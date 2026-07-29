// Settings page — a web replacement for the engine's Option menu (web-shell
// direction, docs/web-shell.md).  Edits a curated set of flight.cfg options and
// stores them in localStorage; index.html merges them into the engine's
// flight.cfg on every boot (web/settings.js mergeFlightCfg).  Engine-less.
import { ACCENT, LANG, pageUrl } from './studio-shared.js';

// settings.js is a classic script (globalThis.ysfwSettings), loaded first by
// studio-settings.html.
const { MANAGED, normalize } = globalThis.ysfwSettings;
const STORE_KEY = 'ysfwSettings';

const S = ({
  ja: {
    title: '⚙️ 設定',
    sub: '見た目と表示の設定。変更は自動保存され、次の飛行から反映されます。',
    back: '← 戻る', reset: '既定に戻す',
    DRWSHADOW: '影を描画', DRAWCLOUD: '雲を描画', HRIZNGRAD: '地平線グラデーション',
    ANTIALIAS: 'アンチエイリアス', SMKPARTCL: '煙をパーティクルで描画', SIMPLEHUD: 'シンプルHUD',
    VISIBILIT: '視程', AIRLVODTL: '機体の描画品質',
    AIRLVODTL_OPTS: ['自動', '常に高品質', '常に簡易'],
    SMOKETYPE: '煙のタイプ', CLOUDTYPE: '雲のタイプ', ZBUFFQUAL: 'Zバッファ品質',
    ZBUFFQUAL_OPTS: ['0（速い）', '1（標準）', '2（高）', '3（最高）'],
    HUDALWAYS: 'HUDを常に表示', SHOWKIAS_: '速度をIASで表示', FRMPERSEC: 'FPSを表示',
    DRAWVJSTK: '仮想スティックを表示',
    GBLACKOUT: 'ブラックアウト（G効果）', MIDAIRCOL: '空中衝突', NOTAILSTK: '尾部接地から保護',
    LANDANWHR: 'どこでも着陸可',
    choice: {
      SMOKETYPE: { TOWEL: '帯', SOLID: '立体', NULL: 'なし' },
      CLOUDTYPE: { NONE: 'なし', FLAT: '平面', SOLID: '立体' },
    },
    secDisplay: '表示・描画', secGameplay: 'ゲームプレイ',
    km: (v) => (v / 1000).toFixed(1) + ' km',
    saved: '保存しました',
  },
  en: {
    title: '⚙️ Settings',
    sub: 'Look & display options. Changes save automatically and apply from your next flight.',
    back: '← Back', reset: 'Reset to defaults',
    DRWSHADOW: 'Draw shadows', DRAWCLOUD: 'Draw clouds', HRIZNGRAD: 'Horizon gradation',
    ANTIALIAS: 'Anti-aliasing', SMKPARTCL: 'Smoke as particles', SIMPLEHUD: 'Simple HUD',
    VISIBILIT: 'Visibility', AIRLVODTL: 'Airplane graphics',
    AIRLVODTL_OPTS: ['Automatic', 'Always high quality', 'Always coarse'],
    SMOKETYPE: 'Smoke type', CLOUDTYPE: 'Cloud type', ZBUFFQUAL: 'Z-buffer quality',
    ZBUFFQUAL_OPTS: ['0 (fast)', '1 (default)', '2 (high)', '3 (highest)'],
    HUDALWAYS: 'Always show HUD', SHOWKIAS_: 'Airspeed as IAS', FRMPERSEC: 'Show FPS',
    DRAWVJSTK: 'Show virtual stick',
    GBLACKOUT: 'Blackout (G effects)', MIDAIRCOL: 'Mid-air collision', NOTAILSTK: 'Tail-strike protection',
    LANDANWHR: 'Land anywhere',
    choice: {
      SMOKETYPE: { TOWEL: 'Ribbon', SOLID: 'Solid', NULL: 'None' },
      CLOUDTYPE: { NONE: 'None', FLAT: 'Flat', SOLID: 'Solid' },
    },
    secDisplay: 'Display', secGameplay: 'Gameplay',
    km: (v) => (v / 1000).toFixed(1) + ' km',
    saved: 'Saved',
  },
})[LANG] || {};

function load() {
  try { return normalize(JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
  catch (e) { return normalize({}); }
}
function save(values) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(values)); } catch (e) {}
}

const el = (tag, css, text) => {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
};

function render(root) {
  document.body.style.cssText = 'margin:0;background:#0b1119;color:#e6edf3;font-family:system-ui,sans-serif';
  const wrap = el('div', 'max-width:560px;margin:0 auto;padding:20px 16px 48px');
  root.appendChild(wrap);

  const back = el('a', 'color:' + ACCENT + ';font-size:13px;text-decoration:none', S.back);
  back.href = pageUrl('index.html');
  wrap.appendChild(back);

  wrap.appendChild(el('h1', 'font-size:22px;margin:10px 0 2px', S.title));
  wrap.appendChild(el('div', 'color:#8fa3bb;font-size:13px;margin-bottom:18px', S.sub));

  const values = load();
  const savedTag = el('div', 'color:#6ee7a8;font-size:12px;min-height:16px;margin-bottom:8px');

  const flash = () => {
    savedTag.textContent = S.saved;
    setTimeout(() => { savedTag.textContent = ''; }, 1200);
  };
  const set = (key, v) => { values[key] = v; save(values); flash(); };

  const list = el('div', 'display:flex;flex-direction:column;gap:2px');
  wrap.appendChild(list);
  const rowCss = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 12px;border:1px solid #243244;border-radius:8px;background:#0d141d';
  // Section headers, keyed by the first MANAGED key of each section.
  const HEADS = { DRWSHADOW: S.secDisplay, GBLACKOUT: S.secGameplay };
  // Rebuildable so Reset can redraw every control from the defaults.
  function buildRows() {
    list.textContent = '';
    for (const m of MANAGED) {
      if (HEADS[m.key]) {
        list.appendChild(el('div', 'color:#8fa3bb;font-size:11px;margin:10px 0 4px', HEADS[m.key]));
      }
      if (m.type === 'bool') {
        const row = el('label', rowCss + ';cursor:pointer');
        row.appendChild(el('span', 'font-size:14px', S[m.key] || m.key));
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = values[m.key];
        cb.style.cssText = 'width:18px;height:18px;cursor:pointer';
        cb.addEventListener('change', () => set(m.key, cb.checked));
        row.appendChild(cb);
        list.appendChild(row);
      } else if (m.type === 'length') {
        // Slider in engine bounds; live km readout.
        const row = el('label', rowCss + ';cursor:pointer');
        row.appendChild(el('span', 'font-size:14px;white-space:nowrap', S[m.key] || m.key));
        const box = el('div', 'display:flex;align-items:center;gap:10px;flex:1;justify-content:flex-end');
        const out = el('span', 'font-size:13px;color:#8fa3bb;min-width:56px;text-align:right', S.km(values[m.key]));
        const sl = el('input'); sl.type = 'range'; sl.id = 'ysfw-set-' + m.key;
        sl.min = String(m.min); sl.max = String(m.max); sl.step = '100';
        sl.value = String(values[m.key]);
        sl.style.cssText = 'flex:1;max-width:220px;accent-color:' + ACCENT;
        sl.addEventListener('input', () => {
          out.textContent = S.km(Number(sl.value));
          set(m.key, Number(sl.value));
        });
        box.appendChild(sl); box.appendChild(out);
        row.appendChild(box);
        list.appendChild(row);
      } else if (m.type === 'choice') { // string-token select
        const row = el('label', rowCss);
        row.appendChild(el('span', 'font-size:14px', S[m.key] || m.key));
        const sel = el('select'); sel.id = 'ysfw-set-' + m.key;
        sel.style.cssText = 'font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid #2a3647;background:#0d141d;color:#e6edf3;cursor:pointer';
        const labels = (S.choice || {})[m.key] || {};
        for (const v of m.values) {
          const o = el('option', null, labels[v] || v);
          o.value = v;
          sel.appendChild(o);
        }
        sel.value = values[m.key];
        sel.addEventListener('change', () => set(m.key, sel.value));
        row.appendChild(sel);
        list.appendChild(row);
      } else { // enum
        const row = el('label', rowCss);
        row.appendChild(el('span', 'font-size:14px', S[m.key] || m.key));
        const sel = el('select'); sel.id = 'ysfw-set-' + m.key;
        sel.style.cssText = 'font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid #2a3647;background:#0d141d;color:#e6edf3;cursor:pointer';
        const labels = S[m.key + '_OPTS'] || [];
        for (let i = 0; i < m.count; i++) {
          const o = el('option', null, labels[i] || String(i));
          o.value = String(i);
          sel.appendChild(o);
        }
        sel.value = String(values[m.key]);
        sel.addEventListener('change', () => set(m.key, Number(sel.value)));
        row.appendChild(sel);
        list.appendChild(row);
      }
    }
  }
  buildRows();
  wrap.appendChild(el('div', 'height:8px'));
  wrap.appendChild(savedTag);

  const reset = el('button', 'padding:8px 12px;border:1px solid #243244;border-radius:8px;background:transparent;color:#8fa3bb;cursor:pointer;font-size:13px', S.reset);
  reset.addEventListener('click', () => {
    const def = normalize({});
    save(def);
    for (const k of Object.keys(def)) values[k] = def[k];
    buildRows();
    flash();
  });
  wrap.appendChild(reset);
}

render(document.body);
window.ysfwSettingsReady = true;  // smoke-test signal
