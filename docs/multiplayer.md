# ysflight-web マルチプレイ設計 (Multiplayer Design)

## 背景: YSFLIGHT 既存ネットコード

YSFLIGHT には TCP ベースのマルチプレイ実装が既にある
(`upstream/YSFLIGHT/src/core` の `fsnetwork*` / `fssocketserver` / `fssocketclient`、
既定ポート 7915、独自バイナリプロトコル `NETVERSION`)。
サーバ・クライアントとも `yssocket` (BSD ソケット) 上に実装されている。

ブラウザは生の TCP を張れないため、次の2段階で対応する。

## Phase 1: WebSocket ブリッジ (実装コスト最小・本家サーバと相互運用)

```
[browser wasm client] --WebSocket--> [ws-tcp relay (Node)] --TCP--> [YSFLIGHT console server]
```

- Emscripten はリンク時に BSD ソケット呼び出しを WebSocket に変換する
  (`-lwebsocket.js`, デフォルトで `ws://<host>/`)。クライアント側コード変更ゼロで
  `connect()` が WebSocket 接続になる。
- サーバ側に [websockify](https://github.com/novnc/websockify) 互換の
  リレー(`server/relay.mjs`)を置き、TCP の YSFLIGHT サーバ
  (`main_consvr` をネイティブビルドしたもの、または通常クライアントのサーバモード)
  へ中継する。
- バイナリフレーミング: Emscripten の WebSocket ソケットは
  `binaryType=arraybuffer` のメッセージ単位で TCP ストリームをエミュレートする。
  YSFLIGHT プロトコルは長さプレフィックス付きメッセージなので、
  リレーは素通しで良い (websockify と同じ)。

### 必要な作業
1. `server/relay.mjs` — Node + `ws` で WS→TCP 素通しリレー (済: スケルトン)
2. wasm クライアントのリンクフラグに `-sSOCKET_WEBSOCKET_URL` 相当の設定
   (`Module['websocket']['url']` を `web/index.html` で設定可能にする)
3. ネイティブ YSFLIGHT サーバを同一ホストで起動 (`main_consvr` ターゲット)

## Phase 2: WebRTC DataChannel (P2P / 低遅延 UDP 相当)

飛行状態の同期は本来 UDP 向き。WebRTC DataChannel
(unordered / maxRetransmits=0) で UDP 相当の特性が得られる。

- シグナリングサーバ (Node, WebSocket) でロビーとSDP交換を提供
- ホストプレイヤーのブラウザが「サーバ」になる P2P トポロジ、
  もしくは SFU 的な中継サーバ
- `fsnetwork` の transport 層を抽象化し、`yssocket` 実装と
  `WebRTC DataChannel` 実装 (JSライブラリ経由、EM_JS バインディング) を差し替え可能にする

Phase 2 は transport 抽象化のリファクタリングが必要なため、
Phase 1 を動かしてから着手する。

## 状態同期に関するメモ

- YSFLIGHT は 状態スナップショット + イベント型のメッセージを混在送信する
- ティックレートはサーバ側設定 (`fsconsole` 参照)
- ブラウザのタブ非アクティブ時は requestAnimationFrame が止まるため、
  クライアントは setTimeout フォールバック (emscripten main loop の
  `emscripten_set_main_loop_timing`) を検討すること
