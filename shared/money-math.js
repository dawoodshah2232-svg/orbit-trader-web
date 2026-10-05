/* shared/money-math.js — QuotesWare P0: centralized money math (pure functions).
 *
 * Single home for pip/tick value, P/L, margin and swap math. Every function takes
 * a normalized spec object (see shared/specs-loader.js) and plain numbers — no
 * globals, no DOM, no feed access. Units:
 *   - P/L and margin are returned in ACCOUNT currency.
 *   - swap is in account-currency units per 1.0 lot per night (see spec.swap_long).
 *   - "points" = spec.pip_size (the legacy UI point).
 */
(function (root) {
"use strict";

function num(v, fb) { v = +v; return isFinite(v) ? v : fb; }
function dirSign(dir) { return dir === "sell" ? -1 : 1; }
/* Accept both canonical (contract_size) and legacy (contract) shapes. */
function specContract(sp) {
  return num(sp.contract_size != null ? sp.contract_size : sp.contract, 1);
}
/* Minimum price increment = 10^-digits. */
function tickSize(sp) { return Math.pow(10, -num(sp.digits, 2)); }
/* Account-currency value of a one-pip move for `volume` lots (informational). */
function pipValue(sp, volume) {
  return num(sp.pip_value != null ? sp.pip_value : sp.pipValue, 0) * num(volume, 0);
}
/* Profit-currency value of a one-tick move for `volume` lots. */
function tickValue(sp, volume) {
  return num(sp.tick_value, 0) * num(volume, 0);
}
/* Price difference expressed in pips. */
function toPips(sp, priceDiff) {
  var ps = num(sp.pip_size != null ? sp.pip_size : sp.pipSize, 0);
  return ps ? num(priceDiff) / ps : 0;
}
/* P/L in account currency.
 *   fxRate converts 1 unit of profit currency -> account currency (default 1).
 *   e.g. USDJPYc on a USD account: fxRate = 1 / USDJPY mid.
 * dir: "buy"|"sell" (anything else counts as buy). */
function profitLoss(sp, dir, openPx, closePx, volume, fxRate) {
  if (fxRate == null || !isFinite(+fxRate) || +fxRate <= 0) fxRate = 1;
  return (num(closePx) - num(openPx)) * dirSign(dir) * num(volume) * specContract(sp) * fxRate;
}
/* Required margin in account currency. leverage as a number (100 = 1:100). */
function marginRequired(sp, volume, price, leverage) {
  var lev = num(leverage, 0);
  if (lev <= 0) return 0;
  return specContract(sp) * num(volume) * num(price) / lev;
}
/* Overnight swap in account currency for `nights` nights.
 * triple=true applies the triple-swap-day multiplier (x3). */
function swapCharge(sp, dir, volume, nights, triple) {
  var r = dir === "sell"
    ? num(sp.swap_short != null ? sp.swap_short : sp.swapShort, 0)
    : num(sp.swap_long != null ? sp.swap_long : sp.swapLong, 0);
  return r * num(volume) * num(nights, 1) * (triple ? 3 : 1);
}
/* Minimum SL/TP distance in price terms. */
function stopsDistance(sp) {
  return num(sp.stops_level != null ? sp.stops_level : sp.stopsPts, 0) * tickSize(sp);
}
/* Round a price to the symbol tick. */
function roundToTick(sp, px) {
  var t = tickSize(sp);
  return Math.round(num(px) / t) * t;
}

/* ---------- Margin calculation types ----------
 * Initial-margin formulas per calculation type, in the platform's own terms.
 * Each returns the required margin in account currency for `volume` lots.
 * `leverage` is a number (100 = 1:100). All volumes are absolute (unsigned). */

/* Forex (OTC): share of the notional fixed by leverage. */
function marginForex(volume, contractSize, leverage) {
  var lev = num(leverage, 0);
  if (lev <= 0) { return 0; }
  return Math.abs(num(volume, 0)) * num(contractSize, 0) / lev;
}

/* Forex without leverage: the whole notional must be posted. */
function marginForexNoLeverage(volume, contractSize, price) {
  return Math.abs(num(volume, 0)) * num(contractSize, 0) * num(price, 0);
}

/* CFD: full contract value, no leverage division. */
function marginCfd(volume, contractSize, price) {
  return Math.abs(num(volume, 0)) * num(contractSize, 0) * num(price, 0);
}

/* CFD with leverage: contract value scaled down by leverage. */
function marginCfdLeverage(volume, contractSize, price, leverage) {
  var lev = num(leverage, 0);
  if (lev <= 0) { return 0; }
  return Math.abs(num(volume, 0)) * num(contractSize, 0) * num(price, 0) / lev;
}

/* CFD index: contract value expressed through tick value / tick size.
 * An index quote moves in whole ticks; the margin scales with how much
 * account currency each tick is worth relative to the tick size. */
function marginCfdIndex(volume, contractSize, price, tickValue, tickSize) {
  var ts = num(tickSize, 0);
  if (ts <= 0) { return 0; }
  return Math.abs(num(volume, 0)) * num(contractSize, 0) * num(price, 0) *
    (num(tickValue, 0) / ts);
}

/* Futures (exchange): broker-set per-lot amounts.
 * Initial margin opens the position; maintenance margin is the lower band
 * used for margin-call/stop-out comparisons in exchange mode. */
function marginFutures(volume, initialMarginPerLot) {
  return Math.abs(num(volume, 0)) * num(initialMarginPerLot, 0);
}
function marginFuturesMaintenance(volume, maintenanceMarginPerLot) {
  return Math.abs(num(volume, 0)) * num(maintenanceMarginPerLot, 0);
}

/* Exchange stocks / bonds: traded value divided by leverage. */
function marginExchangeStocks(volume, contractSize, price, leverage) {
  var lev = num(leverage, 0);
  if (lev <= 0) { return 0; }
  return Math.abs(num(volume, 0)) * num(contractSize, 0) * num(price, 0) / lev;
}
function marginExchangeBonds(volume, contractSize, price, leverage) {
  var lev = num(leverage, 0);
  if (lev <= 0) { return 0; }
  return Math.abs(num(volume, 0)) * num(contractSize, 0) * num(price, 0) / lev;
}

/* Exchange options: the option premium value (price x contract x lots),
 * plus an optional broker add-on (e.g. a share of the underlying value). */
function marginExchangeOptions(volume, contractSize, optionPrice, addOn) {
  return Math.abs(num(volume, 0)) * num(contractSize, 0) * num(optionPrice, 0) +
    num(addOn, 0);
}

/* Exchange-cleared (FORTS-style) futures: margin comes from the settlement
 * price, not the trade price — settlementPrice x contractSize x the
 * clearing house's initial-margin rate (fraction, e.g. 0.15 = 15%). */
function marginFortsFutures(settlementPrice, contractSize, initialMarginRate) {
  return num(settlementPrice, 0) * num(contractSize, 0) * num(initialMarginRate, 0);
}

/* Exchange-cleared (FORTS-style) options: the premium value plus a risk
 * add-on that grows when the option is in the money:
 *   call: premium + max(0, 2 x rate x (settle - strike)) x contractSize
 *   put : premium + max(0, 2 x rate x (strike - settle)) x contractSize
 * optionType: "call" | "put" (anything else counts as call). */
function marginFortsOptions(optionPrice, contractSize, strikePrice,
    futuresSettlementPrice, initialMarginRate, optionType) {
  var cs = num(contractSize, 0);
  var premium = num(optionPrice, 0) * cs;
  var rate = num(initialMarginRate, 0);
  var diff = optionType === "put"
    ? num(strikePrice, 0) - num(futuresSettlementPrice, 0)
    : num(futuresSettlementPrice, 0) - num(strikePrice, 0);
  var addOn = Math.max(0, 2 * rate * diff) * cs;
  return premium + addOn;
}

/* Collateral instruments: traded value charged at the broker's collateral
 * rate (fraction, e.g. 0.5 = half the notional must be posted). */
function marginCollateral(volume, contractSize, price, collateralRate) {
  return Math.abs(num(volume, 0)) * num(contractSize, 0) *
    num(price, 0) * num(collateralRate, 0);
}

/* Fixed margin: a flat broker-set amount per lot, independent of price. */
function marginFixed(volume, fixedPerLot) {
  return Math.abs(num(volume, 0)) * num(fixedPerLot, 0);
}

/* End-of-day margin-rate recalculation: when the leverage applicable to an
 * open position changes at end of day, its margin is re-scaled by the ratio
 * of the old and new leverage. */
function eodMarginRecalc(marginBefore, oldLeverage, newLeverage) {
  var oldLev = num(oldLeverage, 0);
  var newLev = num(newLeverage, 0);
  if (oldLev <= 0 || newLev <= 0) { return num(marginBefore, 0); }
  return num(marginBefore, 0) * oldLev / newLev;
}

/* Collateral valuation: quantity x market price, discounted by the haircut
 * factor (fraction of full value the broker counts, e.g. 0.7 = 70%). */
function collateralValue(volume, price, discountFactor) {
  return Math.abs(num(volume, 0)) * num(price, 0) * num(discountFactor, 0);
}

var MM = {
  dirSign: dirSign,
  specContract: specContract,
  tickSize: tickSize,
  pipValue: pipValue,
  tickValue: tickValue,
  toPips: toPips,
  profitLoss: profitLoss,
  marginRequired: marginRequired,
  marginForex: marginForex,
  marginForexNoLeverage: marginForexNoLeverage,
  marginCfd: marginCfd,
  marginCfdLeverage: marginCfdLeverage,
  marginCfdIndex: marginCfdIndex,
  marginFutures: marginFutures,
  marginFuturesMaintenance: marginFuturesMaintenance,
  marginExchangeStocks: marginExchangeStocks,
  marginExchangeBonds: marginExchangeBonds,
  marginExchangeOptions: marginExchangeOptions,
  marginFortsFutures: marginFortsFutures,
  marginFortsOptions: marginFortsOptions,
  marginCollateral: marginCollateral,
  marginFixed: marginFixed,
  eodMarginRecalc: eodMarginRecalc,
  collateralValue: collateralValue,
  swapCharge: swapCharge,
  stopsDistance: stopsDistance,
  roundToTick: roundToTick
};
if (typeof module !== "undefined" && module.exports) { module.exports = MM; }
else { root.MoneyMath = MM; }
})(typeof globalThis !== "undefined" ? globalThis : this);
