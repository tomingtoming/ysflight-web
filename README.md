# ysflight-web

**YS FLIGHT SIMULATOR をWebブラウザで** — [captainys/YSFLIGHT](https://github.com/captainys/YSFLIGHT) の
WebAssembly (Emscripten) 移植です。

YSFLIGHT web is a WebAssembly port of Soji Yamakawa (CaptainYS)'s
[YS FLIGHT SIMULATOR](https://ysflight.org), runnable in any modern browser
with WebGL — no installation required.

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

Cloudflare Pages の Git integration で repository を接続し、Build settings を
以下にしてください。

- Build command: `scripts/build.sh`
- Build output directory: `dist`

Cloudflare Pages の build image には Emscripten が入っていないため、
`scripts/build.sh` は `emcmake` が見つからない場合に `emsdk` を
`$HOME/opt/emsdk` へ自動インストールします。固定したい場合は環境変数
`EMSDK_VERSION` を設定してください (既定: `6.0.0`)。

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
DataChannel の P2P で直結し、公開 STUN (Google) で NAT を越えます。ホストの
ブラウザがサーバ権威です (web 版はチャット・ポート設定なし、P2P/Room ID のみ)。

シグナリング (SDP/ICE 交換のみ。ゲームデータは流れない) は、サイト自身の
`/signal` エンドポイント = **Cloudflare Worker + Durable Object**
(`worker/signal.js`) が担います。配信元と同一オリジンの `wss://` なので、別途
シグナリングサーバを立てる必要も、TLS 証明書や mixed-content の調整も不要です。
`?signal=wss://...` で上書き、`?room=` でルームコード固定、`?join=` で参加先指定も可。

詳細は [docs/multiplayer.md](docs/multiplayer.md)。

> **NAT 越え**: 多くの家庭回線同士なら STUN だけで直結します。両者がモバイル /
> CGNAT / 対称NAT (例: Starlink の IPv4) だと直結できず TURN が必要ですが、TURN
> は現状未導入です (将来対応)。両者が IPv6 で繋がれば直結できることが多いです。

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
