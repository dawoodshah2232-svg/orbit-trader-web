/* shared/automations.js — OrbitTrader automation engine (module 9).
 *
 * Event-driven task engine: TRIGGERS detect something worth reacting to,
 * CONDITIONS filter which events qualify, and ACTIONS carry out the response.
 * Typical uses: client communication (email/SMS/channel messages), routine
 * maintenance (log purging, backups), configuration management (symbol/group
 * parameters, leverage profiles), and deal/account management (blocks,
 * balance operations, forced position closes).
 *
 * Pure functions, no globals, no DOM, no I/O: runs in the browser and in
 * node (guarded export at the bottom, same pattern as shared/groups.js).
 * Action "execution" here means PLANNING: planAction()/executeTask() produce
 * op descriptors that the server-side executor applies; nothing in this
 * file touches accounts, balances, or message queues directly. That keeps
 * dry-run mode honest: a dry run plans exactly what a real run would apply.
 *
 * Conventions:
 *   - All timestamps are epoch seconds, UTC (server time).
 *   - Condition fields are dotted paths into the event payload
 *     (e.g. "account.balance", "position.symbol").
 *   - Action param strings support {dotted.path} macros resolved from the
 *     payload, so messages can name the account or symbol involved.
 *   - MAX_ACTIONS_PER_RUN caps how many actions one task run may plan.
 *     A task may set a lower per-task cap, never a higher one.
 */
(function (root) {
"use strict";

/* ================= 1. guardrails ================= */
var MAX_ACTIONS_PER_RUN = 10;      /* hard ceiling, per task run */
var MAX_CRON_LOOKAHEAD_MIN = 366 * 24 * 60;  /* one year, minute steps */

var RUN_AS_SCOPES = ["system", "manager"];
var CONDITION_OPERATORS = [
  "eq", "neq", "gt", "gte", "lt", "lte",
  "in", "not_in", "contains", "not_contains",
  "starts_with", "ends_with",
  "exists", "not_exists", "is_empty", "is_not_empty"
];

/* ================= 2. trigger catalog =================
 * name: stable identifier. kind: "schedule" (time-driven) or "event".
 * category groups the catalog for admin UIs. params describe the
 * trigger-level settings a task supplies (validated by validateTask).
 */
var TRIGGER_CATALOG = [
  /* ---- schedule triggers ---- */
  { name: "schedule.interval", kind: "schedule", category: "schedule",
    description: "Run every N seconds.",
    params: ["interval_seconds"] },
  { name: "schedule.daily", kind: "schedule", category: "schedule",
    description: "Run once a day at a fixed server time, optionally on selected weekdays.",
    params: ["time", "days_of_week"], optional: ["days_of_week"] },
  { name: "schedule.once", kind: "schedule", category: "schedule",
    description: "Run once at a specific time (one-shot task).",
    params: ["at"] },
  { name: "schedule.cron", kind: "schedule", category: "schedule",
    description: "Run on a 5-field cron expression (minute hour day month weekday).",
    params: ["expression"] },
  /* ---- platform events ---- */
  { name: "event.config_changed", kind: "event", category: "platform",
    description: "A server, symbol, or group configuration value changed.",
    params: [] },
  { name: "event.server_restarted", kind: "event", category: "platform",
    description: "The trade server (re)started.",
    params: [] },
  { name: "event.symbol_added", kind: "event", category: "platform",
    description: "A new tradable symbol was created.",
    params: [] },
  { name: "event.session_changed", kind: "event", category: "platform",
    description: "A trading session opened or closed.",
    params: [] },
  /* ---- account events ---- */
  { name: "event.account_created", kind: "event", category: "account",
    description: "An account was created (demo, preliminary, or live).",
    params: [] },
  { name: "event.account_status_changed", kind: "event", category: "account",
    description: "An account moved between statuses (active/suspended/closed...).",
    params: [] },
  { name: "event.balance_low", kind: "event", category: "account",
    description: "An account balance dropped below the configured threshold.",
    params: ["threshold"] },
  { name: "event.login_failed", kind: "event", category: "account",
    description: "A client login attempt failed.",
    params: [] },
  { name: "event.kyc_status_changed", kind: "event", category: "account",
    description: "A client's KYC verification status changed.",
    params: [] },
  /* ---- trading events ---- */
  { name: "event.order_placed", kind: "event", category: "trading",
    description: "A new order was placed.",
    params: [] },
  { name: "event.order_closed", kind: "event", category: "trading",
    description: "An order was closed or cancelled.",
    params: [] },
  { name: "event.position_opened", kind: "event", category: "trading",
    description: "A position was opened.",
    params: [] },
  { name: "event.position_closed", kind: "event", category: "trading",
    description: "A position was closed.",
    params: [] },
  { name: "event.margin_call", kind: "event", category: "trading",
    description: "An account hit margin-call level.",
    params: [] },
  { name: "event.stop_out", kind: "event", category: "trading",
    description: "An account was stopped out.",
    params: [] },
  { name: "event.deposit", kind: "event", category: "trading",
    description: "A deposit balance operation was applied.",
    params: [] },
  { name: "event.withdrawal", kind: "event", category: "trading",
    description: "A withdrawal balance operation was applied.",
    params: [] }
];

function triggerByName(name) {
  for (var i = 0; i < TRIGGER_CATALOG.length; i++) {
    if (TRIGGER_CATALOG[i].name === name) return TRIGGER_CATALOG[i];
  }
  return null;
}

/* ================= 3. action catalog ================= */
var ACTION_CATALOG = [
  /* ---- client communication ---- */
  { name: "send_email", category: "communication",
    description: "Send an email to the client or a fixed address.",
    params: ["to", "subject", "body"] },
  { name: "send_sms", category: "communication",
    description: "Send an SMS to the client's phone number.",
    params: ["to", "body"] },
  { name: "post_channel_message", category: "communication",
    description: "Post a message to a team messaging channel (e.g. alerts channel).",
    params: ["channel", "message"] },
  { name: "send_terminal_message", category: "communication",
    description: "Deliver a message to the client's trading terminal mailbox.",
    params: ["login", "subject", "body"] },
  /* ---- maintenance ---- */
  { name: "purge_old_logs", category: "maintenance",
    description: "Delete log/journal records older than N days.",
    params: ["older_than_days"] },
  { name: "backup_database", category: "maintenance",
    description: "Take a database backup to the configured target.",
    params: ["target"] },
  { name: "rebuild_cache", category: "maintenance",
    description: "Rebuild a server-side cache (quotes, sessions, specs).",
    params: ["scope"] },
  { name: "set_trading_mode", category: "maintenance",
    description: "Enable, restrict, or disable trading for symbols matching a mask.",
    params: ["symbol_mask", "mode"] },
  /* ---- configuration management ---- */
  { name: "set_symbol_param", category: "config",
    description: "Set a symbol parameter (spread, swap, margin...) on masked symbols.",
    params: ["symbol_mask", "param", "value"] },
  { name: "set_group_param", category: "config",
    description: "Set a group setting on one account group.",
    params: ["group", "param", "value"] },
  { name: "set_leverage_profile", category: "config",
    description: "Assign a floating-leverage profile to a group (e.g. auto-adjust on risk events).",
    params: ["group", "profile_id"] },
  /* ---- deal / account management ---- */
  { name: "block_account", category: "account",
    description: "Block an account (no trading, no logins) with a reason.",
    params: ["login", "reason"] },
  { name: "unblock_account", category: "account",
    description: "Remove a block from an account.",
    params: ["login"] },
  { name: "balance_operation", category: "account",
    description: "Apply a balance operation: bonus, charge, or correction.",
    params: ["login", "amount", "op_type", "comment"] },
  { name: "close_positions", category: "account",
    description: "Close open positions on an account, optionally limited by symbol mask.",
    params: ["login", "symbol_mask"] },
  { name: "assign_manager", category: "account",
    description: "Assign (or reassign) the account manager for a client.",
    params: ["login", "manager_id"] },
  { name: "flag_account", category: "account",
    description: "Attach a review tag to an account for the compliance desk.",
    params: ["login", "tag"] }
];

function actionByName(name) {
  for (var i = 0; i < ACTION_CATALOG.length; i++) {
    if (ACTION_CATALOG[i].name === name) return ACTION_CATALOG[i];
  }
  return null;
}

/* Per-action extra validation rules, keyed by action name. Each returns an
 * array of error strings (empty = fine). */
var ACTION_RULES = {
  send_email: function (p) {
    var e = [];
    if (!p.to || typeof p.to !== "string") e.push("send_email: 'to' required");
    if (!p.subject || typeof p.subject !== "string") e.push("send_email: 'subject' required");
    return e;
  },
  send_sms: function (p) {
    var e = [];
    if (!p.to || typeof p.to !== "string") e.push("send_sms: 'to' required");
    return e;
  },
  post_channel_message: function (p) {
    var e = [];
    if (!p.channel || typeof p.channel !== "string") e.push("post_channel_message: 'channel' required");
    return e;
  },
  send_terminal_message: function (p) {
    var e = [];
    if (p.login === undefined || p.login === null || p.login === "") e.push("send_terminal_message: 'login' required");
    return e;
  },
  purge_old_logs: function (p) {
    return (typeof p.older_than_days === "number" && p.older_than_days >= 1)
      ? [] : ["purge_old_logs: 'older_than_days' must be a number >= 1"];
  },
  backup_database: function (p) {
    return (p.target && typeof p.target === "string") ? [] : ["backup_database: 'target' required"];
  },
  rebuild_cache: function (p) {
    var ok = ["quotes", "sessions", "specs", "all"].indexOf(p.scope) !== -1;
    return ok ? [] : ["rebuild_cache: 'scope' must be quotes|sessions|specs|all"];
  },
  set_trading_mode: function (p) {
    var ok = ["full", "close_only", "disabled"].indexOf(p.mode) !== -1;
    var e = [];
    if (!p.symbol_mask || typeof p.symbol_mask !== "string") e.push("set_trading_mode: 'symbol_mask' required");
    if (!ok) e.push("set_trading_mode: 'mode' must be full|close_only|disabled");
    return e;
  },
  set_symbol_param: function (p) {
    var e = [];
    if (!p.symbol_mask || typeof p.symbol_mask !== "string") e.push("set_symbol_param: 'symbol_mask' required");
    if (!p.param || typeof p.param !== "string") e.push("set_symbol_param: 'param' required");
    if (p.value === undefined) e.push("set_symbol_param: 'value' required");
    return e;
  },
  set_group_param: function (p) {
    var e = [];
    if (!p.group || typeof p.group !== "string") e.push("set_group_param: 'group' required");
    if (!p.param || typeof p.param !== "string") e.push("set_group_param: 'param' required");
    if (p.value === undefined) e.push("set_group_param: 'value' required");
    return e;
  },
  set_leverage_profile: function (p) {
    var e = [];
    if (!p.group || typeof p.group !== "string") e.push("set_leverage_profile: 'group' required");
    if (!p.profile_id || typeof p.profile_id !== "string") e.push("set_leverage_profile: 'profile_id' required");
    return e;
  },
  block_account: function (p) {
    return (p.login === undefined || p.login === null || p.login === "")
      ? ["block_account: 'login' required"] : [];
  },
  unblock_account: function (p) {
    return (p.login === undefined || p.login === null || p.login === "")
      ? ["unblock_account: 'login' required"] : [];
  },
  balance_operation: function (p) {
    var e = [];
    if (p.login === undefined || p.login === null || p.login === "") e.push("balance_operation: 'login' required");
    if (typeof p.amount !== "number" || !isFinite(p.amount) || p.amount === 0)
      e.push("balance_operation: 'amount' must be a non-zero number");
    if (["bonus", "charge", "correction"].indexOf(p.op_type) === -1)
      e.push("balance_operation: 'op_type' must be bonus|charge|correction");
    return e;
  },
  close_positions: function (p) {
    return (p.login === undefined || p.login === null || p.login === "")
      ? ["close_positions: 'login' required"] : [];
  },
  assign_manager: function (p) {
    var e = [];
    if (p.login === undefined || p.login === null || p.login === "") e.push("assign_manager: 'login' required");
    if (!p.manager_id || typeof p.manager_id !== "string") e.push("assign_manager: 'manager_id' required");
    return e;
  },
  flag_account: function (p) {
    var e = [];
    if (p.login === undefined || p.login === null || p.login === "") e.push("flag_account: 'login' required");
    if (!p.tag || typeof p.tag !== "string") e.push("flag_account: 'tag' required");
    return e;
  }
};

/* ================= 4. condition model =================
 * Predicate: {field, operator, value}. Group: {op: "and"|"or", rules: [...]}.
 * A missing/empty condition group always passes.
 */
function getPath(obj, path) {
  if (!path || typeof path !== "string") return undefined;
  var cur = obj;
  var parts = path.split(".");
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function isEmptyVal(v) {
  return v === undefined || v === null || v === "" ||
    (Array.isArray(v) && v.length === 0);
}

function numOrStr(v) {
  var n = Number(v);
  return isFinite(n) && (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) ? n : String(v);
}

function compareVals(a, b) {
  /* Numeric when both sides coerce cleanly, otherwise string order. */
  var na = Number(a), nb = Number(b);
  var aNum = isFinite(na) && (typeof a === "number" || (typeof a === "string" && a.trim() !== ""));
  var bNum = isFinite(nb) && (typeof b === "number" || (typeof b === "string" && b.trim() !== ""));
  if (aNum && bNum) return na < nb ? -1 : (na > nb ? 1 : 0);
  var sa = String(a), sb = String(b);
  return sa < sb ? -1 : (sa > sb ? 1 : 0);
}

function evaluatePredicate(pred, payload) {
  if (!pred || typeof pred !== "object") return false;
  var op = pred.operator;
  if (CONDITION_OPERATORS.indexOf(op) === -1)
    throw new Error("automations: unknown operator: " + op);
  var val = getPath(payload || {}, pred.field);

  switch (op) {
    case "exists": return val !== undefined;
    case "not_exists": return val === undefined;
    case "is_empty": return isEmptyVal(val);
    case "is_not_empty": return !isEmptyVal(val);
    case "eq": return val !== undefined && compareVals(val, pred.value) === 0;
    case "neq": return val === undefined || compareVals(val, pred.value) !== 0;
    case "gt": return val !== undefined && compareVals(val, pred.value) > 0;
    case "gte": return val !== undefined && compareVals(val, pred.value) >= 0;
    case "lt": return val !== undefined && compareVals(val, pred.value) < 0;
    case "lte": return val !== undefined && compareVals(val, pred.value) <= 0;
    case "in":
      if (Array.isArray(pred.value)) return pred.value.indexOf(val) !== -1;
      if (Array.isArray(val)) return val.indexOf(pred.value) !== -1;
      return false;
    case "not_in":
      if (Array.isArray(pred.value)) return pred.value.indexOf(val) === -1;
      if (Array.isArray(val)) return val.indexOf(pred.value) === -1;
      return true;
    case "contains":
      return val !== undefined && String(val).indexOf(String(pred.value)) !== -1;
    case "not_contains":
      return val === undefined || String(val).indexOf(String(pred.value)) === -1;
    case "starts_with":
      return val !== undefined && String(val).indexOf(String(pred.value)) === 0;
    case "ends_with": {
      var s = val === undefined ? null : String(val);
      var suf = String(pred.value);
      return s !== null && s.slice(s.length - suf.length) === suf;
    }
  }
  return false; /* unreachable */
}

function evaluateConditions(cond, payload) {
  /* A missing/empty condition set passes (task reacts to every trigger hit). */
  if (!cond || typeof cond !== "object") return true;
  if (Array.isArray(cond.rules)) {
    var op = cond.op === "or" ? "or" : "and"; /* default: and */
    var rules = cond.rules;
    if (rules.length === 0) return true;
    for (var i = 0; i < rules.length; i++) {
      var r = evaluateConditions(rules[i], payload);
      if (op === "or" && r) return true;
      if (op === "and" && !r) return false;
    }
    return op === "and";
  }
  /* A condition object that is neither a rule group nor a predicate
   * (e.g. {}) means "no conditions" and passes. */
  if (typeof cond.operator !== "string") return true;
  /* Single predicate. */
  return evaluatePredicate(cond, payload);
}

/* Validate a condition tree: returns error strings. */
function validateConditions(cond, path) {
  path = path || "conditions";
  if (!cond || typeof cond !== "object") return []; /* absent = pass-through */
  if (Array.isArray(cond.rules)) {
    var errs = [];
    if (cond.op !== undefined && cond.op !== "and" && cond.op !== "or")
      errs.push(path + ".op must be 'and' or 'or'");
    cond.rules.forEach(function (r, i) {
      errs = errs.concat(validateConditions(r, path + ".rules[" + i + "]"));
    });
    return errs;
  }
  var e2 = [];
  if (!cond.field || typeof cond.field !== "string") e2.push(path + ".field required");
  if (CONDITION_OPERATORS.indexOf(cond.operator) === -1)
    e2.push(path + ".operator must be one of: " + CONDITION_OPERATORS.join(","));
  var novalue = ["exists", "not_exists", "is_empty", "is_not_empty"];
  if (novalue.indexOf(cond.operator) === -1 && cond.value === undefined)
    e2.push(path + ".value required for operator '" + cond.operator + "'");
  if ((cond.operator === "in" || cond.operator === "not_in") &&
      !Array.isArray(cond.value) && typeof cond.value !== "string" && typeof cond.value !== "number")
    e2.push(path + ".value for 'in'/'not_in' should be an array or a scalar");
  return e2;
}

/* ================= 5. action validation & planning ================= */

/* Resolve {dotted.path} macros in param strings against the payload.
 * Unknown paths resolve to "" (empty string), never throw. */
function resolveMacros(params, payload) {
  if (typeof params === "string") {
    return params.replace(/\{([a-zA-Z0-9_.]+)\}/g, function (m, path) {
      var v = getPath(payload || {}, path);
      return v === undefined || v === null ? "" : String(v);
    });
  }
  if (Array.isArray(params)) {
    return params.map(function (p) { return resolveMacros(p, payload); });
  }
  if (params && typeof params === "object") {
    var out = {};
    for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k)) out[k] = resolveMacros(params[k], payload);
    }
    return out;
  }
  return params;
}

function validateAction(action) {
  var errs = [];
  if (!action || typeof action !== "object" || Array.isArray(action))
    return ["action must be an object"];
  var def = actionByName(action.action);
  if (!def) return ["unknown action: " + action.action];
  var params = action.params && typeof action.params === "object" ? action.params : {};
  def.params.forEach(function (p) {
    if (params[p] === undefined) errs.push(action.action + ": param '" + p + "' required");
  });
  var rule = ACTION_RULES[action.action];
  if (rule) errs = errs.concat(rule(params));
  return errs;
}

/* Plan an action against an event payload: validate, resolve macros,
 * and return the op descriptor the executor will apply. Throws on
 * invalid actions so executeTask can report them as failures. */
function planAction(action, payload, taskId) {
  var errs = validateAction(action);
  if (errs.length) throw new Error("automations: invalid action: " + errs.join("; "));
  return {
    action: action.action,
    params: resolveMacros(action.params || {}, payload || {}),
    task_id: taskId === undefined ? null : taskId,
    planned: true
  };
}

/* ================= 6. task config model =================
 * Task: {id, name, enabled, trigger: {name, params}, conditions?,
 *        actions: [...], run_as, dry_run, max_actions?}
 */
function makeTask(cfg) {
  cfg = cfg || {};
  return {
    id: cfg.id === undefined ? null : cfg.id,
    name: cfg.name || "",
    enabled: cfg.enabled === undefined ? true : !!cfg.enabled,
    trigger: {
      name: cfg.trigger && cfg.trigger.name ? cfg.trigger.name : "",
      params: (cfg.trigger && cfg.trigger.params && typeof cfg.trigger.params === "object")
        ? cfg.trigger.params : {}
    },
    conditions: cfg.conditions === undefined ? null : cfg.conditions,
    actions: Array.isArray(cfg.actions) ? cfg.actions : [],
    run_as: cfg.run_as || "system",
    dry_run: !!cfg.dry_run,
    max_actions: cfg.max_actions === undefined ? null : cfg.max_actions
  };
}

function effectiveMaxActions(task) {
  if (task.max_actions === null || task.max_actions === undefined) return MAX_ACTIONS_PER_RUN;
  return Math.min(task.max_actions, MAX_ACTIONS_PER_RUN);
}

/* Param names fully covered (presence included) by validateScheduleParams,
 * so the generic "param required" check skips them to avoid double errors. */
function scheduleCheckedParams(name) {
  if (name === "schedule.interval") return ["interval_seconds"];
  if (name === "schedule.daily") return ["time", "days_of_week"];
  if (name === "schedule.once") return ["at"];
  if (name === "schedule.cron") return ["expression"];
  if (name === "event.balance_low") return ["threshold"];
  return [];
}

function validateScheduleParams(name, params, errs) {
  if (name === "schedule.interval") {
    if (typeof params.interval_seconds !== "number" || Math.floor(params.interval_seconds) !== params.interval_seconds ||
        params.interval_seconds < 60)
      errs.push("trigger schedule.interval: 'interval_seconds' must be an integer >= 60");
  } else if (name === "schedule.daily") {
    if (typeof params.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(params.time))
      errs.push("trigger schedule.daily: 'time' must be HH:MM (24h)");
    if (params.days_of_week !== undefined) {
      if (!Array.isArray(params.days_of_week) ||
          params.days_of_week.some(function (d) { return [0,1,2,3,4,5,6].indexOf(d) === -1; }))
        errs.push("trigger schedule.daily: 'days_of_week' must be an array of 0..6 (0=Sunday)");
    }
  } else if (name === "schedule.once") {
    var at = params.at;
    var ok = typeof at === "number" && isFinite(at) && at > 0;
    if (!ok && typeof at === "string") ok = !isNaN(Date.parse(at));
    if (!ok) errs.push("trigger schedule.once: 'at' must be epoch seconds or an ISO date string");
  } else if (name === "schedule.cron") {
    try { parseCron(String(params.expression)); }
    catch (e) { errs.push("trigger schedule.cron: " + e.message); }
  } else if (name === "event.balance_low") {
    if (typeof params.threshold !== "number" || !isFinite(params.threshold) || params.threshold < 0)
      errs.push("trigger event.balance_low: 'threshold' must be a number >= 0");
  }
}

function validateTask(task) {
  var errs = [];
  if (!task || typeof task !== "object") return ["task must be an object"];
  if (!task.name || typeof task.name !== "string") errs.push("task.name required");
  if (RUN_AS_SCOPES.indexOf(task.run_as) === -1)
    errs.push("task.run_as must be one of: " + RUN_AS_SCOPES.join(","));
  var trig = task.trigger || {};
  var def = triggerByName(trig.name);
  if (!def) {
    errs.push("unknown trigger: " + trig.name);
  } else {
    var params = (trig.params && typeof trig.params === "object") ? trig.params : {};
    var optional = def.optional || [];
    var dedicated = scheduleCheckedParams(trig.name);
    def.params.forEach(function (p) {
      if (dedicated.indexOf(p) !== -1) return; /* covered by validateScheduleParams */
      if (params[p] === undefined && optional.indexOf(p) === -1)
        errs.push("trigger " + trig.name + ": param '" + p + "' required");
    });
    validateScheduleParams(trig.name, params, errs);
  }
  errs = errs.concat(validateConditions(task.conditions));
  if (!Array.isArray(task.actions) || task.actions.length === 0) {
    errs.push("task.actions must be a non-empty array");
  } else {
    task.actions.forEach(function (a, i) {
      validateAction(a).forEach(function (e) { errs.push("actions[" + i + "]: " + e); });
    });
  }
  if (task.max_actions !== null && task.max_actions !== undefined) {
    if (typeof task.max_actions !== "number" || Math.floor(task.max_actions) !== task.max_actions ||
        task.max_actions < 1)
      errs.push("task.max_actions must be a positive integer");
    else if (task.max_actions > MAX_ACTIONS_PER_RUN)
      errs.push("task.max_actions (" + task.max_actions + ") exceeds platform ceiling " + MAX_ACTIONS_PER_RUN);
  }
  if (Array.isArray(task.actions) && task.actions.length > effectiveMaxActions(makeTask(task)))
    errs.push("task has " + task.actions.length + " actions, exceeding the per-run cap of " +
      effectiveMaxActions(makeTask(task)));
  return errs;
}

/* ================= 7. cron =================
 * Minimal 5-field cron: minute hour day-of-month month day-of-week.
 * Fields support "*", "*\/n", "a", "a,b", "a-b". Day-of-week accepts 0-7
 * (7 = Sunday). Semantics: (dom OR dow) when both are restricted, matching
 * common cron behaviour; a "*" field never restricts.
 */
function parseCronField(field, lo, hi, label) {
  var allowed = {};
  function add(v) {
    if (v < lo || v > hi) throw new Error("cron: " + label + " value out of range: " + v);
    allowed[v] = true;
  }
  var parts = String(field).split(",");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    var step = 1;
    var range = p;
    var slash = p.indexOf("/");
    if (slash !== -1) {
      range = p.slice(0, slash);
      step = parseInt(p.slice(slash + 1), 10);
      if (!(step >= 1)) throw new Error("cron: bad step in " + label + ": " + p);
    }
    var start, end;
    if (range === "*" || range === "") { start = lo; end = hi; }
    else {
      var dash = range.indexOf("-");
      if (dash === -1) { start = end = parseInt(range, 10); }
      else { start = parseInt(range.slice(0, dash), 10); end = parseInt(range.slice(dash + 1), 10); }
      if (isNaN(start) || isNaN(end)) throw new Error("cron: bad " + label + " token: " + p);
      if (start > end) throw new Error("cron: reversed range in " + label + ": " + p);
    }
    for (var v = start; v <= end; v += step) add(v);
  }
  return allowed;
}

function parseCron(expr) {
  var fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron: expression must have 5 fields, got " + fields.length);
  var cron = {
    minute: parseCronField(fields[0], 0, 59, "minute"),
    hour: parseCronField(fields[1], 0, 23, "hour"),
    dom: parseCronField(fields[2], 1, 31, "day-of-month"),
    month: parseCronField(fields[3], 1, 12, "month"),
    dowRaw: fields[4]
  };
  /* day-of-week: 7 is an alias for Sunday (0). */
  cron.dow = parseCronField(fields[4].replace(/\b7\b/g, "0"), 0, 6, "day-of-week");
  cron.domIsStar = /^\*$/.test(fields[2]);
  cron.dowIsStar = /^\*$/.test(fields[4]);
  return cron;
}

function cronMatches(cron, d /* Date, UTC */) {
  if (!cron.minute[d.getUTCMinutes()]) return false;
  if (!cron.hour[d.getUTCHours()]) return false;
  if (!cron.month[d.getUTCMonth() + 1]) return false;
  var domHit = !!cron.dom[d.getUTCDate()];
  var dowHit = !!cron.dow[d.getUTCDay()];
  var dayHit;
  if (cron.domIsStar && cron.dowIsStar) dayHit = true;
  else if (cron.domIsStar) dayHit = dowHit;
  else if (cron.dowIsStar) dayHit = domHit;
  else dayHit = domHit || dowHit;
  return dayHit;
}

/* Next fire time (epoch seconds, exclusive of fromSec) for a schedule
 * trigger. Returns null for event triggers or unparseable schedules.
 * daily/cron evaluate in UTC (server time). */
function nextScheduleTime(trigger, fromSec) {
  if (!trigger || !trigger.name) return null;
  var from = (typeof fromSec === "number" && isFinite(fromSec)) ? Math.floor(fromSec) : Math.floor(Date.now() / 1000);
  var params = trigger.params || {};
  var d, t, days, hh, mm, cand;

  if (trigger.name === "schedule.interval") {
    var iv = params.interval_seconds;
    if (typeof iv !== "number" || iv < 1) return null;
    return (Math.floor(from / iv) + 1) * iv;
  }
  if (trigger.name === "schedule.once") {
    var at = params.at;
    t = typeof at === "number" ? Math.floor(at) : Math.floor(Date.parse(at) / 1000);
    return (isFinite(t) && t > from) ? t : null;
  }
  if (trigger.name === "schedule.daily") {
    if (typeof params.time !== "string") return null;
    var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(params.time);
    if (!m) return null;
    hh = +m[1]; mm = +m[2];
    days = Array.isArray(params.days_of_week) ? params.days_of_week : [0,1,2,3,4,5,6];
    d = new Date(from * 1000);
    for (var i = 0; i < 8; i++) {
      cand = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, 0));
      var cs = Math.floor(cand.getTime() / 1000);
      if (cs > from && days.indexOf(cand.getUTCDay()) !== -1) return cs;
      d = new Date(d.getTime() + 24 * 3600 * 1000);
    }
    return null;
  }
  if (trigger.name === "schedule.cron") {
    var cron;
    try { cron = parseCron(String(params.expression)); } catch (e) { return null; }
    var cursor = new Date((Math.floor(from / 60) + 1) * 60 * 1000); /* next whole minute, strictly after `from` */
    for (var n = 0; n < MAX_CRON_LOOKAHEAD_MIN; n++) {
      if (cronMatches(cron, cursor)) return Math.floor(cursor.getTime() / 1000);
      cursor = new Date(cursor.getTime() + 60000);
    }
    return null;
  }
  return null;
}

/* ================= 8. task execution =================
 * executeTask(task, payload, opts):
 *   payload: the event payload (for event triggers) or {} (for schedules).
 *   opts: {event_name, now (epoch sec), dry_run (override task flag)}.
 * Returns {executed, reason?, dry_run, ops: [...], stats_delta}.
 * `stats_delta` is 'success' | 'failure' | null so the caller can feed
 * recordRun(). The module never mutates the task or its stats.
 */
function executeTask(task, payload, opts) {
  opts = opts || {};
  var t = makeTask(task);
  var errs = validateTask(t);
  if (errs.length) {
    return { executed: false, reason: "invalid_task", errors: errs, dry_run: false, ops: [], stats_delta: "failure" };
  }
  if (!t.enabled) {
    return { executed: false, reason: "disabled", dry_run: false, ops: [], stats_delta: null };
  }
  var def = triggerByName(t.trigger.name);
  if (def.kind === "event") {
    var ev = opts.event_name || "";
    if (ev !== t.trigger.name) {
      return { executed: false, reason: "trigger_mismatch", dry_run: false, ops: [], stats_delta: null };
    }
  }
  if (!evaluateConditions(t.conditions, payload || {})) {
    return { executed: false, reason: "conditions_not_met", dry_run: false, ops: [], stats_delta: null };
  }
  var dry = opts.dry_run !== undefined ? !!opts.dry_run : t.dry_run;
  var cap = effectiveMaxActions(t);
  var ops = [];
  for (var i = 0; i < t.actions.length && i < cap; i++) {
    try {
      ops.push(planAction(t.actions[i], payload, t.id));
    } catch (e) {
      return { executed: false, reason: "action_plan_failed", errors: [e.message],
               dry_run: false, ops: [], stats_delta: "failure" };
    }
  }
  return {
    executed: true,
    reason: dry ? "dry_run" : "ok",
    dry_run: dry,
    ops: ops,
    stats_delta: dry ? null : "success"   /* dry runs don't count as runs */
  };
}

/* ================= 9. execution statistics ================= */
function statsEmpty() {
  return { runs: 0, successes: 0, failures: 0, last_run_at: null, last_status: null };
}

/* Returns a NEW stats object; the input is not mutated. */
function recordRun(stats, outcome, stampSec) {
  var s = stats && typeof stats === "object" ? stats : statsEmpty();
  var now = (typeof stampSec === "number" && isFinite(stampSec))
    ? Math.floor(stampSec) : Math.floor(Date.now() / 1000);
  var ok = outcome === "success";
  return {
    runs: (s.runs || 0) + 1,
    successes: (s.successes || 0) + (ok ? 1 : 0),
    failures: (s.failures || 0) + (ok ? 0 : 1),
    last_run_at: now,
    last_status: ok ? "success" : "failure"
  };
}

/* ================= 10. manager automation profiles =================
 * Dealing-desk automation: per-request-type auto-processing rules. A client
 * request (order execution, pending placement, deposit/withdrawal, account
 * creation, ...) is processed automatically only when:
 *   1. the profile is enabled and carries a rule for the request type,
 *   2. the rule's autoProcess flag is on,
 *   3. the requested volume does not exceed the rule's maxVolume, and
 *   4. the request's symbol is allowed by the rule's allowedSymbols.
 * Otherwise the request is routed to a manager with a machine-readable
 * reason code. Auto-processed requests are watched against the rule's
 * answerTimeoutSec (20-180 s): a request still unanswered past its deadline
 * is escalated back to manual handling.
 *
 * Conventions (same as the rest of this module):
 *   - All timestamps are epoch seconds, UTC (server time).
 *   - Volume is in lots for trading requests, currency units for
 *     deposit/withdrawal amounts. A rule without maxVolume imposes no
 *     volume limit; a request without a volume is never volume-gated.
 *   - allowedSymbols is optional: exact symbols or "*" masks; a "!"
 *     prefix excludes a match. Absent/empty means "all symbols allowed".
 *   - decideRequest() is pure: it never mutates its inputs and always
 *     returns an audit entry; the caller appends it to the shared audit
 *     log with appendAuditEntry().
 */

var REQUEST_TYPES = [
  { name: "order_execute", description: "Market order execution request." },
  { name: "order_pending", description: "Pending order placement request." },
  { name: "position_modify", description: "Modify SL/TP of an open position." },
  { name: "position_close", description: "Close an open position." },
  { name: "deposit", description: "Deposit balance-operation request." },
  { name: "withdrawal", description: "Withdrawal balance-operation request." },
  { name: "account_create", description: "New account request (demo/preliminary/live)." },
  { name: "balance_op", description: "Bonus/charge/correction balance-operation request." }
];

var ANSWER_TIMEOUT_MIN_SEC = 20;
var ANSWER_TIMEOUT_MAX_SEC = 180;

/* Stable decision reason codes; audit logs and server UIs key on these. */
var DECISION_REASONS = {
  PROFILE_DISABLED: "profile_disabled",
  UNKNOWN_TYPE: "unknown_type",
  TYPE_NOT_CONFIGURED: "type_not_configured",
  AUTO_DISABLED: "auto_disabled",
  VOLUME_EXCEEDED: "volume_exceeded",
  SYMBOL_NOT_ALLOWED: "symbol_not_allowed",
  AUTO_APPROVED: "auto_approved",
  TIMEOUT: "timeout",
  AWAITING_ANSWER: "awaiting_answer"
};

function requestTypeByName(name) {
  for (var i = 0; i < REQUEST_TYPES.length; i++) {
    if (REQUEST_TYPES[i].name === name) return REQUEST_TYPES[i];
  }
  return null;
}

/* Profile: {id, name, enabled, rules: {type: {autoProcess, maxVolume,
 * answerTimeoutSec, allowedSymbols?}}} */
function makeAutomationProfile(cfg) {
  cfg = cfg || {};
  var rules = {};
  var src = (cfg.rules && typeof cfg.rules === "object") ? cfg.rules : {};
  for (var k in src) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      var s = src[k] || {};
      rules[k] = {
        autoProcess: !!s.autoProcess,
        maxVolume: (typeof s.maxVolume === "number") ? s.maxVolume : null,
        answerTimeoutSec: (typeof s.answerTimeoutSec === "number") ? s.answerTimeoutSec : null,
        allowedSymbols: Array.isArray(s.allowedSymbols) ? s.allowedSymbols.slice() : null
      };
    }
  }
  return {
    id: cfg.id === undefined ? null : cfg.id,
    name: cfg.name || "",
    enabled: cfg.enabled === undefined ? true : !!cfg.enabled,
    rules: rules
  };
}

function validateAutomationProfile(profile) {
  var errs = [];
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    return ["automation profile must be an object"];
  if (!profile.name || typeof profile.name !== "string")
    errs.push("automation profile.name required");
  var rules = (profile.rules && typeof profile.rules === "object") ? profile.rules : {};
  for (var type in rules) {
    if (!Object.prototype.hasOwnProperty.call(rules, type)) continue;
    if (requestTypeByName(type) === null) { errs.push("unknown request type: " + type); continue; }
    var r = rules[type] || {};
    if (typeof r.autoProcess !== "boolean")
      errs.push(type + ": 'autoProcess' must be a boolean");
    if (r.answerTimeoutSec === null || r.answerTimeoutSec === undefined) {
      errs.push(type + ": 'answerTimeoutSec' required");
    } else if (typeof r.answerTimeoutSec !== "number" ||
               Math.floor(r.answerTimeoutSec) !== r.answerTimeoutSec ||
               r.answerTimeoutSec < ANSWER_TIMEOUT_MIN_SEC ||
               r.answerTimeoutSec > ANSWER_TIMEOUT_MAX_SEC) {
      errs.push(type + ": 'answerTimeoutSec' must be an integer between " +
        ANSWER_TIMEOUT_MIN_SEC + " and " + ANSWER_TIMEOUT_MAX_SEC);
    }
    if (r.maxVolume !== null && r.maxVolume !== undefined &&
        (typeof r.maxVolume !== "number" || !isFinite(r.maxVolume) || r.maxVolume < 0))
      errs.push(type + ": 'maxVolume' must be a number >= 0");
    if (r.allowedSymbols !== null && r.allowedSymbols !== undefined) {
      if (!Array.isArray(r.allowedSymbols)) {
        errs.push(type + ": 'allowedSymbols' must be an array of symbols/masks");
      } else {
        r.allowedSymbols.forEach(function (sym) {
          if (typeof sym !== "string" || sym === "")
            errs.push(type + ": 'allowedSymbols' entries must be non-empty strings");
        });
      }
    }
  }
  return errs;
}

/* Mask matching: "*" matches anything; "!" prefix excludes a match.
 * Same mask semantics as group symbol lists. */
function maskToRegExp(mask) {
  var escaped = String(mask).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function symbolAllowed(symbol, allowedSymbols) {
  if (!Array.isArray(allowedSymbols) || allowedSymbols.length === 0) return true;
  var included = false, excluded = false;
  for (var i = 0; i < allowedSymbols.length; i++) {
    var pat = allowedSymbols[i];
    if (typeof pat !== "string" || pat === "") continue;
    var neg = pat.charAt(0) === "!";
    if (maskToRegExp(neg ? pat.slice(1) : pat).test(symbol)) {
      if (neg) excluded = true; else included = true;
    }
  }
  return included && !excluded;
}

/* Decide how a request is handled. Request: {id, type, volume?, symbol?}.
 * Returns {action: "auto"|"manual", reason, auditEntry}. Never mutates
 * inputs; the caller appends auditEntry to the audit log. */
function decideRequest(request, profile, nowSec) {
  var req = (request && typeof request === "object") ? request : {};
  var prof = (profile && typeof profile === "object" && !Array.isArray(profile)) ? profile : null;
  var now = (typeof nowSec === "number" && isFinite(nowSec))
    ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  var entry = {
    requestId: req.id === undefined ? null : req.id,
    profile: prof && prof.id !== undefined && prof.id !== null ? prof.id : null,
    action: "manual",
    reason: DECISION_REASONS.PROFILE_DISABLED,
    at: now
  };
  function result(action, reason) {
    entry.action = action;
    entry.reason = reason;
    return { action: action, reason: reason, auditEntry: entry };
  }
  if (!prof || prof.enabled === false) return result("manual", DECISION_REASONS.PROFILE_DISABLED);
  if (requestTypeByName(req.type) === null) return result("manual", DECISION_REASONS.UNKNOWN_TYPE);
  var rules = (prof.rules && typeof prof.rules === "object") ? prof.rules : {};
  var rule = Object.prototype.hasOwnProperty.call(rules, req.type) ? rules[req.type] : null;
  if (!rule) return result("manual", DECISION_REASONS.TYPE_NOT_CONFIGURED);
  if (!rule.autoProcess) return result("manual", DECISION_REASONS.AUTO_DISABLED);
  if (typeof req.volume === "number" && isFinite(req.volume) &&
      typeof rule.maxVolume === "number" && isFinite(rule.maxVolume) &&
      req.volume > rule.maxVolume)
    return result("manual", DECISION_REASONS.VOLUME_EXCEEDED);
  if (req.symbol !== undefined && req.symbol !== null && req.symbol !== "" &&
      !symbolAllowed(String(req.symbol), rule.allowedSymbols))
    return result("manual", DECISION_REASONS.SYMBOL_NOT_ALLOWED);
  return result("auto", DECISION_REASONS.AUTO_APPROVED);
}

/* Escalation check for a request already in auto-processing.
 * pending: {requestId, type, startedAt}. Pure: computes from timestamps
 * only. Returns {timedOut, action, reason, elapsedSec, auditEntry}. */
function checkAutoTimeout(pending, profile, nowSec) {
  var p = (pending && typeof pending === "object") ? pending : {};
  var now = (typeof nowSec === "number" && isFinite(nowSec))
    ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  var started = (typeof p.startedAt === "number" && isFinite(p.startedAt))
    ? Math.floor(p.startedAt) : null;
  var profId = (profile && typeof profile === "object" && !Array.isArray(profile) &&
    profile.id !== undefined && profile.id !== null) ? profile.id : null;
  var entry = {
    requestId: p.requestId === undefined ? null : p.requestId,
    profile: profId,
    action: "manual",
    reason: DECISION_REASONS.TIMEOUT,
    at: now
  };
  function out(timedOut, action, reason, elapsed) {
    entry.action = action;
    entry.reason = reason;
    return { timedOut: timedOut, action: action, reason: reason,
             elapsedSec: elapsed, auditEntry: entry };
  }
  var rules = (profile && profile.rules && typeof profile.rules === "object") ? profile.rules : {};
  var rule = (p.type !== undefined && Object.prototype.hasOwnProperty.call(rules, p.type))
    ? rules[p.type] : null;
  if (!rule || typeof rule.answerTimeoutSec !== "number") {
    return out(true, "manual", DECISION_REASONS.TYPE_NOT_CONFIGURED,
      started === null ? null : now - started);
  }
  var elapsed = started === null ? 0 : now - started;
  if (elapsed > rule.answerTimeoutSec)
    return out(true, "manual", DECISION_REASONS.TIMEOUT, elapsed);
  return out(false, "auto", DECISION_REASONS.AWAITING_ANSWER, elapsed);
}

/* Audit log: plain array of {requestId, profile, action, reason, at}.
 * appendAuditEntry returns a NEW array (input untouched). */
function appendAuditEntry(log, entry) {
  var arr = Array.isArray(log) ? log.slice() : [];
  if (entry && typeof entry === "object") arr.push(entry);
  return arr;
}

/* Query the audit log. Filters: {requestId, profile, action, reason,
 * from (epoch sec, inclusive), to (epoch sec, inclusive)}. */
function queryAuditLog(log, filters) {
  var f = (filters && typeof filters === "object") ? filters : {};
  var arr = Array.isArray(log) ? log : [];
  return arr.filter(function (e) {
    if (!e || typeof e !== "object") return false;
    if (f.requestId !== undefined && f.requestId !== null && e.requestId !== f.requestId) return false;
    if (f.profile !== undefined && f.profile !== null && e.profile !== f.profile) return false;
    if (f.action !== undefined && e.action !== f.action) return false;
    if (f.reason !== undefined && e.reason !== f.reason) return false;
    if (f.from !== undefined && (typeof e.at !== "number" || e.at < f.from)) return false;
    if (f.to !== undefined && (typeof e.at !== "number" || e.at > f.to)) return false;
    return true;
  });
}

var AUTOMATIONS = {
  MAX_ACTIONS_PER_RUN: MAX_ACTIONS_PER_RUN,
  RUN_AS_SCOPES: RUN_AS_SCOPES,
  CONDITION_OPERATORS: CONDITION_OPERATORS,
  TRIGGER_CATALOG: TRIGGER_CATALOG,
  ACTION_CATALOG: ACTION_CATALOG,
  triggerByName: triggerByName,
  actionByName: actionByName,
  evaluatePredicate: evaluatePredicate,
  evaluateConditions: evaluateConditions,
  validateConditions: validateConditions,
  validateAction: validateAction,
  planAction: planAction,
  resolveMacros: resolveMacros,
  makeTask: makeTask,
  validateTask: validateTask,
  effectiveMaxActions: effectiveMaxActions,
  parseCron: parseCron,
  cronMatches: cronMatches,
  nextScheduleTime: nextScheduleTime,
  executeTask: executeTask,
  statsEmpty: statsEmpty,
  recordRun: recordRun,
  REQUEST_TYPES: REQUEST_TYPES,
  requestTypeByName: requestTypeByName,
  DECISION_REASONS: DECISION_REASONS,
  ANSWER_TIMEOUT_MIN_SEC: ANSWER_TIMEOUT_MIN_SEC,
  ANSWER_TIMEOUT_MAX_SEC: ANSWER_TIMEOUT_MAX_SEC,
  makeAutomationProfile: makeAutomationProfile,
  validateAutomationProfile: validateAutomationProfile,
  symbolAllowed: symbolAllowed,
  decideRequest: decideRequest,
  checkAutoTimeout: checkAutoTimeout,
  appendAuditEntry: appendAuditEntry,
  queryAuditLog: queryAuditLog
};
if (typeof module !== "undefined" && module.exports) { module.exports = AUTOMATIONS; }
else { root.OrbitAutomations = AUTOMATIONS; }
})(typeof globalThis !== "undefined" ? globalThis : this);
