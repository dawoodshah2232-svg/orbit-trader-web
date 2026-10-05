/* shared/margin-engine.js — QuotesWare: margin call / stop-out engine + floating leverage (pure functions).
 *
 * Reimplements the documented risk-management concepts in OrbitTrader's own
 * architecture. Every function is pure (no I/O, no globals, no DOM), so this
 * file is safe to load in both the browser bundle and on the Node server.
 * All monetary inputs are plain numbers; broker thresholds live in the config
 * object — no invented broker values are baked in.
 *
 * Units: equity/margin/levels in account currency; margin levels in percent.
 */
(function (root) {
"use strict";

function num(v, fb) { v = +v; return isFinite(v) ? v : fb; }

var RISK_MODELS = ["retail", "with_hedging", "exchange_discount"];
var MODES = ["percent", "money"];

/* Margin level % = equity / margin * 100. Null when no margin is used
 * (level is undefined — there is nothing to compare against). */
function marginLevel(equity, margin) {
  equity = num(equity, 0);
  margin = num(margin, 0);
  if (margin <= 0) { return null; }
  return equity / margin * 100;
}

/* Exchange-mode thresholds: margin call when initial margin > equity,
 * stop-out when maintenance margin > equity. */
function exchangeCheck(equity, exch) {
  var initial = num(exch.initial_margin, 0);
  var maint = num(exch.maintenance_margin, 0);
  return {
    margin_call: initial > equity,
    stop_out: maint > equity
  };
}

/* cfg:
 *   risk_model: "retail" | "with_hedging" | "exchange_discount"
 *   mode: "percent" | "money"
 *   margin_call_level, stop_out_level: thresholds (percent or money)
 *   exchange: { initial_margin, maintenance_margin } (used when
 *             risk_model == "exchange_discount")
 *
 * Returns { margin_call, stop_out }.
 * A margin call is a NOTIFICATION only — it never blocks new positions;
 * stop-out is the forced-closure trigger. */
function checkMargin(equity, margin, cfg) {
  equity = num(equity, 0);
  cfg = cfg || {};
  if (cfg.risk_model === "exchange_discount" && cfg.exchange) {
    return exchangeCheck(equity, cfg.exchange);
  }
  var callLevel = num(cfg.margin_call_level, 0);
  var stopLevel = num(cfg.stop_out_level, 0);
  if (cfg.mode === "money") {
    return {
      margin_call: equity <= callLevel,
      stop_out: equity <= stopLevel
    };
  }
  /* default: percent mode */
  var level = marginLevel(equity, margin);
  if (level === null) { return { margin_call: false, stop_out: false }; }
  return {
    margin_call: level <= callLevel,
    stop_out: level <= stopLevel
  };
}

/* Stop-out processing plan. Emits an ordered action list; the server
 * executes it top-down, re-evaluating the margin state after each action.
 *
 * Order (documented): 1) delete pending orders, largest reserved margin
 * first; 2) close positions, largest floating loss first (if every
 * position is profitable, the least profitable one first). Symbols flagged
 * no_stopout are skipped.
 *
 * Netting real accounts may PARTIALLY close the first candidate position
 * with a "[so XX%]"-style comment, cutting just enough volume to bring the
 * margin level back to the stop-out level.
 *
 * account: { type: "real"|"demo", accounting: "netting"|"hedging",
 *            equity, margin }
 * positions: [{ id, symbol, profit, no_stopout }]
 * orders: [{ id, reserved_margin }]
 * cfg: same as checkMargin plus stop_out_fully_hedged (bool)
 *
 * Action: { action: "delete_order"|"close_position"|"partial_close",
 *           id, reason, fraction?, comment? } */
function stopOutPlan(account, positions, orders, cfg) {
  account = account || {};
  cfg = cfg || {};
  positions = positions || [];
  orders = orders || [];
  var plan = [];

  /* 1) Delete pending orders, largest reserved margin first. */
  var sortedOrders = orders.slice().sort(function (a, b) {
    return num(b.reserved_margin, 0) - num(a.reserved_margin, 0);
  });
  var released = 0;
  sortedOrders.forEach(function (o) {
    released += num(o.reserved_margin, 0);
    plan.push({ action: "delete_order", id: o.id, reason: "stop_out_delete_order" });
  });

  /* 2) Positions: largest loss first; skip no_stopout symbols. */
  var eligible = positions.filter(function (p) { return !p.no_stopout; });
  eligible.sort(function (a, b) {
    return num(a.profit, 0) - num(b.profit, 0);
  });
  if (!eligible.length) { return plan; }

  var equity = num(account.equity, 0);
  var marginAfterOrders = num(account.margin, 0) - released;
  var stopLevel = num(cfg.stop_out_level, 0);
  var isNetting = account.accounting === "netting";
  var isReal = account.type === "real";

  /* Netting real account: partially close just enough of the worst
   * position to restore the stop-out level (percent mode). */
  if (isNetting && isReal && cfg.mode !== "money" && stopLevel > 0 &&
      marginAfterOrders > 0 && eligible.length) {
    var targetMargin = equity * 100 / stopLevel;
    var fraction = 1 - targetMargin / marginAfterOrders;
    if (fraction > 0 && fraction < 1) {
      var pct = Math.round(fraction * 100);
      plan.push({
        action: "partial_close",
        id: eligible[0].id,
        fraction: fraction,
        comment: "[so " + pct + "%]",
        reason: "stop_out_partial_close"
      });
      return plan;
    }
  }

  eligible.forEach(function (p) {
    plan.push({ action: "close_position", id: p.id, reason: "stop_out_close_position" });
  });
  return plan;
}

/* Floating leverage rules engine.
 * rules: [{ conditions: { min_balance, max_balance, min_equity, max_equity,
 *                         min_margin, max_margin, min_volume, max_volume,
 *                         symbols: [], groups: [], order_types: [],
 *                         weekdays: [], countries: [], deposit_currencies: [] },
 *           leverage, auto }]
 * ctx: { balance, equity, margin, volume, symbol, group, order_type,
 *        weekday (0-6 or name), country, deposit_currency, current_leverage }
 *
 * First matching rule wins; no match falls back to ctx.current_leverage.
 * `auto` (automatic vs manual switching, with/without closing positions)
 * is informational — the server layer enforces the switching behaviour. */
function ruleMatches(conditions, ctx) {
  conditions = conditions || {};
  var c = conditions;

  function inRange(v, lo, hi) {
    v = num(v, 0);
    if (lo != null && v < num(lo, -Infinity)) { return false; }
    if (hi != null && v > num(hi, Infinity)) { return false; }
    return true;
  }
  if (!inRange(ctx.balance, c.min_balance, c.max_balance)) { return false; }
  if (!inRange(ctx.equity, c.min_equity, c.max_equity)) { return false; }
  if (!inRange(ctx.margin, c.min_margin, c.max_margin)) { return false; }
  if (!inRange(ctx.volume, c.min_volume, c.max_volume)) { return false; }

  function inList(list, value) {
    if (!list || !list.length) { return true; }
    return list.indexOf(value) !== -1;
  }
  if (!inList(c.symbols, ctx.symbol)) { return false; }
  if (!inList(c.groups, ctx.group)) { return false; }
  if (!inList(c.order_types, ctx.order_type)) { return false; }
  if (!inList(c.countries, ctx.country)) { return false; }
  if (!inList(c.deposit_currencies, ctx.deposit_currency)) { return false; }

  if (c.weekdays && c.weekdays.length) {
    var wd = ctx.weekday;
    var norm = typeof wd === "string" ? wd.toLowerCase().slice(0, 3) : num(wd, -1);
    var hit = c.weekdays.some(function (d) {
      if (typeof d === "number") { return d === norm; }
      return typeof d === "string" && d.toLowerCase().slice(0, 3) === String(norm).slice(0, 3);
    });
    if (!hit) { return false; }
  }
  return true;
}

function applyFloatingLeverage(rules, ctx) {
  ctx = ctx || {};
  rules = rules || [];
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (rule && ruleMatches(rule.conditions, ctx) && num(rule.leverage, 0) > 0) {
      return num(rule.leverage, 0);
    }
  }
  return num(ctx.current_leverage, 1);
}

/* Validate a margin config. Returns an array of error strings (empty = ok).
 * Documents the supported shape; does not invent broker values. */
function validateMarginConfig(cfg) {
  var errors = [];
  if (!cfg || typeof cfg !== "object") { return ["config must be an object"]; }

  if (RISK_MODELS.indexOf(cfg.risk_model) === -1) {
    errors.push("risk_model must be one of: " + RISK_MODELS.join(", "));
  }
  if (MODES.indexOf(cfg.mode) === -1) {
    errors.push("mode must be one of: " + MODES.join(", "));
  }
  var callLevel = num(cfg.margin_call_level, NaN);
  var stopLevel = num(cfg.stop_out_level, NaN);
  if (!(callLevel > 0)) { errors.push("margin_call_level must be a positive number"); }
  if (!(stopLevel > 0)) { errors.push("stop_out_level must be a positive number"); }
  if (callLevel > 0 && stopLevel > 0 && !(callLevel > stopLevel)) {
    errors.push("margin_call_level must be above stop_out_level (call fires first)");
  }
  if (cfg.risk_model === "exchange_discount") {
    var exch = cfg.exchange || {};
    var initial = num(exch.initial_margin, NaN);
    var maint = num(exch.maintenance_margin, NaN);
    if (!(initial >= 0)) { errors.push("exchange.initial_margin must be a non-negative number"); }
    if (!(maint >= 0)) { errors.push("exchange.maintenance_margin must be a non-negative number"); }
    if (initial >= 0 && maint >= 0 && initial < maint) {
      errors.push("exchange.initial_margin must be >= exchange.maintenance_margin");
    }
  }
  ["stop_out_fully_hedged", "negative_balance_compensation", "withdraw_credit_after"].forEach(function (k) {
    if (cfg[k] != null && typeof cfg[k] !== "boolean") {
      errors.push(k + " must be a boolean");
    }
  });
  return errors;
}

/* ---------- Account-level margin aggregation ----------
 * These functions sit on top of the per-position formulas in
 * shared/money-math.js and implement the accounting-model aggregation
 * rules (netting, hedging, exchange discount-rate model). */

/* Aggregate positions per symbol by direction.
 * positions: [{ symbol, direction: "buy"|"sell" (anything else = buy),
 *               volume }]
 * Returns { symbol: { buy: <lots>, sell: <lots> } }. */
function aggregateSameDirection(positions) {
  positions = positions || [];
  var out = {};
  positions.forEach(function (p) {
    p = p || {};
    var sym = String(p.symbol || "");
    if (!sym) { return; }
    if (!out[sym]) { out[sym] = { buy: 0, sell: 0 }; }
    var vol = num(p.volume, 0);
    if (p.direction === "sell") { out[sym].sell += vol; }
    else { out[sym].buy += vol; }
  });
  return out;
}

/* Netting margin, spread-aware stages.
 * On a netting account the offsetting (hedged) volume and the remaining net
 * volume may be margined at different stages: the covered part at the
 * spread rate, the net remainder at the normal rate.
 *   perLotMargin: full margin for 1.0 lot (account currency)
 *   spreadRate: fraction of full margin charged on covered volume
 *               (1 = no discount, 0 = covered volume is free)
 * margin = (netVol + coveredVol x spreadRate) x perLotMargin
 * where coveredVol = 2 x min(buy, sell), netVol = |buy - sell|. */
function nettingMarginStages(buyVol, sellVol, perLotMargin, spreadRate) {
  var b = num(buyVol, 0);
  var s = num(sellVol, 0);
  var rate = num(spreadRate, 1);
  var covered = 2 * Math.min(b, s);
  var net = Math.abs(b - s);
  return (net + covered * rate) * num(perLotMargin, 0);
}

/* Hedging margin for one symbol.
 * modes:
 *   "basic"     — the net (uncovered) volume is margined in full, and the
 *                 covered volume (both legs) is margined at
 *                 hedgedRate x full margin per lot.
 *   "larger_leg" — only the larger side is margined in full; the smaller
 *                 (covered) side adds nothing.
 * hedgedRate: 0..1 fraction (default 1 = no discount). */
function hedgingMargin(buyVol, sellVol, perLotMargin, opts) {
  var b = num(buyVol, 0);
  var s = num(sellVol, 0);
  var perLot = num(perLotMargin, 0);
  opts = opts || {};
  var mode = opts.mode === "larger_leg" ? "larger_leg" : "basic";
  if (mode === "larger_leg") {
    return Math.max(b, s) * perLot;
  }
  var hedgedRate = num(opts.hedgedRate, 1);
  var covered = 2 * Math.min(b, s);
  var net = Math.abs(b - s);
  return (net + covered * hedgedRate) * perLot;
}

/* Stock-exchange discount-rate model for one account.
 * The account is valued from four figures, computed in our own terms:
 *   assets     = balance + credit + floating profit + collateral value
 *                (everything the client economically owns)
 *   liabilities = sum over symbols of the corrected margin, where the
 *                 corrected margin for a symbol is
 *                 max(buy-side margin, sell-side margin) — opposite legs
 *                 on one symbol do not stack.
 *   ownFunds   = assets - liabilities
 *   equity     = balance + credit + floating profit
 *
 * account: { balance, credit, floating_profit }
 * collateral: collateral value already discounted (see MoneyMath.collateralValue)
 * positions: [{ symbol, direction: "buy"|"sell", margin }]
 * Returns { assets, liabilities, ownFunds, equity, perSymbol: { sym: margin } }. */
function exchangeDiscountAccount(account, collateral, positions) {
  account = account || {};
  positions = positions || [];
  var balance = num(account.balance, 0);
  var credit = num(account.credit, 0);
  var floating = num(account.floating_profit, 0);
  var collat = num(collateral, 0);

  var perSymbol = {};
  positions.forEach(function (p) {
    p = p || {};
    var sym = String(p.symbol || "");
    if (!sym) { return; }
    if (!perSymbol[sym]) { perSymbol[sym] = { buy: 0, sell: 0 }; }
    if (p.direction === "sell") { perSymbol[sym].sell += num(p.margin, 0); }
    else { perSymbol[sym].buy += num(p.margin, 0); }
  });

  var liabilities = 0;
  Object.keys(perSymbol).forEach(function (sym) {
    var m = Math.max(perSymbol[sym].buy, perSymbol[sym].sell);
    perSymbol[sym] = m;
    liabilities += m;
  });

  var assets = balance + credit + floating + collat;
  var equity = balance + credit + floating;
  return {
    assets: assets,
    liabilities: liabilities,
    ownFunds: assets - liabilities,
    equity: equity,
    perSymbol: perSymbol
  };
}

/* Exchange spread margin for a spread of legs on related instruments.
 * legMargins: [margin...] of the spread legs, each in account currency.
 * credit: the exchange's spread credit for inter/intra modes (account
 *         currency, floored at zero — the credit can never pay the trader).
 * modes:
 *   "value"     — sum of the leg margins (no spread relief)
 *   "maximal"   — the largest leg margin only
 *   "cme_inter" — largest leg minus the inter-commodity spread credit
 *   "cme_intra" — largest leg minus the intra-commodity spread credit */
function exchangeSpreadMargin(legMargins, mode, credit) {
  legMargins = (legMargins || []).map(function (m) { return num(m, 0); });
  var cr = Math.max(0, num(credit, 0));
  if (!legMargins.length) { return 0; }
  var sum = 0;
  var max = -Infinity;
  legMargins.forEach(function (m) {
    sum += m;
    if (m > max) { max = m; }
  });
  switch (mode) {
    case "value": return sum;
    case "maximal": return max;
    case "cme_inter": return Math.max(0, max - cr);
    case "cme_intra": return Math.max(0, max - cr);
    default: return sum;
  }
}

var ME = {
  marginLevel: marginLevel,
  checkMargin: checkMargin,
  stopOutPlan: stopOutPlan,
  applyFloatingLeverage: applyFloatingLeverage,
  validateMarginConfig: validateMarginConfig,
  aggregateSameDirection: aggregateSameDirection,
  nettingMarginStages: nettingMarginStages,
  hedgingMargin: hedgingMargin,
  exchangeDiscountAccount: exchangeDiscountAccount,
  exchangeSpreadMargin: exchangeSpreadMargin
};
if (typeof module !== "undefined" && module.exports) { module.exports = ME; }
else { root.MarginEngine = ME; }
})(typeof globalThis !== "undefined" ? globalThis : this);
