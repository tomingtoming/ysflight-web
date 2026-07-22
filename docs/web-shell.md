# web-shell ── エンジンは「飛行実行機」、UIはすべてweb側

> ステータス: **設計方針＋進行中**。増分1（ミッションディープリンク）から実装開始。
> 関連: [rearchitecture.md](rearchitecture.md)（エンジン側の継ぎ目）、[toppage-review.md](toppage-review.md)（トップページ）。

## 決定

原典YSFLIGHTエンジン（WASM）は**飛行画面の実行だけ**を担い、それ以外の体験
──トップページ・フライト作成・ミッション・設定・パック管理・マルチロビー・
リプレイ管理・ヘルプ──は**すべてweb側（HTML/JS）が担う**。

エンジンの2Dメインメニュー（`gui/fsmenu*.cpp`）はwebのUXから退役させる
（コードは削らずリンクしたまま残す＝上流追従のコンフリクト面を増やさない）。

## 成立している土台（このリポジトリで実証済み）

- **入口＝起動引数**: web側がURLディープリンクをコマンドライン引数に組んで
  エンジンを起動する。`?freeflight=`（Quick Flight）・`?replay=`・`?join=`
  （-client）が本番稼働中。マッピングの単一の置き場は `web/deeplink.js`。
- **出口＝飛行状態フラグ**: fork側 `fsrunloop.cpp` の `ChangeRunMode` が
  `globalThis.ysfwInFlight` / `ysfwReplaying` を毎遷移で更新。webは
  true→false のエッジを「飛行終了」と解釈し、発射元ページへ帰還させる
  （`?return=` ホワイトリスト、web/fly-return.js）。
- **状態＝ファイル**: 設定・リプレイ・パックはIDBFS/OPFS上のファイルで、
  JSから直接読み書きできる。エンジンは起動時に読む。

つまり「webが発射 → エンジンは飛ぶだけ → 終わったらwebが引き取る」の
往復が既に本番で回っており、本方針はその適用範囲を全入口に広げるもの。

## 本家メインメニューの置き換え地図

| 本家メニュー項目 | web側の手段 | 状態 |
|---|---|---|
| Sim > Fly | `?freeflight=` → `-freeflight` | ✅ 稼働中 |
| Sim > リプレイ再生 | `?replay=` → `-replayrecord` | ✅ 稼働中 |
| Net > Client/Server | `?join=` → `-client`＋シグナリングWorker | ✅ 稼働中 |
| Sim > Endurance | `?endurance=` → `-endurance` | ✅ 増分1（本ドキュメントと同PR） |
| Sim > Intercept | `-intercept` は**上流バグあり**（後述）→ fork修正後に `?intercept=` | 増分3 |
| Sim > Create Flight（本格作成・昼夜・地上砲火・CAS/地対空/レーシング） | web UIで `.yfs` を生成 → IDBFSに書く → `-flyyfs` | 増分4（本丸） |
| Sim > 着陸練習 Lv1-15 | 定型 `.yfs` または生成 | 増分4に含む |
| File > Open / Mission / Recent | `-flyyfs FILE`＋IDBFSはJS管轄 | 増分4に含む |
| File > Save（飛行中の任意保存） | `-saveflight` の起動時予約で大半カバー。完全版はJS橋（rearchitecture.md 継ぎ目2） | 保留可 |
| Option > Config / Option / キー割当 | IDBFS上の設定ファイルをwebエディタで直接編集 | 増分5 |
| Option > ジョイスティック較正 | 入力はweb port層（Gamepad API）の管轄＝webが本来の持ち主 | 増分5 |
| Option > オートデモ | 収録済み飛行データ → `-flyyfs` / `-demoforever` | 低優先 |
| Help | webページ | ✅ 事実上済 |

## 増分計画

1. **ミッションディープリンク（このPR）** ── `web/deeplink.js` 新設
   （URL→argv写像の単一の置き場・単体テスト付き）、`?endurance=`、トップ
   ページにミッションセクション、CIに mission smoke。エンジン無改変。
2. **即時ハンドオーバー** ── 現状、飛行終了→800msポーリングが拾うまで本家
   メニューが一瞬見える。port層 `fslazywindow_emscripten.cpp` の
   `MainLoopTick` は `MustTerminate` で `emscripten_cancel_main_loop()` を
   呼ぶだけで**JSに通知しない**（実測）。ここに terminate→JSイベントを足し、
   ディープリンク起動に `-autoexit` を付ける（`-autoexit`＝メニュー復帰時
   モーダル無しなら終了、`fsrunloop.cpp` の
   `terminateWhenNoModalDialogIsOpenAndBackToMenu`）。メニューは1フレームも
   見えなくなる。wasm再ビルド要・fork不要（port層は本リポジトリの所有）。
3. **`?intercept=`** ── 上流 `fscmdparaminfo.cpp` の `-intercept` は
   フラグ群を `av[3..8]`（**絶対位置**）で読む off-by-one バグがあり、
   `av[i+3..i+8]` であるべき。fork `emscripten` ブランチに単独コミットで
   修正（上流にそのままPRできる純バグ修正として分離）→ submodule bump →
   `?intercept=` 追加。
4. **`.yfs` ジェネレータ（本丸）** ── フライト定義をJSで組み立てて
   `-flyyfs` で起動。Create Flight 相当のweb UI（機体複数・僚機・地上物・
   昼夜・ミッション種別）。ミッション拡張は ident 経由で `.yfs` から復元
   される（`fsworld.cpp:1966`）ため、CAS/地対空/レーシングもこの経路。
5. **設定エディタ** ── config / option / キー割当のwebエディタ
   （IDBFS直編集）。ジョイスティック較正UIのweb移管。

## 検証面

| 対象 | 手段 |
|---|---|
| URL→argv写像 | `test/deeplink.test.mjs`（node --test・純関数） |
| ディープリンク→飛行到達 | `scripts/smoke-mission.mjs`（CI・ヘッドレス実機） |
| 帰還（飛行終了→web引き取り） | `test/fly-return.test.mjs`＋実機 |
| 増分2以降のport変更 | 既存 smoke 群（ビルドはCIが毎PR実施） |
