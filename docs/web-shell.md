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
| Sim > Intercept | `?intercept=` → `-intercept`（fork の絶対index修正込み） | ✅ 増分3 |
| Sim > Create Flight（機体複数・僚機/敵機・昼夜・兵装） | Create-Flightページ（`studio-flight.html`）でspec→`.yfs`生成→`-flyyfs` | ✅ 増分4（地上物・CAS/地対空/レーシングは今後） |
| Sim > 着陸練習 Lv1-15 | 定型 `.yfs` または生成 | 今後（yfs.js基盤を再利用） |
| File > Open / Mission / Recent | `-flyyfs FILE`＋IDBFSはJS管轄 | 増分4に含む |
| File > Save（飛行中の任意保存） | `-saveflight` の起動時予約で大半カバー。完全版はJS橋（rearchitecture.md 継ぎ目2） | 保留可 |
| Option > Option（見た目・表示） | Settingsページ（`studio-settings.html`）→ localStorage → index.htmlが `flight.cfg` にマージ | ✅ 増分5（曲率の高いbool群。キー割当・Config詳細は今後） |
| Option > キー割当 / Config詳細 | 同経路を拡張（`settings.js` のMANAGED拡張） | 今後 |
| Option > ジョイスティック較正 | 入力はweb port層（Gamepad API）の管轄＝webが本来の持ち主 | 今後 |
| Option > オートデモ | 収録済み飛行データ → `-flyyfs` / `-demoforever` | 低優先 |
| Help | webページ | ✅ 事実上済 |

## 増分計画

1. **ミッションディープリンク（このPR）** ── `web/deeplink.js` 新設
   （URL→argv写像の単一の置き場・単体テスト付き）、`?endurance=`、トップ
   ページにミッションセクション、CIに mission smoke。エンジン無改変。
2. **即時ハンドオーバー（実装済み・増分1の次のPR）** ── port層
   `fslazywindow_emscripten.cpp` の `MainLoopTick` が terminate 時に
   `ysfw-terminated` イベントをJSへ発火（メニューフレームを描く前に脱出）し、
   ディープリンク起動には `-autoexit` を付与（`-autoexit`＝メニュー復帰時
   モーダル無しなら終了、`fsrunloop.cpp` の
   `terminateWhenNoModalDialogIsOpenAndBackToMenu`）。シェルはイベントで即
   帰還（800msポーリングはフォールバックに降格）。メニューは1フレームも
   見えない。検証知見: 飛行終了の操作列は Space（CENTER JOYSTICK ゲート解除、
   `fsrunloop.cpp:198` がESCも食う）→ESC×2（`fssimulation.cpp`
   escKeyCount>=2）→（enduranceは CONTINUE FLIGHT? ダイアログ）→ESC。
   飛行中の継続確認等のダイアログはエンジン側に残す（方針どおり）。
3. **`?intercept=`（実装済み）** ── 上流 `fscmdparaminfo.cpp` の
   `-intercept` はフラグ群を `av[3..8]`（**絶対位置**）で読む off-by-one
   バグがあり、`av[i+3..i+8]` であるべきだった。fork `fix/intercept-arg-index`
   に単独コミットで修正（上流にそのままPRできる純バグ修正として分離）→
   submodule bump → `?intercept=機体[,マップ,ステルス,護衛,重爆,爆弾,機数,僚機]`。
   検証知見: intercept は勝利条件を持つため離陸前に `== Your Mission ==`
   ブリーフィング（`fsguisiminfodialog.cpp`）が出る。これは飛行画面の
   ミッション内容としてエンジン側に残す（enduranceの CONTINUE? と同じ扱い）。
   OKボタンのクリックで離陸（Enterでは閉じない）。
4. **`.yfs` ジェネレータ（実装済み）** ── `web/yfs.js` の `buildYfs(spec)`
   がフライト定義（機体・マップ・昼夜・兵装・IFF）をJSで組み立て、
   Create-Flightページ（`studio-flight.html`）がspecを sessionStorage に置いて
   `?createflight=1` へ遷移→ index.html preRun が `.yfs` を生成→`-flyyfs`。
   文法は `FsSimulation::Save`（`fssimulationfileio.cpp`）のサブセット
   （YFSVERSI/FIELDNAM/ENVIRONM/ALLOW*/AIRPLANE/STARTPOS/IDENTIFY）。
   検証: `test/yfs.test.mjs`（生成文字列）＋ `scripts/smoke-createflight.mjs`
   （ページ→生成→飛行到達をヘッドレス実機）。**残**: 地上物（GROUNDOB）・
   ミッション拡張（identで `.yfs` から復元＝`fsworld.cpp:1966`。CAS/地対空/
   レーシング）・着陸練習。
5. **設定エディタ（実装済み・第一段）** ── `web/settings.js` の
   `mergeFlightCfg(existing, values)` が web所有の option を `flight.cfg` に
   行単位でマージ（非管理行＝エンジン書き込み/未公開は温存）。Settingsページ
   （`studio-settings.html`）が localStorage に持ち、index.html preRun が
   **全起動で**マージ→エンジンは通常どおり読む。現状は曲率の高いbool群
   （影・雲・地平線・AA・煙パーティクル・簡易HUD）。検証:
   `test/settings.test.mjs`＋`scripts/smoke-settings.mjs`（ページ→flight.cfg
   反映＋非管理行温存を実機確認）。**残**: 数値option（視程等）・キー割当
   （TRG/AXS行）・ジョイスティック較正UIのweb移管。いずれもMANAGED拡張。

## 検証面

| 対象 | 手段 |
|---|---|
| URL→argv写像 | `test/deeplink.test.mjs`（node --test・純関数） |
| ディープリンク→飛行到達 | `scripts/smoke-mission.mjs`（CI・ヘッドレス実機） |
| 帰還（飛行終了→web引き取り） | `test/fly-return.test.mjs`＋実機 |
| 増分2以降のport変更 | 既存 smoke 群（ビルドはCIが毎PR実施） |
