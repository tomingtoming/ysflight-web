# ブラウザ・ワークベンチ設計 (Browser Workbench Design)

> ステータス（2026-07-08 起草）: MVP＝**機体のlooseファイル組み立て＋取り込み診断＋実エンジン即テスト飛行**。
> 本書は設計記録。実装は `web/workbench.js`（組み立てコア）＋ `web/packs-ui.js`（UI）＋
> 既存パイプライン（`web/packs.js`、[addon-packs.md](addon-packs.md)）の上に載る。

## 何であるか

パックを**組んで・検証して・実エンジンで即飛ばす**ためのブラウザ内作業台。

デスクトップの制作ツール群（モデラ、Pack Assembler 系のリンタ等）が構造的に持てない一点が
「**組んだものをその場で実エンジンに食わせて飛ぶ**」であり、ブラウザ移植だけがこれを足せる。
ワークベンチはその一点に集中する。既存デスクトップツールの再実装はしない（プロの工程は
デスクトップが正、ここは補完）。

## 何でないか

- **モデラではない**。.dnm/.srf の造形はスコープ外（既存ツールで作る）。
- **配布層ではない**。ワークベンチは作者が自分の手元で組む道具であり、誰のバイトも
  再配布しない。配布・同意ゲート（`redistributable`、Endorsed/Loadable の2枚のドア）は
  別トラックで、そちらの実装順序（同意ゲートが先）に従う。
- **新フォーマットではない**。出力は「取り込みパイプラインの正規形をそのまま zip 化したもの」
  （= native 形式、[addon-packs.md](addon-packs.md) §3）。

## MVP の切り方（2026-07-08 裁定）

- **一人目の作者＝自分（と家族）**。入口は loose ファイル（zip も .lst も無い
  .dat/.dnm/.srf の一山）、UI は日本語/英語の既存 i18n に従う。pack.json
  （author/license/redistributable）の発行は後段＝配布トラックとセットで。
- **反復はリロード式**。編集→再取り込み→ `?freeflight=<IDENTIFY>` 付きリロードで数秒/回
  （.data は SW キャッシュ済み）。ホットリロード（エンジンのテンプレート差し替え）は
  エンジン fork 改変が要るため MVP に含めない。

## 4つの面

| 面 | 内容 | MVP |
|---|---|---|
| **In（受け口）** | 既存 zip（稼働済）＋ **loose ファイル組み立て**（新規） | ✅ 機体のみ |
| **Check（検証）** | 取り込み診断の可視化（参照未解決の件数と実例） | ✅ 最小 |
| **Fly（即飛行）** | 導入済みパックの機体ごと「テスト飛行」→ `?freeflight=` リロード | ✅ |
| **Out（発行）** | pack.json（author/license 必須・`redistributable` は既定 false）付き zip 書き出し | ⏳ 配布トラックと同期 |

## アーキテクチャ: loose → zip 合成 → 既存パイプライン

loose ファイルの組み立ては**ブラウザ内で正規形の zip を合成し、既存の取り込み経路
（`analyzePackStreaming` → OPFS → 遅延 materialize）にそのまま流す**。

- 新しい取り込み経路を作らないので、content-hash id・blob 重複排除・有効/無効・
  アンインストール・MP マニフェストの**全不変条件を無償で継承**する。
- 合成 zip はそのままダウンロード可能な native パック＝Out 面の土台が最初から埋まる。
- zip 合成は vendored fflate の `zipSync`（unzip と同居、追加依存なし）。

### 機体スロットと .lst 行の契約（エンジン準拠）

`LoadAirplaneTemplateList`（fsworld.cpp:2585）は 1 行あたり **最低 3 トークン**、位置固定:

```
<dat> <可視dnm> <当たりsrf> [<コックピットsrf> [<遠景dnm>]]
```

- 必須スロット: **.dat（飛行特性）・可視 .dnm・当たり判定 .srf**
- 任意スロット: コックピット .srf、遠景 .dnm（**遠景はコックピットがある時だけ**
  5 番目に置ける。位置固定で空プレースホルダの前例が stock に無いため、
  コックピット無しで遠景だけ指定された場合は警告して落とす）
- スロット推定ヒューリスティック（stock の命名慣行）: `coll` → 当たり、`cock/inst` →
  コックピット、`coarse/lod` → 遠景。曖昧なら UI のセレクタで人間が確定する。
- IDENTIFY は .dat から抽出（既存 `parseDatIdentity`）。取れれば `.lst.idx` サイドカーの
  高速経路とテスト飛行ボタンの両方に効く。無ければ警告（エンジンは .dat を読む
  レガシー経路で動くが、テスト飛行ボタンは機体名を指定できない）。

### テスト飛行（Fly）

- エンジンの `-freeflight <air> <fld> <stp>`（fscmdparaminfo.cpp:115）→ web シェルの
  `?freeflight=AIR[,FLD[,STP]]`（既定 ATSUGI_AIRBASE / NORTH10000_01）は**実装済み**の経路。
  ワークベンチはこれに乗るだけ（エンジン改変ゼロ）。
- 機体名の出所は生成済み `.lst.idx` サイドカー（`packs/<id>.json` レコードの generated に
  保持済み）＝ UI はレコードを読むだけで機体一覧を出せる。
- 検証の前例: `Airplane:<name>` コンソール行は freeflight が機体テンプレートを解決した
  時だけ出る（smoke-pack / smoke-mp-join で実証済みのプローブ）。smoke もこれで組む。

### 診断（Check）

`buildGeneratedLists` の書き換え結果（resolved/missing）は従来集計後に捨てていた。
これを analyze 結果に `diagnostics`（未解決参照の件数＋実例の先頭 N 件）として載せ、
取り込み完了メッセージに「⚠ 参照 n 件が未解決」を出す。**取り込み自体は従来どおり
成功させる**（エンジンは欠けたエントリを Cannot Load でスキップして生き続ける——
挙動は変えず、見えなかったものを見せるだけ）。

## 第五波（2026-07-08 同日実装）: Polygon Crest ファイルブリッジ（P1）

- **OPFSステージング（`web/staging.js`・`workbench-staging/`）が2つのwasmページの橋**:
  モデラ（modeler.html）で保存した .srf/.dnm/.dat は、ブリッジ（`web/modeler-bridge.js`＝
  2秒のVFS stat-walkで新規/更新を検出。Emscripten FSに変更通知は無いがpreload外の
  ツリーは数ファイルなので実質無料）が自動でステージングへ送り、ワークベンチの
  機体組み立てに「🧊 モデラから届いたファイル」として並ぶ（タブ復帰で自動更新）。
- **逆方向**: モデラ起動時にステージングの全ファイルを `/home/web_user/workbench/` へ
  取り込み（File→Openで見える）。取り込んだ分は mtime を記録してエコーバックしない。
- これで **ブラウザだけで「モデリング（Polygon Crest）→ 組み立て → 自分の島に降りる」が
  一周する**。ステージング（loose作業ファイル）と blob ストア（content-addressed な
  パックpayload）は意図的に別物。
- **ファイル入出力の接続先＝OPFSステージングを「モデラのファイル置き場の正」とする**
  （2026-07-09 設計確定）。理由: (a)保存は自動でステージングに残る＝VFSがリロードで
  消えても保存済みの物は失われない (b)ワークベンチと同一の面＝導線が1本 (c)IDBFS常時
  マウントや File System Access API より単純。出入り口: 持ち込み=ワークベンチの
  「＋ファイルを送る」／持ち出し=staged の ⬇ ダウンロード／作品→モデラ=ライブラリの
  🧊（payload の .dnm/.srf をステージングへ）。ローカルディスク直結（FS Access API）は
  需要が立ってから。
- **右クリック**: Polygon Crest の標準ビュー操作は **SHIFT+右ドラッグ=回転・SHIFT+
  両ボタン=ズーム**（fsgui3dviewcontrol.cpp SetMouseStateYsStandard）＝右クリックは
  本質的に必要。modeler.html が canvas の contextmenu/auxclick を preventDefault。

## 第四波（2026-07-08 同日実装）: マイ作品ライブラリとレシピ再編集

- **統合管理（toming「機体やシーナリー生成を統合的に管理できないか」）**: workbench.html の
  先頭に「📦 マイ作品」——OPFSレコードの一覧（種別バッジ・有効無効・🛫・✏️・🗑）。
- **レシピ＝作成パラメータをパック内に同梱**（`workbench.json`。エンジンは読まない・
  content-hash idの一部になる）。これで✏️再編集が成立: **マップは全島がcanvasに戻り
  続きから描ける**、機体はスロット割当と（wizard製なら）ノブのレシピが復元される。
  機体のlooseファイル実体はパックpayload（OPFS blob）から読み戻す＝別途の保管庫を作らない。
- **保存＝置換の意味論**: 再編集の保存は新しいcontent-hash idでinstallし、旧レコードを
  削除（id不変＝内容不変ならno-op）。「上書き保存」がcontent-addressingと両立する形。

## 第三波（2026-07-08 同日実装）: 専用ページ化と「島を描く」

- **専用ページ `workbench.html`（toming裁定「作るのは別の専用の場所で」）**: 作成系UIを
  ゲーム起動パネルから全撤去し、**エンジン非搭載の専用ページ**に移設。成立の鍵は
  **パックの真実がOPFSレコード**であること——ゲームページはboot時に全レコードを
  materializeするので、ワークベンチで作った物は「次にゲームを開いたら存在する」。
  ページ間の統合はリンク1本（`?freeflight=` で即飛行）。stock機体はビルド時に
  `dist/stock/`（index.json＋.dat）へ静的出力（`scripts/gen-stock-index.mjs`）＝
  25MBのwasm preloadなしで .dat ウィザードが動く。
- **島を描く**: canvasに海岸線をドラッグで描く→ストロークが多角形化→
  `assembleSceneryZip({islands})` が **PC2（見た目・凹多角形OK＝エンジンが読み込み時に
  三角形分割）＋ PST `AREA LAND`（DEFAREA WATERを上書きする陸判定＝降りられる）** を
  .fld に直書き。TER無し＝BASEELV 0mの平坦島。**PCKの行数は埋め込みテキストと厳密一致が
  必須**（ローダが行数で数えてOUTSIDEに戻る）＝単体テストの主検査点。
  マップは16km四方、START位置は島が機首前方に来るよう6km南から北向き。
- **接地判定の根拠**（yssceneryio.cpp / ysscenery.cpp 実調査）: 見た目=PC2（判定に無関係）／
  陸水=PST AREA（`GetAreaTypeFromPoint` はPSTループ内側を返しNOAREAならDEFAREA）／
  標高=TERのみ（無ければ `baseElevation`）。三者は完全に直交。

## 第二波（2026-07-08 同日実装）: .dat ウィザードとシーナリーウィザード

MVP と同日に2機能を追加。どちらも**エンジン改変ゼロ**（実ソース調査で確定した事実に立つ）。

### .dat ウィザード（「dat の面倒を見る側」）

- **事実**: `/ysflight` の preload は fsReady（pre-boot）時点で全て読める＝stock 88機の
  `air*.lst`→`.dat`→IDENTIFY が pure JS で列挙できる（実測済み）。
- **形**: 元になる stock 機体を選ぶ→新しい名前→倍率ノブ4つ（エンジン出力=THRAFTBN/THRMILIT/
  PROPELLR・機体の重さ=WEIGHCLN・最高速度=MAXSPEED・操縦の鋭さ=CPITMANE/CROLLMAN/CYAWMANE）
  →生成 .dat が機体組み立ての dat スロットに入る。
- **安全設計**（fsairplaneproperty.cpp の実調査より）: (a)**未知キーワードは1行でもあると
  .dat 全体がロード失敗**するので、編集は既存行の in-place 数値スケールのみ・行の追加はしない
  (b)値は「数値+単位トークン」なので数値だけスケールすれば単位が保存される（倍率方式の理由）
  (c)IDENTIFY はエンジンと同じ正規化（空白/引用符→`_`・大文字化・31字）をUI側で先に適用し、
  stock＋導入済みパックとの重複を警告（FindAirplaneTemplate は先勝ち＝重複は片方を黙って影にする）。

### シーナリーウィザード（「マップを作る」）

- **事実**（yssceneryio.cpp / sescenery.cpp の実調査より）: `.fld`/`.stp` は**完全な行指向
  テキスト**。エンジンが受け付ける最小フィールドはヘッダ8行（`FIELD`/`GND`/`SKY`/
  `GNDSPECULAR`/`DEFAREA WATER`/`BASEELV`/`MAGVAR`/`CANRESUME`。ENDF は省略可＝EOF終端）、
  START は .stp 側 6行。**＝JS直書きで生成できる。SeScenery は不要**。
- **形**: 名前＋地面/海の色＋空の色＋開始高度→ `sce_<name>.lst`（`IDENT fld stp` の3トークン、
  飛べる実績のある scnpack fixture と同形）＋ `.fld` ＋ `.stp` を zip 合成→既存パイプライン→
  「🛫 このマップで飛ぶ」（`?freeflight=<機体>,<IDENT>,START01`）。
- **SeScenery の位置づけ**: `ysscenery_dnm`（sescenery.cpp 含む）は**現行 web ビルドに
  リンク済み＝追加コストゼロ**で extern "C" 露出できるが、要るのは標高グリッド（TER）や
  地上物（GOB）の動的追加・Undo付き双方向編集をやる段になってから。滑走路は GOB 参照
  （`FSGROUNDTYPE_RUNWAY` テンプレート）で足せるのが次の一手（テンプレート名の調査が前提）。

## upstream/public に眠る資産（2026-07-08 調査・将来拡張の弾薬庫）

upstream/public には **Polygon Crest（YSFLIGHT 公式 3D モデルエディタ ysgebl）のソース一式**が
含まれており、GUI エントリポイント（`src/ysgebl/src/main/`）と CLI（`geblcmd`）以外は
**EMSCRIPTEN ビルドでも全部ライブラリとしてビルド・リンクされている**（`geblkernel` は
`platform_emscripten` の直接依存）。つまり以下は「移植」でなく「露出」の距離にある:

| 資産 | 中身 | ワークベンチでの使い道 |
|---|---|---|
| `geblkernel` | `YsShellDnmContainer::LoadDnm/SaveDnm`（木構造・アニメ状態込み）、`YsShellExtReader::MergeSrf`／`SaveSrf`。DNM/SRF/OBJ/STL/PLY/OFF 対応（`kernel/ysshelldnmtemplate.h`, `kernel/ysshellextio.h`） | DNM の参照整合性検証、ノード一覧の取得、（将来）OBJ→SRF 変換の受け口 |
| `geblutil` | `CheckNonManifoldEdge`／`CheckSelfIntersection`／`CheckNonPlanarPolygon`（`kernelutil/ysshellext_diagnoseutil.h`） | Check 面の第二段＝**ジオメトリ診断**（Polygon Crest の修復メニューと同じ実績コード） |
| `geblgl(_gl2)` | `YsShellExtDrawingBuffer`→VBO→GLES2 描画。最小サンプル `samples/YsShellExt/main.cpp`（SRF 読んで描く） | **ブラウザ内 DNM/SRF 単体プレビュー**、オフスクリーン FBO＋`ysbitmap` の `SavePng` で**サムネイル生成**（pack.json の thumbnail 供給元） |
| `geblgui`（`gui/dnm/dnmpreview.cpp`） | DNM アニメプレビュー（ギア/VG翼/フラップのスライダ UI）。ライブラリはビルド済みだが `fslazywindow` の GUI ループ初期化が別途要る | 後段の「ブラウザ内 DNM アニメプレビュー」 |

含意: ワークベンチの Check 面（ジオメトリ診断）と「プレビュー/サムネイル」拡張は、
新規実装でなく **既に wasm 内に居るコードへ JS→wasm の口を生やす作業**。さらに言えば
Polygon Crest 本体のブラウザ移植（＝ブラウザ内モデラ）すら構造的には視野に入る——
ただしそれは別企画級のスコープであり、需要が立ってから。

## 将来（需要が立ってから・順不同）

- **Out 面の完成**: pack.json エディタ（author/license 必須・`redistributable` 既定 false
  = fail-closed、[配布と作者同意の設計](https://github.com/tomingtoming/ysflight-web) 側の
  ゲート設計に従う）＋ zip 書き出しボタン。
- **フォルダ監視**: File System Access API でローカルフォルダを掴み、テスト飛行のたびに
  再取り込み（Chromium 系限定の糖衣。リロード式の上に載る）。
- **ホットリロード**: エンジン fork にテンプレート置換（現状 append 専用、
  fsworld.cpp:2144）を足して無リロード反復へ。
- **シーナリー組み立て**: .fld の内部参照の隔離問題（[addon-packs.md](addon-packs.md) §3）
  を解いてから。
- **load-URL 共有**（Loadable の門）: 自己ホスト zip の URL 取り込みは実装済み。
  「組んだパックを URL で人に渡す」導線の明文化はエコシステム叩き台の議論と同期。
