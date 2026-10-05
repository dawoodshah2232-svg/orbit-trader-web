/* shared/funds.js — OrbitTrader investment-fund (asset management) model.
 *
 * A fund is a pool of investor capital traded by a manager account. Each
 * fund owns three display symbols (NAV, AUM, Performance) so terminals can
 * chart the fund like any other instrument.
 *
 * Model (reimplemented in OrbitTrader terms):
 *   - fund_type: "open_end" (continuous subscriptions/redemptions) or
 *     "closed_end" (capital raised up front, locked until end_date;
 *     subscriptions/redemptions default to off).
 *   - Manager account: a normal trading account whose equity IS the fund
 *     equity. AUM = manager equity − accrued (not yet booked) fees.
 *   - Investor accounts: hedging-mode accounts. An investor's LONG position
 *     in the fund's NAV symbol represents their share holding:
 *     shares = position volume (lots) × shares_per_lot.
 *   - NAV per share = AUM / shares_outstanding (initial_nav while no shares).
 *   - Performance % = (NAV − initial_nav) / initial_nav × 100 (since launch).
 *   - Management fee = fund equity × days × pct / 365, accrued then booked.
 *   - Success fee = success_fee_pct of the per-share gain above the
 *     high-water mark, crystallised periodically (and optionally on
 *     redemption). A hurdle rate may gate/trim the fee:
 *       none — fee on the full gain above the high-water mark;
 *       soft — no fee unless NAV also beats the hurdle level, then the fee
 *              is still computed on the full gain above the high-water mark;
 *       hard — the fee is computed only on the gain above
 *              max(high-water mark, hurdle level).
 *     The high-water mark rises to the NAV at each crystallisation, so the
 *     same gain is never charged twice.
 *   - Every fee is booked as a "commission" balance operation: deducted from
 *     the fund (manager account) and credited to the configured fee account.
 *   - resetFundState() wipes positions/shares/fees/HWM for a relaunch; the
 *     fund configuration itself is untouched.
 *
 * All functions are pure (inputs never mutated; new objects returned), no
 * globals, no DOM: runs in the browser and in node (guarded export at the
 * bottom, same pattern as shared/groups.js).
 *
 * Numbers below marked DEFAULT are OrbitTrader example defaults — the broker
 * sets real values in admin. Tests use clearly-labelled example figures.
 */
(function (root) {
"use strict";

var FUND_TYPES = ["open_end", "closed_end"];
var HURDLE_MODES = ["none", "soft", "hard"];
var SYMBOL_KINDS = ["nav", "aum", "perf"];
var FUND_STATUS = ["active", "frozen"];
var FEE_KINDS = ["management_fee", "success_fee"];
var DAYS_PER_YEAR = 365;

/* ---- small helpers ---- */
function num(v, dflt) {
  var n = (typeof v === "number") ? v : parseFloat(v);
  return (isFinite(n)) ? n : dflt;
}
function r2(x) { /* currency rounding: 2 decimals */
  return Math.round(num(x, 0) * 100) / 100;
}
function isInt(v) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v; }

/* Accepts a Date or an ISO string ("YYYY-MM-DD" or full ISO). Returns a
 * Date in UTC, or null when unparseable. */
function toDate(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v !== "string") return null;
  var s = v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00Z";
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
/* End of a lifetime day: 23:59:59.999 UTC, so end_date is inclusive. */
function endOfDayUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/* ---- 1. fund configuration ---- */
function defaultFundConfig(fundType) {
  var t = (fundType === "closed_end") ? "closed_end" : "open_end";
  var open = (t === "open_end");
  return {
    id: "example-fund",          /* DEFAULT slug; broker sets the real id */
    name: "Example Fund",        /* DEFAULT display name */
    symbol_base: "EXFUND",       /* DEFAULT base for the 3 display symbols */
    symbol_suffixes: { nav: "NAV", aum: "AUM", perf: "PERF" }, /* DEFAULTs */
    fund_type: t,
    currency: "USD",             /* DEFAULT; ISO 4217 */
    start_date: "2026-01-01",    /* DEFAULT lifetime start (ISO date) */
    end_date: null,              /* required for closed_end; null = no maturity */
    max_capital: null,           /* DEFAULT null = unlimited (currency units) */
    max_investors: null,         /* DEFAULT null = unlimited */
    initial_nav: 100.0,          /* DEFAULT NAV per share at launch */
    shares_per_lot: 1.0,         /* DEFAULT: 1 lot of NAV symbol = 1 share */
    manager_login: null,         /* manager trading account (broker sets) */
    fee_account: null,           /* account credited with booked fees */
    management_fee_pct: 2.0,     /* DEFAULT annual %, example only */
    success_fee_pct: 20.0,       /* DEFAULT % of gains, example only */
    hurdle_mode: "none",         /* DEFAULT: "none" | "soft" | "hard" */
    hurdle_rate_pct: 0.0,        /* DEFAULT annual %; >0 required unless "none" */
    crystallise_on_redemption: true,  /* DEFAULT: charge success fee on redeem */
    allow_subscriptions: open,   /* closed_end DEFAULT false (fixed capital) */
    allow_redemptions: open      /* closed_end DEFAULT false (locked capital) */
  };
}

/* Validate a fund config -> array of error strings (empty = valid). */
function validateFundConfig(c) {
  var errs = [];
  function err(m) { errs.push(m); }
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["config must be an object"];

  if (typeof c.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(c.id))
    err("id must be a slug ([a-z0-9_-], starts alnum)");
  if (typeof c.name !== "string" || !c.name) err("name must be a non-empty string");
  if (typeof c.symbol_base !== "string" || !c.symbol_base) err("symbol_base must be a non-empty string");
  if (!c.symbol_suffixes || typeof c.symbol_suffixes !== "object") {
    err("symbol_suffixes must be an object");
  } else {
    ["nav", "aum", "perf"].forEach(function (k) {
      if (typeof c.symbol_suffixes[k] !== "string" || !c.symbol_suffixes[k])
        err("symbol_suffixes." + k + " must be a non-empty string");
    });
  }
  if (FUND_TYPES.indexOf(c.fund_type) === -1)
    err("fund_type must be one of: " + FUND_TYPES.join(", "));
  if (typeof c.currency !== "string" || c.currency.length !== 3)
    err("currency must be a 3-letter ISO code");

  var start = toDate(c.start_date);
  if (!start) err("start_date must be a parseable ISO date");
  var end = (c.end_date === null || c.end_date === undefined) ? null : toDate(c.end_date);
  if (c.end_date !== null && c.end_date !== undefined && !end) err("end_date must be null or a parseable ISO date");
  if (start && end && endOfDayUTC(end).getTime() <= start.getTime())
    err("end_date must be after start_date");
  if (c.fund_type === "closed_end" && !end)
    err("closed_end funds require end_date (the maturity that locks capital)");

  if (c.max_capital !== null && c.max_capital !== undefined &&
      (typeof c.max_capital !== "number" || !isFinite(c.max_capital) || c.max_capital <= 0))
    err("max_capital must be null or a number > 0");
  if (c.max_investors !== null && c.max_investors !== undefined &&
      (!isInt(c.max_investors) || c.max_investors < 1))
    err("max_investors must be null or an integer >= 1");

  if (typeof c.initial_nav !== "number" || !isFinite(c.initial_nav) || c.initial_nav <= 0)
    err("initial_nav must be a number > 0");
  if (typeof c.shares_per_lot !== "number" || !isFinite(c.shares_per_lot) || c.shares_per_lot <= 0)
    err("shares_per_lot must be a number > 0");

  [["management_fee_pct", true], ["success_fee_pct", true], ["hurdle_rate_pct", false]].forEach(function (p) {
    var v = c[p[0]];
    if (typeof v !== "number" || !isFinite(v) || v < 0 || v > 100)
      err(p[0] + " must be a number in [0, 100]");
  });
  if (HURDLE_MODES.indexOf(c.hurdle_mode) === -1)
    err("hurdle_mode must be one of: " + HURDLE_MODES.join(", "));
  if (c.hurdle_mode === "none" && c.hurdle_rate_pct !== 0)
    err("hurdle_rate_pct must be 0 when hurdle_mode is 'none'");
  if (c.hurdle_mode !== "none" && !(c.hurdle_rate_pct > 0))
    err("hurdle_rate_pct must be > 0 when hurdle_mode is '" + c.hurdle_mode + "'");

  ["crystallise_on_redemption", "allow_subscriptions", "allow_redemptions"].forEach(function (f) {
    if (typeof c[f] !== "boolean") err(f + " must be a boolean");
  });
  return errs;
}

/* ---- 2. fund state ---- */
function initialFundState(cfg) {
  return {
    fund_id: cfg ? cfg.id : null,
    status: "active",
    shares_outstanding: 0,
    high_water_mark: cfg ? num(cfg.initial_nav, 100) : 100,
    accrued_management_fee: 0,
    accrued_success_fee: 0,
    investors: [],
    last_crystallised_at: null
  };
}
/* Relaunch helper: fresh state, config untouched. */
function resetFundState(cfg) { return initialFundState(cfg); }

function cloneState(s) {
  var c = {};
  for (var k in s) {
    if (Object.prototype.hasOwnProperty.call(s, k)) c[k] = s[k];
  }
  c.investors = (s.investors || []).slice();
  return c;
}

/* ---- 3. the three display symbols ---- */
function fundSymbolNames(cfg) {
  var base = (cfg && cfg.symbol_base) || "";
  var suf = (cfg && cfg.symbol_suffixes) || {};
  return {
    nav:  base + "." + (suf.nav || "NAV"),
    aum:  base + "." + (suf.aum || "AUM"),
    perf: base + "." + (suf.perf || "PERF")
  };
}

/* ---- 4. lifetime ---- */
function fundLifetimeStatus(cfg, now) {
  var t = toDate(now) || new Date();
  var start = toDate(cfg.start_date);
  var end = (cfg.end_date === null || cfg.end_date === undefined) ? null : toDate(cfg.end_date);
  if (start && t.getTime() < start.getTime()) return "upcoming";
  if (end && t.getTime() > endOfDayUTC(end).getTime()) return "matured";
  return "live";
}

/* ---- 5. core money math ----
 * managerEquity: the manager trading account's current equity (fund equity).
 * Accrued-but-unbooked fees are subtracted to get AUM. */
function accruedFees(state) {
  return num(state.accrued_management_fee, 0) + num(state.accrued_success_fee, 0);
}
function aum(state, managerEquity) {
  return num(managerEquity, 0) - accruedFees(state);
}
function navPerShare(state, managerEquity, cfg) {
  var shares = num(state.shares_outstanding, 0);
  if (!(shares > 0)) return num(cfg.initial_nav, 100);
  return aum(state, managerEquity) / shares;
}
function performancePct(state, managerEquity, cfg) {
  var init = num(cfg.initial_nav, 100);
  if (!(init > 0)) return 0;
  return (navPerShare(state, managerEquity, cfg) - init) / init * 100;
}

/* Full display-symbol quote set. The NAV symbol is the tradable fund share
 * (long-only for investors); AUM and PERF are display-only. */
function displayQuotes(cfg, state, managerEquity) {
  var names = fundSymbolNames(cfg);
  var nav = navPerShare(state, managerEquity, cfg);
  var a = aum(state, managerEquity);
  var p = performancePct(state, managerEquity, cfg);
  return [
    { kind: "nav",  symbol: names.nav,  bid: r2(nav), ask: r2(nav), trade_mode: "long_only", digits: 2 },
    { kind: "aum",  symbol: names.aum,  bid: r2(a),   ask: r2(a),   trade_mode: "disabled",  digits: 2 },
    { kind: "perf", symbol: names.perf, bid: r2(p),   ask: r2(p),   trade_mode: "disabled",  digits: 2 }
  ];
}

/* ---- 6. management fee ----
 * fee = fund equity × days × pct / 365. The caller passes the manager
 * account's current equity; the model does not net accrued fees from the
 * base (see aum() for the net figure). Rounded to 2dp at accrual. */
function managementFee(managerEquity, days, cfg) {
  var d = Math.max(0, Math.floor(num(days, 0)));
  return r2(Math.max(0, num(managerEquity, 0)) * d * (num(cfg.management_fee_pct, 0) / 100) / DAYS_PER_YEAR);
}
function accrueManagementFee(state, managerEquity, days, cfg) {
  var fee = managementFee(managerEquity, days, cfg);
  var ns = cloneState(state);
  ns.accrued_management_fee = r2(ns.accrued_management_fee + fee);
  return { state: ns, fee: fee };
}

/* ---- 7. success fee (high-water mark + hurdle) ---- */
function successFeePerShare(nav, hwm, days, cfg) {
  var mode = cfg.hurdle_mode || "none";
  var hurdlePct = num(cfg.hurdle_rate_pct, 0);
  var feePct = num(cfg.success_fee_pct, 0);
  var d = Math.max(0, Math.floor(num(days, 0)));
  var hurdleLevel = (mode === "none") ? hwm : hwm * (1 + (hurdlePct / 100) * (d / DAYS_PER_YEAR));
  var out = { chargeable: false, hurdle_level: hurdleLevel, fee_base_per_share: hwm,
              fee_per_share: 0, new_hwm: hwm };
  if (!(feePct > 0)) return out;
  if (!(nav > hwm)) return out;              /* high-water mark not beaten */
  var base = hwm;
  if (mode === "soft") {
    if (!(nav > hurdleLevel)) return out;    /* hurdle gates, fee on full HWM gain */
  } else if (mode === "hard") {
    base = Math.max(hwm, hurdleLevel);       /* fee only above the hurdle level */
    if (!(nav > base)) return out;
  }
  out.chargeable = true;
  out.fee_base_per_share = base;
  out.fee_per_share = (nav - base) * (feePct / 100);
  out.new_hwm = nav;                         /* crystallise at the pre-fee NAV */
  return out;
}

function successFeeQuote(state, managerEquity, days, cfg) {
  var shares = num(state.shares_outstanding, 0);
  var hwm = num(state.high_water_mark, num(cfg.initial_nav, 100));
  var nav = navPerShare(state, managerEquity, cfg);
  var q = successFeePerShare(nav, hwm, days, cfg);
  return {
    chargeable: q.chargeable && shares > 0,
    nav_per_share: nav,
    high_water_mark: hwm,
    hurdle_level: q.hurdle_level,
    hurdle_mode: cfg.hurdle_mode || "none",
    fee_base_per_share: q.fee_base_per_share,
    fee_per_share: r2(q.fee_per_share),
    total_fee: r2(q.fee_per_share * shares),
    new_hwm: q.new_hwm
  };
}

/* Crystallise: move the success fee into accrued_success_fee and raise the
 * high-water mark so the same gain is never charged twice. */
function crystalliseSuccessFee(state, managerEquity, days, cfg, now) {
  var q = successFeeQuote(state, managerEquity, days, cfg);
  var ns = cloneState(state);
  if (q.chargeable) {
    ns.accrued_success_fee = r2(ns.accrued_success_fee + q.total_fee);
    ns.high_water_mark = q.new_hwm;
    ns.last_crystallised_at = (now instanceof Date) ? now.toISOString() :
      (typeof now === "string" ? now : new Date().toISOString());
  }
  return { state: ns, quote: q };
}

/* ---- 8. booking a fee as a "commission" balance operation ----
 * The returned op is data only: the caller deducts `amount` from the fund
 * (manager account) balance and credits `to_login`. After booking, the
 * accrued bucket is zeroed so a fee is never booked twice. */
function bookFeeAsCommission(cfg, state, feeKind) {
  if (FEE_KINDS.indexOf(feeKind) === -1)
    throw new Error("funds: unknown fee kind: " + feeKind);
  var key = (feeKind === "management_fee") ? "accrued_management_fee" : "accrued_success_fee";
  var amount = r2(num(state[key], 0));
  if (!(amount > 0)) return { ok: false, reason: "nothing_accrued", state: cloneState(state), op: null };
  var ns = cloneState(state);
  ns[key] = 0;
  var op = {
    type: "balance_op",
    op: "commission",
    fund_id: cfg.id,
    fee_kind: feeKind,
    from_login: cfg.manager_login,   /* fund side: manager trading account */
    to_login: cfg.fee_account,       /* fee recipient (management company) */
    amount: amount,                  /* always positive; direction is from->to */
    currency: cfg.currency,
    comment: "Fund " + cfg.id + " " + feeKind.replace(/_/g, " ") + " booked as commission"
  };
  return { ok: true, state: ns, op: op };
}

/* ---- 9. subscriptions / redemptions ---- */
function canSubscribe(cfg, state, managerEquity, amount, investorLogin, now) {
  if (!(num(amount, 0) > 0)) return { ok: false, reason: "invalid_amount" };
  if (!state || state.status !== "active") return { ok: false, reason: "fund_not_active" };
  if (!cfg.allow_subscriptions) return { ok: false, reason: "subscriptions_closed" };
  if (fundLifetimeStatus(cfg, now) !== "live") return { ok: false, reason: "outside_lifetime" };
  var investors = state.investors || [];
  var isNew = !investorLogin || investors.indexOf(investorLogin) === -1;
  if (isNew && cfg.max_investors !== null && cfg.max_investors !== undefined &&
      investors.length >= cfg.max_investors)
    return { ok: false, reason: "max_investors_reached" };
  if (cfg.max_capital !== null && cfg.max_capital !== undefined &&
      aum(state, managerEquity) + num(amount, 0) > cfg.max_capital)
    return { ok: false, reason: "max_capital_exceeded" };
  return { ok: true, reason: null };
}

/* Shares are issued at the current NAV. The cash enters the pool, so the
 * caller adds equity_delta to the manager account equity. */
function subscribe(cfg, state, managerEquity, amount, investorLogin, now) {
  var chk = canSubscribe(cfg, state, managerEquity, amount, investorLogin, now);
  if (!chk.ok) return { ok: false, reason: chk.reason };
  var nav = navPerShare(state, managerEquity, cfg);
  var shares = num(amount, 0) / nav;
  var ns = cloneState(state);
  ns.shares_outstanding = ns.shares_outstanding + shares;
  if (investorLogin && ns.investors.indexOf(investorLogin) === -1) ns.investors.push(investorLogin);
  return {
    ok: true, state: ns,
    shares_issued: shares,
    nav_per_share: nav,
    equity_delta: num(amount, 0),
    receipt: { fund_id: cfg.id, investor: investorLogin || null, amount: num(amount, 0),
               shares_issued: shares, nav_per_share: nav, currency: cfg.currency }
  };
}

/* Redemption pays out at the current NAV. With crystallise_on_redemption the
 * success fee on the redeemed shares is taken first (per-share HWM math, so
 * remaining shares are unaffected and the HWM itself does not move). The
 * caller subtracts payout from the manager account equity (equity_delta is
 * negative). Redemptions are allowed while live, and after maturity so a
 * closed-end fund can liquidate. */
function redeem(cfg, state, managerEquity, shares, opts) {
  opts = opts || {};
  var now = opts.now;
  var days = Math.max(0, Math.floor(num(opts.days, 0)));
  var want = num(shares, 0);
  if (!(want > 0)) return { ok: false, reason: "invalid_shares" };
  if (!state || state.status !== "active") return { ok: false, reason: "fund_not_active" };
  if (!cfg.allow_redemptions) return { ok: false, reason: "redemptions_closed" };
  var life = fundLifetimeStatus(cfg, now);
  if (life !== "live" && life !== "matured") return { ok: false, reason: "outside_lifetime" };
  if (want > num(state.shares_outstanding, 0)) return { ok: false, reason: "insufficient_shares" };

  var nav = navPerShare(state, managerEquity, cfg);
  var hwm = num(state.high_water_mark, num(cfg.initial_nav, 100));
  var fee = 0, feeBase = hwm;
  var ns = cloneState(state);
  if (cfg.crystallise_on_redemption) {
    var q = successFeePerShare(nav, hwm, days, cfg);
    if (q.chargeable) {
      fee = r2(q.fee_per_share * want);
      feeBase = q.fee_base_per_share;
      ns.accrued_success_fee = r2(ns.accrued_success_fee + fee);
    }
  }
  var payout = r2(want * nav - fee);
  ns.shares_outstanding = ns.shares_outstanding - want;
  return {
    ok: true, state: ns,
    shares_redeemed: want,
    nav_per_share: nav,
    success_fee_charged: fee,
    success_fee_base_per_share: feeBase,
    payout: payout,
    equity_delta: -payout
  };
}

/* ---- 10. investor position <-> share conversion ----
 * On a hedging-mode investor account, a LONG position in the fund's NAV
 * symbol IS the share holding. */
function sharesFromPositionVolume(volumeLots, cfg) {
  return num(volumeLots, 0) * num(cfg.shares_per_lot, 1);
}
function positionVolumeFromShares(shares, cfg) {
  var spl = num(cfg.shares_per_lot, 1);
  if (!(spl > 0)) throw new Error("funds: shares_per_lot must be > 0");
  return num(shares, 0) / spl;
}

var FUNDS = {
  FUND_TYPES: FUND_TYPES,
  HURDLE_MODES: HURDLE_MODES,
  SYMBOL_KINDS: SYMBOL_KINDS,
  FUND_STATUS: FUND_STATUS,
  FEE_KINDS: FEE_KINDS,
  DAYS_PER_YEAR: DAYS_PER_YEAR,
  defaultFundConfig: defaultFundConfig,
  validateFundConfig: validateFundConfig,
  fundSymbolNames: fundSymbolNames,
  initialFundState: initialFundState,
  resetFundState: resetFundState,
  fundLifetimeStatus: fundLifetimeStatus,
  aum: aum,
  navPerShare: navPerShare,
  performancePct: performancePct,
  displayQuotes: displayQuotes,
  managementFee: managementFee,
  accrueManagementFee: accrueManagementFee,
  successFeePerShare: successFeePerShare,
  successFeeQuote: successFeeQuote,
  crystalliseSuccessFee: crystalliseSuccessFee,
  bookFeeAsCommission: bookFeeAsCommission,
  canSubscribe: canSubscribe,
  subscribe: subscribe,
  redeem: redeem,
  sharesFromPositionVolume: sharesFromPositionVolume,
  positionVolumeFromShares: positionVolumeFromShares
};
if (typeof module !== "undefined" && module.exports) { module.exports = FUNDS; }
else { root.OrbitFunds = FUNDS; }
})(typeof globalThis !== "undefined" ? globalThis : this);
