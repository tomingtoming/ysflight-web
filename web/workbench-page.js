// The dedicated workbench page (workbench.html): an engine-less creation space.
//
// Everything made here is installed as an OPFS pack record ONLY — no engine FS,
// no wasm.  The game page enumerates OPFS records at boot (materializeEnabled in
// packs-ui.js) and materializes them, so a pack created here simply exists the
// next time the game loads.  "Fly" buttons navigate to index.html?freeflight=…
//
// Stock aircraft for the .dat wizard come from dist/stock/ (index.json + the
// .dat files), staged statically at build time (scripts/gen-stock-index.mjs) —
// which is what lets this page skip the 25MB engine preload entirely.

import {
  classifyLoose, assembleAircraftZip,
  makeDatFromBase, assembleSceneryZip, SCENERY_START,
} from './workbench.js';
import { analyzePackStreaming, MAX_PACK_BYTES } from './packs.js';
import * as opfs from './opfs-store.js';

const ACCENT = '#4da3ff';
const DEFAULT_FLY_AIRCRAFT = 'F-15C_EAGLE';
const WORLD_M = 16000; // the island canvas spans a 16km x 16km sea

const LANG = (function () {
  try {
    const l = String((new URLSearchParams(location.search).get('lang')) || navigator.language || 'en').toLowerCase();
    return l.indexOf('ja') === 0 ? 'ja' : 'en';
  } catch (e) { return 'en'; }
})();
const S = ({
  ja: {
    title: '🛠 ワークベンチ',
    sub: '機体とマップを作る場所。作ったものは自動で保存され、ゲームを開くと使えます。',
    backToGame: '← ゲームへ戻る',
    errorPrefix: 'エラー: ',
    working: '作業中…',
    // aircraft
    acTitle: '✈️ 機体を組む',
    acIntro: 'モデラーで作った .dnm / .srf と、飛行特性 .dat を1機に組み立てます。.dat が無ければ下の「stockから作る」で。',
    acDrop: '機体のファイル (.dat / .dnm / .srf) をドロップ / クリックして選択',
    slotDat: '飛行特性 (.dat) ※必須',
    slotVisual: '外観モデル (.dnm) ※必須',
    slotColl: '当たり判定 (.srf) ※必須',
    slotCockpit: 'コックピット (.srf)',
    slotCoarse: '遠景モデル (.dnm)',
    packName: 'パック名',
    none: '（なし）',
    assemble: '組み立てて取り込む',
    acDone: (n) => '✓ 機体パック「' + n + '」を保存しました',
    warn: {
      'coarse-needs-cockpit': '⚠ 遠景モデルは外しました（コックピット指定がないと使えません）',
      'no-ascii-identify': '⚠ .dat に ASCII の IDENTIFY がありません（テスト飛行ボタンで名前指定できません）',
    },
    errMap: {
      NO_DAT: '飛行特性 (.dat) を割り当ててください（下の「stockから作る」でも作れます）',
      NO_VISUAL: '外観モデル (.dnm) を割り当ててください',
      NO_COLLISION: '当たり判定 (.srf) を割り当ててください',
    },
    ignored: (names) => '— 対象外: ' + names.join(', '),
    fly: (n) => '🛫 ' + n + ' で飛ぶ',
    // dat wizard
    datTitle: '✏️ 飛行特性 (.dat) を stock から作る',
    datIntro: '元になる機体を選んで、名前を付けて、性能を倍率でいじれます。できた .dat は上の機体組み立てに入ります。',
    datBase: '元になる機体',
    datName: '新しい機体名（英数字）',
    knobs: { engine: 'エンジン出力', weight: '機体の重さ', speed: '最高速度', agility: '操縦の鋭さ' },
    datUse: 'この .dat を使う',
    datGenerated: (n) => '（生成）' + n + '.dat',
    datSet: (n) => '✓ ' + n + ' を機体組み立ての .dat スロットに入れました',
    datNeedName: '新しい機体名を入れてください',
    datDup: '⚠ その名前は既存の機体と重複しています（別名を推奨）',
    // island
    isTitle: '🏝 マップを描く',
    isIntro: 'ドラッグで海岸線を描くと島になります（何個でも）。島は本物の陸地＝降りられます。マップは16km四方。',
    isName: 'マップ名（英数字）',
    isSea: '海の色', isSky: '空の色', isLand: '島の色',
    isAlt: '開始高度 (m)',
    isUndo: '↩ 島を1つ消す', isClear: '全部消す',
    isMake: 'マップを保存する',
    isDone: (n, k) => '✓ マップ「' + n + '」（島 ' + k + ' 個）を保存しました',
    isEmptyOk: '（島ゼロでも保存できます＝ただの海）',
    flyWhat: 'テスト飛行の機体',
  },
  en: {
    title: '🛠 Workbench',
    sub: 'The place to build aircraft and maps. Everything saves automatically and is available next time the game loads.',
    backToGame: '← Back to the game',
    errorPrefix: 'Error: ',
    working: 'Working…',
    acTitle: '✈️ Assemble an aircraft',
    acIntro: 'Combine your modeler-made .dnm / .srf with a flight-model .dat. No .dat? Make one below from a stock base.',
    acDrop: 'Drop aircraft files (.dat / .dnm / .srf) / click to choose',
    slotDat: 'Flight model (.dat) — required',
    slotVisual: 'Visual model (.dnm) — required',
    slotColl: 'Collision shell (.srf) — required',
    slotCockpit: 'Cockpit (.srf)',
    slotCoarse: 'Coarse/LOD model (.dnm)',
    packName: 'Pack name',
    none: '(none)',
    assemble: 'Assemble & save',
    acDone: (n) => '✓ Saved aircraft pack “' + n + '”',
    warn: {
      'coarse-needs-cockpit': '⚠ Coarse model dropped (needs a cockpit assigned)',
      'no-ascii-identify': '⚠ No ASCII IDENTIFY in the .dat — the test-fly button can’t name this aircraft',
    },
    errMap: {
      NO_DAT: 'Assign a flight model (.dat) — or make one below from a stock base',
      NO_VISUAL: 'Assign a visual model (.dnm)',
      NO_COLLISION: 'Assign a collision shell (.srf)',
    },
    ignored: (names) => '— not usable: ' + names.join(', '),
    fly: (n) => '🛫 Fly ' + n,
    datTitle: '✏️ Make a flight model (.dat) from stock',
    datIntro: 'Pick a base aircraft, name yours, scale its performance. The result feeds the assembly above.',
    datBase: 'Base aircraft',
    datName: 'New aircraft name (ASCII)',
    knobs: { engine: 'Engine power', weight: 'Weight', speed: 'Top speed', agility: 'Handling sharpness' },
    datUse: 'Use this .dat',
    datGenerated: (n) => '(generated) ' + n + '.dat',
    datSet: (n) => '✓ Placed ' + n + ' into the assembly’s .dat slot',
    datNeedName: 'Enter a new aircraft name',
    datDup: '⚠ That name clashes with an existing aircraft (pick another)',
    isTitle: '🏝 Draw a map',
    isIntro: 'Drag to draw coastlines — each stroke becomes an island (as many as you like). Islands are real, landable ground. The map is 16km across.',
    isName: 'Map name (ASCII)',
    isSea: 'Sea color', isSky: 'Sky color', isLand: 'Island color',
    isAlt: 'Start altitude (m)',
    isUndo: '↩ Remove last island', isClear: 'Clear all',
    isMake: 'Save the map',
    isDone: (n, k) => '✓ Saved map “' + n + '” (' + k + ' island' + (k === 1 ? '' : 's') + ')',
    isEmptyOk: '(Zero islands is fine too — plain sea)',
    flyWhat: 'Test-fly aircraft',
  },
})[LANG];

// --- OPFS-only install ----------------------------------------------------------

async function webSha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Install a pack zip as an OPFS record (blobs + record; no engine FS).  The
// game page materializes every enabled record at boot, so this IS an install.
async function installZip(bytes, name) {
  let a = null, recordWritten = false;
  try {
    a = await analyzePackStreaming(bytes, {
      sha256: webSha256, putBlob: opfs.putBlob, name,
      maxPackBytes: MAX_PACK_BYTES, maxFileBytes: MAX_PACK_BYTES,
    });
    await opfs.putRecordFromAnalysis(a, { enabled: true });
    recordWritten = true;
  } catch (e) {
    if (recordWritten && a) { try { await opfs.removeRecord(a.id); } catch (_) {} }
    try { await opfs.gc(); } catch (_) {}
    throw e;
  }
  return {
    id: a.id, name: a.name, categories: a.categories, bytes: a.total,
    templates: a.generated.filter((g) => !g.idx).reduce((n, g) => n + g.entries, 0),
    diagnostics: a.diagnostics,
  };
}

// Aircraft identities already taken (stock + installed packs) for the dup check.
async function knownIdentities() {
  const known = new Set((await stockIndex()).map((a) => a.identify));
  for (const rec of await opfs.listRecords()) {
    for (const g of rec.generated || []) {
      if (!/^aircraft\/.*\.lst\.idx$/.test(g.file)) continue;
      for (const line of (g.text || '').split('\n')) {
        const t = line.split('\t');
        if (t.length >= 2 && t[1]) known.add(t[1]);
      }
    }
  }
  return known;
}

let stockCache = null;
async function stockIndex() {
  if (stockCache) return stockCache;
  try {
    const r = await fetch('./stock/index.json');
    stockCache = r.ok ? await r.json() : [];
  } catch (e) { stockCache = []; }
  return stockCache;
}

const flyUrl = (air, field, start) => {
  const p = new URLSearchParams();
  p.set('freeflight', [air, field, start].filter(Boolean).join(','));
  if (new URLSearchParams(location.search).get('lang')) p.set('lang', LANG);
  return './index.html?' + p.toString();
};

// --- page ------------------------------------------------------------------------

const app = document.getElementById('app');
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const row = (parent, label, input) => {
  const r = el('div', 'row');
  r.appendChild(el('span', 'lab', label));
  r.appendChild(input);
  parent.appendChild(r);
  return input;
};

function header() {
  const top = el('div', 'top');
  const left = el('div');
  left.appendChild(el('h1', null, S.title));
  const back = el('a', null, S.backToGame);
  back.href = './index.html' + (LANG === 'ja' ? '' : '?lang=' + LANG);
  top.appendChild(left);
  top.appendChild(back);
  app.appendChild(top);
  app.appendChild(el('p', 'sub', S.sub));
}

// --- aircraft assembly card --------------------------------------------------------

let acSetGeneratedDat = null; // hook the dat wizard uses to feed the assembly

function aircraftCard() {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, S.acTitle));
  card.appendChild(el('p', 'intro', S.acIntro));

  const drop = el('label', 'drop', S.acDrop);
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.dat,.dnm,.srf';
  input.multiple = true;
  input.style.display = 'none';
  drop.appendChild(input);
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hot'); }));
  card.appendChild(drop);

  const slotsBox = el('div');
  slotsBox.style.marginTop = '10px';
  card.appendChild(slotsBox);
  const msg = el('div', 'msg');
  const btnRow = el('div', 'btnrow');
  card.appendChild(msg);
  card.appendChild(btnRow);

  let entries = [];       // [{name, bytes}] accumulated loose files
  let generatedDat = null;
  let sels = null;

  const rebuildSlots = () => {
    slotsBox.innerHTML = '';
    btnRow.innerHTML = '';
    const { candidates, guess, ignored } = classifyLoose(entries);
    const byName = new Map(entries.map((e) => [e.name.split(/[\\/]/).pop(), e]));
    const mkSel = (label, cands, preselect, required, extraOpt) => {
      const sel = document.createElement('select');
      if (!required) sel.appendChild(Object.assign(el('option'), { value: '', textContent: S.none }));
      for (const c of cands) sel.appendChild(Object.assign(el('option'), { value: c.name, textContent: c.name }));
      if (extraOpt) sel.appendChild(extraOpt);
      sel.value = preselect || (required ? (cands[0] && cands[0].name) || '' : '');
      return row(slotsBox, label, sel);
    };
    const genOpt = generatedDat
      ? Object.assign(el('option'), { value: '@generated', textContent: S.datGenerated(generatedDat.identify) })
      : null;
    sels = {
      dat: mkSel(S.slotDat, candidates.dat, generatedDat ? '@generated' : guess.dat, true, genOpt),
      visual: mkSel(S.slotVisual, candidates.dnm, guess.visual, true),
      collision: mkSel(S.slotColl, candidates.srf, guess.collision, true),
      cockpit: mkSel(S.slotCockpit, candidates.srf, guess.cockpit, false),
      coarse: mkSel(S.slotCoarse, candidates.dnm, guess.coarse, false),
    };
    if (generatedDat) sels.dat.value = '@generated';
    const nameIn = Object.assign(document.createElement('input'), { type: 'text', placeholder: (guess.dat || (generatedDat && generatedDat.identify) || '').replace(/\.dat$/i, '') });
    row(slotsBox, S.packName, nameIn);
    if (ignored.length) msg.textContent = S.ignored(ignored);

    const goBtn = el('button', 'accent', S.assemble);
    goBtn.addEventListener('click', async () => {
      goBtn.disabled = true;
      msg.textContent = S.working;
      try {
        const pick = (sel) => (sel.value === '@generated' ? generatedDat : sel.value ? byName.get(sel.value) : null);
        const asm = assembleAircraftZip({
          name: nameIn.value.trim() || undefined,
          dat: pick(sels.dat), visual: pick(sels.visual), collision: pick(sels.collision),
          cockpit: pick(sels.cockpit), coarse: pick(sels.coarse),
        });
        const res = await installZip(asm.zipBytes, asm.packName);
        const lines = [S.acDone(asm.packName)];
        for (const w of asm.warnings) if (S.warn[w]) lines.push(S.warn[w]);
        msg.textContent = lines.join('\n');
        if (asm.identify) {
          const fly = el('button', 'accent', S.fly(asm.identify));
          fly.addEventListener('click', () => { location.href = flyUrl(asm.identify); });
          btnRow.innerHTML = '';
          btnRow.appendChild(fly);
        }
        lastAircraftIdentify = asm.identify || lastAircraftIdentify;
        void res;
      } catch (e) {
        const m = (e && e.message) || String(e);
        const friendly = /missing \.dat/.test(m) ? S.errMap.NO_DAT
          : /missing visual/.test(m) ? S.errMap.NO_VISUAL
          : /missing collision/.test(m) ? S.errMap.NO_COLLISION : m;
        msg.textContent = S.errorPrefix + friendly;
      } finally {
        goBtn.disabled = false;
      }
    });
    btnRow.appendChild(goBtn);
  };

  const addFiles = async (fileList) => {
    for (const f of Array.from(fileList)) {
      if (!/\.(dat|dnm|srf)$/i.test(f.name)) continue;
      entries = entries.filter((e) => e.name !== f.name);
      entries.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    rebuildSlots();
  };
  input.addEventListener('change', () => addFiles(input.files));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });

  acSetGeneratedDat = (dat) => { generatedDat = dat; rebuildSlots(); };
  app.appendChild(card);
}

let lastAircraftIdentify = null;

// --- dat wizard card ---------------------------------------------------------------

async function datCard() {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, S.datTitle));
  card.appendChild(el('p', 'intro', S.datIntro));

  const stock = await stockIndex();
  const baseSel = document.createElement('select');
  for (const a of stock) baseSel.appendChild(Object.assign(el('option'), { value: a.file, textContent: a.identify }));
  row(card, S.datBase, baseSel);
  const nameIn = Object.assign(document.createElement('input'), { type: 'text' });
  row(card, S.datName, nameIn);

  const knobs = {};
  for (const k of ['engine', 'weight', 'speed', 'agility']) {
    const wrap = el('div');
    wrap.style.cssText = 'flex:1;display:flex;align-items:center;gap:8px;min-width:0';
    const slider = Object.assign(document.createElement('input'), { type: 'range', min: '0.5', max: '3', step: '0.1', value: '1' });
    slider.style.cssText = 'flex:1;min-width:0';
    const val = el('span', 'val', '×1.0');
    slider.addEventListener('input', () => { val.textContent = '×' + Number(slider.value).toFixed(1); });
    wrap.appendChild(slider);
    wrap.appendChild(val);
    row(card, S.knobs[k], wrap);
    knobs[k] = slider;
  }

  const msg = el('div', 'msg');
  card.appendChild(msg);
  const btnRow = el('div', 'btnrow');
  const useBtn = el('button', 'accent', S.datUse);
  useBtn.addEventListener('click', async () => {
    const name = nameIn.value.trim();
    if (!name) { msg.textContent = S.datNeedName; return; }
    useBtn.disabled = true;
    try {
      const r = await fetch('./stock/' + baseSel.value);
      if (!r.ok) throw new Error('stock fetch: HTTP ' + r.status);
      const dat = makeDatFromBase(new Uint8Array(await r.arrayBuffer()), {
        identify: name,
        knobs: Object.fromEntries(Object.entries(knobs).map(([k, s]) => [k, Number(s.value)])),
      });
      const lines = [S.datSet(dat.identify)];
      if ((await knownIdentities()).has(dat.identify)) lines.push(S.datDup);
      msg.textContent = lines.join('\n');
      acSetGeneratedDat({ name: dat.identify.toLowerCase() + '.dat', bytes: dat.bytes, identify: dat.identify });
    } catch (e) {
      msg.textContent = S.errorPrefix + ((e && e.message) || e);
    } finally {
      useBtn.disabled = false;
    }
  });
  btnRow.appendChild(useBtn);
  card.appendChild(btnRow);
  app.appendChild(card);
}

// --- island drawing card --------------------------------------------------------------

function islandCard() {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, S.isTitle));
  card.appendChild(el('p', 'intro', S.isIntro));

  const nameIn = row(card, S.isName, Object.assign(document.createElement('input'), { type: 'text' }));
  const seaIn = row(card, S.isSea, Object.assign(document.createElement('input'), { type: 'color', value: '#0d3a66' }));
  const skyIn = row(card, S.isSky, Object.assign(document.createElement('input'), { type: 'color', value: '#176abd' }));
  const landIn = row(card, S.isLand, Object.assign(document.createElement('input'), { type: 'color', value: '#3c8c50' }));
  const altIn = row(card, S.isAlt, Object.assign(document.createElement('input'), { type: 'number', value: '1000', min: '100', max: '10000' }));

  const canvas = document.createElement('canvas');
  canvas.id = 'island-canvas';
  canvas.width = 640;
  canvas.height = 640;
  card.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const polygons = []; // in canvas px: [[x,y],...]
  let stroke = null;

  const redraw = () => {
    ctx.fillStyle = seaIn.value;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    for (const poly of polygons.concat(stroke && stroke.length >= 3 ? [stroke] : [])) {
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (const [x, y] of poly.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fillStyle = landIn.value;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      ctx.stroke();
    }
  };
  seaIn.addEventListener('input', redraw);
  landIn.addEventListener('input', redraw);

  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    stroke = [pt(e)];
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const p = pt(e);
    const last = stroke[stroke.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 6) { stroke.push(p); redraw(); }
  });
  const endStroke = () => {
    if (stroke && stroke.length >= 3) polygons.push(stroke);
    stroke = null;
    redraw();
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', () => { stroke = null; redraw(); });

  const tools = el('div', 'btnrow');
  tools.style.justifyContent = 'flex-start';
  const undoBtn = el('button', null, S.isUndo);
  undoBtn.addEventListener('click', () => { polygons.pop(); redraw(); });
  const clearBtn = el('button', null, S.isClear);
  clearBtn.addEventListener('click', () => { polygons.length = 0; redraw(); });
  tools.appendChild(undoBtn);
  tools.appendChild(clearBtn);
  card.appendChild(tools);

  const msg = el('div', 'msg', S.isEmptyOk);
  card.appendChild(msg);
  const btnRow = el('div', 'btnrow');
  const goBtn = el('button', 'accent', S.isMake);
  const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const toWorld = ([x, y]) => [
    (x / canvas.width - 0.5) * WORLD_M,   // X = east
    (y / canvas.height - 0.5) * WORLD_M,  // canvas down = Z = south
  ];
  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    msg.textContent = S.working;
    try {
      const asm = assembleSceneryZip({
        name: nameIn.value.trim(),
        ground: hex2rgb(seaIn.value),
        sky: hex2rgb(skyIn.value),
        land: hex2rgb(landIn.value),
        startAltM: Math.max(100, Number(altIn.value) || 1000),
        islands: polygons.map((poly) => ({ points: poly.map(toWorld) })),
      });
      await installZip(asm.zipBytes, asm.packName);
      msg.textContent = S.isDone(asm.ident, polygons.length);
      btnRow.innerHTML = '';
      const flySel = document.createElement('select');
      const opts = [lastAircraftIdentify, DEFAULT_FLY_AIRCRAFT].filter(Boolean);
      for (const o of [...new Set(opts)]) flySel.appendChild(Object.assign(el('option'), { value: o, textContent: o }));
      const flyWrap = el('div', 'row');
      flyWrap.style.margin = '0';
      flyWrap.appendChild(el('span', 'lab', S.flyWhat));
      flyWrap.appendChild(flySel);
      const fly = el('button', 'accent', S.fly(asm.ident));
      fly.addEventListener('click', () => { location.href = flyUrl(flySel.value, asm.ident, SCENERY_START); });
      btnRow.appendChild(flyWrap);
      btnRow.appendChild(fly);
    } catch (e) {
      msg.textContent = S.errorPrefix + ((e && e.message) || e);
      goBtn.disabled = false;
    }
  });
  btnRow.appendChild(goBtn);
  card.appendChild(btnRow);
  app.appendChild(card);
  redraw();
}

// --- boot -------------------------------------------------------------------------

async function main() {
  try { await navigator.storage.persist(); } catch (e) { /* best effort */ }
  header();
  aircraftCard();
  await datCard();
  islandCard();
  // Driven by the smoke test (and handy in the console).
  window.ysfwWorkbench = {
    ready: true,
    installZip,
    listStock: stockIndex,
    makeDat: async (file, identify, knobs) => {
      const r = await fetch('./stock/' + file);
      if (!r.ok) throw new Error('stock fetch: HTTP ' + r.status);
      return makeDatFromBase(new Uint8Array(await r.arrayBuffer()), { identify, knobs });
    },
    assembleInstall: async (slots) => {
      const asm = assembleAircraftZip(slots);
      const res = await installZip(asm.zipBytes, asm.packName);
      return { ...res, identify: asm.identify, warnings: asm.warnings, packName: asm.packName };
    },
    createScenery: async (opts) => {
      const asm = assembleSceneryZip(opts);
      const res = await installZip(asm.zipBytes, asm.packName);
      return { ...res, ident: asm.ident, start: SCENERY_START };
    },
  };
}
main();
