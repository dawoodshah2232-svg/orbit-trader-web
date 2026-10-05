/* shared/groups.js — OrbitTrader account-group model.
 *
 * Accounts are joined into groups and ALL trade conditions are set per group.
 * Pure functions, no globals, no DOM: runs in the browser and in node
 * (guarded export at the bottom, same pattern as shared/money-math.js).
 *
 * Model:
 *   - A group's TYPE is derived from its name/path by case-sensitive
 *     substring matching, first match wins: "demo" -> demo, "manager" ->
 *     manager, "contest" -> contest, "preliminary" -> preliminary,
 *     "coverage" -> coverage, anything else -> real.
 *   - "preliminary" groups hold account-open requests: zero balance, no
 *     trading. Trading is disabled through the group settings (all
 *     order/position limits are 0); tradingAllowed() is the enforcement point.
 *   - Every setting default is permissive (null = unlimited where the model
 *     implies no limit). These are OrbitTrader defaults, not any broker's.
 *   - Symbol conditions are overlaid per group with masks + overrides:
 *     matchMask() supports comma lists, "*" wildcards and "!" negation;
 *     applySymbolOverrides() treats the string "Default" as "inherit from
 *     the base spec"; topDownApply() applies an ordered rule list so later
 *     rules win per symbol.
 */
(function (root) {
"use strict";

var GROUP_TYPES = ["demo", "manager", "contest", "preliminary", "coverage", "real"];

/* Order matters: first substring match wins (case-sensitive). */
var TYPE_MATCH_ORDER = [
  ["demo", "demo"],
  ["manager", "manager"],
  ["contest", "contest"],
  ["preliminary", "preliminary"],
  ["coverage", "coverage"]
];

var TRADE_MODES = ["full", "long_only", "short_only", "close_only", "disabled"];

var OVERRIDE_FIELDS = [
  "spread_difference", "spread_markup",
  "volume_min", "volume_step", "volume_max", "volume_limit",
  "trade_mode", "swap_long", "swap_short", "margin_rate_multiplier"
];

/* ---- 1. group type derivation ---- */
function deriveGroupType(name) {
  if (typeof name !== "string") return "real";
  for (var i = 0; i < TYPE_MATCH_ORDER.length; i++) {
    if (name.indexOf(TYPE_MATCH_ORDER[i][0]) !== -1) return TYPE_MATCH_ORDER[i][1];
  }
  return "real";
}

/* ---- 2. default group settings ---- */
function baseSettings() {
  return {
    max_symbols: null,            /* null = unlimited */
    max_positions_netting: null,  /* null = unlimited (netting accounts) */
    max_positions_hedging: null,  /* null = unlimited (hedging accounts) */
    max_orders: null,             /* null = unlimited pending orders */
    history_depth_days: null,     /* null = keep full history */
    annual_interest_free_margin_pct: 0,
    default_leverage: 100,        /* 100 = 1:100, platform standard default */
    trade_signals: true,
    fund_transfer: { allow_deposit: true, allow_withdraw: true, allow_internal: true },
    swaps_enabled: true,
    trailing_stops: true,
    ea_trading: true,
    fifo_close_rule: false,       /* false = positions may close in any order */
    prohibit_hedge: false,        /* false = opposite-direction positions allowed */
    inactivity_days_demo: null    /* null = demos never expire on inactivity */
  };
}

function defaultGroupSettings(type) {
  var s = baseSettings();
  if (type === "preliminary") {
    /* Holding state for account-open requests: zero balance, no trading. */
    s.max_positions_netting = 0;
    s.max_positions_hedging = 0;
    s.max_orders = 0;
    s.trade_signals = false;
    s.swaps_enabled = false;
    s.trailing_stops = false;
    s.ea_trading = false;
    s.fund_transfer = { allow_deposit: true, allow_withdraw: false, allow_internal: false };
  } else if (type === "contest") {
    /* Contest balances are seeded by the organizer: no signal copying and
       no withdrawals/internal transfers while the contest runs. */
    s.trade_signals = false;
    s.fund_transfer = { allow_deposit: true, allow_withdraw: false, allow_internal: false };
  }
  return s;
}

/* Enforcement point for "no trading": a group whose order limit is 0
 * (the preliminary default) may not open new trades. */
function tradingAllowed(settings) {
  if (!settings || typeof settings !== "object") return false;
  return settings.max_orders !== 0;
}

/* ---- 3. settings validation -> array of error strings (empty = valid) ---- */
function validateGroupSettings(s) {
  var errs = [];
  function err(m) { errs.push(m); }
  if (!s || typeof s !== "object" || Array.isArray(s)) return ["settings must be an object"];

  ["max_symbols", "max_positions_netting", "max_positions_hedging",
   "max_orders", "history_depth_days", "inactivity_days_demo"].forEach(function (f) {
    var v = s[f];
    if (v === null || v === undefined) return;
    if (typeof v !== "number" || !isFinite(v) || Math.floor(v) !== v || v < 0)
      err(f + " must be null or an integer >= 0");
  });

  var pct = s.annual_interest_free_margin_pct;
  if (typeof pct !== "number" || !isFinite(pct) || pct < 0)
    err("annual_interest_free_margin_pct must be a number >= 0");
  var lev = s.default_leverage;
  if (typeof lev !== "number" || !isFinite(lev) || lev <= 0)
    err("default_leverage must be a number > 0");

  ["trade_signals", "swaps_enabled", "trailing_stops",
   "ea_trading", "fifo_close_rule", "prohibit_hedge"].forEach(function (f) {
    if (typeof s[f] !== "boolean") err(f + " must be a boolean");
  });

  var ft = s.fund_transfer;
  if (!ft || typeof ft !== "object" || Array.isArray(ft)) {
    err("fund_transfer must be an object");
  } else {
    ["allow_deposit", "allow_withdraw", "allow_internal"].forEach(function (f) {
      if (typeof ft[f] !== "boolean") err("fund_transfer." + f + " must be a boolean");
    });
  }
  return errs;
}

/* ---- 4. symbol masks ----
 * Comma-separated tokens. "*" matches any character sequence (so "EUR*"
 * is a prefix wildcard and "*USD" a suffix wildcard). A token starting
 * with "!" negates: the symbol must NOT match it. A mask matches when at
 * least one positive token matches (or there are no positive tokens) and
 * no negation token matches. Matching is case-sensitive. */
function tokenPattern(token) {
  var esc = token.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + esc + "$");
}
function trim(t) { return t.replace(/^\s+|\s+$/g, ""); }

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

/* ---- 5. per-group symbol overrides ----
 * The string "Default" (or a missing key) means "inherit the base value".
 * spread_difference is RELATIVE: points added to the base spread.
 * trade_mode must be one of TRADE_MODES. Unknown override keys are ignored.
 * Returns a NEW object; baseSpec and override are never mutated. */
function applySymbolOverrides(baseSpec, override) {
  var base = (baseSpec && typeof baseSpec === "object") ? baseSpec : {};
  var out = {};
  for (var k in base) {
    if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
  }
  if (!override || typeof override !== "object") return out;

  OVERRIDE_FIELDS.forEach(function (f) {
    var v = override[f];
    if (v === undefined || v === "Default") return; /* inherit */
    if (f === "spread_difference") {
      if (typeof v !== "number" || !isFinite(v))
        throw new Error("groups: spread_difference must be a finite number");
      var cur = isFinite(+base.spread) ? +base.spread : 0;
      out.spread = cur + v;
      return;
    }
    if (f === "trade_mode") {
      if (TRADE_MODES.indexOf(v) === -1)
        throw new Error("groups: invalid trade_mode override: " + v);
      out.trade_mode = v;
      return;
    }
    out[f] = v;
  });
  return out;
}

/* ---- 6. top-down rule application ----
 * symbols: array of base spec objects (name taken from `symbol`, falling
 * back to `name`). rules: array of {mask, override}, applied in order so
 * later rules win per symbol. Returns a new array of new objects. */
function symbolName(spec) {
  if (spec && typeof spec === "object") {
    if (typeof spec.symbol === "string") return spec.symbol;
    if (typeof spec.name === "string") return spec.name;
  }
  return "";
}

function topDownApply(symbols, rules) {
  var list = Array.isArray(symbols) ? symbols : [];
  var rs = Array.isArray(rules) ? rules : [];
  return list.map(function (spec) {
    var cur = applySymbolOverrides(spec, null);
    var nm = symbolName(spec);
    rs.forEach(function (rule) {
      if (!rule || typeof rule !== "object") return;
      if (matchMask(nm, rule.mask)) cur = applySymbolOverrides(cur, rule.override);
    });
    return cur;
  });
}

var GROUPS = {
  GROUP_TYPES: GROUP_TYPES,
  TRADE_MODES: TRADE_MODES,
  OVERRIDE_FIELDS: OVERRIDE_FIELDS,
  deriveGroupType: deriveGroupType,
  defaultGroupSettings: defaultGroupSettings,
  tradingAllowed: tradingAllowed,
  validateGroupSettings: validateGroupSettings,
  matchMask: matchMask,
  applySymbolOverrides: applySymbolOverrides,
  topDownApply: topDownApply
};
if (typeof module !== "undefined" && module.exports) { module.exports = GROUPS; }
else { root.OrbitGroups = GROUPS; }
})(typeof globalThis !== "undefined" ? globalThis : this);
