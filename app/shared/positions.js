/* OrbitTrader — position accounting (netting vs hedging).
 * Pure, immutable functions: every call returns NEW arrays/objects and
 * never mutates its inputs. Runs in node and in the browser.
 *
 * Accounting mode is per GROUP and is one of "netting" | "hedging".
 *
 * Netting   : at most ONE open position per symbol. A new order in the
 *             same direction merges into that position (volume grows, open
 *             price becomes the volume-weighted average). An opposite
 *             order first reduces the position, closes it at zero, or
 *             flips it (close the old position, open the remainder in the
 *             new direction). Stop-loss / take-profit belong to the
 *             position: a new order's SL/TP replace the position's only
 *             when the order provides them, otherwise they are kept.
 * Hedging   : any number of positions per symbol, including opposite
 *             directions. Each position carries its own SL/TP.
 *             Two opposite positions may be closed against each other
 *             with closeBy (no market price involved): the pair settles
 *             off the two open prices and saves one spread versus two
 *             market closes.
 *
 * SL/TP inheritance:
 *  - Netting, same direction or opposite-reduce: the order's SL/TP replace
 *    the position's only when the order provides them (inheritSLTP).
 *  - Netting, flip (direction change): the new position takes the order's
 *    SL/TP as-is — nothing is inherited from the closed position.
 *  - Hedging: every new position carries its own SL/TP straight from its
 *    order; closing one position never affects any other's.
 *
 * SL/TP modification (modifySLTP) validates the new levels against the
 * symbol's stops level and freeze level (spec fields: stops_level and
 * freeze_level in points, 1 point = pip_size).
 *
 * P/L helpers: closePL for a market close, closeByPL for a close-by pair
 * (models the one-spread saving). Amounts are in (price units x volume);
 * converting to money is the caller's job.
 *
 * Position : {id, symbol, direction:"buy"|"sell", volume, open_price,
 *             sl, tp, swap, commission}
 * Deal     : {type:"close"|"flip_close", position_id, volume, close_price,
 *             comment?}
 *             "close"      — volume was reduced (partially or fully);
 *                            the position with position_id still exists
 *                            unless its remaining volume is 0.
 *             "flip_close" — the whole previous netting position was
 *                            closed because the opposite order exceeded
 *                            it; the remainder opens as a new position.
 *             closeBy deals carry comment "Close By #<id_a> / #<id_b>"
 *             recording both tickets.
 */
(function (root) {
"use strict";

var EPS = 1e-9;
var _nextId = 1;

/* ---------------- helpers ---------------- */

function isZero(x) { return Math.abs(x) < EPS; }

function isPosNumber(x) {
  return typeof x === "number" && isFinite(x) && x > EPS;
}

function clonePosition(p) {
  var out = {
    id: p.id,
    symbol: p.symbol,
    direction: p.direction,
    volume: p.volume,
    open_price: p.open_price,
    sl: p.sl === undefined ? null : p.sl,
    tp: p.tp === undefined ? null : p.tp,
    swap: p.swap === undefined ? 0 : p.swap,
    commission: p.commission === undefined ? 0 : p.commission
  };
  /* Ticket linkage (carried through when present; ignored when absent):
   * ticket — position ticket (trade-lifecycle layer assigns deal ticket);
   * opening_deal_tickets — deal tickets that opened/fed this position;
   * external_ids — gateway/LP ticket references. */
  if (p.ticket !== undefined) out.ticket = p.ticket;
  if (p.opening_deal_tickets !== undefined) out.opening_deal_tickets = p.opening_deal_tickets.slice();
  if (p.external_ids !== undefined) {
    out.external_ids = p.external_ids.map(function (e) { return { source: e.source, id: e.id }; });
  }
  return out;
}

function clonePositions(positions) {
  return (positions || []).map(clonePosition);
}

function newId() {
  return "pos_" + (_nextId++);
}

function findById(positions, id) {
  for (var i = 0; i < positions.length; i++) {
    if (positions[i].id === id) return { position: positions[i], index: i };
  }
  return null;
}

function findBySymbol(positions, symbol) {
  for (var i = 0; i < positions.length; i++) {
    if (positions[i].symbol === symbol) return { position: positions[i], index: i };
  }
  return null;
}

function opposite(dir) {
  return dir === "buy" ? "sell" : "buy";
}

/* ---------------- SL/TP inheritance ---------------- */

/* inheritSLTP(pos, order) -> {sl, tp}
 * Netting same-direction (merge) and opposite-reduce rule: the order's SL/TP
 * replace the position's only when the order provides them; otherwise the
 * position keeps its own. A flip (direction change) takes the order's SL/TP
 * as-is — nothing is inherited from the closed position — so callers do not
 * use this helper for flips.
 */
function inheritSLTP(pos, order) {
  return {
    sl: (order.sl !== undefined && order.sl !== null)
        ? order.sl
        : (pos.sl === undefined ? null : pos.sl),
    tp: (order.tp !== undefined && order.tp !== null)
        ? order.tp
        : (pos.tp === undefined ? null : pos.tp)
  };
}

/* ---------------- validation ---------------- */

/* validateAccounting(mode) -> error string, or null when valid. */
function validateAccounting(mode) {
  if (mode === "netting" || mode === "hedging") return null;
  return 'accounting must be "netting" or "hedging", got ' + JSON.stringify(mode);
}

function validateOrder(order) {
  if (!order || typeof order !== "object") return "order must be an object";
  if (typeof order.symbol !== "string" || order.symbol === "") return "order.symbol must be a non-empty string";
  if (order.direction !== "buy" && order.direction !== "sell") return 'order.direction must be "buy" or "sell"';
  if (!isPosNumber(order.volume)) return "order.volume must be a positive number";
  if (typeof order.price !== "number" || !isFinite(order.price) || order.price <= 0) return "order.price must be a positive number";
  return null;
}

/* ---------------- openOrder ---------------- */

/* openOrder(positions, order, accounting) -> {positions, deals}
 * order = {symbol, direction:"buy"|"sell", volume, price, sl?, tp?}
 * Netting merges/flips; hedging always appends a new position.
 */
function openOrder(positions, order, accounting) {
  var accErr = validateAccounting(accounting);
  if (accErr) throw new Error(accErr);
  var ordErr = validateOrder(order);
  if (ordErr) throw new Error(ordErr);

  var out = clonePositions(positions);
  var deals = [];

  if (accounting === "hedging") {
    out.push(clonePosition({
      id: newId(),
      symbol: order.symbol,
      direction: order.direction,
      volume: order.volume,
      open_price: order.price,
      sl: order.sl,
      tp: order.tp,
      swap: 0,
      commission: 0
    }));
    return { positions: out, deals: deals };
  }

  /* --- netting --- */
  var found = findBySymbol(out, order.symbol);
  if (!found) {
    out.push(clonePosition({
      id: newId(),
      symbol: order.symbol,
      direction: order.direction,
      volume: order.volume,
      open_price: order.price,
      sl: order.sl,
      tp: order.tp,
      swap: 0,
      commission: 0
    }));
    return { positions: out, deals: deals };
  }

  var pos = found.position;

  if (pos.direction === order.direction) {
    /* Same direction: grow volume, weighted-average open price. */
    var totalVol = pos.volume + order.volume;
    pos.open_price = (pos.volume * pos.open_price + order.volume * order.price) / totalVol;
    pos.volume = totalVol;
    /* SL/TP: new order's values replace only when provided, else keep. */
    var inherited = inheritSLTP(pos, order);
    pos.sl = inherited.sl;
    pos.tp = inherited.tp;
    return { positions: out, deals: deals };
  }

  /* Opposite direction: reduce -> close -> flip. */
  var closeVol = Math.min(order.volume, pos.volume);
  var deal = {
    type: order.volume > pos.volume && !isZero(order.volume - pos.volume) ? "flip_close" : "close",
    position_id: pos.id,
    volume: closeVol,
    close_price: order.price
  };
  deals.push(deal);

  if (isZero(order.volume - pos.volume)) {
    /* Exact close: remove the position. */
    out.splice(found.index, 1);
    return { positions: out, deals: deals };
  }

  if (order.volume < pos.volume) {
    /* Partial reduce: volume shrinks, weighted price unchanged. */
    pos.volume = pos.volume - order.volume;
    return { positions: out, deals: deals };
  }

  /* Flip: old position fully closed, remainder opens in the new direction. */
  out.splice(found.index, 1);
  out.push(clonePosition({
    id: newId(),
    symbol: order.symbol,
    direction: order.direction,
    volume: order.volume - pos.volume,
    open_price: order.price,
    sl: order.sl,
    tp: order.tp,
    swap: 0,
    commission: 0
  }));
  return { positions: out, deals: deals };
}

/* ---------------- closePosition ---------------- */

/* closePosition(positions, position_id, volume, price, accounting) -> {positions, deal}
 * Partial close allowed in both modes. Full close removes the position.
 * Netting: partial close keeps the weighted open price.
 */
function closePosition(positions, position_id, volume, price, accounting) {
  var accErr = validateAccounting(accounting);
  if (accErr) throw new Error(accErr);
  if (!isPosNumber(volume)) throw new Error("close volume must be a positive number");
  if (typeof price !== "number" || !isFinite(price) || price <= 0) throw new Error("close price must be a positive number");

  var out = clonePositions(positions);
  var found = findById(out, position_id);
  if (!found) throw new Error("position not found: " + String(position_id));

  var pos = found.position;
  if (volume - pos.volume > EPS) {
    throw new Error("close volume " + volume + " exceeds position volume " + pos.volume);
  }

  var deal = { type: "close", position_id: pos.id, volume: volume, close_price: price };

  if (isZero(volume - pos.volume)) {
    out.splice(found.index, 1);
  } else {
    pos.volume = pos.volume - volume;
  }
  return { positions: out, deal: deal };
}

/* ---------------- closeBy ---------------- */

/* closeBy(positions, id_a, id_b, volume) -> {positions, deals}
 * Hedging only: offset two opposite-direction positions against each other.
 * Closed volume = min(volume, vol_a, vol_b). Both positions shrink (or are
 * removed at zero). No market price is involved: close_price is null and
 * P/L is settled off the two positions' open prices (see closeByPL).
 * Both tickets are recorded in each deal's comment. Compared with closing
 * both legs on the market, close-by saves one spread (modeled in closeByPL).
 */
function closeBy(positions, id_a, id_b, volume) {
  if (id_a === id_b) throw new Error("closeBy needs two different positions");
  if (!isPosNumber(volume)) throw new Error("closeBy volume must be a positive number");

  var out = clonePositions(positions);
  var fa = findById(out, id_a);
  var fb = findById(out, id_b);
  if (!fa) throw new Error("position not found: " + String(id_a));
  if (!fb) throw new Error("position not found: " + String(id_b));
  if (fa.position.direction === fb.position.direction) {
    throw new Error("closeBy requires opposite directions");
  }

  var closed = Math.min(volume, fa.position.volume, fb.position.volume);
  /* Both tickets are recorded in the close comment for audit. */
  var closeComment = "Close By #" + fa.position.id + " / #" + fb.position.id;
  var deals = [
    { type: "close", position_id: fa.position.id, volume: closed, close_price: null, comment: closeComment },
    { type: "close", position_id: fb.position.id, volume: closed, close_price: null, comment: closeComment }
  ];

  /* Remove zeroed positions (highest index first to keep splice safe). */
  var toRemove = [];
  [fa, fb].forEach(function (f) {
    f.position.volume = f.position.volume - closed;
    if (isZero(f.position.volume)) toRemove.push(f.index);
  });
  toRemove.sort(function (x, y) { return y - x; });
  toRemove.forEach(function (i) { out.splice(i, 1); });

  return { positions: out, deals: deals };
}

/* ---------------- close P/L ---------------- */

/* closePL(position, close_price, volume) -> gross realized P/L of the closed
 * volume, in (price units x volume). Positive = trader profit.
 * volume defaults to the position's full volume.
 */
function closePL(position, close_price, volume) {
  if (!position || typeof position !== "object") throw new Error("closePL: position must be an object");
  if (typeof close_price !== "number" || !isFinite(close_price) || close_price <= 0) {
    throw new Error("closePL: close price must be a positive number");
  }
  var vol = volume === undefined ? position.volume : volume;
  if (!isPosNumber(vol)) throw new Error("closePL: volume must be a positive number");
  var sign = position.direction === "buy" ? 1 : -1;
  return sign * (close_price - position.open_price) * vol;
}

/* closeByPL(buyPos, sellPos, volume, spreadPerUnit) -> {gross, spread_saved, net}
 * Realized P/L of a close-by pair (hedging). The legs settle against each
 * other's open prices — no market price involved:
 *   gross        = (sell.open_price - buy.open_price) * volume
 * Because both legs vanish without touching the market, one spread is saved
 * versus closing the two legs separately on the market:
 *   spread_saved = spreadPerUnit * volume   (spreadPerUnit = one spread in price units)
 *   net          = gross + spread_saved
 * Pass the positions in buy/sell order; the helper detects direction.
 */
function closeByPL(buyPos, sellPos, volume, spreadPerUnit) {
  if (!buyPos || !sellPos) throw new Error("closeByPL: two positions required");
  if (buyPos.direction === sellPos.direction) throw new Error("closeByPL: positions must be opposite directions");
  if (!isPosNumber(volume)) throw new Error("closeByPL: volume must be a positive number");
  var buy = buyPos.direction === "buy" ? buyPos : sellPos;
  var sell = buyPos.direction === "buy" ? sellPos : buyPos;
  var perUnit = (typeof spreadPerUnit === "number" && isFinite(spreadPerUnit) && spreadPerUnit > 0)
      ? spreadPerUnit : 0;
  var gross = (sell.open_price - buy.open_price) * volume;
  var saved = perUnit * volume;
  return { gross: gross, spread_saved: saved, net: gross + saved };
}

/* ---------------- modifySLTP ---------------- */

/* modifySLTP(positions, position_id, sl, tp, spec, price) -> {positions, position}
 * Change a position's stop-loss / take-profit.
 *   sl, tp: undefined = keep current, null = clear, number = set (validated).
 *   spec:  symbol spec with optional stops_level / freeze_level (in points,
 *          1 point = spec.pip_size; null/undefined spec skips level checks).
 *   price: current market price used for distance and side checks.
 * Rules: a buy's SL must sit below price and its TP above; a sell is the
 * mirror. Both levels must stay at least stops_level away from price, and
 * may not be placed inside the freeze_level zone around price.
 * Returns new state plus the updated position; inputs are not mutated.
 */
function modifySLTP(positions, position_id, sl, tp, spec, price) {
  if (typeof price !== "number" || !isFinite(price) || price <= 0) {
    throw new Error("modifySLTP: price must be a positive number");
  }
  var out = clonePositions(positions);
  var found = findById(out, position_id);
  if (!found) throw new Error("position not found: " + String(position_id));
  var pos = found.position;

  var pip = (spec && typeof spec.pip_size === "number" && spec.pip_size > 0) ? spec.pip_size : 1;
  var stops = (spec && typeof spec.stops_level === "number" && spec.stops_level > 0) ? spec.stops_level * pip : 0;
  var freeze = (spec && typeof spec.freeze_level === "number" && spec.freeze_level > 0) ? spec.freeze_level * pip : 0;

  function checkLevel(value, name) {
    if (value === undefined) return;
    if (value === null) return; /* clear */
    if (typeof value !== "number" || !isFinite(value) || value <= 0) {
      throw new Error(name + " must be a positive price or null");
    }
    var above = value > price;
    if (pos.direction === "buy") {
      if (name === "sl" && above) throw new Error("buy SL must be below the current price");
      if (name === "tp" && !above) throw new Error("buy TP must be above the current price");
    } else {
      if (name === "sl" && !above) throw new Error("sell SL must be above the current price");
      if (name === "tp" && above) throw new Error("sell TP must be below the current price");
    }
    var dist = Math.abs(value - price);
    if (stops > 0 && dist < stops - EPS) {
      throw new Error(name + " is inside the stops level (" + (stops / pip) + " points minimum)");
    }
    if (freeze > 0 && dist < freeze - EPS) {
      throw new Error(name + " is inside the freeze level (" + (freeze / pip) + " points)");
    }
  }

  checkLevel(sl, "sl");
  checkLevel(tp, "tp");
  if (sl !== undefined) pos.sl = sl;
  if (tp !== undefined) pos.tp = tp;
  return { positions: out, position: clonePosition(pos) };
}

/* ---------------- netExposure ---------------- */

/* netExposure(positions, symbol) -> {buy_volume, sell_volume, net_volume}
 * net_volume = buy_volume - sell_volume (signed). Used for netting margin calc.
 */
function netExposure(positions, symbol) {
  var buy = 0, sell = 0;
  (positions || []).forEach(function (p) {
    if (p.symbol !== symbol) return;
    if (p.direction === "buy") buy += p.volume;
    else if (p.direction === "sell") sell += p.volume;
  });
  return { buy_volume: buy, sell_volume: sell, net_volume: buy - sell };
}

var Positions = {
  validateAccounting: validateAccounting,
  openOrder: openOrder,
  closePosition: closePosition,
  closeBy: closeBy,
  closePL: closePL,
  closeByPL: closeByPL,
  inheritSLTP: inheritSLTP,
  modifySLTP: modifySLTP,
  netExposure: netExposure,
  opposite: opposite
};

if (typeof module !== "undefined" && module.exports) { module.exports = Positions; }
else { root.PositionAccounting = Positions; }

})(typeof globalThis !== "undefined" ? globalThis : this);
