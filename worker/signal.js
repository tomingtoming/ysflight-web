// Cloudflare Worker + Durable Object: WebRTC signaling for ysflight-web.
//
// This replaces the old self-hosted server/signal.mjs.  A single hub Durable
// Object holds every room's WebSockets in memory and relays the exact same
// JSON protocol the wasm client already speaks (see
// src/port/yssocket/yssocket_emscripten.cpp):
//
//   client -> server : {t:'host',room,token?,manifest?} | {t:'join',room}
//                      | {t:'sdp'|'ice', peer?, data}   (host sends peer, peer omits it)
//                      | {t:'ping'}
//   server -> client : {t:'host-ok',room,manifestDropped?,manifestBytes?,manifestCap?}
//                      | {t:'host-taken'} | {t:'no-room'}
//                      | {t:'join-ok',peer,manifest?} | {t:'peer',peer}
//                      | {t:'sdp'|'ice', peer, data}
//                      | {t:'host-left'} | {t:'peer-left',peer}
//
// token (optional) lets a host whose signaling WebSocket dropped (mobile tab
// freeze, transient network, page resume) RECONNECT and re-send {t:'host'} with
// the same token to RECLAIM its room -- keeping already-joined peers -- instead of
// being rejected with host-taken.  onClose only deletes a room for the socket that
// currently owns it, so a reclaimed room is not clobbered by the old socket's late
// close.  Together these stop a brief host-socket loss from permanently deleting
// the room and stranding late joiners on no-room.
//
// Host-loss GRACE: when the CURRENT host socket closes, the room is NOT deleted
// immediately -- it goes hostless for GRACE_MS awaiting the host's reclaim.  A
// join during the grace window is accepted (join-ok) and queued; the reclaim
// flushes the queued {t:'peer'} events to the returning host so those joiners
// connect without retrying.  A {t:'host'} with a DIFFERENT token is allowed to
// take over a HOSTLESS room (the host reloaded its page: pinRoomUrl keeps
// ?room=<code> so the code is reused but the token is fresh) -- queued joiners
// are handed to the new host; peers of the dead host get host-left.  Only when
// the grace expires with no host does the room die (host-left to peers).
// Before this, the deleted-on-close room turned the host's transient socket
// loss (background-tab timer throttling delaying its keepalive pings) into
// "?join=<room> hangs / no-room" for invite links -- the reported bug.
//
// KEEPALIVE: the hub pings every connected socket every KEEPALIVE_MS.  The
// clients' own 25s pings run on setInterval, which browsers throttle to 60s+
// in background tabs -- past the network idle timeout, killing the host socket
// while its owner reads another tab.  Server-driven pings are immune to tab
// throttling, so idle rooms survive a backgrounded host.  Clients ignore
// unknown message types, so {t:'ping'} downstream is compatible with every
// deployed client.
//
// Both knobs are env-overridable for tests: SIGNAL_GRACE_MS, SIGNAL_KEEPALIVE_MS.
//
// manifest (optional) is the host's add-on-pack list (ids+hashes+categories,
// tiny control metadata) stored in room state and echoed to joiners; pack BYTES
// are transferred P2P over a separate 'ysf-pack' DataChannel (see pack-net.js).
//
// Game traffic never touches this Worker -- after signaling it flows P2P over
// WebRTC DataChannels.  ICE servers are minted by the /turn endpoint below
// (Cloudflare Realtime TURN: STUN + a TURN relay fallback for NAT-blocked pairs);
// the client falls back to public STUN if /turn is unconfigured.  Everything else
// (the static game in dist/) is served by Workers Static Assets.
//
// The hub DO keeps connections in memory (no Hibernation): it stays resident
// only while signaling WebSockets are open, and a single global hub fits the
// Workers Free plan's Durable Object duration budget even running continuously.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/signal') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected WebSocket Upgrade', { status: 426 });
      }
      const id = env.SIGNAL.idFromName('hub'); // single global signaling hub
      return env.SIGNAL.get(id).fetch(request);
    }
    if (url.pathname === '/turn') {
      return turnCredentials(request, env);
    }
    if (url.pathname === '/clientlog') {
      return clientLog(request);
    }
    if (url.pathname === '/metric') {
      return metric(request, env);
    }
    // Non-signaling paths: serve the static game assets (dist/).
    return env.ASSETS.fetch(request);
  }
};

// Frontend diagnostics sink (web/diag.js POSTs here): echoes a small JSON
// batch of client-side events (errors, VR/mode breadcrumbs, heartbeats) into
// console.log, which observability (enabled in wrangler.jsonc) persists into
// Workers Logs -- searchable in the dashboard (Workers & Pages -> ysflight-web
// -> Logs, filter "[clientlog]").  Built for the 2026-07 Quest in-headset hang
// reports: the headset browser's console is unreachable mid-session, so the
// page ships its evidence here; a hang shows up as the heartbeat stream
// STOPPING (plus an "unclean-end" event from the next page load carrying the
// last known state).
//
// Guards: POST-only; same-origin when a browser sends Origin (same rationale
// as /turn above); 16KB body cap; at most 50 events per batch, each truncated.
// Volume is a trickle (one heartbeat every 10s while a session is active), so
// the free-tier log budget is unaffected.
async function clientLog(request) {
  if (request.method !== 'POST') {
    return new Response('POST only', { status: 405, headers: { 'Allow': 'POST' } });
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return new Response(null, { status: 403 });
  }
  let text = '';
  try { text = await request.text(); } catch (e) { return new Response(null, { status: 400 }); }
  if (text.length > 16384) text = text.slice(0, 16384);
  let batch = null;
  try { batch = JSON.parse(text); } catch (e) {}
  if (!batch || !Array.isArray(batch.events)) {
    return new Response(null, { status: 400 });
  }
  const sid = String(batch.sid || '').slice(0, 32);
  for (const ev of batch.events.slice(0, 50)) {
    let line = '';
    try { line = JSON.stringify(ev); } catch (e) { continue; }
    console.log('[clientlog]', sid, line.slice(0, 2000));
  }
  const ua = (request.headers.get('User-Agent') || '').slice(0, 120);
  console.log('[clientlog-meta]', sid, JSON.stringify({ n: batch.events.length, ua }));
  return new Response(null, { status: 204 });
}

// Shared sanitizers for everything that reaches an Analytics Engine column: a
// blob must be a bounded string and a double must be a real number, or the write
// throws and the row is lost.  Used by both sinks (/metric and the room events).
const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n || 64);
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

// Usage metrics sink (web/metrics.js POSTs here): writes one Analytics Engine
// data point per event.  This is the "how many people actually play" counter --
// see docs/metrics.md for the schema, the SQL cookbook and the read token.
//
// Why not just read the logs?  /clientlog above lands in Workers Logs, which
// keeps 7 days and answers questions one grep at a time.  Analytics Engine
// keeps three months and answers them in SQL, so a flight flown today is still
// countable next quarter.  The two are complementary: logs for postmortems,
// this for counting.
//
// The last four columns are stamped SERVER-side (audience is the client's, but
// host and country are not the client's to claim): host separates production
// from staging in one shared dataset, and country is the closest thing to
// "who" that this project will ever store.
//
//   index1  visitor id (random, localStorage; the sampling key)
//   blob1   event      'session' | 'flight-start' | 'flight-end' | 'vr-end'
//   blob2   launch     deep-link kind, or 'menu' (picked inside the engine)
//   blob3   aircraft   when the URL carried it (deeplink.js launchTargets)
//   blob4   field
//   blob5   role       'solo' | 'host' | 'join'
//   blob6   device     'desktop' | 'touch' | 'vr'
//   blob7   lang
//   blob8   referrer   hostname, session events only
//   blob9   reason     flight/VR end reason ('ended' | 'left' | VR endReason)
//   blob10  audience   'public' | 'dev'  (the maintainer's own QA loads)
//   blob11  sid        page-load id: groups one visit's events together
//   blob12  build      client build id
//   blob13  host       SERVER: request hostname (prod vs staging)
//   blob14  country    SERVER: request.cf.country
//   double1 secs       flight / VR duration
//   double2 visits     this browser's visit number (1 = first ever, 0 = no storage)
//   double3 fps        VR average
//   double4 days       days since this browser's first visit
//
// Guards mirror /turn and /clientlog: POST-only, same-origin when a browser
// sends Origin, 8 KB body cap, at most 20 events per batch, every string
// truncated.  Per-IP rate limit via METRIC_RATE; a missing binding fails OPEN
// (an older deploy config must not turn the counter off silently) while the
// free-tier write budget (100k/day against a handful per visit) absorbs the
// rest.  No binding at all -> 204: local `wrangler dev` and the static smoke
// server should not make the client retry.
async function metric(request, env) {
  if (request.method !== 'POST') {
    return new Response('POST only', { status: 405, headers: { 'Allow': 'POST' } });
  }
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) {
    return new Response(null, { status: 403 });
  }
  if (env.METRIC_RATE && typeof env.METRIC_RATE.limit === 'function') {
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.METRIC_RATE.limit({ key: ip });
      if (!success) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
    } catch (e) {}
  }
  let text = '';
  try { text = await request.text(); } catch (e) { return new Response(null, { status: 400 }); }
  if (text.length > 8192) return new Response(null, { status: 413 });
  let batch = null;
  try { batch = JSON.parse(text); } catch (e) {}
  if (!batch || !Array.isArray(batch.events)) {
    return new Response(null, { status: 400 });
  }
  if (!env.PLAY) return new Response(null, { status: 204 });

  const vid = str(batch.vid, 64) || 'anon';
  const sid = str(batch.sid, 32);
  const audience = batch.aud === 'dev' ? 'dev' : 'public';
  const build = str(batch.build, 24);
  const host = url.hostname;
  const country = (request.cf && request.cf.country) || '';
  let written = 0;
  for (const ev of batch.events.slice(0, 20)) {
    if (!ev || typeof ev !== 'object') continue;
    const name = str(ev.e, 24);
    if (!name) continue;
    try {
      env.PLAY.writeDataPoint({
        indexes: [vid],
        blobs: [
          name, str(ev.launch, 24), str(ev.aircraft, 48), str(ev.field, 48),
          str(ev.role, 8), str(ev.device, 8), str(ev.lang, 16), str(ev.ref, 64),
          str(ev.reason, 32), audience, sid, build, host, String(country).slice(0, 8)
        ],
        doubles: [num(ev.secs), num(ev.visits), num(ev.fps), num(ev.days)]
      });
      written++;
    } catch (e) {
      // A counter must never fail quietly: a dataset that stopped receiving
      // reads exactly like nobody playing.  observability is on, so this lands
      // in Workers Logs next to the [clientlog] lines.
      console.error('[metric] writeDataPoint failed:', String((e && e.message) || e));
    }
  }
  // One line per batch, for the same reason -- and it is the only way to tell a
  // live pipeline from a dead one without an Analytics Engine read token.
  console.log('[metric]', JSON.stringify({ n: written, host: host, cc: country, aud: audience, build: build }));
  return new Response(null, { status: 204 });
}

// Mint short-lived TURN credentials (Cloudflare Realtime TURN) for the WebRTC
// peers.  Direct P2P over public STUN cannot traverse symmetric-NAT/CGNAT pairs
// (mobile, Starlink, many home routers), so a joiner never receives the host's
// game-state and the aircraft list stays empty; a TURN relay is the fix.  The
// client (web/index.html) POSTs /turn at load and feeds the returned iceServers
// to BOTH the engine game channel (Module.ysfwIceServers, see yssocket) and the
// pack channel (window.ysfwPackIce, see pack-net.js).
//
// Requires two Worker secrets:  wrangler secret put TURN_KEY_ID
//                               wrangler secret put TURN_API_TOKEN
// (the Realtime TURN key id and that key's API token).  When either is unset we
// return 204 so the client cleanly falls back to STUN-only.
//
// Abuse hardening (the endpoint is public and TURN relay traffic is metered):
//   - POST only, mirroring the sole legit caller (web/index.html); GET scrapers,
//     crawlers and link prefetchers get 405.
//   - When a browser sends an Origin it must match this deployment's own origin
//     (custom domain, workers.dev preview and wrangler dev alike), so OTHER
//     websites can't mint relay credentials off this endpoint from their pages.
//     Non-browser clients omit Origin (e.g. scripts/smoke-mp-pack-turn.mjs) and
//     are governed by the rate limit instead -- a script can spoof Origin anyway,
//     so requiring it would only break legit tools without slowing an attacker.
//   - Per-IP rate limit (TURN_RATE ratelimit binding, wrangler.jsonc).  The
//     client mints ONCE per page load, so the cap is generous even for several
//     players behind one NAT, while a credential-harvesting loop hits 429.
//     Binding absent (older deploy config) or failing -> fail OPEN: a broken
//     limiter must degrade to the pre-hardening behavior, not take TURN down.
async function turnCredentials(request, env) {
  if (request.method !== 'POST') {
    return new Response('POST only', { status: 405, headers: { 'Allow': 'POST' } });
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return new Response(null, { status: 403 });
  }
  if (env.TURN_RATE && typeof env.TURN_RATE.limit === 'function') {
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.TURN_RATE.limit({ key: ip });
      if (!success) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
    } catch (e) {}
  }
  const keyId = env.TURN_KEY_ID;
  const apiToken = env.TURN_API_TOKEN;
  if (!keyId || !apiToken) return new Response(null, { status: 204 });
  try {
    const resp = await fetch(
      'https://rtc.live.cloudflare.com/v1/turn/keys/' + keyId + '/credentials/generate-ice-servers',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
        // 4h: covers a long play session started from this page load (creds are
        // minted once per load), while a leaked/harvested credential dies the
        // same afternoon instead of working for a day.  If a tab sits open past
        // the TTL before connecting, the TURN allocate simply fails and the
        // client degrades to STUN-only -- same as /turn unconfigured, page unhurt.
        body: JSON.stringify({ ttl: 14400 }),
      },
    );
    if (!resp.ok) return new Response(null, { status: 502 });
    const body = await resp.text(); // { "iceServers": [ {urls}, {urls,username,credential} ] }
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return new Response(null, { status: 502 });
  }
}

// Cap on a host's serialized add-on-pack manifest stored in the in-memory hub.
// The manifest is lean control metadata (id/name/categories/sourceUrl per enabled
// pack -- see web/pack-net.js buildRoomManifest, which deliberately omits per-file
// hashes), so even a host with hundreds of packs stays far under this.  The cap is
// a guard against a misbehaving client bloating hub memory, NOT an expected limit;
// a manifest that trips it is DROPPED and reported back in host-ok so the host can
// surface it (silent drop here was the bug behind "host fine, joiners get nothing").
const MAX_MANIFEST_BYTES = 256 * 1024;

// Analytics Engine data point layout for the SIGNALING rooms (dataset ysfw_room,
// binding ROOM).  Deliberately a SECOND dataset, not more columns on ysfw_play:
// the grain is different (one row per room event, not per visitor event), and a
// row whose index1 is a room would be counted as a person by every
// count(DISTINCT index1) query already written against ysfw_play.
//
// This exists because the question "did a second player ever arrive" was
// unanswerable.  The client-side counter records role='host' the moment a page
// loads with ?host=1 -- which is intent, not a room.  On 2026-08-24 three
// visitors opened a host URL within four minutes and the hub saw zero sockets:
// from ysfw_play alone there is no way to tell whether they failed to connect or
// whether the instrument simply stops short of the server.  These rows are what
// the hub actually saw.  log() below still writes the same events to Workers
// Logs for postmortems; that store is 7 days and cannot be queried, this one is
// three months of SQL.
//
//   index1  room     8-hex hash of the room key -- NOT the key.  A room key is a
//                    join capability ({t:'join',room} is the whole handshake), so
//                    a three-month analytics store must not hold live invite
//                    codes.  The hash is stable, so "same room" still groups.
//   blob1   event    'room-open' | 'room-join' | 'room-join-fail' | 'room-taken'
//                    | 'room-hostless' | 'room-reclaim' | 'room-close'
//
//   room-hostless is the row to COUNT, not room-close.  room-close comes from the
//   grace timer, which is a setTimeout inside a Durable Object, and an object with
//   no sockets left can be evicted with the timer still pending.  Measured against
//   production on 2026-08-28: with anything at all touching the hub before the
//   deadline the timer fires exactly on time (rooms left hostless at +30s and +75s
//   both produced room-close, secs=90), but a host that left a hub with no other
//   socket produced no room-close at all, not even seven minutes later.  So
//   room-close means "we watched this room be torn down" -- true when written,
//   and a subset of the rooms that ended.  room-hostless is written straight from
//   onClose, which always runs, and carries the same peak and lifetime.  A room
//   that comes back writes room-reclaim after it, so the pair reads correctly.
//   blob2   channel  'game' | 'pack'   (pack rooms are the derived '~p' twin --
//                    web/pack-net.js derivePackRoom; every session makes both, so
//                    counting rooms without this column double-counts)
//   blob3   reason   'no-room' | 'hostless' | 'grace-expired' | ''
//   blob4   host     request hostname, stamped at connect (prod vs staging)
//   blob5   country  request.cf.country of the socket that caused the event
//   blob6   audience 'public' | 'dev' -- the maintainer's own QA rooms.  There is
//                    no visitor id on this side, so the tag has to ride the
//                    SOCKET: ?aud=dev on the signaling URL (web/index.html builds
//                    it from the sticky ?metrics=dev audience).  The URL is the
//                    only seam both channels share -- the game channel's
//                    {t:'host'} is built by the engine in C++, the pack channel's
//                    by web/pack-net.js.  Without it, one evening of testing
//                    multiplayer outweighs a week of real rooms.
//   double1 peers    peers in the room at that moment
//   double2 peak     most peers the room ever held (0 = nobody ever joined)
//   double3 secs     room lifetime, at close
//   double4 packs    add-on packs the host advertised
//
// A room key is at most 16 chars, so FNV-1a is plenty: this is a grouping id,
// not a security boundary (the only reader is the account owner).
// Read the pack count off the room rather than caching it: a host takeover
// replaces the manifest, and a cached count would keep reporting the dead host's.
function packsOf(r) {
  return r && Array.isArray(r.manifest) ? r.manifest.length : 0;
}

function roomKey(room) {
  let h = 0x811c9dc5;
  for (let i = 0; i < room.length; i++) {
    h ^= room.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export class SignalHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;              // for the ROOM dataset; absent in local dev/tests
    // room -> { host: WebSocket|null, peers: Map<peerId, WebSocket>, nextPeer: number,
    //           manifest: object|null, manifestDropped: boolean, token: string|null,
    //           pending: Set<peerId>, graceTimer: number|null }
    // host === null means the room is in the host-loss grace window (see header);
    // pending holds peers who joined while hostless, flushed as {t:'peer'} on reclaim.
    this.rooms = new Map();
    this.graceMs = Number(env && env.SIGNAL_GRACE_MS) > 0 ? Number(env.SIGNAL_GRACE_MS) : 90000;
    this.keepaliveMs = Number(env && env.SIGNAL_KEEPALIVE_MS) > 0 ? Number(env.SIGNAL_KEEPALIVE_MS) : 30000;
    this.conns = new Set();      // every open server-side socket, for keepalive pings
    this.keepalive = null;       // interval handle; live only while conns is non-empty
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.trackConn(server);
    // Per-connection state (mirrors signal.mjs's per-socket role/room/peerId).
    // Stamped once per socket: the DO has no request at close/expiry time, and a
    // client cannot be trusted to say which deployment it is on.
    const conn = {
      role: null, room: null, peerId: 0, closed: false,
      site: url.hostname,
      cc: (request.cf && request.cf.country) || '',
      aud: url.searchParams.get('aud') === 'dev' ? 'dev' : 'public'
    };
    server.addEventListener('message', (ev) => this.onMessage(server, conn, ev.data));
    server.addEventListener('close', () => this.onClose(server, conn));
    server.addEventListener('error', () => this.onClose(server, conn));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Server-driven keepalive (see header).  The interval runs only while sockets
  // are open, so an idle hub with no connections holds no timer and can wind down.
  trackConn(ws) {
    this.conns.add(ws);
    if (!this.keepalive) {
      this.keepalive = setInterval(() => {
        for (const s of this.conns) this.send(s, { t: 'ping' });
      }, this.keepaliveMs);
    }
  }

  untrackConn(ws) {
    this.conns.delete(ws);
    if (this.conns.size === 0 && this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  send(ws, obj) {
    if (!ws) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }

  // Structured signaling log.  Observability is on (wrangler.jsonc), so these are
  // persisted and searchable -- grep the dashboard Logs by ev= or pack=true.  Only
  // tiny control events are logged (no game/pack bytes pass through here), so the
  // volume is negligible.  `pack` flags the derived pack-distribution room
  // (web/pack-net.js derivePackRoom appends '~p'), the channel this debugging
  // targets.
  log(ev, room, extra) {
    try {
      console.log(JSON.stringify(Object.assign(
        { ev, room, pack: typeof room === 'string' && room.endsWith('~p') }, extra || {})));
    } catch (e) {}
  }

  // Same events as log(), but into Analytics Engine (see the layout above).
  // Guarded on the binding so `wrangler dev`, the CI stub and older deploy
  // configs simply do not count -- they must not throw.  A write that fails is
  // loud for the same reason the /metric one is: a dataset that quietly stopped
  // receiving reads exactly like nobody playing together.
  room(ev, room, extra) {
    if (!this.env || !this.env.ROOM || typeof room !== 'string') return;
    const e = extra || {};
    try {
      this.env.ROOM.writeDataPoint({
        indexes: [roomKey(room)],
        blobs: [
          str(ev, 24), room.endsWith('~p') ? 'pack' : 'game', str(e.reason, 32),
          str(e.site, 64), str(e.cc, 8), e.aud === 'dev' ? 'dev' : 'public'
        ],
        doubles: [num(e.peers), num(e.peak), num(e.secs), num(e.packs)]
      });
    } catch (err) {
      console.error('[room] writeDataPoint failed:', String((err && err.message) || err));
    }
  }

  // Seconds since the room was created, for the lifetime columns.
  roomAge(r) {
    return Math.max(0, Math.round((Date.now() - ((r && r.openedMs) || Date.now())) / 1000));
  }

  onMessage(ws, conn, raw) {
    let m;
    try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); }
    catch (e) { return; }

    // Keepalive ping from a host/peer: nothing to relay, but receiving traffic
    // keeps the WebSocket (and therefore the in-memory room) alive so invite
    // links don't expire while a host sits idle waiting for players.
    if (m.t === 'ping') return;

    if (m.t === 'host' && typeof m.room === 'string' && m.room.length <= 16) {
      // Optional add-on-pack manifest (tiny control metadata so a joiner knows
      // which packs the host requires; pack BYTES never touch the Worker -- they
      // go P2P).  Cap its serialized size so a host can't bloat the in-memory hub.
      // Parsed up front so both the create and the reclaim path can apply it.
      let manifest = null;
      let bytes = 0, dropped = false, hasManifest = false;
      if (m.manifest != null) {
        hasManifest = true;
        try {
          const s = JSON.stringify(m.manifest);
          bytes = s.length;
          if (s.length <= MAX_MANIFEST_BYTES) manifest = m.manifest;
          else dropped = true; // over cap -> joiner would see no manifest; reported in host-ok below
        } catch (e) {}
      }
      // host-ok carries the drop signal so the host can warn instead of silently
      // distributing nothing (web/pack-net.js startPackHost logs it).  Only added
      // when a manifest was actually dropped, so the common case stays minimal.
      const hostOk = (room) => dropped
        ? { t: 'host-ok', room, manifestDropped: true, manifestBytes: bytes, manifestCap: MAX_MANIFEST_BYTES }
        : { t: 'host-ok', room };
      const token = (typeof m.token === 'string' && m.token.length <= 64) ? m.token : null;
      const existing = this.rooms.get(m.room);
      if (existing) {
        // Re-host (reclaim): a host whose signaling socket dropped (mobile freeze,
        // transient network, page resume) reconnects and re-sends {t:'host'} with
        // the SAME token to reclaim its room -- WITHOUT disturbing already-joined
        // peers (keep the peers Map + nextPeer so live peerIds stay valid).
        if (token && existing.token && token === existing.token) {
          const old = existing.host;
          existing.host = ws;                          // adopt the fresh socket
          if (old && old !== ws) { try { old.close(); } catch (e) {} } // its stale-close is guarded below
          conn.role = 'host';
          conn.room = m.room;
          if (hasManifest) { existing.manifest = manifest; existing.manifestDropped = dropped; } // refresh; absent -> keep prior
          this.send(ws, hostOk(m.room));
          const flushed = this.reclaimRoom(existing, ws);
          this.log('host-reclaim', m.room, { peers: existing.peers.size, flushed, packs: Array.isArray(existing.manifest) ? existing.manifest.length : 0 });
          this.room('room-reclaim', m.room, { peers: existing.peers.size, peak: existing.peak || 0,
            packs: packsOf(existing), secs: this.roomAge(existing), reason: 'same-token',
            site: existing.site, cc: existing.cc, aud: existing.aud });
          return;
        }
        // Token mismatch on a HOSTLESS room (grace window): the host reloaded its
        // page -- pinRoomUrl keeps ?room=<code> in the URL, so the reload re-hosts
        // the same code with a FRESH token.  Allow the takeover: peers of the dead
        // engine instance get host-left (their P2P died with that page), while
        // joiners still waiting for their first offer are handed to the new host.
        // A token mismatch on a room with a LIVE host stays a genuine collision.
        if (!existing.host) {
          for (const [id, pws] of existing.peers) {
            if (!existing.pending.has(id)) { this.send(pws, { t: 'host-left' }); existing.peers.delete(id); }
          }
          existing.host = ws;
          existing.token = token;
          existing.manifest = manifest;       // the new page's manifest, even if absent
          existing.manifestDropped = dropped;
          conn.role = 'host';
          conn.room = m.room;
          this.send(ws, hostOk(m.room));
          const flushed = this.reclaimRoom(existing, ws);
          this.log('host-takeover', m.room, { flushed, packs: Array.isArray(manifest) ? manifest.length : 0 });
          this.room('room-reclaim', m.room, { peers: existing.peers.size, peak: existing.peak || 0,
            packs: packsOf(existing), secs: this.roomAge(existing), reason: 'takeover',
            site: existing.site, cc: existing.cc, aud: existing.aud });
          return;
        }
        this.send(ws, { t: 'host-taken' });
        this.log('host-taken', m.room);
        this.room('room-taken', m.room, { peers: existing.peers.size, peak: existing.peak, site: conn.site, cc: conn.cc, aud: conn.aud });
        return;
      }
      conn.role = 'host';
      conn.room = m.room;
      const packs = Array.isArray(manifest) ? manifest.length : 0;
      this.rooms.set(m.room, { host: ws, peers: new Map(), nextPeer: 1, manifest, manifestDropped: dropped, token, pending: new Set(), graceTimer: null,
        // For the room dataset: peak answers "did anyone ever arrive" even for
        // a room whose peers all left before it closed, and openedMs survives
        // the host socket so expireRoom can report a lifetime.
        openedMs: Date.now(), peak: 0, site: conn.site, cc: conn.cc, aud: conn.aud });
      this.send(ws, hostOk(m.room));
      // packs: how many add-on packs the host advertised; dropped: the manifest
      // exceeded the hub cap and was discarded (a prime suspect when a joiner
      // never pulls anything despite the host having packs enabled).
      this.log('host', m.room, { packs, bytes, dropped });
      this.room('room-open', m.room, { packs, site: conn.site, cc: conn.cc, aud: conn.aud });

    } else if (m.t === 'join' && typeof m.room === 'string') {
      const r = this.rooms.get(m.room);
      if (!r) {
        this.send(ws, { t: 'no-room' });
        this.log('join', m.room, { result: 'no-room' });
        // The most informative row in the set: somebody followed an invite and
        // the room was not there.  Zero joins and zero join-fails means nobody
        // tried; zero joins with join-fails means the links are going stale.
        this.room('room-join-fail', m.room, { reason: 'no-room', site: conn.site, cc: conn.cc, aud: conn.aud });
        return;
      }
      conn.role = 'peer';
      conn.room = m.room;
      conn.peerId = r.nextPeer++;
      r.peers.set(conn.peerId, ws);
      // Echo the host's pack manifest so the joiner can diff it against its local
      // packs BEFORE the WebRTC/log-on handshake (see web/pack-net.js).
      // manifestDropped tells the joiner the host DID advertise packs but the hub
      // discarded the list for exceeding its size cap — distinct from a host with no
      // packs, so the joiner can surface it instead of silently joining pack-less.
      this.send(ws, { t: 'join-ok', peer: conn.peerId, manifest: r.manifest || null, manifestDropped: r.manifestDropped || undefined });
      // Hostless (grace window): queue the peer instead of notifying a dead socket;
      // the host's reclaim/takeover flushes the {t:'peer'} so this joiner connects
      // without having to retry.
      if (r.host) this.send(r.host, { t: 'peer', peer: conn.peerId });
      else r.pending.add(conn.peerId);
      if (r.peers.size > (r.peak || 0)) r.peak = r.peers.size;
      this.log('join', m.room, { result: 'join-ok', peer: conn.peerId, hostless: r.host ? undefined : true, packs: Array.isArray(r.manifest) ? r.manifest.length : 0 });
      this.room('room-join', m.room, { peers: r.peers.size, peak: r.peak,
        reason: r.host ? '' : 'hostless', packs: packsOf(r), site: conn.site, cc: conn.cc, aud: conn.aud });

    } else if ((m.t === 'sdp' || m.t === 'ice') && conn.room) {
      const r = this.rooms.get(conn.room);
      if (!r) { this.log('relay-drop', conn.room, { t: m.t, role: conn.role, reason: 'no-room' }); return; }
      if (conn.role === 'host') {
        const target = r.peers.get(m.peer);
        // A relay to an absent target (peer gone, or a stale/forged peer id) means
        // the handshake silently stalls -- log it so the gap is visible.
        if (!target) this.log('relay-drop', conn.room, { t: m.t, dir: 'host->peer', peer: m.peer, reason: 'no-peer' });
        else this.send(target, { t: m.t, peer: 0, data: m.data });
      } else {
        if (!r.host) this.log('relay-drop', conn.room, { t: m.t, dir: 'peer->host', peer: conn.peerId, reason: 'no-host' });
        else this.send(r.host, { t: m.t, peer: conn.peerId, data: m.data });
      }
      // SDP exchange is low-volume (one offer + one answer per pair) and marks the
      // WebRTC handshake actually starting; ICE candidates are high-volume so they
      // are NOT logged individually (a missing relay target above still surfaces).
      if (m.t === 'sdp') this.log('sdp', conn.room, { dir: conn.role === 'host' ? 'host->peer' : 'peer->host', peer: conn.role === 'host' ? m.peer : conn.peerId });
    }
  }

  // Shared tail of reclaim and takeover: hand the queued hostless-window joiners
  // to the (re)claiming host socket and disarm the grace timer.  Returns how many
  // {t:'peer'} events were flushed (for the log).
  reclaimRoom(r, ws) {
    if (r.graceTimer !== null) { clearTimeout(r.graceTimer); r.graceTimer = null; }
    let flushed = 0;
    for (const id of r.pending) {
      if (r.peers.has(id)) { this.send(ws, { t: 'peer', peer: id }); flushed++; }
    }
    r.pending.clear();
    return flushed;
  }

  onClose(ws, conn) {
    this.untrackConn(ws);
    if (conn.closed || !conn.room) return;
    conn.closed = true;
    const r = this.rooms.get(conn.room);
    if (!r) return;
    if (conn.role === 'host') {
      // Only the CURRENT host socket affects the room.  If the host already
      // reconnected and reclaimed the room with a fresh socket (r.host !== ws),
      // this is the delayed close of the OLD socket -- ignore it, or it would
      // clobber the freshly reclaimed room and strand the reconnected host (the
      // bug behind "after idle, late joiners get no-room").
      if (r.host !== ws) { this.log('host-close-stale', conn.room); return; }
      // Grace window (see header): keep the room hostless awaiting the host's
      // reclaim instead of deleting it -- deleting here turned every transient
      // host-socket loss into no-room for invite links.  Peers are NOT told
      // host-left yet: their P2P DataChannels are independent of signaling and
      // stay up through the blip.
      r.host = null;
      const room = conn.room;
      r.graceTimer = setTimeout(() => this.expireRoom(room), this.graceMs);
      this.log('host-grace', room, { peers: r.peers.size, graceMs: this.graceMs });
      // Written here rather than left to the timer: this line always runs, the
      // timer might not (see the layout note above).  A room that is reclaimed
      // gets a room-reclaim row after this one.
      this.room('room-hostless', room, {
        peers: r.peers.size, peak: r.peak || 0, packs: packsOf(r),
        secs: this.roomAge(r), site: r.site, cc: r.cc, aud: r.aud
      });
    } else {
      r.peers.delete(conn.peerId);
      r.pending.delete(conn.peerId);
      if (r.host) this.send(r.host, { t: 'peer-left', peer: conn.peerId });
      this.log('peer-left', conn.room, { peer: conn.peerId });
    }
  }

  // Grace expired with no reclaim: the host is genuinely gone, tear the room down.
  expireRoom(room) {
    const r = this.rooms.get(room);
    if (!r || r.host) return;  // reclaimed (or already gone) in the meantime
    for (const [, pws] of r.peers) this.send(pws, { t: 'host-left' });
    this.rooms.delete(room);
    this.log('host-left', room, { peers: r.peers.size, graceExpired: true });
    // One row per room, at the end: peak 0 is a room that nobody ever joined.
    this.room('room-close', room, {
      peers: r.peers.size, peak: r.peak || 0, packs: packsOf(r),
      secs: this.roomAge(r),
      reason: 'grace-expired', site: r.site, cc: r.cc, aud: r.aud
    });
  }
}
