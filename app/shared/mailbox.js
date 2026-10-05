/* QuotesWare wave-2 — Mailbox (internal broker-to-trader mail) model.
 *
 * Platform-independent core for the broker mailbox: message records,
 * read/unread tracking, a template engine with per-account macros,
 * attachment policy, bulk-recipient expansion, and the manager
 * send-permission gate. Pure logic — no DOM, no network, no DB.
 *
 * Note on rights: the manager rights catalogue lives in `shared/rbac.js`
 * (do not edit). The send right is named MAIL_SEND ('mailbox.send') here;
 * `canSend` consults it, falling back to the documented tiers in
 * docs/ROLES.md ('dealing' and above may broadcast).
 */
"use strict";

// --- Attachment policy -------------------------------------------------------
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;        // 2 MB per file
const MAX_TOTAL_ATTACHMENTS_BYTES = 4 * 1024 * 1024; // 4 MB per message
const MAX_ATTACHMENT_FILES = 5;                      // 5 files max per message

// --- Permission gate ---------------------------------------------------------
// Manager right required to send mailbox mail. Consults shared/rbac.js
// conventions: an actor's rights may be given as an array of right names,
// an object with a `rights` array, or an object with a `tier` string
// (roles tiers: 'read' | 'dealing' | 'admin' | 'keys' per docs/ROLES.md).
// Anything unknown fails closed (cannot send).
const MAIL_SEND = "mailbox.send";

function normalizeRights(actor) {
  if (!actor) return { rights: [], tier: null };
  if (Array.isArray(actor)) return { rights: actor.slice(), tier: null };
  if (typeof actor === "object") {
    return {
      rights: Array.isArray(actor.rights) ? actor.rights.slice() : [],
      tier: typeof actor.tier === "string" ? actor.tier : null,
    };
  }
  return { rights: [], tier: null };
}

function canSend(actor) {
  const n = normalizeRights(actor);
  if (n.rights.indexOf(MAIL_SEND) !== -1) return true;
  // Role-tier fallback per docs/ROLES.md: dealing/admin tiers are the staff
  // roles allowed to broadcast; read-only tiers and traders cannot send.
  if (n.tier === "dealing" || n.tier === "admin") return true;
  return false;
}

// --- Message model -----------------------------------------------------------
// { id, subject, body, sender, recipient_account_id, sent_at, read_at }
// `read_at` is null until the recipient opens the message.
function createMessage(opts) {
  const o = opts || {};
  if (typeof o.recipient_account_id !== "number" || !Number.isFinite(o.recipient_account_id)) {
    throw new TypeError("createMessage: recipient_account_id must be a finite number");
  }
  const now = o.sent_at instanceof Date ? o.sent_at : new Date();
  return {
    id: o.id != null ? o.id : null,
    subject: String(o.subject != null ? o.subject : ""),
    body: String(o.body != null ? o.body : ""),
    sender: String(o.sender != null ? o.sender : "broker"),
    recipient_account_id: o.recipient_account_id,
    sent_at: now,
    read_at: o.read_at instanceof Date ? o.read_at : null,
  };
}

function isRead(msg) {
  return !!(msg && msg.read_at instanceof Date);
}

// Idempotent: first open stamps read_at; later calls leave the original stamp.
function markRead(msg, when) {
  if (!msg || typeof msg !== "object") throw new TypeError("markRead: message required");
  if (isRead(msg)) return msg;
  msg.read_at = when instanceof Date ? when : new Date();
  return msg;
}

// --- Template engine ---------------------------------------------------------
// Account macros (per-recipient values, rendered at send time):
//   #LOGIN# #USER_BALANCE# #USER_EQUITY# #USER_MARGIN#
//   #USER_MARGIN_FREE# #USER_MARGIN_LEVEL#
// Time macros (UTC):
//   #DATE# (YYYY-MM-DD)  #TIME# (HH:MM)  #DATETIME# (YYYY-MM-DD HH:MM)
// Unknown macros (e.g. #FOO#) pass through untouched.
const MACRO_RE = /#([A-Z_]+)#/g;

function mbMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function renderTemplate(tpl, account) {
  const src = String(tpl != null ? tpl : "");
  const acc = account || {};
  const now = new Date();
  const values = {
    LOGIN: String(acc.login != null ? acc.login : ""),
    USER_BALANCE: mbMoney(acc.balance),
    USER_EQUITY: mbMoney(acc.equity != null ? acc.equity : acc.balance),
    USER_MARGIN: mbMoney(acc.margin),
    USER_MARGIN_FREE: mbMoney(acc.margin_free != null ? acc.margin_free : acc.free_margin),
    USER_MARGIN_LEVEL: mbMoney(acc.margin_level),
    DATE: now.getUTCFullYear() + "-" + pad2(now.getUTCMonth() + 1) + "-" + pad2(now.getUTCDate()),
    TIME: pad2(now.getUTCHours()) + ":" + pad2(now.getUTCMinutes()),
    DATETIME:
      now.getUTCFullYear() + "-" + pad2(now.getUTCMonth() + 1) + "-" + pad2(now.getUTCDate()) +
      " " + pad2(now.getUTCHours()) + ":" + pad2(now.getUTCMinutes()),
  };
  return src.replace(MACRO_RE, function (m, name) {
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m;
  });
}

// --- Attachment policy -------------------------------------------------------
// files: [{ name, size }] where size is bytes. Returns { ok, errors[] }.
// Edges: exactly 2MB per file OK; exactly 5 files OK; exactly 4MB total OK.
function validateAttachments(files) {
  const list = Array.isArray(files) ? files : [];
  const errors = [];
  let total = 0;
  if (list.length > MAX_ATTACHMENT_FILES) {
    errors.push("too many files: " + list.length + " (max " + MAX_ATTACHMENT_FILES + ")");
  }
  list.forEach(function (f, i) {
    const label = (f && f.name ? String(f.name) : "file#" + (i + 1));
    const size = f ? Number(f.size) : NaN;
    if (!Number.isFinite(size) || size < 0) {
      errors.push(label + ": invalid size");
      return;
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      errors.push(label + ": " + size + " bytes exceeds 2MB per-file limit");
    }
    total += size;
  });
  if (total > MAX_TOTAL_ATTACHMENTS_BYTES) {
    errors.push("total " + total + " bytes exceeds 4MB message limit");
  }
  return { ok: errors.length === 0, errors: errors, total_bytes: total, count: list.length };
}

// --- Bulk recipient expansion ------------------------------------------------
// rangeSpec: comma-separated tokens, e.g. "1001, 1002-1005, group:Orbit-Demo, all"
//   - "1234"            single account login
//   - "1001-1050"       inclusive login range (reversed ranges rejected)
//   - "group:<name>"    every account in that group
//   - "all"             every account
// accounts: [{ login, group, ... }]. Returns { logins, invalid } — logins sorted
// numerically and deduplicated; invalid tokens listed, never thrown.
function expandRecipients(rangeSpec, accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const logins = new Set();
  const invalid = [];
  const tokens = String(rangeSpec != null ? rangeSpec : "")
    .split(",")
    .map(function (t) { return t.trim(); })
    .filter(function (t) { return t.length > 0; });

  tokens.forEach(function (tok) {
    const low = tok.toLowerCase();
    if (low === "all") {
      list.forEach(function (a) { if (isLogin(a)) logins.add(a.login); });
      return;
    }
    const gm = /^group\s*:\s*(.+)$/i.exec(tok);
    if (gm) {
      const want = gm[1].trim().toLowerCase();
      let hit = false;
      list.forEach(function (a) {
        if (isLogin(a) && String(a.group || "").toLowerCase() === want) {
          logins.add(a.login);
          hit = true;
        }
      });
      if (!hit) invalid.push(tok);
      return;
    }
    const rm = /^(\d+)\s*-\s*(\d+)$/.exec(tok);
    if (rm) {
      const lo = parseInt(rm[1], 10), hi = parseInt(rm[2], 10);
      if (lo > hi) { invalid.push(tok); return; }
      list.forEach(function (a) {
        if (isLogin(a) && a.login >= lo && a.login <= hi) logins.add(a.login);
      });
      return;
    }
    const sm = /^(\d+)$/.exec(tok);
    if (sm) {
      const login = parseInt(sm[1], 10);
      const found = list.some(function (a) { return isLogin(a) && a.login === login; });
      if (found) logins.add(login);
      else invalid.push(tok);
      return;
    }
    invalid.push(tok);
  });

  return { logins: Array.from(logins).sort(function (a, b) { return a - b; }), invalid: invalid };
}

function isLogin(a) {
  return a && typeof a.login === "number" && Number.isFinite(a.login);
}

var __EXP_MAILBOX__ = (function () { var E = {
  MAX_ATTACHMENT_BYTES: MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENTS_BYTES: MAX_TOTAL_ATTACHMENTS_BYTES,
  MAX_ATTACHMENT_FILES: MAX_ATTACHMENT_FILES,
  MAIL_SEND: MAIL_SEND,
  canSend: canSend,
  createMessage: createMessage,
  isRead: isRead,
  markRead: markRead,
  renderTemplate: renderTemplate,
  validateAttachments: validateAttachments,
  expandRecipients: expandRecipients,
};
return E; })();
if (typeof module !== "undefined" && module.exports) { module.exports = __EXP_MAILBOX__; }
else if (typeof globalThis !== "undefined") { globalThis.OrbitMailbox = __EXP_MAILBOX__; }
