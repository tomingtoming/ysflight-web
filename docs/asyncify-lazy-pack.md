# ysflight-web ASYNCIFY 遅延パック — サイズ削減と容量上限の構想 (Lazy-Pack: Size & Capacity)

> ステータス: **実装済み機能の知見メモ＋未着手の最適化/構想**。無制限パックの本命解
> (`__syscall_openat` の ASYNCIFY 化) は PR [#47](https://github.com/tomingtoming/ysflight-web/pull/47)
> で実装・デプロイ済み。本ドキュメントは「その後に残った2つの宿題 — wasm サイズ削減と、
> プレイ中 RAM の真の容量上限 — の調査結果と将来構想」を保全する（うち **プレイ中 RAM の容量上限は
> layer3 LRU unload として実装済み**。`web/memfs-lru.js` ＋ `web/packs-ui.js` 配線、JS のみ・wasm 再ビルド不要。下記）。
> file:line は本リポジトリと upstream エンジン (`upstream/YSFLIGHT`, emscripten ブランチ) のもの。
> 調査日: 2026-06-24。

## 背景 — 遅延パックの仕組み（実装済み）

「無制限パック」は **classic FS(MEMFS/IDBFS) + ASYNCIFY=1** で解いた。エンジンの同期 `fopen` は
すべて `__syscall_openat` に集約されるので、これを JS ライブラリで上書きし
(`src/port/ysfw_openat.jslib`、`__async:'auto'`)、`/packs/<id>/...` が MEMFS に未在なら
`globalThis.ysfwMaterializeForOpen(path)` を **await** してから本来の open に委譲する。ASYNCIFY が
fopen を suspend → materialize 完了 → resume する。demo・飛行・選択の全経路を一点でカバーする。

ビルドフラグは `upstream/YSFLIGHT/src/main/CMakeLists.txt:595-617`（`-sASYNCIFY=1`,
`-sASYNCIFY_STACK_SIZE=16384`, `--js-library .../ysfw_openat.jslib`, `EXPORTED_RUNTIME_METHODS` に
`Asyncify`）。

boot 時は **メタ(.lst/.dat/.stp)だけ** materialize し（`web/packs-ui.js` `materializeEnabled`）、
重いペイロード(.dnm/.srf/.fld…)は openat フックでオンデマンドに OPFS→MEMFS コピーする
(`web/opfs-store.js` `materializeFile`)。

---

## 宿題1: wasm サイズ削減（未着手・急がない）

### 実測（emsdk 6.0.0, ローカル relink, 2026-06-24）

| 構成 | wasm | 備考 |
|---|---|---|
| ASYNCIFY 全計装（現行出荷, PR#47） | **4,909,258 (4.9M)** | 計装ユニーク関数 約2,118 |
| `-sASYNCIFY_IGNORE_INDIRECT=1` 単体 | **3,648,353 (3.65M)** | 機会上限。ただし **unsafe**（後述） |
| ASYNCIFY 前ベースライン | ~3.1M | |

→ 安全に詰めれば最大 **−1.26M (−26%)** の余地。残る +0.55M は openat から直接到達する
真に必要な計装で、ここは削れない。

### 肥大の正体（`-sASYNCIFY_ADVISE=1` の出力分析）

計装の root は2つだけ:
- 実 async import 2点: `__syscall_openat`（本物）, `__syscall_poll`（emscripten 既定の IMPORTS。
  本プロジェクトの jslib では suspend しないが、状態変更源として保守的にシードされる）
- **indirect/virtual call の保守的シード 551関数**（"can change the state due to initial scan"）

そこから `operator new`（throwing 版が `new_handler` を indirect 呼び出し）・printf 系・
`__dynamic_cast`（vtable walk）・`YsArray`/`YsString` 等の **libc/libc++ 遍在ハブ**経由で
約2,100関数へ伝播する。これらハブは **openat に絶対到達しない偽陽性**。つまり肥大の主因は
「仮想関数だらけのエンジンを indirect-call 保守解析が丸ごと巻き込む」こと。
`ASYNCIFY_IGNORE_INDIRECT` を単純に付けると、ロード経路の仮想ディスパッチ祖先まで計装が外れ、
**resume 時にスタックが壊れる**ので単体では出荷不可。

### 安全な削減法

`-sASYNCIFY_IGNORE_INDIRECT=1` + `-sASYNCIFY_ADD=@list`。list = 「実際の openat unwind スタックに
載る indirect 関数の和集合」を**実測**して与える。

安全網: 本ビルドは `-sASSERTIONS=1`。ASYNCIFY+ASSERTIONS では rewind 時に「計装外コードがスタックに
載っている危険状態」を検知して **loud abort** する（emscripten ChangeLog v1.39.9）。つまり ADD 漏れは
静かなスタック破壊ではなく **abort** になり、`scripts/smoke-test.mjs` / `smoke-pack.mjs` の
`/Aborted\(/` fatal 判定で捕捉できる。

### 自動 capture 手順（着手して中断中）

1. `ASYNCIFY_DEBUG`（`tools/emsdk/upstream/emscripten/src/lib/libasync.js`）ビルドで unwind 関数名を採取。
2. `smoke-test.mjs`（boot/demo を駆動）+ `smoke-pack.mjs`（テストパック install→play→scan を駆動）で
   主要経路を自動巡回し ADD 候補を集める。両者は `Cannot Load`/`Aborted`/`RuntimeError` を fatal 判定する
   ので**回帰検知のゲート**にもなる。
3. `IGNORE_INDIRECT=1 + ASYNCIFY_ADD=@list` で relink → サイズ測定 → smoke で resume クラッシュ無しを確認。

**smoke では駆動されない経路**（interactive flight・機体選択プレビュー・replay・scenery 差分）は
**実機巡回が必要**。ただし漏れても上記 ASSERTIONS で abort して気づける。

> リスク評価: 静的推測だけでリストを組むと稀な経路で踏み抜く。実測 + ASSERTIONS + smoke 回帰で
> 「漏れたら気づく」状態を作ってから絞るのが正攻法。腰を据えた作業で、急がない。

---

## 宿題2: 容量上限 — 警告は化石、真の上限はプレイ中 RAM

### 診断: boot 時の「容量上限」警告は ASYNCIFY 前の遺物

UI 警告「N個のアドオンは容量上限を超えたため読み込まれませんでした。…無効化すると読み込めます」
（`web/index.html` `packsSkipped`、EN: "over the memory budget … make room"）は、
**ASYNCIFY 前の MEMFS 一括展開バジェット時代の文言**。

コード実態（`web/packs-ui.js` の `materializeEnabled`）:
- enabled な全パックの**メタを無条件にロード**する。**boot 時の容量バジェットはもう存在しない**。
- skip するのは `reason:'error'`（メタ materialize の失敗）**だけ**。`__ysfwMaterializeSkipped` の中身は
  容量超過ではなく**エラー**。

→ ユーザーには「容量が足りない、無効化しろ」と表示されるが、実際は**そのパックの取り込み解析が
リストを見つけられていない**（容量とは無関係）。無効化しても解決しない誤誘導。真因はほぼ
「取り込み時にリストが見つからない非標準名/配置（`aircrafts_of_gac.lst` 等）」。

### 真の容量上限: セッション中の MEMFS(RAM) 単調増加

オンデマンド materialize は OPFS→**MEMFS（= wasm linear memory = RAM）**へコピーする。かつては
**eviction が無く**、多数のパックを跨いで長時間飛ぶと RAM が単調増加し、いずれ ~2GB（wasm32 +
`ALLOW_MEMORY_GROWTH` の既定上限 = `MAXIMUM_MEMORY`）の linear-memory 天井に当たって abort した。
**boot ではなくプレイ中に効く、これが本物の容量上限。**
→ **layer3 の LRU unload（下記）で解消済み**: `web/memfs-lru.js` が追跡ペイロードを高水位で LRU evict し、
消えたファイルは次の open で openat フックが透過再 materialize するため、RAM は有界になった。

### 将来構想 3層

1. **layer1（誤誘導除去・済）**: `packsSkipped` を真因（取り込みデータの解析失敗→再取り込み）に書き換え、
   バナーにパック名をインライン表示、stale コメント2箇所（`index.html` の旧 budget 言及）を修正。
   → 本コミットに含む（`web/index.html` のみ）。
2. **layer2（根治・中）**: 取り込み解析（`analyzePack`）が非標準なリスト名/配置を拾えるようにする。
   「3個落ちる」の根本治療。
3. **layer3（真の無制限・大／実装済み）**: **Phase 3 LRU unload**。materialize 済みペイロードに
   アクセス時刻（単調カウンタ）と byte サイズを記録し、追跡合計が高水位 (`highWater`) を超えたら LRU 順に
   `FS.unlink` して低水位 (`lowWater`) まで落とす。消しても**次の open で openat ASYNCIFY フックが OPFS から
   透過再 materialize** するので安全（「消す→次の open で勝手に戻る」既存基盤の再利用。openat フックは
   出荷済みなので **JS のみ・wasm 再ビルド不要**）。これでインストール数・総容量に関係なく **RAM が有界**
   になり、真の無制限パックが完成する。
   - 実体: `web/memfs-lru.js`（純粋・依存ゼロ・node テスト可、`test/memfs-lru.test.mjs`）＋ `web/packs-ui.js`
     配線（`trackMaterialized` / `sweepLru`、`ysfwMaterializeForOpen`・`ysfwOnChoiceHighlight` の materialize
     直後に sweep。`residentInFlight` で in-flight open のファイルを evict から保護）。
   - 既定 **highWater 768MiB / lowWater 512MiB**、`window.__ysfwMemfsBudget = { highWater, lowWater }`（bytes）で
     上書き可。高低差 256MiB ≫ 単一ペイロードファイル（MB級）なので、直近 materialize 分は決して victim に
     ならない。
   - メタ（.lst/.dat/.stp）は**ピン留め**で evict しない: `.lst` はエンジンの glob で発見されるため、消すと
     メニューから黙って消える（payload と違い openat 経由で戻らない）。
   - 閾値は `Module.HEAP8.length` ではなく**追跡ペイロード合計**で測る — linear memory は縮まないので前者だと
     一度超過したら無限 evict になる。後者が「実際に解放できてヒープ成長圧を下げられる」唯一のレバー。
   - ビルド: 新規 `web/memfs-lru.js` を `scripts/build.sh` の H_SHELL（BUILD_ID）/ cp / PRECACHE / `_headers` に追加済み
     （SW precache が bust する）。

> layer3 の残り（任意・要 wasm 再ビルド）: **resident hit の per-open touch**。現状 recency は materialize 時刻
> ベース（openat フックは MEMFS ヒット時に発火しないため、resident なファイルの再 open は recency を更新しない）。
> 上記の高低差ゆえ実用上は LRU 同等で、万一の誤 evict も透過再 materialize で無害だが、厳密化するには openat
> jslib に touch 呼び出しを足す必要があり再ビルドを伴う（`memfs-lru.js` 側は `touch(key)` を用意済み）。

### 終局（構造的決着）

linear memory を一切使わない **WasmFS+OPFS**（ファイルがディスクに resid）が emscripten
[#23133](https://github.com/emscripten-core/emscripten/issues/23133)（ASYNCIFY=1 + OPFS backend が
abort）の解決で出荷可能になれば、MEMFS materialize 自体が消えて RAM 天井問題が根本から無くなる。
**layer3 の LRU は、それが実るまでの橋**。WasmFS ルートは現状塩漬け（別途 `experiment/wasmfs-opfs-asyncify`）。

---

## 次の一手

- layer1（誤誘導除去）・layer3（LRU unload）は実装済み。**build+deploy で反映**（`scripts/build.sh` →
  Cloudflare。新規 `web/memfs-lru.js` を含む shell JS が BUILD_ID に効くので SW precache が bust する）。
- layer2（取り込み解析の非標準リスト名対応）を別 PR で根治。
- サイズ削減の自動 capture を再開（宿題1）。
- 任意: layer3 の per-open touch（要 wasm 再ビルド。上記注記）。
