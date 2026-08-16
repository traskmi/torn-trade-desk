// ==UserScript==
// @name         Torn Trade Desk
// @namespace    tekim.tradedesk
// @version      1.54.1
// @updateURL    https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.user.js
// @downloadURL  https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.user.js
// @description  Live travel-profit board — YATA foreign stock × Torn-API resale, ranked by $/minute. Refresh button, affordability + best-pick, mug calculator.
// @author       Tekim
// @match        *://*.torn.com/*
// @connect      yata.yt
// @connect      api.torn.com
// @connect      weav3r.dev
// @connect      raw.githubusercontent.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /* ---------- static: flights (round-trip minutes + airfare), no private island ---------- */
  const FLY = {
    mex: { name: "Mexico", rt: 48, fare: 13000 },
    cay: { name: "Cayman", rt: 66, fare: 20000 },
    can: { name: "Canada", rt: 78, fare: 18000 },
    haw: { name: "Hawaii", rt: 254, fare: 22000 },
    uni: { name: "UK", rt: 302, fare: 36000 },
    arg: { name: "Argentina", rt: 316, fare: 42000 },
    swi: { name: "Switzerland", rt: 332, fare: 54000 },
    jap: { name: "Japan", rt: 426, fare: 64000 },
    chi: { name: "China", rt: 458, fare: 70000 },
    uae: { name: "UAE", rt: 514, fare: 64000 },
    sou: { name: "South Africa", rt: 564, fare: 80000 }
  };
  const DEST_CC = { mexico: "mex", cayman: "cay", "cayman islands": "cay", canada: "can", hawaii: "haw", "united kingdom": "uni", uk: "uni", britain: "uni", argentina: "arg", switzerland: "swi", japan: "jap", china: "chi", uae: "uae", "united arab emirates": "uae", "south africa": "sou" };
  function destCC(dest) { return dest ? (DEST_CC[String(dest).toLowerCase().trim()] || null) : null; }
  function detectLoc(j) {
    if (!j || !j.status || !j.travel) return null;
    const st = j.status.state;
    if (st === "Traveling" || st === "Okay") return null;
    if (j.travel.time_left > 0) return null;
    return destCC(j.travel.destination);
  }
  function detectTravel(j) {
    if (!j || !j.status || !j.travel) return { where: "unknown", cc: null };
    const st = j.status.state, tl = j.travel.time_left || 0;
    if (st === "Traveling" || tl > 0) return { where: "flying", cc: destCC(j.travel.destination), arriveIn: tl };
    const cc = detectLoc(j);
    if (cc) return { where: "abroad", cc: cc };
    return { where: "home", cc: null };
  }

  /* ---------- state ---------- */
  const state = { resale: null, itemMeta: null, resaleAt: 0, cash: null, stocks: null, cap: GM_getValue("cap", 23), rows: [], updates: {}, filter: "all", fund: GM_getValue("fund", false), scale: GM_getValue("scale", 1), view: "board", inv: null, invAt: 0, travel: null, invReady: null, sort: GM_getValue("sort", "landing"), maxTrip: GM_getValue("maxTrip", 0), ov: GM_getValue("ov", {}), loc: null, lastLoc: undefined, travelWhere: null, flyTo: null, flyEta: null, stkMkt: null, stkMine: null, stkAt: 0, _stkHist: null, oc: null, arrivalTs: 0, myLevel: null, travelMethod: GM_getValue("travelMethod", "std"), travelBook: GM_getValue("travelBook", false), priceBasis: GM_getValue("priceBasis", "mkt"), boardView: GM_getValue("boardView", "table") };
  // One-time: make Landing (what'll be in stock when you arrive) the default board sort for existing installs still on the old $/min default.
  try { if (!GM_getValue("landing_default_v1", false)) { if (state.sort === "ppm") { state.sort = "landing"; GM_setValue("sort", "landing"); } GM_setValue("landing_default_v1", true); } } catch (e) { }
  const fmtRt = function (min) { const h = Math.floor(min / 60), m = min % 60; return (h ? h + "h" : "") + (m ? m + "m" : "") || "0m"; };

  const TRAVEL_METHODS = { std: { mult: 1.00, label: "Standard", short: "Standard" }, air: { mult: 0.70, label: "Airstrip · Private Island + Pilot (−30%)", short: "Airstrip −30%" }, wlt: { mult: 0.50, label: "WLT benefit (−50%)", short: "WLT −50%" }, biz: { mult: 0.30, label: "Business Class ticket (−70%)", short: "Business −70%" } };
  function travelMult() { const m = TRAVEL_METHODS[state.travelMethod] || TRAVEL_METHODS.std; return m.mult * (state.travelBook ? 0.75 : 1); }
  function rtOf(cc) { const f = FLY[cc]; return f ? Math.max(1, Math.round(f.rt * travelMult())) : 0; }
  function travelLabel() { const m = (TRAVEL_METHODS[state.travelMethod] || TRAVEL_METHODS.std).short; return m + (state.travelBook ? " +book" : ""); }
  function recomputePpm() {
    (state.rows || []).forEach(function (x) { const f = FLY[x.cc]; if (!f) return; x.ppm = Math.round((x.ppi * state.cap - f.fare) / rtOf(x.cc)); x.full = x.buy * state.cap; });
    state.rows.sort(function (a, b) { return b.ppm - a.ppm; });
  }
  const TIME_OPTS = [[0, "⏱ Any time"], [60, "≤ 1h"], [90, "≤ 1½h"], [120, "≤ 2h"], [180, "≤ 3h"], [240, "≤ 4h"], [360, "≤ 6h"], [480, "≤ 8h"], [600, "≤ 10h"]];

  /* ---------- helpers ---------- */
  function gmGet(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      function fail(kind, msg, status) { const err = new Error(msg); err.kind = kind; err.url = url; if (status) err.status = status; reject(err); }
      GM_xmlhttpRequest({
        method: "GET", url: url, timeout: timeoutMs || 20000,
        onload: function (r) {
          if (r.status < 200 || r.status >= 300) return fail("http", "HTTP " + r.status, r.status);
          try { resolve(JSON.parse(r.responseText)); } catch (e) { fail("json", "bad JSON from " + url); }
        },
        onerror: function () { fail("network", "network error: " + url); },
        ontimeout: function () { fail("timeout", "timeout: " + url); }
      });
    });
  }
  function tornKey() {
    let k = GM_getValue("torn_key", "");
    if (!k) {
      k = (window.prompt("Torn Trade Desk — paste your Torn API key (limited access is fine):") || "").trim();
      if (k) GM_setValue("torn_key", k);
    }
    return k;
  }
  const money = function (n) {
    n = Math.round(n);
    if (Math.abs(n) >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1e3) + "k";
    return "$" + n;
  };
  const full$ = function (n) { return "$" + Math.round(n).toLocaleString("en-US"); };
  const parseM = function (s) { const n = parseInt(String(s == null ? "" : s).replace(/[^0-9]/g, ""), 10); return isNaN(n) ? 0 : n; };
  const escAttr = function (s) { return String(s == null ? "" : s).replace(/"/g, "&quot;"); };
  function copyText(t) {
    try { if (typeof GM_setClipboard === "function") { GM_setClipboard(t, "text"); return; } } catch (e) { }
    try { if (navigator.clipboard) navigator.clipboard.writeText(t); } catch (e) { }
  }
  function mkTradeLine(nm, q, p, net) {
    let s = nm + " ×" + q + " @ $" + p.toLocaleString() + "/ea = $" + (p * q).toLocaleString();
    if (typeof net === "number") s += " · net " + (net >= 0 ? "+" : "−") + "$" + Math.abs(net).toLocaleString();
    return s.slice(0, 155);
  }
  function stashTrade(nm, q, p, uid) { try { GM_setValue("pending_trade", { line: mkTradeLine(nm, q, p), uid: uid || 0, at: Date.now() }); } catch (e) { } }
  function buyCostOf(id) { const r = (state.rows || []).find(function (x) { return x.id == id; }); return r ? r.buy : null; }
  const ago = function (secs) {
    if (secs == null) return "?";
    const m = Math.floor(secs / 60);
    return m < 1 ? secs + "s" : m + "m";
  };

  function primaryStockAcronym() {
    const mine = state.stkMine || {}, mkt = state.stkMkt || {};
    let best = null, maxVal = 0;
    Object.keys(mine).forEach(function (id) {
      const h = mine[id], s = mkt[id];
      if (h && s && h.total_shares > 0) {
        const val = h.total_shares * s.current_price;
        if (val > maxVal) { maxVal = val; best = s.acronym; }
      }
    });
    return best || "STK";
  }

  /* ---------- data ---------- */
  async function loadResale(key) {
    const now = Date.now();
    if (state.resale && now - state.resaleAt < 600000) return state.resale;
    const j = await gmGet("https://api.torn.com/torn/?selections=items&key=" + encodeURIComponent(key));
    if (j.error) throw new Error("Torn API: " + j.error.error);
    const idx = {}, meta = {};
    Object.keys(j.items).forEach(function (id) {
      const it = j.items[id];
      idx[+id] = it.market_value;
      const eff = (it.effect || "").trim(), req = (it.requirement || "").trim();
      meta[+id] = { type: it.type || "", hasUse: !!(eff || req), name: it.name || "", buy: it.buy_price || 0, mkt: it.market_value || 0, circ: it.circulation || 0 };
    });
    state.resale = idx; state.itemMeta = meta; state.resaleAt = now;
    return idx;
  }

  async function loadTraderPrices(key) {
    if (!key) return {};
    const prices = {};
    try {
      const mk = await gmGet("https://weav3r.dev/api/marketplace?apiKey=" + encodeURIComponent(key), 20000);
      const items = (mk && mk.items) || [];
      items.forEach(function (it) {
        if (it && it.item_id > 0 && it.highest_trader_price > 0) {
          prices[it.item_id] = it.highest_trader_price;
        }
      });
    } catch (e) { /* non-fatal fallback */ }
    return prices;
  }

  async function loadCash(key) {
    try {
      const j = await gmGet("https://api.torn.com/user/?selections=money,networth,basic,travel&key=" + encodeURIComponent(key));
      if (j && typeof j.money_onhand === "number") state.cash = j.money_onhand;
      if (j && j.networth && typeof j.networth.stockmarket === "number") state.stocks = j.networth.stockmarket;
      if (j && typeof j.level === "number") state.myLevel = j.level;
      const tw = detectTravel(j);
      state.travelWhere = tw.where;
      state.loc = tw.where === "abroad" ? tw.cc : null;
      state.flyTo = tw.where === "flying" ? (tw.cc || null) : null;
      state.flyEta = tw.where === "flying" ? (tw.arriveIn || 0) : null;
      state.arrivalTs = (j && j.travel && j.travel.timestamp) || 0;
    } catch (e) { /* non-fatal */ }
  }
  function focusCC() { return state.loc || (state.travelWhere === "flying" ? state.flyTo : null) || null; }
  function applyLocationFilter() {
    const f = focusCC();
    if (f !== state.lastLoc) { state.lastLoc = f; state.filter = f || "all"; }
  }

  const HIST_MAX = 576, HIST_AGE = 48 * 3600;
  const EV_MAX = 80, EV_AGE = 30 * 86400;

  function isRealRestock(dq, prevQ, maxQ) {
    if (dq <= 0) return false;
    if ((maxQ || 0) <= 10) return prevQ === 0;
    return prevQ === 0 ? dq >= 5 : (dq >= prevQ && dq >= 5);
  }
  function recordStocks(yata) {
    if (!yata || !yata.stocks) return;
    let hist; try { hist = GM_getValue("stock_hist", null) || {}; } catch (e) { hist = {}; }
    let ev; try { ev = GM_getValue("stock_events", null) || {}; } catch (e) { ev = {}; }
    let sea; try { sea = GM_getValue("stock_seasonal", null) || {}; } catch (e) { sea = {}; }
    const now = Math.floor(Date.now() / 1000), cutoff = now - HIST_AGE, evCut = now - EV_AGE;
    let changed = false, evChanged = false, seaChanged = false;
    Object.keys(yata.stocks).forEach(function (cc) {
      if (!FLY[cc]) return;
      const block = yata.stocks[cc], upd = block.update || now;
      (block.stocks || block).forEach(function (it) {
        const key = cc + ":" + it.id, arr = hist[key] || (hist[key] = []);
        const last = arr[arr.length - 1];
        if (last && last[0] === upd) return;
        const prevT = last ? last[0] : null, prevQ = last ? last[1] : null, q = it.quantity;
        arr.push([upd, q]); changed = true;
        while (arr.length && arr[0][0] < cutoff) arr.shift();
        if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
        if (prevQ != null) {
          const rec = ev[key] || (ev[key] = { rs: [], so: [], q: null, max: 0, up: [] });
          rec.max = Math.max(rec.max || 0, prevQ, q);
          const dq = q - prevQ;
          if (dq < 0 && prevT != null) {
            const dt = upd - prevT;
            if (dt > 0 && dt <= 3600) {
              const d = new Date(((prevT + upd) / 2) * 1000), b = d.getUTCDay() * 24 + d.getUTCHours();
              const sk = sea[key] || (sea[key] = {}), cell = sk[b] || (sk[b] = [0, 0, 0]);
              cell[0] += -dq; cell[1] += dt; cell[2] += 1; seaChanged = true;
            }
          }
          if (dq > 0) { (rec.up || (rec.up = [])).push([upd, dq, prevQ]); evChanged = true; }
          if (isRealRestock(dq, prevQ, rec.max)) { rec.rs.push([upd, dq]); evChanged = true; }
          else if (prevQ > 0 && q === 0) { rec.so.push(upd); evChanged = true; }
          rec.q = q;
          rec.rs = rec.rs.filter(function (e) { return e[0] >= evCut; }); if (rec.rs.length > EV_MAX) rec.rs.splice(0, rec.rs.length - EV_MAX);
          rec.so = rec.so.filter(function (t) { return t >= evCut; }); if (rec.so.length > EV_MAX) rec.so.splice(0, rec.so.length - EV_MAX);
          if (rec.up) { rec.up = rec.up.filter(function (e) { return e[0] >= evCut; }); if (rec.up.length > 200) rec.up.splice(0, rec.up.length - 200); }
        }
      });
    });
    if (changed) { try { GM_setValue("stock_hist", hist); } catch (e) { } }
    if (evChanged) { try { GM_setValue("stock_events", ev); } catch (e) { } }
    if (seaChanged) { try { GM_setValue("stock_seasonal", sea); } catch (e) { } }
    state._hist = hist; state._ev = ev; state._seasonal = sea;
  }
  const med = function (arr) { if (!arr.length) return 0; const a = arr.slice().sort(function (x, y) { return x - y; }); return a[Math.floor(a.length / 2)]; };

  let _sharedCache;
  function sharedFresh() {
    let synced = 0; try { synced = GM_getValue("shared_synced_at", 0) || 0; } catch (e) { }
    if (!synced || Date.now() - synced > 4 * 86400 * 1000) return null;
    if (_sharedCache === undefined) { try { _sharedCache = GM_getValue("shared_data", null); } catch (e) { _sharedCache = null; } }
    return _sharedCache;
  }
  function evRecord(cc, id) {
    const key = cc + ":" + id, sd = sharedFresh();
    if (sd && sd.events && sd.events[key]) return sd.events[key];
    const ev = state._ev || (function () { try { return GM_getValue("stock_events", null) || {}; } catch (e) { return {}; } })();
    return ev[key];
  }
  function seasonalRecord(cc, id) {
    const key = cc + ":" + id, sd = sharedFresh();
    if (sd && sd.seasonal && sd.seasonal[key]) return sd.seasonal[key];
    const sea = state._seasonal || (function () { try { return GM_getValue("stock_seasonal", null) || {}; } catch (e) { return {}; } })();
    return sea[key];
  }

  // Central shared dataset (the always-on Google Apps Script collector) — baked in so every user reads it with no
  // setup; the client just prefers it per-item over its own thinner local record. Silent: no UI, auto-synced on load.
  const SHARED_URL = "https://script.google.com/macros/s/AKfycbz0xnXTzToEVuLkEEQ6z0mYVHGNREqqvOc1ihTEBUMSsxydu_IgYxLdrlYOgADJciuH/exec";
  function syncShared(manual, cb) {
    const url = GM_getValue("shared_url", "") || SHARED_URL; // GM override optional (no UI), else the baked-in feed
    if (!url) { if (cb) cb({ err: "No shared feed URL." }); return; }
    gmGet(url, 30000).then(function (j) {
      if (!j || j.kind !== "tdk-restock-export") { if (cb) cb({ err: "That URL didn’t return Trade Desk data." }); return; }
      try { GM_setValue("shared_data", { at: j.at, events: j.events || {}, seasonal: j.seasonal || {} }); GM_setValue("shared_synced_at", Date.now()); } catch (e) { }
      _sharedCache = undefined;
      let items = Object.keys(j.events || {}).length, buckets = 0; const s = j.seasonal || {}; Object.keys(s).forEach(function (k) { buckets += Object.keys(s[k]).length; });
      if (state.rows && state.rows.length) render();
      if (cb) cb({ items: items, buckets: buckets, at: j.at });
    }).catch(function (e) { if (cb) cb({ err: (e.message || e) }); });
  }

  function restockPredict(cc, id) {
    const rec = evRecord(cc, id); if (!rec || !rec.rs || rec.rs.length < 2) return null;
    const rs = rec.rs.slice().sort(function (a, b) { return a[0] - b[0]; });
    const ts = rs.map(function (e) { return e[0]; });
    const gaps = []; for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    const interval = med(gaps);
    const lastRs = ts[ts.length - 1], nextAt = lastRs + interval;
    const batch = med(rs.map(function (e) { return e[1]; }).filter(function (a) { return a > 0; }));
    const so = (rec.so || []).slice().sort(function (a, b) { return a - b; });
    const durs = [];
    so.forEach(function (st) { let pr = 0; for (let i = 0; i < ts.length; i++) { if (ts[i] < st) pr = ts[i]; else break; } if (pr) durs.push(st - pr); });
    const selloutDur = med(durs);
    const outDur = (interval && selloutDur && interval > selloutDur) ? interval - selloutDur : 0;
    return { interval: interval, lastRs: lastRs, nextAt: nextAt, n: ts.length, lastSo: so.length ? so[so.length - 1] : 0, batch: batch, selloutDur: selloutDur, outDur: outDur, nSo: durs.length };
  }

  const POLL_MS = 5 * 60 * 1000;
  function pollStocks() {
    let last = 0; try { last = GM_getValue("stock_poll_at", 0); } catch (e) { }
    if (Date.now() - last < POLL_MS - 4000) return;
    try { GM_setValue("stock_poll_at", Date.now()); } catch (e) { }
    gmGet("https://yata.yt/api/v1/travel/export/", 30000).then(recordStocks).catch(function () { });
  }

  function stockTrend(cc, id) {
    const hist = state._hist || (function () { try { return GM_getValue("stock_hist", null) || {}; } catch (e) { return {}; } })();
    const arr = hist[cc + ":" + id]; if (!arr || arr.length < 2) return null;
    const a = arr[arr.length - 2], b = arr[arr.length - 1], dq = b[1] - a[1];
    if (!dq) return null;
    let maxQ = 0; for (let i = 0; i < arr.length; i++) if (arr[i][1] > maxQ) maxQ = arr[i][1];
    return { dq: dq, perMin: dq / (Math.max(60, b[0] - a[0]) / 60), prev: a[1], maxQ: maxQ };
  }

  function buyRate(cc, id) {
    const hist = state._hist || (function () { try { return GM_getValue("stock_hist", null) || {}; } catch (e) { return {}; } })();
    const arr = hist[cc + ":" + id]; if (!arr || arr.length < 2) return null;
    let sold = 0, secs = 0, nSeg = 0;
    for (let i = 1; i < arr.length; i++) {
      const dq = arr[i][1] - arr[i - 1][1], dt = arr[i][0] - arr[i - 1][0];
      if (dq < 0 && dt > 0) { sold += -dq; secs += dt; nSeg++; }
    }
    if (sold <= 0 || secs <= 0) return null;
    return { perMin: sold / (secs / 60), sold: sold, sellMin: secs / 60, nSeg: nSeg };
  }

  // Time-of-week sell velocity averaged over the FLIGHT WINDOW (only the dow×hours you'd actually be in transit),
  // from the seasonal buckets. Returns null when the window's buckets are too thin to lean on. Note: like the
  // buckets themselves, this is the rate WHILE actively selling (denominator = selling-seconds), used only for the
  // near-term "does current stock survive a short hop" check — NOT integrated blindly over multi-hour flights.
  function seasonalRate(cc, id, fromTs, toTs) {
    const sea = seasonalRecord(cc, id); if (!sea) return null;
    let sold = 0, secs = 0, span = 0, covered = 0, minSamp = Infinity, t = fromTs;
    while (t < toTs) {
      const nextHour = Math.min(toTs, (Math.floor(t / 3600) + 1) * 3600), dt = nextHour - t;
      const cell = sea[new Date(t * 1000).getUTCDay() * 24 + new Date(t * 1000).getUTCHours()];
      span += dt;
      if (cell && cell[1] > 0 && cell[2] >= 1) { sold += cell[0]; secs += cell[1]; covered += dt; minSamp = Math.min(minSamp, cell[2]); }
      t = nextHour;
    }
    if (secs <= 0 || sold <= 0) return null;
    return { perMin: sold / (secs / 60), coverage: span > 0 ? covered / span : 0, minSamp: minSamp === Infinity ? 0 : minSamp };
  }

  // "Landing": predicted stock when you'd touch down if you flew NOW. Foreign stock RESTOCKS on a short cycle, so:
  //  - a LONG flight spans many restock cycles → availability is governed by the CYCLE (how much of each cycle the
  //    item holds stock = selloutDur/interval), NOT by draining current stock to zero;
  //  - a SHORT hop (< one restock cycle, or no cycle data) → the near-term question: does CURRENT stock survive the
  //    trip, and if it sells out, does a restock land before you do?
  function arrivalOutlook(x) {
    if (!FLY[x.cc]) return null;
    const nowS = Math.floor(Date.now() / 1000);
    let arr;
    if (state.travelWhere === "abroad" && x.cc === state.loc) arr = nowS;
    else if (state.travelWhere === "flying" && x.cc === state.flyTo && state.arrivalTs) arr = state.arrivalTs;
    else arr = nowS + Math.round(rtOf(x.cc) / 2) * 60;
    const flight = arr - nowS, landTxt = flight <= 30 ? "you arrive" : "you land in ~" + fmtDur(flight);
    const cap = state.cap, st = x.stock, rp = restockPredict(x.cc, x.id);
    const dur = function (s) { return fmtDur(Math.max(0, Math.round(s))); };
    let nextRs = null; // next predicted restock at/after now
    if (rp && rp.nextAt && rp.interval > 0) { nextRs = rp.nextAt; let g = 0; while (nextRs < nowS && g++ < 5000) nextRs += rp.interval; }

    // --- LONG flight: item restocks ≥1× in transit → availability is set by the CYCLE, not depletion ---
    if (rp && rp.interval > 0 && flight >= rp.interval) {
      const frac = (rp.selloutDur > 0 && rp.interval > 0) ? Math.min(1, rp.selloutDur / rp.interval) : (st > 0 ? 1 : 0); // share of each cycle it holds stock ≈ odds it's up on arrival
      if (rp.nSo === 0 || frac >= 0.6) return { cls: "good", txt: "✓ In stock", tip: "Usually in stock — should be available when " + landTxt + "." };
      if (frac >= 0.25) return { cls: "warn", txt: "◐ Maybe", tip: "In stock only ~" + Math.round(frac * 100) + "% of the time — best right after a restock (~every " + dur(rp.interval) + ")." };
      return { cls: "warn", txt: "◐ Maybe", tip: "Sells out fast — usually empty except just after a restock (~every " + dur(rp.interval) + ")." };
    }

    // --- SHORT hop (or no cycle data): does CURRENT stock survive, and does a restock beat you there? ---
    const br = buyRate(x.cc, x.id), sr = seasonalRate(x.cc, x.id, nowS, arr);
    const rate = (sr && sr.coverage >= 0.5) ? sr.perMin : (br ? br.perMin : 0);
    let outAt = Infinity;
    if (st <= 0) outAt = nowS; else if (rate > 0) outAt = nowS + (st / rate) * 60;
    if (st > 0 && outAt > arr) {
      if (st >= cap) return { cls: "good", txt: "✓ In stock", tip: "In stock now and should last until " + landTxt + "." };
      return { cls: "warn", txt: "◐ Partial", tip: "Only " + st.toLocaleString() + " in stock — under your cap of " + cap + " (partial load) when " + landTxt + "." };
    }
    if (st <= 0) {
      if (nextRs && nextRs <= arr) return { cls: "good", txt: "✓ In stock", tip: "Out now, but a fresh restock should land before " + landTxt + "." };
      if (nextRs) return { cls: "bad", txt: "✗ Empty", tip: "Out now — next restock is after " + landTxt + "." };
      return { cls: "unk", txt: "?", tip: "Out now — not enough history yet to predict the next restock." };
    }
    const rsAfterOut = (rp && rp.outDur) ? outAt + rp.outDur : nextRs; // the restock following this stock selling out
    if (rsAfterOut && rsAfterOut <= arr) return { cls: "good", txt: "✓ In stock", tip: "Sells out mid-flight, but should restock before " + landTxt + "." };
    return { cls: "bad", txt: "✗ Empty", tip: "Likely sold out before " + landTxt + "." };
  }

  async function loadOC(key) {
    try {
      const j = await gmGet("https://api.torn.com/v2/user/organizedcrime?key=" + encodeURIComponent(key));
      const oc = j && j.organizedCrime, nowS = Math.floor(Date.now() / 1000);
      const st = oc ? String(oc.status || "").toLowerCase() : "";
      if (!oc || oc.executed_at || (oc.expired_at && oc.expired_at < nowS) || ["successful", "failure", "failed", "expired", "completed"].indexOf(st) !== -1) { state.oc = null; return; }
      state.oc = { name: oc.name, status: oc.status, readyAt: oc.ready_at || 0 };
    } catch (e) { /* non-fatal */ }
  }
  function ocGuard() {
    const oc = state.oc; if (!oc || !oc.readyAt) return null;
    const provisional = String(oc.status || "").toLowerCase() === "recruiting";
    return { name: oc.name, secs: oc.readyAt - Math.floor(Date.now() / 1000), status: oc.status, provisional: provisional };
  }
  function fmtDur(secs) {
    secs = Math.max(0, secs | 0);
    const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60;
    return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m ? m + "m " + s + "s" : s + "s";
  }
  function mmss(secs) {
    secs = Math.max(0, secs | 0);
    const h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60;
    return h ? h + "h " + m + "m" : m + ":" + (s < 10 ? "0" : "") + s;
  }
  let landTimer = null;
  function armLandingRefresh() {
    if (landTimer) { clearTimeout(landTimer); landTimer = null; }
    if (state.travelWhere === "flying" && state.flyEta > 0) {
      landTimer = setTimeout(function () { landTimer = null; refresh(); }, (state.flyEta + 2) * 1000);
    }
  }
  async function refresh() {
    setStatus("Refreshing…");
    const key = tornKey();
    if (!key) { setStatus("Need a Torn API key.", true); return; }
    const w3b = GM_getValue("w3b_key", "");
    try {
      const [yata, resale, traderPrices] = await Promise.all([
        gmGet("https://yata.yt/api/v1/travel/export/", 30000),
        loadResale(key),
        state.priceBasis === "trader" ? loadTraderPrices(w3b) : Promise.resolve({})
      ]);
      await loadCash(key);
      await loadOC(key);
      recordStocks(yata);
      const nowS = Math.floor(Date.now() / 1000);
      const rows = [];
      state.updates = {};
      Object.keys(yata.stocks).forEach(function (cc) {
        const f = FLY[cc]; if (!f) return;
        const block = yata.stocks[cc];
        state.updates[cc] = block.update ? nowS - block.update : null;
        (block.stocks || block).forEach(function (it) {
          const mktSell = resale[it.id]; if (!mktSell) return;
          const traderSell = traderPrices[it.id] || 0;
          const sell = (state.priceBasis === "trader" && traderSell > 0) ? traderSell : mktSell;
          const ppi = sell - it.cost;
          if (ppi <= 0) return;
          const cap = state.cap;
          const ppm = Math.round((ppi * cap - f.fare) / rtOf(cc));
          rows.push({ id: it.id, name: it.name, cc: cc, country: f.name, buy: it.cost, sell: sell, stock: it.quantity, ppi: ppi, ppm: ppm, full: it.cost * cap, freshS: state.updates[cc], isTraderPrice: state.priceBasis === "trader" && traderSell > 0 });
        });
      });
      rows.sort(function (a, b) { return b.ppm - a.ppm; });
      state.rows = rows;
      state.foreignIds = new Set(); Object.values(yata.stocks).forEach(function (b) { (b.stocks || []).forEach(function (it) { state.foreignIds.add(it.id); }); });
      applyLocationFilter();
      render();
      const flyNote = state.flyTo && FLY[state.flyTo]
        ? " · ✈ heading to " + FLY[state.flyTo].name + (state.flyEta ? " · land in " + fmtRt(Math.ceil(state.flyEta / 60)) : "") + " — planning ahead"
        : " · ✈ In flight";
      const locNote = state.travelWhere === "abroad" && FLY[state.loc] ? " · 📍 you're in " + FLY[state.loc].name
        : state.travelWhere === "home" ? " · 🏠 Home"
          : state.travelWhere === "flying" ? flyNote
            : "";
      const basisNote = state.priceBasis === "trader" ? " · ⚡ Trader Instant Prices" : " · 🛒 Item Market Avg";
      setStatus("Updated " + new Date().toLocaleTimeString() + locNote + basisNote);
      armLandingRefresh();
    } catch (e) {
      const msg = e.message || "";
      const isYata = e.url && e.url.indexOf("yata.yt") !== -1;
      const down = e.kind === "timeout" || e.kind === "network" || e.status >= 500;
      if (KEYERR.test(msg)) {
        statusKeyError(msg.replace(/^Torn API:\s*/, ""));
      } else if (isYata && down) {
        setStatus("YATA is down (" + (e.status || e.kind) + ") — stock data unavailable, retry shortly.", true);
      } else {
        setStatus("Refresh failed — " + msg, true);
      }
    }
  }

  /* ---------- UI ---------- */
  let host, panel;
  function css() {
    return `
    #tdk-btn{position:fixed;right:18px;bottom:18px;z-index:2147483600;width:46px;height:46px;border-radius:50%;
      background:#14130f;border:1px solid #d9b441;color:#d9b441;font-size:20px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.5)}
    #tdk-btn:hover{background:#201e17}
    #tdk-panel{position:fixed;right:28px;top:12px;z-index:2147483000;width:min(780px,92vw);max-height:calc(100vh - 24px);overflow:hidden;padding:0;
      background:#14130f;color:#ece7d8;border:1px solid #2c2a21;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);
      font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;display:none}
    #tdk-panel.open{display:flex}
    /* ---- Command Rail shell (v1.52) — vertical icon nav on the left, scrolling content column on the right ---- */
    .tdk-rail{flex:0 0 50px;width:50px;display:flex;flex-direction:column;gap:4px;padding:8px 7px;background:#100f0b;border-right:1px solid #2c2a21;overflow-y:auto}
    .tdk-rail .tdk-railsp{flex:1;min-height:6px}
    .tdk-rail .tdk-btn2{display:flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;background:transparent;border:1px solid transparent;color:#928b78;border-radius:10px}
    .tdk-rail .tdk-btn2 i{font-size:18px;font-style:normal;line-height:1}
    .tdk-rail .tdk-btn2 span{display:none}
    .tdk-rail .tdk-btn2:hover{background:#262112;color:#ece7d8}
    .tdk-rail .tdk-btn2.on{background:#d9b441;color:#14130f;border-color:transparent}
    .tdk-rail .tdk-btn2.ready{background:#16241c;border-color:#4cc281;color:#8fe6b3;animation:tdkpulse 1.8s ease-in-out infinite}
    .tdk-col{flex:1;min-width:0;min-height:0;overflow-y:auto;max-height:calc(100vh - 26px);scrollbar-gutter:stable}
    .tdk-topbar{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:9px;padding:12px 46px 10px 16px;background:#14130f;border-bottom:1px solid #2c2a21;flex-wrap:wrap}
    .tdk-topbar .t{font-weight:800;letter-spacing:.02em}
    .tdk-topbar .t small{color:#928b78;font-weight:600;letter-spacing:.12em;text-transform:uppercase;font-size:10px;margin-left:6px}
    .tdk-topbar .sp{flex:1}
    .tdk-topbar .capw{font-size:12px;color:#928b78}
    .tdk-hd{position:sticky;top:0;z-index:6;background:#14130f;border-bottom:1px solid #2c2a21}
    .tdk-h{display:flex;align-items:center;gap:9px;padding:14px 52px 8px 16px;background:#14130f;flex-wrap:wrap}
    .tdk-h2{display:flex;align-items:center;gap:9px;padding:0 16px 12px;flex-wrap:wrap}
    .tdk-h .t{font-weight:800;letter-spacing:.02em}
    .tdk-h .t small{color:#928b78;font-weight:600;letter-spacing:.14em;text-transform:uppercase;font-size:10px;display:block}
    .tdk-h .sp,.tdk-h2 .sp{flex:1}
    .tdk-btn2{background:#2a2413;border:1px solid #d9b441;color:#d9b441;border-radius:9px;padding:7px 11px;font-weight:700;cursor:pointer}
    .tdk-btn2.ready{border-color:#4cc281;color:#8fe6b3;background:#16241c;animation:tdkpulse 1.8s ease-in-out infinite}
    @keyframes tdkpulse{0%,100%{box-shadow:0 0 0 1px rgba(76,194,129,.25)}50%{box-shadow:0 0 0 4px rgba(76,194,129,.5)}}
    .tdk-btn2:hover{background:#332a15}
    .tdk-cap{width:56px;background:#201e17;border:1px solid #3a3729;color:#ece7d8;border-radius:8px;padding:6px 8px;
      font-family:ui-monospace,Consolas,monospace}
    .tdk-status{font-size:11px;color:#928b78;padding:0 16px 6px}
    .tdk-status.err{color:#e5615c}
    .tdk-sett-link{color:#d9b441;cursor:pointer;text-decoration:none;border-bottom:1px dotted #d9b441}
    .tdk-sett-link:hover{color:#f0cf6b}
    .tdk-best{margin:12px 16px;padding:12px 14px;border:1px solid #3a3729;border-left:4px solid #d9b441;border-radius:10px;background:#1b1a14}
    .tdk-best .l{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#d9b441;font-weight:700}
    .tdk-best .p{font-size:18px;font-weight:800;margin-top:2px}
    .tdk-best .p span{color:#928b78;font-weight:600;font-size:13px}
    .tdk-best .k{color:#928b78;font-size:12px;margin-top:4px}
    .tdk-best .k b{color:#d9b441;font-family:ui-monospace,monospace}
    table.tdk{width:100%;border-collapse:collapse}
    table.tdk th{position:sticky;top:0;text-align:right;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#928b78;
      font-weight:700;padding:9px 14px;border-bottom:1px solid #3a3729;background:#201e17;white-space:nowrap}
    table.tdk th.l,table.tdk td.l{text-align:left}
    table.tdk th.so{cursor:pointer;user-select:none}
    table.tdk th.so:hover{color:#c3bda9}
    table.tdk th.so.on{color:#d9b441}
    table.tdk th.so.on::after{content:" ▾"}
    table.tdk td{padding:9px 14px;border-bottom:1px solid #211f18;text-align:right;white-space:nowrap;
      font-family:ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
    table.tdk td.mv{color:#ded7c5}
    table.tdk td.mv.needfund{color:#e2933f;font-weight:700;cursor:help}
    .tdk-stktag{color:#d9b441;font-size:10px;margin-left:4px;font-weight:800;font-family:system-ui,sans-serif}
    table.tdk td.ldc{padding-left:8px;padding-right:8px}
    .ld{font-weight:700;white-space:nowrap;font-size:11px}
    .ld-good{color:#5cbb81}.ld-warn{color:#e2933f}.ld-bad{color:#e5615c}.ld-unk{color:#6f6a5a}
    table.tdk td.num{color:#c3bda9}
    table.tdk td.l{font-family:system-ui,sans-serif}
    table.tdk tr.dim td{opacity:.82}
    table.tdk tr:hover td{background:#1b1a14}
    .nm{font-weight:700;color:#f2eddf}.cy{color:#a49c88;font-size:11px}
    table.tdk td.l .cy2{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#8f886f;margin-top:2px;letter-spacing:.01em}
    table.tdk td.l .cy2 .needfund{color:#e2933f;font-weight:700;cursor:help}
    table.tdk th.l .thsub{font-weight:500;color:#6f6a5a;text-transform:none;letter-spacing:.02em;font-size:9px;margin-left:6px}
    /* Board table: fixed layout so the 5 columns always fit the panel — no horizontal scroll (scoped to #tdk-board so the Bag/pack tables are untouched) */
    #tdk-board table.tdk{table-layout:fixed}
    #tdk-board table.tdk th[data-sort="fullprofit"]{width:96px}
    #tdk-board table.tdk th[data-sort="stock"]{width:84px}
    #tdk-board table.tdk th.ld{width:104px}
    #tdk-board table.tdk th[data-sort="ppm"]{width:100px}
    #tdk-board table.tdk td.ppm,#tdk-board table.tdk th[data-sort="ppm"]{padding-right:22px} /* keep $/min off the panel's right edge / scrollbar */
    #tdk-board table.tdk td.l{overflow:hidden}
    #tdk-board table.tdk td.l .nm,#tdk-board table.tdk td.l .cy,#tdk-board table.tdk td.l .cy2{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ppm{color:#d9b441;font-weight:800}
    .gd{color:#4cc281;font-weight:700}
    .chip{font-family:system-ui,sans-serif;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px}
    .c-ok{color:#4cc281;background:#16281d}.c-low{color:#e2933f;background:#2c2114}.c-out{color:#e5615c;background:#2c1717}
    .tk-tr{font-size:9px;margin-right:4px;vertical-align:middle}.tk-tr.up{color:#4cc281}.tk-tr.dn{color:#e5615c}
    .rs-eta{font-size:9px;color:#9fc7f0;margin-left:4px;white-space:nowrap;cursor:help;font-family:ui-monospace,monospace}
    .star{color:#d9b441;margin-left:6px}
    /* view switcher */
    .tdk-vsw{display:flex;justify-content:flex-end;gap:3px;padding:0 16px 8px}
    .tdk-vsw button{width:30px;height:26px;border:1px solid #3c3623;background:#201e17;color:#928b78;border-radius:7px;font-size:14px;cursor:pointer;line-height:1}
    .tdk-vsw button:hover{color:#ece7d8}
    .tdk-vsw button.on{background:#d9b441;color:#14130f;border-color:transparent}
    /* cards lens */
    .tk-cards{display:flex;flex-direction:column;gap:8px;padding:0 12px 12px}
    .tk-card{display:flex;gap:12px;align-items:flex-start;border:1px solid #332e1e;border-radius:11px;background:#1e1b12;padding:12px 14px;cursor:pointer}
    .tk-card:hover{background:#231f14}
    .tk-card.dim{opacity:.72}.tk-card.fund{border-color:#d9b441;background:#221d10}.tk-card.ocmiss{background:#241717}
    .tk-card .tk-cl{min-width:0;flex:1}
    .tk-card .tk-cl .cy{color:#a49c88;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tk-card .tk-cl .cy2{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#8f886f;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tk-card .tk-cr{text-align:right;white-space:nowrap}
    .tk-card .tk-cppm{font-family:ui-monospace,monospace;color:#d9b441;font-weight:800;font-size:16px}
    .tk-card .tk-cppm small{color:#8f886f;font-weight:500;font-size:11px}
    .tk-card .tk-csub{font-size:11px;color:#8f886f;margin-top:3px;font-family:ui-monospace,monospace}
    /* leaderboard lens */
    .tk-lb{display:flex;flex-direction:column;gap:8px;padding:0 12px 12px}
    .tk-bar{position:relative;display:flex;align-items:center;gap:12px;min-height:46px;border:1px solid #332e1e;border-radius:10px;background:#1f1c11;padding-right:14px;overflow:hidden;cursor:pointer}
    .tk-bar.dim{opacity:.72}
    .tk-fill{position:absolute;left:0;top:0;bottom:0;border-radius:9px 0 0 9px;background:linear-gradient(90deg,rgba(217,180,65,.30),rgba(217,180,65,.04));border-left:3px solid #d9b441}
    .tk-bar.b-warn .tk-fill{background:linear-gradient(90deg,rgba(226,163,74,.26),rgba(226,163,74,.03));border-left-color:#e2933f}
    .tk-bar.b-bad .tk-fill{background:linear-gradient(90deg,rgba(229,97,92,.24),rgba(229,97,92,.03));border-left-color:#e5615c}
    .tk-bar.b-unk .tk-fill{background:linear-gradient(90deg,rgba(143,136,111,.18),transparent);border-left-color:#6f6a5a}
    .tk-rank{position:relative;width:26px;text-align:center;font-family:ui-monospace,monospace;color:#8f886f;font-weight:800}
    .tk-bn{position:relative;font-weight:600;color:#f2eddf;min-width:0;overflow:hidden;text-overflow:ellipsis}
    .tk-bn small{display:block;color:#8f886f;font-size:11px;font-weight:400}
    .tk-br{position:relative;margin-left:auto;text-align:right;padding-left:8px}
    .tk-bp{font-family:ui-monospace,monospace;color:#d9b441;font-weight:800;font-size:15px;display:block}
    /* departures lens */
    .tk-flipwrap{overflow-x:auto;padding:0 6px 10px}
    table.tk-flip{width:100%;border-collapse:collapse;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
    table.tk-flip th{font-size:9px;letter-spacing:.12em;color:#b9932f;text-transform:uppercase;text-align:left;padding:8px 12px;border-bottom:1px solid #2a2410;white-space:nowrap}
    table.tk-flip td{padding:10px 12px;border-bottom:1px solid #201a0c;color:#eec95f;white-space:nowrap;cursor:pointer}
    table.tk-flip td:last-child,table.tk-flip th:last-child{padding-right:20px} /* keep Status off the right edge */
    table.tk-flip tr:hover td{background:#12100a}
    .tk-flip .dep-dest{color:#f4efe0;font-weight:700;letter-spacing:.06em}
    .tk-flip .dep-ppm{color:#d9b441;font-weight:800}
    .tk-flip .dep-prof{color:#4cc281}
    .stt{display:inline-block;font-weight:800;padding:3px 8px;border-radius:3px;letter-spacing:.06em;font-size:10px;color:#14130f}
    .stt.go{background:#69c58a}.stt.warn{background:#e2933f}.stt.no{background:#e5615c}.stt.mut{background:#3a3729;color:#928b78}
    .tdk-filter{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 10px}
    .tdk-fc{font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;cursor:pointer;border:1px solid #3a3729;background:#1b1a14;color:#c3bda9}
    .tdk-fc:hover{background:#201e17}
    .tdk-fc.on{background:#2a2413;border-color:#d9b441;color:#d9b441}
    .tdk-fc.here{border-color:#4cc281;color:#8fe6b3}
    .tdk-fc.here.on{background:#16241c;border-color:#4cc281;color:#8fe6b3}
    .tdk-fc.heading{border-color:#4a90d9;color:#9fc7f0}
    .tdk-fc.heading.on{background:#152230;border-color:#4a90d9;color:#9fc7f0}
    .tdk-tsel{margin-left:auto;font-size:11px;font-weight:700;padding:4px 8px;border-radius:999px;cursor:pointer;border:1px solid #3a3729;background:#1b1a14;color:#c3bda9}
    .tdk-tsel:focus{outline:none;border-color:#d9b441;color:#d9b441}
    .tdk-btn2.on{background:#d9b441;color:#14130f;border-color:#d9b441}
    .tdk-sm{padding:7px 9px;font-size:12px}
    .tdk-ver{cursor:pointer;border-bottom:1px dotted #928b78}
    .tdk-ver:hover{color:#d9b441;border-bottom-color:#d9b441}
    .tdk-ver[data-new]:not([data-new=""])::after{content:" 🆕" attr(data-new);color:#4cc281;font-weight:800;border:none}
    ul.bwlog{margin:4px 0 0;padding-left:18px;color:#c3bda9;font-size:12px;line-height:1.5}
    ul.bwlog li{margin:2px 0}
    ul.bwlog code{color:#9fc7f0;font-family:ui-monospace,Consolas,monospace}
    ul.bwlog b{color:#4cc281}
    ul.bwlog li.muted{color:#7c7566;font-style:italic}
    .tdk-upbar{display:flex;align-items:center;gap:10px;margin:2px 0 10px;flex-wrap:wrap}
    .tdk-upbar2{margin-top:-6px}
    .tdk-upd{font-size:12px;color:#928b78}
    .tdk-impbox{display:flex;gap:8px;align-items:flex-start;margin:-4px 0 10px}
    .tdk-impbox textarea{flex:1;min-width:0;height:64px;resize:vertical;background:#201e17;border:1px solid #3a3729;color:#ece7d8;border-radius:8px;padding:7px 9px;font-family:ui-monospace,monospace;font-size:11px}
    .tdk-upd b{color:#d9b441;font-family:ui-monospace,monospace}
    .tdk-upd a{color:#d9b441;text-decoration:none;border-bottom:1px dotted #d9b441}
    .tdk-upd a:hover{color:#f0cf6b}
    .tdk-clog{padding:9px 0;border-bottom:1px solid #2c2a21}
    .tdk-clog:last-child{border-bottom:none}
    .tdk-clog .cv{font-weight:800;color:#d9b441}
    .tdk-clog .cv span{color:#928b78;font-weight:600;font-size:11px}
    details.tdk-clog>summary{cursor:pointer;list-style:none;user-select:none}
    details.tdk-clog>summary::-webkit-details-marker{display:none}
    details.tdk-clog>summary::before{content:"▸";color:#928b78;margin-right:7px;font-size:11px;display:inline-block}
    details.tdk-clog[open]>summary::before{content:"▾"}
    .tdk-clog ul{margin:4px 0 0;padding-left:18px;color:#c3bda9;font-size:12.5px;line-height:1.5}
    .tdk-clog li{margin:2px 0}
    .chip.short{color:#e2933f;background:#2c2114;margin-left:6px}
    table.tdk tr.fund td{opacity:1;background:#221d10}
    table.tdk tr.fund td.l{box-shadow:inset 3px 0 0 #d9b441}
    .tdk-fund2{margin-top:8px;padding-top:8px;border-top:1px dashed #3a3729;font-size:12px;color:#e2933f;line-height:1.45}
    .tdk-fund2 b{color:#d9b441;font-family:ui-monospace,monospace}
    .tdk-keep{color:#928b78;font-size:11px;white-space:nowrap}
    .tdk-keephdr{margin:12px 0 4px;font-size:12px;font-weight:700;color:#c9a94a;border-top:1px dashed #3a3729;padding-top:8px}
    .tdk-keephdr span{color:#928b78;font-weight:400}
    .tdk-sub{color:#928b78;font-size:12px;padding:6px 0}
    .tdk-inl{font-size:13px;padding-left:6px;vertical-align:middle;position:relative;top:-1px;white-space:nowrap;line-height:1}
    .tdk-inl.ovr{text-decoration:underline dotted;text-underline-offset:3px}
    .tdk-mkt{display:inline-block;vertical-align:middle}
    .tdk-mkt a{text-decoration:none;font-size:15px;margin-left:6px;cursor:pointer;filter:grayscale(.15)}
    .tdk-mkt a:hover{filter:none}
    .tdk-shop-tag{margin-left:6px;font-size:11px;font-weight:700;padding:1px 5px;border-radius:5px;white-space:nowrap;vertical-align:middle}
    .tdk-shop-tag.good{background:rgba(85,170,90,.18);color:#7ac67f;border:1px solid rgba(85,170,90,.4)}
    .tdk-shop-tag.meh{background:transparent;color:#8f886f;font-weight:600}
    .tdk-im-banner{flex:0 0 100%;width:100%;box-sizing:border-box;margin:0 0 8px;padding:8px 12px;background:#1b1a14;border:1px solid #d9b441;border-radius:8px;color:#d8d2bf;font-size:13px;line-height:1.5}
    .tdk-im-banner b{color:#f0e7cf}
    .tdk-im-banner .tdk-im-x{color:#7ac67f;font-weight:700}
    .tdk-im-guard{cursor:pointer;font-size:15px;margin-right:4px;user-select:none}
    .tdk-im-flip{outline:2px solid rgba(85,170,90,.55);outline-offset:-2px;border-radius:6px;background:rgba(85,170,90,.08)}
    .tdk-im-ftag{margin-left:8px;font-size:11px;font-weight:800;color:#7ac67f;background:rgba(85,170,90,.16);border:1px solid rgba(85,170,90,.4);border-radius:5px;padding:1px 5px;white-space:nowrap}
    .tdk-tog{cursor:pointer;margin-left:6px;font-size:12px;opacity:.85}
    .tdk-tog:hover{opacity:1}
    .tdk-act{white-space:nowrap}
    table.tdk tr.tdk-ovr td{background:rgba(217,180,65,.06)}
    .fly{color:#c3bda9;text-decoration:none;border-bottom:1px dotted #4a4536}
    .fly:hover{color:#d9b441;border-bottom-color:#d9b441}
    .tdk-mug{margin:0;padding:11px 16px;border-top:1px solid #2c2a21;font-size:12px;color:#928b78;background:#181712;line-height:1.45}
    .tdk-mug b{color:#e5615c;font-family:ui-monospace,monospace}
    table.tdk tbody tr{cursor:pointer}
    #tdk-buyers{position:fixed;top:58px;right:22px;width:min(720px,92vw);z-index:2147483650;background:#1b1a14;border:1px solid #d9b441;border-radius:12px;box-shadow:0 16px 44px rgba(0,0,0,.65);padding:13px 15px;display:none;max-height:calc(100vh - 78px);overflow:auto;resize:both}
    #tdk-buyers.open{display:block}
    .tdk-bh{display:flex;align-items:center;gap:10px;margin-bottom:6px}
    .tdk-bh .tt{font-weight:800;font-size:14px}
    .tdk-bh .tt small{color:#928b78;font-weight:600;font-size:11px}
    .tdk-bx{margin-left:auto;cursor:pointer;color:#928b78;font-size:20px;background:none;border:none;line-height:1}
    .tdk-bx:hover{color:#e5615c}
    .tdk-calc{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:12px;color:#c3bda9;flex-wrap:wrap}
    .tdk-calc input{width:66px;background:#201e17;border:1px solid #3a3729;color:#ece7d8;border-radius:8px;padding:5px 7px;font-family:ui-monospace,monospace}
    .tdk-calc-hint{color:#928b78;font-size:11px}
    .tdk-brow .bp{text-align:right}
    .tdk-brow .bp .ea{color:#928b78;font-size:10px;font-weight:600}
    .tdk-brow .bt{color:#8fe6b3;font-size:11px;font-weight:700;font-family:ui-monospace,monospace;margin-top:1px}
    .tdk-brow .bt .netp{color:#d9b441}.tdk-brow .bt .netp.neg{color:#e5615c}
    .tdk-flip{display:flex;align-items:center;gap:12px;padding:9px 12px;border-bottom:1px solid #2c2a21;cursor:pointer}
    .tdk-flip:hover{background:#1b1a14}
    .tdk-flip .fn{flex:1;font-weight:700;color:#f2eddf}
    .tdk-flip .fs{font-weight:400;font-size:11px;color:#a49c88;margin-top:2px}
    .tdk-flip .fs b{color:#ded7c5;font-family:ui-monospace,monospace}.tdk-flip .fs span{color:#7c7566}
    .tdk-flip .fp{text-align:right}
    .tdk-flip .fpv{color:#4cc281;font-weight:800;font-family:ui-monospace,monospace}
    .tdk-flip .fpm{color:#928b78;font-size:11px}
    .tdk-flip .fwarn{color:#e2933f;cursor:help}
    .tdk-flip .fbuy{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;margin:0 2px;border-radius:6px;border:1px solid #3a3729;color:#d9b441;text-decoration:none;background:#201e17;white-space:nowrap}
    .tdk-flip .fbuy:hover{background:#2a2413;border-color:#d9b441}
    .sksec{margin:10px 12px 4px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#d9b441;font-weight:700;border-top:1px dashed #3a3729;padding-top:8px}
    .sksec b.up{color:#4cc281}.sksec b.dn{color:#e5615c}
    .skrow{display:flex;align-items:flex-start;gap:12px;padding:8px 12px;border-bottom:1px solid #211f18}
    .skmain{flex:1;min-width:0}
    .skn{font-weight:700;color:#f2eddf}.skn span{color:#a49c88;font-weight:400;font-size:11px}
    .skn .skhold{color:#4cc281;font-size:10px}
    .sksub{font-size:11px;color:#a49c88;margin-top:2px;font-family:ui-monospace,monospace}
    .skhint{font-size:11px;color:#c3bda9;margin-top:3px}
    .sknet{font-size:11px;color:#928b78;margin-top:2px}.sknet b.up{color:#4cc281}.sknet b.dn{color:#e5615c}.sknet span{color:#7c7566}
    .skpl{text-align:right;font-family:ui-monospace,monospace;white-space:nowrap}
    .skpl .up{color:#4cc281;font-weight:800}.skpl .dn{color:#e5615c;font-weight:800}
    .skpct{color:#928b78;font-size:11px}
    .sktag{font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;margin-left:4px}
    .sktag.low{color:#4cc281;background:#16281d}.sktag.high{color:#e2933f;background:#2c2114}.sktag.mid{color:#928b78;background:#211f18}
    .skbn{font-size:11px;color:#c9a94a;margin-top:3px}.skbn.ok{color:#4cc281}
    .skbar{display:inline-block;width:70px;height:6px;background:#211f18;border-radius:3px;overflow:hidden;vertical-align:middle;margin-right:6px}
    .skbar i{display:block;height:100%;background:#d9b441}
    .tdk-solo{font-size:11px;color:#c3bda9;white-space:nowrap;cursor:pointer}
    .bnty{display:flex;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid #211f18}
    .bnty.na{opacity:.55}
    .bnty .bmain{flex:1;min-width:0}
    .bnty .bn a{color:#e5615c;text-decoration:none;font-weight:700}
    .bnty .bn a:hover{text-decoration:underline}
    .bnty .bn .bl{color:#928b78;font-size:11px;font-weight:400;margin-left:2px}
    .bnty .bn .bprof{font-size:12px;text-decoration:none;margin-left:2px}
    .bnty .bsub{font-size:11px;color:#a49c88;margin-top:2px}
    .bnty .bpay{color:#4cc281;font-weight:800;font-family:ui-monospace,monospace;white-space:nowrap}
    .bnty .bpay span{color:#928b78;font-size:10px}
    .bnty .bhide{background:none;border:1px solid #3a3729;color:#928b78;border-radius:6px;padding:2px 5px;cursor:pointer;font-size:11px;line-height:1}
    .bnty .bhide:hover{border-color:#e5615c;color:#e5615c;background:#241717}
    .bnty.trap{opacity:.6}
    .bnty .btrap{color:#e5615c;font-weight:700}
    .bnty .bprot2{color:#9fc7f0}
    .bnty .bout{color:#e2933f}
    .tdk-cp{background:#2a2413;border:1px solid #d9b441;color:#d9b441;border-radius:8px;padding:5px 8px;cursor:pointer;font-size:12px;white-space:nowrap}
    .tdk-cp:hover{background:#332a15}
    .tdk-filldesc{display:block;margin:6px 0;background:#2a2413;border:1px solid #d9b441;color:#d9b441;border-radius:8px;padding:8px 11px;font-weight:700;cursor:pointer;font-size:12px;max-width:100%;text-align:left;white-space:normal;line-height:1.35}
    .tdk-filldesc:hover{background:#332a15}
    .tdk-set .sl{font-size:12px;color:#c3bda9;margin:8px 0 4px}
    .tdk-set .sl small{color:#928b78}
    .tdk-set .sl a.prof{color:#d9b441;text-decoration:none;border-bottom:1px dotted #4a4536}
    .tdk-set .srow{display:flex;gap:8px;align-items:center;margin-bottom:4px}
    .tdk-set input{flex:1;min-width:0;background:#201e17;border:1px solid #3a3729;color:#ece7d8;border-radius:8px;padding:7px 9px;font-family:ui-monospace,monospace;font-size:12px}
    .tdk-set .ssub{font-size:12px;color:#928b78;margin-top:6px;line-height:1.55}
    .tdk-set .ssub b{color:#d9b441}
    .tdk-set .serr{color:#e5615c}
    .tdk-set select{flex:1;min-width:0;background:#201e17;border:1px solid #3a3729;color:#ece7d8;border-radius:8px;padding:7px 9px;font-size:12px}
    .tdk-set .scheck{display:flex;align-items:center;gap:7px;font-size:12px;color:#c3bda9;cursor:pointer}
    .tdk-set .scheck input{flex:0 0 auto;min-width:0;width:15px;height:15px;accent-color:#d9b441}
    .tdk-set .scheck small{color:#928b78}
    .tdk-set .ssub a.prof{color:#d9b441;text-decoration:none;border-bottom:1px dotted #4a4536}
    .tdk-happy .hreset{font-size:14px;font-weight:700;color:#8fe6b3;background:#16241c;border:1px solid #2f5e46;border-radius:99px;padding:8px 11px;margin-bottom:8px}
    .tdk-happy .hreset.soon{color:#f0b3ad;background:#2c1614;border-color:#7a4a44}
    .tdk-happy .hsec{font-size:12px;color:#c3bda9;margin:8px 0 4px;font-weight:700}
    .tdk-happy .hsec small{color:#928b78;font-weight:400}
    .tdk-happy .hrow{display:flex;align-items:center;gap:8px;padding:3px 0}
    .tdk-happy .hrow label{flex:1;font-size:13px;color:#ece7d8}
    .tdk-happy .hv{color:#928b78;font-size:11px}
    .tdk-happy .hqty{width:70px;background:#201e17;border:1px solid #3a3729;color:#ece7d8;border-radius:8px;padding:5px 7px;font-family:ui-monospace,monospace}
    .tdk-happy .hsub{width:92px;text-align:right;color:#8fe6b3;font-size:11px;font-family:ui-monospace,monospace}
    .tdk-happy #tdk-hen-target{width:80px;background:#201e17;border:1px solid #3a3729;color:#ece7d8;border-radius:8px;padding:5px 7px;font-family:ui-monospace,monospace}
    .tdk-happy .hcost{margin-top:4px}
    .tdk-happy .hcrow{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:3px 0;color:#c3bda9;align-items:baseline}
    .tdk-happy .hcrow b{font-family:ui-monospace,monospace;color:#d9b441;white-space:nowrap}
    .tdk-happy .hcrow.htot{border-top:1px solid #3a3729;margin-top:4px;padding-top:6px;font-weight:800;color:#ece7d8}
    .tdk-happy .hcrow.htot b{color:#4cc281}
    .tdk-happy a.prof{color:#d9b441;text-decoration:none;border-bottom:1px dotted #4a4536;cursor:pointer}
    .tdk-happy ul.horder{margin:6px 0 0;padding-left:0;list-style:none;color:#c3bda9;font-size:12.5px;line-height:1.5}
    .tdk-happy ul.horder li{margin:5px 0}
    .tdk-happy ul.horder li label{display:flex;gap:8px;align-items:flex-start;cursor:pointer}
    .tdk-happy ul.horder li input{margin-top:2px;flex:0 0 auto;width:15px;height:15px;accent-color:#d9b441}
    .tdk-happy ul.horder li.done{opacity:.5}
    .tdk-happy ul.horder li.done label{text-decoration:line-through}
    .tdk-happy .hchk label{cursor:pointer}
    .tdk-happy .hresult{margin-top:10px;font-size:16px;font-weight:800;color:#ece7d8;border-top:1px dashed #3a3729;padding-top:8px}
    .tdk-happy .hresult b{color:#d9b441}
    .tdk-happy .hseq{margin-top:4px;font-size:12px;color:#e2933f;line-height:1.45}
    .tdk-happy .hseq b{color:#d9b441}
    .tdk-happy .hstats{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0}
    .tdk-happy .hstat{background:#201e17;border:1px solid #3a3729;color:#c3bda9;border-radius:8px;padding:6px 9px;font-weight:700;cursor:pointer;font-size:12px}
    .tdk-happy .hstat.on{background:#2a2413;border-color:#d9b441;color:#d9b441}
    .tdk-happy .hstat:disabled{opacity:.4;cursor:default}
    .tdk-happy .hgymres{margin-top:6px;font-size:13px;color:#ece7d8}
    .tdk-happy .hgymres b{color:#8fe6b3}
    .tdk-x{position:absolute;top:11px;right:12px;border-color:#7a4a44 !important;color:#e7a49d !important}
    .tdk-x:hover{background:#3a201d !important}
    .tdk-bestonline{display:block;margin:8px 0 4px;padding:9px 12px;border:1px solid #4cc281;border-radius:99px;background:#16241c;color:#bfe9cf;text-decoration:none;font-size:13px}
    .tdk-bestonline:hover{background:#1c2f24}
    .tdk-bestonline b{color:#eafff2}
    .tdk-brow{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #2c2a21}
    .tdk-brow:last-child{border-bottom:none}
    .tdk-brow .bn{font-weight:700}
    .tdk-brow .br{font-size:11px;color:#928b78;margin-top:1px}
    .tdk-brow .bp{margin-left:auto;font-family:ui-monospace,monospace;font-weight:800;color:#4cc281}
    .tdk-brow a.prof{color:#c3bda9;text-decoration:none;border-bottom:1px dotted #4a4536}
    .tdk-brow a.prof:hover{color:#d9b441}
    .tdk-trade{background:#2a2413;border:1px solid #d9b441;color:#d9b441;border-radius:8px;padding:5px 10px;font-weight:700;cursor:pointer;text-decoration:none;font-size:12px;white-space:nowrap}
    .tdk-trade:hover{background:#d9b441;color:#14130f}
    .tdk-homebar{margin:10px 16px 0;padding:9px 12px;border-radius:10px;font-size:12.5px;line-height:1.5;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .tdk-homebar.abroad{border:1px solid #d9b441;background:#1f1b10;color:#e8dcb4}
    .tdk-homebar.home{border:1px solid #4cc281;background:#16241c;color:#bfe9cf}
    .tdk-homebar .hb-val{color:#928b78;font-size:11px}
    .tdk-homebar .hb-go{margin-left:auto;background:#2a2413;border:1px solid #d9b441;color:#d9b441;border-radius:8px;padding:5px 9px;font-weight:700;cursor:pointer;text-decoration:none;white-space:nowrap;font-size:12px}
    .tdk-homebar.home .hb-go{border-color:#4cc281;color:#8fe6b3;background:#173026}
    .tdk-homebar .hb-go:hover{filter:brightness(1.15)}
    .tdk-oc{margin:10px 16px 0;padding:9px 12px;border:1px solid #7a5a2a;border-left:4px solid #d9b441;border-radius:10px;background:#211c12;color:#e7d3a0;font-size:12.5px;line-height:1.5}
    .tdk-imm{margin:10px 16px 0;padding:9px 12px;border-radius:10px;font-size:13px;line-height:1.45;font-weight:600}
    .tdk-imm.active{border:1px solid #4cc281;background:#16241c;color:#bfe9cf;animation:tdkpulse 1s ease-in-out infinite}
    .tdk-imm.gone{border:1px solid #7a4a44;background:#241717;color:#f0b3ad}
    .tdk-imm.fly{border:1px solid #4a90d9;background:#152230;color:#9fc7f0}
    .tdk-imm b{color:#f2eddf;font-family:ui-monospace,monospace}
    .tdk-oc.danger{border-color:#7a4a44;border-left-color:#e5615c;background:#241717;color:#f0b3ad}
    .tdk-oc b{color:#f2eddf}
    .oc-x{color:#e5615c;font-weight:800;margin-left:6px;font-family:system-ui,sans-serif;font-size:11px;cursor:help}
    table.tdk tr.ocmiss td{background:#241717}
    table.tdk tr.ocmiss .fly{color:#e5615c;text-decoration:line-through}
    .tdk-bmkt{text-decoration:none;font-size:14px;margin-right:8px;filter:grayscale(.15);vertical-align:middle}
    .tdk-bmkt:hover{filter:none}
    .tdk-bzap{cursor:pointer;font-size:13px;margin-right:8px;opacity:.85;vertical-align:middle}
    .tdk-bzap:hover{opacity:1}
    .tdk-pk{font-size:11px;margin-top:3px;font-weight:600;white-space:normal;line-height:1.35}
    .tdk-pk.even{color:#9fb1c9}
    .tdk-pk.warn{color:#e2933f}
    .tdk-pk.open{color:#4cc281}
    .tdk-pk.sell{color:#d9b441}
    .tdk-pk .tdk-pkm{opacity:.7;font-weight:400;font-style:italic}
    .tdk-pkedit{cursor:pointer;margin-left:6px;opacity:.7;font-weight:400}
    .tdk-pkedit:hover{opacity:1;color:#d9b441}
    .tdk-pdq{width:80px}
    `;
  }
  function setStatus(msg, err) { const s = host.querySelector("#tdk-status"); if (s) { s.textContent = msg; s.className = "tdk-status" + (err ? " err" : ""); } }
  const KEYERR = /incorrect key|key is empty|key.*disabled|access level|owner of this|invalid/i;
  function statusKeyError(detail) {
    const s = host.querySelector("#tdk-status"); if (!s) return;
    s.className = "tdk-status err";
    s.innerHTML = 'Torn key rejected' + (detail ? ' (' + detail + ')' : '') + ' — <a class="tdk-sett-link" id="tdk-status-set">open ⚙ Settings to update it</a>';
    const l = s.querySelector("#tdk-status-set"); if (l) l.addEventListener("click", openSettings);
  }

  function renderChips() {
    const present = [];
    Object.keys(FLY).forEach(function (cc) { if (state.rows.some(function (x) { return x.cc === cc; })) present.push(cc); });
    const chips = [["all", "All"]].concat(present.map(function (cc) { return [cc, FLY[cc].name]; }));
    const timeSel = '<select class="tdk-tsel" id="tdk-tsel" title="Only show destinations within this round-trip time">' +
      TIME_OPTS.map(function (o) { return '<option value="' + o[0] + '"' + (state.maxTrip === o[0] ? " selected" : "") + '>' + o[1] + "</option>"; }).join("") + "</select>";
    const heading = state.travelWhere === "flying" ? state.flyTo : null;
    host.querySelector("#tdk-filter").innerHTML = chips.map(function (c) {
      const here = c[0] === state.loc;
      const toHere = c[0] === heading && !here;
      const mark = here ? "📍 " : toHere ? "✈ " : "";
      const cls = here ? " here" : toHere ? " heading" : "";
      const tip = here ? ' title="You\'re here now"' : toHere ? ' title="Heading here — plan your buy before you land"' : "";
      return '<span class="tdk-fc' + (state.filter === c[0] ? " on" : "") + cls + '" data-cc="' + c[0] + '"' + tip + '>' + mark + c[1] + '</span>';
    }).join("") + timeSel;
  }

  function renderHomeBar() {
    const el = host.querySelector("#tdk-homebar"); if (!el) return;
    const w = state.travelWhere, travelUrl = "https://www.torn.com/page.php?sid=travel";
    if (w === "abroad") {
      const tb = GM_getValue("trip_bought", null);
      const cap = (tb && tb.cap) || state.cap || 23;
      const n = tb ? tb.n : null;
      if (n != null && n > 0) {
        el.style.display = ""; el.className = "tdk-homebar abroad";
        el.innerHTML = '🛒 <b>' + n + '/' + cap + ' slots filled</b> this trip — fly home to sell your haul.<a class="hb-go" href="' + travelUrl + '">✈ Return to Torn</a>';
      } else if (n === 0) {
        el.style.display = ""; el.className = "tdk-homebar abroad";
        el.innerHTML = '🛍️ <b>0/' + cap + '</b> bought — fill your slots here, then return to Torn to sell.<a class="hb-go" href="' + travelUrl + '">🛒 Buy</a>';
      } else {
        el.style.display = "none"; el.innerHTML = "";
      }
    } else if (w === "home") {
      const h = haulSummary();
      el.style.display = ""; el.className = "tdk-homebar home";
      el.innerHTML = '🏠 <b>Home</b>' +
        (h && h.items
          ? ' · <b>' + h.items + '</b> sellable item' + (h.items === 1 ? '' : 's') + ' worth <b>~' + money(h.value) + '</b> in your bag<button class="hb-go" id="tdk-hb-bag">📦 Sell haul</button>'
          : ' · board ranked across all destinations');
      const bag = el.querySelector("#tdk-hb-bag");
      if (bag) bag.addEventListener("click", function () { setView("inv"); });
    } else {
      el.style.display = "none"; el.innerHTML = "";
    }
  }

  function renderImmunity() {
    const el = host && host.querySelector("#tdk-immunity"); if (!el) return;
    const arr = state.arrivalTs || 0, now = Math.floor(Date.now() / 1000);
    if (!arr) { el.style.display = "none"; el.innerHTML = ""; return; }
    const toLand = arr - now, rem = (arr + 15) - now;
    if (state.travelWhere === "flying" && toLand > 0) {
      el.style.display = ""; el.className = "tdk-imm fly";
      el.innerHTML = '✈ <b>Landing in ' + mmss(toLand) + '</b> — panel auto-refreshes on arrival to start your 15s immunity timer.';
    } else if (rem > 0) {
      el.style.display = ""; el.className = "tdk-imm active";
      el.innerHTML = '🛡️ <b>Immunity: ' + rem + 's</b> — can’t be attacked. Buy / shelter cash in stocks / re-fly NOW.';
    } else if (rem > -12 && state.travelWhere !== "flying") {
      el.style.display = ""; el.className = "tdk-imm gone";
      el.innerHTML = '⚠️ <b>Immunity ended — you’re exposed.</b> Only wallet cash is muggable — shelter it in stocks.';
    } else { el.style.display = "none"; el.innerHTML = ""; }
  }

  function renderOC() {
    const el = host.querySelector("#tdk-oc"); if (!el) return;
    const g = ocGuard();
    if (!g) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "";
    if (g.provisional) {
      el.className = "tdk-oc";
      el.innerHTML = '⏰ <b>OC “' + g.name + '”</b> is recruiting — the real ready deadline is set once planning starts (days off; you’re clear to travel for now).';
    } else if (g.secs <= 0) {
      el.className = "tdk-oc danger";
      el.innerHTML = '⛔ <b>OC “' + g.name + '” is ready now</b> — don’t travel. You must be in Torn (not flying/hospital) or you’ll block the crime.';
    } else {
      el.className = "tdk-oc";
      el.innerHTML = '⏰ <b>OC “' + g.name + '”</b> ready in <b>' + fmtDur(g.secs) + '</b>. Flights with a round trip longer than that are flagged ⛔ below — you must be back in Torn for it.';
    }
  }

  function render() {
    const cap = state.cap, cash = state.cash, fund = state.fund;
    const stocks = state.stocks || 0, funds = cash == null ? null : cash + stocks;
    if (state.filter !== "all" && !state.rows.some(function (x) { return x.cc === state.filter; })) state.filter = "all";
    renderChips();
    renderHomeBar();
    renderOC();
    renderImmunity();
    const capTh = host.querySelector("#tdk-th-full"); if (capTh) capTh.textContent = "Profit ×" + cap;
    const fbtn = host.querySelector("#tdk-fund"); if (fbtn) fbtn.className = "tdk-btn2" + (fund ? " on" : "");
    let rows = state.filter === "all" ? state.rows : state.rows.filter(function (x) { return x.cc === state.filter; });
    if (state.maxTrip) { const hereCC = focusCC(); rows = rows.filter(function (x) { return FLY[x.cc] && (rtOf(x.cc) <= state.maxTrip || x.cc === hereCC); }); } // exempt where you're standing / heading — no round trip needed there
    const best = rows.find(function (x) { return (cash == null || x.full <= cash) && x.stock >= cap; });
    const alt = best ? null : rows.find(function (x) { return x.stock > 0; });
    const topOver = rows.find(function (x) { return x.stock >= cap && cash != null && x.full > cash && x.full <= funds && (!best || x.ppm > best.ppm); });
    const b = host.querySelector("#tdk-best");
    const loc = (state.filter === "all" ? "" : " · " + FLY[state.filter].name) + (cash != null ? " · " + money(cash) : "") + (travelMult() < 1 ? " · ✈ " + travelLabel() : "");
    let html;
    if (best) {
      html = '<div class="l">Best now' + loc + '</div>' +
        '<div class="p">' + best.name + ' <span>· ' + best.country + '</span></div>' +
        '<div class="k"><b>$' + best.ppm.toLocaleString() + '</b>/min · trip ' + money(best.ppi * cap - FLY[best.cc].fare) + ' · load ' + money(best.full) + ' · stock ' + best.stock.toLocaleString() + '</div>';
      if (topOver) {
        html += '<div class="tdk-fund2">💰 Bigger play if funded: <b>' + topOver.name + '</b> (' + topOver.country + ') · <b>$' + topOver.ppm.toLocaleString() + '</b>/min — sell <b>' + money(topOver.full - cash) + '</b> of your <b>' + money(stocks) + '</b> in stocks to full-load it.</div>';
      }
    } else if (alt) {
      const barriers = [];
      if (cash != null && alt.full > cash) {
        const need = alt.full - cash;
        barriers.push(need <= stocks
          ? '💵 sell <b>' + money(need) + '</b> of your <b>' + money(stocks) + '</b> in stocks to full-load'
          : '💵 needs <b>' + money(need) + '</b> — beyond your cash + stocks (<b>' + money(funds) + '</b>); buy what you can afford');
      }
      if (alt.stock < cap) barriers.push('📦 only <b>' + alt.stock.toLocaleString() + '</b> in stock (partial load)');
      html = '<div class="l">Best available' + loc + '</div>' +
        '<div class="p">' + alt.name + ' <span>· ' + alt.country + '</span></div>' +
        '<div class="k"><b>$' + alt.ppm.toLocaleString() + '</b>/min · trip ' + money(alt.ppi * cap - FLY[alt.cc].fare) + ' · load ' + money(alt.full) + ' · stock ' + alt.stock.toLocaleString() + '</div>' +
        (barriers.length ? '<div class="tdk-fund2">' + barriers.join(' · ') + '</div>' : '');
    } else {
      const msg = !state.rows.length ? 'No data yet — hit ↻ Refresh (YATA may be down).'
        : !rows.length ? 'Nothing profitable in this filter — try All.'
          : 'Everything’s out of stock here — check back after restocks.';
      html = '<div class="l">Best now</div><div class="p">' + msg + '</div>';
    }
    b.innerHTML = html;

    const body = host.querySelector("#tdk-body");
    let sm = state.sort || "ppm";
    if (sm === "buy" || sm === "sell" || sm === "full") sm = "ppm"; // those columns were folded into the item cell
    const disp = rows.slice();
    disp.forEach(function (x) { x._ol = arrivalOutlook(x); }); // Landing outlook — computed once, reused for the sort and every lens
    const lrk = function (x) { const c = x._ol ? x._ol.cls : "unk"; return c === "good" ? 0 : c === "warn" ? 1 : c === "bad" ? 2 : 3; };
    if (sm === "landing") disp.sort(function (a, b) { return (lrk(a) - lrk(b)) || (b.ppm - a.ppm); }); // in stock on arrival first, then best $/min
    else if (sm === "stock") disp.sort(function (a, b) { return ((a.stock > 0 ? 0 : 1) - (b.stock > 0 ? 0 : 1)) || (b.ppm - a.ppm); });
    else if (sm === "ppm") disp.sort(function (a, b) { return b.ppm - a.ppm; });
    else if (sm === "fullprofit") disp.sort(function (a, b) { return b.ppi - a.ppi; });
    else disp.sort(function (a, b) { return (b[sm] || 0) - (a[sm] || 0); });
    host.querySelectorAll("#tdk-board th.so").forEach(function (th) { th.classList.toggle("on", th.getAttribute("data-sort") === sm); });
    const g = ocGuard();
    const pStk = primaryStockAcronym();

    const view = state.boardView || "table";
    host.querySelectorAll("#tdk-vsw button").forEach(function (vb) { vb.classList.toggle("on", vb.getAttribute("data-view") === view); });
    const maxPpm = disp.reduce(function (m, x) { return Math.max(m, x.ppm); }, 0) || 1;
    const built = disp.map(function (x, i) {
      const aff = cash == null || x.full <= cash;
      const fill = x.stock >= cap;
      const isTop = topOver && x === topOver;
      const ocMiss = g && !g.provisional && FLY[x.cc] && (g.secs <= 0 || rtOf(x.cc) * 60 >= g.secs);
      let sc = x.stock === 0 ? '<span class="chip c-out">out</span>'
        : x.stock < cap ? '<span class="chip c-low">only ' + x.stock + '</span>'
          : '<span class="chip c-ok">' + x.stock.toLocaleString() + '</span>';
      const tr = stockTrend(x.cc, x.id);
      if (tr) {
        const rate = Math.abs(Math.round(tr.perMin));
        if (tr.dq < 0) {
          const soEta = (rate > 0 && x.stock > 0) ? ' · sells out in ~' + fmtDur(Math.round(x.stock / rate * 60)) : '';
          sc = '<span class="tk-tr dn" title="Sold ' + Math.abs(tr.dq).toLocaleString() + ' since last sample (~' + rate + '/min)' + soEta + '">▼</span>' + sc;
        } else if (isRealRestock(tr.dq, tr.prev, tr.maxQ)) {
          sc = '<span class="tk-tr up" title="Restocked +' + tr.dq.toLocaleString() + ' since last sample">▲</span>' + sc;
        }
      }
      let loadInline = 'load ' + money(x.full);
      if (!aff && cash != null && stocks > 0) {
        const need = x.full - cash;
        loadInline = '<span class="needfund" title="' + escAttr("Need to free " + money(need) + " in " + pStk + " stock cash before flying") + '">load ' + money(x.full) + ' (' + pStk + ')</span>';
      }
      const cls = (aff ? "" : (fund ? (isTop ? "fund" : "") : "dim")) + (ocMiss ? " ocmiss" : "");
      const mark = (aff && fill) ? '<span class="star" title="Affordable now & fully in stock — a clean pick">★</span>' : (isTop ? '<span class="star" title="Best funded play — over budget, but reachable by selling stocks (see the banner up top)">💰</span>' : '');
      const ocBadge = ocMiss ? '<span class="oc-x" title="Round trip ' + (FLY[x.cc] ? fmtRt(rtOf(x.cc)) : '?') + (g.secs <= 0 ? ' — your OC is ready NOW, don’t fly' : ' exceeds your OC (ready in ' + fmtDur(g.secs) + ') — you’d miss it') + '">⛔ OC</span>' : '';
      const rtTxt = FLY[x.cc] ? '<span title="' + (travelMult() < 1 ? travelLabel() + ' · base ' + fmtRt(FLY[x.cc].rt) : 'Standard round trip') + '">' + fmtRt(rtOf(x.cc)) + ' rt</span> · ' : '';
      const ol = x._ol;
      const sellTag = x.isTraderPrice ? ' <span style="font-size:9px;color:#d9b441;" title="Priced off top trader buy-offer">⚡</span>' : '';
      const profit = money(x.ppi * cap), ppmTxt = '$' + x.ppm.toLocaleString();
      const ldPill = ol ? '<span class="ld ld-' + ol.cls + '" title="' + escAttr(ol.tip) + '">' + ol.txt + '</span>' : '<span class="ld ld-unk">·</span>';
      const nm = '<span class="nm">' + x.name + mark + '</span>';
      const dataAttr = ' data-id="' + x.id + '" data-name="' + x.name.replace(/"/g, "") + '"';

      if (view === "cards") {
        return '<div class="tk-card ' + cls + '"' + dataAttr + '>' +
          '<div class="tk-cl">' + nm +
            '<div class="cy">' + x.country + ' ✈ · ' + rtTxt + ago(x.freshS) + ' old' + ocBadge + '</div>' +
            '<div class="cy2">' + money(x.buy) + ' → ' + money(x.sell) + sellTag + ' · ' + loadInline + '</div></div>' +
          '<div class="tk-cr"><div class="tk-cppm">' + ppmTxt + '<small>/min</small></div>' +
            '<div class="tk-csub">' + ldPill + ' · <b class="gd">+' + profit + '</b> · ' + sc + '</div></div></div>';
      }
      if (view === "bars") {
        const pct = Math.max(4, Math.round(x.ppm / maxPpm * 100));
        const bcl = ol ? ol.cls : "unk";
        return '<div class="tk-bar b-' + bcl + (cls.indexOf("dim") >= 0 ? " dim" : "") + '"' + dataAttr + '>' +
          '<span class="tk-fill" style="width:' + pct + '%"></span>' +
          '<span class="tk-rank">' + (i + 1) + '</span>' +
          '<span class="tk-bn">' + x.name + mark + '<small>' + x.country + ' · ' + fmtRt(rtOf(x.cc)) + ' rt · +' + profit + ' · ' + sc + '</small></span>' +
          '<span class="tk-br"><span class="tk-bp">' + ppmTxt + '</span>' + ldPill + '</span></div>';
      }
      if (view === "dep") {
        const stt = ol ? (ol.cls === "good" ? ["go", "BOARDING"] : ol.cls === "warn" ? ["warn", "LIMITED"] : ol.cls === "bad" ? ["no", "CANCELLED"] : ["mut", "—"]) : ["mut", "—"];
        return '<tr' + dataAttr + '><td class="dep-dest">' + x.country.toUpperCase() + '</td>' +
          '<td>' + x.name + ' · ' + money(x.buy) + '→' + money(x.sell) + '</td>' +
          '<td class="dep-prof">+' + profit + '</td>' +
          '<td class="dep-ppm">' + ppmTxt + '</td>' +
          '<td><span class="stt ' + stt[0] + '">' + stt[1] + '</span></td></tr>';
      }
      return '<tr class="' + cls + '"' + dataAttr + '>' +
        '<td class="l">' + nm +
          '<div class="cy"><a class="fly" href="https://www.torn.com/page.php?sid=travel" title="Open the travel agency">' + x.country + ' ✈</a> · ' + rtTxt + ago(x.freshS) + ' old' + ocBadge + '</div>' +
          '<div class="cy2">' + money(x.buy) + ' → ' + money(x.sell) + sellTag + ' · ' + loadInline + '</div></td>' +
        '<td class="gd">' + profit + '</td>' +
        '<td>' + sc + '</td>' +
        '<td class="ldc">' + ldPill + '</td>' +
        '<td class="ppm">' + ppmTxt + '</td></tr>';
    }).join("");

    const tbl = host.querySelector("#tdk-board table.tdk"), lens = host.querySelector("#tdk-lens");
    if (view === "table") {
      body.innerHTML = built;
      if (tbl) tbl.style.display = "";
      if (lens) { lens.style.display = "none"; lens.innerHTML = ""; }
    } else {
      if (tbl) tbl.style.display = "none";
      if (lens) {
        lens.style.display = "";
        if (view === "cards") lens.innerHTML = '<div class="tk-cards">' + built + '</div>';
        else if (view === "bars") lens.innerHTML = '<div class="tk-lb">' + built + '</div>';
        else lens.innerHTML = '<div class="tk-flipwrap"><table class="tk-flip"><thead><tr><th>Destination</th><th>Cargo · buy→sell</th><th>Profit ×' + cap + '</th><th>$/min</th><th>Landing</th></tr></thead><tbody>' + built + '</tbody></table></div>';
      }
    }

    const mug = host.querySelector("#tdk-mug");
    if (mug) mug.innerHTML = cash != null
      ? '🩸 Mug risk on your ' + money(cash) + ': typically <b>−' + money(cash * 0.05) + ' to −' + money(cash * 0.10) + '</b>, up to <b>−' + money(cash * 0.20) + '</b> if they\'re fully kitted. Only wallet cash is muggable — shelter in stocks right after you sell.'
      : '🩸 Only wallet cash is muggable (5–20%). Shelter your haul in stocks the moment you land.';
  }

  function applyScale() { if (panel) { panel.style.zoom = state.scale; panel.style.maxHeight = "calc((100vh - 24px) / " + state.scale + ")"; } }
  function w3bKey() {
    let k = GM_getValue("w3b_key", "");
    if (!k) { k = (window.prompt("weav3r (W3B) API key — for live trader buy prices:") || "").trim(); if (k) GM_setValue("w3b_key", k); }
    return k;
  }
  function bindClose(bx) { const c = host.querySelector("#tdk-bclose"); if (c) c.onclick = function () { bx.classList.remove("open"); }; }
  const STATUS_DOT = { Online: "🟢", Idle: "🟡", Offline: "⚫" };
  async function openBuyers(id, name) {
    const bx = host.querySelector("#tdk-buyers");
    bx.classList.add("open");
    bx.innerHTML = '<div class="tdk-bh"><div class="tt">Buyers · ' + name + '<small> — loading…</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>';
    bindClose(bx);
    const key = w3bKey();
    if (!key) { const t = bx.querySelector(".tt"); if (t) t.innerHTML = 'Buyers · ' + name + '<small> — a W3B key is needed</small>'; return; }
    try {
      const j = await gmGet("https://weav3r.dev/api/marketplace/" + id + "/traders?apiKey=" + encodeURIComponent(key));
      const traders = (j.traders || []).slice(0, 6);
      const tkey = GM_getValue("torn_key", ""), status = {};
      if (tkey && traders.length) {
        await Promise.all(traders.map(function (t) {
          return gmGet("https://api.torn.com/user/" + t.player_id + "/?selections=profile&key=" + encodeURIComponent(tkey))
            .then(function (p) { status[t.player_id] = (p && p.last_action && p.last_action.status) || "?"; })
            .catch(function () { status[t.player_id] = "?"; });
        }));
      }
      const dot = function (s) { return STATUS_DOT[s] || "❔"; };
      const tradeUrl = function (pid) { return "https://www.torn.com/trade.php#step=start&userID=" + pid; };
      const bestOn = traders.find(function (t) { return status[t.player_id] === "Online"; }) ||
        traders.find(function (t) { return status[t.player_id] === "Idle"; });
      const head = '<div class="tdk-bh"><div class="tt">Buyers · ' + name + '<small> — ' + (j.total_count || traders.length) + ' buying' + (tkey ? ' · online first' : '') + '</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>';
      const banner = bestOn
        ? '<a class="tdk-bestonline" href="' + tradeUrl(bestOn.player_id) + '" target="_blank" rel="noopener" data-uid="' + bestOn.player_id + '" data-price="' + bestOn.price + '">⚡ Trade best ' + (status[bestOn.player_id] === "Online" ? "online" : "idle") + ': <b>' + bestOn.player_name + '</b> @ $' + bestOn.price.toLocaleString() + ' ' + dot(status[bestOn.player_id]) + '</a>'
        : '<div class="tdk-sub" style="padding:6px 2px">' + (tkey ? 'None of the top buyers are online right now.' : 'Add your Torn API key to flag who’s online.') + '</div>';
      const rank = function (t) { const s = status[t.player_id]; return s === "Online" ? 0 : s === "Idle" ? 1 : s === "Offline" ? 3 : 2; };
      const sorted = traders.map(function (t, i) { return { t: t, i: i }; })
        .sort(function (a, b) { return (rank(a.t) - rank(b.t)) || (a.i - b.i); }).map(function (x) { return x.t; });
      let owned = 0, ownedStale = false;
      if (tkey) { try { const inv = await loadInv(tkey); if (inv.length) { const f = inv.find(function (it) { return (it.ID || it.id || it.item_id) == id; }); owned = f ? (f.quantity || 0) : 0; } } catch (e) { } }
      if (!owned) { const c = GM_getValue("inv_counts", null); if (c && c.map && c.map[id] != null) { owned = c.map[id]; ownedStale = true; } }
      const q0 = owned > 0 ? owned : Math.max(1, state.cap || 1);
      const buyCost = buyCostOf(id);
      const btText = function (price, qty) {
        let s = "= $" + (price * qty).toLocaleString();
        if (buyCost != null) { const net = (price - buyCost) * qty; s += ' · <span class="netp' + (net < 0 ? " neg" : "") + '">net ' + (net >= 0 ? "+" : "−") + "$" + Math.abs(net).toLocaleString() + "</span>"; }
        return s;
      };
      const calcBar = '<div class="tdk-calc">Qty <input id="tdk-qty" type="number" min="1" value="' + q0 + '">' +
        (owned > 0 ? '<button class="tdk-cp" id="tdk-qty-own" title="' + (ownedStale ? 'From your last Items-page visit (Torn inventory API is down) — click to use' : 'Set quantity to how many you own') + '">You have ' + owned + (ownedStale ? '*' : '') + '</button>' : '') +
        '<span class="tdk-calc-hint">' + (ownedStale ? '*from your last Items-page visit · ' : '') + 'totals update live · 📋 copies the trade line' + (buyCost != null ? ' · net = sell − $' + buyCost.toLocaleString() + ' buy/ea' : '') + '</span></div>';
      const list = sorted.map(function (t) {
        const r = t.rating || { upvotes: 0, downvotes: 0 };
        return '<div class="tdk-brow"><div><div class="bn">' + dot(status[t.player_id]) + ' ' + t.player_name + '</div>' +
          '<div class="br">' + r.upvotes + '↑ ' + r.downvotes + '↓ · <a class="prof" href="https://www.torn.com/profiles.php?XID=' + t.player_id + '" target="_blank" rel="noopener">profile</a></div></div>' +
          '<div class="bp">$' + t.price.toLocaleString() + '<span class="ea"> /ea</span><div class="bt" data-price="' + t.price + '">' + btText(t.price, q0) + '</div></div>' +
          '<button class="tdk-cp" data-price="' + t.price + '" title="Copy trade line">📋</button>' +
          '<a class="tdk-trade" href="' + tradeUrl(t.player_id) + '" target="_blank" rel="noopener" data-uid="' + t.player_id + '" data-price="' + t.price + '">⇄ Trade</a></div>';
      }).join("");
      bx.innerHTML = head + banner + (list ? calcBar + list : '<div class="br">No traders listed for this item.</div>');
      bindClose(bx);
      const qtyEl = bx.querySelector("#tdk-qty");
      const getQ = function () { return Math.max(1, parseInt(qtyEl && qtyEl.value, 10) || 1); };
      const recalc = function () {
        const q = getQ();
        bx.querySelectorAll(".bt").forEach(function (el) { el.innerHTML = btText(+el.getAttribute("data-price"), q); });
      };
      if (qtyEl) qtyEl.addEventListener("input", recalc);
      const ownBtn = bx.querySelector("#tdk-qty-own");
      if (ownBtn) ownBtn.addEventListener("click", function () { if (qtyEl) { qtyEl.value = owned; recalc(); } });
      bx.querySelectorAll(".tdk-cp").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const p = +this.getAttribute("data-price"), q = getQ();
          copyText(mkTradeLine(name, q, p, buyCost != null ? (p - buyCost) * q : undefined));
          const self = this, old = this.textContent; this.textContent = "✓";
          setTimeout(function () { self.textContent = old; }, 1200);
        });
      });
      bx.querySelectorAll("a.tdk-trade, a.tdk-bestonline").forEach(function (a) {
        a.addEventListener("click", function () {
          const p = +this.getAttribute("data-price"), uid = +this.getAttribute("data-uid");
          if (p) stashTrade(name, getQ(), p, uid);
        });
      });
    } catch (e) {
      bx.innerHTML = '<div class="tdk-bh"><div class="tt">Buyers · ' + name + '<small> — error</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div><div class="br">' + e.message + ' (check your W3B key in Tampermonkey storage)</div>';
      bindClose(bx);
    }
  }

  async function openFlip() {
    const bx = host.querySelector("#tdk-buyers");
    bx.classList.add("open");
    bx.innerHTML = '<div class="tdk-bh"><div class="tt">💱 Quick Flips<small> — scanning the market…</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div><div class="br" id="tdk-flip-note">Pulling market data…</div>';
    bindClose(bx);
    const setTitle = function (s) { const t = bx.querySelector(".tt"); if (t) t.innerHTML = '💱 Quick Flips<small> — ' + s + '</small>'; };
    const key = w3bKey();
    if (!key) { setTitle("a W3B key is needed (⚙ Settings)"); return; }
    const note = bx.querySelector("#tdk-flip-note");
    try {
      const mk = await gmGet("https://weav3r.dev/api/marketplace?apiKey=" + encodeURIComponent(key), 30000);
      const items = (mk && mk.items) || [];
      const cashCeil = (state.cash && state.cash > 0) ? state.cash : 50e6;
      const LIQ = 8, SHORTLIST = 30;
      const cand = [];
      items.forEach(function (it) {
        if (!it || it.item_id <= 0) return;
        const buy = it.lowest_price;
        if (!(buy > 0) || (it.total_bazaars || 0) < LIQ) return;
        if (buy > cashCeil) return;
        const ref = Math.max(it.bazaar_average || 0, buy);
        cand.push({ id: it.item_id, name: it.item_name, buy: buy, disp: ref > buy ? (ref - buy) / buy : 0 });
      });
      cand.sort(function (a, b) { return b.disp - a.disp; });
      const short = cand.slice(0, SHORTLIST);
      if (!short.length) { note.textContent = "No affordable, liquid items to check right now."; setTitle("nothing to scan"); return; }
      note.textContent = "Checking live buy-offers for " + short.length + " liquid, affordable items…";
      const flips = [];
      await Promise.all(short.map(function (c) {
        return gmGet("https://weav3r.dev/api/marketplace/" + c.id + "/traders?apiKey=" + encodeURIComponent(key), 20000)
          .then(function (j) {
            const t = (j && j.traders) || [];
            if (!t.length) return;
            const sell = t[0].price, profit = sell - c.buy;
            if (profit < 1000) return;
            flips.push({ id: c.id, name: c.name, buy: c.buy, sell: sell, profit: profit, buyers: j.total_count || t.length });
          }).catch(function () { });
      }));
      flips.sort(function (a, b) { return b.profit - a.profit; });
      if (!flips.length) { note.textContent = "Market's efficient right now — no crossed-market flips (no live buyer is paying above the cheapest listing on the items scanned). Try again later — these appear and vanish fast."; setTitle("no flips right now"); return; }
      const top = flips.slice(0, 12);
      note.textContent = "Finding the cheapest seller for the top " + top.length + " flips…";
      await Promise.all(top.map(function (f) {
        return gmGet("https://weav3r.dev/api/marketplace/" + f.id + "?apiKey=" + encodeURIComponent(key), 20000)
          .then(function (j) {
            const L = ((j && j.listings) || []).filter(function (x) { return x.price > 0; }).sort(function (a, b) { return a.price - b.price; });
            f.baz = L.length ? L[0] : null;
          }).catch(function () { f.baz = null; });
      }));
      top.forEach(function (f) {
        f.buy2 = f.baz ? f.baz.price : f.buy;
        f.profit2 = f.sell - f.buy2;
      });
      const finalFlips = top.filter(function (f) { return f.profit2 > 0; }).sort(function (a, b) { return b.profit2 - a.profit2; });
      if (!finalFlips.length) { note.textContent = "Those flips just closed — the cheap listings moved before we could price them. Try again shortly."; setTitle("closed — prices moved"); return; }
      const cat = function (id) { return (state.itemMeta && state.itemMeta[id] && state.itemMeta[id].type) || ""; };
      const rows = finalFlips.map(function (f) {
        const marg = f.buy2 > 0 ? Math.round(f.profit2 / f.buy2 * 100) : 0;
        const warn = marg > 300 ? ' <span class="fwarn" title="Huge margin — likely a stale or fat-finger listing. Verify it\'s still live in-game before buying.">⚠</span>' : '';
        const links = [];
        if (f.baz) links.push('<a class="fbuy" href="https://www.torn.com/bazaar.php?userId=' + f.baz.player_id + '" target="_blank" rel="noopener" title="Buy from ' + String(f.baz.player_name || "").replace(/"/g, "") + '’s bazaar — ' + (f.baz.quantity || 0) + ' @ $' + f.baz.price.toLocaleString() + '">🏪 ' + (f.baz.player_name || "bazaar") + '</a>');
        links.push('<a class="fbuy" href="' + marketUrl(f.id, f.name, cat(f.id)) + '" target="_blank" rel="noopener" title="Also check the Item Market for this item">🛒 Market</a>');
        return '<div class="tdk-flip" data-id="' + f.id + '" data-name="' + f.name.replace(/"/g, "") + '">' +
          '<div class="fn">' + f.name + warn + '<div class="fs">buy <b>' + full$(f.buy2) + '</b> ' + links.join(" ") + ' → sell <b>' + full$(f.sell) + '</b> <span>· ' + f.buyers + ' buyers · ⚡ click row to trade</span></div></div>' +
          '<div class="fp"><div class="fpv">+' + money(f.profit2) + '</div><div class="fpm">' + marg + '% /ea</div></div></div>';
      }).join("");
      setTitle("buy low → sell live · top " + finalFlips.length);
      note.outerHTML = '<div class="tdk-sub" style="padding:6px 12px">🏪 = buy from that seller’s bazaar (hidden since Item Market 2.0) · 🛒 = Item Market. Sell via ⚡ (click the row) = a direct trade, no fee. Prices move fast — reconfirm before buying.</div><div id="tdk-flips">' + rows + '</div>';
      bx.querySelectorAll(".tdk-flip .fbuy").forEach(function (a) { a.addEventListener("click", function (e) { e.stopPropagation(); }); });
      bx.querySelectorAll(".tdk-flip").forEach(function (el) {
        el.addEventListener("click", function () { openBuyers(+this.getAttribute("data-id"), this.getAttribute("data-name")); });
      });
    } catch (e) {
      const n = bx.querySelector("#tdk-flip-note"); if (n) n.textContent = "Flip scan failed: " + (e.message || e) + " (check your W3B key in ⚙ Settings).";
    }
  }

  const STK_MAX = 700, STK_AGE = 14 * 24 * 3600, STK_SAMPLE = 600;
  const STK_SELL_FEE = 0.001;
  function recordStockPrices(mkt) {
    if (!mkt) return;
    let hist; try { hist = GM_getValue("stk_hist", null) || {}; } catch (e) { hist = {}; }
    const now = Math.floor(Date.now() / 1000), cutoff = now - STK_AGE;
    let changed = false;
    Object.keys(mkt).forEach(function (id) {
      const p = mkt[id] && mkt[id].current_price; if (!(p > 0)) return;
      const arr = hist[id] || (hist[id] = []);
      const last = arr[arr.length - 1];
      if (last && now - last[0] < STK_SAMPLE) return;
      arr.push([now, p]); changed = true;
      while (arr.length && arr[0][0] < cutoff) arr.shift();
      if (arr.length > STK_MAX) arr.splice(0, arr.length - STK_MAX);
    });
    if (changed) { try { GM_setValue("stk_hist", hist); } catch (e) { } }
    state._stkHist = hist;
  }
  function stkStats(id) {
    const hist = state._stkHist || (function () { try { return GM_getValue("stk_hist", null) || {}; } catch (e) { return {}; } })();
    const arr = hist[id]; if (!arr || arr.length < 3) return null;
    let lo = Infinity, hi = -Infinity, sum = 0;
    arr.forEach(function (p) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); sum += p[1]; });
    const avg = sum / arr.length, cur = arr[arr.length - 1][1], range = hi - lo;
    return { lo: lo, hi: hi, avg: avg, cur: cur, pos: range > 0 ? (cur - lo) / range : 0.5, vsAvg: avg > 0 ? (cur - avg) / avg : 0, n: arr.length, spanH: (arr[arr.length - 1][0] - arr[0][0]) / 3600 };
  }
  async function loadStocks(key) {
    try {
      const [m, u] = await Promise.all([
        gmGet("https://api.torn.com/torn/?selections=stocks&key=" + encodeURIComponent(key)),
        gmGet("https://api.torn.com/user/?selections=stocks&key=" + encodeURIComponent(key))
      ]);
      if (m && m.stocks) { state.stkMkt = m.stocks; state.stkAt = Date.now(); recordStockPrices(m.stocks); }
      if (u) { state.stkMine = (u.stocks && typeof u.stocks === "object") ? u.stocks : {}; }
    } catch (e) { /* non-fatal */ }
  }
  function pollStockPrices() {
    const key = GM_getValue("torn_key", ""); if (!key) return;
    let last = 0; try { last = GM_getValue("stk_poll_at", 0); } catch (e) { }
    if (Date.now() - last < 10 * 60 * 1000 - 4000) return;
    try { GM_setValue("stk_poll_at", Date.now()); } catch (e) { }
    gmGet("https://api.torn.com/torn/?selections=stocks&key=" + encodeURIComponent(key)).then(function (m) { if (m && m.stocks) { state.stkMkt = m.stocks; recordStockPrices(m.stocks); } }).catch(function () { });
  }
  function stkAvgCost(h) {
    let sh = 0, cost = 0; const tx = (h && h.transactions) || {};
    Object.keys(tx).forEach(function (k) { sh += tx[k].shares; cost += tx[k].shares * tx[k].bought_price; });
    return sh > 0 ? cost / sh : 0;
  }
  function rangeTag(st) {
    if (st.pos <= 0.2) return '<span class="sktag low">▼ near low</span>';
    if (st.pos >= 0.8) return '<span class="sktag high">▲ near high</span>';
    return '<span class="sktag mid">mid-range</span>';
  }
  function benefitAwareHint(r, st) {
    const s = r.s, req = s.benefit && s.benefit.requirement;
    const shares = r.held ? (state.stkMine[r.id].total_shares || 0) : 0;
    const accumulating = req && shares < req;
    if (st.pos <= 0.25 && st.vsAvg < -0.02) return '🟢 near its recent low' + (accumulating ? ' — good spot to add toward ' + s.benefit.description : ' — potential buy');
    if (st.pos >= 0.8 && st.vsAvg > 0.02) {
      if (accumulating) return '⚪ near recent high — but you\'re building the ' + s.benefit.description + ' block, so hold (don\'t sell the block)';
      return r.held ? '🔴 near its recent high — consider taking profit' : '⚪ near recent high';
    }
    return '';
  }
  async function openStocks() {
    const bx = host.querySelector("#tdk-buyers");
    bx.classList.add("open");
    bx.innerHTML = '<div class="tdk-bh"><div class="tt">📊 Stocks<small> — loading…</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div><div class="br" style="padding:10px 12px">Pulling the stock market…</div>';
    bindClose(bx);
    const setTitle = function (s) { const t = bx.querySelector(".tt"); if (t) t.innerHTML = '📊 Stocks<small> — ' + s + '</small>'; };
    const key = tornKey();
    if (!key) { setTitle("need a Torn API key (⚙ Settings)"); return; }
    await loadStocks(key);
    const mkt = state.stkMkt, mine = state.stkMine || {};
    if (!mkt) { setTitle("couldn't load stocks — check your key in ⚙ Settings"); return; }
    const traveling = state.travelWhere === "flying" || state.travelWhere === "abroad";
    const asOf = new Date(state.stkAt || Date.now()).toLocaleTimeString();
    const holdIds = Object.keys(mine).filter(function (id) { return mine[id] && mine[id].total_shares > 0; });
    let portHtml, totalVal = 0, totalPL = 0, totalFee = 0;
    if (holdIds.length) {
      const body = holdIds.map(function (id) {
        const h = mine[id], s = mkt[id]; if (!s) return '';
        const shares = h.total_shares, cost = stkAvgCost(h), cur = s.current_price;
        const val = cur * shares, pl = (cur - cost) * shares, pct = cost > 0 ? (cur - cost) / cost * 100 : 0;
        const fee = val * STK_SELL_FEE, net = pl - fee;
        totalVal += val; totalPL += pl; totalFee += fee;
        const req = s.benefit && s.benefit.requirement;
        let benefit = '';
        if (req) {
          if (shares >= req) benefit = '<div class="skbn ok">✅ Benefit active: ' + s.benefit.description + ' every ' + s.benefit.frequency + 'd</div>';
          else { const togo = req - shares; benefit = '<div class="skbn"><span class="skbar"><i style="width:' + Math.min(100, shares / req * 100).toFixed(1) + '%"></i></span>' + (shares / req * 100).toFixed(1) + '% → ' + s.benefit.description + ' · ' + togo.toLocaleString() + ' more ≈ ' + money(togo * cur) + '</div>'; }
        }
        const st = stkStats(id);
        return '<div class="skrow"><div class="skmain"><div class="skn">' + s.acronym + ' <span>' + s.name + '</span></div>' +
          '<div class="sksub">' + shares.toLocaleString() + ' sh @ $' + cost.toFixed(2) + ' → $' + cur + (st ? ' ' + rangeTag(st) : '') + '</div>' +
          '<div class="sknet">net if sold now <b class="' + (net >= 0 ? 'up' : 'dn') + '">' + (net >= 0 ? '+' : '') + money(net) + '</b> <span>after 0.1% sell fee −' + money(fee) + '</span></div>' + benefit + '</div>' +
          '<div class="skpl"><div class="' + (pl >= 0 ? 'up' : 'dn') + '">' + (pl >= 0 ? '+' : '') + money(pl) + '</div><div class="skpct">' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%</div></div></div>';
      }).join('');
      portHtml = '<div class="sksec">Your portfolio · value ' + money(totalVal) + ' · gross P&amp;L <b class="' + (totalPL >= 0 ? 'up' : 'dn') + '">' + (totalPL >= 0 ? '+' : '') + money(totalPL) + '</b> · net after fees <b class="' + (totalPL - totalFee >= 0 ? 'up' : 'dn') + '">' + (totalPL - totalFee >= 0 ? '+' : '') + money(totalPL - totalFee) + '</b></div>' + body;
    } else {
      portHtml = '<div class="sksec">Your portfolio</div><div class="tdk-sub" style="padding:6px 12px">You don\'t hold any stocks right now.</div>';
    }
    const rows = Object.keys(mkt).map(function (id) { const st = stkStats(id); return { id: id, s: mkt[id], st: st, held: !!(mine[id] && mine[id].total_shares > 0), vsAvg: st ? st.vsAvg : 0 }; });
    const withHist = rows.filter(function (r) { return r.st; });
    let scanHtml;
    if (!withHist.length) {
      scanHtml = '<div class="sksec">Buy-low scanner</div><div class="tdk-sub" style="padding:6px 12px">📊 Recording prices now — range &amp; buy-low signals appear once there\'s a few hours of history (a background poll runs every ~10 min).</div>';
    } else {
      withHist.sort(function (a, b) { return a.vsAvg - b.vsAvg; });
      scanHtml = '<div class="sksec">Buy-low scanner · ' + withHist.length + ' with history · most-below-average first</div>' + withHist.map(function (r) {
        const s = r.s, st = r.st, hint = benefitAwareHint(r, st);
        return '<div class="skrow"><div class="skmain"><div class="skn">' + s.acronym + ' <span>' + s.name + '</span>' + (r.held ? ' <b class="skhold" title="You hold this">•held</b>' : '') + '</div>' +
          '<div class="sksub">$' + s.current_price + ' · ' + (st.vsAvg >= 0 ? '+' : '') + (st.vsAvg * 100).toFixed(1) + '% vs ' + Math.round(st.spanH) + 'h avg ' + rangeTag(st) + '</div>' + (hint ? '<div class="skhint">' + hint + '</div>' : '') + '</div></div>';
      }).join('');
    }
    bx.innerHTML = '<div class="tdk-bh"><div class="tt">📊 Stocks<small> — as of ' + asOf + (traveling ? ' · ✈ look-only while traveling' : '') + '</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>' +
      '<div class="tdk-sub" style="padding:6px 12px">Prices tick constantly — figures are as of the time above and reconcile to Torn when re-opened. Signals are range/trend heuristics, not predictions.</div>' +
      '<div id="tdk-stocks">' + portHtml + scanHtml + '</div>';
    bindClose(bx);
  }

  async function ensureForeignIds() {
    if (state.foreignIds) return state.foreignIds;
    try {
      const y = await gmGet("https://yata.yt/api/v1/travel/export/", 30000);
      const set = new Set();
      Object.values((y && y.stocks) || {}).forEach(function (b) { (b.stocks || []).forEach(function (it) { set.add(it.id); }); });
      state.foreignIds = set;
    } catch (e) { state.foreignIds = new Set(); }
    return state.foreignIds;
  }
  async function openShopFlips() {
    const bx = host.querySelector("#tdk-buyers");
    bx.classList.add("open");
    bx.innerHTML = '<div class="tdk-bh"><div class="tt">🏪 Shop Flips<small> — loading…</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div><div class="br" style="padding:10px 12px">Scanning the item catalog…</div>';
    bindClose(bx);
    const setTitle = function (s) { const t = bx.querySelector(".tt"); if (t) t.innerHTML = '🏪 Shop Flips<small> — ' + s + '</small>'; };
    const key = tornKey();
    if (!key) { setTitle("need a Torn API key (⚙ Settings)"); return; }
    try {
      await loadResale(key);
      const foreign = await ensureForeignIds();
      const meta = state.itemMeta || {};
      const cashCeil = (state.cash && state.cash > 0) ? state.cash : 50e6;
      const cand = [];
      Object.keys(meta).forEach(function (id) {
        const m = meta[id], buy = m.buy || 0, mkt = m.mkt || 0;
        if (!(buy > 0) || !(mkt > 0) || foreign.has(+id)) return;
        if (buy > cashCeil) return;
        const spread = mkt - buy, marg = spread / buy;
        if (spread < 500 || marg < 0.08) return;
        cand.push({ id: +id, name: m.name, type: m.type, buy: buy, mkt: mkt, spread: spread, marg: marg });
      });
      cand.sort(function (a, b) { return b.spread - a.spread; });
      const top = cand.slice(0, 20);
      if (!top.length) { setTitle("nothing above threshold"); bx.querySelector(".br").textContent = "No shop→market flips over $500 spread right now."; return; }
      const cat = function (id) { return (meta[id] && meta[id].type) || ""; };
      const rows = top.map(function (c) {
        const marg = Math.round(c.marg * 100);
        const net = c.spread - c.mkt * 0.01;
        const warn = marg > 500 ? ' <span class="fwarn" title="Huge % on a cheap item — small cash and usually restock-capped; verify it\'s in the shop">⚠</span>' : '';
        const mUrl = marketUrl(c.id, c.name, cat(c.id));
        return '<div class="tdk-flip" data-id="' + c.id + '" data-name="' + c.name.replace(/"/g, "") + '">' +
          '<div class="fn">' + c.name + ' <span class="skhold" style="color:#928b78">' + c.type + '</span>' + warn +
          '<div class="fs">shop <b>' + full$(c.buy) + '</b> → market <b>' + full$(c.mkt) + '</b> <a class="fbuy" href="' + mUrl + '" target="_blank" rel="noopener" title="Open the Item Market to sell (1% fee) or check price">🛒 Market</a> <span>· net +' + money(net) + ' after 1% list fee · ⚡ click row for buyers</span></div></div>' +
          '<div class="fp"><div class="fpv">+' + money(c.spread) + '</div><div class="fpm">' + marg + '% /ea</div></div></div>';
      }).join("");
      setTitle("Torn city shops · buy low → sell on market · top " + top.length);
      bx.innerHTML = '<div class="tdk-bh"><div class="tt">🏪 Shop Flips<small> — Torn city shops · top ' + top.length + '</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>' +
        '<div class="tdk-sub" style="padding:6px 12px">Buy at the fixed shop price, sell on the market. Shop price is a catalog constant — <b>verify the item is actually stocked</b> (shops have limited stock, caps &amp; restocks; the market can\'t absorb unlimited). Selling on the Item Market costs 1% (a direct ⚡ trade is fee-free). Travel items are excluded — the board covers those.</div>' +
        '<div id="tdk-flips">' + rows + '</div>';
      bindClose(bx);
      bx.querySelectorAll(".tdk-flip .fbuy").forEach(function (a) { a.addEventListener("click", function (e) { e.stopPropagation(); }); });
      bx.querySelectorAll(".tdk-flip").forEach(function (el) { el.addEventListener("click", function () { openBuyers(+this.getAttribute("data-id"), this.getAttribute("data-name")); }); });
    } catch (e) {
      const b = bx.querySelector(".br"); if (b) b.textContent = "Shop scan failed: " + (e.message || e) + " (check your key in ⚙ Settings).";
    }
  }

  const bDec = function (s) { return String(s || "").replace(/&#0?39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">"); };
  function trapInfo(x) {
    const r = [];
    if (x.defw >= 300) r.push(x.defw.toLocaleString() + ' defends won');
    if (x.xan >= 100) r.push(x.xan.toLocaleString() + ' xanax');
    if (x.nw >= 1e9) r.push('$' + (x.nw / 1e9).toFixed(1) + 'B');
    if (!r.length) return null;
    const ageBit = (x.age && x.level && x.age / x.level >= 50) ? ((x.age >= 365 ? (x.age / 365).toFixed(1) + 'y' : x.age + 'd') + ' old at L' + x.level) : null;
    return (ageBit ? ageBit + ' · ' : '') + r.slice(0, 2).join(' · ');
  }
  async function openBounty() {
    const bx = host.querySelector("#tdk-buyers");
    bx.classList.add("open");
    const mn0 = GM_getValue("bounty_min", 50000), mx0 = GM_getValue("bounty_max", 250000), ml0 = GM_getValue("bounty_maxlvl", state.myLevel || 25), solo0 = GM_getValue("bounty_solo", true);
    bx.innerHTML = '<div class="tdk-bh"><div class="tt">🎯 Bounty<small> — targets you might beat</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>' +
      '<div class="tdk-calc">$<input id="tdk-bmin" type="number" value="' + mn0 + '" title="Min reward"> – $<input id="tdk-bmax" type="number" value="' + mx0 + '" title="Max reward"> · ≤ lvl <input id="tdk-bmaxlvl" type="number" value="' + ml0 + '" title="Max target level"> · <label class="tdk-solo"><input type="checkbox" id="tdk-bsolo"' + (solo0 ? ' checked' : '') + '> solo only</label> <button class="tdk-btn2 tdk-sm" id="tdk-bscan">🔄 Scan</button></div>' +
      '<div class="tdk-sub" style="padding:6px 12px" id="tdk-bnote">' + (state.myLevel ? "You're level " + state.myLevel + ". " : "") + 'Lowest-level first = best chance to win. Level ≠ stats — spy first if you can; solo targets (no faction) can\'t be avenged. A loss just costs energy + a short hospital stay.</div>' +
      '<div id="tdk-blist"></div>';
    bindClose(bx);
    const scan = async function () {
      const key = tornKey(); const list = host.querySelector("#tdk-blist");
      if (!key) { host.querySelector("#tdk-bnote").innerHTML = 'Need a Torn API key (⚙ Settings).'; return; }
      const mn = Math.max(0, parseInt(host.querySelector("#tdk-bmin").value, 10) || 0);
      const mx = Math.max(mn, parseInt(host.querySelector("#tdk-bmax").value, 10) || 250000);
      const ml = Math.max(1, parseInt(host.querySelector("#tdk-bmaxlvl").value, 10) || 99);
      const solo = host.querySelector("#tdk-bsolo").checked;
      GM_setValue("bounty_min", mn); GM_setValue("bounty_max", mx); GM_setValue("bounty_maxlvl", ml); GM_setValue("bounty_solo", solo);
      list.innerHTML = '<div class="tdk-sub" style="padding:10px 12px">Scanning bounties…</div>';
      try {
        const offs = []; for (let o = 0; o <= 1500; o += 100) offs.push(o);
        const pages = await Promise.all(offs.map(function (o) { return gmGet("https://api.torn.com/v2/torn/bounties?offset=" + o + "&key=" + encodeURIComponent(key)).catch(function () { return null; }); }));
        const all = []; pages.forEach(function (j) { if (j && j.bounties) all.push.apply(all, j.bounties); });
        const inR = all.filter(function (x) { return x.reward >= mn && x.reward <= mx && x.target_level <= ml; });
        const byT = {}; inR.forEach(function (x) { if (!byT[x.target_id] || x.reward > byT[x.target_id].reward) byT[x.target_id] = x; });
        let block; try { block = GM_getValue("bounty_block", null) || {}; } catch (e) { block = {}; }
        const cand = Object.keys(byT).map(function (k) { return byT[k]; }).filter(function (x) { return !block[x.target_id]; }).sort(function (a, b) { return a.target_level - b.target_level; }).slice(0, 36);
        if (!cand.length) { list.innerHTML = '<div class="tdk-sub" style="padding:10px 12px">No bounties in $' + mn.toLocaleString() + '–$' + mx.toLocaleString() + ' at ≤ lvl ' + ml + (Object.keys(block).length ? ' (' + Object.keys(block).length + ' hidden)' : '') + '. Widen the range.</div>'; return; }
        list.innerHTML = '<div class="tdk-sub" style="padding:6px 12px">Checking status + faction for ' + cand.length + ' targets…</div>';
        await Promise.all(cand.map(function (x) {
          return gmGet("https://api.torn.com/user/" + x.target_id + "/?selections=profile,personalstats&key=" + encodeURIComponent(key)).then(function (p) {
            x.state = (p && p.status && p.status.state) || "?"; x.last = (p && p.last_action && p.last_action.status) || "?";
            x.until = (p && p.status && p.status.until) || 0;
            x.faction = (p && p.faction && p.faction.faction_id) ? (p.faction.faction_name || "faction") : null;
            x.age = (p && p.age) || 0; const ps = (p && p.personalstats) || {};
            x.defw = ps.defendswon || 0; x.xan = ps.xantaken || 0; x.nw = ps.networth || 0; x.aw = ps.attackswon || 0;
            x.trap = trapInfo(x);
            x.prot = x.age > 0 && x.age < 14;
          }).catch(function () { x.state = "?"; x.last = "?"; x.faction = null; });
        }));
        let rows = cand;
        if (solo) rows = rows.filter(function (x) { return !x.faction; });
        const dot = function (s) { return s === "Online" ? "🟢" : s === "Idle" ? "🟡" : "⚫"; };
        const nowS = Math.floor(Date.now() / 1000);
        const rowFn = function (x) {
          const stTxt = x.state === "Okay" ? "Okay" : x.state + (x.until > nowS ? ' <span class="bout">· out in ' + fmtDur(x.until - nowS) + '</span>' : '');
          return '<div class="bnty' + (x.state === "Okay" ? "" : " na") + (x.trap ? " trap" : "") + '"><div class="bmain"><div class="bn">' +
            '<a href="https://www.torn.com/page.php?sid=attack&user2ID=' + x.target_id + '" target="_blank" rel="noopener" title="Attack ' + x.target_name + '">⚔ ' + x.target_name + '</a> <span class="bl">L' + x.target_level + '</span> <a class="bprof" href="https://www.torn.com/profiles.php?XID=' + x.target_id + '" target="_blank" rel="noopener" title="Profile">👤</a></div>' +
            '<div class="bsub">' + dot(x.last) + ' ' + stTxt + ' · ' + (x.faction ? '🚩 ' + bDec(x.faction) : '🕊 solo') + (x.trap ? ' · <span class="btrap">⚠ ' + x.trap + '</span>' : (x.prot ? ' · <span class="bprot2">🛡 protected — attackable in ' + (14 - x.age) + 'd</span>' : (x.reason ? ' · “' + bDec(x.reason) + '”' : ''))) + '</div></div>' +
            '<div class="bpay">$' + x.reward.toLocaleString() + (x.quantity > 1 ? ' <span>×' + x.quantity + '</span>' : '') + '</div>' +
            '<button class="bhide" data-id="' + x.target_id + '" data-name="' + String(x.target_name).replace(/"/g, "") + '" title="Avoid — hide this target from all future scans (too strong / beat you)">🚫</button></div>';
        };
        const safe = rows.filter(function (x) { return !x.trap; }), traps = rows.filter(function (x) { return x.trap; });
        const prot = safe.filter(function (x) { return x.prot; });
        const ok = safe.filter(function (x) { return !x.prot && x.state === "Okay"; });
        const na = safe.filter(function (x) { return !x.prot && x.state !== "Okay"; }).sort(function (a, b) { return (a.until || 9e15) - (b.until || 9e15); });
        const blkN = Object.keys(block).length;
        list.innerHTML =
          '<div class="sksec">✅ Attackable now · ' + ok.length + (solo ? ' · solo only' : '') + '</div>' +
          (ok.length ? ok.map(rowFn).join('') : '<div class="tdk-sub" style="padding:6px 12px">None attackable this second' + (solo ? ' (try unchecking “solo only”)' : '') + ' — real newbies are often new-player-protected or already being farmed. Raise the max level to find players aged past protection.</div>') +
          (na.length ? '<div class="sksec">⛔ In hospital / unavailable · ' + na.length + '</div>' + na.map(rowFn).join('') : '') +
          (prot.length ? '<div class="sksec">🛡 New-player protected · ' + prot.length + ' (can’t attack — under 14 days old)</div>' + prot.map(rowFn).join('') : '') +
          (traps.length ? '<div class="sksec">⚠ Auto-hidden — likely stat-builds · ' + traps.length + ' (don’t attack)</div>' + traps.map(rowFn).join('') : '') +
          (blkN ? '<div class="tdk-sub" style="padding:8px 12px">🚫 ' + blkN + ' target' + (blkN === 1 ? '' : 's') + ' hidden. <a class="tdk-sett-link" id="tdk-bclear">clear all</a></div>' : '');
        list.querySelectorAll(".bhide").forEach(function (b) {
          b.addEventListener("click", function (e) {
            e.stopPropagation(); e.preventDefault();
            let blk; try { blk = GM_getValue("bounty_block", null) || {}; } catch (er) { blk = {}; }
            blk[this.getAttribute("data-id")] = { name: this.getAttribute("data-name") || "", at: Date.now() };
            try { GM_setValue("bounty_block", blk); } catch (er) { }
            const row = this.closest(".bnty"); if (row) row.remove();
          });
        });
        const cl = list.querySelector("#tdk-bclear");
        if (cl) cl.addEventListener("click", function () { try { GM_setValue("bounty_block", {}); } catch (er) { } scan(); });
      } catch (e) { list.innerHTML = '<div class="tdk-sub" style="padding:10px 12px">Bounty scan failed: ' + (e.message || e) + '</div>'; }
    };
    host.querySelector("#tdk-bscan").addEventListener("click", scan);
    scan();
  }
  async function loadInv(key) {
    const now = Date.now();
    if (state.inv && now - state.invAt < 120000) return state.inv;
    const j = await gmGet("https://api.torn.com/user/?selections=inventory,travel&key=" + encodeURIComponent(key));
    if (j.error) throw new Error("Torn API: " + j.error.error);
    state.travel = j.travel || null;
    const raw = j.inventory;
    state.inv = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
    state.invAt = now;
    return state.inv;
  }

  const SAFE_TYPES = { Plushie: 1, Flower: 1, Collectible: 1, Artifact: 1, Jewelry: 1, "Supply Pack": 1 };
  function effSellable(id, type, hasUse, equipped) {
    if (equipped) return false;
    const o = state.ov[id];
    if (o === "sell") return true;
    if (o === "keep") return false;
    return !hasUse && !!SAFE_TYPES[type];
  }
  function toggleOverride(id, curEff) {
    state.ov[id] = curEff ? "keep" : "sell";
    GM_setValue("ov", state.ov);
  }
  function marketUrl(id, name, cat) {
    return "https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=" + id +
      "&itemName=" + String(name || "").trim().replace(/\s+/g, "_") + "&itemType=" + (cat || "");
  }
  const TYPE_ICON = { Plushie: "🧸", Flower: "🌸", Collectible: "🎖️", Artifact: "🏺", Jewelry: "💎", "Supply Pack": "📦", Drug: "💊", Candy: "🍬", Enhancer: "✨", Tool: "🔧", Material: "🧱", Special: "⭐", Temporary: "⏳", Medical: "➕", Alcohol: "🍺", Energy: "🥤", Booster: "🧃", Weapon: "🗡️", Armor: "🛡️", Clothing: "👕", Car: "🚗", Book: "📖" };
  function typeIcon(t) { return TYPE_ICON[t] || "•"; }

  function invItems() {
    const api = state.inv || [];
    if (api.length) return { items: api, source: "api", at: state.invAt };
    const store = GM_getValue("inv_counts", null);
    if (store && store.map && Object.keys(store.map).length) {
      const meta = state.itemMeta || {};
      const items = Object.keys(store.map).filter(function (id) { return store.map[id] > 0; }).map(function (id) {
        const m = meta[id] || {};
        return { ID: +id, id: +id, name: m.name || ("#" + id), type: m.type || "", quantity: store.map[id], equipped: !!(store.equip && store.equip[id]) };
      });
      return { items: items, source: "scan", at: store.at };
    }
    return { items: [], source: "none", at: 0 };
  }

  function haulSummary(foreignOnly) {
    const store = GM_getValue("inv_counts", null);
    if (!store || !store.map) return null;
    const prices = state.resale || {}, meta = state.itemMeta || {}, foreign = state.foreignIds;
    if (foreignOnly && (!foreign || !foreign.size)) return { items: 0, count: 0, value: 0 };
    let items = 0, count = 0, value = 0;
    Object.keys(store.map).forEach(function (id) {
      const qty = store.map[id], price = prices[id]; if (!qty || !price) return;
      if (foreignOnly) { if (!foreign.has(+id)) return; }
      else { const m = meta[id] || {}; if (!effSellable(id, m.type, m.hasUse, store.equip && store.equip[id])) return; }
      items++; count += qty; value += price * qty;
    });
    return { items: items, count: count, value: value };
  }

  const PACK_MODELS = {
    "Six-Pack of Alcohol": { kind: "draws", n: 6, pool: ["Bottle of Kandy Kane", "Bottle of Pumpkin Brew", "Bottle of Minty Mayhem", "Bottle of Wicked Witch", "Bottle of Mistletoe Madness", "Bottle of Stinky Swamp Punch"] },
    "Six-Pack of Energy Drink": { kind: "draws", n: 6, pool: ["Can of Munster", "Can of Santa Shooters", "Can of Red Cow", "Can of Rockstar Rudolph", "Can of Taurine Elite", "Can of X-MASS"] },
    "Box of Medical Supplies": { kind: "oneof", outcomes: [[20, "Morphine"], [20, "Empty Blood Bag"], [30, "First Aid Kit"], [50, "Small First Aid Kit"]] },
    "Box of Grenades": { kind: "oneof", outcomes: [[100, "Grenade"], [100, "HEG"]] }
  };
  function nameToId(nm) {
    const meta = state.itemMeta || {};
    if (state._nameIdFor !== meta) {
      const idx = {}; Object.keys(meta).forEach(function (id) { const n = meta[id] && meta[id].name; if (n && idx[n] == null) idx[n] = +id; });
      state._nameId = idx; state._nameIdLc = null; state._nameIdFor = meta;
    }
    if (state._nameId[nm] != null) return state._nameId[nm];
    if (!state._nameIdLc) { state._nameIdLc = {}; Object.keys(state._nameId).forEach(function (n) { state._nameIdLc[n.toLowerCase()] = state._nameId[n]; }); }
    const lc = state._nameIdLc[nm.toLowerCase()];
    return lc != null ? lc : null;
  }
  function packHint(name) {
    const m = PACK_MODELS[name]; if (!m) return null;
    const prices = state.resale || {};
    const priceOf = function (nm) { const id = nameToId(nm); return id != null ? (prices[id] || 0) : 0; };
    let vals;
    if (m.kind === "draws") {
      vals = m.pool.map(priceOf);
      if (vals.some(function (v) { return !v; })) return { incomplete: true };
      const mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      return { ev: m.n * mean, spread: Math.max.apply(null, vals) / Math.max(1, Math.min.apply(null, vals)), oneof: false };
    }
    vals = m.outcomes.map(function (o) { return o[0] * priceOf(o[1]); });
    if (vals.some(function (v) { return !v; })) return { incomplete: true };
    const mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    return { ev: mean, lo: Math.min.apply(null, vals), hi: Math.max.apply(null, vals), spread: Math.max.apply(null, vals) / Math.max(1, Math.min.apply(null, vals)), oneof: true };
  }

  function getPackData() { return GM_getValue("pack_data", {}) || {}; }
  function setPackData(d) { GM_setValue("pack_data", d); }

  function packEmpirical(name) {
    const pd = getPackData()[name]; if (!pd) return null;
    const prices = state.resale || {};
    const valOf = function (items) { let v = 0; Object.keys(items).forEach(function (id) { v += (prices[id] || 0) * items[id]; }); return v; };
    let opens = 0, totalVal = 0; const perOpen = [];
    if (pd.log && pd.log.length) pd.log.forEach(function (rec) { const v = valOf(rec.items || {}); perOpen.push(v); opens++; totalVal += v; });
    if (pd.manual && pd.manual.opens > 0) { opens += pd.manual.opens; totalVal += valOf(pd.manual.items || {}); }
    if (!opens) return null;
    const ev = totalVal / opens;
    let ci = null;
    if (perOpen.length >= 3) {
      const mean = perOpen.reduce(function (a, b) { return a + b; }, 0) / perOpen.length;
      const varr = perOpen.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (perOpen.length - 1);
      ci = 1.96 * Math.sqrt(varr / perOpen.length);
    }
    return { ev: ev, opens: opens, ci: ci, logged: perOpen.length, manual: !!(pd.manual && pd.manual.opens) };
  }

  function packHintHtml(name, sellPrice) {
    if (!PACK_MODELS[name]) return "";
    const edit = ' <span class="tdk-pkedit" data-pack="' + escAttr(name) + '" title="Enter your real drop odds (from torn.report) or sync from your Torn log">✎</span>';
    const emp = packEmpirical(name);
    if (emp && sellPrice) {
      let verdict, cls;
      if (emp.ci != null) {
        if (emp.ev - emp.ci > sellPrice) { verdict = "OPEN"; cls = "open"; }
        else if (emp.ev + emp.ci < sellPrice) { verdict = "SELL"; cls = "sell"; }
        else { verdict = "need more data"; cls = "even"; }
      } else {
        const r = emp.ev / sellPrice;
        verdict = r >= 1.05 ? "OPEN" : r <= 0.95 ? "SELL" : "≈ even";
        cls = r >= 1.05 ? "open" : r <= 0.95 ? "sell" : "even";
      }
      const src = emp.logged ? (emp.manual ? 'n=' + emp.opens + ' log+manual' : 'n=' + emp.opens + ' logged') : 'n=' + emp.opens + ' manual';
      let txt = '🎁 open-EV ~' + money(emp.ev) + (emp.ci != null ? ' ±' + money(emp.ci) : '') + ' vs sell ' + money(sellPrice) + ' → ' + verdict + ' <span class="tdk-pkm">' + src + '</span>';
      return '<div class="cy tdk-pk ' + cls + '" title="Your real drop odds × live prices. Verdict turns confident once the ± interval clears the sell price.">' + txt + edit + '</div>';
    }
    const h = packHint(name); if (!h) return "";
    if (h.incomplete) return '<div class="cy tdk-pk">🎁 open-EV: contents not priced yet — open your Items page tabs' + edit + '</div>';
    const wide = h.spread >= 5;
    let txt = '🎁 open-EV ~' + money(h.ev) + ' <span class="tdk-pkm">equal-odds, rough</span>';
    if (h.oneof) txt += ' · one of ' + money(h.lo) + '–' + money(h.hi);
    txt += ' · vs sell ' + money(sellPrice);
    if (wide) txt += ' · ⚠ wide spread — gamble';
    return '<div class="cy tdk-pk ' + (wide ? 'warn' : 'even') + '" title="Rough equal-odds estimate (wiki contents × live prices). Add your real odds with ✎ for a verdict.">' + txt + edit + '</div>';
  }

  async function renderInv() {
    const box = host.querySelector("#tdk-inv");
    box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk</div><div class="p">loading inventory…</div></div>';
    const key = tornKey();
    if (!key) { box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk</div><div class="p">Need a Torn API key</div></div>'; return; }
    let items;
    try { items = await loadInv(key); } catch (e) {
      const keyBad = KEYERR.test(e.message || "");
      box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk</div><div class="p">Error: ' + e.message + '</div>' + (keyBad ? '<div class="k"><a class="tdk-sett-link" id="tdk-inv-set">open ⚙ Settings to update your key</a></div>' : '') + '</div>';
      const l = box.querySelector("#tdk-inv-set"); if (l) l.addEventListener("click", openSettings);
      return;
    }
    const tv = state.travel;
    const arriveIn = tv && tv.timestamp ? tv.timestamp - Math.floor(Date.now() / 1000) : 0;
    if (arriveIn > 0) {
      state.invAt = 0;
      const m = Math.floor(arriveIn / 60), s = arriveIn % 60;
      const eta = m > 0 ? m + "m " + s + "s" : s + "s";
      box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk</div>' +
        '<div class="p">✈ In flight to ' + (tv.destination || "destination") + '</div>' +
        '<div class="k">Torn hides your inventory while traveling — land first, then reopen 📦 Bag. Arriving in ~' + eta + '.</div></div>';
      return;
    }
    if (!state.resale || !state.itemMeta) { try { await loadResale(key); } catch (e) { } }
    paintInv();
  }

  function paintInv() {
    const box = host.querySelector("#tdk-inv"); if (!box) return;
    const src = invItems();
    const items = src.items, priceMap = state.resale || {}, meta = state.itemMeta || {};
    const idOf = function (it) { return it.ID || it.id || it.item_id; };
    const priceOf = function (it) { return priceMap[idOf(it)] || it.market_price || 0; };
    const metaOf = function (it) { return meta[idOf(it)] || {}; };
    const typeOf = function (it) { return metaOf(it).type || it.type || "—"; };
    const eqSet = (GM_getValue("inv_counts", null) || {}).equip || {}; // equipped items scraped from item.php — honored even if the live API omits the flag
    const sell = [], keep = [];
    items.forEach(function (it) {
      const price = priceOf(it); if (price <= 0) return;
      const id = idOf(it), m = metaOf(it);
      const s = effSellable(id, typeOf(it), m.hasUse, it.equipped || eqSet[id]);
      (s ? sell : keep).push({ id: id, name: it.name, type: typeOf(it), qty: it.quantity, unit: price, total: price * it.quantity, ov: !!state.ov[id] });
    });
    sell.sort(function (a, b) { return b.total - a.total; });
    keep.sort(function (a, b) { return b.total - a.total; });
    const esc = function (s) { return String(s || "").replace(/"/g, "&quot;"); };
    const rowsHtml = function (arr, sellable) {
      return arr.map(function (x) {
        const tog = '<span class="tdk-tog" data-id="' + x.id + '" data-eff="' + (sellable ? 1 : 0) + '" title="' + (sellable ? 'Mark as keep' : 'Allow selling this item') + (x.ov ? ' — override set' : '') + '">' + (sellable ? '🔒' : '🔓') + '</span>';
        const basket = sellable ? '<a class="tdk-bmkt" href="' + marketUrl(x.id, x.name, x.type) + '" target="_blank" rel="noopener" title="Open Item Market">🧺</a>' : '';
        const zap = sellable ? '<span class="tdk-bzap" data-id="' + x.id + '" data-name="' + esc(x.name) + '" title="Find buyers for this item">⚡</span>' : '';
        return '<tr' + (x.ov ? ' class="tdk-ovr"' : '') + '><td class="l"><span class="nm">' + x.name + '</span>' + packHintHtml(x.name, x.unit) + '</td>' +
          '<td class="l"><span class="cy">' + typeIcon(x.type) + ' ' + x.type + '</span></td>' +
          '<td class="num">' + x.qty.toLocaleString() + ' × ' + full$(x.unit) + '</td>' +
          '<td class="num gd">' + full$(x.total) + '</td>' +
          '<td class="tdk-act">' + basket + zap + tog + '</td></tr>';
      }).join("");
    };
    const table = function (arr, sellable) {
      return '<table class="tdk"><thead><tr><th class="l">Item</th><th class="l">Category</th><th>Qty × Sell</th><th>Expected $</th><th></th></tr></thead><tbody>' + rowsHtml(arr, sellable) + '</tbody></table>';
    };
    const scanNote = src.source === "scan" ? ' <span class="tdk-keep">· scraped snapshot' + (src.at ? ' ' + ago(Math.floor((Date.now() - src.at) / 1000)) + ' old' : '') + ' (inventory API down)</span>' : '';
    const rescanBtn = src.source === "scan" ? ' <button class="tdk-btn2 tdk-sm" id="tdk-invclear" title="Sold something that still shows here? Wipe the scraped snapshot and rebuild it by reopening your Items-page tabs.">↻ Rescan</button>' : '';
    if (!sell.length && !keep.length) {
      box.innerHTML = '<div class="tdk-best"><div class="l">Bag</div>' +
        '<div class="p">' + (src.source === "none" ? 'Nothing catalogued yet' : 'Nothing sellable found') + '</div>' +
        '<div class="k">' + (src.source === "none"
          ? 'Torn’s inventory API is down for their migration, so open your <b>Items page</b> and click through the category tabs (Candy, Drugs, Plushies, …) once — the tool catalogs what you hold as you browse, then shows every sellable item here in one place.'
          : 'Nothing here is currently sellable on the market.') + '</div></div>';
      return;
    }
    const grand = sell.reduce(function (s, x) { return s + x.total; }, 0);
    const hasPack = sell.concat(keep).some(function (x) { return PACK_MODELS[x.name]; });
    const packNote = hasPack ? ' <span class="tdk-keep">· 🎁 pack open-EV is a rough equal-odds estimate — see <a class="tdk-sett-link" href="https://torn.report/pack" target="_blank" rel="noopener">torn.report</a> for real drop odds</span>' : '';
    let html = '<div class="tdk-best"><div class="l">Safe to sell · ' + sell.length + ' item' + (sell.length === 1 ? '' : 's') + scanNote + '</div>' +
      '<div class="p">' + money(grand) + ' <span>expected if you dump it all</span></div>' +
      '<div class="k">🧺 open market · ⚡ find buyers · 🔒 held back / 🔓 allow (saved). Links only open Torn’s market — nothing sells for you.' + rescanBtn + packNote + '</div></div>';
    html += sell.length ? table(sell, true) : '<div class="tdk-sub">Nothing marked sell-ok right now.</div>';
    if (keep.length) {
      const kept = keep.reduce(function (s, x) { return s + x.total; }, 0);
      html += '<div class="tdk-keephdr">🔒 Held back · ' + keep.length + ' item' + (keep.length === 1 ? '' : 's') + ' · ' + money(kept) + ' <span>(use-items, gear &amp; untrusted types — click 🔓 to allow one)</span></div>' + table(keep, false);
    }
    box.innerHTML = html;
    box.querySelectorAll(".tdk-tog").forEach(function (el) {
      el.addEventListener("click", function () {
        toggleOverride(+this.getAttribute("data-id"), this.getAttribute("data-eff") === "1");
        paintInv();
      });
    });
    box.querySelectorAll(".tdk-bzap").forEach(function (el) {
      el.addEventListener("click", function () { openBuyers(+this.getAttribute("data-id"), this.getAttribute("data-name")); });
    });
    box.querySelectorAll(".tdk-pkedit").forEach(function (el) {
      el.addEventListener("click", function () { openPackOdds(this.getAttribute("data-pack")); });
    });
    const clr = box.querySelector("#tdk-invclear");
    if (clr) clr.addEventListener("click", function () {
      GM_setValue("inv_counts", { map: {}, at: 0 });
      setStatus("Snapshot cleared — reopen your Items-page tabs to rebuild it.");
      renderInv();
    });
  }

  function setView(v) {
    state.view = v;
    const bd = host.querySelector("#tdk-board"), iv = host.querySelector("#tdk-inv");
    if (bd) bd.style.display = v === "inv" ? "none" : "";
    if (iv) iv.style.display = v === "inv" ? "" : "none";
    const b = host.querySelector("#tdk-invbtn"); if (b) b.classList.toggle("on", v === "inv");
    const f = host.querySelector("#tdk-fund"); if (f) f.classList.toggle("on", v !== "inv" && state.fund);
    if (v === "inv") renderInv(); else render();
  }

  function markBagReady(ready) {
    const b = host && host.querySelector("#tdk-invbtn"); if (!b) return;
    b.classList.toggle("ready", !!ready);
    b.title = ready ? "Inventory API is back — open your 📦 Bag!" : "Your sellable-junk inventory (Torn's inventory API is down for migration)";
  }
  async function checkInvStatus() {
    const key = GM_getValue("torn_key", ""); if (!key) return;
    try {
      const items = await loadInv(key);
      const tv = state.travel, flying = tv && tv.timestamp && (tv.timestamp - Math.floor(Date.now() / 1000) > 0);
      if (flying) return;
      const ready = items.length > 0, was = state.invReady;
      state.invReady = ready;
      markBagReady(ready);
      if (ready && was === false && panel && panel.classList.contains("open")) {
        setStatus("📦 Torn's inventory API is back — the Bag works now!");
      }
    } catch (e) { /* keep last known state */ }
  }

  const CHANGELOG = [
    { v: "1.54.1", d: "Aug 12, 2026", c: ["📐 Gave the $/min column real breathing room from the panel’s right edge (wider column + right padding), reserved a stable scrollbar gutter so nothing hugs the scrollbar, and did the same for the Departures view’s Status column."] },
    { v: "1.54.0", d: "Aug 12, 2026", c: ["😊 Happy Jump — added a full-jump cost + a tick-off checklist. Set your energy-to-bank target and it prices the whole run at market value: N× Xanax for the energy, Ecstasy, and the Erotic DVDs to reach 99,999 — each with a 🛒 Item-Market buy link (they’re all Item-Market buys, no travel needed). Below it, a saved step-by-step order you can check off as you go over the hours (bank energy → wait the drug cooldown → tissues first → Ecstasy ×2 → train).", "🔋 The gym ‘energy to spend’ box now allows your BANKED energy above the normal max (e.g. 1,000 from stacking Xanax), instead of capping at 150."] },
    { v: "1.53.2", d: "Aug 12, 2026", c: ["📏 Added breathing room between the panel and the right edge of the browser (right margin 18→28px), so the $/min column isn't jammed against the edge."] },
    { v: "1.53.1", d: "Aug 12, 2026", c: ["🛬 Landing is now sortable — and the new default sort: it groups what will actually be IN STOCK when you land first (✓ → ◐ → ✗ → ?), and within each group ranks by $/min, so the top of the board is the best profit among things you can actually buy on arrival. Click any column header to sort by it as before."] },
    { v: "1.53.0", d: "Aug 12, 2026", c: ["🔭 Board view switcher (facelift part 2): the little ▤ ▭ ▬ ✈ buttons above the board flip the SAME travel data between four looks — Table, Cards, Leaderboard (heat bars sized by $/min, coloured by Landing), and Departures (an airport board where Landing reads as BOARDING / LIMITED / CANCELLED). Your choice is saved. Click any row/card/bar to open its buyers, same as before."] },
    { v: "1.52.5", d: "Aug 12, 2026", c: ["🩹 Fixed “Nothing profitable here” while abroad: the ≤time-budget filter was hiding the country you're standing in (its round-trip is long, but you don't fly there — you're already there). The board now always shows the country you're in / heading to, regardless of the time filter."] },
    { v: "1.52.4", d: "Aug 12, 2026", c: ["🔬 The Torn build-watcher list in this window is now collapsible — click the “🔬 Torn build watcher” heading to expand/collapse it (▸/▾). Starts collapsed so it stays out of the way; the count stays in the heading, and it remembers your choice."] },
    { v: "1.52.3", d: "Aug 12, 2026", c: ["📐 Slimmed the rail to a compact icon-only strip (50px, was 76px) like the mockup — hover an icon for its name. Gives the board back the extra width."] },
    { v: "1.52.2", d: "Aug 12, 2026", c: ["🩹 Bag no longer lists EQUIPPED items (e.g. worn pants) as sellable. The equipped flag was being dropped when the Bag ran off the scraped snapshot (Torn's inventory API being flaky), so a worn item with an old ‘sell’ toggle could slip into the sell list. The tool now records which items are equipped from your Items page and always keeps them out of the sell side. Visit your Items page once (any tab) to refresh equipped state, then reopen 📦 Bag."] },
    { v: "1.52.1", d: "Aug 12, 2026", c: ["📐 Board now fits with NO horizontal scroll: folded Buy / Resale / Load into a compact line under each item name (buy → resale · load), so the table is just Item · Profit ×N · Stock · Landing · $/min — five columns that fit any width (fixed layout, long names ellipsis-clip).", "🧹 Decluttered the Stock column — dropped the ⏳ restock ETA (the Landing column + its tooltip already tell you whether it'll be stocked when you land)."] },
    { v: "1.52.0", d: "Aug 12, 2026", c: ["✨ Facelift (part 1 of the redesign): the two cramped header rows are gone — the tabs (📦 ✈ 😊 💱 🏪 📊 🎯) now live in a clean vertical icon rail on the left, with ↻ Refresh and ⚙ Settings at its foot. The top strip keeps just the title, Cap, and A−/A+. Fixes the long-standing “Refresh/⚙ buttons drift as the font size changes” problem and frees up room. Everything works exactly as before — this is a layout change only. Next: selectable board views (Table / Cards / Leaderboard / Departures)."] },
    { v: "1.51.0", d: "Aug 11, 2026", c: ["🔬 Build watcher — smarter “new” detection: the {hash} in each bundle name is already Torn’s content checksum, so a first sighting can’t tell “new to Torn” from “new to you” — those now only ever get CATALOGED (no more false 🆕 alarms from just opening a page you hadn’t before). A hash CHANGE still alerts (real fresh code), and it’s flagged 🆕 only when the module first appeared recently AND is already being re-deployed — the real fingerprint of a genuinely new module Torn is iterating on."] },
    { v: "1.50.0", d: "Aug 11, 2026", c: ["🛬 Landing column simplified to a plain, glanceable answer — ✓ In stock / ◐ Maybe / ◐ Partial / ✗ Empty (or ? when there isn’t enough history), color-coded. Hover gives ONE short line of why (e.g. “usually in stock”, “sells out fast — best right after a restock”). Dropped the cryptic labels and the wall-of-detail tooltips."] },
    { v: "1.49.0", d: "Aug 7, 2026", c: ["🛬 Fixed the Landing prediction (it was wrong for remote destinations): the previous 'hourly simulation' only ever drained stock and never added restocks back, so a long flight always projected 'sold out' even though foreign stock refills every few minutes. Landing now models the RESTOCK CYCLE — for a trip spanning multiple cycles it reports how reliably the item is in stock (✓ usually / ◐ ~N% of each cycle / ⚡ snap up if it sells out fast); for a short hop it checks whether current stock survives and whether a restock beats you there. The day/time (seasonal) sell-rate still feeds the short-hop estimate and keeps improving as data grows.", "🧹 Shared data feed is now built-in — removed the Settings URL box and the Sync button (it just works quietly in the background), de-cluttering the interface."] },
    { v: "1.48.0", d: "Aug 7, 2026", c: ["⚙ Resale Price Basis Toggle: Added setting to calculate $/min off either 'Market Value (Bazaar / Item Market)' or 'Top Trader Offer (Instant Trade via W3B)'. Your preference is saved permanently.", "⚡ Resale Column Indicator: When calculating off trader buy prices, a small ⚡ badge appears next to the resale value on the board."] },
    { v: "1.47.0", d: "Aug 6, 2026", c: ["💰 Smart Stock Load Tooltip: Load column now shows in orange with the stock symbol (e.g. IST) if you need to free cash before flying...", "🧹 Cleaned up board layout by embedding stock symbols directly into the Load column."] },
    { v: "1.46.0", d: "Aug 6, 2026", c: ["📅 Day/Time Aware Landing Engine: 'Landing' column now runs an hourly simulation over your flight path...", "🎯 Confidence Indicator: Landing predictions now flag when seasonal bucket data is thin..."] },
    { v: "1.45.0", d: "Aug 5, 2026", c: ["🌐 Shared data feed (optional): point ⚙ Settings → “Shared data feed URL”..."] }
  ];

  const RAW_URL = "https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.user.js";
  function curVersion() { return (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "0"; }
  function cmpVer(a, b) {
    const pa = String(a).split("."), pb = String(b).split(".");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = parseInt(pa[i] || "0", 10), nb = parseInt(pb[i] || "0", 10);
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return 0;
  }
  function checkUpdate() {
    const s = host.querySelector("#tdk-upd"); if (!s) return;
    s.textContent = "Checking…";
    GM_xmlhttpRequest({
      method: "GET", url: RAW_URL + "?_=" + Date.now(), timeout: 15000,
      onload: function (r) {
        const m = (r.responseText || "").match(/@version\s+([\d.]+)/);
        const remote = m ? m[1] : null, cur = curVersion();
        if (!remote) { s.textContent = "Couldn't read remote version."; return; }
        if (cmpVer(cur, remote) < 0) {
          s.innerHTML = "Update available: <b>v" + remote + "</b> (you have v" + cur + ") — <a href=\"" + RAW_URL + "\" target=\"_blank\" rel=\"noopener\">Install now ↗</a>";
        } else {
          s.innerHTML = "You're on the latest — <b>v" + cur + "</b> ✓";
        }
      },
      onerror: function () { s.textContent = "Couldn't reach GitHub."; },
      ontimeout: function () { s.textContent = "Update check timed out."; }
    });
  }

  const HAPPY_ITEMS = {
    "Bag of Bon Bons": 25, "Bag of Chocolate Kisses": 25, "Box of Bon Bons": 25, "Box of Extra Strong Mints": 25, "Box of Sweet Hearts": 25, "Lollipop": 25, "Box of Chocolate Bars": 25,
    "Big Box of Chocolate Bars": 35, "Bag of Candy Kisses": 50, "Chocolate Egg": 50, "Bag of Bloody Eyeballs": 75, "Bag of Tootsie Rolls": 75, "Bag of Chocolate Truffles": 100, "Bag of Reindeer Droppings": 100,
    "Bag of Humbugs": 150, "Bag of Sherbet": 150, "Jawbreaker": 150, "Pixie Sticks": 150, "Birthday Cupcake": 250,
    "Shrooms": 500, "PCP": 250, "Xanax": 75, "Vicodin": 75, "Speed": 50, "Erotic DVD": 2500, "Feathery Hotel Coupon": 500
  };
  const HAPPY_CAP = 99999;
  function calcHappy(start, flat, ecstasy) {
    if (!ecstasy) return Math.min(HAPPY_CAP, start + flat);
    const beforeFlat = Math.min(flat, Math.max(0, Math.floor(HAPPY_CAP / 2) - start));
    const doubled = Math.min(HAPPY_CAP, (start + beforeFlat) * 2);
    return Math.min(HAPPY_CAP, doubled + (flat - beforeFlat));
  }
  async function openHappy() {
    const bx = host.querySelector("#tdk-buyers");
    bx.classList.add("open");
    bx.innerHTML = '<div class="tdk-bh"><div class="tt">Happy Jump<small> — loading…</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>';
    bindClose(bx);
    const key = GM_getValue("torn_key", "");
    let cur = null, max = null, stats = null, gymId = null, energyNow = null, energyMax = 150;
    if (key) {
      try {
        const j = await gmGet("https://api.torn.com/user/?selections=bars,battlestats,gym&key=" + encodeURIComponent(key));
        if (j && j.happy) { cur = j.happy.current; max = j.happy.maximum; }
        if (j && j.energy) { energyNow = j.energy.current; if (j.energy.maximum) energyMax = j.energy.maximum; }
        if (j && typeof j.strength === "number") stats = { Strength: j.strength, Speed: j.speed, Defense: j.defense, Dexterity: j.dexterity };
        if (j && j.active_gym) gymId = j.active_gym;
      } catch (e) { }
      if (!state.gyms) { try { const g = await gmGet("https://api.torn.com/torn/?selections=gyms&key=" + encodeURIComponent(key)); state.gyms = (g && g.gyms) || {}; } catch (e) { } }
      if (!state.itemMeta) { try { await loadResale(key); } catch (e) { } }
    }
    const gym = (state.gyms && gymId && state.gyms[gymId]) ? state.gyms[gymId] : null;
    const meta = state.itemMeta || {}, store = GM_getValue("inv_counts", null);
    const held = {}; let hasEcstasy = false;
    if (store && store.map) Object.keys(store.map).forEach(function (id) {
      const nm = meta[id] && meta[id].name;
      if (nm && HAPPY_ITEMS[nm] != null) held[nm] = store.map[id];
      if (nm === "Ecstasy") hasEcstasy = true;
    });
    const heldNames = Object.keys(held).sort(function (a, b) { return HAPPY_ITEMS[b] - HAPPY_ITEMS[a]; });
    const start = cur != null ? cur : (max != null ? max : 0);
    const itemRows = heldNames.map(function (nm) {
      return '<div class="hrow"><label>' + nm + ' <span class="hv">+' + HAPPY_ITEMS[nm] + '</span></label>' +
        '<input class="hqty" type="number" min="0" data-per="' + HAPPY_ITEMS[nm] + '" value="' + held[nm] + '"><span class="hsub" data-sub></span></div>';
    }).join("");
    const STAT_KEYS = { Strength: "strength", Speed: "speed", Defense: "defense", Dexterity: "dexterity" };
    const trainable = (gym ? Object.keys(STAT_KEYS).filter(function (s) { return (gym[STAT_KEYS[s]] || 0) > 0; }) : []);
    const defStat = trainable[0] || "Strength";
    const enCap = Math.max(energyMax, energyNow || 0); // allow banked energy over the normal max (Xanax pushes above the cap)
    const gymBlock = (stats && gym) ? (
      '<div class="hsec hgymhdr" style="margin-top:12px;border-top:1px dashed #3a3729;padding-top:8px">Gym gain estimate <small>— ' + (gym.name || "gym") + ' · ' + gym.energy + 'E/train · rough</small></div>' +
      '<div class="hstats">' + Object.keys(STAT_KEYS).map(function (s) {
        const dots = (gym[STAT_KEYS[s]] || 0) / 10;
        return '<button class="hstat' + (s === defStat ? " on" : "") + '" data-stat="' + s + '" data-dots="' + dots + '" data-val="' + stats[s] + '"' + (dots <= 0 ? " disabled" : "") + '>' + s.slice(0, 3) + ' ' + (dots > 0 ? "(" + dots.toFixed(1) + ")" : "—") + '</button>';
      }).join("") + '</div>' +
      '<div class="hrow"><label>Energy to spend</label><input class="hqty" id="tdk-hen" type="number" min="' + gym.energy + '" max="' + enCap + '" value="' + (energyNow && energyNow > 0 ? energyNow : enCap) + '"><span class="hv">max ' + enCap.toLocaleString() + (enCap > energyMax ? ' (banked)' : '') + '</span></div>' +
      '<div class="hgymres" id="tdk-hgymres"></div>' +
      '<div class="ssub">Estimate (Vladar formula, verified) · excludes Steadfast/education perks · happy decays as you train.</div>'
    ) : (key && stats ? '<div class="ssub">Gym estimate needs your active gym — train once, then reopen 😊 Happy.</div>' : '');
    bx.innerHTML =
      '<div class="tdk-bh"><div class="tt">Happy Jump' + (max != null ? '<small> — ' + start.toLocaleString() + ' / ' + max.toLocaleString() + ' base</small>' : '') + '</div><button class="tdk-bx" id="tdk-bclose">×</button></div>' +
      '<div class="tdk-happy">' +
        '<div class="hreset" id="tdk-hreset">…</div>' +
        (key ? '' : '<div class="ssub serr">Add your Torn API key in ⚙ Settings to read live happy.</div>') +
        (heldNames.length ? '<div class="hsec">Boosters you hold <small>(edit counts)</small></div>' + itemRows
          : '<div class="ssub">No happy items detected yet — open your Items page (Candy / Drugs tabs) so the tool can see them, or just enter a total below.</div>') +
        '<div class="hrow"><label>Other flat happy <span class="hv">manual</span></label><input class="hqty" id="tdk-hother" type="number" min="0" data-per="1" value="0"><span class="hsub" data-sub></span></div>' +
        '<div class="hrow hchk"><label><input type="checkbox" id="tdk-hecs"' + (hasEcstasy ? ' checked' : '') + '> Ecstasy ×2 <span class="hv">doubles happy</span></label></div>' +
        '<div class="hresult" id="tdk-hresult"></div>' +
        '<div class="hseq" id="tdk-hseq"></div>' +
        '<div class="ssub">Cap 99,999 · boosted happy lasts only until the reset. Values verified from the Torn wiki.</div>' +
        '<div class="hsec" style="margin-top:12px;border-top:1px dashed #3a3729;padding-top:8px">🛒 Cost to run a full jump <small>— est. at market value</small></div>' +
        '<div class="hrow"><label>Energy to bank</label><input id="tdk-hen-target" type="number" min="0" step="250" value="1000"><span class="hv">Xanax = +250 each</span></div>' +
        '<div class="hcost" id="tdk-hcost"></div>' +
        '<div class="hsec" style="margin-top:12px">Best order <small>— tick as you go</small> · <a class="prof" id="tdk-hck-reset" href="#">reset</a></div>' +
        '<ul class="horder" id="tdk-hchecklist">' +
          '<li><label><input type="checkbox" data-step="s1"> <b>Bank energy</b> — one Xanax every ~6–8h (drug cooldown), <b>don’t spend energy</b>, until you hit your target.</label></li>' +
          '<li><label><input type="checkbox" data-step="s2"> <b>Wait out the final Xanax’s drug cooldown</b> before any Ecstasy — otherwise the overdose wipes your energy + happy.</label></li>' +
          '<li><label><input type="checkbox" data-step="s3"> Right after a happy reset (xx:00/15/30/45): eat happy items — <b>Box of Tissues first</b> (caps ~20% of max), then candies / eDVDs — up to ~50,000.</label></li>' +
          '<li><label><input type="checkbox" data-step="s4"> <b>Ecstasy ×2</b> → ~99,999.</label></li>' +
          '<li><label><input type="checkbox" data-step="s5"> Eat any leftover happy items.</label></li>' +
          '<li><label><input type="checkbox" data-step="s6"> <b>Train all your energy</b> before the next 15-minute reset.</label></li>' +
        '</ul>' +
        gymBlock +
      '</div>';
    bindClose(bx);

    const VLA = { a: 3.480061091e-7, b: 250, c: 3.091619094e-6, d: 6.82775184551527e-5, e: -0.0301431777 };
    const gymBracket = function (h, s) { return (VLA.a * Math.log(h + VLA.b) + VLA.c) * s + VLA.d * (h + VLA.b) + VLA.e; };
    const estGym = function (dots, statVal, happy, energy, ept) {
      const per = function (h, s) { return Math.max(0, dots * ept * gymBracket(h, s)); };
      let h = happy, s = statVal, en = energy, total = 0, n = 0;
      while (en >= ept && n < 200000) { const g = per(h, s); total += g; s += g; en -= ept; n++; h = Math.max(0, h - ept * 0.5); }
      return { total: total, perStart: per(happy, statVal), trains: n };
    };
    const fmtG = function (n) { return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2); };
    let lastHappy = start;
    const updateGymEst = function () {
      const res = bx.querySelector("#tdk-hgymres"); if (!res || !gym) return;
      const sb = bx.querySelector(".hstat.on"); if (!sb) { res.textContent = ""; return; }
      const dots = +sb.getAttribute("data-dots"), statVal = +sb.getAttribute("data-val"), statName = sb.getAttribute("data-stat");
      const enEl = bx.querySelector("#tdk-hen"), energy = Math.max(gym.energy, Math.min(enCap, parseInt(enEl && enEl.value, 10) || enCap));
      const est = estGym(dots, statVal, lastHappy, energy, gym.energy);
      res.innerHTML = '~<b>+' + fmtG(est.perStart) + '</b> ' + statName + '/train @ ' + lastHappy.toLocaleString() + ' happy · total <b>~+' + fmtG(est.total) + '</b> from ' + energy.toLocaleString() + 'E <span class="hv">(' + est.trains + ' trains, happy decaying)</span>';
    };
    bx.querySelectorAll(".hstat").forEach(function (b) { b.addEventListener("click", function () { if (this.disabled) return; bx.querySelectorAll(".hstat").forEach(function (x) { x.classList.remove("on"); }); this.classList.add("on"); updateGymEst(); }); });
    const enEl = bx.querySelector("#tdk-hen"); if (enEl) enEl.addEventListener("input", updateGymEst);
    const renderCost = function () {
      const el = bx.querySelector("#tdk-hcost"); if (!el) return;
      const ecs = bx.querySelector("#tdk-hecs").checked;
      const baseH = max != null ? max : start;
      const targetE = Math.max(0, parseInt((bx.querySelector("#tdk-hen-target") || {}).value, 10) || 0);
      const nXan = Math.ceil(targetE / 250);
      const flatBefore = ecs ? Math.max(0, Math.floor(HAPPY_CAP / 2) - baseH) : Math.max(0, HAPPY_CAP - baseH);
      const dvdNeed = Math.ceil(flatBefore / 2500);
      const priceOf = function (nm) { const id = nameToId(nm); return id ? ((state.resale && state.resale[id]) || 0) : 0; };
      const link = function (nm) { const id = nameToId(nm); if (!id) return ""; const t = (state.itemMeta && state.itemMeta[id] && state.itemMeta[id].type) || ""; return ' <a class="prof" href="' + marketUrl(id, nm, t) + '" target="_blank" rel="noopener" title="Buy on the Item Market">🛒</a>'; };
      const $ = function (n) { return n > 0 ? money(n) : '<span class="hv">price?</span>'; };
      const cX = nXan * priceOf("Xanax"), cE = ecs ? priceOf("Ecstasy") : 0, cD = dvdNeed * priceOf("Erotic DVD");
      const tot = cX + cE + cD;
      el.innerHTML =
        '<div class="hcrow"><span>' + nXan + '× Xanax → +' + (nXan * 250).toLocaleString() + 'E' + link("Xanax") + '</span><b>' + $(cX) + '</b></div>' +
        (ecs ? '<div class="hcrow"><span>1× Ecstasy — doubles happy' + link("Ecstasy") + '</span><b>' + $(cE) + '</b></div>' : '') +
        '<div class="hcrow"><span>' + dvdNeed + '× Erotic DVD → +' + (dvdNeed * 2500).toLocaleString() + ' happy' + link("Erotic DVD") + '</span><b>' + $(cD) + '</b></div>' +
        '<div class="hcrow htot"><span>Total <span class="hv">from base ' + baseH.toLocaleString() + ' happy' + (ecs ? '' : ', no Ecstasy') + '</span></span><b>' + $(tot) + '</b></div>' +
        '<div class="ssub">All three are <b>Item Market</b> buys — no travel needed (🛒 links above). Cheaper-but-tedious: candies (25–250 happy) cost far less per-happy than eDVDs. Prices are market-value estimates — check live before buying.</div>';
    };
    const recompute = function () {
      let flat = 0;
      bx.querySelectorAll(".hqty").forEach(function (inp) {
        const per = +inp.getAttribute("data-per"), q = Math.max(0, parseInt(inp.value, 10) || 0);
        const sub = inp.parentNode.querySelector("[data-sub]"); if (sub) sub.textContent = q ? "= +" + (per * q).toLocaleString() : "";
        flat += per * q;
      });
      const ecs = bx.querySelector("#tdk-hecs").checked;
      const final = calcHappy(start, flat, ecs);
      bx.querySelector("#tdk-hresult").innerHTML = 'Max happy: <b>' + final.toLocaleString() + '</b>' + (final >= HAPPY_CAP ? ' <span class="hv">(cap)</span>' : '') +
        ' <span class="hv">= ' + start.toLocaleString() + ' + ' + flat.toLocaleString() + ' flat' + (ecs ? ', ×2' : '') + '</span>';
      const seq = bx.querySelector("#tdk-hseq");
      if (!flat && !ecs) seq.textContent = "";
      else if (!ecs) seq.innerHTML = 'Eat all boosters (+' + flat.toLocaleString() + ') → <b>' + final.toLocaleString() + '</b>';
      else {
        const beforeFlat = Math.min(flat, Math.max(0, Math.floor(HAPPY_CAP / 2) - start));
        if (beforeFlat >= flat) seq.innerHTML = 'Eat all boosters (+' + flat.toLocaleString() + ' → ' + (start + flat).toLocaleString() + '), then <b>Ecstasy ×2</b> → <b>' + final.toLocaleString() + '</b>';
        else seq.innerHTML = 'Eat +' + beforeFlat.toLocaleString() + ' → ' + (start + beforeFlat).toLocaleString() + ', <b>Ecstasy ×2</b> → ' + Math.min(HAPPY_CAP, (start + beforeFlat) * 2).toLocaleString() + ', then remaining +' + (flat - beforeFlat).toLocaleString() + ' → <b>' + final.toLocaleString() + '</b>';
      }
      lastHappy = final; updateGymEst(); renderCost();
    };
    bx.querySelectorAll(".hqty, #tdk-hecs").forEach(function (el) { el.addEventListener("input", recompute); el.addEventListener("change", recompute); });
    const tgtEl = bx.querySelector("#tdk-hen-target"); if (tgtEl) tgtEl.addEventListener("input", renderCost);
    // Persistent, tick-as-you-go checklist (a jump spans hours of energy banking, so it survives reopening)
    const ckGet = function () { try { return GM_getValue("happy_checklist", {}) || {}; } catch (e) { return {}; } };
    (function () { const cks = ckGet(); bx.querySelectorAll("#tdk-hchecklist input[data-step]").forEach(function (cb) {
      cb.checked = !!cks[cb.getAttribute("data-step")]; cb.closest("li").classList.toggle("done", cb.checked);
      cb.addEventListener("change", function () { const s = ckGet(); s[cb.getAttribute("data-step")] = cb.checked; try { GM_setValue("happy_checklist", s); } catch (e) { } cb.closest("li").classList.toggle("done", cb.checked); });
    }); })();
    const ckr = bx.querySelector("#tdk-hck-reset"); if (ckr) ckr.addEventListener("click", function (e) { e.preventDefault(); try { GM_setValue("happy_checklist", {}); } catch (e2) { } bx.querySelectorAll("#tdk-hchecklist input[data-step]").forEach(function (cb) { cb.checked = false; cb.closest("li").classList.remove("done"); }); });
    const updateReset = function () {
      const el = host.querySelector("#tdk-hreset"); if (!el) return;
      const now = new Date(), m = now.getUTCMinutes(), s = now.getUTCSeconds();
      const secs = 15 * 60 - ((m % 15) * 60 + s), nextQ = ((Math.floor(m / 15) + 1) * 15) % 60;
      const mm = Math.floor(secs / 60), ss = secs % 60;
      el.innerHTML = '⏰ Happy resets in <b>' + mm + ':' + (ss < 10 ? '0' : '') + ss + '</b> (at :' + (nextQ < 10 ? '0' + nextQ : nextQ) + ' TCT)';
      el.className = 'hreset' + (secs <= 120 ? ' soon' : '');
    };
    updateReset(); recompute();
    if (state._happyTimer) clearInterval(state._happyTimer);
    state._happyTimer = setInterval(function () {
      if (!host.querySelector("#tdk-hreset") || !bx.classList.contains("open")) { clearInterval(state._happyTimer); state._happyTimer = null; return; }
      updateReset();
    }, 1000);
  }

  function updateTravelEff() {
    const el = host && host.querySelector("#tdk-set-teff"); if (!el) return;
    const pct = Math.round((1 - travelMult()) * 100);
    const ex = FLY.uae ? " · e.g. UAE " + fmtRt(FLY.uae.rt) + " → " + fmtRt(rtOf("uae")) : "";
    el.innerHTML = pct > 0 ? "Effective flight time: <b>−" + pct + "%</b> vs Standard" + ex + " · ±3% Torn variance" : "Standard flight times" + ex;
  }
  function applyTravelChange(manual) {
    GM_setValue("travelMethod", state.travelMethod); GM_setValue("travelBook", state.travelBook);
    if (manual) GM_setValue("travel_manual", true);
    if (state.rows && state.rows.length) recomputePpm();
    const sel = host && host.querySelector("#tdk-set-tmethod"); if (sel) sel.value = state.travelMethod;
    updateTravelEff(); render();
  }
  function probeTravelProp() {
    const key = GM_getValue("torn_key", "");
    if (!key) return Promise.resolve({ ok: false, reason: "no Torn key" });
    return Promise.all([
      gmGet("https://api.torn.com/user/?selections=profile&key=" + encodeURIComponent(key)).catch(function () { return null; }),
      gmGet("https://api.torn.com/user/?selections=properties&key=" + encodeURIComponent(key)).catch(function () { return null; })
    ]).then(function (res) {
      const prof = res[0], pj = res[1];
      if (!pj || pj.error) return { ok: false, reason: (pj && pj.error && pj.error.error) || "no property data" };
      const props = pj.properties || {};
      const myId = prof && !prof.error ? prof.player_id : null;
      const residenceId = prof && !prof.error ? prof.property_id : null;
      const hasPerk = function (p) { return !!(p && p.modifications && p.staff && +p.modifications.airstrip > 0 && +p.staff.pilot > 0); };
      let cur = residenceId != null ? props[String(residenceId)] : null, via = "residence";
      if (!hasPerk(cur)) {
        const rental = Object.keys(props).map(function (k) { return props[k]; })
          .find(function (p) { return p && p.rented && myId != null && p.rented.user_id === myId && hasPerk(p); });
        if (rental) { cur = rental; via = "rented"; }
      }
      return {
        ok: true, perk: hasPerk(cur), name: cur ? (cur.property || "your property") : null, via: via,
        air: !!(cur && cur.modifications && +cur.modifications.airstrip > 0),
        pilot: !!(cur && cur.staff && +cur.staff.pilot > 0)
      };
    }).catch(function (e) { return { ok: false, reason: (e.message || e) }; });
  }
  function detectTravelProp() {
    const el = host.querySelector("#tdk-set-tdetect"); if (!el) return;
    if (!GM_getValue("torn_key", "")) { el.innerHTML = "Add a Torn key above to auto-detect your Private Island / Airstrip / Pilot."; return; }
    el.textContent = "🔍 Checking your property…";
    probeTravelProp().then(function (r) {
      if (!r.ok) { el.innerHTML = '<span class="serr">Couldn’t read properties: ' + r.reason + '</span> — pick your method manually above.'; return; }
      GM_setValue("travel_detect_done", true);
      if (r.perk) {
        if (!GM_getValue("travel_manual", false) && state.travelMethod !== "air") { state.travelMethod = "air"; applyTravelChange(false); }
        const applied = state.travelMethod === "air";
        el.innerHTML = "Detected: <b>" + r.name + "</b>" + (r.via === "rented" ? " (rented)" : "") + " · Airstrip ✓ · Pilot ✓ → Airstrip <b>−30%</b>. " +
          (applied ? "<b>Active ✓</b>" : '<a href="#" id="tdk-tapply" class="prof">Use it</a>');
        const ap = host.querySelector("#tdk-tapply");
        if (ap) ap.addEventListener("click", function (e) { e.preventDefault(); state.travelMethod = "air"; applyTravelChange(true); detectTravelProp(); });
      } else {
        el.innerHTML = "Current property: <b>" + (r.name || "unknown") + "</b> — " + (r.air && !r.pilot ? "Airstrip but no Pilot (both needed for −30%)" : "no active Airstrip") + ". Standard flight time; pick a method manually if that’s wrong.";
      }
    });
  }
  function autoDetectTravelOnce() {
    if (GM_getValue("travel_manual", false) || GM_getValue("travel_detect_done", false)) return;
    if (!GM_getValue("torn_key", "")) return;
    probeTravelProp().then(function (r) {
      if (!r.ok) return;
      GM_setValue("travel_detect_done", true);
      if (r.perk && state.travelMethod !== "air") { state.travelMethod = "air"; GM_setValue("travelMethod", "air"); if (state.rows && state.rows.length) recomputePpm(); render(); }
    });
  }
  function openSettings() {
    const bx = host.querySelector("#tdk-buyers");
    bx.classList.add("open");
    const esc = function (s) { return String(s || "").replace(/"/g, "&quot;"); };
    bx.innerHTML =
      '<div class="tdk-bh"><div class="tt">Settings</div><button class="tdk-bx" id="tdk-bclose">×</button></div>' +
      '<div class="tdk-set">' +
        '<div class="sl">Torn API key <small>— board · cash · inventory · online status</small></div>' +
        '<div class="srow"><input id="tdk-set-torn" type="text" spellcheck="false" placeholder="Torn API key" value="' + esc(GM_getValue("torn_key", "")) + '"><button class="tdk-btn2" id="tdk-set-test">Test</button></div>' +
        '<div class="sl">weav3r (W3B) key <small>— trader buy prices</small></div>' +
        '<div class="srow"><input id="tdk-set-w3b" type="text" spellcheck="false" placeholder="W3B key" value="' + esc(GM_getValue("w3b_key", "")) + '"><button class="tdk-btn2" id="tdk-set-w3btest">Test</button></div>' +
        '<div class="sl" style="margin-top:16px">💵 Resale price basis ($/min) <small>— how the board prices your haul</small></div>' +
        '<div class="srow"><select id="tdk-set-pbasis">' +
          '<option value="mkt"' + (state.priceBasis === "mkt" ? ' selected' : '') + '>Market Value (Bazaar / Item Market average)</option>' +
          '<option value="trader"' + (state.priceBasis === "trader" ? ' selected' : '') + '>Top Trader Offer (Instant trade via W3B)</option>' +
        '</select></div>' +
        '<div class="srow"><button class="tdk-btn2" id="tdk-set-save">Save keys &amp; options</button><span id="tdk-set-msg" class="ssub"></span></div>' +
        '<div id="tdk-set-out" class="ssub"></div>' +
        '<div class="sl" style="margin-top:16px">✈ Travel method <small>— sets your real flight time so $/min, the ≤time filter &amp; the OC guard match your setup</small></div>' +
        '<div class="srow"><select id="tdk-set-tmethod">' +
          Object.keys(TRAVEL_METHODS).map(function (k) { return '<option value="' + k + '"' + (state.travelMethod === k ? ' selected' : '') + '>' + TRAVEL_METHODS[k].label + '</option>'; }).join("") +
        '</select></div>' +
        '<div class="srow"><label class="scheck"><input type="checkbox" id="tdk-set-tbook"' + (state.travelBook ? ' checked' : '') + '> Book “Mailing Yourself Abroad” active <small>(−25% for 31 days, stacks)</small></label></div>' +
        '<div id="tdk-set-teff" class="ssub"></div>' +
        '<div id="tdk-set-tdetect" class="ssub"></div>' +
        '<div class="sl" style="margin-top:14px">Need a key? <a class="prof" href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener">Torn → Settings → API Keys</a>. Note: the 📦 Bag needs Torn’s inventory API, which is temporarily disabled during Torn’s inventory migration — no key fixes that until Torn restores it.</div>' +
      '</div>';
    bindClose(bx);
    host.querySelector("#tdk-set-save").addEventListener("click", function () {
      GM_setValue("torn_key", host.querySelector("#tdk-set-torn").value.trim());
      GM_setValue("w3b_key", host.querySelector("#tdk-set-w3b").value.trim());
      state.priceBasis = host.querySelector("#tdk-set-pbasis").value;
      GM_setValue("priceBasis", state.priceBasis);
      state.inv = null; state.resale = null; state.itemMeta = null; state.cash = null; state.stocks = null;
      host.querySelector("#tdk-set-msg").textContent = " Saved ✓ — caches cleared, hit Refresh";
      refresh();
    });
    const mSel = host.querySelector("#tdk-set-tmethod");
    if (mSel) mSel.addEventListener("change", function () { state.travelMethod = this.value; applyTravelChange(true); });
    const bChk = host.querySelector("#tdk-set-tbook");
    if (bChk) bChk.addEventListener("change", function () { state.travelBook = this.checked; applyTravelChange(true); });
    updateTravelEff();
    detectTravelProp();
    host.querySelector("#tdk-set-test").addEventListener("click", function () {
      const k = host.querySelector("#tdk-set-torn").value.trim(), out = host.querySelector("#tdk-set-out");
      if (!k) { out.textContent = "Enter a Torn key first."; return; }
      out.textContent = "Testing…";
      gmGet("https://api.torn.com/key/?selections=info&key=" + encodeURIComponent(k)).then(function (j) {
        if (j.error) { out.innerHTML = '<span class="serr">Key error: ' + j.error.error + '</span>'; return null; }
        const lvl = (j.access_type || "?") + " (level " + (j.access_level != null ? j.access_level : "?") + ")";
        return gmGet("https://api.torn.com/user/?selections=inventory&key=" + encodeURIComponent(k)).then(function (inv) {
          let msg;
          if (inv.error) msg = '<span class="serr">📦 inventory blocked: ' + inv.error.error + '</span>';
          else { const raw = inv.inventory; const arr = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []); msg = '📦 inventory: <b>' + arr.length + '</b> readable' + (arr.length ? '' : ' — <b>Torn’s inventory API is returning empty for everyone right now</b> (Torn is mid-migration on their inventory system, 2026). This is NOT your key — the 📦 Bag will start working once Torn restores the endpoint.'); }
          out.innerHTML = '✓ Access: <b>' + lvl + '</b><br>' + msg;
        });
      }).catch(function (e) { out.innerHTML = '<span class="serr">Test failed: ' + e.message + '</span>'; });
    });
    host.querySelector("#tdk-set-w3btest").addEventListener("click", function () {
      const k = host.querySelector("#tdk-set-w3b").value.trim(), out = host.querySelector("#tdk-set-out");
      if (!k) { out.textContent = "Enter a W3B key first."; return; }
      out.textContent = "Testing W3B…";
      gmGet("https://weav3r.dev/api/marketplace/206/traders?apiKey=" + encodeURIComponent(k)).then(function (j) {
        if (j && j.error) { out.innerHTML = '<span class="serr">W3B error: ' + j.error + '</span>'; return; }
        const n = j && (j.total_count != null ? j.total_count : (j.traders ? j.traders.length : null));
        out.innerHTML = '✓ W3B key works — weav3r reachable' + (n != null ? ' (Xanax: <b>' + n + '</b> traders listed)' : '');
      }).catch(function (e) { out.innerHTML = '<span class="serr">W3B test failed: ' + e.message + ' — check the key</span>'; });
    });
  }

  function importRestockData(text) {
    let p; try { p = JSON.parse(text); } catch (e) { return { err: "That isn’t valid JSON — copy the whole ⬇ Export blob." }; }
    if (!p || p.kind !== "tdk-restock-export") return { err: "Not a Trade Desk export (missing kind)." };
    const inEv = p.events || {}, inSea = p.seasonal || {};
    let imports; try { imports = GM_getValue("tdk_imports", []) || []; } catch (e) { imports = []; }
    const sig = (function (s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h + ":" + s.length; })(text);
    const dup = imports.indexOf(sig) >= 0;
    let ev; try { ev = GM_getValue("stock_events", null) || {}; } catch (e) { ev = {}; }
    let evItems = 0;
    Object.keys(inEv).forEach(function (k) {
      const src = inEv[k], dst = ev[k] || (ev[k] = { rs: [], so: [], up: [], q: null, max: 0 });
      const merge = function (dArr, sArr, keyFn) { const seen = {}; (dArr || []).forEach(function (e) { seen[keyFn(e)] = 1; }); (sArr || []).forEach(function (e) { if (!seen[keyFn(e)]) { dArr.push(e); seen[keyFn(e)] = 1; } }); };
      merge(dst.rs, src.rs, function (e) { return e[0]; }); merge(dst.so, src.so, function (t) { return t; });
      if (src.up) { dst.up = dst.up || []; merge(dst.up, src.up, function (e) { return e[0]; }); }
      dst.rs.sort(function (a, b) { return a[0] - b[0]; }); dst.so.sort(function (a, b) { return a - b; }); if (dst.up) dst.up.sort(function (a, b) { return a[0] - b[0]; });
      dst.max = Math.max(dst.max || 0, src.max || 0); if (dst.q == null) dst.q = src.q; evItems++;
    });
    let sea; try { sea = GM_getValue("stock_seasonal", null) || {}; } catch (e) { sea = {}; }
    const seaEmpty = Object.keys(sea).length === 0; let seaBuckets = 0, seaMode;
    if (seaEmpty) { seaMode = "loaded"; Object.keys(inSea).forEach(function (k) { sea[k] = {}; Object.keys(inSea[k]).forEach(function (b) { sea[k][b] = inSea[k][b].slice(); seaBuckets++; }); }); }
    else if (dup) { seaMode = "skipped (already imported)"; }
    else { seaMode = "merged"; Object.keys(inSea).forEach(function (k) { const dk = sea[k] || (sea[k] = {}); Object.keys(inSea[k]).forEach(function (b) { const s = inSea[k][b], d = dk[b] || (dk[b] = [0, 0, 0]); d[0] += s[0] || 0; d[1] += s[1] || 0; d[2] += s[2] || 0; seaBuckets++; }); }); }
    try { GM_setValue("stock_events", ev); GM_setValue("stock_seasonal", sea); } catch (e) { }
    if (!dup) { imports.push(sig); if (imports.length > 50) imports.shift(); try { GM_setValue("tdk_imports", imports); } catch (e) { } }
    state._ev = ev; state._seasonal = sea;
    return { evItems: evItems, seaBuckets: seaBuckets, seaMode: seaMode };
  }
  function openChangelog() {
    const bx = host.querySelector("#tdk-buyers");
    const ovCount = Object.keys(state.ov).length;
    const blog = (function () { try { return GM_getValue("build_log", []) || []; } catch (e) { return []; } })();
    const fresh = blog.filter(function (x) { return x.type !== "seen" && !x.lg; });
    const legacy = blog.filter(function (x) { return x.type !== "seen" && x.lg; });
    const catN = blog.filter(function (x) { return x.type === "seen"; }).length;
    const cnt = function (x) { return x.n > 1 ? ' <span class="muted">×' + x.n + '</span>' : ''; };
    const sh = function (x) { return x.h ? ' <code class="muted">' + String(x.h).slice(0, 7) + '</code>' : ''; };
    const bwOpen = (function () { try { return GM_getValue("bw_open", false); } catch (e) { return false; } })();
    const bsec = '<details class="tdk-clog bwd"' + (bwOpen ? ' open' : '') + '><summary class="cv">🔬 Torn build watcher <span>· ' + (fresh.length ? fresh.length + ' new/changed · fresh code to poke (disclose, don’t exploit)' : 'watching — no fresh releases yet') + '</span></summary><ul class="bwlog">' +
      (fresh.length ? fresh.slice(0, 25).map(function (x) { return '<li>' + (x.type === "new" ? '🆕 <b>NEW module</b> ' : '♻ <b>updated</b> ') + '<code>' + x.k + '</code>' + sh(x) + cnt(x) + ' · ' + new Date(x.t).toLocaleString() + '</li>'; }).join("")
        : '<li>Nothing yet — a <b>NEW</b> module or a genuinely fresh bundle hash will show here as you browse. Best bug-bounty odds. Read-only.</li>') +
      (legacy.length ? '<li class="muted">…plus ' + legacy.length + ' legacy <code>-old</code> bundle update' + (legacy.length === 1 ? '' : 's') + ' (e.g. header-old — Torn phasing these out, low value; not badged).</li>' : '') +
      (catN ? '<li class="muted">…plus ' + catN + ' existing module' + (catN === 1 ? '' : 's') + ' cataloged while learning what exists (not alerts).</li>' : '') + '</ul></details>';
    bx.classList.add("open");
    bx.innerHTML = '<div class="tdk-bh"><div class="tt">Changelog<small> — Torn Trade Desk</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>' +
      '<div class="tdk-upbar"><button class="tdk-btn2" id="tdk-updbtn" title="Check GitHub for a newer version">🔄 Check for updates</button><span class="tdk-upd" id="tdk-upd">v' + curVersion() + '</span></div>' +
      '<div class="tdk-upbar tdk-upbar2"><button class="tdk-btn2" id="tdk-exp-restock" title="Copy your recorded restock/stock + seasonal data to the clipboard — paste it to Claude to analyze, or save it as a backup">⬇ Export</button><button class="tdk-btn2" id="tdk-imp-restock" title="Paste a previously exported blob to restore your data after a Tampermonkey/cache wipe — or seed a fresh install from someone else’s export">⬆ Import</button><span class="tdk-upd" id="tdk-exp-msg"></span></div>' +
      '<div class="tdk-impbox" id="tdk-impbox" style="display:none"><textarea id="tdk-imp-ta" spellcheck="false" placeholder="Paste the exported JSON here, then Load…"></textarea><button class="tdk-btn2" id="tdk-imp-go">Load</button></div>' +
      (ovCount ? '<div class="tdk-upbar tdk-upbar2"><button class="tdk-btn2" id="tdk-ovreset" title="Clear every keep/sell-ok override you\'ve set">↺ Reset ' + ovCount + ' override' + (ovCount > 1 ? 's' : '') + '</button></div>' : '') +
      bsec +
      CHANGELOG.map(function (e) {
        return '<div class="tdk-clog"><div class="cv">v' + e.v + ' <span>· ' + e.d + '</span></div><ul>' + e.c.map(function (x) { return '<li>' + x + '</li>'; }).join("") + '</ul></div>';
      }).join("");
    const ub = bx.querySelector("#tdk-updbtn"); if (ub) ub.addEventListener("click", checkUpdate);
    const rb = bx.querySelector("#tdk-ovreset");
    if (rb) rb.addEventListener("click", function () {
      state.ov = {}; GM_setValue("ov", state.ov);
      if (state.view === "inv") paintInv();
      if (ITEM_PAGE.test(location.pathname)) { document.querySelectorAll("li[data-item][data-tdk]").forEach(repaintRow); }
      openChangelog();
    });
    const xb = bx.querySelector("#tdk-exp-restock");
    if (xb) xb.addEventListener("click", function () {
      let evd = {}; try { evd = GM_getValue("stock_events", null) || {}; } catch (e) { }
      let sead = {}; try { sead = GM_getValue("stock_seasonal", null) || {}; } catch (e) { }
      const meta = state.itemMeta || {}, names = {};
      Object.keys(evd).forEach(function (k) { const id = k.split(":")[1]; if (meta[id] && meta[id].name) names[id] = meta[id].name; });
      Object.keys(sead).forEach(function (k) { const id = k.split(":")[1]; if (meta[id] && meta[id].name) names[id] = meta[id].name; });
      let buckets = 0; Object.keys(sead).forEach(function (k) { buckets += Object.keys(sead[k]).length; });
      const payload = { kind: "tdk-restock-export", version: curVersion(), at: Math.floor(Date.now() / 1000), fields: "events[cc:id]={rs:[[t,amount]] restocks, so:[t] sellouts, up:[[t,dq,prevQ]] RAW increases, max, q}; seasonal[cc:id]={bucket→[soldQty,seconds,samples]}, bucket = UTC(dayOfWeek 0=Sun..6)*24 + hourOfDay(0..23)", names: names, events: evd, seasonal: sead };
      copyText(JSON.stringify(payload));
      const m = bx.querySelector("#tdk-exp-msg"); if (m) m.textContent = "Copied " + Object.keys(evd).length + " items · " + buckets + " seasonal buckets — paste to Claude or save as backup";
    });
    const ib = bx.querySelector("#tdk-imp-restock");
    if (ib) ib.addEventListener("click", function () { const box = bx.querySelector("#tdk-impbox"); if (box) { box.style.display = box.style.display === "none" ? "block" : "none"; const ta = bx.querySelector("#tdk-imp-ta"); if (ta && box.style.display !== "none") ta.focus(); } });
    const ig = bx.querySelector("#tdk-imp-go");
    if (ig) ig.addEventListener("click", function () {
      const ta = bx.querySelector("#tdk-imp-ta"), m = bx.querySelector("#tdk-exp-msg");
      const res = importRestockData((ta && ta.value || "").trim());
      if (res.err) { if (m) m.innerHTML = '<span style="color:#e5615c">' + res.err + '</span>'; return; }
      if (m) m.textContent = "Imported ✓ " + res.evItems + " items · " + res.seaBuckets + " buckets (" + res.seaMode + ")";
      if (ta) ta.value = "";
    });
    try { GM_setValue("build_seen_at", Date.now()); } catch (e) { } updateBuildBadge();
    const bwd = bx.querySelector("details.bwd"); if (bwd) bwd.addEventListener("toggle", function () { try { GM_setValue("bw_open", bwd.open); } catch (e) { } }); // remember collapsed/expanded
    bindClose(bx);
  }

  function openPackOdds(name) {
    const m = PACK_MODELS[name]; if (!m) return;
    const bx = host.querySelector("#tdk-buyers"); bx.classList.add("open");
    const names = (m.kind === "draws" ? m.pool.slice() : m.outcomes.map(function (o) { return o[1]; }));
    const uniq = []; names.forEach(function (n) { if (uniq.indexOf(n) < 0) uniq.push(n); });
    const pd = getPackData()[name] || {}, man = pd.manual || { opens: 0, items: {} }, prices = state.resale || {};
    const rowFor = function (nm) {
      const id = nameToId(nm), cur = id != null ? (man.items[id] || 0) : 0, pr = id != null ? (prices[id] || 0) : 0;
      return '<div class="hrow"><label>' + nm + ' <span class="hv">' + (id == null ? '⚠ not in catalog' : pr ? money(pr) + '/ea' : '—') + '</span></label>' +
        '<input class="hqty tdk-pdq" data-name="' + escAttr(nm) + '" type="number" min="0" value="' + cur + '"><span class="hv">recv</span></div>';
    };
    bx.innerHTML =
      '<div class="tdk-bh"><div class="tt">Pack odds · ' + name + '<small> — your real drops</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>' +
      '<div class="tdk-happy">' +
        '<div class="ssub">Enter how many you\'ve <b>opened</b> and the <b>total quantity received</b> of each item (read them off <a class="tdk-sett-link" href="https://torn.report/pack" target="_blank" rel="noopener">torn.report</a>). EV = your odds × live prices, so it never goes stale.</div>' +
        '<div class="hrow"><label>Packs opened <span class="hv">(manual)</span></label><input class="hqty" id="tdk-pd-opens" type="number" min="0" value="' + (man.opens || 0) + '"><span class="hv"></span></div>' +
        uniq.map(rowFor).join('') +
        '<div class="hresult" id="tdk-pd-ev"></div>' +
        (pd.log && pd.log.length ? '<div class="ssub">Plus <b>' + pd.log.length + '</b> opens synced from your Torn log.</div>' : '') +
        '<div class="srow" style="margin-top:8px;flex-wrap:wrap;gap:6px"><button class="tdk-btn2" id="tdk-pd-save">Save odds</button><button class="tdk-btn2" id="tdk-pd-sync" title="Pull your real supply-pack opens from the Torn API log (beta)">⟳ Sync from Torn log</button><button class="tdk-btn2" id="tdk-pd-clear" title="Clear all saved data for this pack">Clear</button></div>' +
        '<div id="tdk-pd-msg" class="ssub"></div>' +
      '</div>';
    bindClose(bx);
    const evEl = bx.querySelector("#tdk-pd-ev");
    const recompute = function () {
      const opens = Math.max(0, parseInt(bx.querySelector("#tdk-pd-opens").value, 10) || 0);
      const items = {}; let tot = 0;
      bx.querySelectorAll(".tdk-pdq").forEach(function (inp) {
        const id = nameToId(inp.getAttribute("data-name")), q = Math.max(0, parseInt(inp.value, 10) || 0);
        if (id != null && q) { items[id] = (items[id] || 0) + q; tot += (prices[id] || 0) * q; }
      });
      evEl.innerHTML = opens > 0 ? 'EV/open: <b>' + money(tot / opens) + '</b> <span class="hv">over ' + opens + ' opens</span>' : '<span class="hv">enter opens to see EV</span>';
      return { opens: opens, items: items };
    };
    bx.querySelectorAll("#tdk-pd-opens, .tdk-pdq").forEach(function (el) { el.addEventListener("input", recompute); });
    recompute();
    bx.querySelector("#tdk-pd-save").addEventListener("click", function () {
      const r = recompute(), d = getPackData(); d[name] = d[name] || {}; d[name].manual = { opens: r.opens, items: r.items }; setPackData(d);
      bx.querySelector("#tdk-pd-msg").textContent = "Saved ✓ — verdict updates in the Bag."; if (state.view === "inv") paintInv();
    });
    bx.querySelector("#tdk-pd-clear").addEventListener("click", function () {
      const d = getPackData(); delete d[name]; setPackData(d); if (state.view === "inv") paintInv(); openPackOdds(name);
    });
    bx.querySelector("#tdk-pd-sync").addEventListener("click", function () { syncPackLog(name, bx.querySelector("#tdk-pd-msg")); });
  }

  async function syncPackLog(name, msgEl) {
    const key = tornKey(); if (!key) { if (msgEl) msgEl.textContent = "Need a Torn API key (⚙ Settings)."; return; }
    const set = function (h) { if (msgEl) msgEl.innerHTML = h; };
    set("Syncing from your Torn log…");
    try {
      const lt = await gmGet("https://api.torn.com/torn/?selections=logtypes&key=" + encodeURIComponent(key));
      const types = lt.logtypes || lt || {};
      const ids = Object.keys(types).filter(function (id) { return /supply pack/i.test(String(types[id])); });
      const pool = {}, m = PACK_MODELS[name];
      (m.kind === "draws" ? m.pool : m.outcomes.map(function (o) { return o[1]; })).forEach(function (n) { const i = nameToId(n); if (i != null) pool[i] = 1; });
      if (!ids.length) { console.log("[TDK] torn/logtypes =", types); set('No "supply pack" log type found — dumped all log types to the console (F12). Paste them to Claude to finish wiring this.'); return; }
      const d = getPackData(); d[name] = d[name] || {}; const existing = d[name].log = d[name].log || [];
      const seen = {}; existing.forEach(function (r) { seen[r.key] = 1; });
      let added = 0; const samples = [];
      for (let i = 0; i < ids.length; i++) {
        const res = await gmGet("https://api.torn.com/user/?selections=log&log=" + encodeURIComponent(ids[i]) + "&key=" + encodeURIComponent(key));
        const log = res.log || {};
        Object.keys(log).forEach(function (k) {
          const e = log[k]; if (samples.length < 2) samples.push(e);
          const dat = e.data || {};
          const hay = String(e.title || "") + " " + JSON.stringify(dat);
          if (hay.toLowerCase().indexOf(name.toLowerCase()) < 0) return;
          const items = {};
          const eat = function (arr) { arr.forEach(function (it) { const id = +(it.id || it.ID || it.item || 0), q = +(it.qty || it.quantity || it.amount || 1); if (id && pool[id]) items[id] = (items[id] || 0) + (q || 1); }); };
          if (Array.isArray(dat.items)) eat(dat.items);
          if (Array.isArray(dat.received)) eat(dat.received);
          if (Array.isArray(dat.reward)) eat(dat.reward);
          if (Object.keys(items).length && !seen[k]) { existing.push({ key: k, ts: e.timestamp || 0, items: items }); seen[k] = 1; added++; }
        });
      }
      setPackData(d);
      if (added) { set('Synced <b>' + added + '</b> opens from your Torn log ✓'); if (state.view === "inv") paintInv(); openPackOdds(name); }
      else { console.log("[TDK] sample supply-pack log entries =", samples); set('Found the log type but couldn\'t auto-parse received items — dumped 2 sample entries to the console (F12). Paste them to Claude to finalize the parser.'); }
    } catch (e) { set("Sync failed: " + (e.message || e)); }
  }

  function build() {
    host = document.createElement("div");
    document.body.appendChild(host);
    if (typeof GM_addStyle === "function") { GM_addStyle(css()); }
    else { const style = document.createElement("style"); style.textContent = css(); (document.head || document.documentElement).appendChild(style); }

    const btn = document.createElement("button"); btn.id = "tdk-btn"; btn.textContent = "💰"; btn.title = "Torn Trade Desk";
    host.appendChild(btn);

    panel = document.createElement("div"); panel.id = "tdk-panel";
    panel.innerHTML =
      '<button class="tdk-btn2 tdk-x" id="tdk-close" title="Close panel">✕</button>' +
      '<aside class="tdk-rail">' +
        '<button class="tdk-btn2" id="tdk-invbtn" title="Bag — your sellable-junk inventory"><i>📦</i><span>Bag</span></button>' +
        '<button class="tdk-btn2" id="tdk-fund" title="Travel board — best $/min plays for your flight time, plus over-budget plays with how to fund them from stocks"><i>✈</i><span>Travel</span></button>' +
        '<button class="tdk-btn2" id="tdk-happy" title="Happy-jump calculator — max happy, best order &amp; reset timer"><i>😊</i><span>Happy</span></button>' +
        '<button class="tdk-btn2" id="tdk-flip" title="Quick flips — buy cheap, sell to the highest live trader"><i>💱</i><span>Flip</span></button>' +
        '<button class="tdk-btn2" id="tdk-shop" title="Shop flips — Torn city-shop items worth more on the market"><i>🏪</i><span>Shop</span></button>' +
        '<button class="tdk-btn2" id="tdk-stk" title="Stocks — your P&amp;L, benefit-block progress, buy-low scanner"><i>📊</i><span>Stocks</span></button>' +
        '<button class="tdk-btn2" id="tdk-bounty" title="Bounty planner — collectible bounties, lowest-level first"><i>🎯</i><span>Bounty</span></button>' +
        '<span class="tdk-railsp"></span>' +
        '<button class="tdk-btn2" id="tdk-refresh" title="Refresh live data"><i>↻</i><span>Refresh</span></button>' +
        '<button class="tdk-btn2" id="tdk-settings" title="Settings — API keys &amp; options"><i>⚙</i><span>Settings</span></button>' +
      '</aside>' +
      '<div class="tdk-col">' +
        '<div class="tdk-topbar">' +
          '<div class="t">Trade Desk<small>$/min · <span class="tdk-ver" id="tdk-ver" title="View changelog">v' + (typeof GM_info !== "undefined" && GM_info.script ? GM_info.script.version : "") + '</span></small></div><div class="sp"></div>' +
          '<span class="capw">Cap <input class="tdk-cap" id="tdk-cap" type="number" min="1" max="60" value="' + state.cap + '"></span>' +
          '<button class="tdk-btn2 tdk-sm" id="tdk-adec" title="Smaller text">A−</button>' +
          '<button class="tdk-btn2 tdk-sm" id="tdk-ainc" title="Bigger text">A+</button>' +
        '</div>' +
        '<div class="tdk-status" id="tdk-status">Click Refresh to pull live data.</div>' +
        '<div id="tdk-board">' +
          '<div class="tdk-imm" id="tdk-immunity" style="display:none"></div>' +
          '<div class="tdk-homebar" id="tdk-homebar" style="display:none"></div>' +
          '<div class="tdk-oc" id="tdk-oc" style="display:none"></div>' +
          '<div class="tdk-filter" id="tdk-filter"></div>' +
          '<div class="tdk-best" id="tdk-best"><div class="l">Best play</div><div class="p">—</div></div>' +
          '<div class="tdk-vsw" id="tdk-vsw">' +
            '<button data-view="table" title="Table view">▤</button>' +
            '<button data-view="cards" title="Card view">▭</button>' +
            '<button data-view="bars" title="Leaderboard view">▬</button>' +
            '<button data-view="dep" title="Departures board">✈</button>' +
          '</div>' +
          '<table class="tdk"><thead><tr><th class="l">Item <span class="thsub">buy → resale · load</span></th><th id="tdk-th-full" class="so" data-sort="fullprofit" title="Total profit for a full load (profit/ea × cap), before airfare. Set Cap to 1 to see per-item profit.">Profit ×' + state.cap + '</th><th class="so" data-sort="stock">Stock</th><th class="so ld" data-sort="landing" title="Predicted stock when you touch down if you flew there from Torn right now. Sort groups what will be in stock on arrival first, then by $/min.">Landing</th><th class="so" data-sort="ppm">$/min</th></tr></thead><tbody id="tdk-body"></tbody></table>' +
          '<div id="tdk-lens" style="display:none"></div>' +
          '<div class="tdk-mug" id="tdk-mug"></div>' +
        '</div>' +
        '<div id="tdk-inv" style="display:none"></div>' +
      '</div>';
    host.appendChild(panel);
    const buyers = document.createElement("div"); buyers.id = "tdk-buyers"; host.appendChild(buyers);

    btn.addEventListener("click", function () { panel.classList.toggle("open"); if (panel.classList.contains("open")) { if (!state.rows.length) refresh(); checkInvStatus(); } });
    host.querySelector("#tdk-close").addEventListener("click", function () { panel.classList.remove("open"); });
    host.querySelector("#tdk-settings").addEventListener("click", openSettings);
    host.querySelector("#tdk-happy").addEventListener("click", openHappy);
    host.querySelector("#tdk-flip").addEventListener("click", openFlip);
    host.querySelector("#tdk-shop").addEventListener("click", openShopFlips);
    host.querySelector("#tdk-stk").addEventListener("click", openStocks);
    host.querySelector("#tdk-bounty").addEventListener("click", openBounty);
    host.querySelector("#tdk-refresh").addEventListener("click", function () { if (state.view === "inv") { state.inv = null; renderInv(); } else refresh(); });
    host.querySelector("#tdk-cap").addEventListener("change", function (e) {
      state.cap = Math.max(1, parseInt(e.target.value, 10) || 23); GM_setValue("cap", state.cap);
      if (state.rows.length) { recomputePpm(); render(); }
    });
    host.querySelector("#tdk-filter").addEventListener("click", function (e) {
      const c = e.target.closest(".tdk-fc"); if (!c) return;
      state.filter = c.dataset.cc; render();
    });
    host.querySelector("#tdk-filter").addEventListener("change", function (e) {
      if (e.target.id !== "tdk-tsel") return;
      state.maxTrip = +e.target.value; GM_setValue("maxTrip", state.maxTrip); render();
    });
    host.querySelector("#tdk-fund").addEventListener("click", function () {
      if (state.view === "inv") { state.fund = true; setView("board"); }
      else { state.fund = !state.fund; render(); }
      GM_setValue("fund", state.fund);
    });
    host.querySelector("#tdk-board").addEventListener("click", function (e) {
      if (e.target.closest("a, button, th")) return; // clicking any row/card/bar/departure opens the buyers popover
      const el = e.target.closest("[data-id]"); if (!el || !el.dataset.id) return;
      openBuyers(+el.dataset.id, el.dataset.name);
    });
    host.querySelector("#tdk-board").addEventListener("click", function (e) {
      const th = e.target.closest("th.so"); if (!th) return;
      state.sort = th.getAttribute("data-sort"); GM_setValue("sort", state.sort); render();
    });
    host.querySelector("#tdk-vsw").addEventListener("click", function (e) {
      const vb = e.target.closest("button[data-view]"); if (!vb) return;
      state.boardView = vb.getAttribute("data-view"); GM_setValue("boardView", state.boardView); render();
    });
    host.querySelector("#tdk-ainc").addEventListener("click", function () { state.scale = Math.min(1.6, +(state.scale + 0.1).toFixed(2)); GM_setValue("scale", state.scale); applyScale(); });
    host.querySelector("#tdk-adec").addEventListener("click", function () { state.scale = Math.max(0.9, +(state.scale - 0.1).toFixed(2)); GM_setValue("scale", state.scale); applyScale(); });
    host.querySelector("#tdk-invbtn").addEventListener("click", function () { setView(state.view === "inv" ? "board" : "inv"); });
    host.querySelector("#tdk-ver").addEventListener("click", openChangelog);
    applyScale();
  }

  const ITEM_PAGE = /\/item\.php/;
  function repaintRow(li) {
    li.querySelectorAll(".tdk-inl, .tdk-mkt").forEach(function (n) { n.remove(); });
    li.removeAttribute("data-tdk");
    annotateRows();
  }
  function annotateRows() {
    const meta = state.itemMeta || {}, prices = state.resale || {};
    document.querySelectorAll("li[data-item]:not([data-tdk])").forEach(function (li) {
      li.setAttribute("data-tdk", "1");
      const id = +li.getAttribute("data-item"); if (!id) return;
      const m = meta[id] || {};
      const equipped = li.getAttribute("data-equipped") === "true";
      const cat = li.getAttribute("data-category") || m.type || "";
      const price = prices[id] || 0;
      const nameEl = li.querySelector(".name-wrap .name");
      const name = nameEl ? nameEl.textContent.trim() : "";
      const sellable = effSellable(id, m.type, m.hasUse, equipped);
      const ov = !!state.ov[id];
      const nameWrap = li.querySelector(".name-wrap");
      if (nameWrap && !nameWrap.querySelector(".tdk-inl")) {
        const tag = document.createElement("span");
        tag.className = "tdk-inl " + (sellable ? "sell" : "keep") + (ov ? " ovr" : "");
        tag.textContent = sellable ? "💰" : "🔒";
        tag.title = (sellable ? "Safe to sell" : "Held back") + " · market " + (price ? money(price) : "—") +
          (equipped ? " · equipped (always kept)" : " · click to " + (sellable ? "mark keep" : "allow sell")) + (ov ? " · override set" : "");
        if (!equipped) {
          tag.style.cursor = "pointer";
          tag.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); toggleOverride(id, sellable); repaintRow(li); });
        }
        nameWrap.appendChild(tag);
        if (sellable && price > 0) {
          const z = document.createElement("span");
          z.className = "tdk-inl tdk-zap"; z.textContent = "⚡"; z.title = "Find buyers · trade the best online offer"; z.style.cursor = "pointer";
          z.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); panel.classList.add("open"); openBuyers(id, name); });
          nameWrap.appendChild(z);
        }
      }
      if (sellable && price > 0) {
        const actions = li.querySelector(".outside-actions");
        if (actions && !actions.querySelector(".tdk-mkt")) {
          const wrap = document.createElement("div"); wrap.className = "tdk-mkt";
          const a = document.createElement("a");
          a.href = marketUrl(id, name, cat); a.target = "_blank"; a.rel = "noopener";
          a.title = "Open Item Market"; a.textContent = "🧺";
          wrap.appendChild(a); actions.appendChild(wrap);
        }
      }
    });
  }

  function harvestInvCounts() {
    const rows = document.querySelectorAll("li[data-item][data-qty]"); if (!rows.length) return;
    const store = GM_getValue("inv_counts", null) || { map: {}, at: 0 };
    const map = store.map || {}, equip = store.equip || {}, meta = state.itemMeta || {};
    const seen = {}, catsPresent = {};
    rows.forEach(function (li) {
      const id = +li.getAttribute("data-item"), q = parseInt(li.getAttribute("data-qty"), 10);
      if (!id || isNaN(q)) return;
      const cat = li.getAttribute("data-category") || (meta[id] && meta[id].type) || "";
      if (cat) catsPresent[cat] = 1;
      if (q > 0) { map[id] = q; seen[id] = 1; } else { delete map[id]; }
      // Track equipped state (item.php marks worn items) so the Bag never lists a worn item as sellable.
      if (li.getAttribute("data-equipped") === "true") equip[id] = 1; else delete equip[id];
    });
    Object.keys(map).forEach(function (id) {
      if (seen[id]) return;
      const cat = meta[id] && meta[id].type;
      if (cat && catsPresent[cat]) { delete map[id]; delete equip[id]; }
    });
    GM_setValue("inv_counts", { map: map, equip: equip, at: Date.now() });
  }
  function annotateItemsPage() {
    if (!ITEM_PAGE.test(location.pathname)) return;
    const key = GM_getValue("torn_key", ""); if (!key) return;
    loadResale(key).then(function () {
      annotateRows(); harvestInvCounts();
      let pending = false;
      new MutationObserver(function () {
        if (pending) return; pending = true;
        requestAnimationFrame(function () { pending = false; annotateRows(); harvestInvCounts(); });
      }).observe(document.body, { childList: true, subtree: true });
    }).catch(function () { });
  }

  const SHOP_PAGE = /\/shops\.php/i;
  function annotateShopRows() {
    const meta = state.itemMeta || {};
    document.querySelectorAll('span.item[itemid]:not([data-tdk])').forEach(function (it) {
      it.setAttribute("data-tdk", "1");
      const id = +it.getAttribute("itemid"); if (!id) return;
      const box = it.closest(".acc-title") || it.closest("li"); if (!box) return;
      const pr = box.querySelector(".price"); if (!pr || box.querySelector(".tdk-shop-tag")) return;
      const buy = parseM(pr.textContent);
      const m = meta[id] || {}, mkt = m.mkt || 0;
      if (!(buy > 0) || !(mkt > 0)) return;
      const spread = mkt - buy, marg = buy > 0 ? spread / buy : 0;
      const good = spread > 0 && (spread >= 1000 || marg >= 0.5);
      const tag = document.createElement("span");
      tag.className = "tdk-shop-tag " + (good ? "good" : "meh");
      if (good) {
        tag.textContent = "💰+" + money(spread);
        tag.title = "Market value " + full$(mkt) + " vs shop " + full$(buy) + " → flip +" + full$(spread) + " each (" + Math.round(marg * 100) + "%). Resell on the Item Market or direct-trade.";
      } else {
        tag.textContent = "mkt " + money(mkt);
        tag.title = "Market value " + full$(mkt) + " · shop " + full$(buy) + " — no meaningful flip.";
      }
      pr.parentNode.insertBefore(tag, pr.nextSibling);
    });
  }
  function annotateShopPage() {
    if (!SHOP_PAGE.test(location.pathname)) return;
    const key = GM_getValue("torn_key", ""); if (!key) return;
    loadResale(key).then(function () {
      annotateShopRows();
      let pending = false;
      new MutationObserver(function () { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; annotateShopRows(); }); }).observe(document.body, { childList: true, subtree: true });
    }).catch(function () { });
  }

  const MARKET_PAGE = /sid=ItemMarket/i;
  const imCtx = {};
  function marketItemId() { const m = (location.hash + location.search).match(/itemID=(\d+)/i); return m ? +m[1] : null; }
  function marketCtx(id) {
    if (imCtx[id] && Date.now() - imCtx[id].at < 120000) return Promise.resolve(imCtx[id]);
    const meta = (state.itemMeta && state.itemMeta[id]) || {};
    const ctx = { mkt: meta.mkt || 0, bid: 0, baz: 0, at: Date.now() };
    const key = GM_getValue("w3b_key", "");
    if (!key) { imCtx[id] = ctx; return Promise.resolve(ctx); }
    return Promise.all([
      gmGet("https://weav3r.dev/api/marketplace/" + id + "/traders?apiKey=" + encodeURIComponent(key), 15000)
        .then(function (j) { const t = (j && j.traders) || []; if (t.length) ctx.bid = t[0].price; }).catch(function () { }),
      gmGet("https://weav3r.dev/api/marketplace/" + id + "?apiKey=" + encodeURIComponent(key), 15000)
        .then(function (j) { const L = ((j && j.listings) || []).filter(function (x) { return x.price > 0; }).sort(function (a, b) { return a.price - b.price; }); if (L.length) ctx.baz = L[0].price; }).catch(function () { })
    ]).then(function () { imCtx[id] = ctx; return ctx; });
  }
  function marketDataRows() {
    return [...document.querySelectorAll('[class*="sellerRow"]')].filter(function (r) {
      const p = r.querySelector('[class*="price"]'); return p && /\$[\d,]/.test(p.textContent || "");
    });
  }
  function ensureMarketBanner(id, ctx) {
    if (document.getElementById("tdk-im-banner")) return;
    const anchor = document.querySelector('[class*="sellerRow"]'); if (!anchor) return;
    const meta = (state.itemMeta && state.itemMeta[id]) || {};
    const name = meta.name || decodeURIComponent(((location.hash + location.search).match(/itemName=([^&]+)/i) || [])[1] || "").replace(/_/g, " ") || "item";
    const sellable = effSellable(id, meta.type, meta.hasUse, false), ov = !!(state.ov && state.ov[id]);
    const crossed = ctx.bid && ctx.baz && ctx.baz < ctx.bid;
    const bar = document.createElement("div");
    bar.id = "tdk-im-banner"; bar.className = "tdk-im-banner";
    bar.innerHTML =
      '<span class="tdk-im-guard ' + (sellable ? "sell" : "keep") + (ov ? " ovr" : "") + '" title="' + (sellable ? "Safe to sell" : "Held back — kept off the sell flow") + ' · click to toggle">' + (sellable ? "💰" : "🔒") + '</span>' +
      '<b>' + name + '</b> · market ' + (ctx.mkt ? full$(ctx.mkt) : "—") + ' · cheapest bazaar ' + (ctx.baz ? full$(ctx.baz) : "—") + ' · top bid ' + (ctx.bid ? full$(ctx.bid) : "—") +
      (crossed ? ' · <span class="tdk-im-x">⚡ crossed: bazaar &lt; top bid</span>' : "");
    anchor.parentNode.insertBefore(bar, anchor);
    const g = bar.querySelector(".tdk-im-guard");
    if (g) g.addEventListener("click", function () {
      toggleOverride(id, effSellable(id, meta.type, meta.hasUse, false));
      const s = effSellable(id, meta.type, meta.hasUse, false);
      this.textContent = s ? "💰" : "🔒";
      this.className = "tdk-im-guard " + (s ? "sell" : "keep") + " ovr";
    });
  }
  function annotateMarketRows(id, ctx) {
    const rows = marketDataRows(); if (!rows.length) return;
    ensureMarketBanner(id, ctx);
    rows.forEach(function (r) {
      if (r.getAttribute("data-tdk")) return;
      r.setAttribute("data-tdk", "1");
      const pe = r.querySelector('[class*="price"]'); if (!pe) return;
      const ask = parseM(pe.textContent);
      if (ctx.bid > 0 && ask > 0 && ask < ctx.bid) {
        r.classList.add("tdk-im-flip");
        const tag = document.createElement("span");
        tag.className = "tdk-im-ftag";
        tag.textContent = "⚡+" + money(ctx.bid - ask);
        tag.title = "A live trader is buying at " + full$(ctx.bid) + " — buy this listing (" + full$(ask) + ") and sell to them for +" + full$(ctx.bid - ask) + " each (direct trade, no fee). Prices move fast — reconfirm.";
        pe.appendChild(tag);
      }
    });
  }
  function annotateMarketPage() {
    if (!MARKET_PAGE.test(location.search + location.hash)) return;
    const key = GM_getValue("torn_key", "");
    (key ? loadResale(key).catch(function () { }) : Promise.resolve()).then(function () {
      let curId = null, pending = false;
      const run = function () {
        const id = marketItemId();
        if (id !== curId) {
          const b = document.getElementById("tdk-im-banner"); if (b) b.remove();
          document.querySelectorAll('[class*="sellerRow"][data-tdk]').forEach(function (r) {
            r.removeAttribute("data-tdk"); r.classList.remove("tdk-im-flip");
            const t = r.querySelector(".tdk-im-ftag"); if (t) t.remove();
          });
          curId = id;
          if (id != null) marketCtx(id).then(function (ctx) { if (marketItemId() === id) annotateMarketRows(id, ctx); });
        } else if (id != null && imCtx[id]) {
          annotateMarketRows(id, imCtx[id]);
        }
      };
      run();
      new MutationObserver(function () { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; run(); }); }).observe(document.body, { childList: true, subtree: true });
      window.addEventListener("hashchange", run);
    });
  }

  const TRADE_PAGE = /\/trade\.php/;
  function tradeDescHelper() {
    if (!TRADE_PAGE.test(location.pathname)) return;
    const run = function () {
      const ta = document.querySelector("textarea#description");
      if (!ta || document.querySelector("#tdk-filldesc")) return;
      const pend = GM_getValue("pending_trade", null);
      if (!pend || !pend.line || (Date.now() - pend.at > 15 * 60 * 1000)) return;
      const btn = document.createElement("button");
      btn.id = "tdk-filldesc"; btn.type = "button"; btn.className = "tdk-filldesc";
      btn.textContent = "📋 Fill description: " + pend.line;
      btn.title = "Drops this into the description. You still add the items and press Initiate Trade.";
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        ta.focus();
        try { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value"); if (d && d.set) d.set.call(ta, pend.line); else ta.value = pend.line; } catch (err) { ta.value = pend.line; }
        ta.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }));
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " " }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        ta.dispatchEvent(new Event("blur", { bubbles: true }));
        btn.textContent = "✓ Filled — add items, then Initiate Trade";
      });
      ta.parentNode.insertBefore(btn, ta.nextSibling);
    };
    run();
    let pending = false;
    new MutationObserver(function () { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; run(); }); }).observe(document.body, { childList: true, subtree: true });
  }

  function onTravelPage() { return /[?&]sid=travel\b/i.test(location.search + location.hash) || /\/travel\.php/i.test(location.pathname); }
  function scrapeTripBought() {
    if (!onTravelPage()) return;
    const run = function () {
      let n = null, cap = null;
      const m = (document.body.innerText || "").match(/purchased\s+(\d+)\s*\/\s*(\d+)\s+item/i);
      if (m) { n = +m[1]; cap = +m[2]; }
      else { const ul = document.querySelector('ul[aria-label*="Inventory"]'); const al = ul && ul.getAttribute("aria-label"); const am = al && al.match(/(\d+)\s+item/i); if (am) { n = +am[1]; cap = state.cap || 23; } }
      if (n == null) return;
      if (m && cap > (state.cap || 0)) {
        state.cap = cap; GM_setValue("cap", cap);
        const ci = host && host.querySelector("#tdk-cap"); if (ci) ci.value = cap;
        if (state.rows && state.rows.length) recomputePpm();
        render();
      }
      const prev = GM_getValue("trip_bought", null);
      if (!prev || prev.n !== n || prev.cap !== cap) { GM_setValue("trip_bought", { n: n, cap: cap, at: Date.now() }); renderHomeBar(); }
    };
    run();
    let pending = false;
    new MutationObserver(function () { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; run(); }); }).observe(document.body, { childList: true, subtree: true });
  }

  // The {hash} in /builds/{module}/{name}.{hash}.js is Torn's own webpack content-checksum, so a changed hash always
  // = changed code. We can't tell "new to Torn" from "new to YOUR browsing" (we only see what the page loads), so:
  //   • a FIRST sighting is only ever CATALOGED (never alerts) — kills the false "NEW" from just visiting a page;
  //   • a hash CHANGE alerts (real fresh code) — and if that module first appeared RECENTLY (< NEW_WINDOW) and is
  //     already being re-deployed, it's flagged 🆕 (a genuinely-new module Torn is actively iterating = best odds).
  const NEW_WINDOW = 10 * 86400 * 1000;
  const BUILD_DEBOUNCE = 15 * 60 * 1000;
  const LEGACY_RE = /(^|\/)[^/]*-old(\/|$)/i;
  function recordBuilds() {
    let man; try { man = GM_getValue("build_manifest", null); } catch (e) { man = null; }
    const first = !man; const manifest = man || {};
    let log; try { log = GM_getValue("build_log", []) || []; } catch (e) { log = []; }
    let hashes; try { hashes = GM_getValue("build_hashes", null); } catch (e) { hashes = null; }
    let fseen; try { fseen = GM_getValue("build_firstseen", null); } catch (e) { fseen = null; }
    const now = Date.now();
    let dirty = false;
    try { if (!GM_getValue("build_seen_at", 0)) GM_setValue("build_seen_at", now); } catch (e) { }
    if (!hashes) { hashes = {}; Object.keys(manifest).forEach(function (k) { hashes[k] = [manifest[k]]; }); log = log.filter(function (x) { return !(LEGACY_RE.test(x.k) && (x.type === "changed" || x.type === "new")); }); dirty = true; }
    if (!fseen) { fseen = {}; Object.keys(manifest).forEach(function (k) { fseen[k] = 0; }); dirty = true; } // existing modules: unknown/pre-existing age (0)
    const bump = function (key, hash, entry) {
      const top = log[0];
      if (top && top.k === key && top.type === entry.type && (now - top.t) < BUILD_DEBOUNCE) { top.h = hash; top.t = now; top.n = (top.n || 1) + 1; }
      else log.unshift(entry);
      dirty = true;
    };
    (performance.getEntriesByType ? performance.getEntriesByType("resource") : []).forEach(function (r) {
      const m = String(r.name || "").match(/\/builds\/([^/]+)\/([^/]+?)\.([0-9a-f]{8,})\.js(?:$|\?)/);
      if (!m) return;
      const key = m[1] + "/" + m[2], hash = m[3], prev = manifest[key], lg = LEGACY_RE.test(key) ? 1 : 0;
      const seen = hashes[key] || (hashes[key] = []);
      if (!prev) {
        manifest[key] = hash; if (seen.indexOf(hash) < 0) seen.push(hash);
        if (fseen[key] == null) fseen[key] = first ? 0 : now;           // when WE first saw it (0 = pre-existing at baseline)
        if (!first) bump(key, hash, { k: key, h: hash, t: now, type: "seen", lg: lg }); // first sight = cataloged only, never an alert
      } else if (prev !== hash) {
        manifest[key] = hash;
        if (seen.indexOf(hash) >= 0) { /* flap back to a hash we've already recorded — not fresh code */ }
        else {
          seen.push(hash); if (seen.length > 12) seen.shift();
          const fresh = fseen[key] > 0 && (now - fseen[key] < NEW_WINDOW); // appeared recently AND now redeploying = genuinely-new module
          bump(key, hash, { k: key, h: hash, ph: prev, t: now, type: fresh ? "new" : "changed", lg: lg });
        }
      }
    });
    if (log.length > 100) log.length = 100;
    try { GM_setValue("build_manifest", manifest); GM_setValue("build_hashes", hashes); GM_setValue("build_firstseen", fseen); if (dirty) GM_setValue("build_log", log); } catch (e) { }
    updateBuildBadge();
  }
  function buildUnseen() { try { const log = GM_getValue("build_log", []) || [], seen = GM_getValue("build_seen_at", 0); return log.filter(function (x) { return x.t > seen && x.type !== "seen" && !x.lg; }).length; } catch (e) { return 0; } }
  function updateBuildBadge() {
    const v = host && host.querySelector("#tdk-ver"); if (!v) return;
    const n = buildUnseen();
    v.setAttribute("data-new", n > 0 ? String(n) : "");
    v.title = n > 0 ? n + " new/changed Torn module" + (n === 1 ? "" : "s") + " since you last looked — click for the build watcher" : "View changelog";
  }

  build();
  annotateItemsPage();
  annotateShopPage();
  annotateMarketPage();
  tradeDescHelper();
  scrapeTripBought();
  setTimeout(recordBuilds, 5000);
  setInterval(recordBuilds, 60 * 1000);
  setTimeout(autoDetectTravelOnce, 9000);
  setTimeout(function () { try { if (Date.now() - (GM_getValue("shared_synced_at", 0) || 0) > 12 * 3600 * 1000) syncShared(false); } catch (e) { } }, 15000); // silent: refresh the baked-in shared feed at most ~twice a day
  setTimeout(checkInvStatus, 8000);
  setInterval(checkInvStatus, 15 * 60 * 1000);
  setTimeout(pollStocks, 12000);
  setInterval(pollStocks, 60 * 1000);
  setTimeout(pollStockPrices, 20000);
  setInterval(pollStockPrices, 5 * 60 * 1000);
  setInterval(function () { renderImmunity(); renderOC(); }, 1000);
})();