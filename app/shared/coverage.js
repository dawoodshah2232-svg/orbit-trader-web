/* shared/coverage.js — OrbitTrader coverage (hedging) workflow.
 *
 * The broker can hold its own hedge positions in dedicated "coverage"
 * accounts, inside account groups whose name marks them as coverage
 * (see shared/groups.js: the case-sensitive substring "coverage").
 * Coverage accounts never serve real clients; their positions exist to
 * offset (cover) the broker's net exposure on client positions.
 *
 * This module is pure logic: no globals, no DOM, no vendor branding.
 * It runs in the browser and in node (guarded export at the bottom,
 * same pattern as shared/groups.js and shared/positions.js).
 *
 * Shapes used here:
 *   Position : {id, symbol, direction:"buy"|"sell", volume, open_price,
 *               swap?, commission?}           (same as shared/positions.js)
 *   Quote    : {bid, ask}                     current prices per symbol
 *   SymbolMeta : {symbol: {baseCurrency, profitCurrency, contractSize,
 *                         tickValue}}
 *     contractSize = trade units per 1.0 volume (default 1)
 *     tickValue    = profit-currency value of a 1.0 price move per 1.0
 *                    volume (default 1)
 *
 * Functions:
 *   isCoverageGroup(group)        -> boolean
 *   coverageAccountRoles()        -> ["coverage_account","external_trade_account"]
 *   summarizePositions(pos, q)    -> per-symbol client summary rows
 *   computeUncovered(cl, cov)     -> per-symbol {client_net, coverage_net, uncovered}
 *   coverageSummary(cl, cov, q)   -> summary rows + coverage fields + uncovered
 *   exposureByCurrency(cl, cov, meta, quotes) -> {base, profit} per-currency tables
 *   createCoverageSetup(parts)    -> {ok, setup?|errors}
 *   validateCoverageSetup(parts)  -> array of error strings (empty = valid)
 */
(function (root) {
"use strict";

var EPS = 1e-9;

function isPosNumber(x) { return typeof x === "number" && isFinite(x) && x > EPS; }

function noop(x) { return x; }


/* ---- 1. coverage groups & accounts ---- */

/* A group is a coverage group when its name marks it so: the
 * case-sensitive substring "coverage", same convention as
 * groups.js deriveGroupType(). An optional explicit type overrides the
 * name when present (e.g. {type:"coverage"}).
 */
function isCoverageGroup(group) {
  if (!group || typeof group !== "object") return false;
  if (typeof group.type === "string" && group.type === "coverage") return true;
  if (typeof group.name === "string" && group.name.indexOf("coverage") !== -1) return true;
  return false;
}

/* The two account roles in a covering workflow. */
function coverageAccountRoles() {
  return ["coverage_account", "external_trade_account"];
}

/* Internal account = holds the broker's own hedge positions, must sit in a
 * coverage group. External trade account = the account held at the
 * liquidity venue / counterparty the gateway routes to. */
function validateCoverageAccountLink(account, group) {
  var errs = [];
  if (!account || typeof account !== "object") { errs.push("coverage account must be an object"); return errs; }
  if (typeof account.login !== "string" || account.login === "")
    errs.push("coverage account must have a non-empty login");
  if (!isCoverageGroup(group))
    errs.push("coverage account must belong to a coverage group");
  return errs;
}

/* ---- 2. per-symbol summary ---- */

function groupBySymbol(positions) {
  var map = {};
  (positions || []).forEach(function (p) {
    if (!p || typeof p.symbol !== "string") return;
    if (p.direction !== "buy" && p.direction !== "sell") return;
    if (!isPosNumber(p.volume)) return;
    if (typeof p.open_price !== "number" || !isFinite(p.open_price)) return;
    if (!map[p.symbol]) map[p.symbol] = [];
    map[p.symbol].push(p);
  });
  return map;
}

function exitPrice(direction, quote) {
  /* Buys close at bid, sells close at ask — the floating value of a
   * position is computed off the price it would unwind at. */
  if (!quote) return null;
  if (direction === "buy") return quote.bid;
  if (direction === "sell") return quote.ask;
  return null;
}

function tickValueFor(meta, symbol) {
  if (meta && meta[symbol] && isPosNumber(meta[symbol].tickValue)) return meta[symbol].tickValue;
  return 1;
}

/* floatingProfit(positions, quotes, meta) -> total in profit-currency units. */
function floatingProfit(positions, quotes, meta) {
  var total = 0;
  (positions || []).forEach(function (p) {
    if (!p || typeof p.symbol !== "string") return;
    if (p.direction !== "buy" && p.direction !== "sell") return;
    if (!isPosNumber(p.volume)) return;
    var q = quotes ? quotes[p.symbol] : null;
    var exit = exitPrice(p.direction, q);
    if (exit === null || !isFinite(exit)) return;
    var sign = p.direction === "buy" ? 1 : -1;
    total += sign * (exit - p.open_price) * p.volume * tickValueFor(meta, p.symbol);
  });
  return total;
}

/* summarizePositions(positions, quotes?, meta?) ->
 * [{symbol, position_count, buy_volume, sell_volume,
 *   buy_avg_price, sell_avg_price, net_volume, floating_profit}]
 * buy_avg_price / sell_avg_price are null when that side has no volume.
 * Rows are sorted by symbol. */
function summarizePositions(positions, quotes, meta) {
  var bySym = groupBySymbol(positions);
  var rows = [];
  Object.keys(bySym).forEach(function (sym) {
    var list = bySym[sym];
    var buyVol = 0, sellVol = 0, buyPx = 0, sellPx = 0;
    list.forEach(function (p) {
      if (p.direction === "buy") { buyVol += p.volume; buyPx += p.volume * p.open_price; }
      else { sellVol += p.volume; sellPx += p.volume * p.open_price; }
    });
    rows.push({
      symbol: sym,
      position_count: list.length,
      buy_volume: noop(buyVol),
      sell_volume: noop(sellVol),
      buy_avg_price: buyVol > EPS ? noop(buyPx / buyVol) : null,
      sell_avg_price: sellVol > EPS ? noop(sellPx / sellVol) : null,
      net_volume: noop(buyVol - sellVol),
      floating_profit: noop(floatingProfit(list, quotes || {}, meta || {}))
    });
  });
  rows.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
  return rows;
}

/* ---- 3. uncovered volume ---- */

/* netPerSymbol(positions) -> {symbol: signed net volume} (buy - sell). */
function netPerSymbol(positions) {
  var net = {};
  var bySym = groupBySymbol(positions);
  Object.keys(bySym).forEach(function (sym) {
    var n = 0;
    bySym[sym].forEach(function (p) {
      n += (p.direction === "buy" ? 1 : -1) * p.volume;
    });
    net[sym] = n;
  });
  return net;
}

/* computeUncovered(clientPositions, coveragePositions) ->
 * [{symbol, client_net, coverage_net, uncovered}]
 * uncovered = client_net - coverage_net (signed):
 *   positive = the broker still carries long client risk,
 *   negative = the broker is over-hedged (short bias),
 *   zero     = fully covered.
 * Sorted by symbol. Symbols present on only one side still appear. */
function computeUncovered(clientPositions, coveragePositions) {
  var c = netPerSymbol(clientPositions);
  var h = netPerSymbol(coveragePositions);
  var seen = {};
  [c, h].forEach(function (m) { Object.keys(m).forEach(function (s) { seen[s] = true; }); });
  var rows = [];
  Object.keys(seen).forEach(function (sym) {
    var cn = c[sym] || 0, hn = h[sym] || 0;
    rows.push({
      symbol: sym,
      client_net: noop(cn),
      coverage_net: noop(hn),
      uncovered: noop(cn - hn)
    });
  });
  rows.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
  return rows;
}

/* coverageSummary(clientPositions, coveragePositions, quotes?, meta?) ->
 * full per-symbol row: summary + coverage_net + uncovered. */
function coverageSummary(clientPositions, coveragePositions, quotes, meta) {
  var summary = summarizePositions(clientPositions, quotes, meta);
  var h = netPerSymbol(coveragePositions);
  var seen = {};
  summary.forEach(function (r) {
    seen[r.symbol] = true;
    var hn = h[r.symbol] || 0;
    r.coverage_net = noop(hn);
    r.uncovered = noop(r.net_volume - hn);
  });
  /* Symbols that exist only in the coverage book. */
  Object.keys(h).forEach(function (sym) {
    if (seen[sym]) return;
    var hn = h[sym];
    summary.push({
      symbol: sym,
      position_count: 0,
      buy_volume: 0,
      sell_volume: 0,
      buy_avg_price: null,
      sell_avg_price: null,
      net_volume: 0,
      floating_profit: 0,
      coverage_net: noop(hn),
      uncovered: noop(0 - hn)
    });
  });
  summary.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
  return summary;
}

/* ---- 4. exposure by currency ---- */

/* exposureByCurrency(clientPositions, coveragePositions, meta, quotes?) ->
 *   { base:   [{currency, client, coverage, residual}],
 *     profit: [{currency, client, coverage, residual}] }
 * base   : signed notional in base currency  = sign*volume*open_price*contractSize
 * profit : floating profit in profit currency (needs quotes; 0 without)
 * residual = client - coverage. contractSize defaults to 1. Symbols missing
 * from meta are skipped (cannot place them in a currency). */
function exposureByCurrency(clientPositions, coveragePositions, meta, quotes) {
  function side(positions) {
    var acc = {};
    var bySym = groupBySymbol(positions);
    Object.keys(bySym).forEach(function (sym) {
      var m = meta && meta[sym];
      if (!m || typeof m !== "object") return;
      var size = isPosNumber(m.contractSize) ? m.contractSize : 1;
      bySym[sym].forEach(function (p) {
        var sign = p.direction === "buy" ? 1 : -1;
        if (typeof m.baseCurrency === "string") {
          var b = acc["base|" + m.baseCurrency] || 0;
          acc["base|" + m.baseCurrency] = b + sign * p.volume * p.open_price * size;
        }
        if (typeof m.profitCurrency === "string") {
          var q = quotes ? quotes[sym] : null;
          var exit = exitPrice(p.direction, q);
          if (exit !== null && isFinite(exit)) {
            var k = "profit|" + m.profitCurrency;
            var cur = acc[k] || 0;
            acc[k] = cur + sign * (exit - p.open_price) * p.volume * tickValueFor(meta, sym);
          }
        }
      });
    });
    return acc;
  }

  var c = side(clientPositions);
  var h = side(coveragePositions);
  var keys = {};
  [c, h].forEach(function (m) { Object.keys(m).forEach(function (k) { keys[k] = true; }); });

  var base = [], profit = [];
  Object.keys(keys).forEach(function (k) {
    var parts = k.split("|");
    var row = {
      currency: parts[1],
      client: noop(c[k] || 0),
      coverage: noop(h[k] || 0),
      residual: noop((c[k] || 0) - (h[k] || 0))
    };
    if (parts[0] === "base") base.push(row); else profit.push(row);
  });
  function byCur(a, b) { return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0; }
  base.sort(byCur); profit.sort(byCur);
  return { base: base, profit: profit };
}

/* ---- 5. covering workflow ---- */

/* createCoverageSetup parts:
 *   coverageGroup    {name, type?}              — must mark a coverage group
 *   coverageAccount  {login}                    — internal hedge account
 *   externalAccount  {login, venue?}            — account at the liquidity venue
 *   gateway          {name, enabled}            — routing gateway, must be enabled
 *   routingRule      {name, gateway, symbolMask?} — binds symbols to the gateway
 *
 * The routing rule must name THIS setup's gateway (rule.gateway === gateway.name)
 * so the coverage flow is unambiguous: coverage account -> rule -> gateway
 * -> external account. Returns {ok:true, setup} or {ok:false, errors}. */
function validateCoverageSetup(parts) {
  var errs = [];
  var p = (parts && typeof parts === "object") ? parts : {};

  if (!isCoverageGroup(p.coverageGroup))
    errs.push("coverageGroup must be a coverage group (name containing \"coverage\")");

  errs = errs.concat(validateCoverageAccountLink(p.coverageAccount, p.coverageGroup));

  if (!p.externalAccount || typeof p.externalAccount !== "object") {
    errs.push("externalAccount must be an object");
  } else if (typeof p.externalAccount.login !== "string" || p.externalAccount.login === "") {
    errs.push("externalAccount must have a non-empty login");
  }

  if (!p.gateway || typeof p.gateway !== "object") {
    errs.push("gateway must be an object");
  } else {
    if (typeof p.gateway.name !== "string" || p.gateway.name === "")
      errs.push("gateway must have a non-empty name");
    if (p.gateway.enabled !== true)
      errs.push("gateway must be enabled to cover through it");
  }

  if (!p.routingRule || typeof p.routingRule !== "object") {
    errs.push("routingRule must be an object");
  } else {
    if (typeof p.routingRule.name !== "string" || p.routingRule.name === "")
      errs.push("routingRule must have a non-empty name");
    if (p.gateway && typeof p.gateway.name === "string" && p.gateway.name !== "" &&
        p.routingRule.gateway !== p.gateway.name)
      errs.push("routingRule.gateway must match gateway.name (\"" + p.gateway.name + "\")");
    if (p.routingRule.symbolMask !== undefined &&
        typeof p.routingRule.symbolMask !== "string")
      errs.push("routingRule.symbolMask must be a string when provided");
  }

  return errs;
}

var _setupSeq = 1;

function createCoverageSetup(parts) {
  var errs = validateCoverageSetup(parts);
  if (errs.length > 0) return { ok: false, errors: errs };
  var setup = {
    id: "cov_" + (_setupSeq++),
    coverage_group: parts.coverageGroup.name,
    coverage_account: parts.coverageAccount.login,
    external_account: parts.externalAccount.login,
    external_venue: parts.externalAccount.venue || null,
    gateway: parts.gateway.name,
    routing_rule: parts.routingRule.name,
    symbol_mask: parts.routingRule.symbolMask || "*",
    created_at: new Date().toISOString()
  };
  return { ok: true, setup: setup };
}

var Coverage = {
  isCoverageGroup: isCoverageGroup,
  coverageAccountRoles: coverageAccountRoles,
  validateCoverageAccountLink: validateCoverageAccountLink,
  summarizePositions: summarizePositions,
  netPerSymbol: netPerSymbol,
  floatingProfit: floatingProfit,
  computeUncovered: computeUncovered,
  coverageSummary: coverageSummary,
  exposureByCurrency: exposureByCurrency,
  validateCoverageSetup: validateCoverageSetup,
  createCoverageSetup: createCoverageSetup
};

if (typeof module !== "undefined" && module.exports) { module.exports = Coverage; }
else { root.OrbitCoverage = Coverage; }
})(typeof globalThis !== "undefined" ? globalThis : this);
