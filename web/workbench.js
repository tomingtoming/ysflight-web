// Browser workbench core (MVP): assemble an AIRCRAFT pack from LOOSE files —
// a .dat/.dnm/.srf pile dropped without a zip or .lst — by synthesizing a
// normal-form zip and handing it to the existing import pipeline (packs.js).
//
// Keeping the output a plain zip means every pipeline invariant (content-hash
// id, OPFS dedupe, lazy materialize, enable/disable, MP manifest) is inherited
// for free, and the assembled pack doubles as a downloadable native pack.
//
// Engine contract (fsworld.cpp LoadAirplaneTemplateList): one aircraft per
// .lst line, positional tokens, minimum 3:
//   <dat> <visual dnm> <collision srf> [<cockpit srf> [<coarse dnm>]]
// The coarse model can only ride in position 5, so it is dropped (with a
// warning) when no cockpit occupies position 4 — stock lists never use an
// empty-string placeholder and we don't get to invent one here.
//
// Scenery/ground assembly is out of scope for now: field-internal references
// break the pack isolation (docs/addon-packs.md §3) and wait for demand.

import { zipSync } from './vendor/fflate.js';
import { parseDatIdentity } from './packs.js';

// Byte-preserving text codec for .dat/.fld editing: legacy files may hold
// Shift-JIS comment bytes, so a UTF-8 decode/encode round-trip would corrupt
// them.  latin1 maps every byte to one code point and back, losslessly.
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

// --- classification ----------------------------------------------------------

const extOf = (name) => {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
};
const baseName = (name) => name.split(/[\\/]/).pop();
const stem = (name) => baseName(name).replace(/\.[^.]+$/, '').toLowerCase();

const COARSE_RE = /(coarse|_lod|lod\d*$|_c$)/;
const COLLISION_RE = /(coll|_col$|col\d*$)/;
const COCKPIT_RE = /(cock|inst)/;

// Group loose files into slot candidates and take a best guess at the
// assignment, following the stock naming conventions (a4coll.srf,
// a4cockpit.srf, a4fcoarse.dnm...).  The UI shows the guess in selects so a
// human confirms anything ambiguous.  `files` is [{name, bytes}].
// Returns { candidates: {dat, dnm, srf}, guess: {dat, visual, collision,
// cockpit, coarse}, ignored: [names] } — guesses are file names or null.
export function classifyLoose(files) {
  const named = files.map((f) => ({ ...f, name: baseName(f.name) }));
  const byExt = { dat: [], dnm: [], srf: [] };
  const ignored = [];
  for (const f of named) {
    const e = extOf(f.name);
    if (byExt[e]) byExt[e].push(f);
    else ignored.push(f.name);
  }

  const dat = byExt.dat[0] || null;

  // dnm: a coarse-looking name is the coarse model; with exactly two dnm and
  // no name hint, the smaller file is the coarse one (that is its whole point).
  let visual = null, coarse = null;
  const dnms = byExt.dnm.slice();
  const coarseIdx = dnms.findIndex((f) => COARSE_RE.test(stem(f.name)));
  if (coarseIdx >= 0) coarse = dnms.splice(coarseIdx, 1)[0];
  else if (dnms.length === 2) {
    dnms.sort((a, b) => b.bytes.length - a.bytes.length);
    coarse = dnms.pop();
  }
  visual = dnms[0] || null;

  // srf: name hints first; a single leftover srf is the collision shell.
  let collision = null, cockpit = null;
  const srfs = byExt.srf.slice();
  const colIdx = srfs.findIndex((f) => COLLISION_RE.test(stem(f.name)));
  if (colIdx >= 0) collision = srfs.splice(colIdx, 1)[0];
  const cockIdx = srfs.findIndex((f) => COCKPIT_RE.test(stem(f.name)));
  if (cockIdx >= 0) cockpit = srfs.splice(cockIdx, 1)[0];
  if (!collision && srfs.length > 0) collision = srfs.shift();
  if (!cockpit && srfs.length > 0) cockpit = srfs.shift();

  return {
    candidates: byExt,
    guess: {
      dat: dat && dat.name,
      visual: visual && visual.name,
      collision: collision && collision.name,
      cockpit: cockpit && cockpit.name,
      coarse: coarse && coarse.name,
    },
    ignored,
  };
}

// --- assembly ----------------------------------------------------------------

// Error codes the UI maps to friendly strings.
export const ERR = {
  NO_DAT: 'workbench: missing .dat (flight model)',
  NO_VISUAL: 'workbench: missing visual .dnm',
  NO_COLLISION: 'workbench: missing collision .srf',
};

const sanitizeEntry = (name) => {
  const b = baseName(name);
  if (!b || b === '.' || b === '..') throw new Error('workbench: bad file name: ' + name);
  return b;
};
const emit = (p) => (/\s/.test(p) ? `"${p}"` : p);

// Assemble a normal-form aircraft pack zip from assigned slots.  Each slot is
// {name, bytes} (visual/collision required alongside dat; cockpit/coarse
// optional).  Returns { zipBytes, identify, lstLine, warnings } — identify is
// null when the .dat carries no ASCII IDENTIFY/CATEGORY pair (the engine then
// reads the .dat itself; the test-fly button just can't name the aircraft).
export function assembleAircraftZip({ name, dat, visual, collision, cockpit, coarse }) {
  if (!dat) throw new Error(ERR.NO_DAT);
  if (!visual) throw new Error(ERR.NO_VISUAL);
  if (!collision) throw new Error(ERR.NO_COLLISION);

  const warnings = [];
  const entries = {};
  const used = new Set();
  const add = (slot) => {
    const entry = 'aircraft/' + sanitizeEntry(slot.name);
    if (used.has(entry.toLowerCase())) throw new Error('workbench: duplicate file name: ' + slot.name);
    used.add(entry.toLowerCase());
    entries[entry] = slot.bytes instanceof Uint8Array ? slot.bytes : new Uint8Array(slot.bytes);
    return entry;
  };

  const tokens = [add(dat), add(visual), add(collision)];
  if (cockpit) tokens.push(add(cockpit));
  if (coarse) {
    if (cockpit) tokens.push(add(coarse));
    else warnings.push('coarse-needs-cockpit'); // positional slot 5 needs slot 4 occupied
  }

  const identity = parseDatIdentity(entries[tokens[0]]);
  if (!identity) warnings.push('no-ascii-identify');

  const packName = (name || (identity && identity.identify) || stem(dat.name) || 'workbench')
    .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'workbench';
  const lstLine = tokens.map(emit).join(' ') + '\n';
  entries['aircraft/air_' + packName.toLowerCase() + '.lst'] = new TextEncoder().encode(lstLine);

  return {
    zipBytes: zipSync(entries),
    identify: identity ? identity.identify : null,
    packName,
    lstLine,
    warnings,
  };
}

// --- .dat wizard ---------------------------------------------------------------

// Enumerate the stock aircraft readable at fsReady: the .data preload is fully
// mounted at /ysflight before the boot gate, so the air*.lst files and every
// .dat head are plain FS reads.  Returns [{identify, category, datPath}].
export function listStockAircraft(FS, root = '/ysflight') {
  const out = [];
  let names;
  try { names = FS.readdir(root + '/aircraft'); } catch (e) { return out; }
  for (const n of names) {
    if (!/^air.*\.lst$/i.test(n)) continue;
    let text;
    try { text = b2s(FS.readFile(root + '/aircraft/' + n)); } catch (e) { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('REM ')) continue;
      const first = line.split(/\s+/)[0].replace(/^"|"$/g, '');
      if (!/\.dat$/i.test(first)) continue;
      try {
        const idn = parseDatIdentity(FS.readFile(root + '/' + first));
        if (idn) out.push({ identify: idn.identify, category: idn.category, datPath: root + '/' + first });
      } catch (e) { /* unreadable entry — skip */ }
    }
  }
  out.sort((a, b) => (a.identify < b.identify ? -1 : 1));
  return out;
}

// The engine registers IDENTIFY after replacing space/tab/quote with '_' and
// capitalizing; MP compares the first 31 chars.  Mirror that here so the name
// the user types is exactly the name ?freeflight= will resolve.
export function sanitizeIdentify(name) {
  return (name || '')
    .replace(/[\s"]+/g, '_')
    .toUpperCase()
    .replace(/[^\x20-\x7e]/g, '_')
    .slice(0, 31);
}

// Multiplier knobs -> the .dat keys they scale.  Values are plain numbers with
// a trailing unit token (e.g. "22.6t", "2.0MACH", "8.0"); scaling the number in
// place preserves the unit, and we never ADD a key (an unknown keyword fails
// the whole load, so edits are strictly in-place on lines that already exist).
const KNOB_KEYS = {
  engine: ['THRAFTBN', 'THRMILIT', 'PROPELLR'],
  weight: ['WEIGHCLN'],
  speed: ['MAXSPEED'],
  agility: ['CPITMANE', 'CROLLMAN', 'CYAWMANE'],
};

// Build a new .dat from a stock base: rename IDENTIFY and scale the whitelisted
// knobs.  knobs = {engine?, weight?, speed?, agility?} as multipliers (1 = keep).
// Byte-preserving outside the touched lines.  Returns {bytes, identify, applied}.
export function makeDatFromBase(baseBytes, { identify, knobs = {} }) {
  const clean = sanitizeIdentify(identify);
  if (!clean) throw new Error('workbench: new aircraft name is required');
  const scaleOf = (key) => {
    for (const [knob, keys] of Object.entries(KNOB_KEYS)) {
      if (keys.includes(key)) {
        const s = knobs[knob];
        return typeof s === 'number' && isFinite(s) && s > 0 && s !== 1 ? s : null;
      }
    }
    return null;
  };
  const applied = [];
  let renamed = false;
  const lines = b2s(baseBytes).split('\n').map((line) => {
    const key = (line.match(/^([A-Z0-9]+)\b/) || [])[1];
    if (!key) return line;
    if (key === 'IDENTIFY' && !renamed) {
      renamed = true;
      const eol = line.endsWith('\r') ? '\r' : '';
      return 'IDENTIFY "' + clean + '"' + eol;
    }
    const scale = scaleOf(key);
    if (scale === null) return line;
    return line.replace(/^([A-Z0-9]+\s+)(-?[0-9]*\.?[0-9]+)/, (m, head, num) => {
      const scaled = parseFloat(num) * scale;
      applied.push(key);
      // Enough precision for any knob (thrust in t, dimensionless constants).
      return head + String(Math.round(scaled * 1000) / 1000);
    });
  });
  if (!renamed) throw new Error('workbench: base .dat has no IDENTIFY line');
  return { bytes: s2b(lines.join('\n')), identify: clean, applied };
}

// --- scenery wizard --------------------------------------------------------------

export const SCENERY_START = 'START01';

const rgb = (c) => `${c[0]} ${c[1]} ${c[2]}`;
const num = (v, d) => (Math.round(v * 100) / 100).toFixed(d);

// Assemble a minimal flyable scenery pack as plain text — .fld and .stp are
// line-based text formats (yssceneryio.cpp), and the smallest field the engine
// accepts is just the header block (ENDF is optional; LoadFld ends at EOF).
// Ships the same normal-form zip as everything else: sce_<name>.lst pointing at
// scenery/<name>.fld + .stp (3 tokens, same shape as the flying scnpack fixture).
// Returns {zipBytes, ident, packName}.
export function assembleSceneryZip({ name, ground = [40, 90, 60], sky = [23, 106, 189], startAltM = 1000, startSpeedMS = 100 }) {
  const ident = sanitizeIdentify(name);
  if (!ident) throw new Error('workbench: map name is required');
  const packName = ident.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  const fileStem = packName;

  const fld = [
    'FIELD',
    'GND ' + rgb(ground),
    'SKY ' + rgb(sky),
    'GNDSPECULAR TRUE',
    'DEFAREA WATER',
    'BASEELV 0.00m',
    'MAGVAR 0.00deg',
    'CANRESUME TRUE',
    '',
  ].join('\n');

  const stp = [
    'N ' + SCENERY_START,
    'C POSITION 0.00m ' + num(startAltM, 2) + 'm 0.00m',
    'C ATTITUDE 0.00deg 0.00deg 0.00deg',
    'C INITSPED ' + num(startSpeedMS, 2) + 'm/s',
    'C CTLTHROT 0.80',
    'C CTLLDGEA FALSE',
    '',
  ].join('\n');

  const enc = new TextEncoder();
  const entries = {
    ['scenery/sce_' + packName + '.lst']: enc.encode(ident + ' scenery/' + fileStem + '.fld scenery/' + fileStem + '.stp\n'),
    ['scenery/' + fileStem + '.fld']: enc.encode(fld),
    ['scenery/' + fileStem + '.stp']: enc.encode(stp),
  };
  return { zipBytes: zipSync(entries), ident, packName };
}
