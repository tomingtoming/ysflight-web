# ysflight-web マルチプレイ設計 (Multiplayer Design)

## 概要

ブラウザ同士の **WebRTC DataChannel による P2P 対戦**。1人のブラウザがホスト
(YSFLIGHT のサーバモード = 権威) になり、他のブラウザがルームコードで参加する。
ゲームデータは P2P で直結し、公開 STUN で NAT を越える。専用サーバの運用は不要で、
シグナリングだけを Cloudflare Worker + Durable Object が担う。

> **✅ P2P 対戦は動作確認済み (2026-06-12)**
> ブラウザA (サーバモード) + ブラウザB (Room ID で接続) の2ページ構成で、
> ログオン → ロビー → 飛行参加まで E2E 検証。ゲームデータは DataChannel で直結。

```
[browser host (server mode)] <--- WebRTC DataChannel (P2P) ---> [browser client]
              \                                                 /
               +------ /signal (Cloudflare Worker + DO) -------+
                        SDP/ICE 交換のみ。ゲームデータは流れない
```

## 背景: YSFLIGHT 既存ネットコード

YSFLIGHT は TCP ベースの client-server マルチプレイを持つ
(`fsnetwork*` / `fssocketserver` / `fssocketclient`、独自バイナリプロトコル
`NETVERSION`)。ブラウザは生 TCP を張れないため、本プロジェクトでは **WebRTC
DataChannel を「ソケットの代わり」に使い、1つのブラウザをサーバ役にする** ことで、
サーバ運用なしの P2P 対戦を実現している。

> かつてはネイティブ YSFLIGHT サーバへ WebSocket→TCP でブリッジする経路
> (`server/relay.mjs`) もあったが、別途ネイティブサーバの運用が要り相互運用も
> 限定的だったため廃止し、P2P 一本に集約した。

## シグナリング: Cloudflare Worker + Durable Object

`worker/signal.js`。配信サイトと同一オリジンの `/signal` で WebSocket を受け、
単一のハブ Durable Object (`SignalHub`) が room ごとに host / peers の接続を保持して
SDP/ICE を中継する (旧 `server/signal.mjs` の置き換え)。ゲームデータは一切通らない。

- **同一オリジン wss://** なので、https 配信でもブラウザの mixed-content 制限に
  かからず、TLS 証明書や Cloudflare Tunnel の準備も不要。
- Durable Object は **SQLite クラス**として宣言 (`new_sqlite_classes`) ＝ Workers
  Free プランで利用可。ストレージ未使用・接続中のみ常駐するため、単一ハブでも無料枠
  (リクエスト 100k/日、計算 13,000 GB秒/日) に収まる。
- クライアントは既定で `wss://<配信ホスト>/signal` に接続する (`web/index.html`)。
  `?signal=wss://...` で上書き可。

### プロトコル (client ⇄ /signal)

JSON メッセージ。`worker/signal.js` と wasm 側
(`src/port/yssocket/yssocket_emscripten.cpp`) で形を一致させている。

| 向き | メッセージ |
|---|---|
| host → | `{t:'host', room}` / `{t:'sdp'\|'ice', peer, data}` |
| → host | `{t:'host-ok', room}` / `{t:'host-taken'}` / `{t:'peer', peer}` / `{t:'sdp'\|'ice', peer, data}` / `{t:'peer-left', peer}` |
| peer → | `{t:'join', room}` / `{t:'sdp'\|'ice', data}` (peer は付けない=サーバが接続から推定) |
| → peer | `{t:'no-room'}` / `{t:'join-ok', peer}` / `{t:'sdp'\|'ice', peer, data}` / `{t:'host-left'}` |

確立後はゲームデータが P2P (DataChannel) で流れ、シグナリングは新規参加・追加
ICE・切断通知のみに使われる。

## NAT 越え / STUN・TURN

- 既定の ICE 設定は公開 STUN (`stun:stun.l.google.com:19302`) のみ。
- 多くの家庭回線 (cone NAT) 同士、または両者 IPv6 なら STUN だけで直結できる。
- 両者がモバイル / CGNAT / 対称NAT (例: Starlink の IPv4) の場合は直結できず
  **TURN** が必要になるが、**現状 TURN は未導入** (将来対応)。
- 接続が中継 (relay) になったかは `RTCPeerConnection.getStats()` の選択候補ペアの
  `candidateType` で判定できる (将来 UI 表示予定)。

## 動かし方

### 本番 (Cloudflare)

`scripts/build.sh` で `dist/` を生成 → Cloudflare Workers Builds が
`worker/signal.js` と `dist/` をデプロイ。利用者は配信 URL を開き、ゲーム内
ホストはメニュー右上の「📋 招待リンクをコピー」で招待 URL を取得して共有
(Room ID は 8 桁数字を自動採番)。参加者は招待リンク (`?join=12345678`) を開いて
名前を入力すれば自動参加、またはゲーム内ネットワーク→クライアントの「Room ID」欄に
8 桁を入力する。Room ID 表示と招待ボタンはメニュー時のみ表示し、飛行中は隠れる。
メニュー左上の接続バッジで P2P 可否 (直結 / 対称NAT) を事前確認できる。

web 版ではチャットとサーバポート設定は無効化されている (P2P / Room ID のみ)。
互換性のため NET-VERSION は `20260617` に更新済み (旧来のネイティブ版とは接続不可)。

### ローカル

```sh
scripts/build.sh        # dist/ を生成
npx wrangler dev        # /signal(Worker+DO) + dist/ を http://localhost:8787 で提供
# 2タブで開く: 一方で「サーバ開始」、もう一方は招待リンク or Room ID(8桁) を入力
```

ローカルは http なので既定で `ws://localhost:8787/signal` が使われる (ブラウザは
localhost の ws:// を許可する)。

## 今後

- **TURN 連携**: モバイル / CGNAT / 対称NAT 同士でも繋がるように。Cloudflare
  Realtime TURN か coturn を外部に置き、Worker で短命クレデンシャルを発行する形
  (静的な長期クレデンシャルは配らない)。
- **接続診断**: 事前に STUN で直結可否を推定 (cone/symmetric・IPv6 有無)、接続後は
  `getStats()` で「直接 / 中継経由」をバッジ表示。
