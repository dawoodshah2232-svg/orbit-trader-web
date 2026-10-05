/* shared/crm.js — OrbitTrader client-records (CRM) model.
 *
 * A client is the aggregated trader entity: personal data, documents and
 * linked trading accounts live in one record. Every change bumps `version`
 * and appends a history entry, so the full record history is versioned.
 *
 * Concepts (reimplemented in OrbitTrader's own model):
 *   - Lifecycle: not_registered -> active / inactive / suspended /
 *     closed / terminated. closed and terminated are terminal.
 *   - KYC: not_started -> pending -> verified / rejected, with verified
 *     records going stale after a configurable number of days (expired).
 *   - Assigned manager, lead source / campaign / visitor id for attribution.
 *   - Corporate clients: company name, LEI, VAT number, licence number.
 *   - Regulation profile: nationality, tax id, employment, income and
 *     net-worth bands, trading experience, source of funds.
 *   - Documents carry per-action permission lists (view / download) with
 *     staff roles; comments are a plain audit-friendly note log.
 *
 * Pure functions, no globals, no DOM, no I/O: runs in the browser and in
 * node (guarded export at the bottom, same pattern as shared/groups.js).
 * All mutating helpers return NEW client objects; inputs are never mutated.
 */
(function (root) {
"use strict";

var CLIENT_STATUSES = [
  "not_registered", "active", "inactive", "suspended", "closed", "terminated"
];
var TERMINAL_STATUSES = ["closed", "terminated"];

var CLIENT_TYPES = ["individual", "corporate"];

var KYC_STATUSES = ["not_started", "pending", "verified", "rejected", "expired"];

/* Lifecycle state machine. Lists the legal targets per current status.
 * closed / terminated are terminal (empty lists). */
var LIFECYCLE_TRANSITIONS = {
  not_registered: ["active", "suspended", "terminated"],
  active:         ["inactive", "suspended", "closed", "terminated"],
  inactive:       ["active", "suspended", "closed", "terminated"],
  suspended:      ["active", "closed", "terminated"],
  closed:         [],
  terminated:     []
};

/* KYC state machine. Verified records may lapse into expired when they go
 * stale (see isKycFresh); rejected/expired records re-enter pending for a
 * fresh review. */
var KYC_TRANSITIONS = {
  not_started: ["pending"],
  pending:     ["verified", "rejected"],
  verified:    ["expired", "pending"],
  rejected:    ["pending"],
  expired:     ["pending"]
};

var DOC_TYPES = [
  "id_card", "passport", "proof_of_address", "bank_statement", "selfie",
  "company_registration", "shareholder_register", "director_id", "other"
];

var DOC_ACTIONS = ["view", "download"];

/* Profile fields a manager may update in bulk (see updateProfile). */
var PROFILE_FIELDS = [
  "first_name", "last_name", "email", "phone", "date_of_birth", "language",
  "manager", "lead_source", "campaign", "visitor_id"
];
var ADDRESS_FIELDS = ["country", "city", "street", "postal"];
var REGULATION_FIELDS = [
  "nationality", "tax_id", "employment_status", "income_band",
  "net_worth_band", "trading_experience", "source_of_funds"
];
var CORPORATE_FIELDS = ["name", "lei", "vat_number", "licence_number"];

/* ---- config (documented defaults; the broker adjusts, no values are
 *      broker-specific) ---- */
function defaultConfig() {
  return {
    allowActivationWithoutKyc: false, /* true = may go active without verified KYC */
    kycFreshDays: 365,                /* verified KYC stays fresh this many days */
    requireReasonFor: ["suspended", "closed", "terminated"],
    maxCommentChars: 2000,
    maxDocuments: 50,
    docPermissionRoles: ["admin", "manager", "kyc_officer"]
  };
}

/* ---- small helpers ---- */
function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string") return now;
  return new Date().toISOString();
}
function isBlank(v) {
  return v === null || v === undefined || (typeof v === "string" && v.replace(/^\s+|\s+$/g, "") === "");
}
function emailOk(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function generateId(prefix) {
  return (prefix || "c_") + Date.now().toString(36) + "_" +
    Math.floor(Math.random() * 1e9).toString(36);
}
function shallowCopy(o) {
  var out = {};
  for (var k in o) {
    if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  }
  return out;
}
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ---- 1. client record factory ---- */
function defaultClient(overrides, now) {
  var stamp = nowIso(now);
  var c = {
    id: generateId("c_"),
    type: "individual",
    status: "not_registered",
    kyc_status: "not_started",
    kyc_verified_at: null,
    first_name: "", last_name: "",
    email: "", phone: "", date_of_birth: null,
    language: "en",
    address: { country: "", city: "", street: "", postal: "" },
    company: null, /* corporate clients only: {name, lei, vat_number, licence_number} */
    regulation: {
      nationality: "", tax_id: "", employment_status: "",
      income_band: "", net_worth_band: "",
      trading_experience: "", source_of_funds: ""
    },
    manager: null,
    lead_source: null, campaign: null, visitor_id: null,
    accounts: [],   /* linked trading account logins */
    documents: [],   /* see addDocument */
    comments: [],    /* see addComment */
    version: 1,
    history: [],
    created_at: stamp,
    updated_at: stamp
  };
  c.history.push({
    version: 1, changed_at: stamp, changed_by: "system",
    action: "created", note: "", changes: {}
  });
  if (overrides && typeof overrides === "object") {
    for (var k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) c[k] = overrides[k];
    }
  }
  return c;
}

/* ---- 2. validation -> array of error strings (empty = valid) ---- */
function validateDocument(doc, cfg) {
  var errs = [];
  var config = cfg || defaultConfig();
  function err(m) { errs.push(m); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["document must be an object"];
  if (DOC_TYPES.indexOf(doc.doc_type) === -1)
    err("doc_type must be one of: " + DOC_TYPES.join(", "));
  if (isBlank(doc.filename) || typeof doc.filename !== "string")
    err("filename is required");
  if (doc.size_bytes !== undefined &&
      (typeof doc.size_bytes !== "number" || !isFinite(doc.size_bytes) || doc.size_bytes < 0))
    err("size_bytes must be a number >= 0");
  var p = doc.permissions;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    err("permissions must be an object");
  } else {
    DOC_ACTIONS.forEach(function (a) {
      var roles = p[a];
      if (roles === undefined) return; /* action not granted to anyone */
      if (!Array.isArray(roles)) { err("permissions." + a + " must be an array of roles"); return; }
      roles.forEach(function (r) {
        if (config.docPermissionRoles.indexOf(r) === -1)
          err("permissions." + a + ": unknown role '" + r + "'");
      });
    });
    for (var k in p) {
      if (Object.prototype.hasOwnProperty.call(p, k) && DOC_ACTIONS.indexOf(k) === -1)
        err("unknown permission action '" + k + "'");
    }
  }
  return errs;
}

function validateComment(comment, cfg) {
  var config = cfg || defaultConfig();
  if (!comment || typeof comment !== "object" || Array.isArray(comment))
    return ["comment must be an object"];
  var errs = [];
  if (isBlank(comment.author) || typeof comment.author !== "string")
    errs.push("comment.author is required");
  if (typeof comment.body !== "string" || isBlank(comment.body))
    errs.push("comment.body is required");
  else if (comment.body.length > config.maxCommentChars)
    errs.push("comment.body exceeds " + config.maxCommentChars + " characters");
  return errs;
}

function validateClient(c, cfg) {
  var errs = [];
  var config = cfg || defaultConfig();
  function err(m) { errs.push(m); }
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["client must be an object"];

  if (isBlank(c.id) || typeof c.id !== "string") err("id is required");
  if (CLIENT_TYPES.indexOf(c.type) === -1)
    err("type must be one of: " + CLIENT_TYPES.join(", "));
  if (CLIENT_STATUSES.indexOf(c.status) === -1)
    err("status must be one of: " + CLIENT_STATUSES.join(", "));
  if (KYC_STATUSES.indexOf(c.kyc_status) === -1)
    err("kyc_status must be one of: " + KYC_STATUSES.join(", "));

  if (c.type === "individual") {
    if (isBlank(c.first_name)) err("first_name is required for individual clients");
    if (isBlank(c.last_name)) err("last_name is required for individual clients");
  } else if (c.type === "corporate") {
    if (!c.company || typeof c.company !== "object" || isBlank(c.company.name))
      err("company.name is required for corporate clients");
    else if (c.company.lei && !/^[A-Z0-9]{20}$/.test(c.company.lei))
      err("company.lei must be 20 alphanumeric characters");
  }

  if (!isBlank(c.email) && !emailOk(c.email)) err("email is not a valid address");
  if (c.date_of_birth !== null && c.date_of_birth !== undefined) {
    var d = new Date(c.date_of_birth);
    if (isNaN(d.getTime())) err("date_of_birth is not a valid date");
    else if (d.getTime() > Date.now()) err("date_of_birth cannot be in the future");
  }
  if (c.address && typeof c.address === "object") {
    ADDRESS_FIELDS.forEach(function (f) {
      if (c.address[f] !== undefined && typeof c.address[f] !== "string")
        err("address." + f + " must be a string");
    });
  }
  if (typeof c.version !== "number" || Math.floor(c.version) !== c.version || c.version < 1)
    err("version must be a positive integer");
  if (!Array.isArray(c.accounts)) err("accounts must be an array");
  else c.accounts.forEach(function (a) {
    if (typeof a !== "number" || Math.floor(a) !== a || a <= 0)
      err("accounts must contain positive integer logins");
  });
  if (!Array.isArray(c.documents)) err("documents must be an array");
  else c.documents.forEach(function (doc, i) {
    validateDocument(doc, config).forEach(function (e) {
      err("documents[" + i + "]: " + e);
    });
  });
  if (!Array.isArray(c.comments)) err("comments must be an array");
  else c.comments.forEach(function (cm, i) {
    validateComment(cm, config).forEach(function (e) {
      err("comments[" + i + "]: " + e);
    });
  });
  if (!Array.isArray(c.history)) err("history must be an array");
  return errs;
}

/* ---- 3. versioned history ----
 * Every mutating helper routes through commitChange(): bumps `version`,
 * stamps updated_at, appends a history entry {version, changed_at,
 * changed_by, action, note, changes}. Returns a NEW client object. */
function commitChange(client, action, changes, note, actor, now) {
  var stamp = nowIso(now);
  var c = shallowCopy(client);
  c.version = client.version + 1;
  c.updated_at = stamp;
  c.history = client.history.slice();
  c.history.push({
    version: c.version,
    changed_at: stamp,
    changed_by: actor || "system",
    action: action,
    note: note || "",
    changes: changes || {}
  });
  return c;
}

/* ---- 4. lifecycle ---- */
function canTransition(from, to) {
  var allowed = LIFECYCLE_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.indexOf(to) !== -1;
}
function nextStatuses(from) {
  var allowed = LIFECYCLE_TRANSITIONS[from];
  return allowed ? allowed.slice() : [];
}
function isTerminalStatus(status) {
  return TERMINAL_STATUSES.indexOf(status) !== -1;
}

/* ---- 5. KYC ----
 * A verified record is "fresh" while kyc_verified_at is within
 * config.kycFreshDays of now. kycEffectiveStatus() folds staleness into the
 * reported status so callers never have to check dates themselves. */
function isKycFresh(client, cfg, now) {
  var config = cfg || defaultConfig();
  if (!client || client.kyc_status !== "verified") return false;
  if (!client.kyc_verified_at) return false;
  var at = new Date(client.kyc_verified_at).getTime();
  if (isNaN(at)) return false;
  var ageMs = (now instanceof Date ? now : new Date()).getTime() - at;
  return ageMs >= 0 && ageMs <= config.kycFreshDays * 86400000;
}
function kycEffectiveStatus(client, cfg, now) {
  if (client && client.kyc_status === "verified" && !isKycFresh(client, cfg, now))
    return "expired";
  return client ? client.kyc_status : "not_started";
}
function canKycTransition(from, to) {
  var allowed = KYC_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.indexOf(to) !== -1;
}
function kycTransition(client, to, opts) {
  opts = opts || {};
  var cfg = opts.config || defaultConfig();
  var stamp = nowIso(opts.now);
  var from = client.kyc_status;
  if (KYC_STATUSES.indexOf(to) === -1)
    throw new Error("crm: unknown kyc status '" + to + "'");
  if (!canKycTransition(from, to))
    throw new Error("crm: kyc transition not allowed: " + from + " -> " + to);
  if (to === "verified" && opts.reviewedBy === undefined && !opts.reviewed)
    throw new Error("crm: verifying KYC requires a reviewer (opts.reviewedBy)");
  var c = shallowCopy(client);
  c.kyc_status = to;
  if (to === "verified") c.kyc_verified_at = stamp;
  if (to === "rejected") c.kyc_verified_at = null;
  c = commitChange(c, "kyc:" + from + "->" + to,
    { kyc_status: [from, to] }, opts.note || "", opts.actor, opts.now);
  return c;
}

/* ---- 6. lifecycle transition ----
 * Enforces the state machine, the KYC gate for activation, and the
 * reason requirement for suspend/close/terminate. Returns a NEW client. */
function transitionClient(client, to, opts) {
  opts = opts || {};
  var cfg = opts.config || defaultConfig();
  var from = client.status;
  if (CLIENT_STATUSES.indexOf(to) === -1)
    throw new Error("crm: unknown status '" + to + "'");
  if (!canTransition(from, to))
    throw new Error("crm: transition not allowed: " + from + " -> " + to);
  if (cfg.requireReasonFor.indexOf(to) !== -1 && isBlank(opts.reason))
    throw new Error("crm: a reason is required to move to '" + to + "'");
  if (to === "active" && !cfg.allowActivationWithoutKyc) {
    if (kycEffectiveStatus(client, cfg, opts.now) !== "verified")
      throw new Error("crm: activation requires fresh verified KYC");
  }
  var c = shallowCopy(client);
  c.status = to;
  return commitChange(c, "status:" + from + "->" + to,
    { status: [from, to] }, opts.reason || "", opts.actor, opts.now);
}

/* Trading gate: active lifecycle AND fresh verified KYC (KYC gate waived
 * only when the config explicitly allows it). */
function canTrade(client, cfg, now) {
  var config = cfg || defaultConfig();
  if (!client || client.status !== "active") return false;
  if (config.allowActivationWithoutKyc) return true;
  return kycEffectiveStatus(client, config, now) === "verified";
}

/* ---- 7. documents ----
 * permissions: {view:[roles], download:[roles]}. docMay(doc, action,
 * userRoles) is the enforcement point used by download/view endpoints. */
function docMay(doc, action, userRoles, cfg) {
  var config = cfg || defaultConfig();
  if (!doc || !doc.permissions) return false;
  if (DOC_ACTIONS.indexOf(action) === -1) return false;
  var granted = doc.permissions[action];
  if (!Array.isArray(granted)) return false;
  var roles = Array.isArray(userRoles) ? userRoles : [userRoles];
  for (var i = 0; i < roles.length; i++) {
    if (granted.indexOf(roles[i]) !== -1 &&
        config.docPermissionRoles.indexOf(roles[i]) !== -1) return true;
  }
  return false;
}
function addDocument(client, doc, opts) {
  opts = opts || {};
  var cfg = opts.config || defaultConfig();
  var errs = validateDocument(doc, cfg);
  if (errs.length) throw new Error("crm: invalid document: " + errs.join("; "));
  if (client.documents.length >= cfg.maxDocuments)
    throw new Error("crm: document limit reached (" + cfg.maxDocuments + ")");
  var d = shallowCopy(doc);
  d.id = d.id || generateId("doc_");
  d.uploaded_at = d.uploaded_at || nowIso(opts.now);
  d.uploaded_by = d.uploaded_by || opts.actor || "system";
  d.verified_at = d.verified_at || null;
  d.verified_by = d.verified_by || null;
  var c = shallowCopy(client);
  c.documents = client.documents.concat([d]);
  return commitChange(c, "document:added", { document_id: d.id }, opts.note || "", opts.actor, opts.now);
}
function findDocument(client, docId) {
  for (var i = 0; i < client.documents.length; i++) {
    if (client.documents[i].id === docId) return client.documents[i];
  }
  return null;
}
function removeDocument(client, docId, opts) {
  opts = opts || {};
  if (!findDocument(client, docId))
    throw new Error("crm: document not found: " + docId);
  var c = shallowCopy(client);
  c.documents = client.documents.filter(function (d) { return d.id !== docId; });
  return commitChange(c, "document:removed", { document_id: docId }, opts.note || "", opts.actor, opts.now);
}
/* Only metadata may be patched post-upload: permissions, verification
 * stamp/reviewer, filename. The file bytes are immutable. */
function updateDocument(client, docId, patch, opts) {
  opts = opts || {};
  var cfg = opts.config || defaultConfig();
  var existing = findDocument(client, docId);
  if (!existing) throw new Error("crm: document not found: " + docId);
  var ALLOW = ["permissions", "verified_at", "verified_by", "filename"];
  var merged = shallowCopy(existing);
  var changes = {};
  for (var k in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    if (ALLOW.indexOf(k) === -1) throw new Error("crm: document field not updatable: " + k);
    if (!sameValue(existing[k], patch[k])) { merged[k] = patch[k]; changes[k] = [existing[k], patch[k]]; }
  }
  var errs = validateDocument(merged, cfg);
  if (errs.length) throw new Error("crm: invalid document update: " + errs.join("; "));
  var c = shallowCopy(client);
  c.documents = client.documents.map(function (d) { return d.id === docId ? merged : d; });
  return commitChange(c, "document:updated", { document_id: docId, fields: changes },
    opts.note || "", opts.actor, opts.now);
}

/* ---- 8. comments ---- */
function addComment(client, author, body, opts) {
  opts = opts || {};
  var cfg = opts.config || defaultConfig();
  var cm = {
    id: generateId("cm_"),
    author: author,
    body: body,
    created_at: nowIso(opts.now)
  };
  var errs = validateComment(cm, cfg);
  if (errs.length) throw new Error("crm: invalid comment: " + errs.join("; "));
  var c = shallowCopy(client);
  c.comments = client.comments.concat([cm]);
  return commitChange(c, "comment:added", { comment_id: cm.id }, "", opts.actor, opts.now);
}

/* ---- 9. manager assignment + profile updates ---- */
function assignManager(client, manager, opts) {
  opts = opts || {};
  if (isBlank(manager) || typeof manager !== "string")
    throw new Error("crm: manager must be a non-empty string");
  var old = client.manager;
  if (old === manager) return client; /* no-op: no version bump */
  var c = shallowCopy(client);
  c.manager = manager;
  return commitChange(c, "manager:assigned", { manager: [old, manager] },
    opts.note || "", opts.actor, opts.now);
}
function updateProfile(client, patch, opts) {
  opts = opts || {};
  var c = shallowCopy(client);
  var changes = {};
  function setField(obj, key, val) {
    if (!sameValue(obj[key], val)) { changes[key] = [obj[key], val]; obj[key] = val; }
  }
  PROFILE_FIELDS.forEach(function (f) {
    if (patch[f] !== undefined) setField(c, f, patch[f]);
  });
  if (patch.address && typeof patch.address === "object") {
    c.address = shallowCopy(c.address || {});
    ADDRESS_FIELDS.forEach(function (f) {
      if (patch.address[f] !== undefined && !sameValue(c.address[f], patch.address[f])) {
        changes["address." + f] = [c.address[f], patch.address[f]];
        c.address[f] = patch.address[f];
      }
    });
  }
  if (patch.regulation && typeof patch.regulation === "object") {
    c.regulation = shallowCopy(c.regulation || {});
    REGULATION_FIELDS.forEach(function (f) {
      if (patch.regulation[f] !== undefined && !sameValue(c.regulation[f], patch.regulation[f])) {
        changes["regulation." + f] = [c.regulation[f], patch.regulation[f]];
        c.regulation[f] = patch.regulation[f];
      }
    });
  }
  if (patch.company !== undefined) {
    if (c.type !== "corporate") throw new Error("crm: company data is for corporate clients only");
    c.company = patch.company === null ? null : shallowCopy(patch.company);
    changes.company = ["<updated>"];
  }
  var keys = Object.keys(changes);
  if (!keys.length) return client; /* no-op */
  var errs = validateClient(c, opts.config);
  if (errs.length) throw new Error("crm: invalid profile update: " + errs.join("; "));
  return commitChange(c, "profile:updated", changes, opts.note || "", opts.actor, opts.now);
}

/* ---- 10. account links + derived read model ---- */
function linkAccount(client, login, opts) {
  opts = opts || {};
  if (typeof login !== "number" || Math.floor(login) !== login || login <= 0)
    throw new Error("crm: login must be a positive integer");
  if (client.accounts.indexOf(login) !== -1) return client; /* already linked */
  var c = shallowCopy(client);
  c.accounts = client.accounts.concat([login]);
  return commitChange(c, "account:linked", { login: login }, opts.note || "", opts.actor, opts.now);
}
function unlinkAccount(client, login, opts) {
  opts = opts || {};
  if (client.accounts.indexOf(login) === -1)
    throw new Error("crm: account not linked: " + login);
  var c = shallowCopy(client);
  c.accounts = client.accounts.filter(function (a) { return a !== login; });
  return commitChange(c, "account:unlinked", { login: login }, opts.note || "", opts.actor, opts.now);
}
/* Flat derived view for admin UI badges/lists. Never persisted. */
function derive(client, cfg, now) {
  var config = cfg || defaultConfig();
  return {
    id: client.id,
    type: client.type,
    status: client.status,
    terminal: isTerminalStatus(client.status),
    kyc: kycEffectiveStatus(client, config, now),
    kyc_fresh: isKycFresh(client, config, now),
    can_trade: canTrade(client, config, now),
    manager: client.manager,
    accounts: client.accounts.length,
    documents: client.documents.length,
    comments: client.comments.length,
    version: client.version
  };
}

var CRM = {
  CLIENT_STATUSES: CLIENT_STATUSES,
  TERMINAL_STATUSES: TERMINAL_STATUSES,
  CLIENT_TYPES: CLIENT_TYPES,
  KYC_STATUSES: KYC_STATUSES,
  LIFECYCLE_TRANSITIONS: LIFECYCLE_TRANSITIONS,
  KYC_TRANSITIONS: KYC_TRANSITIONS,
  DOC_TYPES: DOC_TYPES,
  DOC_ACTIONS: DOC_ACTIONS,
  defaultConfig: defaultConfig,
  defaultClient: defaultClient,
  validateClient: validateClient,
  validateDocument: validateDocument,
  validateComment: validateComment,
  canTransition: canTransition,
  nextStatuses: nextStatuses,
  isTerminalStatus: isTerminalStatus,
  isKycFresh: isKycFresh,
  kycEffectiveStatus: kycEffectiveStatus,
  canKycTransition: canKycTransition,
  kycTransition: kycTransition,
  transitionClient: transitionClient,
  canTrade: canTrade,
  docMay: docMay,
  addDocument: addDocument,
  findDocument: findDocument,
  removeDocument: removeDocument,
  updateDocument: updateDocument,
  addComment: addComment,
  assignManager: assignManager,
  updateProfile: updateProfile,
  linkAccount: linkAccount,
  unlinkAccount: unlinkAccount,
  derive: derive
};
if (typeof module !== "undefined" && module.exports) { module.exports = CRM; }
else { root.OrbitCRM = CRM; }
})(typeof globalThis !== "undefined" ? globalThis : this);
