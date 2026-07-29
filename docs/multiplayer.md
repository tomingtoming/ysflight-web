# ysflight-web マルチプレイ設計 (Multiplayer Design)

## 概要

ブラウザ同士の **WebRTC DataChannel による P2P 対戦**。1人のブラウザがホスト
(YSFLIGHT のサーバモード = 権威) になり、他のブラウザがルームコードで参加する。
ゲームデータは P2P で直結し、公開 STUN で NAT を越える。専用サーバの運用は不要で、
シグナリングだけを Cloudflare Worker + Durable Object が担う。

> **✅ P2P 対戦は動作確認済み (2026-06-12)**
> ブラウザA (サーバモード) + ブラウザB (Room ID で接続) の2ページ構成で、
> ログオン → ロビー → 飛行参加まで E2E 検証。ゲームデータは DataChannel で直結。

> **v1 ステータス（2026-06-27）**: ゲーム対戦の P2P トランスポート（本書の主題）は v1 で稼働中。
> ただし**追加パックのホスト→クライアント自動配信は v1 ではスコープ外＝既定 OFF**（`MP_PACK_SYNC`、
> `?packsync=1` で再有効。commit `ae6fb81`）。v1 は原典同様の **vanilla 契約**（各プレイヤーが同じ
> パックを事前にローカル導入）で、joiner は base ＋自分のパックだけで即接続する。本書中の「パック同期
> channel」記述（NAT/TURN 節の `pack-net.js` 等）はこの v2 先送りの配信機構を指す。配信状況の詳細は
> [addon-packs.md](addon-packs.md) §5、現状仕様の通しは [overview.md](overview.md)。

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
| host → | `{t:'host', room, token?}` / `{t:'sdp'\|'ice', peer, data}` |
| → host | `{t:'host-ok', room}` / `{t:'host-taken'}` / `{t:'peer', peer}` / `{t:'sdp'\|'ice', peer, data}` / `{t:'peer-left', peer}` |
| peer → | `{t:'join', room}` / `{t:'sdp'\|'ice', data}` (peer は付けない=サーバが接続から推定) |
| → peer | `{t:'no-room'}` / `{t:'join-ok', peer}` / `{t:'sdp'\|'ice', peer, data}` / `{t:'host-left'}` |
| ハブ → 全員 | `{t:'ping'}` (サーバ主導 keep-alive。クライアントは無視してよい) |

確立後はゲームデータが P2P (DataChannel) で流れ、シグナリングは新規参加・追加
ICE・切断通知のみに使われる。

### ホスト切断への耐性 (grace / reclaim / keepalive)

ホストのシグナリング WebSocket は、タブがバックグラウンドになるとブラウザの
タイマースロットリングで 25 秒間隔の keep-alive ping が 60 秒以上に間延びし、
アイドル切断されることがある。これが従来「ホストは無事なのに招待リンクが
no-room で繋がらない」の主因だった。対策は 3 段構え (`worker/signal.js`):

1. **サーバ主導 keep-alive**: ハブが全接続へ 30 秒ごとに `{t:'ping'}` を送る。
   サーバ側のタイマーはタブのスロットリングと無関係なので、バックグラウンドの
   ホストでもソケット (＝room) が生き続ける。
2. **ホスト喪失 grace (90秒)**: それでもホストのソケットが切れた場合、room を
   即削除せず 90 秒間「ホスト不在」のまま保持する。この間の `join` は受理して
   保留 (join-ok は即返す) し、ホストが同じ `token` で再接続 (reclaim) した瞬間に
   保留中の `{t:'peer', peer}` をまとめて流す。参加者はリトライ不要で接続に進む。
3. **ホスト不在 room の乗っ取り (takeover)**: grace 中に別 token の `{t:'host'}`
   が来た場合は「ホストがページをリロードした」ケース (URL に `?room=` が固定
   されるので room コードは同じ・token は新規) として乗っ取りを許可する。旧
   ホストと接続済みだった peer には `host-left` を送り、保留中の joiner は新
   ホストへ引き渡す。ホストが生きている room への別 token は従来どおり
   `host-taken`。

grace が切れても reclaim が無ければ room は削除され、peer へ `host-left`、以後の
join は `no-room` (従来挙動)。時間は env `SIGNAL_GRACE_MS` / `SIGNAL_KEEPALIVE_MS`
で上書き可 (テスト用)。契約は `scripts/smoke-mp-reconnect.mjs` が検証し、
`scripts/sig-stub.mjs` (テスト用 Node ミラー) も同じ挙動を実装する。

## NAT 越え / STUN・TURN

- ICE 設定は Worker の `/turn` が配る **Cloudflare Realtime TURN** の iceServers
  (STUN + TURN リレー)。`/turn` が未設定/到達不能なら公開 STUN
  (`stun:stun.l.google.com:19302`) 一本にフォールバックする。
- 多くの家庭回線 (cone NAT) 同士、または両者 IPv6 なら STUN だけで直結できる。
- 両者がモバイル / CGNAT / 対称NAT (例: Starlink の IPv4) で直結できない場合は
  **TURN リレー経由**で接続する (直結できるペアは従来どおり P2P 直結のまま)。
- ゲーム channel (`yssocket`) とパック同期 channel (`pack-net.js`) の両方に同じ
  iceServers を流す。`web/index.html` が起動時に `/turn` を取得し、
  `Module.ysfwIceServers` (engine) と `window.ysfwPackIce` (pack) にセットする。
- `?turn=0` で STUN 一本に強制できる (TURN 無し時の挙動の再現用)。
- 接続が中継 (relay) になったかは `RTCPeerConnection.getStats()` の選択候補ペアの
  `candidateType` で判定できる (将来 UI 表示予定)。

## 動かし方

### 本番 (Cloudflare)

`scripts/build.sh` で `dist/` を生成 → Cloudflare Workers Builds が
`worker/signal.js` と `dist/` をデプロイ。ホストはトップページの
「友達と対戦したい？（ホストを立てる）」フォームから名前を入れて開始する
(＝`?host=1&name=` ディープリンク。エンジンが `-server` で直接サーバモード起動、
web-shell 増分6。docs/web-shell.md)。ホストが立つと Room ID と「📋 招待リンクを
コピー」ボタンが出る (Room ID は 8 桁数字を自動採番、`?room=` で固定可)。
参加者は招待リンク (`?join=12345678`) を開いて名前を入力すれば自動参加、
またはトップページの「Room ID で参加」フォームに 8 桁を入力する。

画面の右上 UI は 3 状態 (engine の `ChangeRunMode` が `globalThis.ysfwInFlight`
を、ホスト中は `globalThis.ysfwRtc.host` をセットし、`web/index.html` がそれを見て切替):

- **メニュー画面** (飛行前): 接続バッジのみ
- **ホスト中** (自分がサーバ): Room ID 表示 ＋ 招待リンクコピーボタン
- **飛行中** (ホスト以外＝クライアント/通常飛行): いずれも非表示

接続バッジは公開 STUN で P2P 可否 (直結 / 対称NAT) を事前確認できる。

web 版ではチャットとサーバポート設定は無効化されている (P2P / Room ID のみ)。
互換性のため NET-VERSION は `20260617` に更新済み (旧来のネイティブ版とは接続不可)。

### NAT 越えと TURN (Cloudflare Realtime TURN)

直結できないペア (対称NAT / CGNAT / モバイル同士など) のフォールバックとして
**Cloudflare Realtime TURN** を導入済み。直結できるペアは従来どおり P2P 直結で、
TURN は繋がらないときだけ中継に使われる。メニューの接続バッジが「🟡 一部の相手と
繋がらないかも」のときが自分側の対称NAT。

- **配信**: Worker の `/turn` (`worker/signal.js`) が Cloudflare の
  `POST /v1/turn/keys/{KEY_ID}/credentials/generate-ice-servers` を叩いて短命
  (TTL 4h) の iceServers を返す。長期クレデンシャルは配らない。
- **悪用対策** (公開エンドポイント × 中継は従量課金、なので必須): `/turn` は
  **POST 限定** (GET は 405)・**Origin ヘッダがある場合は同一オリジンのみ** (他サイトの
  ページからは 403。Origin を送らない非ブラウザは次のレート制限側で受ける)・
  **IP ごとレート制限 10回/分** (`wrangler.jsonc` の `TURN_RATE` ratelimit binding、
  超過は 429)。クライアントの取得はページ読込ごとに 1 回なので正規プレイには余裕。
  TTL 4h は「そのページ読込から始まる長めのプレイセッション」は覆いつつ、漏れた
  クレデンシャルの寿命を 1 日→半日未満に縮める。TTL 失効後に接続を試みた場合は
  TURN allocate が失敗して STUN 一本に劣化するだけ (未設定時 204 と同じ挙動)。
- **クライアント**: `web/index.html` が起動時に `/turn` を取得し、engine
  (`Module.ysfwIceServers` → `yssocket` の `R.iceServers()`) とパック同期
  (`window.ysfwPackIce` → `pack-net.js`) の両 channel に流す。
- **セットアップ (要 Cloudflare アカウント設定)**:
  1. ダッシュボード → Realtime → TURN で TURN key を作成し、KEY ID と API トークンを取得
  2. Worker に secret を登録:
     `wrangler secret put TURN_KEY_ID` / `wrangler secret put TURN_API_TOKEN`
  3. 未設定時は `/turn` が 204 を返し、クライアントは自動で STUN 一本に戻る
- **運用/金銭**: TURN は実トラフィックを中継するため帯域課金が発生する
  (Cloudflare Realtime TURN の GB 単価)。直結できるペアは中継しないので、課金は
  直結不可ペアのフォールバック分のみ。
- **接続タイムアウト**: `jsCliConnect` は 20s で ICE 未確立なら接続失敗を可視化する
  (旧来の「機体リスト空のまま無言ハング」を解消)。

### ローカル

```sh
scripts/build.sh        # dist/ を生成
npx wrangler dev        # /signal(Worker+DO) + dist/ を http://localhost:8787 で提供
# 2タブで開く: 一方で「サーバ開始」、もう一方は招待リンク or Room ID(8桁) を入力
```

ローカルは http なので既定で `ws://localhost:8787/signal` が使われる (ブラウザは
localhost の ws:// を許可する)。

## 今後

- ~~**TURN 連携**~~ 導入済み: Cloudflare Realtime TURN を Worker の `/turn` から
  短命クレデンシャルで配信し、直結できないペアのフォールバックにする。上の
  「NAT 越えと TURN」を参照。
- **接続診断**: 事前に STUN で直結可否を推定 (cone/symmetric・IPv6 有無)、接続後は
  `getStats()` で「直接 / 中継経由」をバッジ表示。
