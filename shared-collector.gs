/**
 * Torn Trade Desk — Shared Foreign-Stock Collector (Google Apps Script)
 * ---------------------------------------------------------------------
 * Polls YATA's GLOBAL foreign-stock export every ~5 minutes and accumulates the same data the Trade Desk
 * userscript records locally — restock/sellout EVENTS + a day-of-week×hour SEASONAL sell-rate aggregate —
 * into one authoritative, always-on dataset. Serves it as JSON (doGet) so every user (including brand-new
 * installs, or anyone whose Tampermonkey storage got wiped) gets full 24/7 history without collecting it
 * themselves. Foreign stock is GLOBAL (one YATA snapshot everyone sees), so a SINGLE poller is enough — no
 * per-user uploads, no poisoning, no dedup math.
 *
 * ONE-TIME SETUP
 *   1. Go to https://script.google.com  →  New project.  Delete the sample, paste this whole file, Save.
 *   2. Pick the `setup` function in the toolbar and click Run. Authorize when Google prompts (it needs Drive
 *      to store the data file, and URL-fetch to reach YATA). This creates the storage file, installs the
 *      every-5-minutes trigger, and does one poll immediately.
 *   3. Deploy  →  New deployment  →  gear icon  →  "Web app".
 *        Execute as: Me     |     Who has access: Anyone
 *      Click Deploy, copy the Web app URL (ends in /exec).
 *   4. In Torn Trade Desk  →  ⚙ Settings  →  "Shared data feed URL", paste that /exec URL and click Save & Sync.
 *      Share the same /exec URL with anyone else who wants to read the feed.
 *
 * MAINTENANCE
 *   - It runs itself on the 5-min trigger. Check View → Executions for errors.
 *   - Reset all data: delete the "tdk_shared_data.json" file in your Drive, then Run `setup` again.
 *   - Stop collecting: Triggers (clock icon) → delete the `poll` trigger.
 */

var YATA_URL = 'https://yata.yt/api/v1/travel/export/';
var FILE_NAME = 'tdk_shared_data.json';
var GAP_MAX = 3600;               // skip selling intervals longer than 1h (browser/poll gap → unreliable rate)
var SAMPLE_MAX = 1800;            // only log restock/sellout events from samples ≤30min apart (a longer YATA-stale gap can hide multiple cycles)
var EV_MAX = 200;                 // cap restock/sellout events kept per item
var EV_AGE = 45 * 86400;          // prune events older than 45 days

/** Run once (and any time you want to (re)install the trigger). */
function setup() {
  load_();                        // ensure the storage file exists
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'poll') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(5).create();
  poll();                         // seed immediately
}

function file_() {
  var it = DriveApp.getFilesByName(FILE_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFile(FILE_NAME, '{}', 'application/json');
}
function load_() {
  var d;
  try { d = JSON.parse(file_().getBlob().getDataAsString()); } catch (e) { d = {}; }
  if (!d.last) d.last = {};       // "cc:id" -> [updTs, qty]  (last sample, to diff against)
  if (!d.events) d.events = {};   // "cc:id" -> { rs:[[t,amt]], so:[t], up:[[t,dq,prevQ]], q, max }
  if (!d.seasonal) d.seasonal = {}; // "cc:id" -> { bucket -> [soldQty, seconds, samples] }, bucket = UTCday*24+UTChour
  return d;
}
function save_(d) { file_().setContent(JSON.stringify(d)); }

/** Same heuristic the userscript uses for a "real" restock (batch refill / doubling), rare items live at 0-1. */
function isRealRestock_(dq, prevQ, maxQ) {
  if (dq <= 0) return false;
  if ((maxQ || 0) <= 10) return prevQ === 0;
  return prevQ === 0 ? dq >= 5 : (dq >= prevQ && dq >= 5);
}

/** Time-triggered: fetch YATA, diff each item against the last sample, accumulate events + seasonal. */
function poll() {
  var res = UrlFetchApp.fetch(YATA_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return;
  var yata; try { yata = JSON.parse(res.getContentText()); } catch (e) { return; }
  if (!yata || !yata.stocks) return;

  var d = load_();
  var now = Math.floor(Date.now() / 1000), evCut = now - EV_AGE;

  Object.keys(yata.stocks).forEach(function (cc) {
    var block = yata.stocks[cc];
    var upd = block.update || now;                 // YATA's per-country update timestamp
    var arr = block.stocks || block;
    if (!arr || !arr.forEach) return;
    arr.forEach(function (it) {
      var key = cc + ':' + it.id, q = it.quantity;
      var prev = d.last[key];                       // [updTs, qty]
      d.last[key] = [upd, q];
      if (!prev || prev[0] === upd) return;         // no prior sample, or YATA hasn't refreshed this country
      var prevT = prev[0], prevQ = prev[1], dq = q - prevQ, sampleDt = upd - prevT;

      var rec = d.events[key] || (d.events[key] = { rs: [], so: [], q: null, max: 0 });
      rec.max = Math.max(rec.max || 0, prevQ, q);
      if (rec.up) delete rec.up;                       // up[] (raw increases) is unused by every client prediction — drop it; it was ~30% of the feed
      // Only trust restock/sellout EVENTS from a short sample interval. For low-traffic countries YATA refreshes
      // rarely, so a jump measured across a multi-hour stale gap can hide several real restock/sellout cycles —
      // logging one event there pollutes the cadence with misleading sparse gaps (the old 50–75h Canada entries).
      if (sampleDt <= SAMPLE_MAX) {
        if (isRealRestock_(dq, prevQ, rec.max)) rec.rs.push([upd, dq]);
        else if (prevQ > 0 && q === 0) rec.so.push(upd);
      }
      rec.q = q;
      rec.rs = rec.rs.filter(function (e) { return e[0] >= evCut; }); if (rec.rs.length > EV_MAX) rec.rs.splice(0, rec.rs.length - EV_MAX);
      rec.so = rec.so.filter(function (t) { return t >= evCut; });    if (rec.so.length > EV_MAX) rec.so.splice(0, rec.so.length - EV_MAX);

      // Seasonal: attribute each SELLING interval's sold-qty + seconds to its day-of-week×hour bucket (UTC = TCT).
      if (dq < 0) {
        var dt = upd - prevT;
        if (dt > 0 && dt <= GAP_MAX) {
          var mid = new Date(((prevT + upd) / 2) * 1000);
          var b = mid.getUTCDay() * 24 + mid.getUTCHours();          // 0..167
          var sk = d.seasonal[key] || (d.seasonal[key] = {});
          var cell = sk[b] || (sk[b] = [0, 0, 0]);
          cell[0] += -dq; cell[1] += dt; cell[2] += 1;
        }
      }
    });
  });

  d.updated = now;
  save_(d);
}

/**
 * ONE-TIME SEED from the userscript's local data (e.g. hours you already collected before deploying this).
 * HOW:  1. In Torn Trade Desk → changelog window → click ⬇ Export (copies the blob to your clipboard).
 *       2. Paste that blob between the backticks below, replacing PASTE_EXPORT_JSON_HERE.
 *       3. Pick `seedFromBlob` in the toolbar dropdown and Run (no redeploy needed — this writes straight to the
 *          Drive file that doGet serves). Check View → Executions / Logs for the "Seeded:" line.
 *       4. Clear the blob back to the placeholder when done (keeps the file tidy).
 * SAFE: runs as YOU in the editor, not a public endpoint. Events merge by timestamp (idempotent); seasonal only
 * FILLS buckets the poller doesn't have yet (never overwrites the poller's own ongoing data → no double-count).
 */
function seedFromBlob() {
  var BLOB = `PASTE_EXPORT_JSON_HERE`;
  if (BLOB.indexOf('PASTE_EXPORT') === 0) { Logger.log('Paste your ⬇ Export blob between the backticks first.'); return; }
  var p = JSON.parse(BLOB);
  var d = load_(), evIn = p.events || {}, seaIn = p.seasonal || {};
  var addedEv = 0, filled = 0;
  Object.keys(evIn).forEach(function (k) {
    var s = evIn[k], t = d.events[k] || (d.events[k] = { rs: [], so: [], up: [], q: null, max: 0 });
    var mrg = function (dArr, sArr, kf) { var seen = {}; (dArr || []).forEach(function (e) { seen[kf(e)] = 1; }); (sArr || []).forEach(function (e) { if (!seen[kf(e)]) { dArr.push(e); addedEv++; } }); };
    mrg(t.rs, s.rs, function (e) { return e[0]; }); mrg(t.so, s.so, function (x) { return x; }); t.up = t.up || []; mrg(t.up, s.up, function (e) { return e[0]; });
    t.rs.sort(function (a, b) { return a[0] - b[0]; }); t.so.sort(function (a, b) { return a - b; }); t.up.sort(function (a, b) { return a[0] - b[0]; });
    t.max = Math.max(t.max || 0, s.max || 0); if (t.q == null) t.q = s.q;
  });
  Object.keys(seaIn).forEach(function (k) {
    var dk = d.seasonal[k] || (d.seasonal[k] = {});
    Object.keys(seaIn[k]).forEach(function (b) { if (!dk[b]) { dk[b] = seaIn[k][b].slice(); filled++; } }); // gap-fill only
  });
  save_(d);
  Logger.log('Seeded: +' + addedEv + ' events merged, ' + filled + ' seasonal buckets filled. Items now: ' + Object.keys(d.events).length);
}

/** Web-app read endpoint: returns the collected dataset in the same shape the userscript's ⬇ Export uses. */
function doGet(e) {
  var d = load_();
  // Strip any residual up[] (unused by clients; poll() drops it going forward, this covers records not yet re-polled).
  var events = {}, src = d.events || {};
  Object.keys(src).forEach(function (k) { var r = src[k]; events[k] = { rs: r.rs || [], so: r.so || [], q: r.q, max: r.max }; });
  var out = {
    kind: 'tdk-restock-export',
    source: 'shared-collector',
    at: d.updated || Math.floor(Date.now() / 1000),
    fields: 'events[cc:id]={rs:[[t,amt]],so:[t],q,max}; seasonal[cc:id]={bucket->[soldQty,seconds,samples]}, bucket=UTCday(0=Sun..6)*24+UTChour(0..23)',
    events: events,
    seasonal: d.seasonal || {}
  };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
