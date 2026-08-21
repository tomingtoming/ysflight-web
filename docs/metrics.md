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

読み出しは SQL API。**Account Analytics Read を持つAPIトークンが要る**
（wranglerのOAuthトークンでは通らない＝`Authentication error`）。

### 1回だけの準備 ── 読み取りトークンを作る

1. ダッシュボード → My Profile → API Tokens → Create Token → Custom token
2. Permissions: **Account** → **Account Analytics** → **Read**
3. Account Resources: `tomingtoming` のみ
4. 作られたトークンを手元に保存（例: `~/.config/cf-analytics-token`, `chmod 600`）

```sh
TOK=$(cat ~/.config/cf-analytics-token)
ACC=809e6a1cf10d5cd0491c6dff583a88fe
q() { curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/analytics_engine/sql" \
        -H "Authorization: Bearer $TOK" -H 'Content-Type: text/plain' --data "$1"; }
```

### 日次: 何人が来て、何人が飛んで、どれだけ飛んだか

```sql
SELECT toDate(timestamp) AS day,
       uniq(index1)                                        AS people,
       uniqIf(index1, blob1 = 'flight-start')              AS people_who_flew,
       countIf(blob1 = 'flight-end')                       AS flights,
       round(sumIf(double1, blob1 = 'flight-end') / 60, 1) AS minutes_flown
FROM ysfw_play
WHERE timestamp > now() - INTERVAL '30' DAY
  AND blob10 = 'public'          -- tomingのQAを除く
  AND blob13 = 'ysflight-web.toming.app'  -- stagingを除く
GROUP BY day ORDER BY day
```

### 到達漏斗（トップに来た人のうち、実際に飛ぶのは何割か）

```sql
SELECT uniq(index1)                            AS visitors,
       uniqIf(index1, blob1 = 'flight-start')  AS flew,
       uniqIf(index1, blob1 = 'flight-end' AND double1 >= 60) AS flew_over_a_minute
FROM ysfw_play
WHERE timestamp > now() - INTERVAL '7' DAY AND blob10 = 'public'
```

### リピート率（`double2` = その端末の通算訪問回数）

```sql
SELECT countIf(double2 = 1) AS first_timers,
       countIf(double2 > 1) AS returning,
       countIf(double2 = 0) AS storage_blocked
FROM ysfw_play
WHERE blob1 = 'session' AND timestamp > now() - INTERVAL '30' DAY AND blob10 = 'public'
```

### 飛行時間の分布（平均は外れ値1本で嘘をつく）

```sql
SELECT quantile(0.5)(double1)  AS median_secs,
       quantile(0.9)(double1)  AS p90_secs,
       max(double1)            AS longest
FROM ysfw_play
WHERE blob1 = 'flight-end' AND double1 > 0
  AND timestamp > now() - INTERVAL '30' DAY AND blob10 = 'public'
```

### モバイルは本当に遊べているのか

訪問の過半はモバイル（Web Analytics実測 2026-08-21）だが、23MBのDLと
操作系を考えると離脱している可能性が高い——それを裁く問い。

```sql
SELECT blob6 AS device, uniq(index1) AS people,
       countIf(blob1 = 'flight-start') AS flights,
       round(avgIf(double1, blob1 = 'flight-end')) AS avg_secs
FROM ysfw_play
WHERE timestamp > now() - INTERVAL '30' DAY AND blob10 = 'public'
GROUP BY device
```

### 機体とフィールドの人気（URLが持っていた分だけ）

```sql
SELECT blob3 AS aircraft, blob4 AS field, count() AS flights
FROM ysfw_play
WHERE blob1 = 'flight-start' AND blob3 != ''
  AND timestamp > now() - INTERVAL '90' DAY AND blob10 = 'public'
GROUP BY aircraft, field ORDER BY flights DESC LIMIT 20
```

## 運用

- **tomingの端末は1回だけ `?metrics=dev` を付けて開く**（端末ごと・ブラウザごと）。
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
6. **計測しているのは `index.html`（ゲーム本体のページ）だけ**。ワークベンチ・各スタジオページの利用は入っていない（必要になったらそこにも `metrics.js` を載せる。1行）。
7. **アドブロッカーで落ちる分がある**。`/metric` は自ドメイン・同一オリジンなので Web Analytics のビーコンよりは通りやすいが、ゼロではない。∴ **絶対数の下限**として読む。
