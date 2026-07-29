// Controls page — a web replacement for the engine's key-assignment /
// calibration menus (web-shell increment 13).  Assigns GAMEPAD axes and
// buttons by capture ("move the stick / press the button"), plus dead zones;
// stores the model in localStorage and index.html merges it into the engine's
// ctlassign.cfg on every boot (web/controls.js mergeCtlAssign).  Engine-less.
//
// Calibration has no web counterpart on purpose: the port feeds the Gamepad
// API's already-normalized axes to the engine (see controls.js header), so
// REV + dead zones are the whole story here.
import { ACCENT, LANG, pageUrl } from './studio-shared.js';

const { AXIS_FUNCS, BUTTON_FUNCS, gamepadPreset, normalize } = globalThis.ysfwControls;
const STORE_KEY = 'ysfwControls';

const S = ({
  ja: {
    title: '🕹️ コントローラ設定',
    sub: 'ゲームパッド/スティックの割当。変更は自動保存され、次の飛行から反映されます。キーボード・マウスの割当はそのまま残ります。',
    back: '← 戻る', reset: '割当をすべて消す', preset: 'ゲームパッド標準を適用',
    noPad: 'コントローラが見つかりません。接続してボタンをどれか押してください。',
    padLabel: '対象デバイス',
    axes: '軸', buttons: 'ボタン', dz: 'デッドゾーン',
    capture: '割当', captureAxis: 'スティックを動かして…', captureBtn: 'ボタンを押して…',
    unbound: '（未割当）', clear: '解除', rev: '反転',
    axisName: (d, a) => `パッド${d} 軸${a}`, btnName: (d, b) => `パッド${d} B${b}`,
    AILERON: 'エルロン（ロール）', ELEVATOR: 'エレベータ（ピッチ）', THROTTLE: 'スロットル（絶対）',
    THROTTLEUPDOWN: 'スロットル（増減）', RUDDER: 'ラダー（ヨー）',
    FIREWEAPON: '発射', SELECTWEAPON: '武器切替', RADAR: 'レーダー', DISPENSEFLARE: 'フレア',
    LANDINGGEAR: 'ギア', FLAP: 'フラップ', SPOILERBRAKE: 'スポイラー＆ブレーキ', AFTERBURNER: 'アフターバーナー',
    AUTOTRIM: 'オートトリム', THROTTLEUP: 'スロットル＋', THROTTLEDOWN: 'スロットル−', REVERSETHRUST: '逆噴射',
    COCKPITVIEW: 'コックピット視点', OUTSIDEPLAYERVIEW: '外部視点', PAUSESIMULATION: 'ポーズ',
    dzElv: 'エレベータ', dzAil: 'エルロン', dzRud: 'ラダー',
    saved: '保存しました',
    calibNote: '※ 較正（キャリブレーション）はweb版では不要です — ブラウザのGamepad APIが正規化済みの値を返すため、反転とデッドゾーンだけで整います。キーボードとマウスの割当はエンジン既定のまま保たれます。',
  },
  en: {
    title: '🕹️ Controller Setup',
    sub: 'Gamepad / stick assignments. Changes save automatically and apply from your next flight. Keyboard and mouse bindings are left untouched.',
    back: '← Back', reset: 'Clear all bindings', preset: 'Apply gamepad defaults',
    noPad: 'No controller detected. Connect one and press any button.',
    padLabel: 'Target device',
    axes: 'Axes', buttons: 'Buttons', dz: 'Dead zones',
    capture: 'Assign', captureAxis: 'Move the stick…', captureBtn: 'Press a button…',
    unbound: '(unbound)', clear: 'Clear', rev: 'Reverse',
    axisName: (d, a) => `Pad ${d} axis ${a}`, btnName: (d, b) => `Pad ${d} B${b}`,
    AILERON: 'Aileron (roll)', ELEVATOR: 'Elevator (pitch)', THROTTLE: 'Throttle (absolute)',
    THROTTLEUPDOWN: 'Throttle (rate)', RUDDER: 'Rudder (yaw)',
    FIREWEAPON: 'Fire', SELECTWEAPON: 'Select weapon', RADAR: 'Radar', DISPENSEFLARE: 'Flare',
    LANDINGGEAR: 'Landing gear', FLAP: 'Flaps', SPOILERBRAKE: 'Spoiler & brake', AFTERBURNER: 'Afterburner',
    AUTOTRIM: 'Auto trim', THROTTLEUP: 'Throttle +', THROTTLEDOWN: 'Throttle −', REVERSETHRUST: 'Reverse thrust',
    COCKPITVIEW: 'Cockpit view', OUTSIDEPLAYERVIEW: 'Outside view', PAUSESIMULATION: 'Pause',
    dzElv: 'Elevator', dzAil: 'Aileron', dzRud: 'Rudder',
    saved: 'Saved',
    calibNote: '* Calibration is not needed on the web — the browser Gamepad API already returns normalized values; Reverse + dead zones cover the rest. Keyboard and mouse keep their engine defaults.',
  },
})[LANG] || {};

function load() {
  try { return normalize(JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
  catch (e) { return normalize({}); }
}
function save(model) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(model)); } catch (e) {}
}

const el = (tag, css, text) => {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
};

function pads() {
  const out = [];
  const gs = (navigator.getGamepads && navigator.getGamepads()) || [];
  for (const g of gs) if (g && g.connected) out.push(g);
  return out;
}

function render(root) {
  document.body.style.cssText = 'margin:0;background:#0b1119;color:#e6edf3;font-family:system-ui,sans-serif';
  const wrap = el('div', 'max-width:640px;margin:0 auto;padding:20px 16px 48px');
  root.appendChild(wrap);

  const back = el('a', 'color:' + ACCENT + ';font-size:13px;text-decoration:none', S.back);
  back.href = pageUrl('index.html');
  wrap.appendChild(back);
  wrap.appendChild(el('h1', 'font-size:22px;margin:10px 0 2px', S.title));
  wrap.appendChild(el('div', 'color:#8fa3bb;font-size:13px;margin-bottom:14px', S.sub));

  const model = load();
  const savedTag = el('div', 'color:#6ee7a8;font-size:12px;min-height:16px;margin:8px 0');
  const flash = () => { savedTag.textContent = S.saved; setTimeout(() => { savedTag.textContent = ''; }, 1200); };
  const persist = () => { save(model); flash(); };

  // ---- Device row: connected pads + live nudge to press a button ------------
  const padRow = el('div', 'display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap');
  const padSel = el('select', 'padding:7px 9px;border-radius:6px;border:1px solid #243244;background:#0d141d;color:#e6edf3;font-size:13px;max-width:320px');
  padSel.id = 'ysfw-ctl-pad';
  const padNote = el('span', 'color:#8fa3bb;font-size:12px', S.noPad);
  padRow.appendChild(el('span', 'color:#8fa3bb;font-size:12px;white-space:nowrap', S.padLabel));
  padRow.appendChild(padSel);
  padRow.appendChild(padNote);
  wrap.appendChild(padRow);
  function refreshPads() {
    const cur = padSel.value;
    padSel.textContent = '';
    for (const g of pads()) {
      const o = el('option', null, g.index + ': ' + (g.id || 'gamepad').slice(0, 40));
      o.value = String(g.index);
      padSel.appendChild(o);
    }
    if (cur && [...padSel.options].some((o) => o.value === cur)) padSel.value = cur;
    padNote.style.display = padSel.options.length ? 'none' : '';
  }
  window.addEventListener('gamepadconnected', refreshPads);
  window.addEventListener('gamepaddisconnected', refreshPads);
  refreshPads();
  const curDev = () => Math.min(6, Math.max(0, parseInt(padSel.value || '0', 10) || 0));

  // ---- Capture machinery ----------------------------------------------------
  // Axis capture: sample all pads' axes, assign on the axis with the biggest
  // travel from its starting value (>0.5).  Button capture: first press wins.
  let capture = null; // { kind:'axis'|'btn', func, label, base:[[..axes]], done }
  function startCapture(kind, func, labelEl) {
    if (capture) capture.cancel();
    const gs = pads();
    capture = {
      kind, func, labelEl,
      base: gs.map((g) => [...g.axes]),
      idx: gs.map((g) => g.index),
      cancel() { capture = null; renderLists(); },
    };
    labelEl.textContent = kind === 'axis' ? S.captureAxis : S.captureBtn;
  }
  function pollCapture() {
    if (!capture) return;
    const gs = pads();
    for (let gi = 0; gi < gs.length; gi++) {
      const g = gs[gi];
      const bi = capture.idx.indexOf(g.index);
      if (capture.kind === 'axis' && bi !== -1) {
        for (let a = 0; a < Math.min(6, g.axes.length); a++) {
          const delta = Math.abs(g.axes[a] - (capture.base[bi][a] || 0));
          if (delta > 0.5) {
            const dev = Math.min(6, g.index);
            model.axes = model.axes.filter((x) => x.func !== capture.func && !(x.dev === dev && x.axis === a));
            model.axes.push({ dev, axis: a, func: capture.func, rev: false });
            capture = null; persist(); renderLists();
            return;
          }
        }
      }
      if (capture.kind === 'btn') {
        for (let b = 0; b < Math.min(32, g.buttons.length); b++) {
          if (g.buttons[b].pressed) {
            const dev = Math.min(6, g.index);
            model.btns = model.btns.filter((x) => x.func !== capture.func && !(x.dev === dev && x.btn === b));
            model.btns.push({ dev, btn: b, func: capture.func });
            capture = null; persist(); renderLists();
            return;
          }
        }
      }
    }
  }
  setInterval(pollCapture, 50);

  // ---- Assignment lists -----------------------------------------------------
  const rowCss = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border:1px solid #243244;border-radius:8px;background:#0d141d;flex-wrap:wrap';
  const secCss = 'color:#8fa3bb;font-size:11px;margin:12px 0 4px';
  const axList = el('div', 'display:flex;flex-direction:column;gap:2px');
  const btList = el('div', 'display:flex;flex-direction:column;gap:2px');
  wrap.appendChild(el('div', secCss, S.axes));
  wrap.appendChild(axList);
  wrap.appendChild(el('div', secCss, S.buttons));
  wrap.appendChild(btList);

  function bindingRow(func, isAxis) {
    const row = el('div', rowCss);
    row.appendChild(el('span', 'font-size:14px;min-width:150px', S[func] || func));
    const cur = isAxis ? model.axes.find((x) => x.func === func) : model.btns.find((x) => x.func === func);
    const lab = el('span', 'font-size:12px;color:' + (cur ? '#6ee7a8' : '#5b6b80') + ';min-width:110px',
      cur ? (isAxis ? S.axisName(cur.dev, cur.axis) : S.btnName(cur.dev, cur.btn)) : S.unbound);
    row.appendChild(lab);
    const box = el('div', 'display:flex;align-items:center;gap:8px');
    if (isAxis && cur) {
      const revLab = el('label', 'display:flex;align-items:center;gap:4px;font-size:12px;color:#8fa3bb;cursor:pointer');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!cur.rev;
      cb.addEventListener('change', () => { cur.rev = cb.checked; persist(); });
      revLab.appendChild(cb); revLab.appendChild(el('span', null, S.rev));
      box.appendChild(revLab);
    }
    const cap = el('button', 'font-size:12px;padding:5px 10px;border-radius:6px;border:1px solid #2a3647;background:#13202f;color:' + ACCENT + ';cursor:pointer', S.capture);
    cap.addEventListener('click', () => startCapture(isAxis ? 'axis' : 'btn', func, lab));
    box.appendChild(cap);
    if (cur) {
      const clr = el('button', 'font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid #40222a;background:#1a0f13;color:#e78;cursor:pointer', S.clear);
      clr.addEventListener('click', () => {
        if (isAxis) model.axes = model.axes.filter((x) => x.func !== func);
        else model.btns = model.btns.filter((x) => x.func !== func);
        persist(); renderLists();
      });
      box.appendChild(clr);
    }
    row.appendChild(box);
    return row;
  }
  function renderLists() {
    axList.textContent = '';
    for (const f of AXIS_FUNCS) axList.appendChild(bindingRow(f, true));
    btList.textContent = '';
    for (const f of BUTTON_FUNCS) btList.appendChild(bindingRow(f, false));
  }
  renderLists();

  // ---- Dead zones -----------------------------------------------------------
  wrap.appendChild(el('div', secCss, S.dz));
  const dzBox = el('div', 'display:flex;flex-direction:column;gap:2px');
  wrap.appendChild(dzBox);
  for (const [key, label] of [['elv', S.dzElv], ['ail', S.dzAil], ['rud', S.dzRud]]) {
    const row = el('label', rowCss + ';cursor:pointer');
    row.appendChild(el('span', 'font-size:14px', label));
    const box = el('div', 'display:flex;align-items:center;gap:10px;flex:1;justify-content:flex-end');
    const out = el('span', 'font-size:12px;color:#8fa3bb;min-width:44px;text-align:right',
      model.dz[key] != null ? model.dz[key].toFixed(3) : '—');
    const sl = el('input'); sl.type = 'range'; sl.id = 'ysfw-ctl-dz-' + key;
    sl.min = '0'; sl.max = '0.2'; sl.step = '0.005';
    sl.value = String(model.dz[key] != null ? model.dz[key] : 0.03);
    sl.style.cssText = 'flex:1;max-width:200px;accent-color:' + ACCENT;
    sl.addEventListener('input', () => {
      model.dz[key] = Number(sl.value);
      out.textContent = model.dz[key].toFixed(3);
      persist();
    });
    box.appendChild(sl); box.appendChild(out);
    row.appendChild(box);
    dzBox.appendChild(row);
  }

  wrap.appendChild(savedTag);

  // ---- Preset / reset -------------------------------------------------------
  const btnRow = el('div', 'display:flex;gap:10px;margin-top:6px;flex-wrap:wrap');
  const presetBtn = el('button', 'padding:8px 12px;border:1px solid #2a3647;border-radius:8px;background:#13202f;color:' + ACCENT + ';cursor:pointer;font-size:13px', S.preset);
  presetBtn.id = 'ysfw-ctl-preset';
  presetBtn.addEventListener('click', () => {
    const p = gamepadPreset(curDev());
    model.axes = p.axes; model.btns = p.btns; model.dz = p.dz;
    persist(); renderLists();
  });
  const resetBtn = el('button', 'padding:8px 12px;border:1px solid #243244;border-radius:8px;background:transparent;color:#8fa3bb;cursor:pointer;font-size:13px', S.reset);
  resetBtn.addEventListener('click', () => {
    model.axes = []; model.btns = []; model.dz = { elv: null, ail: null, rud: null };
    persist(); renderLists();
  });
  btnRow.appendChild(presetBtn); btnRow.appendChild(resetBtn);
  wrap.appendChild(btnRow);

  wrap.appendChild(el('div', 'color:#7d93b0;font-size:11.5px;line-height:1.5;margin-top:14px', S.calibNote));
}

render(document.body);
window.ysfwControlsReady = true;  // smoke-test signal
