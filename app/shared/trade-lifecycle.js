/* OrbitTrader — trade lifecycle: order -> deal -> position state machine.
 *
 * Pure functions, immutable: every call returns NEW objects/arrays and never
 * mutates its inputs. Runs in node and in the browser (UMD: node
 * module.exports, browser global OrbitTradeLifecycle). Position-accounting
 * math (netting/hedging merge, close, closeBy) is delegated to
 * shared/positions.js; this module adds the order lifecycle on top of it
 * and keeps the ticket linkage order <-> deal <-> position.
 *
 * Concepts (reimplemented in OrbitTrader terms):
 *   - An ORDER is a request to trade. It is created in state "started",
 *     accepted into "placed", and then ends in exactly one terminal state:
 *     "filled", "partially_filled"-then-"filled", "canceled", "rejected",
 *     or "expired". Only the documented transitions are legal; anything
 *     else throws.
 *   - A DEAL is an executed fill. Each deal carries the ticket of the order
 *     that produced it (order_ticket), and may carry external IDs supplied
 *     by a gateway / liquidity provider.
 *   - A POSITION is created by deal(s). It references its opening deal
 *     ticket(s) (opening_deal_tickets) and may carry external IDs.
 *   - Applying a deal to the position list produces exactly one effect:
 *     "open" / "increase" / "decrease" / "close" / "reverse", depending on
 *     the accounting mode ("netting" | "hedging") and the current positions.
 *
 * Order : {ticket, state, type, symbol, direction:"buy"|"sell", volume,
 *          price, filled_volume, sl, tp, expiration:{mode,at?},
 *          external_ids:[], comment, time_created, time_done?}
 * Deal  : {ticket, order_ticket, symbol, direction, volume, price, time,
 *          external_ids:[], closes_position_ticket?}
 *          (closes_position_ticket: hedging-only — a closing deal that
 *          targets one specific position by its ticket.)
 * Position : positions.js shape + {ticket, opening_deal_tickets:[],
 *          external_ids:[]}
 */
(function (root) {
"use strict";

var Positions = (typeof require === "function")
  ? require("./positions.js")
  : root.PositionAccounting;

/* ============================================================
 * 1. Order states and the validated transition table
 * ============================================================ */

/* Order lifecycle states. */
var ORDER_STATES = [
  "started",          /* request received, not yet accepted by the server */
  "placed",           /* accepted; resting (pending) or being executed (market) */
  "partially_filled", /* partially executed; the remainder is still live */
  "filled",           /* fully executed (terminal) */
  "canceled",         /* withdrawn before completion (terminal) */
  "rejected",         /* refused by the server: validation, risk, session (terminal) */
  "expired"           /* expired by its expiration time (terminal) */
];

/* Terminal states: no further transitions are allowed. */
var ORDER_TERMINAL_STATES = ["filled", "canceled", "rejected", "expired"];

/* Legal transitions from each state. Illegal transitions throw. */
var ORDER_TRANSITIONS = {
  started:          ["placed", "canceled", "rejected", "expired"],
  placed:           ["partially_filled", "filled", "canceled", "rejected", "expired"],
  partially_filled: ["filled", "canceled", "rejected", "expired"],
  filled:           [],
  canceled:         [],
  rejected:         [],
  expired:          []
};

/* Order types: market, pending, and protective (SL/TP) orders.
 * direction still carries the order's own trade direction. */
var ORDER_TYPES = [
  "buy_market", "sell_market",
  "buy_limit", "sell_limit",
  "buy_stop", "sell_stop",
  "buy_stop_limit", "sell_stop_limit",
  "sl", "tp"
];

var PENDING_TYPES = [
  "buy_limit", "sell_limit",
  "buy_stop", "sell_stop",
  "buy_stop_limit", "sell_stop_limit"
];

/* Expiration modes: gtc = good till canceled; day = dies at the end of the
 * trading day (at = day-end timestamp, ms); specified = dies at an explicit
 * timestamp (at, ms). Only gtc needs no timestamp. */
var EXPIRATION_MODES = ["gtc", "day", "specified"];

/* The five deal->position effects. */
var POSITION_EFFECTS = ["open", "increase", "decrease", "close", "reverse"];

/* ============================================================
 * 2. Ticket generation
 * ============================================================ */

var _ticketCounters = { ord: 0, deal: 0, pos: 0 };

/* issueTicket(prefix) -> "ord_7" / "deal_3" / "pos_12".
 * Prefix is one of "ord" | "deal" | "pos". Counter is module-local. */
function issueTicket(prefix) {
  if (!Object.prototype.hasOwnProperty.call(_ticketCounters, prefix)) {
    throw new Error('ticket prefix must be "ord", "deal" or "pos", got ' + JSON.stringify(prefix));
  }
  _ticketCounters[prefix] += 1;
  return prefix + "_" + _ticketCounters[prefix];
}

/* resetTicketCounters() — test helper: makes ticket sequences deterministic. */
function resetTicketCounters() {
  _ticketCounters = { ord: 0, deal: 0, pos: 0 };
}

/* ============================================================
 * 3. Validation helpers
 * ============================================================ */

function isState(s) { return ORDER_STATES.indexOf(s) !== -1; }
function isType(t) { return ORDER_TYPES.indexOf(t) !== -1; }

function validateOrder(order) {
  if (!order || typeof order !== "object") return "order must be an object";
  if (typeof order.ticket !== "string" || order.ticket === "") return "order.ticket must be a non-empty string";
  if (!isState(order.state)) return "order.state is not a known state: " + JSON.stringify(order.state);
  if (!isType(order.type)) return "order.type is not a known type: " + JSON.stringify(order.type);
  if (typeof order.symbol !== "string" || order.symbol === "") return "order.symbol must be a non-empty string";
  if (order.direction !== "buy" && order.direction !== "sell") return 'order.direction must be "buy" or "sell"';
  if (typeof order.volume !== "number" || !isFinite(order.volume) || order.volume <= 0) return "order.volume must be a positive number";
  if (typeof order.price !== "number" || !isFinite(order.price) || order.price <= 0) return "order.price must be a positive number";
  if (typeof order.filled_volume !== "number" || !isFinite(order.filled_volume) || order.filled_volume < 0) return "order.filled_volume must be a non-negative number";
  if (order.filled_volume - order.volume > 1e-9) return "order.filled_volume cannot exceed order.volume";
  var eErr = validateExpiration(order.expiration);
  if (eErr) return eErr;
  return null;
}

function validateExpiration(expiration) {
  if (!expiration || typeof expiration !== "object") return "order.expiration must be an object";
  if (EXPIRATION_MODES.indexOf(expiration.mode) === -1) return "expiration.mode must be one of " + EXPIRATION_MODES.join("|");
  if (expiration.mode !== "gtc") {
    if (typeof expiration.at !== "number" || !isFinite(expiration.at) || expiration.at <= 0) {
      return 'expiration.at must be a positive timestamp (ms) for mode "' + expiration.mode + '"';
    }
  }
  return null;
}

function validateDeal(deal) {
  if (!deal || typeof deal !== "object") return "deal must be an object";
  if (typeof deal.ticket !== "string" || deal.ticket === "") return "deal.ticket must be a non-empty string";
  if (typeof deal.order_ticket !== "string" || deal.order_ticket === "") return "deal.order_ticket must be a non-empty string (ticket of the originating order)";
  if (typeof deal.symbol !== "string" || deal.symbol === "") return "deal.symbol must be a non-empty string";
  if (deal.direction !== "buy" && deal.direction !== "sell") return 'deal.direction must be "buy" or "sell"';
  if (typeof deal.volume !== "number" || !isFinite(deal.volume) || deal.volume <= 0) return "deal.volume must be a positive number";
  if (typeof deal.price !== "number" || !isFinite(deal.price) || deal.price <= 0) return "deal.price must be a positive number";
  return null;
}

/* ============================================================
 * 4. Orders: creation and the validated state transition
 * ============================================================ */

function cloneOrder(o) {
  return {
    ticket: o.ticket,
    state: o.state,
    type: o.type,
    symbol: o.symbol,
    direction: o.direction,
    volume: o.volume,
    price: o.price,
    filled_volume: o.filled_volume,
    sl: o.sl === undefined ? null : o.sl,
    tp: o.tp === undefined ? null : o.tp,
    expiration: { mode: o.expiration.mode, at: o.expiration.at === undefined ? null : o.expiration.at },
    external_ids: (o.external_ids || []).map(function (e) { return { source: e.source, id: e.id }; }),
    comment: o.comment === undefined ? "" : o.comment,
    time_created: o.time_created === undefined ? null : o.time_created,
    time_done: o.time_done === undefined ? null : o.time_done
  };
}

/* createOrder(spec) -> order in state "started" with a fresh ticket.
 * spec = {type, symbol, direction, volume, price, sl?, tp?,
 *         expiration? ({mode:"gtc"} | {mode:"day"|"specified", at}),
 *         external_ids?, comment?, time_created?}
 * Throws on invalid spec. */
function createOrder(spec) {
  if (!spec || typeof spec !== "object") throw new Error("createOrder: spec must be an object");
  if (!isType(spec.type)) throw new Error("createOrder: unknown order type: " + JSON.stringify(spec.type));
  var order = {
    ticket: issueTicket("ord"),
    state: "started",
    type: spec.type,
    symbol: spec.symbol,
    direction: spec.direction,
    volume: spec.volume,
    price: spec.price,
    filled_volume: 0,
    sl: spec.sl === undefined ? null : spec.sl,
    tp: spec.tp === undefined ? null : spec.tp,
    expiration: spec.expiration === undefined ? { mode: "gtc", at: null } : spec.expiration,
    external_ids: [],
    comment: spec.comment === undefined ? "" : spec.comment,
    time_created: spec.time_created === undefined ? Date.now() : spec.time_created,
    time_done: null
  };
  if (Array.isArray(spec.external_ids)) {
    spec.external_ids.forEach(function (e) {
      if (!e || typeof e.source !== "string" || typeof e.id !== "string") {
        throw new Error("createOrder: external_ids entries need {source, id} strings");
      }
      order.external_ids.push({ source: e.source, id: e.id });
    });
  }
  var err = validateOrder(order);
  if (err) throw new Error("createOrder: " + err);
  return order;
}

/* transition(order, to, time) -> NEW order in state `to`.
 * Throws when the transition is illegal (unknown state, terminal source,
 * or a pair not present in ORDER_TRANSITIONS). Terminal states get
 * time_done stamped. */
function transition(order, to, time) {
  var err = validateOrder(order);
  if (err) throw new Error("transition: " + err);
  if (!isState(to)) throw new Error("transition: unknown target state " + JSON.stringify(to));
  if (ORDER_TRANSITIONS[order.state].indexOf(to) === -1) {
    throw new Error('transition: illegal ' + order.state + " -> " + to);
  }
  var out = cloneOrder(order);
  out.state = to;
  if (ORDER_TERMINAL_STATES.indexOf(to) !== -1) {
    out.time_done = time === undefined ? Date.now() : time;
  }
  return out;
}

/* addExternalId(record, source, id) -> NEW record with the external ID
 * appended (e.g. gateway or LP ticket reference). Works for orders,
 * deals, and positions. */
function addExternalId(record, source, id) {
  if (!record || typeof record !== "object") throw new Error("addExternalId: record must be an object");
  if (typeof source !== "string" || source === "") throw new Error("addExternalId: source must be a non-empty string");
  if (typeof id !== "string" || id === "") throw new Error("addExternalId: id must be a non-empty string");
  var out = record.ticket !== undefined && record.state !== undefined ? cloneOrder(record)
    : record.order_ticket !== undefined ? cloneDeal(record)
    : cloneLifecyclePosition(record);
  out.external_ids = (record.external_ids || []).map(function (e) { return { source: e.source, id: e.id }; });
  out.external_ids.push({ source: source, id: id });
  return out;
}

/* ============================================================
 * 5. Fills: order -> deal
 * ============================================================ */

function cloneDeal(d) {
  return {
    ticket: d.ticket,
    order_ticket: d.order_ticket,
    symbol: d.symbol,
    direction: d.direction,
    volume: d.volume,
    price: d.price,
    time: d.time === undefined ? null : d.time,
    external_ids: (d.external_ids || []).map(function (e) { return { source: e.source, id: e.id }; }),
    closes_position_ticket: d.closes_position_ticket === undefined ? null : d.closes_position_ticket
  };
}

/* applyFill(order, volume, price, opts) -> {order, deal}
 * Records an execution against a live order. The order must be "placed"
 * or "partially_filled"; fill volume must be positive and must not exceed
 * the remaining volume. Returns the new deal (carrying order_ticket) and
 * the order moved to "partially_filled" or "filled".
 * opts = {time?, closes_position_ticket?} */
function applyFill(order, volume, price, opts) {
  var err = validateOrder(order);
  if (err) throw new Error("applyFill: " + err);
  if (order.state !== "placed" && order.state !== "partially_filled") {
    throw new Error('applyFill: order must be "placed" or "partially_filled", got "' + order.state + '"');
  }
  if (typeof volume !== "number" || !isFinite(volume) || volume <= 0) {
    throw new Error("applyFill: volume must be a positive number");
  }
  if (typeof price !== "number" || !isFinite(price) || price <= 0) {
    throw new Error("applyFill: price must be a positive number");
  }
  var remaining = order.volume - order.filled_volume;
  if (volume - remaining > 1e-9) {
    throw new Error("applyFill: fill volume " + volume + " exceeds remaining " + remaining);
  }
  opts = opts || {};

  var deal = {
    ticket: issueTicket("deal"),
    order_ticket: order.ticket,
    symbol: order.symbol,
    direction: order.direction,
    volume: volume,
    price: price,
    time: opts.time === undefined ? Date.now() : opts.time,
    external_ids: [],
    closes_position_ticket: opts.closes_position_ticket === undefined ? null : opts.closes_position_ticket
  };

  var out = cloneOrder(order);
  out.filled_volume = out.filled_volume + volume;
  var done = out.volume - out.filled_volume < 1e-9;
  out.state = done ? "filled" : "partially_filled";
  if (done) out.time_done = deal.time;
  return { order: out, deal: deal };
}

/* ============================================================
 * 6. Expiration: GTC / Day / Specified -> Expired
 * ============================================================ */

/* checkExpiration(order, nowMs) -> order
 * If the order's expiration has passed (nowMs >= expiration.at) and the
 * order is not yet terminal, moves it to "expired". GTC orders never
 * expire. Returns the (possibly new) order; unchanged orders are returned
 * as a fresh clone for consistency. */
function checkExpiration(order, nowMs) {
  var err = validateOrder(order);
  if (err) throw new Error("checkExpiration: " + err);
  if (typeof nowMs !== "number" || !isFinite(nowMs) || nowMs <= 0) {
    throw new Error("checkExpiration: nowMs must be a positive timestamp (ms)");
  }
  if (ORDER_TERMINAL_STATES.indexOf(order.state) !== -1) return cloneOrder(order);
  if (order.expiration.mode === "gtc") return cloneOrder(order);
  if (nowMs >= order.expiration.at) return transition(order, "expired", nowMs);
  return cloneOrder(order);
}

/* ============================================================
 * 7. Positions: ticket-aware records + deal -> position effects
 * ============================================================ */

function cloneLifecyclePosition(p) {
  var base = {
    id: p.id,
    symbol: p.symbol,
    direction: p.direction,
    volume: p.volume,
    open_price: p.open_price,
    sl: p.sl === undefined ? null : p.sl,
    tp: p.tp === undefined ? null : p.tp,
    swap: p.swap === undefined ? 0 : p.swap,
    commission: p.commission === undefined ? 0 : p.commission
  };
  base.ticket = p.ticket === undefined ? null : p.ticket;
  base.opening_deal_tickets = Array.isArray(p.opening_deal_tickets) ? p.opening_deal_tickets.slice() : [];
  base.external_ids = Array.isArray(p.external_ids)
    ? p.external_ids.map(function (e) { return { source: e.source, id: e.id }; })
    : [];
  return base;
}

function cloneLifecyclePositions(positions) {
  return (positions || []).map(cloneLifecyclePosition);
}

function findByTicket(positions, ticket) {
  for (var i = 0; i < positions.length; i++) {
    if (positions[i].ticket === ticket) return { position: positions[i], index: i };
  }
  return null;
}

/* Stamp ticket bookkeeping onto the positions returned by positions.js:
 * - ids that already existed keep their ticket; the incoming deal ticket is
 *   appended to opening_deal_tickets (netting merge keeps one position
 *   fed by several deals).
 * - brand-new ids get ticket = the incoming deal's ticket and
 *   opening_deal_tickets = [deal.ticket].
 * Close/flip deals emitted by the accounting layer get fresh deal tickets
 * and carry the incoming deal's order_ticket as their originating order. */
function annotateAccountingResult(r, deal, beforeIds) {
  var closedDeals = [];
  var openedPositions = [];
  r.deals.forEach(function (d) {
    closedDeals.push({
      ticket: issueTicket("deal"),
      order_ticket: deal.order_ticket,
      symbol: d.symbol === undefined ? deal.symbol : d.symbol,
      direction: d.direction === undefined ? null : d.direction,
      volume: d.volume,
      price: d.close_price === undefined ? null : d.close_price,
      time: deal.time,
      external_ids: [],
      closes_position_ticket: null,
      close_type: d.type,
      position_id: d.position_id
    });
  });
  var positions = r.positions.map(function (p) {
    var out = cloneLifecyclePosition(p);
    if (Object.prototype.hasOwnProperty.call(beforeIds, p.id)) {
      /* Pre-existing position: keep identity, record the extra deal. */
      var prev = beforeIds[p.id];
      out.ticket = prev.ticket;
      out.opening_deal_tickets = prev.opening_deal_tickets.slice();
      if (out.opening_deal_tickets.indexOf(deal.ticket) === -1) {
        out.opening_deal_tickets.push(deal.ticket);
      }
      out.external_ids = prev.external_ids.map(function (e) { return { source: e.source, id: e.id }; });
    } else {
      /* Newly opened position: the deal is its identity. */
      out.ticket = deal.ticket;
      out.opening_deal_tickets = [deal.ticket];
      openedPositions.push(out);
    }
    return out;
  });
  return { positions: positions, closedDeals: closedDeals, openedPositions: openedPositions };
}

/* applyDeal(positions, deal, accounting) ->
 *   {positions, effect, closed_volume, closed_deals, opened_positions}
 *
 * Computes the position effect of one incoming deal:
 *   netting  : open (no position) | increase (same direction) |
 *              decrease (opposite, smaller) | close (opposite, equal) |
 *              reverse (opposite, larger — old side closed, remainder opens)
 *   hedging  : open (a new position per deal) | decrease | close — when the
 *              deal carries closes_position_ticket it targets one position
 *              explicitly and shrinks/removes it.
 * closed_volume = total volume closed by this deal. closed_deals carry the
 * deal's order_ticket so every deal traces back to its originating order. */
function applyDeal(positions, deal, accounting) {
  var accErr = Positions.validateAccounting(accounting);
  if (accErr) throw new Error("applyDeal: " + accErr);
  var dErr = validateDeal(deal);
  if (dErr) throw new Error("applyDeal: " + dErr);

  var before = cloneLifecyclePositions(positions);
  var beforeIds = {};
  before.forEach(function (p) { beforeIds[p.id] = p; });

  /* --- hedging: deal explicitly closes one position --- */
  if (deal.closes_position_ticket && accounting === "hedging") {
    var target = findByTicket(before, deal.closes_position_ticket);
    if (!target) throw new Error("applyDeal: closes_position_ticket not found: " + deal.closes_position_ticket);
    if (target.position.direction === deal.direction) {
      throw new Error("applyDeal: closing deal must be opposite to the position direction");
    }
    var cr = Positions.closePosition(before, target.position.id, deal.volume, deal.price, "hedging");
    var closedVol = deal.volume;
    /* A position was fully removed iff its id is gone now. */
    var stillThere = cr.positions.some(function (p) { return p.id === target.position.id; });
    var effect = stillThere ? "decrease" : "close";
    var closedDeal = {
      ticket: issueTicket("deal"),
      order_ticket: deal.order_ticket,
      symbol: deal.symbol,
      direction: deal.direction,
      volume: closedVol,
      price: deal.price,
      time: deal.time,
      external_ids: [],
      closes_position_ticket: deal.closes_position_ticket,
      close_type: "close",
      position_id: target.position.id
    };
    var out = cr.positions.map(function (p) {
      var c = cloneLifecyclePosition(p);
      var prev = beforeIds[p.id];
      c.ticket = prev.ticket;
      c.opening_deal_tickets = prev.opening_deal_tickets.slice();
      c.external_ids = prev.external_ids.map(function (e) { return { source: e.source, id: e.id }; });
      return c;
    });
    return {
      positions: out,
      effect: effect,
      closed_volume: closedVol,
      closed_deals: [closedDeal],
      opened_positions: []
    };
  }

  /* --- normal path: deal opens / merges against the book --- */
  var beforeSymbol = before.filter(function (p) { return p.symbol === deal.symbol; });
  var orderLike = {
    symbol: deal.symbol,
    direction: deal.direction,
    volume: deal.volume,
    price: deal.price,
    sl: null,
    tp: null
  };
  var r = Positions.openOrder(before, orderLike, accounting);
  var ann = annotateAccountingResult(r, deal, beforeIds);

  var effect2;
  if (accounting === "hedging") {
    effect2 = "open";
  } else if (beforeSymbol.length === 0) {
    effect2 = "open";
  } else {
    var prev = beforeSymbol[0];
    if (prev.direction === deal.direction) {
      effect2 = "increase";
    } else {
      var flip = r.deals.some(function (d) { return d.type === "flip_close"; });
      if (flip) effect2 = "reverse";
      else if (ann.positions.some(function (p) { return p.symbol === deal.symbol; })) effect2 = "decrease";
      else effect2 = "close";
    }
  }

  var closed_volume = 0;
  ann.closedDeals.forEach(function (d) { closed_volume += d.volume; });

  return {
    positions: ann.positions,
    effect: effect2,
    closed_volume: closed_volume,
    closed_deals: ann.closedDeals,
    opened_positions: ann.openedPositions
  };
}

/* ============================================================
 * 8. Type / mode classifiers
 * ============================================================ */

function isPendingType(type) { return PENDING_TYPES.indexOf(type) !== -1; }
function isMarketType(type) { return type === "buy_market" || type === "sell_market"; }
function isProtectiveType(type) { return type === "sl" || type === "tp"; }

var TradeLifecycle = {
  ORDER_STATES: ORDER_STATES,
  ORDER_TERMINAL_STATES: ORDER_TERMINAL_STATES,
  ORDER_TRANSITIONS: ORDER_TRANSITIONS,
  ORDER_TYPES: ORDER_TYPES,
  EXPIRATION_MODES: EXPIRATION_MODES,
  POSITION_EFFECTS: POSITION_EFFECTS,

  issueTicket: issueTicket,
  resetTicketCounters: resetTicketCounters,
  validateOrder: validateOrder,
  validateDeal: validateDeal,
  validateExpiration: validateExpiration,
  createOrder: createOrder,
  transition: transition,
  addExternalId: addExternalId,
  applyFill: applyFill,
  checkExpiration: checkExpiration,
  applyDeal: applyDeal,

  isPendingType: isPendingType,
  isMarketType: isMarketType,
  isProtectiveType: isProtectiveType
};

if (typeof module !== "undefined" && module.exports) { module.exports = TradeLifecycle; }
else { root.OrbitTradeLifecycle = TradeLifecycle; }

})(typeof globalThis !== "undefined" ? globalThis : this);
