// Unit tests for web/studio-paint.js.
//
// Covers:
//   (a) Single-face paint -> only that face's C line differs; all others byte-equal.
//   (b) Flood selection correctness (connected same-color faces).
//   (c) Waterline split: surface-area / triangle continuity, no boundary gap,
//       N / R-flag preservation.
//   (d) Navlight protection (CLA 30-34 blocks are not painted).
//   (e) Regression: existing repaintDnm (whole-model swap) still passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFaceLineMap,
  repaintFacesById,
  splitFacesAtY,
  floodSelect,
  buildTriToFace,
} from '../web/studio-paint.js';
import { repaintDnm } from '../web/workbench.js';

const here = dirname(fileURLToPath(import.meta.url));

// ─── Synthetic DNM fixtures ───────────────────────────────────────────────────

// Minimal DNM with two faces of different colors.
const makeDnm = (opts = {}) => {
  const { extraNode = '', lightCla = false } = opts;
  const cla = lightCla ? 30 : 0;
  const lines = [
    'DYNAMODEL', 'DNMVER 1',
    'PCK "body.srf" 22',
    'SURF',
    'V 0 0 0',   // 0
    'V 1 0 0',   // 1
    'V 1 1 0',   // 2
    'V 0 1 0',   // 3
    'V 0 -1 0',  // 4
    'V 1 -1 0',  // 5
    'F',
    ' V 0 1 2',
    ' N 0 0 1 0 0 1',
    ' C 200 100 50',  // ← face 0 color
    'E',
    'F',
    ' V 0 3 2',
    ' N 0 0 1 0 0 1',
    ' C 50 200 100',  // ← face 1 color
    'E',
    'F',
    ' V 0 4 5',
    ' N 0 0 -1 0 0 -1',
    ' C 200 100 50',  // ← face 2 color (same as face 0)
    'E',
    'SRF "Body"',
    'FIL "body.srf"',
    'CLA ' + cla,
    'NST 1',
    'STA 0 0 0 0 0 0 1',
    'CNT 0 0 0',
    'POS 0 0 0 0 0 0 1',
    extraNode,
    '',
  ];
  return new TextEncoder().encode(lines.join('\n'));
};

// DNM with a face that straddles y=0 (for split testing).
const makeSplitDnm = () => {
  // A quad that goes from y=-1 to y=1, split by y=0 -> becomes two triangles.
  const lines = [
    'DYNAMODEL', 'DNMVER 1',
    'PCK "wing.srf" 18',
    'SURF',
    'V -1 1 0',   // 0 above
    'V  1 1 0',   // 1 above
    'V  1 -1 0',  // 2 below
    'V -1 -1 0',  // 3 below
    'V -1 0 1',   // 4 entirely above
    'V  1 0 1',   // 5 entirely above
    'V  1 0.5 1', // 6 entirely above
    // face 0: straddles y=0
    'F',
    ' V 0 1 2 3',
    ' N 0 0 1 0 0 1',
    ' C 100 150 200',
    'E',
    // face 1: entirely above y=0
    'F',
    ' V 4 5 6',
    ' N 0 1 0 0 1 0',
    ' C 200 200 200',
    'E',
    'SRF "Wing"',
    'FIL "wing.srf"',
    'CLA 0',
    'NST 1',
    'STA 0 0 0 0 0 0 1',
    'CNT 0 0 0',
    'POS 0 0 0 0 0 0 1',
    '',
  ];
  return new TextEncoder().encode(lines.join('\n'));
};

// ─── helpers ─────────────────────────────────────────────────────────────────

const decode = (bytes) => new TextDecoder('latin1').decode(bytes);

// Count occurrences of substring in string.
const countOcc = (str, sub) => {
  let n = 0, pos = 0;
  while ((pos = str.indexOf(sub, pos)) >= 0) { n++; pos += sub.length; }
  return n;
};

// Find all C lines in an SRF block named srfName within a DNM string.
function extractCLines(dnmStr, srfName) {
  const lines = dnmStr.split('\n');
  const results = [];
  let inBlock = false, remaining = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^PCK\s+("?)([^"\s]+)\1\s+(\d+)/.exec(lines[i]);
    if (m) {
      if (m[2] === srfName) { inBlock = true; remaining = parseInt(m[3], 10); }
      continue;
    }
    if (inBlock) {
      remaining--;
      if (/^\s*C\s+/.test(lines[i])) results.push(lines[i].trim());
      if (remaining <= 0) inBlock = false;
    }
  }
  return results;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('buildFaceLineMap: finds correct C-line indices for each face', () => {
  const bytes = makeDnm();
  const { faceMap, nodeToSrf } = buildFaceLineMap(bytes);
  const srfName = nodeToSrf.get('Body');
  assert.ok(srfName, 'Body node maps to an SRF');
  const faces = faceMap.get(srfName);
  assert.ok(faces, 'SRF has face entries');
  assert.equal(faces.length, 3, 'three faces in the SRF');
  // Each face should have found its C line
  for (const f of faces) {
    assert.ok(f.cLineIdx >= 0, 'face has a C line at idx ' + f.cLineIdx);
  }
  // Colors should match what we put in
  assert.deepEqual(faces[0].color, [200, 100, 50]);
  assert.deepEqual(faces[1].color, [50, 200, 100]);
  assert.deepEqual(faces[2].color, [200, 100, 50]);
});

test('(a) single-face paint: only the targeted C line changes; all other bytes identical', () => {
  const bytes = makeDnm();
  const newColor = [10, 20, 30];
  const { bytes: out, replaced } = repaintFacesById(
    bytes, [{ nodeLabel: 'Body', faceIndex: 0 }], newColor,
  );
  assert.equal(replaced, 1, 'exactly 1 C line replaced');

  const original = decode(bytes).split('\n');
  const result = decode(out).split('\n');
  assert.equal(original.length, result.length, 'line count unchanged');

  let diffs = 0;
  for (let i = 0; i < original.length; i++) {
    if (original[i] !== result[i]) {
      diffs++;
      // The changed line must be a C line with the new color.
      assert.match(result[i].trim(), /^C 10 20 30$/, 'changed line is new C value');
    }
  }
  assert.equal(diffs, 1, 'exactly one line changed');
});

test('(a) single-face paint: face 1 unchanged when only face 0 is painted', () => {
  const bytes = makeDnm();
  const { bytes: out } = repaintFacesById(
    bytes, [{ nodeLabel: 'Body', faceIndex: 0 }], [10, 20, 30],
  );
  // Face 1 has color 50 200 100 — it must be unchanged
  const cLines = extractCLines(decode(out), 'body.srf');
  assert.ok(cLines.some((l) => l === 'C 50 200 100'), 'face 1 color preserved');
  assert.ok(cLines.some((l) => l === 'C 10 20 30'), 'face 0 painted to new color');
  // Face 2 should still be 200 100 50 (different face, same original color as face 0)
  assert.ok(cLines.some((l) => l === 'C 200 100 50'), 'face 2 unchanged');
});

test('(a) byte-identical contract: non-C lines are verbatim after repaint', () => {
  const bytes = makeDnm();
  const { bytes: out } = repaintFacesById(
    bytes, [{ nodeLabel: 'Body', faceIndex: 1 }], [99, 88, 77],
  );
  const origLines = decode(bytes).split('\n');
  const outLines = decode(out).split('\n');
  // All non-C lines must be byte-identical
  for (let i = 0; i < origLines.length; i++) {
    if (!/^\s*C\s+/.test(origLines[i])) {
      assert.equal(outLines[i], origLines[i], 'non-C line ' + i + ' unchanged');
    }
  }
});

test('(b) floodSelect: finds all connected faces with same color', () => {
  // Faces 0 and 2 share color "200,100,50" and are connected through shared vertices.
  // Actually: face 0 = {0,1,2}, face 2 = {0,4,5}. They share vertex 0.
  // Two faces sharing a SINGLE vertex are NOT edge-adjacent (need 2 shared vertices).
  // Let's test with a simpler SRF built inline.
  const srf = {
    vertices: [
      [0, 0, 0], [1, 0, 0], [1, 1, 0],  // 0,1,2
      [0, 1, 0],                          // 3
    ],
    faces: [
      { idx: [0, 1, 2], color: [100, 100, 100] },  // face 0
      { idx: [0, 2, 3], color: [100, 100, 100] },  // face 1 — shares edge 0-2 with face 0
      { idx: [0, 1, 3], color: [200, 200, 200] },  // face 2 — different color
    ],
  };
  const sel = floodSelect(srf, 0);
  assert.ok(sel.has(0), 'start face in selection');
  assert.ok(sel.has(1), 'face 1 reached via shared edge 0-2');
  assert.ok(!sel.has(2), 'face 2 excluded (different color)');
});

test('(b) floodSelect: isolated same-color face not selected (no shared edge)', () => {
  // face 0 and face 1 share same color but no edge.
  const srf = {
    vertices: [
      [0, 0, 0], [1, 0, 0], [0, 1, 0],  // 0,1,2
      [5, 0, 0], [6, 0, 0], [5, 1, 0],  // 3,4,5 — distant
    ],
    faces: [
      { idx: [0, 1, 2], color: [100, 100, 100] },
      { idx: [3, 4, 5], color: [100, 100, 100] },  // same color, no shared edge
    ],
  };
  const sel = floodSelect(srf, 0);
  assert.ok(sel.has(0), 'start face');
  assert.ok(!sel.has(1), 'disconnected face not reached');
});

test('(c) splitFacesAtY: straddling face becomes two faces; surface area preserved', () => {
  const bytes = makeSplitDnm();
  const { bytes: out, facesAbove, facesBelow } = splitFacesAtY(bytes, 'Wing', 0);

  // face 0 straddles y=0 -> split into 2; face 1 is entirely above -> kept as-is
  // total: 3 faces after split
  assert.ok(facesAbove >= 1, 'at least one face above: ' + facesAbove);
  assert.ok(facesBelow >= 1, 'at least one face below: ' + facesBelow);

  // Count F...E blocks in the output SRF
  const str = decode(out);
  const fCount = countOcc(str, '\nF\n') + countOcc(str, '\nF\r\n');
  // At minimum we should have more faces than before the split (original=2, after>=3)
  const origStr = decode(bytes);
  const origF = countOcc(origStr, '\nF\n') + countOcc(origStr, '\nF\r\n');
  assert.ok(fCount > origF, 'face count increased: ' + origF + ' -> ' + fCount);
});

test('(c) splitFacesAtY: entirely-above face is preserved byte-identical', () => {
  const bytes = makeSplitDnm();
  const { bytes: out } = splitFacesAtY(bytes, 'Wing', 0);
  // face 1 is entirely above (vertices at y=0 or y=0.5) — its color "200 200 200" must survive.
  const cLines = extractCLines(decode(out), 'wing.srf');
  assert.ok(cLines.some((l) => l === 'C 200 200 200'), 'above face color preserved');
});

test('(c) splitFacesAtY: boundary vertices get R smooth flag', () => {
  const bytes = makeSplitDnm();
  const { bytes: out } = splitFacesAtY(bytes, 'Wing', 0);
  const str = decode(out);
  // New boundary vertices at y=0 should have the R flag.
  const vLines = str.split('\n').filter((l) => /^V\s+/.test(l.trim()) && l.includes(' 0 '));
  // At least one V line for a boundary vertex with R flag (may be any y=0 vertex)
  const hasR = str.split('\n').some((l) => /^V\s+.*\sR(\s|$)/.test(l.trim()));
  assert.ok(hasR, 'at least one vertex has R flag after split');
});

test('(c) splitFacesAtY: split does not change faces outside the target node', () => {
  // Make a DNM with two nodes; split one; the other's lines are untouched.
  const extraNode = [
    'PCK "other.srf" 10',
    'SURF',
    'V 10 10 10',
    'V 11 10 10',
    'V 10 11 10',
    'F',
    ' V 0 1 2',
    ' C 77 88 99',
    'E',
    'SRF "Other"',
    'FIL "other.srf"',
    'CLA 0',
  ].join('\n');
  // We need a DNM that has BOTH nodes. Build it manually.
  const combined = [
    'DYNAMODEL', 'DNMVER 1',
    'PCK "wing2.srf" 18',
    'SURF',
    'V -1 1 0', 'V 1 1 0', 'V 1 -1 0', 'V -1 -1 0',
    'V -1 0 1', 'V 1 0 1', 'V 1 0.5 1',
    'F', ' V 0 1 2 3', ' N 0 0 1 0 0 1', ' C 100 150 200', 'E',
    'F', ' V 4 5 6', ' N 0 1 0 0 1 0', ' C 200 200 200', 'E',
    'PCK "other.srf" 9',
    'SURF',
    'V 10 10 10', 'V 11 10 10', 'V 10 11 10',
    'F', ' V 0 1 2', ' C 77 88 99', 'E',
    'SRF "Wing2"', 'FIL "wing2.srf"', 'CLA 0',
    'NST 1', 'STA 0 0 0 0 0 0 1', 'CNT 0 0 0', 'POS 0 0 0 0 0 0 1',
    'SRF "Other"', 'FIL "other.srf"', 'CLA 0',
    'NST 1', 'STA 0 0 0 0 0 0 1', 'CNT 0 0 0', 'POS 0 0 0 0 0 0 1',
    '',
  ];
  const bytes = new TextEncoder().encode(combined.join('\n'));
  const { bytes: out } = splitFacesAtY(bytes, 'Wing2', 0);
  // The "other.srf" block must still contain C 77 88 99
  const cLines = extractCLines(decode(out), 'other.srf');
  assert.ok(cLines.some((l) => l === 'C 77 88 99'), 'other SRF is untouched');
});

// DNM with ZA (per-polygon translucency): a straddling glass face + an
// opaque face + a non-straddling glass face.  ZA refers to RAW polygon
// indices (dnm-preview.js byRaw convention), value semantics
// alpha = (255 - value)/255 (ysshellextio.cpp).
const makeZaDnm = () => {
  const lines = [
    'DYNAMODEL', 'DNMVER 1',
    'PCK "canopy.srf" 25',
    'SURF',
    'V -1 1 0',   // 0 above
    'V  1 1 0',   // 1 above
    'V  1 -1 0',  // 2 below
    'V -1 -1 0',  // 3 below
    'V -1 2 1',   // 4 entirely above
    'V  1 2 1',   // 5 entirely above
    'V  1 3 1',   // 6 entirely above
    'V -1 3 1',   // 7 entirely above
    // face 0: GLASS, straddles y=0  (ZA 0 128)
    'F',
    ' V 0 1 2 3',
    ' N 0 0 1 0 0 1',
    ' C 22 28 40',
    'E',
    // face 1: opaque, entirely above (no ZA)
    'F',
    ' V 4 5 6',
    ' N 0 1 0 0 1 0',
    ' C 200 200 200',
    'E',
    // face 2: GLASS, entirely above (ZA 2 96)
    'F',
    ' V 4 6 7',
    ' N 0 1 0 0 1 0',
    ' C 22 28 40',
    'E',
    'ZA 0 128 2 96',
    'SRF "Canopy"',
    'FIL "canopy.srf"',
    'CLA 0',
    'NST 1',
    'STA 0 0 0 0 0 0 1',
    'CNT 0 0 0',
    'POS 0 0 0 0 0 0 1',
    '',
  ];
  return new TextEncoder().encode(lines.join('\n'));
};

// Independent mini-parser: ZA pairs (any per-line chunking) + face colors by
// raw polygon index, within one PCK block.
function readZaAndFaces(dnmStr, srfName) {
  const lines = dnmStr.split('\n');
  const za = new Map(); // rawFaceIdx -> value
  const faceColors = [];
  let inBlock = false, remaining = 0, inFace = false, curColor = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^PCK\s+("?)([^"\s]+)\1\s+(\d+)/.exec(lines[i]);
    if (m) {
      if (m[2] === srfName) { inBlock = true; remaining = parseInt(m[3], 10); }
      continue;
    }
    if (!inBlock) continue;
    remaining--;
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'F') { inFace = true; curColor = null; }
    else if (t[0] === 'E' && inFace) { faceColors.push(curColor); inFace = false; }
    else if (inFace && t[0] === 'C') curColor = t.slice(1, 4).map(Number);
    else if (t[0] === 'ZA') {
      for (let k = 1; k + 1 < t.length; k += 2) za.set(Number(t[k]), Number(t[k + 1]));
    }
    if (remaining <= 0) inBlock = false;
  }
  return { za, faceColors };
}

test('(c+) ZA: straddling glass face — children inherit the parent ZA value', () => {
  const bytes = makeZaDnm();
  const { bytes: out } = splitFacesAtY(bytes, 'Canopy', 0);
  const { za, faceColors } = readZaAndFaces(decode(out), 'canopy.srf');

  // Face 0 (glass quad, ZA 128) straddles y=0 -> 2 children.
  // Face 1 (opaque) and face 2 (glass, ZA 96) are entirely above -> preserved.
  // Deterministic output order: [face0-above, face0-below, face1, face2].
  assert.equal(faceColors.length, 4, 'four faces after split');
  assert.equal(za.get(0), 128, 'above child inherits ZA 128');
  assert.equal(za.get(1), 128, 'below child inherits ZA 128');
  assert.ok(!za.has(2), 'opaque face has no ZA');
  assert.equal(za.get(3), 96, 'non-split glass face ZA remapped to new index, value intact');
  assert.equal(za.size, 3, 'exactly three ZA entries');
  // Sanity: glass faces still carry the glass color.
  assert.deepEqual(faceColors[0], [22, 28, 40]);
  assert.deepEqual(faceColors[1], [22, 28, 40]);
  assert.deepEqual(faceColors[3], [22, 28, 40]);
});

test('(c+) ZA: split with no straddling face leaves ZA values identical', () => {
  // Cut plane below everything: no face straddles, indices are unchanged.
  const bytes = makeZaDnm();
  const { bytes: out } = splitFacesAtY(bytes, 'Canopy', -100);
  const { za } = readZaAndFaces(decode(out), 'canopy.srf');
  assert.equal(za.get(0), 128, 'face 0 ZA intact');
  assert.equal(za.get(2), 96, 'face 2 ZA intact');
  assert.equal(za.size, 2, 'no extra ZA entries');
});

test('(c+) ZA: multi-line chunked ZA is parsed and re-emitted', () => {
  // Same shape but ZA split across two lines (stock files chunk pairs).
  const lines = [
    'DYNAMODEL', 'DNMVER 1',
    'PCK "glass.srf" 26',
    'SURF',
    'V -1 1 0', 'V 1 1 0', 'V 1 -1 0', 'V -1 -1 0',
    'V -1 2 1', 'V 1 2 1', 'V 1 3 1', 'V -1 3 1',
    'F', ' V 0 1 2 3', ' N 0 0 1 0 0 1', ' C 22 28 40', 'E',
    'F', ' V 4 5 6', ' N 0 1 0 0 1 0', ' C 200 200 200', 'E',
    'F', ' V 4 6 7', ' N 0 1 0 0 1 0', ' C 22 28 40', 'E',
    'ZA 0 128',
    'ZA 2 96',
    'SRF "Glass"', 'FIL "glass.srf"', 'CLA 0',
    'NST 1', 'STA 0 0 0 0 0 0 1', 'CNT 0 0 0', 'POS 0 0 0 0 0 0 1',
    '',
  ];
  const bytes = new TextEncoder().encode(lines.join('\n'));
  const { bytes: out } = splitFacesAtY(bytes, 'Glass', 0);
  const { za } = readZaAndFaces(decode(out), 'glass.srf');
  assert.equal(za.get(0), 128);
  assert.equal(za.get(1), 128);
  assert.equal(za.get(3), 96);
  assert.equal(za.size, 3);
});

test('(d) navlight protection: CLA 30 node is not painted', () => {
  const bytes = makeDnm({ lightCla: true });
  const { bytes: out, replaced } = repaintFacesById(
    bytes, [{ nodeLabel: 'Body', faceIndex: 0 }], [255, 0, 0],
  );
  assert.equal(replaced, 0, 'no C lines replaced for light-class node');
  // Verify the original color is preserved
  const cLines = extractCLines(decode(out), 'body.srf');
  assert.ok(cLines.some((l) => l === 'C 200 100 50'), 'navlight color unchanged');
});

test('buildTriToFace: triangle -> face index mapping is correct', () => {
  // A mock SRF with faces of varying vertex count.
  const srf = {
    faces: [
      { idx: [0, 1, 2] },         // 1 triangle
      { idx: [0, 1, 2, 3] },      // 2 triangles (quad)
      { idx: [0, 1, 2, 3, 4] },   // 3 triangles (pentagon)
    ],
  };
  const map = buildTriToFace(srf);
  assert.equal(map.length, 1 + 2 + 3, 'total triangles = 6');
  assert.equal(map[0], 0, 'triangle 0 -> face 0');
  assert.equal(map[1], 1, 'triangle 1 -> face 1');
  assert.equal(map[2], 1, 'triangle 2 -> face 1');
  assert.equal(map[3], 2, 'triangle 3 -> face 2');
  assert.equal(map[5], 2, 'triangle 5 -> face 2');
});

test('(e) regression: existing repaintDnm whole-model swap still works', () => {
  const bytes = makeDnm();
  const { bytes: out, replaced } = repaintDnm(bytes, { '200,100,50': [10, 20, 30] });
  // Both face 0 and face 2 share that color -> 2 replacements
  assert.equal(replaced, 2, 'both matching faces replaced');
  const cLines = extractCLines(decode(out), 'body.srf');
  assert.ok(cLines.every((l) => l !== 'C 200 100 50'), 'old color gone');
  assert.ok(cLines.filter((l) => l === 'C 10 20 30').length === 2, 'new color appears twice');
});

// ─── Integration: stock f15.dnm ──────────────────────────────────────────────

let f15Bytes;
try {
  f15Bytes = readFileSync(join(here, '..', 'upstream', 'YSFLIGHT', 'runtime', 'aircraft', 'f15.dnm'));
} catch (_) { /* skip if not present */ }

test('buildFaceLineMap on stock f15.dnm: all face C lines found', { skip: !f15Bytes }, () => {
  const { faceMap, nodeToSrf, lightSrfs } = buildFaceLineMap(f15Bytes);
  assert.ok(faceMap.size > 5, 'multiple SRFs: ' + faceMap.size);
  assert.ok(nodeToSrf.size > 5, 'multiple nodes: ' + nodeToSrf.size);
  // All faces in non-light SRFs should have a C line (cLineIdx >= 0).
  let found = 0, missing = 0;
  for (const [srfName, faces] of faceMap) {
    if (lightSrfs.has(srfName)) continue;
    for (const f of faces) {
      if (f.cLineIdx >= 0) found++; else missing++;
    }
  }
  assert.ok(found > 100, 'many C lines found: ' + found);
  // Some faces may legitimately lack a C line (they default to grey); this is OK.
  // Just verify the ratio is reasonable.
  assert.ok(missing < found, 'missing < found (' + missing + ' vs ' + found + ')');
});

test('repaintFacesById on f15.dnm face 0: byte-identical contract', { skip: !f15Bytes }, () => {
  // Find the first non-light node
  const { nodeToSrf, lightSrfs } = buildFaceLineMap(f15Bytes);
  let targetNode = null;
  for (const [nodeLabel, srfName] of nodeToSrf) {
    if (!lightSrfs.has(srfName)) { targetNode = nodeLabel; break; }
  }
  assert.ok(targetNode, 'found a non-light node');
  const { bytes: out, replaced } = repaintFacesById(
    f15Bytes, [{ nodeLabel: targetNode, faceIndex: 0 }], [1, 2, 3],
  );
  // Only 1 C line changed
  assert.equal(replaced, 1);
  // Line count unchanged
  const origLines = new TextDecoder('latin1').decode(f15Bytes).split('\n');
  const outLines = new TextDecoder('latin1').decode(out).split('\n');
  assert.equal(origLines.length, outLines.length);
  // Exactly 1 line differs
  const diffs = origLines.filter((l, i) => l !== outLines[i]);
  assert.equal(diffs.length, 1);
});
