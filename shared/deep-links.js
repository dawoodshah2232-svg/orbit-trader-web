/* shared/deep-links.js — OrbitTrader app URL-scheme spec.
 *
 * OrbitTrader's own deep-link format: orbittrader://<action>?<params>
 * Pure functions, no globals, no DOM: runs in the browser and in node
 * (guarded export at the bottom, same pattern as shared/groups.js).
 *
 * Link types:
 *   account      server + login        -> open the terminal login dialog pre-filled
 *   marketwatch  symbol list           -> set the Market Watch contents
 *   chart        symbol + timeframe    -> open a chart for symbol/timeframe
 *   trade        symbol + side + volume -> open the order ticket pre-filled
 *                                        (a trade link NEVER auto-sends an order;
 *                                        the user always confirms in the ticket)
 *
 * Marketing links: any link may carry utm-style params
 * (utm_source, utm_medium, utm_campaign, utm_term, utm_content). They are
 * ignored by the app's navigation but extractCampaign() maps them to
 * lead_source / lead_medium / lead_campaign / lead_term / lead_content so
 * the operator can attribute an install or signup to a campaign on the
 * account's lead record.
 *
 * Universal links: toUniversalLink()/fromUniversalLink() wrap a deep link
 * into an https URL on the operator's own domain so iOS Universal Links and
 * Android App Links can route it; appleAppSiteAssociation() and
 * androidAssetLinks() generate the host-side association documents from an
 * operator-supplied config (validateUniversalConfig() checks it).
 *
 * This spec is written for OrbitTrader and uses no third-party schemes,
 * branding, or vendor URL formats.
 */
(function (root) {
"use strict";

var SCHEME = "orbittrader";

var LINK_TYPES = ["account", "marketwatch", "chart", "trade"];

var TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"];

var SIDES = ["buy", "sell"];

var UTM_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

var LEAD_FIELD_MAP = {
  utm_source: "lead_source",
  utm_medium: "lead_medium",
  utm_campaign: "lead_campaign",
  utm_term: "lead_term",
  utm_content: "lead_content"
};

/* Required params per link type. */
var REQUIRED_PARAMS = {
  account: ["server", "login"],
  marketwatch: ["symbols"],
  chart: ["symbol", "timeframe"],
  trade: ["symbol", "side", "volume"]
};

/* Params that may additionally appear per link type. */
var OPTIONAL_PARAMS = {
  account: UTM_FIELDS.slice(),
  marketwatch: UTM_FIELDS.slice(),
  chart: UTM_FIELDS.slice(),
  trade: UTM_FIELDS.slice()
};

/* Platform limits for this spec. */
var MAX_SYMBOL_LEN = 32;
var MAX_WATCHLIST_SYMBOLS = 64;
var MAX_LOGIN = 2147483647;

/* ---- validation helpers ---- */

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function validServer(v) {
  if (!isNonEmptyString(v)) return false;
  if (v.length > 253) return false;
  if (/\s/.test(v)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9.:\-]*$/.test(v);
}

function validLogin(v) {
  var n;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^[0-9]+$/.test(v)) n = parseInt(v, 10);
  else return false;
  return isFinite(n) && Math.floor(n) === n && n >= 1 && n <= MAX_LOGIN;
}

/* OrbitTrader symbol spelling: 1..32 chars, starts alphanumeric, then
 * alphanumeric plus ".", "_", "-", "#" (suffix-style quote symbols). */
function validSymbol(v) {
  if (!isNonEmptyString(v)) return false;
  if (v.length > MAX_SYMBOL_LEN) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._\-#]*$/.test(v);
}

function validSymbolsList(v) {
  var parts;
  if (Array.isArray(v)) parts = v.slice();
  else if (typeof v === "string") parts = v.split(",");
  else return false;
  if (parts.length === 0 || parts.length > MAX_WATCHLIST_SYMBOLS) return false;
  var seen = {};
  for (var i = 0; i < parts.length; i++) {
    var s = typeof parts[i] === "string" ? parts[i].replace(/^\s+|\s+$/g, "") : "";
    if (!validSymbol(s)) return false;
    if (seen[s]) return false; /* no duplicates */
    seen[s] = true;
  }
  return true;
}

function validTimeframe(v) {
  return typeof v === "string" && TIMEFRAMES.indexOf(v) !== -1;
}

function validSide(v) {
  return typeof v === "string" && SIDES.indexOf(v) !== -1;
}

function validVolume(v) {
  var n = typeof v === "number" ? v :
          (typeof v === "string" && v !== "" ? Number(v) : NaN);
  return typeof n === "number" && isFinite(n) && n > 0;
}

function validUtmValue(v) {
  return isNonEmptyString(v);
}

/* Validate one param for a link type; returns an error string or null. */
function validateParam(type, key, value) {
  if (key === "server") return validServer(value) ? null : "server must be a non-empty host (no whitespace, max 253 chars)";
  if (key === "login") return validLogin(value) ? null : "login must be a positive integer 1.." + MAX_LOGIN;
  if (key === "symbol") return validSymbol(value) ? null : "symbol must be 1.." + MAX_SYMBOL_LEN + " chars: alphanumeric start, then [A-Za-z0-9._#-}";
  if (key === "symbols") return validSymbolsList(value) ? null : "symbols must be a comma list of 1.." + MAX_WATCHLIST_SYMBOLS + " valid unique symbols";
  if (key === "timeframe") return validTimeframe(value) ? null : "timeframe must be one of " + TIMEFRAMES.join(", ");
  if (key === "side") return validSide(value) ? null : "side must be one of " + SIDES.join(", ");
  if (key === "volume") return validVolume(value) ? null : "volume must be a finite number > 0";
  if (UTM_FIELDS.indexOf(key) !== -1)
    return validUtmValue(value) ? null : key + " must be a non-empty string";
  return "unknown param '" + key + "' for link type '" + type + "'";
}

function validateParams(type, params) {
  var errs = [];
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return ["params must be an object"];
  }
  var req = REQUIRED_PARAMS[type] || [];
  var opt = OPTIONAL_PARAMS[type] || [];
  var allowed = req.concat(opt);
  req.forEach(function (k) {
    if (!(k in params) || params[k] === undefined || params[k] === null || params[k] === "")
      errs.push("missing required param '" + k + "'");
  });
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    if (allowed.indexOf(k) === -1) {
      errs.push("unknown param '" + k + "' for link type '" + type + "'");
      continue;
    }
    if (REQUIRED_PARAMS[type].indexOf(k) !== -1 &&
        (params[k] === undefined || params[k] === null || params[k] === "")) {
      continue; /* already reported as missing */
    }
    var e = validateParam(type, k, params[k]);
    if (e) errs.push(e);
  }
  return errs;
}

/* ---- URL structure ---- */

function parseStructure(url) {
  if (typeof url !== "string") throw new Error("deep-links: url must be a string");
  var m = url.match(/^\s*([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s);
  if (!m) throw new Error("deep-links: not a scheme:// url");
  if (m[1].toLowerCase() !== SCHEME)
    throw new Error("deep-links: scheme must be '" + SCHEME + "://', got '" + m[1] + "://'");
  var rest = m[2];
  var q = rest.indexOf("?");
  var action = (q === -1 ? rest : rest.slice(0, q)).replace(/\/+$/, "");
  var query = q === -1 ? "" : rest.slice(q + 1);
  if (LINK_TYPES.indexOf(action) === -1)
    throw new Error("deep-links: unknown link type '" + action + "'; expected one of " + LINK_TYPES.join(", "));
  var params = {};
  if (query) {
    query.split("&").forEach(function (pair) {
      var eq = pair.indexOf("=");
      var k = eq === -1 ? pair : pair.slice(0, eq);
      var v = eq === -1 ? "" : pair.slice(eq + 1);
      try { k = decodeURIComponent(k); } catch (e) { throw new Error("deep-links: bad encoding in param name"); }
      try { v = decodeURIComponent(v); } catch (e) { throw new Error("deep-links: bad encoding in param '" + k + "'"); }
      if (!(k in params)) params[k] = v; /* first wins on duplicates */
    });
  }
  return { type: action, params: params };
}

/* ---- public: parse / build / validate ---- */

function parseDeepLink(url) {
  var s = parseStructure(url);
  var errs = validateParams(s.type, s.params);
  if (errs.length) throw new Error("deep-links: invalid " + s.type + " link: " + errs.join("; "));
  /* normalize: symbols list from comma string -> array */
  var out = {};
  for (var k in s.params) {
    if (!Object.prototype.hasOwnProperty.call(s.params, k)) continue;
    if (k === "symbols") {
      out.symbols = s.params.symbols.split(",").map(function (x) {
        return x.replace(/^\s+|\s+$/g, "");
      });
    } else {
      out[k] = s.params[k];
    }
  }
  return { type: s.type, params: out };
}

function encodeVal(v) {
  return encodeURIComponent(String(v));
}

function buildDeepLink(type, params) {
  if (LINK_TYPES.indexOf(type) === -1)
    throw new Error("deep-links: unknown link type '" + type + "'");
  var errs = validateParams(type, params);
  if (errs.length) throw new Error("deep-links: invalid " + type + " link: " + errs.join("; "));
  var parts = [];
  var req = REQUIRED_PARAMS[type] || [];
  var opt = OPTIONAL_PARAMS[type] || [];
  req.concat(opt).forEach(function (k) {
    if (!(k in params) || params[k] === undefined || params[k] === null) return;
    var v = params[k];
    if (k === "symbols") {
      v = (Array.isArray(v) ? v : String(v).split(","))
        .map(function (x) { return String(x).replace(/^\s+|\s+$/g, ""); })
        .map(encodeVal).join(",");
    } else {
      v = encodeVal(v);
    }
    parts.push(encodeVal(k) + "=" + v);
  });
  return SCHEME + "://" + type + "?" + parts.join("&");
}

function isDeepLink(url) {
  if (typeof url !== "string") return false;
  return /^\s*orbittrader:\/\//i.test(url);
}

/* Returns [] when the URL parses and validates; otherwise the errors. */
function validateDeepLink(url) {
  try {
    parseDeepLink(url);
    return [];
  } catch (e) {
    return [e.message];
  }
}

/* ---- marketing campaign mapping ----
 * utm_* params on any deep link map to lead_* fields for the account's
 * lead record. Returns {} when the link carries no campaign params. */
function extractCampaign(params) {
  var out = {};
  if (!params || typeof params !== "object") return out;
  UTM_FIELDS.forEach(function (u) {
    if (isNonEmptyString(params[u])) out[LEAD_FIELD_MAP[u]] = params[u];
  });
  return out;
}

/* ---- universal links (https wrapper for iOS/Android app links) ---- */

function defaultUniversalConfig() {
  return {
    ios: { app_id: "", paths: ["*"] },          /* app_id = "<team-id>.<bundle-id>", fill in */
    android: { package_name: "", sha256_cert_fingerprints: [] }
  };
}

function validAppId(v) {
  return typeof v === "string" && /^[A-Z0-9]{10}\.[A-Za-z0-9.\-]+$/.test(v);
}

function validFingerprint(v) {
  if (typeof v !== "string") return false;
  var hex = v.replace(/:/g, "");
  return /^[0-9A-Fa-f]{64}$/.test(hex);
}

function validateUniversalConfig(cfg) {
  var errs = [];
  if (!cfg || typeof cfg !== "object") return ["config must be an object"];
  var ios = cfg.ios, and = cfg.android;
  if (!ios || typeof ios !== "object") errs.push("ios must be an object");
  else {
    if (!validAppId(ios.app_id)) errs.push("ios.app_id must look like '<10-char-team-id>.<bundle-id>'");
    if (!Array.isArray(ios.paths) || ios.paths.length === 0) errs.push("ios.paths must be a non-empty array");
  }
  if (!and || typeof and !== "object") errs.push("android must be an object");
  else {
    if (!isNonEmptyString(and.package_name)) errs.push("android.package_name must be a non-empty string");
    if (!Array.isArray(and.sha256_cert_fingerprints) || and.sha256_cert_fingerprints.length === 0)
      errs.push("android.sha256_cert_fingerprints must be a non-empty array");
    else and.sha256_cert_fingerprints.forEach(function (f, i) {
      if (!validFingerprint(f)) errs.push("android.sha256_cert_fingerprints[" + i + "] must be a 64-hex SHA-256 digest (colons optional)");
    });
  }
  return errs;
}

/* Host-side document for iOS Universal Links (apple-app-site-association). */
function appleAppSiteAssociation(cfg) {
  var errs = validateUniversalConfig(cfg);
  if (errs.length) throw new Error("deep-links: bad universal config: " + errs.join("; "));
  return {
    applinks: {
      apps: [],
      details: [{ appID: cfg.ios.app_id, paths: cfg.ios.paths.slice() }]
    }
  };
}

/* Host-side document for Android App Links (assetlinks.json). */
function androidAssetLinks(cfg) {
  var errs = validateUniversalConfig(cfg);
  if (errs.length) throw new Error("deep-links: bad universal config: " + errs.join("; "));
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: cfg.android.package_name,
      sha256_cert_fingerprints: cfg.android.sha256_cert_fingerprints.slice()
    }
  }];
}

function validHost(v) {
  return isNonEmptyString(v) && v.length <= 253 && !/\s/.test(v) &&
         /^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(v);
}

/* Wrap a deep link into an https URL on the operator's domain:
 * https://<host>/open?link=<encoded orbittrader://...> */
function toUniversalLink(host, deepUrl) {
  if (!validHost(host)) throw new Error("deep-links: host must be a plain hostname");
  var errs = validateDeepLink(deepUrl);
  if (errs.length) throw new Error("deep-links: cannot wrap invalid deep link: " + errs.join("; "));
  return "https://" + host + "/open?link=" + encodeURIComponent(deepUrl);
}

/* Inverse of toUniversalLink: verify the host and recover the deep link. */
function fromUniversalLink(host, url) {
  if (!validHost(host)) throw new Error("deep-links: host must be a plain hostname");
  if (typeof url !== "string") throw new Error("deep-links: url must be a string");
  var m = url.match(/^https?:\/\/([^\/\?#]+)(\/open)(\?([^#]*))?$/);
  if (!m || m[1].toLowerCase() !== host.toLowerCase())
    throw new Error("deep-links: url is not a universal link for host '" + host + "'");
  var link = null;
  if (m[4]) {
    m[4].split("&").forEach(function (pair) {
      var eq = pair.indexOf("=");
      var k = eq === -1 ? pair : pair.slice(0, eq);
      if (decodeURIComponent(k) === "link" && link === null)
        link = decodeURIComponent(eq === -1 ? "" : pair.slice(eq + 1));
    });
  }
  if (!link) throw new Error("deep-links: universal link carries no 'link' param");
  var errs = validateDeepLink(link);
  if (errs.length) throw new Error("deep-links: wrapped link is invalid: " + errs.join("; "));
  return link;
}

var DEEP_LINKS = {
  SCHEME: SCHEME,
  LINK_TYPES: LINK_TYPES,
  TIMEFRAMES: TIMEFRAMES,
  SIDES: SIDES,
  UTM_FIELDS: UTM_FIELDS,
  MAX_SYMBOL_LEN: MAX_SYMBOL_LEN,
  MAX_WATCHLIST_SYMBOLS: MAX_WATCHLIST_SYMBOLS,
  parseDeepLink: parseDeepLink,
  buildDeepLink: buildDeepLink,
  isDeepLink: isDeepLink,
  validateDeepLink: validateDeepLink,
  extractCampaign: extractCampaign,
  defaultUniversalConfig: defaultUniversalConfig,
  validateUniversalConfig: validateUniversalConfig,
  appleAppSiteAssociation: appleAppSiteAssociation,
  androidAssetLinks: androidAssetLinks,
  toUniversalLink: toUniversalLink,
  fromUniversalLink: fromUniversalLink
};
if (typeof module !== "undefined" && module.exports) { module.exports = DEEP_LINKS; }
else { root.OrbitDeepLinks = DEEP_LINKS; }
})(typeof globalThis !== "undefined" ? globalThis : this);
