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
  makeDatFromBase, assembleSceneryZip, SCENERY_START, RECIPE_FILE,
} from './workbench.js';
import { analyzePackStreaming, MAX_PACK_BYTES } from './packs.js';
import * as opfs from './opfs-store.js';
import { listStaged, getStaged, removeStaged, putStaged } from './staging.js';

const ACCENT = '#4da3ff';
const DEFAULT_FLY_AIRCRAFT = 'F-15C_EAGLE';
const WORLD_M = 16000; // the island canvas spans a 16km x 16km sea

// Curated stock ground objects for the map editor (NAM = the .dat IDENTIFY the
// engine's preloaded ground templates register under; all 108 always link).
const OBJECT_PALETTE = [
  { nam: 'AIRCRAFTCARRIER', ja: '空母（着艦/発艦可）', en: 'Carrier (land/launch!)', glyph: '🚢' },
  { nam: 'ELEVATED_RUNWAY_1000X60', ja: '滑走路（高架 1km）', en: 'Runway (elevated 1km)', glyph: '🛬' },
  { nam: 'ISLAND_BASE', ja: '島基地（ILS付き）', en: 'Island base (ILS)', glyph: '🏝' },
  { nam: 'HMS_INVINCIBLE', ja: '軽空母', en: 'Light carrier', glyph: '⚓' },
  { nam: 'BIGBEN', ja: 'ビッグベン', en: 'Big Ben', glyph: '🕰' },
  { nam: 'CASTLE', ja: '城', en: 'Castle', glyph: '🏰' },
  { nam: 'PALACE', ja: '宮殿', en: 'Palace', glyph: '🏛' },
  { nam: 'BRIDGE1', ja: '橋', en: 'Bridge', glyph: '🌉' },
  { nam: 'HANGAR1', ja: '格納庫', en: 'Hangar', glyph: '🏬' },
  { nam: 'TERMINAL', ja: '空港ターミナル', en: 'Terminal', glyph: '🏢' },
  { nam: 'POWER_PLANT', ja: '発電所', en: 'Power plant', glyph: '🏭' },
  { nam: 'TREES_400M_20M', ja: '森', en: 'Forest', glyph: '🌲' },
  { nam: 'TREE1', ja: '木', en: 'Tree', glyph: '🌳' },
  { nam: 'ELEPHANT', ja: '象', en: 'Elephant', glyph: '🐘' },
  { nam: 'JEEP', ja: 'ジープ', en: 'Jeep', glyph: '🚙' },
  { nam: 'M1A1ABRAMS', ja: '戦車', en: 'Tank', glyph: '🛡' },
  { nam: 'SAM', ja: '対空ミサイル（撃ってくる）', en: 'SAM (it shoots!)', glyph: '🚀' },
  { nam: 'VOR', ja: 'VORビーコン', en: 'VOR beacon', glyph: '📡' },
];

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
    stagedTitle: '🧊 モデラから届いたファイル',
    stagedHint: 'Polygon Crest（3Dモデラ）で保存したファイルは自動でここに届きます',
    stagedAdd: '追加',
    stagedAddTitle: '機体組み立てのファイルに加える',
    stagedEmpty: '（まだありません — 🧊 でモデルを作って保存すると届きます）',
    stagedAdded: (n) => '✓ ' + n + ' を組み立てに追加しました',
    stagedDl: '⬇', stagedDlTitle: 'ダウンロード（手元に保存）',
    stagedSend: '＋ ファイルを送る',
    stagedSendTitle: '手持ちの .srf/.dnm/.dat をモデラと組み立ての共有領域に入れる',
    stagedSent: (n) => '✓ ' + n + ' 件を送りました（モデラでは次回起動時に File→Open で見えます）',
    libModeler: '🧊', libModelerTitle: 'この機体のモデルをモデラに送る（次回起動の File→Open で開けます）',
    libModelerSent: (n) => '✓ モデルを ' + n + ' 件モデラに送りました。🧊 を開くと File→Open で見えます',
    modelerLink: '🧊 3Dモデラを開く（Polygon Crest）',
    modelerLinkTitle: 'YSFLIGHT公式の3Dモデルエディタ（実験版）。保存したモデルはここに届きます',
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
    // creations library
    libTitle: '📦 マイ作品',
    libIntro: 'このワークベンチで作った物だけが並びます（zipで取り込んだパックの管理はゲーム側の「追加パック」で）。✏️ で続きから編集できます',
    libEmpty: '（まだ何もありません — 下で作りましょう）',
    libKind: { aircraft: '✈️', scenery: '🏝', mixed: '📦', other: '📦' },
    libOn: '有効', libOff: '無効',
    libFly: '🛫', libFlyTitle: 'テスト飛行（ゲームページに移動します）',
    libEdit: '✏️', libEditTitle: '続きから編集',
    libDel: '🗑', libDelTitle: '削除',
    libDelConfirm: (n) => '「' + n + '」を削除しますか？',
    libUpdated: (n) => '✓ 「' + n + '」を更新しました（前の版は置き換え）',
    libEditingBadge: (n) => '✏️ 編集中: ' + n,
    // island
    isTitle: '🏝 マップを描く',
    isIntro: 'ドラッグで海岸線を描くと島になります（何個でも）。島は本物の陸地＝降りられます。マップは16km四方。',
    isName: 'マップ名（英数字）',
    isSea: '海の色', isSky: '空の色', isLand: '島の色',
    isAlt: '開始高度 (m)',
    isUndo: '↩ 1つ戻す', isClear: '全部消す',
    isMake: 'マップを保存する',
    modeDraw: '✏️ 島を描く',
    modeObject: '🚢 置き物',
    modeMountain: '⛰ 山',
    modeStart: '🛫 スタート',
    modeHint: {
      draw: 'ドラッグで海岸線を描くと島になります',
      object: '置きたい物を選んでクリックで配置（空母は本当に着艦・発艦できます）',
      mountain: 'クリックで山を置きます（なだらかな本物の地形＝緩い斜面には着陸もできます）',
      start: 'クリックで開始地点を置きます（低高度・速度0なら降着装置が下りた状態で始まります）',
    },
    objPick: '置く物',
    headingDeg: '向き (°)',
    mtRadius: '山の半径 (m)',
    mtHeight: '山の高さ (m)',
    stAlt: '開始高度 (m)',
    stSpeed: '開始速度 (m/s)',
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
    stagedTitle: '🧊 From the modeler',
    stagedHint: 'Files you save in Polygon Crest (the 3D modeler) arrive here automatically',
    stagedAdd: 'Add',
    stagedAddTitle: 'Add to the aircraft assembly files',
    stagedEmpty: '(Nothing yet — make and save a model in 🧊 and it lands here)',
    stagedAdded: (n) => '✓ Added ' + n + ' to the assembly',
    stagedDl: '⬇', stagedDlTitle: 'Download a copy',
    stagedSend: '＋ Send a file',
    stagedSendTitle: 'Put your own .srf/.dnm/.dat into the shared modeler/assembly area',
    stagedSent: (n) => '✓ Sent ' + n + ' file(s) (visible in the modeler’s File→Open on its next start)',
    libModeler: '🧊', libModelerTitle: 'Send this aircraft’s model to the modeler (File→Open on its next start)',
    libModelerSent: (n) => '✓ Sent ' + n + ' model file(s) to the modeler — open 🧊 and use File→Open',
    modelerLink: '🧊 Open the 3D modeler (Polygon Crest)',
    modelerLinkTitle: 'YSFLIGHT’s official model editor (experimental). Saved models arrive here',
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
    libTitle: '📦 My creations',
    libIntro: 'Only things MADE in this workbench appear here (imported zip packs are managed in the game’s add-on panel). ✏️ re-opens an item for further editing',
    libEmpty: '(Nothing yet — make something below)',
    libKind: { aircraft: '✈️', scenery: '🏝', mixed: '📦', other: '📦' },
    libOn: 'On', libOff: 'Off',
    libFly: '🛫', libFlyTitle: 'Test-fly (moves to the game page)',
    libEdit: '✏️', libEditTitle: 'Continue editing',
    libDel: '🗑', libDelTitle: 'Delete',
    libDelConfirm: (n) => 'Delete “' + n + '”?',
    libUpdated: (n) => '✓ Updated “' + n + '” (previous version replaced)',
    libEditingBadge: (n) => '✏️ Editing: ' + n,
    isTitle: '🏝 Draw a map',
    isIntro: 'Drag to draw coastlines — each stroke becomes an island (as many as you like). Islands are real, landable ground. The map is 16km across.',
    isName: 'Map name (ASCII)',
    isSea: 'Sea color', isSky: 'Sky color', isLand: 'Island color',
    isAlt: 'Start altitude (m)',
    isUndo: '↩ Undo', isClear: 'Clear all',
    isMake: 'Save the map',
    modeDraw: '✏️ Draw islands',
    modeObject: '🚢 Objects',
    modeMountain: '⛰ Mountains',
    modeStart: '🛫 Starts',
    modeHint: {
      draw: 'Drag to draw coastlines — each stroke becomes an island',
      object: 'Pick something and click to place it (the carrier really works for landing/launching)',
      mountain: 'Click to place a mountain (real terrain — gentle slopes are landable)',
      start: 'Click to place a spawn point (low + slow starts with gear down)',
    },
    objPick: 'Object',
    headingDeg: 'Heading (°)',
    mtRadius: 'Mountain radius (m)',
    mtHeight: 'Mountain height (m)',
    stAlt: 'Start altitude (m)',
    stSpeed: 'Start speed (m/s)',
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

// Save with replace semantics: when re-editing an existing creation, the new
// content-hash id replaces the old record (same id = no-op, content unchanged).
async function saveOrReplace(zipBytes, name, replaceId) {
  const res = await installZip(zipBytes, name);
  if (replaceId && replaceId !== res.id) {
    try { await opfs.removeRecord(replaceId); await opfs.gc(); } catch (e) { /* old version lingers; harmless */ }
  }
  return res;
}

// The creations-library view: ONLY workbench-made packs (the ones carrying an
// embedded workbench.json recipe).  Imported zips are inventory, not creations
// — they live in the game page's pack panel, not here.
async function listCreations() {
  const out = [];
  for (const rec of await opfs.listRecords()) {
    if (!((rec.files || []).some((f) => f.path === RECIPE_FILE))) continue;
    const cats = rec.categories || [];
    const kind = cats.length > 1 ? 'mixed' : cats[0] === 'aircraft' ? 'aircraft' : cats[0] === 'scenery' ? 'scenery' : 'other';
    const identities = [];
    let sceneryIdent = null;
    for (const g of rec.generated || []) {
      if (/^aircraft\/.*\.lst\.idx$/.test(g.file)) {
        for (const line of (g.text || '').split('\n')) {
          const t = line.split('\t');
          if (t.length >= 2 && t[1]) identities.push(t[1]);
        }
      } else if (/^scenery\/.*\.lst$/.test(g.file) && !/\.idx$/.test(g.file)) {
        const first = (g.text || '').split('\n').find(Boolean);
        if (first) sceneryIdent = first.trim().split(/\s+/)[0].replace(/^"|"$/g, '') || null;
      }
    }
    const recipeFile = (rec.files || []).find((f) => f.path === RECIPE_FILE);
    out.push({
      id: rec.id, name: rec.name, enabled: rec.enabled !== false,
      installedAt: rec.installedAt || 0,
      kind, identities, sceneryIdent, recipeSha: recipeFile ? recipeFile.sha256 : null,
    });
  }
  out.sort((a, b) => b.installedAt - a.installedAt);
  return out;
}

async function loadRecipe(recipeSha) {
  const bytes = await opfs.getBlob(recipeSha);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Read a pack's payload files back out of the content-addressed store —
// the aircraft edit flow restores its loose entries from these.
async function packPayload(id, prefix) {
  const rec = await opfs.getRecord(id);
  const out = [];
  for (const f of (rec && rec.files) || []) {
    if (f.path === RECIPE_FILE || !f.path.startsWith(prefix)) continue;
    if (/\.lst(\.idx)?$/i.test(f.path)) continue; // regenerated on assemble
    out.push({ name: f.path.split('/').pop(), bytes: await opfs.getBlob(f.sha256) });
  }
  return out;
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

// --- creations library card ---------------------------------------------------------

let renderLibrary = () => {};           // re-render hook, called after any save/delete
let aircraftEdit = () => {};            // (recipe, rec) => restore the aircraft card
let islandEdit = () => {};              // (recipe, rec) => restore the island card
let lastAircraftIdentify = null;

function creationsCard() {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, S.libTitle));
  card.appendChild(el('p', 'intro', S.libIntro));
  const listEl = el('div');
  card.appendChild(listEl);
  app.appendChild(card);

  renderLibrary = async () => {
    const items = await listCreations();
    listEl.innerHTML = '';
    if (items.length === 0) {
      listEl.appendChild(el('div', 'msg', S.libEmpty));
      return;
    }
    for (const it of items) {
      const rowEl = el('div');
      rowEl.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid #2a3647;' +
        'border-radius:7px;margin-bottom:6px;background:#0b1017' + (it.enabled ? '' : ';opacity:.5');
      const badge = el('span', null, S.libKind[it.kind] || '📦');
      badge.style.cssText = 'flex:none';
      const nm = el('span', null, it.name || it.id);
      nm.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6edf3;font-size:13.5px';
      const sub = el('span', null, it.identities[0] || it.sceneryIdent || '');
      sub.style.cssText = 'flex:none;color:#7d93b0;font-size:11px;max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      rowEl.appendChild(badge);
      rowEl.appendChild(nm);
      rowEl.appendChild(sub);

      const btn = (label, title, accent) => {
        const b = el('button', accent ? 'accent' : null, label);
        b.title = title;
        b.style.cssText += ';font-size:12px;padding:4px 9px;flex:none';
        rowEl.appendChild(b);
        return b;
      };
      const onoff = btn(it.enabled ? S.libOn : S.libOff, '', it.enabled);
      onoff.addEventListener('click', async () => {
        await opfs.setEnabled(it.id, !it.enabled);
        renderLibrary();
      });
      // Fly: aircraft by its first identity; scenery by ident (workbench maps
      // know their start; imported scenery may lack one we can name -> hidden).
      const canFlyScenery = it.kind === 'scenery' && it.sceneryIdent && it.recipeSha;
      if (it.enabled && (it.identities.length > 0 || canFlyScenery)) {
        const fly = btn(S.libFly, S.libFlyTitle, true);
        fly.addEventListener('click', () => {
          if (it.identities.length > 0) location.href = flyUrl(it.identities[0]);
          else location.href = flyUrl(lastAircraftIdentify || DEFAULT_FLY_AIRCRAFT, it.sceneryIdent, SCENERY_START);
        });
      }
      // Send an aircraft's model files to the modeler (via staging) for editing.
      if (it.kind === 'aircraft') {
        const toModeler = btn(S.libModeler, S.libModelerTitle, false);
        toModeler.addEventListener('click', async () => {
          const payload = (await packPayload(it.id, 'aircraft/')).filter((f) => /\.(dnm|srf)$/i.test(f.name));
          for (const f of payload) await putStaged(f.name, f.bytes);
          const st = document.createElement('div');
          st.textContent = S.libModelerSent(payload.length);
          st.className = 'msg';
          rowEl.after(st);
          setTimeout(() => st.remove(), 5000);
        });
      }
      if (it.recipeSha) {
        const ed = btn(S.libEdit, S.libEditTitle, false);
        ed.addEventListener('click', async () => {
          try {
            const recipe = await loadRecipe(it.recipeSha);
            if (recipe.type === 'scenery') islandEdit(recipe, it);
            else aircraftEdit(recipe, it);
          } catch (e) {
            console.warn('[workbench] recipe load failed', e);
          }
        });
      }
      const del = btn(S.libDel, S.libDelTitle, false);
      del.style.color = '#c75d6a';
      del.addEventListener('click', async () => {
        if (!self.confirm(S.libDelConfirm(it.name || it.id))) return;
        await opfs.removeRecord(it.id);
        try { await opfs.gc(); } catch (e) {}
        renderLibrary();
      });
      listEl.appendChild(rowEl);
    }
  };
  renderLibrary();
}

// --- aircraft assembly card --------------------------------------------------------

let acSetGeneratedDat = null; // hook the dat wizard uses to feed the assembly

function aircraftCard() {
  const card = el('div', 'card');
  card.appendChild(el('h2', null, S.acTitle));
  card.appendChild(el('p', 'intro', S.acIntro));

  // The modeler is where the .dnm/.srf come from when you have none yet.
  const modelerLink = el('a', null, S.modelerLink);
  modelerLink.href = './modeler.html';
  modelerLink.title = S.modelerLinkTitle;
  modelerLink.style.cssText =
    'display:inline-block;margin:0 0 10px;padding:6px 12px;border:1px solid #2a3647;border-radius:6px;' +
    'color:#8fa3bb;font-size:12.5px;text-decoration:none';
  card.appendChild(modelerLink);

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

  // Files the modeler saved arrive here via the OPFS staging bridge — one
  // click puts them into the assembly.  Refreshed whenever the tab comes back
  // into view (the user flips between the modeler and this page).
  const stagedBox = el('div');
  stagedBox.style.marginTop = '8px';
  card.appendChild(stagedBox);

  const slotsBox = el('div');
  slotsBox.style.marginTop = '10px';
  card.appendChild(slotsBox);
  const msg = el('div', 'msg');
  const btnRow = el('div', 'btnrow');
  card.appendChild(msg);
  card.appendChild(btnRow);

  let entries = [];       // [{name, bytes}] accumulated loose files
  let generatedDat = null;
  let datRecipe = null;   // {baseFile, identify, knobs} when the dat wizard made the .dat
  let editingId = null;   // replace-on-save target when re-editing a creation
  let sels = null;
  const editBadge = el('div', 'msg');
  card.insertBefore(editBadge, drop);

  const rebuildSlots = (preset) => {
    slotsBox.innerHTML = '';
    btnRow.innerHTML = '';
    const { candidates, guess, ignored } = classifyLoose(entries);
    const pre = (slot) => (preset && preset.slots && preset.slots[slot]) || null;
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
      dat: mkSel(S.slotDat, candidates.dat, pre('dat') || (generatedDat ? '@generated' : guess.dat), true, genOpt),
      visual: mkSel(S.slotVisual, candidates.dnm, pre('visual') || guess.visual, true),
      collision: mkSel(S.slotColl, candidates.srf, pre('collision') || guess.collision, true),
      cockpit: mkSel(S.slotCockpit, candidates.srf, pre('cockpit') || guess.cockpit, false),
      coarse: mkSel(S.slotCoarse, candidates.dnm, pre('coarse') || guess.coarse, false),
    };
    if (!preset && generatedDat) sels.dat.value = '@generated';
    const nameIn = Object.assign(document.createElement('input'), { type: 'text', placeholder: (guess.dat || (generatedDat && generatedDat.identify) || '').replace(/\.dat$/i, '') });
    if (preset && preset.packName) nameIn.value = preset.packName;
    row(slotsBox, S.packName, nameIn);
    if (ignored.length) msg.textContent = S.ignored(ignored);

    const goBtn = el('button', 'accent', S.assemble);
    goBtn.addEventListener('click', async () => {
      goBtn.disabled = true;
      msg.textContent = S.working;
      try {
        const pick = (sel) => (sel.value === '@generated' ? generatedDat : sel.value ? byName.get(sel.value) : null);
        const slots = {
          dat: pick(sels.dat), visual: pick(sels.visual), collision: pick(sels.collision),
          cockpit: pick(sels.cockpit), coarse: pick(sels.coarse),
        };
        const asm = assembleAircraftZip({
          name: nameIn.value.trim() || undefined,
          ...slots,
          recipe: {
            packName: nameIn.value.trim() || undefined,
            slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, v ? v.name : null])),
            datRecipe: sels.dat.value === '@generated' ? datRecipe : null,
          },
        });
        const res = await saveOrReplace(asm.zipBytes, asm.packName, editingId);
        editingId = res.id; // further saves keep replacing this creation
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
        renderLibrary();
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

  const renderStaged = async () => {
    let staged = [];
    try { staged = await listStaged(); } catch (e) { /* OPFS unavailable — hide */ }
    stagedBox.innerHTML = '';
    const title = el('div', null, S.stagedTitle);
    title.style.cssText = 'color:#cfe0f5;font-size:12.5px;font-weight:600';
    const hint = el('div', null, staged.length ? S.stagedHint : S.stagedEmpty);
    hint.style.cssText = 'color:#7d93b0;font-size:11px;margin-bottom:4px';
    stagedBox.appendChild(title);
    stagedBox.appendChild(hint);
    for (const s of staged) {
      const rowEl = el('div');
      rowEl.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px;border:1px solid #2a3647;border-radius:6px;margin-bottom:4px';
      const nm = el('span', null, s.name);
      nm.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6edf3;font-size:12.5px';
      const sz = el('span', null, (s.size / 1024).toFixed(1) + 'KB');
      sz.style.cssText = 'flex:none;color:#7d93b0;font-size:11px';
      const add = el('button', 'accent', S.stagedAdd);
      add.title = S.stagedAddTitle;
      add.style.cssText += ';font-size:11.5px;padding:3px 10px;flex:none';
      add.addEventListener('click', async () => {
        try {
          const bytes = await getStaged(s.name);
          entries = entries.filter((e) => e.name !== s.name);
          entries.push({ name: s.name, bytes });
          rebuildSlots();
          msg.textContent = S.stagedAdded(s.name);
        } catch (e) { msg.textContent = S.errorPrefix + ((e && e.message) || e); }
      });
      const dl = el('button', null, S.stagedDl);
      dl.title = S.stagedDlTitle;
      dl.style.cssText += ';font-size:11.5px;padding:3px 8px;flex:none';
      dl.addEventListener('click', async () => {
        const bytes = await getStaged(s.name);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes]));
        a.download = s.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      });
      const del = el('button', null, '🗑');
      del.style.cssText += ';font-size:11.5px;padding:3px 8px;flex:none;color:#c75d6a';
      del.addEventListener('click', async () => { await removeStaged(s.name); renderStaged(); });
      rowEl.appendChild(nm);
      rowEl.appendChild(sz);
      rowEl.appendChild(add);
      rowEl.appendChild(dl);
      rowEl.appendChild(del);
      stagedBox.appendChild(rowEl);
    }
    // Local files INTO the shared area (they reach the modeler's File->Open on
    // its next start; the assembly can add them from this same list).
    const sendLab = el('label', null, S.stagedSend);
    sendLab.title = S.stagedSendTitle;
    sendLab.style.cssText =
      'display:inline-block;margin-top:2px;padding:4px 10px;border:1px dashed #2a3647;border-radius:6px;' +
      'color:#7d93b0;font-size:11.5px;cursor:pointer';
    const sendIn = document.createElement('input');
    sendIn.type = 'file';
    sendIn.accept = '.srf,.dnm,.dat';
    sendIn.multiple = true;
    sendIn.style.display = 'none';
    sendIn.addEventListener('change', async () => {
      let n = 0;
      for (const f of Array.from(sendIn.files)) {
        if (!/\.(srf|dnm|dat)$/i.test(f.name)) continue;
        await putStaged(f.name, new Uint8Array(await f.arrayBuffer()));
        n++;
      }
      if (n) msg.textContent = S.stagedSent(n);
      renderStaged();
    });
    sendLab.appendChild(sendIn);
    stagedBox.appendChild(sendLab);
  };
  renderStaged();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renderStaged(); });
  window.addEventListener('focus', renderStaged);

  acSetGeneratedDat = (dat, recipeInfo) => { generatedDat = dat; datRecipe = recipeInfo || null; rebuildSlots(); };

  // Re-open a creation: its loose files come back out of the pack payload, the
  // slot assignment and name from the embedded recipe.
  aircraftEdit = async (recipe, it) => {
    entries = await packPayload(it.id, 'aircraft/');
    generatedDat = null;
    datRecipe = recipe.datRecipe || null;
    editingId = it.id;
    editBadge.textContent = S.libEditingBadge(it.name || it.id);
    rebuildSlots({ slots: recipe.slots || {}, packName: recipe.packName || it.name });
    card.scrollIntoView({ behavior: 'smooth' });
  };
  app.appendChild(card);
}

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
      const knobVals = Object.fromEntries(Object.entries(knobs).map(([k, s]) => [k, Number(s.value)]));
      acSetGeneratedDat(
        { name: dat.identify.toLowerCase() + '.dat', bytes: dat.bytes, identify: dat.identify },
        { baseFile: baseSel.value, identify: name, knobs: knobVals },
      );
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
  const editBadge = el('div', 'msg');
  card.appendChild(editBadge);
  let editingId = null; // replace-on-save target when re-editing

  const nameIn = row(card, S.isName, Object.assign(document.createElement('input'), { type: 'text' }));
  const seaIn = row(card, S.isSea, Object.assign(document.createElement('input'), { type: 'color', value: '#0d3a66' }));
  const skyIn = row(card, S.isSky, Object.assign(document.createElement('input'), { type: 'color', value: '#176abd' }));
  const landIn = row(card, S.isLand, Object.assign(document.createElement('input'), { type: 'color', value: '#3c8c50' }));
  const altIn = row(card, S.isAlt, Object.assign(document.createElement('input'), { type: 'number', value: '1000', min: '100', max: '10000' }));

  // --- mode toolbar (draw / objects / mountains / starts) -----------------------
  let mode = 'draw';
  const modeBar = el('div', 'btnrow');
  modeBar.style.cssText += ';justify-content:flex-start;margin:4px 0 2px';
  const modeHint = el('div', null, S.modeHint.draw);
  modeHint.style.cssText = 'color:#7d93b0;font-size:11px;margin-bottom:4px';
  const modeBtns = {};
  const modeCtl = {}; // per-mode control rows, shown for the active mode
  const setMode = (m) => {
    mode = m;
    modeHint.textContent = S.modeHint[m];
    for (const [k, b] of Object.entries(modeBtns)) b.className = k === m ? 'accent' : '';
    for (const [k, r] of Object.entries(modeCtl)) r.style.display = k === mode ? 'flex' : 'none';
  };
  for (const [m, label] of [['draw', S.modeDraw], ['object', S.modeObject], ['mountain', S.modeMountain], ['start', S.modeStart]]) {
    const b = el('button', m === 'draw' ? 'accent' : null, label);
    b.addEventListener('click', () => setMode(m));
    modeBtns[m] = b;
    modeBar.appendChild(b);
  }
  card.appendChild(modeBar);
  card.appendChild(modeHint);

  const ctlRow = (m, children) => {
    const r = el('div', 'row');
    r.style.display = 'none';
    for (const c of children) r.appendChild(c);
    modeCtl[m] = r;
    card.appendChild(r);
    return r;
  };
  const lab = (t) => { const s = el('span', 'lab', t); s.style.width = 'auto'; return s; };
  const numIn = (v, min, max, w) => {
    const i = Object.assign(document.createElement('input'), { type: 'number', value: String(v), min: String(min), max: String(max) });
    i.style.cssText = 'width:' + (w || 90) + 'px;padding:5px 8px;border:1px solid #2a3647;border-radius:5px;background:#0b1017;color:#e6edf3;font-size:12.5px';
    return i;
  };
  const objSel = document.createElement('select');
  objSel.style.cssText = 'flex:1;min-width:0;padding:5px 8px;border:1px solid #2a3647;border-radius:5px;background:#0b1017;color:#e6edf3;font-size:12.5px';
  for (const o of OBJECT_PALETTE) {
    objSel.appendChild(Object.assign(el('option'), { value: o.nam, textContent: o.glyph + ' ' + (LANG === 'ja' ? o.ja : o.en) }));
  }
  const objHead = numIn(0, 0, 359, 70);
  ctlRow('object', [lab(S.objPick), objSel, lab(S.headingDeg), objHead]);
  const mtRad = numIn(1500, 300, 6000, 90);
  const mtHt = numIn(300, 30, 2000, 90);
  ctlRow('mountain', [lab(S.mtRadius), mtRad, lab(S.mtHeight), mtHt]);
  const stAlt = numIn(300, 0, 10000, 90);
  const stSpd = numIn(80, 0, 400, 80);
  const stHead = numIn(0, 0, 359, 70);
  ctlRow('start', [lab(S.stAlt), stAlt, lab(S.stSpeed), stSpd, lab(S.headingDeg), stHead]);

  const canvas = document.createElement('canvas');
  canvas.id = 'island-canvas';
  canvas.width = 640;
  canvas.height = 640;
  card.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const polygons = [];   // islands, in canvas px: [[x,y],...]
  const objects = [];    // {nam, x, z, headingDeg} in WORLD meters
  const mountains = [];  // {x, z, radiusM, heightM} in WORLD meters
  const starts = [];     // {x, z, altM, speedMS, headingDeg} in WORLD meters
  const placed = [];     // undo order: 'poly' | 'object' | 'mountain' | 'start'
  let stroke = null;

  const toWorld = ([x, y]) => [
    (x / canvas.width - 0.5) * WORLD_M,   // X = east
    (y / canvas.height - 0.5) * WORLD_M,  // canvas down = Z = south
  ];
  const fromWorld = ([x, z]) => [
    (x / WORLD_M + 0.5) * canvas.width,
    (z / WORLD_M + 0.5) * canvas.height,
  ];
  const pxPerM = canvas.width / WORLD_M;

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
    for (const m of mountains) {
      const [cx, cy] = fromWorld([m.x, m.z]);
      const r = m.radiusM * pxPerM;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(139,90,43,.9)');
      g.addColorStop(0.6, 'rgba(90,120,60,.6)');
      g.addColorStop(1, 'rgba(90,120,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const o of objects) {
      const [x, y] = fromWorld([o.x, o.z]);
      const glyph = (OBJECT_PALETTE.find((p) => p.nam === o.nam) || {}).glyph || '📦';
      ctx.font = '20px sans-serif';
      ctx.fillText(glyph, x, y);
    }
    for (const s of starts) {
      const [x, y] = fromWorld([s.x, s.z]);
      // Heading tick: 0 = north = up on the map (canvas -y).
      const hx = Math.sin((s.headingDeg || 0) * Math.PI / 180);
      const hy = -Math.cos((s.headingDeg || 0) * Math.PI / 180);
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
  };
  seaIn.addEventListener('input', redraw);
  landIn.addEventListener('input', redraw);

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
    if (mode === 'object') {
      objects.push({ nam: objSel.value, x: wx, z: wz, headingDeg: Number(objHead.value) || 0 });
      placed.push('object');
    } else if (mode === 'mountain') {
      mountains.push({ x: wx, z: wz, radiusM: Number(mtRad.value) || 1500, heightM: Number(mtHt.value) || 300 });
      placed.push('mountain');
    } else if (mode === 'start') {
      starts.push({ x: wx, z: wz, altM: Number(stAlt.value) || 0, speedMS: Number(stSpd.value) || 0, headingDeg: Number(stHead.value) || 0 });
      placed.push('start');
    }
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const p = pt(e);
    const last = stroke[stroke.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 6) { stroke.push(p); redraw(); }
  });
  const endStroke = () => {
    if (stroke && stroke.length >= 3) { polygons.push(stroke); placed.push('poly'); }
    stroke = null;
    redraw();
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', () => { stroke = null; redraw(); });

  const tools = el('div', 'btnrow');
  tools.style.justifyContent = 'flex-start';
  const undoBtn = el('button', null, S.isUndo);
  undoBtn.addEventListener('click', () => {
    const kind = placed.pop();
    if (kind === 'poly') polygons.pop();
    else if (kind === 'object') objects.pop();
    else if (kind === 'mountain') mountains.pop();
    else if (kind === 'start') starts.pop();
    redraw();
  });
  const clearBtn = el('button', null, S.isClear);
  clearBtn.addEventListener('click', () => {
    polygons.length = 0; objects.length = 0; mountains.length = 0; starts.length = 0; placed.length = 0;
    redraw();
  });
  tools.appendChild(undoBtn);
  tools.appendChild(clearBtn);
  card.appendChild(tools);

  const msg = el('div', 'msg', S.isEmptyOk);
  card.appendChild(msg);
  const btnRow = el('div', 'btnrow');
  const goBtn = el('button', 'accent', S.isMake);
  const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    msg.textContent = S.working;
    try {
      const scenery = {
        name: nameIn.value.trim(),
        ground: hex2rgb(seaIn.value),
        sky: hex2rgb(skyIn.value),
        land: hex2rgb(landIn.value),
        startAltM: Math.max(100, Number(altIn.value) || 1000),
        islands: polygons.map((poly) => ({ points: poly.map(toWorld) })),
        objects: objects.slice(),
        mountains: mountains.slice(),
        starts: starts.slice(),
      };
      const asm = assembleSceneryZip({ ...scenery, recipe: { scenery } });
      const res = await saveOrReplace(asm.zipBytes, asm.packName, editingId);
      editingId = res.id; // further saves keep replacing this creation
      renderLibrary();
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

  // Re-open a drawn map: the recipe carries the wizard state verbatim, so the
  // canvas comes back with every island and you keep drawing where you left off.
  const rgb2hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
  islandEdit = (recipe, it) => {
    const sc = recipe.scenery || {};
    nameIn.value = sc.name || it.name || '';
    if (sc.ground) seaIn.value = rgb2hex(sc.ground);
    if (sc.sky) skyIn.value = rgb2hex(sc.sky);
    if (sc.land) landIn.value = rgb2hex(sc.land);
    if (sc.startAltM) altIn.value = String(sc.startAltM);
    polygons.length = 0;
    for (const isl of sc.islands || []) polygons.push((isl.points || []).map(fromWorld));
    objects.length = 0;
    for (const o of sc.objects || []) objects.push({ ...o });
    mountains.length = 0;
    for (const m of sc.mountains || []) mountains.push({ ...m });
    starts.length = 0;
    for (const s of sc.starts || []) starts.push({ ...s });
    placed.length = 0; // undo history does not survive a re-open; clear-all still works
    editingId = it.id;
    editBadge.textContent = S.libEditingBadge(it.name || it.id);
    redraw();
    card.scrollIntoView({ behavior: 'smooth' });
  };
  app.appendChild(card);
  redraw();
}

// --- boot -------------------------------------------------------------------------

async function main() {
  try { await navigator.storage.persist(); } catch (e) { /* best effort */ }
  header();
  creationsCard();
  aircraftCard();
  await datCard();
  islandCard();
  // Driven by the smoke test (and handy in the console).  The two create APIs
  // embed recipes exactly like the UI does, so anything made through them shows
  // up as an editable creation in the library.
  window.ysfwWorkbench = {
    ready: true,
    installZip,
    listStock: stockIndex,
    listCreations,
    loadRecipe,
    listStaged, getStaged, putStaged, removeStaged, // modeler file bridge (smoke/debug)
    deleteCreation: async (id) => {
      await opfs.removeRecord(id);
      try { await opfs.gc(); } catch (e) {}
      renderLibrary();
      return { id, removed: true };
    },
    makeDat: async (file, identify, knobs) => {
      const r = await fetch('./stock/' + file);
      if (!r.ok) throw new Error('stock fetch: HTTP ' + r.status);
      return makeDatFromBase(new Uint8Array(await r.arrayBuffer()), { identify, knobs });
    },
    assembleInstall: async (slots) => {
      const asm = assembleAircraftZip({
        ...slots,
        recipe: {
          packName: slots.name,
          slots: Object.fromEntries(['dat', 'visual', 'collision', 'cockpit', 'coarse']
            .map((k) => [k, slots[k] ? slots[k].name : null])),
        },
      });
      const res = await saveOrReplace(asm.zipBytes, asm.packName, slots.replaceId);
      renderLibrary();
      return { ...res, identify: asm.identify, warnings: asm.warnings, packName: asm.packName };
    },
    createScenery: async (opts) => {
      const { replaceId, ...scenery } = opts;
      const asm = assembleSceneryZip({ ...scenery, recipe: { scenery } });
      const res = await saveOrReplace(asm.zipBytes, asm.packName, replaceId);
      renderLibrary();
      return { ...res, ident: asm.ident, start: SCENERY_START };
    },
  };
}
main();
