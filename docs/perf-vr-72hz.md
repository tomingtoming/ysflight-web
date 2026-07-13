# ysflight-web VR 72Hz到達のCPU削減 (VR Frame CPU Reduction)

> ステータス: **第1弾実装済み（WebGL状態シャドウ）・実機確認待ち**。
> file:line は upstream エンジン (`upstream/YSFLIGHT` / `upstream/public`, emscripten ブランチ) と本リポジトリのもの。
> 調査日: 2026-07-13。プロファイル基盤は `scripts/profile-vr.mjs` / `scripts/profile-report.mjs`（本調査で新設）。

## 症状

Quest 3S の VR モードで **26.5fps・エンジンCPU 44ms/フレーム**（`Module._YsfwGetTickMs()`、
multiview マージ後の実測）。目標は 72Hz = **13.9ms/フレーム**。CPU律速は確定済み
（tick EMA がフレーム周期に張り付く）。

## 計測方法

```sh
PROFILING=1 ./scripts/build.sh          # --profiling-funcs 付き wasm を dist-prof/ に出す（dist/ は不変）
node scripts/serve.mjs 8935 dist-prof
node scripts/profile-vr.mjs 'http://127.0.0.1:8935/index.html?freeflight=F-15C_EAGLE' out.cpuprofile
node scripts/profile-report.mjs out.cpuprofile   # self-time 上位とカテゴリ別ロールアップ
```

`profile-vr.mjs` は detshot と同じ手順でフライトに入り、`vr.forceMultiview` で VR 描画パスを
強制してから CDP Profiler で 10 秒サンプリングする。ヘッドレス（SwiftShader）なので**絶対値は
実機の予測にならない**が、同一箱内の A/B と自己時間の相対比は有効。
V8 プロファイルの関数分類は `callFrame.url` で行うこと（wasm 実関数は `.wasm`、Blink 組み込みは
空 URL。名前の接頭辞では分類できない — profile-report.mjs のコメント参照）。

## 結論（第1弾）

**エンジンCPUの ~78% が WebGL `getParameter`（`glGetIntegerv`）1種で消えていた。**

犯人はエンジン全域に散る「状態を読んで退避→復元」パターン:

| 呼び出し元 | 照会 | 頻度 |
|---|---|---|
| `YsGLSLUse3DRenderer`（ysglsl3ddrawing.c:860） | `GL_CURRENT_PROGRAM` | **レンダラ有効化毎 = シェルノード毎に1〜4回/フレーム**（RAIIラッパ `YsGLSLRenderer` のコンストラクタ経由） |
| `YsHasShellExtVboSet::Render`（ysshellextgl_gl2.cpp:40） | `GL_FRONT_FACE` | シェルノード毎/フレーム |
| `fsopengl2.0.cpp` 各所 | `GL_BLEND_SRC/DST_RGB`, `GL_VIEWPORT` | 描画フェーズ毎 |
| `ysglslsharedrenderer.c`（12箇所）・`ysglslplain2ddrawing.c` | `GL_CURRENT_PROGRAM` 等 | 設定変更毎 |

ネイティブGLでは `glGetIntegerv` はドライバ内のメモリ読みでほぼ無料。WebGL では
`getParameter` が**GPUプロセスへの同期往復**（コマンドバッファの fire-and-forget が使えない
唯一級のパス）で、1回ごとにパイプラインを止める。ネイティブ由来エンジンの移植で最も踏みやすい
アンチパターン。

## 修正（実装済み・エンジン改変ゼロ）

`web/index.html` の **WebGL状態シャドウ**: `HTMLCanvasElement.prototype.getContext` をフックし、
webgl/webgl2 コンテキストの `useProgram` / `frontFace` / `viewport` / `blendFunc(Separate)` を
ラップして CPU 側に記録。該当7enumの `getParameter` はシャドウから即答し、GPU プロセスに
触れない。他の pname は素通し。**全ての状態書き込みが同じラップ済みメソッドを通る**ので
シャドウは定義上コヒーレント。

### 効果（同一サンドボックス内A/B・ヘッドレス）

| | tick CPU (ms/frame) | getParameter self-time |
|---|---|---|
| 修正前 | ~20（VR強制時） | **77.7%** |
| 修正後 | **~3.6** | 消滅（残るは他enumの~0.4%） |

修正後のプロファイルは 74% が `(idle)`（vsync待ち）。検証: detshot hold 完全一致
（38.1/36.8/40.9）、settle の決定領域 ground=52.9 が本番ビルドと一致、smoke 7本全緑
＝レンダリング同一・状態シャドウの誤答なし。

## 残りのホットスポット（第2弾候補・効果順の見込み）

修正後の self-time 上位（idle除く、いずれも全体の1-2%以下）:

1. **vertex attrib 有効/無効の毎ドロー切替**（`enable/disableVertexAttribArray` 計 ~2.6%）
   — ysgl はレンダラ切替のたび attrib を全部つけ外しする。VAO 化 or 現在状態の差分適用で削れる
2. **`bufferSubData`（~1.3%）** — 2D描画（HUD等）の頂点ストリーミング。リングバッファ化候補
3. **uniform 再アップロード**（`uniformMatrix4fv`+`uniform3fv`+`uniform1f` ~1.4%）
   — 値が変わらないフレームでも毎回送っている。CPU側キャッシュで削減可
4. `wasm-to-js` 境界（~1.7%）— GL呼び出し回数そのものに比例。1〜3が減れば連動して減る

ただし第1弾だけで idle 74% なので、**実機で 72Hz に届くかをまず確認してから**着手判断。

## 実機確認の読み方

VR セッションを終了すると console に `[vr] session avg XX.X fps, YYms CPU/frame (period ZZms)`
が出る（fswebxr.cpp の session end ハンドラ）。CPU/frame がフレーム周期より十分小さければ
CPU律速は解消（以後は GPU/合成律速）。

## 落とし穴メモ

- `--seconds` 省略時に profile-vr.mjs の位置引数パースが index 0 を落とすバグは修正済み
- ヘッドレスでは flat モードの tick が VR強制より大きく出る逆転が観測された（forceMultiview の
  オフスクリーンFBOリダイレクトが default framebuffer 提示コストを飛ばすためと推定）。
  実機比較には使わないこと

## 追補（2026-07-13・実機A/B第2ラウンド）

状態シャドウ後の実機: **61.1fps・7ms CPU**（40.4/34msから改善。34msは前セッションの
内容依存のEMAだった模様）。`?vrscale=0.7`（ピクセル~半分）でも **60.8fps・9ms** →
**GPUフィル律速説は棄却**。CPU 7ms << 13.9ms予算なのに61fps止まり＝ペーシング問題。

**真犯人: フレームレート交渉の属性名タイポ。** 交渉コードが `session.frameRates`
（存在しない）を読んでいたため常にno-opし、セッションはQuest 3Sブラウザ既定の
**90Hz（予算11.1ms）のまま**。11.1msをわずかに超える頻度でvsyncを落とし実効~61fps。
仕様の正しい属性は **`session.supportedFrameRates`**。修正後は72Hz（13.9ms予算）が
granted されるはずで、CPU 7msなら張り付く見込み。granted レートは placard 3行目の
`@NNHz` とセッション後チップの1行目に表示される。
