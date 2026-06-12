# ysflight-web

**YS FLIGHT SIMULATOR をWebブラウザで** — [captainys/YSFLIGHT](https://github.com/captainys/YSFLIGHT) の
WebAssembly (Emscripten) 移植です。

YSFLIGHT web is a WebAssembly port of Soji Yamakawa (CaptainYS)'s
[YS FLIGHT SIMULATOR](https://ysflight.org), runnable in any modern browser
with WebGL — no installation required.

## 構成 / Architecture

```
upstream/YSFLIGHT   captainys/YSFLIGHT (submodule, BSD-licensed sources + runtime data)
upstream/public     captainys/public   (submodule, ysclass/fssimplewindow/ysgl などの共通ライブラリ)
patches/            上流に当てる最小限のEmscripten対応パッチ (CMake分岐・GLESヘッダ選択など)
src/port/           本リポジトリで新規に書いたプラットフォーム層
  fssimplewindow/     Emscripten backend (WebGL context, DOM input events, timers)
  fslazywindow/       emscripten_set_main_loop driver
web/                index.html シェル (ローディングUI, IDBFS永続化, 言語設定)
server/             マルチプレイ用 WebSocket→TCP リレー (Phase 1)
scripts/            build.sh / apply-patches.sh
docs/               設計ドキュメント (multiplayer.md ほか)
```

技術的な要点:

- 描画は YSFLIGHT 既存の **OpenGL ES 2.0 バックエンド** (`graphics/gl2.0`, Android移植用)
  をそのまま WebGL 1.0 で使用 (`-sFULL_ES2`)
- メインループは `fslazywindow` のコールバック構造を `requestAnimationFrame` に接続
- ゲームデータ (`runtime/`, 約25MB) は `--preload-file` で `.data` にパッケージ
- ユーザ設定 (`/home/web_user/Documents`) は **IndexedDB (IDBFS)** で永続化
- **wasm pthreads 有効** — シミュレーションのスレッドプールが本来の並列実行で
  動作 (COOP/COEP ヘッダ必須。Cloudflare Pages へは `_headers` で自動付与、
  ローカルは `node scripts/serve.mjs` を使うこと。ヘッダ無し配信では
  SharedArrayBuffer が使えずロードに失敗する)
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
node scripts/serve.mjs     # COOP/COEP ヘッダ付き配信 (pthreads に必須)
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

## マルチプレイ / Multiplayer (roadmap)

YSFLIGHT 既存の TCP ネットコード (port 7915) を WebSocket でブリッジします。
詳細・実行手順は [docs/multiplayer.md](docs/multiplayer.md) を参照。

- **Phase 1 (動作確認済み)**: Emscripten のソケットエミュレーション +
  `server/relay.mjs` (WS→TCP リレー) でネイティブ YSFLIGHT サーバに接続。
  `?client=名前&server=ws://ホスト:7916` で起動するとロビーに自動ログイン
- **Phase 2 (動作確認済み)**: **ブラウザがサーバになれます**。WebRTC
  DataChannel の P2P 接続で、ゲーム内の「サーバ開始」がルームコード
  (画面右上に `Room: #ABC123`) を発行し、他のブラウザはサーバアドレス欄に
  `#ABC123` を入力して参加。必要なのは軽量なシグナリングサーバ
  (`server/signal.mjs`、SDP交換のみでゲームデータは流れない) だけ。
  `?signal=wss://...` で指定、`?room=` でルームコード固定も可

## 既知の制限 / Known limitations

- サウンドは OpenAL (Web Audio) 実装済み。ATC音声(ボイス)は未実装
- 日本語UI対応済み (Canvas 2D によるシステムフォント描画)。
  言語はブラウザのロケールから自動選択、`?lang=ja` / `?lang=en` で強制可能
- クリップボード・IME 未対応
- SharedArrayBuffer 必須 (COOP/COEP ヘッダ付き配信が前提)。
  かなり古いブラウザでは動作しません

## License

- 上流 YSFLIGHT のソースコードとランタイムデータ: 3-clause BSD (`upstream/YSFLIGHT/LICENSE`)
- 上流 public ライブラリ群: 各ソースファイルヘッダに記載の 2-clause BSD
- 本リポジトリの追加コード (`src/port`, `web`, `server`, `scripts`, `patches`):
  同じく 2-clause BSD ライセンス

YS FLIGHT SIMULATOR is (c) Soji Yamakawa (CaptainYS, http://www.ysflight.com).
This is an unofficial community port.
