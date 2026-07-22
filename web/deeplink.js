// Deep-link → engine-argument mapping (the web shell's "entry" contract).
//
// The top page and studio pages drive the engine ENTIRELY through URL deep
// links; the engine's own main menu is never part of the web UX (docs/
// web-shell.md).  This module is the single place where a URL query string
// becomes a command-line argument vector for the WASM engine's main().
//
// Loaded as a CLASSIC script from index.html (before the Module definition,
// which needs it synchronously), so it must not use import/export.  Tests
// import it for its globalThis side effect (test/deeplink.test.mjs) — same
// dual-use arrangement as the whitelist in fly-return.js, but inverted:
// index.html consumes this module directly instead of keeping an inline copy.
//
// Supported deep links (all composable with ?lang=):
//   ?freeflight=AIRPLANE[,FIELD[,POSITION]]   free flight (Quick Flight)
//   ?endurance=AIRPLANE[,FIELD[,WINGMEN,LEVEL,AAM]]
//                                             endurance mission (wave defense)
//   ?intercept=AIRPLANE[,FIELD[,STEALTH,AIRCOVER,HEAVY,BOMB,ATTACKERS,WINGMEN]]
//                                             intercept mission (stop the raid)
//   ?createflight=1                           fly the Create-Flight page's spec
//                                             (spec in sessionStorage, -> .yfs)
//   ?replay=<file>                            play a saved recording
globalThis.ysfwDeepLink = (function () {
  'use strict';

  var USER_DIR = '/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT';
  // Where the Create-Flight page's generated .yfs is written (index.html preRun,
  // from the sessionStorage spec) and where -flyyfs reads it.
  var CREATEFLIGHT_YFS = USER_DIR + '/__createflight.yfs';

  // Clamp helper for numeric mission parameters: non-numeric input falls back
  // to def, numeric input is bounded to [lo, hi].  The engine clamps again
  // (YsBound in fscmdparaminfo.cpp) — this keeps the URL surface predictable
  // and the argv free of junk strings.
  function intParam(raw, def, lo, hi) {
    var n = parseInt(raw, 10);
    if (isNaN(n)) n = def;
    return String(Math.min(hi, Math.max(lo, n)));
  }

  // Build main()'s argument vector from a query string (a string or a
  // URLSearchParams).  Pure: no DOM, no globals read.
  function buildEngineArgs(search) {
    var q = search instanceof URLSearchParams ? search : new URLSearchParams(search);
    var a = [];
    // UI language follows the browser locale (ja/en); override with ?lang=ja etc.
    var lang = q.get('lang');
    if (lang) a.push('-language', lang);
    var ff = q.get('freeflight');
    if (ff) {
      var p = ff.split(',');
      // Default start position: NORTH10000_01 is an airborne start that exists in
      // every bundled field's .stp (verified).  The old default 'NORTH3000' is in
      // NO .stp, so a bare ?freeflight=AIRCRAFT silently failed to spawn.
      a.push('-freeflight', p[0], p[1] || 'ATSUGI_AIRBASE', p[2] || 'NORTH10000_01');
    }
    // ?endurance=AIRPLANE,FIELD,WINGMEN,LEVEL,AAM — the engine's endurance
    // mission (-endurance, EXEMODE_ENDURANCE): waves of attackers, fly until
    // shot down.  fsmain.cpp sets up the player loadout (AAM+rocket) and takes
    // off directly — no engine dialog is involved, same contract as
    // -freeflight.  Defaults: same field default as freeflight; 2 wingmen,
    // enemy level 3 of 1-5, AAMs allowed.
    var en = q.get('endurance');
    if (en) {
      var e = en.split(',');
      a.push('-endurance', e[0], e[1] || 'ATSUGI_AIRBASE',
        intParam(e[2], 2, 0, 2),   // wingmen 0-2
        intParam(e[3], 3, 1, 5),   // enemy level 1-5
        intParam(e[4], 1, 0, 1));  // allow AAM 0/1
    }
    // ?intercept=AIRPLANE,FIELD,STEALTH,AIRCOVER,HEAVY,BOMB,ATTACKERS,WINGMEN —
    // the engine's intercept mission (-intercept, EXEMODE_INTERCEPT): an
    // attacker raid comes in, stop it.  Flag order mirrors the engine's argv
    // (fscmdparaminfo.cpp; requires the fork's i-relative index fix).
    // Defaults: a classic raid — no stealth, escorted heavy bombers with
    // bombs, 3 attackers, 2 wingmen.
    var ic = q.get('intercept');
    if (ic) {
      var c = ic.split(',');
      a.push('-intercept', c[0], c[1] || 'ATSUGI_AIRBASE',
        intParam(c[2], 0, 0, 1),   // attackers may include stealth
        intParam(c[3], 1, 0, 1),   // attackers have air cover (escort)
        intParam(c[4], 1, 0, 1),   // attackers may include heavy bombers
        intParam(c[5], 1, 0, 1),   // attackers carry bombs
        intParam(c[6], 3, 1, 5),   // number of attackers 1-5
        intParam(c[7], 2, 0, 2));  // wingmen 0-2
    }
    // ?replay=<file> plays a saved recording: the engine's -replayrecord loads the
    // .yfs and auto-starts playback (a loaded flight record makes PlayerPlaneIsReady
    // false).  The file lives in the IDBFS user dir's replays/; sanitize to a bare
    // name so it cannot escape that directory.
    var rp = q.get('replay');
    if (rp) {
      var rf = String(rp).replace(/[^A-Za-z0-9._-]/g, '');
      if (rf) a.push('-replayrecord', USER_DIR + '/replays/' + rf);
    }
    // ?createflight=1 boots a flight authored by the Create-Flight page: the
    // page wrote a spec to sessionStorage and index.html's preRun turns it into
    // the .yfs at CREATEFLIGHT_YFS before main() reads it (yfs.js).  The URL
    // carries no spec (it can be large) — only the trigger.
    if (q.get('createflight')) {
      a.push('-flyyfs', CREATEFLIGHT_YFS);
    }
    // Every deep link also gets -autoexit: when the engine returns to its menu
    // (flight/replay over, or the deep link failed to resolve) it TERMINATES
    // instead, the port fires 'ysfw-terminated', and the shell navigates away —
    // the engine menu is never presented (instant handover, docs/web-shell.md).
    // All three modes start their flight synchronously inside the init state
    // machine (fsmain.cpp case 7), so autoexit cannot fire before takeoff.
    if (a.indexOf('-freeflight') >= 0 || a.indexOf('-endurance') >= 0 ||
        a.indexOf('-intercept') >= 0 || a.indexOf('-replayrecord') >= 0 ||
        a.indexOf('-flyyfs') >= 0) {
      a.push('-autoexit');
    }
    return a;
  }

  // Which deep link (if any) owns this boot.  'flight' kinds (freeflight,
  // endurance) arm the flight-end return watcher; 'replay' arms the replay-end
  // watcher; null means a manual launch (pack panel).  Mirrors buildEngineArgs's
  // precedence: when several are present the engine acts on the LAST parsed
  // execution mode, but for arming watchers any flight kind counts.
  function deepLinkKind(search) {
    var q = search instanceof URLSearchParams ? search : new URLSearchParams(search);
    if (q.get('freeflight')) return 'freeflight';
    if (q.get('endurance')) return 'endurance';
    if (q.get('intercept')) return 'intercept';
    if (q.get('createflight')) return 'createflight';
    if (q.get('replay')) return 'replay';
    return null;
  }

  // True when this boot goes STRAIGHT into the engine (no pack panel): any
  // deep link above.  (?join= boots straight too but is decided separately in
  // index.html — it also involves the -client args and pack-sync gate.)
  function isDirectBoot(search) {
    return null !== deepLinkKind(search);
  }

  return {
    USER_DIR: USER_DIR,
    buildEngineArgs: buildEngineArgs,
    deepLinkKind: deepLinkKind,
    isDirectBoot: isDirectBoot,
  };
})();
