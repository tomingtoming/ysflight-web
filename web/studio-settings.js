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
    saved: '保存しました',
  },
  en: {
    title: '⚙️ Settings',
    sub: 'Look & display options. Changes save automatically and apply from your next flight.',
    back: '← Back', reset: 'Reset to defaults',
    DRWSHADOW: 'Draw shadows', DRAWCLOUD: 'Draw clouds', HRIZNGRAD: 'Horizon gradation',
    ANTIALIAS: 'Anti-aliasing', SMKPARTCL: 'Smoke as particles', SIMPLEHUD: 'Simple HUD',
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

  const list = el('div', 'display:flex;flex-direction:column;gap:2px');
  wrap.appendChild(list);
  for (const m of MANAGED) {
    const row = el('label', 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 12px;border:1px solid #243244;border-radius:8px;background:#0d141d;cursor:pointer');
    row.appendChild(el('span', 'font-size:14px', S[m.key] || m.key));
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = values[m.key];
    cb.style.cssText = 'width:18px;height:18px;cursor:pointer';
    cb.addEventListener('change', () => {
      values[m.key] = cb.checked;
      save(values);
      savedTag.textContent = S.saved;
      setTimeout(() => { savedTag.textContent = ''; }, 1200);
    });
    row.appendChild(cb);
    list.appendChild(row);
  }
  wrap.appendChild(el('div', 'height:8px'));
  wrap.appendChild(savedTag);

  const reset = el('button', 'padding:8px 12px;border:1px solid #243244;border-radius:8px;background:transparent;color:#8fa3bb;cursor:pointer;font-size:13px', S.reset);
  reset.addEventListener('click', () => {
    const def = normalize({});
    save(def);
    for (const k of Object.keys(def)) values[k] = def[k];
    // Re-render checkboxes.
    const boxes = list.querySelectorAll('input[type=checkbox]');
    MANAGED.forEach((m, i) => { if (boxes[i]) boxes[i].checked = def[m.key]; });
    savedTag.textContent = S.saved;
    setTimeout(() => { savedTag.textContent = ''; }, 1200);
  });
  wrap.appendChild(reset);
}

render(document.body);
window.ysfwSettingsReady = true;  // smoke-test signal
