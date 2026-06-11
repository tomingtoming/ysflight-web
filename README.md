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
- スレッドプールはシングルスレッドWasmでは逐次実行にフォールバック
  (`-pthread` 化すれば従来通り並列実行)

## ビルド / Build

必要なもの: [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html), CMake 3.20+, Node.js

```sh
git clone --recursive git@github.com:tomingtoming/ysflight-web.git
cd ysflight-web
scripts/build.sh           # パッチ適用 → emcmake configure → build → dist/ に出力
npx serve dist             # 任意の静的サーバでOK
```

`dist/` の中身 (`index.html` + `ysflight32_gl2.{js,wasm,data}`) を
そのまま静的ホスティングに置けば動きます。

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
- **Phase 2 (構想)**: WebRTC DataChannel による P2P / 低遅延転送

## 既知の制限 / Known limitations

- サウンドは OpenAL (Web Audio) 実装済み。ATC音声(ボイス)は未実装
- 日本語UI対応済み (Canvas 2D によるシステムフォント描画)。
  言語はブラウザのロケールから自動選択、`?lang=ja` / `?lang=en` で強制可能
- クリップボード・IME 未対応
- シングルスレッドのため重いシーンでは fps が落ちます

## License

- 上流 YSFLIGHT のソースコードとランタイムデータ: 3-clause BSD (`upstream/YSFLIGHT/LICENSE`)
- 上流 public ライブラリ群: 各ソースファイルヘッダに記載の 2-clause BSD
- 本リポジトリの追加コード (`src/port`, `web`, `server`, `scripts`, `patches`):
  同じく 2-clause BSD ライセンス

YS FLIGHT SIMULATOR is (c) Soji Yamakawa (CaptainYS, http://www.ysflight.com).
This is an unofficial community port.
