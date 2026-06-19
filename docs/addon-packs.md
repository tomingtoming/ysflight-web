# ysflight-web 追加パック設計 (Add-on Packs Design)

> ステータス: **設計提案 (未実装)**。本ドキュメントは実装前の合意形成用。
> 調査根拠の file:line は upstream エンジン (`upstream/YSFLIGHT`, emscripten ブランチ) と
> 本リポジトリのものを併記する。

## 概要

YSFLIGHT に**機体・シーナリー・地上物の追加パック**を後から足せる仕組みを、Web版に導入する。

設計の出発点は、調査で判明した一点に尽きる:

> **追加パックの「読込・登録」レイヤーは原典エンジンに既に存在し、Web版の永続化基盤 (IDBFS)
> もそのユーザーディレクトリと一致している。** よって作るべきはエンジン改造ではなく、
> 「パックをユーザーディレクトリへ配達し、永続化し、選ばせる」プラットフォーム層である。

### スコープ（合意済み）

- **配達**: ユーザー持ち込み中心（プロジェクトは既定で何もホストしない）。カタログは将来拡張
- **対象**: 機体 (aircraft) ＋ シーナリー/マップ (scenery) ＋ 地上物 (ground) の3カテゴリ
- **互換**: 独自パック形式と、既存 YSFLIGHT コミュニティ addon の**両対応**（取り込み時に正規化）
- **マルチプレイ**: **ホスト（サーバ）が導入したパックは参加クライアントにも配信される**

## 1. エンジンが既に持つもの

原典 YSFLIGHT は起動時に3カテゴリを**グロブでディレクトリ走査**して読む
(`upstream/YSFLIGHT/src/core/fsworld.cpp`):

| カテゴリ | 走査パターン | リスト1行の形 | プリント |
|---|---|---|---|
| 機体 | `aircraft/air*.lst` | `<dat> <dnm> <coll.srf> <cockpit.srf> <coarse.dnm>` | fsworld.cpp:2460 |
| シーナリー | `scenery/sce*.lst` | `IDENT "field.fld" "start.stp" "" [mode]` | fsworld.cpp:2843 |
| 地上物 | `ground/gro*.lst` | `<dat> <srf> <srf> ...` | fsworld.cpp:2767 |

読込元は**2系統**で、両方とも既定で ON (`fsworld.h:255-267` の `InitializationOption`
で `loadDef*` / `loadUser*` がすべて `YSTRUE`):

- `loadDef*`: ルート `.` = `--preload-file` で焼いた読み取り専用 runtime
  (`/ysflight`、約25MB。`upstream/YSFLIGHT/src/main/CMakeLists.txt:609`)
- `loadUser*`: **`FsGetUserYsflightDir()` 配下** = `src/filename/fsfilename.cpp:110-151` で
  `GetUserDocDir()/YSFLIGHT.COM/YSFLIGHT/`

決定的なのは、Web版がこのユーザーディレクトリを上書きしておらず、`GetUserDocDir()` が
`/home/web_user/Documents` に解決されること。つまり**ユーザー add-on の置き場 =
IDBFS で永続化している領域そのもの** (`web/index.html:135` のマウント先)。
ファイル走査は `YsFileList::FindFileList`（POSIX `opendir` ベース）で MEMFS/IDBFS 上でも動く。

結論: **`/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT/{aircraft,scenery,ground}/` に
パック一式と `air<id>.lst` 等を書いて `syncfs` するだけで、エンジンは次回起動時に自動で拾い、
リロード後も残り、オフラインでも効く。** リストの各行のパスは**ユーザーディレクトリ基準**で
解決される（機体 fsworld.cpp:2468 / 地上物 2775 / シーナリー 2858 → `MakeFullPathName(rootDir,…)`）。

## 2. パックのレイアウト — 実体は隔離、リストだけ共有ディレクトリに置く

複数パックが同名ファイル（例 `aircraft/f15.dnm`）を持つと上書き衝突する。これを構造で殺す:

```
/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT/
  aircraft/  air<id>.lst      ← グロブ air*.lst で拾われる「小さなリスト」だけ共有
  scenery/   sce<id>.lst
  ground/    gro<id>.lst
  packs/<id>/                 ← パック実体は id ごとに隔離（衝突しない）
    aircraft/… scenery/… ground/…
    manifest.json
  packs/index.json            ← 導入済み一覧（有効/無効/容量/出自/hash）
```

成立の根拠: エンジンのグロブ走査は `{aircraft,scenery,ground}/` の**直下しか見ない**が、
`.lst` 各行のデータパスは**ユーザーディレクトリ基準**で解決される。だから `air<id>.lst` の行を
`packs/<id>/aircraft/foo.dnm` と書けば、リストは拾われ・実体は隔離される。

- **id = パック内容のハッシュ**（manifest の Merkle ルート）。版が違えば id が違う＝衝突しない
- **衝突なし**（パックごとに別サブツリー）
- **アンインストールが原子的**: 3つの `*<id>.lst` ＋ `packs/<id>/` を削除するだけ
- **有効/無効トグルが無料**: `air<id>.lst` → `air<id>.lst.off` にリネーム（グロブの ext=`lst`
  から外れて読まれなくなる）

## 3. 取り込み（インポート）パイプライン

ドロップされた zip を、native 形式でも既存 addon でも、上の正規形へ落とす一本道:

1. MEMFS のステージングに展開（path traversal 遮断・既知拡張子のみ）
2. **分類**: `*.lst` と `.dat/.dnm/.srf/.fld/.stp` を走査し、各リストのカテゴリを判定
3. **正規化**: 実体を `packs/<id>/{aircraft,scenery,ground}/` へ再配置し、各 `.lst` の
   内部パスを `packs/<id>/…` へ書き換えて `air<id>.lst` 等として発行
4. `manifest.json` 生成（id / 表示名 / 推定対応版 / カテゴリ / ファイル一覧＋SHA-256 /
   ライセンス=user-supplied）
5. コミット（ステージ→本体 move）→ `index.json` 更新 → `FS.syncfs(false)`

native 形式は「この正規形をそのまま zip 化したもの」と定義する。よって取り込みは「検証して
move」だけ。既存 addon は同じパイプラインの「正規化」を通る——**入口は一本、native は薄いラッパ**。

### 「両対応」の正直なコスト（既存 addon の正規化）

既存コミュニティ addon を“そのまま食わせる”難しさは、原典が Windows / 古い版前提だから。
正規化で吸収すべき差分:

- **文字コード**: 古い `.lst` / ファイル名が Shift-JIS。エンジンは `SetUTF8String` 前提
  なので、SJIS 混入で「file not found」化 → 検出＆ UTF-8 変換が要る
- **パス区切り**: `\` を `/` へ正規化
- **大文字小文字**: Windows は無視、MEMFS は敏感。`.lst` の参照と実ファイルの case 不一致を修復
- **リスト命名/マージ前提**: 本体 `aircraft.lst` への追記を前提とする addon は、グロブ対象の
  `air<id>.lst` へ改名生成する
- **シーナリーの内部参照**: `.fld` が自前サブアセットを root 相対で引く場合、隔離が崩れる
  (`fieldTemplate` の `SetRootDir`)。機体は全ファイルが行内で明示されるので隔離はクリーンだが、
  **シーナリーは要注意**
- **共有ベース依存**: base 機体を流用する塗装パック等は隔離と相性が悪い

機体は隔離がきれいで互換も楽。シーナリー/地上物は上記が出やすい。

## 4. シングルプレイ: pre-boot 管理 ＝ 無リロード

エンジンはテンプレを**起動時に一度だけ**読む。読込は遅延ロードで、`main()` 開始から数 rAF
フレーム後の `StepByStepInitialization` (`fsmain.cpp:351`) → `InitializeOneStep`
(`fsmain.cpp:372` → `fsrunloop.cpp:576`、case 0/1/2 で
`LoadAirplaneTemplate`/`LoadGroundTemplate`/`LoadFieldTemplate`、L584/587/590) で走る。

したがって **`main()` の前（あるいは前述の遅延ロードより前）に FS へ置いてあれば、その一度の
読込で拾われる。リロードは不要。** 既に導入済みのパックは、現状の `preRun` の
`FS.syncfs(true)`（IDBFS→FS 復元、`web/index.html:137`）だけで揃う＝**いま既にゼロ追加で動く経路**。

新規導入時の実装フックは、**既存の run-dependency ゲートを延長するだけ（ビルド変更なし、推奨）**:

```js
// web/index.html の preRun 内、IDBFS mount + syncfs(true) の後に
Module.addRunDependency('ysfw-packs');
// パック管理UIで導入/削除/トグル → FS.writeFile(...) → FS.syncfs(false)
// ユーザーが「開始」したら:
Module.removeRunDependency('ysfw-packs');   // ここで初めて main() が進む
```

代替として `Module.noInitialRun=true` ＋ `Module.callMain(args)` も可能だが、`callMain` の
export が必要（`EXPORTED_RUNTIME_METHODS` は現状 `FS,IDBFS,UTF8ToString,stringToUTF8,ENV`
のみ、`CMakeLists.txt:605`）＝ビルド変更が要る。**run-dependency 方式の方が無改造で済むので優先。**

## 5. マルチプレイ: ホスト→クライアント配信

### 5.1 ネットコードの現実（ここが設計を決める）

YSFLIGHT のマルチプレイは**名前参照＋状態同期**のプロトコルで、**コンテンツ配信機構を持たない**
(`upstream/YSFLIGHT/src/core/fsnetwork.cpp`)。両端が**同じ add-on を起動時に各自ロード済み**で
あることを前提にする。

- **フィールド**: 名前のみ送信（`SendLoadField`, fsnetwork.cpp:3838-3861。64バイト固定、
  名前＋pos/att だけ）。クライアントは**自分のローカル**から名前で読む。
  **欠落 = 致命的**: `CLIENT_FATAL_FIELD_UNAVAILABLE` で**即切断**（5896-5913 / 9796-9801）
- **機体**: 名前＋飛行モデル諸元（`.dat` の数値を `FSNETCMD_AIRCMD` テキストで再送、3951-4007）。
  `.dnm/.srf` 等のモデルは送られない。**欠落 = 代替機で継続**（substitution cascade:
  同名→`SubstIdName`→クラス/カテゴリ一致機、ReceiveAddObject 6005-6067）。
  **共通機体ゼロ**のときだけ致命的（`CLIENT_FATAL_NO_COMMON_AIRPLANE`, 7107-7116）
- **バルク転送なし**: バッファは小さく（COMBUFSIZE=8192）、過大パケットは**サーバが切断**
  （`FSNETCMD_TESTHUGEPACKET` はそれを検証するためのコマンド）。`FSNETCMD_*` にバイトを
  流し込むのは不可

**設計含意**:

1. **配信は完全に out-of-band**。realtime プロトコルとは別レイヤーで、**`FSNETCMD_LOGON`
   より前**に完了させる。そうすればエンジン既存の名前解決（`FindAirplaneTemplate`/`AddField`）が
   そのまま通る
2. **フィールド・パックが最優先**（欠落＝切断）。機体/地上物は substitution で延命できる
3. 機体は**ビジュアルファイルだけ**配ればよい（物理は wire 同期される）。フル `.dat` が要るのは
   「クライアント自身が選んで飛ぶ機体」だけ

### 5.2 トランスポートの現実

| 経路 | 担体 | バルク可 | 用途 |
|---|---|---|---|
| host↔client P2P | WebRTC DataChannel (`ordered:true`, reliable) | **可（ただし要追加実装）** | ゲームデータ／パック配信 |
| browser↔/signal | WebSocket (Worker+DO) | **不可（制御JSONのみ）** | SDP/ICE 交換のみ |
| HTTPS fetch | 同一/外部オリジン | 可 | パックの自己取得 |

- バルク可能な P2P 経路は**実質 DataChannel 一本**。ただし現状のグルー
  (`src/port/yssocket/yssocket_emscripten.cpp`) は **チャンク分割なし・`bufferedAmount`
  背圧なし・最大メッセージサイズ非対応**（`jsHostSend`/`jsCliSend` が丸ごと1回 `ch.send`、
  244-250 / 355-364）。受信側 `drainQueue` (71-84) は**メッセージ境界を平坦化**するため、
  ゲーム用 `'ysf'` チャネルの再利用は不可
- → パック配信には**専用の2本目 DataChannel `'ysf-pack'`** を開き、長さプレフィックス付き
  フレーミング・≤64KiB チャンク・`bufferedamountlow` 背圧を**自前で**足す
- トポロジは**ホスト中心の star**（クライアント同士は繋がらない）＝ホストが自然なパック源
- ICE は STUN ＋ **Cloudflare Realtime TURN** リレー（Worker の `/turn` が配信）。対称 NAT/CGNAT のホストも TURN 経由で到達できる（`/turn` 未設定時は STUN 一本にフォールバックし、到達不能ペアが残る）
- ネイティブ鯖ブリッジは廃止済み（`server/relay.mjs` 削除、NET-VERSION `20260617` で web↔web のみ）

### 5.3 配信方式 — ハイブリッド（manifest を契約に、ホストを真実源に）

| 方式 | バイトの出所 | 採否 |
|---|---|---|
| **A. ホストが DataChannel で push** | host peer (`'ysf-pack'`) | **必須フォールバック** |
| **B. クライアントが URL から自己取得** | 元配布 URL / CDN (HTTPS) | **優先（速い経路）** |
| C. プロジェクトの content-addressed ストア | 自前 CDN/R2 | **棚上げ**（"何もホストしない"に反する・運用/モデレーション負荷） |

- **B を優先**: manifest（`{id, files:[{path,sha256,size}], sourceUrl}`）だけ受け取り、
  クライアントが `fetch` → SHA-256 検証 → IDBFS 書込。ホストの上り帯域を食わず、URL を持つ
  既存 addon にそのまま効く。リスクは CORS（多くの addon サイトは ACAO を返さない）
- **A は必須**: 持ち込みパックは URL を持たないのが普通。その場合ホストが `'ysf-pack'` で
  バイトを直接配る。これが無いとユーザー持ち込みパックを配信できない
- **共通の背骨**: content-hash manifest ／ `packs/<id>/` への IDBFS 書込＋`*<id>.lst` 生成 ／
  同じ登録手順。A と B の差は「バイトの出所」だけなので、両対応の増分コストは小さい
- **手順**: 参加時、`FSNETCMD_LOGON` の**前**に out-of-band で
  「manifest 提示 → クライアントが hash 差分 → 欠けてる分を fetch または push で取得 → 検証 →
   IDBFS 書込」を完了させる。フィールドを最優先

### 5.4 招待リンク経由 join で「起動済みクライアント問題」を消す（採用）

最大の難所は『クライアントは**メニュー＝既に boot 済み**でホスト接続する』点だった。起動後に
ローダを呼び直すと重複登録される——`LoadAirplaneTemplate` 等は `FindTemplate` デデュープをせず
`…Template.Create()` で無条件 append する (fsworld.cpp:2144 機体 / 2577 地上物 / 2929 フィールド)。

**解決: クライアント join を必ず boot 前のシェルで起こす。** エンジン内ネットワークメニューの
クライアント接続を閉じ（既に無効化済みの chat / server-port と同系統のフォーク改変）、join は
**招待リンク `?join=<room>`（または boot 前シェルの Room ID 入力フォーム）からのみ**受ける。
すると join 意図が **boot 前に確定**するので、§4 と同じ run-dependency ゲートでパック sync を
boot 前に完了でき、**リロードも再スキャン shim も不要**になる。

> 補足: ここでの「boot 前」とは **"ランタイム初期化済み・`main()` 未実行"** の意（wasm を全く
> ロードしない意味ではない）。`FS.writeFile` に FS が要るため、`preRun` で IDBFS を mount し
> `addRunDependency('ysfw-packs')` を握った状態でパック展開→離す、という §4 のゲートで成立する。

手順（クライアント、`?join=<room>` 着信時）:

1. シェルが署名サーバ (`/signal`) に **JS で**接続し room に join、ホストの**パック manifest**を
   取得（§5.5）。Option B(URL) なら manifest だけで十分、Option A(push) なら boot 前にホストへ
   `'ysf-pack'` 用の接続も張る
2. エンジンモジュールをロードしつつ `preRun` で IDBFS mount + `syncfs(true)` +
   `addRunDependency('ysfw-packs')`（ここで FS が使える）
3. manifest を IDBFS の導入済みと hash 差分 → 欠けを fetch(URL) / receive(DataChannel) →
   SHA-256 検証 → `packs/<id>/` へ書込＋`*<id>.lst` 生成 → `removeRunDependency('ysfw-packs')`
4. `main()` 進行 → エンジンが `-client name room` で接続 → YSFLIGHT の `LOGON/LOADFIELD/LIST`
   が走る頃にはパックは FS 上にある＝名前解決がそのまま通る。**リロードなし**

UX: 手動 Room ID 入力は **boot 前シェルのフォームとして残す**（メニューから消すだけで入力手段は
失わない）。solo 飛行中に友達へ join したい場合は招待リンクを開く＝新規ロード（問題のある
"接続後にパック欠落を発見してリロード" ではない）。

**フォールバック（残余ケースのみ）**: 何らかの理由で起動後に登録が必要になったら、(a) join 意図付き
**制御リロード**（`?join=` で再 boot、`.data` はキャッシュ済みで速い・無改造）、(b) **個別 new-list
再スキャン shim**（新パックだけを列挙した `air<id>.lst` を1ファイル走査、`Load*TemplateList` の
C shim を export＝リビルド。`EXPORTED_FUNCTIONS` は現状 `_main,_malloc,_free` のみ、
CMakeLists.txt:606）。**標準フローでは boot 前 join により両方とも不要。**
起動後に既存ローダを素で呼び直すな（黙って重複登録する）。

### 5.5 ホスト側 manifest の公開

ホストはパックをローカルに持つので boot 前 sync は不要だが、joiner が boot 前に欲しい
**manifest を公開**する必要がある。`{t:'host', room}` に `manifest`（pack id＝content hash・
ファイル別 hash・サイズ・任意の URL の小さな JSON）を付けて Durable Object の room 状態に保持し、
`join-ok` で joiner に返す。manifest は小さな制御メタデータなので "ゲームデータは Worker を
通らない" 不変条件は保たれる（バイトは流さない）。

## 6. リスクと対策

- **IDBFS クォータ**: 大型 addon は数十 MB。IndexedDB は origin 単位で上限があり、ストレージ
  圧で**追い出され得る**。`navigator.storage.persist()` を要求し容量を表示。書込は temp →
  atomic rename（または完了マーカー）で、中断時に半端な `packs/<id>/` を残さない
- **untrusted なファイル**: バイトは untrusted な host peer (A) / 任意 URL (B) 由来。
  エンジンの `.dat/.dnm/.fld` パーサは敵対入力に対して堅牢化されていない（wasm サンドボックス内の
  クラッシュ/グリーフ要因）。**path traversal 厳禁**（`..`・絶対パス・symlink を拒否、書込は
  `packs/<id>/` と3走査ディレクトリ配下に限定）、ファイル/パック単位のサイズ上限、manifest
  スキーマ検証を**書込前**に
- **内容/版の不一致と無言の視覚デシンク**: エンジンは**名前のみ**で照合しハッシュを見ない。
  同名・別バイトの `.dnm` 2つは黙ってデシンクする。content hash でバイト一致は保証できるが、
  クライアントが**同名・別ハッシュ**版を既に持つ場合は競合（ローカル版が名前解決に勝つ）。
  ポリシ要決定: セッション中はホストの版を優先（`packs/<host-id>/` 名前空間＋セッション限定
  `.lst`）か、警告/拒否か。NET-VERSION ゲートは**プロトコル版**は見るが**パック内容**は見ない
- **取得できないクライアント**: 対称 NAT/CGNAT のホストは A は TURN リレー経由で到達可能
  （`/turn` 未設定時のみ到達不能）、コミュニティ URL は
  B で CORS/リンク切れ。**フィールド欠落は致命的**なので、エンジンのハード切断に当たる前に
  「このサーバはフィールド X を要求するが取得できなかった」と**`LOGON` 前に**明示する。
  機体/地上物欠落は substitution に委ねて参加は許す。ユーザー**拒否**（untrusted バイト DL の
  同意プロンプト）時はメニュー維持（クラッシュさせない）
- **ホストの上り帯域（A）**: 家庭回線ホストが複数クライアントへ数 MB を押すとゲーム通信と競合。
  背圧（`bufferedAmount`）＋ピアごと直列化、URL があれば B を優先して上りからバイトを退避
- **セッション中のパック変更/遅延 join**: 設計は「sync は `LOGON` 前完了」を前提。ホストが
  接続中にパックを差し替えると前提が崩れリロード経路 (1) に戻る。**推奨: パックはセッション
  固定**（ホスト開始時に確定、途中変更不可）
- **DataChannel のフレーミング衝突**: 受信グルーが境界を平坦化するため、`'ysf-pack'` は
  自己区切り（長さプレフィックス）必須・`'ysf'` とは**別チャネル**必須。チャンクは ≤64KiB、
  送信バッファ上限（~16MB）厳守

## 7. 段階導入

- **v1（出荷を止めない最小形）**: 持ち込み（ファイルピッカー/ドラッグ&ドロップ）＋ native 形式＋
  構造保存インポート＋ **pre-boot 管理（run-dependency gate）で無リロード**＋
  `storage.persist()`＋容量表示。まず機体で価値を即出す。マルチプレイは**配信なし**（両端が
  同じパックを各自導入している前提＝原典どおり）
- **v1.5**: 既存 addon のレガシー正規化（SJIS/case/区切り/リスト改名）で“食わせる”互換を本格化。
  全カテゴリ対応
- **v2（マルチプレイ配信・採用）**: §5 のハイブリッド B+A。manifest 交換＋ `'ysf-pack'` チャネル＋
  content hash 検証。**クライアント join を boot 前シェルに一本化**（招待リンク / シェル入力のみ、
  エンジン内メニュー接続は閉じる）し、パック sync を boot 前ゲートで完了＝**リロード/再スキャン
  shim 不要**（§5.4）。フィールド最優先。新規実装: boot 前シェル用の JS 署名/WebRTC/manifest
  クライアントの切り出し（現状この処理はエンジンが駆動）、`'ysf-pack'` のフレーミング/背圧、
  ホスト manifest 公開（§5.5）
- **将来**: 許諾済みパックの小さなカタログ／URL インポート（再配布の足場ができてから）。
  方式 C（自前 content-addressed ストア）は P2P バルクが NAT で不安定すぎる場合の保険

## 8. 決定事項・未決事項

決定:

- **マルチプレイ配信を v2 で実施**（ユーザー価値大）
- **クライアント join は招待リンク / boot 前シェルに一本化**し、エンジン内メニューのクライアント
  接続は閉じる。これにより join 意図が boot 前に確定し、パック sync が boot 前ゲートで完了＝
  リロード/再スキャン shim 不要（§5.4）

未決:

- 同名・別ハッシュ・パックの競合ポリシ（ホスト優先 / 警告 / 拒否）— §6
- Option A（ホスト push）の boot 前接続: シェルが game とは別に boot 前 WebRTC を張るか、まず
  Option B(URL) だけ boot 前対応にして A は後続にするか（実装順の決定）
- ネイティブ鯖ブリッジ復活の予定有無（あると配信前提が変わる）
- C shim export（登録フォールバック b）は標準フローでは不要。残余フォールバック用に入れるかは保留

## 9. v2 実装計画（マルチプレイ配信・確定 2026-06-18）

v1（M1〜M3＋起動fix）は main マージ済み。v2＝「ホストが有効化したパックを参加者へ自動配信」。実コード調査の上で確定した計画。

### アーキ決定: エンジンと別の **シェル所有 WebRTC 接続**（M4〜M7は wasm rebuild 不要）

パック転送は、エンジンのゲーム用 peer 接続とは**別の**シェル所有 `RTCPeerConnection` ＋ `'ysf-pack'` DataChannel で行う。決め手は **pre-boot 同期要件**：パック同期は `main()` 前（run-dependency ゲート中）に終える必要があるが、エンジンの peer 接続は `main()` 後にしか生成されない。よって「engine の pc に2本目チャネルを足す」案は**パックが要る時点で接続が存在せず成立しない**＝シェル所有の別接続が必然（結果として C++ 改変ゼロ）。同じ Cloudflare ハブを**派生 room**（`derivePackRoom`＝ゲーム room＋`~p`、≤16字）で再利用、受信は既存 `window.ysfwPacks.installFromBytes`。バイトは P2P でホストpush、Worker は manifest（小さな制御メタ）だけ中継＝「ゲームデータは Worker を通らない」不変条件は維持。

### マイルストーン

| ID | 内容 | rebuild | 検証 |
|---|---|---|---|
| **M4** | ホスト manifest 契約＋Worker 通過（制御のみ・転送なし）。`pack-net.js` のコア（`derivePackRoom`/`buildRoomManifest`/`diffManifest`/`prioritizeMissing`）＋ `signal.js` の manifest passthrough（≤64KB） | 不要 | node 単体（本PR・14/14） |
| **M5** | `'ysf-pack'` チャンク/背圧つき DataChannel（**Option A：ホストpush**）。長さプレフィックス枠・≤64KiB・`bufferedamountlow`・per-peer 直列 | 不要 | **2ブラウザ Playwright**（pack無しjoiner→P2P受領→sha256検証→install） |
| **M6** | **pre-boot join 統合**：`?join` でゲートを保持し、ゲート内で manifest 受領→差分→取得→install→syncfs→解放（無リロード）。手動 Room-ID もシェル前段に集約 | 不要 | 2ブラウザ（招待リンクjoin→パック入りで起動・機体ロード確認） |
| **M7** | **Option B（URL自己取得）** ＋ **フィールド最優先**（必須・ゲート停止）＋ 取得失敗UX（無言切断の前に明示パネル＋Retry/ソロ） | 不要 | Playwright 3ケース（B成功 / B→A fallback / フィールド取得失敗UX） |
| **M8** | エンジン内メニューの client 接続を閉じる（pre-boot 一本化）。chat/server-port 無効化（commit 30d3083）と同種の upstream submodule 改変 | **必要** | 全スモーク（rebuild後の回帰） |

**Option A を先**（持ち込みパックはURL無しが普通＝必須経路、かつ難所のチャンク/背圧を先に潰す）、B は後から重ねる最適化（A が恒久フォールバック）。

### 確定した分岐（2026-06-18）

- **M8 はやる**（完全ハードニング・v2で1回 rebuild）。pre-boot join を唯一の経路にし、pack 同期を飛ばす抜け道を塞ぐ
- **同名・別ハッシュの競合＝セッション中はホスト版を優先**（`packs/<host-id>/` 名前空間＋セッション限定 `.lst`。`diffManifest` が `conflicts` を返す → M6 の install で処理）
- ~~**TURN はスコープ外**~~ → **Cloudflare Realtime TURN 導入済み**（Worker の `/turn` が短命クレデンシャルを配信）。到達不能ペアもリレーで救済し、なお取得できない場合は取得失敗UXで可視化（無言ハングにしない）

### 残りの細部（実装時に既定値で進める）

同意UXの粒度（ホスト単位/セッション単位）・派生room命名（`~p`採用）・best-effort パックの背景DL（次セッション用にIDBFS保存）・content/version desync（ホスト配信分はcontent-hashでバイト一致保証、既存ローカル同名は競合ポリシで上書き）。

## 参考: 主要コード参照

エンジン (`upstream/YSFLIGHT`, emscripten):

- グロブ走査とローダ: `src/core/fsworld.cpp:2460/2767/2843`（プリント）、
  `2458/2765/2841`（opt ローダ）、`2468/2775/2858`（user-dir 走査）、
  `2144/2577/2929`（デデュープ無しの append）
- 既定値: `src/core/fsworld.h:255-267`（`loadDef*`/`loadUser*` 全 `YSTRUE`）
- ユーザーディレクトリ: `src/filename/fsfilename.cpp:110-151`
- 遅延テンプレ読込: `src/main/fsmain.cpp:351/372` → `src/ui/fsrunloop.cpp:576/584/587/590`
- ネットコード: `src/core/fsnetwork.cpp`（`SendLoadField:3838-3861`、
  欠落フィールド致命 `5896-5913/9796-9801`、機体 substitution `6005-6067`、
  共通機体ゼロ致命 `7107-7116`、`SendAirplaneList:4407-4452`）
- ビルドフラグ: `src/main/CMakeLists.txt:595-610`（`EXPORTED_RUNTIME_METHODS:605`、
  `EXPORTED_FUNCTIONS:606`、`--preload-file runtime@/ysflight:609`）

本リポジトリ:

- 起動シェル: `web/index.html`（preRun IDBFS mount+syncfs `127-138`、Module.arguments
  `115-126`、`?join` 解釈 `107/123`、loadEngine `193-198/362`）
- WebRTC グルー: `src/port/yssocket/yssocket_emscripten.cpp`（DataChannel `159-161`、
  送信 `244-250/355-364`、受信平坦化 `71-84`）
- シグナリング: `worker/signal.js`、マルチプレイ設計: `docs/multiplayer.md`
