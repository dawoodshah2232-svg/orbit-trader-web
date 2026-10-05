/* shared/accounts.js — OrbitTrader trading-account lifecycle model.
 *
 * Pure functions, no globals, no DOM: runs in the browser and in node
 * (guarded export at the bottom, same pattern as shared/groups.js).
 *
 * Model (reimplemented from platform administration concepts, in OrbitTrader
 * terms):
 *   - Account TYPES: demo, preliminary, live, manager, technical, disabled.
 *     - demo: virtual funds, no real money movement, optional expiry.
 *     - preliminary: holding state for account-open requests — zero balance,
 *       no trading, no login until approved and converted to demo/live.
 *     - live: real-money trading account.
 *     - manager: staff account with back-office rights; never trades.
 *     - technical: internal system accounts (e.g. coverage/liquidity books);
 *       no trader login, no client trading.
 *     - disabled: soft-disabled; login and trading both blocked, history kept.
 *   - Accounts live on ONE trade server each; the account key is server+login.
 *   - Balance and credit are separate ledgers. Every money movement is a
 *     "deal" record: deal stream is the source of truth; account.balance /
 *     account.credit are cached heads. checkBalance() recomputes the head
 *     from the stream; fixBalance() posts correction deals to realign them.
 *   - Archive moves an account out of active service (keeps history);
 *     restore brings it back. Archive requires zero balance/credit and no
 *     open positions.
 *   - Import validates rows from a file (CSV) or a remote server feed and
 *     reports per-row errors instead of failing the whole batch.
 *   - Allocation settings decide which trade server a new account lands on.
 *   - Corporate links tie an account to a corporate client entity.
 *   - Deposit/withdraw links are broker-configured URL templates with
 *     #LOGIN# / #NAME# / #CURRENCY# / #SERVER# macros.
 *
 * All broker-specific values below (default groups, allocation strategy,
 * URL templates) are OrbitTrader defaults, not any broker's.
 */
(function (root) {
"use strict";

var ACCOUNT_TYPES = ["demo", "preliminary", "live", "manager", "technical", "disabled"];

/* Per-type capability matrix. */
var TYPE_CAPS = {
  demo:        { can_login: true,  can_trade: true,  can_deposit: false, can_withdraw: false, virtual_funds: true,  staff: false, has_expiry: true  },
  preliminary: { can_login: false, can_trade: false, can_deposit: false, can_withdraw: false, virtual_funds: false, staff: false, has_expiry: false },
  live:        { can_login: true,  can_trade: true,  can_deposit: true,  can_withdraw: true,  virtual_funds: false, staff: false, has_expiry: false },
  manager:     { can_login: true,  can_trade: false, can_deposit: false, can_withdraw: false, virtual_funds: false, staff: true,  has_expiry: false },
  technical:   { can_login: false, can_trade: false, can_deposit: false, can_withdraw: false, virtual_funds: false, staff: false, has_expiry: false },
  disabled:    { can_login: false, can_trade: false, can_deposit: false, can_withdraw: false, virtual_funds: false, staff: false, has_expiry: false }
};

/* Balance-deal kinds. target = which ledger moves; sign = fixed direction
 * (+1 credit-side, -1 debit-side). "correction" takes an explicit sign in
 * the op; everything else is fixed. */
var DEAL_KINDS = {
  deposit:     { target: "balance", sign:  1, label: "Deposit" },
  withdrawal:  { target: "balance", sign: -1, label: "Withdrawal" },
  bonus:       { target: "balance", sign:  1, label: "Bonus" },
  dividend:    { target: "balance", sign:  1, label: "Dividend" },
  interest:    { target: "balance", sign:  1, label: "Interest on free funds" },
  charge:      { target: "balance", sign: -1, label: "Charge" },
  fee:         { target: "balance", sign: -1, label: "Fee" },
  commission:  { target: "balance", sign: -1, label: "Commission" },
  tax:         { target: "balance", sign: -1, label: "Tax" },
  correction:  { target: null,      sign:  0, label: "Correction" },
  credit_in:   { target: "credit",  sign:  1, label: "Credit in" },
  credit_out:  { target: "credit",  sign: -1, label: "Credit out" }
};

/* OrbitTrader default group per account type (broker-configurable). */
var DEFAULT_GROUP_FOR_TYPE = {
  demo: "Orbit-Demo",
  preliminary: "Orbit-Preliminary",
  live: "Orbit-Live",
  manager: "Orbit-Managers",
  technical: "Orbit-Technical",
  disabled: "Orbit-Disabled"
};

var ISO_CCY = /^[A-Z]{3}$/;

/* Money is kept to 2 decimals (minor units of the account currency). */
function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function isFiniteNum(v) {
  return typeof v === "number" && isFinite(v);
}

/* ---- 1. account key: per-trade-server storage ---- */
function makeAccountKey(server, login) {
  if (typeof server !== "string" || server.length === 0) throw new Error("server required");
  var n = Number(login);
  if (!isFiniteNum(n) || n <= 0 || Math.floor(n) !== n) throw new Error("login must be a positive integer");
  return server + ":" + n;
}

/* ---- 2. type caps ---- */
function typeCaps(type) {
  if (!Object.prototype.hasOwnProperty.call(TYPE_CAPS, type)) return null;
  var c = TYPE_CAPS[type], out = {};
  for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
  return out;
}

/* ---- 3. account factory + validation ---- */
function defaultAccount(server, login, type) {
  type = type || "demo";
  return {
    server: server,
    login: Number(login),
    type: type,
    group: DEFAULT_GROUP_FOR_TYPE[type] || "Orbit-Live",
    name: "",
    email: null,
    phone: null,
    currency: "USD",
    leverage: 100,
    balance: 0,
    credit: 0,
    opening_balance: 0,
    archived: false,
    archived_at: null,
    corporate_id: null,
    expires_at: null,
    must_change_pw: false,
    created_at: null
  };
}

function validateAccount(a) {
  var errs = [];
  if (!a || typeof a !== "object") return ["account must be an object"];
  try { makeAccountKey(a.server, a.login); }
  catch (e) { errs.push(e.message); }
  if (ACCOUNT_TYPES.indexOf(a.type) === -1) errs.push("unknown account type: " + a.type);
  if (typeof a.group !== "string" || a.group.length === 0) errs.push("group required");
  if (!ISO_CCY.test(a.currency || "")) errs.push("currency must be ISO 4217 (3 uppercase letters)");
  if (!isFiniteNum(a.leverage) || a.leverage <= 0 || Math.floor(a.leverage) !== a.leverage)
    errs.push("leverage must be a positive integer");
  if (!isFiniteNum(a.balance)) errs.push("balance must be a finite number");
  if (!isFiniteNum(a.credit)) errs.push("credit must be a finite number");
  if (a.type === "preliminary" && (round2(a.balance) !== 0 || round2(a.credit) !== 0))
    errs.push("preliminary accounts must have zero balance and zero credit");
  return errs;
}

/* ---- 4. login / trading gates ---- */
function canLogin(a) {
  if (!a || a.archived) return false;
  var c = typeCaps(a.type);
  return !!c && c.can_login;
}

function canTrade(a) {
  if (!a || a.archived) return false;
  var c = typeCaps(a.type);
  return !!c && c.can_trade;
}

/* ---- 5. balance / credit operations ---- */
function signOf(kind, op) {
  var def = DEAL_KINDS[kind];
  if (!def) throw new Error("unknown deal kind: " + kind);
  if (kind === "correction") {
    if (op.sign !== 1 && op.sign !== -1) throw new Error("correction requires sign +1 or -1");
    return op.sign;
  }
  return def.sign;
}

/* Applies one money movement. Returns { account, deal } (inputs not mutated).
 * Throws on: unknown kind, bad amount, archived/disabled account, or
 * insufficient funds on debit ops. nextId supplies the deal id. */
function applyBalanceOp(account, op, nextId) {
  if (!account || typeof account !== "object") throw new Error("account required");
  if (!op || typeof op !== "object") throw new Error("op required");
  if (account.archived) throw new Error("account is archived");
  if (account.type === "disabled") throw new Error("account is disabled");
  var kind = op.kind;
  var def = DEAL_KINDS[kind];
  if (!def) throw new Error("unknown deal kind: " + kind);
  var amount = Number(op.amount);
  if (!isFiniteNum(amount) || amount <= 0) throw new Error("amount must be a positive finite number");
  amount = round2(amount);
  if (amount <= 0) throw new Error("amount rounds to zero");
  var sign = signOf(kind, op);
  /* "correction" may target either ledger (op.target), defaulting to balance. */
  var target = def.target || op.target || "balance";
  if (kind === "correction" && target !== "balance" && target !== "credit")
    throw new Error("correction target must be balance or credit");
  var a = {};
  for (var k in account) if (Object.prototype.hasOwnProperty.call(account, k)) a[k] = account[k];

  var deal = {
    id: nextId == null ? null : nextId,
    server: a.server,
    login: a.login,
    kind: kind,
    amount: amount,
    sign: sign,
    signed_amount: round2(sign * amount),
    target: target,
    balance_after: a.balance,
    credit_after: a.credit,
    comment: typeof op.comment === "string" ? op.comment : "",
    created_at: op.created_at || null
  };

  if (def.target === "balance" || (kind === "correction" && target === "balance")) {
    var nb = round2(a.balance + sign * amount);
    if (nb < 0) throw new Error("insufficient balance for " + kind);
    a.balance = nb;
    deal.balance_after = nb;
  } else {
    var nc = round2(a.credit + sign * amount);
    if (nc < 0) throw new Error("insufficient credit for " + kind);
    a.credit = nc;
    deal.credit_after = nc;
  }
  return { account: a, deal: deal };
}

/* ---- 6. check / fix balance (recalculate head from deal stream) ---- */
/* Correction deals are audit records of past fixes: they are EXCLUDED from
 * the expected-value computation so the check stays anchored to the
 * trade-generated stream (otherwise a fix would shift its own baseline and
 * never converge). */
function sumDeals(deals, target) {
  var t = 0;
  (deals || []).forEach(function (d) {
    if (d && d.kind !== "correction" && d.target === target && isFiniteNum(d.signed_amount))
      t = round2(t + d.signed_amount);
  });
  return t;
}

/* Recomputes expected balance/credit from opening values + deal stream and
 * compares with the cached heads. Returns a report; never mutates. */
function checkBalance(account, deals) {
  if (!account || typeof account !== "object") throw new Error("account required");
  var expected_balance = round2((account.opening_balance || 0) + sumDeals(deals, "balance"));
  var expected_credit = round2(sumDeals(deals, "credit"));
  var db = round2(account.balance - expected_balance);
  var dc = round2(account.credit - expected_credit);
  return {
    expected_balance: expected_balance,
    actual_balance: round2(account.balance),
    expected_credit: expected_credit,
    actual_credit: round2(account.credit),
    balance_discrepancy: db,
    credit_discrepancy: dc,
    ok: db === 0 && dc === 0
  };
}

/* Posts correction deals to realign the cached heads with the deal stream.
 * Returns { account, corrections: [deal...] }. Correction deals are audit
 * records (excluded from future checkBalance() expectations), so a
 * follow-up checkBalance() with the full stream passes. */
function fixBalance(account, deals, nextId) {
  var rep = checkBalance(account, deals);
  var corrections = [];
  var cur = account;
  var id = nextId == null ? 1 : nextId;
  function fixOne(discrepancy, target) {
    if (discrepancy === 0) return;
    /* cached head is HIGH by `discrepancy` -> post a negative correction */
    var res = applyBalanceOp(cur, {
      kind: "correction",
      target: target,
      amount: Math.abs(discrepancy),
      sign: discrepancy > 0 ? -1 : 1,
      comment: "fix-balance: realign cached " + target + " with deal stream"
    }, id++);
    cur = res.account;
    corrections.push(res.deal);
  }
  fixOne(rep.balance_discrepancy, "balance");
  var rep2 = checkBalance(cur, (deals || []).concat(corrections));
  fixOne(rep2.credit_discrepancy, "credit");
  return { account: cur, corrections: corrections };
}

/* ---- 7. archive / restore ---- */
function archiveAccount(account, opts) {
  if (!account || typeof account !== "object") throw new Error("account required");
  if (account.archived) throw new Error("account already archived");
  opts = opts || {};
  var openPositions = Number(opts.open_positions || 0);
  if (openPositions > 0) throw new Error("cannot archive: open positions exist");
  if (round2(account.balance) !== 0) throw new Error("cannot archive: balance is not zero");
  if (round2(account.credit) !== 0) throw new Error("cannot archive: credit is not zero");
  var a = {};
  for (var k in account) if (Object.prototype.hasOwnProperty.call(account, k)) a[k] = account[k];
  a.archived = true;
  a.archived_at = opts.archived_at || new Date().toISOString();
  a.archived_by = opts.actor || null;
  a.archive_reason = opts.reason || null;
  return a;
}

function restoreAccount(account) {
  if (!account || typeof account !== "object") throw new Error("account required");
  if (!account.archived) throw new Error("account is not archived");
  var a = {};
  for (var k in account) if (Object.prototype.hasOwnProperty.call(account, k)) a[k] = account[k];
  a.archived = false;
  a.archived_at = null;
  delete a.archived_by;
  delete a.archive_reason;
  return a;
}

/* ---- 8. import from file / server ---- */
var IMPORT_COLUMNS = ["login", "name", "email", "type", "group", "currency", "balance", "leverage"];

function parseImportRow(row) {
  var errors = [];
  if (!row || typeof row !== "object") return { account: null, errors: ["row must be an object"] };
  var login = Number(row.login);
  if (!isFiniteNum(login) || login <= 0 || Math.floor(login) !== login)
    errors.push("login must be a positive integer");
  var type = row.type || "live";
  if (ACCOUNT_TYPES.indexOf(type) === -1) errors.push("unknown account type: " + type);
  var currency = String(row.currency || "USD").toUpperCase();
  if (!ISO_CCY.test(currency)) errors.push("currency must be ISO 4217");
  var leverage = row.leverage == null || row.leverage === "" ? 100 : Number(row.leverage);
  if (!isFiniteNum(leverage) || leverage <= 0 || Math.floor(leverage) !== leverage)
    errors.push("leverage must be a positive integer");
  var balance = row.balance == null || row.balance === "" ? 0 : Number(row.balance);
  if (!isFiniteNum(balance) || balance < 0) errors.push("balance must be a non-negative number");
  if (errors.length) return { account: null, errors: errors };
  var a = defaultAccount(row.server || "main", login, type);
  a.name = String(row.name || "");
  a.email = row.email || null;
  a.group = row.group || DEFAULT_GROUP_FOR_TYPE[type];
  a.currency = currency;
  a.balance = round2(balance);
  a.opening_balance = round2(balance);
  a.leverage = leverage;
  var verrs = validateAccount(a);
  if (verrs.length) return { account: null, errors: verrs };
  return { account: a, errors: [] };
}

/* rows: array of plain objects (parsed CSV row or remote-server record).
 * Returns { imported: [...], errors: [{ index, row, errors }] }. Valid rows
 * import even when other rows fail; duplicate logins within the batch are
 * reported as errors. */
function importAccounts(rows, defaults) {
  defaults = defaults || {};
  var imported = [], errors = [], seen = {};
  (rows || []).forEach(function (row, i) {
    var r = parseImportRow(row);
    if (r.errors.length) {
      errors.push({ index: i, row: row, errors: r.errors });
      return;
    }
    var key = makeAccountKey(r.account.server, r.account.login);
    if (seen[key]) {
      errors.push({ index: i, row: row, errors: ["duplicate login in batch: " + key] });
      return;
    }
    seen[key] = true;
    if (defaults.group && !row.group) r.account.group = defaults.group;
    imported.push(r.account);
  });
  return { imported: imported, errors: errors };
}

/* ---- 9. account allocation settings ---- */
function defaultAllocationSettings() {
  return {
    strategy: "least_loaded",   /* least_loaded | round_robin | fixed_server */
    fixed_server: null,         /* used when strategy === "fixed_server" */
    default_group_for_type: DEFAULT_GROUP_FOR_TYPE,
    state: { round_robin_index: 0 }
  };
}

/* servers: [{ name, accounts_count, cap }] (cap null = unlimited).
 * Returns the chosen server name. Throws when no server can take the account. */
function allocateServer(servers, settings, accountType) {
  settings = settings || defaultAllocationSettings();
  var list = (servers || []).filter(function (s) {
    return s && typeof s.name === "string" &&
      (s.cap == null || (s.accounts_count || 0) < s.cap);
  });
  if (!list.length) throw new Error("no trade server available for allocation");
  if (settings.strategy === "fixed_server") {
    var fixed = list.filter(function (s) { return s.name === settings.fixed_server; })[0];
    if (!fixed) throw new Error("fixed server unavailable: " + settings.fixed_server);
    return fixed.name;
  }
  if (settings.strategy === "round_robin") {
    var idx = (settings.state && settings.state.round_robin_index) || 0;
    var pick = list[idx % list.length];
    if (settings.state) settings.state.round_robin_index = idx + 1;
    return pick.name;
  }
  /* least_loaded (default) */
  var best = list[0];
  list.forEach(function (s) {
    if ((s.accounts_count || 0) < (best.accounts_count || 0)) best = s;
  });
  return best.name;
}

/* ---- 10. corporate links ---- */
function linkCorporate(account, corporate) {
  if (!account || typeof account !== "object") throw new Error("account required");
  if (!corporate || corporate.id == null || String(corporate.id).length === 0)
    throw new Error("corporate id required");
  var a = {};
  for (var k in account) if (Object.prototype.hasOwnProperty.call(account, k)) a[k] = account[k];
  a.corporate_id = String(corporate.id);
  a.corporate_name = corporate.name || null;
  return a;
}

function unlinkCorporate(account) {
  if (!account || typeof account !== "object") throw new Error("account required");
  var a = {};
  for (var k in account) if (Object.prototype.hasOwnProperty.call(account, k)) a[k] = account[k];
  a.corporate_id = null;
  a.corporate_name = null;
  return a;
}

/* ---- 11. deposit / withdraw links ---- */
/* templates: { deposit: "https://pay.example/dep?login=#LOGIN#&cur=#CURRENCY#",
 *              withdrawal: "https://pay.example/wd?login=#LOGIN#" }
 * Macros: #LOGIN# #NAME# #CURRENCY# #SERVER# #GROUP#. */
function resolvePaymentUrl(account, kind, templates) {
  if (!account || typeof account !== "object") throw new Error("account required");
  if (kind !== "deposit" && kind !== "withdrawal") throw new Error("kind must be deposit or withdrawal");
  templates = templates || {};
  var tpl = templates[kind];
  if (typeof tpl !== "string" || tpl.length === 0) throw new Error("no " + kind + " URL configured");
  var macros = {
    "#LOGIN#": String(account.login),
    "#NAME#": encodeURIComponent(account.name || ""),
    "#CURRENCY#": account.currency || "",
    "#SERVER#": account.server || "",
    "#GROUP#": encodeURIComponent(account.group || "")
  };
  var url = tpl;
  for (var m in macros) if (Object.prototype.hasOwnProperty.call(macros, m))
    url = url.split(m).join(macros[m]);
  return url;
}

var ACCOUNTS = {
  ACCOUNT_TYPES: ACCOUNT_TYPES,
  TYPE_CAPS: TYPE_CAPS,
  DEAL_KINDS: DEAL_KINDS,
  DEFAULT_GROUP_FOR_TYPE: DEFAULT_GROUP_FOR_TYPE,
  IMPORT_COLUMNS: IMPORT_COLUMNS,
  makeAccountKey: makeAccountKey,
  typeCaps: typeCaps,
  defaultAccount: defaultAccount,
  validateAccount: validateAccount,
  canLogin: canLogin,
  canTrade: canTrade,
  applyBalanceOp: applyBalanceOp,
  checkBalance: checkBalance,
  fixBalance: fixBalance,
  archiveAccount: archiveAccount,
  restoreAccount: restoreAccount,
  parseImportRow: parseImportRow,
  importAccounts: importAccounts,
  defaultAllocationSettings: defaultAllocationSettings,
  allocateServer: allocateServer,
  linkCorporate: linkCorporate,
  unlinkCorporate: unlinkCorporate,
  resolvePaymentUrl: resolvePaymentUrl
};
if (typeof module !== "undefined" && module.exports) { module.exports = ACCOUNTS; }
else { root.OrbitAccounts = ACCOUNTS; }
})(typeof globalThis !== "undefined" ? globalThis : this);
