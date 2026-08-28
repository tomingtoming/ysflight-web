// Unit tests for the signaling-room counter (the ROOM dataset written by
// worker/signal.js's SignalHub) — the "did a second player ever arrive" half of
// the usage numbers.
//
// The hub is driven directly rather than through fetch(): onMessage/onClose take
// a socket and a per-connection record, so a plain object with send() is enough
// and no WebSocketPair, Durable Object runtime or browser is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SignalHub } from '../worker/signal.js';

function makeHub(dataset) {
  const points = [];
  const env = {};
  if (dataset !== null) {
    env.ROOM = dataset || { writeDataPoint: (p) => points.push(p) };
  }
  return { hub: new SignalHub({}, env), points };
}

const sock = () => ({ sent: [], send(s) { this.sent.push(JSON.parse(s)); } });
const conn = (extra) => Object.assign(
  { role: null, room: null, peerId: 0, closed: false, site: 'ysflight-web.toming.app', cc: 'JP', aud: 'public' },
  extra || {});

const send = (hub, ws, c, msg) => hub.onMessage(ws, c, JSON.stringify(msg));
// A host close arms the real 90s grace timer, which would hold node's event loop
// open for the whole 90 seconds.  Tests that leave a room hostless drop it.
const dropTimers = (hub) => {
  for (const [, r] of hub.rooms) {
    if (r.graceTimer !== null) { clearTimeout(r.graceTimer); r.graceTimer = null; }
  }
};
const by = (points, ev) => points.filter((p) => p.blobs[0] === ev);

test('opening a room writes one row with the documented column order', () => {
  const { hub, points } = makeHub();
  send(hub, sock(), conn(), { t: 'host', room: 'ROOM0001', token: 'tok', manifest: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(points.length, 1);
  const p = points[0];
  assert.equal(p.indexes.length, 1);
  assert.match(p.indexes[0], /^[0-9a-f]{8}$/);           // hashed, never the key itself
  assert.notEqual(p.indexes[0], 'ROOM0001');
  assert.deepEqual(p.blobs, ['room-open', 'game', '', 'ysflight-web.toming.app', 'JP', 'public']);
  assert.deepEqual(p.doubles, [0, 0, 0, 2]);             // peers, peak, secs, packs
});

test('the room key is hashed, and the same room always hashes the same', () => {
  const { hub, points } = makeHub();
  send(hub, sock(), conn(), { t: 'host', room: 'STABLE01', token: 't' });
  hub.rooms.clear();
  send(hub, sock(), conn(), { t: 'host', room: 'STABLE01', token: 't' });
  assert.equal(points[0].indexes[0], points[1].indexes[0]);
});

test('the pack room is tagged as its own channel, not counted as a second game', () => {
  const { hub, points } = makeHub();
  send(hub, sock(), conn(), { t: 'host', room: 'ROOM0002', token: 't' });
  send(hub, sock(), conn(), { t: 'host', room: 'ROOM0002~p', token: 't' });
  assert.deepEqual(points.map((p) => p.blobs[1]), ['game', 'pack']);
  assert.notEqual(points[0].indexes[0], points[1].indexes[0]);
});

test('a joiner is recorded with the peer count and the running peak', () => {
  const { hub, points } = makeHub();
  const host = sock(), hc = conn();
  send(hub, host, hc, { t: 'host', room: 'ROOM0003', token: 't' });
  send(hub, sock(), conn(), { t: 'join', room: 'ROOM0003' });
  const j = by(points, 'room-join');
  assert.equal(j.length, 1);
  assert.deepEqual(j[0].doubles.slice(0, 2), [1, 1]);    // peers, peak
  assert.equal(j[0].blobs[2], '');                       // reason: the host was live
});

test('an invite that arrives after the room is gone is recorded, not silent', () => {
  // Zero joins AND zero join-fails means nobody tried.  Zero joins WITH
  // join-fails means the invite links are going stale — a different problem with
  // the same shape in the client-side counter, which sees neither.
  const { hub, points } = makeHub();
  const ws = sock();
  send(hub, ws, conn(), { t: 'join', room: 'MISSING1' });
  assert.deepEqual(ws.sent, [{ t: 'no-room' }]);
  const f = by(points, 'room-join-fail');
  assert.equal(f.length, 1);
  assert.equal(f[0].blobs[2], 'no-room');
});

test('a joiner queued during the host-loss grace window is marked hostless', () => {
  const { hub, points } = makeHub();
  const host = sock(), hc = conn();
  send(hub, host, hc, { t: 'host', room: 'ROOM0004', token: 't' });
  hub.rooms.get('ROOM0004').host = null;                 // the grace window
  send(hub, sock(), conn(), { t: 'join', room: 'ROOM0004' });
  assert.equal(by(points, 'room-join')[0].blobs[2], 'hostless');
});

test('the host leaving is recorded on the spot, because the timer may never fire', () => {
  // room-close comes from a setTimeout inside a Durable Object; when the last
  // socket goes the object can be evicted and the timer with it (measured on
  // production: a host that left an empty hub produced no room-close at all).
  // onClose always runs, so the same peak and lifetime are recorded there.
  const { hub, points } = makeHub();
  const host = sock(), hc = conn();
  send(hub, host, hc, { t: 'host', room: 'ROOM0020', token: 't' });
  const peer = sock(), pc = conn();
  send(hub, peer, pc, { t: 'join', room: 'ROOM0020' });
  hub.onClose(peer, pc);
  hub.onClose(host, hc);
  const h = by(points, 'room-hostless');
  assert.equal(h.length, 1);
  assert.equal(h[0].doubles[0], 0, 'peers at that moment');
  assert.equal(h[0].doubles[1], 1, 'peak survives here too');
  assert.equal(h[0].blobs[3], 'ysflight-web.toming.app');
  dropTimers(hub);
});

test('a room that comes back says so, so hostless is not read as the end', () => {
  const { hub, points } = makeHub();
  const host = sock(), hc = conn();
  send(hub, host, hc, { t: 'host', room: 'ROOM0021', token: 'same' });
  hub.onClose(host, hc);
  const back = sock();
  send(hub, back, conn(), { t: 'host', room: 'ROOM0021', token: 'same' });
  assert.deepEqual(points.map((p) => p.blobs[0]),
    ['room-open', 'room-hostless', 'room-reclaim']);
  assert.equal(by(points, 'room-reclaim')[0].blobs[2], 'same-token');
});

test('a page reload takes the room over with a fresh token, and that reads differently', () => {
  const { hub, points } = makeHub();
  const host = sock(), hc = conn();
  send(hub, host, hc, { t: 'host', room: 'ROOM0022', token: 'old' });
  hub.onClose(host, hc);
  send(hub, sock(), conn(), { t: 'host', room: 'ROOM0022', token: 'brand-new' });
  assert.equal(by(points, 'room-reclaim')[0].blobs[2], 'takeover');
});

test('a stale socket closing late writes nothing', () => {
  // The reclaimed room must not get a second hostless row when the old socket's
  // delayed close finally lands.
  const { hub, points } = makeHub();
  const host = sock(), hc = conn();
  send(hub, host, hc, { t: 'host', room: 'ROOM0023', token: 'same' });
  send(hub, sock(), conn(), { t: 'host', room: 'ROOM0023', token: 'same' });  // reclaim
  hub.onClose(host, hc);                                                      // the stale close
  assert.equal(by(points, 'room-hostless').length, 0);
});

test('a room whose peers all left still reports that somebody came', () => {
  // The point of peak: at close the peers Map is empty either way, so without it
  // "two people played" and "nobody ever joined" are the same row.
  const { hub, points } = makeHub();
  const host = sock(), hc = conn();
  send(hub, host, hc, { t: 'host', room: 'ROOM0005', token: 't' });
  const peer = sock(), pc = conn();
  send(hub, peer, pc, { t: 'join', room: 'ROOM0005' });
  hub.onClose(peer, pc);
  hub.rooms.get('ROOM0005').host = null;
  hub.expireRoom('ROOM0005');
  const c = by(points, 'room-close');
  assert.equal(c.length, 1);
  assert.equal(c[0].doubles[0], 0, 'peers at close');
  assert.equal(c[0].doubles[1], 1, 'peak must survive the peer leaving');
  assert.equal(c[0].blobs[2], 'grace-expired');
  assert.equal(c[0].blobs[3], 'ysflight-web.toming.app', 'the room keeps its own provenance');
  assert.equal(c[0].blobs[5], 'public');
});

test('a room nobody joined closes with peak 0', () => {
  const { hub, points } = makeHub();
  send(hub, sock(), conn(), { t: 'host', room: 'ROOM0006', token: 't' });
  hub.rooms.get('ROOM0006').host = null;
  hub.expireRoom('ROOM0006');
  assert.equal(by(points, 'room-close')[0].doubles[1], 0);
});

test('a second host on a live room is a collision, and it is counted', () => {
  const { hub, points } = makeHub();
  send(hub, sock(), conn(), { t: 'host', room: 'ROOM0007', token: 'mine' });
  const other = sock();
  send(hub, other, conn(), { t: 'host', room: 'ROOM0007', token: 'theirs' });
  assert.deepEqual(other.sent, [{ t: 'host-taken' }]);
  assert.equal(by(points, 'room-taken').length, 1);
});

test('the pack count follows a host takeover instead of freezing at the first host', () => {
  const { hub, points } = makeHub();
  const first = sock(), fc = conn();
  send(hub, first, fc, { t: 'host', room: 'ROOM0008', token: 'a', manifest: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] });
  hub.rooms.get('ROOM0008').host = null;                 // host reloaded its page
  send(hub, sock(), conn(), { t: 'host', room: 'ROOM0008', token: 'b', manifest: [{ id: 'x' }] });
  send(hub, sock(), conn(), { t: 'join', room: 'ROOM0008' });
  assert.equal(by(points, 'room-join')[0].doubles[3], 1);
});

test("the maintainer's own rooms are tagged, all the way to the close row", () => {
  // A socket opened from a ?metrics=dev browser carries ?aud=dev, so an evening
  // of testing multiplayer does not outweigh a week of real rooms.  The tag has
  // to survive onto room-close, which fires from a timer long after the socket
  // (and its conn) is gone -- hence the room record keeps its own copy.
  const { hub, points } = makeHub();
  const dev = conn({ aud: 'dev' });
  send(hub, sock(), dev, { t: 'host', room: 'DEVROOM1', token: 't' });
  send(hub, sock(), conn({ aud: 'dev' }), { t: 'join', room: 'DEVROOM1' });
  send(hub, sock(), conn({ aud: 'dev' }), { t: 'join', room: 'NOSUCH01' });
  hub.rooms.get('DEVROOM1').host = null;
  hub.expireRoom('DEVROOM1');
  assert.deepEqual(points.map((p) => p.blobs[5]), ['dev', 'dev', 'dev', 'dev']);
});

test('anything that is not exactly dev counts as public', () => {
  const { hub, points } = makeHub();
  send(hub, sock(), conn({ aud: 'DEV' }), { t: 'host', room: 'ROOM0011', token: 't' });
  send(hub, sock(), conn({ aud: undefined }), { t: 'host', room: 'ROOM0012', token: 't' });
  assert.deepEqual(points.map((p) => p.blobs[5]), ['public', 'public']);
});

test('the socket URL is where the dev tag is read, and it defaults to public', () => {
  // The one place the query string is parsed.  WebSocketPair/Response(101) only
  // exist in the Workers runtime, so both are stubbed -- what is under test is
  // that fetch() reads ?aud off the URL and stamps the connection with it.
  const realPair = globalThis.WebSocketPair;
  const realResponse = globalThis.Response;
  globalThis.WebSocketPair = function () {
    const mk = () => ({ accept() {}, addEventListener() {}, send() {} });
    return [mk(), mk()];
  };
  globalThis.Response = function (body, init) { this.body = body; this.init = init; };
  try {
    const { hub } = makeHub();
    const seen = [];
    hub.onMessage = (ws, c) => seen.push(c.aud);
    hub.trackConn = () => {};
    const req = (u) => ({ url: u, cf: { country: 'JP' } });
    // fetch() wires the handlers rather than calling onMessage, so reach the conn
    // through the listener it registers.
    let captured = null;
    globalThis.WebSocketPair = function () {
      const mk = () => ({
        accept() {}, send() {},
        addEventListener(kind, fn) { if (kind === 'message') this._fn = fn; }
      });
      const a = mk(), b = mk();
      captured = b;
      return [a, b];
    };
    hub.fetch(req('https://ysflight-web.toming.app/signal?aud=dev'));
    captured._fn({ data: JSON.stringify({ t: 'ping' }) });
    hub.fetch(req('https://ysflight-web.toming.app/signal'));
    captured._fn({ data: JSON.stringify({ t: 'ping' }) });
    hub.fetch(req('https://ysflight-web.toming.app/signal?aud=nonsense'));
    captured._fn({ data: JSON.stringify({ t: 'ping' }) });
    assert.deepEqual(seen, ['dev', 'public', 'public']);
  } finally {
    globalThis.WebSocketPair = realPair;
    globalThis.Response = realResponse;
  }
});

test('no dataset binding (local dev, older config) counts nothing and throws nothing', () => {
  const { hub, points } = makeHub(null);
  send(hub, sock(), conn(), { t: 'host', room: 'ROOM0009', token: 't' });
  send(hub, sock(), conn(), { t: 'join', room: 'ROOM0009' });
  assert.equal(points.length, 0);
  assert.equal(hub.rooms.size, 1, 'signaling still works without the counter');
});

test('a dataset that rejects a write is loud, and signaling keeps working', () => {
  const errs = [];
  const realError = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const { hub } = makeHub({ writeDataPoint() { throw new Error('nope'); } });
    const host = sock(), hc = conn();
    send(hub, host, hc, { t: 'host', room: 'ROOM0010', token: 't' });
    assert.deepEqual(host.sent, [{ t: 'host-ok', room: 'ROOM0010' }]);
  } finally {
    console.error = realError;
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /\[room\] writeDataPoint failed: nope/);
});
