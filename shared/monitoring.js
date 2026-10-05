/* shared/monitoring.js — OrbitTrader server monitoring model (Admin dashboard data layer).
 *
 * Independent implementation of the Admin dashboard monitoring contract:
 *   1. Status snapshot — a point-in-time health record per server component:
 *      component name/version, start time, uptime, CPU / memory / disk load,
 *      database sizes (groups, accounts, positions, orders, deals), live
 *      connections, network throughput and ping.
 *   2. Per-minute metrics catalog (METRICS) — the fixed field set the Admin
 *      dashboard graphs: cpu, memory, disk, connections, network, threads,
 *      trade statistics and history-tick statistics.
 *   3. Journal — append-only component log entries {ts, component,
 *      event_type, message}; keyword search with logical operators:
 *        `|`  or,   `&`  and,   `^`  not   (^ binds tightest, then &, then |).
 *      e.g.  "failover | ^network & history" finds failover entries plus
 *      non-network history entries. Quoted phrases match exactly:
 *      '"database locked"'.
 *   4. Export formatters for journal entries: CSV and an HTML table.
 *
 * Pure functions only — no globals, no DOM, no network. Usable from Node
 * (CommonJS) and, via the global, from the browser bundle.
 */
(function (root) {
"use strict";

/* ---------------- helpers ---------------- */
function isNum(v) { return typeof v === "number" && isFinite(v); }
function num(v, fb) { v = +v; return isFinite(v) ? v : fb; }
function isInt(v) { return isNum(v) && Math.floor(v) === v; }
function validDate(v) {
  if (typeof v === "number") return isFinite(v);
  if (typeof v === "string" && v) return !isNaN(Date.parse(v));
  return false;
}

/* ---------------- 1. status snapshot ---------------- */

/* Field names of a snapshot, in documentation order. */
var SNAPSHOT_FIELDS = [
  "component", "version", "started_at", "uptime_sec",
  "cpu_pct", "mem_used_mb", "mem_total_mb", "disk_used_mb", "disk_total_mb",
  "db_sizes", "connections", "network_in_bps", "network_out_bps", "ping_ms"
];
var DB_SIZE_KEYS = ["groups", "accounts", "positions", "orders", "deals"];

/* Build a normalized snapshot from a partial record (missing numeric fields
 * default to 0). Does not validate — run validateSnapshot() for that. */
function makeSnapshot(p) {
  p = p || {};
  var db = (p.db_sizes && typeof p.db_sizes === "object") ? p.db_sizes : {};
  var out = {
    component: p.component != null ? String(p.component) : "",
    version: p.version != null ? String(p.version) : "",
    started_at: p.started_at != null ? p.started_at : new Date().toISOString(),
    uptime_sec: num(p.uptime_sec, 0),
    cpu_pct: num(p.cpu_pct, 0),
    mem_used_mb: num(p.mem_used_mb, 0),
    mem_total_mb: num(p.mem_total_mb, 0),
    disk_used_mb: num(p.disk_used_mb, 0),
    disk_total_mb: num(p.disk_total_mb, 0),
    db_sizes: {},
    connections: Math.floor(num(p.connections, 0)),
    network_in_bps: num(p.network_in_bps, 0),
    network_out_bps: num(p.network_out_bps, 0),
    ping_ms: num(p.ping_ms, 0)
  };
  DB_SIZE_KEYS.forEach(function (k) {
    out.db_sizes[k] = Math.floor(num(db[k], 0));
  });
  return out;
}

/* Validate a status snapshot. Returns {valid, errors:[strings]}.
 * errors is empty when valid. */
function validateSnapshot(s) {
  var errors = [];
  function bad(name, why) { errors.push(name + ": " + why); }
  if (!s || typeof s !== "object") return { valid: false, errors: ["snapshot: not an object"] };

  if (!s.component || typeof s.component !== "string" || !s.component.trim())
    bad("component", "required non-empty string");
  if (!s.version || typeof s.version !== "string" || !s.version.trim())
    bad("version", "required non-empty string");
  if (!validDate(s.started_at))
    bad("started_at", "must be a parseable date or epoch ms");
  if (!isNum(s.uptime_sec) || s.uptime_sec < 0)
    bad("uptime_sec", "must be a number >= 0");
  if (!isNum(s.cpu_pct) || s.cpu_pct < 0 || s.cpu_pct > 100)
    bad("cpu_pct", "must be a number between 0 and 100");
  ["mem_used_mb", "mem_total_mb", "disk_used_mb", "disk_total_mb"].forEach(function (k) {
    if (!isNum(s[k]) || s[k] < 0) bad(k, "must be a number >= 0");
  });
  if (isNum(s.mem_used_mb) && isNum(s.mem_total_mb) && s.mem_used_mb > s.mem_total_mb)
    bad("mem_used_mb", "cannot exceed mem_total_mb");
  if (isNum(s.disk_used_mb) && isNum(s.disk_total_mb) && s.disk_used_mb > s.disk_total_mb)
    bad("disk_used_mb", "cannot exceed disk_total_mb");
  if (!s.db_sizes || typeof s.db_sizes !== "object")
    bad("db_sizes", "required object");
  else DB_SIZE_KEYS.forEach(function (k) {
    if (!isInt(s.db_sizes[k]) || s.db_sizes[k] < 0)
      bad("db_sizes." + k, "must be an integer >= 0");
  });
  if (!isInt(s.connections) || s.connections < 0)
    bad("connections", "must be an integer >= 0");
  ["network_in_bps", "network_out_bps", "ping_ms"].forEach(function (k) {
    if (!isNum(s[k]) || s[k] < 0) bad(k, "must be a number >= 0");
  });
  return { valid: errors.length === 0, errors: errors };
}

/* ---------------- 2. per-minute metrics catalog ---------------- */

/* OrbitTrader's own metric field set — the Admin dashboard graphs each of
 * these once per minute. key = field name in a metrics record,
 * label = dashboard display name, unit = display unit. */
var METRICS = [
  { key: "uptime_sec",        label: "Uptime",                unit: "s" },
  { key: "cpu_pct",           label: "CPU load",              unit: "%" },
  { key: "mem_used_mb",       label: "Memory used",           unit: "MB" },
  { key: "mem_total_mb",      label: "Memory total",          unit: "MB" },
  { key: "mem_used_pct",      label: "Memory load",           unit: "%" },
  { key: "disk_used_pct",     label: "Disk load",             unit: "%" },
  { key: "disk_free_mb",      label: "Disk free",             unit: "MB" },
  { key: "conns_active",      label: "Active connections",    unit: "conn" },
  { key: "conns_peak",        label: "Peak connections",      unit: "conn" },
  { key: "threads",           label: "Worker threads",        unit: "n" },
  { key: "net_in_bps",        label: "Network in",            unit: "bit/s" },
  { key: "net_out_bps",       label: "Network out",           unit: "bit/s" },
  { key: "ping_ms",           label: "Peer ping",             unit: "ms" },
  { key: "db_groups",         label: "Groups in database",    unit: "n" },
  { key: "db_accounts",       label: "Accounts in database",  unit: "n" },
  { key: "db_positions",      label: "Open positions",        unit: "n" },
  { key: "db_orders",         label: "Pending orders",        unit: "n" },
  { key: "db_deals",          label: "Deals today",           unit: "n" },
  { key: "trades_last_min",   label: "Trades per minute",     unit: "n/min" },
  { key: "orders_last_min",   label: "Order events per minute", unit: "n/min" },
  { key: "ticks_in_raw",      label: "Raw ticks per minute",  unit: "n/min" },
  { key: "ticks_in_accepted", label: "Accepted ticks per minute", unit: "n/min" },
  { key: "hist_bars_written", label: "Minute bars written per minute", unit: "n/min" },
  { key: "journal_errors",    label: "Journal errors per minute", unit: "n/min" }
];
function metricByKey(key) {
  for (var i = 0; i < METRICS.length; i++)
    if (METRICS[i].key === key) return METRICS[i];
  return null;
}

/* ---------------- 3. journal ---------------- */

/* Event types a journal entry can carry. */
var JOURNAL_EVENT_TYPES = [
  "configuration", "system", "network", "history",
  "accounts", "trades", "api", "live_update", "report_mailer", "failover"
];

/* Validate a journal entry {ts, component, event_type, message}.
 * Returns {valid, errors:[strings]}. */
function validateJournalEntry(e) {
  var errors = [];
  if (!e || typeof e !== "object") return { valid: false, errors: ["entry: not an object"] };
  if (!validDate(e.ts)) errors.push("ts: must be a parseable date or epoch ms");
  if (!e.component || typeof e.component !== "string" || !e.component.trim())
    errors.push("component: required non-empty string");
  if (JOURNAL_EVENT_TYPES.indexOf(e.event_type) === -1)
    errors.push("event_type: must be one of " + JOURNAL_EVENT_TYPES.join(", "));
  if (typeof e.message !== "string" || !e.message.trim())
    errors.push("message: required non-empty string");
  return { valid: errors.length === 0, errors: errors };
}

/* --- keyword query language: `|` or, `&` and, `^` not.
 * Precedence: ^ (unary) binds tightest, then &, then |. Parentheses allowed.
 * Quoted phrases match literally, e.g. '"db compact"'. --- */

function tokenize(q) {
  var toks = [], i = 0, n = q.length;
  function isSpace(c) { return c === " " || c === "\t" || c === "\r" || c === "\n"; }
  while (i < n) {
    var c = q.charAt(i);
    if (isSpace(c)) { i++; continue; }
    if (c === "|" || c === "&" || c === "^" || c === "(" || c === ")") {
      toks.push({ t: "op", v: c }); i++; continue;
    }
    if (c === '"') {
      var buf = "", j = i + 1;
      while (j < n && q.charAt(j) !== '"') {
        if (q.charAt(j) === "\\" && j + 1 < n) { buf += q.charAt(j + 1); j += 2; }
        else { buf += q.charAt(j); j++; }
      }
      if (j >= n) throw new Error("monitoring.parseQuery: unterminated quoted phrase");
      toks.push({ t: "term", v: buf }); i = j + 1; continue;
    }
    var k = i;
    while (k < n && !isSpace(q.charAt(k)) && "|&^()\"".indexOf(q.charAt(k)) === -1) k++;
    toks.push({ t: "term", v: q.slice(i, k) }); i = k;
  }
  return toks;
}

/* Parse a query string into an AST:
 *   {type:"term",value} | {type:"not",expr} |
 *   {type:"and",left,right} | {type:"or",left,right}.
 * Empty/blank query → null (matches everything). Throws on syntax errors. */
function parseQuery(q) {
  var toks = tokenize(String(q == null ? "" : q));
  if (!toks.length) return null;
  var pos = 0;
  function peek() { return toks[pos]; }
  function next() { return toks[pos++]; }
  function parseOr() {
    var left = parseAnd();
    while (peek() && peek().t === "op" && peek().v === "|") {
      next(); left = { type: "or", left: left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd() {
    var left = parseNot();
    while (peek() && peek().t === "op" && peek().v === "&") {
      next(); left = { type: "and", left: left, right: parseNot() };
    }
    return left;
  }
  function parseNot() {
    if (peek() && peek().t === "op" && peek().v === "^") {
      next(); return { type: "not", expr: parseNot() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    var tk = peek();
    if (!tk) throw new Error("monitoring.parseQuery: unexpected end of query");
    if (tk.t === "op" && tk.v === "(") {
      next();
      var e = parseOr();
      var close = next();
      if (!close || close.t !== "op" || close.v !== ")")
        throw new Error("monitoring.parseQuery: missing closing parenthesis");
      return e;
    }
    if (tk.t === "term") { next(); return { type: "term", value: tk.v }; }
    throw new Error("monitoring.parseQuery: unexpected token '" + tk.v + "'");
  }
  var ast = parseOr();
  if (pos !== toks.length)
    throw new Error("monitoring.parseQuery: unexpected trailing input");
  return ast;
}

function entryHaystack(e) {
  return [e.component || "", e.event_type || "", e.message || ""]
    .join(" ").toLowerCase();
}

/* Test one entry against a parsed AST (null AST matches everything).
 * Keyword matching is case-insensitive substring search. */
function matchQuery(ast, entry) {
  if (!ast) return true;
  if (!entry) return false;
  switch (ast.type) {
    case "term":
      return entryHaystack(entry).indexOf(String(ast.value).toLowerCase()) !== -1;
    case "not": return !matchQuery(ast.expr, entry);
    case "and": return matchQuery(ast.left, entry) && matchQuery(ast.right, entry);
    case "or":  return matchQuery(ast.left, entry) || matchQuery(ast.right, entry);
    default: return false;
  }
}

/* Filter journal entries by a query string. Empty query returns all entries. */
function searchJournal(entries, query) {
  var ast = parseQuery(query);
  return (entries || []).filter(function (e) { return matchQuery(ast, e); });
}

/* ---------------- 4. export formatters ---------------- */

function csvField(v) {
  var s = String(v == null ? "" : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* Journal entries → CSV (RFC 4180 quoting, CRLF line endings). */
function journalToCSV(entries) {
  var lines = ["ts,component,event_type,message"];
  (entries || []).forEach(function (e) {
    lines.push([csvField(e.ts), csvField(e.component),
                csvField(e.event_type), csvField(e.message)].join(","));
  });
  return lines.join("\r\n");
}

function htmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* Journal entries → HTML table fragment (safe: all fields escaped). */
function journalToHTML(entries) {
  var rows = (entries || []).map(function (e) {
    return "<tr><td>" + htmlEscape(e.ts) + "</td><td>" +
      htmlEscape(e.component) + "</td><td>" + htmlEscape(e.event_type) +
      "</td><td>" + htmlEscape(e.message) + "</td></tr>";
  });
  return "<table class=\"orbit-journal\">" +
    "<thead><tr><th>Time</th><th>Component</th><th>Event</th><th>Message</th></tr></thead>" +
    "<tbody>" + rows.join("") + "</tbody></table>";
}

/* Human-readable uptime, e.g. 90061 → "1d 01:01:01". */
function formatUptime(sec) {
  var s = Math.max(0, Math.floor(num(sec, 0)));
  var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
      m = Math.floor(s % 3600 / 60), r = s % 60;
  function pad(x) { return (x < 10 ? "0" : "") + x; }
  return d + "d " + pad(h) + ":" + pad(m) + ":" + pad(r);
}

var Monitoring = {
  SNAPSHOT_FIELDS: SNAPSHOT_FIELDS,
  DB_SIZE_KEYS: DB_SIZE_KEYS,
  makeSnapshot: makeSnapshot,
  validateSnapshot: validateSnapshot,
  METRICS: METRICS,
  metricByKey: metricByKey,
  JOURNAL_EVENT_TYPES: JOURNAL_EVENT_TYPES,
  validateJournalEntry: validateJournalEntry,
  parseQuery: parseQuery,
  matchQuery: matchQuery,
  searchJournal: searchJournal,
  journalToCSV: journalToCSV,
  journalToHTML: journalToHTML,
  formatUptime: formatUptime
};
if (typeof module !== "undefined" && module.exports) { module.exports = Monitoring; }
else { root.Monitoring = Monitoring; }
})(typeof globalThis !== "undefined" ? globalThis : this);
