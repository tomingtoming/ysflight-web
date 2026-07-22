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
| Net > Client | `?join=` → `-client`＋シグナリングWorker | ✅ 稼働中 |
| Net > Server | `?host=1&name=` → `-server`（トップのホストフォームから発射） | ✅ 増分6 |
| Sim > Endurance | `?endurance=` → `-endurance` | ✅ 増分1（本ドキュメントと同PR） |
| Sim > Intercept | `?intercept=` → `-intercept`（fork の絶対index修正込み） | ✅ 増分3 |
| Sim > Create Flight（機体複数・僚機/敵機・昼夜・兵装） | Create-Flightページ（`studio-flight.html`）でspec→`.yfs`生成→`-flyyfs` | ✅ 増分4＋地上物プリセット=増分8 |
| Sim > レーシング / CAS（拡張ミッション） | `?mission=racing\|cas` → 組み込みspec→`EXTENSIO`行入り`.yfs`→`-flyyfs` | ✅ 増分12（地対空はプレイヤー=地上物のためfork待ち） |
| Sim > 着陸練習 Lv1-15 | `?landing=` → fork `-landingpractice`（`.yfs`では採点HUD/進入生成が再現できないためCLI新設が正道） | ✅ 増分10 |
| File > Open / Mission / Recent | `-flyyfs FILE`＋IDBFSはJS管轄 | 増分4に含む |
| File > Save（飛行中の任意保存） | `-saveflight` の起動時予約で大半カバー。完全版はJS橋（rearchitecture.md 継ぎ目2） | 保留可 |
| Option > Option（見た目・表示） | Settingsページ（`studio-settings.html`）→ localStorage → index.htmlが `flight.cfg` にマージ | ✅ 増分5（bool群）＋増分7（視程・機体LOD）＋増分9（煙/雲/Zバッファ・表示系・ゲームプレイ系=本家Optionダイアログとほぼパリティ。キー割当は今後） |
| Option > キー割当 / Config詳細 | 同経路を拡張（`settings.js` のMANAGED拡張） | 今後 |
| Option > ジョイスティック較正 | 入力はweb port層（Gamepad API）の管轄＝webが本来の持ち主 | 今後 |
| Option > オートデモ | `?demo=1` → `-demoforever`（観るモード。ループは仕様＝退出はブラウザ戻る） | ✅ 増分11 |
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
6. **ホスト入口（実装済み）** ── `?host=1&name=NAME[&field=FIELD]` →
   `-server NAME [FIELD]`（上流 `fscmdparaminfo.cpp` の EXEMODE_SERVER →
   `StartNetServerMode`。エンジン無改変）。web port の yssocket 層が
   シグナリングroomを claim（`?room=` で固定・省略時8桁自動採番）、既存の
   Room チップが招待リンクを出す。`&name=` は `?join=&name=` と同じ別パラメータ
   方式（`?host` の値自体はトリガーのみ＝旧 `?host=1` リンクは名前フォーム
   自動展開として生き続ける）。トップの「ホストの始め方」howtoカードは
   実フォーム（名前→ホスト開始）へ置換——本家 Network メニュー経由の教示は
   退役。`?join=` と併用時は join 優先（-server は argv に入れない）。
   ホスト起動にも `-autoexit` が付き、セッション終了→シェル帰還。
   検証: `test/deeplink.test.mjs`（写像）＋`scripts/smoke-host.mjs`
   （?host=→サーバーモード到達＋sig-stub相手のroom claim＋autoexit誤発火なし、
   CIは `scripts/smoke-host.sh`）。**残**: マルチロビー体験の本格化
   （ルーム一覧・フィールド選択UI等）は需要駆動で。ホスト中の機体選択・
   終了確認等のダイアログはエンジン側に残す（飛行画面の一部＝方針どおり）。
7. **設定エディタ第二段: 数値/enum（実装済み）** ── `settings.js` の MANAGED を
   型付き（bool/length/enum）に一般化し、書式はエンジンの
   `FsFlightConfig::Save` と byte 一致（length は `%.2lfm`、enum は整数）。
   第一弾は **視程**（`VISIBILIT`、fsdef.h の 800–20000m にクランプ、
   スライダー）と**機体の描画品質**（`AIRLVODTL`、本家 "Airplane Graphics"
   ドロップリスト相当の 0 自動/1 高品質/2 簡易、セレクト）。検証:
   `test/settings.test.mjs`（クランプ・書式・冪等）＋`scripts/smoke-settings.mjs`
   （チェックボックス/スライダー/セレクトの3型を実UIで操作→flight.cfg 反映）。
   **残**: キー割当（TRG/AXS行）・Config詳細・ジョイスティック較正UI。
8. **Create Flight 地上物プリセット（実装済み）** ── `spec.ground` を `yfs.js`
   が GROUNDOB/IDENTIFY/GNDPOSIT/GNDATTIT ブロックに書く（エンジン保存文法
   準拠）。**GNDPOSIT は絶対座標で地形スナップ無し**（`FsGround::Settle` 確認済み）
   なので、ページは `stock/fields.json`（gen-stock-index.mjs が stock `.stp` から
   生成: フィールド→開始位置の座標/方位）の**接地済み開始位置をアンカー**に
   プリセット（対空砲陣地/SAM陣地/練習ターゲット）を散布する。フィールドの
   scenery 定義済み地上物は FIELDNAM だけで自動配置される（`FsWorld::AddField`）
   ため、ここで足すのは「フィールドに無い的」。検証: `test/yfs.test.mjs`
   （文法・丸め・sanitize・後方互換）＋`scripts/smoke-createflight.mjs`
   （プリセット選択→`.yfs` に GROUNDOB→飛行到達・"Cannot create a ground
   object" を FATAL 監視）。**残**: 自由配置UI（座標指定）は需要駆動。
   プレイヤー操縦の地上物（地対空ミッション）はミッション拡張側
   （EXTENSIO=`fssimextension.cpp` のレジストリ、Racing/CAS/GroundToAir）で扱う。
9. **設定エディタ第三段: Config詳細（実装済み）** ── `choice` 型（文字列トークン
   enum、fsconfig.cpp のキーワード表準拠）を新設し、本家 Option ダイアログ
   （fsguiconfigdlg.cpp）の残りをパリティ化: 煙のタイプ SMOKETYPE
   （TOWEL/SOLID/NULL）・雲のタイプ CLOUDTYPE（NONE/FLAT/SOLID）・Zバッファ品質
   ZBUFFQUAL（0-3）＋表示系 bool（HUDALWAYS/SHOWKIAS_/FRMPERSEC/DRAWVJSTK）＋
   ゲームプレイ系 bool（GBLACKOUT/MIDAIRCOL/NOTAILSTK/LANDANWHR、
   Settingsページに「表示・描画/ゲームプレイ」見出しで区分）。既定値はすべて
   `FsFlightConfig::SetDefault` と一致。コントロールは `#ysfw-set-<KEY>` の id
   を持ち smoke が安定参照。検証: `test/settings.test.mjs`（choice 検証・既定値）
   ＋`scripts/smoke-settings.mjs`（CLOUDTYPE NONE を実UI→flight.cfg まで確認）。
   **残**: キー割当（=ジョイスティック割当、port絡み）・較正・オートデモ。
10. **着陸練習（実装済み・fork小改変）** ── `?landing=LEVEL[,機体[,フィールド]]`
    → fork 新設の `-landingpractice LEVEL AIRCRAFT [FIELD]`
    （EXEMODE_LANDINGPRACTICE=7、fork `feat/landing-practice-cli`）。エンジンの
    着陸練習は ILS 相対の進入生成・AOA/トリム・天候・採点HUDの深いロジックで
    `.yfs` では再現できないため、メニューと同じ2呼び出し
    （`SetUpLandingPracticeMode`＋`StartShowLandingPracticeInfoMode`）を
    コマンドラインから叩く入口を fsmain に追加（レベル→旋回脚/横風/天候の
    15段表は fsmenu_sim.cpp の switch をデータ表として鏡写し・要同期コメント付き）。
    トラフィックパターン情報画面は Space/クリックで離陸（飛行画面の一部＝
    エンジン側に残す方針どおり）。web 既定は F/A-18＋AOMORI（エンジン既定
    フィールド・ILS 有りを smoke で実証）。トップのミッション節に
    🛬 カード2枚（Lv1 ファイナル/Lv12 低視程IFR）。検証:
    `test/deeplink.test.mjs`（写像・クランプ）＋`scripts/smoke-mission.mjs`
    第3レッグ（?landing=1→情報画面を Space で抜け in-flight 到達）。
    **残**: レベル任意選択UI（1-15セレクト）は需要駆動。
11. **オートデモ（実装済み）** ── `?demo=1` → 既存 `-demoforever`
    （EXEMODE_OPENINGDEMOFOREVER、エンジン無改変）。キー押下＝次のデモ・
    メニュー復帰なしのキオスク仕様なので **`-autoexit` は意図的に付けない**
    （観るモード。退出はブラウザの戻る）。トップの設定リンク下に静かな
    🎬 リンク。検証: `test/deeplink.test.mjs`＋`scripts/smoke-mission.mjs`
    第4レッグ（ブート＋パネル非表示＋数秒の安定）。これで置き換え地図の
    未対応行は **Option > キー割当/較正（=ジョイスティック領域）だけ**。
12. **拡張ミッション: レーシング＋CAS（実装済み・エンジン無改変）** ──
    `?mission=racing|cas[,機体[,フィールド]]` → 組み込みspec
    （`yfs.js` `missionSpec`）→ `EXTENSIO` 行入り `.yfs` → 既存 `-flyyfs`。
    エンジンの拡張レジストリ（`fsworld.cpp` case 52 → `fssimextension.cpp`）
    がミッションを復元する。調査で確定した構造:
    **レーシング**＝ゲートはフィールドscenery側の `RACECHKP` 地上物で、拡張は
    ラップ計時＋武装剥がしのみ→ RACING_VALLEY（開始位置は単一の `START`）で
    完全成立。**CAS**＝拡張は状態ゼロ（Serialize=ヘッダのみ）で、戦車は
    `StartSimulation`/`OnInterval` が毎回生成→ TOHOKU 空中スタートで成立。
    **ミッションゴールは .yfs 文法に無い**（本家の prevflight 再開と同じ
    オープンエンド挙動）。**地対空はプレイヤー=地上物**で `-flyyfs` の
    `PlayerPlaneIsReady()` ゲートに弾かれるため fork 小改変（ゲート緩和 or
    `-groundtoair`）待ち＝次スタック。トップに 🏁/🛡️ カード各1。検証:
    `test/yfs.test.mjs`（EXTENSIO 行・whitelist・preset）＋
    `scripts/smoke-mission.mjs` 第5・6レッグ（racing/cas とも in-flight 到達＋
    生成 .yfs の EXTENSIO 行確認）。

## 検証面

| 対象 | 手段 |
|---|---|
| URL→argv写像 | `test/deeplink.test.mjs`（node --test・純関数） |
| ディープリンク→飛行到達 | `scripts/smoke-mission.mjs`（CI・ヘッドレス実機） |
| ホスト入口→サーバーモード到達＋room claim | `scripts/smoke-host.mjs`（CI・ヘッドレス実機＋sig-stub） |
| 帰還（飛行終了→web引き取り） | `test/fly-return.test.mjs`＋実機 |
| 増分2以降のport変更 | 既存 smoke 群（ビルドはCIが毎PR実施） |
