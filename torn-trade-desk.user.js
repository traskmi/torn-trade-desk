// ==UserScript==
// @name         Torn Trade Desk
// @namespace    tekim.tradedesk
// @version      1.4.0
// @updateURL    https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.user.js
// @downloadURL  https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.user.js
// @description  Live travel-profit board — YATA foreign stock × Torn-API resale, ranked by $/minute. Refresh button, affordability + best-pick, mug calculator.
// @author       Tekim
// @match        *://*.torn.com/*
// @connect      yata.yt
// @connect      api.torn.com
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
  const state = { resale: null, resaleAt: 0, cash: null, cap: GM_getValue("cap", 23), rows: [], updates: {}, filter: "all", fund: GM_getValue("fund", false) };

  /* ---------- helpers ---------- */
  function gmGet(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: "GET", url: url, timeout: 20000,
        onload: function (r) {
          if (r.status < 200 || r.status >= 300) return reject(new Error("HTTP " + r.status));
          try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error("bad JSON from " + url)); }
        },
        onerror: function () { reject(new Error("network error: " + url)); },
        ontimeout: function () { reject(new Error("timeout: " + url)); }
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
    const idx = {};
    Object.keys(j.items).forEach(function (id) { idx[+id] = j.items[id].market_value; });
    state.resale = idx; state.resaleAt = now;
    return idx;
  }
  async function loadCash(key) {
    try {
      const j = await gmGet("https://api.torn.com/user/?selections=money&key=" + encodeURIComponent(key));
      if (j && typeof j.money_onhand === "number") state.cash = j.money_onhand;
    } catch (e) { /* non-fatal */ }
  }
  async function refresh() {
    setStatus("Refreshing…");
    const key = tornKey();
    if (!key) { setStatus("Need a Torn API key.", true); return; }
    try {
      const [yata, resale] = await Promise.all([
        gmGet("https://yata.yt/api/v1/travel/export/"),
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
      setStatus("Refresh failed — " + e.message, true);
    }
  }

  /* ---------- UI ---------- */
  let host, panel;
  function css() {
    return `
    #tdk-btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:46px;height:46px;border-radius:50%;
      background:#14130f;border:1px solid #d9b441;color:#d9b441;font-size:20px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.5)}
    #tdk-btn:hover{background:#201e17}
    #tdk-panel{position:fixed;right:18px;bottom:74px;z-index:2147483000;width:min(760px,94vw);max-height:80vh;overflow:auto;
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
    table.tdk tr.dim td{opacity:.42}
    table.tdk tr:hover td{background:#1b1a14}
    .nm{font-weight:700}.cy{color:#928b78;font-size:11px}
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
    .chip.short{color:#e2933f;background:#2c2114;margin-left:6px}
    table.tdk tr.fund td{opacity:1;background:#221d10}
    table.tdk tr.fund td.l{box-shadow:inset 3px 0 0 #d9b441}
    .tdk-fund2{margin-top:8px;padding-top:8px;border-top:1px dashed #3a3729;font-size:12px;color:#e2933f;line-height:1.45}
    .tdk-fund2 b{color:#d9b441;font-family:ui-monospace,monospace}
    .fly{color:#c3bda9;text-decoration:none;border-bottom:1px dotted #4a4536}
    .fly:hover{color:#d9b441;border-bottom-color:#d9b441}
    .tdk-mug{margin:0;padding:11px 16px;border-top:1px solid #2c2a21;font-size:12px;color:#928b78;background:#181712;line-height:1.45}
    .tdk-mug b{color:#e5615c;font-family:ui-monospace,monospace}
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
    if (state.filter !== "all" && !state.rows.some(function (x) { return x.cc === state.filter; })) state.filter = "all";
    renderChips();
    const fbtn = host.querySelector("#tdk-fund"); if (fbtn) fbtn.className = "tdk-btn2" + (fund ? " on" : "");
    const rows = state.filter === "all" ? state.rows : state.rows.filter(function (x) { return x.cc === state.filter; });
    const best = rows.find(function (x) { return (cash == null || x.full <= cash) && x.stock >= cap; });
    const topOver = rows.find(function (x) { return x.stock >= cap && cash != null && x.full > cash && (!best || x.ppm > best.ppm); });
    const b = host.querySelector("#tdk-best");
    let html = best
      ? '<div class="l">Best now' + (state.filter === "all" ? "" : " · " + FLY[state.filter].name) + (cash != null ? " · " + money(cash) : "") + '</div>' +
        '<div class="p">' + best.name + ' <span>· ' + best.country + '</span></div>' +
        '<div class="k"><b>$' + best.ppm.toLocaleString() + '</b>/min · trip ' + money(best.ppi * cap - FLY[best.cc].fare) + ' · load ' + money(best.full) + ' · stock ' + best.stock.toLocaleString() + '</div>'
      : '<div class="l">Best now</div><div class="p">Nothing both affordable &amp; in stock here</div>';
    if (topOver) {
      html += '<div class="tdk-fund2">💰 Bigger play if funded: <b>' + topOver.name + '</b> (' + topOver.country + ') · <b>$' + topOver.ppm.toLocaleString() + '</b>/min — sell <b>' + money(topOver.full - cash) + '</b> in stocks before you fly to full-load it.</div>';
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
      return '<tr class="' + cls + '">' +
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
        '<div class="t">Trade Desk<small>Torn · $/min board</small></div><div class="sp"></div>' +
        'Cap <input class="tdk-cap" id="tdk-cap" type="number" min="1" max="60" value="' + state.cap + '">' +
        '<button class="tdk-btn2" id="tdk-fund" title="Show top plays even if over budget — reminds you to free up cash first">💰 Fund</button>' +
        '<button class="tdk-btn2" id="tdk-refresh">↻ Refresh</button>' +
      '</div>' +
      '<div class="tdk-status" id="tdk-status">Click Refresh to pull live data.</div>' +
      '<div class="tdk-filter" id="tdk-filter"></div>' +
      '<div class="tdk-best" id="tdk-best"><div class="l">Best play</div><div class="p">—</div></div>' +
      '<table class="tdk"><thead><tr><th class="l">Item</th><th>Buy</th><th>Resale</th><th>Profit/ea</th><th>Stock</th><th>Load</th><th>$/min</th></tr></thead><tbody id="tdk-body"></tbody></table>' +
      '<div class="tdk-mug" id="tdk-mug"></div>';
    host.appendChild(panel);

    btn.addEventListener("click", function () { panel.classList.toggle("open"); if (panel.classList.contains("open") && !state.rows.length) refresh(); });
    host.querySelector("#tdk-refresh").addEventListener("click", refresh);
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
  }

  build();
})();
