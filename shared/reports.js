/* shared/reports.js — OrbitTrader reporting engine.
 *
 * Independent implementation of a broker back-office reporting engine:
 * a catalog of standard report definitions (each with name, purpose and
 * parameters), per-manager report availability, daily/monthly scheduling,
 * and a custom-report plugin hook for registering extra generators.
 *
 * Pure functions, no globals, no DOM: runs in the browser and in node
 * (guarded export at the bottom, same pattern as shared/groups.js).
 *
 * Model:
 *   - A report DEFINITION is {id, name, purpose, category, params,
 *     defaultSchedule, generate}. `params` is an array of parameter
 *     descriptors {name, type, required, default?, description}.
 *     Parameter types: 'date' (YYYY-MM-DD), 'datetime' (ISO 8601),
 *     'string', 'number', 'login' (non-empty string), 'string[]'.
 *   - A generator receives {params, data, manager} and returns
 *     {columns: [{key, label}], rows: [ {...} ]}. `data` is an injected
 *     store shaped as documented in docs/REPORTS.md — the engine never
 *     invents broker values; with no data the reports come back empty.
 *   - Managers run reports only through rights: manager.reportRights may
 *     hold '*', 'reports.<category>.*' or 'reports.<report-id>'. Group
 *     scoping narrows params.groups to the manager's supervised groups.
 *   - Schedules are daily or monthly, firing at a UTC wall-clock time.
 *   - Custom reports register into a registry; built-in ids are protected
 *     from override and removal. createRegistry() gives an isolated
 *     registry (tests); the module also keeps one shared default registry.
 *
 * All timestamps are UTC. Dates are YYYY-MM-DD, datetimes ISO 8601.
 */
(function (root) {
"use strict";

var REPORT_CATEGORIES = [
  "trading", "risk", "execution", "operations", "finance", "regulatory", "growth"
];

var SCHEDULE_RECURRENCES = ["daily", "monthly"];

var PARAM_TYPES = ["date", "datetime", "string", "number", "login", "string[]"];

var ID_RE = /^[a-z0-9][a-z0-9_]*$/;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---- small UTC helpers ---- */
function pad2(n) { return (n < 10 ? "0" : "") + n; }

function toDayUTC(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}
function toMonthUTC(ms) { return toDayUTC(ms).slice(0, 7); }

function dayStartUTC(dayStr) { return Date.parse(dayStr + "T00:00:00Z"); }
function dayEndExclusiveUTC(dayStr) { return dayStartUTC(dayStr) + 86400000; }

function isValidDay(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  var t = dayStartUTC(s);
  return !isNaN(t) && toDayUTC(t) === s; /* rejects 2026-02-30 etc. */
}
function isValidDatetime(s) {
  return typeof s === "string" && !isNaN(Date.parse(s));
}

function inGroups(rowGroup, groups) {
  if (!groups || groups.length === 0) return true;
  return groups.indexOf(rowGroup) !== -1;
}
function inSymbols(rowSymbol, symbols) {
  if (!symbols || symbols.length === 0) return true;
  return symbols.indexOf(rowSymbol) !== -1;
}
function inLogins(rowLogin, logins) {
  if (!logins || logins.length === 0) return true;
  return logins.indexOf(rowLogin) !== -1;
}

function num(v, dflt) {
  var n = +v;
  return isFinite(n) ? n : (dflt || 0);
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  var idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  if (idx < 0) idx = 0;
  return sortedAsc[Math.min(idx, sortedAsc.length - 1)];
}

function addMonths(monthStr, k) {
  var y = +monthStr.slice(0, 4), m = +monthStr.slice(5, 7) - 1 + k;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return y + "-" + pad2(m + 1);
}

function daysInMonthUTC(y, m0) { /* m0: 0-based */
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/* ---- parameter validation ----
 * Returns an array of error strings (empty = valid). Unknown parameter
 * names are rejected so typos fail loudly instead of being ignored. */
function validateParams(def, params) {
  var errs = [];
  if (!def || !Array.isArray(def.params)) return ["report definition has no params list"];
  if (!params || typeof params !== "object" || Array.isArray(params))
    return ["params must be an object"];
  var known = {};
  def.params.forEach(function (p) {
    known[p.name] = p;
    var v = params[p.name];
    var missing = (v === undefined || v === null || v === "");
    if (missing) {
      if (p.required) errs.push("missing required param '" + p.name + "'");
      return;
    }
    switch (p.type) {
      case "date":
        if (!isValidDay(v)) errs.push("param '" + p.name + "' must be a valid YYYY-MM-DD date");
        break;
      case "datetime":
        if (!isValidDatetime(v)) errs.push("param '" + p.name + "' must be a valid ISO 8601 datetime");
        break;
      case "string":
        if (typeof v !== "string") errs.push("param '" + p.name + "' must be a string");
        break;
      case "login":
        if (typeof v !== "string" || v === "") errs.push("param '" + p.name + "' must be a non-empty login");
        break;
      case "number":
        if (typeof v !== "number" || !isFinite(v)) errs.push("param '" + p.name + "' must be a finite number");
        break;
      case "string[]":
        if (!Array.isArray(v) || v.some(function (x) { return typeof x !== "string"; }))
          errs.push("param '" + p.name + "' must be an array of strings");
        break;
      default:
        errs.push("param '" + p.name + "' has unknown type '" + p.type + "'");
    }
  });
  Object.keys(params).forEach(function (k) {
    if (!known[k]) errs.push("unknown param '" + k + "'");
  });
  return errs;
}

/* Returns a copy of params with each descriptor's default applied where
 * the caller left the value missing. */
function applyParamDefaults(def, params) {
  var out = {};
  Object.keys(params || {}).forEach(function (k) { out[k] = params[k]; });
  (def.params || []).forEach(function (p) {
    var v = out[p.name];
    if ((v === undefined || v === null || v === "") && p.default !== undefined) out[p.name] = p.default;
  });
  return out;
}

/* ---- report definition validation ---- */
function validateReportDef(def) {
  var errs = [];
  function err(m) { errs.push(m); }
  if (!def || typeof def !== "object" || Array.isArray(def)) return ["report definition must be an object"];
  if (typeof def.id !== "string" || !ID_RE.test(def.id))
    err("id must be a slug: lowercase letters, digits, underscores");
  if (typeof def.name !== "string" || def.name.trim() === "") err("name must be a non-empty string");
  if (typeof def.purpose !== "string" || def.purpose.trim() === "") err("purpose must be a non-empty string");
  if (REPORT_CATEGORIES.indexOf(def.category) === -1)
    err("category must be one of: " + REPORT_CATEGORIES.join(", "));
  if (!Array.isArray(def.params)) {
    err("params must be an array");
  } else {
    var seen = {};
    def.params.forEach(function (p, i) {
      var where = "params[" + i + "]";
      if (!p || typeof p !== "object") { err(where + " must be an object"); return; }
      if (typeof p.name !== "string" || !ID_RE.test(p.name)) err(where + ".name must be a slug");
      else if (seen[p.name]) err(where + ".name duplicates '" + p.name + "'");
      else seen[p.name] = true;
      if (PARAM_TYPES.indexOf(p.type) === -1) err(where + ".type must be one of: " + PARAM_TYPES.join(", "));
      if (typeof p.required !== "boolean") err(where + ".required must be a boolean");
      if (typeof p.description !== "string" || p.description.trim() === "")
        err(where + ".description must be a non-empty string");
      if (p.default !== undefined && p.required) err(where + ": a required param must not carry a default");
    });
  }
  if (def.defaultSchedule !== null && def.defaultSchedule !== undefined &&
      SCHEDULE_RECURRENCES.indexOf(def.defaultSchedule) === -1)
    err("defaultSchedule must be null or one of: " + SCHEDULE_RECURRENCES.join(", "));
  if (typeof def.generate !== "function") err("generate must be a function");
  return errs;
}

/* ---- built-in report generators ----
 * Each takes {params, data, manager} and returns {columns, rows}.
 * Data collections used (all optional; missing collections read as empty):
 *   deals:         {id, login, group, symbol, side('buy'|'sell'), volume,
 *                   openPrice, closePrice, profit, commission, swap,
 *                   openTime, closeTime} — times are UTC ms
 *   positions:     {login, group, symbol, side, volume, openPrice,
 *                   currentPrice, floatingPl}
 *   balanceOps:    {id, login, group, type, amount, currency, time, comment}
 *                   type in deposit|withdrawal|transfer_in|transfer_out|
 *                   charge|correction|bonus|interest|stopout_coverage|
 *                   commission|dividend|tax. amount is SIGNED: positive
 *                   credits the account, negative debits it.
 *   marginEvents:  {login, group, level, equity, margin, time}
 *   coverage:      {symbol, retainedVolume, hedgedVolume, asOf}
 *   orders:        {id, login, symbol, requestedAt, filledAt, volume,
 *                   side, price} — times are UTC ms
 *   markouts:      {dealId, symbol, side, execPrice, laterPrice, minutes}
 *   accounts:      {login, group, country, createdAt, firstDepositAt,
 *                   firstTradeAt, status} — times are UTC ms
 *   portfolios:    {login, group, balance, equity, margin, openPositions,
 *                   asOfDay} — asOfDay is YYYY-MM-DD (EOD snapshot input)
 */

function genDailyTradingDigest(ctx) {
  var p = ctx.params, d = ctx.data;
  var deals = (d.deals || []).filter(function (x) {
    var t = x.closeTime != null ? x.closeTime : x.openTime;
    return toDayUTC(t) === p.date && inGroups(x.group, p.groups) && inSymbols(x.symbol, p.symbols);
  });
  var bySymbol = {};
  deals.forEach(function (x) {
    var a = bySymbol[x.symbol] || (bySymbol[x.symbol] = {
      symbol: x.symbol, deals: 0, volume: 0, gross_profit: 0, commission: 0, swap: 0
    });
    a.deals += 1;
    a.volume += num(x.volume);
    a.gross_profit += num(x.profit);
    a.commission += num(x.commission);
    a.swap += num(x.swap);
  });
  var rows = Object.keys(bySymbol).sort().map(function (s) {
    var a = bySymbol[s];
    a.net_profit = a.gross_profit - a.commission + a.swap;
    return a;
  });
  return {
    columns: [
      { key: "symbol", label: "Symbol" }, { key: "deals", label: "Deals" },
      { key: "volume", label: "Volume" }, { key: "gross_profit", label: "Gross P/L" },
      { key: "commission", label: "Commission" }, { key: "swap", label: "Swap" },
      { key: "net_profit", label: "Net P/L" }
    ],
    rows: rows
  };
}

function genTradeDetailLedger(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var rows = (d.deals || []).filter(function (x) {
    var t = x.closeTime != null ? x.closeTime : x.openTime;
    return t >= from && t < to && inLogins(x.login, p.logins) &&
      inGroups(x.group, p.groups) && inSymbols(x.symbol, p.symbols);
  }).map(function (x) {
    return {
      id: x.id, login: x.login, group: x.group, symbol: x.symbol, side: x.side,
      volume: num(x.volume), open_price: num(x.openPrice), close_price: num(x.closePrice),
      profit: num(x.profit), commission: num(x.commission), swap: num(x.swap),
      open_time: new Date(x.openTime).toISOString(),
      close_time: x.closeTime != null ? new Date(x.closeTime).toISOString() : null
    };
  }).sort(function (a, b) { return a.open_time < b.open_time ? -1 : 1; });
  return {
    columns: [
      { key: "id", label: "Deal" }, { key: "login", label: "Login" },
      { key: "group", label: "Group" }, { key: "symbol", label: "Symbol" },
      { key: "side", label: "Side" }, { key: "volume", label: "Volume" },
      { key: "open_price", label: "Open price" }, { key: "close_price", label: "Close price" },
      { key: "profit", label: "Profit" }, { key: "commission", label: "Commission" },
      { key: "swap", label: "Swap" }, { key: "open_time", label: "Opened (UTC)" },
      { key: "close_time", label: "Closed (UTC)" }
    ],
    rows: rows
  };
}

function genClientAccountStatement(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var entries = [];
  (d.deals || []).forEach(function (x) {
    if (x.login !== p.login) return;
    if (x.closeTime == null || x.closeTime < from || x.closeTime >= to) return;
    entries.push({
      time: x.closeTime,
      kind: "deal",
      description: x.side + " " + x.volume + " " + x.symbol + " @ " + x.closePrice,
      amount: num(x.profit) - num(x.commission) + num(x.swap)
    });
  });
  (d.balanceOps || []).forEach(function (x) {
    if (x.login !== p.login) return;
    if (x.time < from || x.time >= to) return;
    entries.push({
      time: x.time, kind: "balance",
      description: x.type + (x.comment ? " — " + x.comment : ""),
      amount: num(x.amount)
    });
  });
  entries.sort(function (a, b) { return a.time - b.time; });
  var running = num(p.opening_balance);
  var rows = entries.map(function (e) {
    running += e.amount;
    return {
      time: new Date(e.time).toISOString(), kind: e.kind,
      description: e.description, amount: e.amount, balance: running
    };
  });
  return {
    columns: [
      { key: "time", label: "Time (UTC)" }, { key: "kind", label: "Kind" },
      { key: "description", label: "Description" }, { key: "amount", label: "Amount" },
      { key: "balance", label: "Running balance" }
    ],
    rows: rows
  };
}

function genMarginWarningLog(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var rows = (d.marginEvents || []).filter(function (x) {
    return x.time >= from && x.time < to && inGroups(x.group, p.groups);
  }).map(function (x) {
    return {
      time: new Date(x.time).toISOString(), login: x.login, group: x.group,
      margin_level_pct: num(x.level), equity: num(x.equity), margin: num(x.margin)
    };
  }).sort(function (a, b) { return a.time < b.time ? -1 : 1; });
  return {
    columns: [
      { key: "time", label: "Time (UTC)" }, { key: "login", label: "Login" },
      { key: "group", label: "Group" }, { key: "margin_level_pct", label: "Margin level %" },
      { key: "equity", label: "Equity" }, { key: "margin", label: "Margin" }
    ],
    rows: rows
  };
}

function genStopoutCoverageRegister(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var rows = (d.balanceOps || []).filter(function (x) {
    return x.type === "stopout_coverage" && x.time >= from && x.time < to &&
      inGroups(x.group, p.groups);
  }).map(function (x) {
    return {
      time: new Date(x.time).toISOString(), login: x.login, group: x.group,
      amount: num(x.amount), currency: x.currency || "",
      reason: x.comment || "stop-out negative-balance coverage"
    };
  }).sort(function (a, b) { return a.time < b.time ? -1 : 1; });
  return {
    columns: [
      { key: "time", label: "Time (UTC)" }, { key: "login", label: "Login" },
      { key: "group", label: "Group" }, { key: "amount", label: "Amount" },
      { key: "currency", label: "Currency" }, { key: "reason", label: "Reason" }
    ],
    rows: rows
  };
}

function genBookCoverageBalance(ctx) {
  var p = ctx.params, d = ctx.data;
  var rows = (d.coverage || []).filter(function (x) {
    return inSymbols(x.symbol, p.symbols);
  }).map(function (x) {
    var retained = num(x.retainedVolume), hedged = num(x.hedgedVolume);
    var total = retained + hedged;
    return {
      symbol: x.symbol,
      retained_volume: retained,
      hedged_volume: hedged,
      hedge_ratio_pct: total > 0 ? +(100 * hedged / total).toFixed(2) : 0,
      as_of: x.asOf || p.as_of || null
    };
  }).sort(function (a, b) { return a.symbol < b.symbol ? -1 : 1; });
  return {
    columns: [
      { key: "symbol", label: "Symbol" }, { key: "retained_volume", label: "Retained volume" },
      { key: "hedged_volume", label: "Hedged volume" },
      { key: "hedge_ratio_pct", label: "Hedge ratio %" }, { key: "as_of", label: "As of" }
    ],
    rows: rows
  };
}

function genExecutionSpeedStats(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var buckets = {};
  (d.orders || []).forEach(function (x) {
    if (x.requestedAt == null || x.filledAt == null) return;
    if (x.filledAt < from || x.filledAt >= to) return;
    if (!inSymbols(x.symbol, p.symbols)) return;
    var key = x.symbol + "|" + toDayUTC(x.filledAt) + "T" + pad2(new Date(x.filledAt).getUTCHours()) + ":00";
    var b = buckets[key] || (buckets[key] = { symbol: x.symbol, hour: key.split("|")[1], lat: [] });
    b.lat.push(x.filledAt - x.requestedAt);
  });
  var rows = Object.keys(buckets).sort().map(function (k) {
    var b = buckets[k];
    b.lat.sort(function (a, c) { return a - c; });
    return {
      symbol: b.symbol, hour_utc: b.hour, fills: b.lat.length,
      p50_ms: percentile(b.lat, 50), p95_ms: percentile(b.lat, 95), max_ms: b.lat[b.lat.length - 1]
    };
  });
  return {
    columns: [
      { key: "symbol", label: "Symbol" }, { key: "hour_utc", label: "Hour (UTC)" },
      { key: "fills", label: "Fills" }, { key: "p50_ms", label: "p50 ms" },
      { key: "p95_ms", label: "p95 ms" }, { key: "max_ms", label: "Max ms" }
    ],
    rows: rows
  };
}

function genFillQualityMarkouts(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var lookback = num(p.lookback_minutes, 5);
  var bySymbol = {};
  (d.markouts || []).forEach(function (x) {
    if (x.minutes == null || x.minutes > lookback) return;
    if (!inSymbols(x.symbol, p.symbols)) return;
    var dir = x.side === "sell" ? -1 : 1;
    var drift = dir * (num(x.laterPrice) - num(x.execPrice));
    var a = bySymbol[x.symbol] || (bySymbol[x.symbol] = { symbol: x.symbol, fills: 0, driftSum: 0, positive: 0 });
    a.fills += 1;
    a.driftSum += drift;
    if (drift > 0) a.positive += 1;
  });
  var rows = Object.keys(bySymbol).sort().map(function (s) {
    var a = bySymbol[s];
    return {
      symbol: s, fills: a.fills,
      avg_drift: +(a.driftSum / a.fills).toFixed(6),
      positive_share_pct: +((100 * a.positive) / a.fills).toFixed(2),
      lookback_minutes: lookback
    };
  });
  void from; void to; /* range scoping for markouts is the caller's data window */
  return {
    columns: [
      { key: "symbol", label: "Symbol" }, { key: "fills", label: "Fills" },
      { key: "avg_drift", label: "Avg signed drift" },
      { key: "positive_share_pct", label: "Positive share %" },
      { key: "lookback_minutes", label: "Lookback (min)" }
    ],
    rows: rows
  };
}

function genEodGroupSnapshot(ctx) {
  var p = ctx.params, d = ctx.data;
  var byGroup = {};
  (d.portfolios || []).forEach(function (x) {
    if (x.asOfDay !== p.date) return;
    if (!inGroups(x.group, p.groups)) return;
    var a = byGroup[x.group] || (byGroup[x.group] = {
      group: x.group, accounts: 0, balance: 0, equity: 0, margin: 0, open_positions: 0
    });
    a.accounts += 1;
    a.balance += num(x.balance);
    a.equity += num(x.equity);
    a.margin += num(x.margin);
    a.open_positions += num(x.openPositions);
  });
  var rows = Object.keys(byGroup).sort().map(function (g) { return byGroup[g]; });
  return {
    columns: [
      { key: "group", label: "Group" }, { key: "accounts", label: "Accounts" },
      { key: "balance", label: "Balance" }, { key: "equity", label: "Equity" },
      { key: "margin", label: "Margin used" }, { key: "open_positions", label: "Open positions" },
      { key: "date", label: "Date" }
    ],
    rows: rows.map(function (r) { r.date = p.date; return r; })
  };
}

function genMoneyFlowSummary(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var FLOW_TYPES = ["deposit", "withdrawal", "transfer_in", "transfer_out"];
  var byGroup = {};
  (d.balanceOps || []).forEach(function (x) {
    if (FLOW_TYPES.indexOf(x.type) === -1) return;
    if (x.time < from || x.time >= to) return;
    if (!inGroups(x.group, p.groups)) return;
    var a = byGroup[x.group] || (byGroup[x.group] = {
      group: x.group, deposits: 0, withdrawals: 0, transfers_in: 0, transfers_out: 0
    });
    /* amounts are signed; flow columns display magnitudes */
    if (x.type === "deposit") a.deposits += num(x.amount);
    else if (x.type === "withdrawal") a.withdrawals -= num(x.amount);
    else if (x.type === "transfer_in") a.transfers_in += num(x.amount);
    else if (x.type === "transfer_out") a.transfers_out -= num(x.amount);
  });
  var rows = Object.keys(byGroup).sort().map(function (g) {
    var a = byGroup[g];
    a.net_flow = a.deposits - a.withdrawals + a.transfers_in - a.transfers_out;
    return a;
  });
  return {
    columns: [
      { key: "group", label: "Group" }, { key: "deposits", label: "Deposits" },
      { key: "withdrawals", label: "Withdrawals" }, { key: "transfers_in", label: "Transfers in" },
      { key: "transfers_out", label: "Transfers out" }, { key: "net_flow", label: "Net flow" }
    ],
    rows: rows
  };
}

function regulatoryRows(deals, euStyle) {
  return deals.map(function (x) {
    var t = x.closeTime != null ? x.closeTime : x.openTime;
    if (euStyle) {
      return {
        trade_datetime_utc: new Date(t).toISOString(), client_id: x.login,
        instrument: x.symbol, buy_sell: x.side === "sell" ? "SELL" : "BUY",
        quantity: num(x.volume), price: num(x.closePrice), trading_venue: "XXXX"
      };
    }
    return {
      execution_time_utc: new Date(t).toISOString(), account: x.login,
      instrument: x.symbol, side: x.side, volume: num(x.volume),
      price: num(x.closePrice), venue: "OTC"
    };
  }).sort(function (a, b) {
    var ka = a.trade_datetime_utc || a.execution_time_utc;
    var kb = b.trade_datetime_utc || b.execution_time_utc;
    return ka < kb ? -1 : 1;
  });
}

function genRegulatoryExtractUS(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var deals = (d.deals || []).filter(function (x) {
    var t = x.closeTime != null ? x.closeTime : x.openTime;
    return t >= from && t < to;
  });
  return {
    columns: [
      { key: "execution_time_utc", label: "Execution time (UTC)" },
      { key: "account", label: "Account" }, { key: "instrument", label: "Instrument" },
      { key: "side", label: "Side" }, { key: "volume", label: "Volume" },
      { key: "price", label: "Price" }, { key: "venue", label: "Venue" }
    ],
    rows: regulatoryRows(deals, false)
  };
}

function genRegulatoryExtractEU(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var deals = (d.deals || []).filter(function (x) {
    var t = x.closeTime != null ? x.closeTime : x.openTime;
    return t >= from && t < to;
  });
  return {
    columns: [
      { key: "trade_datetime_utc", label: "Trade datetime (UTC)" },
      { key: "client_id", label: "Client" }, { key: "instrument", label: "Instrument" },
      { key: "buy_sell", label: "Buy/Sell" }, { key: "quantity", label: "Quantity" },
      { key: "price", label: "Price" }, { key: "trading_venue", label: "Trading venue" }
    ],
    rows: regulatoryRows(deals, true)
  };
}

function genAccountGrowthTracker(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var byMonth = {};
  (d.accounts || []).forEach(function (x) {
    if (x.createdAt == null || x.createdAt < from || x.createdAt >= to) return;
    if (!inGroups(x.group, p.groups)) return;
    var m = toMonthUTC(x.createdAt);
    var a = byMonth[m] || (byMonth[m] = { month: m, opened: 0, funded: 0, activated: 0 });
    a.opened += 1;
    if (x.firstDepositAt != null) a.funded += 1;
    if (x.firstTradeAt != null) a.activated += 1;
  });
  var rows = Object.keys(byMonth).sort().map(function (m) { return byMonth[m]; });
  return {
    columns: [
      { key: "month", label: "Month" }, { key: "opened", label: "Opened" },
      { key: "funded", label: "First-funded" }, { key: "activated", label: "First-trade" }
    ],
    rows: rows
  };
}

function genRetentionCohorts(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var months = Math.max(1, Math.floor(num(p.months, 6)));
  var cohorts = {}; /* cohortMonth -> {size, logins:{}} */
  (d.accounts || []).forEach(function (x) {
    if (x.firstDepositAt == null || x.firstDepositAt < from || x.firstDepositAt >= to) return;
    var m = toMonthUTC(x.firstDepositAt);
    var c = cohorts[m] || (cohorts[m] = { size: 0, logins: {} });
    if (!c.logins[x.login]) { c.logins[x.login] = true; c.size += 1; }
  });
  var activeMonths = {}; /* login -> {month:true} from deal activity */
  (d.deals || []).forEach(function (x) {
    var t = x.closeTime != null ? x.closeTime : x.openTime;
    if (t == null) return;
    var m = toMonthUTC(t);
    var s = activeMonths[x.login] || (activeMonths[x.login] = {});
    s[m] = true;
  });
  var rows = [];
  Object.keys(cohorts).sort().forEach(function (cm) {
    var c = cohorts[cm];
    for (var k = 0; k < months; k++) {
      var target = addMonths(cm, k);
      var active = 0;
      Object.keys(c.logins).forEach(function (login) {
        if (activeMonths[login] && activeMonths[login][target]) active += 1;
      });
      rows.push({
        cohort_month: cm, month_offset: k, cohort_size: c.size, active: active,
        retention_pct: c.size > 0 ? +((100 * active) / c.size).toFixed(1) : 0
      });
    }
  });
  return {
    columns: [
      { key: "cohort_month", label: "Cohort month" }, { key: "month_offset", label: "Month offset" },
      { key: "cohort_size", label: "Cohort size" }, { key: "active", label: "Active" },
      { key: "retention_pct", label: "Retention %" }
    ],
    rows: rows
  };
}

function genClientLifetimeValue(ctx) {
  var p = ctx.params, d = ctx.data;
  var from = dayStartUTC(p.from), to = dayEndExclusiveUTC(p.to);
  var minNet = num(p.min_net_deposit, 0);
  var per = {};
  function agg(login) {
    return per[login] || (per[login] = {
      login: login, deposits: 0, withdrawals: 0, volume: 0,
      costs: 0, first: null, last: null
    });
  }
  (d.balanceOps || []).forEach(function (x) {
    if (x.time < from || x.time >= to) return;
    var a = agg(x.login);
    if (x.type === "deposit") a.deposits += num(x.amount);
    else if (x.type === "withdrawal") a.withdrawals -= num(x.amount); /* signed -> magnitude */
    if (a.first == null || x.time < a.first) a.first = x.time;
    if (a.last == null || x.time > a.last) a.last = x.time;
  });
  (d.deals || []).forEach(function (x) {
    var t = x.closeTime != null ? x.closeTime : x.openTime;
    if (t == null || t < from || t >= to) return;
    var a = agg(x.login);
    a.volume += num(x.volume);
    a.costs += num(x.commission) - num(x.swap);
    if (a.first == null || t < a.first) a.first = t;
    if (a.last == null || t > a.last) a.last = t;
  });
  var rows = Object.keys(per).map(function (login) {
    var a = per[login];
    return {
      login: login,
      deposits: a.deposits,
      withdrawals: a.withdrawals,
      net_deposits: a.deposits - a.withdrawals,
      volume: a.volume,
      costs_paid: a.costs,
      tenure_days: a.first != null ? Math.max(1, Math.round((a.last - a.first) / 86400000) + 1) : 0
    };
  }).filter(function (r) { return r.net_deposits >= minNet; })
    .sort(function (a, b) { return b.net_deposits - a.net_deposits; });
  return {
    columns: [
      { key: "login", label: "Login" }, { key: "deposits", label: "Deposits" },
      { key: "withdrawals", label: "Withdrawals" }, { key: "net_deposits", label: "Net deposits" },
      { key: "volume", label: "Volume" }, { key: "costs_paid", label: "Costs paid" },
      { key: "tenure_days", label: "Tenure (days)" }
    ],
    rows: rows
  };
}

/* ---- standard report catalog ----
 * id, name, purpose and parameters per definition. Names and purposes are
 * written for OrbitTrader; they are not copied from any vendor's list. */
function P(name, type, required, description, dflt) {
  var p = { name: name, type: type, required: !!required, description: description };
  if (dflt !== undefined) p.default = dflt;
  return p;
}
var GROUP_PARAM = P("groups", "string[]", false, "Limit to these account groups; empty means all in scope.");
var SYMBOL_PARAM = P("symbols", "string[]", false, "Limit to these symbols; empty means all.");
var LOGIN_LIST_PARAM = P("logins", "string[]", false, "Limit to these logins; empty means all in scope.");
var FROM_PARAM = P("from", "date", true, "First day of the period (YYYY-MM-DD, UTC, inclusive).");
var TO_PARAM = P("to", "date", true, "Last day of the period (YYYY-MM-DD, UTC, inclusive).");

var REPORT_CATALOG = [
  {
    id: "daily_trading_digest", name: "Daily trading digest", category: "trading",
    purpose: "One row per symbol per day: deal count, traded volume, gross and net P/L, commission and swap totals for the selected day.",
    params: [
      P("date", "date", true, "The day to digest (YYYY-MM-DD, UTC)."),
      GROUP_PARAM, SYMBOL_PARAM
    ],
    defaultSchedule: "daily", generate: genDailyTradingDigest
  },
  {
    id: "trade_detail_ledger", name: "Trade detail ledger", category: "trading",
    purpose: "Row-level deal list for a period with login, group, symbol, side, volume, prices, P/L, commission and swap.",
    params: [FROM_PARAM, TO_PARAM, LOGIN_LIST_PARAM, GROUP_PARAM, SYMBOL_PARAM],
    defaultSchedule: "daily", generate: genTradeDetailLedger
  },
  {
    id: "client_account_statement", name: "Client account statement", category: "trading",
    purpose: "Per-account statement: balance operations and closed deals in chronological order with a running balance.",
    params: [
      P("login", "login", true, "Account login the statement is for."),
      FROM_PARAM, TO_PARAM,
      P("opening_balance", "number", false, "Balance before the first row; the running balance starts here.", 0)
    ],
    defaultSchedule: "monthly", generate: genClientAccountStatement
  },
  {
    id: "margin_warning_log", name: "Margin warning log", category: "risk",
    purpose: "Margin-call events raised by the margin engine: login, group, margin level at trigger, equity and required margin.",
    params: [FROM_PARAM, TO_PARAM, GROUP_PARAM],
    defaultSchedule: "daily", generate: genMarginWarningLog
  },
  {
    id: "stopout_coverage_register", name: "Stop-out coverage register", category: "risk",
    purpose: "Credits posted to cover negative balances after stop-outs, with login, amount, currency and posting reason.",
    params: [FROM_PARAM, TO_PARAM, GROUP_PARAM],
    defaultSchedule: "daily", generate: genStopoutCoverageRegister
  },
  {
    id: "book_coverage_balance", name: "Book coverage balance", category: "risk",
    purpose: "Net exposure per symbol split between internally retained risk and externally hedged flow, with hedge ratios.",
    params: [
      P("as_of", "datetime", false, "Valuation moment (ISO 8601 UTC); defaults to generation time.", null),
      SYMBOL_PARAM
    ],
    defaultSchedule: "daily", generate: genBookCoverageBalance
  },
  {
    id: "execution_speed_stats", name: "Execution speed statistics", category: "execution",
    purpose: "Distribution of order request-to-fill latency by symbol and hour, with p50, p95 and max.",
    params: [FROM_PARAM, TO_PARAM, SYMBOL_PARAM],
    defaultSchedule: "daily", generate: genExecutionSpeedStats
  },
  {
    id: "fill_quality_markouts", name: "Fill quality markouts", category: "execution",
    purpose: "Signed price movement after each fill over a lookback window, to evaluate execution quality per symbol.",
    params: [
      FROM_PARAM, TO_PARAM,
      P("lookback_minutes", "number", false, "Minutes after the fill to measure the drift.", 5),
      SYMBOL_PARAM
    ],
    defaultSchedule: "daily", generate: genFillQualityMarkouts
  },
  {
    id: "eod_group_snapshot", name: "End-of-day group snapshot", category: "operations",
    purpose: "Per-group end-of-day totals: accounts, balance, equity, margin used and open positions.",
    params: [
      P("date", "date", true, "The day the snapshot is for (YYYY-MM-DD, UTC)."),
      GROUP_PARAM
    ],
    defaultSchedule: "daily", generate: genEodGroupSnapshot
  },
  {
    id: "money_flow_summary", name: "Money flow summary", category: "finance",
    purpose: "Deposits, withdrawals and internal transfers per period with net flow, grouped by account group.",
    params: [FROM_PARAM, TO_PARAM, GROUP_PARAM],
    defaultSchedule: "daily", generate: genMoneyFlowSummary
  },
  {
    id: "regulatory_extract_us", name: "US-style regulatory extract", category: "regulatory",
    purpose: "Transaction extract in a US-regulator-friendly layout: execution timestamps, parties, instruments, volumes, prices.",
    params: [FROM_PARAM, TO_PARAM],
    defaultSchedule: "daily", generate: genRegulatoryExtractUS
  },
  {
    id: "regulatory_extract_eu", name: "EU-style regulatory extract", category: "regulatory",
    purpose: "Transaction extract in an EU-regulator-friendly layout for trade reporting: trade datetimes, client ids, quantities, venues.",
    params: [FROM_PARAM, TO_PARAM],
    defaultSchedule: "daily", generate: genRegulatoryExtractEU
  },
  {
    id: "account_growth_tracker", name: "Account growth tracker", category: "growth",
    purpose: "New accounts opened, first-funded and first-trade-activated over time, split by month and group.",
    params: [FROM_PARAM, TO_PARAM, GROUP_PARAM],
    defaultSchedule: "monthly", generate: genAccountGrowthTracker
  },
  {
    id: "retention_cohorts", name: "Retention cohorts", category: "growth",
    purpose: "First-deposit cohorts with the share of each cohort still trading in every following month.",
    params: [
      FROM_PARAM, TO_PARAM,
      P("months", "number", false, "How many months after the cohort month to track.", 6)
    ],
    defaultSchedule: "monthly", generate: genRetentionCohorts
  },
  {
    id: "client_lifetime_value", name: "Client lifetime value", category: "growth",
    purpose: "Per-client totals: deposits, withdrawals, net deposits, traded volume, costs paid and tenure in days.",
    params: [
      FROM_PARAM, TO_PARAM,
      P("min_net_deposit", "number", false, "Keep only clients with net deposits at or above this.", 0)
    ],
    defaultSchedule: "monthly", generate: genClientLifetimeValue
  }
];

function getReport(id) {
  for (var i = 0; i < REPORT_CATALOG.length; i++) {
    if (REPORT_CATALOG[i].id === id) return REPORT_CATALOG[i];
  }
  return null;
}
function listReports() {
  return REPORT_CATALOG.slice();
}

/* ---- report registry + custom-report plugin hook ----
 * createRegistry() returns an isolated registry. The module also keeps one
 * shared default registry behind registerCustomReport / runReport / ... .
 * Built-in ids can never be overridden or removed. */
function createRegistry() {
  var defs = {};   /* id -> definition */
  var order = [];  /* registration order for customs */
  var builtIns = {};
  REPORT_CATALOG.forEach(function (d) {
    defs[d.id] = d;
    builtIns[d.id] = true;
  });

  function register(def) {
    var errs = validateReportDef(def);
    if (errs.length) throw new Error("reports: invalid custom report: " + errs.join("; "));
    if (builtIns[def.id]) throw new Error("reports: '" + def.id + "' is a built-in report and cannot be overridden");
    if (defs[def.id]) throw new Error("reports: custom report '" + def.id + "' is already registered");
    defs[def.id] = def;
    order.push(def.id);
    return def.id;
  }
  function unregister(id) {
    if (builtIns[id]) throw new Error("reports: '" + id + "' is a built-in report and cannot be removed");
    if (!defs[id]) throw new Error("reports: unknown custom report '" + id + "'");
    delete defs[id];
    order.splice(order.indexOf(id), 1);
    return true;
  }
  function get(id) { return defs[id] || null; }
  function list() {
    var out = REPORT_CATALOG.slice();
    order.forEach(function (id) { out.push(defs[id]); });
    return out;
  }
  function run(id, params, data, manager) {
    var def = get(id);
    if (!def) throw new Error("reports: unknown report '" + id + "'");
    if (manager !== undefined && manager !== null) {
      if (!managerCanRun(manager, id, api)) throw new Error(
        "reports: manager '" + (manager.login || "?") + "' may not run '" + id + "'");
      params = scopeParamsForManager(manager, params || {});
    }
    params = applyParamDefaults(def, params || {});
    var errs = validateParams(def, params);
    if (errs.length) throw new Error("reports: invalid params for '" + id + "': " + errs.join("; "));
    return def.generate({ params: params, data: data || {}, manager: manager || null });
  }
  var api = {
    register: register, unregister: unregister, get: get, list: list, run: run,
    has: function (id) { return !!defs[id]; },
    isBuiltIn: function (id) { return !!builtIns[id]; }
  };
  return api;
}

var defaultRegistry = createRegistry();

function registerCustomReport(def) { return defaultRegistry.register(def); }
function unregisterCustomReport(id) { return defaultRegistry.unregister(id); }
function listAllReports() { return defaultRegistry.list(); }
function getAnyReport(id) { return defaultRegistry.get(id); }
function runReport(id, params, data, manager) { return defaultRegistry.run(id, params, data, manager); }

/* ---- per-manager availability ----
 * manager = {login, name?, reportRights?: [...], groups?: [...]}
 * Rights strings: '*' | 'reports.<category>.*' | 'reports.<report-id>'.
 * No reportRights (or a non-array) means no reports at all. */
function managerCanRun(manager, reportId, registry) {
  if (!manager || typeof manager !== "object") return false;
  var reg = registry || defaultRegistry;
  var def = reg.get(reportId);
  if (!def) return false;
  var rights = manager.reportRights;
  if (!Array.isArray(rights) || rights.length === 0) return false;
  if (rights.indexOf("*") !== -1) return true;
  return rights.indexOf("reports." + def.id) !== -1 ||
         rights.indexOf("reports." + def.category + ".*") !== -1;
}

function reportsForManager(manager, registry) {
  var reg = registry || defaultRegistry;
  return reg.list().filter(function (d) { return managerCanRun(manager, d.id, reg); });
}

/* Narrows params.groups to the manager's supervised groups. Throws when the
 * caller asks for a group outside the manager's scope. Managers whose
 * groups list contains '*' keep the params untouched. */
function scopeParamsForManager(manager, params) {
  var out = {};
  Object.keys(params || {}).forEach(function (k) { out[k] = params[k]; });
  var allowed = (manager && Array.isArray(manager.groups)) ? manager.groups : [];
  if (allowed.indexOf("*") !== -1) return out;
  var requested = out.groups || (out.group ? [out.group] : null);
  if (requested) {
    for (var i = 0; i < requested.length; i++) {
      if (allowed.indexOf(requested[i]) === -1)
        throw new Error("reports: group '" + requested[i] + "' is outside this manager's scope");
    }
    return out;
  }
  out.groups = allowed.slice();
  return out;
}

/* ---- report scheduling (daily / monthly, UTC) ----
 * schedule = {id, reportId, params, recurrence, atHour, atMinute,
 *             dayOfMonth?, email?, enabled, createdAt, lastRunAt?, createdBy?}
 * createdAt anchors the first eligible fire time (defaults to build time);
 * the runner stamps lastRunAt after each execution so the same fire time
 * is never reported due twice. */
var scheduleSeq = 0;
function defaultScheduleId(spec) {
  scheduleSeq += 1;
  var id = spec.reportId + "-" + spec.recurrence + "-" + spec.atHour + "h" + spec.atMinute + "m";
  if (spec.recurrence === "monthly") id += "-d" + spec.dayOfMonth;
  return id + "-" + scheduleSeq;
}

function validateSchedule(s, registry) {
  var errs = [];
  function err(m) { errs.push(m); }
  var reg = registry || defaultRegistry;
  if (!s || typeof s !== "object" || Array.isArray(s)) return ["schedule must be an object"];
  if (typeof s.id !== "string" || s.id === "") err("id must be a non-empty string");
  if (!reg.get(s.reportId)) err("unknown reportId '" + s.reportId + "'");
  else {
    var perrs = validateParams(reg.get(s.reportId), s.params || {});
    perrs.forEach(function (e) { err("params: " + e); });
  }
  if (SCHEDULE_RECURRENCES.indexOf(s.recurrence) === -1)
    err("recurrence must be one of: " + SCHEDULE_RECURRENCES.join(", "));
  if (typeof s.atHour !== "number" || Math.floor(s.atHour) !== s.atHour || s.atHour < 0 || s.atHour > 23)
    err("atHour must be an integer 0-23");
  if (typeof s.atMinute !== "number" || Math.floor(s.atMinute) !== s.atMinute || s.atMinute < 0 || s.atMinute > 59)
    err("atMinute must be an integer 0-59");
  if (s.recurrence === "monthly") {
    if (typeof s.dayOfMonth !== "number" || Math.floor(s.dayOfMonth) !== s.dayOfMonth ||
        s.dayOfMonth < 1 || s.dayOfMonth > 31)
      err("dayOfMonth must be an integer 1-31 for monthly schedules");
  }
  if (s.email !== undefined && s.email !== null && s.email !== "") {
    if (typeof s.email !== "string" || s.email.indexOf("@") === -1)
      err("email must look like an email address");
  }
  if (typeof s.enabled !== "boolean") err("enabled must be a boolean");
  if (s.createdAt !== undefined && s.createdAt !== null &&
      (typeof s.createdAt !== "number" || !isFinite(s.createdAt) || s.createdAt < 0))
    err("createdAt must be a non-negative UTC ms timestamp");
  if (s.lastRunAt !== undefined && s.lastRunAt !== null &&
      (typeof s.lastRunAt !== "number" || !isFinite(s.lastRunAt) || s.lastRunAt < 0))
    err("lastRunAt must be a non-negative UTC ms timestamp");
  return errs;
}

/* Builds a schedule from a loose spec; returns {ok, schedule?, errors}. */
function buildSchedule(spec, registry) {
  var s = {
    id: spec.id || defaultScheduleId(spec),
    reportId: spec.reportId,
    params: spec.params || {},
    recurrence: spec.recurrence,
    atHour: spec.atHour,
    atMinute: spec.atMinute,
    dayOfMonth: spec.dayOfMonth,
    email: spec.email || null,
    enabled: spec.enabled === undefined ? true : !!spec.enabled,
    createdAt: spec.createdAt !== undefined && spec.createdAt !== null ? spec.createdAt : Date.now(),
    lastRunAt: spec.lastRunAt !== undefined ? spec.lastRunAt : null,
    createdBy: spec.createdBy || null
  };
  var errs = validateSchedule(s, registry);
  if (errs.length) return { ok: false, errors: errs };
  return { ok: true, schedule: s };
}

/* Next run strictly after fromMs (UTC ms). Monthly dayOfMonth is clamped
 * to the month's length (e.g. 31 -> Feb 28/29). */
function nextRunAt(schedule, fromMs) {
  var from = new Date(fromMs);
  function at(y, m0, d) {
    return Date.UTC(y, m0, d, schedule.atHour, schedule.atMinute, 0, 0);
  }
  if (schedule.recurrence === "daily") {
    var t = at(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    while (t <= fromMs) t += 86400000;
    return t;
  }
  /* monthly */
  var y = from.getUTCFullYear(), m0 = from.getUTCMonth();
  for (var i = 0; i < 36; i++) {
    var yy = y + Math.floor((m0 + i) / 12);
    var mm = (m0 + i) % 12;
    var day = Math.min(schedule.dayOfMonth, daysInMonthUTC(yy, mm));
    var t2 = at(yy, mm, day);
    if (t2 > fromMs) return t2;
  }
  throw new Error("reports: could not find next monthly run");
}

/* Enabled schedules whose next fire time after (lastRunAt || createdAt)
 * has arrived at or before nowMs. */
function dueSchedules(schedules, nowMs) {
  return (schedules || []).filter(function (s) {
    if (!s.enabled) return false;
    var from = Math.max(s.lastRunAt || 0, s.createdAt || 0);
    return nextRunAt(s, from) <= nowMs;
  });
}

function describeSchedule(s) {
  var when = s.recurrence === "daily"
    ? "daily at " + pad2(s.atHour) + ":" + pad2(s.atMinute) + " UTC"
    : "monthly on day " + s.dayOfMonth + " at " + pad2(s.atHour) + ":" + pad2(s.atMinute) + " UTC";
  var extra = s.email ? " → " + s.email : "";
  return s.reportId + " " + when + extra + (s.enabled ? "" : " (disabled)");
}

var REPORTS = {
  REPORT_CATALOG: REPORT_CATALOG,
  REPORT_CATEGORIES: REPORT_CATEGORIES,
  SCHEDULE_RECURRENCES: SCHEDULE_RECURRENCES,
  PARAM_TYPES: PARAM_TYPES,
  getReport: getReport,
  listReports: listReports,
  validateReportDef: validateReportDef,
  validateParams: validateParams,
  applyParamDefaults: applyParamDefaults,
  createRegistry: createRegistry,
  defaultRegistry: defaultRegistry,
  registerCustomReport: registerCustomReport,
  unregisterCustomReport: unregisterCustomReport,
  listAllReports: listAllReports,
  getAnyReport: getAnyReport,
  runReport: runReport,
  managerCanRun: managerCanRun,
  reportsForManager: reportsForManager,
  scopeParamsForManager: scopeParamsForManager,
  buildSchedule: buildSchedule,
  validateSchedule: validateSchedule,
  nextRunAt: nextRunAt,
  dueSchedules: dueSchedules,
  describeSchedule: describeSchedule,
  /* exposed for tests */
  _toDayUTC: toDayUTC,
  _isValidDay: isValidDay
};
if (typeof module !== "undefined" && module.exports) { module.exports = REPORTS; }
else { root.OrbitReports = REPORTS; }
})(typeof globalThis !== "undefined" ? globalThis : this);
