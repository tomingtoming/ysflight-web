# metrics ── 「どれくらいの人が遊んでいるか」を数える

> ステータス: **稼働**（2026-08-21 導入）。
> 実装: [`web/metrics.js`](../web/metrics.js) → `/metric`（[`worker/signal.js`](../worker/signal.js)）→ Workers Analytics Engine。
> 検査: `test/metrics.test.mjs`（単体）・`scripts/smoke-metrics.mjs`（実ブラウザ）。

## なぜ作ったか ── 既存の3つの計器が答えられなかったこと

導入前、この企画には計器が3つあった。どれも「何人が遊んだか」を答えられない。

| 既存の計器 | 測っているもの | 答えられない理由 |
|---|---|---|
| Cloudflare Web Analytics（`index.html` 末尾のビーコン） | ページビュー・訪問数（保持90日） | **ページビューは飛行ではない**。トップページはランチャーで、エンジンは23MBのDLで、訪問の過半はモバイル |
| ゾーンのpath別リクエスト数（GraphQL `httpRequestsAdaptiveGroups`） | `.data` を落とした回数＝エンジン起動の代理 | **保持8日**・1クエリ1日窓（Freeプラン）。先月の数字はもう存在しない |
| `web/diag.js` → `/clientlog` → Workers Logs | 飛行中/VR中だけ10秒ごとのheartbeat＝実飛行時間 | **保持7日・SQL集計不可**。ハングの検死には効くが、数える道具ではない |

Analytics Engineは**保持3ヶ月・SQLで読める**。今日の飛行を11月に数えられる。
Freeプランで**書き込み10万点/日・読み1万クエリ/日**（実績は1訪問あたり数点なので桁が3つ余る）。

`/clientlog`（Workers Logs）は**残す**。役割が違う——ログは検死、こちらは計数。

## 何を測っているか

イベントは4種類。`web/metrics.js` が `web/diag.js` のイベント列を**購読**して生成する
（metrics側にポーラーは無い。`globalThis.ysfwInFlight` を見張るループはdiagが1つだけ持ち、
2つ持つと「飛行が始まった」の定義が2つになって必ずズレる）。

| イベント | いつ | 主な値 |
|---|---|---|
| `session` | ページロード1回につき1つ | `visits`（この端末の通算訪問回数・1なら初訪問）・`days`（初訪問からの日数）・`ref`（流入元ホスト） |
| `flight-start` | 飛行に入った瞬間 | 機体・フィールド・launch種別・role |
| `flight-end` | 飛行から出た瞬間／離脱時 | `secs`（飛行秒数）・`reason`（`ended` = メニューへ戻った／`left` = タブを閉じた・遷移した） |
| `vr-end` | VRセッション終了 | `secs`・`fps`（平均）・`reason` |

**両端を記録するのが肝**。飛行中にタブを閉じた人は `flight-start` だけを残し、
その差分そのものが「最後まで飛ぶか」の答えになる（`pagehide` では `reason='left'` で
`sendBeacon` に載せるので、多くはそれでも秒数が付く）。

### データポイントの列（SQLはこの並びを前提に書く）

`index1` はビジターID（localStorageの乱数）＝サンプリングキー。

| 列 | 内容 |
|---|---|
| `blob1` | イベント名 `session` / `flight-start` / `flight-end` / `vr-end` |
| `blob2` | launch種別（ディープリンクの種類、エンジンメニューから選ぶ場合は `menu`） |
| `blob3` | 機体（URLが持っているときだけ。[`deeplink.js` `launchTargets`](../web/deeplink.js)） |
| `blob4` | フィールド |
| `blob5` | role `solo` / `host` / `join` |
| `blob6` | デバイス `desktop` / `touch` / `vr` |
| `blob7` | 言語 |
| `blob8` | 流入元ホスト（`session` のみ） |
| `blob9` | 終了理由 |
| `blob10` | audience `public` / `dev`（tomingのQAアクセス） |
| `blob11` | sid（1ページロードのイベントをまとめるID） |
| `blob12` | ビルドID |
| `blob13` | **サーバ側**: リクエストのホスト名（本番とstagingの区別） |
| `blob14` | **サーバ側**: 国コード |
| `double1` | 秒数（飛行 / VR） |
| `double2` | この端末の通算訪問回数（1=初回、0=localStorage不可） |
| `double3` | VR平均FPS |
| `double4` | 初訪問からの日数 |

最後の2列（host・country）はクライアントに名乗らせず**サーバで刻む**。
`blob13` があるので本番とstagingが同じデータセットに同居しても混ざらない。

## 読み方

読み出しは SQL API。**wrangler が持っているトークンでそのまま読める**——Analytics Engine を
アカウントで有効化した時点（2026-08-21）で通るようになった。専用の API トークンは要らない。

> 有効化**前**は同じトークンで `Authentication error` が返っていた。あれは権限不足ではなく
> 「製品が有効になっていない」の意味だった＝**エラーメッセージの額面を信じると1手遠回りする**。

```sh
# 期限切れなら `npx wrangler whoami` を1回叩けば更新される
TOK=$(grep '^oauth_token' ~/.wrangler/config/default.toml | sed 's/.*= *"//;s/"//')
ACC=809e6a1cf10d5cd0491c6dff583a88fe
q() { curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/analytics_engine/sql" \
        -H "Authorization: Bearer $TOK" -H 'Content-Type: text/plain' --data "$1"; }
```

### 方言（先に読むこと）

AEのSQLは**ClickHouseのサブセット**で、よく使う関数がいくつも無い。

| やりたいこと | ❌ 無い | ✅ 使えるもの |
|---|---|---|
| ユニーク数 | `uniq(x)` | `count(DISTINCT x)` |
| 条件付きユニーク | `uniqIf(x, cond)` | 無い。**WHERE で絞った別クエリにする** |
| 分位数 | `quantile(0.5)(x)` | `quantileExactWeighted(0.5)(x, _sample_interval)` |
| 条件付き集計 | — | `countIf` / `sumIf` / `avgIf` は使える |
| 文字列の代表値 | `max(文字列)` | 型エラー。`argMax(文字列, timestamp)` か GROUP BY に含める |

以下のSQLは**全て実物に通してある**（2026-08-23）。

### 日次: 何人が来て、何人が飛んで、何分飛んだか

```sql
SELECT toDate(timestamp) AS day,
       count(DISTINCT index1)                             AS people,
       countIf(blob1 = 'session')                         AS sessions,
       countIf(blob1 = 'flight-start')                    AS starts,
       countIf(blob1 = 'flight-end')                      AS ends,
       round(sumIf(double1, blob1 = 'flight-end') / 60, 1) AS minutes
FROM ysfw_play
WHERE blob10 = 'public'                        -- tomingのQAを除く
  AND blob13 = 'ysflight-web.toming.app'       -- stagingを除く
GROUP BY day ORDER BY day
```

### 到達漏斗（`uniqIf` が無いので2本に割る）

```sql
SELECT count(DISTINCT index1) AS visitors FROM ysfw_play
WHERE blob10 = 'public' AND blob13 = 'ysflight-web.toming.app';

SELECT count(DISTINCT index1) AS people_who_flew FROM ysfw_play
WHERE blob10 = 'public' AND blob13 = 'ysflight-web.toming.app' AND blob1 = 'flight-start';
```

### 飛行時間の分布（平均は外れ値1本で嘘をつく）

```sql
SELECT count() AS flights,
       round(quantileExactWeighted(0.5)(double1, _sample_interval)) AS median_secs,
       round(quantileExactWeighted(0.9)(double1, _sample_interval)) AS p90_secs,
       round(max(double1)) AS longest_secs,
       round(avg(double1)) AS mean_secs
FROM ysfw_play
WHERE blob1 = 'flight-end' AND blob10 = 'public'
```

### 訪問者ごと（誰が本当に遊んでいるか）

```sql
SELECT index1 AS visitor, blob14 AS cc, blob6 AS device,
       countIf(blob1 = 'session')      AS visits,
       countIf(blob1 = 'flight-start') AS starts,
       round(sumIf(double1, blob1 = 'flight-end') / 60, 1) AS minutes
FROM ysfw_play
WHERE blob10 = 'public' AND blob13 = 'ysflight-web.toming.app'
GROUP BY visitor, cc, device ORDER BY visits DESC LIMIT 20
```

### リピート率（`double2` = その端末の通算訪問回数）

```sql
SELECT countIf(double2 = 1) AS first_time,
       countIf(double2 > 1) AS returning,
       countIf(double2 = 0) AS storage_blocked,
       round(max(double2))  AS most_visits_by_one_browser
FROM ysfw_play
WHERE blob1 = 'session' AND blob10 = 'public'
```

### モバイルは本当に遊べているのか

```sql
SELECT blob6 AS device, count(DISTINCT index1) AS people,
       countIf(blob1 = 'session') AS sessions,
       countIf(blob1 = 'flight-start') AS starts,
       round(avgIf(double1, blob1 = 'flight-end')) AS avg_secs
FROM ysfw_play
WHERE blob10 = 'public' AND blob13 = 'ysflight-web.toming.app'
GROUP BY device ORDER BY sessions DESC
```

### 機体・フィールド／飛行の終わり方／流入元

```sql
SELECT blob3 AS aircraft, blob4 AS field, count() AS starts FROM ysfw_play
WHERE blob1 = 'flight-start' AND blob3 != '' AND blob10 = 'public'
GROUP BY aircraft, field ORDER BY starts DESC LIMIT 20;

SELECT blob9 AS reason, count() AS n, round(avg(double1)) AS avg_secs FROM ysfw_play
WHERE blob1 = 'flight-end' AND blob10 = 'public' GROUP BY reason;

SELECT blob8 AS referrer, count() AS sessions FROM ysfw_play
WHERE blob1 = 'session' AND blob10 = 'public' GROUP BY referrer ORDER BY sessions DESC
```

### 初回の実測（2026-08-21 09:20 UTC 導入 〜 08-23、約2.2日・tomingのdev分を除く）

参考値として残す。**n が小さいので比率を主張しない**。

- 訪問者20（ブラウザ単位）・68セッション・**うち8人が実際に飛んだ**
- 飛行19回開始／15回終了、飛行時間は中央値108秒・p90 663秒・**最長1327秒（22分）**
- 終わり方は `ended` 5回（平均348秒）に対し **`left` 10回（平均188秒）＝3分の2は飛行中に離脱**
- 機体は CESSNA_172R / SMALL_MAP が7回で最多、以下 F-18C/厚木4・F-15J/ハワイ4・B747/ヒースロー3
- 起動は `freeflight` 18・`createflight` 1、**`menu` 0＝エンジン本家メニュー発の飛行はゼロ**
- 国は CN 15人・US 3人・CH 1人・HU 1人。最も遊んでいるのは CH のdesktop（15訪問8飛行）と CN のtouch（11訪問・計38.6分）

### 2週目の実測（導入〜2026-08-27、約6.5日・prodのみ・dev除外）

- 訪問者82・218セッション・**21人が飛んだ（26%）**・飛行67開始/45終了・合計128.5分
- 飛行時間は中央値99秒・p90 323秒・最長1327秒。終わり方は `ended` 20 / `left` 25
- **`menu` 発の飛行は14回・5人**——初回実測の「menu 0」は n=19 では出ていなかっただけで、**エンジン本家メニューは使われている**
- **touch のほうが長く飛ぶ**（平均212秒 / desktop 104秒）。ただし**完走報告率は touch 60%・desktop 85%** なので、touch側の合計分数は過小に出る
- 国は CN 69人（84%）。流入は direct 199・google 9・`m.baidu.com` 4・**`doubao.com` 3**・`weixin110.qq.com` 1
- **`vr-end` は6.5日間ゼロ**。VRに入った人がいないのか、計器が着弾していないのかは**この数字では区別できない**（実機で1回入って確かめること）
- 層①（Web Analytics）の同期間は pv 230 / 訪問138 で、AEのセッション218とほぼ一致＝独立した2つの計器が同じ絵を出している

## 部屋を数える（`ysfw_room`・2026-08-28追加）

`ysfw_play` の `blob5`（role）は **`?host=1` のページを開いた瞬間**に立つ＝**意図**であって部屋ではない。導入初週の実測でこれが効いた: 08-24の05:04〜05:08に3人が別々にホストのURLを開いたのに、**シグナリングhubが見たソケットはその日ゼロ**。`ysfw_play` だけでは「繋がらなかった」のか「計器がクライアントで止まっている」のかを**区別できない**。

`ysfw_room` は**hubが実際に見た事実**を書く。worker は同じ事象を `log()` でWorkers Logsにも吐いているが、あちらは7日で消え、しかも**この端末のトークンでは読めない**（限界5）。

**別データセットにしたのは意図的**——`ysfw_play` の `index1` はブラウザ、`ysfw_room` の `index1` は部屋。混ぜると、既に書いた `count(DISTINCT index1)` のクエリが**部屋を人として数える**。

### 列

| 列 | 中身 |
|---|---|
| `index1` | 部屋キーの**8桁ハッシュ**。⚠ **キーそのものは書かない**——`{t:'join',room}` が入室の全てなので部屋キーは**入室capability**であり、3ヶ月残る場所に生の招待コードを置かない。ハッシュは安定なので「同じ部屋」の grouping は効く |
| `blob1` | `room-open` / `room-join` / `room-join-fail` / `room-taken` / `room-close` |
| `blob2` | `game` / `pack`（`~p` 付きのパック配布部屋。1セッションが両方作るので、この列で割らないと部屋が倍に見える） |
| `blob3` | `no-room` / `hostless` / `grace-expired` / 空 |
| `blob4` | ホスト名（本番とstagingの分離） |
| `blob5` | 国 |
| `double1` | その時点のpeer数 |
| `double2` | **peak**＝その部屋が持った最大peer数（**0＝誰も来なかった**） |
| `double3` | 部屋の寿命（秒・close時） |
| `double4` | ホストが提示したアドオンパック数 |

⚠ **peak が要る理由**: 閉じる時点では peers は必ず空なので、`double1` だけ見ると「2人で遊んだ部屋」と「誰も来なかった部屋」が同じ行になる。

### 引き方

```sql
-- 部屋は立ったか、2人目は来たか（本番のゲーム部屋だけ）
SELECT toDate(timestamp) AS day,
       countIf(blob1 = 'room-open')      AS rooms,
       countIf(blob1 = 'room-join')      AS joins,
       countIf(blob1 = 'room-join-fail') AS stale_invites,
       countIf(blob1 = 'room-taken')     AS collisions
FROM ysfw_room
WHERE blob2 = 'game' AND blob4 = 'ysflight-web.toming.app'
GROUP BY day ORDER BY day
```

```sql
-- 閉じた部屋の顛末（peak 0 = 誰も来なかった / secs = 待っていた時間）
SELECT count() AS rooms,
       countIf(double2 = 0) AS nobody_came,
       countIf(double2 > 0) AS had_company,
       round(quantileExactWeighted(0.5)(double3, _sample_interval)) AS median_secs
FROM ysfw_room
WHERE blob1 = 'room-close' AND blob2 = 'game' AND blob4 = 'ysflight-web.toming.app'
```

**読み分け**——`joins` も `stale_invites` も0なら**誰も招待リンクを踏んでいない**（＝共有されていない）。`joins` が0で `stale_invites` が立つなら**踏まれてはいるが部屋が消えている**（招待リンクの寿命の問題）。この2つは `ysfw_play` からは同じ「join 0」に見える。

## 運用

- **tomingの端末は1回だけ `?metrics=dev` を付けて開く**（端末ごと・ブラウザごと。2026-08-23に toming-desktop / toming-server / macbook / Quest 3S / Pixel 9 Pro で実施済み——集計に `aud='dev'` として現れることを確認した）。
  以後その端末の全イベントに `blob10='dev'` が付き、上のSQLの `blob10='public'` から外れる。
  戻すのは `?metrics=public`。この規模では自分のQAが数字を支配するので、**これをやらないと計器は自分を測る**。
- **オプトアウト**は `?metrics=off`（その端末で以後いっさい送らない）。
- **stagingへのデプロイは同じデータセットに書く**。SQLで `blob13` を本番に絞ること。

## 限界（数字を読むときに忘れないこと）

1. **飛行秒数は±1秒程度ずれる**。diagのポーリングが1Hzで、メインスレッドが重いとさらに遅れる。分単位の飛行を測る分には問題ないが、秒単位の精度を主張しない。
2. **機体・フィールドはURLが持っているときだけ**。エンジンのメニューから選んだ飛行、Create Flight・ミッション（.yfs経由）では空になる。母数は `blob3 != ''` で絞ること。
3. **「人」ではなく「ブラウザ」を数えている**。同じ人の別端末は別人に見え、共有PCの2人は1人に見える。localStorageを消せば新規訪問者になる。
4. **localStorageが使えない環境は `double2 = 0`**。初訪問（1）と区別できるようにしてある。「分からなかった」を「初訪問」に混ぜない。
5. **XRiftのワールドは対象外**（`app.xrift.net` にホストされるので、こちらのアカウントからは原理的に見えない）。
6. **botを弾いていない**。Cloudflare Web Analytics には bot 列があるがこのデータセットには無く、**JSを実行するクローラは人として数えられる**。訪問回数だけ多くて `flight-start` がゼロの `index1` はそれを疑う（訪問者ごとのSQLがそのための窓）。
7. **計測しているのは `index.html`（ゲーム本体のページ）だけ**。ワークベンチ・各スタジオページの利用は入っていない（必要になったらそこにも `metrics.js` を載せる。1行）。
8. **`blob7`（lang）は 2026-08-28 より前の行では常に空**。`classify()` は拾っていたのに `fields()` が載せていなかった（＝クライアントからサーバへ一度も出ていない）。導入初週の342行は全部空なので、**言語で切るクエリは `blob7 != ''` で母数を絞る**か日付で切ること。同じ値しか返さない列は「世界が一様」と見分けがつかない、の実例。⚠ **`blob12`（build）では前後を分けられない**——`BUILD_ID` は `scripts/build.sh` がエンジンの js/wasm/data とシェルのハッシュから作るので、`metrics.js` だけが変わったビルドは**同じIDのまま**（この修正の前後とも `5d48fda4044b`）。分けられるのは時刻だけ。
9. **アドブロッカーで落ちる分がある**。`/metric` は自ドメイン・同一オリジンなので Web Analytics のビーコンよりは通りやすいが、ゼロではない。∴ **絶対数の下限**として読む。
