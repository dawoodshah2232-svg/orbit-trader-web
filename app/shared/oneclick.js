/* OrbitTrader — one-click trading: enable gate, trade defaults, order intents.
 *
 * Behavioral reimplementation of the "one-click trading" terminal concept:
 * the terminal can show a buy/sell panel per symbol that fires an order
 * with a single click, using per-account trade defaults, without an order
 * confirmation dialog. Because that convenience is also the risk, the
 * platform requires two independent conditions before a click can produce
 * anything executable:
 *
 *   1. The account's settings flag is ON (per-account, off by default).
 *   2. The account holder accepted the one-click terms (recorded with a
 *      timestamp AND the terms version; re-acceptance is required when the
 *      terms version changes).
 *
 * This module never executes anything. It builds an order INTENT object
 * {symbol, side, volume, deviation, sl, tp, source:'oneclick', ...} that the
 * execution engine consumes and validates again server-side
 * (see server/lib/oneclick.php). Intent building rejects with a stable
 * reason code whenever the gate fails or the order parameters are invalid.
 *
 * Conventions used here:
 *  - deviation is max slippage in points (non-negative integer).
 *  - defaultSL / defaultTP are protective offsets in points from the entry
 *    price; 0 (or null) means "no protective level attached".
 *  - volume is validated against the symbol spec's volume_min / volume_max /
 *    volume_step read from shared/symbol-specs.json (via shared/specs-loader.js).
 *  - trade_mode comes from the symbol schema (SYMBOL_SCHEMA_V2): one of
 *    full | long_only | short_only | close_only | disabled. It is absent
 *    from some embedded spec rows, so it defaults to "full".
 *  - trade_status defaults to "enabled"; "disabled" rejects all intents.
 *
 * Pure functions, no globals, no DOM: runs in the browser and in node
 * (guarded export at the bottom; browser global is OrbitOneClick).
 */
(function (root) {
"use strict";

/* ============================================================
 * 1. Constants
 * ============================================================ */

/* Intent source tag stamped on every intent this module builds. */
var SOURCE = "oneclick";

/* Terms version the current gate check expects. Bumping this forces
 * re-acceptance on every account (terms_stale reason until re-accepted). */
var CURRENT_TERMS_VERSION = "1";

/* Symbol trade modes per SYMBOL_SCHEMA_V2. */
var TRADE_MODES = ["full", "long_only", "short_only", "close_only", "disabled"];

/* Sides. */
var SIDES = ["buy", "sell"];

/* Stable reason codes returned on rejection. */
var CODES = {
  OK: "ok",
  GATE_DISABLED: "gate_disabled",         /* one-click flag is off */
  TERMS_NOT_ACCEPTED: "terms_not_accepted", /* no acceptance timestamp/version */
  TERMS_STALE: "terms_stale",             /* accepted version != current version */
  SYMBOL_UNKNOWN: "symbol_unknown",       /* no spec found for the symbol */
  SYMBOL_DISABLED: "symbol_disabled",     /* trade_status=disabled or mode=disabled */
  SYMBOL_CLOSE_ONLY: "symbol_close_only", /* mode=close_only: no new positions */
  SIDE_BLOCKED: "side_blocked",           /* long_only/short_only blocks this side */
  BAD_VOLUME: "bad_volume",               /* not a finite positive number */
  VOLUME_OUT_OF_RANGE: "volume_out_of_range", /* outside volume_min..volume_max */
  VOLUME_STEP: "volume_step",             /* not aligned to volume_step */
  BAD_DEVIATION: "bad_deviation",         /* negative or non-integer */
  BAD_SLTP: "bad_sltp",                   /* negative protective offset */
  BAD_SIDE: "bad_side",                   /* side is not buy/sell */
  BAD_QUOTE: "bad_quote",                 /* bid/ask missing or non-positive */
  BAD_SYMBOL: "bad_symbol"                /* symbol missing/empty */
};

/* Tolerance for volume-step alignment (float arithmetic). */
var STEP_EPSILON = 1e-9;

/* ============================================================
 * 2. Settings: enable flag + terms acceptance
 * ============================================================ */

/* Fresh default settings: one-click off, no terms accepted. */
function defaultSettings() {
  return { enabled: false, termsVersion: null, termsAcceptedAt: null };
}

/* Record acceptance of the one-click terms. Pure: returns a NEW settings
 * object, input untouched. `version` is the terms version being accepted
 * (defaults to CURRENT_TERMS_VERSION); `now` is the acceptance timestamp. */
function recordTermsAcceptance(settings, opts) {
  var o = opts || {};
  var next = cloneSettings(settings || defaultSettings());
  next.termsVersion = typeof o.version === "string" ? o.version : CURRENT_TERMS_VERSION;
  next.termsAcceptedAt = typeof o.now === "number" ? o.now : 0;
  return next;
}

/* Toggle the enable flag. Pure: returns a NEW settings object. */
function setEnabled(settings, enabled) {
  var next = cloneSettings(settings || defaultSettings());
  next.enabled = !!enabled;
  return next;
}

/* The gate: returns {allowed:boolean, code, message}. One-click may build
 * intents only when the flag is on AND terms were accepted at the current
 * version. The code explains the first failing condition. */
function gateStatus(settings, now) {
  var s = settings || {};
  if (!s.enabled) {
    return { allowed: false, code: CODES.GATE_DISABLED, message: "One-click trading is switched off for this account." };
  }
  if (!s.termsAcceptedAt || !s.termsVersion) {
    return { allowed: false, code: CODES.TERMS_NOT_ACCEPTED, message: "One-click terms have not been accepted." };
  }
  if (s.termsVersion !== CURRENT_TERMS_VERSION) {
    return { allowed: false, code: CODES.TERMS_STALE, message: "The one-click terms changed; they must be accepted again." };
  }
  void now;
  return { allowed: true, code: CODES.OK, message: "Gate open." };
}

/* ============================================================
 * 3. Trade defaults (per account)
 * ============================================================ */

/* Documented defaults; a real account record overrides these. */
function defaultTradeDefaults() {
  return {
    defaultSymbol: null,  /* string symbol code, or null = none chosen */
    defaultVolume: 0.01,  /* lots */
    defaultDeviation: 0,  /* points */
    defaultSL: 0,         /* points offset from entry; 0 = none */
    defaultTP: 0          /* points offset from entry; 0 = none */
  };
}

/* Validate a trade-defaults record. Returns an array of reason codes
 * (empty = valid). When a specFor lookup is provided and defaultSymbol
 * is set, the default volume is also checked against that symbol's
 * volume limits and step. */
function validateDefaults(defaults, specFor) {
  var problems = [];
  var d = defaults || {};
  if (d.defaultSymbol != null && (typeof d.defaultSymbol !== "string" || d.defaultSymbol.length === 0)) {
    problems.push(CODES.BAD_SYMBOL);
  }
  if (!isFiniteNumber(d.defaultVolume) || d.defaultVolume <= 0) {
    problems.push(CODES.BAD_VOLUME);
  }
  if (!isValidDeviation(d.defaultDeviation)) {
    problems.push(CODES.BAD_DEVIATION);
  }
  if (!isValidSlTp(d.defaultSL)) {
    problems.push(CODES.BAD_SLTP);
  }
  if (!isValidSlTp(d.defaultTP)) {
    problems.push(CODES.BAD_SLTP);
  }
  if (problems.indexOf(CODES.BAD_VOLUME) === -1 && typeof d.defaultSymbol === "string" && d.defaultSymbol.length > 0 && typeof specFor === "function") {
    var spec = specFor(d.defaultSymbol);
    if (spec) {
      var vr = volumeCheck(spec, d.defaultVolume);
      if (!vr.ok) problems.push(vr.code);
    }
  }
  return problems;
}

/* ============================================================
 * 4. Symbol checks (mode / status / volume)
 * ============================================================ */

/* Whether a side may open on a symbol spec. Returns {tradable, code}.
 * trade_mode defaults to "full"; trade_status defaults to "enabled". */
function symbolGate(spec, side) {
  if (!spec) return { tradable: false, code: CODES.SYMBOL_UNKNOWN };
  if (spec.trade_status === "disabled") {
    return { tradable: false, code: CODES.SYMBOL_DISABLED };
  }
  var mode = typeof spec.trade_mode === "string" ? spec.trade_mode : "full";
  if (TRADE_MODES.indexOf(mode) === -1) mode = "full";
  if (mode === "disabled") {
    return { tradable: false, code: CODES.SYMBOL_DISABLED };
  }
  if (mode === "close_only") {
    return { tradable: false, code: CODES.SYMBOL_CLOSE_ONLY };
  }
  if (mode === "long_only" && side === "sell") {
    return { tradable: false, code: CODES.SIDE_BLOCKED };
  }
  if (mode === "short_only" && side === "buy") {
    return { tradable: false, code: CODES.SIDE_BLOCKED };
  }
  return { tradable: true, code: CODES.OK };
}

/* Volume against a symbol spec: {ok, code}. */
function volumeCheck(spec, volume) {
  if (!isFiniteNumber(volume) || volume <= 0) {
    return { ok: false, code: CODES.BAD_VOLUME };
  }
  var min = isFiniteNumber(spec.volume_min) ? spec.volume_min : 0;
  var max = isFiniteNumber(spec.volume_max) ? spec.volume_max : Infinity;
  if (volume < min - STEP_EPSILON || volume > max + STEP_EPSILON) {
    return { ok: false, code: CODES.VOLUME_OUT_OF_RANGE };
  }
  var step = isFiniteNumber(spec.volume_step) && spec.volume_step > 0 ? spec.volume_step : 0;
  if (step > 0) {
    var units = (volume - min) / step;
    if (Math.abs(units - Math.round(units)) > STEP_EPSILON) {
      return { ok: false, code: CODES.VOLUME_STEP };
    }
  }
  return { ok: true, code: CODES.OK };
}

/* ============================================================
 * 5. Order intent builder (does NOT execute)
 * ============================================================ */

/* Build an order intent for immediate market execution.
 *
 * args: {
 *   side: "buy" | "sell",
 *   symbol: string,
 *   spec: symbol spec object (or null),
 *   settings: account one-click settings,
 *   defaults: account trade defaults,
 *   overrides: {volume, deviation, sl, tp} (each optional),
 *   now: timestamp (ms)
 * }
 *
 * Returns {ok:true, intent} or {ok:false, code, message}. The intent
 * carries source:'oneclick' and acceptedTermsAt so the execution engine
 * can audit the gate trail. Overrides replace defaults field-by-field;
 * everything is validated fresh. */
function buildIntent(args) {
  var a = args || {};
  var side = a.side;
  var symbol = a.symbol;
  var spec = a.spec || null;
  var settings = a.settings || defaultSettings();
  var defaults = a.defaults || defaultTradeDefaults();
  var o = a.overrides || {};
  var now = typeof a.now === "number" ? a.now : 0;

  if (typeof symbol !== "string" || symbol.length === 0) {
    return reject(CODES.BAD_SYMBOL, "Symbol is required.");
  }
  if (SIDES.indexOf(side) === -1) {
    return reject(CODES.BAD_SIDE, "Side must be 'buy' or 'sell'.");
  }
  var gate = gateStatus(settings, now);
  if (!gate.allowed) {
    return reject(gate.code, gate.message);
  }
  var sg = symbolGate(spec, side);
  if (!sg.tradable) {
    return reject(sg.code, symbolGateMessage(sg.code, symbol, side));
  }

  var volume = o.volume !== undefined ? o.volume : defaults.defaultVolume;
  var vr = volumeCheck(spec, volume);
  if (!vr.ok) {
    return reject(vr.code, "Volume " + String(volume) + " is invalid for " + symbol + " (" + vr.code + ").");
  }
  var deviation = o.deviation !== undefined ? o.deviation : defaults.defaultDeviation;
  if (!isValidDeviation(deviation)) {
    return reject(CODES.BAD_DEVIATION, "Deviation must be a non-negative integer number of points.");
  }
  var sl = o.sl !== undefined ? o.sl : defaults.defaultSL;
  var tp = o.tp !== undefined ? o.tp : defaults.defaultTP;
  if (!isValidSlTp(sl) || !isValidSlTp(tp)) {
    return reject(CODES.BAD_SLTP, "SL/TP offsets must be non-negative numbers of points (0 = none).");
  }

  var intent = {
    symbol: symbol,
    side: side,
    volume: volume,
    deviation: deviation,
    sl: sl == null ? 0 : sl,
    tp: tp == null ? 0 : tp,
    source: SOURCE,
    acceptedTermsAt: settings.termsAcceptedAt,
    termsVersion: settings.termsVersion,
    requestedAt: now
  };
  return { ok: true, intent: intent };
}

/* ============================================================
 * 6. One-click panel state
 * ============================================================ */

/* Panel state for one symbol. Buttons are armed only when the gate passes
 * AND the side is allowed on the symbol AND a sane quote is present.
 * Never throws: unknown symbols / bad quotes come back as disarmed with
 * reason codes, so the UI can render them instead of crashing.
 *
 * args: {symbol, bid, ask, spec, settings, defaults, now}
 * returns {symbol, bid, ask, armed, buyArmed, sellArmed, reasons[]} */
function panelState(args) {
  var a = args || {};
  var symbol = a.symbol;
  var bid = a.bid;
  var ask = a.ask;
  var spec = a.spec || null;
  var reasons = [];
  var buyArmed = false;
  var sellArmed = false;

  if (typeof symbol !== "string" || symbol.length === 0) {
    reasons.push(CODES.BAD_SYMBOL);
  } else if (!spec) {
    reasons.push(CODES.SYMBOL_UNKNOWN);
  }
  if (!isFiniteNumber(bid) || bid <= 0 || !isFiniteNumber(ask) || ask <= 0) {
    reasons.push(CODES.BAD_QUOTE);
  }

  var gate = gateStatus(a.settings || defaultSettings(), a.now);
  if (!gate.allowed) {
    reasons.push(gate.code);
  }

  if (reasons.length === 0) {
    var buy = symbolGate(spec, "buy");
    var sell = symbolGate(spec, "sell");
    if (buy.tradable) {
      buyArmed = true;
    } else {
      reasons.push(buy.code);
    }
    if (sell.tradable) {
      sellArmed = true;
    } else {
      reasons.push(sell.code);
    }
  }

  return {
    symbol: typeof symbol === "string" ? symbol : null,
    bid: isFiniteNumber(bid) ? bid : null,
    ask: isFiniteNumber(ask) ? ask : null,
    armed: buyArmed || sellArmed,
    buyArmed: buyArmed,
    sellArmed: sellArmed,
    reasons: reasons
  };
}

/* ============================================================
 * 7. Small helpers
 * ============================================================ */

function isFiniteNumber(v) {
  return typeof v === "number" && isFinite(v);
}

function isValidDeviation(v) {
  return isFiniteNumber(v) && v >= 0 && Math.floor(v) === v;
}

function isValidSlTp(v) {
  return v == null || (isFiniteNumber(v) && v >= 0);
}

function cloneSettings(s) {
  return {
    enabled: !!s.enabled,
    termsVersion: s.termsVersion == null ? null : String(s.termsVersion),
    termsAcceptedAt: s.termsAcceptedAt == null ? null : s.termsAcceptedAt
  };
}

function reject(code, message) {
  return { ok: false, code: code, message: message };
}

function symbolGateMessage(code, symbol, side) {
  switch (code) {
    case CODES.SYMBOL_DISABLED: return symbol + " is disabled for trading.";
    case CODES.SYMBOL_CLOSE_ONLY: return symbol + " is close-only; new " + side + " positions are not allowed.";
    case CODES.SIDE_BLOCKED: return side + " is not allowed on " + symbol + " (symbol trade mode).";
    case CODES.SYMBOL_UNKNOWN: return "No specification found for " + symbol + ".";
    default: return symbol + " is not tradable (" + code + ").";
  }
}

/* ============================================================
 * 8. Export
 * ============================================================ */
var OneClick = {
  SOURCE: SOURCE,
  CURRENT_TERMS_VERSION: CURRENT_TERMS_VERSION,
  CODES: CODES,
  TRADE_MODES: TRADE_MODES,
  defaultSettings: defaultSettings,
  recordTermsAcceptance: recordTermsAcceptance,
  setEnabled: setEnabled,
  gateStatus: gateStatus,
  defaultTradeDefaults: defaultTradeDefaults,
  validateDefaults: validateDefaults,
  symbolGate: symbolGate,
  volumeCheck: volumeCheck,
  buildIntent: buildIntent,
  panelState: panelState
};

if (typeof module !== "undefined" && module.exports) { module.exports = OneClick; }
else { root.OrbitOneClick = OneClick; }

})(typeof globalThis !== "undefined" ? globalThis : this);
