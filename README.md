# ysflight-web

**YS FLIGHT SIMULATOR をWebブラウザで** — [captainys/YSFLIGHT](https://github.com/captainys/YSFLIGHT) の
WebAssembly (Emscripten) 移植です。

YSFLIGHT web is a WebAssembly port of Soji Yamakawa (CaptainYS)'s
[YS FLIGHT SIMULATOR](https://ysflight.org), runnable in any modern browser
with WebGL — no installation required.

**▶ プレイ / Play: https://ysflight-web.toming.app**

## 構成 / Architecture

```
upstream/YSFLIGHT   tomingtoming/YSFLIGHT の emscripten ブランチ (captainys/YSFLIGHT のフォーク)
upstream/public     tomingtoming/public  の emscripten ブランチ (captainys/public のフォーク)
src/port/           本リポジトリで新規に書いたプラットフォーム層
  fssimplewindow/     Emscripten backend (WebGL context, DOM input events, timers)
  fslazywindow/       emscripten_set_main_loop driver
web/                index.html シェル (ローディングUI, IDBFS永続化, 言語設定)
worker/             WebRTC シグナリング (Cloudflare Worker + Durable Object)
scripts/            build.sh / smoke-test.sh / serve.mjs
docs/               設計ドキュメント (multiplayer.md ほか)
```

上流への変更は、フォークの `emscripten` ブランチ上に**テーマ別の通常コミット**
として管理しています (旧方式の `patches/*.patch` は廃止)。上流との差分は

```sh
git -C upstream/YSFLIGHT log --oneline master..emscripten
git -C upstream/public   log --oneline master..emscripten
```

で一覧でき、上流が更新されたら `git fetch upstream && git rebase upstream/master`
で追従します。上流にPR可能な純粋バグ修正 (例: ysgl のsampler uniformバグ) は
独立コミットとして分離してあり、そのまま cherry-pick して提案できます。

技術的な要点:

- 描画は YSFLIGHT 既存の **OpenGL ES 2.0 バックエンド** (`graphics/gl2.0`, Android移植用)
  をそのまま WebGL 1.0 で使用 (`-sFULL_ES2`)
- メインループは `fslazywindow` のコールバック構造を `requestAnimationFrame` に接続
- ゲームデータ (`runtime/`, 約25MB) は `--preload-file` で `.data` にパッケージ
- ユーザ設定 (`/home/web_user/Documents`) は **IndexedDB (IDBFS)** で永続化
- **シミュレーションは単一スレッド実行** — `-pthread` を使うと (`-sPROXY_TO_PTHREAD`
  無しでは) `main()` とメインループがブラウザのメインスレッド上で動き、`YsThreadPool`
  がワーカー完了を `condition_variable` で待ってメインスレッドをブロックする。ワーカーが
  遅延・停止するとページ全体が凍結する (rAF 停止) ため、Web では単一スレッドで実行する。
  これにより SharedArrayBuffer / COOP+COEP は不要 (再有効化には
  `-sPROXY_TO_PTHREAD` + OffscreenCanvas が必要)
- **PWA**: Service Worker によるオフラインプレイ・2回目以降の即時起動。
  アセットはコンテンツハッシュ付きファイル名で配信されるため、
  更新時のキャッシュ問題なし (`_headers` で immutable キャッシュ指定)
- **バックグラウンドタブ対応**: タブ非表示中も Web Worker 駆動で
  シミュレーションが継続 (マルチプレイ中の切断を防止。描画はスキップ)

## ビルド / Build

必要なもの: [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html), CMake 3.20+, Node.js

```sh
git clone --recursive git@github.com:tomingtoming/ysflight-web.git
cd ysflight-web
scripts/build.sh           # パッチ適用 → emcmake configure → build → dist/ に出力
node scripts/serve.mjs     # dist/ をローカル配信 (素の静的配信。COOP/COEP 不要)
```

`dist/` の中身 (`index.html` + `ysflight32_gl2.{js,wasm,data}`) を
そのまま静的ホスティングに置けば動きます。

### スモークテスト / Smoke test

```sh
scripts/smoke-test.sh            # default(ソフトウェアGPU) + strict(実GPU/Mesa GL)
```

`strict` はシステムの Chrome を **headed** で起動し、ネイティブ Mesa GL
(`--use-angle=gl`) 上でブートを検証します。実ドライバは mediump を fp16 に
降格するため、ソフトウェアラスタライザでは検出できないシェーダの
精度不一致リンクエラーを push 前に捕捉できます (要ディスプレイ +
google-chrome)。CI では `default` のみ実行されます。
**レンダラ周りを変更したら push 前に必ず実行してください。**

## デプロイ / Deploy

本番 URL は **https://ysflight-web.toming.app**（Cloudflare Workers のカスタムドメイン）。

本番は **Cloudflare Workers**（設定は `wrangler.jsonc`）。Worker 本体は
`worker/signal.js`（`/signal` の WebRTC シグナリング＝Durable Object `SignalHub`）で、
ゲーム本体（`dist/`）は同じ Worker から **Workers Static Assets**
（`assets.directory: ./dist`）として配信されます。**Pages ではありません**
（旧 Pages 運用からの移行済み）。

**Workers Builds**（Worker の Git integration）で repository を接続し、Build
settings を以下に：

- Build command: `scripts/build.sh`
- Deploy command（production ブランチ）: `npx wrangler deploy`
- Deploy command（非production ブランチ＝プレビュー）: `npx wrangler versions upload`

Cloudflare の build image には Emscripten が入っていないため、`scripts/build.sh`
は `emcmake` が見つからない場合に `emsdk` を `$HOME/opt/emsdk` へ自動インストール
します（CMake も同様に自前取得）。固定したい場合は環境変数 `EMSDK_VERSION`
（既定: `6.0.0`）。YSFLIGHT を wasm にフルコンパイルするのでビルドは数分かかります。

> **CI とデプロイは別系統**。GitHub Actions（[`.github/workflows/build.yml`](.github/workflows/build.yml)）は
> push / PR で `scripts/build.sh` → unit + シグナリング/ブラウザ smoke を回す
> **ビルド＋テスト専用**で、デプロイはしません。本番への反映は上記 **Cloudflare Workers
> Builds が main への push を契機に自動実行**します（GitHub 側に `wrangler deploy`
> ステップは無い）。手動デプロイは接続先アカウントの認証で `npx wrangler deploy`。
> `wrangler deployments list` に出る Author は接続先 Cloudflare アカウント
> （現状 `<cloudflare-account-email>`＝**オーナー本人の別アカウント**。リポジトリの
> コミッタ `tomingtoming` とメールが違うが誤設定ではない）、Source は
> `Unknown (deployment)` と表示されます。

### PR プレビュー URL

非production ブランチ（PR）のビルドは `wrangler versions upload` で**プレビュー版**
を作り、各バージョンに次の形のプレビュー URL が割り当たります：

```
https://<version-prefix>-ysflight-web.<subdomain>.workers.dev
```

（`<version-prefix>` はバージョン ID の先頭 8 桁。**前提**＝Worker の Preview URLs が
有効。dashboard → Workers & Pages → `ysflight-web` → Settings → Domains & Routes
（UI 版により Triggers 配下）→ **Preview URLs**、`*.workers.dev` サブドメインも有効。）

**URL の探し方**——**Workers Builds は Pages と違い、このURLを PR にコメントしません**。
次のどちらかで確認します：

- ビルドログ末尾の `Version Preview URL:` 行（Workers Builds のチェックのリンク先）
- dashboard の **デプロイ（Deployments）タブ** → 各バージョンのプレビュー URL リンク

GitHub の PR に付くのは pass/fail の「Workers Builds」チェック1個だけです。

> 注意: プレビュー URL が割り当たるのは **Preview URLs を有効化した後**にアップした
> バージョンだけ。有効化前のビルドのプレビュー URL は 404 になります（その場合は再ビルド
> すれば付きます）。

### デプロイ状況の確認 / Verifying a live deploy

main への push 後、Workers Builds が wasm フルビルドを回すので反映まで数分かかります。
実際に本番へ載ったかは次で確認します（`deployments list` の Message は常に `-`＝git SHA は
記録されないので、**どのコミットが載っているかは中身を突き合わせる**のが確実）：

- `npx wrangler deployments status` … アクティブな version とその作成時刻
- `npx wrangler deployments list` … 履歴（Author = 接続アカウント、Message `-`）
- **静的アセット**: `curl -s https://ysflight-web.toming.app/pack-net.js` を取得し、手元の
  `web/pack-net.js`（`dist/<file>` はそのコピー）と `diff` ＝バイト一致なら反映済み
- **Worker（`/signal`）**: アセットと同じ `wrangler deploy` で**原子的に同時更新**される
  （1 コミット = `worker/signal.js` ＋ `dist/` を一括）。挙動で確かめるなら
  `wss://ysflight-web.toming.app/signal` に `{t:'host',room,manifest}` を送って `host-ok`
  応答を見る（ルームは in-memory・切断で消える）

GitHub Pages は repository settings の Pages で無効化してください。

## 操作 / Controls

本家YSFLIGHTと同じキーボード操作です (矢印キー: 操縦桿, Q/A: スロットル,
Z/X: ラダー, G: ギア, Space: 機銃, etc.)。メニューから Simulation → Create Flight で
フライト開始。本家同様、ジョイスティック未接続時は**マウスが操縦桿**として機能します
(画面中心がニュートラル)。

**ゲームパッド/ジョイスティック対応** (Gamepad API): 接続して何かボタンを押すと
ブラウザがパッドを公開し、ゲームから利用可能になります (Gamepad API の仕様)。
軸・ボタンの割り当ては Option → Config Key/Mouse/Joystick Assignment で変更可能。
standardマッピングのD-padはPOVハットとして扱われます。

## マルチプレイ / Multiplayer

ブラウザ同士の **WebRTC P2P** で対戦します。1人が「サーバ開始」でホストになり
(画面右上に `Room: 12345678` の 8 桁数字を表示)、他の参加者は招待リンク
(`?join=12345678`) を開いて名前を入力すれば自動参加、またはネットワーク→
クライアントの「Room ID」欄に 8 桁を入力して参加。ゲームデータは WebRTC
DataChannel の P2P で直結し、NAT 越えは Cloudflare Realtime TURN
(STUN + 直結不可ペア向けの TURN リレー) を Worker の `/turn` から配信します。
ホストのブラウザがサーバ権威です (web 版はチャット・ポート設定なし、P2P/Room ID のみ)。

シグナリング (SDP/ICE 交換のみ。ゲームデータは流れない) は、サイト自身の
`/signal` エンドポイント = **Cloudflare Worker + Durable Object**
(`worker/signal.js`) が担います。配信元と同一オリジンの `wss://` なので、別途
シグナリングサーバを立てる必要も、TLS 証明書や mixed-content の調整も不要です。
`?signal=wss://...` で上書き、`?room=` でルームコード固定、`?join=` で参加先指定も可。

詳細は [docs/multiplayer.md](docs/multiplayer.md)。

> **NAT 越え / 接続性**: 多くの家庭回線同士なら STUN だけで直結します。両者が
> ともにモバイル / CGNAT / 対称NAT (例: Starlink の IPv4) で直結できない場合は
> **Cloudflare Realtime TURN** リレー経由で接続します (Worker の `/turn` が短命
> クレデンシャルを配信。未設定時は STUN 一本にフォールバック)。メニューの接続バッジで
> 自分側が直結可能かを事前確認できます。両者が IPv6 なら直結できることが多いです。
> 設定・コストは [docs/multiplayer.md](docs/multiplayer.md) を参照。

## 既知の制限 / Known limitations

- サウンドは OpenAL (Web Audio) 実装済み。ATC音声(ボイス)は未実装
- 日本語UI対応済み (Canvas 2D によるシステムフォント描画)。
  言語はブラウザのロケールから自動選択、`?lang=ja` / `?lang=en` で強制可能
- クリップボード・IME 未対応
- シミュレーションは単一スレッド実行 (Web のメインスレッドをブロックしないため)。
  ネイティブのような並列シミュレーションは行わない

## License

- 上流 YSFLIGHT のソースコードとランタイムデータ: 3-clause BSD (`upstream/YSFLIGHT/LICENSE`)
- 上流 public ライブラリ群: 各ソースファイルヘッダに記載の 2-clause BSD
- 本リポジトリの追加コード (`src/port`, `web`, `server`, `scripts`, `patches`):
  同じく 2-clause BSD ライセンス

YS FLIGHT SIMULATOR is (c) Soji Yamakawa (CaptainYS, http://www.ysflight.com).
This is an unofficial community port.
