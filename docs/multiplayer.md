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
- **https で配信されたページ (Cloudflare Pages 等) からは `wss://` しか張れない**
  (mixed content 制限。`?signal=ws://192.168.x.x:7917` は別PCからブロックされる)。
  対処は次のいずれか:
  1. **Cloudflare Tunnel (推奨・無料)**: シグナリングを動かすマシンで
     `cloudflared tunnel --url http://localhost:7917` を実行すると
     `https://xxxx.trycloudflare.com` が発行される。これをそのまま
     `?signal=wss://xxxx.trycloudflare.com` に指定 (WebSocket対応・TLS付き)
  2. `signal.mjs --cert fullchain.pem --key privkey.pem` で直接TLS
     (正規の証明書が必要。自己署名はブラウザに拒否される)
  3. **LAN内だけなら http 配信を使う**: ホスト機で `npx serve dist` し、
     全員 `http://192.168.x.x:3000/?signal=ws://192.168.x.x:7917` で開く
     (httpページからは ws:// が使える)
- コンソールサーバの対話メニューは glibc の getchar() sticky-EOF の影響で
  パイプ経由では操作不能。`-server Name FIELD` のCLI起動を使う。
- Emscripten のソケットは `Module['websocket']['url']` で接続先WebSocketを
  上書きできる (web/index.html では `?server=` クエリで指定)。

## Phase 2: WebRTC DataChannel (ブラウザホスト)

> **✅ Phase 2 動作確認済み (2026-06-12)**
> ブラウザA (サーバモード) + ブラウザB (#ルームコードで接続) の
> 2ページ構成で、ログオン → ロビー → 飛行参加まで E2E 検証。
> ゲームデータは WebRTC DataChannel で P2P 直結。

```
[browser host] <--DataChannel(P2P)--> [browser client]
       \                                  /
        +---- signal.mjs (SDP/ICE交換のみ) ----+
```

- `yssocket` の Emscripten 実装 (`src/port/yssocket/yssocket_emscripten.cpp`) が
  `YsSocketServer` を WebRTC DataChannel 上に実装。**ゲーム本体は無改造**
- DataChannel は ordered/reliable (TCP相当)。ゲームデータはシグナリング
  サーバを経由しない
- ICE: STUN (stun.l.google.com) のみ。対称NAT同士などでは繋がらない場合あり
  (TURN は未実装)

### 使い方

```sh
# シグナリングサーバ (どこか1箇所で稼働させる; ゲームデータは流れない)
cd server && npm install
node signal.mjs                 # ws://host:7917 (https配信なら --cert/--key で wss)

# ホスト (ブラウザ)
https://.../?signal=wss://シグナリングホスト:7917
→ ネットワークメニューから「サーバ開始」→ 画面右上に Room: #ABC123 が出る
  (?room=好きなコード で固定も可)

# クライアント (ブラウザ)
https://.../?signal=wss://シグナリングホスト:7917
→ ネットワーク接続のサーバアドレス欄に #ABC123 を入力
  (または ?client=名前,%23ABC123 で自動接続)
```

接続先アドレスが `#...` / `rtc:...` なら WebRTC、通常のホスト名/IPなら
従来の WebSocket リレー (Phase 1) が選ばれる。

## 状態同期に関するメモ

- YSFLIGHT は 状態スナップショット + イベント型のメッセージを混在送信する
- ティックレートはサーバ側設定 (`fsconsole` 参照)
- ブラウザのタブ非アクティブ時は requestAnimationFrame が止まるため、
  クライアントは setTimeout フォールバック (emscripten main loop の
  `emscripten_set_main_loop_timing`) を検討すること
