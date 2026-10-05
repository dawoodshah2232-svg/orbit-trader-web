/* shared/liquidity.js — OrbitTrader liquidity module: ECN-style price
 * aggregation, order routing rules, symbol & price translation, and the
 * gateway model (config, remote deployment, status/journal, positions
 * requests, weekend operation).
 *
 * Pure functions, no globals, no DOM, no Date.now() — every time-dependent
 * function takes `now` (epoch ms) as a parameter so behavior is deterministic
 * and testable in node and the browser. UMD pattern: node module.exports +
 * browser global OrbitLiquidity (same pattern as shared/groups.js).
 *
 * Relationship to shared/feeds.js: feeds.js owns the priority-ordered quote
 * sources and instant failover. This module is NOT a duplicate of it — it
 * layers on top:
 *   - the price aggregator consumes books from feed/gateway sources and
 *     merges them into one DOM stream;
 *   - the routing engine references gateway IDs managed by the feed config;
 *   - the translation maps sit between external feeds and internal symbols.
 *
 * Model (OrbitTrader's own, neutral terms):
 *   1. Price aggregator — merges quote books from many external sources into
 *      one stream + market depth. Per-source, per-direction selection (one
 *      source may feed the bid side while another feeds the ask side),
 *      volume filters and time-window filters per source.
 *   2. Cluster aggregator — the platform's own open orders become depth
 *      levels. Per-group / per-client inclusion via masks.
 *   3. Matching statistics — requests, active orders, platform-matched
 *      deals, gateway-matched deals, price ticks, book changes; reset on
 *      restart.
 *   4. Routing rules engine — top-down rules with conditions (request type,
 *      order type, additional AND-conditions) and actions (process to a
 *      dealer/gateway, or to the internal matching engine). Dealer/gateway
 *      priority: symbol-configured gateway first, then gateways before
 *      dealers, with next-candidate fallback after a refusal.
 *   5. Symbol & price translation — rename external symbols, shift bid/ask
 *      in points, masks with "!" negation, topmost-match-wins.
 *   6. Gateway config — unique IMMUTABLE gateway id (referenced by deal
 *      records and routing rules; changing it requires a new config),
 *      enable flag with auto-off outside working hours, module executable,
 *      modes (trade+quotes / trade only), external server credentials,
 *      advanced network (loopback, ordered address fallback, auto-switch),
 *      client groups processed, balance-import flag, handled symbols with
 *      masks, translations, parameters (news category, quote delay <=20min,
 *      sampling, calendar holidays), timeouts.
 *   7. Remote gateway as a service — install/start/stop/uninstall
 *      lifecycle, .cfg file model, NOT auto-updated on platform upgrades.
 *   8. Gateway status + journal + speed profiling.
 *   9. Gateway positions request — ask a gateway for current positions of
 *      its accounts, with totals.
 *  10. Weekend operation — LP-style gateways stay off on weekends;
 *      platform-following gateways follow the platform weekend settings;
 *      calendar parameter overrides (+DDMMM force-off / -DDMMM force-on).
 *  11. Book routing (A-Book / B-Book / C-Book) — per-symbol/per-group rules
 *      selecting which book takes the flow; B-Book-first coverage with
 *      proportional reduction (minimum coverage volume + coverage %);
 *      basis-symbol aggregation for LP routing decisions; C-Book internal
 *      crossing; LP turnover / imbalance / slippage reports; toxic-flow
 *      flags.
 *
 * All defaults below are OrbitTrader defaults, not any broker's values.
 */
(function (root) {
"use strict";

/* ============================== utilities ============================== */

function num(v, fb) { v = +v; return isFinite(v) ? v : fb; }
function str(v, fb) { return (typeof v === "string") ? v : fb; }
function trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }

function tokenPattern(token) {
  var esc = String(token).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + esc + "$");
}

/* Mask language shared by translations, group/client inclusion and handled
 * symbols: comma-separated tokens, "*" wildcards, "!" negation.
 * Semantics: negations veto; with no positive tokens, anything not negated
 * matches; otherwise at least one positive token must match. */
function matchMask(symbol, mask) {
  if (typeof symbol !== "string" || typeof mask !== "string") return false;
  var pos = [], neg = [];
  mask.split(",").forEach(function (raw) {
    var t = trim(raw);
    if (!t) return;
    if (t.charAt(0) === "!") {
      t = trim(t.slice(1));
      if (t) neg.push(t);
    } else {
      pos.push(t);
    }
  });
  if (pos.length === 0 && neg.length === 0) return false;
  function hits(tokens) {
    for (var i = 0; i < tokens.length; i++) {
      if (tokenPattern(tokens[i]).test(symbol)) return true;
    }
    return false;
  }
  if (hits(neg)) return false;
  if (pos.length === 0) return true;
  return hits(pos);
}

function cloneShallow(obj) {
  var out = {};
  if (obj && typeof obj === "object") {
    Object.keys(obj).forEach(function (k) { out[k] = obj[k]; });
  }
  return out;
}

/* "HH:MM" (24h, UTC) -> minutes since midnight; NaN when malformed. */
function hhmmToMinutes(s) {
  if (typeof s !== "string") return NaN;
  var m = /^(\d{1,2}):(\d{2})$/.exec(trim(s));
  if (!m) return NaN;
  var h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return NaN;
  return h * 60 + mi;
}

function utcMinutesOfDay(now) {
  var d = new Date(num(now, 0));
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/* ==================== 1. price aggregator ==================== */

var AGGREGATOR_SOURCE_TYPES = ["feed", "gateway"];
var DEPTH_DEFAULT_LEVELS = 8;

/* A source entry inside the aggregator:
 *   id            — source id (matches a feeds.js source id)
 *   type          — "feed" | "gateway"
 *   enabled       — participate at all
 *   bid / ask     — per-direction selection: include its levels on the
 *                   bid side / ask side (independent booleans)
 *   volume_min / volume_max — volume filter: only levels whose volume sits
 *                   in [min, max] are kept (null = unbounded)
 *   time_from / time_to — "HH:MM" UTC window; both null = always active
 */
function defaultAggregatorSource(id) {
  return {
    id: str(id, ""), type: "feed", enabled: true,
    bid: true, ask: true,
    volume_min: null, volume_max: null,
    time_from: null, time_to: null
  };
}

function defaultAggregatorConfig() {
  return {
    sources: [],
    depth_levels: DEPTH_DEFAULT_LEVELS,
    cluster: defaultClusterConfig()
  };
}

function sourceInTimeWindow(src, now) {
  var from = hhmmToMinutes(src.time_from);
  var to = hhmmToMinutes(src.time_to);
  if (isNaN(from) || isNaN(to)) return true; /* malformed or absent = always */
  var m = utcMinutesOfDay(now);
  if (from <= to) return m >= from && m < to;
  return m >= from || m < to; /* overnight window, e.g. 22:00-06:00 */
}

function levelPassesVolume(level, src) {
  var v = num(level && level.volume, NaN);
  if (isNaN(v)) return false;
  if (src.volume_min != null && v < src.volume_min) return false;
  if (src.volume_max != null && v > src.volume_max) return false;
  return true;
}

/* Merge one source's book into the running aggregation.
 * sourceBooks: [{ source_id, bids: [{price, volume}], asks: [{price, volume}] }]
 * Returns { symbol, at, bids, asks, used_sources } where bids are sorted
 * best-first (desc), asks best-first (asc), each level tagged with its
 * source id, capped at config.depth_levels per side. */
function aggregateBook(symbol, sourceBooks, config, now) {
  config = config || defaultAggregatorConfig();
  var byId = {};
  (config.sources || []).forEach(function (s) { if (s && s.id) byId[s.id] = s; });
  var cap = Math.max(1, num(config.depth_levels, DEPTH_DEFAULT_LEVELS) | 0);
  var bids = [], asks = [], used = [];
  (sourceBooks || []).forEach(function (book) {
    if (!book || !book.source_id) return;
    var src = byId[book.source_id];
    if (!src || src.enabled === false) return;
    if (!sourceInTimeWindow(src, now)) return;
    var included = false;
    function push(side, levels, allowed) {
      if (!allowed) return;
      (levels || []).forEach(function (lv) {
        if (!lv || !isFinite(+lv.price)) return;
        if (!levelPassesVolume(lv, src)) return;
        side.push({ price: +lv.price, volume: num(lv.volume, 0), source: src.id });
        included = true;
      });
    }
    push(bids, book.bids, src.bid !== false);
    push(asks, book.asks, src.ask !== false);
    if (included && used.indexOf(src.id) < 0) used.push(src.id);
  });
  bids.sort(function (a, b) { return b.price - a.price || b.volume - a.volume; });
  asks.sort(function (a, b) { return a.price - b.price || b.volume - a.volume; });
  return {
    symbol: str(symbol, ""), at: num(now, 0),
    bids: bids.slice(0, cap), asks: asks.slice(0, cap),
    used_sources: used
  };
}

/* ==================== 2. cluster aggregator ==================== */

/* The platform's own open orders, offered as depth.
 * groups / clients: mask lists for per-group / per-client inclusion
 * ("*" = include all; "!" negation narrows). include=false turns the
 * cluster book off entirely. */
function defaultClusterConfig() {
  return { include: true, groups: "*", clients: "*" };
}

/* openOrders: [{ side: "buy"|"sell", price, volume, group, client_id }]
 * Returns the cluster's side of the DOM as { bids, asks } levels tagged
 * source: "cluster", sorted best-first, capped at depthLevels. */
function clusterBook(symbol, openOrders, clusterCfg, depthLevels) {
  clusterCfg = clusterCfg || defaultClusterConfig();
  var cap = Math.max(1, num(depthLevels, DEPTH_DEFAULT_LEVELS) | 0);
  var bids = [], asks = [];
  if (clusterCfg.include === false) return { symbol: str(symbol, ""), bids: bids, asks: asks };
  (openOrders || []).forEach(function (o) {
    if (!o || !isFinite(+o.price) || !isFinite(+o.volume)) return;
    if (!matchMask(str(o.group, ""), str(clusterCfg.groups, "*"))) return;
    if (!matchMask(str(o.client_id, ""), str(clusterCfg.clients, "*"))) return;
    var lv = { price: +o.price, volume: +o.volume, source: "cluster" };
    if (o.side === "buy") bids.push(lv);
    else if (o.side === "sell") asks.push(lv);
  });
  bids.sort(function (a, b) { return b.price - a.price || b.volume - a.volume; });
  asks.sort(function (a, b) { return a.price - b.price || b.volume - a.volume; });
  return { symbol: str(symbol, ""), bids: bids.slice(0, cap), asks: asks.slice(0, cap) };
}

/* ==================== 3. matching statistics ==================== */

/* Counters, reset on restart. bumpStats is immutable: it returns a new
 * object and leaves its argument untouched. */
function newStats() {
  return {
    requests: 0,            /* total trade requests seen */
    active_orders: 0,       /* orders currently open */
    ecn_matched_deals: 0,   /* deals matched inside the platform engine */
    gateway_matched_deals: 0, /* deals matched on external gateways */
    ecn_price_ticks: 0,     /* price ticks produced by the platform engine */
    book_changes: 0         /* order-book change events */
  };
}

function bumpStats(stats, event) {
  var s = cloneShallow(stats && typeof stats === "object" ? stats : newStats());
  ["requests", "active_orders", "ecn_matched_deals",
   "gateway_matched_deals", "ecn_price_ticks", "book_changes"
  ].forEach(function (k) { s[k] = num(s[k], 0); });
  switch (event) {
    case "request": s.requests += 1; break;
    case "order_open": s.requests += 1; s.active_orders += 1; break;
    case "order_close": s.active_orders = Math.max(0, s.active_orders - 1); break;
    case "ecn_deal": s.ecn_matched_deals += 1; break;
    case "gateway_deal": s.gateway_matched_deals += 1; break;
    case "price_tick": s.ecn_price_ticks += 1; break;
    case "book_change": s.book_changes += 1; break;
    default: break; /* unknown events leave the counters unchanged */
  }
  return s;
}

/* ==================== 4. routing rules engine ==================== */

var ROUTE_REQUEST_TYPES = ["trade"];
var ROUTE_ORDER_TYPES = ["market", "limit", "stop", "stop_limit"];
var ROUTE_ACTIONS = ["dealer", "ecn"];
var CONDITION_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in"];

/* Rule:
 *   id, name, enabled
 *   conditions: { request_type, order_type, and: [{field, op, value}] }
 *     request_type / order_type null = wildcard (any)
 *     and: list of extra conditions, ALL must hold; field is a dotted path
 *     into the request (e.g. "volume", "client.group", "symbol")
 *   action: { type: "dealer"|"ecn", dealer_id } — dealer_id optional; when
 *     absent the dealer/gateway priority scheme picks the target.
 */
function defaultRoutingConfig() {
  return { rules: [] };
}

function getField(obj, path) {
  var cur = obj;
  var parts = String(path || "").split(".");
  for (var i = 0; i < parts.length; i++) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function condHolds(cond, request) {
  if (!cond || typeof cond !== "object") return true;
  var actual = getField(request, cond.field);
  var v = cond.value;
  switch (cond.op) {
    case "ne": return actual !== v;
    case "gt": return +actual > +v;
    case "gte": return +actual >= +v;
    case "lt": return +actual < +v;
    case "lte": return +actual <= +v;
    case "in": return Array.isArray(v) && v.indexOf(actual) >= 0;
    case "eq": default: return actual === v;
  }
}

/* Does a single rule match the request? Wildcards when the condition is
 * absent/null; every `and` condition must hold. */
function matchRule(rule, request) {
  if (!rule || typeof rule !== "object") return false;
  if (rule.enabled === false) return false;
  var c = rule.conditions || {};
  if (c.request_type != null && request.request_type !== c.request_type) return false;
  if (c.order_type != null && request.order_type !== c.order_type) return false;
  var ands = c.and || [];
  for (var i = 0; i < ands.length; i++) {
    if (!condHolds(ands[i], request)) return false;
  }
  return true;
}

/* Dealer/gateway priority scheme (first-to-capture fallback):
 *   1. the gateway configured on the symbol (request.symbol_gateway_id),
 *      when it is an enabled dealer in the list;
 *   2. other enabled gateways, in list order;
 *   3. enabled dealers, in list order.
 * Dealer entry: { id, kind: "gateway"|"dealer", enabled }. */
function dealerPriorityList(dealers, request) {
  var list = Array.isArray(dealers) ? dealers : [];
  var enabled = list.filter(function (d) { return d && d.id && d.enabled !== false; });
  var gw = enabled.filter(function (d) { return d.kind === "gateway"; });
  var dl = enabled.filter(function (d) { return d.kind !== "gateway"; });
  var out = [];
  var symGw = request && request.symbol_gateway_id;
  var symEntry = null;
  if (symGw) {
    for (var i = 0; i < gw.length; i++) {
      if (gw[i].id === symGw) { symEntry = gw[i]; break; }
    }
  }
  if (symEntry) out.push(symEntry);
  gw.forEach(function (d) { if (d !== symEntry) out.push(d); });
  dl.forEach(function (d) { out.push(d); });
  return out;
}

function resolveDealer(dealers, request) {
  var ordered = dealerPriorityList(dealers, request);
  return ordered.length ? ordered[0].id : null;
}

/* Next candidate after a refusal/return: same priority order, skipping the
 * dealer that refused. */
function nextDealer(dealers, request, refusedId) {
  var ordered = dealerPriorityList(dealers, request);
  for (var i = 0; i < ordered.length; i++) {
    if (ordered[i].id !== refusedId) return ordered[i].id;
  }
  return null;
}

/* Top-down rule evaluation: the first matching enabled rule wins.
 * Returns { rule_id, action, target } where target is the dealer id for a
 * dealer action (forced dealer_id, else the priority scheme) and null for
 * the internal engine ("ecn"). With no matching rule the default is
 * "process to dealer" via the priority scheme. */
function routeRequest(request, config, dealers) {
  config = config || defaultRoutingConfig();
  var rules = config.rules || [];
  var rule = null;
  for (var i = 0; i < rules.length; i++) {
    if (matchRule(rules[i], request)) { rule = rules[i]; break; }
  }
  var action = (rule && rule.action) || { type: "dealer" };
  var type = action.type === "ecn" ? "ecn" : "dealer";
  var target = null;
  if (type === "dealer") {
    target = (action.dealer_id != null) ? action.dealer_id : resolveDealer(dealers, request);
  }
  return { rule_id: rule ? rule.id : null, action: type, target: target };
}

function validateRoutingConfig(config) {
  var errs = [];
  if (!config || typeof config !== "object") return ["config must be an object"];
  var seen = {};
  (config.rules || []).forEach(function (r, i) {
    var tag = "rules[" + i + "]";
    if (!r || typeof r !== "object") { errs.push(tag + ": must be an object"); return; }
    if (!r.id) errs.push(tag + ": missing id");
    else if (seen[r.id]) errs.push(tag + ": duplicate id '" + r.id + "'");
    else seen[r.id] = true;
    var c = r.conditions || {};
    if (c.request_type != null && ROUTE_REQUEST_TYPES.indexOf(c.request_type) < 0) {
      errs.push(tag + ": unknown request_type '" + c.request_type + "'");
    }
    if (c.order_type != null && ROUTE_ORDER_TYPES.indexOf(c.order_type) < 0) {
      errs.push(tag + ": unknown order_type '" + c.order_type + "'");
    }
    (c.and || []).forEach(function (a, j) {
      if (!a || typeof a !== "object") { errs.push(tag + ".and[" + j + "]: must be an object"); return; }
      if (!a.field) errs.push(tag + ".and[" + j + "]: missing field");
      if (CONDITION_OPS.indexOf(a.op) < 0) errs.push(tag + ".and[" + j + "]: unknown op '" + a.op + "'");
    });
    var a2 = r.action || {};
    if (ROUTE_ACTIONS.indexOf(a2.type) < 0) errs.push(tag + ": unknown action type '" + a2.type + "'");
  });
  return errs;
}

/* ==================== 5. symbol & price translation ==================== */

/* Entry: { mask, rename, bid_shift_points, ask_shift_points }.
 * rename: internal symbol name for the external one (null = keep name).
 * Shifts are in points; 1 point = 10^-digits. */
function defaultTranslationEntry(mask) {
  return { mask: str(mask, ""), rename: null, bid_shift_points: 0, ask_shift_points: 0 };
}

function defaultTranslationConfig() {
  return { entries: [] };
}

/* Topmost-match-wins: the FIRST entry whose mask matches the external
 * symbol applies. Returns { platform_symbol, bid_shift_points,
 * ask_shift_points } or null when nothing matches. */
function translateSymbol(externalSymbol, entries) {
  var list = Array.isArray(entries) ? entries : (entries && entries.entries) || [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e || typeof e !== "object") continue;
    if (matchMask(externalSymbol, e.mask || "")) {
      return {
        platform_symbol: (e.rename != null) ? e.rename : externalSymbol,
        bid_shift_points: num(e.bid_shift_points, 0),
        ask_shift_points: num(e.ask_shift_points, 0)
      };
    }
  }
  return null;
}

function pointValue(digits) {
  return Math.pow(10, -num(digits, 0));
}

function applyShift(price, shiftPoints, digits) {
  var p = num(price, NaN);
  if (isNaN(p)) return NaN;
  return p + num(shiftPoints, 0) * pointValue(digits);
}

/* Shift every level of a translated book. The translation affects the DOM:
 * bid levels move by bid_shift_points, ask levels by ask_shift_points. */
function translateBook(book, translation, digits) {
  if (!book) return null;
  translation = translation || { bid_shift_points: 0, ask_shift_points: 0 };
  function shift(levels, pts) {
    return (levels || []).map(function (lv) {
      return { price: applyShift(lv.price, pts, digits), volume: num(lv.volume, 0), source: lv.source };
    });
  }
  return {
    symbol: translation.platform_symbol != null ? translation.platform_symbol : book.symbol,
    at: book.at,
    bids: shift(book.bids, translation.bid_shift_points),
    asks: shift(book.asks, translation.ask_shift_points),
    used_sources: book.used_sources ? book.used_sources.slice() : []
  };
}

/* ==================== 6. gateway configuration ==================== */

var GATEWAY_MODES = ["trade_quotes", "trade_only"]; /* trade+quotes | trade only */
var GATEWAY_KINDS = ["lp", "platform"]; /* liquidity-provider style | peer platform */

/* The gateway id is UNIQUE and IMMUTABLE: deal records and routing rules
 * reference it by id. Changing it requires a new gateway config —
 * rekeyGatewayId() builds one; it never mutates in place.
 *
 * Defaults: enabled with auto-off outside working hours; trade+quotes;
 * receive+update symbols and deliver quotes on; symbol-settings import,
 * balance import and calendar overrides off. All values are OrbitTrader
 * defaults, not any broker's. */
function defaultGatewayConfig() {
  return {
    id: "",
    name: "",
    enabled: true,
    auto_off_outside_hours: true,
    module: "",                    /* connector executable on the history server */
    mode: "trade_quotes",
    server: { address: "", login: "", password: "" }, /* external trading server */
    network: { loopback: false, addresses: [], auto_switch: true },
    groups: [],                    /* client groups processed by this gateway */
    allow_import_trader_balances: false, /* external accounting corrections */
    symbols: {
      receive_update: true,        /* receive/update handled symbols */
      deliver_quotes: true,        /* publish quotes from this gateway */
      allow_import_symbol_settings: false, /* new symbols land with trading disabled */
      masks: ""                    /* handled symbols; masks with ! negation */
    },
    translations: [],              /* translation entries (topmost-match-wins) */
    parameters: {
      news_category: "",
      quotes_delay_min: 0,         /* 0-20 minutes */
      tick_sampling: true,
      book_sampling: true,
      trading_calendar_holidays: "" /* "+DDMMM" force-off / "-DDMMM" force-on */
    },
    timeouts: { reconnect_interval_sec: 60, reconnect_attempts: 10 },
    weekend: defaultWeekendConfig()
  };
}

function validateGatewayConfig(cfg) {
  var errs = [];
  if (!cfg || typeof cfg !== "object") return ["config must be an object"];
  if (!cfg.id) errs.push("id is required");
  if (GATEWAY_MODES.indexOf(cfg.mode) < 0) {
    errs.push("mode must be one of: " + GATEWAY_MODES.join("|"));
  }
  var qd = num(cfg.parameters && cfg.parameters.quotes_delay_min, NaN);
  if (!isFinite(qd) || qd < 0 || qd > 20) {
    errs.push("parameters.quotes_delay_min must be between 0 and 20 minutes");
  }
  var ri = num(cfg.timeouts && cfg.timeouts.reconnect_interval_sec, NaN);
  if (!isFinite(ri) || ri <= 0) errs.push("timeouts.reconnect_interval_sec must be positive");
  var ra = num(cfg.timeouts && cfg.timeouts.reconnect_attempts, NaN);
  if (!isFinite(ra) || ra < 0 || Math.floor(ra) !== ra) {
    errs.push("timeouts.reconnect_attempts must be a non-negative integer");
  }
  ((cfg.network && cfg.network.addresses) || []).forEach(function (a, i) {
    if (typeof a !== "string" || !trim(a)) {
      errs.push("network.addresses[" + i + "]: must be a non-empty address string");
    }
  });
  if (GATEWAY_KINDS.indexOf(cfg.weekend && cfg.weekend.kind) < 0) {
    errs.push("weekend.kind must be one of: " + GATEWAY_KINDS.join("|"));
  }
  return errs;
}

/* Changing a gateway id requires a NEW config object; the old one is left
 * untouched (id is immutable on an existing config). */
function rekeyGatewayId(cfg, newId) {
  var out = cloneShallow(cfg || {});
  out.id = str(newId, "");
  return out;
}

/* ==================== 7. remote gateway as a service ==================== */

/* Remote gateways can run as OS services next to the platform. The .cfg
 * carries connection identity; timezone/DST tell the gateway how to
 * interpret its own schedule. Remote gateways are NOT auto-updated when
 * the platform upgrades — they are redeployed manually. */
var SERVICE_ACTIONS = ["install", "start", "stop", "uninstall"];

function defaultServiceConfig() {
  return {
    name: "", address: "", login: "", password: "",
    timezone: "UTC", dst_enabled: false
  };
}

function validateServiceConfig(cfg) {
  var errs = [];
  if (!cfg || typeof cfg !== "object") return ["config must be an object"];
  ["name", "address", "login"].forEach(function (k) {
    if (typeof cfg[k] !== "string" || !trim(cfg[k])) errs.push(k + " is required");
  });
  return errs;
}

/* Lifecycle description for a remote gateway service action. Returns the
 * ordered steps (as neutral descriptions, no platform paths invented) plus
 * the upgrade note. */
var SERVICE_UPGRADE_NOTE =
  "remote gateways are not auto-updated on platform upgrades; redeploy them manually";

function describeServiceAction(action) {
  if (SERVICE_ACTIONS.indexOf(action) < 0) return null;
  var steps = {
    install: [
      "deploy the connector binary and its API library beside each other",
      "write the .cfg file (name, address, login/password, timezone, DST)",
      "register the service with the OS"
    ],
    start: ["start the registered service"],
    stop: ["stop the running service"],
    uninstall: ["stop the service if running", "remove the OS service registration"]
  };
  return { action: action, steps: steps[action], upgrade_note: SERVICE_UPGRADE_NOTE };
}

/* ==================== 8. gateway status, journal, profiling ==================== */

function defaultGatewayStatus(gatewayId) {
  return {
    gateway_id: str(gatewayId, ""),
    module: "", api_version: "", signed_by: "",
    config_id: "",
    db: { trades_processed: 0, traffic_bytes: 0 },
    at: null
  };
}

/* Speed-profiling breakdown for a gateway (milliseconds). */
function defaultSpeedProfile() {
  return {
    process_time_ms: 0,
    request_process_ms: 0,
    order_execute_ms: 0,
    api_overhead_ms: 0,
    trade_server_response_ms: 0,
    gateway_response_ms: 0
  };
}

function profileTotal(profile) {
  var total = 0;
  if (profile && typeof profile === "object") {
    Object.keys(defaultSpeedProfile()).forEach(function (k) {
      total += num(profile[k], 0);
    });
  }
  return total;
}

function validateSpeedProfile(profile) {
  var errs = [];
  if (!profile || typeof profile !== "object") return ["profile must be an object"];
  Object.keys(defaultSpeedProfile()).forEach(function (k) {
    var v = num(profile[k], NaN);
    if (!isFinite(v) || v < 0) errs.push(k + " must be a non-negative number");
  });
  return errs;
}

var JOURNAL_LEVELS = ["info", "warning", "error"];

function journalEntry(gatewayId, now, level, message) {
  return {
    gateway_id: str(gatewayId, ""),
    at: num(now, 0),
    level: JOURNAL_LEVELS.indexOf(level) >= 0 ? level : "info",
    message: str(message, "")
  };
}

/* ==================== 9. gateway positions request ==================== */

/* Ask a gateway for the current positions held on its accounts.
 * positionsRequest builds the request; summarizeGatewayPositions folds the
 * reply ( [{ symbol, type: "buy"|"sell", volume, price, comment }] ) into
 * totals per symbol. */
function positionsRequest(gatewayId, accounts, now) {
  return {
    gateway_id: str(gatewayId, ""),
    accounts: (accounts || []).slice(),
    requested_at: num(now, 0)
  };
}

function summarizeGatewayPositions(positions) {
  var list = (positions || []).filter(function (p) {
    return p && typeof p.symbol === "string" && isFinite(+p.volume);
  });
  var bySymbol = {};
  var totalVolume = 0;
  list.forEach(function (p) {
    var agg = bySymbol[p.symbol] || { volume: 0, count: 0 };
    agg.volume += +p.volume;
    agg.count += 1;
    bySymbol[p.symbol] = agg;
    totalVolume += +p.volume;
  });
  return { positions: list, totals: { count: list.length, total_volume: totalVolume, by_symbol: bySymbol } };
}

/* ==================== 10. weekend operation ==================== */

function defaultWeekendConfig() {
  return { kind: "lp", calendar_overrides: "" };
}

/* Calendar parameter: comma list of "+DDMMM" (force off that day) and
 * "-DDMMM" (force on that day), e.g. "+25DEC,-26DEC". Returns true = force
 * on, false = force off, null = no override for the day of `now` (UTC). */
function parseCalendarOverrides(param, now) {
  if (typeof param !== "string" || !trim(param)) return null;
  var d = new Date(num(now, 0));
  var months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  var dd = ("0" + d.getUTCDate()).slice(-2);
  var today = dd + months[d.getUTCMonth()];
  var result = null;
  param.split(",").forEach(function (raw) {
    var t = trim(raw);
    if (t.length < 2) return;
    var sign = t.charAt(0), day = t.slice(1).toUpperCase();
    if (day !== today) return;
    if (sign === "+") result = false;      /* force off */
    else if (sign === "-") result = true;  /* force on */
  });
  return result;
}

function isWeekend(now) {
  var dow = new Date(num(now, 0)).getUTCDay();
  return dow === 0 || dow === 6;
}

/* Weekend rule: LP-style gateways stay off on weekends; platform-following
 * gateways follow the platform weekend setting. The calendar parameter
 * overrides both. */
function gatewayOpenOnWeekend(gateway, now, platformOpenOnWeekend) {
  var weekend = (gateway && gateway.weekend) || defaultWeekendConfig();
  var cal = parseCalendarOverrides(weekend.calendar_overrides, now);
  if (cal != null) return cal;
  if (!isWeekend(now)) return true;
  if (weekend.kind === "lp") return false;
  return !!platformOpenOnWeekend;
}

/* Effective enable state: disabled flag, auto-off outside working hours,
 * and the weekend rule combined. */
function gatewayEffectiveState(gateway, now, ctx) {
  gateway = gateway || defaultGatewayConfig();
  ctx = ctx || {};
  if (gateway.enabled === false) return { enabled: false, reason: "disabled" };
  if (gateway.auto_off_outside_hours && ctx.in_working_hours === false) {
    return { enabled: false, reason: "outside_working_hours" };
  }
  if (!gatewayOpenOnWeekend(gateway, now, ctx.platform_open_on_weekend)) {
    return { enabled: false, reason: "weekend" };
  }
  return { enabled: true, reason: "ok" };
}

/* ==================== 11. book routing (A/B/C), coverage, LP reports ==================== */

var BOOKS = ["a", "b", "c"];
var BOOK_LABELS = {
  a: "A-Book — flow hedged externally with a liquidity provider",
  b: "B-Book — flow kept on the platform's own book",
  c: "C-Book — client flow crossed internally, only the residual routed out"
};

/* A book routing rule applies to symbols matching symbol_mask and client
 * groups matching group_mask (mask language, topmost-match-wins). book is
 * "a" | "b" | "c". coverage_pct + min_coverage_volume implement the
 * B-Book-first coverage flow: the client volume stays in B-Book up to
 * min_coverage_volume; coverage_pct of the REMAINDER is then routed to the
 * A-Book LP. lp_id names the LP the A-Book leg goes to (gateway id); null
 * = the gateway priority scheme decides. */
function defaultBookRule(symbolMask) {
  return {
    symbol_mask: str(symbolMask, ""),
    group_mask: "*",
    book: "b",
    coverage_pct: 0,
    min_coverage_volume: 0,
    lp_id: null
  };
}

function defaultBookConfig() {
  return { rules: [] };
}

function matchBookRule(rule, symbol, group) {
  if (!rule || typeof rule !== "object") return false;
  if (!matchMask(str(symbol, ""), str(rule.symbol_mask, ""))) return false;
  return matchMask(str(group, ""), str(rule.group_mask, "*"));
}

/* Topmost-match-wins: the first rule matching symbol+group applies. When
 * no rule matches, the platform default applies (B-Book, no coverage). */
function selectBookRule(config, symbol, group) {
  var rules = (config && config.rules) || [];
  for (var i = 0; i < rules.length; i++) {
    if (matchBookRule(rules[i], symbol, group)) return rules[i];
  }
  return defaultBookRule("*");
}

function validateBookConfig(config) {
  var errs = [];
  if (!config || typeof config !== "object") return ["config must be an object"];
  (config.rules || []).forEach(function (r, i) {
    var tag = "rules[" + i + "]";
    if (!r || typeof r !== "object") { errs.push(tag + ": must be an object"); return; }
    if (typeof r.symbol_mask !== "string" || !trim(r.symbol_mask)) {
      errs.push(tag + ": symbol_mask is required");
    }
    if (BOOKS.indexOf(r.book) < 0) {
      errs.push(tag + ": book must be one of: " + BOOKS.join("|"));
    }
    var pct = num(r.coverage_pct, NaN);
    if (!isFinite(pct) || pct < 0 || pct > 100) {
      errs.push(tag + ": coverage_pct must be between 0 and 100");
    }
    var min = num(r.min_coverage_volume, NaN);
    if (!isFinite(min) || min < 0) {
      errs.push(tag + ": min_coverage_volume must be a non-negative number");
    }
  });
  return errs;
}

function roundLots(v) {
  return Math.round(num(v, 0) * 1e8) / 1e8;
}

function clampPct(p) {
  var v = num(p, 0);
  return Math.min(100, Math.max(0, v));
}

/* Split a client trade volume across the books per a routing rule.
 * Returns { a, b, c } volumes (lots, rounded to 8 decimals).
 *   "a" book: everything hedged out (A-Book).
 *   "c" book: everything marked for the internal crossing book; the actual
 *     crossing is computed by crossBookFlows(); only its residual is
 *     routed to the A-Book LP afterwards.
 *   "b" book: B-Book-first with proportional reduction —
 *     volume up to min_coverage_volume stays in B-Book; of the remainder,
 *     coverage_pct goes to the A-Book LP and the rest stays in B-Book.
 * Worked example (platform's own numbers): 30 lots, min coverage volume
 * 6 lots, coverage 50%  →  24 lots remain above the minimum; 50% of 24 =
 * 12 lots to A-Book, 18 lots stay in B-Book. */
function allocateBookVolume(volume, rule) {
  var v = num(volume, NaN);
  if (!isFinite(v) || v < 0) return null;
  rule = rule || defaultBookRule("*");
  var book = BOOKS.indexOf(rule.book) >= 0 ? rule.book : "b";
  if (book === "a") return { a: roundLots(v), b: 0, c: 0 };
  if (book === "c") return { a: 0, b: 0, c: roundLots(v) };
  var min = Math.max(0, num(rule.min_coverage_volume, 0));
  if (v <= min) return { a: 0, b: roundLots(v), c: 0 };
  var hedged = roundLots((v - min) * clampPct(rule.coverage_pct) / 100);
  return { a: hedged, b: roundLots(v - hedged), c: 0 };
}

/* C-Book internal crossing: client long and short flow on the same book
 * offset each other; only the net residual needs to go anywhere.
 * flows: [{ client_id, side: "buy"|"sell", volume }].
 * Returns totals plus the crossed amount and the residual side/volume. */
function crossBookFlows(flows) {
  var buy = 0, sell = 0;
  (flows || []).forEach(function (f) {
    if (!f || !isFinite(+f.volume) || +f.volume < 0) return;
    if (f.side === "buy") buy += +f.volume;
    else if (f.side === "sell") sell += +f.volume;
  });
  var crossed = Math.min(buy, sell);
  var residual = roundLots(buy - sell);
  return {
    buy_volume: roundLots(buy),
    sell_volume: roundLots(sell),
    crossed_volume: roundLots(crossed),
    residual_side: residual > 0 ? "buy" : residual < 0 ? "sell" : null,
    residual_volume: Math.abs(residual)
  };
}

/* ---- basis-symbol aggregation ----
 * Symbols that share a basis symbol (e.g. contract variants of one
 * underlying) can be aggregated into a single exposure for LP routing
 * decisions: the hedge decision is taken on the aggregate, not per symbol.
 * symbolSpecs: [{ symbol, basis }] — basis falls back to the symbol itself
 * when absent, so unmapped symbols stay singletons. */
function groupByBasis(symbolSpecs) {
  var groups = {};
  (symbolSpecs || []).forEach(function (s) {
    if (!s || typeof s.symbol !== "string") return;
    var basis = (typeof s.basis === "string" && trim(s.basis)) ? s.basis : s.symbol;
    (groups[basis] = groups[basis] || []).push(s.symbol);
  });
  Object.keys(groups).forEach(function (k) { groups[k].sort(); });
  return groups;
}

/* Sum per-symbol volumes into per-basis totals. volumeBySymbol:
 * { SYMBOL: volume }. Returns { basis: totalVolume }. */
function aggregateBasisVolume(symbolSpecs, volumeBySymbol) {
  var groups = groupByBasis(symbolSpecs);
  var out = {};
  Object.keys(groups).forEach(function (basis) {
    var total = 0;
    groups[basis].forEach(function (sym) {
      var v = num(volumeBySymbol && volumeBySymbol[sym], NaN);
      if (isFinite(v) && v > 0) total += v;
    });
    out[basis] = roundLots(total);
  });
  return out;
}

/* ---- LP reports (pure computation over deal records) ----
 * Deal record shape: { lp_id, symbol, side: "buy"|"sell", volume,
 * expected_price, executed_price }.
 * turnover: total volume per LP; imbalance: long vs short flow per LP
 * (imbalance_ratio 0 = perfectly balanced, 1 = entirely one-sided);
 * slippage: signed (executed - expected) price deltas per LP —
 * negative means the fill was better than expected. */

/* Returns [{ lp_id, turnover_volume, deal_count }] sorted by turnover desc. */
function lpTurnover(deals) {
  var per = {};
  (deals || []).forEach(function (d) {
    if (!d || typeof d.lp_id !== "string" || !isFinite(+d.volume) || +d.volume <= 0) return;
    var agg = per[d.lp_id] || { lp_id: d.lp_id, turnover_volume: 0, deal_count: 0 };
    agg.turnover_volume += +d.volume;
    agg.deal_count += 1;
    per[d.lp_id] = agg;
  });
  return Object.keys(per).map(function (k) {
    return { lp_id: per[k].lp_id, turnover_volume: roundLots(per[k].turnover_volume),
             deal_count: per[k].deal_count };
  }).sort(function (a, b) { return b.turnover_volume - a.turnover_volume; });
}

/* Returns [{ lp_id, buy_volume, sell_volume, net_volume, total_volume,
 * imbalance_ratio }] one entry per LP. */
function lpImbalance(deals) {
  var per = {};
  (deals || []).forEach(function (d) {
    if (!d || typeof d.lp_id !== "string" || !isFinite(+d.volume) || +d.volume <= 0) return;
    var agg = per[d.lp_id] || { lp_id: d.lp_id, buy_volume: 0, sell_volume: 0 };
    if (d.side === "buy") agg.buy_volume += +d.volume;
    else if (d.side === "sell") agg.sell_volume += +d.volume;
    per[d.lp_id] = agg;
  });
  return Object.keys(per).sort().map(function (k) {
    var agg = per[k];
    var total = agg.buy_volume + agg.sell_volume;
    var net = agg.buy_volume - agg.sell_volume;
    return {
      lp_id: k,
      buy_volume: roundLots(agg.buy_volume),
      sell_volume: roundLots(agg.sell_volume),
      net_volume: roundLots(net),
      total_volume: roundLots(total),
      imbalance_ratio: total > 0 ? roundLots(Math.abs(net) / total) : 0
    };
  });
}

/* Returns [{ lp_id, count, mean_slippage, min_slippage, max_slippage }]
 * over the signed (executed - expected) price deltas. */
function lpSlippage(deals) {
  var per = {};
  (deals || []).forEach(function (d) {
    if (!d || typeof d.lp_id !== "string") return;
    var exp = num(d.expected_price, NaN), exe = num(d.executed_price, NaN);
    if (!isFinite(exp) || !isFinite(exe)) return;
    var agg = per[d.lp_id] || { lp_id: d.lp_id, count: 0, sum: 0, min: Infinity, max: -Infinity };
    var delta = exe - exp;
    agg.count += 1;
    agg.sum += delta;
    if (delta < agg.min) agg.min = delta;
    if (delta > agg.max) agg.max = delta;
    per[d.lp_id] = agg;
  });
  return Object.keys(per).sort().map(function (k) {
    var agg = per[k];
    return {
      lp_id: k,
      count: agg.count,
      mean_slippage: roundLots(agg.sum / agg.count),
      min_slippage: roundLots(agg.min),
      max_slippage: roundLots(agg.max)
    };
  });
}

/* ---- toxic-flow flags ----
 * Flags accounts/symbols whose win-rate + volume pattern looks predatory
 * against the platform (configurable thresholds; the platform carries no
 * pre-judged "toxic" list). accountStats:
 * [{ account_id, symbol, trades, wins, volume }].
 * Returns only the flagged entries:
 * [{ account_id, symbol, trades, win_rate, volume, thresholds }] where
 * thresholds echoes the config that produced the flag. */
function defaultToxicConfig() {
  return {
    min_trades: 20,      /* below this sample size, never flag */
    min_win_rate: 0.65,  /* 0..1 */
    min_volume_lots: 10  /* minimum flow volume before flagging */
  };
}

function validateToxicConfig(cfg) {
  var errs = [];
  if (!cfg || typeof cfg !== "object") return ["config must be an object"];
  var t = num(cfg.min_trades, NaN);
  if (!isFinite(t) || t < 1 || Math.floor(t) !== t) {
    errs.push("min_trades must be a positive integer");
  }
  var w = num(cfg.min_win_rate, NaN);
  if (!isFinite(w) || w < 0 || w > 1) errs.push("min_win_rate must be between 0 and 1");
  var v = num(cfg.min_volume_lots, NaN);
  if (!isFinite(v) || v < 0) errs.push("min_volume_lots must be a non-negative number");
  return errs;
}

function flagToxicFlows(accountStats, cfg) {
  cfg = cfg || defaultToxicConfig();
  var minTrades = Math.max(1, num(cfg.min_trades, 1) | 0);
  var minWinRate = clampPct(num(cfg.min_win_rate, 1) * 100) / 100;
  var minVol = Math.max(0, num(cfg.min_volume_lots, 0));
  var flagged = [];
  (accountStats || []).forEach(function (a) {
    if (!a || a.account_id == null) return;
    var trades = num(a.trades, 0), wins = num(a.wins, 0), vol = num(a.volume, 0);
    if (!isFinite(trades) || trades < minTrades) return;
    var winRate = trades > 0 ? wins / trades : 0;
    if (!isFinite(vol) || vol < minVol) return;
    if (winRate < minWinRate) return;
    flagged.push({
      account_id: a.account_id,
      symbol: str(a.symbol, ""),
      trades: trades | 0,
      win_rate: roundLots(winRate),
      volume: roundLots(vol),
      thresholds: { min_trades: minTrades, min_win_rate: minWinRate, min_volume_lots: minVol }
    });
  });
  return flagged;
}

/* ============================== exports ============================== */

var OrbitLiquidity = {
  /* utilities */
  matchMask: matchMask,
  pointValue: pointValue,
  /* 1. price aggregator */
  AGGREGATOR_SOURCE_TYPES: AGGREGATOR_SOURCE_TYPES,
  DEPTH_DEFAULT_LEVELS: DEPTH_DEFAULT_LEVELS,
  defaultAggregatorConfig: defaultAggregatorConfig,
  defaultAggregatorSource: defaultAggregatorSource,
  aggregateBook: aggregateBook,
  /* 2. cluster aggregator */
  defaultClusterConfig: defaultClusterConfig,
  clusterBook: clusterBook,
  /* 3. matching statistics */
  newStats: newStats,
  bumpStats: bumpStats,
  /* 4. routing rules */
  ROUTE_REQUEST_TYPES: ROUTE_REQUEST_TYPES,
  ROUTE_ORDER_TYPES: ROUTE_ORDER_TYPES,
  ROUTE_ACTIONS: ROUTE_ACTIONS,
  CONDITION_OPS: CONDITION_OPS,
  defaultRoutingConfig: defaultRoutingConfig,
  matchRule: matchRule,
  routeRequest: routeRequest,
  resolveDealer: resolveDealer,
  nextDealer: nextDealer,
  validateRoutingConfig: validateRoutingConfig,
  /* 5. translation */
  defaultTranslationConfig: defaultTranslationConfig,
  defaultTranslationEntry: defaultTranslationEntry,
  translateSymbol: translateSymbol,
  applyShift: applyShift,
  translateBook: translateBook,
  /* 6. gateway config */
  GATEWAY_MODES: GATEWAY_MODES,
  GATEWAY_KINDS: GATEWAY_KINDS,
  defaultGatewayConfig: defaultGatewayConfig,
  validateGatewayConfig: validateGatewayConfig,
  rekeyGatewayId: rekeyGatewayId,
  /* 7. remote service */
  SERVICE_ACTIONS: SERVICE_ACTIONS,
  SERVICE_UPGRADE_NOTE: SERVICE_UPGRADE_NOTE,
  defaultServiceConfig: defaultServiceConfig,
  validateServiceConfig: validateServiceConfig,
  describeServiceAction: describeServiceAction,
  /* 8. status / journal / profiling */
  defaultGatewayStatus: defaultGatewayStatus,
  defaultSpeedProfile: defaultSpeedProfile,
  profileTotal: profileTotal,
  validateSpeedProfile: validateSpeedProfile,
  JOURNAL_LEVELS: JOURNAL_LEVELS,
  journalEntry: journalEntry,
  /* 9. positions request */
  positionsRequest: positionsRequest,
  summarizeGatewayPositions: summarizeGatewayPositions,
  /* 10. weekend */
  defaultWeekendConfig: defaultWeekendConfig,
  parseCalendarOverrides: parseCalendarOverrides,
  isWeekend: isWeekend,
  gatewayOpenOnWeekend: gatewayOpenOnWeekend,
  gatewayEffectiveState: gatewayEffectiveState,
  /* 11. book routing / coverage / basis aggregation / LP reports / toxic flow */
  BOOKS: BOOKS,
  BOOK_LABELS: BOOK_LABELS,
  defaultBookConfig: defaultBookConfig,
  defaultBookRule: defaultBookRule,
  matchBookRule: matchBookRule,
  selectBookRule: selectBookRule,
  validateBookConfig: validateBookConfig,
  allocateBookVolume: allocateBookVolume,
  crossBookFlows: crossBookFlows,
  groupByBasis: groupByBasis,
  aggregateBasisVolume: aggregateBasisVolume,
  lpTurnover: lpTurnover,
  lpImbalance: lpImbalance,
  lpSlippage: lpSlippage,
  defaultToxicConfig: defaultToxicConfig,
  validateToxicConfig: validateToxicConfig,
  flagToxicFlows: flagToxicFlows
};
if (typeof module !== "undefined" && module.exports) { module.exports = OrbitLiquidity; }
else { root.OrbitLiquidity = OrbitLiquidity; }
})(typeof globalThis !== "undefined" ? globalThis : this);
