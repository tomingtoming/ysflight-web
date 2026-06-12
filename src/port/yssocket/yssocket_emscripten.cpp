/* ////////////////////////////////////////////////////////////

File Name: yssocket_emscripten.cpp

Emscripten implementation of yssocket for the ysflight-web project.

- YsSocketClient keeps the upstream TCP code path (which Emscripten
  tunnels over WebSocket, used with the ws-tcp relay against native
  YSFLIGHT servers), and adds a WebRTC DataChannel path used when the
  host address is a room code ("#ABC123" or "rtc:ABC123").
- YsSocketServer is implemented entirely on WebRTC DataChannels: the
  browser registers a room code on the signaling server and accepts
  joining browsers peer-to-peer, so a browser can host a game.

The signaling server is server/signal.mjs; the page selects it with
Module.ysfwSignalUrl (?signal=... in the web shell).  Game traffic never
passes through the signaling server.

Copyright (c) 2026 ysflight-web contributors.
Follows the same BSD-style license as yssocket itself.

//////////////////////////////////////////////////////////// */

#include <emscripten.h>

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <poll.h>
#include <arpa/inet.h>

#include <map>

#include "yssocket.h"

#define SOCKET_ERROR (-1)
typedef struct sockaddr_in SOCKADDR_IN;
typedef struct sockaddr SOCKADDR;

// ============================================================================
// JavaScript glue: WebRTC host & client over the signaling server.
//
// All state lives in globalThis.ysfwRtc.  The C++ side polls; everything
// asynchronous happens in JS event handlers.  Bytes arriving on a data
// channel are queued per peer and drained into wasm memory on demand.

EM_JS(void, jsRtcInit, (), {
	if (globalThis.ysfwRtc) return;
	globalThis.ysfwRtc = {
		cfg: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
		signalUrl: function () {
			return Module.ysfwSignalUrl ||
				((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.hostname + ':7917');
		},
		mixedContent: function (url) {
			// Browsers block insecure ws:// from https pages (except localhost).
			if (location.protocol !== 'https:') return false;
			if (url.lastIndexOf('ws://', 0) !== 0) return false;
			var host = url.substring(5).split('/')[0].split(':')[0];
			return host !== 'localhost' && host !== '127.0.0.1';
		},
		makeQueue: function () {
			return { chunks: [], offset: 0, size: 0 };
		},
		pushQueue: function (q, data) {
			var u8 = new Uint8Array(data);
			q.chunks.push(u8);
			q.size += u8.length;
		},
		drainQueue: function (q, ptr, cap) {
			var n = 0;
			while (n < cap && q.chunks.length > 0) {
				var head = q.chunks[0];
				var avail = head.length - q.offset;
				var take = Math.min(avail, cap - n);
				HEAPU8.set(head.subarray(q.offset, q.offset + take), ptr + n);
				n += take;
				q.offset += take;
				if (q.offset >= head.length) { q.chunks.shift(); q.offset = 0; }
			}
			q.size -= n;
			return n;
		},
		overlay: function (text) {
			var el = document.getElementById('ysfw-room-overlay');
			if (!text) { if (el) el.remove(); return; }
			if (!el) {
				el = document.createElement('div');
				el.id = 'ysfw-room-overlay';
				el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:30;' +
					'background:rgba(10,14,20,.85);color:#cfd8e3;padding:8px 14px;' +
					'border-radius:6px;font:14px monospace;pointer-events:none';
				document.body.appendChild(el);
			}
			el.textContent = text;
		}
	};
});

// ---------------------------------------------------------------------------
// Host side

EM_JS(int, jsHostStart, (int maxClients), {
	var R = globalThis.ysfwRtc;
	if (R.host) return 0;

	var room = (Module.ysfwRoomCode ||
		Array.from({ length: 6 }, function () {
			return 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)];
		}).join(''));

	var H = {
		room: room, max: maxClients, ok: false, failed: false,
		slots: {},          // slot -> {pc, ch, open, closed, q}
		peerToSlot: {},     // signaling peerId -> slot
		acceptQueue: [], closeQueue: [],
		ws: null
	};
	R.host = H;
	R.overlay('Room: #' + room + ' (connecting...)');

	if (R.mixedContent(R.signalUrl())) {
		H.failed = true;
		R.overlay('Blocked: https page cannot use ws:// — use wss:// for ?signal=');
		console.error('ysflight-web: this page is https, so the browser blocks ws:// signaling URLs. ' +
			'Use wss:// (TLS) for ?signal=, e.g. via a Cloudflare Tunnel or a TLS reverse proxy.');
		return 0;
	}
	var ws;
	try { ws = new WebSocket(R.signalUrl()); } catch (e) { H.failed = true; R.overlay('Signal server unreachable'); return 0; }
	H.ws = ws;
	ws.onerror = function () { if (!H.ok) { H.failed = true; R.overlay('Signal server unreachable'); } };
	ws.onclose = function () { if (!H.ok) { H.failed = true; } };
	ws.onopen = function () { ws.send(JSON.stringify({ t: 'host', room: room })); };
	ws.onmessage = function (ev) {
		var m = JSON.parse(ev.data);
		if (m.t === 'host-ok') {
			H.ok = true;
			R.overlay('Room: #' + room);
		} else if (m.t === 'host-taken') {
			H.failed = true;
			R.overlay('Room code taken — restart server');
		} else if (m.t === 'peer') {
			// Find a free slot.
			var slot = -1;
			for (var i = 0; i < H.max; ++i) {
				if (!H.slots[i]) { slot = i; break; }
			}
			if (slot < 0) return;
			var pc = new RTCPeerConnection(R.cfg);
			var ch = pc.createDataChannel('ysf', { ordered: true });
			ch.binaryType = 'arraybuffer';
			var S = { pc: pc, ch: ch, open: false, closed: false, q: R.makeQueue(), iceQ: [], remoteSet: false };
			H.slots[slot] = S;
			H.peerToSlot[m.peer] = slot;
			ch.onopen = function () { S.open = true; H.acceptQueue.push(slot); };
			ch.onmessage = function (e) { R.pushQueue(S.q, e.data); };
			ch.onclose = function () { if (S.open && !S.closed) { S.closed = true; H.closeQueue.push(slot); } };
			pc.onicecandidate = function (e) {
				if (e.candidate) ws.send(JSON.stringify({ t: 'ice', peer: m.peer, data: e.candidate }));
			};
			pc.createOffer().then(function (o) {
				return pc.setLocalDescription(o);
			}).then(function () {
				ws.send(JSON.stringify({ t: 'sdp', peer: m.peer, data: pc.localDescription }));
			});
		} else if (m.t === 'sdp') {
			var slot = H.peerToSlot[m.peer];
			if (slot === undefined || !H.slots[slot]) return;
			var S2 = H.slots[slot];
			S2.pc.setRemoteDescription(m.data).then(function () {
				S2.remoteSet = true;
				for (var c = 0; c < S2.iceQ.length; ++c) S2.pc.addIceCandidate(S2.iceQ[c]).catch(function () {});
				S2.iceQ = [];
			});
		} else if (m.t === 'ice') {
			var slot = H.peerToSlot[m.peer];
			if (slot === undefined || !H.slots[slot]) return;
			var S3 = H.slots[slot];
			if (S3.remoteSet) S3.pc.addIceCandidate(m.data).catch(function () {});
			else S3.iceQ.push(m.data);
		} else if (m.t === 'peer-left') {
			var slot = H.peerToSlot[m.peer];
			if (slot !== undefined && H.slots[slot] && H.slots[slot].open && !H.slots[slot].closed) {
				H.slots[slot].closed = true;
				H.closeQueue.push(slot);
			}
		}
	};
	return 1;
});

EM_JS(void, jsHostRoomCode, (char *buf, int cap), {
	var R = globalThis.ysfwRtc;
	stringToUTF8(R && R.host ? R.host.room : '', buf, cap);
});

EM_JS(int, jsHostPollAccept, (), {
	var H = globalThis.ysfwRtc && globalThis.ysfwRtc.host;
	if (!H || H.acceptQueue.length === 0) return -1;
	return H.acceptQueue.shift();
});

EM_JS(int, jsHostPollClosed, (), {
	var H = globalThis.ysfwRtc && globalThis.ysfwRtc.host;
	if (!H || H.closeQueue.length === 0) return -1;
	return H.closeQueue.shift();
});

EM_JS(int, jsHostActive, (int slot), {
	var H = globalThis.ysfwRtc && globalThis.ysfwRtc.host;
	var S = H && H.slots[slot];
	return (S && S.open && !S.closed) ? 1 : 0;
});

EM_JS(int, jsHostNumConnected, (), {
	var H = globalThis.ysfwRtc && globalThis.ysfwRtc.host;
	if (!H) return 0;
	var n = 0;
	for (var k in H.slots) {
		var S = H.slots[k];
		if (S && S.open && !S.closed) ++n;
	}
	return n;
});

EM_JS(int, jsHostRecv, (int slot, unsigned char *ptr, int cap), {
	var R = globalThis.ysfwRtc;
	var H = R && R.host;
	var S = H && H.slots[slot];
	if (!S || S.q.size === 0) return 0;
	return R.drainQueue(S.q, ptr, cap);
});

EM_JS(void, jsHostSend, (int slot, unsigned char *ptr, int n), {
	var H = globalThis.ysfwRtc && globalThis.ysfwRtc.host;
	var S = H && H.slots[slot];
	if (S && S.open && !S.closed && S.ch.readyState === 'open') {
		S.ch.send(HEAPU8.subarray(ptr, ptr + n));
	}
});

EM_JS(void, jsHostDisconnect, (int slot), {
	var H = globalThis.ysfwRtc && globalThis.ysfwRtc.host;
	var S = H && H.slots[slot];
	if (!S) return;
	try { S.ch.close(); } catch (e) {}
	try { S.pc.close(); } catch (e) {}
	S.closed = true;
	delete H.slots[slot];
});

EM_JS(void, jsHostStop, (), {
	var R = globalThis.ysfwRtc;
	var H = R && R.host;
	if (!H) return;
	for (var k in H.slots) {
		var S = H.slots[k];
		try { S.ch.close(); } catch (e) {}
		try { S.pc.close(); } catch (e) {}
	}
	try { H.ws.close(); } catch (e) {}
	R.overlay(null);
	R.host = null;
});

// ---------------------------------------------------------------------------
// Client side

EM_JS(void, jsCliConnect, (const char *roomPtr), {
	var R = globalThis.ysfwRtc;
	var room = UTF8ToString(roomPtr);
	var C = { state: 0, q: R.makeQueue(), pending: [], pc: null, ch: null, ws: null, iceQ: [], remoteSet: false };  // state: 0=connecting 1=open 2=closed
	R.cli = C;

	if (R.mixedContent(R.signalUrl())) {
		C.state = 2;
		console.error('ysflight-web: this page is https, so the browser blocks ws:// signaling URLs. ' +
			'Use wss:// (TLS) for ?signal=.');
		return;
	}
	var ws;
	try { ws = new WebSocket(R.signalUrl()); } catch (e) { C.state = 2; return; }
	C.ws = ws;
	ws.onerror = function () { if (C.state === 0) C.state = 2; };
	ws.onopen = function () { ws.send(JSON.stringify({ t: 'join', room: room })); };
	ws.onmessage = function (ev) {
		var m = JSON.parse(ev.data);
		if (m.t === 'no-room') {
			C.state = 2;
		} else if (m.t === 'sdp') {
			var pc = new RTCPeerConnection(R.cfg);
			C.pc = pc;
			pc.ondatachannel = function (e) {
				var ch = e.channel;
				ch.binaryType = 'arraybuffer';
				C.ch = ch;
				ch.onopen = function () {
					C.state = 1;
					for (var i = 0; i < C.pending.length; ++i) ch.send(C.pending[i]);
					C.pending = [];
				};
				ch.onmessage = function (e2) { R.pushQueue(C.q, e2.data); };
				ch.onclose = function () { C.state = 2; };
			};
			pc.onicecandidate = function (e) {
				if (e.candidate) ws.send(JSON.stringify({ t: 'ice', data: e.candidate }));
			};
			pc.setRemoteDescription(m.data).then(function () {
				C.remoteSet = true;
				for (var c = 0; c < C.iceQ.length; ++c) pc.addIceCandidate(C.iceQ[c]).catch(function () {});
				C.iceQ = [];
				return pc.createAnswer();
			}).then(function (a) {
				return pc.setLocalDescription(a);
			}).then(function () {
				ws.send(JSON.stringify({ t: 'sdp', data: pc.localDescription }));
			});
		} else if (m.t === 'ice') {
			if (C.pc && C.remoteSet) C.pc.addIceCandidate(m.data).catch(function () {});
			else C.iceQ.push(m.data);
		} else if (m.t === 'host-left') {
			C.state = 2;
		}
	};
});

EM_JS(int, jsCliState, (), {
	var C = globalThis.ysfwRtc && globalThis.ysfwRtc.cli;
	return C ? C.state : 2;
});

EM_JS(int, jsCliRecv, (unsigned char *ptr, int cap), {
	var R = globalThis.ysfwRtc;
	var C = R && R.cli;
	if (!C || C.q.size === 0) return 0;
	return R.drainQueue(C.q, ptr, cap);
});

EM_JS(void, jsCliSend, (unsigned char *ptr, int n), {
	var C = globalThis.ysfwRtc && globalThis.ysfwRtc.cli;
	if (!C) return;
	var data = HEAPU8.slice(ptr, ptr + n);
	if (C.state === 1 && C.ch && C.ch.readyState === 'open') {
		C.ch.send(data);
	} else if (C.state === 0) {
		C.pending.push(data);   // queued until the channel opens
	}
});

EM_JS(void, jsCliClose, (), {
	var R = globalThis.ysfwRtc;
	var C = R && R.cli;
	if (!C) return;
	try { if (C.ch) C.ch.close(); } catch (e) {}
	try { if (C.pc) C.pc.close(); } catch (e) {}
	try { if (C.ws) C.ws.close(); } catch (e) {}
	R.cli = null;
});

// ============================================================================
// Helpers

// "#ABC123" or "rtc:ABC123" selects the WebRTC path; anything that looks
// like a hostname/IP goes through the TCP path (WebSocket relay).
static const char *YsfwRtcRoomFromHost(const char host[])
{
	if (nullptr == host) {
		return nullptr;
	}
	if ('#' == host[0] && 0 != host[1]) {
		return host + 1;
	}
	if (0 == strncmp(host, "rtc:", 4) && 0 != host[4]) {
		return host + 4;
	}
	return nullptr;
}

// ============================================================================
// YsSocketServer: WebRTC host

YsSocketServer::YsSocketServer(int port, int maxNumCli)
{
	started = YSFALSE;
	listeningPort = port;
	maxNumClient = maxNumCli;
	clientSockUsed = new YSBOOL[maxNumCli];
	clientReady = new YSBOOL[maxNumCli];
	clientSock = new SOCKET[maxNumCli];
	for (int i = 0; i < maxNumCli; ++i) {
		clientSockUsed[i] = YSFALSE;
		clientReady[i] = YSFALSE;
		clientSock[i] = -1;
	}
}

YsSocketServer::~YsSocketServer()
{
	Terminate();
	delete[] clientSockUsed;
	delete[] clientReady;
	delete[] clientSock;
}

YSRESULT YsSocketServer::Start(void)
{
	if (YSTRUE == started) {
		return YSOK;
	}
	jsRtcInit();
	if (0 == jsHostStart(maxNumClient)) {
		printf("Failed to start the WebRTC host.\n");
		return YSERR;
	}

	char room[32];
	jsHostRoomCode(room, sizeof(room));
	printf("WebRTC room opened.  Other players join with address: #%s\n", room);
	printf("(Signaling server: see ?signal= ; game data flows peer-to-peer.)\n");

	started = YSTRUE;
	return YSOK;
}

YSRESULT YsSocketServer::Terminate(void)
{
	if (YSTRUE != started) {
		return YSERR;
	}
	jsHostStop();
	for (int i = 0; i < maxNumClient; ++i) {
		clientSockUsed[i] = YSFALSE;
	}
	started = YSFALSE;
	return YSOK;
}

YSRESULT YsSocketServer::CheckAndAcceptConnection(void)
{
	if (YSTRUE != started) {
		return YSERR;
	}
	int slot;
	while (0 <= (slot = jsHostPollAccept())) {
		if (slot < maxNumClient) {
			clientSockUsed[slot] = YSTRUE;
			unsigned int ipAddr[4] = {0, 0, 0, 0};
			ConnectionAccepted(slot, ipAddr);
		}
	}
	while (0 <= (slot = jsHostPollClosed())) {
		if (slot < maxNumClient && YSTRUE == clientSockUsed[slot]) {
			ConnectionClosedByClient(slot);
			jsHostDisconnect(slot);
			clientSockUsed[slot] = YSFALSE;
		}
	}
	return YSOK;
}

YSRESULT YsSocketServer::CheckReceive(void)
{
	if (YSTRUE != started) {
		return YSERR;
	}
	for (int i = 0; i < maxNumClient; ++i) {
		if (YSTRUE != clientSockUsed[i]) {
			continue;
		}
		int n;
		while (0 < (n = jsHostRecv(i, buffer, nBufferSize))) {
			ReceivedFrom(i, n, buffer);
		}
	}
	return YSOK;
}

int YsSocketServer::GetNumClient(void) const
{
	return maxNumClient;
}

YSBOOL YsSocketServer::IsClientActive(int clientId) const
{
	if (0 <= clientId && clientId < maxNumClient && YSTRUE == clientSockUsed[clientId]) {
		return (0 != jsHostActive(clientId)) ? YSTRUE : YSFALSE;
	}
	return YSFALSE;
}

int YsSocketServer::GetNumConnectedClient(void) const
{
	return jsHostNumConnected();
}

YSRESULT YsSocketServer::Disconnect(int clientId)
{
	if (clientId < 0) {
		for (int i = 0; i < maxNumClient; ++i) {
			if (YSTRUE == clientSockUsed[i]) {
				jsHostDisconnect(i);
				clientSockUsed[i] = YSFALSE;
			}
		}
		return YSOK;
	}
	if (clientId < maxNumClient && YSTRUE == clientSockUsed[clientId]) {
		jsHostDisconnect(clientId);
		clientSockUsed[clientId] = YSFALSE;
		return YSOK;
	}
	return YSERR;
}

YSRESULT YsSocketServer::Send(int clientId, YSSIZE_T nBytes, unsigned char dat[], unsigned /*timeout*/)
{
	if (YSTRUE != started || nBytes <= 0) {
		return YSERR;
	}
	if (clientId < 0) {
		for (int i = 0; i < maxNumClient; ++i) {
			if (YSTRUE == clientSockUsed[i]) {
				jsHostSend(i, dat, (int)nBytes);
			}
		}
		return YSOK;
	}
	if (clientId < maxNumClient && YSTRUE == clientSockUsed[clientId]) {
		jsHostSend(clientId, dat, (int)nBytes);
		return YSOK;
	}
	return YSERR;
}

YSRESULT YsSocketServer::SendTerminateMessage(int clientId, unsigned timeout)
{
	unsigned char msg[] = "***SERVER TERMINATING***";
	return Send(clientId, sizeof(msg) - 1, msg, timeout);
}

YSRESULT YsSocketServer::ConnectionAccepted(int, unsigned int[4])
{
	return YSOK;
}

YSRESULT YsSocketServer::ConnectionClosedByClient(int)
{
	return YSOK;
}

SOCKET YsSocketServer::GetClientSocket(int)
{
	return -1;
}

// ============================================================================
// YsSocketClient: TCP (WebSocket relay) or WebRTC room, chosen per Connect().

// Side table: rtc mode per client instance (the upstream header is unchanged).
static std::map<const YsSocketClient *, bool> ysfwCliRtcMode;

static bool YsfwCliIsRtc(const YsSocketClient *cli)
{
	auto it = ysfwCliRtcMode.find(cli);
	return (it != ysfwCliRtcMode.end() && it->second);
}

YsSocketClient::YsSocketClient()
{
	Initialize(0);
}

YsSocketClient::YsSocketClient(int port)
{
	Initialize(port);
}

void YsSocketClient::Initialize(int port)
{
	started = YSFALSE;
	connected = YSFALSE;
	this->port = port;
	sock = -1;
	ysfwCliRtcMode[this] = false;
}

YsSocketClient::~YsSocketClient()
{
	Terminate();
	ysfwCliRtcMode.erase(this);
}

YSRESULT YsSocketClient::Start(int port)
{
	this->port = port;
	return Start();
}

YSRESULT YsSocketClient::Start(void)
{
	started = YSTRUE;
	return YSOK;
}

YSRESULT YsSocketClient::Terminate(void)
{
	if (YSTRUE == connected) {
		Disconnect();
	}
	started = YSFALSE;
	return YSOK;
}

YSRESULT YsSocketClient::Connect(const char hostaddr[])
{
	if (YSTRUE != started) {
		return YSERR;
	}

	const char *room = YsfwRtcRoomFromHost(hostaddr);
	if (nullptr != room) {
		jsRtcInit();
		printf("Joining WebRTC room #%s ...\n", room);
		jsCliConnect(room);
		ysfwCliRtcMode[this] = true;
		// The channel opens asynchronously; sends are queued in the JS glue
		// until then, mirroring how Emscripten's TCP-over-WebSocket behaves.
		connected = YSTRUE;
		return YSOK;
	}

	// --- TCP path (Emscripten tunnels this over WebSocket; use the relay) ---
	ysfwCliRtcMode[this] = false;

	sock = socket(PF_INET, SOCK_STREAM, 0);
	if (sock == -1) {
		return YSERR;
	}

	SOCKADDR_IN addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons(port);

	struct hostent *table = gethostbyname(hostaddr);
	if (table == NULL) {
		close(sock);
		sock = -1;
		return YSERR;
	}
	memcpy(&addr.sin_addr, table->h_addr_list[0], table->h_length);

	printf("Trying to : %s\n", inet_ntoa(addr.sin_addr));
	if (connect(sock, (SOCKADDR *)&addr, sizeof(SOCKADDR_IN)) != 0) {
		printf("Error occured in connect()\n");
		close(sock);
		sock = -1;
		return YSERR;
	}
	printf("Connected.\n");

	connected = YSTRUE;
	return YSOK;
}

YSRESULT YsSocketClient::Disconnect(void)
{
	if (YSTRUE != connected) {
		return YSERR;
	}
	if (YsfwCliIsRtc(this)) {
		jsCliClose();
	} else if (0 <= sock) {
		close(sock);
		sock = -1;
	}
	connected = YSFALSE;
	return YSOK;
}

YSBOOL YsSocketClient::IsConnected(void)
{
	if (YSTRUE == connected && YsfwCliIsRtc(this) && 2 == jsCliState()) {
		// Connection lost; report it once through the normal callback path.
		ConnectionClosedByServer();
		Disconnect();
	}
	return connected;
}

YSRESULT YsSocketClient::Send(YSSIZE_T nBytes, unsigned char dat[], unsigned /*timeout*/)
{
	if (YSTRUE != connected || nBytes <= 0) {
		return YSERR;
	}
	if (YsfwCliIsRtc(this)) {
		if (2 == jsCliState()) {
			return YSERR;
		}
		jsCliSend(dat, (int)nBytes);
		return YSOK;
	}

	struct pollfd pfd;
	pfd.fd = sock;
	pfd.events = POLLOUT;
	pfd.revents = 0;
	if (poll(&pfd, 1, 1) >= 1) {
		send(sock, (char *)dat, (int)nBytes, 0);
		return YSOK;
	}
	return YSERR;
}

YSRESULT YsSocketClient::CheckReceive(void)
{
	if (YSTRUE != connected) {
		return YSOK;
	}

	if (YsfwCliIsRtc(this)) {
		int n;
		while (0 < (n = jsCliRecv(buffer, nBufferSize))) {
			Received(n, buffer);
		}
		if (2 == jsCliState()) {
			ConnectionClosedByServer();
			Disconnect();
		}
		return YSOK;
	}

	struct pollfd pfd;
	pfd.fd = sock;
	pfd.events = POLLIN;
	pfd.revents = 0;
	if (poll(&pfd, 1, 1) >= 1) {
		int nBytesReceived = recv(sock, (char *)buffer, nBufferSize, 0);
		if (nBytesReceived == 0 || nBytesReceived == SOCKET_ERROR) {
			ConnectionClosedByServer();
			Disconnect();
		} else {
			Received(nBytesReceived, buffer);
		}
	}
	return YSOK;
}

YSRESULT YsSocketClient::ConnectionClosedByServer(void)
{
	printf("Connection closed by server.\n");
	return YSOK;
}
