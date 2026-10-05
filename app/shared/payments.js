/* shared/payments.js — OrbitTrader payment-processing model.
 *
 * Reimplements the payment-processing concepts (provider integrations,
 * terminal deposit/withdrawal, manager confirmation, balance operations,
 * Active vs History sections, idempotency keys) as an independent model.
 * No vendor text is copied and no real provider brand names appear anywhere:
 * providers are configured by the broker with neutral ids (e.g. "card-psp-a",
 * "manual-bank") and a generic `kind` from PROVIDER_KINDS.
 *
 * Pure functions, no globals, no DOM: runs in the browser and in node
 * (guarded export at the bottom, same pattern as shared/groups.js).
 *
 * Model:
 *   - Provider config: a plain object describing one payment rail the broker
 *     has wired up. All money behaviour (fees, limits, confirmation rules)
 *     is data-driven from this config. These are OrbitTrader platform
 *     defaults, not any broker's values.
 *   - Transaction lifecycle (state machine in TRANSITIONS):
 *       draft -> pending -> awaiting_confirm -> processing -> completed
 *     with terminal exits rejected / cancelled / failed / expired.
 *     Deposits settle via a provider callback or (manual rails) via the
 *     manager's approval; withdrawals always pass a manager confirmation
 *     step and then a settlement step.
 *   - Active vs History: "active" = any non-terminal status (what the
 *     terminal shows under Active); "history" = terminal statuses.
 *   - Payment-order lifecycle (state machine in PAYMENT_TRANSITIONS,
 *     wave-4 extension below): initial -> processing -> waiting -> locked
 *     -> done, with terminal exits rejected / canceled / failed. A rules
 *     engine routes each new order to auto-processing, manual review, or
 *     rejection; operators lock waiting orders before accept/reject, and
 *     provider confirmations are idempotent per external reference. Every
 *     order also carries a unique internal_ref (internal payment number).
 *   - Idempotency: createTransaction() accepts an idempotency_key; a repeat
 *     submission with the same key and the same payload returns the original
 *     transaction instead of creating a duplicate. Keys expire after
 *     IDEMPOTENCY_WINDOW_HOURS.
 *   - Balance operations are pure: applyBalanceOp() computes the new balance
 *     and returns a ledger record; the caller persists it (see
 *     server/lib/payments.php and server/db/migrate-w3-payments.sql).
 */
(function (root) {
"use strict";

/* ---- 1. vocabularies ---- */

/* Neutral provider kinds. Brokers map their real rails onto these kinds;
 * the model never names a vendor. */
var PROVIDER_KINDS = ["card_psp", "ewallet", "crypto", "bank_transfer", "manual"];

var DIRECTIONS = ["deposit_only", "withdrawal_only", "both"];

var TXN_TYPES = ["deposit", "withdrawal"];

var TXN_STATUSES = ["draft", "pending", "awaiting_confirm", "processing",
                    "completed", "rejected", "cancelled", "failed", "expired"];

var ACTIVE_STATUSES = ["draft", "pending", "awaiting_confirm", "processing"];

var TERMINAL_STATUSES = ["completed", "rejected", "cancelled", "failed", "expired"];

/* Allowed edges of the lifecycle state machine. */
var TRANSITIONS = {
  draft:            ["pending", "cancelled", "expired"],
  pending:          ["awaiting_confirm", "completed", "failed", "cancelled", "expired"],
  awaiting_confirm: ["processing", "completed", "rejected", "cancelled"],
  processing:       ["completed", "failed"],
  completed:        [],
  rejected:         [],
  cancelled:        [],
  failed:           [],
  expired:          []
};

/* Idempotency keys are honoured for 24h after first use. */
var IDEMPOTENCY_WINDOW_HOURS = 24;

/* ---- 2. helpers ---- */

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function isFiniteNumber(v) {
  return typeof v === "number" && isFinite(v);
}

function genId(nowMs) {
  var t = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  return "ptx-" + t.toString(36) + "-" +
         Math.floor(Math.random() * 0xffffff).toString(36);
}

function isActive(status) {
  return ACTIVE_STATUSES.indexOf(status) !== -1;
}

function isTerminal(status) {
  return TERMINAL_STATUSES.indexOf(status) !== -1;
}

/* ---- 3. provider configs ----
 * Documented defaults per kind (OrbitTrader platform defaults):
 *   - Automated rails (card_psp, ewallet, crypto) settle deposits on the
 *     provider's callback, so confirm_deposit = false; a manager must still
 *     approve every withdrawal (confirm_withdrawal = true).
 *   - Assisted rails (bank_transfer, manual) need a manager to verify the
 *     money actually arrived/sent: both flags true.
 *   - settlement_ttl_hours: how long a pending deposit waits for the
 *     provider before expirePending() marks it expired. */
function defaultProviderConfig(kind) {
  if (PROVIDER_KINDS.indexOf(kind) === -1)
    throw new Error("payments: unknown provider kind: " + kind);
  var cfg = {
    id: "new-" + kind,   /* placeholder: the broker must assign its own neutral id */
    kind: kind,
    name: "",
    enabled: true,
    direction: "both",
    currencies: [],          /* empty = all currencies */
    countries: [],           /* empty = all countries */
    min_amount: 1.00,
    max_amount: null,        /* null = no cap */
    fee_pct: 0,
    fee_fixed: 0,
    fee_payer: "client",     /* "client" | "broker" */
    confirm_deposit: false,
    confirm_withdrawal: true,
    settlement_ttl_hours: 48,
    config: {}               /* provider credentials: server-side only */
  };
  if (kind === "crypto") cfg.settlement_ttl_hours = 72;
  if (kind === "bank_transfer") {
    cfg.confirm_deposit = true;
    cfg.settlement_ttl_hours = 120;
  }
  if (kind === "manual") {
    cfg.confirm_deposit = true;
    cfg.settlement_ttl_hours = 168;
  }
  return cfg;
}

/* Validation -> array of error strings (empty = valid). */
function validateProviderConfig(c) {
  var errs = [];
  function err(m) { errs.push(m); }
  if (!c || typeof c !== "object" || Array.isArray(c))
    return ["provider config must be an object"];

  if (typeof c.id !== "string" || c.id.replace(/^\s+|\s+$/g, "") === "")
    err("id must be a non-empty string (broker-assigned neutral provider id)");
  if (PROVIDER_KINDS.indexOf(c.kind) === -1)
    err("kind must be one of: " + PROVIDER_KINDS.join(", "));
  if (typeof c.name !== "string")
    err("name must be a string");
  if (typeof c.enabled !== "boolean")
    err("enabled must be a boolean");
  if (DIRECTIONS.indexOf(c.direction) === -1)
    err("direction must be one of: " + DIRECTIONS.join(", "));

  [["currencies", /^[A-Z]{3}$/], ["countries", /^[A-Z]{2}$/]].forEach(function (pair) {
    var f = pair[0], re = pair[1], v = c[f];
    if (!Array.isArray(v)) { err(f + " must be an array"); return; }
    v.forEach(function (x) {
      if (typeof x !== "string" || !re.test(x))
        err(f + " entries must be ISO codes, got: " + JSON.stringify(x));
    });
  });

  if (!isFiniteNumber(c.min_amount) || c.min_amount < 0)
    err("min_amount must be a number >= 0");
  if (c.max_amount !== null && c.max_amount !== undefined) {
    if (!isFiniteNumber(c.max_amount) || c.max_amount <= 0)
      err("max_amount must be null or a number > 0");
    else if (isFiniteNumber(c.min_amount) && c.max_amount < c.min_amount)
      err("max_amount must be >= min_amount");
  }
  if (!isFiniteNumber(c.fee_pct) || c.fee_pct < 0 || c.fee_pct > 100)
    err("fee_pct must be a number between 0 and 100");
  if (!isFiniteNumber(c.fee_fixed) || c.fee_fixed < 0)
    err("fee_fixed must be a number >= 0");
  if (c.fee_payer !== "client" && c.fee_payer !== "broker")
    err('fee_payer must be "client" or "broker"');
  if (typeof c.confirm_deposit !== "boolean")
    err("confirm_deposit must be a boolean");
  if (typeof c.confirm_withdrawal !== "boolean")
    err("confirm_withdrawal must be a boolean");
  if (!isFiniteNumber(c.settlement_ttl_hours) ||
      Math.floor(c.settlement_ttl_hours) !== c.settlement_ttl_hours ||
      c.settlement_ttl_hours <= 0)
    err("settlement_ttl_hours must be a positive integer");
  if (!c.config || typeof c.config !== "object" || Array.isArray(c.config))
    err("config must be an object");
  return errs;
}

/* ---- 4. quoting ----
 * Fee model (documented, data-driven):
 *   fee = amount * fee_pct / 100 + fee_fixed
 *   deposit:    broker credits `credit` = amount - (client pays fee ? fee : 0)
 *   withdrawal: broker debits  `debit`  = amount + (client pays fee ? fee : 0);
 *               the client receives `payout` = amount.
 * Returns {ok:true, ...} or {ok:false, errors:[...]}. */
function quotePayment(provider, type, amount) {
  var cfgErrs = validateProviderConfig(provider);
  if (cfgErrs.length) return { ok: false, errors: cfgErrs };
  if (TXN_TYPES.indexOf(type) === -1)
    return { ok: false, errors: ["type must be one of: " + TXN_TYPES.join(", ")] };
  if (!isFiniteNumber(amount) || amount <= 0)
    return { ok: false, errors: ["amount must be a number > 0"] };
  if (amount < provider.min_amount)
    return { ok: false, errors: ["amount below provider minimum of " + provider.min_amount] };
  if (provider.max_amount !== null && provider.max_amount !== undefined &&
      amount > provider.max_amount)
    return { ok: false, errors: ["amount above provider maximum of " + provider.max_amount] };
  if (provider.direction === "deposit_only" && type !== "deposit")
    return { ok: false, errors: ["provider is deposit-only"] };
  if (provider.direction === "withdrawal_only" && type !== "withdrawal")
    return { ok: false, errors: ["provider is withdrawal-only"] };
  if (!provider.enabled)
    return { ok: false, errors: ["provider is disabled"] };

  var fee = round2(amount * provider.fee_pct / 100 + provider.fee_fixed);
  var clientPays = provider.fee_payer === "client";
  var out = { ok: true, type: type, amount: round2(amount), fee: fee };
  if (type === "deposit") {
    out.credit = round2(amount - (clientPays ? fee : 0));
    if (out.credit <= 0)
      return { ok: false, errors: ["fee exceeds deposit amount"] };
  } else {
    out.debit = round2(amount + (clientPays ? fee : 0));
    out.payout = round2(amount);
  }
  return out;
}

/* ---- 5. store ----
 * A store is a plain object {txns: [], idempotency: {}} mutated in place.
 * nowMs is injected so tests are deterministic. */
function newStore() {
  return { txns: [], idempotency: {}, payments: [], payment_seq: 0 };
}

function findTxn(store, txnId) {
  for (var i = 0; i < store.txns.length; i++) {
    if (store.txns[i].id === txnId) return store.txns[i];
  }
  return null;
}

function idemFingerprint(input) {
  return [input.type, input.login, input.provider.id,
          Number(input.amount).toFixed(2), input.currency || ""].join("|");
}

function findByIdempotencyKey(store, key, nowMs) {
  var rec = store.idempotency[key];
  if (!rec) return null;
  var ageH = (nowMs - rec.created_at) / 3600000;
  if (ageH > IDEMPOTENCY_WINDOW_HOURS) return null;
  return findTxn(store, rec.txn_id);
}

function pruneIdempotency(store, nowMs) {
  var pruned = 0;
  for (var k in store.idempotency) {
    if (!Object.prototype.hasOwnProperty.call(store.idempotency, k)) continue;
    var ageH = (nowMs - store.idempotency[k].created_at) / 3600000;
    if (ageH > IDEMPOTENCY_WINDOW_HOURS) { delete store.idempotency[k]; pruned++; }
  }
  return pruned;
}

/* ---- 6. createTransaction ----
 * input: {id?, type, login, provider, amount, currency?, idempotency_key?,
 *         note?, meta?}
 * Initial status: deposit -> (confirm_deposit ? awaiting_confirm : pending);
 *                 withdrawal -> (confirm_withdrawal ? awaiting_confirm : processing).
 * A repeat call with the same idempotency_key + identical payload returns the
 * original transaction ({deduped:true}); the same key with a DIFFERENT
 * payload is rejected so a client can never silently double-spend. */
function createTransaction(store, input, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  if (!input || typeof input !== "object")
    return { ok: false, errors: ["input must be an object"] };

  var login = input.login;
  if (typeof login !== "number" || Math.floor(login) !== login || login <= 0)
    return { ok: false, errors: ["login must be a positive integer"] };

  var currency = input.currency === undefined ? "USD" : input.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
    return { ok: false, errors: ["currency must be a 3-letter ISO code"] };

  var q = quotePayment(input.provider, input.type, input.amount);
  if (!q.ok) return { ok: false, errors: q.errors };
  var provider = input.provider;

  if (input.idempotency_key !== undefined && input.idempotency_key !== null) {
    var key = input.idempotency_key;
    if (typeof key !== "string" || key === "")
      return { ok: false, errors: ["idempotency_key must be a non-empty string"] };
    var existing = findByIdempotencyKey(store, key, now);
    if (existing) {
      if (idemFingerprint(input) === idemFingerprint(existing._input))
        return { ok: true, deduped: true, txn: existing };
      return { ok: false,
               errors: ["idempotency key already used with a different payload"] };
    }
  }

  var needsConfirm = (input.type === "deposit")
      ? provider.confirm_deposit
      : provider.confirm_withdrawal;
  var status = input.type === "deposit"
      ? (needsConfirm ? "awaiting_confirm" : "pending")
      : (needsConfirm ? "awaiting_confirm" : "processing");

  var txn = {
    id: (typeof input.id === "string" && input.id !== "") ? input.id : genId(now),
    type: input.type,
    login: login,
    provider_id: provider.id,
    provider_kind: provider.kind,
    amount: q.amount,
    fee: q.fee,
    fee_payer: provider.fee_payer,
    currency: currency,
    status: status,
    idempotency_key: input.idempotency_key || null,
    provider_ref: null,
    note: (typeof input.note === "string") ? input.note : "",
    meta: (input.meta && typeof input.meta === "object") ? input.meta : {},
    confirmed_by: null,
    confirmed_at: null,
    settled_by: null,
    settled_at: null,
    created_at: now,
    updated_at: now,
    expires_at: (status === "pending" || status === "draft")
        ? now + provider.settlement_ttl_hours * 3600000
        : null,
    _input: { type: input.type, login: login, provider: { id: provider.id },
              amount: input.amount, currency: currency }
  };
  /* Balance effect of this transaction once settled (computed at creation so
   * the ledger is auditable even if the provider config changes later). */
  if (input.type === "deposit") {
    txn.credit = q.credit;
    txn.debit = 0;
  } else {
    txn.credit = 0;
    txn.debit = q.debit;
    txn.payout = q.payout;
  }

  store.txns.push(txn);
  if (txn.idempotency_key)
    store.idempotency[txn.idempotency_key] = { txn_id: txn.id, created_at: now };
  return { ok: true, deduped: false, txn: txn };
}

/* ---- 7. state transitions ---- */

function touch(txn, now) {
  txn.updated_at = now;
  return txn;
}

function failResult(msg) { return { ok: false, errors: [msg] }; }

/* Provider webhook: only a "pending" deposit can be confirmed/failed here.
 * confirmed -> completed (+ balance op to persist); failed -> failed. */
function providerCallback(store, txnId, event, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  var txn = findTxn(store, txnId);
  if (!txn) return failResult("transaction not found: " + txnId);
  if (!event || typeof event !== "object") return failResult("event must be an object");
  if (txn.type !== "deposit")
    return failResult("provider callbacks apply to deposits only");
  if (txn.status !== "pending")
    return failResult("provider callback requires status pending, got " + txn.status);
  if (event.outcome !== "confirmed" && event.outcome !== "failed")
    return failResult('event.outcome must be "confirmed" or "failed"');
  if (event.provider_ref !== undefined && event.provider_ref !== null &&
      typeof event.provider_ref !== "string")
    return failResult("event.provider_ref must be a string");

  if (event.provider_ref) txn.provider_ref = event.provider_ref;
  if (typeof event.note === "string" && event.note !== "") txn.note = event.note;
  txn.status = event.outcome === "confirmed" ? "completed" : "failed";
  if (event.outcome === "confirmed") {
    txn.settled_at = now;
    txn.settled_by = "provider";
  }
  touch(txn, now);
  var res = { ok: true, txn: touch(txn, now) };
  if (event.outcome === "confirmed")
    res.balance_op = balanceOpFor(txn);
  return res;
}

/* Manager confirmation step. approve:
 *   deposit    -> completed (+ balance op): on manual/assisted rails the
 *               manager's approval IS the receipt verification.
 *   withdrawal -> processing (the broker still has to execute the payout;
 *               settleTransaction() finishes it).
 * reject -> rejected. */
function confirmTransaction(store, txnId, manager, decision, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  var txn = findTxn(store, txnId);
  if (!txn) return failResult("transaction not found: " + txnId);
  if (txn.status !== "awaiting_confirm")
    return failResult("confirmation requires status awaiting_confirm, got " + txn.status);
  var who = (manager && typeof manager.username === "string")
      ? manager.username.replace(/^\s+|\s+$/g, "") : "";
  if (who === "") return failResult("manager username is required");
  if (decision !== "approve" && decision !== "reject")
    return failResult('decision must be "approve" or "reject"');

  txn.confirmed_by = who;
  txn.confirmed_at = now;
  var res = { ok: true };
  if (decision === "reject") {
    txn.status = "rejected";
    res.txn = touch(txn, now);
    return res;
  }
  if (txn.type === "deposit") {
    txn.status = "completed";
    txn.settled_at = now;
    txn.settled_by = who;
    res.balance_op = balanceOpFor(txn);
  } else {
    txn.status = "processing";
  }
  res.txn = touch(txn, now);
  return res;
}

/* Settlement of a withdrawal that is "processing".
 * success -> completed (+ balance op to persist); fail -> failed. */
function settleTransaction(store, txnId, manager, outcome, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  var txn = findTxn(store, txnId);
  if (!txn) return failResult("transaction not found: " + txnId);
  if (txn.type !== "withdrawal")
    return failResult("settlement applies to withdrawals only");
  if (txn.status !== "processing")
    return failResult("settlement requires status processing, got " + txn.status);
  var who = (manager && typeof manager.username === "string")
      ? manager.username.replace(/^\s+|\s+$/g, "") : "";
  if (who === "") return failResult("manager username is required");
  if (outcome !== "success" && outcome !== "fail")
    return failResult('outcome must be "success" or "fail"');

  var res = { ok: true };
  if (outcome === "success") {
    txn.status = "completed";
    txn.settled_at = now;
    txn.settled_by = who;
    res.balance_op = balanceOpFor(txn);
  } else {
    txn.status = "failed";
    txn.settled_at = now;
    txn.settled_by = who;
  }
  res.txn = touch(txn, now);
  return res;
}

/* Cancellation: allowed while the money has not moved (draft/pending/
 * awaiting_confirm). A processing withdrawal must be settled, not cancelled. */
function cancelTransaction(store, txnId, actor, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  var txn = findTxn(store, txnId);
  if (!txn) return failResult("transaction not found: " + txnId);
  if (["draft", "pending", "awaiting_confirm"].indexOf(txn.status) === -1)
    return failResult("cannot cancel a transaction with status " + txn.status);
  var who = typeof actor === "string" ? actor.replace(/^\s+|\s+$/g, "") : "";
  txn.status = "cancelled";
  if (who !== "") txn.note = (txn.note ? txn.note + " | " : "") + "cancelled by " + who;
  return { ok: true, txn: touch(txn, now) };
}

/* Mark stale draft/pending transactions expired. Returns the expired ids. */
function expirePending(store, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  var expired = [];
  store.txns.forEach(function (txn) {
    if ((txn.status === "draft" || txn.status === "pending") &&
        typeof txn.expires_at === "number" && txn.expires_at <= now) {
      txn.status = "expired";
      touch(txn, now);
      expired.push(txn.id);
    }
  });
  return expired;
}

/* ---- 8. balance operations ----
 * Pure: computes the new balance and returns the ledger record the caller
 * must persist alongside the accounts.balance update. Never mutates inputs.
 * account: {login, balance, currency}. op: {txn_id, type, amount, fee,
 *          fee_payer, currency}.
 * deposit:    credit = amount - (client pays fee ? fee : 0)
 * withdrawal: debit  = amount + (client pays fee ? fee : 0); insufficient
 *             funds -> {ok:false}. */
function applyBalanceOp(account, op) {
  if (!account || typeof account !== "object")
    return { ok: false, errors: ["account must be an object"] };
  if (!op || typeof op !== "object")
    return { ok: false, errors: ["op must be an object"] };
  if (TXN_TYPES.indexOf(op.type) === -1)
    return { ok: false, errors: ["op.type must be deposit or withdrawal"] };
  if (!isFiniteNumber(account.balance) || account.balance < 0)
    return { ok: false, errors: ["account.balance must be a number >= 0"] };
  if (!isFiniteNumber(op.amount) || op.amount <= 0)
    return { ok: false, errors: ["op.amount must be a number > 0"] };
  var fee = isFiniteNumber(op.fee) && op.fee >= 0 ? op.fee : 0;
  if (typeof op.currency !== "string" || op.currency !== account.currency)
    return { ok: false, errors: ["op currency must match account currency"] };

  var clientPays = op.fee_payer !== "broker"; /* default: client pays */
  var ledger = {
    txn_id: op.txn_id || null,
    login: account.login,
    currency: account.currency,
    amount: round2(op.amount),
    fee: round2(fee),
    balance_before: round2(account.balance)
  };
  if (op.type === "deposit") {
    ledger.direction = "credit";
    ledger.credit = round2(op.amount - (clientPays ? fee : 0));
    if (ledger.credit <= 0)
      return { ok: false, errors: ["fee exceeds deposit amount"] };
    ledger.balance_after = round2(account.balance + ledger.credit);
  } else {
    ledger.direction = "debit";
    ledger.debit = round2(op.amount + (clientPays ? fee : 0));
    if (ledger.debit > account.balance)
      return { ok: false, errors: ["insufficient funds"] };
    ledger.balance_after = round2(account.balance - ledger.debit);
  }
  return { ok: true, ledger: ledger };
}

/* Ledger record for a settled transaction (persist + apply to balance). */
function balanceOpFor(txn) {
  if (txn.type === "deposit") {
    return { txn_id: txn.id, type: "deposit", amount: txn.amount,
             fee: txn.fee, fee_payer: txn.fee_payer, currency: txn.currency };
  }
  return { txn_id: txn.id, type: "withdrawal", amount: txn.amount,
           fee: txn.fee, fee_payer: txn.fee_payer, currency: txn.currency };
}

/* ---- 9. Active vs History sections ---- */

function byCreatedDesc(a, b) {
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

/* What the terminal shows under "Active": everything not yet terminal. */
function listActive(txns) {
  return (Array.isArray(txns) ? txns : [])
      .filter(function (t) { return isActive(t.status); })
      .sort(byCreatedDesc);
}

/* What the terminal shows under "History": terminal states only. */
function listHistory(txns) {
  return (Array.isArray(txns) ? txns : [])
      .filter(function (t) { return isTerminal(t.status); })
      .sort(byCreatedDesc);
}

function sectionCounts(txns) {
  var c = { active: 0, history: 0 };
  (Array.isArray(txns) ? txns : []).forEach(function (t) {
    if (isActive(t.status)) c.active++;
    else if (isTerminal(t.status)) c.history++;
  });
  return c;
}

/* ---- 10. payment-order lifecycle (broker-side processing) ----
 * A payment order is the broker-facing record of a client money request
 * (deposit or withdrawal) as it moves through the operations pipeline. It
 * answers "what is the broker doing about this payment right now" and is
 * separate from the transaction settlement layer above.
 *
 * States:
 *   initial    order created, not yet evaluated by the rules engine.
 *   processing an automated rail is working on it, or a rule auto-processed
 *              it and it awaits provider confirmation.
 *   waiting    routed to manual review; sits in the operator queue.
 *   locked     an operator claimed it (locked_by) and is working it; no
 *              other operator may act on it until it is released or decided.
 *   done       accepted / confirmed: the money flow completed.
 *   rejected   refused by a rule or by the locking operator (with reason).
 *   canceled   cancelled by the client or an operator before completion.
 *   failed     the rail reported a processing failure.
 *
 * PAYMENT_TRANSITIONS is the validated state machine: transitionPayment()
 * rejects any edge not listed here, so illegal jumps (e.g. initial -> done
 * or waiting -> done) can never happen. Every transition is appended to
 * the order's state_history for audit.
 *
 * Money movement itself stays in the transaction layer (applyBalanceOp);
 * payment orders only gate the decision flow. */

var PAYMENT_STATES = ["initial", "processing", "waiting", "locked",
                      "done", "rejected", "canceled", "failed"];

var PAYMENT_ACTIVE_STATES = ["initial", "processing", "waiting", "locked"];

var PAYMENT_TERMINAL_STATES = ["done", "rejected", "canceled", "failed"];

var PAYMENT_TRANSITIONS = {
  initial:    ["processing", "waiting", "rejected", "canceled"],
  processing: ["waiting", "done", "failed", "rejected", "canceled"],
  waiting:    ["locked", "canceled"],
  locked:     ["done", "rejected", "waiting", "canceled"],
  done:       [],
  rejected:   [],
  canceled:   [],
  failed:     []
};

var RULE_ACTIONS = ["auto", "manual", "reject"];

function isPaymentActive(state) {
  return PAYMENT_ACTIVE_STATES.indexOf(state) !== -1;
}

function isPaymentTerminal(state) {
  return PAYMENT_TERMINAL_STATES.indexOf(state) !== -1;
}

function findPayment(store, paymentId) {
  var arr = (store && Array.isArray(store.payments)) ? store.payments : [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id === paymentId) return arr[i];
  }
  return null;
}

function genPaymentId(nowMs) {
  var t = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  return "pmt-" + t.toString(36) + "-" +
         Math.floor(Math.random() * 0xffffff).toString(36);
}

/* Unique internal payment number, e.g. "PMT-000123". The sequence lives on
 * the store; brokers persisting to MySQL should back it with a table
 * sequence / AUTO_INCREMENT so numbers survive restarts and stay unique
 * across processes (pure-JS in-memory counter is process-local). */
function nextInternalRef(store) {
  store.payment_seq = (typeof store.payment_seq === "number" ? store.payment_seq : 0) + 1;
  var s = String(store.payment_seq);
  while (s.length < 6) s = "0" + s;
  return "PMT-" + s;
}

function internalRefTaken(store, ref, exceptId) {
  var arr = Array.isArray(store.payments) ? store.payments : [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].internal_ref === ref && arr[i].id !== exceptId) return true;
  }
  return false;
}

/* Operator identity: accepts {id: "..."} or a bare id string. */
function operatorId(operator) {
  if (typeof operator === "string") return operator.replace(/^\s+|\s+$/g, "");
  if (operator && typeof operator.id === "string")
    return operator.id.replace(/^\s+|\s+$/g, "");
  return "";
}

/* ---- 11. createPayment ----
 * input: {id?, type, login, method, amount, currency?, internal_ref?,
 *         note?, meta?}
 * method is a broker-neutral payment-method id (e.g. "card-psp-a",
 * "manual-bank"); it is what the rules engine matches on.
 * Every order starts in "initial" and is routed by applyPaymentRules(). */
function createPayment(store, input, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  if (!input || typeof input !== "object")
    return { ok: false, errors: ["input must be an object"] };

  var login = input.login;
  if (typeof login !== "number" || Math.floor(login) !== login || login <= 0)
    return failResult("login must be a positive integer");
  if (TXN_TYPES.indexOf(input.type) === -1)
    return failResult("type must be one of: " + TXN_TYPES.join(", "));
  if (!isFiniteNumber(input.amount) || input.amount <= 0)
    return failResult("amount must be a number > 0");

  var currency = input.currency === undefined ? "USD" : input.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
    return failResult("currency must be a 3-letter ISO code");

  var method = (typeof input.method === "string")
      ? input.method.replace(/^\s+|\s+$/g, "") : "";
  if (method === "")
    return failResult("method must be a non-empty string (broker-neutral payment method id)");

  var id = (typeof input.id === "string" && input.id !== "") ? input.id : genPaymentId(now);
  if (findPayment(store, id))
    return failResult("payment id already exists: " + id);

  var ref = (typeof input.internal_ref === "string" && input.internal_ref !== "")
      ? input.internal_ref : nextInternalRef(store);
  if (internalRefTaken(store, ref, id))
    return failResult("internal_ref already used: " + ref);

  var p = {
    id: id,
    type: input.type,
    login: login,
    method: method,
    amount: round2(input.amount),
    currency: currency,
    state: "initial",
    internal_ref: ref,
    locked_by: null,
    locked_at: null,
    external_ref: null,
    confirmed_at: null,
    accepted_by: null,
    accepted_at: null,
    reject_reason: null,
    note: (typeof input.note === "string") ? input.note : "",
    meta: (input.meta && typeof input.meta === "object") ? input.meta : {},
    state_history: [{ from: null, to: "initial", at: now, actor: "system" }],
    created_at: now,
    updated_at: now
  };
  if (!Array.isArray(store.payments)) store.payments = [];
  store.payments.push(p);
  return { ok: true, payment: p };
}

/* ---- 12. validated state transitions ----
 * transitionPayment(store, paymentId, to, opts?, nowMs)
 * The single gate for every state change: the edge must be listed in
 * PAYMENT_TRANSITIONS, otherwise the call is rejected and nothing is
 * mutated. opts: {actor?, note?}. Successful transitions are appended to
 * state_history. */
function transitionPayment(store, paymentId, to, opts, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  var p = findPayment(store, paymentId);
  if (!p) return failResult("payment not found: " + paymentId);
  if (PAYMENT_STATES.indexOf(to) === -1)
    return failResult("unknown payment state: " + JSON.stringify(to));
  if (PAYMENT_TRANSITIONS[p.state].indexOf(to) === -1)
    return failResult("illegal payment transition: " + p.state + " -> " + to);
  var actor = (opts && typeof opts.actor === "string") ? opts.actor : "";
  p.state_history.push({ from: p.state, to: to, at: now, actor: actor });
  p.state = to;
  if (opts && typeof opts.note === "string" && opts.note !== "")
    p.note = (p.note ? p.note + " | " : "") + opts.note;
  return { ok: true, payment: touch(p, now) };
}

/* ---- 13. rules-based processing ----
 * A rule: {id, name?, match: {method?, type?, currency?, min_amount?,
 * max_amount?}, action: "auto"|"manual"|"reject", reject_reason?}
 *   method/currency: string or array of strings (payment must match one).
 *   type: "deposit" | "withdrawal".
 *   min_amount / max_amount: inclusive amount bounds.
 * An empty match {} is a catch-all. Rules are evaluated in array order and
 * the FIRST matching rule wins; when nothing matches the default is
 * "manual" (money is never auto-processed by accident).
 *   auto   -> initial -> processing  (an automated rail takes it over)
 *   manual -> initial -> waiting     (operator review queue)
 *   reject -> initial -> rejected    (with reject_reason) */
function strOrStrArr(v) {
  if (typeof v === "string" && v !== "") return true;
  return Array.isArray(v) && v.length > 0 &&
      v.every(function (x) { return typeof x === "string" && x !== ""; });
}

function validatePaymentRules(rules) {
  var errs = [];
  if (!Array.isArray(rules)) return ["rules must be an array"];
  var seen = {};
  rules.forEach(function (r, i) {
    var at = "rules[" + i + "]";
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      errs.push(at + " must be an object"); return;
    }
    if (typeof r.id !== "string" || r.id.replace(/^\s+|\s+$/g, "") === "")
      errs.push(at + ".id must be a non-empty string");
    else if (seen[r.id]) errs.push(at + '.id duplicates "' + r.id + '"');
    else seen[r.id] = 1;
    if (RULE_ACTIONS.indexOf(r.action) === -1)
      errs.push(at + ".action must be one of: " + RULE_ACTIONS.join(", "));
    var m = r.match;
    if (m === undefined) m = {};
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      errs.push(at + ".match must be an object"); return;
    }
    if (m.method !== undefined && !strOrStrArr(m.method))
      errs.push(at + ".match.method must be a non-empty string or array of strings");
    if (m.type !== undefined && TXN_TYPES.indexOf(m.type) === -1)
      errs.push(at + ".match.type must be one of: " + TXN_TYPES.join(", "));
    if (m.currency !== undefined && !strOrStrArr(m.currency))
      errs.push(at + ".match.currency must be a non-empty string or array of strings");
    if (m.min_amount !== undefined &&
        (!isFiniteNumber(m.min_amount) || m.min_amount < 0))
      errs.push(at + ".match.min_amount must be a number >= 0");
    if (m.max_amount !== undefined &&
        (!isFiniteNumber(m.max_amount) || m.max_amount <= 0))
      errs.push(at + ".match.max_amount must be a number > 0");
    if (isFiniteNumber(m.min_amount) && isFiniteNumber(m.max_amount) &&
        m.max_amount < m.min_amount)
      errs.push(at + ".match.max_amount must be >= min_amount");
    if (r.action === "reject" && r.reject_reason !== undefined &&
        (typeof r.reject_reason !== "string" || r.reject_reason === ""))
      errs.push(at + ".reject_reason must be a non-empty string when provided");
  });
  return errs;
}

function ruleMatches(rule, p) {
  var m = rule.match || {};
  function anyOf(field, value) {
    if (field === undefined) return true;
    var list = Array.isArray(field) ? field : [field];
    return list.indexOf(value) !== -1;
  }
  if (!anyOf(m.method, p.method)) return false;
  if (m.type !== undefined && m.type !== p.type) return false;
  if (!anyOf(m.currency, p.currency)) return false;
  if (m.min_amount !== undefined && !(p.amount >= m.min_amount)) return false;
  if (m.max_amount !== undefined && !(p.amount <= m.max_amount)) return false;
  return true;
}

/* Pure: no store access, no mutation. Returns {matched, action}. */
function evaluatePaymentRules(rules, payment) {
  for (var i = 0; i < rules.length; i++) {
    if (ruleMatches(rules[i], payment))
      return { matched: rules[i], action: rules[i].action };
  }
  return { matched: null, action: "manual" };
}

/* Route one "initial" order through the rule set. Returns
 * {ok, payment, rule, action}. Only orders in "initial" may be routed. */
function applyPaymentRules(store, paymentId, rules, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  var ruleErrs = validatePaymentRules(rules);
  if (ruleErrs.length) return { ok: false, errors: ruleErrs };
  var p = findPayment(store, paymentId);
  if (!p) return failResult("payment not found: " + paymentId);
  if (p.state !== "initial")
    return failResult("rules apply to payments in state initial, got " + p.state);

  var ev = evaluatePaymentRules(rules, p);
  var to, opts = { actor: "rules" };
  if (ev.action === "auto") {
    to = "processing";
  } else if (ev.action === "manual") {
    to = "waiting";
  } else {
    to = "rejected";
    p.reject_reason = (ev.matched && typeof ev.matched.reject_reason === "string" &&
                       ev.matched.reject_reason !== "")
        ? ev.matched.reject_reason
        : "rejected by processing rules";
  }
  var tr = transitionPayment(store, paymentId, to, opts, now);
  if (!tr.ok) return tr;
  return { ok: true, payment: tr.payment, rule: ev.matched, action: ev.action };
}

/* ---- 14. lock -> accept/reject flow ----
 * A waiting order is claimed by an operator (lock), who then either accepts
 * it (done) or rejects it with a reason (rejected). The lock belongs to the
 * locking operator: a second operator's lock is denied, and only the
 * locking operator may accept or reject. Re-locking by the same operator
 * refreshes the lock (idempotent retry) without duplicating history. */

function lockPayment(store, paymentId, operator, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  var op = operatorId(operator);
  if (op === "") return failResult("operator id is required to lock a payment");
  var p = findPayment(store, paymentId);
  if (!p) return failResult("payment not found: " + paymentId);
  if (p.state === "locked") {
    if (p.locked_by !== op)
      return failResult('payment is already locked by operator "' + p.locked_by + '"');
    p.locked_at = now; /* same-operator re-lock: refresh, stay locked */
    return { ok: true, relocked: true, payment: touch(p, now) };
  }
  if (p.state !== "waiting")
    return failResult("lock requires state waiting, got " + p.state);
  p.locked_by = op;
  p.locked_at = now;
  var tr = transitionPayment(store, paymentId, "locked", { actor: op }, now);
  if (!tr.ok) { p.locked_by = null; p.locked_at = null; return tr; }
  return { ok: true, relocked: false, payment: tr.payment };
}

function requireLocker(p, op) {
  if (p.state !== "locked")
    return "decision requires state locked, got " + p.state;
  if (p.locked_by !== op)
    return 'only the locking operator ("' + (p.locked_by || "none") +
           '") may decide this payment';
  return null;
}

function acceptPayment(store, paymentId, operator, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  var op = operatorId(operator);
  if (op === "") return failResult("operator id is required to accept a payment");
  var p = findPayment(store, paymentId);
  if (!p) return failResult("payment not found: " + paymentId);
  var blocked = requireLocker(p, op);
  if (blocked) return failResult(blocked);
  p.accepted_by = op;
  p.accepted_at = now;
  var tr = transitionPayment(store, paymentId, "done", { actor: op }, now);
  if (!tr.ok) { p.accepted_by = null; p.accepted_at = null; return tr; }
  return { ok: true, payment: tr.payment };
}

function rejectPayment(store, paymentId, operator, reason, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  var op = operatorId(operator);
  if (op === "") return failResult("operator id is required to reject a payment");
  if (typeof reason !== "string" || reason.replace(/^\s+|\s+$/g, "") === "")
    return failResult("a rejection reason is required");
  var p = findPayment(store, paymentId);
  if (!p) return failResult("payment not found: " + paymentId);
  var blocked = requireLocker(p, op);
  if (blocked) return failResult(blocked);
  p.reject_reason = reason;
  var tr = transitionPayment(store, paymentId, "rejected", { actor: op }, now);
  if (!tr.ok) { p.reject_reason = null; return tr; }
  return { ok: true, payment: tr.payment };
}

/* ---- 15. idempotent confirmations ----
 * Provider-side confirmation of an auto-processed ("processing") order:
 * confirmPayment(store, paymentId, externalRef, amount?, nowMs).
 *   - processing + matching amount -> done (external_ref recorded).
 *   - already done + same externalRef (+ same or omitted amount) -> the
 *     existing record is returned UNCHANGED ({deduped:true}); no duplicate,
 *     no re-stamp (updated_at is untouched).
 *   - already done + different externalRef or amount -> rejected: the
 *     caller is confirming something else under the same id.
 *   - any other state -> rejected (waiting orders use lock/accept/reject). */
function confirmPayment(store, paymentId, externalRef, amount, nowMs) {
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  if (typeof externalRef !== "string" || externalRef.replace(/^\s+|\s+$/g, "") === "")
    return failResult("external reference is required to confirm a payment");
  var amt = null;
  if (amount !== undefined && amount !== null) {
    if (!isFiniteNumber(amount) || amount <= 0)
      return failResult("amount must be a number > 0 when provided");
    amt = round2(amount);
  }
  var p = findPayment(store, paymentId);
  if (!p) return failResult("payment not found: " + paymentId);

  if (p.state === "done") {
    var sameRef = p.external_ref === externalRef;
    var sameAmt = amt === null || amt === p.amount;
    if (sameRef && sameAmt)
      return { ok: true, deduped: true, payment: p }; /* unchanged record */
    return failResult("payment is already done with a different reference or amount");
  }
  if (p.state !== "processing")
    return failResult("confirmation requires state processing, got " + p.state);
  if (amt !== null && amt !== p.amount)
    return failResult("confirmation amount " + amt + " does not match payment amount " +
                      p.amount);
  p.external_ref = externalRef;
  p.confirmed_at = now;
  var tr = transitionPayment(store, paymentId, "done", { actor: "provider" }, now);
  if (!tr.ok) { p.external_ref = null; p.confirmed_at = null; return tr; }
  return { ok: true, deduped: false, payment: tr.payment };
}

/* ---- 16. payment Active vs History sections ----
 * Mirrors the transaction sections: the operations dashboard shows
 * non-terminal orders under "Active" and terminal ones under "History". */

function listActivePayments(payments) {
  return (Array.isArray(payments) ? payments : [])
      .filter(function (p) { return isPaymentActive(p.state); })
      .sort(byCreatedDesc);
}

function listPaymentHistory(payments) {
  return (Array.isArray(payments) ? payments : [])
      .filter(function (p) { return isPaymentTerminal(p.state); })
      .sort(byCreatedDesc);
}

function paymentSectionCounts(payments) {
  var c = { active: 0, history: 0 };
  (Array.isArray(payments) ? payments : []).forEach(function (p) {
    if (isPaymentActive(p.state)) c.active++;
    else if (isPaymentTerminal(p.state)) c.history++;
  });
  return c;
}

var PAYMENTS = {
  PROVIDER_KINDS: PROVIDER_KINDS,
  DIRECTIONS: DIRECTIONS,
  TXN_TYPES: TXN_TYPES,
  TXN_STATUSES: TXN_STATUSES,
  ACTIVE_STATUSES: ACTIVE_STATUSES,
  TERMINAL_STATUSES: TERMINAL_STATUSES,
  TRANSITIONS: TRANSITIONS,
  IDEMPOTENCY_WINDOW_HOURS: IDEMPOTENCY_WINDOW_HOURS,
  round2: round2,
  isActive: isActive,
  isTerminal: isTerminal,
  defaultProviderConfig: defaultProviderConfig,
  validateProviderConfig: validateProviderConfig,
  quotePayment: quotePayment,
  newStore: newStore,
  findTxn: findTxn,
  findByIdempotencyKey: findByIdempotencyKey,
  pruneIdempotency: pruneIdempotency,
  createTransaction: createTransaction,
  providerCallback: providerCallback,
  confirmTransaction: confirmTransaction,
  settleTransaction: settleTransaction,
  cancelTransaction: cancelTransaction,
  expirePending: expirePending,
  applyBalanceOp: applyBalanceOp,
  balanceOpFor: balanceOpFor,
  listActive: listActive,
  listHistory: listHistory,
  sectionCounts: sectionCounts,
  PAYMENT_STATES: PAYMENT_STATES,
  PAYMENT_ACTIVE_STATES: PAYMENT_ACTIVE_STATES,
  PAYMENT_TERMINAL_STATES: PAYMENT_TERMINAL_STATES,
  PAYMENT_TRANSITIONS: PAYMENT_TRANSITIONS,
  RULE_ACTIONS: RULE_ACTIONS,
  isPaymentActive: isPaymentActive,
  isPaymentTerminal: isPaymentTerminal,
  findPayment: findPayment,
  createPayment: createPayment,
  transitionPayment: transitionPayment,
  validatePaymentRules: validatePaymentRules,
  evaluatePaymentRules: evaluatePaymentRules,
  applyPaymentRules: applyPaymentRules,
  lockPayment: lockPayment,
  acceptPayment: acceptPayment,
  rejectPayment: rejectPayment,
  confirmPayment: confirmPayment,
  listActivePayments: listActivePayments,
  listPaymentHistory: listPaymentHistory,
  paymentSectionCounts: paymentSectionCounts
};
if (typeof module !== "undefined" && module.exports) { module.exports = PAYMENTS; }
else { root.OrbitPayments = PAYMENTS; }
})(typeof globalThis !== "undefined" ? globalThis : this);
