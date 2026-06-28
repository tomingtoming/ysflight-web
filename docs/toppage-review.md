# ysflight-web トップページ改善レビュー (Top-page Persona Review)

> ステータス: **2026-06-28 レビュー**。[personas.md](personas.md) の第一ターゲット
> (旧YSFLIGHT既存ファン)を評価軸に、`web/index.html`・`web/packs-ui.js` を6レンズで
> 多角レビューし、各指摘を実在性・ペルソナ整合・v1スコープ整合で検証した結果
> (採用23件 / 却下2件)。仕様の正本は [overview.md](overview.md)。
>
> **実装状況**: クイックウィン9件 **f1 / f2 / f4 / f6 / f7 / f19 / f20 / f21 / f25 は
> commit `936726d` で実装済み**。下記の残り (f3 / f5 / f8 / f10 / f11 / f12 / f13 / f14 /
> f15 / f16 / f18 / f22 / f23 / f24) はバックログ。**f14**(Service Worker が25MBの`.data`を
> `addAll`で再取得＝二重DLリスク)は UX コピーでなく**性能バグ寄り**で要別対応。
>
> 注: 行番号はレビュー時点(`936726d` 直前)のもの。実装済み項目の行は現在ずれている。
> f12 の実装時は能力判定を `getContext('webgl2')` ではなく **`getContext('webgl')`**
> にすること(エンジンは WebGL1=`-sFULL_ES2`。webgl2要求は正常端末を誤って弾く)。

---

## 全体評価

トップページは技術的な完成度（25MB wasm の即時ロード、SW によるオフライン即起動、PWA manifest）は高いが、**フォールド〜ロード待ち画面のコピーが完全に新規層(P1)語彙で構成され、第一ターゲットであるP0（旧YSFLIGHT既存ファン）の4ニーズ（飛行挙動が原典のまま／URLを開くだけ／昔のaddon持ち込み／昔の仲間と対戦）に一つも応えていない**。事実は実装(原典同一・ソロaddon持ち込み・P2P対戦)として既に揃っているのに、それを言葉とビジュアルで伝えていないギャップが最大の課題。加えて、ホストHow-toの位置誤記(f4)など「対戦導線が実害レベルで詰まる」事実不一致が混在する。改善の大半は文字列差し替え中心の低effortで、P0への訴求は短期で大きく底上げできる。

検証メモ: 以下の行番号・文言は `web/index.html` / `web/packs-ui.js` の実コードと照合済み。OGP/description(行7/13/18)は実際には「instant multiplayer」を含むが、いずれにせよ "unofficial/非公式" の語は index.html 全体で0ヒット(f2根拠は成立)。

---

## 優先度順 改善項目

優先度＝P0インパクト×低effort。最上段ほど「先にやるべき」。

### 最優先(P0直撃・effort S)

| # | タイトル | 対象 | 現状の問題(行) | 改善案 | sev | eff |
|---|---|---|---|---|---|---|
| **f4** | ホストHow-to手順3が「画面右上」と誤記、実際は右下 | P0 | `index.html:259`(ja「画面右上」)/`:321`(en「top-right」)が、実装のRoomチップ(`ysfwBRStack` = `right:8px;bottom:8px`=右下, `:755`)と食い違う。右上に出る経路は実在しない | ja「画面**右下**に…」/en「…appears **bottom-right**」へ2文字列修正 | **high** | S |
| **f1** | フォールドのh1・pitchが新規層専用で、P0への「あの原典がそのまま」信号がゼロ | P0 | `index.html:167` h1「YSFLIGHT web」のみ／`:203`(ja)`:265`(en) pitchは無料・スマホ・今すぐ飛ぶの新規訴求のみ。原典連続性は最下部`#note`(12px・最暗`#5d7290`)だけ | `TXT.pitch` ja/en を二段構えに差し替え(新規訴求を残しつつ既存ファン信号を織り込む)。**「アドオン持ち込み」はソロ前提の語に限定**(例「ソロでそのまま読み込めます」)しMP配信を匂わせない。「飛行感そのまま」は overview §1.1 の golden test 事実に寄せる。文字列1行差し替え・DOM/CSS追加不要 | medium | S |
| **f2** | 「非公式(unofficial)」がユーザー可視UIに無く、公式誤認＋原作者リスペクト両面で弱い | P0 | `#note`(`:177`)は「…WebAssembly port.」止まり。`grep -iE 'unofficial|非公式|有志'` で index.html 0ヒット(確認済) | `#note` に1語追記「有志による非公式の WebAssembly 移植 / An unofficial, fan-made WebAssembly port」。トーンは事務的に圧縮。**OGP description(行7/13/18)にも "unofficial" を1語添える**と共有経路でも公式誤認を防げる(任意の上積み) | low | S |
| **f25** | 対戦コピーに「追加パックは相手に自動で渡らない(各自事前導入)」の明示が無い | P0 | ホストHow-to(`index.html:256-260`)にパック事前共有の注意なし。`MP_PACK_SYNC` 既定OFF(`:435-441`, vanilla契約)。**v1既定ではjoinerは無音でソロブートし、ホストのカスタム機体欠落の警告すら出ない**(同期失敗UIは `?packsync=1` 時のみ) | ホストHow-toに注記1行追加: ja「※カスタム機体・マップで対戦するときは、参加者全員が同じアドオンを各自で事前に取り込んでください(v1では自動配信しません)」/en同旨。vanilla契約を正しく伝えるだけでv2配信スコープと矛盾しない | medium | S |
| **f7** | 初回約25MB DLが無言待ち＋「2回目以降は瞬時・オフライン可」を訴求せず | both | `setStatus`(`index.html:587-596`)は英語プレフィックスを抜くだけでバー幅はバイト比のみ。総量/残量/ETAを一度も提示しない。`#status` 初期値「loading...」(`:169`)。SWでオフライン即起動が実在するのにコピーゼロ。サイズ表記も「~23MB」(コメント)と「約25MB」(overview)で不統一 | (必須)`#pitch`直下 or `#status`初期文言に静的1行「初回だけ約25MBを読み込みます(2回目以降は瞬時・オフラインでも起動)」追加＋サイズ表記を約25MBに統一。(任意)ライブMB併記・再訪「✓端末に保存済み」バッジ。※総量は実値由来にし、content-hash資産とドリフトさせない | medium | S |
| **f6** | 同一画面に2つの「開始」(今すぐ飛ぶ／▶プレイ開始)が並びCTA階層が逆転 | both | `packs-ui.js`: quickTitle「🛫今すぐ飛ぶ」(`:48`)＋カード「▶<機体名>」(`:618`)＋全幅アクセントの playBtn「▶プレイ開始」(`:70`, width:100%/ACCENT塗り)。pitchが主CTAと呼ぶ「今すぐ飛ぶ」より playBtn(=エンジンメニュー行き)の方が視覚的に最大で逆転 | **最小・安全案に限定**: playBtn直下に1行注記「機体・マップを自分で選ぶ／対戦をホストするならこちら(エンジンのメニューへ)」、または playBtnラベルを「▶プレイ開始(メニュー)」へ。※playBtnはP0(ホスト/addon選択)の唯一の入口でもあるため、アクセント剥奪・記号集約はA/B無しでは非推奨。既存 postPlayHint(`:62`)と機能重複に注意 | medium | S |

### 次点(中effort・要実装)

| # | タイトル | 対象 | 現状の問題(行) | 改善案 | sev | eff |
|---|---|---|---|---|---|---|
| **f3** | 「昔の仲間と対戦」導線が折りたたみ既定非表示＋フォールド外でP0ニーズ④の発見性が低い | P0 | 手動ジョイン(`index.html:1412` display:none)・ホストhowto(`:1443` display:none)とも初期非表示。`overlay.appendChild`(`:1428/1458`)でPCではフォールド外に積層。フォールド(166-180)に対戦文言なし | パネル直下に「対戦したい人はこちら↓」の1行アンカー。**ジョインより「ホスト導線の発見性」を主眼に**(招待リンク `?join=` 受信者には別の目立つフォーム、`?host=1` はhowto自動展開が既存。真のギャップは招待を持たず来た既存ファン) | medium | M |
| **f8** | 初見で「飛行機ゲーム」と分かる絵が一枚もない | both | `#overlay`(166-180)はh1/進捗/pitch/単色`#121a26`スケルトン(`:113-122`)のみ。body内 `<img>`/`background-image` 0ヒット。Quick Flightカード(`packs-ui.js:603-636`)もテキストのみ | スケルトン領域 or `#pitch`直下に軽量(WebP/数十KB)スクショ1枚を静的DOMで。**必須条件3つ**: ①ストック写真でなく実エンジンのYSFLIGHTレンダー(偽物に読まれP0信頼毀損を回避) ②真に数十KB＋`loading=lazy`で初回paintをブロックしない(LCP悪化させない) ③効果は「待機中の信頼補強＋P1の即理解」に限定評価 | medium | M |
| **f12** | WebGL/wasm非対応・初回オフライン時のエラーが生英語止まりで25MB待った末に詰む | both | `index.html:718-720` window 'error' で生英語のみ。`<noscript>`/能力チェックなし。`loadEngine`(`:729-734`)は onerror なし | DL前に能力チェック→欠落時ja/en案内。**重要修正: 判定は `getContext('webgl2')` でなく `getContext('webgl')`**(エンジンは WebGL 1.0=`-sFULL_ES2`。webgl2要求は正常な WebGL1 端末を誤って弾く)。engine script の onerror＋進捗タイムアウトも追加(「永久に詰む」断定は過剰なので表現は穏当に) | medium | M |
| **f11** | PWAインストール誘導が皆無(`beforeinstallprompt`未処理)で再訪導線とshortcutsを取りこぼす | both | manifest は icons/standalone/landscape/shortcuts(3機体直リンク)完備だが `beforeinstallprompt`/`appinstalled`/display-mode判定が web/配下に皆無 | DL完了後パネル下部に控えめな「ホーム画面に追加」ボタン。`display-mode:standalone` で非表示、iOSは一文ヒントのみ。**文言は「次回からホーム画面から1タップ起動」程度に抑える**(SWキャッシュ済みで通常タブ再訪も既に速いため「起動が一瞬」は誇張)。初訪ノイズ回避にプレイ操作後の表示が望ましい | low | M |

### a11y(アクセシビリティ)

| # | タイトル | 対象 | 現状の問題(行) | 改善案 | sev | eff |
|---|---|---|---|---|---|---|
| **f18** | viewport が `maximum-scale=1/user-scalable=no` でピンチズーム禁止(WCAG 1.4.4違反) | both | `index.html:5` がページ全体の拡大を禁止。ロード画面・フォーム・`#note`(12px)も拡大不能。P0は年齢上のユーザーを含む | viewportから `maximum-scale=1, user-scalable=no` を外す。フライト中のピンチ抑止は `#canvas` の touch-action/イベント側で局所化。**実装前に `#canvas` 自体へ touch-action が効いているか要確認**(現状の局所付与はスティック/ボタンのみ) | medium | S |
| **f19** | 補助テキスト `#5d7290` がコントラスト比 3.8-3.9:1 で WCAG AA(4.5:1)未達 | both | `index.html:146`(#note 12px)、`packs-ui.js:586`(quickHint 11px)/`:671`(postPlayHint 11px)/`:629`(tag 10px) すべて `#5d7290`。実測 3.77-3.94:1 | **`#8fa3bb`(7.5:1)でなく中間トーン `#7d93b0`〜`#738eaf`** に置換(#8fa3bb は #sub/status 級で階層がつぶれる。中間ならAA達成かつ「本文より淡い」意図を保持)。優先は #note/quickHint/postPlayHint。色トークン1変更で複数同時に直る | medium | S |
| **f20** | 右下シェル操作行のボタンが高さ ~28-34px でタッチターゲット最小未達 | both | `index.html:755` ysfwBRStack(gap:6px)、help(`:1131`)/fsBtn(`:1061`)/badge(`:839`) が padding:6px 10px・font 12px、chip(`:797`)が padding:8px 14px | `pointer:coarse` 時のみ `min-height:44px`＋padding増。Roomチップ(招待リンクコピー=P0対戦導線の要)と「?ヘルプ」を優先。`matchMedia('(pointer:coarse)')` は既存(`:1165`) | medium | S |
| **f21** | ロード画面に `aria-live`/`role=progressbar` が無く SR に進捗が伝わらない | both | `#progress`(`:168`)に role/aria なし、`#status`(`:169`)に aria-live なし、`setStatus`(`:587-596`)は textContent更新のみ | `#status` に `aria-live="polite" role="status"`(最優先・JS改変ほぼ不要)。`#progress` に `role="progressbar"`＋bar幅更新時に `aria-valuenow` を1行同期 | medium | S |
| **f16** | プリセット機体カードのサブ表記が日英混在・粒度不揃い | both | `packs-ui.js:604-607` sub: 'Small Map'/'厚木 / Atsugi'/'Hawaii ✈ 空中'/'Heathrow'。subはハードコードでLANG分岐なし | 表記ルール一本化: **固有名(厚木/Hawaii/Heathrow)はP0の懐古フックなので保持**、汎用語「Small Map」と状態注記「空中」のみSテーブルでローカライズ。粒度を「地名(+任意で開始状態)」に統一、不統一な✈絵文字は削除 or 全カード統一 | low | S |
| **f5** | 「昔のaddon持ち込み」の見出し・ドロップゾーンが新規語彙で旧モッダーに届きにくい | P0 | `packs-ui.js:47` panelTitle「追加パック」/`:60` dropZone/ja見出しに「アドオン」語なし | panelTitle・dropZone(`:47/60`)とdropHintに「手持ちのアドオン」を追記。**postPlayHint(`:62`)の書き換えは不可**(現状は「取り込んだ機体は Simulation→Create Flight で選べる」=モッダー最大の離脱点を潰す別目的の文言。再利用訴求は見出し/dropZone側に限定) | low | S |
| **f13** | ロード進捗が日本語ロケールでも英語のまま(「loading...」「Downloading data...」) | both | `index.html:169` 初期値「loading...」、`setStatus`(`:587-596`)が Emscripten 英語をそのまま表示。`pitch`はja・進捗はenで不整合 | `setStatus` 内で「Downloading data」を含む時ja「データを読み込み中…」へ差し替え＋`TXT.loading` 新設。**「loading...」リテラルは169行だけでなく `:1478`(join開始時)にも在り両方をTXT経由に** | low | S |
| **f15** | PC で Quick Flight パネルが折りたたみトグル・出典の下に沈みうる | P1 | `packs-ui.js:788-792` は coarse(タッチ)時のみ `insertBefore`、PCは末尾append。`#note`(`:176`)＋トグル2本の下にパネルが積まれる | `:791` の分岐から coarse 限定を外し、PCでも pack panel をjoin form前へ。※実際に上に来るのは1行トグル2本＋#noteで巨大ではない=「主CTAがフォールド外」は誇張、最小IA整合として扱う | low | S |
| **f22** | 折りたたみトグルに `aria-expanded` が無い | both | `index.html:1418-1425`(ジョイン)/`:1450-1455`(ホスト)が素のbuttonでdisplay切替のみ | 両トグルに `aria-expanded="false"` 初期付与＋ハンドラで開閉同期。`aria-controls` はid追加とセットで任意 | low | S |
| **f23** | 入力フィールド(Room ID/名前)が label と紐付かず、エラー文も input 未結合 | both | `index.html:1371/1467` の label変数は実体が div。input は placeholder依存(`:1375-1384/1470-1474`)、err div(`:1386-1387`)は未関連 | 各 input に `aria-label`(**ハードコードでなく既存TXT i18n流用**)。err に `role="alert"`＋`aria-describedby` は副次 | low | S |
| **f24** | ヘルプモーダルにフォーカストラップ・初期フォーカス・role/aria-modal が無い | P0 | `index.html:1078-1110` 素のdiv、role/aria-modal なし。open時 focus移動なし(初回PC Quick Flight時に1回自動open=`:972`、localStorageで端末毎1回) | panel に `role="dialog" aria-modal="true"`＋aria-label、open時 close.focus()、close時トリガへ復帰。完全トラップは余力次第 | low | M |

---

## すぐ効くクイックウィン(effort S・文字列/属性のみ)

実装リスクが最小で、P0インパクトが高い順。**この6本はまとめて1回で着手可能**:

1. **f4** ホストHow-to「右上→右下」修正(`index.html:259/321`) ― 事実不一致の解消。対戦導線の信頼回復。**最優先**。
2. **f1** pitch文字列を既存ファン二段構えに差し替え(`:203/265`) ― フォールドにP0信号を入れる最大の一手。
3. **f25** ホストHow-toにvanilla契約注記1行追加 ― 無音の対戦同期ミスマッチを予告で防ぐ。
4. **f2** `#note`＋OGPに「非公式/unofficial」1語 ― 公式誤認防止＋原作者リスペクト。
5. **f7** 「初回だけ約25MB(次回瞬時・オフライン)」を静的1行で追加＋サイズ表記統一 ― 待ち離脱の最大要因に答える。
6. **f19/f20/f21** a11y三点(色トークン1変更／coarse時44px／`#status` の `aria-live`) ― いずれも数行で複数箇所が同時に直る。

---

## 却下した提案と理由(透明性のため)

- **f9**(モバイル操作案内「離陸でスティックが出る」を待ち時間中に前出し): **スコープ外**。これはP1新規層向けの「操作オンボーディング」そのもので、personas.md がv1で意図的に未着手と確定した領域。P0既存ファンは原典で操作系を熟知しており不要。実装事実(touchHint=`packs-ui.js:50/100`, renderPanel は DL完了後)は正確だが、確定descopeと矛盾。P1主役化のv2で再評価する価値はある。

- **f17**(空状態で postPlayHint を隠す): **事実誤認(IA誤読)**。postPlayHint は「Quick Flightと同居して詰め込み」ではなく、Quick Flightグリッド(`packs-ui.js:660-661`で先にappend)の下にある別セクション(パック管理)見出し直下の、最も淡い`#5d7290`/11pxの補助文。`:667-668` のコメントが「モッダー最大の離脱点(取り込んだ機体が Create Flight に出ると知らない)を潰す」=P0狙いの設計意図を明示。P1視点でP0向け要素を弱める方向で、得る価値が乏しい。改修自体は低コスト無害だが前提が誤読。

---

参照ソース: `/Users/toming/keel/lake/ysflight-web/web/index.html`, `/Users/toming/keel/lake/ysflight-web/web/packs-ui.js`(全行番号を実コードと照合済み)。
