// studio-scenery.js — Scenery Studio (🏝 マップスタジオ)
// Full-screen map editor: the canvas fills the main work area.
// Drawing/placement logic ported verbatim from workbench-page.js islandCard().

import {
  studioChrome, LANG, el, row, flyUrl, pageUrl,
  saveOrReplace, loadCreation, OBJECT_PALETTE, WORLD_M,
  DEFAULT_FLY_AIRCRAFT, stockIndex,
} from './studio-shared.js';
import { assembleSceneryZip, migrateScenery, runwayLightFixtures, SCENERY_START } from './workbench.js';
import {
  hitTest, itemAt, moveSelected, setHeading, duplicateSelected, deleteSelected,
  runwayCorners,
} from './scenery-edit.js';

// Bilingual strings (island keys verbatim from workbench-page.js S.ja / S.en).
const S = ({
  ja: {
    title: '🏝 マップスタジオ',
    isTitle: '🏝 マップ',
    isIntro: 'ドラッグで海岸線を描くと島になります（何個でも）。島は本物の陸地＝降りられます。マップは16km四方。',
    isName: 'マップ名（英数字）',
    isSea: '海の色', isSky: '空の色', isLand: '島の色',
    isAlt: '開始高度 (m)',
    saveTitle: '保存',
    isMake: 'マップを保存する',
    isEmptyOk: '（島ゼロでも保存できます＝ただの海）',
    isUndo: '↩ 1つ戻す', isClear: '全部消す',
    modeDraw: '✏️ 島を描く',
    modeObject: '🚢 置き物',
    modeMountain: '⛰ 山',
    modeStart: '🛫 スタート',
    modeRunway: '🛬 滑走路',
    modeSelect: '🖱 選択',
    modeHint: {
      select: 'クリックで選択・ドラッグで移動（島は頂点もつかめます）。数値で位置・向きを編集、複製・削除も',
      draw: 'ドラッグで海岸線を描くと島になります',
      object: '置きたい物を選んでクリックで配置（空母は本当に着艦・発艦できます）',
      mountain: 'クリックで山を置きます（なだらかな本物の地形＝緩い斜面には着陸もできます）',
      start: 'クリックで開始地点を置きます（低高度・速度0なら降着装置が下りた状態で始まります）',
      runway: 'クリックで滑走路を敷きます（着陸可・端に離陸位置つき。海の上でもOK）',
    },
    objPick: '置く物',
    headingDeg: '向き (°)',
    mtRadius: '山の半径 (m)',
    mtHeight: '山の高さ (m)',
    rwLength: '長さ (m)',
    rwWidth: '幅 (m)',
    stAlt: '開始高度 (m)',
    stSpeed: '開始速度 (m/s)',
    selNone: '（何も選択されていません — 地図上の要素をクリック）',
    selKind: { island: '🏝 島', object: '🚢 置き物', mountain: '⛰ 山', start: '🛫 スタート', runway: '🛬 滑走路' },
    selX: '東西 (m)', selZ: '南北 (m)',
    selVerts: (n) => '頂点 ' + n + ' 個',
    selDup: '⧉ 複製', selDel: '🗑 削除',
    rwIls: '📡 ILS（計器進入）',
    rwVaid: '進入角指示灯',
    vaidNone: 'なし', vaidPapi: 'PAPI', vaidVasi: 'VASI',
    isDone: (n, k) => '✓ マップ「' + n + '」（島 ' + k + ' 個）を保存しました',
    flyWhat: 'テスト飛行の機体',
    fly: (n) => '🛫 ' + n + ' で飛ぶ',
    libEditingBadge: (n) => '✏️ 編集中: ' + n,
    errorPrefix: 'エラー: ',
    working: '作業中…',
    usageTitle: '使い方',
  },
  en: {
    title: '🏝 Scenery Studio',
    isTitle: '🏝 Map',
    isIntro: 'Drag to draw coastlines — each stroke becomes an island (as many as you like). Islands are real, landable ground. The map is 16km across.',
    isName: 'Map name (ASCII)',
    isSea: 'Sea color', isSky: 'Sky color', isLand: 'Island color',
    isAlt: 'Start altitude (m)',
    saveTitle: 'Save',
    isMake: 'Save the map',
    isEmptyOk: '(Zero islands is fine too — plain sea)',
    isUndo: '↩ Undo', isClear: 'Clear all',
    modeDraw: '✏️ Draw islands',
    modeObject: '🚢 Objects',
    modeMountain: '⛰ Mountains',
    modeStart: '🛫 Starts',
    modeRunway: '🛬 Runways',
    modeSelect: '🖱 Select',
    modeHint: {
      select: 'Click to select, drag to move (islands: grab a vertex too). Edit numbers, duplicate or delete',
      draw: 'Drag to draw coastlines — each stroke becomes an island',
      object: 'Pick something and click to place it (the carrier really works for landing/launching)',
      mountain: 'Click to place a mountain (real terrain — gentle slopes are landable)',
      start: 'Click to place a spawn point (low + slow starts with gear down)',
      runway: 'Click to lay a runway (landable, with a takeoff spawn at the threshold — even over water)',
    },
    objPick: 'Object',
    headingDeg: 'Heading (°)',
    mtRadius: 'Mountain radius (m)',
    mtHeight: 'Mountain height (m)',
    rwLength: 'Length (m)',
    rwWidth: 'Width (m)',
    stAlt: 'Start altitude (m)',
    stSpeed: 'Start speed (m/s)',
    selNone: '(nothing selected — click an element on the map)',
    selKind: { island: '🏝 Island', object: '🚢 Object', mountain: '⛰ Mountain', start: '🛫 Start', runway: '🛬 Runway' },
    selX: 'East (m)', selZ: 'North (m)',
    selVerts: (n) => n + ' vertices',
    selDup: '⧉ Duplicate', selDel: '🗑 Delete',
    rwIls: '📡 ILS (instrument approach)',
    rwVaid: 'Approach slope lights',
    vaidNone: 'None', vaidPapi: 'PAPI', vaidVasi: 'VASI',
    isDone: (n, k) => '✓ Saved map "' + n + '" (' + k + ' island' + (k === 1 ? '' : 's') + ')',
    flyWhat: 'Test-fly aircraft',
    fly: (n) => '🛫 Fly ' + n,
    libEditingBadge: (n) => '✏️ Editing: ' + n,
    errorPrefix: 'Error: ',
    working: 'Working…',
    usageTitle: 'How to use',
  },
})[LANG];

async function main() {
  const { rail, main: mainEl } = studioChrome(S.title);

  // ── rail: map settings ────────────────────────────────────────────────────────

  rail.appendChild(el('h2', null, S.isTitle));

  const editBadge = el('div', 'msg');
  rail.appendChild(editBadge);
  let editingId = null; // replace-on-save target when re-editing

  const nameIn = row(rail, S.isName, Object.assign(document.createElement('input'), { type: 'text' }));
  const seaIn  = row(rail, S.isSea,  Object.assign(document.createElement('input'), { type: 'color', value: '#0d3a66' }));
  const skyIn  = row(rail, S.isSky,  Object.assign(document.createElement('input'), { type: 'color', value: '#176abd' }));
  const landIn = row(rail, S.isLand, Object.assign(document.createElement('input'), { type: 'color', value: '#3c8c50' }));
  const altIn  = row(rail, S.isAlt,  Object.assign(document.createElement('input'), { type: 'number', value: '1000', min: '100', max: '10000' }));

  // ── rail: save section ────────────────────────────────────────────────────────

  rail.appendChild(el('h2', null, S.saveTitle));
  const goBtn = el('button', 'accent', S.isMake);
  rail.appendChild(goBtn);
  const saveMsg = el('div', 'msg', S.isEmptyOk);
  rail.appendChild(saveMsg);
  const flyRow = el('div');
  flyRow.style.display = 'none';
  rail.appendChild(flyRow);

  // ── rail: usage / legend ─────────────────────────────────────────────────────

  rail.appendChild(el('h2', null, S.usageTitle));
  rail.appendChild(el('p', 'intro', S.isIntro));
  const modeLabels = {
    select: S.modeSelect, draw: S.modeDraw, object: S.modeObject, mountain: S.modeMountain, start: S.modeStart, runway: S.modeRunway,
  };
  const legend = el('div');
  legend.style.cssText = 'color:#7d93b0;font-size:11.5px';
  for (const [k, hint] of Object.entries(S.modeHint)) {
    const li = el('div');
    li.style.marginBottom = '4px';
    li.textContent = modeLabels[k] + ': ' + hint;
    legend.appendChild(li);
  }
  rail.appendChild(legend);

  // ── main: toolbar ─────────────────────────────────────────────────────────────
  // flex:none slim bar above the canvas; per-mode controls live here too.

  const toolbar = el('div');
  toolbar.style.cssText = 'flex:none;padding:8px 12px;border-bottom:1px solid #2a3647;background:#0d141d';

  // Top sub-row: mode buttons | hint text (flex:1) | undo | clear
  const toolRow = el('div');
  toolRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap';

  let mode = 'draw';
  const modeBtns = {};

  const modeBar = el('div');
  modeBar.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap';

  const modeHintEl = el('span');
  modeHintEl.style.cssText = 'flex:1;min-width:0;color:#7d93b0;font-size:11px;padding:0 4px';
  modeHintEl.textContent = S.modeHint.draw;

  const undoBtn  = el('button', null, S.isUndo);
  const clearBtn = el('button', null, S.isClear);

  // Per-mode number input helper (toolbar-sized styling).
  const numIn = (v, min, max, w) => {
    const i = Object.assign(document.createElement('input'), {
      type: 'number', value: String(v), min: String(min), max: String(max),
    });
    i.style.cssText = 'width:' + (w || 80) + 'px;padding:5px 8px;border:1px solid #2a3647;border-radius:5px;background:#0b1017;color:#e6edf3;font-size:12.5px';
    return i;
  };
  const clab = (t) => {
    const s = el('span', null, t);
    s.style.cssText = 'color:#8fa3bb;font-size:12px;white-space:nowrap';
    return s;
  };

  // Object mode controls
  const objSel = document.createElement('select');
  objSel.style.cssText = 'padding:5px 8px;border:1px solid #2a3647;border-radius:5px;background:#0b1017;color:#e6edf3;font-size:12.5px;max-width:180px';
  for (const o of OBJECT_PALETTE) {
    objSel.appendChild(Object.assign(el('option'), { value: o.nam, textContent: o.glyph + ' ' + (LANG === 'ja' ? o.ja : o.en) }));
  }
  const objHead = numIn(0, 0, 359, 70);
  const objCtl = el('div');
  objCtl.style.cssText = 'display:none;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px';
  objCtl.appendChild(clab(S.objPick)); objCtl.appendChild(objSel);
  objCtl.appendChild(clab(S.headingDeg)); objCtl.appendChild(objHead);

  // Mountain mode controls
  const mtRad = numIn(1500, 300, 6000, 90);
  const mtHt  = numIn(300,  30,  2000, 90);
  const mtCtl = el('div');
  mtCtl.style.cssText = 'display:none;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px';
  mtCtl.appendChild(clab(S.mtRadius)); mtCtl.appendChild(mtRad);
  mtCtl.appendChild(clab(S.mtHeight)); mtCtl.appendChild(mtHt);

  // Start mode controls
  const stAlt  = numIn(300, 0, 10000, 90);
  const stSpd  = numIn(80,  0, 400,   80);
  const stHead = numIn(0,   0, 359,   70);
  const stCtl  = el('div');
  stCtl.style.cssText = 'display:none;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px';
  stCtl.appendChild(clab(S.stAlt));    stCtl.appendChild(stAlt);
  stCtl.appendChild(clab(S.stSpeed));  stCtl.appendChild(stSpd);
  stCtl.appendChild(clab(S.headingDeg)); stCtl.appendChild(stHead);

  // Small helpers for the approach-aid controls (used in runway mode and in
  // the select panel for an existing runway).
  const ilsCheck = (get, set) => {
    const lb = el('label');
    lb.style.cssText = 'display:inline-flex;align-items:center;gap:4px;color:#8fa3bb;font-size:12px;white-space:nowrap;cursor:pointer';
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!get() });
    cb.addEventListener('change', () => set(cb.checked));
    lb.appendChild(cb);
    lb.appendChild(document.createTextNode(S.rwIls));
    return lb;
  };
  const vaidSel = (get, set) => {
    const sl = document.createElement('select');
    sl.style.cssText = 'padding:5px 8px;border:1px solid #2a3647;border-radius:5px;background:#0b1017;color:#e6edf3;font-size:12.5px';
    for (const [v, label] of [['', S.vaidNone], ['papi', S.vaidPapi], ['vasi', S.vaidVasi]]) {
      sl.appendChild(Object.assign(el('option'), { value: v, textContent: label }));
    }
    sl.value = get() || '';
    sl.addEventListener('change', () => set(sl.value || undefined));
    return sl;
  };

  // Runway mode controls
  const rwLen  = numIn(2000, 400, 6000, 90);
  const rwWid  = numIn(45,   20,  120,  80);
  const rwHead = numIn(0,    0,   359,  70);
  let rwIls = false, rwVaid;
  const rwCtl  = el('div');
  rwCtl.style.cssText = 'display:none;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px';
  rwCtl.appendChild(clab(S.rwLength));   rwCtl.appendChild(rwLen);
  rwCtl.appendChild(clab(S.rwWidth));    rwCtl.appendChild(rwWid);
  rwCtl.appendChild(clab(S.headingDeg)); rwCtl.appendChild(rwHead);
  rwCtl.appendChild(ilsCheck(() => rwIls, (v) => { rwIls = v; }));
  rwCtl.appendChild(clab(S.rwVaid));     rwCtl.appendChild(vaidSel(() => rwVaid, (v) => { rwVaid = v; }));

  // Select mode: property mini-panel (rebuilt per selection by renderSelPanel).
  const selCtl = el('div');
  selCtl.style.cssText = 'display:none;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px';

  const perModeCtls = { select: selCtl, draw: null, object: objCtl, mountain: mtCtl, start: stCtl, runway: rwCtl };

  let deselect = () => {}; // bound after the selection state exists below

  const setMode = (m) => {
    mode = m;
    modeHintEl.textContent = S.modeHint[m];
    for (const [k, b] of Object.entries(modeBtns)) b.className = k === m ? 'accent' : '';
    for (const ctl of [selCtl, objCtl, mtCtl, stCtl, rwCtl]) ctl.style.display = 'none';
    const c = perModeCtls[m];
    if (c) c.style.display = 'flex';
    if (m !== 'select') deselect();
  };

  for (const [m, label] of [['draw', S.modeDraw], ['select', S.modeSelect], ['object', S.modeObject], ['mountain', S.modeMountain], ['runway', S.modeRunway], ['start', S.modeStart]]) {
    const b = el('button', m === 'draw' ? 'accent' : null, label);
    b.addEventListener('click', () => setMode(m));
    modeBtns[m] = b;
    modeBar.appendChild(b);
  }

  toolRow.appendChild(modeBar);
  toolRow.appendChild(modeHintEl);
  toolRow.appendChild(undoBtn);
  toolRow.appendChild(clearBtn);
  toolbar.appendChild(toolRow);
  toolbar.appendChild(selCtl);
  toolbar.appendChild(objCtl);
  toolbar.appendChild(mtCtl);
  toolbar.appendChild(stCtl);
  toolbar.appendChild(rwCtl);
  mainEl.appendChild(toolbar);

  // ── main: canvas wrap ─────────────────────────────────────────────────────────
  // Canvas keeps 640×640 internal resolution; CSS size tracks the container via
  // ResizeObserver so pointer math (getBoundingClientRect-normalized) stays valid.

  const canvasWrap = el('div');
  canvasWrap.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;padding:12px;overflow:hidden;min-height:0';

  const canvas = document.createElement('canvas');
  canvas.width  = 640;
  canvas.height = 640;
  canvas.style.cssText = 'touch-action:none;cursor:crosshair;border:1px solid #2a3647;border-radius:8px;display:block';

  // Largest centered square that fits in the padded container.
  new ResizeObserver(() => {
    const s = Math.max(64, Math.min(canvasWrap.clientWidth - 24, canvasWrap.clientHeight - 24));
    canvas.style.width  = s + 'px';
    canvas.style.height = s + 'px';
  }).observe(canvasWrap);

  canvasWrap.appendChild(canvas);
  mainEl.appendChild(canvasWrap);
  const ctx = canvas.getContext('2d');

  // ── drawing state ─────────────────────────────────────────────────────────────
  // Everything lives in WORLD METERS (recipe shape); only the in-progress
  // stroke is canvas px.  `state` is the shared handle for scenery-edit.js.

  const islands   = [];   // {points: [[x, z], ...]}
  const objects   = [];   // {nam, x, z, headingDeg}
  const mountains = [];   // {x, z, radiusM, heightM}
  const starts    = [];   // {x, z, altM, speedMS, headingDeg}
  const runways   = [];   // {x, z, headingDeg, lengthM, widthM}
  const state     = { islands, objects, mountains, starts, runways };
  let stroke = null;

  // Snapshot undo: push a deep copy before every mutation (place, drag, edit,
  // delete, duplicate, clear); undo restores in place (array identity kept).
  const undoStack = [];
  const pushUndo = () => {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 60) undoStack.shift();
  };
  const popUndo = () => {
    const snap = undoStack.pop();
    if (!snap) return;
    const s = JSON.parse(snap);
    for (const k of Object.keys(state)) state[k].splice(0, state[k].length, ...s[k]);
  };

  let sel = null;      // {kind, index, vertex?} — select mode only
  let drag = null;     // {x, z, moved} — world coords of the last drag point

  // World axes (engine truth, see compassToEngineDeg in workbench.js):
  // +x = east, +z = north.  The canvas is a north-up map, so canvas -y = +z.
  const toWorld   = ([x, y]) => [(x / canvas.width  - 0.5) * WORLD_M, (0.5 - y / canvas.height) * WORLD_M];
  const fromWorld = ([x, z]) => [(x / WORLD_M + 0.5) * canvas.width,  (0.5 - z / WORLD_M) * canvas.height];
  const pxPerM    = canvas.width / WORLD_M;

  // ── redraw ────────────────────────────────────────────────────────────────────

  const redraw = () => {
    ctx.fillStyle = seaIn.value;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);

    const polys = islands.map((i) => (i.points || []).map(fromWorld))
      .concat(stroke && stroke.length >= 3 ? [stroke] : []);
    for (const poly of polys) {
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (const [x, y] of poly.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fillStyle = landIn.value;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.stroke();
    }

    for (const m of mountains) {
      const [cx, cy] = fromWorld([m.x, m.z]);
      const r = m.radiusM * pxPerM;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0,   'rgba(139,90,43,.9)');
      g.addColorStop(0.6, 'rgba(90,120,60,.6)');
      g.addColorStop(1,   'rgba(90,120,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const rw of runways) {
      const [cx, cy] = fromWorld([rw.x, rw.z]);
      const h = (rw.headingDeg || 0) * Math.PI / 180;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(h);
      // heading 0 = north = canvas -y; the rect's long side runs along -y
      const lpx = rw.lengthM * pxPerM;
      const wpx = Math.max(4, rw.widthM * pxPerM);
      ctx.fillStyle = '#585a5e';
      ctx.fillRect(-wpx / 2, -lpx / 2, wpx, lpx);
      ctx.strokeStyle = 'rgba(255,255,255,.8)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, -lpx / 2 + 3);
      ctx.lineTo(0, lpx / 2 - 3);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      // Approach aids, where they will stand in the compiled field.
      for (const g of runwayLightFixtures(rw)) {
        const [gx, gy] = fromWorld([g.x, g.z]);
        ctx.fillStyle = g.nam === 'ILS' ? '#39d5ff' : g.nam === 'VASI' ? '#ffb84d' : '#ff5964';
        ctx.fillRect(gx - 2, gy - 2, 4, 4);
      }
    }

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    for (const o of objects) {
      const [x, y] = fromWorld([o.x, o.z]);
      const glyph = (OBJECT_PALETTE.find((p) => p.nam === o.nam) || {}).glyph || '📦';
      ctx.font = '20px sans-serif';
      ctx.fillText(glyph, x, y);
    }

    for (const sp of starts) {
      const [x, y] = fromWorld([sp.x, sp.z]);
      // Compass 0 = north = canvas -y
      const hx = Math.sin((sp.headingDeg || 0) * Math.PI / 180);
      const hy = -Math.cos((sp.headingDeg || 0) * Math.PI / 180);
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + hx * 16, y + hy * 16);
      ctx.stroke();
      ctx.font = '16px sans-serif';
      ctx.fillText('🛫', x, y);
    }
    ctx.lineWidth = 1;

    // Selection highlight (select mode).
    const it = itemAt(state, sel);
    if (it) {
      ctx.strokeStyle = '#4da3ff';
      ctx.lineWidth = 2;
      if (sel.kind === 'island') {
        const pts = (it.points || []).map(fromWorld);
        if (pts.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
          ctx.closePath();
          ctx.stroke();
        }
        ctx.fillStyle = '#4da3ff';
        for (const [x, y] of pts) ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
      } else if (sel.kind === 'runway') {
        const pts = runwayCorners(it, 60).map(fromWorld);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
        ctx.closePath();
        ctx.stroke();
      } else if (sel.kind === 'mountain') {
        const [x, y] = fromWorld([it.x, it.z]);
        ctx.beginPath();
        ctx.arc(x, y, (it.radiusM || 1500) * pxPerM, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const [x, y] = fromWorld([it.x, it.z]);
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }
  };

  seaIn.addEventListener('input', redraw);
  landIn.addEventListener('input', redraw);

  // ── pointer handlers ──────────────────────────────────────────────────────────

  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };

  canvas.addEventListener('pointerdown', (e) => {
    const p = pt(e);
    if (mode === 'draw') {
      canvas.setPointerCapture(e.pointerId);
      stroke = [p];
      return;
    }
    const [wx, wz] = toWorld(p);
    if (mode === 'select') {
      sel = hitTest(state, [wx, wz], 10 / pxPerM); // 10px click slop, in meters
      drag = sel ? { x: wx, z: wz, moved: false } : null;
      if (sel) canvas.setPointerCapture(e.pointerId);
      renderSelPanel();
      redraw();
      return;
    }
    pushUndo();
    if (mode === 'object') {
      objects.push({ nam: objSel.value, x: wx, z: wz, headingDeg: Number(objHead.value) || 0 });
    } else if (mode === 'mountain') {
      mountains.push({ x: wx, z: wz, radiusM: Number(mtRad.value) || 1500, heightM: Number(mtHt.value) || 300 });
    } else if (mode === 'runway') {
      runways.push({
        x: wx, z: wz, headingDeg: Number(rwHead.value) || 0,
        lengthM: Number(rwLen.value) || 2000, widthM: Number(rwWid.value) || 45,
        ils: rwIls || undefined, vaid: rwVaid,
      });
    } else if (mode === 'start') {
      starts.push({ x: wx, z: wz, altM: Number(stAlt.value) || 0, speedMS: Number(stSpd.value) || 0, headingDeg: Number(stHead.value) || 0 });
    }
    redraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (mode === 'select') {
      if (!drag || !sel) return;
      const [wx, wz] = toWorld(pt(e));
      if (!drag.moved) { pushUndo(); drag.moved = true; } // one undo step per drag
      moveSelected(state, sel, wx - drag.x, wz - drag.z);
      drag.x = wx; drag.z = wz;
      refreshSelValues();
      redraw();
      return;
    }
    if (!stroke) return;
    const p = pt(e);
    const last = stroke[stroke.length - 1];
    // 6px threshold matches islandCard — avoids excessive vertex density
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 6) { stroke.push(p); redraw(); }
  });

  const endStroke = () => {
    drag = null;
    if (stroke && stroke.length >= 3) { pushUndo(); islands.push({ points: stroke.map(toWorld) }); }
    stroke = null;
    redraw();
  };
  canvas.addEventListener('pointerup',     endStroke);
  canvas.addEventListener('pointercancel', () => { stroke = null; drag = null; redraw(); });

  // ── undo / clear ──────────────────────────────────────────────────────────────

  undoBtn.addEventListener('click', () => {
    popUndo();
    deselect(); // indices may have shifted; also redraws + panel
  });

  clearBtn.addEventListener('click', () => {
    pushUndo();
    for (const k of Object.keys(state)) state[k].length = 0;
    deselect();
  });

  // ── select mode: property panel + keyboard ───────────────────────────────────

  deselect = () => { sel = null; drag = null; renderSelPanel(); redraw(); };

  // Live-value inputs, refreshed during drags (skipped while being typed in).
  let selValueIns = []; // [{input, get}]
  const refreshSelValues = () => {
    for (const { input, get } of selValueIns) {
      if (document.activeElement !== input) input.value = String(get());
    }
  };

  // A numeric property field: pushes ONE undo snapshot per focus session, then
  // writes through live.
  const propIn = (get, set, { min, max, step = 1, w = 90 } = {}) => {
    const i = numIn(get(), min === undefined ? -WORLD_M : min, max === undefined ? WORLD_M : max, w);
    i.step = String(step);
    let armed = false;
    i.addEventListener('focus', () => { armed = true; });
    i.addEventListener('input', () => {
      if (i.value === '' || !Number.isFinite(Number(i.value))) return;
      if (armed) { pushUndo(); armed = false; }
      set(Number(i.value));
      redraw();
    });
    selValueIns.push({ input: i, get });
    return i;
  };

  function renderSelPanel() {
    selCtl.innerHTML = '';
    selValueIns = [];
    const it = itemAt(state, sel);
    if (!it) {
      selCtl.appendChild(clab(S.selNone));
      return;
    }
    selCtl.appendChild(clab(S.selKind[sel.kind]));
    if (sel.kind === 'island') {
      selCtl.appendChild(clab(S.selVerts((it.points || []).length)));
    } else {
      selCtl.appendChild(clab(S.selX));
      selCtl.appendChild(propIn(() => Math.round(it.x), (v) => { it.x = v; }));
      selCtl.appendChild(clab(S.selZ));
      selCtl.appendChild(propIn(() => Math.round(it.z), (v) => { it.z = v; }));
    }
    if (sel.kind === 'object') {
      const os = objSel.cloneNode(true);
      os.value = it.nam;
      os.addEventListener('change', () => { pushUndo(); it.nam = os.value; redraw(); });
      selCtl.appendChild(clab(S.objPick));
      selCtl.appendChild(os);
    }
    if (sel.kind === 'object' || sel.kind === 'start' || sel.kind === 'runway') {
      selCtl.appendChild(clab(S.headingDeg));
      selCtl.appendChild(propIn(() => Math.round(it.headingDeg || 0),
        (v) => setHeading(state, sel, v), { min: 0, max: 359, w: 70 }));
    }
    if (sel.kind === 'mountain') {
      selCtl.appendChild(clab(S.mtRadius));
      selCtl.appendChild(propIn(() => Math.round(it.radiusM || 1500), (v) => { it.radiusM = v; }, { min: 300, max: 6000 }));
      selCtl.appendChild(clab(S.mtHeight));
      selCtl.appendChild(propIn(() => Math.round(it.heightM || 300), (v) => { it.heightM = v; }, { min: 30, max: 2000 }));
    }
    if (sel.kind === 'start') {
      selCtl.appendChild(clab(S.stAlt));
      selCtl.appendChild(propIn(() => Math.round(it.altM || 0), (v) => { it.altM = v; }, { min: 0, max: 10000 }));
      selCtl.appendChild(clab(S.stSpeed));
      selCtl.appendChild(propIn(() => Math.round(it.speedMS || 0), (v) => { it.speedMS = v; }, { min: 0, max: 400, w: 80 }));
    }
    if (sel.kind === 'runway') {
      selCtl.appendChild(clab(S.rwLength));
      selCtl.appendChild(propIn(() => Math.round(it.lengthM || 2000), (v) => { it.lengthM = v; }, { min: 400, max: 6000 }));
      selCtl.appendChild(clab(S.rwWidth));
      selCtl.appendChild(propIn(() => Math.round(it.widthM || 45), (v) => { it.widthM = v; }, { min: 20, max: 120, w: 80 }));
      selCtl.appendChild(ilsCheck(() => it.ils, (v) => { pushUndo(); it.ils = v || undefined; redraw(); }));
      selCtl.appendChild(clab(S.rwVaid));
      selCtl.appendChild(vaidSel(() => it.vaid, (v) => { pushUndo(); it.vaid = v; redraw(); }));
    }
    const dupBtn = el('button', null, S.selDup);
    dupBtn.addEventListener('click', () => {
      pushUndo();
      sel = duplicateSelected(state, sel, 500, -500); // nudge SE so the copy is visible
      renderSelPanel();
      redraw();
    });
    const delBtn = el('button', null, S.selDel);
    delBtn.addEventListener('click', () => {
      pushUndo();
      deleteSelected(state, sel);
      deselect();
    });
    selCtl.appendChild(dupBtn);
    selCtl.appendChild(delBtn);
  }
  renderSelPanel();

  document.addEventListener('keydown', (e) => {
    if (mode !== 'select' || !sel) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      pushUndo();
      deleteSelected(state, sel);
      deselect();
    } else if (e.key === 'Escape') {
      deselect();
    }
  });

  // ── save ──────────────────────────────────────────────────────────────────────

  const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgb2hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    saveMsg.textContent = S.working;
    try {
      const scenery = {
        conv: 2, // headingDeg fields are compass degrees (see migrateScenery)
        name: nameIn.value.trim(),
        ground: hex2rgb(seaIn.value),
        sky:    hex2rgb(skyIn.value),
        land:   hex2rgb(landIn.value),
        startAltM: Math.max(100, Number(altIn.value) || 1000),
        islands:   islands.map((i) => ({ ...i, points: (i.points || []).map(([x, z]) => [x, z]) })),
        objects:   objects.map((o) => ({ ...o })),
        mountains: mountains.map((m) => ({ ...m })),
        starts:    starts.map((s) => ({ ...s })),
        runways:   runways.map((r) => ({ ...r })),
      };
      const asm = assembleSceneryZip({ ...scenery, recipe: { scenery } });
      const res = await saveOrReplace(asm.zipBytes, asm.packName, editingId);
      editingId = res.id; // further saves replace this creation

      saveMsg.textContent = S.isDone(asm.ident, islands.length);

      // Build / rebuild the test-fly row with up to 20 stock identities.
      flyRow.innerHTML = '';
      flyRow.style.display = '';
      const stock   = await stockIndex();
      const allIds  = [DEFAULT_FLY_AIRCRAFT, ...stock.map((a) => a.identify).filter((id) => id !== DEFAULT_FLY_AIRCRAFT)];
      const flySel  = document.createElement('select');
      flySel.style.cssText = 'flex:1;min-width:0;padding:6px 9px;border:1px solid #2a3647;border-radius:6px;background:#0b1017;color:#e6edf3;font-size:13px';
      for (const id of allIds.slice(0, 20)) {
        flySel.appendChild(Object.assign(el('option'), { value: id, textContent: id }));
      }
      const flyWrap = el('div', 'row');
      flyWrap.style.margin = '0';
      flyWrap.appendChild(el('span', 'lab', S.flyWhat));
      flyWrap.appendChild(flySel);
      const flyBtn = el('button', 'accent', S.fly(asm.ident));
      flyBtn.addEventListener('click', () => { location.href = flyUrl(flySel.value, asm.ident, SCENERY_START); });
      flyRow.appendChild(flyWrap);
      flyRow.appendChild(flyBtn);
    } catch (e) {
      saveMsg.textContent = S.errorPrefix + ((e && e.message) || e);
    }
    goBtn.disabled = false;
  });

  // ── edit on boot (?edit=<id>) ─────────────────────────────────────────────────

  const editId = new URLSearchParams(location.search).get('edit');
  if (editId) {
    const c = await loadCreation(editId);
    if (c && c.recipe) {
      if (c.recipe.type !== 'scenery') {
        // Wrong studio — redirect without history entry.  Aircraft recipes
        // carry no type field; pack recipes say 'pack'.
        location.replace(pageUrl(c.recipe.type === 'pack' ? 'studio-pack.html' : 'studio-aircraft.html', { edit: editId }));
        return;
      }
      if (c.recipe.type === 'scenery') {
        // Legacy (pre-conv-2) recipes stored headings in engine attitude sign;
        // migrate so the editor state is compass and recompiles identically.
        const sc = migrateScenery(c.recipe.scenery || {});
        nameIn.value = sc.name || c.name || '';
        if (sc.ground) seaIn.value = rgb2hex(sc.ground);
        if (sc.sky)    skyIn.value  = rgb2hex(sc.sky);
        if (sc.land)   landIn.value = rgb2hex(sc.land);
        if (sc.startAltM) altIn.value = String(sc.startAltM);
        islands.length   = 0;
        for (const isl of sc.islands   || []) islands.push({ ...isl, points: (isl.points || []).map(([x, z]) => [x, z]) });
        objects.length   = 0;
        for (const o of sc.objects     || []) objects.push({ ...o });
        mountains.length = 0;
        for (const m of sc.mountains   || []) mountains.push({ ...m });
        starts.length    = 0;
        for (const sp of sc.starts     || []) starts.push({ ...sp });
        runways.length   = 0;
        for (const rw of sc.runways    || []) runways.push({ ...rw });
        undoStack.length = 0; // undo history does not survive a re-open
        editingId = editId;
        editBadge.textContent = S.libEditingBadge(c.name || editId);
      }
    }
  }

  redraw();

  // Smoke hook — set only after async boot completes.
  window.ysfwStudio = {
    ready: true,
    page: 'scenery',
    counts: () => ({ islands: islands.length, objects: objects.length, mountains: mountains.length, starts: starts.length, runways: runways.length }),
    selection: () => (sel ? { ...sel } : null),
  };
}

main();
