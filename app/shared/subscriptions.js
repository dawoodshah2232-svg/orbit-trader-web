/* OrbitTrader — paid trader subscriptions (independent implementation).
 * Behavioral reference: broker admin docs, "Subscriptions": paid trader
 * services charged from the account balance ("charge" operation), automated
 * renewal attempts, suspension when funds are insufficient, real accounts only.
 * Reimplemented from behavior only — no vendor text, branding, or prices.
 *
 * Pure module: no I/O, no Date.now() inside (callers pass `now` as a Date,
 * defaulting to new Date() only when omitted). Account shape mirrors
 * server/db/schema.sql `accounts`: { login, type: 'demo'|'live', balance,
 * group, currency }. Product shape: { id, name, price, period_days, currency,
 * groups?, countries? }.
 */
"use strict";

const STATUS = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
};

/* ---- market-data levels + entitlements ---------------------------------- */
/* Market data is sold in ascending levels: Delayed < Level 1 < Level 2 <
 * Tick history. A subscription grants one level (optional
 * product.data_level); levels stack — the account's effective level is the
 * highest level any of its ACTIVE subscriptions grants. Entitlements (e.g.
 * "news") are independent per-subscription flags that gate other services. */
const DATA_LEVELS = {
  DELAYED: "delayed",
  LEVEL1: "level1",
  LEVEL2: "level2",
  TICKS: "ticks",
};

const DATA_LEVEL_RANK = {
  delayed: 0,
  level1: 1,
  level2: 2,
  ticks: 3,
};

const RANK_TO_LEVEL = Object.keys(DATA_LEVEL_RANK).reduce((acc, lvl) => {
  acc[DATA_LEVEL_RANK[lvl]] = lvl;
  return acc;
}, {});

const ENTITLEMENT_NEWS = "news";

const MAX_CONNECTIONS_PER_SUBSCRIPTION = 3;

const DEFAULT_MAX_RENEWAL_RETRIES = 24;
const DEFAULT_RETRY_INTERVAL_HOURS = 1;

const OP_CHARGE = "charge";

function isString(v) {
  return typeof v === "string" && v.length > 0;
}

/* ---- product config -------------------------------------------------- */

function validateProduct(p) {
  if (!p || typeof p !== "object") return { ok: false, error: "product required" };
  if (!isString(p.id)) return { ok: false, error: "product.id must be a non-empty string" };
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(p.id)) return { ok: false, error: "product.id must be a slug" };
  if (!isString(p.name)) return { ok: false, error: "product.name required" };
  if (typeof p.price !== "number" || !(p.price >= 0)) return { ok: false, error: "product.price must be a non-negative number" };
  if (!Number.isInteger(p.period_days) || p.period_days < 1) return { ok: false, error: "product.period_days must be a positive integer" };
  if (!isString(p.currency) || p.currency.length !== 3) return { ok: false, error: "product.currency must be a 3-letter code" };
  for (const key of ["groups", "countries"]) {
    if (p[key] !== undefined && !Array.isArray(p[key])) return { ok: false, error: "product." + key + " must be an array" };
  }
  /* Optional market-data level: one of delayed|level1|level2|ticks.
   * Optional entitlements: non-empty string flags (e.g. "news"). */
  if (p.data_level !== undefined && !(typeof p.data_level === "string" && p.data_level in DATA_LEVEL_RANK)) {
    return { ok: false, error: "product.data_level must be one of: delayed, level1, level2, ticks" };
  }
  if (p.entitlements !== undefined) {
    if (!Array.isArray(p.entitlements)) return { ok: false, error: "product.entitlements must be an array" };
    if (!p.entitlements.every(isString)) return { ok: false, error: "product.entitlements must be non-empty strings" };
  }
  return { ok: true };
}

/* Permission lists: an empty/missing list means "allowed everywhere".
 * country is checked only when the account carries one. */
function productAllowsAccount(product, account) {
  if (!product || !account) return false;
  if (Array.isArray(product.groups) && product.groups.length > 0) {
    if (!isString(account.group) || product.groups.indexOf(account.group) < 0) return false;
  }
  if (Array.isArray(product.countries) && product.countries.length > 0) {
    if (isString(account.country) && product.countries.indexOf(account.country) < 0) return false;
  }
  return true;
}

/* ---- real-accounts-only rule ------------------------------------------ */
/* Demo (and any non-live) accounts may not buy subscriptions. There is no
 * balance to charge meaningfully and billing rules differ per group. */
function isRealAccount(account) {
  return !!account && account.type === "live";
}

/* ---- renewal date math (UTC) ------------------------------------------ */

function addDaysUTC(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function nextRenewalFrom(now, periodDays) {
  return addDaysUTC(now, periodDays);
}

function renewalDue(sub, now) {
  if (!sub || sub.status !== STATUS.ACTIVE) return false;
  return new Date(sub.next_renewal_at).getTime() <= now.getTime();
}

/* ---- charge attempt --------------------------------------------------- */
/* Returns { outcome: 'charged', op, newBalance } or
 *         { outcome: 'suspended', suspension } — the latter when the balance
 * does not cover the price. Callers persist op / subscription patches.
 * The charge operation is a plain balance operation the server applies:
 *   { type: 'charge', amount, comment, product_id, login }        */
function chargeAttempt(account, product, now) {
  const price = Number(product.price);
  const balance = Number(account.balance);
  const stamp = (now || new Date()).toISOString();
  if (!(balance >= price)) {
    // insufficient funds -> suspension patch (no charge op emitted)
    return {
      outcome: "suspended",
      suspension: {
        status: STATUS.SUSPENDED,
        suspended_at: stamp,
        last_charge_outcome: "insufficient_funds",
      },
    };
  }
  return {
    outcome: "charged",
    op: {
      type: OP_CHARGE,
      amount: -price, // negative = deducted from the account balance
      comment: "Subscription: " + product.name + " (" + product.period_days + " days)",
      product_id: product.id,
      login: account.login,
    },
    newBalance: balance - price,
    charged_at: stamp,
  };
}

/* ---- lifecycle -------------------------------------------------------- */

function activate(account, product, now) {
  now = now || new Date();
  if (!isRealAccount(account)) return { ok: false, error: "demo_account" };
  const pv = validateProduct(product);
  if (!pv.ok) return { ok: false, error: pv.error };
  if (!productAllowsAccount(product, account)) return { ok: false, error: "not_permitted" };
  const charge = chargeAttempt(account, product, now);
  const stamp = now.toISOString();
  if (charge.outcome === "suspended") {
    return {
      ok: true,
      subscription: {
        product_id: product.id,
        status: STATUS.SUSPENDED,
        started_at: stamp,
        next_renewal_at: null,
        suspended_at: stamp,
      },
      charge: null,
      note: "insufficient_funds",
    };
  }
  return {
    ok: true,
    subscription: {
      product_id: product.id,
      status: STATUS.ACTIVE,
      started_at: stamp,
      next_renewal_at: nextRenewalFrom(now, product.period_days).toISOString(),
      suspended_at: null,
    },
    charge: charge.op,
  };
}

/* Run one automated renewal attempt when due. Returns { ok, renewed, ... }.
 * renewed=false when not due or not renewable (idempotent for schedulers). */
function renew(sub, account, product, now) {
  now = now || new Date();
  if (!sub || sub.status !== STATUS.ACTIVE) return { ok: false, error: "not_active" };
  if (!renewalDue(sub, now)) return { ok: true, renewed: false };
  const charge = chargeAttempt(account, product, now);
  const stamp = now.toISOString();
  if (charge.outcome === "suspended") {
    return {
      ok: true,
      renewed: false,
      suspended: true,
      patch: {
        status: STATUS.SUSPENDED,
        suspended_at: stamp,
        last_charge_outcome: "insufficient_funds",
      },
    };
  }
  return {
    ok: true,
    renewed: true,
    patch: {
      status: STATUS.ACTIVE,
      next_renewal_at: addDaysUTC(new Date(sub.next_renewal_at), product.period_days).toISOString(),
      last_charge_outcome: "charged",
    },
    charge: charge.op,
  };
}

/* Reactivate a suspended subscription: charge immediately, then resume the
 * period from now if the charge succeeds. */
function reactivate(sub, account, product, now) {
  now = now || new Date();
  if (!sub || sub.status !== STATUS.SUSPENDED) return { ok: false, error: "not_suspended" };
  const charge = chargeAttempt(account, product, now);
  const stamp = now.toISOString();
  if (charge.outcome === "suspended") {
    return { ok: true, reactivated: false, patch: { suspended_at: stamp, last_charge_outcome: "insufficient_funds" } };
  }
  return {
    ok: true,
    reactivated: true,
    patch: {
      status: STATUS.ACTIVE,
      suspended_at: null,
      next_renewal_at: nextRenewalFrom(now, product.period_days).toISOString(),
      last_charge_outcome: "charged",
    },
    charge: charge.op,
  };
}

function cancel(sub, now, reason) {
  now = now || new Date();
  if (!sub) return { ok: false, error: "missing" };
  if (sub.status === STATUS.CANCELLED) return { ok: true, patch: {} };
  const patch = { status: STATUS.CANCELLED, cancelled_at: now.toISOString() };
  if (isString(reason)) patch.cancel_reason = reason;
  return { ok: true, patch: patch };
}

/* ---- market-data levels (stacking) -------------------------------------- */
/* Only ACTIVE subscriptions contribute; subscriptions whose product has no
 * data_level contribute nothing. Returns the level name ("delayed",
 * "level1", "level2", "ticks") or null when nothing grants market data. */

function dataLevelRank(level) {
  return (typeof level === "string" && level in DATA_LEVEL_RANK) ? DATA_LEVEL_RANK[level] : null;
}

function effectiveDataLevel(subscriptions, productsById) {
  let best = -1;
  for (const sub of subscriptions || []) {
    if (!sub || sub.status !== STATUS.ACTIVE) continue;
    const product = productsById && productsById[sub.product_id];
    const rank = product ? dataLevelRank(product.data_level) : null;
    if (rank !== null && rank > best) best = rank;
  }
  return best < 0 ? null : RANK_TO_LEVEL[best];
}

/* True when the account's stacked level is at least `minLevel`. */
function hasDataLevel(subscriptions, productsById, minLevel) {
  const need = dataLevelRank(minLevel);
  if (need === null) return false;
  const got = effectiveDataLevel(subscriptions, productsById);
  return got !== null && DATA_LEVEL_RANK[got] >= need;
}

/* ---- news gating -------------------------------------------------------- */
/* The news feed is available only while at least one ACTIVE subscription
 * grants the "news" entitlement (via its product.entitlements list). */

function hasEntitlement(subscriptions, productsById, entitlement) {
  if (!isString(entitlement)) return false;
  for (const sub of subscriptions || []) {
    if (!sub || sub.status !== STATUS.ACTIVE) continue;
    const product = productsById && productsById[sub.product_id];
    if (product && Array.isArray(product.entitlements) && product.entitlements.indexOf(entitlement) >= 0) {
      return true;
    }
  }
  return false;
}

function newsAccess(subscriptions, productsById) {
  return hasEntitlement(subscriptions, productsById, ENTITLEMENT_NEWS);
}

/* ---- connection registry ------------------------------------------------- */
/* At most MAX_CONNECTIONS_PER_SUBSCRIPTION (3) simultaneous connections may
 * be registered against one subscription. The registry is a plain object
 * { subscriptionId: [connId, ...] }; these functions are pure (they copy). */

function connectionCount(registry, subscriptionId) {
  const list = registry && registry[subscriptionId];
  return Array.isArray(list) ? list.length : 0;
}

function registerConnection(registry, subscriptionId, connId, now) {
  now = now || new Date();
  if (!isString(String(subscriptionId))) return { ok: false, error: "subscription_id_required" };
  if (!isString(String(connId))) return { ok: false, error: "connection_id_required" };
  const next = Object.assign({}, registry);
  const list = ((next[subscriptionId] || [])).slice();
  if (list.indexOf(connId) >= 0) return { ok: true, registry: next, already: true };
  if (list.length >= MAX_CONNECTIONS_PER_SUBSCRIPTION) {
    return {
      ok: false,
      error: "connection_limit",
      reason: "max " + MAX_CONNECTIONS_PER_SUBSCRIPTION + " simultaneous connections per subscription",
      at: now.toISOString(),
    };
  }
  list.push(connId);
  next[subscriptionId] = list;
  return { ok: true, registry: next, count: list.length };
}

function releaseConnection(registry, subscriptionId, connId) {
  const next = Object.assign({}, registry);
  const list = ((next[subscriptionId] || [])).slice();
  const idx = list.indexOf(connId);
  if (idx >= 0) list.splice(idx, 1);
  if (list.length === 0) delete next[subscriptionId];
  else next[subscriptionId] = list;
  return { ok: true, registry: next };
}

/* ---- auto-renewal with hourly retries ------------------------------------- */
/* Unlike renew() (which suspends on the first payment failure), this flow
 * keeps the subscription ACTIVE and retries the charge hourly: on each
 * failure recordFailedRenewal() bumps renewal_attempts and stamps
 * next_retry_at; when attempts reach maxRetries the subscription is moved
 * to "cancelled" with cancel_reason "renewal_payment_failed". Pure state
 * functions — the scheduler persists the returned patches. */

function addHoursUTC(date, hours) {
  const d = new Date(date.getTime());
  d.setUTCHours(d.getUTCHours() + hours);
  return d;
}

function scheduleNextRetry(now, intervalHours) {
  return addHoursUTC(now || new Date(), intervalHours || DEFAULT_RETRY_INTERVAL_HOURS);
}

/* True when a renewal or a scheduled retry attempt is due right now. */
function renewalAttemptDue(sub, now) {
  if (!sub || sub.status !== STATUS.ACTIVE) return false;
  if (sub.next_retry_at && new Date(sub.next_retry_at).getTime() <= now.getTime()) return true;
  return renewalDue(sub, now);
}

function recordFailedRenewal(sub, now, opts) {
  now = now || new Date();
  opts = opts || {};
  const maxRetries = Number.isInteger(opts.maxRetries) && opts.maxRetries > 0
    ? opts.maxRetries
    : DEFAULT_MAX_RENEWAL_RETRIES;
  const retryHours = typeof opts.retryHours === "number" && opts.retryHours > 0
    ? opts.retryHours
    : DEFAULT_RETRY_INTERVAL_HOURS;
  const attempts = (Number(sub.renewal_attempts) || 0) + 1;
  const stamp = now.toISOString();
  if (attempts >= maxRetries) {
    return {
      ok: true,
      cancelled: true,
      patch: {
        status: STATUS.CANCELLED,
        cancelled_at: stamp,
        cancel_reason: "renewal_payment_failed",
        renewal_attempts: attempts,
        next_retry_at: null,
      },
    };
  }
  return {
    ok: true,
    retryScheduled: true,
    patch: {
      renewal_attempts: attempts,
      next_retry_at: scheduleNextRetry(now, retryHours).toISOString(),
      last_charge_outcome: "insufficient_funds",
    },
  };
}

/* One scheduled renewal attempt with retry semantics. On success the period
 * extends and retry state is cleared; on payment failure the retry flow
 * above applies. opts: { maxRetries, retryHours }. */
function renewWithRetry(sub, account, product, now, opts) {
  now = now || new Date();
  if (!sub || sub.status !== STATUS.ACTIVE) return { ok: false, error: "not_active" };
  if (!renewalAttemptDue(sub, now)) return { ok: true, renewed: false };
  const charge = chargeAttempt(account, product, now);
  if (charge.outcome === "charged") {
    return {
      ok: true,
      renewed: true,
      patch: {
        status: STATUS.ACTIVE,
        next_renewal_at: addDaysUTC(new Date(sub.next_renewal_at), product.period_days).toISOString(),
        next_retry_at: null,
        renewal_attempts: 0,
        last_charge_outcome: "charged",
      },
      charge: charge.op,
    };
  }
  const fail = recordFailedRenewal(sub, now, opts);
  return Object.assign({ renewed: false }, fail);
}

var __EXP_SUBS__ = (function () { var E = {
  STATUS,
  OP_CHARGE,
  DATA_LEVELS,
  DATA_LEVEL_RANK,
  ENTITLEMENT_NEWS,
  MAX_CONNECTIONS_PER_SUBSCRIPTION,
  DEFAULT_MAX_RENEWAL_RETRIES,
  DEFAULT_RETRY_INTERVAL_HOURS,
  validateProduct,
  productAllowsAccount,
  isRealAccount,
  addDaysUTC,
  addHoursUTC,
  nextRenewalFrom,
  renewalDue,
  chargeAttempt,
  activate,
  renew,
  reactivate,
  cancel,
  /* wave-4: levels, entitlements, connections, retry-renewal */
  dataLevelRank,
  effectiveDataLevel,
  hasDataLevel,
  hasEntitlement,
  newsAccess,
  connectionCount,
  registerConnection,
  releaseConnection,
  scheduleNextRetry,
  renewalAttemptDue,
  recordFailedRenewal,
  renewWithRetry,
};
return E; })();
if (typeof module !== "undefined" && module.exports) { module.exports = __EXP_SUBS__; }
else if (typeof globalThis !== "undefined") { globalThis.OrbitSubscriptions = __EXP_SUBS__; }
