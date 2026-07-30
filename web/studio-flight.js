// Create-Flight page — author a multi-aircraft flight without the engine's
// Create-Flight menu (web-shell direction, docs/web-shell.md).
//
// The page composes a plain spec (field, time of day, weapon flags, aircraft
// rows with side + start position), stores it in sessionStorage, and navigates
// to index.html?createflight=1.  index.html's preRun turns the spec into a
// .yfs via web/yfs.js and boots it with -flyyfs.  Engine-less like the other
// studio pages: it only needs the stock aircraft index for the id dropdown.
import { ACCENT, LANG, pageUrl, stockIndex, stockFields, xpWindow } from './studio-shared.js';

// yfs.js is a classic script (globalThis.ysfwYfs), loaded by studio-flight.html
// before this module — the same publish-on-global arrangement index.html uses.
const { buildYfs } = globalThis.ysfwYfs;

const S = ({
  ja: {
    title: 'フライトを作る',
    sub: '機体・マップ・時間帯を選んで、そのまま離陸。追加した機体はAIとして飛びます。',
    field: 'マップ', time: '時間帯', day: '昼', night: '夜',
    weapons: '兵装', gun: '機関砲', aam: '空対空', agm: '空対地', bomb: '爆弾', rocket: 'ロケット',
    aircraft: '機体', addAi: '＋ 敵機/僚機を追加', player: 'あなた', side: '陣営',
    sideFriend: '味方', sideEnemyA: '敵A', sideEnemyB: '敵B', startPos: '開始位置',
    remove: '削除', fly: '離陸', back: '← 戻る',
    needPlayer: '「あなた」の機体を1機選んでください。',
    ground: '地上物', groundNone: 'なし',
    groundAaa: '対空砲陣地（AAA×3）', groundSam: 'SAM陣地（SAM×2＋AAA×1）',
    groundTargets: '練習ターゲット（×4）', groundAt: '配置場所',
  },
  en: {
    title: 'Create Flight',
    sub: 'Pick an aircraft, map and time of day, then take off. Added aircraft fly as AI.',
    field: 'Map', time: 'Time', day: 'Day', night: 'Night',
    weapons: 'Weapons', gun: 'Gun', aam: 'AAM', agm: 'AGM', bomb: 'Bomb', rocket: 'Rocket',
    aircraft: 'Aircraft', addAi: '+ Add enemy / wingman', player: 'You', side: 'Side',
    sideFriend: 'Friendly', sideEnemyA: 'Enemy A', sideEnemyB: 'Enemy B', startPos: 'Start position',
    remove: 'Remove', fly: 'Take off', back: '← Back',
    needPlayer: 'Pick one aircraft for "You".',
    ground: 'Ground objects', groundNone: 'None',
    groundAaa: 'AAA site (AAA×3)', groundSam: 'SAM site (SAM×2 + AAA×1)',
    groundTargets: 'Practice targets (×4)', groundAt: 'Placed at',
  },
})[LANG] || {};

// Bundled fields with a known-good start position each (the same triples the
// top page's Quick Flight presets use, so a Create-Flight can never point at an
// uninstalled add-on or a start position missing from the field's .stp).
const FIELDS = [
  { id: 'SMALL_MAP', label: 'Small Map', start: 'RW36_01' },
  { id: 'ATSUGI_AIRBASE', label: '厚木 / Atsugi', start: 'RW01_01' },
  { id: 'HAWAII', label: 'Hawaii', start: 'NORTH10000_01' },
  { id: 'HEATHROW', label: 'Heathrow', start: 'RW27R' },
];
// IFF/side values map to the engine's IDENTIFY (0 = your side).
const SIDES = () => [
  { iff: 0, label: S.sideFriend },
  { iff: 1, label: S.sideEnemyA },
  { iff: 2, label: S.sideEnemyB },
];

// Ground-object presets: stock identifies + a scatter pattern (dx/dz meters
// from the anchor).  y stays the anchor's own — GNDPOSIT is absolute and the
// engine does not snap to terrain, so anchoring at a ground start position
// (from stock/fields.json) keeps everything on the apron.
const GROUND_PRESETS = () => [
  { key: 'aaa', label: S.groundAaa, objs: [{ id: 'AAA', dx: 0, dz: 0 }, { id: 'AAA', dx: 180, dz: -130 }, { id: 'AAA', dx: -180, dz: -130 }] },
  { key: 'sam', label: S.groundSam, objs: [{ id: 'ASPAM', dx: 120, dz: 0 }, { id: 'ASPAM', dx: -120, dz: 0 }, { id: 'AAA', dx: 0, dz: -160 }] },
  { key: 'targets', label: S.groundTargets, objs: [{ id: 'GROUNDTARGET1', dx: -150, dz: 0 }, { id: 'GROUNDTARGET1', dx: -50, dz: 0 }, { id: 'GROUNDTARGET2', dx: 50, dz: 0 }, { id: 'GROUNDTARGET2', dx: 150, dz: 0 }] },
];

// A start position is "on the ground" (usable as a ground-object anchor) when
// its .stp altitude is low — airborne starts sit at thousands of meters.
const groundStps = (stps) => (stps || []).filter((s) => typeof s.y === 'number' && s.y < 50);

const el = (tag, css, text) => {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
};

let AIRCRAFT_IDS = [];
let FIELD_STPS = {};  // { FIELD_ID: [{n,x,y,z,h}] } from stock/fields.json

function aircraftSelect(value) {
  const sel = el('select', 'padding:6px 8px;border-radius:6px;border:1px solid #7F9DB9;background:#fff;color:#000;font-size:13px;min-width:180px');
  for (const id of AIRCRAFT_IDS) {
    const o = el('option', null, id);
    o.value = id;
    if (id === value) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

function render(root) {
  const wrap = xpWindow(root, S.title, S.sub);

  // Field + time-of-day row.
  const opts = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px');
  const fieldSel = el('select', 'padding:7px 9px;border-radius:6px;border:1px solid #7F9DB9;background:#fff;color:#000;font-size:13px;width:100%');
  // All stock fields from stock/fields.json (verified .stp start positions),
  // with the curated FIELDS entries supplying nicer labels / preferred starts.
  // Falls back to the curated four if fields.json failed to load (issue #83).
  const fieldFor = (id) => {
    const cur = FIELDS.find((x) => x.id === id);
    if (cur) return cur;
    const stps = FIELD_STPS[id] || [];
    return { id, label: id, start: stps.length ? stps[0].n : '' };
  };
  const fieldIds = Object.keys(FIELD_STPS).filter((id) => (FIELD_STPS[id] || []).length).sort();
  const allFields = fieldIds.length ? fieldIds.map(fieldFor) : FIELDS;
  for (const f of allFields) {
    const o = el('option', null, f.label); o.value = f.id; fieldSel.appendChild(o);
  }
  const fieldBox = el('div'); fieldBox.appendChild(el('div', 'color:#555;font-size:11px;margin-bottom:4px', S.field)); fieldBox.appendChild(fieldSel);
  const timeSel = el('select', 'padding:7px 9px;border-radius:6px;border:1px solid #7F9DB9;background:#fff;color:#000;font-size:13px;width:100%');
  for (const [v, t] of [['DAY', S.day], ['NIGHT', S.night]]) { const o = el('option', null, t); o.value = v; timeSel.appendChild(o); }
  const timeBox = el('div'); timeBox.appendChild(el('div', 'color:#555;font-size:11px;margin-bottom:4px', S.time)); timeBox.appendChild(timeSel);
  opts.appendChild(fieldBox); opts.appendChild(timeBox);
  wrap.appendChild(opts);

  // Weapon flags.
  wrap.appendChild(el('div', 'color:#555;font-size:11px;margin-bottom:6px', S.weapons));
  const wpnRow = el('div', 'display:flex;flex-wrap:wrap;gap:14px;margin-bottom:20px');
  const wpn = {};
  for (const [k, lbl] of [['gun', S.gun], ['aam', S.aam], ['agm', S.agm], ['bomb', S.bomb], ['rocket', S.rocket]]) {
    const lab = el('label', 'display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = true; wpn[k] = cb;
    lab.appendChild(cb); lab.appendChild(el('span', null, lbl));
    wpnRow.appendChild(lab);
  }
  wrap.appendChild(wpnRow);

  // Aircraft list: row 0 is always the player.
  wrap.appendChild(el('div', 'color:#555;font-size:11px;margin-bottom:6px', S.aircraft));
  const list = el('div', 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px');
  wrap.appendChild(list);

  const defaultId = AIRCRAFT_IDS.includes('F-15J_EAGLE') ? 'F-15J_EAGLE' : AIRCRAFT_IDS[0];
  const defaultEnemy = AIRCRAFT_IDS.includes('F-18C_HORNET') ? 'F-18C_HORNET' : AIRCRAFT_IDS[0];

  function makeRow(isPlayer) {
    const row = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 11px;border:1px solid ' +
      (isPlayer ? '#003C74' : '#ACA899') + ';border-radius:2px;background:' + (isPlayer ? '#FFFFE1' : '#fff'));
    row.dataset.player = isPlayer ? '1' : '';
    const tag = el('span', 'font-size:12px;font-weight:700;color:' + (isPlayer ? '#0046D5' : '#555') + ';min-width:52px',
      isPlayer ? S.player : S.side);
    row.appendChild(tag);
    const sel = aircraftSelect(isPlayer ? defaultId : defaultEnemy);
    row._aircraft = sel;
    row.appendChild(sel);
    if (!isPlayer) {
      const sideSel = el('select', 'padding:6px 8px;border-radius:6px;border:1px solid #ACA899;background:#0b1119;color:#000;font-size:13px');
      for (const s of SIDES()) { const o = el('option', null, s.label); o.value = String(s.iff); sideSel.appendChild(o); }
      sideSel.value = '1';
      row._side = sideSel;
      row.appendChild(sideSel);
      const rm = el('button', 'margin-left:auto;padding:5px 9px;border:1px solid #9C6A66;border-radius:3px;background:linear-gradient(180deg,#FFFFFF,#E7E3D3);color:#C33B1E;cursor:pointer;font-size:12px', S.remove);
      rm.addEventListener('click', () => row.remove());
      row.appendChild(rm);
    }
    return row;
  }

  list.appendChild(makeRow(true));

  const addBtn = el('button', 'padding:8px 12px;border:1px dashed #7F9DB9;border-radius:2px;background:#fff;color:#0046D5;cursor:pointer;font-size:13px;margin-bottom:22px', S.addAi);
  addBtn.addEventListener('click', () => list.appendChild(makeRow(false)));
  wrap.appendChild(addBtn);

  // Ground objects: a preset scattered around a ground start position of the
  // selected field.  Hidden when stock/fields.json has no ground start for the
  // field (nowhere safe to anchor — GNDPOSIT is absolute, no terrain snap).
  const gndBox = el('div', 'margin-bottom:22px');
  gndBox.appendChild(el('div', 'color:#555;font-size:11px;margin-bottom:6px', S.ground));
  const gndRow = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 11px;border:1px solid #ACA899;border-radius:2px;background:#fff');
  const selCss = 'padding:6px 8px;border-radius:2px;border:1px solid #7F9DB9;background:#fff;color:#000;font-size:13px';
  const gndPreset = el('select', selCss);
  gndPreset.id = 'ysfw-ground-preset';
  { const o = el('option', null, S.groundNone); o.value = ''; gndPreset.appendChild(o); }
  for (const p of GROUND_PRESETS()) { const o = el('option', null, p.label); o.value = p.key; gndPreset.appendChild(o); }
  const gndAtLbl = el('span', 'font-size:12px;color:#555', S.groundAt);
  const gndAnchor = el('select', selCss);
  gndAnchor.id = 'ysfw-ground-anchor';
  const gndSide = el('select', selCss);
  for (const s of SIDES()) { const o = el('option', null, s.label); o.value = String(s.iff); gndSide.appendChild(o); }
  gndSide.value = '1';
  gndRow.appendChild(gndPreset); gndRow.appendChild(gndAtLbl); gndRow.appendChild(gndAnchor); gndRow.appendChild(gndSide);
  gndBox.appendChild(gndRow);
  wrap.appendChild(gndBox);
  function refreshAnchors() {
    const stps = groundStps(FIELD_STPS[fieldSel.value]);
    gndAnchor.textContent = '';
    for (const s of stps) { const o = el('option', null, s.n); o.value = s.n; gndAnchor.appendChild(o); }
    gndBox.style.display = stps.length ? '' : 'none';
    if (!stps.length) gndPreset.value = '';
  }
  fieldSel.addEventListener('change', refreshAnchors);
  refreshAnchors();

  // Fly.
  const flyBtn = el('button', 'display:block;width:100%;padding:12px;border:1px solid #003C74;border-radius:3.5px;background:linear-gradient(180deg,#FFFFFF,#E5E1CE);color:#000;font-size:15px;font-weight:700;box-shadow:inset 0 0 0 2px rgba(70,120,210,.55);cursor:pointer', S.fly);
  const err = el('div', 'color:#e78;font-size:12px;margin-top:8px;min-height:16px');
  flyBtn.addEventListener('click', () => {
    const f = fieldFor(fieldSel.value) || FIELDS[0];
    const rows = Array.from(list.children);
    const aircraft = rows.map((row) => {
      const isPlayer = !!row.dataset.player;
      return {
        id: row._aircraft.value,
        player: isPlayer,
        iff: isPlayer ? 0 : parseInt(row._side.value, 10),
        // Player starts at the field's known-good position; AI start airborne
        // so they are immediately in play regardless of the field.
        startPos: isPlayer ? f.start : 'NORTH10000_01',
      };
    });
    const spec = {
      field: f.id,
      env: timeSel.value,
      weapons: { gun: wpn.gun.checked, aam: wpn.aam.checked, agm: wpn.agm.checked, bomb: wpn.bomb.checked, rocket: wpn.rocket.checked },
      aircraft,
    };
    // Ground preset -> concrete placements around the chosen anchor (same y:
    // the anchor comes from the .stp, so it is on the ground; see yfs.js).
    const preset = GROUND_PRESETS().find((p) => p.key === gndPreset.value);
    const anchor = groundStps(FIELD_STPS[f.id]).find((s) => s.n === gndAnchor.value);
    if (preset && anchor) {
      spec.ground = preset.objs.map((o) => ({
        id: o.id,
        x: anchor.x + o.dx, y: anchor.y, z: anchor.z + o.dz,
        h: anchor.h || 0,
        iff: parseInt(gndSide.value, 10),
      }));
    }
    try {
      buildYfs(spec);  // validate before navigating (throws on a bad spec)
      sessionStorage.setItem('ysfwCreateFlight', JSON.stringify(spec));
      location.assign(pageUrl('index.html', { createflight: '1', return: 'studio-flight.html' }));
    } catch (e) {
      err.textContent = S.needPlayer;
    }
  });
  wrap.appendChild(flyBtn);
  wrap.appendChild(err);
}

(async function () {
  try {
    const idx = await stockIndex();
    AIRCRAFT_IDS = idx.map((a) => a.identify).filter(Boolean).sort();
  } catch (e) {
    AIRCRAFT_IDS = ['F-15J_EAGLE', 'F-18C_HORNET'];
  }
  try { FIELD_STPS = await stockFields(); } catch (e) { FIELD_STPS = {}; }
  render(document.body);
  window.ysfwCreateFlightReady = true;  // smoke-test signal
})();
