/* shared/terminal-services.js — OrbitTrader terminal services (pure logic).
 *
 * Two independent client-terminal concerns, implemented as side-effect-free
 * functions (no globals, no DOM, no network, no Date.now() inside the
 * evaluation paths). Usable from Node (CommonJS) and, via the global,
 * from the browser bundle.
 *
 * 1. PRICE ALERTS
 *    Alert definitions with conditions on Bid / Ask / Last / tick Volume
 *    (symbol-level), plus Time / Positions count / Floating profit /
 *    Uncovered volume (account-level, optionally per symbol). An alert is a
 *    plain record:
 *      { id, symbol, condition, threshold, direction, state,
 *        oneShot, createdAt, lastTriggeredAt }
 *      symbol: string or null (null = account-level alert).
 *      condition: "bid" | "ask" | "last" | "volume" | "time" |
 *                 "positions" | "profit" | "uncovered".
 *      threshold: numeric reference value (for "time", an ms timestamp).
 *      direction: "above" | "below".
 *      state: "active" | "triggered" | "disabled".
 *      oneShot: true = fire once, then the caller disables it;
 *               false = recurring (fires on every evaluation while met).
 *    evaluate(alert, marketSnapshot, accountSnapshot) -> bool:
 *      pure — reports whether the condition currently holds. It never
 *      mutates the alert and never notifies; the caller handles
 *      notification and state transitions. applyTrigger(alert, triggered)
 *      computes the next alert record immutably (sets lastTriggeredAt,
 *      marks one-shot alerts "triggered" / disables them).
 *    Threshold crossing is inclusive ("above" means value >= threshold,
 *    "below" means value <= threshold), matching tick-polling where the
 *    sampled tick can land exactly on the threshold. Missing data needed
 *    for a condition yields false rather than a guess.
 *
 * 2. ECONOMIC CALENDAR DATA MODEL
 *    Indicator records (name, country, currency, priority high/medium/low,
 *    period label, forecast / previous / actual placeholders, eventTime).
 *    The model stores the fields; CALLERS supply values. Forecast/previous/
 *    actual default to null — this module ships no invented real data.
 *    Filters by priority / currency / country, and an upcoming-events query
 *    over [from, until) timestamps, sorted ascending by event time.
 */
(function (root) {
"use strict";

/* ---------------- helpers ---------------- */
function isNum(v) { return typeof v === "number" && isFinite(v); }
function isNonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function toNum(v) { v = +v; return isFinite(v) ? v : null; }
function cmpByTimeAsc(a, b) { return a.eventTime - b.eventTime; }

/* ---------------- 1. alerts ---------------- */

/* Condition names recognised by the evaluator. */
var ALERT_CONDITIONS = ["bid", "ask", "last", "volume",
                        "time", "positions", "profit", "uncovered"];
var ALERT_DIRECTIONS = ["above", "below"];
var ALERT_STATES = ["active", "triggered", "disabled"];

/* Conditions that read per-symbol market data (need alert.symbol). */
var SYMBOL_CONDITIONS = ["bid", "ask", "last", "volume"];

/* Build a normalized alert record from a partial definition. Throws on
 * invalid fields so bad definitions fail fast at creation time. */
function makeAlert(p) {
  p = p || {};
  var r = validateAlert(p);
  if (!r.valid) throw new Error("makeAlert: invalid alert — " + r.errors.join("; "));
  var out = {
    id: String(p.id).trim(),
    symbol: p.symbol == null ? null : String(p.symbol).trim().toUpperCase(),
    condition: p.condition,
    threshold: +p.threshold,
    direction: p.direction || "above",
    state: p.state || "active",
    oneShot: p.oneShot === undefined ? true : !!p.oneShot,
    createdAt: p.createdAt != null ? p.createdAt : new Date().toISOString(),
    lastTriggeredAt: p.lastTriggeredAt == null ? null : p.lastTriggeredAt
  };
  return out;
}

/* Validate an alert definition. Returns {valid, errors:[strings]}. */
function validateAlert(a) {
  var errors = [];
  function bad(name, why) { errors.push(name + ": " + why); }
  if (!a || typeof a !== "object") return { valid: false, errors: ["alert: not an object"] };

  if (!isNonEmptyString(a.id)) bad("id", "required non-empty string");
  if (a.symbol != null && !isNonEmptyString(a.symbol))
    bad("symbol", "must be a non-empty string or null");
  if (ALERT_CONDITIONS.indexOf(a.condition) === -1)
    bad("condition", "must be one of " + ALERT_CONDITIONS.join("/"));
  if (SYMBOL_CONDITIONS.indexOf(a.condition) !== -1 && a.symbol == null)
    bad("symbol", "required for condition '" + a.condition + "'");
  if (!isNum(a.threshold)) bad("threshold", "required finite number");
  if (a.direction !== undefined && ALERT_DIRECTIONS.indexOf(a.direction) === -1)
    bad("direction", "must be 'above' or 'below'");
  if (a.state !== undefined && ALERT_STATES.indexOf(a.state) === -1)
    bad("state", "must be one of " + ALERT_STATES.join("/"));
  if (a.oneShot !== undefined && typeof a.oneShot !== "boolean")
    bad("oneShot", "must be boolean");
  return { valid: errors.length === 0, errors: errors };
}

/* Resolve the numeric value an alert condition compares against.
 * marketSnapshot:  { now?, quotes: { SYMBOL: {bid, ask, last, volume?} } }
 * accountSnapshot: { positionsCount?, floatingProfit?, uncoveredVolume?,
 *                    positionsBySymbol?, profitBySymbol?, uncoveredBySymbol? }
 * Returns the value, or null when the data needed is missing. */
function alertValue(alert, marketSnapshot, accountSnapshot) {
  var market = marketSnapshot || {};
  var account = accountSnapshot || {};
  var cond = alert.condition;
  var sym = alert.symbol;

  if (SYMBOL_CONDITIONS.indexOf(cond) !== -1) {
    var quotes = market.quotes || {};
    var q = sym != null ? quotes[sym] : null;
    if (!q || typeof q !== "object") return null;
    if (cond === "volume") return toNum(q.volume);
    return toNum(q[cond]);
  }

  if (cond === "time") {
    /* "time": fires once the clock reaches the threshold. The caller
     * supplies now (ms since epoch) — the evaluator never reads the clock. */
    var now = market.now != null ? market.now : account.now;
    return toNum(now);
  }

  if (cond === "positions") {
    if (sym != null) {
      var bySym = account.positionsBySymbol || {};
      return toNum(bySym[sym] != null ? bySym[sym] : 0);
    }
    return toNum(account.positionsCount != null ? account.positionsCount : 0);
  }

  if (cond === "profit") {
    if (sym != null) {
      var pBySym = account.profitBySymbol || {};
      return pBySym[sym] != null ? toNum(pBySym[sym]) : 0;
    }
    return account.floatingProfit != null ? toNum(account.floatingProfit) : 0;
  }

  if (cond === "uncovered") {
    if (sym != null) {
      var uBySym = account.uncoveredBySymbol || {};
      return uBySym[sym] != null ? toNum(uBySym[sym]) : 0;
    }
    return account.uncoveredVolume != null ? toNum(account.uncoveredVolume) : 0;
  }

  return null;
}

/* Compare a value against a threshold in the given direction.
 * Inclusive on purpose: tick-polling can sample exactly on the threshold. */
function crosses(value, threshold, direction) {
  if (!isNum(value) || !isNum(threshold)) return false;
  return direction === "below" ? value <= threshold : value >= threshold;
}

/* Evaluate an alert against the current snapshots. Pure: reads only,
 * returns true when the alert's condition currently holds.
 * Disabled alerts never evaluate true; alerts already "triggered" still
 * evaluate purely on their condition (state bookkeeping is the caller's job). */
function evaluate(alert, marketSnapshot, accountSnapshot) {
  if (!alert || typeof alert !== "object") return false;
  if (alert.state === "disabled") return false;
  if (ALERT_CONDITIONS.indexOf(alert.condition) === -1) return false;
  var value = alertValue(alert, marketSnapshot, accountSnapshot);
  return crosses(value, +alert.threshold, alert.direction === "below" ? "below" : "above");
}

/* Immutable state transition after an evaluation round. Pure — returns a
 * NEW alert record; the input is untouched.
 *   triggered && alert.oneShot   → state "triggered" (caller disables /
 *                                  archives it from there)
 *   triggered && !alert.oneShot  → stays "active", lastTriggeredAt updated
 *   !triggered                   → copy unchanged */
function applyTrigger(alert, triggered) {
  var next = {};
  for (var k in alert) if (Object.prototype.hasOwnProperty.call(alert, k)) next[k] = alert[k];
  if (!triggered) return next;
  next.lastTriggeredAt = new Date().toISOString();
  if (next.oneShot) next.state = "triggered";
  return next;
}

/* Evaluate a whole watchlist. Pure — returns [{alert, triggered}]
 * without touching any alert. The caller decides what to do with hits. */
function evaluateAll(alerts, marketSnapshot, accountSnapshot) {
  if (!Array.isArray(alerts)) return [];
  return alerts.map(function (alert) {
    return { alert: alert, triggered: evaluate(alert, marketSnapshot, accountSnapshot) };
  });
}

/* Convenience: run evaluateAll then applyTrigger over each alert.
 * Pure — returns new alert records, leaves the input list untouched. */
function updateAll(alerts, marketSnapshot, accountSnapshot) {
  if (!Array.isArray(alerts)) return [];
  return alerts.map(function (alert) {
    return applyTrigger(alert, evaluate(alert, marketSnapshot, accountSnapshot));
  });
}

/* ---------------- 2. economic calendar ---------------- */

/* Indicator priority bands. */
var EVENT_PRIORITIES = ["high", "medium", "low"];

/* Reference economy catalog (country + reporting currency). Static reference
 * data only — actual indicator readings are always supplied by callers. */
var ECONOMIES = [
  { country: "United States",    currency: "USD" },
  { country: "Euro Area",        currency: "EUR" },
  { country: "United Kingdom",    currency: "GBP" },
  { country: "Japan",            currency: "JPY" },
  { country: "Switzerland",       currency: "CHF" },
  { country: "Canada",           currency: "CAD" },
  { country: "Australia",        currency: "AUD" },
  { country: "New Zealand",      currency: "NZD" },
  { country: "China",            currency: "CNY" },
  { country: "Singapore",        currency: "SGD" },
  { country: "Hong Kong",        currency: "HKD" },
  { country: "India",            currency: "INR" },
  { country: "South Korea",      currency: "KRW" },
  { country: "Brazil",           currency: "BRL" },
  { country: "Mexico",           currency: "MXN" },
  { country: "South Africa",     currency: "ZAR" },
  { country: "United Arab Emirates", currency: "AED" },
  { country: "Saudi Arabia",      currency: "SAR" }
];

/* Build a normalized calendar event record. forecast / previous / actual
 * default to null — placeholder slots, NOT real data; callers fill them. */
function makeEvent(p) {
  p = p || {};
  var r = validateEvent(p);
  if (!r.valid) throw new Error("makeEvent: invalid event — " + r.errors.join("; "));
  return {
    id: String(p.id).trim(),
    name: String(p.name).trim(),
    country: String(p.country).trim(),
    currency: String(p.currency).trim().toUpperCase(),
    priority: p.priority,
    period: p.period == null ? "" : String(p.period),
    eventTime: +p.eventTime,
    forecast: p.forecast == null ? null : +p.forecast,
    previous: p.previous == null ? null : +p.previous,
    actual: p.actual == null ? null : +p.actual
  };
}

/* Validate a calendar event. Returns {valid, errors:[strings]}. */
function validateEvent(e) {
  var errors = [];
  function bad(name, why) { errors.push(name + ": " + why); }
  if (!e || typeof e !== "object") return { valid: false, errors: ["event: not an object"] };

  if (!isNonEmptyString(e.id)) bad("id", "required non-empty string");
  if (!isNonEmptyString(e.name)) bad("name", "required non-empty string");
  if (!isNonEmptyString(e.country)) bad("country", "required non-empty string");
  if (!isNonEmptyString(e.currency)) bad("currency", "required non-empty string");
  if (EVENT_PRIORITIES.indexOf(e.priority) === -1)
    bad("priority", "must be one of " + EVENT_PRIORITIES.join("/"));
  if (e.period !== undefined && e.period !== null && typeof e.period !== "string")
    bad("period", "must be a string");
  if (!isNum(e.eventTime)) bad("eventTime", "required finite ms timestamp");
  [["forecast", e.forecast], ["previous", e.previous], ["actual", e.actual]].forEach(function (pair) {
    if (pair[1] !== undefined && pair[1] !== null && !isNum(pair[1]))
      bad(pair[0], "must be a finite number or null");
  });
  return { valid: errors.length === 0, errors: errors };
}

/* Filter events by priority / currency / country. Each filter may be a
 * single value or an array of values; absent filters are ignored.
 * Comparisons are case-insensitive for currency/country. */
function filterEvents(events, filters) {
  if (!Array.isArray(events)) return [];
  filters = filters || {};
  function listOf(v) {
    if (v === undefined || v === null) return null;
    var arr = Array.isArray(v) ? v : [v];
    return arr.map(function (x) { return String(x).toLowerCase(); });
  }
  var pr = listOf(filters.priority);
  var cc = listOf(filters.currency);
  var co = listOf(filters.country);
  return events.filter(function (e) {
    if (!e || typeof e !== "object") return false;
    if (pr && pr.indexOf(String(e.priority || "").toLowerCase()) === -1) return false;
    if (cc && cc.indexOf(String(e.currency || "").toLowerCase()) === -1) return false;
    if (co && co.indexOf(String(e.country || "").toLowerCase()) === -1) return false;
    return true;
  });
}

/* Events with from <= eventTime < until, ascending by eventTime.
 * from/until are ms timestamps; absent `until` means open-ended. */
function upcomingEvents(events, from, until) {
  if (!Array.isArray(events)) return [];
  var lo = isNum(from) ? from : -Infinity;
  var hi = isNum(until) ? until : Infinity;
  return events
    .filter(function (e) {
      return e && typeof e === "object" && isNum(e.eventTime) &&
             e.eventTime >= lo && e.eventTime < hi;
    })
    .slice()
    .sort(cmpByTimeAsc);
}

/* Convenience: upcoming events filtered by the same filter contract,
 * then sorted ascending by event time. */
function upcomingFiltered(events, filters, from, until) {
  return upcomingEvents(filterEvents(events, filters), from, until);
}

/* Look up an economy record by country or currency (case-insensitive);
 * returns null when unknown. */
function findEconomy(key) {
  if (!isNonEmptyString(key)) return null;
  var k = key.trim().toLowerCase();
  for (var i = 0; i < ECONOMIES.length; i++) {
    if (ECONOMIES[i].country.toLowerCase() === k ||
        ECONOMIES[i].currency.toLowerCase() === k) return ECONOMIES[i];
  }
  return null;
}

/* ---------------- exports ---------------- */
var TerminalServices = {
  /* alerts */
  ALERT_CONDITIONS: ALERT_CONDITIONS,
  ALERT_DIRECTIONS: ALERT_DIRECTIONS,
  ALERT_STATES: ALERT_STATES,
  makeAlert: makeAlert,
  validateAlert: validateAlert,
  alertValue: alertValue,
  crosses: crosses,
  evaluate: evaluate,
  applyTrigger: applyTrigger,
  evaluateAll: evaluateAll,
  updateAll: updateAll,
  /* economic calendar */
  EVENT_PRIORITIES: EVENT_PRIORITIES,
  ECONOMIES: ECONOMIES,
  makeEvent: makeEvent,
  validateEvent: validateEvent,
  filterEvents: filterEvents,
  upcomingEvents: upcomingEvents,
  upcomingFiltered: upcomingFiltered,
  findEconomy: findEconomy
};
if (typeof module !== "undefined" && module.exports) { module.exports = TerminalServices; }
else { root.TerminalServices = TerminalServices; }
})(typeof globalThis !== "undefined" ? globalThis : this);
