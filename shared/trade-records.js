/* OrbitTrader — trade records: admin field models for orders, deals, positions.
 *
 * This module models the ADMIN field specs of trading records: which fields
 * every order / deal / position carries, how orders move through their
 * lifecycle (state machine), how every modification is audited, and how
 * per-record operation journals and trading-operation reports are built.
 *
 * It deliberately does NOT do position accounting (netting/hedging merge,
 * close, closeBy) — that lives in shared/positions.js. What lives here is
 * the record-keeping layer: field catalogs, state transitions, audit entries,
 * journals, and report aggregation.
 *
 * Pure functions, no globals, no DOM: runs in the browser and in node
 * (guarded export at the bottom; browser global is OrbitTradeRecords).
 *
 * Terminology is neutral OrbitTrader terminology.
 */
(function (root) {
"use strict";

/* ============================================================
 * 1. Catalogs (enumerations)
 * ============================================================ */

/* The eight order types an admin can see on an order. */
var ORDER_TYPES = [
  "buy_market", "sell_market",
  "buy_limit", "sell_limit",
  "buy_stop", "sell_stop",
  "buy_stop_limit", "sell_stop_limit"
];

/* Order lifecycle states. */
var ORDER_STATES = [
  "pending",      /* accepted, waiting (market orders pass through instantly) */
  "activated",    /* a stop/limit order whose trigger price was reached and
                     is now being executed (transient, informational) */
  "filled",       /* fully executed */
  "partially_filled", /* partially executed (leftover moved on / cancelled) */
  "cancelled",    /* withdrawn before execution */
  "expired",      /* expired by its expiration time */
  "rejected"      /* refused by the server (validation, risk, session gate) */
];

/* Terminal states: no further transitions allowed. */
var ORDER_TERMINAL_STATES = ["filled", "cancelled", "expired", "rejected"];

/* Which transitions are legal from each state. */
var ORDER_TRANSITIONS = {
  pending:          ["activated", "partially_filled", "filled", "cancelled", "expired", "rejected"],
  activated:        ["partially_filled", "filled", "cancelled", "expired", "rejected"],
  partially_filled: ["filled", "cancelled", "expired", "rejected"],
  filled:           [],
  cancelled:        [],
  expired:          [],
  rejected:         []
};

/* Filling policies: how much of the requested volume must be filled. */
var FILLING_POLICIES = [
  "fill_or_kill",      /* fill the whole volume or cancel */
  "immediate_or_cancel", /* fill as much as possible now, cancel the rest */
  "book_or_cancel",    /* fill only the quoted volume, rest goes to the book */
  "return"             /* whatever can be filled fills; remainder stays */
];

/* Who/what performed an operation (modification audit + journal actors). */
var ACTOR_SOURCES = [
  "administrator",  /* server administrator */
  "manager",        /* dealing/back-office manager */
  "api",            /* manager or web API call */
  "server",         /* server-side automation (EOD, rollover, stop-out) */
  "gateway"        /* external liquidity gateway */
];

/* Reason catalog for order/deal operations. */
var OPERATION_REASONS = [
  "client",    /* trader's own request */
  "expert",    /* automated strategy on the trader's terminal */
  "dealer",    /* manual dealer action */
  "stop_loss", /* triggered by the order's stop-loss price */
  "take_profit", /* triggered by the order's take-profit price */
  "stop_out",  /* forced close by the margin engine (SO) */
  "rollover",  /* end-of-day rollover / swap processing */
  "gateway",   /* liquidity-gateway execution or correction */
  "signal"     /* trade-signal subscription action */
];

/* Deal actions: trade entries plus balance operations. */
var DEAL_ACTIONS = [
  "in",            /* opens/increases a position */
  "out",           /* reduces/closes a position */
  "in_out",        /* in then out in one step (reversal) */
  "balance",       /* deposit / withdrawal */
  "credit",        /* credit facility in / out */
  "charge",        /* subscription or service charge */
  "correction",    /* manual balance correction */
  "bonus",         /* promotional bonus in / out */
  "commission",    /* instant per-deal commission */
  "commission_daily",  /* daily aggregated commission */
  "commission_monthly", /* monthly aggregated commission */
  "commission_agent",  /* agent/IB commission */
  "interest_rate", /* interest on free margin */
  "dividend",      /* dividend adjustment */
  "tax",           /* tax withholding */
  "so_compensation" /* stop-out negative-balance compensation */
];

/* Deal actions that are balance operations rather than trades. */
var BALANCE_DEAL_ACTIONS = [
  "balance", "credit", "charge", "correction", "bonus",
  "commission", "commission_daily", "commission_monthly", "commission_agent",
  "interest_rate", "dividend", "tax", "so_compensation"
];

/* Deal action groups for reporting. */
var DEAL_ACTION_GROUPS = {
  trade: ["in", "out", "in_out"],
  balance_ops: BALANCE_DEAL_ACTIONS
};

/* Position states (open positions live in the trade book; closed move to history). */
var POSITION_STATES = ["open", "closed"];

/* SL/TP ownership: whose the protective levels are. */
var SLTP_OWNERS = ["trader", "manager", "server"];

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

/* ============================================================
 * 3. Order field model
 * ============================================================ */

/* defaultOrder(login, symbol) -> a blank order record with sane defaults.
 * Field-by-field (admin field spec):
 *   ticket            — unique order identifier (server-assigned on insert)
 *   login             — owning account login
 *   symbol            — traded symbol
 *   type              — one of ORDER_TYPES
 *   state             — one of ORDER_STATES ("pending" at creation)
 *   filling_policy    — one of FILLING_POLICIES
 *   volume            — requested volume (lots/units), positive
 *   volume_filled     — already executed volume, starts 0
 *   price_open        — requested/limit/stop price (0 for market when the
 *                       market price at receipt applies)
 *   price_trigger     — stop-limit trigger price (stop-limit orders only)
 *   price_sl / price_tp — protective levels attached at order time
 *   expiration        — ISO datetime string or null (GTC)
 *   activation_disabled — true = order will NOT trigger even if price
 *                       reaches it (admin/dealer hold flag)
 *   time_setup        — creation time (ISO)
 *   time_done         — terminal-state time (ISO) or null
 *   expert_id         — strategy identifier ("magic number"), 0 = manual
 *   party_id          — external party reference (gateway / bridge)
 *   dealer_id         — dealer/manager login that last touched the order
 *   reason            — OPERATION_REASONS entry for the last operation
 *   comment           — free-text note
 *   modifications     — audit trail of changes (see modifyOrder)
 */
function defaultOrder(login, symbol) {
  return {
    ticket: null,
    login: login,
    symbol: symbol,
    type: null,
    state: "pending",
    filling_policy: "return",
    volume: 0,
    volume_filled: 0,
    price_open: 0,
    price_trigger: null,
    price_sl: null,
    price_tp: null,
    expiration: null,
    activation_disabled: false,
    time_setup: nowIso(),
    time_done: null,
    expert_id: 0,
    party_id: null,
    dealer_id: null,
    reason: null,
    comment: "",
    modifications: []
  };
}

/* validateOrder(order) -> error string or null. */
function validateOrder(order) {
  if (!order || typeof order !== "object") return "order must be an object";
  if (typeof order.login !== "string" || order.login === "") return "order.login must be a non-empty string";
  if (typeof order.symbol !== "string" || order.symbol === "") return "order.symbol must be a non-empty string";
  if (!inList(ORDER_TYPES, order.type)) return "order.type must be one of: " + ORDER_TYPES.join(", ");
  if (!inList(ORDER_STATES, order.state)) return "order.state must be one of: " + ORDER_STATES.join(", ");
  if (!inList(FILLING_POLICIES, order.filling_policy)) return "order.filling_policy must be one of: " + FILLING_POLICIES.join(", ");
  if (!isPosNumber(order.volume)) return "order.volume must be a positive number";
  if (!isNonNegNumber(order.volume_filled)) return "order.volume_filled must be a non-negative number";
  if (order.volume_filled - order.volume > 1e-9) return "order.volume_filled cannot exceed order.volume";
  if (!isNonNegNumber(order.price_open)) return "order.price_open must be a non-negative number";
  if (order.price_trigger !== null && order.price_trigger !== undefined && !isPosNumber(order.price_trigger)) {
    return "order.price_trigger must be a positive number or null";
  }
  if (order.price_sl !== null && order.price_sl !== undefined && !isPosNumber(order.price_sl)) {
    return "order.price_sl must be a positive number or null";
  }
  if (order.price_tp !== null && order.price_tp !== undefined && !isPosNumber(order.price_tp)) {
    return "order.price_tp must be a positive number or null";
  }
  if (order.expiration !== null && order.expiration !== undefined && isNaN(Date.parse(order.expiration))) {
    return "order.expiration must be an ISO datetime string or null";
  }
  if (typeof order.activation_disabled !== "boolean") return "order.activation_disabled must be a boolean";
  if (order.reason !== null && order.reason !== undefined && !inList(OPERATION_REASONS, order.reason)) {
    return "order.reason must be one of: " + OPERATION_REASONS.join(", ");
  }
  if (!Number.isInteger(order.expert_id) || order.expert_id < 0) return "order.expert_id must be a non-negative integer";
  if (!Array.isArray(order.modifications)) return "order.modifications must be an array";
  return null;
}

/* canTransitionOrder(from, to) -> boolean. */
function canTransitionOrder(from, to) {
  if (!inList(ORDER_STATES, from) || !inList(ORDER_STATES, to)) return false;
  return inList(ORDER_TRANSITIONS[from] || [], to);
}

/* transitionOrder(order, to, actor, reason) -> NEW order with the state
 * changed and the transition appended to the modifications audit.
 * actor = {source: ACTOR_SOURCES entry, login: string}
 * Throws on illegal transition or unknown actor source.
 */
function transitionOrder(order, to, actor, reason) {
  var err = validateOrder(order);
  if (err) throw new Error(err);
  if (!inList(ORDER_STATES, to)) throw new Error("unknown target state: " + String(to));
  if (!canTransitionOrder(order.state, to)) {
    throw new Error("illegal order transition " + order.state + " -> " + to);
  }
  var actErr = validateActor(actor);
  if (actErr) throw new Error(actErr);
  if (reason !== null && reason !== undefined && !inList(OPERATION_REASONS, reason)) {
    throw new Error("unknown reason: " + String(reason));
  }

  var out = clone(order);
  out.state = to;
  out.reason = reason === undefined ? null : reason;
  if (inList(ORDER_TERMINAL_STATES, to)) out.time_done = nowIso();
  out.modifications.push({
    time: nowIso(),
    actor_source: actor.source,
    actor_login: actor.login,
    action: "state_change",
    field_changes: { state: { from: order.state, to: to } },
    reason: out.reason
  });
  return out;
}

/* modifyOrder(order, changes, actor, reason) -> NEW order.
 * Allowed mutable fields: price_open, price_trigger, price_sl, price_tp,
 * volume (reduction only), expiration, activation_disabled, comment, dealer_id.
 * Every changed field is recorded old -> new in the audit entry.
 * Only pending orders (or partially filled, for SL/TP/volume reductions)
 * may be modified.
 */
var ORDER_MUTABLE_FIELDS = [
  "price_open", "price_trigger", "price_sl", "price_tp",
  "volume", "expiration", "activation_disabled", "comment", "dealer_id"
];

function modifyOrder(order, changes, actor, reason) {
  var err = validateOrder(order);
  if (err) throw new Error(err);
  if (inList(ORDER_TERMINAL_STATES, order.state)) {
    throw new Error("cannot modify an order in terminal state " + order.state);
  }
  if (order.state === "activated") {
    throw new Error("cannot modify an order while it is being executed (activated)");
  }
  var actErr = validateActor(actor);
  if (actErr) throw new Error(actErr);
  if (!changes || typeof changes !== "object") throw new Error("changes must be an object");

  var fieldChanges = {};
  var keys = Object.keys(changes);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!inList(ORDER_MUTABLE_FIELDS, k)) {
      throw new Error("field is not modifiable: " + k);
    }
    var oldV = order[k];
    var newV = changes[k];
    if (k === "volume") {
      if (!isPosNumber(newV)) throw new Error("volume must stay a positive number");
      if (newV - order.volume > 1e-9) throw new Error("volume may only be reduced by modification");
      if (newV - order.volume_filled < -1e-9) throw new Error("volume cannot drop below volume_filled");
    }
    if (snap(oldV) !== snap(newV)) fieldChanges[k] = { from: oldV, to: newV };
  }
  if (Object.keys(fieldChanges).length === 0) {
    throw new Error("no effective changes supplied");
  }

  var out = clone(order);
  for (var f in fieldChanges) out[f] = fieldChanges[f].to;
  out.reason = reason === undefined ? null : reason;
  if (reason !== null && reason !== undefined && !inList(OPERATION_REASONS, reason)) {
    throw new Error("unknown reason: " + String(reason));
  }
  out.modifications.push({
    time: nowIso(),
    actor_source: actor.source,
    actor_login: actor.login,
    action: "modify",
    field_changes: fieldChanges,
    reason: out.reason
  });
  return out;
}

/* validateActor(actor) -> error string or null. */
function validateActor(actor) {
  if (!actor || typeof actor !== "object") return "actor must be an object";
  if (!inList(ACTOR_SOURCES, actor.source)) return "actor.source must be one of: " + ACTOR_SOURCES.join(", ");
  if (typeof actor.login !== "string" || actor.login === "") return "actor.login must be a non-empty string";
  return null;
}

function snap(v) { return JSON.stringify(v === undefined ? null : v); }

/* ============================================================
 * 4. Deal field model
 * ============================================================ */

/* defaultDeal() -> a blank deal record with sane defaults.
 * Field-by-field (admin field spec):
 *   deal_id         — unique deal identifier
 *   login           — owning account login
 *   symbol          — traded symbol (null for pure balance ops)
 *   action          — one of DEAL_ACTIONS
 *   entry           — "in" | "out" | "in_out" for trade deals, null otherwise
 *   order_ticket    — originating order ticket (null for balance ops)
 *   position_id     — affected position (null for balance ops)
 *   direction       — "buy" | "sell" for trade deals
 *   volume          — executed volume (0 for balance ops)
 *   price           — platform execution price
 *   price_gateway   — price at which the gateway filled (may differ)
 *   volume_gateway  — volume the gateway filled (may differ)
 *   profit          — realized profit of the deal (account currency)
 *   commission      — commission charged on the deal
 *   swap            — swap charged/credited on the deal
 *   market_bid / market_ask / market_last — market snapshot at execution
 *   dealer_id       — dealer/gateway identifier that executed it
 *   gateway_id      — gateway the deal came through (null = internal)
 *   reason          — OPERATION_REASONS entry
 *   comment         — free-text note (e.g. "[so 42%]", "[sl 1.0850]")
 *   time            — execution time (ISO)
 */
function defaultDeal() {
  return {
    deal_id: null,
    login: null,
    symbol: null,
    action: null,
    entry: null,
    order_ticket: null,
    position_id: null,
    direction: null,
    volume: 0,
    price: 0,
    price_gateway: null,
    volume_gateway: null,
    profit: 0,
    commission: 0,
    swap: 0,
    market_bid: null,
    market_ask: null,
    market_last: null,
    dealer_id: null,
    gateway_id: null,
    reason: null,
    comment: "",
    time: nowIso()
  };
}

/* validateDeal(deal) -> error string or null. */
function validateDeal(deal) {
  if (!deal || typeof deal !== "object") return "deal must be an object";
  if (typeof deal.login !== "string" || deal.login === "") return "deal.login must be a non-empty string";
  if (!inList(DEAL_ACTIONS, deal.action)) return "deal.action must be one of: " + DEAL_ACTIONS.join(", ");
  var isBalance = inList(BALANCE_DEAL_ACTIONS, deal.action);
  var isTrade = inList(DEAL_ACTION_GROUPS.trade, deal.action);

  if (isTrade) {
    if (typeof deal.symbol !== "string" || deal.symbol === "") return "trade deals need deal.symbol";
    if (!inList(["in", "out", "in_out"], deal.entry)) return 'trade deals need deal.entry "in"|"out"|"in_out"';
    if (deal.direction !== "buy" && deal.direction !== "sell") return 'trade deals need deal.direction "buy"|"sell"';
    if (!isPosNumber(deal.volume)) return "trade deals need a positive deal.volume";
    if (!isPosNumber(deal.price)) return "trade deals need a positive deal.price";
    if (deal.order_ticket === null || deal.order_ticket === undefined) return "trade deals need deal.order_ticket";
  } else if (isBalance) {
    if (deal.entry !== null && deal.entry !== undefined) return "balance deals must not carry deal.entry";
  }
  if (deal.price_gateway !== null && deal.price_gateway !== undefined && !isPosNumber(deal.price_gateway)) {
    return "deal.price_gateway must be a positive number or null";
  }
  if (deal.volume_gateway !== null && deal.volume_gateway !== undefined && !isPosNumber(deal.volume_gateway)) {
    return "deal.volume_gateway must be a positive number or null";
  }
  if (!isFiniteNumber(deal.profit)) return "deal.profit must be a number";
  if (!isFiniteNumber(deal.commission)) return "deal.commission must be a number";
  if (!isFiniteNumber(deal.swap)) return "deal.swap must be a number";
  if (deal.reason !== null && deal.reason !== undefined && !inList(OPERATION_REASONS, deal.reason)) {
    return "deal.reason must be one of: " + OPERATION_REASONS.join(", ");
  }
  if (isNaN(Date.parse(deal.time))) return "deal.time must be an ISO datetime string";
  return null;
}

/* dealFillDeviation(deal) -> {price_deviation_points? , ...} — compare the
 * gateway fill against the platform execution price. Returns nulls when the
 * gateway fields are absent. points_per_price converts a price difference
 * into points (e.g. 10^digits). Pure comparison, no policy attached.
 */
function dealFillDeviation(deal, points_per_price) {
  if (!isPosNumber(points_per_price)) throw new Error("points_per_price must be a positive number");
  var err = validateDeal(deal);
  if (err) throw new Error(err);
  var priceDev = (deal.price_gateway === null || deal.price_gateway === undefined)
    ? null : (deal.price_gateway - deal.price) * points_per_price;
  var volDev = (deal.volume_gateway === null || deal.volume_gateway === undefined)
    ? null : deal.volume_gateway - deal.volume;
  return { price_deviation_points: priceDev, volume_deviation: volDev };
}

/* ============================================================
 * 5. Position field model
 * ============================================================ */

/* defaultPosition(login, symbol) -> a blank position record.
 * Field-by-field (admin field spec):
 *   position_id     — unique position identifier ("ticket" in admin UI)
 *   login / symbol
 *   direction       — "buy" | "sell"
 *   volume          — current open volume
 *   price_open      — volume-weighted average open price (see weightedAvgPrice)
 *   price_current   — last valuation price
 *   price_sl / price_tp — protective levels
 *   sltp_owner      — who owns the SL/TP: trader | manager | server
 *   activation_disabled — protective levels will not trigger while true
 *   swap / commission — accrued values
 *   profit          — unrealized profit at price_current (account currency)
 *   gateway_markup_points — markup the gateway added over the raw price
 *   state           — "open" | "closed"
 *   time_open / time_close — ISO datetimes
 *   reason          — reason of the last operation
 *   comment
 */
function defaultPosition(login, symbol) {
  return {
    position_id: null,
    login: login,
    symbol: symbol,
    direction: null,
    volume: 0,
    price_open: 0,
    price_current: null,
    price_sl: null,
    price_tp: null,
    sltp_owner: "trader",
    activation_disabled: false,
    swap: 0,
    commission: 0,
    profit: 0,
    gateway_markup_points: 0,
    state: "open",
    time_open: nowIso(),
    time_close: null,
    reason: null,
    comment: ""
  };
}

/* validatePosition(pos) -> error string or null. */
function validatePosition(pos) {
  if (!pos || typeof pos !== "object") return "position must be an object";
  if (typeof pos.login !== "string" || pos.login === "") return "position.login must be a non-empty string";
  if (typeof pos.symbol !== "string" || pos.symbol === "") return "position.symbol must be a non-empty string";
  if (pos.direction !== "buy" && pos.direction !== "sell") return 'position.direction must be "buy" or "sell"';
  if (!isNonNegNumber(pos.volume)) return "position.volume must be a non-negative number";
  if (!isPosNumber(pos.price_open)) return "position.price_open must be a positive number";
  if (pos.price_current !== null && pos.price_current !== undefined && !isPosNumber(pos.price_current)) {
    return "position.price_current must be a positive number or null";
  }
  if (pos.price_sl !== null && pos.price_sl !== undefined && !isPosNumber(pos.price_sl)) {
    return "position.price_sl must be a positive number or null";
  }
  if (pos.price_tp !== null && pos.price_tp !== undefined && !isPosNumber(pos.price_tp)) {
    return "position.price_tp must be a positive number or null";
  }
  if (!inList(SLTP_OWNERS, pos.sltp_owner)) return "position.sltp_owner must be one of: " + SLTP_OWNERS.join(", ");
  if (typeof pos.activation_disabled !== "boolean") return "position.activation_disabled must be a boolean";
  if (!isFiniteNumber(pos.gateway_markup_points)) return "position.gateway_markup_points must be a number";
  if (!inList(POSITION_STATES, pos.state)) return "position.state must be one of: " + POSITION_STATES.join(", ");
  if (pos.reason !== null && pos.reason !== undefined && !inList(OPERATION_REASONS, pos.reason)) {
    return "position.reason must be one of: " + OPERATION_REASONS.join(", ");
  }
  return null;
}

/* weightedAvgPrice(fills) -> number.
 * The position's open price is the volume-weighted average of its fills:
 *   sum(price_i * volume_i) / sum(volume_i)
 * fills = [{price, volume}, ...], all positive. Throws on empty/invalid input.
 * (Field-level computation for the position record; the merge mechanics of
 * netting/hedging accounting live in shared/positions.js.)
 */
function weightedAvgPrice(fills) {
  if (!Array.isArray(fills) || fills.length === 0) throw new Error("fills must be a non-empty array");
  var num = 0, den = 0;
  for (var i = 0; i < fills.length; i++) {
    var f = fills[i];
    if (!f || !isPosNumber(f.price) || !isPosNumber(f.volume)) {
      throw new Error("each fill needs positive price and volume");
    }
    num += f.price * f.volume;
    den += f.volume;
  }
  return num / den;
}

/* ============================================================
 * 6. Operation journal
 * ============================================================ */

/* A journal is a per-record, append-only, chronological event log.
 * addJournalEntry(journal, entry) -> NEW journal array with the entry appended.
 * entry = {record_type: "order"|"deal"|"position",
 *          record_id, time (ISO, defaults to now), actor: {source, login},
 *          action: string, field_changes: {field: {from, to}}, reason, comment}
 * Entries are validated; time is filled in when absent.
 */
var JOURNAL_RECORD_TYPES = ["order", "deal", "position"];

function validateJournalEntry(entry) {
  if (!entry || typeof entry !== "object") return "entry must be an object";
  if (!inList(JOURNAL_RECORD_TYPES, entry.record_type)) {
    return "entry.record_type must be one of: " + JOURNAL_RECORD_TYPES.join(", ");
  }
  if (entry.record_id === null || entry.record_id === undefined || entry.record_id === "") {
    return "entry.record_id is required";
  }
  if (entry.time !== undefined && entry.time !== null && isNaN(Date.parse(entry.time))) {
    return "entry.time must be an ISO datetime string";
  }
  var actErr = validateActor(entry.actor);
  if (actErr) return actErr;
  if (typeof entry.action !== "string" || entry.action === "") return "entry.action must be a non-empty string";
  if (entry.field_changes !== undefined && entry.field_changes !== null &&
      (typeof entry.field_changes !== "object" || Array.isArray(entry.field_changes))) {
    return "entry.field_changes must be an object";
  }
  if (entry.reason !== null && entry.reason !== undefined && !inList(OPERATION_REASONS, entry.reason)) {
    return "entry.reason must be one of: " + OPERATION_REASONS.join(", ");
  }
  return null;
}

function addJournalEntry(journal, entry) {
  if (!Array.isArray(journal)) throw new Error("journal must be an array");
  var err = validateJournalEntry(entry);
  if (err) throw new Error(err);
  var e = clone(entry);
  if (e.time === undefined || e.time === null) e.time = nowIso();
  if (e.field_changes === undefined) e.field_changes = {};
  if (e.comment === undefined) e.comment = "";
  if (e.reason === undefined) e.reason = null;
  var out = journal.slice();
  out.push(e);
  return out;
}

/* journalFor(journal, record_type, record_id) -> entries for one record,
 * oldest first (insertion order is chronological by construction).
 */
function journalFor(journal, record_type, record_id) {
  if (!Array.isArray(journal)) throw new Error("journal must be an array");
  return journal.filter(function (e) {
    return e.record_type === record_type && String(e.record_id) === String(record_id);
  });
}

/* ============================================================
 * 7. Trading operation report
 * ============================================================ */

/* buildOperationReport({orders, deals, positions, login, from, to}) -> report.
 * Aggregates trading activity over a set of already-filtered records:
 *   orders:  {placed, filled, cancelled, expired, rejected, modified}
 *   deals:   counts + volume per action, trade volume totals
 *   money:   {profit, commission, swap, balance_in, balance_out, bonus_in, bonus_out}
 *   positions_open: count of open positions
 * Money-direction convention: deal.profit >= 0 counts into the "in" bucket
 * only for explicit balance-type actions listed below; the caller passes
 * signed amounts via profit fields on deals.
 */
var MONEY_IN_ACTIONS = ["balance", "credit", "bonus", "correction", "interest_rate", "dividend", "so_compensation"];
var MONEY_OUT_ACTIONS = ["charge", "commission", "commission_daily", "commission_monthly", "commission_agent", "tax"];

function buildOperationReport(input) {
  if (!input || typeof input !== "object") throw new Error("input must be an object");
  var orders = input.orders || [];
  var deals = input.deals || [];
  var positions = input.positions || [];

  var orderStats = { placed: 0, filled: 0, partially_filled: 0, cancelled: 0, expired: 0, rejected: 0, modified: 0 };
  orders.forEach(function (o) {
    orderStats.placed++;
    if (o.state === "filled") orderStats.filled++;
    else if (o.state === "partially_filled") orderStats.partially_filled++;
    else if (o.state === "cancelled") orderStats.cancelled++;
    else if (o.state === "expired") orderStats.expired++;
    else if (o.state === "rejected") orderStats.rejected++;
    if (Array.isArray(o.modifications) && o.modifications.length > 0) orderStats.modified++;
  });

  var dealStats = { by_action: {}, trade_volume: 0, trade_count: 0 };
  var money = { profit: 0, commission: 0, swap: 0, in_total: 0, out_total: 0 };
  deals.forEach(function (d) {
    var a = d.action;
    dealStats.by_action[a] = (dealStats.by_action[a] || 0) + 1;
    if (inList(DEAL_ACTION_GROUPS.trade, a)) {
      dealStats.trade_count++;
      dealStats.trade_volume += (isFiniteNumber(d.volume) ? d.volume : 0);
      money.profit += (isFiniteNumber(d.profit) ? d.profit : 0);
    }
    money.commission += (isFiniteNumber(d.commission) ? d.commission : 0);
    money.swap += (isFiniteNumber(d.swap) ? d.swap : 0);
    var amt = isFiniteNumber(d.profit) ? d.profit : 0;
    if (inList(MONEY_IN_ACTIONS, a) && amt > 0) money.in_total += amt;
    if (inList(MONEY_OUT_ACTIONS, a)) money.out_total += Math.abs(amt) + Math.abs(isFiniteNumber(d.commission) ? d.commission : 0);
  });

  var openPositions = positions.filter(function (p) { return p.state === "open"; }).length;

  return {
    login: input.login === undefined ? null : input.login,
    from: input.from === undefined ? null : input.from,
    to: input.to === undefined ? null : input.to,
    generated_at: nowIso(),
    orders: orderStats,
    deals: dealStats,
    money: money,
    positions_open: openPositions
  };
}

/* ============================================================ */

var TradeRecords = {
  /* catalogs */
  ORDER_TYPES: ORDER_TYPES,
  ORDER_STATES: ORDER_STATES,
  ORDER_TERMINAL_STATES: ORDER_TERMINAL_STATES,
  ORDER_TRANSITIONS: ORDER_TRANSITIONS,
  FILLING_POLICIES: FILLING_POLICIES,
  ACTOR_SOURCES: ACTOR_SOURCES,
  OPERATION_REASONS: OPERATION_REASONS,
  DEAL_ACTIONS: DEAL_ACTIONS,
  BALANCE_DEAL_ACTIONS: BALANCE_DEAL_ACTIONS,
  DEAL_ACTION_GROUPS: DEAL_ACTION_GROUPS,
  POSITION_STATES: POSITION_STATES,
  SLTP_OWNERS: SLTP_OWNERS,
  ORDER_MUTABLE_FIELDS: ORDER_MUTABLE_FIELDS,
  JOURNAL_RECORD_TYPES: JOURNAL_RECORD_TYPES,
  /* orders */
  defaultOrder: defaultOrder,
  validateOrder: validateOrder,
  validateActor: validateActor,
  canTransitionOrder: canTransitionOrder,
  transitionOrder: transitionOrder,
  modifyOrder: modifyOrder,
  /* deals */
  defaultDeal: defaultDeal,
  validateDeal: validateDeal,
  dealFillDeviation: dealFillDeviation,
  /* positions */
  defaultPosition: defaultPosition,
  validatePosition: validatePosition,
  weightedAvgPrice: weightedAvgPrice,
  /* journal */
  validateJournalEntry: validateJournalEntry,
  addJournalEntry: addJournalEntry,
  journalFor: journalFor,
  /* report */
  buildOperationReport: buildOperationReport
};

if (typeof module !== "undefined" && module.exports) { module.exports = TradeRecords; }
else { root.OrbitTradeRecords = TradeRecords; }

})(typeof globalThis !== "undefined" ? globalThis : this);
