/* OrbitTrader — dealing desk: manual dealer workflow for client order requests.
 *
 * Models the dealing-desk concept (behavioral spec only — no vendor text):
 * client order requests arrive in a request queue that is only visible /
 * actionable while dealing mode is on. A dealer picks requests off the queue
 * and either executes them at the current market price, executes them with a
 * dealer-corrected price ("throw-in", validated against a maximum deviation
 * from the market), or rejects them with a reason code.
 *
 * A supervisor role can inspect every dealer's queue and actions (read-only).
 * Every dealer action is recorded in an append-only dealing log with the
 * outcome (Done / Rejected / Prices), the actor, the timestamp and the
 * old/new price.
 *
 * Request types can be auto-processed: a per-type config map decides whether
 * a type is answered automatically, up to which volume, and within which
 * answer timeout. Requests that exceed the maximum volume or time out fall
 * back to the manual queue.
 *
 * Pure functions, no globals, no DOM: runs in the browser and in node
 * (guarded export at the bottom; browser global is OrbitDealingDesk).
 *
 * Terminology is neutral OrbitTrader terminology.
 */
(function (root) {
"use strict";

/* ============================================================
 * 1. Catalogs (enumerations)
 * ============================================================ */

/* Client request types the dealing desk can receive. */
var REQUEST_TYPES = [
  "market_order",   /* buy/sell at market — price is taken from the market */
  "pending_order",  /* limit/stop order placement with a requested price */
  "order_modify",   /* change price/SL/TP/expiration of a live order */
  "order_cancel",   /* cancel a pending order */
  "position_close", /* close (part of) an open position */
  "sltp_modify"     /* change only the protective SL/TP levels */
];

/* Request lifecycle states. */
var REQUEST_STATES = [
  "queued",    /* waiting for a dealer (or the auto-processor) */
  "done",      /* executed (at market, auto, or with a corrected price) */
  "rejected"   /* refused by the dealer with a reason code */
];

/* Terminal states: no further dealer action allowed. */
var REQUEST_TERMINAL_STATES = ["done", "rejected"];

/* Reject reason codes (dealer-visible, neutral wording). */
var REJECT_REASONS = [
  "no_quotes",          /* no live quote available for the symbol */
  "off_quotes",         /* requested price too far from the market */
  "invalid_volume",     /* volume below minimum or above maximum */
  "invalid_price",      /* price fails symbol stops-level / tick rules */
  "invalid_stops",      /* SL/TP levels invalid for the request */
  "trade_disabled",     /* trading disabled for the account/group/symbol */
  "market_closed",      /* symbol not in a trading session right now */
  "insufficient_margin",/* not enough free margin to accept the request */
  "timeout",            /* request timed out before it could be answered */
  "dealer_decision"     /* discretionary dealer refusal */
];

/* Dealing-log outcome labels. */
var LOG_OUTCOMES = ["Done", "Rejected", "Prices"];
/* "Done"     — request executed at market (or by auto-processing).
 * "Rejected" — request refused by the dealer.
 * "Prices"   — request executed with a dealer-corrected price (throw-in). */

/* Roles in the dealing desk. */
var DEALING_ROLES = ["dealer", "supervisor"];

/* ============================================================
 * 2. Small helpers
 * ============================================================ */

function isFiniteNumber(x) {
  return typeof x === "number" && isFinite(x);
}

function isPosNumber(x) {
  return isFiniteNumber(x) && x > 0;
}

function isNonNegNumber(x) {
  return isFiniteNumber(x) && x >= 0;
}

function inList(list, v) {
  return list.indexOf(v) !== -1;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function nowIso() {
  return new Date().toISOString();
}

function newDesk() {
  return { requests: [], log: [], next_seq: 1 };
}

/* validateDealingActor(actor, requiredRole) -> error string or null. */
function validateDealingActor(actor, requiredRole) {
  if (!actor || typeof actor !== "object") return "actor must be an object";
  if (!inList(DEALING_ROLES, actor.role)) {
    return "actor.role must be one of: " + DEALING_ROLES.join(", ");
  }
  if (typeof actor.login !== "string" || actor.login === "") {
    return "actor.login must be a non-empty string";
  }
  if (requiredRole && actor.role !== requiredRole) {
    return "this action requires the " + requiredRole + " role";
  }
  return null;
}

/* ============================================================
 * 3. Request record
 * ============================================================ */

/* defaultRequest(login, symbol, requestType) -> a blank request.
 * Field-by-field:
 *   request_id     — unique request identifier (server-assigned on insert)
 *   login          — owning account login
 *   symbol         — traded symbol
 *   request_type   — one of REQUEST_TYPES
 *   side           — "buy" | "sell" (trade requests) or null (admin requests)
 *   volume         — requested volume, positive
 *   requested_price— client-requested price (0 = at market)
 *   priority       — true = jumps ahead of non-priority requests (FIFO kept
 *                    among requests with the same priority)
 *   dealer_id      — dealer login the request is assigned to (null = pool)
 *   state          — one of REQUEST_STATES ("queued" at creation)
 *   time_received  — ISO time the request landed in the queue
 *   time_done      — ISO time of the dealer action, or null
 *   timed_out      — true = answer timeout elapsed while still queued
 *   manual         — true = must be answered by a dealer (not auto)
 *   outcome        — null until answered; then
 *                    {kind: "executed_at_market" | "executed_corrected" |
 *                           "auto_executed" | "rejected",
 *                     execution_price, reject_reason, dealer_login}
 */
function defaultRequest(login, symbol, requestType) {
  return {
    request_id: null,
    login: login,
    symbol: symbol,
    request_type: requestType,
    side: null,
    volume: 0,
    requested_price: 0,
    priority: false,
    dealer_id: null,
    state: "queued",
    time_received: nowIso(),
    time_done: null,
    timed_out: false,
    manual: false,
    outcome: null,
    seq: null /* internal FIFO tie-break, assigned on enqueue */
  };
}

var OUTCOME_KINDS = ["executed_at_market", "executed_corrected", "auto_executed", "rejected"];

/* validateRequest(req) -> error string or null. */
function validateRequest(req) {
  if (!req || typeof req !== "object") return "request must be an object";
  if (typeof req.login !== "string" || req.login === "") {
    return "request.login must be a non-empty string";
  }
  if (typeof req.symbol !== "string" || req.symbol === "") {
    return "request.symbol must be a non-empty string";
  }
  if (!inList(REQUEST_TYPES, req.request_type)) {
    return "request.request_type must be one of: " + REQUEST_TYPES.join(", ");
  }
  if (req.side !== null && req.side !== undefined && req.side !== "buy" && req.side !== "sell") {
    return 'request.side must be "buy", "sell" or null';
  }
  if (!isPosNumber(req.volume)) return "request.volume must be a positive number";
  if (!isNonNegNumber(req.requested_price)) {
    return "request.requested_price must be a non-negative number";
  }
  if (typeof req.priority !== "boolean") return "request.priority must be a boolean";
  if (req.dealer_id !== null && req.dealer_id !== undefined && typeof req.dealer_id !== "string") {
    return "request.dealer_id must be a string or null";
  }
  if (!inList(REQUEST_STATES, req.state)) {
    return "request.state must be one of: " + REQUEST_STATES.join(", ");
  }
  if (isNaN(Date.parse(req.time_received))) {
    return "request.time_received must be an ISO datetime string";
  }
  if (req.time_done !== null && req.time_done !== undefined && isNaN(Date.parse(req.time_done))) {
    return "request.time_done must be an ISO datetime string or null";
  }
  if (typeof req.timed_out !== "boolean") return "request.timed_out must be a boolean";
  if (typeof req.manual !== "boolean") return "request.manual must be a boolean";
  if (req.outcome !== null && req.outcome !== undefined) {
    var o = req.outcome;
    if (typeof o !== "object") return "request.outcome must be an object or null";
    if (!inList(OUTCOME_KINDS, o.kind)) {
      return "request.outcome.kind must be one of: " + OUTCOME_KINDS.join(", ");
    }
    if (o.kind === "rejected") {
      if (!inList(REJECT_REASONS, o.reject_reason)) {
        return "rejected outcomes need a request.outcome.reject_reason from REJECT_REASONS";
      }
    } else {
      if (!isPosNumber(o.execution_price)) {
        return "executed outcomes need a positive request.outcome.execution_price";
      }
    }
    if (o.dealer_login !== null && o.dealer_login !== undefined &&
        typeof o.dealer_login !== "string") {
      return "request.outcome.dealer_login must be a string or null";
    }
  }
  if (req.seq !== null && req.seq !== undefined && !Number.isInteger(req.seq)) {
    return "request.seq must be an integer or null";
  }
  return null;
}

/* ============================================================
 * 4. Request queue
 * ============================================================ */

/* enqueueRequest(desk, req) -> NEW desk with the request queued.
 * Validates the request, stamps time_received when missing and assigns the
 * internal FIFO sequence. Returns a new desk (input desk is untouched).
 */
function enqueueRequest(desk, req) {
  if (!desk || !Array.isArray(desk.requests) || !Array.isArray(desk.log)) {
    throw new Error("desk must be {requests: [], log: []}");
  }
  var err = validateRequest(req);
  if (err) throw new Error(err);
  if (req.state !== "queued") throw new Error("only queued requests can be enqueued");
  if (inList(REQUEST_TERMINAL_STATES, req.state)) {
    throw new Error("cannot enqueue a request in a terminal state");
  }
  var out = clone(desk);
  var r = clone(req);
  if (!r.time_received) r.time_received = nowIso();
  r.seq = out.next_seq;
  out.next_seq = out.next_seq + 1;
  out.requests.push(r);
  return out;
}

/* queueComparator(a, b): priority requests first; otherwise FIFO by
 * time_received, with the enqueue sequence as the final tie-break. */
function queueComparator(a, b) {
  if (a.priority !== b.priority) return a.priority ? -1 : 1;
  var ta = Date.parse(a.time_received), tb = Date.parse(b.time_received);
  if (ta !== tb) return ta - tb;
  return (a.seq || 0) - (b.seq || 0);
}

/* queueFor(desk, dealerId) -> queued requests in answering order.
 * dealerId = null returns the whole pool (unassigned + assigned);
 * otherwise only that dealer's assigned requests plus the unassigned pool.
 */
function queueFor(desk, dealerId) {
  if (!desk || !Array.isArray(desk.requests)) throw new Error("desk must be {requests: [], log: []}");
  var list = desk.requests.filter(function (r) {
    if (r.state !== "queued") return false;
    if (dealerId === null || dealerId === undefined) return true;
    return r.dealer_id === null || r.dealer_id === undefined || r.dealer_id === dealerId;
  });
  list.sort(queueComparator);
  return list;
}

/* nextRequest(desk, dealerId) -> the next request to answer, or null. */
function nextRequest(desk, dealerId) {
  var q = queueFor(desk, dealerId);
  return q.length > 0 ? q[0] : null;
}

/* findRequest(desk, requestId) -> request or null (any state). */
function findRequest(desk, requestId) {
  if (!desk || !Array.isArray(desk.requests)) throw new Error("desk must be {requests: [], log: []}");
  for (var i = 0; i < desk.requests.length; i++) {
    if (desk.requests[i].request_id !== null &&
        String(desk.requests[i].request_id) === String(requestId)) {
      return desk.requests[i];
    }
  }
  return null;
}

/* marketPriceFor(market, side) -> the side-appropriate price.
 * market = {bid, ask}; throws when the needed quote is missing. */
function marketPriceFor(market, side) {
  if (!market || typeof market !== "object") throw new Error("market must be {bid, ask}");
  var p = side === "buy" ? market.ask : market.bid;
  if (!isPosNumber(p)) throw new Error("market has no " + (side === "buy" ? "ask" : "bid") + " quote");
  return p;
}

/* ============================================================
 * 5. Dealing log (append-only)
 * ============================================================ */

/* validateLogEntry(entry) -> error string or null.
 * entry = {request_id, login, symbol, time (ISO, defaults later),
 *          actor_login, actor_role, outcome: LOG_OUTCOMES entry,
 *          old_price, new_price, volume, note}
 */
function validateLogEntry(entry) {
  if (!entry || typeof entry !== "object") return "log entry must be an object";
  if (entry.request_id === null || entry.request_id === undefined || entry.request_id === "") {
    return "log entry needs request_id";
  }
  if (typeof entry.login !== "string" || entry.login === "") {
    return "log entry needs login";
  }
  if (typeof entry.symbol !== "string" || entry.symbol === "") {
    return "log entry needs symbol";
  }
  if (entry.time !== undefined && entry.time !== null && isNaN(Date.parse(entry.time))) {
    return "log entry time must be an ISO datetime string";
  }
  if (typeof entry.actor_login !== "string" || entry.actor_login === "") {
    return "log entry needs actor_login";
  }
  if (entry.actor_role !== null && entry.actor_role !== undefined &&
      !inList(DEALING_ROLES, entry.actor_role) && entry.actor_role !== "server") {
    return "log entry actor_role must be dealer, supervisor or server";
  }
  if (!inList(LOG_OUTCOMES, entry.outcome)) {
    return "log entry outcome must be one of: " + LOG_OUTCOMES.join(", ");
  }
  if (entry.old_price !== null && entry.old_price !== undefined && !isNonNegNumber(entry.old_price)) {
    return "log entry old_price must be a non-negative number or null";
  }
  if (entry.new_price !== null && entry.new_price !== undefined && !isNonNegNumber(entry.new_price)) {
    return "log entry new_price must be a non-negative number or null";
  }
  if (entry.outcome === "Prices" && !isPosNumber(entry.new_price)) {
    return "a Prices log entry needs a positive new_price (the corrected price)";
  }
  if (entry.volume !== undefined && entry.volume !== null && !isPosNumber(entry.volume)) {
    return "log entry volume must be a positive number or null";
  }
  if (entry.note !== undefined && entry.note !== null && typeof entry.note !== "string") {
    return "log entry note must be a string";
  }
  return null;
}

/* appendDealingLog(desk, entry) -> NEW desk with the entry appended.
 * Append-only: there is intentionally no remove/rewrite function.
 */
function appendDealingLog(desk, entry) {
  if (!desk || !Array.isArray(desk.log)) throw new Error("desk must be {requests: [], log: []}");
  var err = validateLogEntry(entry);
  if (err) throw new Error(err);
  var out = clone(desk);
  var e = clone(entry);
  if (!e.time) e.time = nowIso();
  if (e.old_price === undefined) e.old_price = null;
  if (e.new_price === undefined) e.new_price = null;
  if (e.volume === undefined) e.volume = null;
  if (e.note === undefined || e.note === null) e.note = "";
  out.log.push(e);
  return out;
}

/* dealingLogFor(desk, requestId) -> log entries for one request, oldest first. */
function dealingLogFor(desk, requestId) {
  if (!desk || !Array.isArray(desk.log)) throw new Error("desk must be {requests: [], log: []}");
  return desk.log.filter(function (e) {
    return String(e.request_id) === String(requestId);
  });
}

/* ============================================================
 * 6. Dealer actions
 * ============================================================ */

/* answerRequest(desk, requestId, dealer, outcome, logOutcome, oldPrice,
 *               newPrice, note) -> NEW desk.
 * Shared engine behind the three dealer actions: validates the actor and the
 * request, applies the outcome, stamps time_done, appends the dealing log.
 */
function answerRequest(desk, requestId, dealer, outcome, logOutcome, oldPrice, newPrice, note) {
  var actErr = validateDealingActor(dealer, "dealer");
  if (actErr) throw new Error(actErr);
  var req = findRequest(desk, requestId);
  if (!req) throw new Error("unknown request: " + String(requestId));
  if (inList(REQUEST_TERMINAL_STATES, req.state)) {
    throw new Error("request " + String(requestId) + " is already " + req.state);
  }
  var oErr = (function () {
    var tmp = clone(req);
    tmp.state = outcome.kind === "rejected" ? "rejected" : "done";
    tmp.outcome = outcome;
    return validateRequest(tmp);
  })();
  if (oErr) throw new Error(oErr);

  var out = clone(desk);
  var r = null;
  for (var i = 0; i < out.requests.length; i++) {
    if (out.requests[i].request_id !== null &&
        String(out.requests[i].request_id) === String(requestId)) { r = out.requests[i]; break; }
  }
  r.state = outcome.kind === "rejected" ? "rejected" : "done";
  r.time_done = nowIso();
  r.outcome = clone(outcome);

  var entry = {
    request_id: r.request_id,
    login: r.login,
    symbol: r.symbol,
    actor_login: dealer.login,
    actor_role: "dealer",
    outcome: logOutcome,
    old_price: oldPrice,
    new_price: newPrice,
    volume: r.volume,
    note: note || ""
  };
  var lErr = validateLogEntry(entry);
  if (lErr) throw new Error(lErr);
  entry.time = nowIso();
  out.log.push(entry);
  return out;
}

/* executeAtMarket(desk, requestId, dealer, market) -> NEW desk.
 * Fills the request at the current side-appropriate market price.
 * market = {bid, ask}. Requests without a side (order_cancel etc.) execute
 * at their requested price.
 */
function executeAtMarket(desk, requestId, dealer, market) {
  var req = findRequest(desk, requestId);
  if (!req) throw new Error("unknown request: " + String(requestId));
  var price;
  if (req.side === "buy" || req.side === "sell") {
    price = marketPriceFor(market, req.side);
  } else {
    if (!isPosNumber(req.requested_price)) {
      throw new Error("non-trade request needs a requested_price to execute at market");
    }
    price = req.requested_price;
  }
  return answerRequest(desk, requestId, dealer, {
    kind: "executed_at_market",
    execution_price: price,
    reject_reason: null,
    dealer_login: dealer.login
  }, "Done", req.requested_price, price, "");
}

/* validateCorrectedPrice(refPrice, correctedPrice, maxDeviation) ->
 * error string or null.
 * The throw-in price must stay within maxDeviation (fraction, e.g. 0.001 =
 * 0.1%) of the reference market price. refPrice is the side-appropriate
 * current market price.
 */
function validateCorrectedPrice(refPrice, correctedPrice, maxDeviation) {
  if (!isPosNumber(refPrice)) return "reference market price must be a positive number";
  if (!isPosNumber(correctedPrice)) return "corrected price must be a positive number";
  if (!isFiniteNumber(maxDeviation) || maxDeviation < 0) {
    return "maxDeviation must be a non-negative number (fraction)";
  }
  var dev = Math.abs(correctedPrice - refPrice) / refPrice;
  if (dev - maxDeviation > 1e-12) {
    return "corrected price deviates " + (dev * 100).toFixed(4) + "% from market; " +
           "maximum allowed is " + (maxDeviation * 100).toFixed(4) + "%";
  }
  return null;
}

/* executeCorrected(desk, requestId, dealer, correctedPrice, market,
 *                 maxDeviation) -> NEW desk.
 * Dealer throw-in: executes the request at a dealer-supplied price that must
 * sit within maxDeviation (fraction) of the current side-appropriate market
 * price. Logged with outcome "Prices" and the old/new price.
 */
function executeCorrected(desk, requestId, dealer, correctedPrice, market, maxDeviation) {
  var req = findRequest(desk, requestId);
  if (!req) throw new Error("unknown request: " + String(requestId));
  var ref;
  if (req.side === "buy" || req.side === "sell") {
    ref = marketPriceFor(market, req.side);
  } else {
    if (!isPosNumber(req.requested_price)) {
      throw new Error("non-trade request needs a requested_price as the correction reference");
    }
    ref = req.requested_price;
  }
  var err = validateCorrectedPrice(ref, correctedPrice, maxDeviation);
  if (err) throw new Error(err);
  return answerRequest(desk, requestId, dealer, {
    kind: "executed_corrected",
    execution_price: correctedPrice,
    reject_reason: null,
    dealer_login: dealer.login
  }, "Prices", req.requested_price, correctedPrice, "");
}

/* rejectRequest(desk, requestId, dealer, reasonCode) -> NEW desk.
 * Refuses the request with a REJECT_REASONS code. Logged as "Rejected".
 */
function rejectRequest(desk, requestId, dealer, reasonCode) {
  if (!inList(REJECT_REASONS, reasonCode)) {
    throw new Error("unknown reject reason: " + String(reasonCode) +
                    " (expected one of: " + REJECT_REASONS.join(", ") + ")");
  }
  var req = findRequest(desk, requestId);
  if (!req) throw new Error("unknown request: " + String(requestId));
  return answerRequest(desk, requestId, dealer, {
    kind: "rejected",
    execution_price: null,
    reject_reason: reasonCode,
    dealer_login: dealer.login
  }, "Rejected", req.requested_price, null, reasonCode);
}

/* ============================================================
 * 7. Supervisor oversight (read-only)
 * ============================================================ */

/* supervisorOverview(desk, actor) -> {queues, unassigned, log}.
 * The supervisor sees every dealer's queue (queued requests grouped by the
 * assigned dealer, plus the unassigned pool) and the full dealing log.
 * Read-only: everything returned is a deep copy, and mutating it cannot
 * affect the desk. Throws unless actor.role is "supervisor".
 */
function supervisorOverview(desk, actor) {
  var actErr = validateDealingActor(actor, "supervisor");
  if (actErr) throw new Error(actErr);
  if (!desk || !Array.isArray(desk.requests) || !Array.isArray(desk.log)) {
    throw new Error("desk must be {requests: [], log: []}");
  }
  var queues = {};
  var unassigned = [];
  var queued = queueFor(desk, null);
  queued.forEach(function (r) {
    if (r.dealer_id === null || r.dealer_id === undefined) {
      unassigned.push(clone(r));
    } else {
      if (!queues[r.dealer_id]) queues[r.dealer_id] = [];
      queues[r.dealer_id].push(clone(r));
    }
  });
  return {
    queues: queues,
    unassigned: unassigned,
    log: clone(desk.log)
  };
}

/* ============================================================
 * 8. Auto-processing config
 * ============================================================ */

/* defaultAutoConfig() -> per-request-type config.
 * Each type maps to {auto, maxVolume, answerTimeoutSec}:
 *   auto             — true = the desk answers eligible requests itself
 *   maxVolume        — requests above this volume stay manual
 *   answerTimeoutSec — a queued request older than this is flagged timed out
 *                      and falls back to the manual queue (20–180s range)
 */
function defaultAutoConfig() {
  var cfg = {};
  REQUEST_TYPES.forEach(function (t) {
    cfg[t] = { auto: false, maxVolume: 0, answerTimeoutSec: 60 };
  });
  return cfg;
}

/* validateAutoConfig(config) -> [error strings]; [] means valid. */
function validateAutoConfig(config) {
  var errs = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["auto config must be an object keyed by request type"];
  }
  REQUEST_TYPES.forEach(function (t) {
    var c = config[t];
    if (c === undefined) return; /* a missing type keeps its defaults */
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      errs.push(t + ": config entry must be an object");
      return;
    }
    if (typeof c.auto !== "boolean") errs.push(t + ": auto must be a boolean");
    if (!isNonNegNumber(c.maxVolume)) errs.push(t + ": maxVolume must be a non-negative number");
    if (!isFiniteNumber(c.answerTimeoutSec) ||
        c.answerTimeoutSec < 20 || c.answerTimeoutSec > 180) {
      errs.push(t + ": answerTimeoutSec must be between 20 and 180 seconds");
    }
  });
  Object.keys(config).forEach(function (k) {
    if (!inList(REQUEST_TYPES, k)) errs.push("unknown request type in config: " + k);
  });
  return errs;
}

/* configFor(config, requestType) -> effective {auto, maxVolume,
 * answerTimeoutSec} for the type (defaults for missing entries). */
function configFor(config, requestType) {
  var d = defaultAutoConfig()[requestType];
  var c = config && config[requestType];
  if (!c) return d;
  return {
    auto: c.auto,
    maxVolume: c.maxVolume,
    answerTimeoutSec: c.answerTimeoutSec
  };
}

/* needsManual(req, cfg) -> true when the request cannot be auto-processed:
 * auto is off, or the volume exceeds the type's maximum. */
function needsManual(req, cfg) {
  if (!cfg.auto) return true;
  return req.volume - cfg.maxVolume > 1e-9;
}

/* runAutoProcessing(desk, config, marketBySymbol, nowMs) -> NEW desk.
 * One automation pass over the queue (oldest first):
 *   - a queued request older than its type's answerTimeoutSec is flagged
 *     timed_out and falls back to the manual queue (stays queued);
 *   - a request whose type is on auto and whose volume is within maxVolume
 *     is executed at the current market price immediately (actor "server",
 *     logged as Done);
 *   - everything else is flagged manual and stays queued for a dealer.
 * marketBySymbol = {symbol: {bid, ask}}; nowMs defaults to Date.now().
 */
function runAutoProcessing(desk, config, marketBySymbol, nowMs) {
  var errs = validateAutoConfig(config || {});
  if (errs.length > 0) throw new Error("invalid auto config: " + errs.join("; "));
  if (!desk || !Array.isArray(desk.requests) || !Array.isArray(desk.log)) {
    throw new Error("desk must be {requests: [], log: []}");
  }
  var now = isFiniteNumber(nowMs) ? nowMs : Date.now();
  var out = clone(desk);

  var ordered = out.requests
    .filter(function (r) { return r.state === "queued"; })
    .sort(queueComparator);

  ordered.forEach(function (r) {
    var cfg = configFor(config, r.request_type);
    var ageMs = now - Date.parse(r.time_received);

    if (ageMs >= cfg.answerTimeoutSec * 1000) {
      /* Timed out: back to the manual queue. */
      r.timed_out = true;
      r.manual = true;
      return;
    }
    if (needsManual(r, cfg)) {
      r.manual = true;
      return;
    }
    /* Auto-execute at market. */
    var price;
    if (r.side === "buy" || r.side === "sell") {
      var m = marketBySymbol && marketBySymbol[r.symbol];
      price = marketPriceFor(m, r.side);
    } else {
      if (!isPosNumber(r.requested_price)) {
        r.manual = true; /* cannot price it — a dealer decides */
        return;
      }
      price = r.requested_price;
    }
    r.state = "done";
    r.time_done = new Date(now).toISOString();
    r.outcome = {
      kind: "auto_executed",
      execution_price: price,
      reject_reason: null,
      dealer_login: null
    };
    out.log.push({
      request_id: r.request_id,
      login: r.login,
      symbol: r.symbol,
      time: new Date(now).toISOString(),
      actor_login: "auto-processing",
      actor_role: "server",
      outcome: "Done",
      old_price: r.requested_price,
      new_price: price,
      volume: r.volume,
      note: "auto"
    });
  });
  return out;
}

/* ============================================================ */

var DealingDesk = {
  /* catalogs */
  REQUEST_TYPES: REQUEST_TYPES,
  REQUEST_STATES: REQUEST_STATES,
  REQUEST_TERMINAL_STATES: REQUEST_TERMINAL_STATES,
  REJECT_REASONS: REJECT_REASONS,
  LOG_OUTCOMES: LOG_OUTCOMES,
  DEALING_ROLES: DEALING_ROLES,
  OUTCOME_KINDS: OUTCOME_KINDS,
  /* desk + actors */
  newDesk: newDesk,
  validateDealingActor: validateDealingActor,
  /* requests */
  defaultRequest: defaultRequest,
  validateRequest: validateRequest,
  /* queue */
  enqueueRequest: enqueueRequest,
  queueFor: queueFor,
  nextRequest: nextRequest,
  findRequest: findRequest,
  /* log */
  validateLogEntry: validateLogEntry,
  appendDealingLog: appendDealingLog,
  dealingLogFor: dealingLogFor,
  /* dealer actions */
  marketPriceFor: marketPriceFor,
  validateCorrectedPrice: validateCorrectedPrice,
  executeAtMarket: executeAtMarket,
  executeCorrected: executeCorrected,
  rejectRequest: rejectRequest,
  /* supervisor */
  supervisorOverview: supervisorOverview,
  /* auto-processing */
  defaultAutoConfig: defaultAutoConfig,
  validateAutoConfig: validateAutoConfig,
  configFor: configFor,
  needsManual: needsManual,
  runAutoProcessing: runAutoProcessing
};

if (typeof module !== "undefined" && module.exports) { module.exports = DealingDesk; }
else { root.OrbitDealingDesk = DealingDesk; }

})(typeof globalThis !== "undefined" ? globalThis : this);
