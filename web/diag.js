// Client-side diagnostics shipper -> POST /clientlog (worker/signal.js).
//
// Why: 2026-07 Quest field reports include an in-headset HANG -- the headset
// browser's console is unreachable, and a frozen main thread can't send
// anything at the moment it dies.  So the evidence model is:
//   - a heartbeat every 10s WHILE a session is interesting (VR presenting,
//     in flight, or replaying), carrying a small state snapshot.  In Workers
//     Logs a hang shows up as the heartbeat stream STOPPING at time T with
//     the last known state attached.
//   - a localStorage sentinel updated on every heartbeat; the NEXT page load
//     compares it against a clean-shutdown marker (pagehide) and, when the
//     previous session ended uncleanly, ships an "unclean-end" event with
//     that last snapshot.
//   - error capture (window.onerror / unhandledrejection / console.error)
//     and mode-transition breadcrumbs, ring-buffered and flushed in batches.
//
// Volume: one small POST per 10s at most while active, plus error bursts.
// Other modules can add breadcrumbs via globalThis.ysfwDiag.push(type, data).
(function () {
  'use strict';
  const SID = Math.random().toString(36).slice(2, 10);
  const buf = [];
  const subs = [];
  let flushTimer = null;

  function push(type, data) {
    const ev = Object.assign({ t: Date.now(), type: String(type).slice(0, 24) }, data || {});
    // Fan out to subscribers BEFORE the ring buffer can drop anything.  This is
    // how web/metrics.js sees flight/VR transitions: diag already owns the one
    // poller that watches ysfwInFlight / ysfwReplaying / Module.ysfwVr, so a
    // second watcher would be a second definition of "a flight started" and the
    // two would drift.  Subscribers are isolated -- a throwing listener must not
    // take diagnostics down with it.
    for (let i = 0; i < subs.length; ++i) {
      try { subs[i](ev); } catch (e) {}
    }
    buf.push(ev);
    if (buf.length > 40) buf.splice(0, buf.length - 40);
    // vr-start/vr-end ship promptly too: headset sessions are exactly the ones
    // that can hang, so don't leave the usage event sitting in the ring buffer.
    // vr-fail likewise: a visitor the VR door just bounced is likely to leave
    // within seconds.
    if (type === 'error' || type === 'cerror' || type === 'unclean-end' ||
        type === 'vr-start' || type === 'vr-end' || type === 'vr-fail') flushSoon(2000);
  }

  function snapshot() {
    let vr = null;
    try {
      const v = globalThis.Module && globalThis.Module.ysfwVr;
      if (v) vr = { session: !!v.session, endReason: v.endReason || null };
    } catch (e) {}
    return {
      inFlight: !!globalThis.ysfwInFlight,
      replaying: !!globalThis.ysfwReplaying,
      vr: vr
    };
  }

  function flush(useBeacon) {
    if (!buf.length) return;
    const payload = JSON.stringify({ sid: SID, events: buf.splice(0, buf.length) });
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon('/clientlog', new Blob([payload], { type: 'application/json' }));
        return;
      }
      fetch('/clientlog', {
        method: 'POST',
        body: payload,
        keepalive: true,
        headers: { 'Content-Type': 'application/json' }
      }).catch(function () {});
    } catch (e) {}
  }

  function flushSoon(ms) {
    if (flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; flush(false); }, ms);
  }

  // ---- error capture ------------------------------------------------------
  window.addEventListener('error', function (e) {
    push('error', {
      msg: String(e.message || '').slice(0, 300),
      src: String(e.filename || '').slice(0, 120),
      line: e.lineno || 0
    });
  });
  window.addEventListener('unhandledrejection', function (e) {
    let msg = '';
    try { msg = String((e.reason && e.reason.message) || e.reason); } catch (err) {}
    push('error', { msg: ('unhandledrejection: ' + msg).slice(0, 300) });
  });
  const origConsoleError = console.error.bind(console);
  console.error = function () {
    try {
      const parts = [];
      for (let i = 0; i < arguments.length; ++i) {
        const a = arguments[i];
        parts.push(String((a && a.message) || a));
      }
      push('cerror', { msg: parts.join(' ').slice(0, 300) });
    } catch (e) {}
    origConsoleError.apply(null, arguments);
  };

  // ---- unclean-end detection (the hang postmortem) ------------------------
  try {
    const alive = JSON.parse(localStorage.getItem('ysfw-diag-alive') || 'null');
    const bye = localStorage.getItem('ysfw-diag-bye');
    if (alive && alive.sid && bye !== alive.sid) {
      push('unclean-end', {
        prevSid: alive.sid,
        lastBeatAgoMs: Date.now() - (alive.t || 0),
        last: alive.s || null
      });
    }
    localStorage.removeItem('ysfw-diag-alive');
    localStorage.removeItem('ysfw-diag-bye');
  } catch (e) {}
  window.addEventListener('pagehide', function () {
    try { localStorage.setItem('ysfw-diag-bye', SID); } catch (e) {}
    push('bye', snapshot());
    flush(true);
  });

  // ---- heartbeat + mode breadcrumbs ---------------------------------------
  let prevMode = { inFlight: null, replaying: null, vrSession: null, endReason: null };
  setInterval(function () {
    const s = snapshot();
    const vrSession = !!(s.vr && s.vr.session);
    const endReason = (s.vr && s.vr.endReason) || null;
    if (s.inFlight !== prevMode.inFlight || s.replaying !== prevMode.replaying ||
        vrSession !== prevMode.vrSession || endReason !== prevMode.endReason) {
      push('mode', s);
      prevMode = { inFlight: s.inFlight, replaying: s.replaying, vrSession: vrSession, endReason: endReason };
      flushSoon(1000);
    }
  }, 1000);
  setInterval(function () {
    const s = snapshot();
    try {
      localStorage.setItem('ysfw-diag-alive', JSON.stringify({ sid: SID, t: Date.now(), s: s }));
    } catch (e) {}
    if ((s.vr && s.vr.session) || s.inFlight || s.replaying) {
      push('hb', s);
      flushSoon(0);
    }
  }, 10000);

  globalThis.ysfwDiag = {
    push: push,
    flush: flush,
    sid: SID,
    // Listen in on every event (web/metrics.js).  Fires for the caller's own
    // pushes too; subscribe before the page starts pushing to see them all.
    subscribe: function (fn) { if (typeof fn === 'function') subs.push(fn); }
  };
})();
