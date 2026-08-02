// ==UserScript==
// @name         Torn Trade Desk
// @namespace    tekim.tradedesk
// @version      1.8.0
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
  const state = { resale: null, itemMeta: null, resaleAt: 0, cash: null, stocks: null, cap: GM_getValue("cap", 23), rows: [], updates: {}, filter: "all", fund: GM_getValue("fund", false), scale: GM_getValue("scale", 1), view: "board", inv: null, invAt: 0, travel: null, ov: GM_getValue("ov", {}) };

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
      meta[+id] = { type: it.type || "", hasUse: !!(eff || req) };
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
      const isYata = e.url && e.url.indexOf("yata.yt") !== -1;
      const down = e.kind === "timeout" || e.kind === "network" || e.status >= 500;
      if (isYata && down) {
        setStatus("YATA is down (" + (e.status || e.kind) + ") — stock data unavailable, retry shortly.", true);
      } else {
        setStatus("Refresh failed — " + e.message, true);
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
    .tdk-h{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #2c2a21;position:sticky;top:0;background:#14130f;flex-wrap:wrap}
    .tdk-h .t{font-weight:800;letter-spacing:.02em}
    .tdk-h .t small{color:#928b78;font-weight:600;letter-spacing:.14em;text-transform:uppercase;font-size:10px;display:block}
    .tdk-h .sp{flex:1}
    .tdk-btn2{background:#2a2413;border:1px solid #d9b441;color:#d9b441;border-radius:9px;padding:7px 13px;font-weight:700;cursor:pointer}
    .tdk-btn2:hover{background:#332a15}
    .tdk-cap{width:56px;background:#201e17;border:1px solid #3a3729;color:#ece7d8;border-radius:8px;padding:6px 8px;
      font-family:ui-monospace,Consolas,monospace}
    .tdk-status{font-size:11px;color:#928b78;padding:0 16px 6px}
    .tdk-status.err{color:#e5615c}
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
    #tdk-buyers{position:absolute;top:92px;left:16px;right:26px;z-index:6;background:#1b1a14;border:1px solid #d9b441;border-radius:12px;box-shadow:0 16px 44px rgba(0,0,0,.65);padding:13px 15px;display:none;max-height:62vh;overflow:auto}
    #tdk-buyers.open{display:block}
    .tdk-bh{display:flex;align-items:center;gap:10px;margin-bottom:6px}
    .tdk-bh .tt{font-weight:800;font-size:14px}
    .tdk-bh .tt small{color:#928b78;font-weight:600;font-size:11px}
    .tdk-bx{margin-left:auto;cursor:pointer;color:#928b78;font-size:20px;background:none;border:none;line-height:1}
    .tdk-bx:hover{color:#e5615c}
    .tdk-x{border-color:#7a4a44 !important;color:#e7a49d !important}
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
      const mark = (aff && fill) ? '<span class="star">★</span>' : (isTop ? '<span class="star">💰</span>' : '');
      return '<tr class="' + cls + '" data-id="' + x.id + '" data-name="' + x.name.replace(/"/g, "") + '">' +
        '<td class="l"><span class="nm">' + x.name + mark + '</span><div class="cy"><a class="fly" href="https://www.torn.com/page.php?sid=travel" title="Open the travel agency">' + x.country + ' ✈</a> · ' + ago(x.freshS) + ' old</div></td>' +
        '<td>' + full$(x.buy) + '</td><td>' + full$(x.sell) + '</td>' +
        '<td class="gd">' + full$(x.ppi) + '</td><td>' + sc + '</td>' +
        '<td>' + money(x.full) + shortB + '</td>' +
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
        ? '<a class="tdk-bestonline" href="' + tradeUrl(bestOn.player_id) + '" target="_blank" rel="noopener">⚡ Trade best ' + (status[bestOn.player_id] === "Online" ? "online" : "idle") + ': <b>' + bestOn.player_name + '</b> @ $' + bestOn.price.toLocaleString() + ' ' + dot(status[bestOn.player_id]) + '</a>'
        : '<div class="tdk-sub" style="padding:6px 2px">' + (tkey ? 'None of the top buyers are online right now.' : 'Add your Torn API key to flag who’s online.') + '</div>';
      const rank = function (t) { const s = status[t.player_id]; return s === "Online" ? 0 : s === "Idle" ? 1 : s === "Offline" ? 3 : 2; };
      const sorted = traders.map(function (t, i) { return { t: t, i: i }; })
        .sort(function (a, b) { return (rank(a.t) - rank(b.t)) || (a.i - b.i); }).map(function (x) { return x.t; });
      const list = sorted.map(function (t) {
        const r = t.rating || { upvotes: 0, downvotes: 0 };
        return '<div class="tdk-brow"><div><div class="bn">' + dot(status[t.player_id]) + ' ' + t.player_name + '</div>' +
          '<div class="br">' + r.upvotes + '↑ ' + r.downvotes + '↓ · <a class="prof" href="https://www.torn.com/profiles.php?XID=' + t.player_id + '" target="_blank" rel="noopener">profile</a></div></div>' +
          '<div class="bp">$' + t.price.toLocaleString() + '</div>' +
          '<a class="tdk-trade" href="' + tradeUrl(t.player_id) + '" target="_blank" rel="noopener">⇄ Trade</a></div>';
      }).join("");
      bx.innerHTML = head + banner + (list || '<div class="br">No traders listed for this item.</div>');
      bindClose(bx);
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
    try { items = await loadInv(key); } catch (e) { box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk</div><div class="p">Error: ' + e.message + '</div></div>'; return; }
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
        '<div class="k">' + (n ? 'Nothing here is currently sellable on the market.' : 'Your Torn API key may lack inventory access, or Torn returned nothing.') + '</div></div>';
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
    const b = host.querySelector("#tdk-invbtn"); if (b) b.className = "tdk-btn2" + (v === "inv" ? " on" : "");
    if (v === "inv") renderInv();
  }
  const CHANGELOG = [
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
        '<button class="tdk-btn2" id="tdk-refresh">↻ Refresh</button>' +
        '<button class="tdk-btn2 tdk-x" id="tdk-close" title="Close panel">✕</button>' +
      '</div>' +
      '<div class="tdk-status" id="tdk-status">Click Refresh to pull live data.</div>' +
      '<div id="tdk-board">' +
        '<div class="tdk-filter" id="tdk-filter"></div>' +
        '<div class="tdk-best" id="tdk-best"><div class="l">Best play</div><div class="p">—</div></div>' +
        '<table class="tdk"><thead><tr><th class="l">Item</th><th>Buy</th><th>Resale</th><th>Profit/ea</th><th>Stock</th><th>Load</th><th>$/min</th></tr></thead><tbody id="tdk-body"></tbody></table>' +
        '<div class="tdk-mug" id="tdk-mug"></div>' +
      '</div>' +
      '<div id="tdk-inv" style="display:none"></div>' +
      '<div id="tdk-buyers"></div>';
    host.appendChild(panel);

    btn.addEventListener("click", function () { panel.classList.toggle("open"); if (panel.classList.contains("open") && !state.rows.length) refresh(); });
    host.querySelector("#tdk-close").addEventListener("click", function () { panel.classList.remove("open"); });
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
      state.fund = !state.fund; GM_setValue("fund", state.fund); render();
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
  function annotateItemsPage() {
    if (!ITEM_PAGE.test(location.pathname)) return;
    const key = GM_getValue("torn_key", ""); if (!key) return; // silent — never prompt from the page
    loadResale(key).then(function () {
      annotateRows();
      let pending = false;
      new MutationObserver(function () {
        if (pending) return; pending = true;
        requestAnimationFrame(function () { pending = false; annotateRows(); });
      }).observe(document.body, { childList: true, subtree: true });
    }).catch(function () { });
  }

  build();
  annotateItemsPage();
})();
