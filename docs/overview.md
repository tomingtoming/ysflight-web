# ysflight-web 現状仕様 (v1 Overview)

> ステータス: **v1 現状仕様（2026-06-27 時点）**。原典 [captainys/YSFLIGHT](http://www.ysflight.com)
> （C++ デスクトップ機）を Emscripten で WASM 化し、ブラウザシェル＋PWA で包んだ非公式移植。
> 本書は v1 の **通し仕様の正本**。各論の詳細は個別設計書を参照:
> [personas.md](personas.md)（誰のために作るか）/ [multiplayer.md](multiplayer.md) / [addon-packs.md](addon-packs.md) /
> [asyncify-lazy-pack.md](asyncify-lazy-pack.md) / [rearchitecture.md](rearchitecture.md) / [../README.md](../README.md)。

全要素は3分類で整理できる:

- **忠実 (Faithful)** — 原典 C++ をそのまま WASM 化（無改変）
- **移植 shim (Port shim)** — `src/port/*` が OS 依存層をブラウザ等価物に差し替え
- **新規 (Net-new)** — デスクトップに存在しない Web 専用機能

---

## 1. 原典 YSFLIGHT との差分（プラットフォーム層）

### 1.1 忠実な中核（無改変）

シミュレーション中核は**原典 C++ をそのまま WASM 化**している（`scripts/build.sh` が
`upstream/YSFLIGHT/src` を直接ビルドし、stock の `ysflight32_gl2` ターゲットを作る）。以下は原典のまま:

- **飛行モデル / 物理**（`FsSimulation::SimulateOneStep`）。唯一の本体改変は描画準備
  （`DecideAllViewPoint` 等）を物理ループ外へ括り出した構造変更のみで、ハーネスの
  ゴールデンテストで軌道バイト同一を確認済み＝**飛行挙動は不変**。
- **アセット形式**（`.dnm/.srf/.fld/.lst/.dat/.stp/.yfs`）の解析、メニュー、5種のゲームモード
  （racing/endurance/intercept/closeairsupport/groundtoair）、起動時の一度きりテンプレ走査。

設計思想は strangler-fig（既存の継ぎ目を切って周囲に足す。書き直さない）。詳細は
[rearchitecture.md](rearchitecture.md)。

### 1.2 移植 shim（`src/port/*`：OS 層の差し替え）

| 層 | shim | 差分 |
|---|---|---|
| 窓 / 入力 / GL | `fssimplewindow_emscripten.cpp` | WebGL1 コンテキスト、DOM イベント入力、**タッチ対応（新規）**。`FsSleep`・`FsSetMousePosition` は no-op（ブラウザはメインスレッドを止められず、ポインタも warp 不可）。**IME / クリップボード未実装**、ブラウザショートカット（F5/F12/Ctrl-VCX）は意図的に素通し |
| メインループ | `fslazywindow_emscripten.cpp` | `emscripten_set_main_loop`（= `requestAnimationFrame`）駆動。**バックグラウンドタブ継続（新規）**＝小さな Web Worker が ~16ms 間隔で tick し、非表示時も描画せず物理だけ継続（マルチプレイ切断防止） |
| 音声 | `fsairsound_emscripten.cpp` | OpenAL → **Web Audio**（Emscripten 経由）実装済み。**ATC 音声（ボイス）は未実装** |
| フォント | `yssystemfont_emscripten.cpp` | Canvas 2D でシステムフォント描画（日本語 UI 対応） |
| プラットフォーム | `fsplatform_emscripten.cpp` | 窓 / 最大化 / 常時最前面等は no-op、ダイアログは `printf` ＋自動却下に縮退 |
| **ソケット** | `yssocket_emscripten.cpp` | TCP → **WebRTC DataChannel**（→ §2） |
| **ファイル open** | `ysfw_openat.jslib` | ASYNCIFY で `__syscall_openat` を計装し、同期 `fopen` を **OPFS からの非同期 materialize 待ち**に（→ §3、遅延パックの心臓部） |

### 1.3 ファイルシステム 3層モデル

原典＝ネイティブ FS を直接利用。Web＝Emscripten の仮想 FS（`-sFORCE_FILESYSTEM=1`）を3層に重ねる:

1. **基本アセット（読取専用）** — 約25MB の `runtime/` を `--preload-file` で `.data` に焼き込み
   `/ysflight` にマウント（原典データ無改変）。
2. **ユーザ設定（永続）** — `/home/web_user/Documents` を **IDBFS（IndexedDB）** で永続化
   （config・リプレイ。デバウンス sync で書き戻し）。
3. **追加パック（新規）** — **OPFS**（content-addressed blob）に保存し、**ASYNCIFY で遅延 materialize**
   （→ §3）。MEMFS は wasm 線形メモリ（~2GB 天井）上で増えるだけなので `web/memfs-lru.js` が
   highWater 768MiB → lowWater 512MiB で LRU 退避し有界化。詳細は [asyncify-lazy-pack.md](asyncify-lazy-pack.md)。

### 1.4 ビルド・配信・PWA

- **描画**: 原典の **OpenGL ES 2.0 バックエンド**（Android 用 `graphics/gl2.0`）を `-sFULL_ES2` で
  **WebGL 1.0** に使用。
- **単一スレッド実行**: `-pthread` 不使用（ワーカー完了待ちでメインスレッドが凍結し rAF が止まるのを避ける）。
  よって **SharedArrayBuffer / COOP+COEP 不要**。
- **コンテンツハッシュ命名 ＋ PWA**: エンジン資産は `ysflight32_gl2.<hash>.{js,wasm,data}` で immutable
  キャッシュ、シェル JS/HTML は network-first（stale 配信防止）。Service Worker でオフライン・即時再起動。
- **ホスティング**: **Cloudflare Workers**（Static Assets。Pages からは移行済み）。同一 Worker
  （`worker/signal.js`）が `/signal`・`/turn` も提供。push で Cloudflare Workers Builds がデプロイ。

### 1.5 デスクトップ版との主な制限

単一スレッド（並列シミュレーションなし）／ WebGL1 のみ／ ATC 音声・IME・クリップボード未対応／
ポインタ warp 不可／実 OS 窓なし（フルスクリーン等は browser-fullscreen のみ）／
wasm32 ~2GB メモリ天井（遅延パックの実容量上限。LRU で緩和、撤廃ではない）。

---

## 2. マルチプレイ

詳細は [multiplayer.md](multiplayer.md)。要点:

- **原典＝TCP client-server**（権威サーバ型、独自バイナリプロトコル、状態・名前参照の同期で
  **バルク資産転送なし**）。ブラウザは生 TCP を張れないため、`yssocket_emscripten.cpp` が
  `YsSocketServer`/`YsSocketClient` を **WebRTC DataChannel** で再実装（エンジンのプロトコル・権威は無改変）。
  1人のブラウザがサーバ権威。
- **シグナリング**: 同一オリジンの **Cloudflare Worker + Durable Object**（`worker/signal.js`、単一グローバルハブ）。
  SDP/ICE のみ中継し、**ゲームデータは一切通らない**。8桁数字ルーム、招待リンク `?join=12345678`、
  host 切断時の **token 付き再取得（reclaim）**で既存 peer を保持。
- **ICE**: 公開 STUN ＋ **Cloudflare Realtime TURN**（`/turn` が短命クレデンシャル TTL24h を配布。
  未設定なら 204 で STUN 一本にフォールバック）。`?turn=0` で強制 STUN。直結不可ペア（対称 NAT / CGNAT /
  モバイル）は TURN 中継。**20秒**で ICE 未確立なら接続失敗を可視化。
- **2系統の DataChannel**: エンジンゲーム用 `'ysf'`（原典プロトコル）と、シェル所有のパック用
  `'ysf-pack'`（派生ルーム `<room>~p`）は別物（後者は §3 のとおり v1 では既定 OFF）。
- **非互換**: `NET-VERSION` を **20260617** に固定し、**原典ネイティブ版とは接続不可**（意図的）。
  Web 版は **チャット・サーバポート設定なし**（P2P / Room ID のみ）。

---

## 3. 追加パックの取り扱い

詳細は [addon-packs.md](addon-packs.md)。

### 3.1 原典（デスクトップ）

ユーザが mod のフォルダを YSFLIGHT ディレクトリに手でコピー。起動時に `aircraft/air*.lst`・
`scenery/sce*.lst`・`ground/gro*.lst` を **glob 走査**。**インポート UI 無し・分離無し・一度きり走査・
配信機構無し**。マルチプレイは「全員が同じファイルを事前導入済み」という暗黙の **vanilla 契約**。

### 3.2 Web シングルプレイのパック管理 ＝ **稼働中（LIVE）**

「フォルダに置く」を **取り込み → 解析 → OPFS → 遅延 materialize** に置換し、**無リロード**で
エンジンの一度きり走査に拾わせる:

1. **取り込み**: 起動前パネルにドラッグ&ドロップ or URL（`sourceUrl` 記録）。Play まで boot gate で保留。
2. **解析 / 正規化**（`web/packs.js`）: unzip → `__MACOSX` 等の除去 → パス正規化＋**`..` traversal 拒否**
   → エンジンが走査するリスト検出 → ラッパーフォルダ剥がし → 大小文字解決 → **content-hash で安定 pack id
   （先頭16hex）** → `packs/<id>/...` を指す `.lst` 再生成。
3. **保存**（`web/opfs-store.js`）: OPFS に **content-addressed blob**（`blob/<aa>/<sha256>`、パック間で
   重複排除）＋ per-pack record。`packs/<id>/` で**分離**（同名ファイル衝突なし）。
4. **遅延 materialize**（“無制限パック”の核）: 起動時は軽量メタ（`.lst/.dat/.stp`）だけ MEMFS へ＝メニュー即完成。
   重い実体（`.dnm/.srf/.fld`・テクスチャ）は**エンジンが開いた瞬間に ASYNCIFY で OPFS→MEMFS へ取り込み**。
   MEMFS は LRU で有界化。
5. **有効無効**（`.lst` ↔ `.lst.off` のリネーム＝glob の裏技）、**アンインストール**（record 先消し →
   `packs/<id>/` 消去 → 参照カウントで blob GC）。

### 3.3 Web マルチプレイの**パック配信** ＝ **実装済みだが既定 OFF（v1 スコープ外）**

> **★2026-06-27（commit `ae6fb81`）で descope。** host→joiner の P2P 自動配信は `MP_PACK_SYNC`
> フラグで**既定無効**、`?packsync=1` でのみ再有効（v2 再設計用のテストスイッチ）。

`?packsync=1` 時に動く設計（コードは `web/pack-net.js` に残置、設計は [addon-packs.md](addon-packs.md) §5/§9）:
パック専用ルーム派生 → host が **lean manifest** を広告（`{id,name,categories,sourceUrl?}` のみ、
ハブ上限 256KB）→ joiner が差分 → 不足を **①Option-B**（`sourceUrl` 自己取得）/ **②Option-A**
（host P2P プッシュ）/ **③metadata-first メタ束**（多数パックをスパース導入）で取得、**フィールド最優先**
（欠落＝致命）、必須失敗時は **Retry/Solo パネル**、同名衝突は **host-wins**。

**なぜ OFF・v2 方針**: 実機テストで **DataChannel 確立後に転送がストール**（10本/206本いずれの部屋も
30〜90秒ハング → Retry/Solo）。筆頭根本原因仮説＝ **`PACK_CHUNK=60KB` が相互運用安全値 16KB を超過**
（実 SCTP 経路で詰まる典型。同一マシン検証では実ネットワークが介在せず再現しなかった）。v2 でチャンク
サイズ準拠・`maxMessageSize` 検証・ICE/connection-state 失敗の即時検知を軸に配信を再設計する。

### 3.4 現在のユーザー体験（v1 の実態）

**マルチプレイで追加パックは自動配信されない。** joiner は即ブートし、**base ＋ 自分がローカル導入した
パックだけ**でホストに接続する＝**原典と同じ vanilla 契約（全員が事前に同じパックを各自導入）**。
シングルプレイのパック取り込み / 有効無効 / 削除は稼働中。

---

## 原典との差分 早見表

| 項目 | 原典 YSFLIGHT | ysflight-web（v1 現状） |
|---|---|---|
| 配布形態 | ネイティブ実行ファイル | ブラウザ / WASM・PWA（URL を開くだけ） |
| 実行 | マルチスレッド | **単一スレッド**（メインスレッド凍結回避） |
| 描画 | デスクトップ GL | **WebGL 1.0**（ES2 バックエンド流用） |
| ネット対戦 | TCP client-server | **WebRTC P2P** ＋ Cloudflare シグナリング。NET-VER 非互換・チャット/ポート設定なし |
| 追加パック導入 | フォルダにコピー | **取り込み UI → OPFS → 遅延 materialize**（無リロード・重複排除・分離・有効無効/削除） |
| MP 時のパック | 各自手動で事前導入（暗黙） | **同左（v1 で明示的に vanilla 契約）。自動配信は v2 へ先送り** |
| 音声 / 入力 | フル | OpenAL→Web Audio（ATC 音声なし）、IME/クリップボードなし |

---

## 関連ドキュメント

- [personas.md](personas.md) — ターゲットユーザー / ペルソナ（第一ターゲット＝旧YSFLIGHTの既存ファン）と、スコープ判断の根拠
- [multiplayer.md](multiplayer.md) — マルチプレイ（WebRTC P2P / シグナリング / TURN）の詳細設計
- [addon-packs.md](addon-packs.md) — 追加パックの全設計（取り込み・OPFS・MP 配信設計）
- [asyncify-lazy-pack.md](asyncify-lazy-pack.md) — OPFS 遅延 materialize（無制限パック）の詳細
- [rearchitecture.md](rearchitecture.md) — エンジンの継ぎ目分析（strangler-fig 戦略）
- [../README.md](../README.md) — ビルド・デプロイ・操作・既知の制限
