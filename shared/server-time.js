/* shared/server-time.js — OrbitTrader: server time, DST, NTP and working-hours model.
 *
 * Pure functions, no globals, no DOM, no Date.now() inside the logic: every
 * function that depends on "now" takes it as a parameter (epoch ms) so
 * behaviour is fully deterministic and testable.
 *
 * Covers, in OrbitTrader's own terms:
 *   1. server timezone configuration (IANA timezone id, validated);
 *   2. DST correction rules (follow the IANA database, or pin a fixed offset);
 *   3. NTP synchronisation config (server list, sync interval, drift
 *      tolerances, drift classification, next-sync scheduling);
 *   4. monotonic millisecond sequencing for order numbering (strictly
 *      increasing integers that embed the epoch millisecond plus a
 *      per-millisecond counter, safe under clock skew and same-ms bursts);
 *   5. working-hours calendar: per-weekday wall-clock windows (in server
 *      time) during which maintenance / optimisation background jobs are
 *      allowed to run.
 *
 * Usage (node):    const ST = require("./shared/server-time.js");
 * Usage (browser): include via <script src="shared/server-time.js"></script>,
 *                  then use window.OrbitServerTime.
 */
(function (root) {
"use strict";

/* --------------------------------------------------------------------------
 * Time-zone helpers.
 *
 * A server timezone is an IANA timezone id such as "UTC", "Europe/London"
 * or "Asia/Dubai". Validation checks the shape of the id and asks the
 * platform's Intl implementation to accept it; if Intl is unavailable the
 * shape check alone is used.
 * -------------------------------------------------------------------------- */
var TZ_ID_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-.]+)+$|^(UTC|Etc\/UTC)$/;

/* Module-level Intl formatter cache keyed by "tz|pattern". Formatters are
 * pure functions of their inputs, so caching them changes nothing
 * observable; it just avoids rebuilding them thousands of times in scans. */
var _fmtCache = {};
function _offsetFmt(tz) {
  var key = tz + "|offset";
  if (!_fmtCache[key]) {
    _fmtCache[key] = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }
  return _fmtCache[key];
}
function _wallFmt(tz) {
  var key = tz + "|wall";
  if (!_fmtCache[key]) {
    _fmtCache[key] = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour12: false,
      weekday: "short", hour: "2-digit", minute: "2-digit"
    });
  }
  return _fmtCache[key];
}

function validateTimezone(id) {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("server_timezone must be a non-empty string");
  }
  if (!TZ_ID_RE.test(id)) {
    throw new Error("server_timezone is not shaped like an IANA id: " + id);
  }
  if (typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: id });
    } catch (e) {
      throw new Error("server_timezone not recognised by the platform: " + id);
    }
  }
  return true;
}

/* Return the UTC offset in whole seconds that `tz` observes at `epochMs`.
 * Implemented on Intl.DateTimeFormat parts so it tracks DST transitions. */
function utcOffsetSeconds(tz, epochMs) {
  validateTimezone(tz);
  if (!isFiniteNumber(epochMs)) throw new Error("epochMs must be a number");
  var dtf = _offsetFmt(tz);
  var parts = dtf.formatToParts(new Date(epochMs));
  var p = {};
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type !== "literal") p[parts[i].type] = parts[i].value;
  }
  /* "24" hour can appear at midnight boundaries with hour12:false. */
  var hour = parseInt(p.hour, 10) % 24;
  var asUtc = Date.UTC(
    parseInt(p.year, 10), parseInt(p.month, 10) - 1, parseInt(p.day, 10),
    hour, parseInt(p.minute, 10), parseInt(p.second, 10)
  );
  return Math.round((asUtc - epochMs) / 1000);
}

/* Wall-clock decomposition of `epochMs` in the server timezone:
 * { weekday: "mon"|...|"sun", hhmm: "HH:MM", offset_seconds }. */
function serverWallTime(tz, epochMs) {
  validateTimezone(tz);
  if (!isFiniteNumber(epochMs)) throw new Error("epochMs must be a number");
  var dtf = _wallFmt(tz);
  var parts = dtf.formatToParts(new Date(epochMs));
  var p = {};
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type !== "literal") p[parts[i].type] = parts[i].value;
  }
  var dayMap = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };
  return {
    weekday: dayMap[p.weekday] || "mon",
    hhmm: (p.hour === "24" ? "00" : p.hour) + ":" + p.minute,
    offset_seconds: utcOffsetSeconds(tz, epochMs)
  };
}

/* --------------------------------------------------------------------------
 * DST correction rules.
 *
 * dst: {
 *   mode: "iana" | "fixed",
 *   auto_correct: boolean,          // shift wall-clock-scheduled jobs across transitions
 *   fixed_offset_seconds: int|null  // required when mode === "fixed"
 * }
 * In "iana" mode the effective offset comes from the timezone database and
 * transitions are expected; in "fixed" mode the offset never changes.
 * -------------------------------------------------------------------------- */
var DST_MODES = ["iana", "fixed"];

function defaultDstConfig() {
  return { mode: "iana", auto_correct: true, fixed_offset_seconds: null };
}

function validateDstConfig(dst) {
  if (!dst || typeof dst !== "object") throw new Error("dst must be an object");
  if (DST_MODES.indexOf(dst.mode) === -1) {
    throw new Error("dst.mode must be one of: " + DST_MODES.join(", "));
  }
  if (typeof dst.auto_correct !== "boolean") {
    throw new Error("dst.auto_correct must be a boolean");
  }
  if (dst.mode === "fixed") {
    if (!isFiniteNumber(dst.fixed_offset_seconds) ||
        Math.round(dst.fixed_offset_seconds) !== dst.fixed_offset_seconds ||
        Math.abs(dst.fixed_offset_seconds) > 14 * 3600) {
      throw new Error("dst.fixed_offset_seconds must be whole seconds within ±14h");
    }
  } else if (dst.fixed_offset_seconds !== null && dst.fixed_offset_seconds !== undefined) {
    throw new Error("dst.fixed_offset_seconds must be null when mode is \"iana\"");
  }
  return true;
}

/* Effective UTC offset (seconds) applied by the server at `epochMs`. */
function effectiveOffsetSeconds(cfg, epochMs) {
  validateTimeConfig(cfg);
  if (cfg.dst.mode === "fixed") return cfg.dst.fixed_offset_seconds;
  return utcOffsetSeconds(cfg.server_timezone, epochMs);
}

/* Scan [fromMs, toMs] for instants where the zone offset changes (DST
 * transitions). Returns [{ at_ms, offset_before_seconds, offset_after_seconds }]
 * with at_ms refined to minute precision. Bounded to 400 days of range. */
function findTransitions(tz, fromMs, toMs) {
  validateTimezone(tz);
  if (!isFiniteNumber(fromMs) || !isFiniteNumber(toMs)) {
    throw new Error("fromMs/toMs must be numbers");
  }
  if (toMs <= fromMs) throw new Error("toMs must be after fromMs");
  if (toMs - fromMs > 400 * 86400000) throw new Error("range limited to 400 days");
  var step = 6 * 3600000;
  var out = [];
  var prevMs = fromMs;
  var prevOff = utcOffsetSeconds(tz, fromMs);
  for (var t = fromMs + step; t <= toMs; t += step) {
    var off = utcOffsetSeconds(tz, t);
    if (off !== prevOff) {
      out.push({
        at_ms: refineTransition(tz, prevMs, t, prevOff, off),
        offset_before_seconds: prevOff,
        offset_after_seconds: off
      });
      prevOff = off;
    }
    prevMs = t;
  }
  return out;
}

function refineTransition(tz, loMs, hiMs, loOff, hiOff) {
  /* Binary search on offset sign; the offset is a step function. */
  while (hiMs - loMs > 60000) {
    var mid = Math.floor((loMs + hiMs) / 2);
    if (utcOffsetSeconds(tz, mid) === loOff) loMs = mid; else hiMs = mid;
  }
  void hiOff;
  return hiMs;
}

/* --------------------------------------------------------------------------
 * NTP synchronisation config.
 *
 * ntp: {
 *   enabled: boolean,
 *   servers: [hostname, ...],   // queried in order, first answer wins
 *   interval_sec: 600,          // re-sync cadence (default: every 10 minutes)
 *   warn_drift_ms: 100,         // drift at/above this logs a warning
 *   max_drift_ms: 500           // drift above this raises an alarm / blocks
 * }
 * -------------------------------------------------------------------------- */
function defaultNtpConfig() {
  return {
    enabled: true,
    /* Sample public pool servers — replace with the broker's own NTP
     * infrastructure in production. */
    servers: ["0.pool.ntp.org", "1.pool.ntp.org", "2.pool.ntp.org"],
    interval_sec: 600,
    warn_drift_ms: 100,
    max_drift_ms: 500
  };
}

function isFiniteNumber(v) {
  return typeof v === "number" && isFinite(v);
}

function validateNtpConfig(ntp) {
  if (!ntp || typeof ntp !== "object") throw new Error("ntp must be an object");
  if (typeof ntp.enabled !== "boolean") throw new Error("ntp.enabled must be a boolean");
  if (!Array.isArray(ntp.servers) || ntp.servers.length === 0) {
    throw new Error("ntp.servers must be a non-empty array of hostnames");
  }
  for (var i = 0; i < ntp.servers.length; i++) {
    if (typeof ntp.servers[i] !== "string" || ntp.servers[i].length === 0) {
      throw new Error("ntp.servers[" + i + "] must be a non-empty hostname");
    }
  }
  if (!isFiniteNumber(ntp.interval_sec) || ntp.interval_sec < 10 || ntp.interval_sec > 86400) {
    throw new Error("ntp.interval_sec must be between 10 and 86400 seconds");
  }
  if (!isFiniteNumber(ntp.warn_drift_ms) || ntp.warn_drift_ms <= 0) {
    throw new Error("ntp.warn_drift_ms must be a positive number of ms");
  }
  if (!isFiniteNumber(ntp.max_drift_ms) || ntp.max_drift_ms <= ntp.warn_drift_ms) {
    throw new Error("ntp.max_drift_ms must be greater than ntp.warn_drift_ms");
  }
  return true;
}

/* Classify a measured clock drift: "ok" | "warn" | "exceeded". */
function classifyDrift(ntp, driftMs) {
  validateNtpConfig(ntp);
  if (!isFiniteNumber(driftMs)) throw new Error("driftMs must be a number");
  var d = Math.abs(driftMs);
  if (d > ntp.max_drift_ms) return "exceeded";
  if (d >= ntp.warn_drift_ms) return "warn";
  return "ok";
}

/* Epoch ms at which the next NTP sync is due after `lastSyncMs`. */
function nextSyncDueMs(ntp, lastSyncMs) {
  validateNtpConfig(ntp);
  if (!isFiniteNumber(lastSyncMs)) throw new Error("lastSyncMs must be a number");
  return lastSyncMs + ntp.interval_sec * 1000;
}

/* --------------------------------------------------------------------------
 * Monotonic millisecond sequencing for order numbering.
 *
 * seq = epochMs * 1000 + counter (0..999). Safe while epochMs < 9.007e12
 * (year ~2255). Guarantees:
 *   - strictly increasing across calls, even if the wall clock moves
 *     backwards (the base millisecond is pinned to the highest seen);
 *   - uniqueness within one sequencer instance;
 *   - the embedded millisecond is recoverable via extractSequenceMs().
 * If more than 1000 ids are requested inside one millisecond, the base
 * millisecond is advanced by 1 (still strictly increasing, never blocking).
 * One sequencer instance is per server process; instances do not coordinate
 * with each other (use per-server id ranges for cross-server uniqueness).
 * -------------------------------------------------------------------------- */
var SEQ_COUNTER_MAX = 999;

function createSequencer() {
  var lastBaseMs = -1;
  var counter = 0;
  return {
    next: function (nowMs) {
      if (!isFiniteNumber(nowMs)) throw new Error("nowMs must be a number");
      var base = Math.floor(nowMs);
      if (base > lastBaseMs) {
        lastBaseMs = base;
        counter = 0;
      } else {
        /* Same millisecond burst, or clock moved backwards: keep the
         * highest base seen so the sequence stays strictly increasing. */
        counter++;
        if (counter > SEQ_COUNTER_MAX) {
          lastBaseMs++;
          counter = 0;
        }
      }
      return lastBaseMs * 1000 + counter;
    },
    /* Highest base millisecond this instance has committed to. */
    lastBaseMs: function () { return lastBaseMs; }
  };
}

function extractSequenceMs(seq) {
  if (!isFiniteNumber(seq) || seq < 0) throw new Error("seq must be a non-negative number");
  return Math.floor(seq / 1000);
}

function extractSequenceCounter(seq) {
  if (!isFiniteNumber(seq) || seq < 0) throw new Error("seq must be a non-negative number");
  return Math.floor(seq % 1000);
}

/* --------------------------------------------------------------------------
 * Working-hours calendar.
 *
 * Per-weekday wall-clock windows (interpreted in server time) during which
 * maintenance / optimisation background jobs are ALLOWED to run. A missing
 * day, or an empty window list, means "no jobs that day".
 *
 *   working_hours: { mon: [{start:"02:00", end:"06:00"}], tue: [...], ... }
 * -------------------------------------------------------------------------- */
var WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
var HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function hhmmToMinutes(hhmm) {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
}

/* Sample defaults: weekday low-activity window 02:00–06:00 server time,
 * no jobs on weekends. Operators configure their own windows. */
function defaultWorkingHours() {
  function weekdayWindow() { return [{ start: "02:00", end: "06:00" }]; }
  return {
    mon: weekdayWindow(), tue: weekdayWindow(), wed: weekdayWindow(),
    thu: weekdayWindow(), fri: weekdayWindow(), sat: [], sun: []
  };
}

function validateWorkingHours(wh) {
  if (!wh || typeof wh !== "object" || Array.isArray(wh)) {
    throw new Error("working_hours must be an object keyed by weekday");
  }
  for (var d = 0; d < WEEKDAYS.length; d++) {
    var day = WEEKDAYS[d];
    var wins = wh[day] === undefined ? [] : wh[day];
    if (!Array.isArray(wins)) throw new Error("working_hours." + day + " must be an array");
    var prevEnd = -1;
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      if (!w || typeof w !== "object") throw new Error("working_hours." + day + "[" + i + "] must be an object");
      if (!HHMM_RE.test(w.start)) throw new Error("working_hours." + day + "[" + i + "].start must be HH:MM");
      if (!HHMM_RE.test(w.end)) throw new Error("working_hours." + day + "[" + i + "].end must be HH:MM");
      var s = hhmmToMinutes(w.start), e = hhmmToMinutes(w.end);
      if (e <= s) throw new Error("working_hours." + day + "[" + i + "] end must be after start");
      if (s < prevEnd) throw new Error("working_hours." + day + " windows overlap or are out of order");
      prevEnd = e;
    }
  }
  for (var key in wh) {
    if (Object.prototype.hasOwnProperty.call(wh, key) && WEEKDAYS.indexOf(key) === -1) {
      throw new Error("working_hours has unknown day key: " + key);
    }
  }
  return true;
}

/* Is `epochMs` inside an allowed working window? `tz` is the server timezone. */
function isWorkingTime(wh, epochMs, tz) {
  validateWorkingHours(wh);
  validateTimezone(tz);
  if (!isFiniteNumber(epochMs)) throw new Error("epochMs must be a number");
  return _isWorkingTimeAt(wh, epochMs, tz);
}

/* Internal: same check, inputs already validated. */
function _isWorkingTimeAt(wh, epochMs, tz) {
  var wt = serverWallTime(tz, epochMs);
  var wins = wh[wt.weekday] || [];
  var nowMin = hhmmToMinutes(wt.hhmm);
  for (var i = 0; i < wins.length; i++) {
    if (nowMin >= hhmmToMinutes(wins[i].start) && nowMin < hhmmToMinutes(wins[i].end)) return true;
  }
  return false;
}

/* Earliest epoch ms >= epochMs at which jobs may run; null if none within
 * `maxDays` (default 370). Day-stepping: at most one wall-clock evaluation
 * per day plus a bounded local scan when a DST transition sits inside the
 * candidate day, so even an empty calendar scans only ~370 days. */
function nextWorkingStart(wh, epochMs, tz, maxDays) {
  validateWorkingHours(wh);
  validateTimezone(tz);
  if (!isFiniteNumber(epochMs)) throw new Error("epochMs must be a number");
  if (maxDays === undefined) maxDays = 370;
  var limit = epochMs + maxDays * 86400000;
  var t = Math.ceil(epochMs / 60000) * 60000;
  for (var d = 0; d <= maxDays && t <= limit; d++) {
    var wt = serverWallTime(tz, t);
    var wins = wh[wt.weekday] || [];
    var nowMin = hhmmToMinutes(wt.hhmm);
    for (var i = 0; i < wins.length; i++) {
      var startMin = hhmmToMinutes(wins[i].start);
      var endMin = hhmmToMinutes(wins[i].end);
      if (nowMin < endMin) {
        var candMin = Math.max(nowMin, startMin);
        var cand = t + (candMin - nowMin) * 60000;
        /* One refinement pass: a DST transition between t and cand shifts
         * the wall clock, so re-anchor on the actual wall time. */
        var wc = serverWallTime(tz, cand);
        var shiftMin = candMin - hhmmToMinutes(wc.hhmm);
        if (shiftMin !== 0) cand += shiftMin * 60000;
        if (cand >= t && cand <= limit && _isWorkingTimeAt(wh, cand, tz)) return cand;
        /* DST gap/ambiguity fallback: bounded local scan around the guess. */
        for (var k = -180; k <= 180; k++) {
          var c2 = cand + k * 60000;
          if (c2 >= t && c2 <= limit && _isWorkingTimeAt(wh, c2, tz)) return c2;
        }
      }
    }
    /* Advance to just past the next server-time midnight. */
    t += (1440 - nowMin) * 60000 + 60000;
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Whole time-config object.
 * -------------------------------------------------------------------------- */
function defaultTimeConfig() {
  return {
    /* IANA timezone id for all server-side wall-clock times. UTC keeps
     * behaviour identical on every host; change only deliberately. */
    server_timezone: "UTC",
    dst: defaultDstConfig(),
    ntp: defaultNtpConfig(),
    working_hours: defaultWorkingHours()
  };
}

function validateTimeConfig(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("time config must be an object");
  validateTimezone(cfg.server_timezone);
  validateDstConfig(cfg.dst);
  validateNtpConfig(cfg.ntp);
  validateWorkingHours(cfg.working_hours);
  return true;
}

var SERVER_TIME = {
  WEEKDAYS: WEEKDAYS,
  DST_MODES: DST_MODES,
  SEQ_COUNTER_MAX: SEQ_COUNTER_MAX,
  validateTimezone: validateTimezone,
  utcOffsetSeconds: utcOffsetSeconds,
  serverWallTime: serverWallTime,
  defaultDstConfig: defaultDstConfig,
  validateDstConfig: validateDstConfig,
  effectiveOffsetSeconds: effectiveOffsetSeconds,
  findTransitions: findTransitions,
  defaultNtpConfig: defaultNtpConfig,
  validateNtpConfig: validateNtpConfig,
  classifyDrift: classifyDrift,
  nextSyncDueMs: nextSyncDueMs,
  createSequencer: createSequencer,
  extractSequenceMs: extractSequenceMs,
  extractSequenceCounter: extractSequenceCounter,
  defaultWorkingHours: defaultWorkingHours,
  validateWorkingHours: validateWorkingHours,
  isWorkingTime: isWorkingTime,
  nextWorkingStart: nextWorkingStart,
  defaultTimeConfig: defaultTimeConfig,
  validateTimeConfig: validateTimeConfig
};
if (typeof module !== "undefined" && module.exports) { module.exports = SERVER_TIME; }
else { root.OrbitServerTime = SERVER_TIME; }
})(typeof globalThis !== "undefined" ? globalThis : this);
