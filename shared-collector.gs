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
var EV_MAX = 200;                 // cap restock/sellout events kept per item
var UP_MAX = 300;                 // cap raw-increase samples kept per item
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
      var prevT = prev[0], prevQ = prev[1], dq = q - prevQ;

      var rec = d.events[key] || (d.events[key] = { rs: [], so: [], up: [], q: null, max: 0 });
      rec.max = Math.max(rec.max || 0, prevQ, q);
      if (dq > 0) rec.up.push([upd, dq, prevQ]);
      if (isRealRestock_(dq, prevQ, rec.max)) rec.rs.push([upd, dq]);
      else if (prevQ > 0 && q === 0) rec.so.push(upd);
      rec.q = q;
      rec.rs = rec.rs.filter(function (e) { return e[0] >= evCut; }); if (rec.rs.length > EV_MAX) rec.rs.splice(0, rec.rs.length - EV_MAX);
      rec.so = rec.so.filter(function (t) { return t >= evCut; });    if (rec.so.length > EV_MAX) rec.so.splice(0, rec.so.length - EV_MAX);
      rec.up = rec.up.filter(function (e) { return e[0] >= evCut; }); if (rec.up.length > UP_MAX) rec.up.splice(0, rec.up.length - UP_MAX);

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

/** Web-app read endpoint: returns the collected dataset in the same shape the userscript's ⬇ Export uses. */
function doGet(e) {
  var d = load_();
  var out = {
    kind: 'tdk-restock-export',
    source: 'shared-collector',
    at: d.updated || Math.floor(Date.now() / 1000),
    fields: 'events[cc:id]={rs:[[t,amt]],so:[t],up:[[t,dq,prevQ]],q,max}; seasonal[cc:id]={bucket->[soldQty,seconds,samples]}, bucket=UTCday(0=Sun..6)*24+UTChour(0..23)',
    events: d.events || {},
    seasonal: d.seasonal || {}
  };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
