/* OrbitTrader — execution modes and fill policies.
 *
 * This module models HOW an order gets executed, not WHAT it records:
 *
 *   1. Execution modes — instant / request / market / exchange. Each mode
 *      defines a different order flow: who sets the price (trader request
 *      vs live market), whether a human dealing desk can be involved, and
 *      whether the order leaves the platform for an external venue.
 *   2. Fill policies — what happens when the requested volume cannot be
 *      filled in full: fill the whole amount or nothing (fill-or-kill),
 *      fill what is available now and drop the rest (immediate-or-cancel),
 *      fill what is quoted and place the rest into the book
 *      (book-or-cancel), or keep the remainder live (return).
 *   3. Compatibility matrix — which fill policies are legal for which
 *      execution mode and order kind (market vs pending), enforced by a
 *      validation function.
 *   4. Requote logic for instant mode — given the requested price, the
 *      current price, and the maximum allowed deviation, decide whether
 *      to execute, ask for a requote at the new price, or reject.
 *   5. Exchange passthrough — routing an order to an external venue via
 *      a gateway, tracking the venue-assigned external ticket through
 *      the routed -> acknowledged -> settled lifecycle.
 *
 * Pure functions, no globals, no DOM: runs in the browser and in node
 * (guarded export at the bottom; browser global is OrbitExecution).
 *
 * Terminology is neutral OrbitTrader terminology. The fill-policy names
 * match the policy catalog in shared/trade-records.js (FILLING_POLICIES)
 * so the record layer and the execution layer agree.
 */
(function (root) {
"use strict";

/* ============================================================
 * 1. Execution mode catalog + per-mode flow model
 * ============================================================ */

/* The four execution modes a symbol (or group override) can use. */
var EXECUTION_MODES = ["instant", "request", "market", "exchange"];

/* Per-mode flow description. Pure documentation-in-code: each mode lists
 * who confirms the price, whether the dealing desk takes part, whether
 * the order leaves the platform through a gateway, whether requotes are
 * possible, and the ordered list of flow steps an order passes through. */
var MODE_FLOW = {
  instant: {
    requiresRequestedPrice: true,  /* order carries the price the trader wants */
    dealerInvolved: true,          /* a dealer may confirm or requote */
    gatewayPassthrough: false,     /* executed inside the platform */
    allowsRequote: true,
    flow: [
      "validate",            /* session, volume, margin, symbol state */
      "price_check",         /* current price vs requested price + deviation */
      "requote_decision",    /* execute / requote / reject */
      "execute",             /* fill at the confirmed price */
      "settle"               /* produce deal + update position */
    ]
  },
  request: {
    requiresRequestedPrice: false, /* trader asks for a quote first */
    dealerInvolved: true,          /* quote comes from the dealing desk */
    gatewayPassthrough: false,
    allowsRequote: true,           /* a new quote is a requote equivalent */
    flow: [
      "validate",
      "request_quote",       /* ask the desk for a price */
      "receive_quote",       /* desk answers within its answer timeout */
      "confirm_quote",       /* trader accepts the quoted price */
      "execute",
      "settle"
    ]
  },
  market: {
    requiresRequestedPrice: false, /* price is whatever the market gives */
    dealerInvolved: false,         /* straight-through, no desk */
    gatewayPassthrough: false,
    allowsRequote: false,          /* no price promise => nothing to requote */
    flow: [
      "validate",
      "execute_at_market",   /* fill at the best currently available price */
      "settle"
    ]
  },
  exchange: {
    requiresRequestedPrice: false, /* limit prices come from the order itself */
    dealerInvolved: false,         /* the venue matches, not the desk */
    gatewayPassthrough: true,      /* order leaves via a liquidity gateway */
    allowsRequote: false,
    flow: [
      "validate",
      "route_to_venue",      /* gateway forwards the order to the exchange */
      "venue_acknowledge",   /* venue accepts and assigns an external ticket */
      "venue_match",         /* venue matches against its order book */
      "settle"               /* venue fill report becomes deal + position */
    ]
  }
};

/* Full description of one execution mode; throws on an unknown mode. */
function describeMode(mode) {
  if (MODE_FLOW[mode] === undefined) {
    throw new Error("unknown execution mode: " + mode);
  }
  var d = MODE_FLOW[mode];
  return {
    mode: mode,
    requiresRequestedPrice: d.requiresRequestedPrice,
    dealerInvolved: d.dealerInvolved,
    gatewayPassthrough: d.gatewayPassthrough,
    allowsRequote: d.allowsRequote,
    flow: d.flow.slice()
  };
}

/* Does this mode need the trader's requested price on the order? */
function modeRequiresPrice(mode) { return describeMode(mode).requiresRequestedPrice; }

/* Can this mode send the trader back a new price instead of filling? */
function modeAllowsRequote(mode) { return describeMode(mode).allowsRequote; }

/* ============================================================
 * 2. Fill policy catalog + fill resolution
 * ============================================================ */

/* The four fill policies (names match trade-records.js FILLING_POLICIES). */
var FILL_POLICIES = [
  "fill_or_kill",       /* whole volume must fill, otherwise nothing */
  "immediate_or_cancel", /* take whatever is available now, drop the rest */
  "book_or_cancel",     /* fill only the quoted volume; rest goes to the book */
  "return"              /* whatever fills, fills; remainder stays live */
];

/* Terminal-ish fill result states produced by resolveFill(). */
var FILL_RESULT_STATES = ["filled", "partial", "canceled", "returned_to_book"];

/* Where the unfilled remainder ends up. */
var REMAINDER_DISPOSITIONS = ["canceled", "booked", "returned_to_book", "none"];

var EPS = 1e-9;

function isPosNumber(x) {
  return typeof x === "number" && isFinite(x) && x > EPS;
}

/* Sum of volume available across a depth ladder:
 * depth = [{price, volume}, ...], best-first. */
function depthTotalVolume(depth) {
  var total = 0;
  for (var i = 0; i < depth.length; i++) {
    if (!isPosNumber(depth[i].volume)) {
      throw new Error("depth level " + i + " has invalid volume");
    }
    total += depth[i].volume;
  }
  return total;
}

/* Walk a depth ladder to fill the requested volume.
 * Returns {filled, fills: [{price, volume}]}. */
function walkDepth(depth, requested) {
  var fills = [];
  var filled = 0;
  for (var i = 0; i < depth.length && filled < requested - EPS; i++) {
    var take = Math.min(depth[i].volume, requested - filled);
    fills.push({ price: depth[i].price, volume: take });
    filled += take;
  }
  return { filled: filled, fills: fills };
}

/* Resolve a fill.
 *
 * args:
 *   requestedVolume — the volume the order asked for (> 0)
 *   policy          — one of FILL_POLICIES
 *   availableVolume — (number) volume currently fillable at the quote, or
 *   availableDepth  — (array) [{price, volume}, ...] ladder, best first
 *
 * Exactly one of availableVolume / availableDepth must be given.
 *
 * Returns:
 *   {
 *     requestedVolume, filledVolume, remainderVolume,
 *     remainderDisposition: "canceled" | "booked" | "returned_to_book" | "none",
 *     state: "filled" | "partial" | "canceled" | "returned_to_book",
 *     fills: [{price, volume}] | null   (only when depth was given)
 *   }
 *
 * Policy semantics:
 *   fill_or_kill      — available >= requested ? full fill : nothing, cancel
 *   immediate_or_cancel — fill what is available now, cancel the remainder
 *   book_or_cancel    — fill only quoted volume, park the rest in the book
 *   return            — fill what is available, remainder stays live in the book
 */
function resolveFill(args) {
  if (!args || typeof args !== "object") {
    throw new Error("resolveFill requires an argument object");
  }
  var requested = args.requestedVolume;
  var policy = args.policy;
  if (!isPosNumber(requested)) {
    throw new Error("requestedVolume must be a positive number");
  }
  if (FILL_POLICIES.indexOf(policy) === -1) {
    throw new Error("unknown fill policy: " + policy);
  }

  var hasVol = args.availableVolume !== undefined && args.availableVolume !== null;
  var hasDepth = args.availableDepth !== undefined && args.availableDepth !== null;
  if (hasVol === hasDepth) {
    throw new Error("exactly one of availableVolume / availableDepth is required");
  }
  var fills = null;
  var available;
  if (hasDepth) {
    if (!Array.isArray(args.availableDepth) || args.availableDepth.length === 0) {
      throw new Error("availableDepth must be a non-empty array");
    }
    available = depthTotalVolume(args.availableDepth);
    fills = walkDepth(args.availableDepth, requested).fills;
  } else {
    if (typeof args.availableVolume !== "number" || args.availableVolume < 0 || !isFinite(args.availableVolume)) {
      throw new Error("availableVolume must be a non-negative finite number");
    }
    available = args.availableVolume;
  }

  var filled = Math.min(requested, available);
  var remainder = requested - filled;

  function base(overrides) {
    var r = {
      requestedVolume: requested,
      filledVolume: filled,
      remainderVolume: remainder,
      remainderDisposition: "none",
      state: "filled",
      fills: fills
    };
    for (var k in overrides) { r[k] = overrides[k]; }
    return r;
  }

  if (policy === "fill_or_kill") {
    if (available >= requested - EPS) {
      return base({ filledVolume: requested, remainderVolume: 0 });
    }
    return base({
      filledVolume: 0, remainderVolume: requested,
      remainderDisposition: "canceled", state: "canceled"
    });
  }

  if (policy === "immediate_or_cancel") {
    if (remainder <= EPS) {
      return base({ remainderVolume: 0 });
    }
    if (filled <= EPS) {
      return base({
        filledVolume: 0,
        remainderDisposition: "canceled", state: "canceled"
      });
    }
    return base({ remainderDisposition: "canceled", state: "partial" });
  }

  if (policy === "book_or_cancel") {
    if (remainder <= EPS) {
      return base({ remainderVolume: 0 });
    }
    return base({ remainderDisposition: "booked", state: "partial" });
  }

  /* return */
  if (remainder <= EPS) {
    return base({ remainderVolume: 0 });
  }
  return base({ remainderDisposition: "returned_to_book", state: "returned_to_book" });
}

/* ============================================================
 * 3. Per-mode compatibility matrix (mode x order kind x policy)
 * ============================================================ */

/* Order kinds for compatibility purposes: "market" orders execute
 * immediately; "pending" orders rest until a trigger price is reached.
 * (Maps to the 8 order types in trade-records.js.) */
var ORDER_KINDS = ["market", "pending"];

/* Which fill policies each mode accepts, per order kind.
 *
 * Reasoning, in plain terms:
 *  - Immediate modes (instant / request / market) fill against the live
 *    quote. A market order there must either take the whole amount or
 *    walk away (fill-or-kill), or take what is there now and drop the
 *    rest (immediate-or-cancel). Anything left over cannot sit on an
 *    internal book that does not exist for immediate fills.
 *  - Pending orders rest on the book until triggered, so the leftover
 *    simply stays live ("return") — there is nothing to cancel.
 *  - Exchange mode routes to a real venue with its own order book, so
 *    the remainder of a market order can rest there (book-or-cancel),
 *    and pending orders may use either book-or-cancel or return. */
var COMPATIBILITY = {
  instant: {
    market:  ["fill_or_kill", "immediate_or_cancel"],
    pending: ["return"]
  },
  request: {
    market:  ["fill_or_kill", "immediate_or_cancel"],
    pending: ["return"]
  },
  market: {
    market:  ["fill_or_kill", "immediate_or_cancel"],
    pending: ["return"]
  },
  exchange: {
    market:  ["fill_or_kill", "immediate_or_cancel", "book_or_cancel"],
    pending: ["book_or_cancel", "return"]
  }
};

/* List the valid fill policies for an execution mode + order kind.
 * Returns a fresh array. Throws on unknown mode/kind. */
function validFillPolicies(mode, orderKind) {
  if (MODE_FLOW[mode] === undefined) {
    throw new Error("unknown execution mode: " + mode);
  }
  if (ORDER_KINDS.indexOf(orderKind) === -1) {
    throw new Error("unknown order kind: " + orderKind);
  }
  return COMPATIBILITY[mode][orderKind].slice();
}

/* Validate one (mode, orderKind, policy) triple.
 * Returns null when valid, otherwise a human-readable error string. */
function validateFillPolicy(mode, orderKind, policy) {
  if (MODE_FLOW[mode] === undefined) {
    return "unknown execution mode: " + mode;
  }
  if (ORDER_KINDS.indexOf(orderKind) === -1) {
    return "unknown order kind: " + orderKind;
  }
  if (FILL_POLICIES.indexOf(policy) === -1) {
    return "unknown fill policy: " + policy;
  }
  var allowed = COMPATIBILITY[mode][orderKind];
  if (allowed.indexOf(policy) === -1) {
    return "fill policy '" + policy + "' is not valid for " + mode +
      " execution with " + orderKind + " orders (valid: " + allowed.join(", ") + ")";
  }
  return null;
}

/* Validate an actual order-type string (e.g. "buy_limit") against a mode
 * and fill policy. Returns null when valid, otherwise an error string. */
function validateOrderFillPolicy(mode, orderType, policy) {
  var kind = orderKindOf(orderType);
  if (kind === null) {
    return "unknown order type: " + orderType;
  }
  return validateFillPolicy(mode, kind, policy);
}

/* Map an order type string to its compatibility kind. */
function orderKindOf(orderType) {
  if (orderType === "buy_market" || orderType === "sell_market") {
    return "market";
  }
  var pending = ["buy_limit", "sell_limit", "buy_stop", "sell_stop",
                 "buy_stop_limit", "sell_stop_limit"];
  if (pending.indexOf(orderType) !== -1) {
    return "pending";
  }
  return null;
}

/* ============================================================
 * 4. Requote logic (instant mode)
 * ============================================================ */

/* Decide what instant execution does with an order.
 *
 * args:
 *   requestedPrice — price the trader sent with the order
 *   currentPrice   — price the server sees now (null/undefined = no quote)
 *   maxDeviation   — largest acceptable |current - requested| (price units)
 *   allowRequote   — if false, deviations beyond tolerance reject outright
 *
 * Returns:
 *   { decision: "execute", executionPrice } — within tolerance, fill at
 *       the current price (a favorable move executes at the better price)
 *   { decision: "requote", newPrice, deviation } — outside tolerance and
 *       requotes allowed: send the trader the new price to confirm
 *   { decision: "reject", reason } — no quote, or outside tolerance with
 *       requotes disabled
 */
function decideRequote(args) {
  if (!args || typeof args !== "object") {
    throw new Error("decideRequote requires an argument object");
  }
  var requested = args.requestedPrice;
  var current = args.currentPrice;
  var maxDev = args.maxDeviation;
  var allowRequote = args.allowRequote !== false; /* default true */

  if (typeof requested !== "number" || !isFinite(requested) || requested <= 0) {
    return { decision: "reject", reason: "invalid_requested_price" };
  }
  if (typeof maxDev !== "number" || !isFinite(maxDev) || maxDev < 0) {
    return { decision: "reject", reason: "invalid_max_deviation" };
  }
  if (typeof current !== "number" || !isFinite(current) || current <= 0) {
    return { decision: "reject", reason: "off_quotes" };
  }

  var deviation = Math.abs(current - requested);
  if (deviation <= maxDev + EPS) {
    return { decision: "execute", executionPrice: current, deviation: deviation };
  }
  if (!allowRequote) {
    return { decision: "reject", reason: "deviation_exceeded", deviation: deviation };
  }
  return { decision: "requote", newPrice: current, deviation: deviation };
}

/* Convenience: did the price move in the trader's favor?
 * side "buy" wants lower; "sell" wants higher. */
function priceMovedFavorably(side, requestedPrice, currentPrice) {
  if (side !== "buy" && side !== "sell") {
    throw new Error("unknown side: " + side);
  }
  return side === "buy" ? currentPrice < requestedPrice
                        : currentPrice > requestedPrice;
}

/* ============================================================
 * 5. Exchange passthrough (external venue routing)
 * ============================================================ */

var _nextRouteSeq = 1;

function nextRouteId() {
  var id = "XR-" + String(_nextRouteSeq++).padStart(6, "0");
  return id;
}

/* Route an order to an external venue through a liquidity gateway.
 *
 * order: {ticket, symbol, side: "buy"|"sell", volume, orderType}
 * venue: {id, gatewayId}
 *
 * Returns a route record:
 *   { routeId, ticket, symbol, side, volume, orderType,
 *     venueId, gatewayId, externalTicket: null, status: "routed",
 *     routedAt, history: [...] } */
function routeToExchange(order, venue) {
  if (!order || typeof order !== "object") {
    throw new Error("order is required");
  }
  if (!venue || typeof venue !== "object" || !venue.id) {
    throw new Error("venue with an id is required");
  }
  var side = order.side;
  if (side !== "buy" && side !== "sell") {
    throw new Error("order side must be 'buy' or 'sell'");
  }
  if (!isPosNumber(order.volume)) {
    throw new Error("order volume must be a positive number");
  }
  var route = {
    routeId: nextRouteId(),
    ticket: order.ticket,
    symbol: order.symbol,
    side: side,
    volume: order.volume,
    orderType: order.orderType || null,
    venueId: venue.id,
    gatewayId: venue.gatewayId || null,
    externalTicket: null,
    status: "routed",
    routedAt: Date.now(),
    history: [{ status: "routed", at: Date.now(), note: "forwarded to venue" }]
  };
  return route;
}

function stampHistory(route, status, note) {
  route.history.push({ status: status, at: Date.now(), note: note || "" });
}

/* The venue accepted the order and assigned its own ticket.
 * externalTicket: the venue-side identifier (string). */
function acknowledgeVenue(route, externalTicket) {
  if (!route || route.status !== "routed") {
    throw new Error("only a routed order can be acknowledged by the venue");
  }
  if (typeof externalTicket !== "string" || externalTicket.length === 0) {
    throw new Error("externalTicket must be a non-empty string");
  }
  route.externalTicket = externalTicket;
  route.status = "acknowledged";
  stampHistory(route, "acknowledged", "venue ticket " + externalTicket);
  return route;
}

/* Process a fill/cancel report coming back from the venue.
 *
 * report: { externalTicket, status: "filled"|"partial"|"canceled"|"rejected",
 *           filledVolume, avgPrice }
 *
 * Returns the updated route (mutated in place, as routes are live state). */
function processVenueReport(route, report) {
  if (!route || (route.status !== "acknowledged" && route.status !== "routed")) {
    throw new Error("venue report needs a routed or acknowledged order");
  }
  if (!report || typeof report !== "object") {
    throw new Error("report is required");
  }
  var valid = ["filled", "partial", "canceled", "rejected"];
  if (valid.indexOf(report.status) === -1) {
    throw new Error("unknown venue report status: " + report.status);
  }
  if (route.externalTicket && report.externalTicket &&
      report.externalTicket !== route.externalTicket) {
    throw new Error("venue report ticket mismatch");
  }
  if (report.status === "filled" || report.status === "partial") {
    if (!isPosNumber(report.filledVolume)) {
      throw new Error("venue fill report needs a positive filledVolume");
    }
  }
  route.externalTicket = route.externalTicket || report.externalTicket || null;
  route.status = report.status;
  route.venueFilledVolume = report.filledVolume || 0;
  route.venueAvgPrice = (report.avgPrice !== undefined) ? report.avgPrice : null;
  stampHistory(route, report.status,
    "venue reported " + report.status +
    (report.filledVolume ? " vol " + report.filledVolume : ""));
  return route;
}

/* ============================================================
 * Exports
 * ============================================================ */

var Execution = {
  /* catalogs */
  EXECUTION_MODES: EXECUTION_MODES,
  FILL_POLICIES: FILL_POLICIES,
  FILL_RESULT_STATES: FILL_RESULT_STATES,
  REMAINDER_DISPOSITIONS: REMAINDER_DISPOSITIONS,
  ORDER_KINDS: ORDER_KINDS,
  COMPATIBILITY: COMPATIBILITY,
  /* modes */
  describeMode: describeMode,
  modeRequiresPrice: modeRequiresPrice,
  modeAllowsRequote: modeAllowsRequote,
  /* fills */
  resolveFill: resolveFill,
  /* compatibility */
  orderKindOf: orderKindOf,
  validFillPolicies: validFillPolicies,
  validateFillPolicy: validateFillPolicy,
  validateOrderFillPolicy: validateOrderFillPolicy,
  /* requotes */
  decideRequote: decideRequote,
  priceMovedFavorably: priceMovedFavorably,
  /* exchange passthrough */
  routeToExchange: routeToExchange,
  acknowledgeVenue: acknowledgeVenue,
  processVenueReport: processVenueReport
};

if (typeof module !== "undefined" && module.exports) { module.exports = Execution; }
else { root.OrbitExecution = Execution; }

})(typeof globalThis !== "undefined" ? globalThis : this);
