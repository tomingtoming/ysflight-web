# ysflight-web 航空機選択の遅延調査 (Aircraft-Select Slowness)

> ステータス: **調査済みの知見メモ（未修正）**。症状の主因・正確なトリガ・修正候補・確定診断手順を記録する。
> file:line は upstream エンジン (`upstream/YSFLIGHT` / `upstream/public`, emscripten ブランチ) と本リポジトリのもの。
> 調査日: 2026-06-21。多エージェント調査（5観点の独立深掘り＋敵対的検証）の結論。

## 症状

> 「航空機選択でめちゃくちゃ遅くなる時がある」── **間欠的**に、機体選択画面で一瞬フリーズする。

## 結論（先に要点）

主因は **「ある機体を初めてプレビューした瞬間の、同期的な `.dnm`/`.srf` パース＋VBO 構築スパイク」**。
単一スレッドの WASM では、この処理が 1 回の `requestAnimationFrame` コールバック内で完結するため
rAF をブロックし、ページが一瞬固まる。

当初もっとも重く見えた「毎フレーム シャドウ＋描画を焼き続ける」per-frame 説は **反証された**。
web ビルドの描画は dirty-gated で、メニュー画面では **選択変更時とプレビューの回転ドラッグ中だけ**
再描画される（アイドル時は CPU/GPU を焼かない）。

---

## 仕組み

航空機選択の 3D プレビューは `FsGuiChooseAircraft::Show`（`fschoose.cpp:2671-2681`）が
**毎フレーム**呼ぶ `DrawAirplane`（`fsguiselectiondialogbase.cpp:128-255`）。
ただし選択リストが **1000ms 以上変化していない時だけ**描画するデバウンスが入っている
（`airLbx->GetLastChangeClock()+1000 < FsGuiClock()`）。同じプレビュー描画は
New Flight ダイアログ（`fsguinewflightdialog.cpp`）と `fsguicommondialog.cpp` からも呼ばれる。

---

## 原因ランキング

| 順位 | 原因 | 深刻度 | 「時がある」のトリガ |
|---|---|---|---|
| **1（主犯）** | 初回プレビューの同期ロードスパイク | prime-suspect (0.83) | **そのセッションで初めて選ぶ重い機体の 1 フレームだけ** |
| 2（寄与） | 初回フレームの O(N) 線形スキャン＋シャドウ/描画 | contributor (0.5–0.62) | 選択確定フレーム＆回転ドラッグ中 |
| 3（条件付き） | パック多数時の検索/フィルタ O(N²) | contributor (0.7) | 大量パック導入時の**検索タイピング**（クリック遅延とは別経路） |
| 棄却 | フィールド `.fld` 再パース | not-it (0.2) | 機体チューザに `ReloadField` が無く症状違い |

---

## 1. 主犯 ── 初回プレビューの同期ロードスパイク

`DrawAirplane` が、選択が 1 秒安定した後の描画フレームで未キャッシュ機体に当たると、
**1 tick 内で**順に同期実行する：

1. **`.dnm` 行単位テキストパース** ── `world->GetAirplaneVisual` → `FsAirplaneTemplate::GetVisual`
   （`fsworld.cpp:242-244`, `if(nullptr==vis) vis.Load(...)`）→ `FsVisualDnm::Load`
   （`fsvisual.cpp:54-58`, ブロッキング `YsFileIO::File fp(fn,"r")`）→ `YsVisualDnm::Load`
   → `ReadDnmOneLine` ループ。
2. **全ノード法線方向修正** `FixOrientationBasedOnAssignedNormal`（O(#polygon) 線形）。
3. **初回描画の遅延 VBO 構築（支配項）** ── 最初の `vis.Draw()`（`fsguiselectiondialogbase.cpp:245-249`）で
   各ノードが `!IsPolygonVboPrepared()` を踏み、`RemakePolygonBuffer`（CPU テッセレーション）＋
   ノードあたり ~8 回の `glBufferData` アップロード。VBO 構築を load 時に遅延させる設計なので、
   初描画フレームに全部乗る。

### 「sometimes」の正体 ── 初回限定

`vis` は mutable メンバにキャッシュされ（`fsworld.cpp:242-252`）、`ResetAircraftList`
（`fschoose.cpp:2683+`）はリストボックス UI を作り直すだけでキャッシュを破棄しない。
よって**再選択は無料** ── 「初めての機体だけ固まり、戻ると速い」という間欠性の正体。

### 機体依存（add-on 機だけの問題ではない）

stock 同梱機ですら `.dnm` は 14KB〜868KB（中央値 ~52KB、p90 ~182KB）の幅がある。
`concorde.dnm`=43,202 行、`lancaster`=26,637 行、`hurricane`=370KB。粗いモデル（~2-4k 行）との差は
**stock 内だけで 10〜60 倍**。だから「重い stock 機を初めて選んだ瞬間」にも固まり得る。

### web 固有の増幅

web ビルドは単一スレッド（`-pthread`/`PROXY_TO_PTHREAD` なし、`YsThreadPool` はインラインフォールバック）。
パース＋法線修正＋`glBufferData` を**ワーカーオフロード不能なまま 1 rAF tick が専有**し、
ネイティブならサブ ms の処理が WASM では数十 ms に膨らむ。さらに大きな `.dnm` 確保は
`-sALLOW_MEMORY_GROWTH` の単一ヒープを圧迫し、フレーム途中の JS GC ポーズも誘発しうる。

---

## 2. 寄与 ── 初回フレームの線形スキャン＋シャドウ/描画

`DrawAirplane` 内で `FindAirplaneTemplate`（`fsworld.cpp:2279-2306`、全テンプレートを
`strcpy`＋`YsCapitalize`＋`strncmp` で線形走査）が **`2 + 2×FSWEAPON_NUMWEAPONTYPE` ≈ 98 回/フレーム**
呼ばれる（`GetAirplaneTemplate` + `GetAirplaneVisual` + 武器 override 48×2）。
N=stock 88 なら 98×88≈8.6k strncmp で無視できるが、**パック多数で N が数百〜数千になると 98×N に膨張**。

シャドウは `FsIsShadowMapAvailable()` が web gl2 ビルドで YSTRUE のため、
`DrawAirplane:173-225` が `MAX_NUM_SHADOWMAP=3` の 3×2048² デプス FBO clear ＋ フル DNM 描画 ＋
2 メインパスを行う。**ただし毎フレーム燃え続けるのではなく**、描画は dirty-gated
（`fslazywindow_emscripten.cpp:117-120` の `Draw()` は `FsCheckWindowExposure()!=0 || NeedRedraw()` 時のみ）で、
`FsGuiChooseAircraft` が needRedraw を立てるのは **選択変更とマウスドラッグ回転（`fschoose.cpp:2307`）だけ**。
自動回転タイマーは無い。よってこのコストは **①初回選択確定の描画フレーム、②プレビューを回転ドラッグしている間**に体感される。

注: 武器シェイプ override の lazy load は、`prop->GetWeaponShapeFile()` が空なら即 `nullptr` 返し
（`fsworld.cpp:364-388`）。大半の武器タイプは空なので、当初の見立てより軽い。

---

## 3. 複合効果

3 軸が同時に最悪化するケース ──「アルファベット後方の重い add-on 機」を「大量パック環境」で「初めて」選ぶと、
1 フレームに **(a) 98×N の線形スキャン ＋ (b) 巨大 `.dnm` の同期パース＋VBO 構築 ＋ (c) その重いジオメトリの 5 パス描画**
が乗る。

### 反証で潰した誤仮説

- **`FsVisualDnm` の値コピーが重い** → 誤り。`YsVisualDnm` は `std::shared_ptr<Dnm>` を保持
  （`upstream/public/src/ysgebl/src/shellrender/ysvisual.h:123`）するため、値コピーは
  **参照カウント増加のみで安価**。
- **毎フレーム シャドウ＋描画を焼き続ける** → 誤り。描画は dirty-gated（上記 §2）。
- **フィールド `.fld` 再パース** → 症状違い。機体チューザには `DrawField`/`ReloadField` が無い。

---

## 4. 修正候補（小さく効く順）

1. **【最小・最効】プリウォーム** ── 選択ハイライト時点で `requestIdleCallback` 等を使い、
   `DrawAirplane` 到達前に `GetAirplaneVisual`＋パースを先行実行。クリティカルパスからロードを外す
   （`fschoose.cpp:2671` 付近の選択変更ハンドラ、1000ms デバウンス手前）。
2. **【小】VBO 構築のフレーム分割** ── 時間予算でノード単位にスライス。最初の 1–2 フレームは
   `GetLod()`（粗い LOD DNM）またはプレースホルダで描き、温まったらフル詳細へ差し替え。
3. **【小】プレビュー専用にシャドウパス無効化** ── `fsguiselectiondialogbase.cpp:173-225` を
   preview モードでスキップ。小さな中央配置モデルにシャドウの視覚的価値は低く、非力 WebGL GPU の
   3×2048² パスを丸ごと削れる。
4. **【中】98 回スキャンを 1 回に集約＋ハッシュ化** ── 選択が変わった時に template / visual /
   weapon-override 配列を**一度だけ解決してダイアログにキャッシュ**（typeName は静止中は不変）。
   さらに `FindAirplaneTemplate` を capitalize 済み `idName` キーの hash map にして O(1) 化。
5. **【条件付き・パック多数向け】チューザのフィルタ O(N²) 解消** ── `LoadAirplaneTemplateList` 完了後に
   `airplaneTemplate.Encache()` を 1 回呼ぶ（`fsworld.cpp:2470` 付近）だけで `GetItemFromId` が O(1) 化。
   加えて `OnTextBoxChange`（`fschoose.cpp:2271`）を 150–200ms デバウンス。※検索タイピングの遅さの修正で、
   機体クリックの遅さとは別問題。

---

## 5. コーディング前の確定診断（in-browser）

**手順 1 ── Performance プロファイルで「初回 vs 再選択」を比較**

DevTools → Performance → 記録開始。航空機チューザで (a) **これまで開いていない重い機体**
（concorde, lancaster, 大型 add-on）を選んで 1 秒静止 → プレビュー表示。続けて (b) **同じ機体をもう一度**選択。記録停止。

- (a) に**数十〜数百 ms の長い 1 フレーム**が現れ、その Main スレッドの中身が
  `LoadDnm`/`ReadDnmOneLine`/`RemakePolygonBuffer`/`glBufferData`（WASM シンボル名で見える）で占められていれば
  **主犯 = lazy-load-spike 確定**。(b) でそのスパイクが消えれば「初回限定キャッシュ」仮説も同時に裏取り。
- (a) のスパイク内に `FindAirplaneTemplate`/`strncmp`/`YsCapitalize` が積み上がっていれば、
  線形スキャン項（パック多数）の寄与が大きいサイン → 修正 4・5 の優先度を上げる。

**手順 2（補助）── 回転ドラッグで描画コストを切り分け**

プレビューを**ゆっくり回転ドラッグ**したとき、毎フレーム ~16ms 超が連続するなら
シャドウ/描画のステディコスト（修正 3）が体感ジャンクに効いている証拠。
スパイクが初回 1 発のみなら描画でなくロード（修正 1・2）が本命。

---

## 推奨アクション

まず手順 1 の (a)/(b) 比較を実行し、長いフレームの中身が DNM パース/VBO 構築なら、
**修正 1（プリウォーム）から着手**するのが最小コスト・最大効果。
