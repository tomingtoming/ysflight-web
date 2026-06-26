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
      return turnCredentials(env);
    }
    // Non-signaling paths: serve the static game assets (dist/).
    return env.ASSETS.fetch(request);
  }
};

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
async function turnCredentials(env) {
  const keyId = env.TURN_KEY_ID;
  const apiToken = env.TURN_API_TOKEN;
  if (!keyId || !apiToken) return new Response(null, { status: 204 });
  try {
    const resp = await fetch(
      'https://rtc.live.cloudflare.com/v1/turn/keys/' + keyId + '/credentials/generate-ice-servers',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
        // TTL comfortably exceeds a play session; creds are minted once per load.
        body: JSON.stringify({ ttl: 86400 }),
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
    // room -> { host: WebSocket, peers: Map<peerId, WebSocket>, nextPeer: number, manifest: object|null }
    this.rooms = new Map();
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // Per-connection state (mirrors signal.mjs's per-socket role/room/peerId).
    const conn = { role: null, room: null, peerId: 0, closed: false };
    server.addEventListener('message', (ev) => this.onMessage(server, conn, ev.data));
    server.addEventListener('close', () => this.onClose(server, conn));
    server.addEventListener('error', () => this.onClose(server, conn));
    return new Response(null, { status: 101, webSocket: client });
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
        // peers (keep the peers Map + nextPeer so live peerIds stay valid).  Without
        // a matching token an existing room is a genuine code collision -> taken.
        if (token && existing.token && token === existing.token) {
          const old = existing.host;
          existing.host = ws;                          // adopt the fresh socket
          if (old && old !== ws) { try { old.close(); } catch (e) {} } // its stale-close is guarded below
          conn.role = 'host';
          conn.room = m.room;
          if (hasManifest) { existing.manifest = manifest; existing.manifestDropped = dropped; } // refresh; absent -> keep prior
          this.send(ws, hostOk(m.room));
          this.log('host-reclaim', m.room, { peers: existing.peers.size, packs: Array.isArray(existing.manifest) ? existing.manifest.length : 0 });
          return;
        }
        this.send(ws, { t: 'host-taken' });
        this.log('host-taken', m.room);
        return;
      }
      conn.role = 'host';
      conn.room = m.room;
      this.rooms.set(m.room, { host: ws, peers: new Map(), nextPeer: 1, manifest, manifestDropped: dropped, token });
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
      this.send(r.host, { t: 'peer', peer: conn.peerId });
      this.log('join', m.room, { result: 'join-ok', peer: conn.peerId, packs: Array.isArray(r.manifest) ? r.manifest.length : 0 });

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

  onClose(ws, conn) {
    if (conn.closed || !conn.room) return;
    conn.closed = true;
    const r = this.rooms.get(conn.room);
    if (!r) return;
    if (conn.role === 'host') {
      // Only the CURRENT host socket tears the room down.  If the host already
      // reconnected and reclaimed the room with a fresh socket (r.host !== ws),
      // this is the delayed close of the OLD socket -- ignore it, or it would
      // clobber the freshly reclaimed room and strand the reconnected host (the
      // bug behind "after idle, late joiners get no-room").
      if (r.host !== ws) { this.log('host-close-stale', conn.room); return; }
      for (const [, pws] of r.peers) this.send(pws, { t: 'host-left' });
      this.rooms.delete(conn.room);
      this.log('host-left', conn.room, { peers: r.peers.size });
    } else {
      r.peers.delete(conn.peerId);
      this.send(r.host, { t: 'peer-left', peer: conn.peerId });
      this.log('peer-left', conn.room, { peer: conn.peerId });
    }
  }
}
