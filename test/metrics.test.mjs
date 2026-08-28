// Unit tests for the usage-metrics path (web/metrics.js + the /metric endpoint
// in worker/signal.js) — the "how many people actually play" counter.
//
// Both halves are exercised without a browser: metrics.js publishes on
// globalThis and skips all wiring when there is no window (same dual-use
// arrangement as deeplink.js), and the Worker's default export is a plain
// fetch(request, env) that a hand-rolled request object satisfies.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../web/deeplink.js';
import '../web/metrics.js';
import worker from '../worker/signal.js';

const { readVisitor, readAudience, classify, createRecorder } = globalThis.ysfwMetrics;

// A localStorage-shaped stub; `broken` reproduces private-mode browsers, where
// every access throws.
function makeStore(broken) {
  const m = new Map();
  return {
    getItem(k) { if (broken) throw new Error('denied'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (broken) throw new Error('denied'); m.set(k, String(v)); },
    removeItem(k) { if (broken) throw new Error('denied'); m.delete(k); },
    _map: m
  };
}

const DAY = 86400000;
const T0 = Date.parse('2026-08-21T09:00:00Z');

// ---- visitor identity ------------------------------------------------------

test('first ever load: id minted, visits = 1, days = 0', () => {
  const store = makeStore();
  const v = readVisitor(store, T0, () => 'abc123');
  assert.equal(v.id, 'abc123');
  assert.equal(v.visits, 1);
  assert.equal(v.days, 0);
  assert.equal(v.persisted, true);
  assert.equal(JSON.parse(store._map.get('ysfw-visitor')).id, 'abc123');
});

test('coming back keeps the id and counts the visit — this is the repeat rate', () => {
  const store = makeStore();
  readVisitor(store, T0, () => 'abc123');
  const second = readVisitor(store, T0 + 3 * DAY, () => 'SHOULD-NOT-BE-USED');
  assert.equal(second.id, 'abc123');
  assert.equal(second.visits, 2);
  assert.equal(second.days, 3);
});

test('storage denied -> visits 0, so "we could not tell" never reads as "first-timer"', () => {
  const v = readVisitor(makeStore(true), T0, () => 'abc123');
  assert.equal(v.visits, 0);
  assert.equal(v.persisted, false);
  assert.equal(v.id, 'abc123');
});

test('corrupt record is replaced, not trusted', () => {
  const store = makeStore();
  store.setItem('ysfw-visitor', '{not json');
  const v = readVisitor(store, T0, () => 'fresh');
  assert.equal(v.id, 'fresh');
  assert.equal(v.visits, 1);
});

// ---- audience (dev opt-out) ------------------------------------------------

test('audience defaults to public and ?metrics=dev sticks for later loads', () => {
  const store = makeStore();
  assert.equal(readAudience(store, ''), 'public');
  assert.equal(readAudience(store, '?metrics=dev'), 'dev');
  assert.equal(readAudience(store, ''), 'dev');            // sticky: no param needed again
  assert.equal(readAudience(store, '?metrics=public'), 'public');  // and undoable
  assert.equal(readAudience(store, ''), 'public');
});

test('?metrics=off is honoured and sticks', () => {
  const store = makeStore();
  assert.equal(readAudience(store, '?metrics=off'), 'off');
  assert.equal(readAudience(store, ''), 'off');
});

test('unknown ?metrics= values are ignored', () => {
  assert.equal(readAudience(makeStore(), '?metrics=yes-please'), 'public');
});

// ---- launch classification -------------------------------------------------

const ctx = { deepLink: globalThis.ysfwDeepLink, language: 'ja-JP', touch: false };

test('bare load = menu launch, solo, no aircraft (picked inside the engine)', () => {
  const c = classify('', ctx);
  assert.equal(c.launch, 'menu');
  assert.equal(c.role, 'solo');
  assert.equal(c.aircraft, '');
  assert.equal(c.device, 'desktop');
});

test('quick flight reports the aircraft AND the defaulted field', () => {
  const c = classify('?freeflight=CESSNA_172R', ctx);
  assert.equal(c.launch, 'freeflight');
  assert.equal(c.aircraft, 'CESSNA_172R');
  assert.equal(c.field, 'ATSUGI_AIRBASE');   // deeplink.js's default, not an empty string
});

test('multiplayer sides are distinguishable', () => {
  assert.equal(classify('?join=12345678', ctx).role, 'join');
  assert.equal(classify('?host=1&name=toming', ctx).role, 'host');
  assert.equal(classify('?host=1&name=toming&field=AOMORI', ctx).field, 'AOMORI');
});

test('touch devices are tagged (over half of all visits arrive on a phone)', () => {
  assert.equal(classify('', { ...ctx, touch: true }).device, 'touch');
});

test('the whole language tag survives, script subtag and all', () => {
  // 8 chars cut 'zh-Hans-CN' down to 'zh-Hans-'; simplified vs traditional is
  // exactly the split this column exists to show.
  assert.equal(classify('', { ...ctx, language: 'zh-Hans-CN' }).lang, 'zh-Hans-CN');
  assert.equal(classify('?lang=en', ctx).lang, 'en');
});

// ---- the recorder ----------------------------------------------------------

function drive(search, opts = {}) {
  const events = [];
  let clock = T0;
  const rec = createRecorder({
    now: () => clock,
    emit: (e, f) => events.push({ e, ...f }),
    referrerHost: opts.ref || '',
    context: classify(search, { ...ctx, ...(opts.ctx || {}) })
  });
  return { rec, events, tick: (ms) => { clock += ms; } };
}

test('load -> fly -> land: one start, one end, duration in seconds', () => {
  const { rec, events, tick } = drive('?freeflight=F-18C_HORNET');
  rec.session({ visits: 2, days: 5 });
  rec.onDiag({ type: 'mode', inFlight: false });   // diag's harmless first snapshot
  assert.equal(events.length, 1, 'the null->false snapshot must not open a flight');
  rec.onDiag({ type: 'mode', inFlight: true });
  tick(412000);
  rec.onDiag({ type: 'mode', inFlight: false });
  assert.deepEqual(events.map((e) => e.e), ['session', 'flight-start', 'flight-end']);
  assert.equal(events[0].visits, 2);
  assert.equal(events[0].days, 5);
  assert.equal(events[2].secs, 412);
  assert.equal(events[2].reason, 'ended');
  assert.equal(events[2].aircraft, 'F-18C_HORNET');
  assert.equal(rec.flying(), false);
});

test('every event carries the language, not just the session', () => {
  // Regression: classify() computed lang and fields() dropped it, so blob7 was
  // empty on all 342 rows of the first week -- a column that never varies is
  // indistinguishable from a world where everybody is the same.
  const { rec, events, tick } = drive('?freeflight=B747', { ctx: { language: 'zh-CN' } });
  rec.session({ visits: 1, days: 0 });
  rec.onDiag({ type: 'mode', inFlight: true });
  tick(60000);
  rec.onDiag({ type: 'mode', inFlight: false });
  assert.equal(events.length, 3);
  for (const e of events) assert.equal(e.lang, 'zh-CN', `${e.e} lost the language`);
});

test('closing the tab mid-flight still reports the duration', () => {
  const { rec, events, tick } = drive('');
  rec.onDiag({ type: 'mode', inFlight: true });
  tick(90000);
  rec.onDiag({ type: 'bye', inFlight: true });
  const end = events.find((e) => e.e === 'flight-end');
  assert.equal(end.secs, 90);
  assert.equal(end.reason, 'left');
});

test('events after the page said goodbye are dropped', () => {
  const { rec, events } = drive('');
  rec.onDiag({ type: 'bye', inFlight: false });
  rec.onDiag({ type: 'mode', inFlight: true });
  assert.equal(events.length, 0);
});

test('repeated in-flight snapshots do not restart the flight', () => {
  const { rec, events, tick } = drive('');
  rec.onDiag({ type: 'mode', inFlight: true });
  tick(1000);
  rec.onDiag({ type: 'mode', inFlight: true });
  tick(1000);
  rec.onDiag({ type: 'mode', inFlight: false });
  assert.deepEqual(events.map((e) => e.e), ['flight-start', 'flight-end']);
  assert.equal(events[1].secs, 2);
});

test('a flight flown in the headset is tagged vr, and the VR session is its own event', () => {
  const { rec, events, tick } = drive('');
  rec.onDiag({ type: 'mode', inFlight: true });
  rec.onDiag({ type: 'vr-start', inFlight: true });
  tick(600000);
  rec.onDiag({
    type: 'vr-end', seconds: 600.4, avgFps: 71.6, reason: 'exit',
    grantedHz: 72, cpuMs: 7.04, fpsSeries: [44.6, 71, 72.2]
  });
  rec.onDiag({ type: 'mode', inFlight: false });
  const vr = events.find((e) => e.e === 'vr-end');
  assert.equal(vr.secs, 600);
  assert.equal(vr.fps, 72);
  assert.equal(vr.reason, 'exit');
  assert.equal(vr.hz, 72);
  assert.equal(vr.cpu, 7);
  assert.equal(vr.fpsSeries, '45,71,72');
  assert.equal(events.find((e) => e.e === 'flight-end').device, 'vr');
});

test('a vr-end from a build without the diagnosis trio still produces a valid row', () => {
  // Rollout order guard: the engine wasm and the shell can be cached at
  // different versions, so the recorder must not turn absent fields into NaN
  // (a NaN double throws at writeDataPoint and the whole row is lost).
  const { rec, events } = drive('');
  rec.onDiag({ type: 'vr-end', seconds: 30, avgFps: 44, reason: 'exit' });
  const vr = events.find((e) => e.e === 'vr-end');
  assert.equal(vr.hz, 0);
  assert.equal(vr.cpu, 0);
  assert.equal(vr.fpsSeries, '');
});

test('an hour-long fps series is truncated to the blob budget, not shipped unbounded', () => {
  const { rec, events } = drive('');
  const series = [];
  for (let i = 0; i < 500; ++i) series.push(120);
  rec.onDiag({ type: 'vr-end', seconds: 9000, avgFps: 120, reason: 'exit', fpsSeries: series });
  const vr = events.find((e) => e.e === 'vr-end');
  assert.ok(vr.fpsSeries.length <= 400);
  assert.ok(vr.fpsSeries.startsWith('120,120'));
});

test('replay playback is not a flight', () => {
  const { rec, events } = drive('?replay=demo.yfs');
  rec.onDiag({ type: 'mode', inFlight: false, replaying: true });
  assert.equal(events.length, 0);
});

// ---- the /metric endpoint --------------------------------------------------

function fakeEnv(overrides = {}) {
  const written = [];
  return {
    written,
    env: {
      PLAY: { writeDataPoint: (p) => written.push(p) },
      ...overrides
    }
  };
}

function post(body, opts = {}) {
  return {
    method: opts.method || 'POST',
    url: opts.url || 'https://ysflight-web.toming.app/metric',
    cf: { country: opts.country || 'JP' },
    headers: new Headers(opts.headers || {}),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

const BATCH = {
  v: 1, vid: 'v0123456789ab', sid: 'sid12345', aud: 'public', build: 'dfb26b9d81f2',
  events: [{
    e: 'flight-end', launch: 'freeflight', aircraft: 'F-18C_HORNET', field: 'ATSUGI_AIRBASE',
    role: 'solo', device: 'desktop', lang: 'ja', ref: '', reason: 'ended',
    secs: 412, visits: 2, fps: 0, days: 5
  }]
};

test('a good batch becomes one data point with the documented column order', async () => {
  const { env, written } = fakeEnv();
  const res = await worker.fetch(post(BATCH), env);
  assert.equal(res.status, 204);
  assert.equal(written.length, 1);
  const p = written[0];
  assert.deepEqual(p.indexes, ['v0123456789ab']);
  assert.deepEqual(p.blobs, [
    'flight-end', 'freeflight', 'F-18C_HORNET', 'ATSUGI_AIRBASE',
    'solo', 'desktop', 'ja', '', 'ended',
    'public', 'sid12345', 'dfb26b9d81f2', 'ysflight-web.toming.app', 'JP', ''
  ]);
  assert.deepEqual(p.doubles, [412, 2, 0, 5, 0, 0]);
});

test('a vr-end carries the diagnosis trio in the documented columns', async () => {
  const { env, written } = fakeEnv();
  await worker.fetch(post({
    ...BATCH,
    events: [{
      e: 'vr-end', launch: 'freeflight', role: 'solo', device: 'vr', lang: 'ja',
      reason: 'exit', secs: 161, visits: 1, fps: 44, days: 0,
      hz: 72, cpu: 7.4, fpsSeries: '40,45,46,44,45'
    }]
  }), env);
  assert.equal(written[0].blobs[14], '40,45,46,44,45');
  assert.deepEqual(written[0].doubles, [161, 1, 44, 0, 72, 7.4]);
});

test('host and country come from the request, not the client', async () => {
  const { env, written } = fakeEnv();
  await worker.fetch(post({ ...BATCH, events: [{ ...BATCH.events[0], host: 'evil.example', country: 'XX' }] },
    { url: 'https://ysflight-web-staging.toming.workers.dev/metric', country: 'US' }), env);
  assert.equal(written[0].blobs[12], 'ysflight-web-staging.toming.workers.dev');
  assert.equal(written[0].blobs[13], 'US');
});

test('audience is normalised to the two values queries filter on', async () => {
  const { env, written } = fakeEnv();
  await worker.fetch(post({ ...BATCH, aud: 'dev' }), env);
  await worker.fetch(post({ ...BATCH, aud: 'nonsense' }), env);
  assert.equal(written[0].blobs[9], 'dev');
  assert.equal(written[1].blobs[9], 'public');
});

test('missing visitor id still counts as a data point', async () => {
  const { env, written } = fakeEnv();
  await worker.fetch(post({ ...BATCH, vid: undefined }), env);
  assert.deepEqual(written[0].indexes, ['anon']);
});

test('junk values cannot poison the numeric columns', async () => {
  const { env, written } = fakeEnv();
  await worker.fetch(post({ ...BATCH, events: [{ e: 'session', secs: 'NaN', visits: null, fps: {}, days: Infinity, hz: 'x', cpu: [] }] }), env);
  assert.deepEqual(written[0].doubles, [0, 0, 0, 0, 0, 0]);
});

test('oversized strings are truncated rather than rejected', async () => {
  const { env, written } = fakeEnv();
  await worker.fetch(post({ ...BATCH, events: [{ e: 'session', aircraft: 'A'.repeat(500) }] }), env);
  assert.equal(written[0].blobs[2].length, 48);
});

test('at most 20 events per batch', async () => {
  const { env, written } = fakeEnv();
  const many = Array.from({ length: 50 }, () => ({ e: 'session' }));
  await worker.fetch(post({ ...BATCH, events: many }), env);
  assert.equal(written.length, 20);
});

test('nameless events are skipped', async () => {
  const { env, written } = fakeEnv();
  await worker.fetch(post({ ...BATCH, events: [{ e: '' }, null, { e: 'session' }] }), env);
  assert.equal(written.length, 1);
});

test('GET is refused', async () => {
  const { env } = fakeEnv();
  const res = await worker.fetch(post(BATCH, { method: 'GET' }), env);
  assert.equal(res.status, 405);
});

test('another site cannot post into the dataset', async () => {
  const { env, written } = fakeEnv();
  const res = await worker.fetch(post(BATCH, { headers: { Origin: 'https://evil.example' } }), env);
  assert.equal(res.status, 403);
  assert.equal(written.length, 0);
});

test('same-origin browser posts pass', async () => {
  const { env, written } = fakeEnv();
  const res = await worker.fetch(post(BATCH, { headers: { Origin: 'https://ysflight-web.toming.app' } }), env);
  assert.equal(res.status, 204);
  assert.equal(written.length, 1);
});

test('malformed and oversized bodies are refused, not written', async () => {
  const { env, written } = fakeEnv();
  assert.equal((await worker.fetch(post('{nope'), env)).status, 400);
  assert.equal((await worker.fetch(post({ v: 1 }), env)).status, 400);
  assert.equal((await worker.fetch(post('x'.repeat(9000)), env)).status, 413);
  assert.equal(written.length, 0);
});

test('rate-limited IPs get 429 and write nothing', async () => {
  const { env, written } = fakeEnv({ METRIC_RATE: { limit: async () => ({ success: false }) } });
  const res = await worker.fetch(post(BATCH), env);
  assert.equal(res.status, 429);
  assert.equal(written.length, 0);
});

test('a broken limiter fails OPEN — a counter must not switch itself off', async () => {
  const { env, written } = fakeEnv({ METRIC_RATE: { limit: async () => { throw new Error('down'); } } });
  const res = await worker.fetch(post(BATCH), env);
  assert.equal(res.status, 204);
  assert.equal(written.length, 1);
});

test('no dataset binding (local dev / older config) accepts and drops', async () => {
  const res = await worker.fetch(post(BATCH), {});
  assert.equal(res.status, 204);
});

test('a dataset that rejects a write is loud, and the rest of the batch still lands', async () => {
  let calls = 0;
  const written = [];
  const env = {
    PLAY: {
      writeDataPoint: (p) => {
        if (++calls === 1) throw new Error('dataset unavailable');
        written.push(p);
      }
    }
  };
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const res = await worker.fetch(post({ ...BATCH, events: [{ e: 'session' }, { e: 'flight-start' }] }), env);
    assert.equal(res.status, 204);
  } finally {
    console.error = realError;
  }
  assert.equal(written.length, 1, 'the second event still went through');
  assert.match(errors.join('\n'), /\[metric\] writeDataPoint failed/);
});
