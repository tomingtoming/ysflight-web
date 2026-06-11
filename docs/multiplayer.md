# ysflight-web マルチプレイ設計 (Multiplayer Design)

## 背景: YSFLIGHT 既存ネットコード

YSFLIGHT には TCP ベースのマルチプレイ実装が既にある
(`upstream/YSFLIGHT/src/core` の `fsnetwork*` / `fssocketserver` / `fssocketclient`、
既定ポート 7915、独自バイナリプロトコル `NETVERSION`)。
サーバ・クライアントとも `yssocket` (BSD ソケット) 上に実装されている。

ブラウザは生の TCP を張れないため、次の2段階で対応する。

> **✅ Phase 1 は動作確認済み (2026-06-11)**
> ネイティブ console server (Atsugi) + `relay.mjs` + wasm クライアントの構成で、
> ログイン → 機体選択 (F/A-18E) → Join → 離陸までを headless Chromium で E2E 検証。
> サーバログ: `User WebPilot logged on.` / `WebPilot took off (F-18E_SUPERHORNET)`

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

### 実行手順 (検証済み)

```sh
# 1. ネイティブのコンソールサーバをビルドして起動 (port 7915)
#    要: build-essential, libglu1-mesa-dev (GL/X11ヘッダ)
cmake -S upstream/YSFLIGHT/src -B build-native -DCMAKE_BUILD_TYPE=Release
cmake --build build-native --target ysflight64_nownd -j
cd build-native/main_consvr
./ysflight64_nownd -server ServerName ATSUGI_AIRBASE

# 2. WS→TCP リレーを起動 (port 7916)
cd server && npm install
node relay.mjs --listen 7916 --target 127.0.0.1:7915

# 3. ブラウザでクライアントを開く
#    http://localhost:8000/?client=YourName&server=ws://localhost:7916
#    (Networkメニューから手動接続でも可)
```

### 注意点
- **https で配信されたページ (GitHub Pages 等) からは `wss://` しか張れない**
  (mixed content 制限)。リモート公開時は `relay.mjs --cert/--key` でTLSを
  有効にするか、Caddy/nginx 等のTLS終端の背後に置くこと。
- コンソールサーバの対話メニューは glibc の getchar() sticky-EOF の影響で
  パイプ経由では操作不能。`-server Name FIELD` のCLI起動を使う。
- Emscripten のソケットは `Module['websocket']['url']` で接続先WebSocketを
  上書きできる (web/index.html では `?server=` クエリで指定)。

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
