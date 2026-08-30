// Usage metrics shipper -> POST /metric (worker/signal.js -> Workers Analytics
// Engine).  The question it exists to answer: HOW MANY PEOPLE ACTUALLY PLAY?
//
// What was already measurable before this file, and why it was not enough:
//   - Cloudflare Web Analytics (the beacon at the bottom of index.html) counts
//     page views and visits.  A page view is not a flight: the top page is a
//     launcher, the engine is a 23 MB download, and more than half the visits
//     arrive on a phone.
//   - web/diag.js ships heartbeats to Workers Logs.  Those DO mark real flight
//     time, but Workers Logs keeps 7 days and cannot be aggregated with SQL --
//     it is a postmortem tool, not a counter.
// Analytics Engine keeps three months and is queryable with SQL, so a flight
// that happened today is still countable in October.  See docs/metrics.md for
// the schema, the SQL cookbook, and the read-token setup.
//
// SOURCE OF TRUTH: this module owns NO poller.  web/diag.js already runs the
// one loop that watches globalThis.ysfwInFlight / ysfwReplaying /
// Module.ysfwVr, so metrics subscribes to diag's event stream instead
// (ysfwDiag.subscribe).  A second watcher would be a second definition of "a
// flight started", and two definitions drift.
//
// PRIVACY: no account, no cookie, no personal data.  A random id in
// localStorage distinguishes "ten visits by one person" from "ten people" --
// that is the whole reason it exists.  ?metrics=off turns this module off for
// good on that browser; ?metrics=dev tags the traffic as the maintainer's own
// (QA loads dominate the numbers at this scale) so queries can exclude it.
//
// VOLUME: a handful of data points per page load (one session, one pair per
// flight, one per VR session), against a free-tier budget of 100,000/day.
globalThis.ysfwMetrics = (function () {
  'use strict';

  var ENDPOINT = '/metric';
  var VISITOR_KEY = 'ysfw-visitor';       // {id, first, visits}
  var AUDIENCE_KEY = 'ysfw-metrics';      // 'dev' | 'off' (absent = public)
  var DAY_MS = 86400000;
  var WIRE_VERSION = 1;

  // ---- pure helpers -------------------------------------------------------

  function randomId() {
    try {
      var c = globalThis.crypto;
      if (c && c.getRandomValues) {
        var b = new Uint8Array(8);
        c.getRandomValues(b);
        var out = '';
        for (var i = 0; i < b.length; ++i) out += (b[i] + 0x100).toString(16).slice(1);
        return out;
      }
    } catch (e) {}
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }

  function dayStamp(ms) { return new Date(ms).toISOString().slice(0, 10); }

  // Read-modify-write the visitor record.  Returns the record plus `visits`
  // (1 on the very first page load ever) and `days` (days since first seen) --
  // the two numbers that turn a pile of sessions into a repeat rate.
  //
  // `store` is a localStorage-shaped object; a browser in private mode throws
  // on access, and then every load looks like a brand-new visitor.  That is
  // reported honestly as visits = 0 rather than silently as 1: a zero in the
  // data means "this browser would not let us tell", not "first-timer".
  function readVisitor(store, nowMs, mkId) {
    var raw = null;
    try { raw = store ? store.getItem(VISITOR_KEY) : null; } catch (e) {}
    var rec = null;
    // A corrupt record is an ABSENT record, not a storage failure: the browser
    // is willing to remember, we just cannot read what is there.
    if (raw) { try { rec = JSON.parse(raw); } catch (e) {} }

    var id, first, visits;
    if (rec && typeof rec.id === 'string' && rec.id) {
      id = rec.id;
      first = /^\d{4}-\d{2}-\d{2}$/.test(rec.first) ? rec.first : dayStamp(nowMs);
      visits = (typeof rec.visits === 'number' && rec.visits > 0 ? rec.visits : 0) + 1;
    } else {
      id = (mkId || randomId)();
      first = dayStamp(nowMs);
      visits = 1;
    }

    var persisted = false;
    try {
      store.setItem(VISITOR_KEY, JSON.stringify({ id: id, first: first, visits: visits }));
      persisted = true;
    } catch (e) {}
    // Storage denied (private mode, blocked storage): this load cannot be tied
    // to any other, so it claims no visit number at all.
    if (!persisted) visits = 0;

    var days = Math.round((nowMs - Date.parse(first + 'T00:00:00Z')) / DAY_MS);
    if (!isFinite(days) || days < 0) days = 0;
    return { id: id, first: first, visits: visits, days: days, persisted: persisted };
  }

  // 'off' | 'dev' | 'public'.  The query parameter is sticky: ?metrics=dev once
  // per browser the maintainer plays on is enough, and ?metrics=public undoes it.
  function readAudience(store, search) {
    var wanted = null;
    try {
      var q = search instanceof URLSearchParams ? search : new URLSearchParams(search || '');
      var v = (q.get('metrics') || '').toLowerCase();
      if (v === 'off' || v === 'dev' || v === 'public') wanted = v;
    } catch (e) {}
    try {
      if (wanted === 'public') store.removeItem(AUDIENCE_KEY);
      else if (wanted) store.setItem(AUDIENCE_KEY, wanted);
      var held = store.getItem(AUDIENCE_KEY);
      if (held === 'off' || held === 'dev') return held;
    } catch (e) {
      if (wanted && wanted !== 'public') return wanted;  // honour it for this load at least
    }
    return 'public';
  }

  // How this page load was launched, and what it is pointed at.  `launch` is
  // the deep-link kind ('menu' when the user will pick inside the engine);
  // `role` separates solo play from the two multiplayer sides, which is the
  // difference between "someone flew" and "someone flew WITH someone".
  function classify(search, ctx) {
    var q = search instanceof URLSearchParams ? search : new URLSearchParams(search || '');
    var dl = (ctx && ctx.deepLink) || null;
    var kind = null, targets = { aircraft: '', field: '' };
    if (dl) {
      try { kind = dl.deepLinkKind(q); } catch (e) {}
      try { targets = dl.launchTargets(q) || targets; } catch (e) {}
    }
    var role = 'solo';
    if (q.get('join')) role = 'join';
    else if (kind === 'host') role = 'host';
    return {
      launch: kind || 'menu',
      aircraft: targets.aircraft || '',
      field: targets.field || '',
      role: role,
      lang: (q.get('lang') || (ctx && ctx.language) || '').slice(0, 16),
      device: (ctx && ctx.touch) ? 'touch' : 'desktop'
    };
  }

  // ---- the recorder -------------------------------------------------------
  //
  // Consumes web/diag.js events and turns transitions into data points.  Pure
  // apart from cfg.now()/cfg.emit(), so test/metrics.test.mjs can drive a whole
  // session (load -> fly -> land -> leave) without a browser.
  //
  // Both ends of a flight are recorded, not just the end: a player who closes
  // the tab mid-flight produces a start with no end, and the gap between the
  // two counts is itself the answer to "do people finish a flight?".  A
  // pagehide while flying is closed out as reason 'left' on a best-effort
  // beacon, so most of those still carry a duration.
  function createRecorder(cfg) {
    var now = cfg.now;
    var emit = cfg.emit;
    var base = cfg.context;                 // classify() output
    var flight = null;                      // {startMs, vr:boolean, hiddenMs:number}
    var sawVr = false;
    var closed = false;
    var hiddenSince = null;                 // ms at which the document went hidden

    function fields(extra) {
      var f = {
        launch: base.launch,
        aircraft: base.aircraft,
        field: base.field,
        role: base.role,
        // On every event, not just 'session': the question this column exists
        // to answer is "do zh-Hans players fly differently from en ones", and
        // that is a filter on flight rows.
        lang: base.lang,
        device: sawVr ? 'vr' : base.device
      };
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) f[k] = extra[k];
      return f;
    }

    // Hidden time that overlaps the open flight.  Clipped at the flight's start
    // because a tab can already be in the background when a flight opens.
    function hiddenSoFar() {
      if (hiddenSince === null || !flight) return 0;
      return Math.max(0, now() - Math.max(hiddenSince, flight.startMs));
    }

    // A flight's duration is the time the tab was VISIBLE, not the wall clock.
    // This is not a smoothing choice: a hidden tab is not simulating, because
    // the engine's main loop is a requestAnimationFrame driver and the browser
    // stops calling it (on mobile the whole tab is frozen).  Wall clock counts
    // that dead time as flying.
    //
    // Left uncorrected it does not add noise, it swamps the number: on
    // 2026-08-30 one phone reported a single 19,317-second flight -- 5h22m,
    // fifteen times the previous longest ever -- and that one row WAS the day's
    // 322 minutes.  The visitor's other flights that week were 71-133 seconds.
    // The failure is silent and one-sided (durations only ever grow), so the
    // headline "minutes played" drifts up as the phone share grows.
    //
    // `hidden` ships alongside so the subtraction is auditable: a row where it
    // dwarfs `secs` is a parked tab, and one where it is always 0 means these
    // events stopped arriving -- neither is visible if we only ship the
    // corrected number.
    function endFlight(reason) {
      if (!flight) return;
      var hiddenMs = flight.hiddenMs + hiddenSoFar();
      var secs = Math.max(0, Math.round((now() - flight.startMs - hiddenMs) / 1000));
      var wasVr = flight.vr || sawVr;
      flight = null;
      emit('flight-end', fields({
        secs: secs,
        hidden: Math.max(0, Math.round(hiddenMs / 1000)),
        reason: reason,
        device: wasVr ? 'vr' : base.device
      }));
    }

    function onDiag(ev) {
      if (closed || !ev || !ev.type) return;
      if (ev.type === 'mode') {
        // diag pushes a snapshot on every transition, including the harmless
        // null -> false one right after load; only the false -> true edge opens
        // a flight.  Replay playback is deliberately NOT a flight: watching a
        // recording is not flying one.
        var flying = !!ev.inFlight;
        if (flying && !flight) {
          flight = { startMs: now(), vr: sawVr, hiddenMs: 0 };
          emit('flight-start', fields({}));
        } else if (!flying && flight) {
          endFlight('ended');
        }
        return;
      }
      if (ev.type === 'vis') {
        // diag.js owns the visibilitychange listener (see its 'vis' push); this
        // side only accumulates. Idempotent on repeats: a second 'hidden'
        // without an intervening 'visible' must not move the start of the
        // hidden span forward, or the parked time it is there to subtract
        // shrinks back to nothing.
        if (ev.hidden) {
          if (hiddenSince === null) hiddenSince = now();
        } else {
          if (flight) flight.hiddenMs += hiddenSoFar();
          hiddenSince = null;
        }
        return;
      }
      if (ev.type === 'vr-start') {
        sawVr = true;
        if (flight) flight.vr = true;
        return;
      }
      if (ev.type === 'vr-fail') {
        // A VR entry that never became a session (index.html's Module.onVrFail
        // -- the glue only fires it when no vr-end will report the attempt).
        // Deliberately does NOT set sawVr: no session was ever presented, so
        // this visitor's flights stay desktop/touch, which is also the column
        // that says WHAT bounced at the VR door.
        emit('vr-fail', fields({ reason: String(ev.reason || 'unknown').slice(0, 32) }));
        return;
      }
      if (ev.type === 'vr-end') {
        // 30s-bucket fps series, as a bounded comma-joined string: one avg per
        // session cannot separate "warm-up is heavy" from "degrades over
        // time", nor missed vsyncs from a 60Hz grant -- and headset sessions
        // are exactly the ones that only ever exist remotely.
        var series = '';
        if (Array.isArray(ev.fpsSeries)) {
          series = ev.fpsSeries.map(function (v) {
            return Math.max(0, Math.round(Number(v) || 0));
          }).join(',').slice(0, 400);
        }
        emit('vr-end', fields({
          secs: Math.max(0, Math.round(Number(ev.seconds) || 0)),
          fps: Math.max(0, Math.round(Number(ev.avgFps) || 0)),
          reason: String(ev.reason || 'exit').slice(0, 32),
          hz: Math.max(0, Math.round(Number(ev.grantedHz) || 0)),
          cpu: Math.max(0, Math.round((Number(ev.cpuMs) || 0) * 10)) / 10,
          fpsSeries: series
        }));
        return;
      }
      if (ev.type === 'bye') {
        // The page is going away (navigation, tab close, engine terminate ->
        // shell handover).  Close an open flight so its duration survives.
        endFlight('left');
        closed = true;
        return;
      }
    }

    return {
      onDiag: onDiag,
      session: function (visitor) {
        emit('session', fields({
          visits: visitor.visits,
          days: visitor.days,
          ref: (cfg.referrerHost || '').slice(0, 64)
        }));
      },
      // Test seam: is a flight currently open?
      flying: function () { return !!flight; }
    };
  }

  // ---- browser wiring -----------------------------------------------------

  var api = {
    readVisitor: readVisitor,
    readAudience: readAudience,
    classify: classify,
    createRecorder: createRecorder
  };

  // Importable from node for tests: no window means no wiring, no timers.
  if (typeof window === 'undefined' || typeof document === 'undefined') return api;

  var store = null;
  try { store = window.localStorage; } catch (e) {}
  var audience = readAudience(store, location.search);
  if (audience === 'off') {
    api.audience = 'off';
    return api;                              // opted out: nothing is sent, ever
  }

  var visitor = readVisitor(store, Date.now(), randomId);
  var sid = (globalThis.ysfwDiag && globalThis.ysfwDiag.sid) || randomId().slice(0, 8);
  var touch = false;
  try {
    touch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) ||
      navigator.maxTouchPoints > 0 || ('ontouchstart' in window);
  } catch (e) {}
  var referrerHost = '';
  try {
    if (document.referrer) {
      var rh = new URL(document.referrer).hostname;
      if (rh && rh !== location.hostname) referrerHost = rh;
    }
  } catch (e) {}

  var queue = [];
  var timer = null;

  function payload(events) {
    return JSON.stringify({
      v: WIRE_VERSION,
      vid: visitor.id,
      sid: sid,
      aud: audience,
      // ASSET is defined further down index.html, so read it at SEND time --
      // this module runs before it exists.
      build: String((globalThis.ASSET && globalThis.ASSET.build) || 'dev').slice(0, 24),
      events: events
    });
  }

  function ship(useBeacon) {
    if (!queue.length) return;
    var body = payload(queue.splice(0, queue.length));
    try {
      if (useBeacon && navigator.sendBeacon &&
          navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))) return;
      fetch(ENDPOINT, {
        method: 'POST',
        body: body,
        keepalive: true,
        headers: { 'Content-Type': 'application/json' }
      }).catch(function () {});
    } catch (e) {}
  }

  function emit(type, f) {
    f.e = type;
    queue.push(f);
    if (queue.length >= 20) { ship(false); return; }
    // Coalesce the events of one moment (a flight-end is usually followed by a
    // 'bye' a heartbeat later) into a single request.
    if (timer) return;
    timer = setTimeout(function () { timer = null; ship(false); }, 1500);
  }

  var recorder = createRecorder({
    now: Date.now,
    emit: emit,
    referrerHost: referrerHost,
    context: classify(location.search, {
      deepLink: globalThis.ysfwDeepLink,
      language: (navigator.language || ''),
      touch: touch
    })
  });

  if (globalThis.ysfwDiag && globalThis.ysfwDiag.subscribe) {
    globalThis.ysfwDiag.subscribe(recorder.onDiag);
  }
  recorder.session(visitor);
  // pagehide is the last reliable moment on mobile (a frozen tab never fires
  // unload); diag pushes its own 'bye' there, which closes an open flight
  // through the subscription above -- this flush is what actually posts it.
  window.addEventListener('pagehide', function () { ship(true); });

  api.audience = audience;
  api.visitor = visitor;
  api.sid = sid;
  api.flush = function () { ship(false); };
  return api;
})();
