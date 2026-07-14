// studio-dat.js — non-destructive .dat (flight model) editor for the aircraft studio.
//
// Public API:
//   parseDat(bytes)            -> { lines, parsed }
//   serializeDat(parsed)       -> Uint8Array
//   editDatKey(parsed, kw, valueStr, occurrenceIdx) -> parsed  (mutates in place)
//   mountDatEditor(container, { getBytes, setBytes, LANG, el, row })
//
// Non-destructive contract:
//   parseDat -> serializeDat with no edits must produce byte-identical output.
//   Form edits only replace the specific line the keyword was on.
//   Unknown keywords and REM lines are preserved exactly.
//   Line order of existing lines never changes.

import { DAT_SCHEMA, SCHEMA_BY_KW, DAT_CATEGORIES } from './dat-schema.js';

// --- latin1 codec (byte-preserving, same as workbench.js) ---
const b2s = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const s2b = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

// --- splitUnit ------------------------------------------------------------------
//
// Stock .dat values carry unit suffixes the engine parses (FsGetForce/FsGetSpeed/
// FsGetAngle...): '2.2MACH', '13.6t', '0.35rad', '100%', '-12.5deg'.  A bare
// number falls back to the DEFAULT unit (N, m/s, rad...), so dropping the
// suffix silently rescales the value — 13.6t would become 13.6 NEWTONS.
// Split a value into { num, suffix } so form edits can preserve the suffix;
// num === null means the value doesn't start with a number (fallback to raw text).
// Invariant for parseable values: num + suffix === valueStr.trim().
//
export function splitUnit(valueStr) {
  const m = /^(-?[0-9]*\.?[0-9]+)(.*)$/.exec(String(valueStr).trim());
  if (!m) return { num: null, suffix: '' };
  return { num: m[1], suffix: m[2] };
}

// --- parseDat -------------------------------------------------------------------
//
// Returns:
//   lines  : string[] — original lines (split on \n, \r kept if present)
//   parsed : Map<string, Array<{lineIdx, rawLine, value}>>
//            key = keyword (uppercase); 'REM' also collects blank lines
//
export function parseDat(bytes) {
  const text = b2s(bytes);
  // Split on \n only; lines may carry a trailing \r (\r\n files).
  const lines = text.split('\n');
  const parsed = new Map();

  const push = (kw, lineIdx, rawLine, value) => {
    if (!parsed.has(kw)) parsed.set(kw, []);
    parsed.get(kw).push({ lineIdx, rawLine, value });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('REM')) {
      push('REM', i, raw, trimmed.slice(3).trim());
      continue;
    }
    // First whitespace-delimited token is the keyword; rest is the value string.
    const spaceIdx = trimmed.search(/\s/);
    const kw = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
    const value = spaceIdx < 0 ? '' : trimmed.slice(spaceIdx + 1).trim();
    push(kw.toUpperCase(), i, raw, value);
  }

  return { lines, parsed };
}

// --- serializeDat ---------------------------------------------------------------
//
// Join lines with \n and encode to Uint8Array via latin1.
// CRITICAL: a round-trip parseDat->serializeDat with no edits must be byte-identical.
//
export function serializeDat(parsed) {
  return s2b(parsed.lines.join('\n'));
}

// --- editDatKey -----------------------------------------------------------------
//
// Find the occurrenceIdx-th occurrence of kw in parsed.parsed, replace that
// line in parsed.lines[], and update the parsed entry.
// If kw is not present, append a new line at the end.
// Returns the (mutated) parsed object.
//
export function editDatKey(parsed, kw, valueStr, occurrenceIdx) {
  if (occurrenceIdx === undefined) occurrenceIdx = 0;
  const entries = parsed.parsed.get(kw);
  const newLine = kw + ' ' + valueStr;
  if (entries && entries.length > occurrenceIdx) {
    const entry = entries[occurrenceIdx];
    // Preserve any inline comment after the value (text after # not preceded by kw-value).
    // Simple approach: replace the whole line, inline comments are rare in .dat.
    parsed.lines[entry.lineIdx] = newLine;
    entry.rawLine = newLine;
    entry.value = valueStr;
  } else {
    // Append new line.
    const lineIdx = parsed.lines.length;
    // Remove trailing empty line if any, then append, then restore trailing newline.
    const hasTrailingEmpty = parsed.lines[parsed.lines.length - 1] === '';
    if (hasTrailingEmpty) {
      parsed.lines.splice(parsed.lines.length - 1, 0, newLine);
      // lineIdx stays as-is (new line is before the empty one)
      if (!parsed.parsed.has(kw)) parsed.parsed.set(kw, []);
      parsed.parsed.get(kw).push({ lineIdx: parsed.lines.length - 2, rawLine: newLine, value: valueStr });
    } else {
      parsed.lines.push(newLine);
      if (!parsed.parsed.has(kw)) parsed.parsed.set(kw, []);
      parsed.parsed.get(kw).push({ lineIdx, rawLine: newLine, value: valueStr });
    }
  }
  return parsed;
}

// --- mountDatEditor -------------------------------------------------------------
//
// Mounts a two-tab UI into `container`:
//   Tab 0: category-sectioned form (フォーム / Form)
//   Tab 1: raw latin1 text textarea (生テキスト / Raw text)
//
// Options:
//   getBytes()          -> Uint8Array | null — read current .dat bytes
//   setBytes(bytes)     — persist changed bytes
//   LANG                — 'ja' | 'en'
//   el(tag, cls, text)  — DOM helper
//   row(parent, label, input) — DOM helper
//
export function mountDatEditor(container, { getBytes, setBytes, LANG, el, row }) {
  const L = (ja, en) => LANG === 'ja' ? ja : en;

  // ---- outer frame ----
  const wrap = el('div');
  wrap.style.cssText = 'border:1px solid #2a3647;border-radius:8px;overflow:hidden;margin-top:8px';

  // ---- tab bar ----
  const tabBar = el('div');
  tabBar.style.cssText = 'display:flex;border-bottom:1px solid #2a3647;background:#0d141d';
  const mkTab = (label) => {
    const t = el('button', null, label);
    t.style.cssText = 'flex:1;padding:7px 10px;border:0;border-radius:0;background:transparent;' +
      'color:#8fa3bb;font-size:12.5px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s';
    return t;
  };
  const tabForm = mkTab(L('フォーム', 'Form'));
  const tabRaw  = mkTab(L('生テキスト', 'Raw text'));
  tabBar.appendChild(tabForm);
  tabBar.appendChild(tabRaw);
  wrap.appendChild(tabBar);

  // ---- content panels ----
  const panelForm = el('div');
  panelForm.style.cssText = 'padding:10px 12px;max-height:600px;overflow-y:auto';
  const panelRaw = el('div');
  panelRaw.style.cssText = 'display:none;padding:8px';

  const textarea = document.createElement('textarea');
  textarea.style.cssText = 'width:100%;height:400px;background:#0b1017;color:#e6edf3;' +
    'border:1px solid #2a3647;border-radius:6px;padding:8px;font-size:12px;font-family:monospace;resize:vertical';
  panelRaw.appendChild(textarea);

  const saveBtn = el('button', 'accent', L('保存 / Save', 'Save'));
  saveBtn.style.cssText = 'margin-top:8px;width:100%';
  panelRaw.appendChild(saveBtn);

  wrap.appendChild(panelForm);
  wrap.appendChild(panelRaw);
  container.appendChild(wrap);

  // ---- state ----
  let parsed = null; // { lines, parsed } from parseDat()

  // ---- tab switching ----
  let activeTab = 0;
  const switchTab = (idx) => {
    activeTab = idx;
    if (idx === 0) {
      tabForm.style.cssText = tabForm.style.cssText.replace('color:#8fa3bb', 'color:#4da3ff').replace('border-bottom:2px solid transparent', 'border-bottom:2px solid #4da3ff');
      tabRaw.style.cssText = tabRaw.style.cssText.replace('color:#4da3ff', 'color:#8fa3bb').replace('border-bottom:2px solid #4da3ff', 'border-bottom:2px solid transparent');
      panelForm.style.display = '';
      panelRaw.style.display = 'none';
    } else {
      tabRaw.style.cssText = tabRaw.style.cssText.replace('color:#8fa3bb', 'color:#4da3ff').replace('border-bottom:2px solid transparent', 'border-bottom:2px solid #4da3ff');
      tabForm.style.cssText = tabForm.style.cssText.replace('color:#4da3ff', 'color:#8fa3bb').replace('border-bottom:2px solid #4da3ff', 'border-bottom:2px solid transparent');
      panelForm.style.display = 'none';
      panelRaw.style.display = '';
      // Sync form state -> textarea
      if (parsed) textarea.value = parsed.lines.join('\n');
    }
  };

  // Initialize tab styles
  tabForm.style.color = '#4da3ff';
  tabForm.style.borderBottom = '2px solid #4da3ff';
  tabRaw.style.color = '#8fa3bb';
  tabRaw.style.borderBottom = '2px solid transparent';

  tabForm.addEventListener('click', () => switchTab(0));
  tabRaw.addEventListener('click', () => {
    if (parsed) textarea.value = parsed.lines.join('\n');
    switchTab(1);
  });

  // ---- raw tab save / re-parse on blur ----
  textarea.addEventListener('blur', () => {
    if (!parsed) return;
    parsed = parseDat(s2b(textarea.value));
    rebuildForm();
  });
  saveBtn.addEventListener('click', () => {
    if (!parsed) return;
    parsed = parseDat(s2b(textarea.value));
    setBytes(serializeDat(parsed));
  });

  // ---- sanity table ----
  const sanityDl = el('dl');
  sanityDl.style.cssText = 'margin:0 0 10px;padding:8px 10px;background:#0d141d;border:1px solid #2a3647;' +
    'border-radius:6px;font-size:12px;display:grid;grid-template-columns:auto 1fr;gap:2px 12px';

  const mkSanity = (label) => {
    const dt = el('dt', null, label);
    dt.style.cssText = 'color:#8fa3bb;margin:0;white-space:nowrap';
    const dd = el('dd', null, 'N/A');
    dd.style.cssText = 'color:#e6edf3;margin:0;font-variant-numeric:tabular-nums';
    sanityDl.appendChild(dt);
    sanityDl.appendChild(dd);
    return dd;
  };
  const sanityTWR = mkSanity(L('推力重量比 (T/W)', 'Thrust-to-weight ratio'));
  const sanityWL  = mkSanity(L('翼面荷重 (W/S kg/m²)', 'Wing loading (kg/m²)'));
  const sanityFF  = mkSanity(L('燃料比 (Mf / Mtotal)', 'Fuel fraction'));
  panelForm.appendChild(sanityDl);

  // ---- form sections ----
  const formSections = el('div');
  panelForm.appendChild(formSections);

  // ---- save button at bottom of form ----
  const formSaveBtn = el('button', 'accent', L('保存 / Save', 'Save'));
  formSaveBtn.style.cssText = 'margin-top:10px;width:100%';
  panelForm.appendChild(formSaveBtn);
  formSaveBtn.addEventListener('click', () => {
    if (!parsed) return;
    setBytes(serializeDat(parsed));
  });

  // ---- helper: get first numeric value of a keyword ----
  const numVal = (kw) => {
    const entries = parsed && parsed.parsed.get(kw);
    if (!entries || !entries.length) return null;
    const v = entries[0].value;
    // Strip units: trim trailing non-numeric suffix (t, kg, m, deg, rad, kt, m/s, mach, etc.)
    const m = v.match(/^-?[\d.]+/);
    return m ? parseFloat(m[0]) : null;
  };

  const updateSanity = () => {
    if (!parsed) { sanityTWR.textContent = 'N/A'; sanityWL.textContent = 'N/A'; sanityFF.textContent = 'N/A'; return; }
    const thrust = numVal('THRAFTBN');
    const clean  = numVal('WEIGHCLN');
    const fuel   = numVal('WEIGFUEL');
    const load   = numVal('WEIGLOAD');
    const wing   = numVal('WINGAREA');
    // The .dat uses suffix units (t, kg, N). Try to figure out the scale:
    // THRAFTBN in N or kg? WEIGHCLN in kg or t?
    // We just show raw ratio since units vary per file.
    if (thrust !== null && clean !== null && clean !== 0) {
      sanityTWR.textContent = (thrust / (clean * 9.81)).toFixed(2);
    } else if (thrust !== null && clean !== null && clean === 0) {
      sanityTWR.textContent = 'inf';
    } else {
      sanityTWR.textContent = 'N/A';
    }
    if (clean !== null && wing !== null && wing !== 0) {
      sanityWL.textContent = (clean / wing).toFixed(1) + ' kg/m²';
    } else {
      sanityWL.textContent = 'N/A';
    }
    if (fuel !== null && clean !== null) {
      const total = clean + (fuel || 0) + (load || 0);
      sanityFF.textContent = total > 0 ? (fuel / total).toFixed(3) : 'N/A';
    } else {
      sanityFF.textContent = 'N/A';
    }
  };

  // ---- category labels (bilingual) ----
  const CAT_LABEL = {
    id:      L('識別 / ID', 'Identification'),
    engine:  L('エンジン', 'Engine'),
    weight:  L('重量', 'Weight'),
    aero:    L('空力', 'Aerodynamics'),
    control: L('操縦', 'Control'),
    gear:    L('脚', 'Landing Gear'),
    weapon:  L('兵装', 'Weapons'),
    turret:  L('砲塔', 'Turrets'),
    smoke:   L('スモーク/フレア', 'Smoke / Flare'),
    cockpit: L('コックピット', 'Cockpit'),
    init:    L('初期値', 'Initial State'),
    perf:    L('性能参照', 'Performance Ref.'),
    meta:    L('メタ', 'Meta'),
  };

  // ---- rebuild form from parsed state ----
  function rebuildForm() {
    formSections.innerHTML = '';
    if (!parsed) return;
    updateSanity();

    // Group known keywords by category.
    const byCat = new Map();
    for (const cat of DAT_CATEGORIES) byCat.set(cat, []);

    const seenKws = new Set();

    for (const schema of DAT_SCHEMA) {
      if (schema.kw === 'REM') continue; // handled specially
      const entries = parsed.parsed.get(schema.kw) || [];
      byCat.get(schema.cat).push({ schema, entries });
      if (entries.length) seenKws.add(schema.kw);
    }

    // Unknown keywords: anything in parsed that's not in the schema and not REM.
    const unknownKws = [];
    for (const [kw] of parsed.parsed) {
      if (kw === 'REM') continue;
      if (!SCHEMA_BY_KW.has(kw)) unknownKws.push(kw);
    }

    // Build category sections.
    for (const cat of DAT_CATEGORIES) {
      const items = byCat.get(cat);
      // Only render categories that have at least one known or present keyword.
      const hasAny = items.some((item) => item.entries.length > 0);
      if (!hasAny && cat !== 'id') {
        // Still render if at least one schema entry is defined to allow adding.
        // For brevity, only render non-empty sections + always show 'id' and 'engine'.
        if (cat !== 'engine' && cat !== 'weight') continue;
      }

      const section = el('div');
      section.style.cssText = 'margin-bottom:12px';
      const h3 = el('h3', null, CAT_LABEL[cat]);
      h3.style.cssText = 'font-size:12px;font-weight:600;color:#4da3ff;margin:8px 0 4px;text-transform:uppercase;letter-spacing:.5px';
      section.appendChild(h3);

      for (const { schema, entries } of items) {
        if (schema.kw === 'REM') continue;
        const inputWrap = buildFieldInput(schema, entries, parsed);
        if (inputWrap) section.appendChild(inputWrap);
      }

      formSections.appendChild(section);
    }

    // Unknown keyword warning section.
    if (unknownKws.length) {
      const section = el('div');
      section.style.cssText = 'margin-bottom:12px';
      const h3 = el('h3');
      h3.style.cssText = 'font-size:12px;font-weight:600;color:#f0a030;margin:8px 0 4px';
      h3.textContent = L('未知のキーワード', 'Unknown keywords');
      section.appendChild(h3);
      const note = el('div', 'msg', L('以下の行は変更せず保存されます。', 'These lines are preserved unchanged.'));
      note.style.cssText = 'color:#8fa3bb;font-size:11.5px;margin-bottom:6px';
      section.appendChild(note);
      for (const kw of unknownKws) {
        const entries = parsed.parsed.get(kw) || [];
        for (const entry of entries) {
          const badge = el('div');
          badge.style.cssText = 'padding:3px 8px;background:#1a1000;border:1px solid #f0a030;' +
            'border-radius:4px;font-size:11.5px;color:#f0c060;font-family:monospace;margin-bottom:3px';
          badge.textContent = entry.rawLine.trim();
          section.appendChild(badge);
        }
      }
      formSections.appendChild(section);
    }
  }

  // ---- build a single field row ----
  function buildFieldInput(schema, entries, parsed) {
    const outer = el('div');
    outer.style.cssText = 'margin-bottom:5px';

    const label = schema.kw + (schema.unit ? ' (' + schema.unit + ')' : '');
    const hint  = (LANG === 'ja' ? schema.ja : schema.en);

    // Value comes from first occurrence (if any).
    const firstEntry = entries[0] || null;
    const currentVal = firstEntry ? firstEntry.value : '';

    const onChange = (newVal) => {
      editDatKey(parsed, schema.kw, newVal);
      updateSanity();
    };

    let inputEl;

    if (schema.type === 'bool') {
      const sel = document.createElement('select');
      sel.style.cssText = 'flex:1;min-width:0;padding:5px 8px;border:1px solid #2a3647;border-radius:6px;' +
        'background:#0b1017;color:#e6edf3;font-size:12px';
      [['', L('（未設定）', '(unset)')], ['TRUE', 'TRUE'], ['FALSE', 'FALSE']].forEach(([v, t]) => {
        sel.appendChild(Object.assign(document.createElement('option'), { value: v, textContent: t }));
      });
      sel.value = currentVal.toUpperCase();
      if (!['TRUE', 'FALSE', ''].includes(sel.value)) sel.value = '';
      sel.addEventListener('change', () => { if (sel.value) onChange(sel.value); });
      inputEl = sel;

    } else if (schema.type === 'vec3' || schema.type === 'att3') {
      // Each token keeps its OWN unit suffix ('0.0m 1.4m 4.50m' — engine
      // defaults change if the suffix is dropped), split per token.
      const wrap3 = el('div');
      wrap3.style.cssText = 'flex:1;display:flex;gap:4px;align-items:center;min-width:0';
      const tokens = currentVal.split(/\s+/).filter(Boolean);
      const parts = [0, 1, 2].map((i) => splitUnit(tokens[i] || ''));
      const suffixes = parts.map((p) => (p.num !== null ? p.suffix : ''));
      const inputs3 = [0, 1, 2].map((i) => {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = 'any';
        inp.value = parts[i].num !== null ? parts[i].num : '';
        inp.style.cssText = 'flex:1;min-width:0;padding:5px 6px;border:1px solid #2a3647;border-radius:6px;' +
          'background:#0b1017;color:#e6edf3;font-size:12px';
        inp.addEventListener('change', () => {
          onChange(inputs3.map((x, j) => (x.value || '0') + (suffixes[j] || '')).join(' '));
        });
        wrap3.appendChild(inp);
        return inp;
      });
      // One compact label for the (typically uniform) suffix.
      const sfx = suffixes.find((s) => s) || '';
      if (sfx) {
        const lab = el('span', null, sfx);
        lab.style.cssText = 'flex:none;color:#8fa3bb;font-size:11px;font-family:monospace';
        wrap3.appendChild(lab);
      }
      inputEl = wrap3;

    } else if (schema.type === 'scalar' || schema.type === 'force' || schema.type === 'weight' ||
               schema.type === 'speed' || schema.type === 'angle' || schema.type === 'length' ||
               schema.type === 'area') {
      // Values carry unit suffixes ('13.6t', '2.2MACH', '100%') that MUST be
      // preserved: a bare number is read in the engine's default unit and
      // silently rescales the value.  Split off the suffix, edit the number,
      // write back number+suffix.  Unparseable values fall back to raw text.
      const { num, suffix } = splitUnit(currentVal);
      if (currentVal !== '' && num === null) {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = currentVal;
        inp.style.cssText = 'flex:1;min-width:0;padding:5px 8px;border:1px solid #2a3647;border-radius:6px;' +
          'background:#0b1017;color:#e6edf3;font-size:12px';
        inp.addEventListener('change', () => { onChange(inp.value); });
        inputEl = inp;
      } else {
        const wrapN = el('div');
        wrapN.style.cssText = 'flex:1;display:flex;gap:4px;align-items:center;min-width:0';
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = 'any';
        inp.value = num !== null ? num : '';
        inp.style.cssText = 'flex:1;min-width:0;padding:5px 8px;border:1px solid #2a3647;border-radius:6px;' +
          'background:#0b1017;color:#e6edf3;font-size:12px';
        inp.addEventListener('change', () => { onChange(inp.value + suffix); });
        wrapN.appendChild(inp);
        if (suffix) {
          const lab = el('span', null, suffix);
          lab.style.cssText = 'flex:none;color:#8fa3bb;font-size:11px;font-family:monospace';
          wrapN.appendChild(lab);
        }
        inputEl = wrapN;
      }

    } else if (schema.type === 'int') {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = '1';
      inp.value = currentVal;
      inp.style.cssText = 'flex:1;min-width:0;padding:5px 8px;border:1px solid #2a3647;border-radius:6px;' +
        'background:#0b1017;color:#e6edf3;font-size:12px';
      inp.addEventListener('change', () => { onChange(String(Math.round(Number(inp.value)))); });
      inputEl = inp;

    } else {
      // string / other / text / -1 args: free text input
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = currentVal;
      inp.style.cssText = 'flex:1;min-width:0;padding:5px 8px;border:1px solid #2a3647;border-radius:6px;' +
        'background:#0b1017;color:#e6edf3;font-size:12px';
      inp.addEventListener('change', () => { onChange(inp.value); });
      inputEl = inp;
    }

    // If the keyword is absent, show a faint "+ add" link instead of the input.
    if (!firstEntry && schema.args !== 0) {
      const addLink = el('a', null, L('＋追加', '+ Add'));
      addLink.style.cssText = 'color:#4da3ff;font-size:11.5px;cursor:pointer;text-decoration:none';
      addLink.href = '#';
      addLink.addEventListener('click', (e) => {
        e.preventDefault();
        outer.innerHTML = '';
        renderRow(outer, label, hint, inputEl);
        inputEl.focus && inputEl.focus();
      });
      const rowEl = el('div');
      rowEl.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px';
      const kwSpan = el('span', null, schema.kw);
      kwSpan.style.cssText = 'color:#4a5a6a;font-size:11.5px;font-family:monospace;flex:0 0 7em';
      rowEl.appendChild(kwSpan);
      rowEl.appendChild(addLink);
      outer.appendChild(rowEl);
    } else if (schema.args === 0) {
      // Boolean flag keywords with no args (AUTOCALC, AIRSTATE): show as a toggle.
      const present = !!firstEntry;
      const chk = Object.assign(document.createElement('input'), { type: 'checkbox', checked: present });
      chk.addEventListener('change', () => {
        if (chk.checked) {
          editDatKey(parsed, schema.kw, '');
        } else {
          // Remove the line — find and splice.
          const ents = parsed.parsed.get(schema.kw);
          if (ents && ents.length) {
            const lineIdx = ents[0].lineIdx;
            parsed.lines.splice(lineIdx, 1);
            // Fix all lineIdx values above.
            for (const [, arr] of parsed.parsed) {
              for (const e of arr) if (e.lineIdx > lineIdx) e.lineIdx--;
            }
            parsed.parsed.delete(schema.kw);
          }
        }
      });
      const rowEl = el('div');
      rowEl.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px';
      const kwSpan = el('span', null, schema.kw);
      kwSpan.style.cssText = 'color:#8fa3bb;font-size:11.5px;font-family:monospace;flex:0 0 7em';
      const hintSpan = el('span', null, hint);
      hintSpan.style.cssText = 'color:#8fa3bb;font-size:11px';
      rowEl.appendChild(kwSpan);
      rowEl.appendChild(chk);
      rowEl.appendChild(hintSpan);
      outer.appendChild(rowEl);
    } else {
      renderRow(outer, label, hint, inputEl);
    }

    return outer;
  }

  function renderRow(parent, label, hint, inputEl) {
    const rowEl = el('div');
    rowEl.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px';
    const kwSpan = el('span', null, label);
    kwSpan.style.cssText = 'color:#8fa3bb;font-size:11.5px;font-family:monospace;flex:0 0 9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    kwSpan.title = hint;
    rowEl.appendChild(kwSpan);
    rowEl.appendChild(inputEl);
    parent.appendChild(rowEl);
  }

  // ---- public: load new bytes ----
  function load(bytes) {
    parsed = parseDat(bytes);
    rebuildForm();
    if (activeTab === 1) textarea.value = parsed.lines.join('\n');
  }

  // ---- auto-load on mount if bytes are available ----
  const initial = getBytes();
  if (initial) load(initial);

  return { load };
}
