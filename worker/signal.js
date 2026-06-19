// Cloudflare Worker + Durable Object: WebRTC signaling for ysflight-web.
//
// This replaces the old self-hosted server/signal.mjs.  A single hub Durable
// Object holds every room's WebSockets in memory and relays the exact same
// JSON protocol the wasm client already speaks (see
// src/port/yssocket/yssocket_emscripten.cpp):
//
//   client -> server : {t:'host',room,manifest?} | {t:'join',room}
//                      | {t:'sdp'|'ice', peer?, data}   (host sends peer, peer omits it)
//   server -> client : {t:'host-ok',room} | {t:'host-taken'} | {t:'no-room'}
//                      | {t:'join-ok',peer,manifest?} | {t:'peer',peer}
//                      | {t:'sdp'|'ice', peer, data}
//                      | {t:'host-left'} | {t:'peer-left',peer}
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
    server.addEventListener('close', () => this.onClose(conn));
    server.addEventListener('error', () => this.onClose(conn));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) {
    if (!ws) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
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
      if (this.rooms.has(m.room)) { this.send(ws, { t: 'host-taken' }); return; }
      conn.role = 'host';
      conn.room = m.room;
      // Optional add-on-pack manifest (tiny control metadata so a joiner knows
      // which packs the host requires; pack BYTES never touch the Worker -- they
      // go P2P).  Cap its serialized size so a host can't bloat the in-memory hub.
      let manifest = null;
      if (m.manifest != null) {
        try {
          const s = JSON.stringify(m.manifest);
          if (s.length <= 64 * 1024) manifest = m.manifest;
        } catch (e) {}
      }
      this.rooms.set(m.room, { host: ws, peers: new Map(), nextPeer: 1, manifest });
      this.send(ws, { t: 'host-ok', room: m.room });

    } else if (m.t === 'join' && typeof m.room === 'string') {
      const r = this.rooms.get(m.room);
      if (!r) { this.send(ws, { t: 'no-room' }); return; }
      conn.role = 'peer';
      conn.room = m.room;
      conn.peerId = r.nextPeer++;
      r.peers.set(conn.peerId, ws);
      // Echo the host's pack manifest so the joiner can diff it against its local
      // packs BEFORE the WebRTC/log-on handshake (see web/pack-net.js).
      this.send(ws, { t: 'join-ok', peer: conn.peerId, manifest: r.manifest || null });
      this.send(r.host, { t: 'peer', peer: conn.peerId });

    } else if ((m.t === 'sdp' || m.t === 'ice') && conn.room) {
      const r = this.rooms.get(conn.room);
      if (!r) return;
      if (conn.role === 'host') {
        this.send(r.peers.get(m.peer), { t: m.t, peer: 0, data: m.data });
      } else {
        this.send(r.host, { t: m.t, peer: conn.peerId, data: m.data });
      }
    }
  }

  onClose(conn) {
    if (conn.closed || !conn.room) return;
    conn.closed = true;
    const r = this.rooms.get(conn.room);
    if (!r) return;
    if (conn.role === 'host') {
      for (const [, pws] of r.peers) this.send(pws, { t: 'host-left' });
      this.rooms.delete(conn.room);
    } else {
      r.peers.delete(conn.peerId);
      this.send(r.host, { t: 'peer-left', peer: conn.peerId });
    }
  }
}
