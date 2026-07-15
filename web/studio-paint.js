// studio-paint.js — Part-level paint panel for the aircraft studio.
//
// Extends the whole-model color-swap ("塗装工房") with per-face / per-region
// selection and painting, plus a horizontal-plane face-split operation so a
// livery boundary runs as a straight line rather than zigzagging between
// facets.
//
// Non-destructive contract: only the C line of each targeted face is touched;
// every other byte is passed through verbatim (same rule as dat-editor).
//
// Dependencies:
//   - dnm-preview.js (parseDnm, faceNormal — pure parse, no DOM)
//   - vendor/three.module.js (Raycaster, etc. — browser-only)
// studio-aircraft.js mounts this panel; it never imports buildObject / the
// renderer directly — those are handed in via the `preview` handle that
// mountPreview already built.

import { parseDnm, faceNormal } from './dnm-preview.js';
import * as THREE from './vendor/three.module.js';

// ─── Byte / text helpers ─────────────────────────────────────────────────────
const b2s = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const s2b = (s) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

// ─── C-line helpers (mirrors workbench.js) ───────────────────────────────────
const C_RE = /^(\s*C\s+)(?:(\d+)\s+(\d+)\s+(\d+)((?:\s+\d+)?)|(\d+))\s*$/;
const PCK_RE = /^PCK\s+("?)([^"\s]+)\1\s+(\d+)/;

function cLineRgb(line) {
  const m = C_RE.exec(line.replace(/\r$/, ''));
  if (!m) return null;
  if (m[2] !== undefined) return [+m[2], +m[3], +m[4]];
  const c = (parseInt(m[6], 10) || 0) & 32767;
  return [((c >> 5) & 31) * 255 / 31, ((c >> 10) & 31) * 255 / 31, (c & 31) * 255 / 31]
    .map((v) => Math.round(v));
}

// Navlight CLA classes (30–34): protected from accidental painting.
// Returns Set<srfName> that belong to light-class nodes.
function lightSrfNames(lines) {
  const names = new Set();
  let lastFil = null;
  for (const line of lines) {
    const t = line.trim();
    const fil = /^FIL\s+("?)([^"\s]+)\1/.exec(t);
    if (fil) { lastFil = fil[2]; continue; }
    const cla = /^CLA\s+(\d+)/.exec(t);
    if (cla && lastFil !== null) {
      const c = parseInt(cla[1], 10);
      if (c >= 30 && c <= 34) names.add(lastFil);
      lastFil = null;
    }
  }
  return names;
}

// ─── Face–C-line map ─────────────────────────────────────────────────────────
//
// Parse the DNM lines once and build:
//   faceMap: Map<srfName, [{cLineIdx: number, color: [r,g,b]}]>
//     cLineIdx = absolute index into `lines[]`; -1 if this face has no C line.
//   nodeToSrf: Map<nodeLabel, srfName>
//   lightSrfs: Set<srfName>
//
// This is the text-level foundation for non-destructive per-face painting.
export function buildFaceLineMap(bytes) {
  const lines = b2s(bytes).split('\n');
  const faceMap = new Map();   // srfName -> [{cLineIdx, color}]
  const nodeToSrf = new Map(); // nodeLabel -> srfName
  const lightSrfs = lightSrfNames(lines);

  // Pass 1: PCK blocks -> parse face C-line positions.
  for (let i = 0; i < lines.length; i++) {
    const pm = PCK_RE.exec(lines[i]);
    if (!pm) continue;
    const srfName = pm[2];
    const n = parseInt(pm[3], 10);
    const blockEnd = Math.min(i + n, lines.length - 1);
    const faces = [];
    let inFace = false;
    let faceCLineIdx = -1;
    let faceColor = [200, 200, 200];
    for (let j = i + 1; j <= blockEnd; j++) {
      const t = lines[j].trim();
      if (t === 'F') {
        inFace = true;
        faceCLineIdx = -1;
        faceColor = [200, 200, 200];
      } else if (t === 'E' && inFace) {
        faces.push({ cLineIdx: faceCLineIdx, color: faceColor.slice() });
        inFace = false;
      } else if (inFace && t.startsWith('C')) {
        const rgb = cLineRgb(lines[j]);
        if (rgb) {
          faceCLineIdx = j;
          faceColor = rgb;
        }
      }
    }
    faceMap.set(srfName, faces);
    i += n; // skip to after this PCK block
  }

  // Pass 2: Node section -> build nodeLabel -> srfName.
  let curLabel = null, lastFil = null;
  for (const line of lines) {
    const t = line.trim();
    const srf = /^SRF\s+("?)([^"\s]+)\1/.exec(t);
    if (srf) { curLabel = srf[2]; lastFil = null; continue; }
    const fil = /^FIL\s+("?)([^"\s]+)\1/.exec(t);
    if (fil && curLabel) { lastFil = fil[2]; nodeToSrf.set(curLabel, lastFil); continue; }
  }

  return { faceMap, nodeToSrf, lightSrfs, lines };
}

// ─── Non-destructive per-face repaint ────────────────────────────────────────
//
// faceRefs = [{nodeLabel, faceIndex}]   (nodeLabel from parseDnm / meshesByLabel)
// newColor  = [r, g, b] 0..255
// Returns new Uint8Array; only the matched C lines change.
export function repaintFacesById(bytes, faceRefs, newColor, faceLineMapData) {
  const data = faceLineMapData || buildFaceLineMap(bytes);
  const { faceMap, nodeToSrf, lightSrfs, lines } = data;

  // Collect absolute line indices to rewrite.
  const toRewrite = new Set();
  for (const { nodeLabel, faceIndex } of faceRefs) {
    const srfName = nodeToSrf.get(nodeLabel);
    if (!srfName || lightSrfs.has(srfName)) continue;
    const faces = faceMap.get(srfName);
    if (!faces || faceIndex >= faces.length) continue;
    const { cLineIdx } = faces[faceIndex];
    if (cLineIdx >= 0) toRewrite.add(cLineIdx);
  }

  const out = lines.slice();
  for (const idx of toRewrite) {
    const hasCR = out[idx].endsWith('\r');
    const indent = (out[idx].match(/^(\s*)C/) || ['', ''])[1];
    out[idx] = indent + 'C ' + newColor[0] + ' ' + newColor[1] + ' ' + newColor[2] + (hasCR ? '\r' : '');
  }
  return { bytes: s2b(out.join('\n')), replaced: toRewrite.size };
}

// ─── Waterline split ─────────────────────────────────────────────────────────
//
// Split all faces in `nodeLabel`'s SRF at the horizontal plane y = cutY.
// Ported faithfully from gen-aircraft-from-spec.mjs (fuselage() waterline logic):
// Sutherland-Hodgman against the half-plane, welded by position so the shared
// boundary edge is not duplicated (R-smoothing across the seam is preserved).
//
// Returns: { bytes: Uint8Array, facesAbove: number, facesBelow: number }
// The returned bytes have the PCK block for that SRF replaced with the split
// version; all other bytes are verbatim.
export function splitFacesAtY(bytes, nodeLabel, cutY) {
  const { faceMap, nodeToSrf, lines } = buildFaceLineMap(bytes);
  const srfName = nodeToSrf.get(nodeLabel);
  if (!srfName) throw new Error('node not found: ' + nodeLabel);

  // Find the PCK block boundaries.
  let blockStart = -1, blockEnd = -1, blockLineCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const pm = PCK_RE.exec(lines[i]);
    if (pm && pm[2] === srfName) {
      blockLineCount = parseInt(pm[3], 10);
      blockStart = i;
      blockEnd = i + blockLineCount;
      break;
    }
  }
  if (blockStart < 0) throw new Error('PCK block not found for: ' + srfName);

  // Parse the SRF block into vertices + faces (with full data).
  const blockLines = lines.slice(blockStart + 1, blockEnd + 1);
  const { vertices, faces: srfFaces } = parseSrfFull(blockLines);

  // Sutherland-Hodgman clip.
  const clip = (verts, keepAbove) => {
    const out = [];
    for (let a = 0; a < verts.length; a++) {
      const P = verts[a], Q = verts[(a + 1) % verts.length];
      const inP = keepAbove ? P[1] >= cutY : P[1] <= cutY;
      const inQ = keepAbove ? Q[1] >= cutY : Q[1] <= cutY;
      if (inP) out.push(P);
      if (inP !== inQ) {
        const t = (cutY - P[1]) / (Q[1] - P[1]);
        out.push([P[0] + t * (Q[0] - P[0]), cutY, P[2] + t * (Q[2] - P[2])]);
      }
    }
    return out;
  };

  // Position-weld: reuse vertex indices for identical positions (preserves
  // R-smoothing across the seam, same as the compiler's memo map).
  const newVerts = vertices.map((v) => v.slice()); // copy existing
  const newSmooth = (parseSrfFull(blockLines).smooth || []).map(Boolean);
  const posKey = (v) => v[0].toFixed(5) + ',' + v[1].toFixed(5) + ',' + v[2].toFixed(5);
  const memoPos = new Map();
  // Seed memo with existing vertices.
  for (let i = 0; i < newVerts.length; i++) memoPos.set(posKey(newVerts[i]), i);
  const getVert = (pos) => {
    const k = posKey(pos);
    let id = memoPos.get(k);
    if (id === undefined) {
      id = newVerts.length;
      newVerts.push(pos);
      newSmooth.push(true); // boundary vertices get R (smooth) flag
      memoPos.set(k, id);
    }
    return id;
  };

  let facesAbove = 0, facesBelow = 0;
  const newFaces = []; // [{idx, color, unlit, nom, zaVal}] — output order = new raw index

  for (const f of srfFaces) {
    // Copier that keeps ALL per-face metadata — split children inherit their
    // parent's zaVal (translucency), so a straddling canopy-glass face stays
    // glass on both sides of the cut.
    const mkFace = (indices) => ({ idx: indices, color: f.color, unlit: f.unlit, nom: f.nom, zaVal: f.zaVal });
    if (f.idx.length < 3) {
      // Degenerate face: pass through verbatim (keeps raw-index parity source).
      newFaces.push(mkFace(f.idx.slice()));
      continue;
    }
    const fverts = f.idx.map((i) => vertices[i] || [0, 0, 0]);
    const ys = fverts.map((v) => v[1]);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    if (minY >= cutY) {
      // entirely above
      newFaces.push(mkFace(f.idx.slice()));
      facesAbove++;
    } else if (maxY <= cutY) {
      // entirely below
      newFaces.push(mkFace(f.idx.slice()));
      facesBelow++;
    } else {
      // straddles the cut plane -> 1:N (parent's ZA value inherited by each child)
      for (const above of [true, false]) {
        const piece = clip(fverts, above);
        if (piece.length >= 3) {
          newFaces.push(mkFace(piece.map(getVert)));
          if (above) facesAbove++; else facesBelow++;
        }
      }
    }
  }

  // Reassemble the SRF block text.
  const newBlock = [];
  newBlock.push('SURF');
  for (let i = 0; i < newVerts.length; i++) {
    const v = newVerts[i];
    newBlock.push('V ' + v[0] + ' ' + v[1] + ' ' + v[2] + (newSmooth[i] ? ' R' : ''));
  }
  for (const f of newFaces) {
    newBlock.push('F');
    newBlock.push(' V ' + f.idx.join(' '));
    if (f.nom) newBlock.push(' N 0 0 0 ' + f.nom.join(' '));
    newBlock.push(' C ' + f.color.join(' '));
    if (f.unlit) newBlock.push(' B');
    newBlock.push('E');
  }
  // Re-emit ZA (per-polygon translucency) against the NEW face indices.  The
  // output face order is deterministic (input order; straddling faces emit
  // above-piece then below-piece), so newFaces[i] is the new raw polygon index
  // i.  Values are the raw integers read from the source ZA lines — the exact
  // engine semantics (alpha = (255-value)/255) are preserved, only the index
  // grouping is regenerated.  Chunked like dnm-gltf.js srfText / stock files.
  const za = [];
  newFaces.forEach((f, i) => {
    if (f.zaVal !== undefined) za.push(i, f.zaVal);
  });
  for (let k = 0; k < za.length; k += 30) {
    newBlock.push('ZA ' + za.slice(k, k + 30).join(' '));
  }

  // Rebuild the full DNM lines array with the replacement PCK block.
  const header = 'PCK ' + JSON.stringify(srfName) + ' ' + newBlock.length;
  const outLines = [
    ...lines.slice(0, blockStart),
    header,
    ...newBlock,
    ...lines.slice(blockEnd + 1),
  ];
  return { bytes: s2b(outLines.join('\n')), facesAbove, facesBelow };
}

// Internal full SRF parser (returns vertices + faces with all metadata).
// Subset of parseDnm's parseSrf but with nom/zaVal/unlit preserved.  ALL F
// blocks are kept — including degenerate (<3 vertex) ones — so face array
// index == raw polygon index, which is what ZA lines refer to (matching
// dnm-preview.js's byRaw convention).  ZA VALUES are kept as raw integers
// (zaVal), not a derived alpha float, so re-emission is bit-exact.
// ZA is the ONLY face-index-referencing attribute line in the DNM/SRF text
// format handled by this repo's parsers (dnm-preview.js parseSrf and
// dnm-gltf.js srfText both read/write only ZA by polygon index).
function parseSrfFull(lines) {
  const vertices = [];
  const smooth = [];
  const faces = [];
  const zaPairs = []; // [rawFaceIdx, value] — applied after all faces parse
  let inFace = false;
  let curFace = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'V' && !inFace) {
      vertices.push([parseFloat(t[1]), parseFloat(t[2]), parseFloat(t[3])]);
      smooth.push(t.length >= 5 && (t[4] === 'R' || t[4] === 'r'));
    } else if (t[0] === 'F') {
      inFace = true;
      curFace = { idx: [], color: [200, 200, 200], unlit: false, nom: null, zaVal: undefined };
    } else if (t[0] === 'E' && inFace) {
      if (curFace) faces.push(curFace); // keep even degenerate — raw index parity
      inFace = false;
      curFace = null;
    } else if (inFace && curFace) {
      if (t[0] === 'V') curFace.idx = t.slice(1).map(Number);
      else if (t[0] === 'C') {
        const rgb = cLineRgb(lines[i]);
        if (rgb) curFace.color = rgb;
      }
      else if (t[0] === 'B') curFace.unlit = true;
      else if (t[0] === 'N') {
        const n = t.length >= 7 ? t.slice(4, 7).map(Number) : t.slice(1, 4).map(Number);
        if (n[0] || n[1] || n[2]) curFace.nom = n;
      }
    } else if (t[0] === 'ZA') {
      // '<raw polygon index> <value>' pairs, possibly many per line (stock
      // files chunk ~15 pairs per line — see dnm-gltf.js srfText).
      for (let k = 1; k + 1 < t.length; k += 2) {
        zaPairs.push([Number(t[k]), Number(t[k + 1]) || 0]);
      }
    }
  }
  for (const [fi, val] of zaPairs) {
    if (fi >= 0 && fi < faces.length) faces[fi].zaVal = val;
  }
  return { vertices, smooth, faces };
}

// ─── Flood selection (same-colour connected faces in one SRF) ────────────────
//
// Returns Set<faceIndex> of faces reachable from startFaceIndex through shared
// edges that also share the same decoded color.
export function floodSelect(srf, startFaceIndex) {
  if (!srf || !srf.faces || startFaceIndex >= srf.faces.length) return new Set();
  const targetColor = srf.faces[startFaceIndex].color.join(',');

  // Build edge-adjacency: edge key "vi,vj" (vi < vj) -> [faceIndex, ...]
  const edgeToFaces = new Map();
  for (let fi = 0; fi < srf.faces.length; fi++) {
    if (srf.faces[fi].color.join(',') !== targetColor) continue;
    const { idx } = srf.faces[fi];
    for (let k = 0; k < idx.length; k++) {
      const a = idx[k], b = idx[(k + 1) % idx.length];
      const key = Math.min(a, b) + ',' + Math.max(a, b);
      const arr = edgeToFaces.get(key) || [];
      arr.push(fi);
      edgeToFaces.set(key, arr);
    }
  }

  // BFS
  const visited = new Set([startFaceIndex]);
  const queue = [startFaceIndex];
  while (queue.length) {
    const fi = queue.shift();
    const { idx } = srf.faces[fi];
    for (let k = 0; k < idx.length; k++) {
      const a = idx[k], b = idx[(k + 1) % idx.length];
      const key = Math.min(a, b) + ',' + Math.max(a, b);
      for (const nfi of edgeToFaces.get(key) || []) {
        if (!visited.has(nfi)) { visited.add(nfi); queue.push(nfi); }
      }
    }
  }
  return visited;
}

// ─── Three.js picking helpers ─────────────────────────────────────────────────
//
// For each mesh in meshesByLabel we precompute triToFace[k] = SRF face index
// for the k-th triangle (BufferGeometry triangle index).  Stored in mesh.userData.

export function buildTriToFace(srf) {
  const map = [];
  for (let fi = 0; fi < srf.faces.length; fi++) {
    const nTri = Math.max(0, srf.faces[fi].idx.length - 2);
    for (let k = 0; k < nTri; k++) map.push(fi);
  }
  return map;
}

function injectTriToFace(meshesByLabel) {
  for (const [label, { mesh, srf }] of meshesByLabel) {
    if (!mesh.userData.triToFace) {
      mesh.userData.triToFace = buildTriToFace(srf);
      mesh.userData.nodeLabel = label;
    }
  }
}

// ─── Highlight overlay ────────────────────────────────────────────────────────
//
// Build a THREE.Mesh overlay for the set of selected faces in one SRF.
// Uses MeshBasicMaterial in a bright tint so it reads over the lit model.
function makeHighlightMesh(srf, faceIndices) {
  const pos = [];
  for (const fi of faceIndices) {
    const f = srf.faces[fi];
    if (!f) continue;
    for (let k = 1; k + 1 < f.idx.length; k++) {
      const push = (vi) => { const v = srf.vertices[vi] || [0, 0, 0]; pos.push(v[0], v[1], v[2]); };
      push(f.idx[0]); push(f.idx[k]); push(f.idx[k + 1]);
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffcc00, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthTest: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 999;
  return m;
}

// ─── Part-paint panel mount ───────────────────────────────────────────────────
//
// Called from studio-aircraft.js after the preview is up.
//   opts.container   — DOM element to fill with the part-paint UI
//   opts.previewHandle — the object returned by mountPreview (scene/camera/renderer/built/parsed)
//   opts.getBytes    — () => Uint8Array of the current visual DNM
//   opts.setBytes    — (Uint8Array) => void  (commits changed bytes back)
//   opts.lang        — 'ja' | 'en'
//
// Returns { update(bytes), dispose() }.
export function mountPartPaint(opts) {
  const { container, previewHandle, getBytes, setBytes, lang } = opts;
  const S = lang === 'ja' ? STRINGS.ja : STRINGS.en;

  // Selection state: Map<nodeLabel, Set<faceIndex>>
  let selection = new Map();
  // Undo/redo stacks: each entry is {bytes, selection}
  const undoStack = [];
  const redoStack = [];

  // Highlight overlays: Map<nodeLabel, THREE.Mesh>
  const highlights = new Map();

  // faceLineMap cache (invalidated when bytes change)
  let faceLineMapData = null;

  // --- helpers ---

  const pushUndo = () => {
    undoStack.push({ bytes: getBytes().slice(), selection: cloneSel(selection) });
    redoStack.length = 0;
    updateUndoButtons();
  };

  const cloneSel = (sel) => {
    const m = new Map();
    for (const [k, v] of sel) m.set(k, new Set(v));
    return m;
  };

  const clearHighlights = () => {
    const { scene } = previewHandle;
    for (const m of highlights.values()) scene.remove(m);
    highlights.clear();
  };

  const rebuildHighlights = () => {
    clearHighlights();
    const { scene, built: { meshesByLabel } } = previewHandle;
    for (const [nodeLabel, faceSet] of selection) {
      if (!faceSet.size) continue;
      const info = meshesByLabel.get(nodeLabel);
      if (!info) continue;
      const hm = makeHighlightMesh(info.srf, faceSet);
      if (!hm) continue;
      // The mesh lives in local node space; we add it to the same Three.js group.
      // Find the group for this node.
      const grp = findGroup(previewHandle, nodeLabel);
      if (grp) grp.add(hm);
      else scene.add(hm);
      highlights.set(nodeLabel, hm);
    }
  };

  const findGroup = (ph, label) => {
    // Traverse the object tree looking for the group that matches label.
    // meshesByLabel[label].mesh is inside its group.
    const info = ph.built.meshesByLabel.get(label);
    if (!info) return null;
    return info.mesh.parent || null;
  };

  const selectionEmpty = () => {
    for (const s of selection.values()) if (s.size) return false;
    return true;
  };

  const selectionSize = () => {
    let n = 0;
    for (const s of selection.values()) n += s.size;
    return n;
  };

  // --- Raycasting ---

  injectTriToFace(previewHandle.built.meshesByLabel);

  const raycaster = new THREE.Raycaster();

  const pickFace = (event) => {
    const { camera, scene, renderer } = previewHandle;
    const canvas = renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const meshes = [];
    for (const { mesh } of previewHandle.built.meshesByLabel.values()) meshes.push(mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const mesh = hit.object;
    const triToFace = mesh.userData.triToFace;
    if (!triToFace) return null;
    const triIdx = hit.faceIndex; // triangle index in the BufferGeometry
    const faceIndex = triToFace[triIdx];
    if (faceIndex === undefined) return null;
    const nodeLabel = mesh.userData.nodeLabel;
    return { nodeLabel, faceIndex };
  };

  // --- Click handler ---

  const onCanvasClick = (event) => {
    // Ignore right-click
    if (event.button !== 0) return;
    const hit = pickFace(event);
    if (!hit) {
      if (!event.shiftKey) { selection.clear(); rebuildHighlights(); renderPanel(); }
      return;
    }
    const { nodeLabel, faceIndex } = hit;

    // Check if this node is a protected light node.
    if (!faceLineMapData) faceLineMapData = buildFaceLineMap(getBytes());
    const srfName = faceLineMapData.nodeToSrf.get(nodeLabel);
    if (srfName && faceLineMapData.lightSrfs.has(srfName) && !lightUnlocked) return;

    if (!event.shiftKey) selection.clear();
    const set = selection.get(nodeLabel) || new Set();
    set.add(faceIndex);
    selection.set(nodeLabel, set);
    rebuildHighlights();
    renderPanel();
  };

  previewHandle.renderer.domElement.addEventListener('click', onCanvasClick);

  // --- Build UI ---

  let lightUnlocked = false;
  let undoBtn, redoBtn, selCountSpan, splitPanel, colorPicker;

  const render = () => { // alias used internally
    renderPanel();
  };

  const updateUndoButtons = () => {
    if (undoBtn) undoBtn.disabled = !undoStack.length;
    if (redoBtn) redoBtn.disabled = !redoStack.length;
  };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // Build the static chrome once.
  container.innerHTML = '';
  container.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 0';

  // Section heading
  const h2 = el('h2');
  h2.textContent = S.section;
  container.appendChild(h2);
  container.appendChild(el('p', 'intro', S.intro));

  // Undo / redo row
  const undoRow = el('div', 'btnrow');
  undoBtn = el('button', null, S.undo);
  redoBtn = el('button', null, S.redo);
  undoBtn.disabled = true; redoBtn.disabled = true;
  undoBtn.addEventListener('click', () => {
    if (!undoStack.length) return;
    redoStack.push({ bytes: getBytes().slice(), selection: cloneSel(selection) });
    const prev = undoStack.pop();
    setBytes(prev.bytes);
    selection = prev.selection;
    faceLineMapData = null;
    rebuildHighlights();
    renderPanel();
    updateUndoButtons();
  });
  redoBtn.addEventListener('click', () => {
    if (!redoStack.length) return;
    undoStack.push({ bytes: getBytes().slice(), selection: cloneSel(selection) });
    const next = redoStack.pop();
    setBytes(next.bytes);
    selection = next.selection;
    faceLineMapData = null;
    rebuildHighlights();
    renderPanel();
    updateUndoButtons();
  });
  undoRow.appendChild(undoBtn);
  undoRow.appendChild(redoBtn);
  container.appendChild(undoRow);

  // Selection info row
  const selRow = el('div', 'row');
  selRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';
  selCountSpan = el('span', 'msg');
  selCountSpan.style.flex = '1';
  selRow.appendChild(selCountSpan);

  // Flood-select button
  const floodBtn = el('button', null, S.floodSelect);
  floodBtn.title = S.floodSelectTitle;
  floodBtn.addEventListener('click', () => {
    const { built: { meshesByLabel } } = previewHandle;
    const newSel = new Map();
    for (const [nodeLabel, faceSet] of selection) {
      if (!faceSet.size) continue;
      const info = meshesByLabel.get(nodeLabel);
      if (!info) continue;
      const allFaces = new Set();
      for (const fi of faceSet) {
        for (const nfi of floodSelect(info.srf, fi)) allFaces.add(nfi);
      }
      newSel.set(nodeLabel, allFaces);
    }
    if (newSel.size) { selection = newSel; rebuildHighlights(); renderPanel(); }
  });
  selRow.appendChild(floodBtn);

  // Select-whole-node button
  const nodeBtn = el('button', null, S.selectNode);
  nodeBtn.addEventListener('click', () => {
    const { built: { meshesByLabel } } = previewHandle;
    const newSel = new Map();
    for (const [nodeLabel] of selection) {
      const info = meshesByLabel.get(nodeLabel);
      if (!info) continue;
      newSel.set(nodeLabel, new Set(info.srf.faces.map((_, i) => i)));
    }
    if (newSel.size) { selection = newSel; rebuildHighlights(); renderPanel(); }
  });
  selRow.appendChild(nodeBtn);

  // Clear selection
  const clearBtn = el('button', null, S.clearSel);
  clearBtn.addEventListener('click', () => {
    selection.clear(); clearHighlights(); renderPanel();
  });
  selRow.appendChild(clearBtn);
  container.appendChild(selRow);

  // Navlight-protection toggle
  const lightRow = el('div', 'row');
  lightRow.style.cssText = 'display:flex;align-items:center;gap:6px';
  const lightCheck = Object.assign(document.createElement('input'), { type: 'checkbox' });
  const lightLabel = el('span', null, S.unlockLights);
  lightLabel.style.cssText = 'color:#8fa3bb;font-size:12px';
  lightCheck.addEventListener('change', () => { lightUnlocked = lightCheck.checked; });
  lightRow.appendChild(lightCheck);
  lightRow.appendChild(lightLabel);
  container.appendChild(lightRow);

  // Dynamic paint panel (rebuilt when selection changes)
  const paintArea = el('div');
  paintArea.style.cssText = 'border-top:1px solid #2a3647;padding-top:8px;margin-top:4px';
  container.appendChild(paintArea);

  // Waterline split panel
  splitPanel = el('div');
  splitPanel.style.cssText = 'border-top:1px solid #2a3647;padding-top:8px;margin-top:4px';
  const splitH = el('h3');
  splitH.textContent = S.splitSection;
  splitH.style.cssText = 'margin:0 0 4px;font-size:13px';
  splitPanel.appendChild(splitH);
  splitPanel.appendChild(el('p', 'intro', S.splitHint));
  const splitRow = el('div', 'row');
  splitRow.style.cssText = 'display:flex;align-items:center;gap:6px';
  const splitY = Object.assign(document.createElement('input'), { type: 'number', step: '0.1', value: '0' });
  splitY.style.cssText = 'width:80px;padding:3px 6px';
  splitRow.appendChild(el('span', null, 'y ='));
  splitRow.appendChild(splitY);
  const splitBtn = el('button', null, S.splitBtn);
  splitBtn.addEventListener('click', () => {
    if (selectionEmpty()) { splitMsg.textContent = S.splitNoSel; return; }
    const cutY = parseFloat(splitY.value);
    if (isNaN(cutY)) { splitMsg.textContent = S.splitBadY; return; }
    pushUndo();
    // Split each selected node at cutY.
    let current = getBytes();
    const nodes = [...selection.keys()];
    try {
      for (const nodeLabel of nodes) {
        const res = splitFacesAtY(current, nodeLabel, cutY);
        current = res.bytes;
      }
      setBytes(current);
      faceLineMapData = null;
      selection.clear();
      clearHighlights();
      renderPanel();
      splitMsg.textContent = S.splitDone(nodes.length);
    } catch (e) {
      splitMsg.textContent = 'Error: ' + (e.message || e);
    }
  });
  splitRow.appendChild(splitBtn);
  splitPanel.appendChild(splitRow);
  const splitMsg = el('div', 'msg');
  splitPanel.appendChild(splitMsg);
  container.appendChild(splitPanel);

  // Dynamic part: paint area
  function renderPanel() {
    const cnt = selectionSize();
    selCountSpan.textContent = cnt ? S.selCount(cnt) : S.selNone;
    floodBtn.disabled = selectionEmpty();
    nodeBtn.disabled = selectionEmpty();
    clearBtn.disabled = selectionEmpty();

    paintArea.innerHTML = '';
    if (selectionEmpty()) {
      paintArea.appendChild(el('div', 'msg', S.paintPickHint));
      return;
    }

    // Current colors in selection
    const { built: { meshesByLabel } } = previewHandle;
    const colorCounts = new Map();
    for (const [nodeLabel, faceSet] of selection) {
      const info = meshesByLabel.get(nodeLabel);
      if (!info) continue;
      for (const fi of faceSet) {
        const f = info.srf.faces[fi];
        if (!f) continue;
        const key = f.color.join(',');
        colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
      }
    }

    // Palette of all colors in the model (for quick picks)
    if (!faceLineMapData) faceLineMapData = buildFaceLineMap(getBytes());
    const modelColors = [];
    for (const [srfName, faces] of faceLineMapData.faceMap) {
      if (faceLineMapData.lightSrfs.has(srfName)) continue;
      for (const f of faces) {
        const key = f.color.join(',');
        if (!modelColors.find((c) => c.key === key)) {
          modelColors.push({ key, color: f.color });
        }
      }
    }

    paintArea.appendChild(el('p', 'intro', S.paintHint));

    // Selection color swatches
    const selColorRow = el('div');
    selColorRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:4px 0';
    for (const [key, count] of colorCounts) {
      const [r, g, b] = key.split(',').map(Number);
      const sw = el('span');
      sw.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:#0b1017;' +
        'border:1px solid #2a3647;border-radius:4px;padding:2px 5px;font-size:11px';
      const dot = el('span');
      dot.style.cssText = 'width:12px;height:12px;border-radius:2px;background:rgb(' + r + ',' + g + ',' + b + ')';
      sw.appendChild(dot);
      sw.appendChild(el('span', null, count + '×'));
      selColorRow.appendChild(sw);
    }
    paintArea.appendChild(selColorRow);

    // Color picker + apply
    const pickRow = el('div', 'row');
    pickRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px';
    colorPicker = Object.assign(document.createElement('input'), { type: 'color', value: '#888888' });
    colorPicker.style.cssText = 'width:44px;height:32px;padding:1px;border:1px solid #2a3647;' +
      'border-radius:6px;background:#0b1017;cursor:pointer';
    // Pre-fill with the first selected color if uniform
    if (colorCounts.size === 1) {
      const [r, g, b] = [...colorCounts.keys()][0].split(',').map(Number);
      colorPicker.value = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    }
    pickRow.appendChild(colorPicker);

    // Palette quick-pick chips
    const paletteRow = el('div');
    paletteRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px';
    for (const { key, color: [r, g, b] } of modelColors.slice(0, 20)) {
      const chip = el('button');
      chip.style.cssText = 'width:20px;height:20px;padding:0;border:1px solid #2a3647;border-radius:3px;' +
        'background:rgb(' + r + ',' + g + ',' + b + ');cursor:pointer';
      chip.title = 'C ' + r + ' ' + g + ' ' + b;
      chip.addEventListener('click', () => {
        colorPicker.value = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
      });
      paletteRow.appendChild(chip);
    }
    pickRow.appendChild(paletteRow);
    paintArea.appendChild(pickRow);

    const applyBtn = el('button', 'accent', S.paintApply);
    const paintMsg2 = el('div', 'msg');

    applyBtn.addEventListener('click', () => {
      const hex = colorPicker.value;
      const newColor = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      // Build faceRefs from selection
      const faceRefs = [];
      for (const [nodeLabel, faceSet] of selection) {
        for (const faceIndex of faceSet) faceRefs.push({ nodeLabel, faceIndex });
      }
      if (!faceRefs.length) return;
      pushUndo();
      if (!faceLineMapData) faceLineMapData = buildFaceLineMap(getBytes());
      const { bytes: newBytes, replaced } = repaintFacesById(getBytes(), faceRefs, newColor, faceLineMapData);
      setBytes(newBytes);
      faceLineMapData = null;
      // Reflect in preview: build a per-face mapping for the preview setPaint path.
      // We emit a color->color mapping for the changed faces only.
      const prevMapping = {};
      for (const [nodeLabel, faceSet] of selection) {
        const info = previewHandle.built.meshesByLabel.get(nodeLabel);
        if (!info) continue;
        for (const fi of faceSet) {
          const f = info.srf.faces[fi];
          if (f) {
            prevMapping[f.color.join(',')] = newColor;
            f.color = newColor.slice(); // update in-memory for future picks
          }
        }
      }
      previewHandle.setPaint(prevMapping);
      // Rebuild highlights after color update
      rebuildHighlights();
      paintMsg2.textContent = S.paintDone(replaced);
      renderPanel();
    });

    paintArea.appendChild(applyBtn);
    paintArea.appendChild(paintMsg2);
  }

  renderPanel();

  return {
    update(bytes) {
      faceLineMapData = null;
      selection.clear();
      clearHighlights();
      renderPanel();
    },
    dispose() {
      previewHandle.renderer.domElement.removeEventListener('click', onCanvasClick);
      clearHighlights();
    },
  };
}

// ─── i18n strings ─────────────────────────────────────────────────────────────
const STRINGS = {
  ja: {
    section: '🎯 部位塗り',
    intro: 'プレビューの面をクリックして選択→色を塗る。Shift+クリックで追加選択。',
    undo: '↩ 元に戻す',
    redo: '↪ やり直す',
    selNone: 'クリックして面を選択',
    selCount: (n) => n + ' 面を選択中',
    floodSelect: '同色領域を選択',
    floodSelectTitle: '選択面と同じ色で隣接する面をまとめて選択',
    selectNode: 'ノード全体を選択',
    clearSel: '選択解除',
    unlockLights: 'ナビライト・灯火類の保護を解除（上級）',
    paintPickHint: '← 面をクリックして選択してください',
    paintHint: '選択面の色:',
    paintApply: '選択面に塗る',
    paintDone: (n) => '✓ ' + n + ' 面を塗り替えました',
    splitSection: '✂ 塗り分け線',
    splitHint: '選択ノードの面群を水平面(y=定数)で分割。分割後は上下を別色に塗れます。',
    splitBtn: '分割する',
    splitDone: (n) => '✓ ' + n + ' ノードを分割しました',
    splitNoSel: '分割するノードを選んでください（面をクリック）',
    splitBadY: '有効なy値を入力してください',
  },
  en: {
    section: '🎯 Part paint',
    intro: 'Click a face in the preview to select it, then pick a color. Shift+click to add to the selection.',
    undo: '↩ Undo',
    redo: '↪ Redo',
    selNone: 'Click a face in the preview to select',
    selCount: (n) => n + ' face' + (n === 1 ? '' : 's') + ' selected',
    floodSelect: 'Flood-select same color',
    floodSelectTitle: 'Select all connected faces that share the same color',
    selectNode: 'Select whole node',
    clearSel: 'Clear selection',
    unlockLights: 'Unlock nav lights / beacons (advanced)',
    paintPickHint: '← Click a face to select it',
    paintHint: 'Selected face color(s):',
    paintApply: 'Paint selected faces',
    paintDone: (n) => '✓ Repainted ' + n + ' face' + (n === 1 ? '' : 's'),
    splitSection: '✂ Split plane',
    splitHint: 'Split faces in the selected node at a horizontal plane (y = constant). After splitting, paint the upper and lower halves different colors.',
    splitBtn: 'Split',
    splitDone: (n) => '✓ Split ' + n + ' node' + (n === 1 ? '' : 's'),
    splitNoSel: 'Select a node first (click a face)',
    splitBadY: 'Enter a valid y value',
  },
};
