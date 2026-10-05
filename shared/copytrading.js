/* shared/copytrading.js — OrbitTrader copy-trading (signals) module (wave 5).
 *
 * Lets a subscriber account automatically mirror the trades of a registered
 * signal provider, with per-subscription copy settings and broker-side
 * guardrails. Concepts (provider registration, provider selection by
 * rating/growth/drawdown, per-subscriber copy settings, volume scaling,
 * slippage/deviation limits, deposit-% caps, stop-copying below an equity
 * floor, sync without confirmations) are an independent reimplementation of
 * the broker-terminal behavior captured in the support inventory; all
 * constants, defaults, and field names here are OrbitTrader's own.
 *
 * Pure functions, no globals, no DOM, no I/O: runs in the browser and in
 * node (guarded export at the bottom, same pattern as shared/groups.js).
 * Copy "execution" here means PLANNING: evaluateCopyTrade() produces a
 * decision + sized order plan that the server-side executor applies; nothing
 * in this file touches accounts, positions, or order routers directly.
 * Callers persist the returned subscription/provider objects themselves.
 *
 * Conventions:
 *   - All timestamps are epoch seconds, UTC (server time).
 *   - Money is in account-currency units; volumes are in lots.
 *   - validate*() returns an array of error strings; empty = valid.
 *   - fns that mutate nothing return fresh objects (provider/subscription
 *     records are treated as immutable by the transition helpers).
 */
(function (root) {
"use strict";

/* ================= 1. enumerations & defaults ================= */

/* Provider lifecycle: every registration starts "pending" and must be
 * explicitly approved before anyone can subscribe to it. */
var PROVIDER_STATUSES = ["pending", "approved", "suspended", "rejected"];

/* Subscription lifecycle: a subscription may be paused (guardrails or the
 * subscriber), resumed, or stopped (terminal — unsubscribe). */
var SUBSCRIPTION_STATUSES = ["active", "paused", "stopped"];

/* How the subscriber's copied volume is derived from the provider's volume. */
var VOLUME_MODES = ["fixed", "ratio", "equity_proportional"];

/* Conservative platform defaults (OrbitTrader's own — tune in config). */
var DEFAULT_MAX_SLIPPAGE_POINTS = 30;   /* skip a copy whose deviation exceeds this */
var DEFAULT_DEPOSIT_PCT_LIMIT = 20;    /* at most 20% of deposit may fund copied margin */
var DEFAULT_VOLUME_MODE = "equity_proportional";
var DEFAULT_COPY_SLTP = true;

/* ================= 2. providers ================= */

/* Provider record shape:
 *   { id, name, growthPct, drawdownPct, historyMonths, tradesCount,
 *     rating: { score (0..5), reviews (count) },
 *     registeredAt (epoch sec UTC), status, statusChangedAt }
 * growthPct/drawdownPct are percentages over the provider's history;
 * they are descriptive stats, not promises of future performance. */
function defaultProvider() {
  return {
    id: null,
    name: "",
    growthPct: 0,
    drawdownPct: 0,
    historyMonths: 0,
    tradesCount: 0,
    rating: { score: 0, reviews: 0 },
    registeredAt: null,
    status: "pending",
    statusChangedAt: null
  };
}

/* Registry shape: { providers: [], nextId: 1 }. Caller-owned; passed in. */
function emptyProviderRegistry() {
  return { providers: [], nextId: 1 };
}

/* Validate a raw registration payload. Returns error strings. */
function validateProviderInput(input) {
  var errs = [];
  var p = input || {};
  if (!p.name || typeof p.name !== "string" || !p.name.trim()) {
    errs.push("provider.name is required");
  } else if (p.name.length > 120) {
    errs.push("provider.name must be at most 120 characters");
  }
  [["growthPct", "provider.growthPct"],
   ["drawdownPct", "provider.drawdownPct"]].forEach(function (pair) {
    var v = p[pair[0]];
    if (v !== undefined && v !== null && (typeof v !== "number" || isNaN(v))) {
      errs.push(pair[1] + " must be a number");
    }
  });
  if (p.drawdownPct !== undefined && p.drawdownPct !== null &&
      typeof p.drawdownPct === "number" && p.drawdownPct < 0) {
    errs.push("provider.drawdownPct must be non-negative");
  }
  if (p.historyMonths !== undefined && p.historyMonths !== null &&
      (!isFiniteNumber(p.historyMonths) || p.historyMonths < 0)) {
    errs.push("provider.historyMonths must be a non-negative number");
  }
  if (p.tradesCount !== undefined && p.tradesCount !== null &&
      (!isFiniteNumber(p.tradesCount) || Math.floor(p.tradesCount) !== p.tradesCount ||
       p.tradesCount < 0)) {
    errs.push("provider.tradesCount must be a non-negative integer");
  }
  if (p.rating !== undefined && p.rating !== null) {
    if (typeof p.rating !== "object") {
      errs.push("provider.rating must be an object");
    } else {
      if (p.rating.score !== undefined &&
          (typeof p.rating.score !== "number" || p.rating.score < 0 || p.rating.score > 5)) {
        errs.push("provider.rating.score must be between 0 and 5");
      }
      if (p.rating.reviews !== undefined &&
          (!isFiniteNumber(p.rating.reviews) || Math.floor(p.rating.reviews) !== p.rating.reviews ||
           p.rating.reviews < 0)) {
        errs.push("provider.rating.reviews must be a non-negative integer");
      }
    }
  }
  return errs;
}

function isFiniteNumber(v) {
  return typeof v === "number" && isFinite(v) && !isNaN(v);
}

/* Register a provider: assigns a deterministic id, stamps registeredAt,
 * starts at status "pending". Returns { ok, provider?, errors? }. */
function registerProvider(registry, input, now) {
  var errs = validateProviderInput(input);
  if (errs.length) return { ok: false, errors: errs };
  if (!registry || !Array.isArray(registry.providers)) {
    return { ok: false, errors: ["registry.providers must be an array"] };
  }
  var at = epochOr(now, Math.floor(Date.now() / 1000));
  var p = defaultProvider();
  p.id = "ct-prov-" + String(registry.nextId++).padStart(4, "0");
  p.name = input.name.trim();
  p.growthPct = numOr(input.growthPct, 0);
  p.drawdownPct = numOr(input.drawdownPct, 0);
  p.historyMonths = numOr(input.historyMonths, 0);
  p.tradesCount = intOr(input.tradesCount, 0);
  if (input.rating) {
    p.rating = { score: numOr(input.rating.score, 0), reviews: intOr(input.rating.reviews, 0) };
  }
  p.registeredAt = at;
  p.status = "pending";
  p.statusChangedAt = at;
  registry.providers.push(p);
  return { ok: true, provider: copyOf(p) };
}

function providerById(registry, id) {
  if (!registry || !Array.isArray(registry.providers)) return null;
  for (var i = 0; i < registry.providers.length; i++) {
    if (registry.providers[i].id === id) return registry.providers[i];
  }
  return null;
}

/* Move a provider through its lifecycle. Returns a fresh record.
 * Throws on unknown status or on a no-op-bypassing transition from
 * "rejected" (a rejected provider must re-register). */
function setProviderStatus(provider, status, now) {
  if (PROVIDER_STATUSES.indexOf(status) < 0) {
    throw new Error("unknown provider status: " + status);
  }
  if (!provider) throw new Error("provider is required");
  if (provider.status === "rejected") {
    throw new Error("rejected provider must re-register; status cannot change");
  }
  var p = copyOf(provider);
  p.status = status;
  p.statusChangedAt = epochOr(now, Math.floor(Date.now() / 1000));
  return p;
}

/* Update a provider's published stats. Only approved/suspended providers
 * may have stats refreshed; returns a fresh record. */
function refreshProviderStats(provider, stats, now) {
  if (!provider) throw new Error("provider is required");
  if (provider.status !== "approved" && provider.status !== "suspended") {
    throw new Error("stats may only refresh for approved/suspended providers");
  }
  var s = stats || {};
  var errs = [];
  ["growthPct", "drawdownPct", "historyMonths", "tradesCount"].forEach(function (k) {
    if (s[k] !== undefined && s[k] !== null && !isFiniteNumber(s[k])) {
      errs.push("stats." + k + " must be a finite number");
    }
  });
  if (errs.length) throw new Error(errs.join("; "));
  var p = copyOf(provider);
  if (s.growthPct !== undefined) p.growthPct = s.growthPct;
  if (s.drawdownPct !== undefined) p.drawdownPct = s.drawdownPct;
  if (s.historyMonths !== undefined) p.historyMonths = s.historyMonths;
  if (s.tradesCount !== undefined) p.tradesCount = Math.floor(s.tradesCount);
  if (s.ratingScore !== undefined) {
    if (s.ratingScore < 0 || s.ratingScore > 5) throw new Error("stats.ratingScore must be 0..5");
    p.rating = { score: s.ratingScore, reviews: intOr(s.ratingReviews, p.rating.reviews) };
  }
  p.statsUpdatedAt = epochOr(now, Math.floor(Date.now() / 1000));
  return p;
}

/* Provider discovery: filter + rank for the subscriber-facing listing.
 * criteria: { minHistoryMonths?, maxDrawdownPct?, minTradesCount?,
 *             orderBy: "growth_desc"|"drawdown_asc"|"rating_desc"|"trades_desc",
 *             limit? }. Only approved providers are listed. */
function rankProviders(registry, criteria) {
  var c = criteria || {};
  var order = c.orderBy || "rating_desc";
  var list = (registry && Array.isArray(registry.providers) ? registry.providers : [])
    .filter(function (p) { return p.status === "approved"; })
    .filter(function (p) {
      if (c.minHistoryMonths !== undefined && p.historyMonths < c.minHistoryMonths) return false;
      if (c.maxDrawdownPct !== undefined && p.drawdownPct > c.maxDrawdownPct) return false;
      if (c.minTradesCount !== undefined && p.tradesCount < c.minTradesCount) return false;
      return true;
    });
  var key = {
    growth_desc: function (p) { return -p.growthPct; },
    drawdown_asc: function (p) { return p.drawdownPct; },
    rating_desc: function (p) { return -(p.rating.score * 1000 + Math.min(p.rating.reviews, 999)); },
    trades_desc: function (p) { return -p.tradesCount; }
  }[order];
  if (!key) throw new Error("unknown orderBy: " + order);
  list = list.slice().sort(function (a, b) {
    var d = key(a) - key(b);
    return d !== 0 ? d : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  if (c.limit !== undefined && c.limit !== null) {
    list = list.slice(0, Math.max(0, Math.floor(c.limit)));
  }
  return list;
}

/* ================= 3. subscription settings ================= */

/* Subscription settings shape (per subscriber):
 *   { providerId, copySLTP, volumeMode, volumeValue,
 *     maxSlippagePoints, depositPctLimit, stopIfEquityBelow,
 *     syncWithoutConfirmation }
 * copySLTP: mirror the provider's SL/TP onto the copied order.
 * volumeMode/volumeValue: "fixed" -> volumeValue lots per trade;
 *   "ratio" -> providerVolume * volumeValue; "equity_proportional" ->
 *   providerVolume * (subscriberEquity / providerEquity), optionally
 *   scaled by volumeValue as a multiplier (default 1).
 * maxSlippagePoints: skip a copy whose observed deviation exceeds this.
 * depositPctLimit: at most this % of the deposit may fund copied margin.
 * stopIfEquityBelow: absolute equity floor; 0/null = disabled.
 * syncWithoutConfirmation: true -> copied/adjusted orders execute
 *   automatically; false -> the plan is staged for subscriber confirmation. */
function defaultSubscriptionSettings(providerId) {
  return {
    providerId: providerId || null,
    copySLTP: DEFAULT_COPY_SLTP,
    volumeMode: DEFAULT_VOLUME_MODE,
    volumeValue: 1,
    maxSlippagePoints: DEFAULT_MAX_SLIPPAGE_POINTS,
    depositPctLimit: DEFAULT_DEPOSIT_PCT_LIMIT,
    stopIfEquityBelow: 0,
    syncWithoutConfirmation: true
  };
}

/* Validate settings. Returns error strings; empty = valid. */
function validateSubscriptionSettings(s) {
  var errs = [];
  var x = s || {};
  if (!x.providerId || typeof x.providerId !== "string") {
    errs.push("settings.providerId is required");
  }
  if (typeof x.copySLTP !== "boolean") {
    errs.push("settings.copySLTP must be boolean");
  }
  if (VOLUME_MODES.indexOf(x.volumeMode) < 0) {
    errs.push("settings.volumeMode must be one of: " + VOLUME_MODES.join(", "));
  }
  if (!isFiniteNumber(x.volumeValue) || x.volumeValue <= 0) {
    errs.push("settings.volumeValue must be a positive number");
  }
  if (!isFiniteNumber(x.maxSlippagePoints) || x.maxSlippagePoints < 0) {
    errs.push("settings.maxSlippagePoints must be a non-negative number");
  }
  if (!isFiniteNumber(x.depositPctLimit) || x.depositPctLimit <= 0 || x.depositPctLimit > 100) {
    errs.push("settings.depositPctLimit must be within (0, 100]");
  }
  if (x.stopIfEquityBelow !== undefined && x.stopIfEquityBelow !== null &&
      (!isFiniteNumber(x.stopIfEquityBelow) || x.stopIfEquityBelow < 0)) {
    errs.push("settings.stopIfEquityBelow must be a non-negative number or 0/null to disable");
  }
  if (typeof x.syncWithoutConfirmation !== "boolean") {
    errs.push("settings.syncWithoutConfirmation must be boolean");
  }
  return errs;
}

/* ================= 4. subscriptions ================= */

/* Subscription record:
 *   { id, accountLogin, providerId, settings (copy), status,
 *     createdAt, pausedAt, stoppedAt, stopReason }
 * Subscriptions registry shape: { subscriptions: [], nextId: 1 }. */
function emptySubscriptionRegistry() {
  return { subscriptions: [], nextId: 1 };
}

/* Create a subscription. Guardrails applied at subscribe time:
 *   - the provider must exist and be approved;
 *   - settings must validate;
 *   - account must carry a positive deposit;
 *   - no second live subscription for the same account+provider;
 *   - rejected if the existing copied margin already exceeds the
 *     subscriber's depositPctLimit (the new subscription must not start
 *     over the deposit-% cap);
 *   - rejected if stopIfEquityBelow is set at/above current equity
 *     (copying would auto-pause immediately).
 * account: { login, deposit, equity }.
 * Returns { ok, subscription?, errors? }. */
function subscribe(subRegistry, provRegistry, account, settings, now) {
  var errs = [];
  var at = epochOr(now, Math.floor(Date.now() / 1000));
  if (!subRegistry || !Array.isArray(subRegistry.subscriptions)) {
    return { ok: false, errors: ["subscription registry is required"] };
  }
  errs = errs.concat(validateSubscriptionSettings(settings || {}));
  var provider = providerById(provRegistry, settings && settings.providerId);
  if (!provider) {
    errs.push("provider not found: " + (settings && settings.providerId));
  } else if (provider.status !== "approved") {
    errs.push("provider is not approved (status: " + provider.status + ")");
  }
  var acct = account || {};
  if (!isFiniteNumber(acct.deposit) || acct.deposit <= 0) {
    errs.push("account.deposit must be positive to subscribe");
  }
  if (acct.equity !== undefined && (!isFiniteNumber(acct.equity) || acct.equity < 0)) {
    errs.push("account.equity must be a non-negative number");
  }
  if (settings && isFiniteNumber(settings.stopIfEquityBelow) && settings.stopIfEquityBelow > 0 &&
      isFiniteNumber(acct.equity) && settings.stopIfEquityBelow >= acct.equity) {
    errs.push("settings.stopIfEquityBelow must be below current equity");
  }
  var live = subRegistry.subscriptions.filter(function (s) {
    return s.accountLogin === acct.login && s.providerId === (settings && settings.providerId) &&
      (s.status === "active" || s.status === "paused");
  });
  if (live.length) {
    errs.push("an active/paused subscription already exists for this account+provider");
  }
  if (errs.length) return { ok: false, errors: errs };
  var sub = {
    id: "ct-sub-" + String(subRegistry.nextId++).padStart(4, "0"),
    accountLogin: acct.login,
    providerId: settings.providerId,
    settings: copyOf(settings),
    status: "active",
    createdAt: at,
    pausedAt: null,
    stoppedAt: null,
    stopReason: null
  };
  subRegistry.subscriptions.push(sub);
  return { ok: true, subscription: copyOf(sub) };
}

function subscriptionById(subRegistry, id) {
  if (!subRegistry || !Array.isArray(subRegistry.subscriptions)) return null;
  for (var i = 0; i < subRegistry.subscriptions.length; i++) {
    if (subRegistry.subscriptions[i].id === id) return subRegistry.subscriptions[i];
  }
  return null;
}

/* Status helpers. All return fresh records; throws on illegal moves. */
function pauseSubscription(sub, reason, now) {
  if (!sub) throw new Error("subscription is required");
  if (sub.status !== "active") throw new Error("only an active subscription can be paused");
  var s = copyOf(sub);
  s.status = "paused";
  s.pausedAt = epochOr(now, Math.floor(Date.now() / 1000));
  s.stopReason = reason || "paused";
  return s;
}

function resumeSubscription(sub, now) {
  if (!sub) throw new Error("subscription is required");
  if (sub.status !== "paused") throw new Error("only a paused subscription can be resumed");
  var s = copyOf(sub);
  s.status = "active";
  s.pausedAt = null;
  s.stopReason = null;
  void now;
  return s;
}

/* Unsubscribe: terminal. Returns the stopped record. */
function unsubscribe(sub, reason, now) {
  if (!sub) throw new Error("subscription is required");
  if (sub.status === "stopped") throw new Error("subscription is already stopped");
  var s = copyOf(sub);
  s.status = "stopped";
  s.stoppedAt = epochOr(now, Math.floor(Date.now() / 1000));
  s.stopReason = reason || "unsubscribed";
  return s;
}

function subscriptionStatus(sub) {
  return sub ? sub.status : null;
}

/* ================= 5. position sizing ================= */

/* Round down to the symbol's volume step (never round up: copied volume
 * must not exceed the intended size). Guards float noise. */
function roundDownToStep(volume, step) {
  if (!isFiniteNumber(volume) || !isFiniteNumber(step) || step <= 0) return NaN;
  var q = Math.floor(volume / step + 1e-9);
  return Number((q * step).toFixed(8));
}

/* Clamp a volume into the symbol spec's [volume_min, volume_max].
 * spec shape: { volume_min, volume_max, volume_step } (see shared/symbol-specs.json). */
function clampToSpec(volume, spec) {
  var sp = spec || {};
  var vmin = isFiniteNumber(sp.volume_min) ? sp.volume_min : 0.01;
  var vmax = isFiniteNumber(sp.volume_max) ? sp.volume_max : 100;
  var step = isFiniteNumber(sp.volume_step) ? sp.volume_step : 0.01;
  var v = roundDownToStep(volume, step);
  if (!isFiniteNumber(v)) return { ok: false, volume: 0, reason: "invalid_volume" };
  if (v > vmax) v = roundDownToStep(vmax, step);
  if (v < vmin) return { ok: false, volume: v, reason: "below_minimum" };
  return { ok: true, volume: v, reason: null };
}

/* Compute the subscriber's copied volume for one provider trade.
 * args: { providerVolume, settings, subscriberEquity, providerEquity, spec }.
 * Returns { ok, volume, reason, raw }.
 *   fixed:              volumeValue lots.
 *   ratio:              providerVolume * volumeValue.
 *   equity_proportional: providerVolume * (subscriberEquity / providerEquity)
 *                        * volumeValue (volumeValue defaults to 1).
 * The result is rounded down to the spec step and clamped to [min, max];
 * a result below volume_min is rejected (skip, not a dust trade). */
function computeCopyVolume(args) {
  var a = args || {};
  var settings = a.settings || {};
  var providerVolume = a.providerVolume;
  if (!isFiniteNumber(providerVolume) || providerVolume <= 0) {
    return { ok: false, volume: 0, reason: "invalid_provider_volume", raw: providerVolume };
  }
  var raw;
  var mode = settings.volumeMode;
  if (mode === "fixed") {
    raw = settings.volumeValue;
  } else if (mode === "ratio") {
    raw = providerVolume * settings.volumeValue;
  } else if (mode === "equity_proportional") {
    if (!isFiniteNumber(a.providerEquity) || a.providerEquity <= 0) {
      return { ok: false, volume: 0, reason: "invalid_provider_equity", raw: 0 };
    }
    if (!isFiniteNumber(a.subscriberEquity) || a.subscriberEquity < 0) {
      return { ok: false, volume: 0, reason: "invalid_subscriber_equity", raw: 0 };
    }
    raw = providerVolume * (a.subscriberEquity / a.providerEquity) *
      (isFiniteNumber(settings.volumeValue) ? settings.volumeValue : 1);
  } else {
    return { ok: false, volume: 0, reason: "unknown_volume_mode", raw: 0 };
  }
  if (!isFiniteNumber(raw) || raw <= 0) {
    return { ok: false, volume: 0, reason: "non_positive_volume", raw: raw };
  }
  var sized = clampToSpec(raw, a.spec);
  return { ok: sized.ok, volume: sized.volume, reason: sized.reason, raw: raw };
}

/* ================= 6. per-trade guardrails ================= */

/* Decide what to do with one provider trade.
 * args: { subscription, providerTrade, account, spec,
 *         observedSlippagePoints, providerEquity,
 *         copyMarginUsed, estimatedMargin }
 *   providerTrade: { symbol, volume, direction, price?, sl?, tp? }.
 *   account: { deposit, equity }.
 *   observedSlippagePoints: deviation measured when the provider's trade
 *     was (re)priced for the subscriber; null/undefined = no data -> the
 *     slippage guardrail cannot pass, so the trade is skipped.
 *   copyMarginUsed: margin already funding this subscriber's copied
 *     positions; estimatedMargin: margin the sized copy would add.
 * Returns a decision object:
 *   { decision: "copy"|"confirm"|"skip"|"pause",
 *     volume?, sl?, tp?, autoExecute, reason }.
 * "pause" means the caller must auto-pause the subscription (equity floor).
 * "confirm" means the plan is staged: syncWithoutConfirmation is false,
 *   so the subscriber must approve before execution. */
function evaluateCopyTrade(args) {
  var a = args || {};
  var sub = a.subscription;
  var settings = (sub && sub.settings) || {};
  var trade = a.providerTrade || {};
  var account = a.account || {};

  if (!sub) return skipOnly("no_subscription");
  if (sub.status !== "active") {
    return skipOnly("subscription_not_active", { status: sub.status });
  }

  /* Equity floor: copying auto-pauses when equity drops below the absolute
   * stop level. The caller persists the paused state. */
  if (isFiniteNumber(settings.stopIfEquityBelow) && settings.stopIfEquityBelow > 0 &&
      isFiniteNumber(account.equity) && account.equity < settings.stopIfEquityBelow) {
    return { decision: "pause", volume: 0, autoExecute: false,
             reason: "equity_below_stop",
             detail: "equity " + account.equity + " < stop " + settings.stopIfEquityBelow };
  }

  /* Slippage guardrail: a trade whose deviation exceeds the subscriber's
   * limit is skipped with an explicit reason. Missing slippage data is
   * treated as failing closed. */
  var slip = a.observedSlippagePoints;
  if (!isFiniteNumber(slip) || slip < 0) {
    return skipOnly("slippage_unknown");
  }
  if (isFiniteNumber(settings.maxSlippagePoints) && slip > settings.maxSlippagePoints) {
    return skipOnly("slippage_exceeded",
      { observed: slip, limit: settings.maxSlippagePoints });
  }

  var sized = computeCopyVolume({
    providerVolume: trade.volume,
    settings: settings,
    subscriberEquity: account.equity,
    providerEquity: a.providerEquity,
    spec: a.spec
  });
  if (!sized.ok) {
    return skipOnly("sizing_failed", { sizingReason: sized.reason, raw: sized.raw });
  }

  /* Deposit-% guardrail: the copied book may not use more margin than
   * depositPctLimit % of the deposit. Reject the trade (not the
   * subscription) when this copy would breach the cap. */
  if (isFiniteNumber(account.deposit) && account.deposit > 0 &&
      isFiniteNumber(settings.depositPctLimit) && settings.depositPctLimit > 0) {
    var cap = account.deposit * settings.depositPctLimit / 100;
    var used = isFiniteNumber(a.copyMarginUsed) ? a.copyMarginUsed : 0;
    var add = isFiniteNumber(a.estimatedMargin) ? a.estimatedMargin : 0;
    if (used + add > cap) {
      return skipOnly("deposit_limit_exceeded",
        { used: used, adding: add, cap: cap, limitPct: settings.depositPctLimit });
    }
  }

  var plan = {
    decision: settings.syncWithoutConfirmation ? "copy" : "confirm",
    volume: sized.volume,
    symbol: trade.symbol,
    direction: trade.direction,
    sl: settings.copySLTP ? (trade.sl !== undefined ? trade.sl : null) : null,
    tp: settings.copySLTP ? (trade.tp !== undefined ? trade.tp : null) : null,
    autoExecute: !!settings.syncWithoutConfirmation,
    reason: null
  };
  return plan;
}

function skipOnly(reason, extra) {
  var r = { decision: "skip", volume: 0, autoExecute: false, reason: reason };
  if (extra) {
    for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k]; }
  }
  return r;
}

/* ================= 7. helpers ================= */

function epochOr(v, fallback) {
  return isFiniteNumber(v) ? Math.floor(v) : fallback;
}

function numOr(v, fallback) {
  return isFiniteNumber(v) ? v : fallback;
}

function intOr(v, fallback) {
  return isFiniteNumber(v) ? Math.floor(v) : fallback;
}

function copyOf(o) {
  return JSON.parse(JSON.stringify(o));
}

/* ================= 8. export ================= */

var COPYTRADING = {
  /* enums & defaults */
  PROVIDER_STATUSES: PROVIDER_STATUSES,
  SUBSCRIPTION_STATUSES: SUBSCRIPTION_STATUSES,
  VOLUME_MODES: VOLUME_MODES,
  DEFAULT_MAX_SLIPPAGE_POINTS: DEFAULT_MAX_SLIPPAGE_POINTS,
  DEFAULT_DEPOSIT_PCT_LIMIT: DEFAULT_DEPOSIT_PCT_LIMIT,
  DEFAULT_VOLUME_MODE: DEFAULT_VOLUME_MODE,
  DEFAULT_COPY_SLTP: DEFAULT_COPY_SLTP,
  /* providers */
  defaultProvider: defaultProvider,
  emptyProviderRegistry: emptyProviderRegistry,
  validateProviderInput: validateProviderInput,
  registerProvider: registerProvider,
  providerById: providerById,
  setProviderStatus: setProviderStatus,
  refreshProviderStats: refreshProviderStats,
  rankProviders: rankProviders,
  /* subscription settings */
  defaultSubscriptionSettings: defaultSubscriptionSettings,
  validateSubscriptionSettings: validateSubscriptionSettings,
  /* subscriptions */
  emptySubscriptionRegistry: emptySubscriptionRegistry,
  subscribe: subscribe,
  subscriptionById: subscriptionById,
  pauseSubscription: pauseSubscription,
  resumeSubscription: resumeSubscription,
  unsubscribe: unsubscribe,
  subscriptionStatus: subscriptionStatus,
  /* sizing */
  roundDownToStep: roundDownToStep,
  clampToSpec: clampToSpec,
  computeCopyVolume: computeCopyVolume,
  /* guardrails */
  evaluateCopyTrade: evaluateCopyTrade
};
if (typeof module !== "undefined" && module.exports) { module.exports = COPYTRADING; }
else { root.OrbitCopyTrading = COPYTRADING; }
})(typeof globalThis !== "undefined" ? globalThis : this);
