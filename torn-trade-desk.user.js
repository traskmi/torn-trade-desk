// ==UserScript==
// @name         Torn Trade Desk
// @namespace    tekim.tradedesk
// @version      1.14.0
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

  /* ---------- state ---------- */
  const state = { resale: null, itemMeta: null, resaleAt: 0, cash: null, stocks: null, cap: GM_getValue("cap", 23), rows: [], updates: {}, filter: "all", fund: GM_getValue("fund", false), scale: GM_getValue("scale", 1), view: "board", inv: null, invAt: 0, travel: null, invReady: null, ov: GM_getValue("ov", {}) };

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
  function copyText(t) {
    try { if (typeof GM_setClipboard === "function") { GM_setClipboard(t, "text"); return; } } catch (e) { }
    try { if (navigator.clipboard) navigator.clipboard.writeText(t); } catch (e) { }
  }
  function mkTradeLine(nm, q, p) { return (nm + " ×" + q + " @ $" + p.toLocaleString() + "/ea = $" + (p * q).toLocaleString()).slice(0, 155); } // trade description cap is 155
  function stashTrade(nm, q, p, uid) { try { GM_setValue("pending_trade", { line: mkTradeLine(nm, q, p), uid: uid || 0, at: Date.now() }); } catch (e) { } }
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
      meta[+id] = { type: it.type || "", hasUse: !!(eff || req), name: it.name || "" };
    });
    state.resale = idx; state.itemMeta = meta; state.resaleAt = now;
    return idx;
  }
  async function loadCash(key) {
    try {
      const j = await gmGet("https://api.torn.com/user/?selections=money,networth&key=" + encodeURIComponent(key));
      if (j && typeof j.money_onhand === "number") state.cash = j.money_onhand;
      if (j && j.networth && typeof j.networth.stockmarket === "number") state.stocks = j.networth.stockmarket;
    } catch (e) { /* non-fatal */ }
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
      render();
      setStatus("Updated " + new Date().toLocaleTimeString());
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
    .tdk-h{display:flex;align-items:center;gap:9px;padding:14px 52px 14px 16px;border-bottom:1px solid #2c2a21;position:sticky;top:0;background:#14130f;flex-wrap:wrap}
    .tdk-h .t{font-weight:800;letter-spacing:.02em}
    .tdk-h .t small{color:#928b78;font-weight:600;letter-spacing:.14em;text-transform:uppercase;font-size:10px;display:block}
    .tdk-h .sp{flex:1}
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
    table.tdk td{padding:9px 14px;border-bottom:1px solid #211f18;text-align:right;white-space:nowrap;
      font-family:ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
    table.tdk td.mv{color:#ded7c5}
    table.tdk td.l{font-family:system-ui,sans-serif}
    table.tdk tr.dim td{opacity:.82}
    table.tdk tr:hover td{background:#1b1a14}
    .nm{font-weight:700;color:#f2eddf}.cy{color:#a49c88;font-size:11px}
    .ppm{color:#d9b441;font-weight:800}
    .gd{color:#4cc281;font-weight:700}
    .chip{font-family:system-ui,sans-serif;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px}
    .c-ok{color:#4cc281;background:#16281d}.c-low{color:#e2933f;background:#2c2114}.c-out{color:#e5615c;background:#2c1717}
    .star{color:#d9b441;margin-left:6px}
    .tdk-filter{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 10px}
    .tdk-fc{font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;cursor:pointer;border:1px solid #3a3729;background:#1b1a14;color:#c3bda9}
    .tdk-fc:hover{background:#201e17}
    .tdk-fc.on{background:#2a2413;border-color:#d9b441;color:#d9b441}
    .tdk-btn2.on{background:#d9b441;color:#14130f;border-color:#d9b441}
    .tdk-sm{padding:7px 9px;font-size:12px}
    .tdk-ver{cursor:pointer;border-bottom:1px dotted #928b78}
    .tdk-ver:hover{color:#d9b441;border-bottom-color:#d9b441}
    .tdk-upbar{display:flex;align-items:center;gap:10px;margin:2px 0 10px;flex-wrap:wrap}
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
    host.querySelector("#tdk-filter").innerHTML = chips.map(function (c) {
      return '<span class="tdk-fc' + (state.filter === c[0] ? " on" : "") + '" data-cc="' + c[0] + '">' + c[1] + '</span>';
    }).join("");
  }
  function render() {
    const cap = state.cap, cash = state.cash, fund = state.fund;
    const stocks = state.stocks || 0, funds = cash == null ? null : cash + stocks;
    if (state.filter !== "all" && !state.rows.some(function (x) { return x.cc === state.filter; })) state.filter = "all";
    renderChips();
    const fbtn = host.querySelector("#tdk-fund"); if (fbtn) fbtn.className = "tdk-btn2" + (fund ? " on" : "");
    const rows = state.filter === "all" ? state.rows : state.rows.filter(function (x) { return x.cc === state.filter; });
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
    body.innerHTML = rows.map(function (x) {
      const aff = cash == null || x.full <= cash;
      const fill = x.stock >= cap;
      const isTop = topOver && x === topOver;
      let sc = x.stock === 0 ? '<span class="chip c-out">out</span>'
        : x.stock < cap ? '<span class="chip c-low">only ' + x.stock + '</span>'
          : '<span class="chip c-ok">' + x.stock.toLocaleString() + '</span>';
      const shortB = (!aff && cash != null && fill) ? '<span class="chip short">free +' + money(x.full - cash) + '</span>' : '';
      const cls = aff ? "" : (fund ? (isTop ? "fund" : "") : "dim");
      const mark = (aff && fill) ? '<span class="star" title="Affordable now & fully in stock — a clean pick">★</span>' : (isTop ? '<span class="star" title="Best funded play — over budget, but reachable by selling stocks (see the banner up top)">💰</span>' : '');
      return '<tr class="' + cls + '" data-id="' + x.id + '" data-name="' + x.name.replace(/"/g, "") + '">' +
        '<td class="l"><span class="nm">' + x.name + mark + '</span><div class="cy"><a class="fly" href="https://www.torn.com/page.php?sid=travel" title="Open the travel agency">' + x.country + ' ✈</a> · ' + ago(x.freshS) + ' old</div></td>' +
        '<td class="mv">' + full$(x.buy) + '</td><td class="mv">' + full$(x.sell) + '</td>' +
        '<td class="gd">' + full$(x.ppi) + '</td><td>' + sc + '</td>' +
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
      const calcBar = '<div class="tdk-calc">Qty <input id="tdk-qty" type="number" min="1" value="' + q0 + '">' +
        (owned > 0 ? '<button class="tdk-cp" id="tdk-qty-own" title="' + (ownedStale ? 'From your last Items-page visit (Torn inventory API is down) — click to use' : 'Set quantity to how many you own') + '">You have ' + owned + (ownedStale ? '*' : '') + '</button>' : '') +
        '<span class="tdk-calc-hint">' + (ownedStale ? '*from your last Items-page visit · ' : '') + 'totals update live · 📋 copies the trade line</span></div>';
      const list = sorted.map(function (t) {
        const r = t.rating || { upvotes: 0, downvotes: 0 };
        return '<div class="tdk-brow"><div><div class="bn">' + dot(status[t.player_id]) + ' ' + t.player_name + '</div>' +
          '<div class="br">' + r.upvotes + '↑ ' + r.downvotes + '↓ · <a class="prof" href="https://www.torn.com/profiles.php?XID=' + t.player_id + '" target="_blank" rel="noopener">profile</a></div></div>' +
          '<div class="bp">$' + t.price.toLocaleString() + '<span class="ea"> /ea</span><div class="bt" data-price="' + t.price + '">= $' + (t.price * q0).toLocaleString() + '</div></div>' +
          '<button class="tdk-cp" data-price="' + t.price + '" title="Copy trade line">📋</button>' +
          '<a class="tdk-trade" href="' + tradeUrl(t.player_id) + '" target="_blank" rel="noopener" data-uid="' + t.player_id + '" data-price="' + t.price + '">⇄ Trade</a></div>';
      }).join("");
      bx.innerHTML = head + banner + (list ? calcBar + list : '<div class="br">No traders listed for this item.</div>');
      bindClose(bx);
      const qtyEl = bx.querySelector("#tdk-qty");
      const getQ = function () { return Math.max(1, parseInt(qtyEl && qtyEl.value, 10) || 1); };
      const recalc = function () {
        const q = getQ();
        bx.querySelectorAll(".bt").forEach(function (el) { el.textContent = "= $" + (+el.getAttribute("data-price") * q).toLocaleString(); });
      };
      if (qtyEl) qtyEl.addEventListener("input", recalc);
      const ownBtn = bx.querySelector("#tdk-qty-own");
      if (ownBtn) ownBtn.addEventListener("click", function () { if (qtyEl) { qtyEl.value = owned; recalc(); } });
      bx.querySelectorAll(".tdk-cp").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const p = +this.getAttribute("data-price"), q = getQ();
          copyText(mkTradeLine(name, q, p));
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
    const items = state.inv || [], priceMap = state.resale || {}, meta = state.itemMeta || {};
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
    const rowsHtml = function (arr, sellable) {
      return arr.map(function (x) {
        const tog = '<span class="tdk-tog" data-id="' + x.id + '" data-eff="' + (sellable ? 1 : 0) + '" title="' + (sellable ? 'Mark as keep' : 'Allow selling this item') + (x.ov ? ' — override set' : '') + '">' + (sellable ? '🔒' : '🔓') + '</span>';
        const action = sellable
          ? '<a class="tdk-trade" href="' + marketUrl(x.id, x.name, x.type) + '" target="_blank" rel="noopener">Sell</a> ' + tog
          : tog;
        return '<tr' + (x.ov ? ' class="tdk-ovr"' : '') + '><td class="l"><span class="nm">' + x.name + (x.qty > 1 ? ' <span class="cy">×' + x.qty.toLocaleString() + '</span>' : '') + '</span></td>' +
          '<td class="l"><span class="cy">' + x.type + '</span></td>' +
          '<td class="num">' + full$(x.unit) + '</td>' +
          '<td class="num gd">' + full$(x.total) + '</td>' +
          '<td class="tdk-act">' + action + '</td></tr>';
      }).join("");
    };
    const table = function (arr, sellable) {
      return '<table class="tdk"><thead><tr><th class="l">Item</th><th class="l">Type</th><th>Unit</th><th>Total</th><th></th></tr></thead><tbody>' + rowsHtml(arr, sellable) + '</tbody></table>';
    };
    if (!sell.length && !keep.length) {
      const n = items.length;
      box.innerHTML = '<div class="tdk-best"><div class="l">Bag</div>' +
        '<div class="p">' + (n ? 'Scanned ' + n + ' item' + (n === 1 ? '' : 's') + ' — none with a market value' : 'Inventory came back empty') + '</div>' +
        '<div class="k">' + (n ? 'Nothing here is currently sellable on the market.' : 'Torn’s inventory API is returning empty right now — it’s mid-migration on Torn’s side, not your key (⚙ → Test to confirm). The Bag will work once Torn restores it.') + '</div></div>';
      return;
    }
    const grand = sell.reduce(function (s, x) { return s + x.total; }, 0);
    let html = '<div class="tdk-best"><div class="l">Safe to sell · ' + sell.length + ' item' + (sell.length === 1 ? '' : 's') + '</div>' +
      '<div class="p">' + money(grand) + ' <span>you could dump for cash</span></div>' +
      '<div class="k">🔒 = held back, 🔓 = click to allow · your choices are saved. The Sell link only opens Torn’s market — it never sells for you.</div></div>';
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
    let cur = null, max = null, stats = null, gymId = null, energyNow = null;
    if (key) {
      try {
        const j = await gmGet("https://api.torn.com/user/?selections=bars,battlestats,gym&key=" + encodeURIComponent(key));
        if (j && j.happy) { cur = j.happy.current; max = j.happy.maximum; }
        if (j && j.energy) energyNow = j.energy.current;
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
      '<div class="hrow"><label>Energy to spend</label><input class="hqty" id="tdk-hen" type="number" min="' + gym.energy + '" value="' + (energyNow || gym.energy) + '"><span class="hv">have ' + (energyNow != null ? energyNow : "?") + '</span></div>' +
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
      const enEl = bx.querySelector("#tdk-hen"), energy = Math.max(gym.energy, parseInt(enEl && enEl.value, 10) || gym.energy);
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
      '<div class="tdk-upbar"><button class="tdk-btn2" id="tdk-updbtn" title="Check GitHub for a newer version">🔄 Check for updates</button><span class="tdk-upd" id="tdk-upd">v' + curVersion() + '</span>' +
        (ovCount ? '<button class="tdk-btn2" id="tdk-ovreset" title="Clear every keep/sell-ok override you\'ve set">↺ Reset ' + ovCount + ' override' + (ovCount > 1 ? 's' : '') + '</button>' : '') +
      '</div>' +
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
  function build() {
    host = document.createElement("div");
    document.body.appendChild(host);
    if (typeof GM_addStyle === "function") { GM_addStyle(css()); }
    else { const style = document.createElement("style"); style.textContent = css(); (document.head || document.documentElement).appendChild(style); }

    const btn = document.createElement("button"); btn.id = "tdk-btn"; btn.textContent = "💰"; btn.title = "Torn Trade Desk";
    host.appendChild(btn);

    panel = document.createElement("div"); panel.id = "tdk-panel";
    panel.innerHTML =
      '<div class="tdk-h">' +
        '<div class="t">Trade Desk<small>Torn · $/min · <span class="tdk-ver" id="tdk-ver" title="View changelog">v' + (typeof GM_info !== "undefined" && GM_info.script ? GM_info.script.version : "") + '</span></small></div><div class="sp"></div>' +
        'Cap <input class="tdk-cap" id="tdk-cap" type="number" min="1" max="60" value="' + state.cap + '">' +
        '<button class="tdk-btn2 tdk-sm" id="tdk-adec" title="Smaller text">A−</button>' +
        '<button class="tdk-btn2 tdk-sm" id="tdk-ainc" title="Bigger text">A+</button>' +
        '<button class="tdk-btn2" id="tdk-invbtn" title="Toggle your sellable-junk inventory">📦 Bag</button>' +
        '<button class="tdk-btn2" id="tdk-fund" title="Show top plays even if over budget — reminds you to free up cash first">💰 Fund</button>' +
        '<button class="tdk-btn2" id="tdk-happy" title="Happy-jump calculator — max happy, best order &amp; reset timer">😊 Happy</button>' +
        '<button class="tdk-btn2" id="tdk-refresh">↻ Refresh</button>' +
        '<button class="tdk-btn2" id="tdk-settings" title="Settings — API keys &amp; options">⚙</button>' +
        '<button class="tdk-btn2 tdk-x" id="tdk-close" title="Close panel">✕</button>' +
      '</div>' +
      '<div class="tdk-status" id="tdk-status">Click Refresh to pull live data.</div>' +
      '<div id="tdk-board">' +
        '<div class="tdk-filter" id="tdk-filter"></div>' +
        '<div class="tdk-best" id="tdk-best"><div class="l">Best play</div><div class="p">—</div></div>' +
        '<table class="tdk"><thead><tr><th class="l">Item</th><th>Buy</th><th>Resale</th><th>Profit/ea</th><th>Stock</th><th>Load</th><th>$/min</th></tr></thead><tbody id="tdk-body"></tbody></table>' +
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
    host.querySelector("#tdk-refresh").addEventListener("click", function () { if (state.view === "inv") { state.inv = null; renderInv(); } else refresh(); });
    host.querySelector("#tdk-cap").addEventListener("change", function (e) {
      state.cap = Math.max(1, parseInt(e.target.value, 10) || 23); GM_setValue("cap", state.cap);
      if (state.rows.length) { state.rows.forEach(function (x) { const f = FLY[x.cc]; x.ppm = Math.round((x.ppi * state.cap - f.fare) / f.rt); x.full = x.buy * state.cap; }); state.rows.sort(function (a, b) { return b.ppm - a.ppm; }); render(); }
    });
    host.querySelector("#tdk-filter").addEventListener("click", function (e) {
      const c = e.target.closest(".tdk-fc"); if (!c) return;
      state.filter = c.dataset.cc; render();
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
        if (sellable && price > 0) { // ⚡ buyers + trade-best-online, by the name where there's room (not the packed action cell)
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
  // Scrape them off item.php and persist, so "You have N" works without the API. Merges across category tabs.
  function harvestInvCounts() {
    const rows = document.querySelectorAll("li[data-item][data-qty]"); if (!rows.length) return;
    const store = GM_getValue("inv_counts", null) || { map: {}, at: 0 };
    const map = store.map || {};
    rows.forEach(function (li) {
      const id = +li.getAttribute("data-item"), q = parseInt(li.getAttribute("data-qty"), 10);
      if (id && !isNaN(q)) map[id] = q;
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

  build();
  annotateItemsPage();
  tradeDescHelper();
  setTimeout(checkInvStatus, 8000);              // first check shortly after load
  setInterval(checkInvStatus, 15 * 60 * 1000);   // then quietly every 15 min — lights the Bag when Torn restores inventory
})();
