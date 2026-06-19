# ysflight-web 漸進的リアーキテクチャ (Incremental Re-architecture)

> ステータス: **進行中の知見メモ**。実証済みの継ぎ目と、その検証方法・次の一手を記録する。
> コードの実体は fork の PR にある: [tomingtoming/YSFLIGHT#2](https://github.com/tomingtoming/YSFLIGHT/pull/2)（弧全体）／
> [tomingtoming/public#1](https://github.com/tomingtoming/public/pull/1)（前提の null backend 修正）。
> file:line は upstream エンジン (`upstream/YSFLIGHT`, emscripten ブランチ) のもの。

## 概要

ysflight-web は原典 YSFLIGHT の C++（約20万行・318ファイル）を Emscripten で WebAssembly に
コンパイルして動かしている（`scripts/build.sh`）。上流は**事実上凍結**。この上に「ブラウザで体験を
足す」をやりたいが、エンジンが手を入れづらい。

選択肢は3つあった ── ①C++のまま継ぎ目を切る ②C++→Rust 化 ③C++→TS/Three.js 再実装。
結論として採ったのは **ストラングラーフィグ**: 全書き換えではなく「**継ぎ目を切る → 新機能/レンダラを
外に足す → 中身の侵食は最後**」。各段を**安全網（characterization harness）の下で実機検証してから**
次へ進む。

---

## 1. 方針 ── 凍結モノリスは書き換えるな、継ぎ目を切って外に足せ

- **同言語のまま継ぎ目を切る**のが下ごしらえ。言語の置換（Rust/TS化）はそれ自体ではアーキテクチャを
  良くしない。継ぎ目を見つけて切る作業は言語非依存で、「体験を足しやすくする」目的の大半はここで達成される。
- **安全網を最初に建てる**。20万行を触る前に、決定論的に挙動を固定できる characterization harness を作る（後述）。
- **「スパゲッティ」と決めつける前に監査せよ**。実コードを読むと、YSFLIGHT は恐れたより遥かに良く分割されていた:
  - global 状態は**集約**されている（`world` ポインタ1本 → `FsWorld` → 単一 `FsSimulation`。`src/main_consvr/fsmainsvr.cpp:82`）
  - `core/` と `vehicle/` は **OpenGL フリー**（純粋シムロジック）
  - 描画は `YsVisualDnm` 抽象で**既にバックエンド分離**（gl1 / gl2 / d3d9 / null が並存）
  - 体験は `FsSimExtensionBase` 拡張APIで**既に分離**（5つのゲームモードが実装済み）
  - 膿は2箇所に集中: 神クラス `FsSimulation`（`src/core/fssimulation.h`、約1219行）と、
    シムオブジェクトが `Draw()` を持つ点（`src/core/fsexistence.cpp:1341` `FsAirplane::Draw`）
- **verify by doing**。各継ぎ目を harness の決定論チェック＋実機（ネイティブGUI）プレイで検証してから commit。
  継ぎ目ごとに1ブランチ。

---

## 2. 安全網 ── characterization harness

`src/main_harness/`（fork に追加した新ターゲット `ysflight64_harness`）。

- **ネイティブ・ヘッドレス**: `graphics/null` + `platform/nownd`（ウィンドウ無し）。コンソールサーバと同じ
  リンク集合。`BUILD_YSFLIGHT_CONSOLE_SERVER` が有効なネイティブで建つ。
- **決定論**: 固定 `dt=0.025`、固定 RNG seed（`srand(time(NULL))` を固定値に）。`FsWorld::SimulateOneStep` を
  **直接**呼び、実時間ベースの run loop（`PassedTime()`）を迂回する。
- 各ステップでプレイヤー機の位置・姿勢を CSV にダンプ → リファクタ前後で比較する golden 回帰網。
- 前提: null backend の `YsTextureManager::Unbind` スタブ（[public#1](https://github.com/tomingtoming/public/pull/1)）。
  これが無いとヘッドレスリンクが未定義シンボルで失敗する。

ビルドと実行:

```sh
cmake -S upstream/YSFLIGHT/src -B build-native -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build build-native --target ysflight64_harness -j$(sysctl -n hw.ncpu)
# 通常: 軌道CSVを出力
build-native/main_harness/ysflight64_harness [field] [airplane] [start] [nSteps] [out.csv] [seed]
# 例（空中スタートで即飛行）:
build-native/main_harness/ysflight64_harness PACIFIC_ATOLL A-4_SKYHAWK NORTH10000_01 2400 traj.csv 12345
```

環境変数で実証モードを切替（いずれもエンジン無改変、ハーネス側に実装）:
- `YSF_RENDER_SNAPSHOT=1` … レンダースナップショット（継ぎ目3）を JSONL 出力
- `YSF_EXPERIENCE=1` … サブクラス型の体験拡張（継ぎ目2）
- `YSF_SCRIPTED_EXPERIENCE=1`（+ `YSF_BUDGET=秒`）… コールバック駆動の体験（継ぎ目2のギャップ解消）

---

## 3. golden test の限界 ── バイト一致は安定系のみ、カオス系は許容誤差

実機で確認した重要な制約（再アーキ検証だけでなく、将来の Rust/TS 移植検証にも効く）:

- **同一バイナリ・同一入力なら決定論的**。地上/静止シナリオ（g1: RACING_VALLEY 地上, g2: PACIFIC_ATOLL 地上）は
  数千ステップ走らせても**バイト完全一致**。安定ダイナミクスは長尺でも再現する。
- **カオス系はバイト一致しない**。空中機動（g3: PACIFIC_ATOLL 空中スタート→60秒で墜落）は、微小な浮動小数点差が
  **約1ステップで発散**する。実際 g3 は環境の摂動で安定値が一度フリップした（スレッド・config・ASLR 等は切り分けで
  除外したが真因は未特定）。**カオス軌道のバイト golden は信頼できない** → 許容誤差比較か短ホライズンにする。
- **クロスツールチェーンは原理的にビット一致しない**（ネイティブ↔WASM、C++↔Rust/TS は FMA・演算順序・math ライブラリが
  違う）。移植の検証は**必ず許容誤差ベース**で、かつカオス増幅を踏まえ短ホライズンで。

> 関連: この「機械化された比較」の一般論は keel `theses/機械化された比較.md` 側でも扱う。

---

## 4. 切った継ぎ目

### 継ぎ目1 ── Update/Render の分離（エンジン本体の唯一の変更）

`FsSimulation::SimulateOneStep`（`src/core/fssimulation.cpp`）が物理積分と**描画準備**を混在させていた:
`focusAir` 選択・`needRedraw`・`DecideAllViewPoint`（カメラ視点・自動視点切替・雲内/フォグ判定、
ウィンドウ寸法問い合わせ）。

- これらを `PrepareRenderView()` に抽出し、物理ステップの外（sim ドライバ `RunSimulationOneStep` /
  `RunReplaySimulationOneStep` の、`SimulateOneStep` 呼び出し直後）へ移した。`SimulateOneStep` は純粋な物理更新に。
- **重要な構造的発見**: 描画経路 `DrawInNormalSimulationMode` は `const`（描画はシム状態を変えない）。
  一方 `DecideAllViewPoint` は視点状態を変更（非const）。だから視点準備は const な Draw の中に置けず、
  **Update と Draw の間（run loop）に座るべき**。これが継ぎ目の正確な位置。
- **検証**: harness は `FsWorld::SimulateOneStep` を直接呼ぶ＝ドライバを迂回するので、移設後は
  `PrepareRenderView` が harness では**一切走らない**。それでも安定軌道がバイト一致 → 視点準備は飛行物理に
  **無フィードバック**と実証。加えてネイティブGUIで free flight / コックピット視点を実プレイし、描画の違和感なしを確認。

### 継ぎ目2 ── 体験は既存の拡張APIで足せる（エンジン無改変）

`FsSimExtensionBase`（`src/core/fssimextension.h`）が「体験を足す」設計済みのフック層。

- フック面: ライフサイクル（`StartSimulation`/`EndSimulation`/`Start/EndReplay`）、毎ステップ
  （`OnInterval`/`Before/AfterSimulateOneStep`/`UseCustomTimeStep`）、制御上書き（`OverrideUserControl`/`OverrideRecording`）、
  勝敗判定（`MustTerminate`/`MustKeepRunning`）、イベント（`OnObjKilledByWeapon`/`OnObjGetDamage`/`OnMissileLaunch`/`OnChatMessage`）、
  2D HUD描画（`Draw2D`）、永続化（`Serialize`/`ProcessCommand`）。
- 登録: `FsSimExtensionRegistry`（ident→生成関数、`src/core/fssimextension.cpp:48` `RegisterKnownExtension`）、
  付与は `world->RegisterExtension(...)` や `.yfs` ファイル（`src/core/fsworld.cpp:1966` で ident から復元）。
- 実証済みの土台: 5つの組込みゲームモードがこの上に（`src/core/fssimextension_{racing,endurance,intercept,closeairsupport,groundtoair}.cpp`）。
- **実証**: デモ体験をハーネス側（=エンジン外）に書き、4フックを発火＋シムを早期終了させた。
  エンジンはそのクラスを知らず、ホストが `RegisterExtension` で差し込むだけ。

**2つのギャップ**（製品目的に対する伸びしろ）:
1. **コンパイル時のみ** ── `RegisterKnownExtension` が組込みをハードコード（ソースに作者の TODO
   `// How can I make it dynamic?`）。体験追加＝WASM 再ビルド。
2. **C++専用** ── Web/TS 開発者はC++を触らないと書けない。

#### 継ぎ目2のギャップ解消 ── コールバック駆動拡張（JS橋の設計）

1つの汎用クラス `FsSimExtension_Callback` が全フックをホスト供給の `std::function` に委譲。体験＝実行時に
渡す関数の束になり、**サブクラス不要・レジストリ編集不要・形だけの再ビルド不要**。

これが **JS/TS 橋の設計そのもの**: Emscripten ビルドでは `std::function` の口を JS 関数（`emscripten::val` /
`EM_ASM`）に繋ぐ。ネイティブではラムダが JS コールバックの代役。実証では `YSF_BUDGET=10` と `20` で
同一コードが実行時パラメータにより挙動を変えた（t=10s / t=20s 終了）。

### 継ぎ目3（土台）── バックエンド非依存のレンダースナップショット

描画バックエンド差し替え（Three.js / wgpu 等）の継ぎ目は、実は `YsVisualDnm` 抽象に既にある。本質は
「即時描画（毎フレーム `Draw`）」を「保持型シーングラフ（一度生成→変換更新）」へ変えること。

- その入力＝**GLフリーなレンダースナップショット**を、シムの**公開getterだけ**から抽出できることを実証
  （`src/main_harness/` の `WriteRenderSnapshot`）。中身: 機種ID（`GetIdentifier`）・位置・姿勢＋
  `FsAirplaneProperty::SetupVisual`（`src/vehicle/fsairplaneproperty.cpp:4271`）が DNM に流すアニメ状態
  （脚・フラップ・スポイラー・可変翼・操舵面・スロットル・逆噴射…。getter は `GetThrottle`/`GetElevator`/
  `GetAileron`/`GetRudder`/`GetLandingGear`/`GetFlap`/`GetSpoiler`/`GetControlVgw`/`GetThrustReverser` 等）。
- **現行のGL描画には一切触れない純加算**。GLフリーなので harness で動き、決定論的（2回ビット一致）。
- スコープ: 機体のみ・プレイヤーのみの**パターン実証**。完全な継ぎ目3には地上物・兵器・爆発・パーティクル・
  **地形（scenery の生GL 562箇所＝最難所）**のスナップショット化と、実際の保持型レンダラ構築が要る。

---

## 5. 現在地と次の一手

### 現在地

- PR: [tomingtoming/YSFLIGHT#2](https://github.com/tomingtoming/YSFLIGHT/pull/2)（弧全体）/
  [tomingtoming/public#1](https://github.com/tomingtoming/public/pull/1)（null `Unbind`）。fork の `emscripten` ブランチ宛。
- ブランチスタック（fork `tomingtoming/YSFLIGHT`、いずれも push 済み）:
  `feat/characterization-harness`（①ハーネス）→ `refactor/hoist-view-prep-out-of-sim-step`（②継ぎ目1）→
  `demo/experience-extension-api`（③継ぎ目2）→ `demo/render-snapshot-seam`（④継ぎ目3）→
  `feat/callback-driven-extension`（⑤callback拡張）。
- 注意: fork の `emscripten` はベース `353d34c` より先に進んでおり、`fssimulation.cpp` でコンフリクトの可能性。
  必要なら rebase。

### 次の一手

1. **JS橋の実装**（製品の本丸）── `FsSimExtension_Callback` をエンジン/emscripten port へ昇格し、4フック＋
   状態 getter（継ぎ目3のスナップショット）を JS に束縛。これで **WASM を再ビルドせず TS で体験を書ける**。
   ただし **emscripten ビルド＋ブラウザ**という新しい検証面が要る（ここまではネイティブのみ検証）。
2. **TS/Three.js レンダラ着手** ── 継ぎ目3のスナップショットを食う最小描画（地形は後回し、機体から）。
3. **実際の体験を1本、本物の機能として実装**（デモでなく）。

### 検証面のまとめ

| 対象 | 検証手段 |
|---|---|
| 物理（リファクタが挙動を変えていないか） | harness の golden（**安定シナリオのみ**バイト一致） |
| 描画（カメラ/視点） | ネイティブGUI（`ysflight64_gl2`）を実起動して目視 |
| 体験フック | harness の `YSF_EXPERIENCE` / `YSF_SCRIPTED_EXPERIENCE` |
| レンダー継ぎ目 | harness の `YSF_RENDER_SNAPSHOT`（決定論チェック） |
| JS橋（今後） | **emscripten ビルド＋ブラウザ**（未着手の検証面） |
