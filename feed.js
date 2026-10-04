/* OrbitFeed - real market data for OrbitTrader. v5.3.
 *
 * Dependency-free, no-build-step browser script. Exposes global OrbitFeed.
 * IRON RULE: this module NEVER invents a price. Every quote comes from a
 * real source; failures keep the last real quote and report OFFLINE.
 * PRIMARY SOURCES (v5.3):
 *   XAUUSD / XAGUSD / every FX pair — Swissquote public spot feed, real
 *   bank bid/ask on a polite staggered schedule: tier1 (charted + metals)
 *   every 2s, tier2 (majors) every 10s, tier3 (rest) every 60s — max 2
 *   requests per second, never a burst (v5.2's ~6 req/s bursts got the
 *   device rate-limited into tick starvation: frozen quotes, zero candles).
 *   Any 429/5xx triggers a global backoff (30s doubling to 5min). Quotes
 *   older than 30s are rejected. NO PAXG may enter XAUUSD quotes or
 *   candles; PAXGUSDc remains a separate 24/7 crypto symbol.
 * Crypto — Kraken WS v2 ticker (+ HTTP fallback), Binance WS aggTrade for
 *   PAXGUSDc, KuCoin WS for BNBUSD; CoinGecko/Kraken/KuCoin HTTP as backup.
 *   Binance/Kraken PAXG feeds ONLY the PAXGUSDc token symbol — never XAUUSD.
 * Sources race on startup (whichever delivers first wins) and the feed
 * auto-switches when the active source stalls; every source feeds the same
 * quote/tick pipeline so switching never resets the chart.
 * Feed states: LIVE (real ticking) / FALLBACK (real, secondary source) /
 *              CLOSED (market closed) / OFFLINE (source down, last price shown)
 *              / LOADING (no quote yet).
 * XAUUSD/XAGUSD follow REAL spot-metal market hours (cTrader/MT5 behaviour):
 * OPEN Sun 22:00 UTC -> Fri 21:00 UTC, DAILY BREAK 21:00-22:00 UTC Mon-Fri,
 * CLOSED weekends. While closed, no ticks flow into quotes/candles — the
 * chart freezes at the last tick with a CLOSED badge and overlay.
 * FX is closed on weekends (Sat all day; Sun before 22:00 UTC).
 * HISTORY: spot/fx intraday candles (M1..H4) = relay seed + local M1 cache
 * (360 candles/symbol, painted instantly on open) merged with real live
 * Swissquote ticks (live wins on overlap). The first live candle renders as
 * soon as it exists — no two-bucket wait. Relay 404/stale/error is an
 * honest live-building fallback — never seeded from another instrument,
 * never simulated. D1+ history: FX from Frankfurter (ECB
 * reference rates, real), XAUUSD/XAGUSD from Yahoo daily spot. Crypto D1+
 * from CoinGecko/Kraken as before.
 */
(function () {
  "use strict";

  var G = typeof window !== "undefined" ? window : globalThis;

  /* ---------------- symbol configuration ---------------- */
  // kind: "live" = 24/7 ticking crypto/PAXG, "fx" = daily anchors, closed Sat/Sun
    /* ---------------- symbol configuration ---------------- */
  // v5.21: EVERY symbol is live spot. XAUUSD/XAGUSD and all FX pairs stream
  // real Swissquote bank spot quotes (2s hot / 20s warm poll); crypto keeps
  // its live exchange feeds. No proxies, no indicative feeds anywhere.
  // kind: "spot" = Swissquote spot metals, "fx" = Swissquote spot FX,
  //       "live" = 24/7 ticking crypto. The Swissquote instrument code
  // derives from the symbol name: EURUSDc -> EUR/USD, XAUUSDc -> XAU/USD.
  var SYMS = {
    XAUUSDc: { kind: "spot", yahoo: "XAUUSD=X", digits: 2, spreadPts: 26, cat: "metals" },
    XAGUSDc: { kind: "spot", yahoo: "XAGUSD=X", digits: 3, spreadPts: 30, cat: "metals" },
    // crypto majors: CoinGecko primary + Kraken (WS + fast HTTP + OHLC).
    // DOGE/LTC use Kraken's canonical pair codes (XDGUSD/XLTCZUSD).
    BTCUSDc: { kind: "live", cg: "bitcoin",   kraken: ["XXBTZUSD", "XBTUSD"], cb: "BTC-USD", digits: 2, spreadPts: 1000, cat: "crypto" },
    ETHUSDc: { kind: "live", cg: "ethereum",  kraken: ["XETHZUSD", "ETHUSD"], cb: "ETH-USD", digits: 2, spreadPts: 100, cat: "crypto" },
    SOLUSDc: { kind: "live", cg: "solana",    kraken: ["SOLUSD"],             cb: "SOL-USD", digits: 2, spreadPts: 30, cat: "crypto" },
    BNBUSDc: { kind: "live", cg: "binancecoin", kraken: [],                   cb: null,      digits: 2, spreadPts: 60, cat: "crypto" },
    XRPUSDc: { kind: "live", cg: "ripple",    kraken: ["XXRPZUSD"],           cb: "XRP-USD", digits: 4, spreadPts: 8, cat: "crypto" },
    DOGEUSDc: { kind: "live", cg: "dogecoin",     kraken: ["XDGUSD"],   cb: null, digits: 4, spreadPts: 8,  cat: "crypto" },
    ADAUSDc:  { kind: "live", cg: "cardano",      kraken: ["ADAUSD"],   cb: null, digits: 4, spreadPts: 12, cat: "crypto" },
    AVAXUSDc: { kind: "live", cg: "avalanche-2",  kraken: ["AVAXUSD"],  cb: null, digits: 2, spreadPts: 40, cat: "crypto" },
    LINKUSDc: { kind: "live", cg: "chainlink",    kraken: ["LINKUSD"],  cb: null, digits: 2, spreadPts: 20, cat: "crypto" },
    TONUSDc:  { kind: "live", cg: "the-open-network", kraken: ["TONUSD"], cb: null, digits: 3, spreadPts: 10, cat: "crypto" },
    TRXUSDc:  { kind: "live", cg: "tron",         kraken: ["TRXUSD"],   cb: null, digits: 4, spreadPts: 6,  cat: "crypto" },
    DOTUSDc:  { kind: "live", cg: "polkadot",     kraken: ["DOTUSD"],   cb: null, digits: 3, spreadPts: 15, cat: "crypto" },
    LTCUSDc:  { kind: "live", cg: "litecoin",     kraken: ["XLTCZUSD"], cb: null, digits: 2, spreadPts: 60, cat: "crypto" },
    NEARUSDc: { kind: "live", cg: "near",         kraken: ["NEARUSD"],  cb: null, digits: 3, spreadPts: 12, cat: "crypto" },
    UNIUSDc:  { kind: "live", cg: "uniswap",      kraken: ["UNIUSD"],   cb: null, digits: 3, spreadPts: 12, cat: "crypto" },
    ATOMUSDc: { kind: "live", cg: "cosmos",       kraken: ["ATOMUSD"],  cb: null, digits: 3, spreadPts: 12, cat: "crypto" },
    ARBUSDc:  { kind: "live", cg: "arbitrum",     kraken: ["ARBUSD"],   cb: null, digits: 4, spreadPts: 10, cat: "crypto" },
    OPUSDc:   { kind: "live", cg: "optimism",     kraken: ["OPUSD"],    cb: null, digits: 4, spreadPts: 10, cat: "crypto" },
    SUIUSDc:  { kind: "live", cg: "sui",          kraken: ["SUIUSD"],   cb: null, digits: 4, spreadPts: 10, cat: "crypto" },
    PAXGUSDc: { kind: "live", cg: "pax-gold",     kraken: ["PAXGUSD"],  cb: "PAXG-USD", digits: 2, spreadPts: 60, cat: "crypto" }
  };
  // FX majors + liquid crosses — all live Swissquote spot. USDCNY is NOT
  // covered by the Swissquote feed and is deliberately absent (no dead
  // symbols). The instrument code derives from the symbol (EURUSDc->EUR/USD).
  var FX_SPOT = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
    "EURGBP", "EURJPY", "GBPJPY", "EURCHF", "AUDJPY", "CADJPY", "EURAUD", "GBPAUD", "AUDCAD", "NZDJPY", "CHFJPY", "EURCAD",
    "USDSEK", "USDNOK", "USDSGD", "USDHKD", "EURNZD", "GBPNZD", "GBPCHF", "GBPCAD", "AUDCHF", "AUDNZD", "CADCHF", "NZDCHF"];
  FX_SPOT.forEach(function (p) {
    var jpy = p.slice(0, 3) === "JPY" || p.slice(3, 6) === "JPY";
    SYMS[p + "c"] = { kind: "fx", digits: jpy ? 3 : 5, spreadPts: jpy ? 14 : 15, cat: "forex" };
  });
  var LIVE_IDS = ["bitcoin", "ethereum", "solana", "binancecoin", "ripple", "pax-gold",
    "dogecoin", "cardano", "avalanche-2", "chainlink", "the-open-network", "polkadot", "litecoin",
    "tron", "near", "uniswap", "cosmos", "arbitrum", "optimism", "sui"].join(",");
  var TF_MS = { M1: 60000, M5: 300000, M15: 900000, M30: 1800000, H1: 3600000, H4: 14400000, D1: 86400000, W1: 604800000 };
  // v5.8 (audit C05): W1 buckets start Monday 00:00 UTC, not Thursday.
  // Unix epoch 0 was a Thursday; Monday 1970-01-05 00:00 UTC = +345600000ms.
  var WEEK_MON_ANCHOR = 345600000;
  function slotStart(t, tfMs) {
    if (tfMs === TF_MS.W1) return Math.floor((t - WEEK_MON_ANCHOR) / TF_MS.W1) * TF_MS.W1 + WEEK_MON_ANCHOR;
    return Math.floor(t / tfMs) * tfMs;
  }
  function slotAligned(t, tfMs) {
    if (!(tfMs > 0)) return true;
    if (tfMs === TF_MS.W1) return (t - WEEK_MON_ANCHOR) % TF_MS.W1 === 0;
    return t % tfMs === 0;
  }
  var POLL_MS = 20000; /* 20s: fastest sustainable cadence w/o risking CoinGecko blocks; backoff retained */          // base crypto poll cadence
  var FAST_POLL_MS = 2000;  // Kraken batched ticker: 1 req / 2s = 30 req/min, well within public limits
  var BNB_POLL_MS = 4000;   // KuCoin BNB-USDT ticker (Kraken doesn't list BNB)
  var FAST_STALE_MS = 45000; // fast-lane quote older than this loses its LIVE badge (honest degradation)
  var krakenFastBusy = false, bnbFastBusy = false; // skip a tick if the previous request is still in flight
  var IDX_POLL_MS = 60000; // Yahoo indices/metals: 5 symbols, 1 req each per minute
  // ---- websocket streaming (primary) ----
  var WS = (typeof G.WebSocket !== "undefined") ? G.WebSocket : null;
  // WS endpoint map — overridable BEFORE start() for QA via
  // window.__FEED_WS_OVERRIDE = {binance:"ws://127.0.0.1:port"} or at runtime
  // via FEED.__test.wsUrl(name, url). Production URLs are the defaults.
  var WS_URLS = {
    kraken: "wss://ws.kraken.com/v2",
    binance: "wss://stream.binance.com:9443/ws/paxgusdt@aggTrade"
  };
  try {
    if (G.__FEED_WS_OVERRIDE) for (var __wsk in G.__FEED_WS_OVERRIDE) WS_URLS[__wsk] = G.__FEED_WS_OVERRIDE[__wsk];
  } catch (e) {}
  var krakenWs = null, krakenWsAlive = false, krakenWsLastMsg = 0,
      krakenWsBackoff = 1000, krakenWsTimer = null, krakenWsAttempt = 0;
  var kucoinWs = null, kucoinWsAlive = false, kucoinWsLastMsg = 0,
      kucoinWsBackoff = 1000, kucoinWsTimer = null, kucoinPingTimer = null, kucoinWsAttempt = 0;
  // ---- Binance WS: live tick source for the PAXGUSDc token (PAXGUSDT aggTrade).
  // Kraken PAXG/USD spot is thin (~7 trades/10 min): no rendering trick can
  // make M1 look live from that. Binance PAXGUSDT (VARA-licensed, reachable
  // from the UAE) delivers dense sub-second ticks. Kraken WS + CoinGecko HTTP
  // stay as automatic fallbacks for PAXGUSDc. XAUUSD NEVER touches this
  // stream — it is Swissquote spot, exclusive.
  var binWs = null, binWsAlive = false, binWsLastMsg = 0,
      binWsBackoff = 1000, binWsTimer = null, binWsAttempt = 0;
  var WS_SILENT_MS = 30000; // WS open but no message this long -> reconnect
  // v5.21: PAXG/USD never maps to XAUUSDc — XAUUSD is Swissquote spot,
  // exclusive. Binance WS PAXGUSDT feeds PAXGUSDc only; Kraken PAXG feeds
  // PAXGUSDc when Binance is down.
  var KRAKEN_WS_SYMS = { "XBT/USD": "BTCUSDc", "ETH/USD": "ETHUSDc", "SOL/USD": "SOLUSDc", "XRP/USD": "XRPUSDc",
    "DOGE/USD": "DOGEUSDc", "ADA/USD": "ADAUSDc", "AVAX/USD": "AVAXUSDc", "LINK/USD": "LINKUSDc", "DOT/USD": "DOTUSDc",
    "LTC/USD": "LTCUSDc", "TRX/USD": "TRXUSDc", "NEAR/USD": "NEARUSDc", "UNI/USD": "UNIUSDc", "ATOM/USD": "ATOMUSDc",
    "ARB/USD": "ARBUSDc", "OP/USD": "OPUSDc", "SUI/USD": "SUIUSDc", "TON/USD": "TONUSDc" };

  /* ---------------- state ---------------- */
  var quotes = {};      // sym -> {bid,ask,mid,digits[,proxy]}
  var states = {};      // sym -> LIVE|DAILY|CLOSED|OFFLINE|LOADING
  var lastOk = {};      // sym -> ms timestamp of last good quote
  var sourceOf = {};    // sym -> "swissquote"|"coingecko"|"kraken"|"kraken-ws"|"coinbase"|"kucoin"|"binance"|"binance-ws"|"yahoo"|"frankfurter"
  var tickBuf = {};     // sym -> [{t, mid}] ring buffer for M1..M30 aggregation
  var histCache = {};   // sym -> { tf -> {candles, at} }
  var histPending = {}; // "sym|tf" -> true
  var cgBackoffUntil = 0, cgFails = 0;
  var started = false;
  // v5.21 spot machinery
  var spotHotExtra = {}; // sym -> true: charted symbol joins the 2s hot poll (FEED.setHot)
  var spotBusy = {};     // sym -> true while a Swissquote request is in flight

  Object.keys(SYMS).forEach(function (s) { states[s] = "LOADING"; tickBuf[s] = []; });

  function roundTo(v, d) {
    var p = Math.pow(10, d);
    return Math.round(v * p) / p;
  }

  function applyQuote(sym, mid, source) {
    var cfg = SYMS[sym];
    // v5.20: spot-metal market hours (cTrader parity) — while XAUUSD/XAGUSD
    // is closed (daily 21:00-22:00 UTC break, weekends) NO ticks may flow
    // into its quotes, tick buffer, or candles. The chart freezes at the last
    // tick and quotes keep the last price with the CLOSED badge.
    if ((sym === "XAUUSDc" || sym === "XAGUSDc") && isGoldClosed()) return null;
    if (!tickOk(sym, mid)) { badTicks[sym] = (badTicks[sym] || 0) + 1; return null; }
    var spread = cfg.spreadPts * Math.pow(10, -cfg.digits);
    var q = { bid: roundTo(mid - spread / 2, cfg.digits), ask: roundTo(mid + spread / 2, cfg.digits), mid: roundTo(mid, cfg.digits), digits: cfg.digits };
    var px = cfg.proxy;
    if (px) q.proxy = px;
    quotes[sym] = q;
    lastOk[sym] = Date.now();
    sourceOf[sym] = source;
    if (cfg.kind === "live" || cfg.kind === "spot" || cfg.kind === "fx") states[sym] = "LIVE";
    var buf = tickBuf[sym];
    buf.push({ t: Date.now(), mid: mid });
    tickDirty[sym] = true; // v5.3: persist M1 candles for instant reopen
    // v5.21: deeper buffers for spot (intraday candles aggregate from ticks):
    // spot 30000 ticks (~17h at 2s), fx 15000 (~83h at 20s), crypto 3000.
    var cap = cfg.kind === "spot" ? 30000 : cfg.kind === "fx" ? 15000 : 3000;
    if (buf.length > cap) buf.splice(0, buf.length - cap);
    if (typeof api.onTick === "function") {
      try { api.onTick(sym, q); } catch (e) { /* never let UI break the feed */ }
    }
    return q;
  }

  /* ---- bad-tick rejection (v5.17): a single malformed tick must never
     spike a candle, the tick chart, or the DOM. A tick is rejected when it
     deviates more than 0.5% from the rolling median of the last accepted
     ticks, unless 4 consecutive ticks confirm the new level (genuine fast
     move — e.g. a genuine fast gold spike — still flows through). ---- */
  var tickMed = {}, tickPend = {}, badTicks = {};
  function medOf(a) {
    var s = a.slice().sort(function (x, y) { return x - y; });
    var n = s.length, h = Math.floor(n / 2);
    return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }
  function tickOk(sym, mid) {
    if (!isFinite(mid) || mid <= 0) return false;
    var win = tickMed[sym]; if (!win) win = tickMed[sym] = [];
    if (win.length < 12) { win.push(mid); return true; }  // warm-up seed
    var m = medOf(win), dev = Math.abs(mid - m) / m;
    if (dev <= 0.005) {
      tickPend[sym] = null;
      win.push(mid); if (win.length > 60) win.shift();
      return true;
    }
    var p = tickPend[sym];
    if (p && Math.abs(mid - p.mid) / p.mid <= 0.005) {
      p.n++;
      if (p.n >= 4) { tickMed[sym] = [mid, mid, mid]; tickPend[sym] = null; return true; }
      return false;
    }
    tickPend[sym] = { mid: mid, n: 1 };
    return false;
  }

  function markOffline(sym) {
    if (quotes[sym]) states[sym] = "OFFLINE";
    else states[sym] = "LOADING";
  }

  /* ---------------- http helper ---------------- */
  function fetchJson(url, timeoutMs) {
    var ctrl = null, timer = null;
    try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
    if (ctrl) timer = setTimeout(function () { try { ctrl.abort(); } catch (e2) {} }, timeoutMs || 10000);
    return G.fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) return { ok: false, status: r.status, data: null };
        return r.json().then(function (j) { return { ok: true, status: r.status, data: j }; },
                              function () { return { ok: false, status: r.status, data: null }; });
      })
      .catch(function () { if (timer) clearTimeout(timer); return { ok: false, status: 0, data: null }; });
  }

  /* ---------------- crypto polling ---------------- */
  function pollCryptoPrimary() {
    if (Date.now() < cgBackoffUntil) return Promise.resolve(false);
    var url = "https://api.coingecko.com/api/v3/simple/price?ids=" + LIVE_IDS + "&vs_currencies=usd";
    return fetchJson(url).then(function (res) {
      if (res.status === 429) {
        cgFails += 1;
        cgBackoffUntil = Date.now() + Math.min(POLL_MS * Math.pow(2, cgFails), 600000);
        return false;
      }
      if (!res.ok || !res.data) return false;
      var got = 0;
      Object.keys(SYMS).forEach(function (sym) {
        var cfg = SYMS[sym];
        if (cfg.kind !== "live") return;
        var row = res.data[cfg.cg];
        // v5.19: never let a slow HTTP leg overwrite a healthy WS primary
        if (row && typeof row.usd === "number" && row.usd > 0 && !wsPrimaryOk(sym)) { applyQuote(sym, row.usd, "coingecko"); got += 1; }
      });
      if (got > 0) { cgFails = 0; return true; }
      return false;
    });
  }

  function pollCryptoKraken() {
    // one batched request covers every live symbol Kraken lists (built from
    // each symbol's canonical Kraken pair code; BNB has none and is skipped)
    var pairs = [];
    Object.keys(SYMS).forEach(function (sym) {
      var cfg = SYMS[sym];
      if (cfg.kind === "live" && cfg.kraken && cfg.kraken.length && pairs.indexOf(cfg.kraken[0]) < 0) pairs.push(cfg.kraken[0]);
    });
    if (!pairs.length) return Promise.resolve(false);
    var url = "https://api.kraken.com/0/public/Ticker?pair=" + pairs.join(",");
    return fetchJson(url).then(function (res) {
      if (!res.ok || !res.data || !res.data.result) return false;
      var r = res.data.result, got = 0;
      Object.keys(SYMS).forEach(function (sym) {
        var cfg = SYMS[sym];
        if (cfg.kind !== "live" || !cfg.kraken.length) return;
        if (wsPrimaryOk(sym)) return; // v5.19: healthy WS primary owns this symbol
        for (var i = 0; i < cfg.kraken.length; i++) {
          var row = r[cfg.kraken[i]];
          if (row && row.c && row.c[0]) {
            var p = parseFloat(row.c[0]);
            if (p > 0) { applyQuote(sym, p, "kraken"); got += 1; }
            break;
          }
        }
      });
      return got > 0;
    });
  }

  function pollCryptoCoinbase() {
    var jobs = [];
    Object.keys(SYMS).forEach(function (sym) {
      var cfg = SYMS[sym];
      if (cfg.kind !== "live" || !cfg.cb) return;
      jobs.push(fetchJson("https://api.coinbase.com/v2/prices/" + cfg.cb + "/spot").then(function (res) {
        // v5.19: never let a slow HTTP leg overwrite a healthy WS primary
        if (wsPrimaryOk(sym)) return;
        if (res.ok && res.data && res.data.data && res.data.data.amount) {
          var p = parseFloat(res.data.data.amount);
          if (p > 0) applyQuote(sym, p, "coinbase");
        }
      }));
    });
    if (!jobs.length) return Promise.resolve(false);
    return Promise.all(jobs).then(function () { return true; });
  }

  /* -------- fast lanes: additive, real quotes only -------- */
  // v5.19: a symbol with a HEALTHY dedicated WebSocket is written ONLY by
  // that socket. HTTP fallback legs must never stomp a live WS primary
  // (prevents quote flicker and source flip-flop between binance-ws and the
  // 2s Kraken HTTP poll).
  function wsPrimaryOk(sym) {
    if (sym === "XAUUSDc") return false; // v5.21: Swissquote HTTP poll is XAUUSD's ONLY writer; no WS/HTTP leg may top it up
    if (sym === "PAXGUSDc") return binWsOk() || krakenWsOk(); // token: either WS owns it 24/7
    if (sym === "BNBUSDc") return kucoinWsOk(); // KuCoin BNB ticker
    return krakenWsOk();                        // Kraken WS v2 ticker
  }
  // Batched Kraken ticker: ONE request covers XBT/ETH/SOL/XRP/PAXG (PAXG
  // feeds the PAXGUSDc token symbol only). Reuses the verified
  // pollCryptoKraken parser: result.<PAIR>.c[0] (last trade close) -> mid,
  // per-symbol spread -> bid/ask, applyQuote keeps states LIVE and tickBufs
  // filling for sparklines/M1-M30 candles.
  function pollKrakenFast() {
    // v5.18: a live WS does not mean every pair ticks — thin pairs (PAXG) can
    // go minutes without a trade while BTC/ETH keep the socket "OK". Top up
    // any live symbol whose quote is older than 20s via the batched HTTP
    // ticker (still max 1 request per 2s tick; WS stays primary).
    if (krakenWsOk()) {
      var now = Date.now(), stale = false;
      Object.keys(SYMS).forEach(function (s) {
        // v5.21: XAUUSD is Swissquote-primary (kind "spot"), never topped up here
        if (s === "XAUUSDc") return;
        if (SYMS[s].kind === "live" && SYMS[s].kraken && SYMS[s].kraken.length && !wsPrimaryOk(s) &&
            (!lastOk[s] || now - lastOk[s] > 20000)) stale = true;
      });
      if (!stale) { degradeStaleFast(); return Promise.resolve(true); }
    }
    if (krakenFastBusy) return Promise.resolve(false);
    krakenFastBusy = true;
    return pollCryptoKraken().then(function (ok) {
      krakenFastBusy = false;
      degradeStaleFast();
      return ok;
    }).catch(function () {
      krakenFastBusy = false;
      degradeStaleFast();
      return false;
    });
  }

  // BNB fast lane: Kraken doesn't list BNB, so use KuCoin's public level1
  // ticker (USDT≈USD for display; digits unchanged). If this fails, the
  // existing 20s CoinGecko path keeps BNB fresh automatically.
  function pollBnbFast() {
    if (kucoinWsOk()) return Promise.resolve(true); // WS primary: HTTP is fallback
    if (bnbFastBusy) return Promise.resolve(false);
    bnbFastBusy = true;
    return fetchJson("https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BNB-USDT").then(function (res) {
      bnbFastBusy = false;
      if (res.ok && res.data && res.data.data && res.data.data.price) {
        var p = parseFloat(res.data.data.price);
        if (p > 0) { applyQuote("BNBUSDc", p, "kucoin"); return true; }
      }
      return false;
    }).catch(function () { bnbFastBusy = false; return false; });
  }

  // Honest degradation for the fast lanes: a LIVE badge must mean quotes
  // are actually flowing. If a live symbol's last REAL quote is older than
  // FAST_STALE_MS (fast AND slow lanes silent), drop to OFFLINE/LOADING.
  // Never synthesizes ticks.
  function degradeStaleFast() {
    var now = Date.now();
    Object.keys(SYMS).forEach(function (sym) {
      var k = SYMS[sym].kind;
      if (k !== "live" && k !== "spot" && k !== "fx") return;
      // v5.20: a closed spot-metal market is CLOSED, never OFFLINE — the
      // freeze is honest, not a feed failure.
      if ((sym === "XAUUSDc" || sym === "XAGUSDc") && isGoldClosed()) {
        if (states[sym] !== "CLOSED") states[sym] = "CLOSED";
        return;
      }
      if (k === "fx" && isFxClosed()) {
        if (states[sym] !== "CLOSED") states[sym] = "CLOSED";
        return;
      }
      if (states[sym] === "LIVE" && (!lastOk[sym] || now - lastOk[sym] > FAST_STALE_MS)) {
        markOffline(sym);
      }
    });
  }

  /* ---------------- websocket streaming (PRIMARY) ----------------
     Kraken WS v2 ticker is the primary quote path: real sub-second exchange
     ticks. All HTTP pollers stay as automatic fallback: when the socket is
     down or silent, the 2s/4s/20s pollers keep quotes fresh. Honesty is
     enforced by degradeStaleFast (45s) regardless of transport. */
  function krakenWsOk() { return krakenWsAlive && (Date.now() - krakenWsLastMsg < 15000); }
  function kucoinWsOk() { return kucoinWsAlive && (Date.now() - kucoinWsLastMsg < 30000); }

  function scheduleKrakenWsRetry() {
    if (krakenWsTimer) return;
    krakenWsAttempt++; // v5.4: visible reconnect attempt #
    var wait = Math.min(krakenWsBackoff, 60000);
    krakenWsBackoff = Math.min(krakenWsBackoff * 2, 60000);
    krakenWsTimer = setTimeout(function () { krakenWsTimer = null; startKrakenWs(); }, wait);
  }

  function startKrakenWs() {
    if (!WS) return; // no WebSocket support: HTTP fallback carries on
    try { if (krakenWs && krakenWs.readyState < 2) { try { krakenWs.close(); } catch (e) {} } } catch (e2) {}
    var ws;
    try { ws = new WS(WS_URLS.kraken); } catch (e) { scheduleKrakenWsRetry(); return; }
    krakenWs = ws;
    ws.onopen = function () {
      krakenWsBackoff = 1000;
      try {
        // v5.21: PAXG/USD is subscribed but NOT mapped — it only reaches
        // PAXGUSDc through the paxP fallback gate below (never stomps XAUUSD).
        ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: Object.keys(KRAKEN_WS_SYMS).concat(["PAXG/USD"]), snapshot: true } }));
      } catch (e) {}
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      krakenWsLastMsg = Date.now(); krakenWsAttempt = 0;
      if (m.channel === "ticker" && (m.type === "update" || m.type === "snapshot") && Array.isArray(m.data)) {
        var paxP = 0; // v5.20: PAXG/USD also feeds the 24/7 PAXGUSDc token symbol
        for (var i = 0; i < m.data.length; i++) {
          var d = m.data[i], sym = KRAKEN_WS_SYMS[d.symbol];
          var p = d ? parseFloat(d.last) : NaN;
          if (d.symbol === "PAXG/USD" && p > 0) paxP = p;
          if (sym && p > 0) {
            applyQuote(sym, p, "kraken-ws"); krakenWsAlive = true;
          }
        }
        // Binance WS owns the PAXG token stream while healthy; Kraken is its
        // fallback (applyQuote itself gates XAUUSDc while gold is closed).
        if (paxP > 0 && !binWsOk()) { applyQuote("PAXGUSDc", paxP, "kraken-ws"); krakenWsAlive = true; }
      }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () { krakenWsAlive = false; scheduleKrakenWsRetry(); };
  }

  function scheduleKucoinWsRetry() {
    if (kucoinWsTimer) return;
    kucoinWsAttempt++; // v5.4: visible reconnect attempt #
    var wait = Math.min(kucoinWsBackoff, 60000);
    kucoinWsBackoff = Math.min(kucoinWsBackoff * 2, 60000);
    kucoinWsTimer = setTimeout(function () { kucoinWsTimer = null; startKucoinWs(); }, wait);
  }

  function startKucoinWs() {
    if (!WS) return;
    // public WS bootstrap: token + endpoint (no auth needed for public tickers)
    fetchJson("https://api.kucoin.com/api/v1/bullet-public", 10000).then(function (res) {
      var d = res.ok && res.data && res.data.data;
      var srv = d && d.instanceServers && d.instanceServers[0];
      if (!d || !d.token || !srv || !srv.endpoint) { scheduleKucoinWsRetry(); return; }
      var url = srv.endpoint + "?token=" + encodeURIComponent(d.token) + "&connectId=" + Math.floor(Math.random() * 1e9);
      var ws;
      try { ws = new WS(url); } catch (e) { scheduleKucoinWsRetry(); return; }
      kucoinWs = ws;
      var pingIv = Math.max(10000, (srv.pingInterval || 18000) - 2000);
      ws.onopen = function () {
        kucoinWsBackoff = 1000;
        try { ws.send(JSON.stringify({ id: Date.now(), type: "subscribe", topic: "/market/ticker:BNB-USDT", privateChannel: false, response: true })); } catch (e) {}
        if (kucoinPingTimer) clearInterval(kucoinPingTimer);
        kucoinPingTimer = setInterval(function () { try { ws.send(JSON.stringify({ id: Date.now(), type: "ping" })); } catch (e2) {} }, pingIv);
      };
      ws.onmessage = function (ev) {
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        kucoinWsLastMsg = Date.now(); kucoinWsAttempt = 0;
        if (m.type === "message" && m.topic === "/market/ticker:BNB-USDT" && m.data && m.data.price) {
          var p = parseFloat(m.data.price);
          if (p > 0) { applyQuote("BNBUSDc", p, "kucoin-ws"); kucoinWsAlive = true; }
        }
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
      ws.onclose = function () {
        kucoinWsAlive = false;
        if (kucoinPingTimer) { clearInterval(kucoinPingTimer); kucoinPingTimer = null; }
        scheduleKucoinWsRetry();
      };
    }).catch(function () { scheduleKucoinWsRetry(); });
  }

  function binWsOk() { return binWsAlive && (Date.now() - binWsLastMsg < 20000); }

  function scheduleBinWsRetry() {
    if (binWsTimer) return;
    binWsAttempt++; // v5.4: visible reconnect attempt #
    var wait = Math.min(binWsBackoff, 60000);
    binWsBackoff = Math.min(binWsBackoff * 2, 60000);
    binWsTimer = setTimeout(function () { binWsTimer = null; startBinWs(); }, wait);
  }

  // Binance PAXGUSDT aggTrade stream. Message: {e:"aggTrade", s:"PAXGUSDT",
  // p:"4140.12" (price), q:"...", T:1695...}. Browser WebSocket answers
  // Binance ping frames at protocol level; no app-level ping needed.
  function startBinWs() {
    if (!WS) return; // no WebSocket support: HTTP fallback carries on
    try { if (binWs && binWs.readyState < 2) { try { binWs.close(); } catch (e) {} } } catch (e2) {}
    var ws;
    try { ws = new WS(WS_URLS.binance); } catch (e) { scheduleBinWsRetry(); return; }
    binWs = ws;
    ws.onopen = function () { binWsBackoff = 1000; };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || m.e !== "aggTrade" || !m.p) return; // ignore anything unexpected
      binWsLastMsg = Date.now(); binWsAttempt = 0;
      var p = parseFloat(m.p);
      // v5.21: PAXGUSDT feeds ONLY PAXGUSDc (the 24/7 token). XAUUSD is
      // Swissquote spot, exclusive — this stream never touches XAUUSDc.
      if (p > 0) {
        applyQuote("PAXGUSDc", p, "binance-ws");
        binWsAlive = true;
      }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () { binWsAlive = false; scheduleBinWsRetry(); };
  }

  /* ---------------- Binance kline_1s: authoritative crypto candles (v5.4) ----
     One combined WS streams REAL 1-second exchange candles for every crypto
     symbol (Binance spot). These are the exchange's own candles — no
     client-side tick aggregation, no ghost candles from stalled ticks.
     REST /api/v3/klines backfills gaps on (re)connect (honors 429).
     Kraken WS + HTTP pollers stay as automatic fallback; the kline leg wins
     when fresh. PAXGUSDc included here is the 24/7 token — never XAUUSD. */
  var BIN_KLINE = { BTCUSDc: "BTCUSDT", ETHUSDc: "ETHUSDT", SOLUSDc: "SOLUSDT",
    BNBUSDc: "BNBUSDT", XRPUSDc: "XRPUSDT", DOGEUSDc: "DOGEUSDT",
    ADAUSDc: "ADAUSDT", AVAXUSDc: "AVAXUSDT", LINKUSDc: "LINKUSDT",
    TONUSDc: "TONUSDT", TRXUSDc: "TRXUSDT", DOTUSDc: "DOTUSDT",
    LTCUSDc: "LTCUSDT", NEARUSDc: "NEARUSDT", UNIUSDc: "UNIUSDT",
    ATOMUSDc: "ATOMUSDT", ARBUSDc: "ARBUSDT", OPUSDc: "OPUSDT",
    SUIUSDc: "SUIUSDT", PAXGUSDc: "PAXGUSDT" };
  var BIN_KLINE_BY_STREAM = {};
  Object.keys(BIN_KLINE).forEach(function (s) { BIN_KLINE_BY_STREAM[BIN_KLINE[s].toLowerCase() + "@kline_1s"] = s; });
  WS_URLS.binanceKline = "wss://stream.binance.com:9443/stream?streams=" +
    Object.keys(BIN_KLINE).map(function (s) { return BIN_KLINE[s].toLowerCase() + "@kline_1s"; }).join("/");
  var binKlineWs = null, binKlineAlive = false, binKlineLastMsg = 0,
      binKlineBackoff = 1000, binKlineTimer = null, binKlineAttempt = 0;
  var binKlines = {};        // sym -> [[t_ms,o,h,l,c]...] newest last, cap 3600
  var binKlineGapBusy = {};  // sym -> true while a REST gap-fill is in flight

  function binKlineFresh(sym) {
    var a = binKlines[sym];
    return !!(a && a.length && Date.now() - a[a.length - 1][0] < 45000);
  }

  function binKlinePush(sym, k) {
    // k: Binance kline {t,T,o,h,l,c}. Clock-skew guard: never accept a candle
    // starting >60s in the future (would corrupt the whole series).
    var t = +k.t;
    if (!isFinite(t) || t <= 0 || t > Date.now() + 60000) return;
    var d = SYMS[sym].digits;
    var c = [t, roundTo(parseFloat(k.o), d), roundTo(parseFloat(k.h), d),
             roundTo(parseFloat(k.l), d), roundTo(parseFloat(k.c), d)];
    if (!saneOhlc(c)) return;
    var a = binKlines[sym] || (binKlines[sym] = []);
    var last = a[a.length - 1];
    if (last && last[0] === t) a[a.length - 1] = c;       // update forming candle
    else if (!last || t > last[0]) { a.push(c); if (a.length > 3600) a.splice(0, a.length - 3600); }
    // older than the newest stored candle: drop. Late WS messages never
    // rewrite history — REST gap-fill is the correction path.
    var px = parseFloat(k.c);
    if (px > 0) applyQuote(sym, px, "binance-kline");
  }

  // REST gap-fill: fetch 1s klines from the last stored candle to now.
  // Called on WS (re)connect and when the leg goes stale.
  function binKlineGapFill(sym) {
    if (binKlineGapBusy[sym]) return;
    var bs = BIN_KLINE[sym];
    if (!bs) return;
    binKlineGapBusy[sym] = true;
    var a = binKlines[sym], lastT = a && a.length ? a[a.length - 1][0] : 0;
    var url = "https://api.binance.com/api/v3/klines?symbol=" + bs + "&interval=1s&limit=1000" +
              (lastT > 0 ? "&startTime=" + (lastT + 1) : "");
    fetchJson(url, 15000).then(function (res) {
      binKlineGapBusy[sym] = false;
      if (res.status === 429) return; // honor the limit: keep WS data, retry later
      if (!res.ok || !Array.isArray(res.data)) return;
      var d = SYMS[sym].digits, arr = binKlines[sym] || (binKlines[sym] = []);
      for (var i = 0; i < res.data.length; i++) {
        var r = res.data[i], t = +r[0];
        if (!isFinite(t) || t <= 0 || t > Date.now() + 60000) continue;
        var c = [t, roundTo(parseFloat(r[1]), d), roundTo(parseFloat(r[2]), d),
                 roundTo(parseFloat(r[3]), d), roundTo(parseFloat(r[4]), d)];
        if (!saneOhlc(c)) continue;
        var l = arr[arr.length - 1];
        if (l && l[0] === t) arr[arr.length - 1] = c;
        else if (!l || t > l[0]) { arr.push(c); if (arr.length > 3600) arr.splice(0, arr.length - 3600); }
      }
    }).catch(function () { binKlineGapBusy[sym] = false; });
  }

  function scheduleBinKlineWsRetry() {
    if (binKlineTimer) return;
    binKlineAttempt++;
    var wait = Math.min(binKlineBackoff, 60000);
    binKlineBackoff = Math.min(binKlineBackoff * 2, 60000);
    wait = Math.round(wait * (0.75 + Math.random() * 0.5)); // jitter: no thundering herd
    binKlineTimer = setTimeout(function () { binKlineTimer = null; startBinKlineWs(); }, wait);
  }

  function startBinKlineWs() {
    if (!WS) return; // no WebSocket support: HTTP fallback carries on
    try { if (binKlineWs && binKlineWs.readyState < 2) { try { binKlineWs.close(); } catch (e) {} } } catch (e2) {}
    var ws;
    try { ws = new WS(WS_URLS.binanceKline); } catch (e) { scheduleBinKlineWsRetry(); return; }
    binKlineWs = ws;
    ws.onopen = function () {
      binKlineBackoff = 1000;
      // gap-fill every symbol, staggered 250ms (21 syms x weight 2 = 42,
      // far under the 6000/min budget)
      var syms = Object.keys(BIN_KLINE), i = 0;
      (function next() {
        if (i >= syms.length) return;
        binKlineGapFill(syms[i++]);
        setTimeout(next, 250);
      })();
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      var d = m && m.data, k = d && d.k;
      if (!d || d.e !== "kline" || !k) return;
      binKlineLastMsg = Date.now();
      binKlineAlive = true;
      binKlineAttempt = 0;
      var sym = BIN_KLINE_BY_STREAM[m.stream]; // combined-stream envelope: name is outer
      if (sym) binKlinePush(sym, k);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () { binKlineAlive = false; scheduleBinKlineWsRetry(); };
  }

  // resample fresh 1s klines to the requested TF; null when the leg is stale
  // (the caller falls back to tick-bucketized candles).
  function binKlineLive(sym, tfMs) {
    if (!binKlineFresh(sym)) return null;
    var r = resample(binKlines[sym], tfMs);
    return (r && r.length) ? r : null;
  }

  // watchdog: open-but-silent sockets get closed so onclose -> backoff retry
  function wsWatchdog() {
    if (!WS) return;
    var now = Date.now();
    if (krakenWs && krakenWs.readyState < 2 && now - krakenWsLastMsg > WS_SILENT_MS) {
      try { krakenWs.close(); } catch (e) {}
    }
    if (binWs && binWs.readyState < 2 && now - binWsLastMsg > WS_SILENT_MS) {
      try { binWs.close(); } catch (e) {}
    }
    if (kucoinWs && kucoinWs.readyState < 2 && now - kucoinWsLastMsg > WS_SILENT_MS) {
      try { kucoinWs.close(); } catch (e) {}
    }
    if (binKlineWs && binKlineWs.readyState < 2 && now - binKlineLastMsg > WS_SILENT_MS) {
      try { binKlineWs.close(); } catch (e) {}
    }
  }

  /* ---------------- indices & metals via Yahoo (periodic, honest) ----------------
     Real 1m quotes + real OHLC history from Yahoo Finance. Refreshed every
     60s and badged DAILY while markets are open / CLOSED on weekends — never
     presented as live ticks. */
  function yahooLastPx(data) {
    try {
      var r = data.chart.result[0];
      var m = r.meta;
      if (m && typeof m.regularMarketPrice === "number" && m.regularMarketPrice > 0) return m.regularMarketPrice;
      var q = r.indicators.quote[0].close;
      for (var i = q.length - 1; i >= 0; i--) {
        if (typeof q[i] === "number" && q[i] > 0) return q[i];
      }
    } catch (e) {}
    return 0;
  }

  function pollIdx() {
    var jobs = [];
    Object.keys(SYMS).forEach(function (sym) {
      var cfg = SYMS[sym];
      if (cfg.kind !== "idx" || !cfg.yahoo) return;
      var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(cfg.yahoo) + "?interval=1m&range=1d";
      jobs.push(fetchJson(url, 12000).then(function (res) {
        var px = res.ok ? yahooLastPx(res.data) : 0;
        if (px > 0) {
          applyQuote(sym, px, "yahoo");
          states[sym] = isFxClosed() ? "CLOSED" : "DAILY";
        } else if (!quotes[sym]) {
          states[sym] = "LOADING";
        } else if (states[sym] !== "CLOSED") {
          states[sym] = "OFFLINE";
        }
      }).catch(function () {
        if (!quotes[sym]) states[sym] = "LOADING";
        else if (states[sym] !== "CLOSED") states[sym] = "OFFLINE";
      }));
    });
    if (!jobs.length) return Promise.resolve(false);
    return Promise.all(jobs).then(function () { return true; });
  }

  function idxHistory(sym, tf) {
    var cfg = SYMS[sym];
    if (!cfg.yahoo) return Promise.resolve(null);
    var spec = null;
    if (tf === "M15" || tf === "M30") spec = ["15m", "1mo"];
    else if (tf === "H1" || tf === "H4") spec = ["1h", "3mo"];
    else if (tf === "D1" || tf === "W1") spec = ["1d", "2y"];
    else if (tf === "MN") spec = ["1d", "5y"];
    else return Promise.resolve(null);
    var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(cfg.yahoo) + "?interval=" + spec[0] + "&range=" + spec[1];
    return fetchJson(url, 15000).then(function (res) {
      var candles = null;
      try {
        var r = res.data.chart.result[0];
        var ts = r.timestamp, q = r.indicators.quote[0], d = cfg.digits, out = [];
        for (var i = 0; i < ts.length; i++) {
          if (typeof q.close[i] !== "number") continue;
          var c = q.close[i];
          out.push([ts[i] * 1000, roundTo(q.open[i] || c, d), roundTo(q.high[i] || c, d), roundTo(q.low[i] || c, d), roundTo(c, d)]);
        }
        candles = out;
      } catch (e) { return null; }
      if (!candles || !candles.length) return null;
      if (tf === "M30") return resample(candles, TF_MS.M30);
      if (tf === "H4") return resample(candles, TF_MS.H4);
      if (tf === "W1") return resample(candles, TF_MS.W1);
      if (tf === "MN") return aggregateMonthly(candles);
      return candles;
    }).catch(function () { return null; });
  }

  function pollCrypto() {
    return pollCryptoPrimary().then(function (ok) {
      if (ok) return;
      return pollCryptoKraken().then(function (ok2) {
        if (ok2) return;
        return pollCryptoCoinbase().then(function () {
          Object.keys(SYMS).forEach(function (sym) {
            // v5.20: a closed gold market stays CLOSED — never flipped to OFFLINE by a poller
            if (sym === "XAUUSDc" && isGoldClosed()) { if (states[sym] !== "CLOSED") states[sym] = "CLOSED"; return; }
            if (SYMS[sym].kind === "live" && states[sym] === "LOADING") markOffline(sym);
            else if (SYMS[sym].kind === "live" && !lastOk[sym]) markOffline(sym);
          });
        });
      });
    }).catch(function () {
      Object.keys(SYMS).forEach(function (sym) {
        if (sym === "XAUUSDc" && isGoldClosed()) { if (states[sym] !== "CLOSED") states[sym] = "CLOSED"; return; }
        if (SYMS[sym].kind === "live") markOffline(sym);
      });
    });
  }

  /* ---------------- FX daily anchors ----------------
     Spot FX market hours (honest): OPEN Sunday 22:00 UTC through Friday
     21:00 UTC. Closed all of Saturday, Sunday before 22:00, and Friday
     from 21:00. Accepts an optional epoch-ms for deterministic tests. */
  function isFxClosed(nowMs) {
    var d = nowMs != null ? new Date(nowMs) : new Date();
    var day = d.getUTCDay(), mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (day === 6) return true;            // all Saturday
    if (day === 0) return mins < 22 * 60;  // Sunday before 22:00 UTC
    if (day === 5) return mins >= 21 * 60;  // Friday from 21:00 UTC
    return false;
  }

  /* ---------------- spot-gold market hours (v5.20) ----------------
     XAUUSD follows real spot-gold hours like cTrader/MT5: OPEN Sunday 22:00
     UTC through Friday 21:00 UTC, with a DAILY BREAK 21:00-22:00 UTC
     Monday-Friday (liquidity providers pause — this is the "Market closed"
     Dawood saw on cTrader at 21:51 UTC), CLOSED all weekend. While closed,
     applyQuote rejects every XAUUSD tick so quotes, buffers, and candles
     freeze at the last tick; the UI shows the CLOSED badge + overlay.
     Accepts an optional epoch-ms for deterministic tests. */
  function isGoldClosed(nowMs) {
    var d = nowMs != null ? new Date(nowMs) : new Date();
    var day = d.getUTCDay(), mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (day === 6) return true;             // Saturday
    if (day === 0) return mins < 22 * 60;   // Sunday before 22:00 UTC
    if (day === 5) return mins >= 21 * 60;  // Friday from 21:00 UTC (weekend)
    return mins >= 21 * 60 && mins < 22 * 60; // daily break Mon-Thu
  }

  // Machine-readable gold session for the chart overlay + badges.
  // {closed, reason:"break"|"weekend"|null, reopensAt:ms, reopenLabel}
  function goldStatus(nowMs) {
    var now = nowMs != null ? nowMs : Date.now();
    if (!isGoldClosed(now)) return { closed: false, reason: null, reopensAt: 0, reopenLabel: "" };
    var d = new Date(now), day = d.getUTCDay();
    var y = d.getUTCFullYear(), mo = d.getUTCMonth(), dt = d.getUTCDate();
    var reason, rDay;
    if (day >= 1 && day <= 4) { reason = "break"; rDay = dt; }          // Mon-Thu break -> 22:00 today
    else if (day === 5) { reason = "weekend"; rDay = dt + 2; }          // Friday -> Sunday
    else if (day === 6) { reason = "weekend"; rDay = dt + 1; }          // Saturday -> Sunday
    else { reason = "weekend"; rDay = dt; }                             // Sunday -> 22:00 today
    var r = Date.UTC(y, mo, rDay, 22, 0, 0);
    var rl = reason === "break" ? "22:00 UTC" : "Sunday 22:00 UTC";
    return { closed: true, reason: reason, reopensAt: r, reopenLabel: rl };
  }

  /* ---------------- Swissquote live spot (v5.21 PRIMARY) ----------------
     Real bank spot quotes for XAUUSD, XAGUSD and every FX pair. One HTTP
     call per instrument:
       https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/{BASE}/{QUOTE}
     Response: [{spreadProfilePrices:[{spreadProfile,bid,ask}...], ts}].
     The "standard" spread profile is preferred, else the first profile.
     ts is epoch ms — a quote older than 30s is rejected and never presented
     as live. Hot set polls every 2s (metals, majors, charted symbol); the
     warm set polls every 20s (all other pairs). No proxies, no indicative
     feeds, no simulated ticks anywhere. */
  // v5.3: polite staggered Swissquote scheduler. v5.2 fired 8-symbol BURSTS
  // every 2s (~6 requests/second sustained) and Swissquote rate-limited the
  // device into tick starvation: frozen quotes, zero candles, "Building live
  // history..." forever. One rotating queue now: tier1 (charted + metals)
  // every 2s, tier2 (majors) every 10s, tier3 (rest) every 60s — max 2
  // requests per 1s tick, never a burst. Any 429/5xx triggers a global
  // cooldown (30s, doubling to 5min): we back off instead of hammering.
  var SPOT_HOT = ["XAUUSDc", "XAGUSDc", "EURUSDc", "GBPUSDc", "USDJPYc", "USDCHFc", "AUDUSDc", "USDCADc"];
  var SPOT_MAJOR = ["EURUSDc", "GBPUSDc", "USDJPYc", "USDCHFc", "AUDUSDc", "USDCADc"];
  var sqLastPoll = {};       // sym -> ms of last pollSwissquote attempt
  var sqCooldownUntil = 0;   // global backoff after 429/5xx
  var sqFails = 0;           // consecutive rate-limit hits
  var spotBusyAt = {};       // sym -> ms the in-flight flag was set (anti-wedge)
  function sqTierMs(sym) {
    if (sym === "XAUUSDc" || sym === "XAGUSDc" || spotHotExtra[sym]) return 2000;
    if (SPOT_MAJOR.indexOf(sym) >= 0) return 10000;
    return 60000;
  }
  function sqRateLimited() {
    sqFails++;
    var wait = Math.min(30000 * Math.pow(2, sqFails - 1), 300000);
    sqCooldownUntil = Date.now() + wait;
  }
  function sqTick() {
    var now = Date.now();
    if (now < sqCooldownUntil) return; // backing off — don't hammer a limit
    // anti-wedge: a hung fetch must never stall a symbol forever
    Object.keys(spotBusy).forEach(function (s) {
      if (spotBusy[s] && now - (spotBusyAt[s] || 0) > 20000) spotBusy[s] = false;
    });
    var due = [];
    Object.keys(SYMS).forEach(function (s) {
      var k = SYMS[s].kind;
      if (k !== "spot" && k !== "fx") return;
      if ((s === "XAUUSDc" || s === "XAGUSDc") && isGoldClosed()) { states[s] = "CLOSED"; return; }
      if (k === "fx" && isFxClosed()) { states[s] = "CLOSED"; return; }
      var tier = sqTierMs(s);
      if (!sqLastPoll[s] || now - sqLastPoll[s] >= tier) due.push(s);
    });
    // tier1 first, then by staleness; max 2 per tick — never a burst
    due.sort(function (a, b) { return sqTierMs(a) - sqTierMs(b) || (sqLastPoll[a] || 0) - (sqLastPoll[b] || 0); });
    var n = Math.min(2, due.length);
    for (var i = 0; i < n; i++) {
      sqLastPoll[due[i]] = now;
      try { pollSwissquote(due[i]); } catch (e) { spotBusy[due[i]] = false; }
    }
    degradeStaleFast();
  }
  var SWISSQUOTE_MAX_AGE_MS = 30000;

  // EURUSDc -> "EUR/USD" (the Swissquote instrument code)
  function swissInstr(sym) {
    var p = String(sym).replace(/c$/, "");
    return p.slice(0, 3) + "/" + p.slice(3, 6);
  }

  // v5.21: real Swissquote bid/ask straight into the quote — the spread is
  // the bank's, never synthesized from a midpoint.
  // v5.8 C03: ticks carry the SOURCE timestamp (row.ts) plus receipt fallback,
  // and the buffer keeps the bid so candles aggregate on a bid basis.
  function applySpotQuote(sym, bid, ask, source, srcTs) {
    var cfg = SYMS[sym];
    if (!cfg || !(bid > 0) || !(ask > 0) || ask < bid) return null;
    if ((sym === "XAUUSDc" || sym === "XAGUSDc") && isGoldClosed()) return null;
    if (cfg.kind === "fx" && isFxClosed()) return null;
    var mid = (bid + ask) / 2;
    if (!tickOk(sym, mid)) { badTicks[sym] = (badTicks[sym] || 0) + 1; return null; }
    var d = cfg.digits;
    var q = { bid: roundTo(bid, d), ask: roundTo(ask, d), mid: roundTo(mid, d), digits: d };
    var px = cfg.proxy;
    if (px) q.proxy = px;
    quotes[sym] = q;
    lastOk[sym] = (srcTs > 0) ? srcTs : Date.now();
    sourceOf[sym] = source;
    states[sym] = "LIVE";
    var buf = tickBuf[sym];
    buf.push({ t: (srcTs > 0) ? srcTs : Date.now(), bid: roundTo(bid, d), mid: roundTo(mid, d) });
    tickDirty[sym] = true; // v5.3: persist M1 candles for instant reopen
    var cap = cfg.kind === "spot" ? 30000 : 15000;
    if (buf.length > cap) buf.splice(0, buf.length - cap);
    if (typeof api.onTick === "function") {
      try { api.onTick(sym, q); } catch (e) { /* never let UI break the feed */ }
    }
    return q;
  }

  function pollSwissquote(sym) {
    var cfg = SYMS[sym];
    if (!cfg) return Promise.resolve(false);
    // closed markets: freeze, don't poll (no wasted calls, no stale quotes)
    if ((sym === "XAUUSDc" || sym === "XAGUSDc") && isGoldClosed()) {
      if (states[sym] !== "CLOSED") states[sym] = "CLOSED";
      return Promise.resolve(true);
    }
    if (cfg.kind === "fx" && isFxClosed()) {
      if (states[sym] !== "CLOSED") states[sym] = "CLOSED";
      return Promise.resolve(true);
    }
    if (spotBusy[sym]) return Promise.resolve(false);
    spotBusy[sym] = true; spotBusyAt[sym] = Date.now();
    return fetchJson("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/" + swissInstr(sym), 8000).then(function (res) {
      spotBusy[sym] = false;
      if (!res.ok) {
        // v5.3: a 429/5xx is rate limiting — back off globally instead of
        // hammering harder (v5.2's ~6 req/s bursts starved the device of ticks).
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) sqRateLimited();
        return false;
      }
      sqFails = 0; // a success means the limit lifted
      var row = res.ok && res.data && res.data[0];
      var picks = row && row.spreadProfilePrices;
      if (!picks || !picks.length) return false;
      var px = null;
      for (var i = 0; i < picks.length; i++) {
        if (picks[i].spreadProfile === "standard") { px = picks[i]; break; }
      }
      if (!px) px = picks[0];
      var bid = parseFloat(px.bid), ask = parseFloat(px.ask);
      var age = row.ts ? Date.now() - row.ts : Infinity;
      if (!(bid > 0) || !(ask > 0) || age > SWISSQUOTE_MAX_AGE_MS) return false;
      var q = applySpotQuote(sym, bid, ask, "swissquote", row.ts);
      return !!q;
    }).catch(function () { spotBusy[sym] = false; return false; });
  }

  function spotHotList() {
    var out = [], seen = {};
    SPOT_HOT.concat(Object.keys(spotHotExtra)).forEach(function (s) {
      if (SYMS[s] && !seen[s]) { seen[s] = 1; out.push(s); }
    });
    return out;
  }

  function pollSpotHot() {
    // v5.3: burst polling removed (it caused the rate-limit starvation);
    // one staggered scheduler tick handles all tiers. Kept for compat.
    sqTick();
    return Promise.resolve(true);
  }

  function pollSpotWarm() {
    // v5.3: see pollSpotHot — the warm burst is retired too.
    sqTick();
    return Promise.resolve(true);
  }

  /* Search-to-add: register an extra fiat pair at runtime (validated first).
     Returns true when registered (or already present). */
  function ensureFxSymbol(sym) {
    if (SYMS[sym]) return true;
    var m = /^([A-Z]{3})([A-Z]{3})c$/.exec(String(sym));
    if (!m) return false;
    var jpy = m[1] === "JPY" || m[2] === "JPY";
    SYMS[sym] = { kind: "fx", digits: jpy ? 3 : 5, spreadPts: 30, cat: "forex", custom: true };
    states[sym] = "LOADING";
    tickBuf[sym] = [];
    return true;
  }

  /* ---------------- candles ---------------- */
  /* v5.18: fill missing timeframe slots with flat candles carried at the last
     real close. This is standard chart continuity (MT5/cTrader render every
     slot): flat legs only, no invented wicks — wicks and bodies only ever
     come from real ticks/candles. maxFill caps how far a quiet/dead feed can
     extend so nothing is fabricated at length. */
  /* v5.20: closedAt(t) is an optional predicate — slots where the market was
     closed are NEVER filled, so the chart shows an honest gap exactly like
     cTrader/MT5 (daily gold break, weekends) instead of flat invented candles. */
  function fillGaps(candles, tfMs, maxFill, closedAt) {
    if (!candles || candles.length < 2 || !(tfMs > 0)) return candles;
    var out = [candles[0]], n = 0;
    for (var i = 1; i < candles.length; i++) {
      var prev = out[out.length - 1], want = prev[0] + tfMs, cur = candles[i];
      while (cur[0] > want && n < maxFill) {
        if (closedAt && closedAt(want)) { want += tfMs; continue; } // market closed: leave the gap
        out.push([want, prev[4], prev[4], prev[4], prev[4]]);
        prev = out[out.length - 1]; want = prev[0] + tfMs; n++;
      }
      if (cur[0] === prev[0]) {
        if (cur[2] > prev[2]) prev[2] = cur[2];
        if (cur[3] < prev[3]) prev[3] = cur[3];
        prev[4] = cur[4];
        if (cur[5]) prev[5] = (prev[5] || 0) + cur[5];
      } else out.push(cur);
    }
    return out;
  }

  // v5.21: XAUUSD/XAGUSD history comes from real Swissquote spot ticks,
  // but the chart must follow spot-metal hours — drop any candle from a
  // closed period (weekends, daily 21:00-22:00 UTC break).
  function stripClosedGold(candles) {
    return stripClosed(candles, isGoldClosed);
  }

  // v5.8 C04: generic closed-period strip — the predicate matches the
  // instrument's own session calendar (gold hours vs FX weekend).
  function stripClosed(candles, closedAt) {
    if (!candles) return candles;
    if (!closedAt) return candles;
    return candles.filter(function (c) { return !closedAt(c[0]); });
  }

  // v5.20: renderer integrity gate — validate a candle series before it can
  // reach Lightweight Charts. Drops malformed rows (non-finite/non-positive
  // OHLC, misaligned timestamps, high<max(open,close), low>min(open,close));
  // dedupes timestamps; returns null when nothing trustworthy remains, in
  // which case the UI holds the last good snapshot + overlay instead of
  // rendering partial garbage.
  function cleanSeries(candles, tfMs) {
    if (!candles || !candles.length) return candles;
    var out = [], seen = {};
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      if (!c || !isFinite(c[0]) || c[0] <= 0) continue;
      if (tfMs > 0 && !slotAligned(c[0], tfMs)) continue; // v5.8 C05: not slot-aligned (W1 = Monday 00:00 UTC)
      if (!saneOhlc(c)) continue;
      if (seen[c[0]]) continue;                    // duplicate timestamp
      seen[c[0]] = 1;
      if (out.length && c[0] < out[out.length - 1][0]) continue; // unordered
      out.push(c);
    }
    // v5.3: a single VALIDATED candle is trustworthy and renders (a live
    // forming candle must not sit behind a spinner). Invalid data still
    // never reaches the chart — it returns null and the UI holds the last
    // good snapshot + status overlay.
    return out.length >= 1 ? out : null;
  }

  function bucketize(sym, tfMs) {
    var buf = tickBuf[sym];
    // v5.8 C06: a single accepted tick renders as a one-tick forming candle
    // (marked incomplete by the renderer); never wait behind a spinner.
    if (!buf || !buf.length) return null;
    // v5.18: aggregate in time order — the buffer is normally chronological,
    // but never trust insertion order (late/out-of-order ticks would corrupt
    // the series and crash the chart renderer)
    var ticks = buf.slice().sort(function (a, b) { return a.t - b.t; });
    var out = [], cur = null, isSpotFx = SYMS[sym] && (SYMS[sym].kind === "spot" || SYMS[sym].kind === "fx");
    for (var i = 0; i < ticks.length; i++) {
      // v5.8 C03: instrument-defined price basis — Swissquote spot/fx candles
      // aggregate the BID (broker-chart parity); other ticks keep last-price.
      var px = (isSpotFx && ticks[i].bid != null) ? ticks[i].bid : ticks[i].mid;
      var b = Math.floor(ticks[i].t / tfMs) * tfMs;
      if (!cur || cur[0] !== b) { cur = [b, px, px, px, px]; out.push(cur); }
      else {
        if (px > cur[2]) cur[2] = px;
        if (px < cur[3]) cur[3] = px;
        cur[4] = px;
      }
    }
    var d = SYMS[sym].digits;
    // v5.8 C04: never fabricate long flat runs for outages — bridge at most 3
    // missed slots (likely missed polls), then leave a real whitespace gap.
    // v5.20: ...except while a market is closed — the break/weekend gap stays
    // a real gap (cTrader parity), never flat-filled.
    var k = SYMS[sym].kind;
    var closedAt = (sym === "XAUUSDc" || sym === "XAGUSDc") ? isGoldClosed : (k === "fx" ? isFxClosed : null);
    var filled = fillGaps(out, tfMs, 3, closedAt);
    return filled.map(function (c) { return [c[0], roundTo(c[1], d), roundTo(c[2], d), roundTo(c[3], d), roundTo(c[4], d)]; });
  }

  /* A candle is structurally impossible (malformed upstream row) when any leg
     is non-finite/non-positive, high<low, or high/low contradict open/close.
     Drop only those — real sustained moves are always preserved. */
  function saneOhlc(c) {
    var o = c[1], h = c[2], l = c[3], x = c[4];
    return isFinite(o) && isFinite(h) && isFinite(l) && isFinite(x) &&
           o > 0 && h > 0 && l > 0 && x > 0 &&
           h >= l && h >= Math.max(o, x) && l <= Math.min(o, x);
  }

  function krakenOhlc(sym, interval) {
    var cfg = SYMS[sym];
    if (!cfg.kraken.length) return Promise.resolve(null);
    var url = "https://api.kraken.com/0/public/OHLC?pair=" + cfg.kraken[0] + "&interval=" + interval;
    return fetchJson(url).then(function (res) {
      if (!res.ok || !res.data || !res.data.result) return null;
      var keys = Object.keys(res.data.result).filter(function (k) { return k !== "last"; });
      if (!keys.length) return null;
      var rows = res.data.result[keys[0]];
      var d = cfg.digits;
      return rows.map(function (r) {
        return [r[0] * 1000, roundTo(parseFloat(r[1]), d), roundTo(parseFloat(r[2]), d),
                roundTo(parseFloat(r[3]), d), roundTo(parseFloat(r[4]), d)];
      }).filter(saneOhlc);
    });
  }

  function cgOhlc(sym, days) {
    var cfg = SYMS[sym];
    var url = "https://api.coingecko.com/api/v3/coins/" + cfg.cg + "/ohlc?vs_currency=usd&days=" + days;
    return fetchJson(url).then(function (res) {
      if (!res.ok || !Array.isArray(res.data) || !res.data.length) return null;
      var d = cfg.digits;
      return res.data.map(function (r) {
        return [r[0], roundTo(r[1], d), roundTo(r[2], d), roundTo(r[3], d), roundTo(r[4], d)];
      }).filter(saneOhlc);
    });
  }

  // KuCoin klines for symbols Kraken doesn't list (BNB). KuCoin returns
  // newest-first rows: [time(sec), open, close, high, low, volume, turnover].
  function kucoinKlines(sym, type) {
    var map = { BNBUSDc: "BNB-USDT" };
    var ks = map[sym];
    if (!ks) return Promise.resolve(null);
    var url = "https://api.kucoin.com/api/v1/market/candles?symbol=" + ks + "&type=" + type;
    return fetchJson(url).then(function (res) {
      if (!res.ok || !res.data || res.data.code !== "200000" || !Array.isArray(res.data.data) || !res.data.data.length) return null;
      var d = SYMS[sym].digits;
      var rows = res.data.data.slice().reverse();
      return rows.map(function (r) {
        return [r[0] * 1000, roundTo(parseFloat(r[1]), d), roundTo(parseFloat(r[3]), d),
                roundTo(parseFloat(r[4]), d), roundTo(parseFloat(r[2]), d)];
      });
    });
  }

  // aggregate finer candles into coarser tf (candles: [t,o,h,l,c])
  function resample(candles, tfMs) {
    if (!candles || !candles.length) return null;
    var out = [], cur = null;
    for (var i = 0; i < candles.length; i++) {
      var b = slotStart(candles[i][0], tfMs); // v5.8 C05: W1 anchored to Monday
      if (!cur || cur[0] !== b) { cur = [b, candles[i][1], candles[i][2], candles[i][3], candles[i][4]]; out.push(cur); }
      else {
        if (candles[i][2] > cur[2]) cur[2] = candles[i][2];
        if (candles[i][3] < cur[3]) cur[3] = candles[i][3];
        cur[4] = candles[i][4];
      }
    }
    return out;
  }

  function aggregateMonthly(daily) {
    if (!daily || !daily.length) return null;
    var out = [], cur = null, key = "";
    for (var i = 0; i < daily.length; i++) {
      var dt = new Date(daily[i][0]);
      var k = dt.getUTCFullYear() + "-" + dt.getUTCMonth();
      if (k !== key) { key = k; cur = [Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1), daily[i][1], daily[i][2], daily[i][3], daily[i][4]]; out.push(cur); }
      else {
        if (daily[i][2] > cur[2]) cur[2] = daily[i][2];
        if (daily[i][3] < cur[3]) cur[3] = daily[i][3];
        cur[4] = daily[i][4];
      }
    }
    return out;
  }

  function cryptoHistory(sym, tf) {
    if (tf === "H1") {
      return krakenOhlc(sym, 60).then(function (c) {
        if (c && c.length) return c;
        return cgOhlc(sym, 1).then(function (c2) { return resample(c2, TF_MS.H1); });
      });
    }
    if (tf === "H4") {
      return krakenOhlc(sym, 240).then(function (c) {
        if (c && c.length) return c;
        return cgOhlc(sym, 30); // native 4h candles
      });
    }
    if (tf === "D1") {
      return krakenOhlc(sym, 1440).then(function (c) {
        if (c && c.length) return c;
        return cgOhlc(sym, 30).then(function (c2) { return resample(c2, TF_MS.D1); }); // 4h -> daily
      });
    }
    if (tf === "W1") {
      return cryptoHistory(sym, "D1").then(function (d) { return resample(d, TF_MS.W1); });
    }
    if (tf === "MN") {
      return cryptoHistory(sym, "D1").then(aggregateMonthly);
    }
    // Intraday crypto history: Kraken serves native 1/5/15/30-minute OHLC
    // (720 candles), KuCoin klines cover symbols Kraken doesn't list (BNB),
    // CoinGecko 30-min candles are an exact fallback for M30 only.
    // (In the app WebView, setAllowUniversalAccessFromFileURLs(true) means
    //  CORS does not block these fetches; desktop browsers fall back to ticks.)
    var KTF = { M1: 1, M5: 5, M15: 15, M30: 30 };
    var KTYPE = { M1: "1min", M5: "5min", M15: "15min", M30: "30min" };
    if (KTF[tf]) {
      return krakenOhlc(sym, KTF[tf]).then(function (c) {
        return (c && c.length) ? c : kucoinKlines(sym, KTYPE[tf]);
      }).then(function (c) {
        if (c && c.length) return c;
        return tf === "M30" ? cgOhlc(sym, 1) : null; // never fabricate finer granularity
      });
    }
    return Promise.resolve(null);
  }

  function fxHistory(sym, tf) {
    // daily FX history via Frankfurter time series (honest daily data only).
    // Any XXXYYY pair: derived from USD-anchored rates, crosses via USD.
    if (tf !== "D1" && tf !== "W1" && tf !== "MN") return Promise.resolve(null);
    var p = String(sym).replace(/c$/, ""), base = p.slice(0, 3), quote = p.slice(3, 6);
    var end = new Date(), start = new Date(end.getTime() - 400 * 86400000);
    function iso(d) { return d.toISOString().slice(0, 10); }
    var url = "https://api.frankfurter.app/" + iso(start) + ".." + iso(end) + "?from=USD&to=" + base + "," + quote;
    return fetchJson(url).then(function (res) {
      if (!res.ok || !res.data || !res.data.rates) return null;
      var d = SYMS[sym].digits, out = [];
      Object.keys(res.data.rates).sort().forEach(function (day) {
        var r = res.data.rates[day];
        var v = base === "USD" ? r[quote] : quote === "USD" ? 1 / r[base] : r[quote] / r[base];
        if (!(v > 0)) return;
        var t = Date.parse(day + "T00:00:00Z");
        var mid = roundTo(v, d);
        // v5.8 C01: one reference rate per day — stored flat (o=h=l=c). The
        // chart draws FX D1 as a labelled reference LINE (isReferenceLine),
        // never as invented candles. W1/MN resample these real daily rates
        // into genuine weekly/monthly OHLC of the reference series.
        out.push([t, mid, mid, mid, mid]);
      });
      if (!out.length) return null;
      if (tf === "D1") return out;
      if (tf === "W1") return resample(out, TF_MS.W1);
      return aggregateMonthly(out);
    });
  }

  function ensureHistory(sym, tf) {
    var key = sym + "|" + tf;
    if (histPending[key]) return;
    // v5.18: back off after a failed fetch — getCandles runs on every tick,
    // so a hard failure must not become a per-tick request loop (rate limits)
    if (histFailAt[key] && Date.now() - histFailAt[key] < 90000) return;
    var cached = histCache[sym] && histCache[sym][tf];
    var isTickTf = tf === "M1" || tf === "M5" || tf === "M15" || tf === "M30";
    var maxAge = (tf === "H1" || tf === "H4") ? 15 * 60000 : isTickTf ? 30 * 60000 : 6 * 3600000;
    if (cached && Date.now() - cached.at < maxAge) return;
    histPending[key] = true;
    var k = SYMS[sym].kind;
    // v5.21: fx -> Frankfurter ECB daily (D1+ only); spot metals -> Yahoo
    // daily spot (D1+ only); spot/fx intraday candles come from live ticks
    // and never reach this fetch path. crypto unchanged.
    var p = k === "fx" ? fxHistory(sym, tf) : (k === "spot" || k === "idx") ? idxHistory(sym, tf) : cryptoHistory(sym, tf);
    p.then(function (candles) {
      delete histPending[key];
      if (candles && candles.length) {
        if (!histCache[sym]) histCache[sym] = {};
        histCache[sym][tf] = { candles: candles, at: Date.now() };
        delete histFailAt[key];
      } else histFailAt[key] = Date.now();
    }).catch(function () { delete histPending[key]; histFailAt[key] = Date.now(); });
  }
  var histFailAt = {}; // "sym|tf" -> ms of last failed history fetch (backoff)

  /* ---------------- v5.3: instant history — relay seed + local M1 cache ----
     v5.2 proved that a cold start with no intraday history reads as "broken"
     (minutes of "Building live history…"). The chart now seeds from REAL M1
     candles in this order:
       1. localStorage M1 cache (instant, cap 360 candles/symbol) — painted
          immediately on open, even before any network.
       2. relay https://dawoodshah2232-svg.github.io/orbit-history/<SYM>_m1.json
          (array of {t,o,h,l,c}; t = epoch ms of the M1 candle open, SYM upper-
          case without the trailing "c"). Used only when the newest candle is
          < 15 min old (or reaches into the current market closure). Relay
          404/stale/error = honest live-building fallback: never simulated,
          never another instrument, never held hostage by the relay.
       3. live Swissquote ticks merged on top (live wins on timestamp overlap).
     The relay is our own aggregation of real market data; every candle is
     still validated (saneOhlc, M1 slot alignment) before it can render. */
  var RELAY_BASE = "https://dawoodshah2232-svg.github.io/orbit-history/";
  var spotSeed = {};        // sym -> {candles:[[t,o,h,l,c]...] M1, at, from:"cache"|"relay"}
  var spotSeedPending = {}; // sym -> true while a relay fetch is in flight
  var M1_CACHE_CAP = 360;
  var tickDirty = {};       // sym -> true when new ticks arrived since last cache save

  // v5.8: cache key versioned — v5.8 candles are bid-basis (C03); the old
  // mid-basis cache is dropped once rather than merged across bases.
  function m1CacheKey(sym) { return "ot_m1cache_v2_" + sym; }

  function loadM1Cache(sym) {
    try {
      if (!G.localStorage) return null;
      var raw = G.localStorage.getItem(m1CacheKey(sym));
      if (!raw) return null;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return null;
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var c = arr[i];
        if (Array.isArray(c) && c.length >= 5 && isFinite(c[0]) && c[0] % 60000 === 0 && saneOhlc(c))
          out.push([c[0], c[1], c[2], c[3], c[4]]);
      }
      return out.length ? out : null;
    } catch (e) { return null; }
  }

  function writeM1Cache(sym, candles) {
    try {
      if (!G.localStorage || !candles || !candles.length) return;
      G.localStorage.setItem(m1CacheKey(sym), JSON.stringify(candles.slice(-M1_CACHE_CAP)));
    } catch (e) { /* storage full/blocked: history just won't persist */ }
  }

  // merge newly aggregated live M1 candles into the persisted cache
  function saveM1Cache(sym) {
    try {
      var m1 = bucketize(sym, TF_MS.M1);
      if (!m1 || !m1.length) return;
      var prev = loadM1Cache(sym) || [];
      var seen = {}, i;
      for (i = 0; i < prev.length; i++) seen[prev[i][0]] = prev[i];
      // v5.8 C02: same-timestamp collision merges OHLC (earlier open, widest
      // high/low, latest close) instead of live blindly replacing the cache.
      for (i = 0; i < m1.length; i++) {
        var mk = m1[i][0], pc = seen[mk], nc = m1[i];
        seen[mk] = pc ? [mk, pc[1], Math.max(pc[2], nc[2]), Math.min(pc[3], nc[3]), nc[4]] : nc;
      }
      var keys = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
      if (keys.length > M1_CACHE_CAP) keys = keys.slice(keys.length - M1_CACHE_CAP);
      var out = [];
      for (i = 0; i < keys.length; i++) out.push(seen[keys[i]]);
      writeM1Cache(sym, out);
    } catch (e) {}
  }

  // persist M1 candles for symbols that received ticks since the last save
  function saveM1Caches() {
    try {
      Object.keys(tickDirty).forEach(function (s) {
        if (!tickDirty[s]) return;
        tickDirty[s] = false;
        if (SYMS[s] && (SYMS[s].kind === "spot" || SYMS[s].kind === "fx" || SYMS[s].kind === "live"))
          saveM1Cache(s);
      });
    } catch (e) {}
  }

  function seedFreshEnough(sym, newest) {
    var now = Date.now();
    if (now - newest < 15 * 60000) return true;
    // market closed: a seed reaching into the current closure is as fresh as possible
    var k = SYMS[sym] && SYMS[sym].kind;
    if ((sym === "XAUUSDc" || sym === "XAGUSDc") && isGoldClosed(now) && isGoldClosed(newest)) return true;
    if (k === "fx" && isFxClosed(now) && isFxClosed(newest)) return true;
    return false;
  }

  // v5.8 C07: the seed is re-fetched every 10 minutes while the app is open —
  // a long-lived session must never sit on a stale seed. Whenever the relay
  // delivers a NEWER seed, seedVersion[sym] bumps so the chart repaints.
  var SEED_REFRESH_MS = 10 * 60000;
  var seedVersion = {}; // sym -> int, bumped on every (re)seed from relay
  function ensureSpotSeed(sym) {
    var cfg = SYMS[sym];
    if (!cfg) return;
    if (spotSeedPending[sym]) return;
    var cur = spotSeed[sym];
    if (cur && Date.now() - cur.at < SEED_REFRESH_MS) return;
    // 1. instant: local M1 cache (all kinds) — only when no seed yet
    if (!cur) {
      var cached = loadM1Cache(sym);
      if (cached && cached.length) spotSeed[sym] = { candles: cached, at: Date.now(), from: "cache" };
    }
    // 2. relay upgrade — FX/metals only (crypto already has real exchange history)
    if (cfg.kind !== "spot" && cfg.kind !== "fx") return;
    spotSeedPending[sym] = true;
    var url = RELAY_BASE + String(sym).replace(/c$/, "") + "_m1.json?t=" + Date.now();
    fetchJson(url, 10000).then(function (res) {
      delete spotSeedPending[sym];
      var rows = res.ok && res.data ? (Array.isArray(res.data) ? res.data : res.data.candles) : null;
      if (!rows || !rows.length) return; // 404/stale/error → live-building fallback
      var d = cfg.digits, out = [], newest = 0, i;
      for (i = 0; i < rows.length; i++) {
        var r = rows[i] || {}, t = +r.t;
        if (!(t > 0) || t % 60000 !== 0) continue; // M1 slot alignment
        var c = [t, roundTo(+r.o, d), roundTo(+r.h, d), roundTo(+r.l, d), roundTo(+r.c, d)];
        if (!saneOhlc(c)) continue;
        out.push(c);
        if (t > newest) newest = t;
      }
      if (out.length < 2 || !seedFreshEnough(sym, newest)) return;
      out.sort(function (a, b) { return a[0] - b[0]; });
      var prevNewest = spotSeed[sym] && spotSeed[sym].newest || 0;
      spotSeed[sym] = { candles: out, at: Date.now(), from: "relay", newest: newest,
        basis: res.data && res.data.basis, // v5.8 C03: relay-declared price basis
        basisSince: res.data && res.data.basis_since };
      if (newest > prevNewest) seedVersion[sym] = (seedVersion[sym] || 0) + 1;
      writeM1Cache(sym, out); // persist the relay seed too
    }).catch(function () { delete spotSeedPending[sym]; });
  }

  // seed candles resampled to the requested timeframe (M1 seed stored)
  function spotSeedFor(sym, tf) {
    var s = spotSeed[sym];
    if (!s || !s.candles || !s.candles.length) return null;
    if (tf === "M1") return s.candles;
    var tfMs = TF_MS[tf];
    if (!tfMs) return null;
    return resample(s.candles, tfMs);
  }

  // seed under live ticks; live wins on timestamp overlap; gaps capped
  // v5.8 C02: on the seed/live boundary, MERGE the overlapping bucket —
  // keep the earlier open, the widest high/low, the latest close. Opening
  // mid-minute must never erase the wicks that printed before the app opened.
  function mergeSeedLive(seed, live, tfMs, closedAt) {
    if (!seed || !seed.length) return live;
    if (!live || !live.length) return seed;
    var cut = live[0][0], out = [], i, j;
    for (i = 0; i < seed.length && seed[i][0] < cut; i++) out.push(seed[i]);
    for (; i < seed.length && seed[i][0] === cut; i++) {
      var s = seed[i], l = live[0];
      out.push([cut, s[1], Math.max(s[2], l[2]), Math.min(s[3], l[3]), l[4]]);
    }
    for (j = 0; j < live.length; j++) out.push(live[j]);
    return fillGaps(out, tfMs, 3, closedAt || null); // v5.8 C04: no long flat fabrication
  }

  /* ---------------- public API ---------------- */
  var api = {
    onTick: null,

    start: function () {
      if (started) return;
      started = true;
      // v5.3: staggered Swissquote scheduler — metals/charted first, no bursts.
      sqTick(); sqTick(); sqTick(); // immediate: tier1 (metals) get quotes in <1s
      pollCrypto();
      pollKrakenFast(); // immediate: batched Kraken ticker, ~2s cadence (HTTP fallback for WS)
      pollBnbFast();    // immediate: KuCoin BNB ticker, ~4s cadence (HTTP fallback for WS)
      startKrakenWs();  // primary: sub-second streaming ticks (crypto)
      startBinWs();     // v5.21: PAXGUSDT — PAXGUSDc token 24/7 (never XAUUSD)
      startBinKlineWs();// v5.4: authoritative Binance 1s candles for all crypto
      startKucoinWs();  // primary: BNB streaming ticks
      setInterval(pollCrypto, POLL_MS);
      setInterval(sqTick, 1000); // v5.3: the only Swissquote driver (polite)
      setInterval(pollKrakenFast, FAST_POLL_MS);
      setInterval(pollBnbFast, BNB_POLL_MS);
      setInterval(wsWatchdog, WS_SILENT_MS);
      setInterval(saveM1Caches, 30000); // v5.3: persist M1 candles for instant reopen
      setInterval(function () {
        // re-evaluate CLOSED vs live at session boundaries (weekend roll)
        var fxC = isFxClosed();
        Object.keys(SYMS).forEach(function (s) {
          if (SYMS[s].kind !== "fx" || !quotes[s]) return;
          states[s] = fxC ? "CLOSED" : (states[s] === "CLOSED" ? "LOADING" : states[s]);
        });
        // v5.20: spot-metal session — freeze to CLOSED the moment the daily
        // break/weekend starts; on reopen, LOADING until the first real tick
        // lands (applySpotQuote flips it to LIVE). No chart reset anywhere.
        var gc = isGoldClosed();
        ["XAUUSDc", "XAGUSDc"].forEach(function (gsym) {
          if (gc) { if (states[gsym] !== "CLOSED") states[gsym] = "CLOSED"; }
          else if (states[gsym] === "CLOSED") {
            states[gsym] = (lastOk[gsym] && Date.now() - lastOk[gsym] < FAST_STALE_MS) ? "LIVE" : "LOADING";
          }
        });
      }, 60000);
    },

    getQuote: function (sym) {
      return quotes[sym] || null;
    },

    /* test hooks: feed.__test.tickOk(sym, mid) — true = accepted;
       feed.__test.injectTick(sym, mid) — push a real tick through applyQuote;
       feed.__test.injectTickAt(sym, mid, t) — push a tick with explicit timestamp
       (for sparse-history QA; updates liveness without adding a "now" tick);
       feed.__test.wsUrl(name, url) — override a WS endpoint (binance/kraken);
       feed.__test.goldHealth() — {binanceOk, krakenOk, source, ageSec} */
    __test: { tickOk: tickOk, badTicks: function () { return badTicks; },
              isGoldClosed: isGoldClosed, goldStatus: goldStatus,
              cleanSeries: cleanSeries, stripClosedGold: stripClosedGold,
              wsUrl: function (name, url) { if (WS_URLS[name] !== undefined) { WS_URLS[name] = url; return true; } return false; },
              goldHealth: function () {
                return { binanceOk: binWsOk(), krakenOk: krakenWsOk(),
                         source: sourceOf["XAUUSDc"] || null,
                         ageSec: lastOk["XAUUSDc"] ? Math.round((Date.now() - lastOk["XAUUSDc"]) / 1000) : -1,
                         state: states["XAUUSDc"] || "LOADING" };
              },
              injectTick: function (sym, mid) { return applyQuote(sym, mid, "test"); },
              injectTickAt: function (sym, mid, t) {
                if (!SYMS[sym] || !(mid > 0) || !(t > 0)) return false;
                var buf = tickBuf[sym];
                if (buf) { buf.push({ t: t, mid: mid }); if (buf.length > 3000) buf.splice(0, buf.length - 3000); }
                lastOk[sym] = Date.now();
                if (SYMS[sym].kind === "live" || SYMS[sym].kind === "spot" || SYMS[sym].kind === "fx") states[sym] = "LIVE";
                return true;
              } },

  getCandlesRaw: function (sym, tf) {
      if (!SYMS[sym] || !TF_MS[tf] && tf !== "MN") return null;
      var sk = SYMS[sym].kind;
      // v5.3: spot/fx intraday candles = relay seed + local M1 cache + live
      // Swissquote ticks merged (live wins on overlap). The chart paints from
      // the seed immediately; the first live candle renders as soon as it
      // exists — no more waiting for two timeframe buckets. Real data only:
      // never seeded from another instrument, never simulated.
      if ((sk === "spot" || sk === "fx") && (tf === "M1" || tf === "M5" || tf === "M15" || tf === "M30")) {
        ensureSpotSeed(sym);
        var seed = spotSeedFor(sym, tf);
        var live = bucketize(sym, TF_MS[tf]);
        // v5.8 C04: FX weekends are real gaps (isFxClosed), never flat-filled
        var closedPred = (sym === "XAUUSDc" || sym === "XAGUSDc") ? isGoldClosed : (sk === "fx" ? isFxClosed : null);
        if (live && closedPred) live = stripClosed(live, closedPred);
        if (seed && closedPred) seed = stripClosed(seed, closedPred);
        var merged = mergeSeedLive(seed, live, TF_MS[tf], closedPred);
        return (merged && merged.length) ? merged : null;
      }
      if (tf === "M1" || tf === "M5" || tf === "M15" || tf === "M30") {
        if (sk === "idx") {
          // periodic symbols have no tick stream: M1/M5 stay empty (honest),
          // M15/M30 come from real Yahoo 15m history
          if (tf === "M15" || tf === "M30") {
            ensureHistory(sym, tf);
            var ch = histCache[sym] && histCache[sym][tf];
            return ch ? ch.candles : null;
          }
          return null;
        }
        // real fetched history (Kraken / KuCoin / CoinGecko) merged with the
        // live forming bucket. v5.4: the live leg prefers authoritative
        // Binance 1s exchange candles (resampled) over client-side tick
        // aggregation when the kline leg is fresh; tick bucketize stays as
        // the automatic fallback.
        ensureHistory(sym, tf);
        var hc = histCache[sym] && histCache[sym][tf];
        var hist = hc ? hc.candles : null;
        var klive = binKlineLive(sym, TF_MS[tf]);
        var live = klive || bucketize(sym, TF_MS[tf]);
        // v5.18: never hold the chart hostage on a slow/failed history fetch —
        // a continuous live series renders immediately; history merges in when
        // it lands (tickCandle/lwcMaybeExtend pick up the longer series).
        // History still loading: hold (null) only while there is no live
        // series at all, so the shimmer shows instead of an empty chart.
        // v5.3: local M1 cache keeps crypto charts instant across restarts
        // (exchange history stays the real source; relay is FX/metals only).
        if (!hist || !hist.length) {
          ensureSpotSeed(sym);
          var cseed = spotSeedFor(sym, tf);
          var cmerged = mergeSeedLive(cseed, live, TF_MS[tf], null);
          if (cmerged && cmerged.length) return cmerged;
          return histPending[sym + "|" + tf] ? null : live;
        }
        // v5.20: spot-metal history never carries closed-period candles —
        // strip before the merge so weekends/breaks can't leak in either path.
        if (sym === "XAUUSDc" || sym === "XAGUSDc") hist = stripClosedGold(hist);
        if (!live || !live.length) return hist;
        var cut = live[0][0], out = [];
        for (var mi = 0; mi < hist.length; mi++) if (hist[mi][0] < cut) out.push(hist[mi]);
        // v5.18: bridge a stale-history gap with flat candles (capped) so the
        // chart reads as one continuous series instead of a visual break
        // v5.20: ...but never across a spot-metal market closure — the break
        // stays an honest gap.
        var closedAt = (sym === "XAUUSDc" || sym === "XAGUSDc") ? isGoldClosed : null;
        return fillGaps(out.concat(live), TF_MS[tf], 120, closedAt);
      }
      // v5.3: spot/fx H1/H4 resample from seed M1 + live M1 ticks (real data).
      if ((sk === "spot" || sk === "fx") && (tf === "H1" || tf === "H4")) {
        ensureSpotSeed(sym);
        var m1seed = spotSeedFor(sym, "M1");
        var m1live = bucketize(sym, TF_MS.M1);
        var m1closed = (sym === "XAUUSDc" || sym === "XAGUSDc") ? isGoldClosed : (sk === "fx" ? isFxClosed : null);
        if (m1live && m1closed) m1live = stripClosed(m1live, m1closed);
        if (m1seed && m1closed) m1seed = stripClosed(m1seed, m1closed);
        var m1full = mergeSeedLive(m1seed, m1live, TF_MS.M1, m1closed);
        var rh = resample(m1full, TF_MS[tf]);
        return (rh && rh.length) ? rh : null;
      }
      ensureHistory(sym, tf);
      var c = histCache[sym] && histCache[sym][tf];
      // v5.20: spot-metal history never carries closed-period candles
      if (c && c.candles && (sym === "XAUUSDc" || sym === "XAGUSDc")) return stripClosedGold(c.candles);
      return c ? c.candles : null;
    },

    /* v5.20: public candle path — every series is validated by cleanSeries
       before it can reach Lightweight Charts. Invalid data never replaces
       the last good snapshot (the UI holds it + shows the status overlay). */
    getCandles: function (sym, tf) {
      return cleanSeries(api.getCandlesRaw(sym, tf), TF_MS[tf] || 0);
    },

    // v5.20: spot-gold session for the chart overlay + badges.
    // {closed, reason:"break"|"weekend"|null, reopensAt, reopenLabel}
    goldStatus: function (nowMs) {
      return goldStatus(nowMs);
    },

    /* v5.20: per-symbol feed condition for the chart status overlay and
       honesty badges. "live" = primary WS streaming; "fallback" = live on a
       backup leg (ladder already switched); "reconnecting" = market open but
       no quote for >15s (or still loading with no quote); "offline" = quote
       gone stale past the honesty limit; "closed" = market closed. */
    // v5.3: seed provenance for the "last session" label — where the chart's
    // history came from and whether live ticks have landed yet.
    // v5.8 C07: seedVer lets the chart repaint when a newer relay seed lands.
    seedInfo: function (sym) {
      var s = spotSeed[sym];
      if (!s) return null;
      return { from: s.from, count: s.candles.length,
        newestAgeSec: Math.round((Date.now() - s.candles[s.candles.length - 1][0]) / 1000),
        live: !!(lastOk[sym] && Date.now() - lastOk[sym] < 15000),
        seedVer: seedVersion[sym] || 0 };
    },

    // v5.8 C01: FX daily history is a single ECB reference rate per day — it
    // has no intraday OHLC. The chart must draw it as a labelled reference
    // LINE, never as candlesticks. W1/MN resample real daily rates into
    // genuine weekly/monthly OHLC of the reference series (still labelled).
    isReferenceLine: function (sym, tf) {
      return !!(SYMS[sym] && SYMS[sym].kind === "fx" && tf === "D1");
    },

    // v5.8 C03/C08: feed-side symbol kind ("spot"/"fx"/"live") for chart logic.
    symKind: function (sym) { return SYMS[sym] ? SYMS[sym].kind : null; },

    // v5.4: expected quote cadence per symbol kind — drives STALE/RECONNECTING.
    // Crypto rides the Binance kline_1s leg (1s); spot/fx keep their
    // Swissquote poll tiers (2s/10s/60s).
    liveTierMs: function (sym) {
      var k = SYMS[sym] ? SYMS[sym].kind : "";
      if (k === "live") return 2000;
      return sqTierMs(sym);
    },

    feedCondition: function (sym) {
      if ((sym === "XAUUSDc" || sym === "XAGUSDc") && isGoldClosed()) return "closed";
      var st = states[sym] || "LOADING";
      // v5.4: STALE = a leg is alive but this symbol's quote aged past its
      // expected cadence (chart holds last real candles, badge says STALE).
      // RECONNECTING = nothing fresh at all. Thresholds scale with the
      // symbol's own cadence so 1s crypto isn't judged like 60s FX.
      var tier = api.liveTierMs(sym);
      var staleAfter = Math.max(15000, tier * 2.5);
      var deadAfter = Math.max(60000, tier * 5);
      if (st === "LIVE") {
        var src = sourceOf[sym] || "";
        var k = SYMS[sym] ? SYMS[sym].kind : "";
        var liveAge = lastOk[sym] ? Date.now() - lastOk[sym] : Infinity;
        if (liveAge > deadAfter) return "reconnecting";
        // v5.21: swissquote is the primary for spot metals + all FX.
        // v5.4: binance-kline is the primary for crypto; anything else
        // feeding them reads "fallback" (honest, never hidden).
        var primary = (k === "spot" || k === "fx") ? "swissquote" : (BIN_KLINE[sym] ? "binance-kline" : "kraken-ws");
        var cond = src === primary ? "live" : "fallback";
        if (liveAge > staleAfter) return "stale";
        return cond;
      }
      if (st === "CLOSED") return "closed";
      var age = lastOk[sym] ? Date.now() - lastOk[sym] : Infinity;
      if (st === "LOADING" || age > deadAfter) return "reconnecting";
      if (age > staleAfter) return "stale";
      return "offline";
    },

    state: function (sym) {
      return states[sym] || "LOADING";
    },

    // extras for UI honesty: age of last real quote, source, symbol list
    info: function (sym) {
      return {
        state: states[sym] || "LOADING",
        ageSec: lastOk[sym] ? Math.round((Date.now() - lastOk[sym]) / 1000) : -1,
        source: sourceOf[sym] || null,
        proxy: (SYMS[sym] && SYMS[sym].proxy) || null,
        updatedAt: lastOk[sym] || null
      };
    },

    // v5.4: socket-level health for the UI — drives "RECONNECTING · try N".
    // {leg: {open, lastMsgAgeSec (-1 = never), attempts}}
    wsHealth: function () {
      var now = Date.now();
      function leg(ws, lastMsg, attempt) {
        return { open: !!(ws && ws.readyState < 2),
                 lastMsgAgeSec: lastMsg ? Math.round((now - lastMsg) / 1000) : -1,
                 attempts: attempt || 0 };
      }
      return {
        kraken: leg(krakenWs, krakenWsLastMsg, krakenWsAttempt),
        kucoin: leg(kucoinWs, kucoinWsLastMsg, kucoinWsAttempt),
        binance: leg(binWs, binWsLastMsg, binWsAttempt),
        binanceKline: leg(binKlineWs, binKlineLastMsg, binKlineAttempt)
      };
    },

    // recent mid prices for sparklines (newest last). Uses live ticks once
    // enough exist; otherwise falls back to real H1 candle closes so the
    // sparkline renders immediately. Real market data only, never simulated.
    recentMids: function (sym, n) {
      var b = tickBuf[sym];
      n = n || 60;
      if (b && b.length >= 5) {
        return b.slice(b.length - Math.min(n, b.length)).map(function (x) { return x.mid; });
      }
      var c = null;
      try { c = api.getCandles(sym, "H1"); } catch (e) { c = null; }
      if (c && c.length >= 5) {
        return c.slice(c.length - Math.min(n, c.length)).map(function (k) { return k[4]; });
      }
      return (b && b.length) ? b.map(function (x) { return x.mid; }) : null;
    },

    // 24h high/low from existing real candle history (H1 window, D1 fallback).
    // Returns {high, low, tf} or null when no real history is available yet.
    dayRange: function (sym) {
      var cfg = SYMS[sym];
      if (!cfg) return null;
      var c = null;
      try { c = api.getCandles(sym, "H1"); } catch (e) { c = null; }
      var hi = -Infinity, lo = Infinity, n = 0;
      if (c && c.length) {
        var cut = Date.now() - 86400000;
        for (var i = c.length - 1; i >= 0; i--) {
          if (c[i][0] < cut) break;
          if (c[i][2] > hi) hi = c[i][2];
          if (c[i][3] < lo) lo = c[i][3];
          n++;
        }
      }
      if (n > 0) return { high: roundTo(hi, cfg.digits), low: roundTo(lo, cfg.digits), tf: "H1" };
      var d = null;
      try { d = api.getCandles(sym, "D1"); } catch (e2) { d = null; }
      if (d && d.length) {
        var last = d[d.length - 1];
        return { high: roundTo(last[2], cfg.digits), low: roundTo(last[3], cfg.digits), tf: "D1" };
      }
      return null;
    },

    // quote-tab category for a symbol (forex/crypto/indices/metals)
    category: function (sym) {
      return (SYMS[sym] && SYMS[sym].cat) || null;
    },

    symbols: function () { return Object.keys(SYMS); },
    kindOf: function (sym) { return SYMS[sym] ? SYMS[sym].kind : null; },

    // search-to-add: register an extra fiat pair (e.g. "USDZARc") at runtime.
    // The pair MUST be validated with checkFxPair first. Returns true on success.
    addSymbol: function (sym) {
      if (!ensureFxSymbol(sym)) return false;
      if (started) pollSwissquote(sym); // kick an immediate quote refresh
      return true;
    },

    // v5.21: validate a fiat pair against the REAL Swissquote spot feed —
    // resolves true only when the feed returns a live quote for the pair.
    checkFxPair: function (base, quote) {
      var sym = String(base) + String(quote) + "c";
      if (SYMS[sym]) return Promise.resolve(true);
      return fetchJson("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/" + base + "/" + quote, 8000).then(function (res) {
        var row = res.ok && res.data && res.data[0];
        var picks = row && row.spreadProfilePrices;
        if (!picks || !picks.length) return false;
        return parseFloat((picks[0] || {}).bid) > 0;
      }).catch(function () { return false; });
    },
    // v5.21: promote a symbol to the 2s hot poll (called when its chart opens)
    setHot: function (sym) {
      if (SYMS[sym] && (SYMS[sym].kind === "spot" || SYMS[sym].kind === "fx")) {
        if (!spotHotExtra[sym]) { spotHotExtra[sym] = true; pollSwissquote(sym); }
        ensureSpotSeed(sym); // v5.3: start the relay fetch the moment the chart opens
        return true;
      }
      return false;
    },
    // v5.21: spot health snapshot for QA/support
    spotHealth: function () {
      var out = {};
      Object.keys(SYMS).forEach(function (s) {
        if (SYMS[s].kind !== "spot" && SYMS[s].kind !== "fx") return;
        out[s] = { source: sourceOf[s] || null,
                   ageSec: lastOk[s] ? Math.round((Date.now() - lastOk[s]) / 1000) : -1,
                   state: states[s] || "LOADING",
                   mid: quotes[s] ? quotes[s].mid : null,
                   proxy: (quotes[s] && quotes[s].proxy) || null };
      });
      return out;
    },

    // deterministic regression-test hooks (market-session boundaries, FX math)
    _testHooks: { isFxClosed: isFxClosed, swissInstr: swissInstr,
                 spotHotList: spotHotList, isGoldClosedDirect: isGoldClosed,
                 // v5.8 audit fixtures: pure candle functions + tick injection
                 mergeSeedLive: mergeSeedLive, resample: resample,
                 fillGaps: fillGaps, cleanSeries: cleanSeries,
                 slotStart: slotStart, slotAligned: slotAligned,
                 bucketize: function (sym, tfMs) { return bucketize(sym, tfMs); },
                 injectTicks: function (sym, arr) {
                   var buf = tickBuf[sym]; if (!buf) return 0;
                   (arr || []).forEach(function (x) { buf.push({ t: x.t, bid: x.bid, mid: x.mid != null ? x.mid : x.bid }); });
                   tickDirty[sym] = true;
                   return buf.length;
                 },
                 clearTicks: function (sym) { tickBuf[sym] = []; },
                 saveM1Cache: saveM1Cache, loadM1Cache: loadM1Cache,
                 // v5.3 QA: point the relay at a fixture server, inspect seeds
                 relayBase: function (u) { if (u !== undefined) RELAY_BASE = u; return RELAY_BASE; },
                 seedInfo: function (sym) {
                   var s = spotSeed[sym];
                   return s ? { from: s.from, count: s.candles.length,
                     newestAgeSec: Math.round((Date.now() - s.candles[s.candles.length - 1][0]) / 1000) } : null;
                 },
                 sqState: function () { return { fails: sqFails, cooldownMs: Math.max(0, sqCooldownUntil - Date.now()) }; } }
  };

  G.OrbitFeed = api;
})();
