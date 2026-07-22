// Missions page — the native Simulation menu at NATIVE granularity
// (web-shell increment 14).  Each mission section offers the same selectable
// options as the engine's own dialog — landing practice's full 15 levels with
// the native descriptions, endurance's wingmen/enemy-level/AAM, intercept's
// raid composition, CAS and racing's aircraft/field — and "start" navigates
// to the (already parameter-complete) deep link.  Engine-less; aircraft come
// from the stock index, fields from stock/fields.json (the bundled set, shown
// by identifier exactly like the native list boxes).
import { ACCENT, LANG, pageUrl, stockIndex, stockFields } from './studio-shared.js';

const S = ({
  ja: {
    title: '🎯 ミッション',
    sub: '本家 Simulation メニューと同じ項目・同じ選択肢。設定して「開始」で即離陸します。',
    back: '← 戻る',
    aircraft: '機体', field: 'マップ', start: '🛫 開始',
    landing: '着陸訓練', landingLevel: 'レベル',
    endurance: '15分間耐久空中戦', wingmen: '僚機', enemyLevel: '敵レベル', allowAam: '空対空ミサイル使用',
    intercept: '基地防空ミッション', attackers: '敵機数',
    stealth: 'ステルス機あり', escort: '護衛戦闘機あり', heavy: '重爆撃機あり', bombs: '爆弾搭載',
    cas: '近接支援ミッション', racing: 'レーシングモード', course: 'コース',
  },
  en: {
    title: '🎯 Missions',
    sub: 'The native Simulation menu — same items, same choices. Configure and press Start to take off.',
    back: '← Back',
    aircraft: 'Aircraft', field: 'Map', start: '🛫 Start',
    landing: 'Landing Practice', landingLevel: 'Level',
    endurance: 'Endurance Mode', wingmen: 'Wingmen', enemyLevel: 'Enemy level', allowAam: 'Allow air-to-air missiles',
    intercept: 'Intercept Mission', attackers: 'Attackers',
    stealth: 'May include stealth', escort: 'Fighter escort', heavy: 'Heavy bombers', bombs: 'Carry bombs',
    cas: 'Close Air Support', racing: 'Racing Mode', course: 'Course',
  },
})[LANG] || {};

// Native landing-level descriptions (runtime/language/*.uitxt
// menu/simulation-Ldg-Level01..15 — the exact strings veterans know).
const LDG_LEVELS = [
  'Straight-In, Wind-Calm, Good Visibility',
  'Straight-In, Light-Wind, Good Visibility',
  'Dog-Leg, Wind-Calm, Good Visibility',
  'Base-Leg, Light-Wind, Good Visibility',
  'Base-Leg, Moderate-Wind, Good Visibility',
  'Base-Leg, Strong-Wind, Good Visibility',
  'Straight-In, Wind-Calm, Low Cloud',
  'Dog-Leg, Wind-Calm, Low Cloud',
  'Base-Leg, Wind-Calm, Low Cloud',
  'Base-Leg, Light-Wind, Low Cloud',
  'Base-Leg, Moderate-Wind, Low Cloud',
  'Straight-In, Wind-Calm, Low Visibility',
  'Base-Leg, Wind-Calm, Low Visibility',
  'Base-Leg, Moderate-Wind, Low Visibility',
  'Base-Leg, Strong-Wind, Low Visibility+Low Cloud',
];

const el = (tag, css, text) => {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
};
const selCss = 'padding:6px 8px;border-radius:6px;border:1px solid #243244;background:#0d141d;color:#e6edf3;font-size:13px';

let AIRCRAFT_IDS = [];
let FIELD_IDS = [];

function makeSelect(options, value, id) {
  const sel = el('select', selCss);
  if (id) sel.id = id;
  for (const o of options) {
    const opt = el('option', null, String(o.label != null ? o.label : o));
    opt.value = String(o.value != null ? o.value : o);
    sel.appendChild(opt);
  }
  if (value != null) sel.value = String(value);
  return sel;
}
function aircraftSelect(def, id) {
  return makeSelect(AIRCRAFT_IDS, AIRCRAFT_IDS.includes(def) ? def : AIRCRAFT_IDS[0], id);
}
function fieldSelect(def, id, ids) {
  const list = ids || FIELD_IDS;
  return makeSelect(list, list.includes(def) ? def : list[0], id);
}
function labeled(label, control) {
  const box = el('label', 'display:flex;flex-direction:column;gap:3px;font-size:11px;color:#8fa3bb');
  box.appendChild(el('span', null, label));
  box.appendChild(control);
  return box;
}
function check(label, checked) {
  const lab = el('label', 'display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;color:#e6edf3');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = checked;
  lab.appendChild(cb); lab.appendChild(el('span', null, label));
  lab._cb = cb;
  return lab;
}
function go(query) {
  const lang = new URLSearchParams(location.search).get('lang');
  location.assign(location.origin + location.pathname.replace(/[^/]*$/, '') + '?' + query + (lang ? '&lang=' + encodeURIComponent(lang) : ''));
}
function section(title, rows, startFn, startId) {
  const card = el('div', 'border:1px solid #243244;border-radius:10px;background:#0d141d;padding:14px 16px;margin-bottom:12px');
  card.appendChild(el('div', 'font-size:15px;font-weight:700;margin-bottom:10px', title));
  const grid = el('div', 'display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end');
  for (const r of rows) grid.appendChild(r);
  const btn = el('button', 'padding:8px 18px;border:0;border-radius:8px;background:' + ACCENT + ';color:#04101f;font-size:14px;font-weight:700;cursor:pointer', S.start);
  if (startId) btn.id = startId;
  btn.addEventListener('click', startFn);
  grid.appendChild(btn);
  card.appendChild(grid);
  return card;
}

function render(root) {
  document.body.style.cssText = 'margin:0;background:#0b1119;color:#e6edf3;font-family:system-ui,sans-serif';
  const wrap = el('div', 'max-width:720px;margin:0 auto;padding:20px 16px 48px');
  root.appendChild(wrap);
  const back = el('a', 'color:' + ACCENT + ';font-size:13px;text-decoration:none', S.back);
  back.href = pageUrl('index.html');
  wrap.appendChild(back);
  wrap.appendChild(el('h1', 'font-size:22px;margin:10px 0 2px', S.title));
  wrap.appendChild(el('div', 'color:#8fa3bb;font-size:13px;margin-bottom:16px', S.sub));

  // ---- 着陸訓練: all 15 native levels + aircraft + field --------------------
  {
    // Level labels exactly as the native menu shows them (ja.uitxt: レベル N /
    // en.uitxt: LEVEL N, then the shared English condition string).
    const lvPrefix = LANG === 'ja' ? 'レベル ' : 'LEVEL ';
    const lv = makeSelect(LDG_LEVELS.map((d, i) => ({ value: i + 1, label: lvPrefix + (i + 1) + ': ' + d })), 1, 'ysfw-ldg-level');
    lv.style.maxWidth = '340px';
    const air = aircraftSelect('F-18C_HORNET', 'ysfw-ldg-air');
    const fld = fieldSelect('AOMORI', 'ysfw-ldg-field');
    wrap.appendChild(section(S.landing, [
      labeled(S.landingLevel, lv), labeled(S.aircraft, air), labeled(S.field, fld),
    ], () => go('landing=' + lv.value + ',' + air.value + ',' + fld.value), 'ysfw-ldg-start'));
  }
  // ---- 15分間耐久空中戦: wingmen / enemy level / AAM ------------------------
  {
    const air = aircraftSelect('F-15J_EAGLE', 'ysfw-end-air');
    const fld = fieldSelect('ATSUGI_AIRBASE', 'ysfw-end-field');
    const wing = makeSelect([0, 1, 2], 2, 'ysfw-end-wing');
    const lvl = makeSelect([1, 2, 3, 4, 5], 3, 'ysfw-end-level');
    const aam = check(S.allowAam, true);
    wrap.appendChild(section(S.endurance, [
      labeled(S.aircraft, air), labeled(S.field, fld),
      labeled(S.wingmen, wing), labeled(S.enemyLevel, lvl), aam,
    ], () => go('endurance=' + air.value + ',' + fld.value + ',' + wing.value + ',' + lvl.value + ',' + (aam._cb.checked ? 1 : 0)), 'ysfw-end-start'));
  }
  // ---- 基地防空ミッション: full raid composition ----------------------------
  {
    const air = aircraftSelect('F-15J_EAGLE', 'ysfw-int-air');
    const fld = fieldSelect('ATSUGI_AIRBASE', 'ysfw-int-field');
    const n = makeSelect([1, 2, 3, 4, 5], 3, 'ysfw-int-n');
    const wing = makeSelect([0, 1, 2], 2, 'ysfw-int-wing');
    const st = check(S.stealth, false);
    const esc = check(S.escort, true);
    const hv = check(S.heavy, true);
    const bm = check(S.bombs, true);
    wrap.appendChild(section(S.intercept, [
      labeled(S.aircraft, air), labeled(S.field, fld),
      labeled(S.attackers, n), labeled(S.wingmen, wing), st, esc, hv, bm,
    ], () => go('intercept=' + air.value + ',' + fld.value + ',' +
      (st._cb.checked ? 1 : 0) + ',' + (esc._cb.checked ? 1 : 0) + ',' +
      (hv._cb.checked ? 1 : 0) + ',' + (bm._cb.checked ? 1 : 0) + ',' +
      n.value + ',' + wing.value), 'ysfw-int-start'));
  }
  // ---- 近接支援ミッション ---------------------------------------------------
  {
    const air = aircraftSelect('F-15J_EAGLE', 'ysfw-cas-air');
    const fld = fieldSelect('TOHOKU', 'ysfw-cas-field');
    wrap.appendChild(section(S.cas, [
      labeled(S.aircraft, air), labeled(S.field, fld),
    ], () => go('mission=cas,' + air.value + ',' + fld.value), 'ysfw-cas-start'));
  }
  // ---- レーシングモード: the two bundled courses ----------------------------
  {
    const air = aircraftSelect('F-15J_EAGLE', 'ysfw-race-air');
    const course = fieldSelect('RACING_VALLEY', 'ysfw-race-course',
      FIELD_IDS.filter((f) => f.startsWith('RACING_')).length ? FIELD_IDS.filter((f) => f.startsWith('RACING_')) : ['RACING_VALLEY', 'RACING_DESERT']);
    wrap.appendChild(section(S.racing, [
      labeled(S.aircraft, air), labeled(S.course, course),
    ], () => go('mission=racing,' + air.value + ',' + course.value), 'ysfw-race-start'));
  }
}

(async function () {
  try {
    const idx = await stockIndex();
    AIRCRAFT_IDS = idx.map((a) => a.identify).filter(Boolean).sort();
  } catch (e) { AIRCRAFT_IDS = ['F-15J_EAGLE', 'F-18C_HORNET']; }
  if (!AIRCRAFT_IDS.length) AIRCRAFT_IDS = ['F-15J_EAGLE', 'F-18C_HORNET'];
  try { FIELD_IDS = Object.keys(await stockFields()).sort(); } catch (e) { FIELD_IDS = []; }
  if (!FIELD_IDS.length) FIELD_IDS = ['AOMORI', 'ATSUGI_AIRBASE', 'SMALL_MAP', 'HAWAII', 'TOHOKU', 'RACING_VALLEY', 'RACING_DESERT'];
  render(document.body);
  window.ysfwMissionsReady = true;  // smoke-test signal
})();
