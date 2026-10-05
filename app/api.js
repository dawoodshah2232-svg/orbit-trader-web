/* ============================================================================
 * OrbitTrader 5.1 — shared broker API client (admin.html, manager.html).
 * Trader-agnostic: no DOM assumptions except an optional status pill.
 *
 *   OrbitAPI.configure({baseUrl, key})   // key = otk_... API key (optional)
 *   OrbitAPI.loginAdmin(u, p)            // → session token, stored
 *   OrbitAPI.status()                    // {mode, latencyMs, version, ...}
 *   OrbitAPI.get('/accounts')            // → parsed JSON (throws on !ok)
 *   OrbitAPI.post('/requests/3/decide', {decision:'approved'}, {queue:true})
 *
 * Offline-first: if the server is unreachable, writes made with {queue:true}
 * are stored in localStorage ("orbit-api-queue") and auto-flushed on
 * reconnect. A queued write resolves {ok:true, queued:true} — NEVER as if
 * it had reached the server. Reads fail loudly when offline; callers must
 * fall back to local data themselves.
 * ========================================================================== */
(function (global) {
  "use strict";

  var LS_CFG = "orbit-api-config";   // {baseUrl} — URL is not a secret, may persist
  var LS_TOK = "orbit-api-token";    // legacy: session tokens are memory-only since P0
  var LS_KEY = "orbit-api-key";     // legacy: API keys are memory-only since P0
  var LS_Q   = "orbit-api-queue";    // [{id, method, path, body, ts}]
  var LS_OUT = "orbit-api-outcomes"; // [{id, method, path, outcome, reason, ts}] — explicit dead-letter log
  var QUEUE_CAP = 200;
  var OUTCOME_CAP = 50;
  var TIMEOUT_MS = 12000;

  function lsGet(k, fb) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; }
    catch (e) { return fb; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  /* P0 secrets hygiene: API keys and session tokens live in memory only, never in
   * browser storage (XSS-readable). One-time migration wipes any pre-P0 values. */
  var _migrated = (function () {
    var wiped = [];
    try {
      var raw = localStorage.getItem(LS_CFG);
      if (raw) {
        try {
          var parsed = JSON.parse(raw);
          if (parsed.key) {
            wiped.push('api-key');
            // rewrite the persisted config without the secret
            localStorage.setItem(LS_CFG, JSON.stringify({ baseUrl: parsed.baseUrl || '' }));
          }
        } catch (e) {}
      }
      ['orbit-api-token', 'orbit-api-key'].forEach(function (k) {
        if (localStorage.getItem(k) || sessionStorage.getItem(k)) wiped.push(k);
      });
      localStorage.removeItem(LS_TOK); sessionStorage.removeItem(LS_TOK);
      localStorage.removeItem(LS_KEY); sessionStorage.removeItem(LS_KEY);
    } catch (e) {}
    if (wiped.length && typeof console !== 'undefined' && console.info)
      console.info('[OrbitAPI] P0: cleared stored secrets (' + wiped.join(', ') +
                   ') — re-enter per session.');
    return true;
  })();

  var _savedCfg = lsGet(LS_CFG, {});
  var cfg = { baseUrl: String((_savedCfg && _savedCfg.baseUrl) || ''), key: '' };
  var sess = null;

  var state = {
    mode: cfg.baseUrl ? "unknown" : "unconfigured", // unconfigured|unknown|online|offline
    latencyMs: null,
    version: null,
    serverTime: null,
    lastCheck: 0,
    lastError: ""
  };
  var listeners = [];
  var flushing = false;
  var autoTimer = null;

  function setState(patch) {
    var changed = false;
    for (var k in patch) {
      if (state[k] !== patch[k]) { state[k] = patch[k]; changed = true; }
    }
    if (changed) listeners.forEach(function (fn) { try { fn(state); } catch (e) {} });
  }

  function baseUrl() { return (cfg.baseUrl || "").replace(/\/+$/, ""); }

  function authHeaders(h) {
    h = h || {};
    if (sess && sess.token) h["Authorization"] = "Bearer " + sess.token;
    else if (cfg.key) h["X-API-Key"] = cfg.key;
    return h;
  }

  // v5.8 A02: optional extra headers (idempotency key) per request.
  function fetchOnce(method, path, body, extraHeaders) {
    var url = baseUrl() + "/api/v1" + path;
    var ctrl = null, timer = null;
    var headers = authHeaders({ "Content-Type": "application/json" });
    if (extraHeaders) for (var k in extraHeaders) headers[k] = extraHeaders[k];
    var opts = { method: method, headers: headers };
    if (typeof AbortController !== "undefined") {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    }
    if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (!res.ok || !data || data.ok !== true) {
          var err = new Error((data && data.error) || ("HTTP " + res.status));
          err.status = res.status; err.data = data;
          throw err;
        }
        return data;
      });
    }, function (netErr) {
      if (timer) clearTimeout(timer);
      var err = new Error("Network unreachable");
      err.network = true; err.cause = netErr;
      throw err;
    });
  }

  /* Core request. opts: {queue:boolean, retry:boolean} */
  function request(method, path, body, opts) {
    opts = opts || {};
    var canQueue = !!opts.queue && method !== "GET" && method !== "HEAD";
    if (!baseUrl()) {
      if (canQueue) { enqueue(method, path, body); return Promise.resolve({ ok: true, queued: true }); }
      return Promise.reject(new Error("No server configured"));
    }
    var attempt = function () { return fetchOnce(method, path, body); };
    return attempt().then(function (data) {
      if (state.mode !== "online") setState({ mode: "online", lastError: "" });
      return data;
    }, function (err) {
      if (err.network) {
        setState({ mode: "offline", lastError: "unreachable" });
        if (canQueue) { enqueue(method, path, body); return { ok: true, queued: true }; }
      } else if (err.status === 401) {
        // Credential rejected — drop the bad token, keep the API key.
        if (sess) { sess = null; }
      }
      throw err;
    });
  }

  /* ---- offline queue ---------------------------------------------------- */
  function getQueue() { return lsGet(LS_Q, []); }

  // v5.8 A03: explicit outcome log — nothing is ever silently dropped.
  // Outcomes: "dropped" (queue cap), "rejected" (server refused on flush).
  function getOutcomes() { return lsGet(LS_OUT, []); }
  function recordOutcome(item, outcome, reason, status) {
    var log = getOutcomes();
    log.push({ id: item.id, method: item.method, path: item.path,
               outcome: outcome, reason: reason || "",
               status: status || 0, ts: Date.now() });
    lsSet(LS_OUT, log.slice(-OUTCOME_CAP));
    try { console.warn("[OrbitAPI] queue item " + outcome + ":", item.method, item.path, reason || ("HTTP " + status)); } catch (e) {}
  }

  function enqueue(method, path, body) {
    var q = getQueue();
    q.push({ id: "q" + Date.now() + Math.floor(Math.random() * 1e6),
             method: method, path: path, body: body || null, ts: Date.now() });
    // v5.8 A03: the cap no longer silently truncates — overflowed items get
    // an explicit "dropped" outcome the user/admin can inspect.
    while (q.length > QUEUE_CAP) {
      var dropped = q.shift();
      recordOutcome(dropped, "dropped", "queue-cap: oldest item evicted");
    }
    lsSet(LS_Q, q);
    return q.length;
  }

  function queueLength() { return getQueue().length; }

  function flushQueue() {
    if (flushing) return Promise.resolve(0);
    var q = getQueue();
    if (!q.length || !baseUrl()) return Promise.resolve(0);
    flushing = true;
    var done = 0, remaining = [], doneIds = {};
    var chain = Promise.resolve();
    q.forEach(function (item) {
      chain = chain.then(function () {
        // v5.8 A02: the queue id is a STABLE idempotency key — if the
        // response was lost but the server applied the write, the replay
        // carries the same key and the server must not apply it twice.
        return fetchOnce(item.method, item.path, item.body,
                         { "X-Idempotency-Key": item.id }).then(function () {
          done++; doneIds[item.id] = true;
        }, function (err) {
          if (err.network || err.status === 401) {
            // Not reachable, or not signed in yet — keep queued, try again later.
            remaining.push(item); throw { stop: true };
          }
          // 403/4xx/5xx: the server saw it and refused — explicit rejected
          // outcome (v5.8 A03), never a silent drop.
          recordOutcome(item, "rejected", err.message, err.status);
        });
      });
    });
    return chain.then(function () {
      lsSet(LS_Q, remaining.concat(getQueue().slice(q.length)));
      flushing = false;
      return done;
    }, function (stop) {
      // v5.8 A02 FIX: the old stop handler re-queued items the server had
      // ALREADY acknowledged (done ones were never in `remaining`, so they
      // leaked back into `kept` and replayed on the next flush). Now done
      // ids are excluded — acknowledged writes leave the queue exactly once.
      var cur = getQueue();
      var seen = {};
      remaining.forEach(function (it) { seen[it.id] = true; });
      var kept = cur.filter(function (it) { return !seen[it.id] && !doneIds[it.id]; });
      lsSet(LS_Q, remaining.concat(kept));
      flushing = false;
      return done;
    });
  }

  /* ---- connection check -------------------------------------------------- */
  function checkConnection() {
    if (!baseUrl()) { setState({ mode: "unconfigured" }); return Promise.resolve(state); }
    var t0 = Date.now();
    return fetchOnce("GET", "/ping").then(function (data) {
      setState({ mode: "online", latencyMs: Date.now() - t0,
                 version: data.version || null, serverTime: data.server_time || null,
                 lastCheck: Date.now(), lastError: "" });
      return flushQueue().then(function () { return state; });
    }, function (err) {
      setState({ mode: "offline", latencyMs: null,
                 lastCheck: Date.now(), lastError: err.message || "unreachable" });
      return state;
    });
  }

  /* ---- public API -------------------------------------------------------- */
  var API = {
    configure: function (o) {
      o = o || {};
      // key === undefined → keep the saved key; "" clears it; anything else replaces it.
      var keepKey = (typeof o.key === "undefined");
      cfg = { baseUrl: String(o.baseUrl || "").trim(),
              key: keepKey ? (cfg.key || "") : String(o.key || "").trim() };
      lsSet(LS_CFG, { baseUrl: cfg.baseUrl }); /* P0: key stays memory-only */
      setState({ mode: cfg.baseUrl ? "unknown" : "unconfigured",
                 latencyMs: null, version: null, lastError: "" });
      return API.check();
    },
    config: function () { return { baseUrl: cfg.baseUrl, hasKey: !!cfg.key }; },
    clearConfig: function () {
      cfg = { baseUrl: "", key: "" }; lsSet(LS_CFG, { baseUrl: "" });
      setState({ mode: "unconfigured", latencyMs: null, version: null });
    },

    loginAdmin: function (username, password) {
      return request("POST", "/auth/login", { username: username, password: password })
        .then(function (d) {
          if (d.kind !== "admin") throw new Error("Not an admin account");
          sess = { token: d.token, kind: "admin", label: d.username, role: d.role };
          return d; /* P0: session token memory-only */
        });
    },
    loginTrader: function (login, password) {
      return request("POST", "/auth/login", { login: login, password: password })
        .then(function (d) {
          if (d.kind !== "trader") throw new Error("Not a trader account");
          sess = { token: d.token, kind: "trader", label: String(login) };
          return d; /* P0: session token memory-only */
        });
    },
    session: function () { return sess ? { kind: sess.kind, label: sess.label, role: sess.role } : null; },
    logout: function () { sess = null; },

    check: checkConnection,
    status: function () {
      return { mode: state.mode, latencyMs: state.latencyMs, version: state.version,
               serverTime: state.serverTime, lastCheck: state.lastCheck,
               lastError: state.lastError, queued: queueLength(),
               queueIssues: getOutcomes().length,
               baseUrl: baseUrl(), hasKey: !!cfg.key, session: API.session() };
    },
    onStatus: function (fn) { listeners.push(fn); return function () {
      listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    startAutoCheck: function (ms) {
      API.stopAutoCheck();
      autoTimer = setInterval(checkConnection, ms || 30000);
    },
    stopAutoCheck: function () { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } },

    queueLength: queueLength,
    flushQueue: flushQueue,
    // v5.8 A03: explicit outcomes for items that left the queue unresolved
    queueOutcomes: getOutcomes,
    clearOutcomes: function () { lsSet(LS_OUT, []); },

    /* v5.8 A04: one shared low-level HTTP layer for the broker server.
     * The admin/trader/manager pages each kept their own inline fetch with
     * different timeouts and error shapes; they now delegate here. Auth
     * stays with the caller (each page has its own token flow); this only
     * unifies timeout, JSON handling and error semantics. opts:
     * {baseUrl, token, timeoutMs, apiPrefix} — apiPrefix "" keeps the
     * legacy /api/... family, "/v1" uses /api/v1/... */
    raw: function (path, body, opts) {
      opts = opts || {};
      var base = String(opts.baseUrl || baseUrl()).replace(/\/+$/, "");
      if (!base) return Promise.reject(new Error("No server configured"));
      var prefix = opts.apiPrefix === "/v1" ? "/api/v1" : "/api";
      var url = base + prefix + (path.charAt(0) === "/" ? path : "/" + path);
      var headers = { "Content-Type": "application/json" };
      if (opts.token) headers["Authorization"] = "Bearer " + opts.token;
      else authHeaders(headers);
      var ctrl = null, timer = null;
      var ms = opts.timeoutMs || TIMEOUT_MS;
      var fopts = { method: body ? "POST" : "GET", headers: headers };
      if (typeof AbortController !== "undefined") {
        ctrl = new AbortController(); fopts.signal = ctrl.signal;
        timer = setTimeout(function () { ctrl.abort(); }, ms);
      }
      if (body !== undefined && body !== null) fopts.body = JSON.stringify(body);
      return fetch(url, fopts).then(function (res) {
        if (timer) clearTimeout(timer);
        return res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
          if (!res.ok || !data || data.ok !== true) {
            var err = new Error((data && data.error) || ("HTTP " + res.status));
            err.status = res.status; err.data = data;
            throw err;
          }
          return data;
        });
      }, function (netErr) {
        if (timer) clearTimeout(timer);
        var err = new Error("Network unreachable");
        err.network = true; err.cause = netErr;
        throw err;
      });
    },

    request: request,
    get:    function (p) { return request("GET", p); },
    post:   function (p, b, o) { return request("POST", p, b, o); },
    patch:  function (p, b, o) { return request("PATCH", p, b, o); },
    del:    function (p, o) { return request("DELETE", p, null, o); },

    /* API keys (superadmin session only) */
    keys: {
      list:     function () { return request("GET", "/api-keys").then(function (d) { return d.keys; }); },
      create:   function (name, scopes, expiresAt) {
        return request("POST", "/api-keys",
          { name: name, scopes: scopes, expires_at: expiresAt || "" });
      },
      revoke:   function (id) { return request("POST", "/api-keys/" + id + "/revoke"); },
      activity: function (id) { return request("GET", "/api-keys/" + id + "/activity"); }
    },

    /* Optional header pill binding. el shows connection state. */
    bindPill: function (el, opts) {
      opts = opts || {};
      var render = function (s) {
        var label, cls;
        if (s.mode === "online") {
          label = "SERVER" + (s.latencyMs != null ? " · " + s.latencyMs + "ms" : "");
          cls = "api-pill on";
        } else if (s.mode === "offline") {
          label = "OFFLINE · local mode" + (s.queued ? " · " + s.queued + " queued" : "");
          cls = "api-pill off";
        } else if (s.mode === "unconfigured") {
          label = "NO SERVER";
          cls = "api-pill na";
        } else {
          label = "SERVER …";
          cls = "api-pill na";
        }
        el.textContent = label;
        el.className = cls;
        if (opts.title !== false) {
          el.title = s.baseUrl ? (s.baseUrl + (s.version ? " · v" + s.version : "")) :
            "Configure the broker server in Settings";
        }
      };
      render(state);
      API.onStatus(render);
      el.style.cursor = "pointer";
      el.onclick = function () { API.check(); };
    }
  };

  /* Shared pill styles (injected once). */
  if (typeof document !== "undefined" && !document.getElementById("orbit-api-css")) {
    var st = document.createElement("style");
    st.id = "orbit-api-css";
    st.textContent = ".api-pill{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.06em;" +
      "padding:3px 9px;border-radius:20px;margin-left:8px;vertical-align:middle;white-space:nowrap}" +
      ".api-pill.on{background:rgba(46,189,133,.15);color:#2EBD85}" +
      ".api-pill.off{background:rgba(242,54,69,.13);color:#F23645}" +
      ".api-pill.na{background:rgba(140,150,165,.16);color:#8e8e93}" +
      ".api-offbar{display:none;font-size:12px;font-weight:600;text-align:center;padding:7px 12px;" +
      "background:rgba(212,175,55,.14);color:#B8860B}" +
      ".api-offbar.show{display:block}";
    document.head.appendChild(st);
  }

  global.OrbitAPI = API;
})(typeof window !== "undefined" ? window : this);
