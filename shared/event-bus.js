/* shared/event-bus.js — OrbitTrader platform event catalog + in-process event bus.
 *
 * Reimplements (in OrbitTrader's own design) the "event streaming" integration
 * concept: platform events published for real-time analysis, security
 * monitoring, business intelligence, machine-learning pipelines, and CRM.
 *
 * Contents:
 *   1. EVENT CATALOG — named, versioned event definitions grouped into five
 *      categories (trading operations, price data, configuration changes,
 *      account changes, client updates) plus security and system events.
 *      Each definition carries: name, version, category, severity, a payload
 *      schema (typed fields with required flags), and whether the last
 *      occurrence is retained by the bus.
 *   2. createBus() — in-process publish/subscribe bus with topic filters
 *      (dot-separated segments, "*" wildcard), synchronous dispatch,
 *      strict catalog validation on emit, and a retained last-event cache.
 *   3. createSink(config) — a neutral, vendor-agnostic streaming sink: a
 *      queued adapter with batching and a pluggable transport. The default
 *      transport is inert (no network), so unit tests and offline deploys
 *      never emit traffic. attachToBus() wires a sink to a bus.
 *
 * Pure functions, no globals, no DOM: runs in the browser and in node
 * (guarded export at the bottom, same pattern as shared/groups.js).
 */
(function (root) {
"use strict";

/* ============================== 1. CATALOG ============================== */

var SEVERITIES = ["info", "warning", "critical"];
var CATEGORIES = ["trading", "market", "config", "account", "client", "security", "system"];

/* Schema field: { type: "string"|"number"|"integer"|"boolean", required: bool, desc: string }.
 * All field names, types and semantics are OrbitTrader's own. */
var EVENT_DEFINITIONS = [
  /* ---- trading operations ---- */
  { name: "order.created", version: 1, category: "trading", severity: "info", retained: true,
    desc: "A new order was accepted into the order book.",
    fields: [
      { name: "order_id", type: "string", required: true, desc: "Order ticket" },
      { name: "account_id", type: "string", required: true, desc: "Owning account login" },
      { name: "symbol", type: "string", required: true, desc: "Instrument symbol" },
      { name: "side", type: "string", required: true, desc: "'buy' or 'sell'" },
      { name: "order_type", type: "string", required: true, desc: "Order type (market/limit/stop/stop_limit)" },
      { name: "volume", type: "number", required: true, desc: "Requested volume in lots" },
      { name: "price", type: "number", required: false, desc: "Limit/stop price (0 for market)" },
      { name: "source", type: "string", required: false, desc: "Origin: client/api/manager/dealer" }
    ] },
  { name: "order.modified", version: 1, category: "trading", severity: "info", retained: true,
    desc: "Price, SL/TP, expiration or volume of a live order changed.",
    fields: [
      { name: "order_id", type: "string", required: true, desc: "Order ticket" },
      { name: "account_id", type: "string", required: true, desc: "Owning account login" },
      { name: "changes", type: "string", required: true, desc: "Comma-separated list of changed fields" },
      { name: "actor", type: "string", required: false, desc: "Who modified it (account/manager/server)" }
    ] },
  { name: "order.cancelled", version: 1, category: "trading", severity: "info", retained: true,
    desc: "A pending order was cancelled or expired.",
    fields: [
      { name: "order_id", type: "string", required: true, desc: "Order ticket" },
      { name: "account_id", type: "string", required: true, desc: "Owning account login" },
      { name: "reason", type: "string", required: false, desc: "Reason (client/expert/expired/server)" }
    ] },
  { name: "order.rejected", version: 1, category: "trading", severity: "warning", retained: false,
    desc: "A trade request was rejected before reaching the book.",
    fields: [
      { name: "account_id", type: "string", required: true, desc: "Owning account login" },
      { name: "symbol", type: "string", required: false, desc: "Instrument symbol" },
      { name: "reject_code", type: "string", required: true, desc: "Machine-readable reject reason" },
      { name: "detail", type: "string", required: false, desc: "Human-readable explanation" }
    ] },
  { name: "order.filled", version: 1, category: "trading", severity: "info", retained: true,
    desc: "An order executed, fully or partially.",
    fields: [
      { name: "order_id", type: "string", required: true, desc: "Order ticket" },
      { name: "deal_id", type: "string", required: true, desc: "Resulting deal ticket" },
      { name: "account_id", type: "string", required: true, desc: "Owning account login" },
      { name: "symbol", type: "string", required: true, desc: "Instrument symbol" },
      { name: "volume", type: "number", required: true, desc: "Executed volume in lots" },
      { name: "price", type: "number", required: true, desc: "Execution price" }
    ] },
  { name: "deal.created", version: 1, category: "trading", severity: "info", retained: true,
    desc: "A deal (balance-affecting trade record) was written.",
    fields: [
      { name: "deal_id", type: "string", required: true, desc: "Deal ticket" },
      { name: "account_id", type: "string", required: true, desc: "Owning account login" },
      { name: "action", type: "string", required: true, desc: "Deal action (in/out/in_out/balance/credit/...)" },
      { name: "symbol", type: "string", required: false, desc: "Instrument symbol" },
      { name: "volume", type: "number", required: false, desc: "Volume in lots" },
      { name: "profit", type: "number", required: false, desc: "Deal profit in account currency" }
    ] },
  { name: "position.opened", version: 1, category: "trading", severity: "info", retained: true,
    desc: "A new position exists for the account.",
    fields: [
      { name: "position_id", type: "string", required: true, desc: "Position ticket" },
      { name: "account_id", type: "string", required: true, desc: "Owning account login" },
      { name: "symbol", type: "string", required: true, desc: "Instrument symbol" },
      { name: "side", type: "string", required: true, desc: "'buy' or 'sell'" },
      { name: "volume", type: "number", required: true, desc: "Position volume in lots" },
      { name: "open_price", type: "number", required: true, desc: "Weighted average open price" }
    ] },
  { name: "position.modified", version: 1, category: "trading", severity: "info", retained: true,
    desc: "Position SL/TP or volume changed.",
    fields: [
      { name: "position_id", type: "string", required: true, desc: "Position ticket" },
      { name: "account_id", type: "string", required: true, desc: "Owning account login" },
      { name: "changes", type: "string", required: true, desc: "Comma-separated list of changed fields" }
    ] },
  { name: "position.closed", version: 1, category: "trading", severity: "info", retained: true,
    desc: "A position closed fully or partially.",
    fields: [
      { name: "position_id", type: "string", required: true, desc: "Position ticket" },
      { name: "account_id", type: "string", required: true, desc: "Owning account login" },
      { name: "symbol", type: "string", required: true, desc: "Instrument symbol" },
      { name: "volume", type: "number", required: true, desc: "Closed volume in lots" },
      { name: "close_price", type: "number", required: true, desc: "Close price" },
      { name: "profit", type: "number", required: true, desc: "Realised profit in account currency" },
      { name: "reason", type: "string", required: false, desc: "Reason (client/sl/tp/stopout/rollover)" }
    ] },
  { name: "margin.call", version: 1, category: "trading", severity: "warning", retained: true,
    desc: "Account margin level crossed the broker's margin-call threshold.",
    fields: [
      { name: "account_id", type: "string", required: true, desc: "Account login" },
      { name: "margin_level", type: "number", required: true, desc: "Margin level percent at trigger" },
      { name: "equity", type: "number", required: false, desc: "Equity at trigger" }
    ] },
  { name: "stopout.triggered", version: 1, category: "trading", severity: "critical", retained: true,
    desc: "Forced close sequence started at the stop-out level.",
    fields: [
      { name: "account_id", type: "string", required: true, desc: "Account login" },
      { name: "margin_level", type: "number", required: true, desc: "Margin level percent at trigger" },
      { name: "closed_count", type: "integer", required: false, desc: "Positions closed by the sequence" }
    ] },

  /* ---- price data ---- */
  { name: "tick.received", version: 1, category: "market", severity: "info", retained: true,
    desc: "Accepted tick from a price feed for a symbol.",
    fields: [
      { name: "symbol", type: "string", required: true, desc: "Instrument symbol" },
      { name: "bid", type: "number", required: true, desc: "Bid quote" },
      { name: "ask", type: "number", required: true, desc: "Ask quote" },
      { name: "source", type: "string", required: false, desc: "Feed identifier" }
    ] },
  { name: "bar.closed", version: 1, category: "market", severity: "info", retained: false,
    desc: "A completed price bar was written to history.",
    fields: [
      { name: "symbol", type: "string", required: true, desc: "Instrument symbol" },
      { name: "timeframe", type: "string", required: true, desc: "Timeframe label (e.g. 'M1')" },
      { name: "open_time", type: "integer", required: true, desc: "Bar open time (unix seconds)" },
      { name: "close", type: "number", required: true, desc: "Bar close price" }
    ] },
  { name: "session.status.changed", version: 1, category: "market", severity: "info", retained: true,
    desc: "Quoting or trading session state changed for a symbol.",
    fields: [
      { name: "symbol", type: "string", required: true, desc: "Instrument symbol" },
      { name: "session_kind", type: "string", required: true, desc: "'quotes' or 'trade'" },
      { name: "new_status", type: "string", required: true, desc: "'open' or 'closed'" }
    ] },
  { name: "price.gap.detected", version: 1, category: "market", severity: "warning", retained: false,
    desc: "Tick arrived outside the configured price-deviation filter.",
    fields: [
      { name: "symbol", type: "string", required: true, desc: "Instrument symbol" },
      { name: "bid", type: "number", required: true, desc: "Outlier bid" },
      { name: "ask", type: "number", required: true, desc: "Outlier ask" },
      { name: "deviation_points", type: "number", required: false, desc: "Deviation in points" }
    ] },

  /* ---- configuration changes ---- */
  { name: "config.group.updated", version: 1, category: "config", severity: "info", retained: false,
    desc: "An account group's trade conditions were edited.",
    fields: [
      { name: "group_name", type: "string", required: true, desc: "Group name/path" },
      { name: "changed_by", type: "string", required: false, desc: "Manager login or 'system'" }
    ] },
  { name: "config.symbol.updated", version: 1, category: "config", severity: "info", retained: false,
    desc: "A symbol specification was edited.",
    fields: [
      { name: "symbol", type: "string", required: true, desc: "Instrument symbol" },
      { name: "changed_by", type: "string", required: false, desc: "Manager login or 'system'" }
    ] },
  { name: "config.session.updated", version: 1, category: "config", severity: "info", retained: false,
    desc: "Quoting/trading session calendar was edited.",
    fields: [
      { name: "symbol", type: "string", required: true, desc: "Instrument symbol" },
      { name: "changed_by", type: "string", required: false, desc: "Manager login or 'system'" }
    ] },
  { name: "config.gateway.failover", version: 1, category: "config", severity: "warning", retained: true,
    desc: "Price source switched to the next configured gateway/feed.",
    fields: [
      { name: "from_source", type: "string", required: true, desc: "Previous source" },
      { name: "to_source", type: "string", required: true, desc: "New active source" },
      { name: "reason", type: "string", required: false, desc: "Why the switch happened" }
    ] },

  /* ---- account changes ---- */
  { name: "account.created", version: 1, category: "account", severity: "info", retained: false,
    desc: "A trading account was opened.",
    fields: [
      { name: "account_id", type: "string", required: true, desc: "Account login" },
      { name: "group_name", type: "string", required: true, desc: "Group the account joined" },
      { name: "account_type", type: "string", required: false, desc: "demo/preliminary/live/manager" }
    ] },
  { name: "account.status.changed", version: 1, category: "account", severity: "info", retained: true,
    desc: "Account moved between lifecycle states (active/disabled/archived/...).",
    fields: [
      { name: "account_id", type: "string", required: true, desc: "Account login" },
      { name: "old_status", type: "string", required: false, desc: "Previous status" },
      { name: "new_status", type: "string", required: true, desc: "New status" },
      { name: "changed_by", type: "string", required: false, desc: "Manager login or 'system'" }
    ] },
  { name: "account.balance.op", version: 1, category: "account", severity: "info", retained: false,
    desc: "A balance-affecting operation was posted to an account.",
    fields: [
      { name: "account_id", type: "string", required: true, desc: "Account login" },
      { name: "op_type", type: "string", required: true, desc: "deposit/withdrawal/credit/bonus/correction/charge/interest" },
      { name: "amount", type: "number", required: true, desc: "Signed amount in account currency" },
      { name: "comment", type: "string", required: false, desc: "Operation comment" }
    ] },

  /* ---- client updates (CRM) ---- */
  { name: "client.registered", version: 1, category: "client", severity: "info", retained: false,
    desc: "A new client record was created in the CRM.",
    fields: [
      { name: "client_id", type: "string", required: true, desc: "Client record id" },
      { name: "lead_source", type: "string", required: false, desc: "Acquisition channel" }
    ] },
  { name: "client.kyc.completed", version: 1, category: "client", severity: "info", retained: false,
    desc: "Client KYC verification finished (pass or fail).",
    fields: [
      { name: "client_id", type: "string", required: true, desc: "Client record id" },
      { name: "result", type: "string", required: true, desc: "'passed' or 'failed'" }
    ] },
  { name: "client.status.changed", version: 1, category: "client", severity: "info", retained: false,
    desc: "Client lifecycle status changed.",
    fields: [
      { name: "client_id", type: "string", required: true, desc: "Client record id" },
      { name: "new_status", type: "string", required: true, desc: "New status" }
    ] },

  /* ---- security ---- */
  { name: "auth.failed", version: 1, category: "security", severity: "warning", retained: false,
    desc: "A login attempt failed.",
    fields: [
      { name: "login", type: "string", required: true, desc: "Login that was attempted" },
      { name: "ip", type: "string", required: false, desc: "Source address" },
      { name: "reason", type: "string", required: false, desc: "Why it failed" }
    ] },
  { name: "ip.banned", version: 1, category: "security", severity: "critical", retained: false,
    desc: "An address was blocked after repeated abuse.",
    fields: [
      { name: "ip", type: "string", required: true, desc: "Blocked address" },
      { name: "reason", type: "string", required: false, desc: "Why it was blocked" }
    ] },
  { name: "permission.changed", version: 1, category: "security", severity: "warning", retained: false,
    desc: "A manager's rights were granted or revoked.",
    fields: [
      { name: "manager_login", type: "string", required: true, desc: "Manager account login" },
      { name: "action", type: "string", required: true, desc: "'granted' or 'revoked'" },
      { name: "scope", type: "string", required: false, desc: "Right or group scope affected" }
    ] },

  /* ---- system ---- */
  { name: "eod.started", version: 1, category: "system", severity: "info", retained: true,
    desc: "End-of-day processing began.",
    fields: [
      { name: "eod_time", type: "integer", required: true, desc: "EOD schedule time (unix seconds)" }
    ] },
  { name: "eod.completed", version: 1, category: "system", severity: "info", retained: true,
    desc: "End-of-day processing finished.",
    fields: [
      { name: "duration_ms", type: "integer", required: false, desc: "Processing duration" }
    ] },
  { name: "server.failover", version: 1, category: "system", severity: "critical", retained: true,
    desc: "A server component switched to its backup.",
    fields: [
      { name: "component", type: "string", required: true, desc: "Component name" },
      { name: "to_node", type: "string", required: false, desc: "Backup node that took over" }
    ] }
];

var CATALOG = {};
EVENT_DEFINITIONS.forEach(function (d) { CATALOG[d.name] = d; });

/* ============================== 2. VALIDATION ============================== */

function typeMatches(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && isFinite(value);
  if (type === "integer") return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
  return false;
}

/* validatePayload(name, payload) -> array of error strings (empty = valid).
 * Throws when the event name is not in the catalog. */
function validatePayload(name, payload) {
  var def = CATALOG[name];
  if (!def) throw new Error("event-bus: unknown event '" + name + "'");
  var errors = [];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return ["payload must be an object"];
  }
  def.fields.forEach(function (f) {
    var has = Object.prototype.hasOwnProperty.call(payload, f.name);
    if (!has) {
      if (f.required) errors.push("missing required field '" + f.name + "'");
      return;
    }
    if (!typeMatches(payload[f.name], f.type)) {
      errors.push("field '" + f.name + "' must be " + f.type);
    }
  });
  return errors;
}

/* Envelope built by bus.emit: { event, version, category, severity, ts, payload }.
 * ts is unix milliseconds. */
function makeEnvelope(def, payload) {
  var env = {
    event: def.name,
    version: def.version,
    category: def.category,
    severity: def.severity,
    ts: Date.now(),
    payload: payload
  };
  return env;
}

/* ============================== 3. BUS ============================== */

/* matchPattern(pattern, eventName): dot-separated segments; a segment "*" matches
 * any single segment; a bare "*" pattern matches everything. */
function matchPattern(pattern, eventName) {
  if (pattern === "*") return true;
  var p = pattern.split(".");
  var e = eventName.split(".");
  if (p.length !== e.length) return false;
  for (var i = 0; i < p.length; i++) {
    if (p[i] !== "*" && p[i] !== e[i]) return false;
  }
  return true;
}

function createBus() {
  var subs = [];      /* { pattern, handler, once } */
  var retained = {};  /* eventName -> last envelope (only for retained events) */

  function dispatch(env) {
    /* copy subscriber list so handlers may subscribe/unsubscribe safely */
    var list = subs.slice();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (matchPattern(s.pattern, env.event)) {
        s.handler(env);
        if (s.once) {
          var idx = subs.indexOf(s);
          if (idx !== -1) subs.splice(idx, 1);
        }
      }
    }
  }

  var bus = {
    /* on(pattern, handler) -> unsubscribe function */
    on: function (pattern, handler) {
      if (typeof pattern !== "string" || !pattern) throw new Error("event-bus: pattern must be a non-empty string");
      if (typeof handler !== "function") throw new Error("event-bus: handler must be a function");
      var s = { pattern: pattern, handler: handler, once: false };
      subs.push(s);
      return function () { bus.off(s); };
    },
    /* once(pattern, handler) -> unsubscribe function */
    once: function (pattern, handler) {
      if (typeof pattern !== "string" || !pattern) throw new Error("event-bus: pattern must be a non-empty string");
      if (typeof handler !== "function") throw new Error("event-bus: handler must be a function");
      var s = { pattern: pattern, handler: handler, once: true };
      subs.push(s);
      return function () { bus.off(s); };
    },
    /* off(patternOrSubscription, handler?) — remove a subscription */
    off: function (patternOrSub, handler) {
      for (var i = subs.length - 1; i >= 0; i--) {
        var s = subs[i];
        if (s === patternOrSub) { subs.splice(i, 1); }
        else if (typeof patternOrSub === "string" && s.pattern === patternOrSub &&
                 (!handler || s.handler === handler)) { subs.splice(i, 1); }
      }
      return bus;
    },
    /* emit(name, payload) -> envelope. Strict: unknown event or schema
     * violation throws; nothing is dispatched. */
    emit: function (name, payload) {
      var errors = validatePayload(name, payload); /* throws on unknown name */
      if (errors.length) throw new Error("event-bus: invalid payload for '" + name + "': " + errors.join("; "));
      var env = makeEnvelope(CATALOG[name], payload);
      if (CATALOG[name].retained) retained[name] = env;
      dispatch(env);
      return env;
    },
    /* last(name) -> last retained envelope, or null */
    last: function (name) {
      return Object.prototype.hasOwnProperty.call(retained, name) ? retained[name] : null;
    },
    /* subscriberCount(pattern?) -> number of active subscriptions */
    subscriberCount: function (pattern) {
      if (pattern === undefined) return subs.length;
      var n = 0;
      for (var i = 0; i < subs.length; i++) if (subs[i].pattern === pattern) n++;
      return n;
    }
  };
  return bus;
}

/* ============================== 4. STREAM SINK ============================== */

/* Neutral stream sink: buffers event envelopes and forwards them in batches
 * through a pluggable transport. The default transport is INERT — it records
 * batches but performs no network I/O, so nothing leaves the process unless
 * the host wires in its own transport. No vendor product names here: a sink is
 * just { name, endpoint, auth, headers, batchSize, maxQueue, maxRetries }.
 *
 * auth: { type: "none"|"bearer"|"basic"|"api_key", token/key/value, header }
 * transport: function (batch, config) — must return true on success, or throw
 *            / return false on failure. */
function inertTransport() { return true; }

function createSink(config) {
  config = config || {};
  var cfg = {
    name: config.name || "default-sink",
    endpoint: config.endpoint || null,
    auth: config.auth || { type: "none" },
    headers: config.headers || {},
    batchSize: config.batchSize > 0 ? Math.floor(config.batchSize) : 50,
    maxQueue: config.maxQueue > 0 ? Math.floor(config.maxQueue) : 1000,
    maxRetries: config.maxRetries >= 0 ? Math.floor(config.maxRetries) : 3,
    transport: typeof config.transport === "function" ? config.transport : inertTransport
  };
  var queue = [];
  var stats = { enqueued: 0, dropped: 0, sent: 0, failed: 0, flushes: 0 };

  function enqueue(env) {
    if (queue.length >= cfg.maxQueue) {
      stats.dropped++;
      return false;
    }
    queue.push(env);
    stats.enqueued++;
    return true;
  }

  function flush() {
    stats.flushes++;
    var sent = 0, failed = 0;
    while (queue.length > 0) {
      var batch = queue.slice(0, cfg.batchSize);
      var ok = false, attempts = 0;
      while (!ok && attempts <= cfg.maxRetries) {
        attempts++;
        try { ok = cfg.transport(batch, cfg) === true; }
        catch (e) { ok = false; }
      }
      if (ok) {
        queue.splice(0, batch.length);
        sent += batch.length;
      } else {
        failed += batch.length;
        queue.splice(0, batch.length); /* poison batch discarded, counted */
      }
    }
    stats.sent += sent;
    stats.failed += failed;
    return { sent: sent, failed: failed };
  }

  var sink = {
    config: cfg,
    enqueue: enqueue,
    flush: flush,
    queueLength: function () { return queue.length; },
    stats: function () {
      return { enqueued: stats.enqueued, dropped: stats.dropped,
               sent: stats.sent, failed: stats.failed, flushes: stats.flushes };
    },
    /* attachToBus(bus, pattern) -> unsubscribe function; forwards envelopes */
    attachToBus: function (bus, pattern) {
      if (!bus || typeof bus.on !== "function") throw new Error("event-bus: attachToBus needs a bus");
      return bus.on(pattern || "*", function (env) { enqueue(env); });
    }
  };
  return sink;
}

/* ============================== EXPORTS ============================== */

var EVENTBUS = {
  SEVERITIES: SEVERITIES,
  CATEGORIES: CATEGORIES,
  EVENT_DEFINITIONS: EVENT_DEFINITIONS,
  CATALOG: CATALOG,
  createBus: createBus,
  createSink: createSink,
  validatePayload: validatePayload,
  matchPattern: matchPattern
};
if (typeof module !== "undefined" && module.exports) { module.exports = EVENTBUS; }
else { root.OrbitEventBus = EVENTBUS; }
})(typeof globalThis !== "undefined" ? globalThis : this);
