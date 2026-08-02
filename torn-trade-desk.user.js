// ==UserScript==
// @name         Torn Trade Desk
// @namespace    tekim.tradedesk
// @version      1.6.1
// @updateURL    https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.user.js
// @downloadURL  https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.user.js
// @description  Live travel-profit board — YATA foreign stock × Torn-API resale, ranked by $/minute. Refresh button, affordability + best-pick, mug calculator.
// @author       Tekim
// @match        *://*.torn.com/*
// @connect      yata.yt
// @connect      api.torn.com
// @connect      weav3r.dev
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
  const state = { resale: null, resaleAt: 0, cash: null, cap: GM_getValue("cap", 23), rows: [], updates: {}, filter: "all", fund: GM_getValue("fund", false), scale: GM_getValue("scale", 1), view: "board", inv: null, invAt: 0 };

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
    .tdk-sm{padding:7px 9px;font-size:12px}
    .tdk-ver{cursor:pointer;border-bottom:1px dotted #928b78}
    .tdk-ver:hover{color:#d9b441;border-bottom-color:#d9b441}
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

  function applyScale() { if (panel) panel.style.zoom = state.scale; }
  function w3bKey() {
    let k = GM_getValue("w3b_key", "");
    if (!k) { k = (window.prompt("weav3r (W3B) API key — for live trader buy prices:") || "").trim(); if (k) GM_setValue("w3b_key", k); }
    return k;
  }
  function bindClose(bx) { const c = host.querySelector("#tdk-bclose"); if (c) c.onclick = function () { bx.classList.remove("open"); }; }
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
      const list = traders.map(function (t) {
        const r = t.rating || { upvotes: 0, downvotes: 0 };
        return '<div class="tdk-brow"><div><div class="bn">' + t.player_name + '</div>' +
          '<div class="br">' + r.upvotes + '↑ ' + r.downvotes + '↓ · <a class="prof" href="https://www.torn.com/profiles.php?XID=' + t.player_id + '" target="_blank" rel="noopener">profile</a></div></div>' +
          '<div class="bp">$' + t.price.toLocaleString() + '</div>' +
          '<a class="tdk-trade" href="https://www.torn.com/trade.php#step=start&userID=' + t.player_id + '" target="_blank" rel="noopener">⇄ Trade</a></div>';
      }).join("");
      bx.innerHTML = '<div class="tdk-bh"><div class="tt">Buyers · ' + name + '<small> — ' + (j.total_count || traders.length) + ' buying, best prices</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>' + (list || '<div class="br">No traders listed for this item.</div>');
      bindClose(bx);
    } catch (e) {
      bx.innerHTML = '<div class="tdk-bh"><div class="tt">Buyers · ' + name + '<small> — error</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div><div class="br">' + e.message + ' (check your W3B key in Tampermonkey storage)</div>';
      bindClose(bx);
    }
  }
  async function loadInv(key) {
    const now = Date.now();
    if (state.inv && now - state.invAt < 120000) return state.inv;
    const j = await gmGet("https://api.torn.com/user/?selections=inventory&key=" + encodeURIComponent(key));
    if (j.error) throw new Error("Torn API: " + j.error.error);
    state.inv = j.inventory || []; state.invAt = now;
    return state.inv;
  }
  const JUNK_TYPES = { Plushie: 1, Flower: 1, Collectible: 1, Artifact: 1, Jewelry: 1 };
  async function renderInv() {
    const box = host.querySelector("#tdk-inv");
    box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk</div><div class="p">loading inventory…</div></div>';
    const key = tornKey();
    if (!key) { box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk</div><div class="p">Need a Torn API key</div></div>'; return; }
    let items;
    try { items = await loadInv(key); } catch (e) { box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk</div><div class="p">Error: ' + e.message + '</div></div>'; return; }
    const junk = items.filter(function (it) { return JUNK_TYPES[it.type] && !it.equipped && (it.market_price || 0) > 0; })
      .map(function (it) { const p = it.market_price || 0; return { name: it.name, type: it.type, qty: it.quantity, unit: p, total: p * it.quantity }; })
      .sort(function (a, b) { return b.total - a.total; });
    if (!junk.length) { box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk</div><div class="p">None found — bags are clean 🎉</div><div class="k">Scans plushies, flowers, collectibles, artifacts &amp; jewelry.</div></div>'; return; }
    const grand = junk.reduce(function (s, x) { return s + x.total; }, 0);
    box.innerHTML = '<div class="tdk-best"><div class="l">Sellable junk · ' + junk.length + ' items</div>' +
      '<div class="p">' + money(grand) + ' <span>you could dump for cash</span></div>' +
      '<div class="k">plushies · flowers · collectibles · artifacts · jewelry — not your consumables or gear</div></div>' +
      '<table class="tdk"><thead><tr><th class="l">Item</th><th class="l">Type</th><th>Qty</th><th>Unit</th><th>Total</th><th></th></tr></thead><tbody>' +
      junk.map(function (x) {
        return '<tr><td class="l"><span class="nm">' + x.name + '</span></td>' +
          '<td class="l"><span class="cy">' + x.type + '</span></td>' +
          '<td class="num">' + x.qty.toLocaleString() + '</td>' +
          '<td class="num">' + full$(x.unit) + '</td>' +
          '<td class="num gd">' + full$(x.total) + '</td>' +
          '<td><a class="tdk-trade" href="https://www.torn.com/imarket.php#/p=shop&step=shop&type=&searchname=' + encodeURIComponent(x.name) + '" target="_blank" rel="noopener">Sell</a></td></tr>';
      }).join("") +
      '</tbody></table>';
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
    { v: "1.6.1", d: "Aug 2, 2026", c: ["Clearer message when YATA is down (502/timeout) instead of raw error", "Longer 30s timeout for YATA's heavy export"] },
    { v: "1.6.0", d: "Aug 1, 2026", c: ["Bigger-text controls (A− / A+)", "Sellable-Junk inventory view (📦 Bag)", "Clickable version → this changelog"] },
    { v: "1.5.0", d: "Aug 1, 2026", c: ["weav3r trader prices — click a row for top buyers", "One-click ⇄ Trade + profile links"] },
    { v: "1.4.0", d: "Aug 1, 2026", c: ["Fly-here (✈) links per row", "Live mug-risk readout", "GitHub hosting + auto-update"] },
    { v: "1.3.0", d: "Aug 1, 2026", c: ["Fund mode — surfaces the best plays even when over budget, with a 'sell $X in stocks' reminder + shortfall badges"] },
    { v: "1.2.0", d: "Aug 1, 2026", c: ["CSP-safe styling + broader page matching (fixed the invisible panel)"] },
    { v: "1.1.0", d: "Aug 1, 2026", c: ["Destination filter chips (All + per-country)"] },
    { v: "1.0.0", d: "Aug 1, 2026", c: ["Initial release — live $/min board (YATA stock × Torn resale), affordability + best pick"] }
  ];
  function openChangelog() {
    const bx = host.querySelector("#tdk-buyers");
    bx.classList.add("open");
    bx.innerHTML = '<div class="tdk-bh"><div class="tt">Changelog<small> — Torn Trade Desk</small></div><button class="tdk-bx" id="tdk-bclose">×</button></div>' +
      CHANGELOG.map(function (e) {
        return '<div class="tdk-clog"><div class="cv">v' + e.v + ' <span>· ' + e.d + '</span></div><ul>' + e.c.map(function (x) { return '<li>' + x + '</li>'; }).join("") + '</ul></div>';
      }).join("");
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

  build();
})();
