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

## 操作 / Controls

本家YSFLIGHTと同じキーボード操作です (矢印キー: 操縦桿, Q/A: スロットル,
Z/X: ラダー, G: ギア, Space: 機銃, etc.)。メニューから Simulation → Create Flight で
フライト開始。

## マルチプレイ / Multiplayer (roadmap)

YSFLIGHT 既存の TCP ネットコード (port 7915) を WebSocket でブリッジする設計です。
詳細は [docs/multiplayer.md](docs/multiplayer.md) を参照。

- **Phase 1**: Emscripten のソケットエミュレーション + `server/relay.mjs`
  (WS→TCP リレー) でネイティブ YSFLIGHT サーバに接続
- **Phase 2**: WebRTC DataChannel による P2P / 低遅延転送

## 既知の制限 / Known limitations

- **サウンド未実装** (Androidポート同様スタブ。OpenAL バックエンドを計画中)
- 日本語UIはフォント未対応のため文字化けします (現状 `-language en` 固定)
- クリップボード・IME・ジョイスティック未対応 (Gamepad API 対応予定)
- シングルスレッドのため重いシーンでは fps が落ちます

## License

- 上流 YSFLIGHT / public のソースコードとデータ: 各リポジトリのライセンス
  (BSD-style — see `upstream/*/LICENSE` / readme)
- 本リポジトリの追加コード (`src/port`, `web`, `server`, `scripts`, `patches`):
  同じく 2-clause BSD ライセンス

YS FLIGHT SIMULATOR is (c) Soji Yamakawa (CaptainYS, http://www.ysflight.com).
This is an unofficial community port.
