/* shared/ai-mcp.js — OrbitTrader AI/MCP integration model.
 *
 * Lets an AI assistant (or any MCP client) operate on platform data through a
 * fixed, named tool catalog in OrbitTrader's own namespace ("orbit.*"). Pure
 * functions, no globals, no DOM, no I/O: runs in the browser and in node
 * (guarded export at the bottom, same pattern as shared/web-services.js).
 *
 * Model:
 *   - Tool catalog: every tool is {name, description, category, paramsSchema,
 *     requiredPermission, readOnly}. Param schemas describe each parameter as
 *     {type, required, description, values? (for enum), default?}.
 *   - Capability gating: canCall(toolName, ctx) is pure. Read-only tools need
 *     the tool's permission (or a basic platform.read / admin grant). Mutating
 *     tools (e.g. orbit.orders.place) are DISABLED unless the server config
 *     explicitly enables trading tools AND the caller holds the exact dealing
 *     permission AND the account is not investor (read-only) mode.
 *   - Prompt library: named prompt templates with {{variables}} and an
 *     allowedTools list that constrains which catalog tools a prompt may use.
 *   - Call audit: logToolCall appends {id, tool, actor, at, allowed, reason?}
 *     entries with params passed through sanitizeParams first (sensitive
 *     fields are redacted before anything is stored).
 *   - MCP server config: {enabled, transport, allowedOrigins, rateLimitPerMin,
 *     tradingToolsEnabled, logCalls} with validation + a pure sliding-window
 *     rate-limit decision helper.
 *
 * Nothing here executes trades or touches the network; it is the policy and
 * shape layer. Server-side enforcement re-checks everything (see
 * server/lib/ai-mcp.php).
 */
(function (root) {
"use strict";

/* ---- 0. helpers ---- */

function int(v, lo, hi) {
  return typeof v === "number" && isFinite(v) &&
    Math.floor(v) === v && v >= lo && v <= hi;
}
function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/* ---- 1. tool catalog ----
 * Read-only unless noted. Names are OrbitTrader's own ("orbit.*") namespace. */

var PARAM_TYPES = ["string", "number", "integer", "boolean", "enum", "array", "object"];

var CATEGORIES = [
  "account", "positions", "orders", "history",
  "symbols", "quotes", "calendar", "platform", "trading"
];

var TOOL_CATALOG = [
  {
    name: "orbit.account.get",
    description: "Read the trading account profile: login, name, group, currency, leverage, credit, balance, equity, margin, free margin, margin level, trade mode, server time.",
    category: "account",
    readOnly: true,
    requiredPermission: "account.read",
    paramsSchema: {
      login:   { type: "integer", required: false, description: "Account login to inspect; defaults to the caller's account." },
      include: { type: "array",    required: false, description: "Extra sections to include, e.g. ['margin_breakdown', 'limits']." }
    }
  },
  {
    name: "orbit.account.snapshot",
    description: "Point-in-time balance/equity/margin snapshot: balance, equity, credit, margin, free margin, margin level, floating P/L.",
    category: "account",
    readOnly: true,
    requiredPermission: "account.read",
    paramsSchema: {
      login: { type: "integer", required: false, description: "Account login; defaults to the caller's account." }
    }
  },
  {
    name: "orbit.positions.list",
    description: "List open positions: ticket, symbol, direction, volume, open price/time, current price, SL/TP, swap, commission, profit.",
    category: "positions",
    readOnly: true,
    requiredPermission: "positions.read",
    paramsSchema: {
      login:  { type: "integer", required: false, description: "Account login; defaults to the caller's account." },
      symbol: { type: "string",  required: false, description: "Only positions on this symbol." },
      sort:   { type: "enum",    required: false, description: "Sort order.", values: ["profit_desc", "profit_asc", "time_desc", "time_asc", "volume_desc"] },
      limit:  { type: "integer", required: false, description: "Max rows to return (1-1000).", default: 200 }
    }
  },
  {
    name: "orbit.positions.get",
    description: "Read a single open position by ticket.",
    category: "positions",
    readOnly: true,
    requiredPermission: "positions.read",
    paramsSchema: {
      ticket: { type: "integer", required: true, description: "Position ticket (id)." }
    }
  },
  {
    name: "orbit.orders.list",
    description: "List pending orders: ticket, symbol, type, volume, open price, SL/TP, expiration, comment.",
    category: "orders",
    readOnly: true,
    requiredPermission: "orders.read",
    paramsSchema: {
      login:  { type: "integer", required: false, description: "Account login; defaults to the caller's account." },
      symbol: { type: "string",  required: false, description: "Only orders on this symbol." },
      limit:  { type: "integer", required: false, description: "Max rows to return (1-1000).", default: 200 }
    }
  },
  {
    name: "orbit.orders.get",
    description: "Read a single pending order by ticket.",
    category: "orders",
    readOnly: true,
    requiredPermission: "orders.read",
    paramsSchema: {
      ticket: { type: "integer", required: true, description: "Order ticket (id)." }
    }
  },
  {
    name: "orbit.history.deals",
    description: "Closed-trade deal history over a date range: ticket, symbol, direction, volume, open/close price/time, profit, swap, commission, comment.",
    category: "history",
    readOnly: true,
    requiredPermission: "history.read",
    paramsSchema: {
      login: { type: "integer", required: false, description: "Account login; defaults to the caller's account." },
      from:  { type: "string",  required: true,  description: "Range start, ISO-8601 date or datetime (UTC)." },
      to:    { type: "string",  required: true,  description: "Range end, ISO-8601 date or datetime (UTC)." },
      symbol:{ type: "string",  required: false, description: "Only deals on this symbol." },
      limit: { type: "integer", required: false, description: "Max rows to return (1-5000).", default: 500 }
    }
  },
  {
    name: "orbit.history.orders",
    description: "Order history (filled/cancelled/expired) over a date range: ticket, symbol, type, state, volume, prices, times.",
    category: "history",
    readOnly: true,
    requiredPermission: "history.read",
    paramsSchema: {
      login: { type: "integer", required: false, description: "Account login; defaults to the caller's account." },
      from:  { type: "string",  required: true,  description: "Range start, ISO-8601 date or datetime (UTC)." },
      to:    { type: "string",  required: true,  description: "Range end, ISO-8601 date or datetime (UTC)." },
      state: { type: "enum",    required: false, description: "Order state filter.", values: ["filled", "cancelled", "expired", "rejected", "all"], default: "all" },
      limit: { type: "integer", required: false, description: "Max rows to return (1-5000).", default: 500 }
    }
  },
  {
    name: "orbit.symbols.list",
    description: "List tradeable symbols: name, description, group/path, digits, currency, contract size, trade mode.",
    category: "symbols",
    readOnly: true,
    requiredPermission: "symbols.read",
    paramsSchema: {
      group:  { type: "string",  required: false, description: "Symbol group prefix filter, e.g. 'Forex'." },
      search: { type: "string",  required: false, description: "Case-insensitive substring match on symbol name." },
      limit:  { type: "integer", required: false, description: "Max rows to return (1-5000).", default: 500 }
    }
  },
  {
    name: "orbit.symbols.spec",
    description: "Full contract specification for one symbol: digits, point, contract size, margin currency, margin requirements, swap rates, trading sessions, tick value/size, limits.",
    category: "symbols",
    readOnly: true,
    requiredPermission: "symbols.read",
    paramsSchema: {
      symbol: { type: "string", required: true, description: "Symbol name, e.g. 'EURUSD'." }
    }
  },
  {
    name: "orbit.quotes.tick",
    description: "Latest tick (quote) for one or more symbols: bid, ask, spread, tick time, trade session state.",
    category: "quotes",
    readOnly: true,
    requiredPermission: "quotes.read",
    paramsSchema: {
      symbols: { type: "array", required: true, description: "Symbol names (1-50)." }
    }
  },
  {
    name: "orbit.quotes.candles",
    description: "OHLC price history (candles) for a symbol and timeframe: time, open, high, low, close, tick volume.",
    category: "quotes",
    readOnly: true,
    requiredPermission: "quotes.read",
    paramsSchema: {
      symbol:    { type: "string",  required: true,  description: "Symbol name." },
      timeframe: { type: "enum",    required: true,  description: "Candle timeframe.", values: ["M1","M5","M15","M30","H1","H4","D1","W1","MN1"] },
      from:      { type: "string",  required: false, description: "Range start, ISO-8601 (UTC); omit with count." },
      to:        { type: "string",  required: false, description: "Range end, ISO-8601 (UTC)." },
      count:     { type: "integer", required: false, description: "Number of most recent candles (1-2000); used when 'from' is omitted.", default: 100 }
    }
  },
  {
    name: "orbit.calendar.events",
    description: "Economic calendar events over a date range: time, country, title, impact level, forecast, previous, actual (when released).",
    category: "calendar",
    readOnly: true,
    requiredPermission: "calendar.read",
    paramsSchema: {
      from:    { type: "string", required: true,  description: "Range start, ISO-8601 date or datetime (UTC)." },
      to:      { type: "string", required: true,  description: "Range end, ISO-8601 date or datetime (UTC)." },
      country: { type: "string", required: false, description: "ISO country code filter, e.g. 'US'." },
      impact:  { type: "enum",   required: false, description: "Minimum impact level.", values: ["low", "medium", "high"], default: "low" }
    }
  },
  {
    name: "orbit.platform.status",
    description: "Platform/server status: server time (UTC), connection state, trade mode (live/demo/maintenance), build version.",
    category: "platform",
    readOnly: true,
    requiredPermission: "platform.read",
    paramsSchema: {}
  },
  {
    name: "orbit.orders.place",
    description: "MUTATING: submit a new market or pending order. DISABLED unless trading tools are explicitly enabled in server config and the caller holds the dealing permission. Never call without an explicit user instruction.",
    category: "trading",
    readOnly: false,
    disabledByDefault: true,
    requiredPermission: "trading.execute",
    paramsSchema: {
      symbol:   { type: "string",  required: true,  description: "Symbol name." },
      side:     { type: "enum",    required: true,  description: "Order side.", values: ["buy", "sell"] },
      type:     { type: "enum",    required: true,  description: "Order type.", values: ["market", "limit", "stop"] },
      volume:   { type: "number",  required: true,  description: "Volume in lots." },
      price:    { type: "number",  required: false, description: "Limit/stop price (required for limit and stop orders)." },
      sl:       { type: "number",  required: false, description: "Stop-loss price." },
      tp:       { type: "number",  required: false, description: "Take-profit price." },
      comment:  { type: "string",  required: false, description: "Order comment (max 31 chars)." },
      magic:    { type: "integer", required: false, description: "Expert-advisor magic number." },
      deviation:{ type: "integer", required: false, description: "Max slippage in points for market orders.", default: 10 }
    }
  }
];

function listTools() { return TOOL_CATALOG.slice(); }
function findTool(name) {
  for (var i = 0; i < TOOL_CATALOG.length; i++)
    if (TOOL_CATALOG[i].name === name) return TOOL_CATALOG[i];
  return null;
}
function toolsByCategory(category) {
  return TOOL_CATALOG.filter(function (t) { return t.category === category; });
}
function readOnlyTools() { return TOOL_CATALOG.filter(function (t) { return t.readOnly; }); }

/* Validate caller-supplied params against a tool's schema. Returns an array
 * of error strings; empty = valid. Unknown params are rejected (strict). */
function validateToolParams(toolName, params) {
  var errs = [];
  var tool = findTool(toolName);
  if (!tool) return ["unknown tool: " + toolName];
  var p = isObj(params) ? params : {};
  var schema = tool.paramsSchema || {};
  Object.keys(schema).forEach(function (key) {
    var spec = schema[key];
    var v = p[key];
    if (v === undefined || v === null) {
      if (spec.required) errs.push("missing required param: " + key);
      return;
    }
    switch (spec.type) {
      case "string":
        if (typeof v !== "string") errs.push(key + " must be a string"); break;
      case "number":
        if (typeof v !== "number" || !isFinite(v)) errs.push(key + " must be a number"); break;
      case "integer":
        if (!int(v, -9007199254740991, 9007199254740991)) errs.push(key + " must be an integer"); break;
      case "boolean":
        if (typeof v !== "boolean") errs.push(key + " must be a boolean"); break;
      case "array":
        if (!Array.isArray(v)) errs.push(key + " must be an array"); break;
      case "object":
        if (!isObj(v)) errs.push(key + " must be an object"); break;
      case "enum":
        if (typeof v !== "string" || (spec.values || []).indexOf(v) === -1)
          errs.push(key + " must be one of " + (spec.values || []).join(", "));
        break;
      default:
        errs.push(key + " has an unknown param type: " + spec.type);
    }
  });
  Object.keys(p).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(schema, key))
      errs.push("unknown param: " + key);
  });
  return errs;
}

/* ---- 2. capability gating ----
 * canCall(toolName, ctx) → {ok, reason}. ctx:
 *   {role, rights, accountType, investor, tradingToolsEnabled}
 *   - role: optional convenience role ("admin" | "manager" | "trader" | "investor" | "viewer").
 *           When ctx.rights is omitted, the role's default rights apply.
 *   - rights: array of permission strings; "*" or "admin" is a wildcard grant.
 *   - accountType: "demo" | "real" (informational; not a gate by itself).
 *   - investor: true when the login is a read-only investor login — all
 *     mutating tools are denied regardless of rights.
 *   - tradingToolsEnabled: server config flag; mutating tools denied when false.
 * Reason codes: "ok", "unknown_tool", "tool_disabled", "investor_readonly",
 * "missing_permission". */

var ROLE_RIGHTS = {
  admin:    ["*"],
  manager:  ["platform.read", "account.read", "positions.read", "orders.read",
             "history.read", "symbols.read", "quotes.read", "calendar.read"],
  trader:   ["platform.read", "account.read", "positions.read", "orders.read",
             "history.read", "symbols.read", "quotes.read", "calendar.read",
             "trading.execute"],
  investor: ["platform.read", "account.read", "positions.read", "orders.read",
             "history.read", "symbols.read", "quotes.read", "calendar.read"],
  viewer:   ["platform.read", "symbols.read", "quotes.read", "calendar.read"]
};
var BASIC_READ_GRANT = "platform.read"; /* basic rights: enough for any read-only tool */

function rightsOf(ctx) {
  if (Array.isArray(ctx.rights)) return ctx.rights;
  var r = ROLE_RIGHTS[ctx.role];
  return r ? r.slice() : [];
}
function hasGrant(rights, permission) {
  return rights.indexOf(permission) !== -1 ||
         rights.indexOf("admin") !== -1 ||
         rights.indexOf("*") !== -1;
}

function canCall(toolName, ctx) {
  var c = ctx || {};
  var tool = findTool(toolName);
  if (!tool) return { ok: false, reason: "unknown_tool" };
  if (tool.disabledByDefault && c.tradingToolsEnabled !== true)
    return { ok: false, reason: "tool_disabled" };
  if (!tool.readOnly && c.investor === true)
    return { ok: false, reason: "investor_readonly" };
  var rights = rightsOf(c);
  if (tool.readOnly) {
    if (hasGrant(rights, tool.requiredPermission) || hasGrant(rights, BASIC_READ_GRANT))
      return { ok: true, reason: "ok" };
  } else {
    /* Mutating tools need the exact dealing permission — no basic-read shortcut. */
    if (hasGrant(rights, tool.requiredPermission))
      return { ok: true, reason: "ok" };
  }
  return { ok: false, reason: "missing_permission" };
}

/* ---- 3. prompt library ----
 * Named templates with {{variables}}; each prompt whitelists the catalog
 * tools it is allowed to use, so an assistant cannot wander outside its brief. */

var PROMPT_LIBRARY = [
  {
    id: "account-summary",
    title: "Account summary",
    variables: ["login"],
    allowedTools: ["orbit.account.get", "orbit.account.snapshot"],
    template:
      "Summarize the trading account {{login}} in plain language for a non-technical trader. " +
      "Report: account currency and leverage, balance, equity, credit, margin, free margin, margin level, " +
      "floating profit/loss, and the current server time. " +
      "Flag a margin call risk only if the margin level is below 150%. " +
      "Do not invent figures — use only the tool results."
  },
  {
    id: "position-review",
    title: "Open position review",
    variables: ["login"],
    allowedTools: ["orbit.positions.list", "orbit.positions.get", "orbit.account.snapshot"],
    template:
      "Review the open positions on account {{login}}. For each position give: symbol, direction, volume, " +
      "open price and time, current price, unrealized profit/loss, and distance to stop-loss / take-profit. " +
      "End with the account-level exposure: total floating P/L and margin level. " +
      "Do not recommend trades — describe only. Use only the tool results."
  },
  {
    id: "market-brief",
    title: "Market brief",
    variables: ["symbols"],
    allowedTools: ["orbit.symbols.list", "orbit.symbols.spec", "orbit.quotes.tick",
                   "orbit.quotes.candles", "orbit.calendar.events"],
    template:
      "Produce a short market brief for: {{symbols}}. For each symbol give the latest bid/ask and spread, " +
      "the last daily candle direction, and any high-impact economic events in the next 48 hours. " +
      "State the data time (UTC) for every figure. Never present prices as live beyond their tick time. " +
      "Use only the tool results."
  },
  {
    id: "history-review",
    title: "Trading history review",
    variables: ["login", "days"],
    allowedTools: ["orbit.history.deals", "orbit.history.orders"],
    template:
      "Review the last {{days}} days of trading on account {{login}}. Give: total closed deals, win rate, " +
      "net profit/loss, average win vs average loss, largest single win and loss, and the most traded symbols. " +
      "List any rejected or expired orders separately. Base everything on the tool results; say so if a " +
      "range returned no deals."
  },
  {
    id: "risk-check",
    title: "Risk check",
    variables: ["login"],
    allowedTools: ["orbit.account.snapshot", "orbit.positions.list", "orbit.orders.list"],
    template:
      "Run a risk check on account {{login}}. Compute: margin level, total exposure (sum of position volumes " +
      "per symbol), and the worst-case loss if every open stop-loss is hit. List pending orders that could " +
      "increase exposure. Warn clearly if the margin level is below 200%. This is descriptive analysis, " +
      "not financial advice. Use only the tool results."
  }
];

function listPrompts() {
  return PROMPT_LIBRARY.map(function (p) {
    return { id: p.id, title: p.title, variables: p.variables.slice(), allowedTools: p.allowedTools.slice() };
  });
}
function findPrompt(id) {
  for (var i = 0; i < PROMPT_LIBRARY.length; i++)
    if (PROMPT_LIBRARY[i].id === id) return PROMPT_LIBRARY[i];
  return null;
}
/* Render a prompt with vars substituted for {{variables}}. Throws when the
 * prompt id is unknown or a variable is missing (callers can catch). */
function renderPrompt(id, vars) {
  var p = findPrompt(id);
  if (!p) throw new Error("unknown prompt: " + id);
  var v = isObj(vars) ? vars : {};
  var missing = [];
  var out = p.template;
  p.variables.forEach(function (name) {
    var val = v[name];
    if (val === undefined || val === null || val === "") missing.push(name);
    out = out.split("{{" + name + "}}").join(String(val === undefined || val === null ? "" : val));
  });
  if (missing.length) throw new Error("missing prompt variables: " + missing.join(", "));
  return out;
}
/* Check that every tool a prompt may use exists in the catalog. */
function promptToolsValid(id) {
  var p = findPrompt(id);
  if (!p) return ["unknown prompt: " + id];
  return p.allowedTools.filter(function (n) { return !findTool(n); })
    .map(function (n) { return "unknown tool in prompt " + id + ": " + n; });
}

/* ---- 4. param sanitizer ----
 * Redacts credential-like fields before anything is logged or echoed back. */

var SENSITIVE_KEY_SUBSTRINGS = ["password", "secret", "token", "apikey", "api_key", "session", "privatekey", "private_key", "credential", "auth"];
var SENSITIVE_KEYS_EXACT = ["pass", "pwd", "pin", "otp", "cookie", "cookies"];

function isSensitiveKey(key) {
  var k = String(key).toLowerCase();
  if (SENSITIVE_KEYS_EXACT.indexOf(k) !== -1) return true;
  for (var i = 0; i < SENSITIVE_KEY_SUBSTRINGS.length; i++)
    if (k.indexOf(SENSITIVE_KEY_SUBSTRINGS[i]) !== -1) return true;
  return false;
}
function sanitizeParams(params) {
  if (Array.isArray(params)) return params.map(sanitizeParams);
  if (!isObj(params)) return params;
  var out = {};
  Object.keys(params).forEach(function (key) {
    out[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeParams(params[key]);
  });
  return out;
}

/* ---- 5. call audit ----
 * logToolCall(log, call, now): appends an entry and returns it.
 *   log: array (append-only; callers persist it).
 *   call: {tool, params, actor, allowed, reason?}.
 *   now: injected timestamp (ms epoch or ISO string); pure/deterministic.
 * Entry: {id, tool, actor, params (sanitized), at, allowed, reason?}. */

function logToolCall(log, call, now) {
  if (!Array.isArray(log)) throw new Error("log must be an array");
  var c = isObj(call) ? call : {};
  var entry = {
    id: "call-" + (log.length + 1),
    tool: c.tool,
    actor: c.actor,
    params: sanitizeParams(c.params),
    at: now === undefined || now === null ? new Date().toISOString() : now,
    allowed: c.allowed === true
  };
  if (c.reason !== undefined) entry.reason = c.reason;
  log.push(entry);
  return entry;
}

/* ---- 6. MCP server config ---- */

var MCP_TRANSPORTS = ["http", "https", "stdio"];

function defaultMcpConfig() {
  return {
    enabled: false,
    transport: "http",
    allowedOrigins: [],
    rateLimitPerMin: 60,
    tradingToolsEnabled: false, /* mutating tools stay off unless the operator opts in */
    logCalls: true
  };
}
function validateMcpConfig(c) {
  var errs = [];
  function err(m) { errs.push(m); }
  if (!c || typeof c !== "object" || Array.isArray(c))
    return ["mcp config must be an object"];
  if (typeof c.enabled !== "boolean") err("enabled must be a boolean");
  if (MCP_TRANSPORTS.indexOf(c.transport) === -1)
    err("transport must be one of " + MCP_TRANSPORTS.join(", "));
  if (!Array.isArray(c.allowedOrigins)) err("allowedOrigins must be an array");
  else c.allowedOrigins.forEach(function (o, i) {
    if (typeof o !== "string" || !o) err("allowedOrigins[" + i + "] must be a non-empty string");
  });
  if (!int(c.rateLimitPerMin, 1, 100000)) err("rateLimitPerMin must be an integer 1-100000");
  if (typeof c.tradingToolsEnabled !== "boolean") err("tradingToolsEnabled must be a boolean");
  if (typeof c.logCalls !== "boolean") err("logCalls must be a boolean");
  if (c.enabled && c.transport !== "stdio" && c.allowedOrigins.length === 0)
    err("enabled network transport requires at least one allowedOrigins entry");
  return errs;
}

/* Pure sliding-window rate-limit decision.
 * recentCalls: array of ms-epoch timestamps of prior calls in this window.
 * Returns {allowed, retryAfterMs}. */
function rateLimitDecision(recentCalls, nowMs, limit) {
  var calls = (Array.isArray(recentCalls) ? recentCalls : [])
    .filter(function (t) { return typeof t === "number" && t > nowMs - 60000 && t <= nowMs; })
    .sort(function (a, b) { return a - b; });
  if (calls.length < limit) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: (calls[0] + 60000) - nowMs };
}

/* ---- exports ---- */

var AI_MCP = {
  /* catalog */
  PARAM_TYPES: PARAM_TYPES,
  CATEGORIES: CATEGORIES,
  listTools: listTools,
  findTool: findTool,
  toolsByCategory: toolsByCategory,
  readOnlyTools: readOnlyTools,
  validateToolParams: validateToolParams,
  /* gating */
  ROLE_RIGHTS: ROLE_RIGHTS,
  BASIC_READ_GRANT: BASIC_READ_GRANT,
  canCall: canCall,
  /* prompts */
  listPrompts: listPrompts,
  findPrompt: findPrompt,
  renderPrompt: renderPrompt,
  promptToolsValid: promptToolsValid,
  /* audit */
  sanitizeParams: sanitizeParams,
  logToolCall: logToolCall,
  /* config */
  MCP_TRANSPORTS: MCP_TRANSPORTS,
  defaultMcpConfig: defaultMcpConfig,
  validateMcpConfig: validateMcpConfig,
  rateLimitDecision: rateLimitDecision
};
if (typeof module !== "undefined" && module.exports) { module.exports = AI_MCP; }
else { root.OrbitAiMcp = AI_MCP; }
})(typeof globalThis !== "undefined" ? globalThis : this);
