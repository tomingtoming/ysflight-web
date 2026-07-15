// DNM/SRF geometry linter — the "nightmare linter".  Every rule here is a
// pathology that real test flights surfaced in this repo: drop one format
// attribute and it comes back as a visible haunting (flat shading, black
// wing edges, sawtooth hinge lines, doubled-up parts...).  The linter makes
// those failures machine-checkable at import time and inside the studio,
// instead of waiting for a flight to reveal them.
//
// Pathology catalogue (the "nightmare" series — primary sources in-repo):
//   #1 missing N lines        gen-aircraft-from-spec.mjs header: a face
//                             without N keeps a zero normal and falls back to
//                             two-sided camera-facing shading (flat/dark).
//   #2 N vs winding mismatch  the engine auto-flips winding to match N
//                             (ysvisual.cpp FixOrientationBasedOnAssignedNormal)
//                             but previews/glTF derive normals from winding,
//                             so disagreement shows as inverted shading there.
//   #7 R on thin plates       R (round) vertices shared by a thin wing's upper
//                             and lower skins average to an edge-on normal ->
//                             black LE/TE strips (dnm-gltf.js: "edge-on
//                             averaged normals (dark patches)").
//   #8 spurious R spray       glb->dnm used to mark R on flat faces; only
//                             genuine smoothing has per-corner normal spread
//                             (fixed by the intra-triangle variance gate,
//                             commit 978f314) — but sprayed files still exist.
//   hinge z-fight             exactly coplanar overlapping faces (fixed wing
//                             TE closure vs control-surface LE) sawtooth at
//                             range; the compiler leaves a 5cm hinge gap.
//   double-applied absolutes  DNM vertices are ABSOLUTE aircraft coordinates;
//                             a rest transform that displaces far-from-origin
//                             geometry usually means POS was applied on top of
//                             absolute verts (the webflight nightmare,
//                             commit bb0f1e9).
//   ZA / B attributes         ZA alpha = (255-value)/255 (ysshellextio.cpp);
//                             B = self-lit.  Real lights belong in CLA 30..34
//                             nodes (workbench.js protects those in the paint
//                             shop) — B quads baked into static geometry are
//                             probably lights that won't behave like lights.
//   STA visibility            a retractable part whose STA states never set
//                             vis=0 stays visible when retracted (STA's 7th
//                             field, ysshelldnmtemplate.h).
//   15-bit / broken colors    C lines are 0..255 RGB(A) or a packed 15-bit
//                             value; out-of-range tokens render as garbage
//                             (the all-red aircraft).
//
// Design: pure module (no DOM/Three/Node APIs) on top of web/dnm-parse.js,
// usable from the studio, the pack importer, Node tests and the Deno CLI.
// Severities are deliberately multi-threshold and calibrated against the
// stock fleet (see test/dnm-lint.test.mjs): stock aircraft must lint clean of
// errors and near-clean of warnings, or the tool trains people to ignore it.

import { parseDnm, parseSrf, faceNormal } from './dnm-parse.js';

const A2R = Math.PI / 32768;

// --- rule catalogue (id -> severity policy is applied per finding below) ---------

export const RULES = {
  'missing-normal': {
    nightmare: 1,
    ja: {
      title: 'N行（明示法線）の無い面',
      why: 'エンジンはF面のNを照明とワインディング補正の基準にする（FixOrientationBasedOnAssignedNormal）。N無しはゼロ法線→両面カメラ向きフォールバックでフラット/暗転（悪夢第1項）。',
      fix: '各F面に「N cx cy cz nx ny nz」を出力する。glb取り込みなら最新の変換器で再取り込み。',
    },
    en: {
      title: 'Faces without an assigned N normal',
      why: 'The engine lights by the assigned N and corrects winding against it; a face without N keeps a zero normal and falls back to two-sided camera-facing shading (nightmare #1).',
      fix: 'Emit "N cx cy cz nx ny nz" per face (re-import through the current glb converter if this came from Blender).',
    },
  },
  'normal-winding-mismatch': {
    nightmare: 2,
    ja: {
      title: 'N法線と頂点順（ワインディング）の不一致',
      why: 'エンジンはロード時にN基準で巻きを反転して自己修復するが、プレビュー/glTF側は巻きから法線を導くため食い違って陰影が裏返る（悪夢第2項）。少数は正常でもあり得る（stock b747は810:24）。',
      fix: '面の頂点順をNの向きに合わせて統一する（モデラーで法線を再計算）。',
    },
    en: {
      title: 'Assigned N disagrees with the vertex winding',
      why: 'The engine self-heals by flipping winding to match N at load, but previews/glTF derive normals from winding, so shading inverts there (nightmare #2). A few are normal (stock b747: 810:24).',
      fix: 'Reorder face vertices to agree with N (recompute normals in the modeler).',
    },
  },
  'edge-on-round-vertex': {
    nightmare: 7,
    ja: {
      title: '薄板のR頂点（平均法線がエッジオン化）',
      why: 'R頂点は隣接面の平均法線で陰影される。薄い翼のLE/TE/翼端で上下スキンを共有すると平均が打ち消されてエッジオン→真っ黒に沈む（悪夢第7項）。',
      fix: '薄板の縁ではRを外す（フラットにする）か、上下スキンの頂点を分離する。',
    },
    en: {
      title: 'R (round) vertices on thin plates (edge-on averaged normal)',
      why: 'An R vertex is shaded by the average of its adjacent face normals; where a thin wing\'s upper and lower skins share it, the average cancels to edge-on and the strip goes black (nightmare #7).',
      fix: 'Drop the R flag along thin-plate edges (keep them flat) or split the shared vertices.',
    },
  },
  'spurious-round-vertex': {
    nightmare: 8,
    ja: {
      title: '偽R散布（曲率の無い所のR頂点）',
      why: '隣接面の法線がほぼ同一＝滑らかにする曲率が無いのにRが付いている。glb→dnm変換の古い癖で、わずかな捻れと組むと暗斑の温床になる（悪夢第8項）。',
      fix: 'フラット面のRを外す。glb由来なら最新の変換器（面内法線分散ゲート入り）で再取り込み。',
    },
    en: {
      title: 'Spurious R spray (round vertices with no curvature)',
      why: 'Adjacent face normals are near-identical — there is nothing to smooth — yet the vertex is marked R. A legacy glb->dnm artifact that breeds dark patches once any twist appears (nightmare #8).',
      fix: 'Remove R from flat regions; re-import glb files through the current converter (intra-triangle variance gate).',
    },
  },
  'coplanar-overlap': {
    nightmare: null,
    ja: {
      title: '同一平面で重なる面ペア（Zファイト）',
      why: '完全に同一平面で重なる面（固定翼後縁の閉じ面と舵面前縁など）は遠景でノコギリ状にちらつく。機体コンパイラはヒンジに5cmの隙間を空けている。',
      fix: '重なる面の間に数cmの隙間を空けるか、片方を削除する。',
    },
    en: {
      title: 'Coplanar overlapping face pairs (z-fighting)',
      why: 'Faces lying in exactly the same plane and overlapping (fixed-wing TE closure vs control-surface LE) shimmer as sawtooth at range. The aircraft compiler leaves a 5cm hinge gap.',
      fix: 'Separate the overlapping faces by a few centimeters, or delete one of them.',
    },
  },
  'rest-transform-displacement': {
    nightmare: null,
    ja: {
      title: '絶対座標への変換二重適用の兆候',
      why: 'DNM頂点は機体絶対座標。原点から遠いジオメトリを静止変換がさらに動かしている＝POSの二重適用（webflightの悪夢）や、逆にPOS前提のローカル座標の混入が疑われる。',
      fix: '静止状態で部品が正位置に見えるか確認。絶対座標ならPOSとCNTを一致させる（またはPOSを0に）。',
    },
    en: {
      title: 'Signs of double-applied absolute coordinates',
      why: 'DNM vertices are absolute aircraft coordinates; a rest transform that displaces far-from-origin geometry suggests POS applied on top of absolute verts (the webflight nightmare) or local-coordinate geometry mixed in.',
      fix: 'Check the part sits correctly at rest; for absolute verts keep POS equal to CNT (or zero POS).',
    },
  },
  'za-invalid': {
    nightmare: null,
    ja: {
      title: 'ZA（面透明度）行の値域・書式異常',
      why: 'エンジンは alpha=(255-値)/255 で読む。255超えや負値・奇数トークン・面数超えの参照は透明度が壊れる（stockのアフターバーナー炎が不透明錐になる系）。',
      fix: 'ZAは「面番号 値」のペア列・値は0..255・面番号は面数未満にする。',
    },
    en: {
      title: 'ZA (per-face translucency) range/format problems',
      why: 'The engine reads alpha=(255-value)/255; values beyond 0..255, dangling tokens or face indices past the face count corrupt translucency (opaque afterburner cones).',
      fix: 'Write ZA as "faceIndex value" pairs with values 0..255 and indices below the face count.',
    },
  },
  'bright-outside-light-node': {
    nightmare: null,
    ja: {
      title: 'ライトクラス外の小さなB（発光）面',
      why: 'ナビライト類の正解はCLA 30..34のライトノード（塗装保護・点滅制御が効く）。静的ジオメトリに焼き込まれた小さなB面は「ライトのつもり」の疑い。',
      fix: 'ライトはCLA 30..34の子ノードに分離する（stockの新しい機体やテンプレの Beacon が手本）。',
    },
    en: {
      title: 'Small self-lit (B) faces outside light-class nodes',
      why: 'Proper lights live in CLA 30..34 nodes (paint-shop protection, blink control). Small B faces baked into static geometry are probably lights that will not behave like lights.',
      fix: 'Move lights into CLA 30..34 child nodes (see the template\'s Beacon node).',
    },
  },
  'retract-never-hidden': {
    nightmare: null,
    ja: {
      title: '格納ノードにvis=0のSTAが無い',
      why: 'STA末尾のvisフラグ0が格納状態の非表示を作る。無いと脚などが格納しても消えず、胴体から透けて見える。',
      fix: '格納側のSTA行の末尾を0にする（例: STA 0 0 0 0 0 0 0）。',
    },
    en: {
      title: 'Retractable node never sets STA vis=0',
      why: 'The trailing vis flag 0 on an STA line is what hides the retracted state; without it the gear stays visible inside the fuselage when retracted.',
      fix: 'Set the retracted STA line\'s trailing flag to 0 (e.g. "STA 0 0 0 0 0 0 0").',
    },
  },
  'bad-color': {
    nightmare: 9,
    ja: {
      title: '色行（C）の値域・書式の壊れ',
      why: 'Cは「r g b [a]」(0..255)か15bitパック値1個。範囲外や非数値はエンジンの読みがずれて機体が真っ赤などに化ける（悪夢第9項）。',
      fix: 'C行を 0..255 のRGBか 0..32767 のパック値に直す。',
    },
    en: {
      title: 'Broken C color lines (range/format)',
      why: 'C is "r g b [a]" in 0..255 or one packed 15-bit value; out-of-range or non-numeric tokens skew the read and the aircraft renders solid red or worse (nightmare #9).',
      fix: 'Fix C lines to RGB in 0..255 or a packed value in 0..32767.',
    },
  },
  'bad-face-index': {
    nightmare: null,
    ja: {
      title: 'F面の頂点番号が頂点数を超えている',
      why: '存在しない頂点を参照する面はゴミ三角形や描画欠けになる。',
      fix: '面のV行の番号を頂点数未満に直す。',
    },
    en: {
      title: 'Face vertex index out of range',
      why: 'A face referencing a nonexistent vertex renders as garbage triangles or holes.',
      fix: 'Fix the face\'s V indices to be below the vertex count.',
    },
  },
  'broken-reference': {
    nightmare: null,
    ja: {
      title: 'FIL/CLDの参照切れ',
      why: 'ノードが存在しないSRFや子ノードを参照している。部品が丸ごと出ない原因。',
      fix: 'FILのSRF名・CLDの子ノード名を実在する名前に直す。',
    },
    en: {
      title: 'Dangling FIL/CLD reference',
      why: 'A node references a missing embedded SRF or child node — whole parts silently vanish.',
      fix: 'Point FIL/CLD at names that actually exist in the file.',
    },
  },
};

// --- thresholds (calibrated against the stock fleet; see test/dnm-lint.test.mjs) --

const TH = {
  // Ratio of shaded (non-B) faces without N.  Stock tops out at 58%
  // (t2bluecoarse); the converter-dropped-N catastrophe is ~100%.
  missingN: { error: 0.90, warn: 0.60, info: 0.02 },
  // N-vs-winding disagreement is info AT MOST: the engine self-heals it and
  // stock is full of it (a10: 89% of faces) — only the ratio is reported.
  mismatch: { info: 0.05, minFaces: 12 },
  edgeOnStrong: 0.15,    // |mean adjacent normal| below this = truly edge-on (black)
  edgeOnMild: 0.35,      // ...below this = suspicious
  edgeOnWarnCount: 20,   // strong hits per SRF before warn (stock coarse max: 14)
  edgeOnInfoMild: 8,     // mild-only hits per SRF before info
  spuriousDot: 0.99995,  // adjacent normals all within ~0.6deg = nothing to smooth
  spuriousRatio: 0.5, spuriousMinR: 24, // spray = most of many R verts spurious (info)
  coplanarEps: 0.006,    // plane distance (m) still considered "same plane"
  coplanarAngle: 0.99995,// |n1.n2| above this = parallel
  overlapMinArea: 3e-4,  // m^2 of true polygon-polygon overlap
  overlapMinFrac: 0.03,  // ...and at least this fraction of the smaller face
  overlapNearFrac: 0.7,  // covers this much of BOTH faces = duplicate footprint
  overlapOppMinArea: 0.01, // opposite-facing pairs (stock two-sided idiom) need this much
  displacement: { min: 1.0, centroid: 2.0 }, // rest displacement (m) / centroid distance
  brightMaxArea: 0.5,    // m^2: a "small" B face that smells like a baked light
};

// --- tiny pure matrix helpers (engine-exact, same math as dnm-gltf.js; kept
// local so this module depends on dnm-parse.js alone) ------------------------------

const mul = (A, B) => {
  const O = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      O[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c] + A[r * 4 + 3] * B[12 + c];
    }
  }
  return O;
};
const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const rotXZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const rotZY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const rotXY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const nodeMatrix = (pos, sta, cnt) => {
  let M = T(pos[0] || 0, pos[1] || 0, pos[2] || 0);
  M = mul(M, rotXZ((pos[3] || 0) * A2R));
  M = mul(M, rotZY((pos[4] || 0) * A2R));
  M = mul(M, rotXY((pos[5] || 0) * A2R));
  if (sta) {
    M = mul(M, T(sta[0] || 0, sta[1] || 0, sta[2] || 0));
    M = mul(M, rotXZ((sta[3] || 0) * A2R));
    M = mul(M, rotZY((sta[4] || 0) * A2R));
    M = mul(M, rotXY((sta[5] || 0) * A2R));
  }
  M = mul(M, T(-(cnt[0] || 0), -(cnt[1] || 0), -(cnt[2] || 0)));
  return M;
};
const apply = (M, v) => [
  M[0] * v[0] + M[1] * v[1] + M[2] * v[2] + M[3],
  M[4] * v[0] + M[5] * v[1] + M[6] * v[2] + M[7],
  M[8] * v[0] + M[9] * v[1] + M[10] * v[2] + M[11],
];
const I16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Raw (never N-flipped) Newell normal + area of a face; the sign is the
// winding's own, which is exactly what rule #2 compares against N.
function newell(verts, idx) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < idx.length; i++) {
    const a = verts[idx[i]], b = verts[idx[(i + 1) % idx.length]];
    if (!a || !b) continue;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz);
  return { n: l ? [nx / l, ny / l, nz / l] : [0, 0, 0], area: l / 2 };
}

const b2s = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};

// --- findings --------------------------------------------------------------------

const finding = (rule, severity, where, count, detail, examples) => ({
  rule, severity,
  node: (where && where.node) || null,
  srf: (where && where.srf) || null,
  count: count === undefined ? 1 : count,
  detail: detail || '',
  examples: examples || [],
  nightmare: RULES[rule].nightmare,
  title: { ja: RULES[rule].ja.title, en: RULES[rule].en.title },
  why: { ja: RULES[rule].ja.why, en: RULES[rule].en.why },
  fix: { ja: RULES[rule].ja.fix, en: RULES[rule].en.fix },
});

// --- per-SRF geometry checks -------------------------------------------------------

// kind: 'visual' (default, everything on) | 'collision' | 'cockpit'.
// Collision shells are never rendered, so shading rules stay quiet for them.
function lintSrfGeometry(srf, where, out, stats, kind) {
  const shaded = kind !== 'collision';
  const faces = srf.faces, verts = srf.vertices;
  stats.faces += faces.length;

  // bad-face-index (always: broken geometry breaks collision too)
  let badIdx = 0;
  const badIdxEx = [];
  faces.forEach((f, i) => {
    if (f.idx.some((v) => !Number.isInteger(v) || v < 0 || v >= verts.length)) {
      badIdx++;
      if (badIdxEx.length < 8) badIdxEx.push(i);
    }
  });
  if (badIdx) out.push(finding('bad-face-index', 'error', where, badIdx, 'faces: ' + badIdxEx.join(', '), badIdxEx));

  // #1 missing N + #2 N vs winding (per SRF counts; severity decided per model).
  // Self-lit (B) faces are exempt: the engine does not shade them, so a zero
  // normal is harmless there (stock bakes plenty of N-less light quads).
  let noN = 0, mism = 0, withN = 0, shadedFaces = 0;
  const noNEx = [], misEx = [];
  faces.forEach((f, i) => {
    if (f.unlit) return;
    shadedFaces++;
    const { n } = newell(verts, f.idx);
    if (!f.nom) {
      noN++;
      if (noNEx.length < 8) noNEx.push(i);
    } else {
      withN++;
      if (n[0] * f.nom[0] + n[1] * f.nom[1] + n[2] * f.nom[2] < 0) {
        mism++;
        if (misEx.length < 8) misEx.push(i);
      }
    }
  });
  if (shaded) {
    stats.noN += noN; stats.withN += withN; stats.mismatch += mism;
    if (noN) stats.noNBySrf.push({ where, count: noN, total: shadedFaces, examples: noNEx });
    if (mism) stats.mismatchBySrf.push({ where, count: mism, total: shadedFaces, examples: misEx });
  }

  // R-vertex rules (#7 thin plates, #8 spray) — need adjacency
  if (shaded && (srf.smooth || []).some(Boolean)) {
    const adj = new Map(); // R vertex -> [engine-oriented adjacent normals]
    for (const f of faces) {
      const n = faceNormal(srf, f);
      for (const vi of f.idx) {
        if (!srf.smooth[vi]) continue;
        (adj.get(vi) || adj.set(vi, []).get(vi)).push(n);
      }
    }
    let strong = 0, mild = 0, spurious = 0, rTotal = 0;
    const edgeEx = [], spurEx = [];
    for (const [vi, ns] of adj) {
      rTotal++;
      if (ns.length < 2) continue;
      let sx = 0, sy = 0, sz = 0, minDot = 1;
      for (const n of ns) { sx += n[0]; sy += n[1]; sz += n[2]; }
      for (let i = 0; i < ns.length; i++) {
        for (let k = i + 1; k < ns.length; k++) {
          const d = ns[i][0] * ns[k][0] + ns[i][1] * ns[k][1] + ns[i][2] * ns[k][2];
          if (d < minDot) minDot = d;
        }
      }
      const meanLen = Math.hypot(sx, sy, sz) / ns.length;
      if (meanLen < TH.edgeOnStrong) {
        strong++;
        if (edgeEx.length < 8) edgeEx.push(vi);
      } else if (meanLen < TH.edgeOnMild) {
        mild++;
        if (edgeEx.length < 8) edgeEx.push(vi);
      } else if (minDot > TH.spuriousDot) {
        spurious++;
        if (spurEx.length < 8) spurEx.push(vi);
      }
    }
    stats.rTotal += rTotal; stats.rEdgeOn += strong + mild; stats.rSpurious += spurious;
    if (strong || mild) {
      const sev = strong >= TH.edgeOnWarnCount ? 'warn'
        : (strong >= 1 || mild >= TH.edgeOnInfoMild) ? 'info' : null;
      if (sev) {
        out.push(finding('edge-on-round-vertex', sev, where, strong + mild,
          strong + ' edge-on / ' + mild + ' borderline; vertices: ' + edgeEx.join(', '), edgeEx));
      }
    }
    if (spurious && rTotal >= TH.spuriousMinR && spurious / rTotal >= TH.spuriousRatio) {
      out.push(finding('spurious-round-vertex', 'info', where, spurious,
        spurious + '/' + rTotal + ' R vertices have no curvature; vertices: ' + spurEx.join(', '), spurEx));
    }
  }
}

// --- raw text scan (value/format validation the lenient parser forgives) ------------

function scanSrfLines(lines, where, out) {
  let faceCount = 0;
  for (const l of lines) {
    if (l.trim().split(/\s+/)[0] === 'F') faceCount++;
  }
  let badColor = 0, badZa = 0;
  const colEx = [], zaEx = [];
  lines.forEach((raw, li) => {
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'C') {
      const tok = t.slice(1);
      let bad = false;
      if (tok.length === 0 || tok.length === 2) bad = true;
      else if (tok.length === 1) {
        const v = Number(tok[0]);
        bad = !Number.isFinite(v) || v < 0 || v > 32767 || Math.round(v) !== v;
      } else {
        bad = tok.slice(0, 4).some((s) => {
          const v = Number(s);
          return !Number.isFinite(v) || v < 0 || v > 255;
        });
      }
      if (bad) { badColor++; if (colEx.length < 8) colEx.push(li + 1); }
    } else if (t[0] === 'ZA') {
      const tok = t.slice(1);
      let bad = tok.length === 0 || tok.length % 2 !== 0;
      for (let k = 0; k + 1 < tok.length; k += 2) {
        const fi = Number(tok[k]), v = Number(tok[k + 1]);
        if (!Number.isInteger(fi) || fi < 0 || fi >= faceCount || !Number.isFinite(v) || v < 0 || v > 255) bad = true;
      }
      if (bad) { badZa++; if (zaEx.length < 8) zaEx.push(li + 1); }
    }
  });
  if (badColor) out.push(finding('bad-color', 'error', where, badColor, 'lines (within block): ' + colEx.join(', '), colEx));
  if (badZa) out.push(finding('za-invalid', 'warn', where, badZa, 'lines (within block): ' + zaEx.join(', '), zaEx));
}

// --- model-level ratio findings (#1/#2 severity from stock-calibrated thresholds) ----

function ratioFindings(out, stats) {
  const total = stats.noN + stats.withN;
  if (total > 0 && stats.noN > 0) {
    const r = stats.noN / total;
    const sev = r >= TH.missingN.error ? 'error'
      : r >= TH.missingN.warn ? 'warn'
      : r >= TH.missingN.info ? 'info' : null;
    if (sev) {
      const worst = stats.noNBySrf.sort((a, b) => b.count - a.count).slice(0, 4);
      out.push(finding('missing-normal', sev, worst[0] && worst[0].where, stats.noN,
        Math.round(r * 100) + '% of ' + total + ' faces; worst: ' +
        worst.map((w) => (w.where.srf || w.where.node || '?') + ' ' + w.count + '/' + w.total).join(', '),
        worst[0] ? worst[0].examples : []));
    }
  }
  if (stats.withN >= TH.mismatch.minFaces && stats.mismatch > 0) {
    const r = stats.mismatch / stats.withN;
    const sev = r >= TH.mismatch.info ? 'info' : null; // engine self-heals: info at most
    if (sev) {
      const worst = stats.mismatchBySrf.sort((a, b) => b.count - a.count).slice(0, 4);
      out.push(finding('normal-winding-mismatch', sev, worst[0] && worst[0].where, stats.mismatch,
        stats.mismatch + '/' + stats.withN + ' N-carrying faces; worst: ' +
        worst.map((w) => (w.where.srf || w.where.node || '?') + ' ' + w.count + '/' + w.total).join(', '),
        worst[0] ? worst[0].examples : []));
    }
  }
}

// --- coplanar overlap (hinge-line z-fight) ------------------------------------------

// World-space faces -> plane-hash buckets -> exact convex-clip overlap area.
// worldFaces: [{node, face, verts:[[x,y,z]..], n, d, area, alpha, unlit}]
function coplanarOverlaps(worldFaces, out) {
  const buckets = new Map();
  const keyOf = (n, dq) => (Math.round(n[0] * 100)) + ',' + (Math.round(n[1] * 100)) + ',' + (Math.round(n[2] * 100)) + ',' + dq;
  worldFaces.forEach((wf, i) => {
    // Canonical plane sign so front/back faces of the same plane collide.
    let { n, d } = wf;
    const mx = Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2]));
    if (mx === 0) return;
    const lead = Math.abs(n[0]) === mx ? n[0] : Math.abs(n[1]) === mx ? n[1] : n[2];
    if (lead < 0) { n = [-n[0], -n[1], -n[2]]; d = -d; }
    wf.cn = n; wf.cd = d;
    const dq = Math.round(d / 0.02);
    for (const q of [dq - 1, dq, dq + 1]) {
      const k = keyOf(n, q);
      (buckets.get(k) || buckets.set(k, []).get(k)).push(i);
    }
  });
  const seen = new Set();
  const pairs = new Map(); // nodeA|nodeB -> {count, ex: []}
  for (const ids of buckets.values()) {
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const i = Math.min(ids[a], ids[b]), j = Math.max(ids[a], ids[b]);
        const pk = i + ':' + j;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const A = worldFaces[i], B = worldFaces[j];
        // translucent/self-lit quads (flames, lights) legitimately hug geometry
        if (A.alpha < 1 || B.alpha < 1 || A.unlit || B.unlit) continue;
        // Same-node, different-color coplanar quads are the deliberate stock
        // "painted-on detail" idiom (cockpit glass on the hull, d25e789).
        if (A.node === B.node && A.color !== B.color) continue;
        const dot = A.cn[0] * B.cn[0] + A.cn[1] * B.cn[1] + A.cn[2] * B.cn[2];
        if (dot < TH.coplanarAngle) continue; // canonical sign -> coplanar means dot ~ +1
        if (Math.abs(A.cd - B.cd) > TH.coplanarEps) continue;
        const area = overlapArea(A, B);
        if (area < TH.overlapMinArea || area < TH.overlapMinFrac * Math.min(A.area, B.area)) continue;
        // Identical vertex sets = the stock two-sided idiom (a polygon and its
        // reversed twin share every vertex): consistent depths, no shimmer.
        const match = (P, Q) => P.length === Q.length &&
          P.every((p) => Q.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.001));
        if (match(A.verts, B.verts)) continue;
        // Opposite-facing coplanar sheets are all over stock (zero-thickness
        // wings, back-to-back closures) — info, and only sizeable ones.
        const sameFacing = (A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2]) > 0;
        if (!sameFacing && area < TH.overlapOppMinArea) continue;
        // Same-facing near-duplicate footprint = guaranteed shimmer (warn);
        // everything else is a heads-up (info).
        const near = area >= TH.overlapNearFrac * Math.max(A.area, B.area);
        const sev = sameFacing && near ? 'warn' : 'info';
        const nk = (A.node || '?') + ' × ' + (B.node || '?');
        const p = pairs.get(nk) || { count: 0, ex: [], sev: 'info' };
        p.count++;
        if (sev === 'warn') p.sev = 'warn';
        if (p.ex.length < 4) p.ex.push('face ' + A.face + ' × ' + B.face + ' (' + area.toFixed(3) + ' m², ' + (sameFacing ? 'same-facing' : 'opposed') + ')');
        pairs.set(nk, p);
      }
    }
  }
  for (const [nk, p] of pairs) {
    out.push(finding('coplanar-overlap', p.sev, { node: nk }, p.count, p.ex.join('; ')));
  }
}

// Exact-enough polygon overlap: project both onto the shared plane and clip A
// by B's edges (Sutherland–Hodgman; faces are near-convex fans in practice).
function overlapArea(A, B) {
  const n = A.cn;
  // plane basis
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const ref = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  let u = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]];
  const ul = Math.hypot(...u) || 1;
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const proj = (p) => [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]];
  let P = A.verts.map(proj);
  let Q = B.verts.map(proj);
  const area2 = (poly) => {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      s += p[0] * q[1] - q[0] * p[1];
    }
    return s / 2;
  };
  if (area2(Q) < 0) Q = Q.slice().reverse();
  // clip P by each edge of Q
  for (let i = 0; i < Q.length && P.length; i++) {
    const a = Q[i], b = Q[(i + 1) % Q.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const inside = (p) => ex * (p[1] - a[1]) - ey * (p[0] - a[0]) >= 0;
    const next = [];
    for (let k = 0; k < P.length; k++) {
      const p = P[k], q = P[(k + 1) % P.length];
      const pin = inside(p), qin = inside(q);
      if (pin) next.push(p);
      if (pin !== qin) {
        const dp = ex * (p[1] - a[1]) - ey * (p[0] - a[0]);
        const dq = ex * (q[1] - a[1]) - ey * (q[0] - a[0]);
        const t = dp / (dp - dq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    P = next;
  }
  return P.length >= 3 ? Math.abs(area2(P)) : 0;
}

// --- entry points --------------------------------------------------------------------

const emptyStats = () => ({
  faces: 0, noN: 0, withN: 0, mismatch: 0,
  noNBySrf: [], mismatchBySrf: [],
  rTotal: 0, rEdgeOn: 0, rSpurious: 0,
});

const summarize = (findings) => {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  // errors first, then warns, then infos
  const rank = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return counts;
};

// Lint one whole DNM.  Returns { findings, counts, stats }.
export function lintDnm(bytes) {
  const parsed = parseDnm(bytes);
  const out = [];
  const stats = emptyStats();
  stats.nodes = parsed.nodes.size;
  stats.srfs = parsed.srfByName.size;

  // node label per SRF name (first referencing node), for nicer findings
  const nodeOfSrf = new Map();
  for (const n of parsed.nodes.values()) {
    if (n.srf && !nodeOfSrf.has(n.srf)) nodeOfSrf.set(n.srf, n.label);
  }

  for (const [name, srf] of parsed.srfByName) {
    lintSrfGeometry(srf, { srf: name, node: nodeOfSrf.get(name) || null }, out, stats, 'visual');
  }
  ratioFindings(out, stats);

  // raw text scan per PCK block
  const lines = b2s(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'PCK') {
      const name = (t[1] || '').replace(/^"|"$/g, '');
      const n = parseInt(t[2], 10) || 0;
      scanSrfLines(lines.slice(i + 1, i + 1 + n), { srf: name, node: nodeOfSrf.get(name) || null }, out);
      i += n;
    }
  }

  // node-level rules
  const staDiffers = (sta) => sta && sta.length >= 2 &&
    sta[0].slice(0, 6).some((val, i) => Math.abs((val || 0) - (sta[sta.length - 1][i] || 0)) > 1e-6);
  for (const n of parsed.nodes.values()) {
    // broken-reference
    if (n.srf && !parsed.srfByName.has(n.srf)) {
      out.push(finding('broken-reference', 'warn', { node: n.label }, 1, 'FIL ' + n.srf));
    }
    for (const c of n.children) {
      if (!parsed.nodes.has(c)) out.push(finding('broken-reference', 'warn', { node: n.label }, 1, 'CLD "' + c + '"'));
    }
    // retract visibility (CLA 0 that really animates = gear)
    if (n.cla === 0 && staDiffers(n.sta) && !n.sta.some((s) => s[6] === 0)) {
      out.push(finding('retract-never-hidden', 'info', { node: n.label }, 1,
        'NST ' + n.sta.length + ', no STA ends with vis=0'));
    }
  }

  // hierarchical rest transforms (parent chains via CLD).  restM composes the
  // full engine transform (POS + STA0 + CNT) for world-space baking; posM
  // composes POS/CNT ONLY — a movable part's STA0 (e.g. gear stowed at rest)
  // legitimately displaces geometry, but the POS/CNT part must be a no-op on
  // absolute vertices (stock keeps POS == CNT), or absolutes get re-applied.
  const restM = new Map(), posM = new Map();
  const walk = (label, parentM, parentPosM) => {
    const n = parsed.nodes.get(label);
    if (!n) return;
    const pos = n.pos || [0, 0, 0, 0, 0, 0], cnt = n.cnt || [0, 0, 0];
    const M = mul(parentM, nodeMatrix(pos, (n.sta && n.sta[0]) || null, cnt));
    const P = mul(parentPosM, nodeMatrix(pos, null, cnt));
    restM.set(label, M);
    posM.set(label, P);
    for (const c of n.children) walk(c, M, P);
  };
  for (const r of parsed.roots) walk(r, I16, I16);

  // rest displacement heuristic + world faces for the coplanar pass + B faces
  const worldFaces = [];
  for (const n of parsed.nodes.values()) {
    const srf = n.srf && parsed.srfByName.get(n.srf);
    if (!srf || !srf.vertices.length) continue;
    const M = restM.get(n.label) || I16;
    const sta0 = (n.sta && n.sta[0]) || null;
    const restHidden = sta0 && sta0[6] === 0;

    // rest-transform-displacement (double-applied absolute coordinates):
    // judged on the POS/CNT transform alone — STA0 stowing is by design.
    let cx = 0, cy = 0, cz = 0;
    for (const v of srf.vertices) { cx += v[0]; cy += v[1]; cz += v[2]; }
    const k = srf.vertices.length;
    const c0 = [cx / k, cy / k, cz / k];
    const c1 = apply(posM.get(n.label) || I16, c0);
    const dv = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
    const disp = Math.hypot(dv[0], dv[1], dv[2]);
    const cdist = Math.hypot(c0[0], c0[1], c0[2]);
    if (disp > TH.displacement.min && cdist > TH.displacement.centroid) {
      // The double-apply SIGNATURE: the shift points the same way as the
      // centroid and has comparable magnitude (absolute verts moved by ~their
      // own position again).  Stock legitimately places local-coordinate
      // parts with POS (su22/su24 style), which fails this direction test.
      const cos = (dv[0] * c0[0] + dv[1] * c0[1] + dv[2] * c0[2]) / ((disp * cdist) || 1);
      const ratio = disp / cdist;
      if (cos > 0.7 && ratio > 0.5 && ratio < 2) {
        out.push(finding('rest-transform-displacement', 'info', { node: n.label, srf: n.srf },
          1, 'centroid ' + cdist.toFixed(1) + ' m from origin, displaced ' + disp.toFixed(1) + ' m along it at rest'));
      }
    }

    // bright faces outside light-class nodes (small B quads baked as "lights")
    if (!(n.cla === 2 || (n.cla >= 30 && n.cla <= 34))) {
      let small = 0;
      const ex = [];
      srf.faces.forEach((f, i) => {
        if (!f.unlit || !(f.alpha === undefined || f.alpha >= 1)) return;
        const { area } = newell(srf.vertices, f.idx);
        if (area > 0 && area < TH.brightMaxArea) {
          small++;
          if (ex.length < 8) ex.push(i);
        }
      });
      if (small) {
        out.push(finding('bright-outside-light-node', 'info', { node: n.label, srf: n.srf },
          small, 'faces: ' + ex.join(', '), ex));
      }
    }

    if (restHidden) continue; // retracted parts overlap their bays by design
    srf.faces.forEach((f, i) => {
      if (f.idx.length < 3) return;
      const verts = f.idx.map((vi) => srf.vertices[vi]).filter(Boolean).map((v) => apply(M, v));
      if (verts.length < 3) return;
      const { n: nn, area } = newell(verts, verts.map((_, ix) => ix));
      if (area < 1e-6) return;
      const ctr = verts.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / verts.length);
      worldFaces.push({
        node: n.label, face: i, verts, n: nn, d: nn[0] * ctr[0] + nn[1] * ctr[1] + nn[2] * ctr[2],
        area, alpha: f.alpha === undefined ? 1 : f.alpha, unlit: !!f.unlit,
        color: (f.color || []).join(','),
      });
    });
  }
  coplanarOverlaps(worldFaces, out);

  const counts = summarize(out);
  return { findings: out, counts, stats };
}

// Lint one bare SRF file (collision shell, cockpit...).
// kind: 'visual' | 'cockpit' | 'collision' — collision skips shading rules.
export function lintSrf(bytes, opts) {
  const kind = (opts && opts.kind) || 'visual';
  const lines = b2s(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).split('\n');
  const srf = parseSrf(lines);
  const out = [];
  const stats = emptyStats();
  stats.nodes = 0; stats.srfs = 1;
  lintSrfGeometry(srf, { srf: (opts && opts.name) || null }, out, stats, kind);
  if (kind !== 'collision') ratioFindings(out, stats);
  scanSrfLines(lines, { srf: (opts && opts.name) || null }, out);
  const counts = summarize(out);
  return { findings: out, counts, stats };
}

// Sniff DNM vs SRF from the content and lint accordingly.  A filename hint
// classifies bare SRFs: *coll* -> collision (shading rules off).
export function lintAuto(bytes, name) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = b2s(u8.subarray(0, 256)).trimStart().toUpperCase();
  if (head.startsWith('DYNAMODEL') || head.startsWith('DNMVER')) return lintDnm(u8);
  const kind = /coll/i.test(name || '') ? 'collision' : /cockpit|ckpit/i.test(name || '') ? 'cockpit' : 'visual';
  return lintSrf(u8, { name, kind });
}
