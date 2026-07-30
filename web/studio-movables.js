// studio-movables.js — Movable-part and light GUI editor for the aircraft studio.
//
// Provides:
//   CLA_TABLE           [{id, name, ja, en}] — all DNM classes from ysshelldnmident.h
//   IS_LIGHT            Set<id> for CLA 30-34
//   modifyDnmNodeFields non-destructive text-level edit of CLA/CNT/STA fields
//   addLightNode        insert a new light node (PCK + SRF block) into a DNM
//   removeDnmNode       remove a node block (and its PCK) from a DNM
//   buildMovablesSection mount the GUI into a rail element
//
// Blink timing sourced from upstream/YSFLIGHT/src/vehicle/fsairplaneproperty.cpp:
//   Beacon : chBeaconLightTime=0.8 s  chBeaconBlankTime=0.8 s  → period 1.6 s 50 % duty
//   Strobe : chStrobeLightTime=0.1 s  chStrobeBlankTime=0.9 s  → period 1.0 s 10 % duty
//
// Gizmo (hinge axis + CNT marker) is rendered by adding Three.js objects directly
// to the scene returned by mountPreview.  Mirror-X is applied (YS left-handed →
// Three.js right-handed) so gizmo and model occupy the same world space.

import { parseDnm } from './dnm-preview.js';
import * as THREE from './vendor/three.module.js';

// ---------------------------------------------------------------------------
// CLA class table — verbatim from ysshelldnmident.h (all aircraft classes)
// ---------------------------------------------------------------------------

export const CLA_TABLE = [
  { id:  0, name: 'LandingDevice',      ja: 'ランディングギア',     en: 'Landing Device' },
  { id:  1, name: 'VGWing',             ja: '可変翼',               en: 'Variable-Geometry Wing' },
  { id:  2, name: 'Afterburner',        ja: 'アフターバーナー',     en: 'Afterburner' },
  { id:  3, name: 'Rotor',              ja: 'ローター',             en: 'Rotor' },
  { id:  4, name: 'AirBrake',           ja: 'エアブレーキ',         en: 'Air Brake' },
  { id:  5, name: 'Flap',               ja: 'フラップ',             en: 'Flap' },
  { id:  6, name: 'Elevator',           ja: '昇降舵',               en: 'Elevator' },
  { id:  7, name: 'Aileron',            ja: '補助翼',               en: 'Aileron' },
  { id:  8, name: 'Rudder',             ja: '方向舵',               en: 'Rudder' },
  { id:  9, name: 'BombBay',            ja: 'ボムベイ',             en: 'Bomb Bay' },
  { id: 10, name: 'VtolNozzle',         ja: 'VTOLノズル',           en: 'VTOL Nozzle' },
  { id: 11, name: 'ThrustReverser',     ja: 'スラストリバーサー',   en: 'Thrust Reverser' },
  { id: 12, name: 'ConcordeNose',       ja: 'コンコルドノーズ',     en: 'Concorde Nose' },
  { id: 13, name: 'ConcordeVisor',      ja: 'コンコルドバイザー',   en: 'Concorde Visor' },
  { id: 14, name: 'GearDoor',           ja: 'ギアドア',             en: 'Gear Door' },
  { id: 15, name: 'GearRoomWall',       ja: 'ギアルーム壁',         en: 'Gear Room Wall' },
  { id: 16, name: 'BrakeOrHook',        ja: 'ブレーキ/フック',      en: 'Brake / Arresting Hook' },
  { id: 17, name: 'GearDoorFast',       ja: 'ギアドア（高速）',     en: 'Gear Door (Fast)' },
  { id: 18, name: 'PropellerSlow',      ja: 'プロペラ（低速）',     en: 'Propeller (Slow)' },
  { id: 20, name: 'PropellerFast',      ja: 'プロペラ（高速）',     en: 'Propeller (Fast)' },
  { id: 21, name: 'Turret',             ja: '砲塔',                 en: 'Turret' },
  { id: 22, name: 'Tire',               ja: 'タイヤ',               en: 'Tire' },
  { id: 23, name: 'Steering',           ja: 'ステアリング',         en: 'Steering' },
  { id: 24, name: 'RotorCustomAxis',    ja: 'カスタム軸ローター',   en: 'Rotor (Custom Axis)' },
  // Lights — ysshelldnmident.h YSDNM_CLASSID_NAVLIGHT … LIGHTONLANDINGGEAR
  { id: 30, name: 'NavLight',           ja: 'ナビライト',           en: 'Nav Light' },
  { id: 31, name: 'Beacon',             ja: 'ビーコン',             en: 'Beacon' },
  { id: 32, name: 'Strobe',             ja: 'ストロボ',             en: 'Strobe' },
  { id: 33, name: 'LandingLight',       ja: 'ランディングライト',   en: 'Landing Light' },
  { id: 34, name: 'LightOnGear',        ja: 'ギアライト',           en: 'Light on Landing Gear' },
  // Doors / interior
  { id: 40, name: 'LeftDoor',           ja: '左ドア',               en: 'Left Door' },
  { id: 41, name: 'RightDoor',          ja: '右ドア',               en: 'Right Door' },
  { id: 42, name: 'RearDoor',           ja: '後部ドア',             en: 'Rear Door' },
  { id: 43, name: 'Interior',           ja: '内装',                 en: 'Interior' },
];

export const CLA_BY_ID = new Map(CLA_TABLE.map((c) => [c.id, c]));
export const IS_LIGHT = new Set([30, 31, 32, 33, 34]);

// Blink parameters extracted from fsairplaneproperty.cpp defaults.
const BLINK = {
  31: { onMs: 800,  period: 1600 },   // Beacon
  32: { onMs: 100,  period: 1000 },   // Strobe
};

// ---------------------------------------------------------------------------
// DNM text-level editing helpers
// ---------------------------------------------------------------------------

const f6 = (v) => (Math.abs(v) < 5e-7 ? '0' : String(Math.round(v * 1e6) / 1e6));

// Re-serialise one STA array element to a line.
const staLine = (s) =>
  'STA ' + s.slice(0, 3).map(f6).join(' ') + ' ' +
  s.slice(3, 6).map((v) => Math.round(v)).join(' ') + ' ' +
  (s[6] !== undefined ? s[6] : 1);

// Non-destructive edit: replace CLA / CNT / STA fields for `label` in the
// original DNM bytes without touching any other bytes.  Returns a new
// Uint8Array (or the original object reference when edits is empty).
export function modifyDnmNodeFields(originalBytes, edits) {
  // edits: Map<label, {cla?, cnt?, sta?}>
  if (!edits || !edits.size) return originalBytes;

  const dec = new TextDecoder();
  const lines = dec.decode(originalBytes).split('\n');
  const out = [];

  // Skip PCK blocks intact; then process node blocks.
  let i = 0;
  // Header
  while (i < lines.length) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'PCK') {
      const n = parseInt(t[2], 10) || 0;
      // Copy PCK header + embedded SRF lines verbatim
      for (let k = 0; k <= n; k++) out.push(lines[i + k]);
      i += n + 1;
    } else if (t[0] === 'DYNAMODEL' || t[0] === 'DNMVER') {
      out.push(lines[i++]);
    } else {
      break; // reached first SRF block or END
    }
  }

  // Process node blocks.  Track whether we're inside a block to be modified.
  let mods = null;
  let skipStas = 0;

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim().split(/\s+/);

    if (t[0] === 'SRF' && t.length >= 2) {
      // Flush any pending mods, start new block tracking
      mods = edits.get(t[1].replace(/^"|"$/g, '')) || null;
      skipStas = 0;
      out.push(raw);
      continue;
    }

    if (!mods) { out.push(raw); continue; }

    // Inside a block that has edits
    if (skipStas > 0 && t[0] === 'STA') { skipStas--; continue; }

    if (mods.cla !== undefined && t[0] === 'CLA') {
      out.push('CLA ' + mods.cla);
    } else if (mods.cnt !== undefined && t[0] === 'CNT') {
      out.push('CNT ' + mods.cnt.map(f6).join(' '));
    } else if (mods.sta !== undefined && t[0] === 'NST') {
      const origNst = parseInt(t[1], 10) || 0;
      out.push('NST ' + mods.sta.length);
      for (const s of mods.sta) out.push(staLine(s));
      skipStas = origNst; // will eat that many subsequent STA lines
    } else {
      out.push(raw);
    }
  }

  return new TextEncoder().encode(out.join('\n'));
}

// Generate the SRF text for a small B-face light-box centred at (cx,cy,cz).
// Follows the stock idiom from gen-aircraft-from-spec.mjs: a 6-quad box with
// every face marked 'B' (bright/unlit), colour = [r,g,b] in 0..255.
export function makeLightSrfText(cx, cy, cz, s, color) {
  const [r, g, b] = color;
  const verts = [
    [cx - s, cy - s, cz - s], [cx + s, cy - s, cz - s],
    [cx + s, cy + s, cz - s], [cx - s, cy + s, cz - s],
    [cx - s, cy - s, cz + s], [cx + s, cy - s, cz + s],
    [cx + s, cy + s, cz + s], [cx - s, cy + s, cz + s],
  ];
  const faces = [
    [0, 1, 2, 3], [5, 4, 7, 6],  // -Z, +Z
    [4, 0, 3, 7], [1, 5, 6, 2],  // -X, +X
    [3, 2, 6, 7], [4, 5, 1, 0],  // +Y, -Y
  ];
  const lines = ['SURF'];
  for (const v of verts) lines.push('V ' + v.map(f6).join(' '));
  for (const f of faces) {
    lines.push('F');
    lines.push('B');
    lines.push('V ' + f.join(' '));
    lines.push('C ' + r + ' ' + g + ' ' + b);
    lines.push('E');
  }
  lines.push('E');
  return lines.join('\n');
}

// Add a new light node to a DNM.  `nodeInfo`:
//   { label, cla, pos:[x,y,z,0,0,0], color:[r,g,b], parentLabel? }
// Inserts a PCK block just before the first SRF node block, and appends the
// SRF node block before the final END.  If parentLabel is given, the new
// node is added to that node's CLD list.
export function addLightNode(originalBytes, nodeInfo) {
  const { label, cla, pos, color, parentLabel } = nodeInfo;
  const s = 0.15; // half-size (m) of the light box
  const [px, py, pz] = pos || [0, 0, 0];
  const srfText = makeLightSrfText(0, 0, 0, s, color || [255, 255, 255]);
  const srfLines = srfText.split('\n');
  const srfName = label.toLowerCase().replace(/[^a-z0-9]/g, '_') + '.srf';
  const pckHeader = 'PCK ' + srfName + ' ' + srfLines.length;

  // SRF node block for the new light
  const posStr = [px, py, pz].map(f6).join(' ') + ' 0 0 0 1';
  const nodeBlock = [
    'SRF "' + label + '"',
    'FIL ' + srfName,
    'CLA ' + cla,
    'NST 0',
    'POS ' + posStr,
    'CNT 0 0 0',
    'PAX 0 0 0',
    'REL DEP',
    'NCH 0',
    'END',
  ];

  const dec = new TextDecoder();
  const lines = dec.decode(originalBytes).split('\n');
  const out = [];
  let firstSrfIdx = -1;
  let finalEndIdx = -1;

  // Find first SRF block and last END
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'PCK') { const n = parseInt(t[2], 10) || 0; i += n; continue; }
    if (t[0] === 'SRF' && t.length >= 2 && firstSrfIdx < 0) firstSrfIdx = i;
    if (t[0] === 'END') finalEndIdx = i;
  }
  if (firstSrfIdx < 0) firstSrfIdx = lines.length - 1;
  if (finalEndIdx < 0) finalEndIdx = lines.length - 1;

  // Rebuild: header+PCKs, new PCK, node blocks, new node, END
  out.push(...lines.slice(0, firstSrfIdx));
  out.push(pckHeader, ...srfLines);
  out.push(...lines.slice(firstSrfIdx, finalEndIdx));
  out.push(...nodeBlock);
  out.push('END');
  if (finalEndIdx + 1 < lines.length) out.push(...lines.slice(finalEndIdx + 1));

  let text = out.join('\n');

  // Add CLD to parent node block if requested
  if (parentLabel) {
    text = addChildToNode(text, parentLabel, label);
  }

  return new TextEncoder().encode(text);
}

// Add `childLabel` to the CLD list of `parentLabel` node block.
function addChildToNode(text, parentLabel, childLabel) {
  const lines = text.split('\n');
  const out = [];
  let inParent = false;
  const ql = '"' + parentLabel + '"';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'SRF' && (t[1] === ql)) { inParent = true; out.push(raw); continue; }
    if (inParent && t[0] === 'SRF') { inParent = false; }

    if (inParent && t[0] === 'NCH') {
      const n = parseInt(t[1], 10) || 0;
      out.push('NCH ' + (n + 1));
      continue;
    }
    if (inParent && t[0] === 'END') {
      out.push('CLD "' + childLabel + '"');
      out.push(raw);
      inParent = false;
      continue;
    }
    out.push(raw);
  }
  return out.join('\n');
}

// Remove a node (and its PCK block) from a DNM.  The node is also removed
// from any parent's CLD list.  Does NOT remove children of the node —
// orphaned children become root nodes (DNM parser treats them normally).
export function removeDnmNode(originalBytes, label) {
  const dec = new TextDecoder();
  const lines = dec.decode(originalBytes).split('\n');
  const ql = '"' + label + '"';

  // First: find the SRF name (FIL line) for the node so we can remove its PCK
  let srfName = null;
  {
    let inTarget = false;
    for (const l of lines) {
      const t = l.trim().split(/\s+/);
      if (t[0] === 'SRF' && (t[1] === ql)) { inTarget = true; continue; }
      if (inTarget && t[0] === 'SRF') break;
      if (inTarget && t[0] === 'FIL') { srfName = t[1].replace(/^"|"$/g, ''); break; }
    }
  }

  const out = [];
  let skip = 0;     // lines remaining in a PCK block to skip
  let inTarget = false;
  let i = 0;

  for (; i < lines.length; i++) {
    if (skip > 0) { skip--; continue; }
    const raw = lines[i];
    const t = raw.trim().split(/\s+/);

    // Skip the PCK for this node's SRF
    if (t[0] === 'PCK') {
      const pckName = t[1].replace(/^"|"$/g, '');
      const n = parseInt(t[2], 10) || 0;
      if (pckName === srfName) { skip = n; continue; }
      out.push(raw);
      continue;
    }

    // Skip the node's own SRF block
    if (t[0] === 'SRF' && t.length >= 2 && (t[1] === ql)) { inTarget = true; continue; }
    if (inTarget) {
      if (t[0] === 'SRF') { inTarget = false; } // next node starts
      else continue; // skip all lines inside target block
    }

    // Strip CLD references from parent nodes
    if (t[0] === 'CLD' && (t[1] === ql)) continue;

    out.push(raw);
  }

  // Fix NCH counts for any node that lost a CLD
  const text = fixNchCounts(out.join('\n'));
  return new TextEncoder().encode(text);
}

// Recount NCH for every SRF block to match actual CLD lines.
function fixNchCounts(text) {
  const lines = text.split('\n');
  // Find every NCH line and its actual following CLD count
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'NCH') {
      // Count actual CLD lines until END or next SRF
      let nch = 0;
      let j = i + 1;
      while (j < lines.length) {
        const tt = lines[j].trim().split(/\s+/);
        if (tt[0] === 'CLD') { nch++; j++; }
        else break;
      }
      out.push('NCH ' + nch);
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Gizmo helpers (Three.js objects added to mountPreview's scene)
// ---------------------------------------------------------------------------

// YS left-handed -> Three.js right-handed mirror: flip X sign.
const ysToThree = (x, y, z) => new THREE.Vector3(-x, y, z);

// Build gizmo objects for a selected node: CNT sphere + hinge axis arrow.
// Returns an array of Three.js objects to add to the scene.
function buildNodeGizmo(nodeData) {
  const objs = [];
  const { cnt, pos, sta } = nodeData;
  if (!cnt) return objs;

  // CNT marker: small sphere at the pivot position (in world-ish coords)
  const [cx, cy, cz] = cnt;
  const [px, py, pz] = pos || [0, 0, 0, 0, 0, 0];
  // World position = POS + CNT (approximate; ignores parent transforms)
  const wx = px + cx, wy = py + cy, wz = (pz || 0) + cz;
  const sph = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x00ffff, depthTest: false }),
  );
  sph.position.copy(ysToThree(wx, wy, wz));
  sph.renderOrder = 999;
  objs.push(sph);

  // Hinge axis arrow: derive from STA rotation difference if possible
  if (sta && sta.length >= 2) {
    const a = sta[0], b = sta[sta.length - 1];
    const dh = (b[3] || 0) - (a[3] || 0);
    const dp = (b[4] || 0) - (a[4] || 0);
    const db = (b[5] || 0) - (a[5] || 0);
    // Dominant rotation axis in YS (RotateXZ=heading~Y, RotateZY=pitch~X, RotateXY=bank~Z)
    const mag = Math.hypot(dh, dp, db);
    if (mag > 0.5) {
      // Approximate: use the largest component's axis
      const nh = Math.abs(dh), np = Math.abs(dp), nb = Math.abs(db);
      let dir;
      if (nh >= np && nh >= nb) dir = new THREE.Vector3(0, 1, 0);      // heading → Y
      else if (np >= nh && np >= nb) dir = new THREE.Vector3(0, 0, -1); // pitch → Z
      else dir = new THREE.Vector3(-1, 0, 0);                            // bank → X
      const arrow = new THREE.ArrowHelper(dir, ysToThree(wx, wy, wz), 1.2, 0xffff00, 0.25, 0.12);
      arrow.renderOrder = 999;
      objs.push(arrow);
    }
  }

  return objs;
}

// ---------------------------------------------------------------------------
// UI strings
// ---------------------------------------------------------------------------

const LANG = document.documentElement.lang === 'en' ? 'en' : 'ja';

const S = {
  ja: {
    section: '可動部・ライト',
    intro: 'DNMノードのクラス・ヒンジ原点(CNT)・状態(STA)を編集。ライトノードの追加・削除も可。',
    nodeList: 'ノード一覧',
    noNodes: '（外観モデル .dnm を選んでください）',
    claLabel: 'クラス (CLA)',
    cntLabel: 'ヒンジ原点 (CNT)',
    staLabel: '状態 (STA)',
    staIdx: (i) => 'STA #' + i,
    staFields: ['Tx', 'Ty', 'Tz', 'H', 'P', 'B', 'Vis'],
    addSta: 'STA追加',
    removeSta: (i) => 'STA#' + i + '削除',
    posLabel: '位置 (POS)',
    apply: '適用',
    applied: (label) => '✓ ' + label + ' を更新しました',
    lightsSection: 'ライト管理',
    addNav: 'ナビライト追加',
    addBeacon: 'ビーコン追加',
    addStrobe: 'ストロボ追加',
    addLanding: 'ランディングライト追加',
    deleteNode: '削除',
    blinkPreview: '点滅プレビュー',
    blinkOn: 'ON', blinkOff: 'OFF',
    colorLabel: '色',
    posXYZ: ['X', 'Y', 'Z'],
    saveHint: '変更は「適用」ボタンで確定 → 「組み立てて保存」で次のステップへ',
    noVisual: '（外観モデルがありません）',
    blinkNote: '※点滅はエンジン実装値（ビーコン1.6s周期・ストロボ1.0s周期）に近似',
  },
  en: {
    section: 'Movables & Lights',
    intro: 'Edit DNM node class, hinge origin (CNT) and states (STA). Add / remove light nodes.',
    nodeList: 'Node list',
    noNodes: '(Select a visual .dnm)',
    claLabel: 'Class (CLA)',
    cntLabel: 'Hinge origin (CNT)',
    staLabel: 'States (STA)',
    staIdx: (i) => 'STA #' + i,
    staFields: ['Tx', 'Ty', 'Tz', 'H', 'P', 'B', 'Vis'],
    addSta: 'Add STA',
    removeSta: (i) => 'Remove STA#' + i,
    posLabel: 'Position (POS)',
    apply: 'Apply',
    applied: (label) => '✓ Updated ' + label,
    lightsSection: 'Light management',
    addNav: 'Add nav light',
    addBeacon: 'Add beacon',
    addStrobe: 'Add strobe',
    addLanding: 'Add landing light',
    deleteNode: 'Delete',
    blinkPreview: 'Blink preview',
    blinkOn: 'ON', blinkOff: 'OFF',
    colorLabel: 'Color',
    posXYZ: ['X', 'Y', 'Z'],
    saveHint: 'Click Apply to commit changes, then Assemble & Save',
    noVisual: '(No visual model)',
    blinkNote: '* Blink timings match engine defaults: beacon 1.6 s period, strobe 1.0 s period',
  },
}[LANG];

// ---------------------------------------------------------------------------
// Section builder — call once from studio-aircraft.js
// ---------------------------------------------------------------------------

// opts: {
//   getVisualEntry : () => {name, bytes} | null
//   getPreview     : () => previewHandle | null  (from mountPreview)
//   onBytesChanged : (newBytes, entryName) => void
// }
export function buildMovablesSection(rail, opts) {
  const { getVisualEntry, getPreview, onBytesChanged } = opts;

  // --- section header ---
  const h2 = document.createElement('h2');
  h2.textContent = S.section;
  rail.appendChild(h2);
  const intro = document.createElement('p');
  intro.className = 'intro';
  intro.textContent = S.intro;
  rail.appendChild(intro);

  const msg = document.createElement('div');
  msg.className = 'msg';
  rail.appendChild(msg);

  // --- node list ---
  const nodeListDiv = document.createElement('div');
  nodeListDiv.style.cssText = 'margin:6px 0;max-height:220px;overflow-y:auto;border:1px solid #ACA899;border-radius:2px;background:#fff';
  rail.appendChild(nodeListDiv);

  // --- detail panel ---
  const detailDiv = document.createElement('div');
  detailDiv.style.cssText = 'margin:6px 0;padding:8px;border:1px solid #ACA899;border-radius:2px;background:#F2F1E5;display:none';
  rail.appendChild(detailDiv);

  // --- lights management ---
  const lightDiv = document.createElement('div');
  rail.appendChild(lightDiv);

  // hint
  const hint = document.createElement('div');
  hint.className = 'msg';
  hint.style.cssText = 'margin-top:6px;font-size:11px;color:#777';
  hint.textContent = S.saveHint;
  rail.appendChild(hint);

  // Active gizmo objects added to the Three.js scene
  let gizmoObjs = [];
  let blinkRaf = 0;
  let selectedLabel = null;
  // Draft edits: Map<label, {cla?,cnt?,sta?,pos?}>
  const pendingEdits = new Map();

  function clearGizmos() {
    const preview = getPreview();
    if (preview && preview.scene) {
      for (const obj of gizmoObjs) preview.scene.remove(obj);
    }
    gizmoObjs = [];
  }

  function installGizmo(nodeData) {
    clearGizmos();
    const preview = getPreview();
    if (!preview || !preview.scene) return;
    const objs = buildNodeGizmo(nodeData);
    for (const obj of objs) preview.scene.add(obj);
    gizmoObjs = objs;
  }

  function showDetail(label, nodeData) {
    selectedLabel = label;
    detailDiv.style.display = 'block';
    detailDiv.innerHTML = '';
    installGizmo(nodeData);

    // Merge with any pending edits so the UI shows the draft state
    const pending = pendingEdits.get(label) || {};
    const cla  = pending.cla  !== undefined ? pending.cla  : (nodeData.cla || 0);
    const cnt  = pending.cnt  !== undefined ? [...pending.cnt]  : [...(nodeData.cnt  || [0, 0, 0])];
    const sta  = pending.sta  !== undefined ? pending.sta.map(s => [...s]) : (nodeData.sta || []).map(s => [...s]);
    const pos  = pending.pos  !== undefined ? [...pending.pos]  : [...(nodeData.pos  || [0, 0, 0, 0, 0, 0])];

    const isLight = IS_LIGHT.has(cla);

    // Title
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:6px;color:#000';
    title.textContent = '"' + label + '"';
    detailDiv.appendChild(title);

    // CLA dropdown
    const claRow = mkRow(S.claLabel);
    const claSel = document.createElement('select');
    claSel.style.cssText = 'flex:1;min-width:0;background:#fff;color:#000;border:1px solid #7F9DB9;border-radius:2px;padding:2px 4px';
    for (const c of CLA_TABLE) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.id + ' ' + c.name + ' — ' + c[LANG];
      if (c.id === cla) opt.selected = true;
      claSel.appendChild(opt);
    }
    claRow.appendChild(claSel);
    detailDiv.appendChild(claRow);

    // POS (light nodes: show position editor; movable nodes: read-only hint)
    if (isLight) {
      const posRow = mkRow(S.posLabel);
      const posInputs = S.posXYZ.map((axis, idx) => {
        const inp = numInput(pos[idx] || 0);
        inp.title = axis;
        posRow.appendChild(inp);
        return inp;
      });
      detailDiv.appendChild(posRow);

      // CNT (for lights usually 0,0,0 — still editable for completeness)
      const cntRow = mkRow(S.cntLabel);
      const cntInputs = S.posXYZ.map((axis, idx) => {
        const inp = numInput(cnt[idx] || 0);
        inp.title = axis;
        cntRow.appendChild(inp);
        return inp;
      });
      detailDiv.appendChild(cntRow);

      // Blink preview for beacon/strobe
      if (BLINK[cla]) {
        const blinkRow = mkRow(S.blinkPreview);
        const blinkBtn = document.createElement('button');
        let blinkActive = false;
        blinkBtn.textContent = S.blinkOff;
        blinkBtn.addEventListener('click', () => {
          blinkActive = !blinkActive;
          blinkBtn.textContent = blinkActive ? S.blinkOn : S.blinkOff;
          if (blinkActive) startBlinkPreview(cla); else stopBlinkPreview();
        });
        blinkRow.appendChild(blinkBtn);
        const blinkNote = document.createElement('span');
        blinkNote.style.cssText = 'font-size:10px;color:#777;margin-left:6px';
        blinkNote.textContent = S.blinkNote;
        blinkRow.appendChild(blinkNote);
        detailDiv.appendChild(blinkRow);
      }

      // Apply button for lights
      const applyBtn = accentBtn(S.apply);
      applyBtn.addEventListener('click', () => {
        const newPos = [...posInputs.map(inp => parseFloat(inp.value) || 0), 0, 0, 0];
        const newCnt = cntInputs.map(inp => parseFloat(inp.value) || 0);
        const newCla = parseInt(claSel.value, 10);
        pendingEdits.set(label, { cla: newCla, pos: newPos, cnt: newCnt });
        commitEdits(label);
      });
      detailDiv.appendChild(applyBtn);

    } else {
      // CNT editor
      const cntRow = mkRow(S.cntLabel);
      const cntInputs = S.posXYZ.map((axis, idx) => {
        const inp = numInput(cnt[idx] || 0);
        inp.title = axis;
        cntRow.appendChild(inp);
        return inp;
      });
      detailDiv.appendChild(cntRow);

      // STA table
      const staSection = document.createElement('div');
      staSection.style.cssText = 'margin:6px 0';
      const staLabel = document.createElement('div');
      staLabel.style.cssText = 'font-size:11px;color:#555;margin-bottom:4px';
      staLabel.textContent = S.staLabel;
      staSection.appendChild(staLabel);

      let staData = sta.length > 0 ? sta.map(s => [...s]) : [];

      const renderStaTable = () => {
        staSection.querySelectorAll('.sta-row').forEach(el => el.remove());
        staData.forEach((row, ri) => {
          const r = document.createElement('div');
          r.className = 'sta-row';
          r.style.cssText = 'display:flex;align-items:center;gap:3px;margin:2px 0;flex-wrap:wrap';
          const idxLab = document.createElement('span');
          idxLab.style.cssText = 'color:#777;font-size:10px;width:36px;flex:none';
          idxLab.textContent = S.staIdx(ri);
          r.appendChild(idxLab);
          S.staFields.forEach((field, fi) => {
            const inp = Object.assign(document.createElement('input'), {
              type: 'number', step: fi >= 3 && fi < 6 ? '100' : '0.01',
              value: (row[fi] !== undefined ? row[fi] : (fi === 6 ? 1 : 0)),
            });
            inp.style.cssText = 'width:52px;min-width:0;background:#fff;color:#000;border:1px solid #7F9DB9;border-radius:2px;padding:1px 3px;font-size:11px';
            inp.title = field;
            inp.addEventListener('change', () => {
              row[fi] = parseFloat(inp.value) || 0;
            });
            r.appendChild(inp);
          });
          const rmBtn = document.createElement('button');
          rmBtn.textContent = '✕';
          rmBtn.style.cssText = 'padding:1px 4px;font-size:10px';
          rmBtn.title = S.removeSta(ri);
          rmBtn.addEventListener('click', () => { staData.splice(ri, 1); renderStaTable(); });
          r.appendChild(rmBtn);
          staSection.appendChild(r);
        });
      };

      renderStaTable();

      const addStaBtn = document.createElement('button');
      addStaBtn.textContent = S.addSta;
      addStaBtn.style.cssText = 'font-size:11px;margin-top:3px';
      addStaBtn.addEventListener('click', () => {
        const last = staData[staData.length - 1] || [0, 0, 0, 0, 0, 0, 1];
        staData.push([...last]);
        renderStaTable();
      });
      staSection.appendChild(addStaBtn);
      detailDiv.appendChild(staSection);

      // Apply button
      const applyBtn = accentBtn(S.apply);
      applyBtn.style.cssText = 'margin-top:6px';
      applyBtn.addEventListener('click', () => {
        const newCnt = cntInputs.map(inp => parseFloat(inp.value) || 0);
        const newCla = parseInt(claSel.value, 10);
        pendingEdits.set(label, { cla: newCla, cnt: newCnt, sta: staData });
        commitEdits(label);
      });
      detailDiv.appendChild(applyBtn);
    }
  }

  function commitEdits(justAppliedLabel) {
    const ent = getVisualEntry();
    if (!ent || !pendingEdits.size) return;
    let bytes = ent.bytes;
    bytes = modifyDnmNodeFields(bytes, pendingEdits);
    pendingEdits.clear();
    onBytesChanged(bytes, ent.name);
    msg.textContent = S.applied(justAppliedLabel);
  }

  function startBlinkPreview(cla) {
    stopBlinkPreview();
    const preview = getPreview();
    if (!preview || !preview.scene) return;
    const { onMs, period } = BLINK[cla];
    const lightObjs = gizmoObjs.filter(o => o instanceof THREE.Mesh);
    let t0 = performance.now();
    const tick = () => {
      const elapsed = (performance.now() - t0) % period;
      const visible = elapsed < onMs;
      for (const obj of lightObjs) obj.visible = visible;
      blinkRaf = requestAnimationFrame(tick);
    };
    blinkRaf = requestAnimationFrame(tick);
  }

  function stopBlinkPreview() {
    if (blinkRaf) { cancelAnimationFrame(blinkRaf); blinkRaf = 0; }
    for (const obj of gizmoObjs) if (obj instanceof THREE.Mesh) obj.visible = true;
  }

  // --- node list render ---
  function renderNodeList() {
    nodeListDiv.innerHTML = '';
    detailDiv.style.display = 'none';
    clearGizmos();
    stopBlinkPreview();
    lightDiv.innerHTML = '';

    const ent = getVisualEntry();
    if (!ent) {
      const em = document.createElement('div');
      em.style.cssText = 'padding:8px;color:#777;font-size:12px';
      em.textContent = S.noNodes;
      nodeListDiv.appendChild(em);
      return;
    }

    let parsed;
    try { parsed = parseDnm(ent.bytes); }
    catch (e) { msg.textContent = 'parse error: ' + e.message; return; }

    const nodes = [...parsed.nodes.values()];

    for (const n of nodes) {
      const claInfo = CLA_BY_ID.get(n.cla);
      const claStr = n.cla + (claInfo ? ' ' + claInfo.name : '');
      const isLight = IS_LIGHT.has(n.cla);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;border-bottom:1px solid #E5E1CE';
      if (selectedLabel === n.label) row.style.background = '#D6E5F5';

      const dot = document.createElement('span');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:none;background:' + (isLight ? '#E5A11B' : '#0046D5');
      row.appendChild(dot);

      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#000';
      nameSpan.textContent = n.label;
      row.appendChild(nameSpan);

      const claSpan = document.createElement('span');
      claSpan.style.cssText = 'font-size:10px;color:#555;flex:none';
      claSpan.textContent = claStr;
      row.appendChild(claSpan);

      row.addEventListener('click', () => {
        nodeListDiv.querySelectorAll('div').forEach(d => { d.style.background = ''; });
        row.style.background = '#D6E5F5';
        showDetail(n.label, n);
      });
      nodeListDiv.appendChild(row);
    }

    // Light management buttons
    const lh = document.createElement('h3');
    lh.style.cssText = 'margin:12px 0 4px;font-size:13px;color:#0046D5';
    lh.textContent = S.lightsSection;
    lightDiv.appendChild(lh);

    const lightBtns = [
      { label: 'Nav',     cla: 30, color: [255, 200, 200], text: S.addNav },
      { label: 'Beacon',  cla: 31, color: [255, 60,  60],  text: S.addBeacon },
      { label: 'Strobe',  cla: 32, color: [255, 255, 255], text: S.addStrobe },
      { label: 'Landing', cla: 33, color: [255, 255, 200], text: S.addLanding },
    ];

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px';
    for (const lb of lightBtns) {
      const btn = document.createElement('button');
      btn.textContent = lb.text;
      btn.style.cssText = 'font-size:11px';
      btn.addEventListener('click', () => {
        const ent2 = getVisualEntry();
        if (!ent2) return;
        // Auto-name: count existing nodes with same CLA
        const existing = [...parseDnm(ent2.bytes).nodes.values()].filter(n => n.cla === lb.cla).length;
        const newLabel = lb.label + (existing > 0 ? existing + 1 : '');
        const newBytes = addLightNode(ent2.bytes, {
          label: newLabel, cla: lb.cla,
          pos: [0, 0, 0], color: lb.color,
          parentLabel: findRootNode(ent2.bytes),
        });
        onBytesChanged(newBytes, ent2.name);
        msg.textContent = '+ ' + newLabel + ' (CLA ' + lb.cla + ') を追加しました';
      });
      btnRow.appendChild(btn);
    }
    lightDiv.appendChild(btnRow);
  }

  function findRootNode(bytes) {
    try {
      const p = parseDnm(bytes);
      return p.roots[0] || null;
    } catch (_) { return null; }
  }

  // Public API
  return {
    refresh: renderNodeList,
    dispose: () => { clearGizmos(); stopBlinkPreview(); },
  };
}

// ---------------------------------------------------------------------------
// Small DOM helpers (no dependency on studio-shared.js)
// ---------------------------------------------------------------------------

function mkRow(labelText) {
  const r = document.createElement('div');
  r.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0';
  const lab = document.createElement('span');
  lab.style.cssText = 'flex:none;width:130px;font-size:11px;color:#555';
  lab.textContent = labelText;
  r.appendChild(lab);
  return r;
}

function numInput(value) {
  return Object.assign(document.createElement('input'), {
    type: 'number', step: '0.01', value,
    style: 'width:64px;background:#fff;color:#000;border:1px solid #7F9DB9;border-radius:2px;padding:2px 4px;font-size:12px',
  });
}

function accentBtn(text) {
  const btn = document.createElement('button');
  btn.className = 'accent';
  btn.textContent = text;
  return btn;
}
