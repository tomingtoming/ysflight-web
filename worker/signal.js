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

export class SignalHub {
  constructor(state, env) {
    this.state = state;
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
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.trackConn(server);
    // Per-connection state (mirrors signal.mjs's per-socket role/room/peerId).
    const conn = { role: null, room: null, peerId: 0, closed: false };
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
          return;
        }
        this.send(ws, { t: 'host-taken' });
        this.log('host-taken', m.room);
        return;
      }
      conn.role = 'host';
      conn.room = m.room;
      this.rooms.set(m.room, { host: ws, peers: new Map(), nextPeer: 1, manifest, manifestDropped: dropped, token, pending: new Set(), graceTimer: null });
      this.send(ws, hostOk(m.room));
      // packs: how many add-on packs the host advertised; dropped: the manifest
      // exceeded the hub cap and was discarded (a prime suspect when a joiner
      // never pulls anything despite the host having packs enabled).
      this.log('host', m.room, { packs: Array.isArray(manifest) ? manifest.length : 0, bytes, dropped });

    } else if (m.t === 'join' && typeof m.room === 'string') {
      const r = this.rooms.get(m.room);
      if (!r) { this.send(ws, { t: 'no-room' }); this.log('join', m.room, { result: 'no-room' }); return; }
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
      this.log('join', m.room, { result: 'join-ok', peer: conn.peerId, hostless: r.host ? undefined : true, packs: Array.isArray(r.manifest) ? r.manifest.length : 0 });

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
  }
}
