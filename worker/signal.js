// Cloudflare Worker + Durable Object: WebRTC signaling for ysflight-web.
//
// This replaces the old self-hosted server/signal.mjs.  A single hub Durable
// Object holds every room's WebSockets in memory and relays the exact same
// JSON protocol the wasm client already speaks (see
// src/port/yssocket/yssocket_emscripten.cpp):
//
//   client -> server : {t:'host',room} | {t:'join',room}
//                      | {t:'sdp'|'ice', peer?, data}   (host sends peer, peer omits it)
//   server -> client : {t:'host-ok',room} | {t:'host-taken'} | {t:'no-room'}
//                      | {t:'join-ok',peer} | {t:'peer',peer}
//                      | {t:'sdp'|'ice', peer, data}
//                      | {t:'host-left'} | {t:'peer-left',peer}
//
// Game traffic never touches this Worker -- after signaling it flows P2P over
// WebRTC DataChannels (public STUN; no TURN for now).  Everything else (the
// static game in dist/) is served by Workers Static Assets.
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
    // Non-signaling paths: serve the static game assets (dist/).
    return env.ASSETS.fetch(request);
  }
};

export class SignalHub {
  constructor(state, env) {
    this.state = state;
    // room -> { host: WebSocket, peers: Map<peerId, WebSocket>, nextPeer: number }
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

    if (m.t === 'host' && typeof m.room === 'string' && m.room.length <= 16) {
      if (this.rooms.has(m.room)) { this.send(ws, { t: 'host-taken' }); return; }
      conn.role = 'host';
      conn.room = m.room;
      this.rooms.set(m.room, { host: ws, peers: new Map(), nextPeer: 1 });
      this.send(ws, { t: 'host-ok', room: m.room });

    } else if (m.t === 'join' && typeof m.room === 'string') {
      const r = this.rooms.get(m.room);
      if (!r) { this.send(ws, { t: 'no-room' }); return; }
      conn.role = 'peer';
      conn.room = m.room;
      conn.peerId = r.nextPeer++;
      r.peers.set(conn.peerId, ws);
      this.send(ws, { t: 'join-ok', peer: conn.peerId });
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
