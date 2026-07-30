// Shared plumbing for the workbench studio pages (studio-aircraft.html,
// studio-scenery.html, studio-pack.html) and the workbench hub.
//
// Everything here is engine-less: creations are installed as OPFS pack records
// only (blobs + record), and the game page materializes every enabled record at
// boot (materializeEnabled in packs-ui.js).  That is what lets every studio
// page skip the 25MB engine preload.
//
// Layout contract (studioChrome): a fixed full-viewport shell —
//   topbar (46px: hub link, page title, cross-studio nav)
//   rail   (left, 360px, scrollable controls)
//   main   (the rest: the page's big work surface)
// The chrome CSS is injected from here so all studios stay uniform.

import { analyzePackStreaming, MAX_PACK_BYTES } from './packs.js';
import * as opfs from './opfs-store.js';
import { RECIPE_FILE } from './workbench.js';

export const ACCENT = '#4da3ff';
export const DEFAULT_FLY_AIRCRAFT = 'F-15C_EAGLE';
export const WORLD_M = 16000; // the island canvas spans a 16km x 16km sea

// Curated stock ground objects for the map editor (NAM = the .dat IDENTIFY the
// engine's preloaded ground templates register under; all 108 always link).
export const OBJECT_PALETTE = [
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
  { nam: 'VORDME', ja: 'VOR/DMEビーコン（距離つき）', en: 'VOR/DME beacon (with distance)', glyph: '📶' },
  { nam: 'NDB', ja: 'NDBビーコン', en: 'NDB beacon', glyph: '📻' },
];

export const LANG = (function () {
  try {
    const l = String((new URLSearchParams(location.search).get('lang')) || navigator.language || 'en').toLowerCase();
    return l.indexOf('ja') === 0 ? 'ja' : 'en';
  } catch (e) { return 'en'; }
})();

// Every studio page imports this module and renders in LANG, but the static
// HTML skeletons say lang="ja" — stamp the real document language once here
// so English visitors get the right attribute (a11y / font selection).
try { document.documentElement.lang = LANG; } catch (e) { /* non-DOM import (tests) */ }

// Preserve an explicit ?lang= across studio navigation; nothing else carries over.
export function pageUrl(page, params) {
  const p = new URLSearchParams(params || {});
  if (new URLSearchParams(location.search).get('lang')) p.set('lang', LANG);
  const q = p.toString();
  return './' + page + (q ? '?' + q : '');
}

export const flyUrl = (air, field, start) => {
  // Include the current page so index.html can navigate back here when the flight ends.
  const returnPage = (location.pathname.split('/').pop() || '');
  const params = { freeflight: [air, field, start].filter(Boolean).join(',') };
  if (returnPage) params.return = returnPage;
  return pageUrl('index.html', params);
};

// --- OPFS-only install ----------------------------------------------------------

export async function webSha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Install a pack zip as an OPFS record (blobs + record; no engine FS).  The
// game page materializes every enabled record at boot, so this IS an install.
export async function installZip(bytes, name) {
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
export async function saveOrReplace(zipBytes, name, replaceId) {
  const res = await installZip(zipBytes, name);
  if (replaceId && replaceId !== res.id) {
    try { await opfs.removeRecord(replaceId); await opfs.gc(); } catch (e) { /* old version lingers; harmless */ }
  }
  return res;
}

// The creations-library view: ONLY workbench-made packs (the ones carrying an
// embedded workbench.json recipe).  Imported zips are inventory, not creations
// — they live in the game page's pack panel / the pack studio, not here.
export async function listCreations() {
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

export async function loadRecipe(recipeSha) {
  const bytes = await opfs.getBlob(recipeSha);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Load a creation's recipe by record id (the studios' ?edit=<id> entry point).
export async function loadCreation(id) {
  const rec = await opfs.getRecord(id);
  if (!rec) return null;
  const recipeFile = (rec.files || []).find((f) => f.path === RECIPE_FILE);
  return {
    id: rec.id, name: rec.name,
    recipe: recipeFile ? await loadRecipe(recipeFile.sha256) : null,
  };
}

// Read a pack's payload files back out of the content-addressed store —
// the aircraft edit flow restores its loose entries from these.  Creations
// made before the community-layout change keep payload under the category
// dir (`prefix`, e.g. 'aircraft/'); newer ones ship it under user/<name>/ —
// accept both so old creations stay editable.
export async function packPayload(id, prefix) {
  const rec = await opfs.getRecord(id);
  const out = [];
  for (const f of (rec && rec.files) || []) {
    if (f.path === RECIPE_FILE) continue;
    if (!f.path.startsWith(prefix) && !f.path.startsWith('user/')) continue;
    if (/\.lst(\.idx)?$/i.test(f.path)) continue; // regenerated on assemble
    out.push({ name: f.path.split('/').pop(), bytes: await opfs.getBlob(f.sha256) });
  }
  return out;
}

// Aircraft identities already taken (stock + installed packs) for the dup check.
export async function knownIdentities() {
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
export async function stockIndex() {
  if (stockCache) return stockCache;
  try {
    const r = await fetch('./stock/index.json');
    stockCache = r.ok ? await r.json() : [];
  } catch (e) { stockCache = []; }
  return stockCache;
}

// Start positions per bundled field ({ FIELD_ID: [{n,x,y,z,h}] }, meters/deg;
// generated by gen-stock-index.mjs from the stock .stp files).  Used by the
// Create-Flight page to anchor ground-object presets at ground coordinates.
let fieldsCache = null;
export async function stockFields() {
  if (fieldsCache) return fieldsCache;
  try {
    const r = await fetch('./stock/fields.json');
    fieldsCache = r.ok ? await r.json() : {};
  } catch (e) { fieldsCache = {}; }
  return fieldsCache;
}

// --- tiny DOM helpers (shared by all studio pages) -------------------------------

export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export const row = (parent, label, input) => {
  const r = el('div', 'row');
  r.appendChild(el('span', 'lab', label));
  r.appendChild(input);
  parent.appendChild(r);
  return input;
};

// --- full-screen studio chrome ----------------------------------------------------

const CHROME_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: #0b1017; color: #e6edf3; overflow: hidden;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px; line-height: 1.5;
  }
  #studio { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
  .topbar {
    flex: none; height: 46px; display: flex; align-items: center; gap: 12px;
    padding: 0 12px; border-bottom: 1px solid #2a3647; background: #0d141d;
  }
  .topbar h1 { font-size: 15px; margin: 0; font-weight: 600; white-space: nowrap; }
  .topbar .nav { margin-left: auto; display: flex; gap: 4px; align-items: center; }
  .topbar a {
    color: #8fa3bb; text-decoration: none; font-size: 12.5px;
    padding: 5px 9px; border-radius: 6px; white-space: nowrap;
  }
  .topbar a:hover { background: rgba(77,163,255,.10); color: #cfe0f5; }
  .topbar a.here { color: #4da3ff; background: rgba(77,163,255,.14); }
  .body { flex: 1; display: flex; min-height: 0; }
  .rail {
    flex: none; width: 360px; overflow-y: auto; padding: 12px;
    border-right: 1px solid #2a3647; background: #0d141d;
  }
  .main { flex: 1; min-width: 0; position: relative; display: flex; flex-direction: column; }
  @media (max-width: 760px) {
    body { overflow: auto; }
    #studio { height: auto; }
    .body { flex-direction: column-reverse; }
    .rail { width: auto; border-right: 0; border-top: 1px solid #2a3647; }
    .main { min-height: 55vh; }
  }
  .rail h2 { font-size: 13.5px; margin: 14px 0 6px; color: #cfe0f5; }
  .rail h2:first-child { margin-top: 0; }
  .rail .intro { color: #7d93b0; font-size: 11.5px; margin: 0 0 8px; }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .row > .lab { flex: none; width: 38%; max-width: 150px; color: #8fa3bb; font-size: 12px; }
  .row > input[type=text], .row > input[type=number], .row > select {
    flex: 1; min-width: 0; padding: 6px 9px; border: 1px solid #2a3647; border-radius: 6px;
    background: #0b1017; color: #e6edf3; font-size: 13px;
  }
  .row > input[type=color] { flex: none; width: 48px; height: 28px; padding: 1px; border: 1px solid #2a3647; border-radius: 6px; background: #0b1017; }
  .row > input[type=range] { flex: 1; min-width: 0; }
  .row .val { flex: none; width: 40px; text-align: right; color: #cfe0f5; font-size: 12px; }
  button {
    font-size: 13px; padding: 7px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid #2a3647; background: #0d141d; color: #8fa3bb;
  }
  button.accent { border-color: #4da3ff; background: rgba(77,163,255,.14); color: #4da3ff; }
  button:disabled { opacity: .5; cursor: default; }
  .btnrow { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 8px; }
  .msg { color: #8fa3bb; font-size: 12.5px; white-space: pre-line; min-height: 1.2em; margin-top: 8px; }
  .drop {
    display: block; padding: 16px 10px; border: 1px dashed #2a3647; border-radius: 8px;
    color: #8fa3bb; font-size: 12.5px; text-align: center; cursor: pointer;
    transition: border-color .15s, background .15s;
  }
  .drop.hot { border-color: #4da3ff; background: rgba(77,163,255,.06); }
  a { color: #4da3ff; }
`;

const NAV = [
  ['studio-aircraft.html', { ja: '✈️ 機体', en: '✈️ Aircraft' }],
  ['studio-scenery.html', { ja: '🏝 マップ', en: '🏝 Map' }],
  ['studio-pack.html', { ja: '📦 パック', en: '📦 Packs' }],
  ['index.html', { ja: '🎮 ゲーム', en: '🎮 Game' }],
];

// Build the studio shell into document.body: injects the chrome CSS, renders
// the topbar with cross-studio nav, and returns { rail, main } to fill.
export function studioChrome(title) {
  const style = document.createElement('style');
  style.textContent = CHROME_CSS;
  document.head.appendChild(style);
  const root = el('div');
  root.id = 'studio';
  const top = el('div', 'topbar');
  const hub = el('a', null, '🛠');
  hub.href = pageUrl('workbench.html');
  hub.title = { ja: 'ワークベンチ（マイ作品）へ', en: 'Workbench (my creations)' }[LANG];
  top.appendChild(hub);
  top.appendChild(el('h1', null, title));
  const nav = el('div', 'nav');
  const herePage = location.pathname.split('/').pop();
  for (const [page, label] of NAV) {
    const a = el('a', page === herePage ? 'here' : null, label[LANG]);
    a.href = pageUrl(page);
    nav.appendChild(a);
  }
  top.appendChild(nav);
  root.appendChild(top);
  const body = el('div', 'body');
  const rail = el('div', 'rail');
  const main = el('div', 'main');
  body.appendChild(rail);
  body.appendChild(main);
  root.appendChild(body);
  document.body.appendChild(root);
  try { navigator.storage.persist(); } catch (e) { /* best effort */ }
  return { rail, main };
}

// ---- XP (Luna) window scaffold for studio pages (2026-07-30 tone) ----------
// The page renders as the era's dialog: sky desktop with the hill, Luna
// titlebar whose red × closes the window (= back to the top page), content on
// the dialog face, and a statusbar carrying the page's one-line description.
export function xpWindow(rootEl, title, sub) {
  document.body.style.cssText =
    'margin:0;min-height:100vh;box-sizing:border-box;padding:26px 10px 40px;' +
    'display:flex;align-items:flex-start;justify-content:center;' +
    'background:linear-gradient(180deg,#7FB2F0 0%,#4E86DD 45%,#2E64C8 100%);' +
    "font-family:Tahoma,'MS UI Gothic','Yu Gothic UI',sans-serif;color:#000";
  const hill = document.createElement('div');
  hill.style.cssText = 'position:fixed;left:-20%;right:-20%;bottom:-14vh;height:36vh;pointer-events:none;' +
    'background:radial-gradient(ellipse at 50% 100%,#55B03C 0%,#3F9C35 45%,transparent 72%)';
  rootEl.appendChild(hill);
  const win = document.createElement('div');
  win.style.cssText = 'position:relative;width:min(760px,98vw);border-radius:8px 8px 4px 4px;background:#ECE9D8;' +
    'box-shadow:0 0 0 1px #0831D9,4px 7px 22px rgba(0,20,60,.5);overflow:hidden';
  const tb = document.createElement('div');
  tb.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 6px 6px 10px;color:#fff;font-weight:700;' +
    "font-size:13.5px;font-family:'Trebuchet MS',Tahoma,sans-serif;text-shadow:1px 1px 1px rgba(10,30,90,.75);" +
    'background:linear-gradient(180deg,#2B76E5 0%,#215DCF 6%,#3D8FFF 42%,#245EDC 88%,#1B54B0 100%)';
  const t = document.createElement('span');
  t.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  t.textContent = title;
  tb.appendChild(t);
  const close = document.createElement('a');
  close.href = pageUrl('index.html');
  close.textContent = '\u00d7';
  close.title = LANG === 'ja' ? '\u9589\u3058\u308b \u2014 \u30c8\u30c3\u30d7\u3078\u623b\u308b' : 'Close \u2014 back to the top page';
  close.style.cssText = 'width:22px;height:21px;flex:none;border-radius:3px;border:1px solid rgba(255,255,255,.75);' +
    'font-size:12px;line-height:19px;text-align:center;color:#fff;text-decoration:none;font-family:Tahoma,monospace;' +
    'background:linear-gradient(180deg,#F0A088,#DD6547 40%,#C33B1E);box-shadow:inset 0 1px 0 rgba(255,255,255,.5)';
  tb.appendChild(close);
  win.appendChild(tb);
  const body = document.createElement('div');
  body.style.cssText = 'padding:12px 12px 8px';
  win.appendChild(body);
  const sb = document.createElement('div');
  sb.style.cssText = 'display:flex;gap:3px;padding:4px;background:#ECE9D8;border-top:1px solid #fff;box-shadow:inset 0 1px 0 #D8D4C4';
  const cell = document.createElement('span');
  cell.style.cssText = 'flex:1;font-size:11px;color:#444;padding:3px 8px;border:1px solid;border-color:#ACA899 #fff #fff #ACA899;border-radius:1px';
  cell.textContent = sub || '';
  sb.appendChild(cell);
  win.appendChild(sb);
  rootEl.appendChild(win);
  return body;
}
