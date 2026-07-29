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
//   ?landing=LEVEL[,AIRCRAFT[,FIELD]]         landing practice (Lv 1-15)
//   ?mission=racing|cas[,AIRCRAFT[,FIELD]]    extension missions (lap race /
//                                             close air support) via a
//                                             generated .yfs
//   ?retry=1                                  Retry Previous Flight
//                                             (engine-saved prevflight.dat)
//   ?openyfs=1                                fly a user-supplied .yfs (the
//                                             top page put it in
//                                             sessionStorage; File > Open)
//   ?openreplay=1                             replay a user-supplied RECORDED
//                                             .yfs (NUMRECOR present — the
//                                             top page auto-routes)
//   ?demo=1                                   auto demo, looping forever
//                                             (screensaver mode; leave via
//                                             browser navigation)
//   ?host=1&name=NAME[&field=FIELD]           host a multiplayer room (server
//                                             mode; ?room= fixes the room code)
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
    // ?landing=LEVEL[,AIRCRAFT[,FIELD]] — Sim > Landing Practice (fork
    // -landingpractice, EXEMODE_LANDINGPRACTICE): the engine maps the level
    // (1-15) to its leg/cross-wind/weather table and shows the traffic-pattern
    // info screen, which takes off on Space/click (a flight-screen dialog —
    // stays engine-side per the web-shell boundary).  Defaults: the classic
    // trainer pairing — F/A-18 into AOMORI (the engine's own default field).
    var ldg = q.get('landing');
    if (ldg) {
      var l = ldg.split(',');
      a.push('-landingpractice', intParam(l[0], 1, 1, 15),
        l[1] || 'F-18C_HORNET', l[2] || 'AOMORI');
    }
    // ?demo=1 — the engine's kiosk demo loop (-demoforever,
    // EXEMODE_OPENINGDEMOFOREVER): random dogfight/acro demos, forever.  A
    // keypress skips to the NEXT demo (native soak/exhibition semantics), so
    // there is deliberately NO -autoexit: the mode never returns to the menu;
    // leaving is browser navigation (back / reopen the top page).
    if (q.get('demo')) {
      a.push('-demoforever');
    }
    // ?host=1&name=NAME[&field=FIELD] hosts a multiplayer room directly: the
    // engine's -server (fscmdparaminfo.cpp, EXEMODE_SERVER) boots straight into
    // server mode (StartNetServerMode), and the web port's yssocket layer claims
    // a signaling room (?room= fixes the code, else an 8-digit one is drawn) —
    // the shell's Room chip then offers the invite link.  &name= carries the
    // pilot name (separate param like ?join=&name=, NOT comma-packed: the value
    // of ?host itself is only a trigger, so legacy ?host=1 links keep working).
    // FIELD is optional; the engine falls back to its net-config default field.
    // No name -> no args: index.html shows the host form instead (manual-launch
    // path), which navigates back here with &name= filled in.  ?join= wins over
    // ?host= — the join flow appends -client later and the engine acts on the
    // LAST execution mode parsed, so keep the loser out of the argv entirely.
    if (q.get('host') && !q.get('join')) {
      var hn = (q.get('name') || '').trim();
      if (hn) {
        a.push('-server', hn);
        var hf = (q.get('field') || '').trim();
        if (hf) a.push(hf);
      }
    }
    // ?createflight=1 boots a flight authored by the Create-Flight page: the
    // page wrote a spec to sessionStorage and index.html's preRun turns it into
    // the .yfs at CREATEFLIGHT_YFS before main() reads it (yfs.js).  The URL
    // carries no spec (it can be large) — only the trigger.
    if (q.get('createflight')) {
      a.push('-flyyfs', CREATEFLIGHT_YFS);
    }
    // ?mission=racing|cas boots a BUILT-IN extension-mission .yfs: index.html's
    // preRun turns ysfwYfs.missionSpec(?mission=) into the same generated file
    // the Create-Flight page uses, and -flyyfs reads it.  The extension lines
    // (EXTENSIO RACINGMODE / CLOSEAIRSUPPORT) restore the mission through the
    // engine's extension registry (fsworld.cpp case 52).
    if (q.get('mission') && !q.get('createflight')) {
      a.push('-flyyfs', CREATEFLIGHT_YFS);
    }
    // ?retry=1 — the native Sim > Retry Previous Flight: the engine saves a
    // start snapshot of every launched flight to prevflight.dat (.yfs format,
    // FsGetPrevFlightFile); -flyyfs re-flies it.  No previous flight -> the
    // load finds nothing and -autoexit returns to the shell.
    // ?openyfs=1 — the native File > Open: the top page put the user's .yfs
    // text in sessionStorage and index.html's preRun writes it to
    // __openflight.yfs before main() reads it.
    if (a.indexOf('-flyyfs') === -1) {
      if (q.get('retry')) {
        a.push('-flyyfs', USER_DIR + '/prevflight.dat');
      } else if (q.get('openyfs')) {
        a.push('-flyyfs', USER_DIR + '/__openflight.yfs');
      } else if (q.get('openreplay')) {
        // A record-carrying .yfs: -flyyfs would reject it (PlayerPlaneIsReady
        // needs a record-free player), -replayrecord plays it back.
        a.push('-replayrecord', USER_DIR + '/__openflight.yfs');
      }
    }
    // Every deep link also gets -autoexit: when the engine returns to its menu
    // (flight/replay over, or the deep link failed to resolve) it TERMINATES
    // instead, the port fires 'ysfw-terminated', and the shell navigates away —
    // the engine menu is never presented (instant handover, docs/web-shell.md).
    // All these modes start their flight synchronously inside the init state
    // machine (fsmain.cpp case 7), so autoexit cannot fire before takeoff.
    // -server included: quitting the hosted session returns to the engine menu,
    // which -autoexit turns into a terminate -> the shell takes over.
    if (a.indexOf('-freeflight') >= 0 || a.indexOf('-endurance') >= 0 ||
        a.indexOf('-intercept') >= 0 || a.indexOf('-replayrecord') >= 0 ||
        a.indexOf('-flyyfs') >= 0 || a.indexOf('-server') >= 0 ||
        a.indexOf('-landingpractice') >= 0) {
      a.push('-autoexit');
    }
    return a;
  }

  // Which deep link (if any) owns this boot.  'flight' kinds (freeflight,
  // endurance, ..., host) arm the flight-end return watcher; 'replay' arms the
  // replay-end watcher; null means a manual launch (pack panel).  Mirrors buildEngineArgs's
  // precedence: when several are present the engine acts on the LAST parsed
  // execution mode, but for arming watchers any flight kind counts.
  function deepLinkKind(search) {
    var q = search instanceof URLSearchParams ? search : new URLSearchParams(search);
    if (q.get('freeflight')) return 'freeflight';
    if (q.get('endurance')) return 'endurance';
    if (q.get('intercept')) return 'intercept';
    if (q.get('createflight')) return 'createflight';
    if (q.get('mission')) return 'mission';
    if (q.get('retry')) return 'retry';
    if (q.get('openyfs')) return 'openyfs';
    if (q.get('openreplay')) return 'openreplay';
    if (q.get('replay')) return 'replay';
    if (q.get('landing')) return 'landing';
    if (q.get('demo')) return 'demo';
    // 'host' only when buildEngineArgs would actually emit -server (name given,
    // no ?join=): a bare ?host=1 stays a manual launch so index.html can show
    // the host form instead of booting an argv-less engine into its own menu.
    if (q.get('host') && !q.get('join') && (q.get('name') || '').trim()) return 'host';
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
