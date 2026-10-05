/* QuotesWare wave-4 — Config export/import portability (module 11 of 13).
 *
 * Versioned JSON export/import of platform settings. A platform settings
 * object is a map of section name -> array of records. Each section declares
 * its key fields: on import, an incoming record whose key matches an existing
 * record UPDATES it (shallow field merge, incoming wins); a non-matching
 * record is CREATED. Records missing their key fields are SKIPPED and
 * reported. Duplicate keys inside one import file are skipped (first wins).
 *
 * Imported records that reference a source server ID are rebound: IDs known
 * locally are kept as-is, unknown IDs are rebound to a configurable main
 * server ID, and every rebinding is reported.
 *
 * Pure logic — no DOM, no network, no DB. CommonJS, runs in the browser and
 * in node.
 */
"use strict";

// --- Format ------------------------------------------------------------------

/* Envelope format identifier and the writer version. Import accepts any
 * version 1..FORMAT_VERSION (older writers stay readable); anything newer is
 * rejected as unsupported. */
var FORMAT_ID = "orbit-config";
var FORMAT_VERSION = 1;

// --- Sections ----------------------------------------------------------------

/* Exportable/importable config sections, in a stable order. */
var SECTIONS = [
  "groups",
  "managers",
  "routing",
  "gateways",
  "plugins",
  "feeders",
  "reports",
  "symbols",
  "spreads",
  "historysync"
];

/* Per-section metadata.
 *   key            — fields that uniquely identify a record within the section
 *                    (key-parameter matching on import).
 *   serverIdFields — record fields holding a server ID that must be rebound
 *                    when importing from another server.
 *   description    — human-readable, shown in the CLI/docs. */
var SECTION_META = {
  groups:      { key: ["name"],              serverIdFields: [],
                 description: "Account groups and their trading conditions." },
  managers:    { key: ["login"],             serverIdFields: ["serverId"],
                 description: "Manager accounts and their permissions." },
  routing:     { key: ["name"],              serverIdFields: ["serverId"],
                 description: "Order routing rules (book selection, coverage)." },
  gateways:    { key: ["name"],              serverIdFields: ["serverId"],
                 description: "Liquidity gateways / bridge endpoints." },
  plugins:     { key: ["name"],              serverIdFields: [],
                 description: "Server plugins and their settings." },
  feeders:     { key: ["name"],              serverIdFields: ["serverId"],
                 description: "Price feed sources and failover order." },
  reports:     { key: ["name"],              serverIdFields: [],
                 description: "Saved report definitions." },
  symbols:     { key: ["name"],              serverIdFields: [],
                 description: "Symbol specifications." },
  spreads:     { key: ["group", "symbol"],   serverIdFields: [],
                 description: "Per-group per-symbol spread/commission overrides." },
  historysync: { key: ["symbol", "timeframe"], serverIdFields: [],
                 description: "History sync sources per symbol and timeframe." }
};

/* Extra server-ID field names scanned generically on every record (in addition
 * to the section's declared serverIdFields), so a record carrying its server
 * reference under a different name is still rebound. */
var SERVER_ID_FIELDS = ["serverId", "server_id", "server"];

// --- Selection ---------------------------------------------------------------

/* Returns a copy of the exportable section list. */
function sectionNames() {
  return SECTIONS.slice();
}

/* Returns the metadata for a section, or null for an unknown section. */
function sectionMeta(section) {
  if (!Object.prototype.hasOwnProperty.call(SECTION_META, section)) return null;
  var m = SECTION_META[section];
  return {
    key: m.key.slice(),
    serverIdFields: m.serverIdFields.slice(),
    description: m.description
  };
}

/* Normalizes a section selection to a validated array of section names.
 * Accepts "all" or an array of names. Throws TypeError on invalid input,
 * unknown sections, or duplicates. */
function validateSelection(selection) {
  var names;
  if (selection === "all") {
    names = SECTIONS.slice();
  } else if (Array.isArray(selection)) {
    names = selection.slice();
  } else {
    throw new TypeError("selection must be \"all\" or an array of section names");
  }
  var seen = {};
  names.forEach(function (name, i) {
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(SECTION_META, name)) {
      throw new TypeError("unknown config section at selection[" + i + "]: " + String(name));
    }
    if (seen[name]) {
      throw new TypeError("duplicate section in selection: " + name);
    }
    seen[name] = true;
  });
  if (names.length === 0) {
    throw new TypeError("selection must include at least one section");
  }
  return names;
}

// --- Keys --------------------------------------------------------------------

/* True when a value is usable as a key-field value. */
function isKeyValue(v) {
  return (typeof v === "string" && v.length > 0) ||
         (typeof v === "number" && isFinite(v));
}

/* Builds the match key for a record in a section, or null when any key field
 * is missing/empty (such records cannot be matched and are skipped on
 * import). Key fields are matched case-sensitively, in declared order. */
function recordKey(section, record) {
  var meta = SECTION_META[section];
  if (!meta || record === null || typeof record !== "object") return null;
  var parts = [];
  for (var i = 0; i < meta.key.length; i++) {
    var v = record[meta.key[i]];
    if (!isKeyValue(v)) return null;
    parts.push(meta.key[i] + "=" + String(v));
  }
  return parts.join("|");
}

// --- Export ------------------------------------------------------------------

/* Deep-clones JSON-safe data so envelopes are decoupled from the source. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* Returns a settings object with every section present as an empty array. */
function emptySettings() {
  var out = {};
  SECTIONS.forEach(function (s) { out[s] = []; });
  return out;
}

/* Exports a subset of the platform settings to a versioned envelope:
 *   { format, version, exportedAt, sections: { name: [records...] } }
 * selection: "all" or an array of section names (validateSelection).
 * Missing sections in `settings` export as empty arrays; extra keys in
 * `settings` are ignored. Records are deep-cloned. */
function exportConfig(settings, selection, opts) {
  if (settings === null || typeof settings !== "object") {
    throw new TypeError("settings must be an object");
  }
  var names = validateSelection(selection);
  opts = opts || {};
  var exportedAt = opts.exportedAt;
  if (exportedAt === undefined || exportedAt === null) {
    exportedAt = new Date().toISOString();
  }
  if (typeof exportedAt !== "string" || exportedAt === "") {
    throw new TypeError("exportedAt must be a non-empty string");
  }
  var sections = {};
  names.forEach(function (name) {
    var rows = settings[name];
    if (rows === undefined || rows === null) rows = [];
    if (!Array.isArray(rows)) {
      throw new TypeError("settings[" + name + "] must be an array");
    }
    sections[name] = clone(rows);
  });
  var envelope = {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    exportedAt: exportedAt,
    sections: sections
  };
  if (opts.serverId !== undefined && opts.serverId !== null) {
    envelope.serverId = String(opts.serverId);
  }
  return envelope;
}

// --- Envelope validation -----------------------------------------------------

/* Validates an import envelope. Returns { ok, errors[] }.
 * Checks: object shape, format identifier, integer version in 1..FORMAT_VERSION,
 * sections as an object whose entries are arrays of objects under known
 * section names. Subset envelopes (missing sections) are allowed. */
function validateEnvelope(envelope) {
  var errors = [];
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, errors: ["envelope must be an object"] };
  }
  if (envelope.format !== FORMAT_ID) {
    errors.push("unsupported format: expected \"" + FORMAT_ID + "\", got " +
                JSON.stringify(envelope.format));
  }
  var v = envelope.version;
  if (typeof v !== "number" || !isFinite(v) || Math.floor(v) !== v) {
    errors.push("version must be an integer");
  } else if (v < 1) {
    errors.push("version must be >= 1, got " + v);
  } else if (v > FORMAT_VERSION) {
    errors.push("unsupported version " + v + " (this build reads up to " +
                FORMAT_VERSION + ")");
  }
  if (envelope.exportedAt !== undefined && envelope.exportedAt !== null &&
      typeof envelope.exportedAt !== "string") {
    errors.push("exportedAt must be a string");
  }
  var sections = envelope.sections;
  if (sections === null || typeof sections !== "object" || Array.isArray(sections)) {
    errors.push("sections must be an object mapping section name to a record array");
  } else {
    Object.keys(sections).forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(SECTION_META, name)) {
        errors.push("unknown section: " + name);
        return;
      }
      var rows = sections[name];
      if (!Array.isArray(rows)) {
        errors.push("sections[" + name + "] must be an array");
        return;
      }
      rows.forEach(function (rec, i) {
        if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
          errors.push("sections[" + name + "][" + i + "] must be an object");
        }
      });
    });
  }
  return { ok: errors.length === 0, errors: errors };
}

// --- Server-ID rebinding -----------------------------------------------------

/* Collects the server-ID-carrying field names for a section: the declared
 * serverIdFields plus the generic SERVER_ID_FIELDS, de-duplicated. */
function serverIdFieldNames(section) {
  var meta = SECTION_META[section];
  var names = meta ? meta.serverIdFields.slice() : [];
  SERVER_ID_FIELDS.forEach(function (f) {
    if (names.indexOf(f) < 0) names.push(f);
  });
  return names;
}

/* Rebinds a record's server-ID fields in place.
 *   knownServerIds — server IDs that exist locally (kept as-is).
 *   mainServerId   — fallback for unknown IDs (when provided).
 * Reports { section, key, field, from, to } for every rebinding. */
function rebindRecord(record, key, section, knownServerIds, mainServerId, rebindings) {
  var fields = serverIdFieldNames(section);
  fields.forEach(function (field) {
    var value = record[field];
    if (value === undefined || value === null || value === "") return;
    var id = String(value);
    if (knownServerIds.indexOf(id) >= 0) return;      /* exists locally: keep */
    if (mainServerId === undefined || mainServerId === null || mainServerId === "") return;
    var to = String(mainServerId);
    if (id === to) return;
    record[field] = to;
    rebindings.push({ section: section, key: key, field: field, from: id, to: to });
  });
}

// --- Import ------------------------------------------------------------------

/* Applies a validated envelope onto existing settings (pure, non-mutating).
 *
 * opts:
 *   mainServerId — fallback server ID for server-ID rebinding (optional).
 *   serverIds    — array of server IDs known to exist locally (optional,
 *                  defaults to []).
 *   sections     — "all" or an array of section names to apply from the
 *                  envelope (default "all"); lets a CLI import one section.
 *
 * Returns:
 *   { ok, errors[], summary: { section: { created, updated, skipped, rebinds } },
 *     rebindings: [...], result: <merged settings object> }
 *
 * Matching: record key (section.key fields) matches an existing record -> the
 * existing record is UPDATED by shallow field merge (incoming fields win,
 * local-only fields are preserved). No match -> the record is CREATED.
 * Records with missing/empty key fields, and duplicate keys within the
 * envelope, are SKIPPED and listed in errors. */
function applyImport(envelope, existing, opts) {
  var validation = validateEnvelope(envelope);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, summary: {}, rebindings: [], result: null };
  }
  if (existing === null || typeof existing !== "object") {
    throw new TypeError("existing settings must be an object");
  }
  opts = opts || {};
  var mainServerId = opts.mainServerId;
  var knownServerIds = Array.isArray(opts.serverIds)
    ? opts.serverIds.map(function (id) { return String(id); })
    : [];
  if (mainServerId !== undefined && mainServerId !== null && mainServerId !== "") {
    mainServerId = String(mainServerId);
    if (knownServerIds.indexOf(mainServerId) < 0) knownServerIds.push(mainServerId);
  } else {
    mainServerId = null;
  }

  var names = validateSelection(opts.sections === undefined ? "all" : opts.sections);
  var result = clone(existing);
  var summary = {};
  var rebindings = [];
  var errors = [];

  names.forEach(function (section) {
    var rows = envelope.sections[section] || [];
    var existingRows = result[section];
    if (!Array.isArray(existingRows)) {
      existingRows = [];
      result[section] = existingRows;
    }
    var index = {};
    existingRows.forEach(function (rec, i) {
      var k = recordKey(section, rec);
      if (k !== null && !Object.prototype.hasOwnProperty.call(index, k)) {
        index[k] = i;
      }
    });

    var sec = { created: 0, updated: 0, skipped: 0, rebinds: 0 };
    var seenInEnvelope = {};
    rows.forEach(function (incoming, i) {
      var rec = clone(incoming);
      var k = recordKey(section, rec);
      if (k === null) {
        sec.skipped++;
        errors.push("sections[" + section + "][" + i + "] skipped: missing key field(s) " +
                    SECTION_META[section].key.join(", "));
        return;
      }
      if (seenInEnvelope[k]) {
        sec.skipped++;
        errors.push("sections[" + section + "][" + i + "] skipped: duplicate key " + k +
                    " within envelope");
        return;
      }
      seenInEnvelope[k] = true;

      var before = rebindings.length;
      rebindRecord(rec, k, section, knownServerIds, mainServerId, rebindings);
      sec.rebinds += rebindings.length - before;

      if (Object.prototype.hasOwnProperty.call(index, k)) {
        var target = existingRows[index[k]];
        Object.keys(rec).forEach(function (f) { target[f] = rec[f]; });
        sec.updated++;
      } else {
        existingRows.push(rec);
        index[k] = existingRows.length - 1;
        sec.created++;
      }
    });
    summary[section] = sec;
  });

  return { ok: true, errors: errors, summary: summary, rebindings: rebindings, result: result };
}

// --- Exports -----------------------------------------------------------------

var __EXP_PORT__ = (function () { var E = {
  FORMAT_ID: FORMAT_ID,
  FORMAT_VERSION: FORMAT_VERSION,
  SECTIONS: SECTIONS,
  SERVER_ID_FIELDS: SERVER_ID_FIELDS,
  sectionNames: sectionNames,
  sectionMeta: sectionMeta,
  validateSelection: validateSelection,
  recordKey: recordKey,
  emptySettings: emptySettings,
  exportConfig: exportConfig,
  validateEnvelope: validateEnvelope,
  applyImport: applyImport
};
return E; })();
if (typeof module !== "undefined" && module.exports) { module.exports = __EXP_PORT__; }
else if (typeof globalThis !== "undefined") { globalThis.OrbitConfigPortability = __EXP_PORT__; }
