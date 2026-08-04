// ==UserScript==
// @name         Torn Trade Desk
// @namespace    tekim.tradedesk
// @version      1.32.1
// @updateURL    https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.user.js
// @downloadURL  https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.user.js
// @description  Live travel-profit board — YATA foreign stock × Torn-API resale, ranked by $/minute. Refresh button, affordability + best-pick, mug calculator.
// @author       Tekim
// @match        *://*.torn.com/*
// @connect      yata.yt
// @connect      api.torn.com
// @connect      weav3r.dev
// @connect      raw.githubusercontent.com
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
  // Torn's status/travel destination strings → our country codes (so we can auto-filter to where you're standing).
  const DEST_CC = { mexico: "mex", cayman: "cay", "cayman islands": "cay", canada: "can", hawaii: "haw", "united kingdom": "uni", uk: "uni", britain: "uni", argentina: "arg", switzerland: "swi", japan: "jap", china: "chi", uae: "uae", "united arab emirates": "uae", "south africa": "sou" };
  function destCC(dest) { return dest ? (DEST_CC[String(dest).toLowerCase().trim()] || null) : null; }
  // Are you standing in a foreign store right now? travel.destination names the country even while hospitalized abroad
  // (state "Hospital", dest "Canada", time_left 0). Rule out in-flight ("Traveling" / time_left>0) and home ("Okay").
  // Verified live Aug 2 2026: Abroad-ok→state "Abroad"; Abroad-hospital→"Hospital"+"In a Canadian hospital"; both dest="Canada",time_left 0.
  function detectLoc(j) {
    if (!j || !j.status || !j.travel) return null;
    const st = j.status.state;
    if (st === "Traveling" || st === "Okay") return null; // in flight, or home & fine
    if (j.travel.time_left > 0) return null;               // still in transit
    return destCC(j.travel.destination);                   // Canada/Mexico/… → cc; Torn/empty → null (home)
  }
  // Tri-state on top of detectLoc's verified rules: are you home (in Torn), in flight, or landed abroad?
  // "home" is where detectLoc collapses to null-but-not-flying — we split it out so it's a first-class state.
  function detectTravel(j) {
    if (!j || !j.status || !j.travel) return { where: "unknown", cc: null };
    const st = j.status.state, tl = j.travel.time_left || 0;
    if (st === "Traveling" || tl > 0) return { where: "flying", cc: destCC(j.travel.destination), arriveIn: tl };
    const cc = detectLoc(j);           // abroad → cc; home → null (flying already ruled out above)
    if (cc) return { where: "abroad", cc: cc };
    return { where: "home", cc: null };
  }

  /* ---------- state ---------- */
  const state = { resale: null, itemMeta: null, resaleAt: 0, cash: null, stocks: null, cap: GM_getValue("cap", 23), rows: [], updates: {}, filter: "all", fund: GM_getValue("fund", false), scale: GM_getValue("scale", 1), view: "board", inv: null, invAt: 0, travel: null, invReady: null, sort: GM_getValue("sort", "ppm"), maxTrip: GM_getValue("maxTrip", 0), ov: GM_getValue("ov", {}), loc: null, lastLoc: undefined, travelWhere: null, flyTo: null, flyEta: null, stkMkt: null, stkMine: null, stkAt: 0, _stkHist: null, oc: null, arrivalTs: 0 };
  const fmtRt = function (min) { const h = Math.floor(min / 60), m = min % 60; return (h ? h + "h" : "") + (m ? m + "m" : "") || "0m"; };
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
  const escAttr = function (s) { return String(s == null ? "" : s).replace(/"/g, "&quot;"); };
  function copyText(t) {
    try { if (typeof GM_setClipboard === "function") { GM_setClipboard(t, "text"); return; } } catch (e) { }
    try { if (navigator.clipboard) navigator.clipboard.writeText(t); } catch (e) { }
  }
  function mkTradeLine(nm, q, p, net) { // trade description cap is 155
    let s = nm + " ×" + q + " @ $" + p.toLocaleString() + "/ea = $" + (p * q).toLocaleString();
    if (typeof net === "number") s += " · net " + (net >= 0 ? "+" : "−") + "$" + Math.abs(net).toLocaleString();
    return s.slice(0, 155);
  }
  function stashTrade(nm, q, p, uid) { try { GM_setValue("pending_trade", { line: mkTradeLine(nm, q, p), uid: uid || 0, at: Date.now() }); } catch (e) { } } // stashed line stays net-free (it's what the buyer sees)
  // Buy cost for net-profit math: the YATA foreign shop price from the current board, if this item is a known travel-trade good.
  function buyCostOf(id) { const r = (state.rows || []).find(function (x) { return x.id == id; }); return r ? r.buy : null; }
  const ago = function (secs) {
    if (secs == null) return "?";
    const m = Math.floor(secs / 60);
    return m < 1 ? secs + "s" : m + "m";
  };

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
  async function loadCash(key) {
    try {
      const j = await gmGet("https://api.torn.com/user/?selections=money,networth,basic,travel&key=" + encodeURIComponent(key));
      if (j && typeof j.money_onhand === "number") state.cash = j.money_onhand;
      if (j && j.networth && typeof j.networth.stockmarket === "number") state.stocks = j.networth.stockmarket;
      const tw = detectTravel(j);
      state.travelWhere = tw.where;             // home | flying | abroad | unknown
      state.loc = tw.where === "abroad" ? tw.cc : null; // preserve existing semantics: abroad cc, else null (drives auto-focus)
      state.flyTo = tw.where === "flying" ? (tw.cc || null) : null; // destination cc while in transit (null when flying home)
      state.flyEta = tw.where === "flying" ? (tw.arriveIn || 0) : null; // seconds until landing
      state.arrivalTs = (j && j.travel && j.travel.timestamp) || 0;    // arrival time → 15s landing-immunity countdown
    } catch (e) { /* non-fatal */ }
  }
  // The country to auto-focus the board on: where you're standing (abroad) OR, while flying out, your destination
  // — so you can plan the buy mid-flight. Flying home (no foreign dest) or at home → null → All.
  function focusCC() { return state.loc || (state.travelWhere === "flying" ? state.flyTo : null) || null; }
  // Auto-focus, but only re-apply when the focus country actually changes, so a chip you pick yourself sticks
  // until you move to a new leg (land abroad, take off toward a country, or fly home → back to All).
  function applyLocationFilter() {
    const f = focusCC();
    if (f !== state.lastLoc) { state.lastLoc = f; state.filter = f || "all"; }
  }
  /* ---------- restock history (foundation for stock-trend + landing prediction) ----------
     YATA gives only current quantity + a per-country update ts — no velocity. So we record snapshots
     ourselves (keyed cc:id), deduped by YATA's update ts, and derive trend/restock cadence from them.
     Stored in GM "stock_hist" = { "cc:id": [[updateTs, quantity], …] }. */
  const HIST_MAX = 576, HIST_AGE = 48 * 3600; // ~2 days at the 5-min poll cadence; both caps now align at 48h
  function recordStocks(yata) {
    if (!yata || !yata.stocks) return;
    let hist; try { hist = GM_getValue("stock_hist", null) || {}; } catch (e) { hist = {}; }
    const now = Math.floor(Date.now() / 1000), cutoff = now - HIST_AGE;
    let changed = false;
    Object.keys(yata.stocks).forEach(function (cc) {
      if (!FLY[cc]) return;
      const block = yata.stocks[cc], upd = block.update || now;
      (block.stocks || block).forEach(function (it) {
        const key = cc + ":" + it.id, arr = hist[key] || (hist[key] = []);
        const last = arr[arr.length - 1];
        if (last && last[0] === upd) return;                 // YATA hasn't refreshed this country since last point
        arr.push([upd, it.quantity]); changed = true;
        while (arr.length && arr[0][0] < cutoff) arr.shift(); // prune by age
        if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX); // then by count
      });
    });
    if (changed) { try { GM_setValue("stock_hist", hist); } catch (e) { } }
    state._hist = hist; // cache for this render cycle's trend arrows
  }
  // Cross-tab background poll: a GM timestamp lock ensures only ONE fetch per interval across all open Torn tabs.
  const POLL_MS = 5 * 60 * 1000;
  function pollStocks() {
    let last = 0; try { last = GM_getValue("stock_poll_at", 0); } catch (e) { }
    if (Date.now() - last < POLL_MS - 4000) return;          // another tab polled recently
    try { GM_setValue("stock_poll_at", Date.now()); } catch (e) { } // claim the slot before fetching
    gmGet("https://yata.yt/api/v1/travel/export/", 30000).then(recordStocks).catch(function () { });
  }
  // Short-term trend from the last two recorded points: ▲ restocked / ▼ being bought / null if <2 points or flat.
  function stockTrend(cc, id) {
    const hist = state._hist || (function () { try { return GM_getValue("stock_hist", null) || {}; } catch (e) { return {}; } })();
    const arr = hist[cc + ":" + id]; if (!arr || arr.length < 2) return null;
    const a = arr[arr.length - 2], b = arr[arr.length - 1], dq = b[1] - a[1];
    if (!dq) return null;
    return { dq: dq, perMin: dq / (Math.max(60, b[0] - a[0]) / 60) };
  }
  /* ---------- Faction OC flight guard: don't fly past your Organized Crime's ready time ----------
     v2/user/organizedcrime WORKS while abroad/hospital (unlike the Items page), so we can warn even when Torn
     hides the OC from you in-country. ready_at = planning completes → crime becomes executable; you must be in
     Torn (not Traveling/Hospital/Jail) or you BLOCK the whole crime. So a round trip longer than time-to-ready
     = you'd miss it. */
  async function loadOC(key) {
    try {
      const j = await gmGet("https://api.torn.com/v2/user/organizedcrime?key=" + encodeURIComponent(key));
      const oc = j && j.organizedCrime, nowS = Math.floor(Date.now() / 1000);
      const st = oc ? String(oc.status || "").toLowerCase() : "";
      if (!oc || oc.executed_at || (oc.expired_at && oc.expired_at < nowS) || ["successful", "failure", "failed", "expired", "completed"].indexOf(st) !== -1) { state.oc = null; return; }
      state.oc = { name: oc.name, status: oc.status, readyAt: oc.ready_at || 0 };
    } catch (e) { /* non-fatal — keep last known */ }
  }
  function ocGuard() { // seconds until you must be back in Torn for the OC (null if none pending)
    const oc = state.oc; if (!oc || !oc.readyAt) return null;
    return { name: oc.name, secs: oc.readyAt - Math.floor(Date.now() / 1000) };
  }
  function fmtDur(secs) { // ticks down to the second under an hour so the OC banner visibly counts
    secs = Math.max(0, secs | 0);
    const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60;
    return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m ? m + "m " + s + "s" : s + "s";
  }
  function mmss(secs) { // in-flight countdown: "Hh Mm" over an hour, else "M:SS"
    secs = Math.max(0, secs | 0);
    const h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60;
    return h ? h + "h " + m + "m" : m + ":" + (s < 10 ? "0" : "") + s;
  }
  let landTimer = null;
  function armLandingRefresh() { // schedule a one-shot refresh at arrival so the immunity timer starts on its own
    if (landTimer) { clearTimeout(landTimer); landTimer = null; }
    if (state.travelWhere === "flying" && state.flyEta > 0) {
      landTimer = setTimeout(function () { landTimer = null; refresh(); }, (state.flyEta + 2) * 1000); // +2s so we're truly landed
    }
  }
  async function refresh() {
    setStatus("Refreshing…");
    const key = tornKey();
    if (!key) { setStatus("Need a Torn API key.", true); return; }
    try {
      const [yata, resale] = await Promise.all([
        gmGet("https://yata.yt/api/v1/travel/export/", 30000),
        loadResale(key)
      ]);
      await loadCash(key);
      await loadOC(key); // faction OC deadline (works even while abroad, unlike the Items page)
      recordStocks(yata); // snapshot every item's stock into the rolling history
      const nowS = Math.floor(Date.now() / 1000);
      const rows = [];
      state.updates = {};
      Object.keys(yata.stocks).forEach(function (cc) {
        const f = FLY[cc]; if (!f) return;
        const block = yata.stocks[cc];
        state.updates[cc] = block.update ? nowS - block.update : null;
        (block.stocks || block).forEach(function (it) {
          const sell = resale[it.id]; if (!sell) return;
          const ppi = sell - it.cost;
          if (ppi <= 0) return;
          const cap = state.cap;
          const ppm = Math.round((ppi * cap - f.fare) / f.rt);
          rows.push({ id: it.id, name: it.name, cc: cc, country: f.name, buy: it.cost, sell: sell, stock: it.quantity, ppi: ppi, ppm: ppm, full: it.cost * cap, freshS: state.updates[cc] });
        });
      });
      rows.sort(function (a, b) { return b.ppm - a.ppm; });
      state.rows = rows;
      state.foreignIds = new Set(); Object.values(yata.stocks).forEach(function (b) { (b.stocks || []).forEach(function (it) { state.foreignIds.add(it.id); }); }); // to exclude travel items from Shop Flips
      applyLocationFilter(); // auto-focus the board on the country you're standing in
      render();
      const flyNote = state.flyTo && FLY[state.flyTo]
        ? " · ✈ heading to " + FLY[state.flyTo].name + (state.flyEta ? " · land in " + fmtRt(Math.ceil(state.flyEta / 60)) : "") + " — planning ahead"
        : " · ✈ In flight"; // flying home (no foreign dest) → generic
      const locNote = state.travelWhere === "abroad" && FLY[state.loc] ? " · 📍 you're in " + FLY[state.loc].name
        : state.travelWhere === "home" ? " · 🏠 Home"
          : state.travelWhere === "flying" ? flyNote
            : "";
      setStatus("Updated " + new Date().toLocaleTimeString() + locNote);
      armLandingRefresh(); // if in flight, auto-refresh right when we land (fires the immunity timer without a manual refresh)
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
    #tdk-panel{position:fixed;right:18px;top:12px;z-index:2147483000;width:min(760px,94vw);max-height:calc(100vh - 24px);overflow:auto;
      background:#14130f;color:#ece7d8;border:1px solid #2c2a21;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);
      font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;display:none}
    #tdk-panel.open{display:block}
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
    table.tdk td.num{color:#c3bda9}
    table.tdk td.l{font-family:system-ui,sans-serif}
    table.tdk tr.dim td{opacity:.82}
    table.tdk tr:hover td{background:#1b1a14}
    .nm{font-weight:700;color:#f2eddf}.cy{color:#a49c88;font-size:11px}
    .ppm{color:#d9b441;font-weight:800}
    .gd{color:#4cc281;font-weight:700}
    .chip{font-family:system-ui,sans-serif;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px}
    .c-ok{color:#4cc281;background:#16281d}.c-low{color:#e2933f;background:#2c2114}.c-out{color:#e5615c;background:#2c1717}
    .tk-tr{font-size:9px;margin-right:4px;vertical-align:middle}.tk-tr.up{color:#4cc281}.tk-tr.dn{color:#e5615c}
    .star{color:#d9b441;margin-left:6px}
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
    .tdk-upbar{display:flex;align-items:center;gap:10px;margin:2px 0 10px;flex-wrap:wrap}
    .tdk-upbar2{margin-top:-6px}
    .tdk-upd{font-size:12px;color:#928b78}
    .tdk-upd b{color:#d9b441;font-family:ui-monospace,monospace}
    .tdk-upd a{color:#d9b441;text-decoration:none;border-bottom:1px dotted #d9b441}
    .tdk-upd a:hover{color:#f0cf6b}
    .tdk-clog{padding:9px 0;border-bottom:1px solid #2c2a21}
    .tdk-clog:last-child{border-bottom:none}
    .tdk-clog .cv{font-weight:800;color:#d9b441}
    .tdk-clog .cv span{color:#928b78;font-weight:600;font-size:11px}
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
    .tdk-happy .hreset{font-size:14px;font-weight:700;color:#8fe6b3;background:#16241c;border:1px solid #2f5e46;border-radius:9px;padding:8px 11px;margin-bottom:8px}
    .tdk-happy .hreset.soon{color:#f0b3ad;background:#2c1614;border-color:#7a4a44}
    .tdk-happy .hsec{font-size:12px;color:#c3bda9;margin:8px 0 4px;font-weight:700}
    .tdk-happy .hsec small{color:#928b78;font-weight:400}
    .tdk-happy .hrow{display:flex;align-items:center;gap:8px;padding:3px 0}
    .tdk-happy .hrow label{flex:1;font-size:13px;color:#ece7d8}
    .tdk-happy .hv{color:#928b78;font-size:11px}
    .tdk-happy .hqty{width:70px;background:#201e17;border:1px solid #3a3729;color:#ece7d8;border-radius:8px;padding:5px 7px;font-family:ui-monospace,monospace}
    .tdk-happy .hsub{width:92px;text-align:right;color:#8fe6b3;font-size:11px;font-family:ui-monospace,monospace}
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
    .tdk-bestonline{display:block;margin:8px 0 4px;padding:9px 12px;border:1px solid #4cc281;border-radius:9px;background:#16241c;color:#bfe9cf;text-decoration:none;font-size:13px}
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
    const heading = state.travelWhere === "flying" ? state.flyTo : null; // where you're headed (pre-focus while flying)
    host.querySelector("#tdk-filter").innerHTML = chips.map(function (c) {
      const here = c[0] === state.loc;          // the country you're currently standing in
      const toHere = c[0] === heading && !here; // your in-flight destination
      const mark = here ? "📍 " : toHere ? "✈ " : "";
      const cls = here ? " here" : toHere ? " heading" : "";
      const tip = here ? ' title="You\'re here now"' : toHere ? ' title="Heading here — plan your buy before you land"' : "";
      return '<span class="tdk-fc' + (state.filter === c[0] ? " on" : "") + cls + '" data-cc="' + c[0] + '"' + tip + '>' + mark + c[1] + '</span>';
    }).join("") + timeSel;
  }
  // Home / sell-side helper bar: abroad → "fly home to sell" nudge; home → your sellable-haul summary + a jump
  // straight to the Bag. Flying/unknown → hidden. The haul value comes from the scraped counts (API-down safe).
  function renderHomeBar() {
    const el = host.querySelector("#tdk-homebar"); if (!el) return;
    const w = state.travelWhere, travelUrl = "https://www.torn.com/page.php?sid=travel";
    if (w === "abroad") {
      // Use Torn's OWN trip counter scraped from the travel page ("purchased N / 23") — the only reliable read of
      // this trip's haul while abroad (inventory API down + Items page blocked in-country). Never fabricate a total.
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
        el.style.display = "none"; el.innerHTML = ""; // no trip data yet (open the travel page once) — don't guess
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
  // 15-second landing-immunity countdown (Torn: you can't be attacked for 15s after you land, abroad or home).
  // Ticks live off the last-known arrival time; only shows right after a fresh landing.
  function renderImmunity() {
    const el = host && host.querySelector("#tdk-immunity"); if (!el) return;
    const arr = state.arrivalTs || 0, now = Math.floor(Date.now() / 1000);
    if (!arr) { el.style.display = "none"; el.innerHTML = ""; return; }
    const toLand = arr - now, rem = (arr + 15) - now;
    if (state.travelWhere === "flying" && toLand > 0) { // in-flight: live countdown; auto-refresh is armed for landing
      el.style.display = ""; el.className = "tdk-imm fly";
      el.innerHTML = '✈ <b>Landing in ' + mmss(toLand) + '</b> — panel auto-refreshes on arrival to start your 15s immunity timer.';
    } else if (rem > 0) { // landed (now ≥ arrival): 15s immunity window (shows even before the auto-refresh confirms)
      el.style.display = ""; el.className = "tdk-imm active";
      el.innerHTML = '🛡️ <b>Immunity: ' + rem + 's</b> — can’t be attacked. Buy / shelter cash in stocks / re-fly NOW.';
    } else if (rem > -12 && state.travelWhere !== "flying") { // brief "you're exposed now" reminder just after it lapses
      el.style.display = ""; el.className = "tdk-imm gone";
      el.innerHTML = '⚠️ <b>Immunity ended — you’re exposed.</b> Only wallet cash is muggable — shelter it in stocks.';
    } else { el.style.display = "none"; el.innerHTML = ""; }
  }
  // OC flight guard banner (works even abroad, where Torn hides the OC from you).
  function renderOC() {
    const el = host.querySelector("#tdk-oc"); if (!el) return;
    const g = ocGuard();
    if (!g) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "";
    if (g.secs <= 0) {
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
    const capTh = host.querySelector("#tdk-th-full"); if (capTh) capTh.textContent = "Profit ×" + cap; // keep the full-load header in sync with Cap
    const fbtn = host.querySelector("#tdk-fund"); if (fbtn) fbtn.className = "tdk-btn2" + (fund ? " on" : "");
    let rows = state.filter === "all" ? state.rows : state.rows.filter(function (x) { return x.cc === state.filter; });
    if (state.maxTrip) rows = rows.filter(function (x) { return FLY[x.cc] && FLY[x.cc].rt <= state.maxTrip; }); // round-trip time budget
    const best = rows.find(function (x) { return (cash == null || x.full <= cash) && x.stock >= cap; });
    const alt = best ? null : rows.find(function (x) { return x.stock > 0; }); // rows are sorted by ppm desc
    // Only surface a "funded" play you could ACTUALLY reach by liquidating stocks (cash + stock value).
    const topOver = rows.find(function (x) { return x.stock >= cap && cash != null && x.full > cash && x.full <= funds && (!best || x.ppm > best.ppm); });
    const b = host.querySelector("#tdk-best");
    const loc = (state.filter === "all" ? "" : " · " + FLY[state.filter].name) + (cash != null ? " · " + money(cash) : "");
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
    // "Best" card above uses profit order (rows); the table can be re-sorted by any column header.
    const sm = state.sort || "ppm";
    const disp = rows.slice();
    if (sm === "stock") disp.sort(function (a, b) { return ((a.stock > 0 ? 0 : 1) - (b.stock > 0 ? 0 : 1)) || (b.ppm - a.ppm); }); // available first, then $/min
    else if (sm === "ppm") disp.sort(function (a, b) { return b.ppm - a.ppm; });
    else if (sm === "fullprofit") disp.sort(function (a, b) { return b.ppi - a.ppi; }); // ppi×cap order == ppi order (cap is constant)
    else disp.sort(function (a, b) { return (b[sm] || 0) - (a[sm] || 0); });
    host.querySelectorAll("#tdk-board th.so").forEach(function (th) { th.classList.toggle("on", th.getAttribute("data-sort") === sm); });
    const g = ocGuard(); // OC deadline — flights whose round trip exceeds it would make you miss the crime
    body.innerHTML = disp.map(function (x) {
      const aff = cash == null || x.full <= cash;
      const fill = x.stock >= cap;
      const isTop = topOver && x === topOver;
      const ocMiss = g && FLY[x.cc] && (g.secs <= 0 || FLY[x.cc].rt * 60 >= g.secs); // round-trip (min→sec) vs time-to-ready
      let sc = x.stock === 0 ? '<span class="chip c-out">out</span>'
        : x.stock < cap ? '<span class="chip c-low">only ' + x.stock + '</span>'
          : '<span class="chip c-ok">' + x.stock.toLocaleString() + '</span>';
      const tr = stockTrend(x.cc, x.id); // ▲ restocking / ▼ selling since last recorded sample
      if (tr) sc = (tr.dq > 0
        ? '<span class="tk-tr up" title="Restocked +' + tr.dq.toLocaleString() + ' since last sample">▲</span>'
        : '<span class="tk-tr dn" title="Sold ' + Math.abs(tr.dq).toLocaleString() + ' since last sample (~' + Math.abs(Math.round(tr.perMin)) + '/min)">▼</span>') + sc;
      const shortB = (!aff && cash != null && fill) ? '<span class="chip short">free +' + money(x.full - cash) + '</span>' : '';
      const cls = (aff ? "" : (fund ? (isTop ? "fund" : "") : "dim")) + (ocMiss ? " ocmiss" : "");
      const mark = (aff && fill) ? '<span class="star" title="Affordable now & fully in stock — a clean pick">★</span>' : (isTop ? '<span class="star" title="Best funded play — over budget, but reachable by selling stocks (see the banner up top)">💰</span>' : '');
      const ocBadge = ocMiss ? '<span class="oc-x" title="Round trip ' + (FLY[x.cc] ? fmtRt(FLY[x.cc].rt) : '?') + (g.secs <= 0 ? ' — your OC is ready NOW, don’t fly' : ' exceeds your OC (ready in ' + fmtDur(g.secs) + ') — you’d miss it') + '">⛔ OC</span>' : '';
      return '<tr class="' + cls + '" data-id="' + x.id + '" data-name="' + x.name.replace(/"/g, "") + '">' +
        '<td class="l"><span class="nm">' + x.name + mark + '</span><div class="cy"><a class="fly" href="https://www.torn.com/page.php?sid=travel" title="Open the travel agency">' + x.country + ' ✈</a> · ' + (FLY[x.cc] ? fmtRt(FLY[x.cc].rt) + ' rt · ' : '') + ago(x.freshS) + ' old' + ocBadge + '</div></td>' +
        '<td class="mv">' + full$(x.buy) + '</td><td class="mv">' + full$(x.sell) + '</td>' +
        '<td class="gd">' + full$(x.ppi) + '</td><td class="gd">' + money(x.ppi * cap) + '</td><td>' + sc + '</td>' +
        '<td class="mv">' + money(x.full) + shortB + '</td>' +
        '<td class="ppm">$' + x.ppm.toLocaleString() + '</td></tr>';
    }).join("");

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
      // Best-effort online lookup: each buyer's public last_action.status via the Torn API.
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
      // Traders arrive price-sorted, so the first online (else idle) is the best offer from someone around.
      const bestOn = traders.find(function (t) { return status[t.player_id] === "Online"; }) ||
        traders.find(function (t) { return status[t.player_id] === "Idle"; });
      const head = '<div class="tdk-bh"><div class="tt">Buyers · ' + name + '<small> — ' + (j.total_count || traders.length) + ' buying' + (tkey ? ' · online first' : '') + '</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>';
      const banner = bestOn
        ? '<a class="tdk-bestonline" href="' + tradeUrl(bestOn.player_id) + '" target="_blank" rel="noopener" data-uid="' + bestOn.player_id + '" data-price="' + bestOn.price + '">⚡ Trade best ' + (status[bestOn.player_id] === "Online" ? "online" : "idle") + ': <b>' + bestOn.player_name + '</b> @ $' + bestOn.price.toLocaleString() + ' ' + dot(status[bestOn.player_id]) + '</a>'
        : '<div class="tdk-sub" style="padding:6px 2px">' + (tkey ? 'None of the top buyers are online right now.' : 'Add your Torn API key to flag who’s online.') + '</div>';
      const rank = function (t) { const s = status[t.player_id]; return s === "Online" ? 0 : s === "Idle" ? 1 : s === "Offline" ? 3 : 2; };
      const sorted = traders.map(function (t, i) { return { t: t, i: i }; })
        .sort(function (a, b) { return (rank(a.t) - rank(b.t)) || (a.i - b.i); }).map(function (x) { return x.t; });
      let owned = 0, ownedStale = false; // how many of this item the user holds
      if (tkey) { try { const inv = await loadInv(tkey); if (inv.length) { const f = inv.find(function (it) { return (it.ID || it.id || it.item_id) == id; }); owned = f ? (f.quantity || 0) : 0; } } catch (e) { } }
      if (!owned) { const c = GM_getValue("inv_counts", null); if (c && c.map && c.map[id] != null) { owned = c.map[id]; ownedStale = true; } } // DOM-scraped fallback while API is down
      const q0 = owned > 0 ? owned : Math.max(1, state.cap || 1);
      const buyCost = buyCostOf(id); // null unless this is a known travel-trade good on the current board
      const btText = function (price, qty) { // running total + net (after buy cost) for one buyer
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
      // Stash the trade line when a ⇄ Trade / ⚡ link is clicked, so trade.php can offer to fill the description.
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
  // ---------- Flip finder: buy cheap (Item Market / bazaar) → sell to the highest live trader ----------
  // Two-stage: (1) ONE whole-market call to shortlist undervalued items (cheapest buy well below bazaar avg),
  // (2) real trader buy-offers for just the shortlist, ranked by actual buy→sell profit. Click a row → the
  // buyers popover to see who's online + ⚡ trade. Reuses the #tdk-buyers overlay like Happy/Settings do.
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
      // Stage 1 — whole market → shortlist LIQUID, AFFORDABLE items to spend trader-calls on. We can't see live
      // buy-offers in bulk, and bazaar_average lies (it's avg ask, not what a buyer pays), so we rank by price
      // DISPERSION between venues (a cheap ask vs a pricier one) — where transient mispricings actually surface.
      const mk = await gmGet("https://weav3r.dev/api/marketplace?apiKey=" + encodeURIComponent(key), 30000);
      const items = (mk && mk.items) || [];
      const cashCeil = (state.cash && state.cash > 0) ? state.cash : 50e6; // only flips you can actually afford
      const LIQ = 8, SHORTLIST = 30;
      const cand = [];
      items.forEach(function (it) {
        if (!it || it.item_id <= 0) return;                              // skip sets (negative ids)
        const asks = [it.lowest_price, it.market_price].filter(function (v) { return v > 0; });
        if (!asks.length || (it.total_bazaars || 0) < LIQ) return;       // need a buyable ask + real liquidity
        const buy = Math.min.apply(null, asks);
        if (buy > cashCeil) return;                                      // within your budget
        const ref = Math.max.apply(null, asks);
        cand.push({ id: it.item_id, name: it.item_name, buy: buy, buyMk: it.market_price, buyBz: it.lowest_price, disp: ref > buy ? (ref - buy) / buy : 0 });
      });
      cand.sort(function (a, b) { return b.disp - a.disp; });            // most-dispersed (likeliest crossed) first
      const short = cand.slice(0, SHORTLIST);
      if (!short.length) { note.textContent = "No affordable, liquid items to check right now."; setTitle("nothing to scan"); return; }
      note.textContent = "Checking live buy-offers for " + short.length + " liquid, affordable items…";
      // Stage 2 — real highest buy-offer per shortlisted item (traders arrive price-desc → [0] is the best sell).
      const flips = [];
      await Promise.all(short.map(function (c) {
        return gmGet("https://weav3r.dev/api/marketplace/" + c.id + "/traders?apiKey=" + encodeURIComponent(key), 20000)
          .then(function (j) {
            const t = (j && j.traders) || [];
            if (!t.length) return;
            const sell = t[0].price, profit = sell - c.buy;
            if (profit < 1000) return; // skip penny-item noise (huge % but trivial cash)
            flips.push({ id: c.id, name: c.name, buy: c.buy, buyMk: c.buyMk, buyBz: c.buyBz, sell: sell, profit: profit, buyers: j.total_count || t.length });
          }).catch(function () { });
      }));
      flips.sort(function (a, b) { return b.profit - a.profit; });
      if (!flips.length) { note.textContent = "Market's efficient right now — no crossed-market flips (no live buyer is paying above the cheapest listing on the items scanned). Try again later — these appear and vanish fast."; setTitle("no flips right now"); return; }
      const top = flips.slice(0, 12);
      note.textContent = "Finding the cheapest seller for the top " + top.length + " flips…";
      // Stage 3 — buy side: per-item listings give the actual cheapest BAZAAR seller (post-IM2.0 these are hidden,
      // so linking straight to that shop is the edge) plus the fresh Item Market price → make each flip clickable-to-buy.
      await Promise.all(top.map(function (f) {
        return gmGet("https://weav3r.dev/api/marketplace/" + f.id + "?apiKey=" + encodeURIComponent(key), 20000)
          .then(function (j) {
            f.mp = (j && j.market_price > 0) ? j.market_price : f.buyMk;   // fresh Item Market price
            const L = ((j && j.listings) || []).filter(function (x) { return x.price > 0; }).sort(function (a, b) { return a.price - b.price; });
            f.baz = L.length ? L[0] : null;                                // cheapest bazaar seller {player_id, player_name, price, quantity}
          }).catch(function () { f.mp = f.buyMk; f.baz = null; });
      }));
      // Re-price on the fresh buy side, drop any that closed, re-rank.
      top.forEach(function (f) {
        const bazP = f.baz ? f.baz.price : Infinity, mkP = f.mp > 0 ? f.mp : Infinity;
        f.buy2 = Math.min(bazP, mkP); f.bazCheap = bazP <= mkP; f.profit2 = f.sell - f.buy2;
      });
      const finalFlips = top.filter(function (f) { return f.profit2 > 0; }).sort(function (a, b) { return b.profit2 - a.profit2; });
      if (!finalFlips.length) { note.textContent = "Those flips just closed — the cheap listings moved before we could price them. Try again shortly."; setTitle("closed — prices moved"); return; }
      const cat = function (id) { return (state.itemMeta && state.itemMeta[id] && state.itemMeta[id].type) || ""; };
      const rows = finalFlips.map(function (f) {
        const marg = f.buy2 > 0 ? Math.round(f.profit2 / f.buy2 * 100) : 0;
        const warn = marg > 300 ? ' <span class="fwarn" title="Huge margin — likely a stale or fat-finger listing. Verify it\'s still live in-game before buying.">⚠</span>' : '';
        const links = [];
        if (f.baz && f.bazCheap) links.push('<a class="fbuy" href="https://www.torn.com/bazaar.php?userId=' + f.baz.player_id + '" target="_blank" rel="noopener" title="Buy from ' + String(f.baz.player_name || "").replace(/"/g, "") + '’s bazaar — ' + (f.baz.quantity || 0) + ' @ $' + f.baz.price.toLocaleString() + '">🏪 ' + (f.baz.player_name || "bazaar") + '</a>');
        links.push('<a class="fbuy" href="' + marketUrl(f.id, f.name, cat(f.id)) + '" target="_blank" rel="noopener" title="Buy on the Item Market' + (f.mp > 0 ? ' (~$' + f.mp.toLocaleString() + ')' : '') + '">🛒 Market</a>');
        return '<div class="tdk-flip" data-id="' + f.id + '" data-name="' + f.name.replace(/"/g, "") + '">' +
          '<div class="fn">' + f.name + warn + '<div class="fs">buy <b>' + full$(f.buy2) + '</b> ' + links.join(" ") + ' → sell <b>' + full$(f.sell) + '</b> <span>· ' + f.buyers + ' buyers · ⚡ click row to trade</span></div></div>' +
          '<div class="fp"><div class="fpv">+' + money(f.profit2) + '</div><div class="fpm">' + marg + '% /ea</div></div></div>';
      }).join("");
      setTitle("buy low → sell live · top " + finalFlips.length);
      note.outerHTML = '<div class="tdk-sub" style="padding:6px 12px">🏪 = buy from that seller’s bazaar (hidden since Item Market 2.0) · 🛒 = Item Market. Sell via ⚡ (click the row) = a direct trade, no fee. Prices move fast — reconfirm before buying.</div><div id="tdk-flips">' + rows + '</div>';
      bx.querySelectorAll(".tdk-flip .fbuy").forEach(function (a) { a.addEventListener("click", function (e) { e.stopPropagation(); }); }); // buy link shouldn't also open the sell popover
      bx.querySelectorAll(".tdk-flip").forEach(function (el) {
        el.addEventListener("click", function () { openBuyers(+this.getAttribute("data-id"), this.getAttribute("data-name")); });
      });
    } catch (e) {
      const n = bx.querySelector("#tdk-flip-note"); if (n) n.textContent = "Flip scan failed: " + (e.message || e) + " (check your W3B key in ⚙ Settings).";
    }
  }
  /* ---------- 📊 Stock market: portfolio P&L + benefit blocks + buy-low/sell-high (record-and-derive) ----------
     Torn's API gives only the CURRENT price (no history), so — like foreign restock — we record it ourselves.
     Honest framing: stocks have NO predictable cycle, so this is range/trend + your P&L + benefit progress,
     NOT a predictor. It NEVER advises selling a block you're accumulating for its benefit. */
  const STK_MAX = 700, STK_AGE = 14 * 24 * 3600, STK_SAMPLE = 600; // ~2 weeks of ≥10-min samples
  const STK_SELL_FEE = 0.001; // Torn charges 0.1% on SELLING stocks (verified wiki.torn.com/wiki/Stock_Market); buying is free
  function recordStockPrices(mkt) {
    if (!mkt) return;
    let hist; try { hist = GM_getValue("stk_hist", null) || {}; } catch (e) { hist = {}; }
    const now = Math.floor(Date.now() / 1000), cutoff = now - STK_AGE;
    let changed = false;
    Object.keys(mkt).forEach(function (id) {
      const p = mkt[id] && mkt[id].current_price; if (!(p > 0)) return;
      const arr = hist[id] || (hist[id] = []);
      const last = arr[arr.length - 1];
      if (last && now - last[0] < STK_SAMPLE) return;        // at most one sample per ~10 min
      arr.push([now, p]); changed = true;
      while (arr.length && arr[0][0] < cutoff) arr.shift();
      if (arr.length > STK_MAX) arr.splice(0, arr.length - STK_MAX);
    });
    if (changed) { try { GM_setValue("stk_hist", hist); } catch (e) { } }
    state._stkHist = hist;
  }
  function stkStats(id) { // range position + vs-recent-average from recorded history (null until enough points)
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
  // Cross-tab background poll for stock prices (needs the Torn key) — builds price history over time.
  function pollStockPrices() {
    const key = GM_getValue("torn_key", ""); if (!key) return;
    let last = 0; try { last = GM_getValue("stk_poll_at", 0); } catch (e) { }
    if (Date.now() - last < 10 * 60 * 1000 - 4000) return;    // one fetch per ~10 min across tabs
    try { GM_setValue("stk_poll_at", Date.now()); } catch (e) { }
    gmGet("https://api.torn.com/torn/?selections=stocks&key=" + encodeURIComponent(key)).then(function (m) { if (m && m.stocks) { state.stkMkt = m.stocks; recordStockPrices(m.stocks); } }).catch(function () { });
  }
  function stkAvgCost(h) { // weighted average buy price across a holding's transactions
    let sh = 0, cost = 0; const tx = (h && h.transactions) || {};
    Object.keys(tx).forEach(function (k) { sh += tx[k].shares; cost += tx[k].shares * tx[k].bought_price; });
    return sh > 0 ? cost / sh : 0;
  }
  function rangeTag(st) {
    if (st.pos <= 0.2) return '<span class="sktag low">▼ near low</span>';
    if (st.pos >= 0.8) return '<span class="sktag high">▲ near high</span>';
    return '<span class="sktag mid">mid-range</span>';
  }
  // Benefit-aware: a block you're still building is a HOLD — never suggest selling it.
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
    // ---- Your portfolio (live P&L + benefit-block progress) ----
    const holdIds = Object.keys(mine).filter(function (id) { return mine[id] && mine[id].total_shares > 0; });
    let portHtml, totalVal = 0, totalPL = 0, totalFee = 0;
    if (holdIds.length) {
      const body = holdIds.map(function (id) {
        const h = mine[id], s = mkt[id]; if (!s) return '';
        const shares = h.total_shares, cost = stkAvgCost(h), cur = s.current_price;
        const val = cur * shares, pl = (cur - cost) * shares, pct = cost > 0 ? (cur - cost) / cost * 100 : 0;
        const fee = val * STK_SELL_FEE, net = pl - fee; // Torn's 0.1% sell fee (buying is free); its Profit column is GROSS
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
    // ---- Buy-low scanner (all 35, most-below-own-average first once history exists) ----
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
  /* ---------- 🏪 Shop Flips: buy from a Torn city shop (fixed price) → sell on the market for more ----------
     Torn has NO shops API, but the items catalog carries buy_price (the NPC shop price) + market_value.
     Foreign/travel items (present in YATA) are excluded — the main board already covers those. buy_price is a
     catalog CONSTANT (not live stock), so this is a REFERENCE: verify the item's actually stocked in its shop. */
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
      await loadResale(key);                       // catalog: buy_price + market_value + circulation
      const foreign = await ensureForeignIds();    // travel items to exclude
      const meta = state.itemMeta || {};
      const cashCeil = (state.cash && state.cash > 0) ? state.cash : 50e6;
      const cand = [];
      Object.keys(meta).forEach(function (id) {
        const m = meta[id], buy = m.buy || 0, mkt = m.mkt || 0;
        if (!(buy > 0) || !(mkt > 0) || foreign.has(+id)) return;    // shop item, priced, not foreign
        if (buy > cashCeil) return;                                  // affordable
        const spread = mkt - buy, marg = spread / buy;
        if (spread < 500 || marg < 0.08) return;                     // meaningful cash + margin
        cand.push({ id: +id, name: m.name, type: m.type, buy: buy, mkt: mkt, spread: spread, marg: marg });
      });
      cand.sort(function (a, b) { return b.spread - a.spread; });
      const top = cand.slice(0, 20);
      if (!top.length) { setTitle("nothing above threshold"); bx.querySelector(".br").textContent = "No shop→market flips over $500 spread right now."; return; }
      const cat = function (id) { return (meta[id] && meta[id].type) || ""; };
      const rows = top.map(function (c) {
        const marg = Math.round(c.marg * 100);
        const net = c.spread - c.mkt * 0.01;                         // if you SELL on the Item Market (1% fee); trade = fee-free
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
  // WHITELIST: only these no-use commodity types ever get a Sell link. Everything else (Tools, Materials,
  // Enhancers, gear, drugs, anything with an effect/requirement) is held back by default — safer than trying
  // to denylist every use-bearing type (some, like the Cassock, are worth millions). The hasUse guard still
  // holds back any whitelisted item that turns out to carry an effect/requirement.
  const SAFE_TYPES = { Plushie: 1, Flower: 1, Collectible: 1, Artifact: 1, Jewelry: 1, "Supply Pack": 1 };
  // Per-item user overrides win over the type default. Equipped is ALWAYS held back, no matter the override.
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
  // Where the Bag's item list comes from: the live Torn inventory API when it works, else the item counts we
  // scraped off your Items page (data-qty) as you browsed it — so the Bag still aggregates everything sellable
  // in one place while Torn's inventory API is down for their migration. Merged across category tabs already.
  function invItems() {
    const api = state.inv || [];
    if (api.length) return { items: api, source: "api", at: state.invAt };
    const store = GM_getValue("inv_counts", null);
    if (store && store.map && Object.keys(store.map).length) {
      const meta = state.itemMeta || {};
      const items = Object.keys(store.map).filter(function (id) { return store.map[id] > 0; }).map(function (id) {
        const m = meta[id] || {};
        return { ID: +id, id: +id, name: m.name || ("#" + id), type: m.type || "", quantity: store.map[id], equipped: false };
      });
      return { items: items, source: "scan", at: store.at };
    }
    return { items: [], source: "none", at: 0 };
  }
  // Rough value of goods you're holding, from the scraped counts × resale (used by the home bar).
  // foreignOnly=true → count ONLY foreign/travel goods (things you can only get by buying abroad), so the abroad
  // "fly home to sell" nudge reflects an actual TRIP HAUL, not your permanent sellable stash. The scrape is a
  // persistent inventory snapshot and (with Torn's inventory API down) can't tell "bought this trip" from "already
  // owned" — foreign-only is the reliable proxy for a real haul.
  function haulSummary(foreignOnly) {
    const store = GM_getValue("inv_counts", null);
    if (!store || !store.map) return null;
    const prices = state.resale || {}, meta = state.itemMeta || {}, foreign = state.foreignIds;
    if (foreignOnly && (!foreign || !foreign.size)) return { items: 0, count: 0, value: 0 }; // no foreign list yet → don't nudge
    let items = 0, count = 0, value = 0;
    Object.keys(store.map).forEach(function (id) {
      const qty = store.map[id], price = prices[id]; if (!qty || !price) return;
      if (foreignOnly) { if (!foreign.has(+id)) return; } // travel goods are all resale merch — skip the junk whitelist
      else { const m = meta[id] || {}; if (!effSellable(id, m.type, m.hasUse, false)) return; }
      items++; count += qty; value += price * qty;
    });
    return { items: items, count: count, value: value };
  }
  // "Open into items" supply packs — contents compiled from wiki.torn.com (current, Mar 2026), priced LIVE via the
  // Torn items catalog (state.resale). Two shapes: "draws" = N independent draws from a same-category pool;
  // "oneof" = one bundle chosen among several. EV assumes equal odds (Torn doesn't publish drop rates), so where the
  // pool value-spread is wide (a rare high-value drop dominates the mean) we DON'T give a confident verdict — we flag
  // it a gamble instead of wrongly shouting "open". Item names must match the catalog exactly (resolver falls back to
  // case-insensitive); a name that doesn't resolve → no hint for that pack rather than a wrong one.
  const PACK_MODELS = {
    "Six-Pack of Alcohol": { kind: "draws", n: 6, pool: ["Bottle of Kandy Kane", "Bottle of Pumpkin Brew", "Bottle of Minty Mayhem", "Bottle of Wicked Witch", "Bottle of Mistletoe Madness", "Bottle of Stinky Swamp Punch"] },
    "Six-Pack of Energy Drink": { kind: "draws", n: 6, pool: ["Can of Munster", "Can of Santa Shooters", "Can of Red Cow", "Can of Rockstar Rudolph", "Can of Taurine Elite", "Can of X-MASS"] },
    "Box of Medical Supplies": { kind: "oneof", outcomes: [[20, "Morphine"], [20, "Empty Blood Bag"], [30, "First Aid Kit"], [50, "Small First Aid Kit"]] },
    "Box of Grenades": { kind: "oneof", outcomes: [[100, "Grenade"], [100, "HEG"]] }
  };
  function nameToId(nm) {
    const meta = state.itemMeta || {};
    if (state._nameIdFor !== meta) { // (re)build a name→id index whenever the catalog reference changes
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
  // ---- Empirical pack data (shared by A: manual seed + B: Torn-log sync) ----
  // GM "pack_data" = { <packName>: { manual?: {opens:N, items:{id:qty}}, log?: [{ts, id, items:{id:qty}}], lastLogTs? } }
  // items = TOTAL received quantity of each content item id. EV is always odds × LIVE prices, so it never stales.
  function getPackData() { return GM_getValue("pack_data", {}) || {}; }
  function setPackData(d) { GM_setValue("pack_data", d); }
  // Combine the manual aggregate (EV point only) with logged per-open records (EV + a real confidence interval).
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
    if (perOpen.length >= 3) { // need a few real opens for a meaningful interval
      const mean = perOpen.reduce(function (a, b) { return a + b; }, 0) / perOpen.length;
      const varr = perOpen.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (perOpen.length - 1);
      ci = 1.96 * Math.sqrt(varr / perOpen.length);
    }
    return { ev: ev, opens: opens, ci: ci, logged: perOpen.length, manual: !!(pd.manual && pd.manual.opens) };
  }
  // Informational open-vs-sell reference for a pack row (sellPrice = the pack's own market value). "" for non-packs.
  // Deliberately NOT a buy/sell verdict: real drop odds aren't published, and an equal-odds EV is provably biased for
  // weighted/tiered packs (user's own torn.report data confirmed it — Grenades under-, Alcohol over-estimated). So we
  // show the equal-odds EV as a clearly-labeled rough reference + contents, flag wide-spread pools as a gamble, and
  // point to torn.report for the empirical call.
  function packHintHtml(name, sellPrice) {
    if (!PACK_MODELS[name]) return "";
    const edit = ' <span class="tdk-pkedit" data-pack="' + escAttr(name) + '" title="Enter your real drop odds (from torn.report) or sync from your Torn log">✎</span>';
    // Prefer YOUR real data (manual seed and/or logged opens) — an actual verdict, priced live. CI comes from logged opens.
    const emp = packEmpirical(name);
    if (emp && sellPrice) {
      let verdict, cls;
      if (emp.ci != null) { // confident only once the interval clears the sell price
        if (emp.ev - emp.ci > sellPrice) { verdict = "OPEN"; cls = "open"; }
        else if (emp.ev + emp.ci < sellPrice) { verdict = "SELL"; cls = "sell"; }
        else { verdict = "need more data"; cls = "even"; }
      } else { // point estimate (manual, or <3 logged) — softer 5% band
        const r = emp.ev / sellPrice;
        verdict = r >= 1.05 ? "OPEN" : r <= 0.95 ? "SELL" : "≈ even";
        cls = r >= 1.05 ? "open" : r <= 0.95 ? "sell" : "even";
      }
      const src = emp.logged ? (emp.manual ? 'n=' + emp.opens + ' log+manual' : 'n=' + emp.opens + ' logged') : 'n=' + emp.opens + ' manual';
      let txt = '🎁 open-EV ~' + money(emp.ev) + (emp.ci != null ? ' ±' + money(emp.ci) : '') + ' vs sell ' + money(sellPrice) + ' → ' + verdict + ' <span class="tdk-pkm">' + src + '</span>';
      return '<div class="cy tdk-pk ' + cls + '" title="Your real drop odds × live prices. Verdict turns confident once the ± interval clears the sell price.">' + txt + edit + '</div>';
    }
    // No data yet → equal-odds reference (labeled rough), + the ✎ to add your odds.
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
      state.invAt = 0; // in-flight inventory is hidden by Torn — don't cache it past landing
      const m = Math.floor(arriveIn / 60), s = arriveIn % 60;
      const eta = m > 0 ? m + "m " + s + "s" : s + "s";
      box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk</div>' +
        '<div class="p">✈ In flight to ' + (tv.destination || "destination") + '</div>' +
        '<div class="k">Torn hides your inventory while traveling — land first, then reopen 📦 Bag. Arriving in ~' + eta + '.</div></div>';
      return;
    }
    if (!state.resale || !state.itemMeta) { try { await loadResale(key); } catch (e) { /* paint with what we have */ } }
    paintInv();
  }
  function paintInv() {
    const box = host.querySelector("#tdk-inv"); if (!box) return;
    const src = invItems();                       // API when live, else scraped Items-page counts
    const items = src.items, priceMap = state.resale || {}, meta = state.itemMeta || {};
    const idOf = function (it) { return it.ID || it.id || it.item_id; };
    const priceOf = function (it) { return priceMap[idOf(it)] || it.market_price || 0; };
    const metaOf = function (it) { return meta[idOf(it)] || {}; };
    const typeOf = function (it) { return metaOf(it).type || it.type || "—"; };
    const sell = [], keep = [];
    items.forEach(function (it) {
      const price = priceOf(it); if (price <= 0) return;
      const id = idOf(it), m = metaOf(it);
      const s = effSellable(id, typeOf(it), m.hasUse, it.equipped);
      (s ? sell : keep).push({ id: id, name: it.name, type: typeOf(it), qty: it.quantity, unit: price, total: price * it.quantity, ov: !!state.ov[id] });
    });
    sell.sort(function (a, b) { return b.total - a.total; });
    keep.sort(function (a, b) { return b.total - a.total; });
    const esc = function (s) { return String(s || "").replace(/"/g, "&quot;"); };
    const rowsHtml = function (arr, sellable) {
      return arr.map(function (x) {
        const tog = '<span class="tdk-tog" data-id="' + x.id + '" data-eff="' + (sellable ? 1 : 0) + '" title="' + (sellable ? 'Mark as keep' : 'Allow selling this item') + (x.ov ? ' — override set' : '') + '">' + (sellable ? '🔒' : '🔓') + '</span>';
        // 🧺 open-market + ⚡ find-buyers only on sell-ok rows (held-back items are lock-only — no sell path by mistake).
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
    const b = host.querySelector("#tdk-invbtn"); if (b) b.classList.toggle("on", v === "inv"); // classList so the "ready" glow survives
    const f = host.querySelector("#tdk-fund"); if (f) f.classList.toggle("on", v !== "inv" && state.fund); // Fund lit only while viewing the board
    if (v === "inv") renderInv(); else render();
  }
  // Torn's inventory API is empty during their 2026 migration. Poll quietly; when it returns items again, glow the Bag.
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
      if (flying) return; // inventory is legitimately empty in transit — not a migration signal
      const ready = items.length > 0, was = state.invReady;
      state.invReady = ready;
      markBagReady(ready);
      if (ready && was === false && panel && panel.classList.contains("open")) {
        setStatus("📦 Torn's inventory API is back — the Bag works now!");
      }
    } catch (e) { /* keep last known state */ }
  }
  const CHANGELOG = [
    { v: "1.32.1", d: "Aug 4, 2026", c: ["The 'Profit ×N' full-load column is now sortable too (click the header). It sorts the same as Profit/ea since it's just that × your cap"] },
    { v: "1.32.0", d: "Aug 4, 2026", c: ["Added a 'Profit ×N' column right after Profit/ea — the total profit for a full load at your Cap (profit/ea × cap, e.g. ×23), before airfare. The header updates when you change Cap. Makes the per-trip payoff obvious at a glance"] },
    { v: "1.31.0", d: "Aug 4, 2026", c: ["✈ In-flight countdown + auto-land refresh: while flying, the banner now counts down 'Landing in 4:12' live, and the panel auto-refreshes the moment you touch down — so your 15s immunity timer starts on its own, no manual refresh needed (refresh once after takeoff to arm it). The OC 'ready in…' banner now also ticks down live every second"] },
    { v: "1.30.0", d: "Aug 4, 2026", c: ["🛡️ Landing-immunity countdown: Torn gives you 15 seconds of attack immunity when you land (abroad or back in Torn). The board now shows a live-ticking '🛡️ Immunity: 12s' banner right after you land (pulsing green), then a red 'you're exposed — shelter your cash' note when it lapses. Ticks off your arrival time; hit Refresh the moment you land to catch the full window. (This is the window that got away while you were buying Pearls)"] },
    { v: "1.29.0", d: "Aug 4, 2026", c: ["⛔ OC flight guard: if you're in a faction Organized Crime, the board now shows how long until it's ready ('⏰ OC ready in 9h 12m') and flags any destination whose ROUND TRIP is longer than that with a ⛔ OC badge + strike-through — because if you're flying when the crime is ready you BLOCK the whole thing (you must be in Torn, not Traveling/Hospital/Jail). Best of all it reads the OC from the API, which still works while you're abroad/hospitalized — exactly when Torn hides the OC from you. Uses ready_at (when planning completes); fails safe by warning early"] },
    { v: "1.28.0", d: "Aug 4, 2026", c: ["🛒 The 'fly home to sell' nudge now reads Torn's OWN trip counter off the travel page ('You have purchased N / 23 items so far') — the reliable source of what you've actually bought this trip. So it shows real slot progress (e.g. '15/23 slots filled — fly home'), stays quiet at 0/23, and never invents a haul total from stale inventory again. Works even though your inventory/Items page is blocked while abroad"] },
    { v: "1.27.1", d: "Aug 4, 2026", c: ["Fixed the false 'Got your haul? Fly home to sell' nudge that showed abroad even when you'd bought nothing — it was counting your whole sellable STASH (from the scraped inventory snapshot), not this trip's purchases. It now counts only foreign/travel goods (things you can only get by buying abroad), so it stays quiet until you're actually carrying a haul"] },
    { v: "1.27.0", d: "Aug 4, 2026", c: ["🏪 Shop Flips: a new header button that finds Torn city-shop items (Big Al's, Bits 'n' Bobs, the car dealership, sweet shop, etc.) whose fixed shop price is below their market value — buy low at the shop, sell higher on the market. Uses the item catalog's buy_price vs market_value, excludes travel items (the board covers those), ranks by cash spread, and shows the net after the 1% Item Market sell fee. Reference-only: shop price is a catalog constant, so verify the item's actually stocked (limited stock/caps/restocks). Click a row for buyers, 🛒 to open the Item Market"] },
    { v: "1.26.0", d: "Aug 4, 2026", c: ["💱 Flips are now one-click actionable: each flip shows a 🏪 link straight to the cheapest seller's bazaar (these are hidden from search since Item Market 2.0 — that's the edge) and a 🛒 Item Market link, so you can jump right to buying. It re-prices on the live cheapest listing before showing, drops any that already closed, and reminds you the ⚡ sell is a direct trade (no fee)"] },
    { v: "1.25.1", d: "Aug 4, 2026", c: ["📊 Stocks now shows your NET-after-fee P&L: Torn's Profit figure is gross, but selling costs a 0.1% fee (verified on the Torn wiki — buying is free). Each holding shows 'net if sold now' after that fee, and the portfolio header totals both gross and net — so you see what you'd actually pocket (e.g. ~$12k fee on a $12.1M IST sale)"] },
    { v: "1.25.0", d: "Aug 4, 2026", c: ["📊 Stocks: a new header button with (1) YOUR portfolio — live P&L per holding + a benefit-block progress bar (e.g. 'IST 22% → free education; 77,882 more ≈ $42.6M'), and (2) a buy-low scanner across all 35 stocks ranked by how far each sits below its own recent average, with ▼near-low / ▲near-high tags. Torn gives no price history, so — like restock — it records prices itself (~10-min background poll); trend/range signals fill in as history builds. It's benefit-AWARE: it never tells you to sell a block you're still accumulating. Honest by design: prices tick constantly (figures are as-of-pull, reconcile to Torn on reopen) and signals are range/trend heuristics, NOT predictions"] },
    { v: "1.24.0", d: "Aug 4, 2026", c: ["💱 Quick Flips: a new header button that hunts genuine 'crossed market' arbitrage — an item you can BUY (Item Market / bazaar) for less than a LIVE trader is offering to BUY it from you, no travel. It scans the whole weav3r market, shortlists the most liquid + affordable items (where transient mispricings actually appear), then pulls real buy-offers and shows ONLY real, positive flips — ranked by profit/ea. Click one to see who's online + ⚡ trade. These are rare and get snapped up fast, so it honestly says 'market's efficient' when there's nothing — it never invents profit. Reconfirm prices before you buy"] },
    { v: "1.23.0", d: "Aug 4, 2026", c: ["✈ In-flight pre-focus: while you're flying TO a country, the board now auto-focuses on that destination (blue ✈ chip) so you can plan your buy before you land — the status line shows 'heading to X · land in Ym'. Flying home goes back to All. Pick another chip and it sticks until your next leg", "📈 Restock history now keeps ~2 days per item (was ~20h) so the trends have room to show full restock cycles"] },
    { v: "1.22.0", d: "Aug 4, 2026", c: ["📈 Restock tracking (foundation): the board now quietly records each item's stock level over time (YATA only gives a live number, no history, so we build our own). A ▲/▼ appears by the Stock chip once there are two samples — ▲ restocked, ▼ being bought (hover for the rate). It polls in the background about every 5 min (shared across your open Torn tabs) so history builds even when you're not looking. This is the groundwork for 'what'll likely be in stock when I land' — predictions come once it has enough data"] },
    { v: "1.21.0", d: "Aug 3, 2026", c: ["🎁 Supply packs now support YOUR real drop odds — priced live, so opening becomes a real OPEN/SELL verdict instead of a rough equal-odds guess. Click ✎ on a pack row to (A) enter opens + what you received (straight from torn.report), or (B) ⟳ Sync from Torn log to pull your actual opens automatically. EV = your odds × live prices (never stales); with enough logged opens it shows a ± confidence interval and only calls OPEN/SELL once that interval clears the sell price — otherwise 'need more data (n=…)'. Packs with no data yet keep the equal-odds reference", "Note: the Torn-log sync is beta — it self-discovers the log type and, if the entry format doesn't match, dumps a sample to the console (F12) to finish wiring"] },
    { v: "1.20.0", d: "Aug 3, 2026", c: ["🎁 Supply-pack open-vs-sell reference in the Bag: for the 'open into items' packs (Six-Pack of Alcohol/Energy, Box of Medical Supplies, Box of Grenades) each row now shows a rough open-EV — the pack's contents (from the Torn wiki) priced live × the items catalog — next to its sell price, so you can eyeball whether opening is even in the ballpark. Contents with a wide value spread are flagged ⚠ gamble. Deliberately NOT a hard buy/sell verdict: Torn doesn't publish drop odds and they aren't uniform, so an equal-odds estimate is only a reference — the footnote links to torn.report for the empirical, per-pack call"] },
    { v: "1.19.2", d: "Aug 2, 2026", c: ["📦 Bag no longer over-reports sold items: the scraped snapshot now reconciles as you browse — opening a category tab lists all of that category's items, so anything you've since sold/used (or that shows qty 0) is dropped instead of lingering. Added a ↻ Rescan button + a 'snapshot Nm old' age so you can wipe & rebuild it for odd cases the API-down snapshot can't see"] },
    { v: "1.19.1", d: "Aug 2, 2026", c: ["📦 Bag readability: the Qty × Sell column was inheriting Torn's dark cell color and was hard to read — gave it an explicit light tone"] },
    { v: "1.19.0", d: "Aug 2, 2026", c: ["🏠 Home / sell-side helper: standing in Torn, the status line shows 🏠 Home and a green bar summarizes your sellable haul (item count + ~value) with a one-click 📦 Sell haul jump to the Bag. Landed abroad, a gold bar reminds you to fly home to sell — with a ✈ Return to Torn link and, when known, the value of sellable goods you're carrying", "📦 Bag now works even while Torn's inventory API is down — it falls back to the item counts scraped from your Items-page visits, so every sellable item across all categories lands in one place instead of clicking each type in Torn's own UI", "📦 Bag rows redesigned: Item · Category (with a type icon) · Qty × Sell · Expected $, plus per-row 🧺 open-market and ⚡ find-buyers (sell-ok items only — held-back items stay lock-only)"] },
    { v: "1.18.1", d: "Aug 2, 2026", c: ["📍 Abroad auto-focus now works even when you're hospitalized abroad (or jailed) — it reads the country from your travel data, not just the 'Abroad' status, so a mugging that lands you in a foreign hospital no longer drops the board back to All", "Header fixed: ↻ Refresh and ⚙ now sit on their own stable row (Refresh + ⚙ pinned left; Cap / A− / A+ on the right) so they stop shuffling around as the font size or button widths change"] },
    { v: "1.18.0", d: "Aug 2, 2026", c: ["📍 Abroad auto-focus: when you're standing in a foreign country the board defaults to that destination's items automatically (the chip shows 📍 and glows green), so you see what to buy right where you are. Pick another chip and it sticks until you move; fly home → back to All"] },
    { v: "1.17.1", d: "Aug 2, 2026", c: ["⚡ Find-buyers stays on sell-ok items only (default junk, or ones you've toggled to sell) — held-back items are lock-only, so there's no path to sell a use-item by mistake"] },
    { v: "1.17.0", d: "Aug 2, 2026", c: ["Net-profit in the Buyers popover: for travel-trade goods each buyer's total now shows 'net +$X' (sell − your foreign buy cost × qty), updates live with quantity, and 📋 copies it into the trade line too"] },
    { v: "1.16.1", d: "Aug 2, 2026", c: ["Gym-estimate energy box is now capped to your energy maximum (can't enter impossible values like 206)"] },
    { v: "1.16.0", d: "Aug 2, 2026", c: ["⏱ Round-trip time filter: a dropdown by the destination chips limits the board to destinations you can fly there-and-back within your window (≤1h … ≤10h) — e.g. only 2 hours → Mexico/Cayman/Canada. Each row now shows its round-trip time too"] },
    { v: "1.15.0", d: "Aug 2, 2026", c: ["Sortable board columns: click a header to sort. Click Stock → in-stock items first (then $/min) so you see what's actually buyable; $/min, Profit/ea, Buy, Resale, Load also sortable. The 'Best' card still uses profit order. Your choice is saved"] },
    { v: "1.14.0", d: "Aug 2, 2026", c: ["😊 Happy now includes a gym-gain ESTIMATE (Vladar formula): pick a stat, set energy, and it projects per-train + total gain at your jumped happy in your active gym — pulls your stats/gym live. Rough by design (Torn hides the real formula; excludes Steadfast/education perks; happy decays as you train)"] },
    { v: "1.13.1", d: "Aug 2, 2026", c: ["Trade-description autofill now properly enables the Initiate Trade button — fires a full keydown/input/keyup/change burst so Torn's form registers the text (no more erase-a-digit-and-retype)"] },
    { v: "1.13.0", d: "Aug 2, 2026", c: ["😊 Happy Jump calculator: live 'happy resets in M:SS' timer (the :00/:15/:30/:45 reset), your current/base happy, your held candy/drug/eDVD boosters (auto-detected) with an Ecstasy ×2 toggle, and the max happy + optimal eat/take order (99,999 cap). All values verified from the Torn wiki"] },
    { v: "1.12.0", d: "Aug 2, 2026", c: ["Trade-description autofill: click ⇄ Trade (or ⚡) on a buyer, then on the trade page a '📋 Fill description' button drops the exact trade line into Torn's required description box. Text-only + you press Initiate Trade — no item/money automation"] },
    { v: "1.11.3", d: "Aug 2, 2026", c: ["Buyers/changelog window now floats over the page at near-full height instead of being clipped short by the panel (especially when opened via ⚡ before refreshing) — drag any edge to resize"] },
    { v: "1.11.2", d: "Aug 2, 2026", c: ["Fixed the item.php ⚡ only showing on the last row — moved it next to the item name (the action cell was too cramped and it clipped)", "Changelog / buyers window is taller and you can drag its bottom edge to resize it"] },
    { v: "1.11.1", d: "Aug 2, 2026", c: ["Hover tooltips on the board's ★ (affordable & in stock) and 💰 (best funded play) row markers so it's clear what they mean"] },
    { v: "1.11.0", d: "Aug 2, 2026", c: ["⚡ on each sellable item.php row (next to the 🧺 basket): click it right in Torn's own Items list to open that item's buyers + quantity calculator + trade-best-online — no more opening the board and hunting for the item"] },
    { v: "1.10.0", d: "Aug 2, 2026", c: ["Buyers popover now has a quantity calculator: prices show /ea, every buyer shows a live running total, and 📋 copies a paste-ready trade line (e.g. 'Ambergris Lump ×23 @ $430,000/ea = $9,890,000')", "'You have N' item count — and since Torn's inventory API is down, it's scraped from your Items page (data-qty) as you browse it, so counts work anyway (marked * when from that snapshot)"] },
    { v: "1.9.5", d: "Aug 2, 2026", c: ["Fund from the Bag now switches straight to the funded board in one click (it used to toggle fund off and need a second click) — Bag/Fund behave like proper tabs now"] },
    { v: "1.9.4", d: "Aug 2, 2026", c: ["'Incorrect key' errors on the board and in the Bag now show a clickable link straight to ⚙ Settings to update the key"] },
    { v: "1.9.3", d: "Aug 2, 2026", c: ["📦 Bag auto-recheck: the tool quietly polls every 15 min and the Bag button glows green the moment Torn's inventory API comes back online", "Added a Test button for the W3B key in Settings too", "Really fixed Fund/Bag: only one lights at a time now (Fund lit only while viewing the board)"] },
    { v: "1.9.2", d: "Aug 2, 2026", c: ["Truth in messaging: the empty 📦 Bag is Torn's fault, not yours — Torn's inventory API is temporarily returning empty for everyone during their inventory-system migration. No key (even Full) can read it until Torn restores the endpoint. Settings/Bag now say so instead of blaming your key"] },
    { v: "1.9.1", d: "Aug 2, 2026", c: ["Moved the ✕ close to the top-right corner so it stops wrapping to a second line; tightened header buttons", "Fixed the Settings key-test advice: inventory needs a Full key (or a Custom key with Inventory ticked) — Limited isn't enough, and everything else works on Limited"] },
    { v: "1.9.0", d: "Aug 2, 2026", c: ["New ⚙ Settings: view/update your Torn + W3B keys and Test the Torn key — shows its access level and whether it can actually read your inventory (diagnoses the empty 📦 Bag)", "Fund now switches you out of the Bag view instead of leaving both buttons lit", "Buy / Resale / Load columns are readable — they were inheriting Torn's dark td color"] },
    { v: "1.8.0", d: "Aug 2, 2026", c: ["Click a board row → Buyers now shows each buyer's 🟢/🟡/⚫ online status (via Torn API) and a one-click ⚡ 'Trade best online' button for the best offer from someone actually around", "Added a ✕ close button to the panel header + raised the 💰 toggle above the panel (fixes not being able to close it)", "Readable board again: brighter item names, lifted dim opacity"] },
    { v: "1.7.4", d: "Aug 2, 2026", c: ["Fund advice is now stocks-aware: reads your actual stock value (networth) and only suggests a 'funded' play you can truly reach with cash+stocks — no more 'sell $229M in stocks' when you don't have it", "Inline tag moved inside the item name to stop rows wrapping to two lines"] },
    { v: "1.7.3", d: "Aug 2, 2026", c: ["Panel now anchors to the top and caps its height to the window (zoom-aware) — the header/Refresh are always reachable, no more overshooting the top of the page", "Dimmed (unaffordable) rows are readable again — bumped opacity so item + buy/resale text isn’t washed out when you’re low on cash"] },
    { v: "1.7.2", d: "Aug 2, 2026", c: ["Click any 🔒/💰 tag (on item.php or in the Bag) to toggle keep ⇄ sell-ok — saved permanently, so you curate your own safe list (equipped items always stay kept)", "Inline tag is now icon-only (value in tooltip) so it no longer wraps item rows to two lines", "Reset-overrides button in the changelog; Bag Sell links now use the current ItemMarket URL"] },
    { v: "1.7.1", d: "Aug 2, 2026", c: ["Supply Packs (e.g. Coin Purse) are now sellable — they carry no use, and unopened packs often beat their contents. Suitcases/Cassock stay held back (they're Enhancers/Tools)"] },
    { v: "1.7.0", d: "Aug 2, 2026", c: ["Inline tags on the Items page (item.php): every row shows 💰 market value on plain-junk (with a 🧺 Open-Market basket) or 🔒 on use-items — your don’t-sell-by-mistake guard, right in Torn’s own list"] },
    { v: "1.6.6", d: "Aug 2, 2026", c: ["📦 Bag safety overhaul: only plain-junk types (plushie/flower/collectible/artifact/jewelry) get a Sell link; Tools, Materials, Enhancers, Special/Temporary, gear, and anything with an effect/requirement are shown in a 🔒 Held-back group with NO Sell link — so pricey use-items (Large Suitcase, Cassock, etc.) can't be sold by mistake"] },
    { v: "1.6.5", d: "Aug 2, 2026", c: ["Fixed 📦 Bag false 'clean bags' — items are now priced from the Torn items catalog (market_value), not the inventory field that was always 0", "When nothing matches, shows how many items were scanned instead of a misleading all-clear"] },
    { v: "1.6.4", d: "Aug 2, 2026", c: ["🔄 Check-for-updates button in the changelog (click the version) — compares against GitHub and gives a one-click Install link when a newer version exists"] },
    { v: "1.6.3", d: "Aug 2, 2026", c: ["Fixed 📦 Bag stuck on 'loading inventory…' (inventory now coerced to an array)", "Board no longer dead-ends: when nothing is affordable + full-stock it shows the Best available play + what's blocking it"] },
    { v: "1.6.2", d: "Aug 2, 2026", c: ["📦 Bag detects when you're flying (Torn hides inventory in transit) — shows arrival countdown instead of an empty list"] },
    { v: "1.6.1", d: "Aug 2, 2026", c: ["Clearer message when YATA is down (502/timeout) instead of raw error", "Longer 30s timeout for YATA's heavy export"] },
    { v: "1.6.0", d: "Aug 1, 2026", c: ["Bigger-text controls (A− / A+)", "Sellable-Junk inventory view (📦 Bag)", "Clickable version → this changelog"] },
    { v: "1.5.0", d: "Aug 1, 2026", c: ["weav3r trader prices — click a row for top buyers", "One-click ⇄ Trade + profile links"] },
    { v: "1.4.0", d: "Aug 1, 2026", c: ["Fly-here (✈) links per row", "Live mug-risk readout", "GitHub hosting + auto-update"] },
    { v: "1.3.0", d: "Aug 1, 2026", c: ["Fund mode — surfaces the best plays even when over budget, with a 'sell $X in stocks' reminder + shortfall badges"] },
    { v: "1.2.0", d: "Aug 1, 2026", c: ["CSP-safe styling + broader page matching (fixed the invisible panel)"] },
    { v: "1.1.0", d: "Aug 1, 2026", c: ["Destination filter chips (All + per-country)"] },
    { v: "1.0.0", d: "Aug 1, 2026", c: ["Initial release — live $/min board (YATA stock × Torn resale), affordability + best pick"] }
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
  // Flat happy per item — verified from the Torn wiki (wiki.torn.com/wiki/Happy), Aug 2026.
  const HAPPY_ITEMS = {
    "Bag of Bon Bons": 25, "Bag of Chocolate Kisses": 25, "Box of Bon Bons": 25, "Box of Extra Strong Mints": 25, "Box of Sweet Hearts": 25, "Lollipop": 25, "Box of Chocolate Bars": 25,
    "Big Box of Chocolate Bars": 35, "Bag of Candy Kisses": 50, "Chocolate Egg": 50, "Bag of Bloody Eyeballs": 75, "Bag of Tootsie Rolls": 75, "Bag of Chocolate Truffles": 100, "Bag of Reindeer Droppings": 100,
    "Bag of Humbugs": 150, "Bag of Sherbet": 150, "Jawbreaker": 150, "Pixie Sticks": 150, "Birthday Cupcake": 250,
    "Shrooms": 500, "PCP": 250, "Xanax": 75, "Vicodin": 75, "Speed": 50, "Erotic DVD": 2500, "Feathery Hotel Coupon": 500
  };
  const HAPPY_CAP = 99999;
  function calcHappy(start, flat, ecstasy) {
    if (!ecstasy) return Math.min(HAPPY_CAP, start + flat);
    const beforeFlat = Math.min(flat, Math.max(0, Math.floor(HAPPY_CAP / 2) - start)); // fill toward cap/2, double, then add rest
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
    const gymBlock = (stats && gym) ? (
      '<div class="hsec hgymhdr" style="margin-top:12px;border-top:1px dashed #3a3729;padding-top:8px">Gym gain estimate <small>— ' + (gym.name || "gym") + ' · ' + gym.energy + 'E/train · rough</small></div>' +
      '<div class="hstats">' + Object.keys(STAT_KEYS).map(function (s) {
        const dots = (gym[STAT_KEYS[s]] || 0) / 10;
        return '<button class="hstat' + (s === defStat ? " on" : "") + '" data-stat="' + s + '" data-dots="' + dots + '" data-val="' + stats[s] + '"' + (dots <= 0 ? " disabled" : "") + '>' + s.slice(0, 3) + ' ' + (dots > 0 ? "(" + dots.toFixed(1) + ")" : "—") + '</button>';
      }).join("") + '</div>' +
      '<div class="hrow"><label>Energy to spend</label><input class="hqty" id="tdk-hen" type="number" min="' + gym.energy + '" max="' + energyMax + '" value="' + Math.min(energyMax, (energyNow && energyNow > 0 ? energyNow : energyMax)) + '"><span class="hv">max ' + energyMax + '</span></div>' +
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
        gymBlock +
      '</div>';
    bindClose(bx);
    // Vladar gym-gain formula (verified from Torn wiki) — happy decays ~50% of energy per train.
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
      const enEl = bx.querySelector("#tdk-hen"), energy = Math.max(gym.energy, Math.min(energyMax, parseInt(enEl && enEl.value, 10) || energyMax));
      const est = estGym(dots, statVal, lastHappy, energy, gym.energy);
      res.innerHTML = '~<b>+' + fmtG(est.perStart) + '</b> ' + statName + '/train @ ' + lastHappy.toLocaleString() + ' happy · total <b>~+' + fmtG(est.total) + '</b> from ' + energy.toLocaleString() + 'E <span class="hv">(' + est.trains + ' trains, happy decaying)</span>';
    };
    bx.querySelectorAll(".hstat").forEach(function (b) { b.addEventListener("click", function () { if (this.disabled) return; bx.querySelectorAll(".hstat").forEach(function (x) { x.classList.remove("on"); }); this.classList.add("on"); updateGymEst(); }); });
    const enEl = bx.querySelector("#tdk-hen"); if (enEl) enEl.addEventListener("input", updateGymEst);
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
      lastHappy = final; updateGymEst();
    };
    bx.querySelectorAll(".hqty, #tdk-hecs").forEach(function (el) { el.addEventListener("input", recompute); el.addEventListener("change", recompute); });
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
        '<div class="srow"><button class="tdk-btn2" id="tdk-set-save">Save keys</button><span id="tdk-set-msg" class="ssub"></span></div>' +
        '<div id="tdk-set-out" class="ssub"></div>' +
        '<div class="sl" style="margin-top:14px">Need a key? <a class="prof" href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener">Torn → Settings → API Keys</a>. Note: the 📦 Bag needs Torn’s inventory API, which is temporarily disabled during Torn’s inventory migration — no key fixes that until Torn restores it.</div>' +
      '</div>';
    bindClose(bx);
    host.querySelector("#tdk-set-save").addEventListener("click", function () {
      GM_setValue("torn_key", host.querySelector("#tdk-set-torn").value.trim());
      GM_setValue("w3b_key", host.querySelector("#tdk-set-w3b").value.trim());
      state.inv = null; state.resale = null; state.itemMeta = null; state.cash = null; state.stocks = null;
      host.querySelector("#tdk-set-msg").textContent = " Saved ✓ — caches cleared, hit Refresh";
    });
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
  function openChangelog() {
    const bx = host.querySelector("#tdk-buyers");
    const ovCount = Object.keys(state.ov).length;
    bx.classList.add("open");
    bx.innerHTML = '<div class="tdk-bh"><div class="tt">Changelog<small> — Torn Trade Desk</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>' +
      '<div class="tdk-upbar"><button class="tdk-btn2" id="tdk-updbtn" title="Check GitHub for a newer version">🔄 Check for updates</button><span class="tdk-upd" id="tdk-upd">v' + curVersion() + '</span></div>' +
      (ovCount ? '<div class="tdk-upbar tdk-upbar2"><button class="tdk-btn2" id="tdk-ovreset" title="Clear every keep/sell-ok override you\'ve set">↺ Reset ' + ovCount + ' override' + (ovCount > 1 ? 's' : '') + '</button></div>' : '') +
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
    bindClose(bx);
  }
  // A: manual odds editor — enter opens + total received per content item (straight from torn.report). Reuses overlay.
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
  // B: pull your real supply-pack opens from the Torn API log. Self-discovers the log type; parses defensively and,
  // if the entry shape doesn't match, dumps a sample to the console so the parser can be finalized. Non-destructive.
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
          if (hay.toLowerCase().indexOf(name.toLowerCase()) < 0) return; // not this pack
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
      '<div class="tdk-hd">' +
        '<div class="tdk-h">' +
          '<div class="t">Trade Desk<small>Torn · $/min · <span class="tdk-ver" id="tdk-ver" title="View changelog">v' + (typeof GM_info !== "undefined" && GM_info.script ? GM_info.script.version : "") + '</span></small></div><div class="sp"></div>' +
          '<button class="tdk-btn2" id="tdk-invbtn" title="Toggle your sellable-junk inventory">📦 Bag</button>' +
          '<button class="tdk-btn2" id="tdk-fund" title="Show top plays even if over budget — reminds you to free up cash first">💰 Fund</button>' +
          '<button class="tdk-btn2" id="tdk-happy" title="Happy-jump calculator — max happy, best order &amp; reset timer">😊 Happy</button>' +
          '<button class="tdk-btn2" id="tdk-flip" title="Quick flips — buy cheap, sell to the highest live trader">💱 Flip</button>' +
          '<button class="tdk-btn2" id="tdk-shop" title="Shop flips — Torn city-shop items worth more on the market">🏪 Shop</button>' +
          '<button class="tdk-btn2" id="tdk-stk" title="Stocks — your P&amp;L, benefit-block progress, buy-low scanner">📊 Stocks</button>' +
          '<button class="tdk-btn2 tdk-x" id="tdk-close" title="Close panel">✕</button>' +
        '</div>' +
        '<div class="tdk-h2">' +
          '<button class="tdk-btn2" id="tdk-refresh">↻ Refresh</button>' +
          '<button class="tdk-btn2" id="tdk-settings" title="Settings — API keys &amp; options">⚙</button>' +
          '<div class="sp"></div>' +
          'Cap <input class="tdk-cap" id="tdk-cap" type="number" min="1" max="60" value="' + state.cap + '">' +
          '<button class="tdk-btn2 tdk-sm" id="tdk-adec" title="Smaller text">A−</button>' +
          '<button class="tdk-btn2 tdk-sm" id="tdk-ainc" title="Bigger text">A+</button>' +
        '</div>' +
      '</div>' +
      '<div class="tdk-status" id="tdk-status">Click Refresh to pull live data.</div>' +
      '<div id="tdk-board">' +
        '<div class="tdk-imm" id="tdk-immunity" style="display:none"></div>' +
        '<div class="tdk-homebar" id="tdk-homebar" style="display:none"></div>' +
        '<div class="tdk-oc" id="tdk-oc" style="display:none"></div>' +
        '<div class="tdk-filter" id="tdk-filter"></div>' +
        '<div class="tdk-best" id="tdk-best"><div class="l">Best play</div><div class="p">—</div></div>' +
        '<table class="tdk"><thead><tr><th class="l">Item</th><th class="so" data-sort="buy">Buy</th><th class="so" data-sort="sell">Resale</th><th class="so" data-sort="ppi">Profit/ea</th><th id="tdk-th-full" class="so" data-sort="fullprofit" title="Total profit for a full load (profit/ea × cap), before airfare">Profit ×' + state.cap + '</th><th class="so" data-sort="stock">Stock</th><th class="so" data-sort="full">Load</th><th class="so" data-sort="ppm">$/min</th></tr></thead><tbody id="tdk-body"></tbody></table>' +
        '<div class="tdk-mug" id="tdk-mug"></div>' +
      '</div>' +
      '<div id="tdk-inv" style="display:none"></div>';
    host.appendChild(panel);
    // Overlay lives on host (not the panel) so it floats over the page at full height, unclipped by the panel.
    const buyers = document.createElement("div"); buyers.id = "tdk-buyers"; host.appendChild(buyers);

    btn.addEventListener("click", function () { panel.classList.toggle("open"); if (panel.classList.contains("open")) { if (!state.rows.length) refresh(); checkInvStatus(); } });
    host.querySelector("#tdk-close").addEventListener("click", function () { panel.classList.remove("open"); });
    host.querySelector("#tdk-settings").addEventListener("click", openSettings);
    host.querySelector("#tdk-happy").addEventListener("click", openHappy);
    host.querySelector("#tdk-flip").addEventListener("click", openFlip);
    host.querySelector("#tdk-shop").addEventListener("click", openShopFlips);
    host.querySelector("#tdk-stk").addEventListener("click", openStocks);
    host.querySelector("#tdk-refresh").addEventListener("click", function () { if (state.view === "inv") { state.inv = null; renderInv(); } else refresh(); });
    host.querySelector("#tdk-cap").addEventListener("change", function (e) {
      state.cap = Math.max(1, parseInt(e.target.value, 10) || 23); GM_setValue("cap", state.cap);
      if (state.rows.length) { state.rows.forEach(function (x) { const f = FLY[x.cc]; x.ppm = Math.round((x.ppi * state.cap - f.fare) / f.rt); x.full = x.buy * state.cap; }); state.rows.sort(function (a, b) { return b.ppm - a.ppm; }); render(); }
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
      // From the Bag, Fund means "show me the funded board" (turn it on) — don't toggle it off.
      // On the board, Fund toggles fund mode normally.
      if (state.view === "inv") { state.fund = true; setView("board"); }
      else { state.fund = !state.fund; render(); }
      GM_setValue("fund", state.fund);
    });
    host.querySelector("#tdk-body").addEventListener("click", function (e) {
      if (e.target.closest("a, button")) return;
      const tr = e.target.closest("tr"); if (!tr || !tr.dataset.id) return;
      openBuyers(+tr.dataset.id, tr.dataset.name);
    });
    host.querySelector("#tdk-board").addEventListener("click", function (e) {
      const th = e.target.closest("th.so"); if (!th) return;
      state.sort = th.getAttribute("data-sort"); GM_setValue("sort", state.sort); render();
    });
    host.querySelector("#tdk-ainc").addEventListener("click", function () { state.scale = Math.min(1.6, +(state.scale + 0.1).toFixed(2)); GM_setValue("scale", state.scale); applyScale(); });
    host.querySelector("#tdk-adec").addEventListener("click", function () { state.scale = Math.max(0.9, +(state.scale - 0.1).toFixed(2)); GM_setValue("scale", state.scale); applyScale(); });
    host.querySelector("#tdk-invbtn").addEventListener("click", function () { setView(state.view === "inv" ? "board" : "inv"); });
    host.querySelector("#tdk-ver").addEventListener("click", openChangelog);
    applyScale();
  }

  /* ---------- inline Items-page annotator (item.php) ---------- */
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
        // Icon only (value in tooltip), placed INSIDE .name-wrap so it rides the name's own line and can't
        // widen Torn's title block into a second row.
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
        if (sellable && price > 0) { // ⚡ only on sell-ok rows (default junk or toggled to sell) — keeps held-back items out of the sell flow entirely
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
  // Torn renders your item counts client-side (data-qty on each row) even while the inventory API is down.
  // Scrape them off item.php and persist, so the Bag works without the API. Merges across category tabs AND
  // reconciles: an open category tab lists ALL of that category's items, so any stored item of that category we
  // no longer see (or that shows data-qty 0) was sold/used to zero — drop it, so the snapshot stops over-reporting.
  // (If an item-search filter hides rows, they re-appear and re-store the moment the filter is cleared.)
  function harvestInvCounts() {
    const rows = document.querySelectorAll("li[data-item][data-qty]"); if (!rows.length) return;
    const store = GM_getValue("inv_counts", null) || { map: {}, at: 0 };
    const map = store.map || {}, meta = state.itemMeta || {};
    const seen = {}, catsPresent = {};
    rows.forEach(function (li) {
      const id = +li.getAttribute("data-item"), q = parseInt(li.getAttribute("data-qty"), 10);
      if (!id || isNaN(q)) return;
      const cat = li.getAttribute("data-category") || (meta[id] && meta[id].type) || "";
      if (cat) catsPresent[cat] = 1;
      if (q > 0) { map[id] = q; seen[id] = 1; } else { delete map[id]; } // qty 0 on-screen → sold out
    });
    Object.keys(map).forEach(function (id) {
      if (seen[id]) return;
      const cat = meta[id] && meta[id].type; // data-category == catalog type, so a shown tab reconciles its items
      if (cat && catsPresent[cat]) delete map[id];
    });
    GM_setValue("inv_counts", { map: map, at: Date.now() });
  }
  function annotateItemsPage() {
    if (!ITEM_PAGE.test(location.pathname)) return;
    const key = GM_getValue("torn_key", ""); if (!key) return; // silent — never prompt from the page
    loadResale(key).then(function () {
      annotateRows(); harvestInvCounts();
      let pending = false;
      new MutationObserver(function () {
        if (pending) return; pending = true;
        requestAnimationFrame(function () { pending = false; annotateRows(); harvestInvCounts(); });
      }).observe(document.body, { childList: true, subtree: true });
    }).catch(function () { });
  }
  // On trade.php: offer to fill the (required) description with the line you stashed by clicking ⇄ Trade.
  // Text-only + user-initiated; we NEVER add items, set money, or press Initiate Trade.
  const TRADE_PAGE = /\/trade\.php/;
  function tradeDescHelper() {
    if (!TRADE_PAGE.test(location.pathname)) return;
    const run = function () {
      const ta = document.querySelector("textarea#description");
      if (!ta || document.querySelector("#tdk-filldesc")) return;
      const pend = GM_getValue("pending_trade", null);
      if (!pend || !pend.line || (Date.now() - pend.at > 15 * 60 * 1000)) return; // expire after 15 min
      const btn = document.createElement("button");
      btn.id = "tdk-filldesc"; btn.type = "button"; btn.className = "tdk-filldesc";
      btn.textContent = "📋 Fill description: " + pend.line;
      btn.title = "Drops this into the description. You still add the items and press Initiate Trade.";
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        ta.focus();
        // Set via the native setter (React-safe), then fire a real typing burst so Torn's validation
        // re-reads the field and enables Initiate Trade (a plain value= + one input event wasn't enough).
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
  // Travel page has Torn's OWN trip counter ("You have purchased N / 23 items so far") — the reliable source of
  // this trip's haul while abroad (inventory API is down + Items page is blocked in-country). Scrape it off the
  // text (+ the inventory panel's aria-label as a fallback) — never off the hashed slot classes.
  function onTravelPage() { return /[?&]sid=travel\b/i.test(location.search + location.hash) || /\/travel\.php/i.test(location.pathname); }
  function scrapeTripBought() {
    if (!onTravelPage()) return;
    const run = function () {
      let n = null, cap = null;
      const m = (document.body.innerText || "").match(/purchased\s+(\d+)\s*\/\s*(\d+)\s+item/i);
      if (m) { n = +m[1]; cap = +m[2]; }
      else { const ul = document.querySelector('ul[aria-label*="Inventory"]'); const al = ul && ul.getAttribute("aria-label"); const am = al && al.match(/(\d+)\s+item/i); if (am) { n = +am[1]; cap = state.cap || 23; } }
      if (n == null) return;
      const prev = GM_getValue("trip_bought", null);
      if (!prev || prev.n !== n || prev.cap !== cap) { GM_setValue("trip_bought", { n: n, cap: cap, at: Date.now() }); renderHomeBar(); }
    };
    run();
    let pending = false;
    new MutationObserver(function () { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; run(); }); }).observe(document.body, { childList: true, subtree: true });
  }

  build();
  annotateItemsPage();
  tradeDescHelper();
  scrapeTripBought();
  setTimeout(checkInvStatus, 8000);              // first check shortly after load
  setInterval(checkInvStatus, 15 * 60 * 1000);   // then quietly every 15 min — lights the Bag when Torn restores inventory
  setTimeout(pollStocks, 12000);                 // seed the restock history soon after load
  setInterval(pollStocks, 60 * 1000);            // check every minute; the GM lock caps actual fetches to one per POLL_MS across tabs
  setTimeout(pollStockPrices, 20000);            // seed stock-price history soon after load
  setInterval(pollStockPrices, 5 * 60 * 1000);   // check every 5 min; GM lock caps actual fetches to one per ~10 min across tabs
  setInterval(function () { renderImmunity(); renderOC(); }, 1000); // live-tick the immunity/flight countdown + OC banner
})();
