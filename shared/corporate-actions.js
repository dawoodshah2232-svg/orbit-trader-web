/* OrbitTrader — corporate actions & bulk operations.
 *
 * Pure, immutable helpers for the three corporate-action families an admin
 * performs across many positions at once:
 *
 *   1. Bulk close   — close every position matching a symbol mask (+ optional
 *                      group filter), in PREVIEW (no mutation, returns the
 *                      would-be-closed list + estimated P/L) or EXECUTE mode.
 *   2. Position splits — apply a split ratio (e.g. 2:1) to one position:
 *                      volume is multiplied by the ratio and rounded to the
 *                      symbol's volume step; the open price is adjusted
 *                      inversely (divided by the ratio). Implemented as
 *                      close + reopen with reason "Split"; the original
 *                      position's ticket is preserved as a link on the new
 *                      position (split_from_ticket).
 *   3. Bulk payments — dividends / tax credits paid per lot at a settlement
 *                      date: per-position amount = lots × per-lot amount,
 *                      emitted as balance-operation records. This module never
 *                      invents corporate data: per-lot amounts are inputs.
 *
 * Every operation returns an audit-friendly result list: each item carries
 * who did it (actor), what happened (action/description), and when
 * (timestamp), plus a top-level audit entry summarizing the run.
 *
 * Runs in node and in the browser (guarded export at the bottom; browser
 * global is OrbitCorporateActions).
 */
(function (root) {
"use strict";

var _nextOpId = 1;
var _nextPosId = 1;

/* ---------------- helpers ---------------- */

function isPosNumber(x) {
  return typeof x === "number" && isFinite(x) && x > 0;
}

function isFiniteNum(x) {
  return typeof x === "number" && isFinite(x);
}

function clonePosition(p) {
  var c = {};
  for (var k in p) {
    if (Object.prototype.hasOwnProperty.call(p, k)) c[k] = p[k];
  }
  return c;
}

function newOpId() { return "ca_" + (_nextOpId++); }

function newPosId() { return "pos_ca_" + (_nextPosId++); }

function utcNow(atMs) {
  return new Date(atMs == null ? Date.now() : atMs).toISOString();
}

/* Number of decimals in a step/tick value, e.g. 0.01 -> 2. */
function decimalsOf(x) {
  var s = String(x);
  var i = s.indexOf(".");
  if (i < 0) return 0;
  var frac = s.slice(i + 1);
  var e = frac.indexOf("e");
  if (e >= 0) frac = frac.slice(0, e);
  return frac.length;
}

/* Round a value to a multiple of step, cleaned to the step's own precision. */
function roundToStep(value, step) {
  if (!isPosNumber(step)) return value;
  var raw = Math.round(value / step) * step;
  return parseFloat(raw.toFixed(decimalsOf(step)));
}

/* Wildcard symbol mask: "*" matches any sequence (case-sensitive). */
function matchSymbolMask(symbol, mask) {
  if (mask == null || mask === "" || mask === "*") return true;
  var re = "^" + String(mask).split("*").map(function (part) {
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join(".*") + "$";
  return new RegExp(re).test(String(symbol));
}

function positionTicket(p) {
  if (p.ticket !== undefined && p.ticket !== null) return p.ticket;
  return p.id;
}

/* Keep only positions matching the symbol mask and optional group filter. */
function filterPositions(positions, opts) {
  opts = opts || {};
  var mask = opts.symbolMask == null ? "*" : opts.symbolMask;
  var group = opts.group;
  return (positions || []).filter(function (p) {
    if (!matchSymbolMask(p.symbol, mask)) return false;
    if (group !== undefined && group !== null && group !== "" && p.group !== group) return false;
    return true;
  });
}

/* Resolve the close price for a position from closePrices.
 * closePrices[symbol] may be a plain number (used for both directions) or
 * {bid, ask} (buy positions close at bid, sell positions at ask).
 * Returns null when no price is available. */
function resolveClosePrice(position, closePrices) {
  var entry = (closePrices || {})[position.symbol];
  if (entry == null) return null;
  if (typeof entry === "number") return entry;
  if (position.direction === "sell" && entry.ask != null) return entry.ask;
  if (entry.bid != null) return entry.bid;
  return null;
}

/* Estimated closing P/L for one position.
 * profit = sign * (closePrice - openPrice) * volume * contractSize
 * (positive contractSize defaults to 1; this is an ESTIMATE for preview). */
function estimateCloseProfit(position, closePrice, contractSize) {
  if (!isFiniteNum(closePrice) || !isFiniteNum(position.open_price) ||
      !isFiniteNum(position.volume)) return null;
  var cs = isPosNumber(contractSize) ? contractSize : 1;
  var sign = position.direction === "sell" ? -1 : 1;
  /* round to 2 decimals: money values in audit records must not carry
   * floating-point noise. */
  return parseFloat((sign * (closePrice - position.open_price) *
    position.volume * cs).toFixed(2));
}

/* One audit item: who / what / when per operated position. */
function auditItem(o) {
  return {
    ticket: o.ticket,
    position_id: o.position_id,
    login: o.login !== undefined ? o.login : null,
    symbol: o.symbol,
    direction: o.direction || null,
    volume: o.volume,
    action: o.action,          /* what */
    actor: o.actor,            /* who */
    at: o.at,                 /* when (ISO) */
    status: o.status,
    reason: o.reason || null,
    detail: o.detail || null
  };
}

/* Top-level audit entry summarizing a run. */
function auditEntry(opType, mode, actor, at, items, totals) {
  var okCount = 0, skipCount = 0;
  items.forEach(function (it) {
    if (it.status === "skipped" || it.status === "error") skipCount++; else okCount++;
  });
  return {
    op_id: newOpId(),
    op_type: opType,
    mode: mode,
    actor: actor || null,
    at: at,
    item_count: items.length,
    success_count: okCount,
    skipped_count: skipCount,
    totals: totals || {},
    items: items
  };
}

/* ---------------- 1. bulk close ---------------- */

function buildBulkClose(positions, opts, execute) {
  opts = opts || {};
  var mode = execute ? "execute" : "preview";
  var actor = opts.actor || null;
  var at = utcNow(opts.atMs);
  var closePrices = opts.closePrices || {};
  var contractSizes = opts.contractSizes || {};
  var reason = opts.reason || "Bulk Close";

  var matched = filterPositions(positions, opts);
  var items = [];
  var closedIds = {};
  var totalProfit = 0;

  matched.forEach(function (p) {
    var ticket = positionTicket(p);
    var closePrice = resolveClosePrice(p, closePrices);
    if (closePrice == null) {
      items.push(auditItem({
        ticket: ticket, position_id: p.id,
        login: p.login !== undefined ? p.login : (p.account !== undefined ? p.account : null),
        symbol: p.symbol, direction: p.direction, volume: p.volume,
        action: mode === "execute" ? "close" : "preview_close",
        actor: actor, at: at, status: "skipped",
        reason: reason,
        detail: { error: "no close price available for symbol" }
      }));
      return;
    }
    var profit = estimateCloseProfit(p, closePrice, contractSizes[p.symbol]);
    totalProfit += (profit == null ? 0 : profit);
    items.push(auditItem({
      ticket: ticket, position_id: p.id,
      login: p.login !== undefined ? p.login : (p.account !== undefined ? p.account : null),
      symbol: p.symbol, direction: p.direction, volume: p.volume,
      action: mode === "execute" ? "close" : "preview_close",
      actor: actor, at: at,
      status: execute ? "closed" : "will_close",
      reason: reason,
      detail: {
        open_price: p.open_price,
        close_price: closePrice,
        estimated_profit: profit,
        closed_at: execute ? at : null
      }
    }));
    if (execute) closedIds[p.id] = true;
  });

  var remaining = execute
    ? (positions || []).filter(function (p) { return !closedIds[p.id]; })
    : (positions || []).slice();

  var audit = auditEntry("bulk_close", mode, actor, at, items,
    { total_estimated_profit: totalProfit });

  return {
    op: "bulk_close",
    mode: mode,
    actor: actor,
    at: at,
    items: items,
    matched_count: matched.length,
    closed_count: execute ? audit.success_count : 0,
    total_estimated_profit: totalProfit,
    positions: remaining,
    mutated: false,
    audit: audit
  };
}

function bulkClosePreview(positions, opts) { return buildBulkClose(positions, opts, false); }
function bulkCloseExecute(positions, opts) { return buildBulkClose(positions, opts, true); }

/* ---------------- 2. position splits ---------------- */

function splitRatioLabel(num, den) { return num + ":" + den; }

function applySplit(positions, ticket, opts) {
  opts = opts || {};
  var actor = opts.actor || null;
  var at = utcNow(opts.atMs);
  var num = opts.ratioNum;
  var den = opts.ratioDen;

  function failItem(error) {
    var item = auditItem({
      ticket: ticket, position_id: null, login: null, symbol: null,
      direction: null, volume: null, action: "split",
      actor: actor, at: at, status: "error", reason: "Split",
      detail: { error: error }
    });
    return {
      ok: false, error: error, positions: (positions || []).slice(),
      items: [item],
      audit: auditEntry("position_split", "execute", actor, at, [item], {})
    };
  }

  if (!isPosNumber(num) || !isPosNumber(den)) {
    return failItem("split ratio must be two positive numbers (ratioNum, ratioDen)");
  }
  var list = positions || [];
  var idx = -1;
  for (var i = 0; i < list.length; i++) {
    if (positionTicket(list[i]) === ticket) { idx = i; break; }
  }
  if (idx < 0) return failItem("position not found for ticket: " + ticket);

  var orig = clonePosition(list[idx]);
  var origTicket = positionTicket(orig);
  var specs = (opts.symbolSpecs || {})[orig.symbol] || {};
  var step = isPosNumber(specs.volume_step) ? specs.volume_step : 0.01;
  var volMin = isPosNumber(specs.volume_min) ? specs.volume_min : 0;
  var volMax = isPosNumber(specs.volume_max) ? specs.volume_max : 0;
  var ratio = num / den;

  var newVolume = roundToStep(orig.volume * ratio, step);
  var newPrice = orig.open_price * (den / num);
  if (isPosNumber(specs.tick_size)) {
    newPrice = parseFloat(newPrice.toFixed(decimalsOf(specs.tick_size)));
  } else {
    newPrice = parseFloat(newPrice.toFixed(8));
  }

  if (!(newVolume > 0)) {
    return failItem("split produces non-positive volume (" + newVolume +
      ") after rounding to step " + step);
  }
  if (volMin > 0 && newVolume < volMin - 1e-9) {
    return failItem("split volume " + newVolume + " is below symbol volume_min " + volMin);
  }
  if (volMax > 0 && newVolume > volMax + 1e-9) {
    return failItem("split volume " + newVolume + " exceeds symbol volume_max " + volMax);
  }

  /* close + reopen with reason "Split"; original ticket preserved as a link
   * on the new position. */
  var closed = auditItem({
    ticket: origTicket, position_id: orig.id,
    login: orig.login !== undefined ? orig.login : (orig.account !== undefined ? orig.account : null),
    symbol: orig.symbol, direction: orig.direction, volume: orig.volume,
    action: "close", actor: actor, at: at, status: "closed", reason: "Split",
    detail: {
      open_price: orig.open_price, close_price: orig.open_price,
      split_ratio: splitRatioLabel(num, den), closed_at: at
    }
  });

  var np = clonePosition(orig);
  delete np.ticket; /* new ticket below; original kept as split_from_ticket */
  np.id = newPosId();
  np.volume = newVolume;
  np.open_price = newPrice;
  np.reason = "Split";
  np.split_ratio = splitRatioLabel(num, den);
  np.split_from_ticket = origTicket;
  np.split_at = at;
  np.split_by = actor;

  var reopened = auditItem({
    ticket: np.id, position_id: np.id,
    login: np.login !== undefined ? np.login : (np.account !== undefined ? np.account : null),
    symbol: np.symbol, direction: np.direction, volume: np.volume,
    action: "reopen", actor: actor, at: at, status: "opened", reason: "Split",
    detail: {
      open_price: np.open_price, split_ratio: splitRatioLabel(num, den),
      split_from_ticket: origTicket
    }
  });

  var items = [closed, reopened];
  var out = list.slice();
  out[idx] = np;

  return {
    ok: true,
    closed: closed,
    newPosition: np,
    positions: out,
    items: items,
    audit: auditEntry("position_split", "execute", actor, at, items, {
      split_ratio: splitRatioLabel(num, den),
      original_ticket: origTicket,
      new_volume: newVolume,
      new_open_price: newPrice
    })
  };
}

/* ---------------- 3. bulk payments (dividends / tax credits) ---------------- */

var PAYMENT_KINDS = ["dividend", "tax_credit"];

/* Dividends: longs receive (+), shorts pay (-).
 * Tax credits: always a positive credit to the account. */
function paymentAmount(kind, direction, volume, perLotAmount) {
  var base = volume * perLotAmount;
  if (kind === "dividend" && direction === "sell") return -base;
  return base;
}

function buildBulkPayments(positions, opts, execute) {
  opts = opts || {};
  var mode = execute ? "execute" : "preview";
  var kind = opts.kind || "dividend";
  var actor = opts.actor || null;
  var at = utcNow(opts.atMs);

  if (PAYMENT_KINDS.indexOf(kind) < 0) {
    return {
      ok: false, error: "unknown payment kind: " + kind +
        " (expected dividend | tax_credit)",
      mode: mode, items: [], balance_operations: []
    };
  }
  var perLot = opts.perLotAmount;
  if (!isFiniteNum(perLot) || perLot === 0) {
    return {
      ok: false, error: "perLotAmount must be a non-zero finite number",
      mode: mode, items: [], balance_operations: []
    };
  }

  var currency = opts.currency || null;
  var settlementDate = opts.settlementDate || null;
  var matched = filterPositions(positions, opts);
  var items = [];
  var ops = [];
  var total = 0;

  matched.forEach(function (p) {
    var ticket = positionTicket(p);
    var login = p.login !== undefined ? p.login : (p.account !== undefined ? p.account : null);
    if (login == null) {
      items.push(auditItem({
        ticket: ticket, position_id: p.id, login: null,
        symbol: p.symbol, direction: p.direction, volume: p.volume,
        action: mode === "execute" ? "post_payment" : "preview_payment",
        actor: actor, at: at, status: "skipped", reason: kind,
        detail: { error: "position has no login/account" }
      }));
      return;
    }
    var amount = paymentAmount(kind, p.direction, p.volume, perLot);
    total += amount;
    var op = {
      kind: kind,
      target: "balance",
      amount: amount,
      currency: currency,
      login: login,
      symbol: p.symbol,
      position_ticket: ticket,
      position_id: p.id,
      direction: p.direction,
      volume: p.volume,
      per_lot_amount: perLot,
      settlement_date: settlementDate,
      status: execute ? "posted" : "preview",
      comment: (kind === "dividend" ? "Dividend" : "Tax credit") +
        " @ " + perLot + "/lot" + (settlementDate ? ", settled " + settlementDate : ""),
      actor: actor,
      created_at: at
    };
    ops.push(op);
    items.push(auditItem({
      ticket: ticket, position_id: p.id, login: login,
      symbol: p.symbol, direction: p.direction, volume: p.volume,
      action: mode === "execute" ? "post_payment" : "preview_payment",
      actor: actor, at: at,
      status: execute ? "posted" : "will_post",
      reason: kind,
      detail: {
        per_lot_amount: perLot, amount: amount,
        currency: currency, settlement_date: settlementDate
      }
    }));
  });

  var audit = auditEntry("bulk_payment_" + kind, mode, actor, at, items,
    { total_amount: total });

  return {
    ok: true,
    op: "bulk_payments",
    kind: kind,
    mode: mode,
    actor: actor,
    at: at,
    items: items,
    balance_operations: ops,
    matched_count: matched.length,
    posted_count: execute ? audit.success_count : 0,
    total_amount: total,
    mutated: false,
    audit: audit
  };
}

function bulkPaymentsPreview(positions, opts) { return buildBulkPayments(positions, opts, false); }
function bulkPayments(positions, opts) { return buildBulkPayments(positions, opts, true); }

var CorporateActions = {
  PAYMENT_KINDS: PAYMENT_KINDS,
  matchSymbolMask: matchSymbolMask,
  filterPositions: filterPositions,
  roundToStep: roundToStep,
  estimateCloseProfit: estimateCloseProfit,
  splitRatioLabel: splitRatioLabel,
  bulkClosePreview: bulkClosePreview,
  bulkCloseExecute: bulkCloseExecute,
  applySplit: applySplit,
  bulkPaymentsPreview: bulkPaymentsPreview,
  bulkPayments: bulkPayments,
  auditEntry: auditEntry
};

if (typeof module !== "undefined" && module.exports) { module.exports = CorporateActions; }
else { root.OrbitCorporateActions = CorporateActions; }

})(typeof globalThis !== "undefined" ? globalThis : this);
