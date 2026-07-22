// Build-time: stage the stock aircraft .dat files + an identity index into
// dist/stock/ so the engine-less workbench page (workbench.html) can offer
// "make a .dat from a stock base" without loading the wasm preload.
//
//   node scripts/gen-stock-index.mjs <runtimeDir> <outDir>
//
// Reads aircraft/air*.lst exactly like the engine's glob, copies each listed
// .dat, and emits index.json [{identify, category, file}] (ASCII identities
// only — same parseDatIdentity the importer uses).
import { readdirSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';

import { parseDatIdentity } from '../web/packs.js';

const [runtimeDir, outDir] = process.argv.slice(2);
if (!runtimeDir || !outDir) {
  console.error('usage: gen-stock-index.mjs <runtimeDir> <outDir>');
  process.exit(1);
}

mkdirSync(join(outDir, 'aircraft'), { recursive: true });
const index = [];
const seen = new Set();
// .lst line: <dat> <visual dnm> <collision srf> [<cockpit srf> [<coarse dnm>]]
// — every token is a file; staging them all lets the workbench build a complete
// aircraft with ZERO user files (stock visuals + a wizard-made .dat).
const SLOTS = ['file', 'visual', 'collision', 'cockpit', 'coarse'];
for (const lst of readdirSync(join(runtimeDir, 'aircraft'))) {
  if (!/^air.*\.lst$/i.test(lst)) continue;
  const text = readFileSync(join(runtimeDir, 'aircraft', lst), 'latin1');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('REM ')) continue;
    const tokens = line.match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, '')) || [];
    if (!tokens[0] || !/\.dat$/i.test(tokens[0])) continue;
    let idn;
    try { idn = parseDatIdentity(readFileSync(join(runtimeDir, tokens[0]))); } catch { continue; }
    if (!idn || seen.has(idn.identify)) continue;
    seen.add(idn.identify);
    const entry = { identify: idn.identify, category: idn.category };
    for (let i = 0; i < SLOTS.length && i < tokens.length; i++) {
      if (!tokens[i]) continue;
      const rel = 'aircraft/' + basename(tokens[i]);
      try {
        copyFileSync(join(runtimeDir, tokens[i]), join(outDir, rel));
        entry[SLOTS[i]] = rel;
      } catch { /* referenced file missing from runtime — skip the slot */ }
    }
    if (!entry.file || !entry.visual || !entry.collision) continue; // engine minimum
    index.push(entry);
  }
}
index.sort((a, b) => (a.identify < b.identify ? -1 : 1));
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index));
console.log('stock index: ' + index.length + ' aircraft -> ' + outDir);

// Start positions per bundled field (stock/fields.json).  The Create-Flight
// page anchors ground-object presets at a named ground start position: the
// engine resolves an airplane STARTPOS by name, but GNDPOSIT is an ABSOLUTE
// coordinate (no terrain snap), so the page needs the .stp coordinates.
// scenery.lst line: IDENTIFY <fld> <stp> [<yfs>] [tags...]; .stp blocks:
// "N <name>" then "C POSITION <x> <y> <z>" / "C ATTITUDE <h> <p> <b>".
const r2 = (v) => Math.round(v * 100) / 100;
const meters = (tok) => {
  const m = String(tok || '').match(/^(-?[0-9.]+)(m|ft)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return (m[2] || '').toLowerCase() === 'ft' ? v * 0.3048 : v;
};
const degrees = (tok) => {
  const m = String(tok || '').match(/^(-?[0-9.]+)(deg|rad)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return (m[2] || '').toLowerCase() === 'rad' ? (v * 180) / Math.PI : v;
};
const fields = {};
try {
  const lst = readFileSync(join(runtimeDir, 'scenery', 'scenery.lst'), 'latin1');
  for (const raw of lst.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, '')) || [];
    const [identify, , stpRel] = tokens;
    if (!identify || !stpRel || !/\.stp$/i.test(stpRel)) continue;
    let text;
    try { text = readFileSync(join(runtimeDir, stpRel), 'latin1'); } catch { continue; }
    const list = [];
    let cur = null;
    for (const l of text.split(/\r?\n/)) {
      const t = l.trim().match(/\S+/g) || [];
      if (t[0] === 'N' && t[1]) { cur = { n: t[1] }; list.push(cur); }
      else if (t[0] === 'C' && cur && t[1] === 'POSITION' && t.length >= 5) {
        const x = meters(t[2]), y = meters(t[3]), z = meters(t[4]);
        if (x !== null && y !== null && z !== null) { cur.x = r2(x); cur.y = r2(y); cur.z = r2(z); }
      } else if (t[0] === 'C' && cur && t[1] === 'ATTITUDE' && t.length >= 3) {
        const h = degrees(t[2]);
        if (h !== null) cur.h = r2(h);
      }
    }
    const ok = list.filter((s) => s.x !== undefined);
    if (ok.length) fields[identify] = ok;
  }
} catch { /* no scenery.lst in a stripped runtime -> fields.json stays empty */ }
writeFileSync(join(outDir, 'fields.json'), JSON.stringify(fields));
console.log('stock fields: ' + Object.keys(fields).length + ' fields -> ' + outDir);
