/* shared/integrations.js — OrbitTrader external integrations model.
 *
 * Configuration + selection logic for the broker's EXTERNAL providers:
 * mail servers (SMTP), SMS gateways, instant-messenger webhooks, and KYC
 * providers. Pure functions, no globals, no DOM, no network: runs in the
 * browser and in node (guarded export at the bottom, same pattern as
 * shared/groups.js).
 *
 * This module is NOT the internal mailbox (see shared/mailbox.js): that is
 * broker-to-trader mail inside the platform. This module configures the
 * third-party services the platform calls out to (SMTP relays, SMS
 * gateways, chat webhooks, identity-verification providers).
 *
 * Conventions (OrbitTrader's own, not any broker's):
 *  - Provider ids are NEUTRAL ("sms-provider-default", "kyc-provider-main"):
 *    never a real vendor's brand name in code, config, or docs.
 *  - Secrets are never stored as values: configs carry `password_ref` /
 *    `api_key_ref` — keys into the operator's secret store. Raw credentials
 *    in a config object fail validation.
 *  - `default*()` factories return the config SHAPE with placeholder
 *    values ("", "example.com"-style placeholders). A config is "valid"
 *    when its shape is right; it is "configured" (routable) only once the
 *    operator fills in host/endpoint/credentials. Selection and routing
 *    functions skip anything not configured or not enabled.
 *  - Selection is deterministic: ties break by registry insertion order.
 */
(function (root) {
"use strict";

/* ================= 1. Mail servers (SMTP) =================
 * Separate mailboxes for client notifications vs verification mail;
 * a flagged default server is the fallback when no server matches the
 * requested mailbox. Send statistics are kept per server + globally. */

var MAILBOX_TYPES = ["notifications", "verification"];
var TLS_MODES = ["none", "starttls", "tls"];

function defaultMailServer() {
  return {
    id: "mail-primary",
    label: "Primary mail server",
    host: "",                 /* e.g. "mail.example.com" — set by operator */
    port: 587,
    auth: {
      username: "",           /* e.g. "noreply@example.com" — set by operator */
      password_ref: ""        /* secret-store key; NEVER a raw password */
    },
    tls: "starttls",          /* "none" | "starttls" | "tls" */
    mailbox: "notifications", /* "notifications" | "verification" */
    is_default: false,
    enabled: true
  };
}

/* Shape validation -> array of error strings (empty = valid). An empty
 * host/username/password_ref is legal here: it means "not configured yet"
 * (see isMailServerConfigured); the shape itself must still be right. */
function validateMailServer(s) {
  var errs = [];
  function err(m) { errs.push(m); }
  if (!s || typeof s !== "object" || Array.isArray(s)) return ["mail server must be an object"];
  if (typeof s.id !== "string" || !s.id) err("id must be a non-empty string");
  if (typeof s.label !== "string") err("label must be a string");
  if (typeof s.host !== "string") err("host must be a string");
  if (typeof s.port !== "number" || !isFinite(s.port) ||
      Math.floor(s.port) !== s.port || s.port < 1 || s.port > 65535)
    err("port must be an integer 1..65535");
  if (TLS_MODES.indexOf(s.tls) === -1)
    err("tls must be one of: " + TLS_MODES.join(", "));
  if (MAILBOX_TYPES.indexOf(s.mailbox) === -1)
    err("mailbox must be one of: " + MAILBOX_TYPES.join(", "));
  var a = s.auth;
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    err("auth must be an object");
  } else {
    if (typeof a.username !== "string") err("auth.username must be a string");
    if (typeof a.password_ref !== "string") err("auth.password_ref must be a string");
  }
  if (typeof s.is_default !== "boolean") err("is_default must be a boolean");
  if (typeof s.enabled !== "boolean") err("enabled must be a boolean");
  return errs;
}

/* Routable = enabled AND fully filled in. Never route mail through a
 * half-configured server. */
function isMailServerConfigured(s) {
  return !!s && s.enabled === true &&
    typeof s.host === "string" && !!s.host &&
    typeof s.port === "number" && isFinite(s.port) &&
    s.port >= 1 && s.port <= 65535 &&
    s.auth && typeof s.auth.username === "string" && !!s.auth.username &&
    typeof s.auth.password_ref === "string" && !!s.auth.password_ref;
}

/* Resolve the server for a mailbox ("notifications" | "verification"):
 *  1. configured servers serving that mailbox (default-flagged first);
 *  2. fallback: any configured server, default-flagged first
 *     ("default-server fallback");
 *  3. null when nothing is usable. Never throws. */
function resolveMailServer(servers, mailbox) {
  var list = Array.isArray(servers) ? servers : [];
  var usable = list.filter(isMailServerConfigured);
  if (usable.length === 0) return null;
  function pick(cands) {
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].is_default === true) return cands[i];
    }
    return cands[0];
  }
  var forBox = usable.filter(function (s) { return s.mailbox === mailbox; });
  if (forBox.length > 0) return pick(forBox);
  return pick(usable);
}

/* ---- send statistics ----
 * stats = { sent, failed, by_server: {id: {sent, failed}}, last_error } */
function createSendStats() {
  return { sent: 0, failed: 0, by_server: {}, last_error: null };
}

function recordSend(stats, serverId, ok, error) {
  if (!stats || typeof stats !== "object" || Array.isArray(stats))
    throw new Error("integrations: send stats object required");
  var id = String(serverId != null ? serverId : "");
  var entry = stats.by_server[id];
  if (!entry || typeof entry !== "object") entry = { sent: 0, failed: 0 };
  if (ok === true) {
    stats.sent += 1;
    entry.sent += 1;
  } else {
    stats.failed += 1;
    entry.failed += 1;
    stats.last_error = error != null ? String(error) : "unknown error";
  }
  stats.by_server[id] = entry;
  return stats;
}

function sendStatsSummary(stats) {
  var s = (stats && typeof stats === "object") ? stats : {};
  var sent = typeof s.sent === "number" && isFinite(s.sent) ? s.sent : 0;
  var failed = typeof s.failed === "number" && isFinite(s.failed) ? s.failed : 0;
  var total = sent + failed;
  return {
    sent: sent,
    failed: failed,
    total: total,
    failure_rate: total > 0 ? failed / total : 0
  };
}

/* ================= 2. SMS gateways =================
 * Multi-provider registry keyed by NEUTRAL ids. A provider serves a
 * message when it is enabled, configured, and its country list ("*" or
 * ISO alpha-2 codes) and group list ("*" or group names) cover the
 * recipient. Selection scores delivery stats against cost:
 *   score = delivery_rate / max(cost_per_message, epsilon)
 * so the best value-for-reliability provider wins; ties keep registry
 * insertion order. */

var SMS_MACRO_RE = /#([A-Z][A-Z0-9_]*)#/g;

function defaultSmsProvider() {
  return {
    id: "sms-provider-default",
    label: "Default SMS provider",
    endpoint: "",            /* provider HTTP API base URL — set by operator */
    api_key_ref: "",          /* secret-store key; NEVER a raw key */
    countries: ["*"],         /* "*" = all countries; else ["AE","US",...] */
    groups: ["*"],            /* "*" = all groups; else group names */
    cost_per_message: 0,     /* operator's contracted cost, account-ccy units */
    delivery_rate: 0,        /* 0..1 measured delivery success */
    enabled: true
  };
}

function validateSmsProvider(p) {
  var errs = [];
  function err(m) { errs.push(m); }
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["sms provider must be an object"];
  if (typeof p.id !== "string" || !p.id) err("id must be a non-empty string");
  if (typeof p.label !== "string") err("label must be a string");
  if (typeof p.endpoint !== "string") err("endpoint must be a string");
  if (typeof p.api_key_ref !== "string") err("api_key_ref must be a string");
  ["countries", "groups"].forEach(function (f) {
    var v = p[f];
    if (!Array.isArray(v) || v.length === 0) {
      err(f + " must be a non-empty array");
      return;
    }
    v.forEach(function (t) {
      if (typeof t !== "string" || !t) err(f + " entries must be non-empty strings");
    });
  });
  if (typeof p.cost_per_message !== "number" || !isFinite(p.cost_per_message) || p.cost_per_message < 0)
    err("cost_per_message must be a number >= 0");
  if (typeof p.delivery_rate !== "number" || !isFinite(p.delivery_rate) ||
      p.delivery_rate < 0 || p.delivery_rate > 1)
    err("delivery_rate must be a number 0..1");
  if (typeof p.enabled !== "boolean") err("enabled must be a boolean");
  return errs;
}

function isSmsProviderConfigured(p) {
  return !!p && p.enabled === true &&
    typeof p.endpoint === "string" && !!p.endpoint &&
    typeof p.api_key_ref === "string" && !!p.api_key_ref;
}

/* registry: plain object id -> provider. Mutates + returns the registry
 * (chainable). Throws on shape errors or duplicate ids. */
function registerSmsProvider(registry, provider) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry))
    throw new Error("integrations: sms provider registry must be an object");
  var errs = validateSmsProvider(provider);
  if (errs.length > 0)
    throw new Error("integrations: invalid sms provider: " + errs.join("; "));
  if (Object.prototype.hasOwnProperty.call(registry, provider.id))
    throw new Error("integrations: duplicate sms provider id: " + provider.id);
  registry[provider.id] = provider;
  return registry;
}

function providerScore(p) {
  var rate = +p.delivery_rate;
  var cost = +p.cost_per_message;
  if (!isFinite(rate) || rate < 0) rate = 0;
  if (!isFinite(cost) || cost < 0) cost = 0;
  return rate / (cost > 0 ? cost : 0.000001);
}

/* opts: { country, group }. country is matched case-insensitively against
 * ISO codes; "*" always matches. Returns the winning provider or null. */
function selectSmsProvider(registry, opts) {
  var o = (opts && typeof opts === "object") ? opts : {};
  var country = typeof o.country === "string" ? o.country.toUpperCase() : "";
  var group = typeof o.group === "string" ? o.group : "";
  var best = null, bestScore = -Infinity;
  Object.keys(registry || {}).forEach(function (id) {
    var p = registry[id];
    if (!isSmsProviderConfigured(p)) return;
    var countries = Array.isArray(p.countries) ? p.countries : [];
    var groups = Array.isArray(p.groups) ? p.groups : [];
    var countryOk = countries.indexOf("*") !== -1 ||
      (country !== "" && countries.some(function (c) {
        return String(c).toUpperCase() === country;
      }));
    var groupOk = groups.indexOf("*") !== -1 ||
      (group !== "" && groups.indexOf(group) !== -1);
    if (!countryOk || !groupOk) return;
    var sc = providerScore(p);
    if (sc > bestScore) { bestScore = sc; best = p; }
  });
  return best;
}

/* ---- SMS templates ----
 * Macros are #NAME# tokens (e.g. #MESSAGE#, #CODE#, #LOGIN#); values come
 * from the macros object. Unknown macros pass through untouched. */
function renderSmsTemplate(text, macros) {
  var src = String(text != null ? text : "");
  var m = (macros && typeof macros === "object") ? macros : {};
  return src.replace(SMS_MACRO_RE, function (tok, name) {
    return Object.prototype.hasOwnProperty.call(m, name) ? String(m[name]) : tok;
  });
}

/* ================= 3. Instant messengers =================
 * Generic webhook-based notifier: the platform POSTs a JSON payload to the
 * channel's webhook URL. No vendor-specific fields — any chat service with
 * an incoming-webhook URL works. */

var MESSENGER_LEVELS = ["info", "warning", "critical"];

function defaultMessengerChannel() {
  return {
    id: "alerts-operations",
    label: "Operations alerts",
    webhook_url: "",       /* incoming-webhook URL — set by operator */
    kind: "webhook",       /* transport kind; only "webhook" is supported */
    enabled: true,
    events: ["*"]          /* event names this channel receives; "*" = all */
  };
}

function validateMessengerChannel(c) {
  var errs = [];
  function err(m) { errs.push(m); }
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["messenger channel must be an object"];
  if (typeof c.id !== "string" || !c.id) err("id must be a non-empty string");
  if (typeof c.label !== "string") err("label must be a string");
  if (typeof c.webhook_url !== "string") {
    err("webhook_url must be a string");
  } else if (c.webhook_url !== "" && c.webhook_url.indexOf("https://") !== 0) {
    err("webhook_url must be empty (unconfigured) or an https:// URL");
  }
  if (c.kind !== "webhook") err('kind must be "webhook"');
  if (typeof c.enabled !== "boolean") err("enabled must be a boolean");
  if (!Array.isArray(c.events)) err("events must be an array");
  return errs;
}

function isMessengerChannelConfigured(c) {
  return !!c && c.enabled === true &&
    typeof c.webhook_url === "string" && c.webhook_url.indexOf("https://") === 0;
}

/* Pure payload builder — the actual HTTP POST is server-side.
 * msg: { title, text, level }. Returns { channel_id, level, posted_at, payload }. */
function buildMessengerPayload(channel, msg) {
  var m = (msg && typeof msg === "object") ? msg : {};
  var level = MESSENGER_LEVELS.indexOf(m.level) !== -1 ? m.level : "info";
  var title = String(m.title != null ? m.title : "");
  var text = String(m.text != null ? m.text : "");
  var prefix = level === "info" ? "" : "[" + level.toUpperCase() + "] ";
  return {
    channel_id: channel && typeof channel.id === "string" ? channel.id : null,
    level: level,
    posted_at: new Date().toISOString(),
    payload: { text: prefix + (title !== "" ? title + "\n" : "") + text }
  };
}

/* ================= 4. KYC =================
 * Identity-verification provider config + check flow. A check is opened
 * automatically at preliminary registration (trigger "registration") and
 * may also be opened manually or on a schedule. The latest result state
 * lives on client.kyc.state; every transition is appended to
 * client.kyc.history so the full verification trail is auditable. */

var KYC_STATES = ["not_started", "pending", "approved", "rejected", "expired"];
var KYC_TRIGGERS = ["registration", "manual", "periodic"];

function defaultKycConfig() {
  return {
    provider_id: "kyc-provider-default",
    label: "Default KYC provider",
    auto_check_at_registration: true,
    enabled: true
  };
}

function validateKycConfig(c) {
  var errs = [];
  function err(m) { errs.push(m); }
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["kyc config must be an object"];
  if (typeof c.provider_id !== "string" || !c.provider_id)
    err("provider_id must be a non-empty string (neutral id, never a vendor brand)");
  if (typeof c.label !== "string") err("label must be a string");
  if (typeof c.auto_check_at_registration !== "boolean")
    err("auto_check_at_registration must be a boolean");
  if (typeof c.enabled !== "boolean") err("enabled must be a boolean");
  return errs;
}

/* A check record. Throws on missing provider or unknown trigger.
 * State starts "pending": the provider has been asked, no verdict yet. */
function createKycCheck(opts) {
  var o = (opts && typeof opts === "object") ? opts : {};
  if (typeof o.provider_id !== "string" || !o.provider_id)
    throw new Error("integrations: kyc check requires a provider_id");
  var trigger = o.trigger == null ? "registration" : o.trigger;
  if (KYC_TRIGGERS.indexOf(trigger) === -1)
    throw new Error("integrations: unknown kyc trigger: " + trigger);
  return {
    id: o.id != null ? o.id : null,
    provider_id: o.provider_id,
    trigger: trigger,
    state: "pending",
    created_at: o.created_at instanceof Date ? o.created_at : new Date(),
    checked_at: null,
    notes: ""
  };
}

/* A result is the provider's verdict on a check. "not_started" is never a
 * valid result state (it means no check was ever opened). */
function validateKycResult(r) {
  var errs = [];
  function err(m) { errs.push(m); }
  if (!r || typeof r !== "object" || Array.isArray(r)) return ["kyc result must be an object"];
  if (KYC_STATES.indexOf(r.state) === -1 || r.state === "not_started")
    errs.push("result state must be one of: pending, approved, rejected, expired");
  if (r.provider_id != null && (typeof r.provider_id !== "string" || !r.provider_id))
    errs.push("provider_id must be a non-empty string when given");
  if (r.trigger != null && KYC_TRIGGERS.indexOf(r.trigger) === -1)
    errs.push("trigger must be one of: " + KYC_TRIGGERS.join(", "));
  if (r.notes != null && typeof r.notes !== "string") errs.push("notes must be a string");
  if (r.checked_at != null && !(r.checked_at instanceof Date))
    errs.push("checked_at must be a Date when given");
  return errs;
}

function ensureKycSlot(client) {
  if (!client.kyc || typeof client.kyc !== "object" || Array.isArray(client.kyc))
    client.kyc = {};
  if (!Array.isArray(client.kyc.history)) client.kyc.history = [];
  return client.kyc;
}

/* Record a provider verdict on the client: updates the current state and
 * appends an immutable history entry. Returns the client (mutated). */
function applyKycResult(client, result) {
  if (!client || typeof client !== "object" || Array.isArray(client))
    throw new Error("integrations: client record required");
  var errs = validateKycResult(result);
  if (errs.length > 0)
    throw new Error("integrations: invalid kyc result: " + errs.join("; "));
  var kyc = ensureKycSlot(client);
  var entry = {
    at: result.checked_at instanceof Date ? result.checked_at : new Date(),
    state: result.state,
    provider_id: result.provider_id != null ? String(result.provider_id) : "",
    trigger: result.trigger != null ? result.trigger : "manual",
    notes: result.notes != null ? String(result.notes) : ""
  };
  kyc.history.push(entry);
  kyc.state = result.state;
  kyc.updated_at = entry.at;
  return client;
}

/* Registration flow: open the automatic check and mark the client pending.
 * Returns the check record; the client is mutated (kyc.state = "pending",
 * history appended). */
function startRegistrationCheck(client, providerId) {
  if (!client || typeof client !== "object" || Array.isArray(client))
    throw new Error("integrations: client record required");
  var check = createKycCheck({ provider_id: providerId, trigger: "registration" });
  var kyc = ensureKycSlot(client);
  kyc.history.push({
    at: check.created_at,
    state: "pending",
    provider_id: check.provider_id,
    trigger: "registration",
    notes: "automatic check at preliminary registration"
  });
  kyc.state = "pending";
  kyc.updated_at = check.created_at;
  return check;
}

/* Latest known state; "not_started" when no check was ever recorded. */
function kycStatus(client) {
  if (!client || typeof client !== "object") return "not_started";
  var st = client.kyc && client.kyc.state;
  return KYC_STATES.indexOf(st) !== -1 ? st : "not_started";
}

var INTEGRATIONS = {
  /* mail */
  MAILBOX_TYPES: MAILBOX_TYPES,
  TLS_MODES: TLS_MODES,
  defaultMailServer: defaultMailServer,
  validateMailServer: validateMailServer,
  isMailServerConfigured: isMailServerConfigured,
  resolveMailServer: resolveMailServer,
  createSendStats: createSendStats,
  recordSend: recordSend,
  sendStatsSummary: sendStatsSummary,
  /* sms */
  defaultSmsProvider: defaultSmsProvider,
  validateSmsProvider: validateSmsProvider,
  isSmsProviderConfigured: isSmsProviderConfigured,
  registerSmsProvider: registerSmsProvider,
  providerScore: providerScore,
  selectSmsProvider: selectSmsProvider,
  renderSmsTemplate: renderSmsTemplate,
  /* messengers */
  MESSENGER_LEVELS: MESSENGER_LEVELS,
  defaultMessengerChannel: defaultMessengerChannel,
  validateMessengerChannel: validateMessengerChannel,
  isMessengerChannelConfigured: isMessengerChannelConfigured,
  buildMessengerPayload: buildMessengerPayload,
  /* kyc */
  KYC_STATES: KYC_STATES,
  KYC_TRIGGERS: KYC_TRIGGERS,
  defaultKycConfig: defaultKycConfig,
  validateKycConfig: validateKycConfig,
  createKycCheck: createKycCheck,
  validateKycResult: validateKycResult,
  applyKycResult: applyKycResult,
  startRegistrationCheck: startRegistrationCheck,
  kycStatus: kycStatus
};
if (typeof module !== "undefined" && module.exports) { module.exports = INTEGRATIONS; }
else { root.OrbitIntegrations = INTEGRATIONS; }
})(typeof globalThis !== "undefined" ? globalThis : this);
