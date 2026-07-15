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
// When `recipe` is given it is embedded as workbench.json — the creation
// parameters ride inside the pack (content-addressed like everything else), so
// the workbench can list its own creations and re-open them for editing.  The
// engine never reads it (only files referenced by the scanned .lst matter).
export const RECIPE_FILE = 'workbench.json';
const recipeEntry = (recipe) => new TextEncoder().encode(JSON.stringify({ schema: 1, ...recipe }));

// Community addon layout (YSFHQ convention, same shape as the real community
// packs the importer was built against, e.g. test/fixtures/testpack.zip): the
// engine-scanned .lst lives in aircraft/ (air_<name>.lst) while the payload
// ships under user/<packName>/, referenced root-relative from the list.  The
// engine resolves list entries against the user-dir root either way, and the
// importer resolves them case-insensitively — this is manners, not mechanics.
export function assembleAircraftZip({ name, dat, visual, collision, cockpit, coarse, recipe }) {
  if (!dat) throw new Error(ERR.NO_DAT);
  if (!visual) throw new Error(ERR.NO_VISUAL);
  if (!collision) throw new Error(ERR.NO_COLLISION);

  const warnings = [];
  const datBytes = dat.bytes instanceof Uint8Array ? dat.bytes : new Uint8Array(dat.bytes);
  const identity = parseDatIdentity(datBytes);
  if (!identity) warnings.push('no-ascii-identify');

  // The pack name doubles as the user/<packName>/ payload directory, so it is
  // sanitized to ASCII-safe characters (it already was, for the .lst name).
  const packName = (name || (identity && identity.identify) || stem(dat.name) || 'workbench')
    .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'workbench';
  const payloadDir = 'user/' + packName + '/';

  const entries = {};
  const used = new Set();
  const add = (slot) => {
    const entry = payloadDir + sanitizeEntry(slot.name);
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

  const lstLine = tokens.map(emit).join(' ') + '\n';
  entries['aircraft/air_' + packName.toLowerCase() + '.lst'] = new TextEncoder().encode(lstLine);
  if (recipe) entries[RECIPE_FILE] = recipeEntry({ type: 'aircraft', ...recipe });

  return {
    zipBytes: zipSync(entries),
    identify: identity ? identity.identify : null,
    packName,
    lstLine,
    warnings,
  };
}

// --- paint shop (.dnm recolor) ---------------------------------------------------

// DNM files are line-based text: PCK "<name>" <N> embeds an SRF as the next N
// lines, and polygon colors are `C r g b [a]` lines inside those blocks.  The
// node section that follows maps each embedded SRF (FIL <name>) to a CLA class
// id — 30..34 are the light classes (nav/beacon/strobe/landing), whose pure
// colors must never be repainted.  Everything here is exact line surgery on the
// latin1 text, so untouched bytes (including Shift-JIS names) survive verbatim.

const PCK_RE = /^PCK\s+("?)([^"\s]+)\1\s+(\d+)/;
// A face color line: either `C r g b [a]` (triplet, group 'rgb') or `C <n>`
// (packed 15-bit, group 'packed').  amp.dnm and other legacy models use packed.
const C_RE = /^(\s*C\s+)(?:(\d+)\s+(\d+)\s+(\d+)((?:\s+\d+)?)|(\d+))\s*$/;

// The [r,g,b] (0..255) a `C` line encodes, or null if not a color line.
// Mirrors YsColor::Set15BitRGB for the packed form (GGGGG RRRRR BBBBB).
function cLineRgb(line) {
  const m = C_RE.exec(line.replace(/\r$/, ''));
  if (!m) return null;
  if (m[2] !== undefined) return [+m[2], +m[3], +m[4]];
  const c = (parseInt(m[6], 10) || 0) & 32767;
  return [((c >> 5) & 31) * 255 / 31, ((c >> 10) & 31) * 255 / 31, (c & 31) * 255 / 31]
    .map((v) => Math.round(v));
}

// Enumerate PCK block line-ranges and the set of light-class block names.
function dnmLayout(lines) {
  const blocks = []; // {name, start, end} — lines[start..end] inclusive are the SRF body
  for (let i = 0; i < lines.length; i++) {
    const m = PCK_RE.exec(lines[i]);
    if (!m) continue;
    const n = parseInt(m[3], 10);
    blocks.push({ name: m[2], start: i + 1, end: Math.min(i + n, lines.length - 1) });
    i += n;
  }
  const inBlock = new Set();
  for (const b of blocks) for (let j = b.start; j <= b.end; j++) inBlock.add(j);
  const claOf = new Map();
  let lastFil = null;
  for (let i = 0; i < lines.length; i++) {
    if (inBlock.has(i)) continue;
    const line = lines[i].trim();
    const fil = /^FIL\s+("?)([^"\s]+)\1/.exec(line);
    if (fil) { lastFil = fil[2]; continue; }
    const cla = /^CLA\s+(\d+)/.exec(line);
    if (cla && lastFil !== null) { claOf.set(lastFil, parseInt(cla[1], 10)); lastFil = null; }
  }
  const isLight = (name) => { const c = claOf.get(name); return c !== undefined && c >= 30 && c <= 34; };
  return { blocks, isLight };
}

// Unique paintable colors of a .dnm (light-class blocks excluded), most-used
// first.  Returns [{key: 'r,g,b', r, g, b, count}].
export function extractDnmColors(bytes) {
  const lines = b2s(bytes).split('\n');
  const { blocks, isLight } = dnmLayout(lines);
  const counts = new Map();
  for (const b of blocks) {
    if (isLight(b.name)) continue;
    for (let j = b.start; j <= b.end; j++) {
      const rgb = cLineRgb(lines[j]);
      if (!rgb) continue;
      const key = rgb.join(',');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [r, g, b] = key.split(',').map(Number);
      return { key, r, g, b, count };
    })
    .sort((a, b) => b.count - a.count);
}

// Repaint: mapping = {'r,g,b': [r2,g2,b2], ...} keyed by the DECODED rgb (so a
// packed `C <n>` and a triplet map by the same key).  A matched line is rewritten
// as a `C r g b` triplet (the engine accepts both forms; the line count in its
// PCK header is unchanged since it's still one line).  Light-class blocks are
// never touched.  Returns {bytes, replaced}.
export function repaintDnm(bytes, mapping) {
  const lines = b2s(bytes).split('\n');
  const { blocks, isLight } = dnmLayout(lines);
  let replaced = 0;
  for (const b of blocks) {
    if (isLight(b.name)) continue;
    for (let j = b.start; j <= b.end; j++) {
      const rgb = cLineRgb(lines[j]);
      if (!rgb) continue;
      const to = mapping[rgb.join(',')];
      if (!to) continue;
      const hasCR = lines[j].endsWith('\r');
      const indent = (lines[j].match(/^(\s*)C/) || ['', ''])[1];
      lines[j] = indent + 'C ' + to[0] + ' ' + to[1] + ' ' + to[2] + (hasCR ? '\r' : '');
      replaced++;
    }
  }
  return { bytes: s2b(lines.join('\n')), replaced };
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
    .replace(/[\s"]/g, '_') // per character, like the engine (no run-collapsing)
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
// extras — SET-style knobs on top of the multiplier ones.  All keys are in the
// engine's keyword list, so ADDING a line a base .dat lacks is accepted (only
// UNKNOWN keywords fail the load); none of them feed AUTOCALC, so appending at
// the end is order-safe:
//   strength    : int (STRENGTH — hits to kill; ~1..99)
//   radarCross  : number (RADARCRS — 0.1 = stealth; weapons hanging outside
//                 force it back to 1.0, engine rule)
//   gunInterval : seconds (GUNINTVL — smaller = faster fire)
//   smoke       : [r,g,b] (SMOKECOL ALL + a tail SMOKEGEN when the base has none)
export function makeDatFromBase(baseBytes, { identify, knobs = {}, extras = {} }) {
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

  // SET-style extras: replace the key's line when present, append when absent.
  const setKey = (key, value) => {
    const re = new RegExp('^' + key + '\\b');
    const idx = lines.findIndex((l) => re.test(l));
    if (idx >= 0) lines[idx] = key + ' ' + value + (lines[idx].endsWith('\r') ? '\r' : '');
    else lines.push(key + ' ' + value);
    applied.push(key);
  };
  if (Number.isFinite(extras.strength)) setKey('STRENGTH', String(Math.max(1, Math.round(extras.strength))));
  if (Number.isFinite(extras.radarCross)) setKey('RADARCRS', String(extras.radarCross));
  if (Number.isFinite(extras.gunInterval)) setKey('GUNINTVL', String(extras.gunInterval));
  if (Array.isArray(extras.smoke) && extras.smoke.length === 3) {
    for (let i = lines.length - 1; i >= 0; i--) if (/^SMOKECOL\b/.test(lines[i])) lines.splice(i, 1);
    if (!lines.some((l) => /^SMOKEGEN\b/.test(l))) lines.push('SMOKEGEN 0.0m 0.0m -6.0m');
    lines.push('SMOKECOL ALL ' + extras.smoke.map((v) => Math.max(0, Math.min(255, v | 0))).join(' '));
    applied.push('SMOKECOL');
  }
  return { bytes: s2b(lines.join('\n')), identify: clean, applied };
}

// --- cockpit position (.dat COCKPITP) ---------------------------------------------

// The engine's cockpit eye point is the .dat's `COCKPITP x y z` line
// (fsairplaneproperty.cpp case 52 -> FsGetVec3), in YS airplane coordinates:
// +x = starboard, +y = up, +z = nose.  Stock format (b747.dat):
//   COCKPITP -0.5m  3.5m  29.05m  #COCKPIT POSITION

// Read the COCKPITP line of a .dat.  Returns {x, y, z} in meters or null when
// the .dat has no COCKPITP line.  Stock always writes "m"; a bare number is
// meters too (FsGetLength's default unit).
export function getDatCockpit(bytes) {
  for (const line of b2s(bytes).split('\n')) {
    const m = /^COCKPITP\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    const num = (tok) => (/ft$/i.test(tok) ? parseFloat(tok) * 0.3048 : parseFloat(tok));
    const [x, y, z] = [num(m[1]), num(m[2]), num(m[3])];
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
  }
  return null;
}

// Replace (or insert) the COCKPITP line, stock-formatted.  Replacement is
// in-place on the existing line; insertion goes right after IDENTIFY (order is
// free — COCKPITP does not feed AUTOCALC — but stock keeps it in the header
// block, so we do too).  Byte-preserving outside the touched line.
export function setDatCockpit(bytes, { x, y, z }) {
  const fmt = (v) => String(Math.round(v * 1000) / 1000) + 'm';
  const cockLine = 'COCKPITP ' + fmt(x) + '  ' + fmt(y) + '  ' + fmt(z) + '  #COCKPIT POSITION';
  const lines = b2s(bytes).split('\n');
  const ix = lines.findIndex((l) => /^COCKPITP\b/.test(l));
  if (ix >= 0) {
    lines[ix] = cockLine + (lines[ix].endsWith('\r') ? '\r' : '');
  } else {
    const idIx = lines.findIndex((l) => /^IDENTIFY\b/.test(l));
    const eol = idIx >= 0 && lines[idIx].endsWith('\r') ? '\r' : '';
    lines.splice(idIx >= 0 ? idIx + 1 : 0, 0, cockLine + eol);
  }
  return s2b(lines.join('\n'));
}

// --- extra viewpoints (.dat EXCAMERA) ----------------------------------------------

// Named additional viewpoints — the F1 view cycle's extra stops
// (fsairplaneproperty.cpp case 144 -> FsAdditionalViewpoint):
//   EXCAMERA "<name>" <x> <y> <z> <h> <p> <b> INSIDE|OUTSIDE|CABIN [NOHUD] [NOINSTPANEL]
// Positions carry a length-unit suffix and angles an angle-unit suffix — the
// engine's FsGetUnit REJECTS bare numbers (the whole line is dropped), and the
// parser requires ac>=9, so the type flag is effectively mandatory too.  Stock
// always writes "m"/"deg" and an explicit type; so do we.  h/p/b follow
// YsAtt3: h yaw (left +), p pitch (up +), b bank.  Defaults when flags are
// absent: INSIDE, HUD and instrument panel shown (NOHUD/NOINSTPANEL hide them
// for that viewpoint only; the main cockpit's pair is CKPITHUD/CKPITIST).
// The DAT ORDER of EXCAMERA lines is the F1 cycle order — preserved verbatim.

// One EXCAMERA line -> a camera object, or null when it does not parse.
// Angles come back in DEGREES (matching what the .dat displays), lengths in
// meters.  Lenient on units the way getDatCockpit is: m/ft for lengths,
// deg/rad for angles, bare = m/deg.
function parseExCameraLine(line) {
  const len = (tok) => (/ft$/i.test(tok) ? parseFloat(tok) * 0.3048 : parseFloat(tok));
  const ang = (tok) => (/rad$/i.test(tok) ? (parseFloat(tok) * 180) / Math.PI : parseFloat(tok)) + 0; // +0: -0deg -> 0
  const m = /^EXCAMERA\s+(?:"([^"]*)"|(\S+))\s+(\S.*)$/.exec(line.trim());
  if (!m) return null;
  const t = m[3].split(/\s+/);
  if (t.length < 6) return null;
  const cam = {
    name: m[1] !== undefined ? m[1] : m[2],
    x: len(t[0]), y: len(t[1]), z: len(t[2]),
    h: ang(t[3]), p: ang(t[4]), b: ang(t[5]),
    type: 'INSIDE', noHud: false, noInstPanel: false,
  };
  if (![cam.x, cam.y, cam.z, cam.h, cam.p, cam.b].every(Number.isFinite)) return null;
  for (const f of t.slice(6)) {
    if (f[0] === '#') break;
    if (f === 'OUTSIDE' || f === 'CABIN' || f === 'INSIDE') cam.type = f;
    else if (f === 'NOHUD') cam.noHud = true;
    else if (f === 'NOINSTPANEL') cam.noInstPanel = true;
  }
  return cam;
}

// Read every EXCAMERA line, in file order (= the F1 cycle order).
export function getDatExCameras(bytes) {
  const cams = [];
  for (const line of b2s(bytes).split('\n')) {
    const cam = parseExCameraLine(line);
    if (cam) cams.push(cam);
  }
  return cams;
}

// Rewrite the .dat's EXCAMERA set to exactly `cams` (same shape as
// getDatExCameras; angles in degrees).  Byte-preserving outside the touched
// lines: existing EXCAMERA lines are replaced pairwise in place (keeping each
// line's CR), extra new cameras are inserted right after the last EXCAMERA
// line (else after COCKPITP, else after IDENTIFY — stock keeps them in the
// header block), and surplus old lines are removed.  Order in = F1 cycle out.
export function setDatExCameras(bytes, cams) {
  const fmtL = (v) => String(Math.round(v * 1000) / 1000) + 'm';
  const fmtA = (v) => String(Math.round((v || 0) * 100) / 100 + 0) + 'deg';
  const lineOf = (c) =>
    'EXCAMERA "' + String(c.name || 'VIEW').replace(/"/g, "'") + '" ' +
    fmtL(c.x) + ' ' + fmtL(c.y) + ' ' + fmtL(c.z) + ' ' +
    fmtA(c.h) + ' ' + fmtA(c.p) + ' ' + fmtA(c.b) + ' ' +
    (c.type === 'OUTSIDE' || c.type === 'CABIN' ? c.type : 'INSIDE') +
    (c.noHud ? ' NOHUD' : '') + (c.noInstPanel ? ' NOINSTPANEL' : '');
  const lines = b2s(bytes).split('\n');
  const ixs = [];
  lines.forEach((l, i) => { if (/^EXCAMERA\b/.test(l)) ixs.push(i); });
  const n = Math.min(ixs.length, cams.length);
  const key = (c) => c && JSON.stringify([c.name, c.x, c.y, c.z, c.h, c.p, c.b, c.type, !!c.noHud, !!c.noInstPanel]);
  for (let i = 0; i < n; i++) {
    // Value-identical lines keep their original bytes (stock spacing intact).
    if (key(parseExCameraLine(lines[ixs[i]])) === key(cams[i])) continue;
    lines[ixs[i]] = lineOf(cams[i]) + (lines[ixs[i]].endsWith('\r') ? '\r' : '');
  }
  if (cams.length > ixs.length) {
    let anchor = ixs.length ? ixs[ixs.length - 1] : lines.findIndex((l) => /^COCKPITP\b/.test(l));
    if (anchor < 0) anchor = lines.findIndex((l) => /^IDENTIFY\b/.test(l));
    const eol = anchor >= 0 && lines[anchor].endsWith('\r') ? '\r' : '';
    lines.splice(anchor + 1, 0, ...cams.slice(ixs.length).map((c) => lineOf(c) + eol));
  } else {
    for (let i = ixs.length - 1; i >= cams.length; i--) lines.splice(ixs[i], 1);
  }
  return s2b(lines.join('\n'));
}

// --- scenery wizard --------------------------------------------------------------

export const SCENERY_START = 'START01';

const rgb = (c) => `${c[0]} ${c[1]} ${c[2]}`;
const num = (v, d) => (Math.round(v * 100) / 100).toFixed(d);

// Assemble a minimal flyable scenery pack as plain text — .fld and .stp are
// line-based text formats (yssceneryio.cpp), and the smallest field the engine
// accepts is just the header block (ENDF is optional; LoadFld ends at EOF).
// Ships the same normal-form zip as everything else: scenery/sce_<name>.lst
// pointing at user/<name>/<name>.fld + .stp (3 tokens, community layout).
//
// islands: [{points: [[xEastM, zSouthM], ...], color?: [r,g,b]}] — each becomes
//   (a) a PC2 PLG polygon (the VISIBLE land; concave is fine, the engine
//       tessellates on load) embedded via PCK — whose line count must match the
//       embedded text EXACTLY (the loader counts lines back to OUTSIDE state) —
//   (b) a PST loop with AREA LAND (the LANDABLE override over DEFAREA WATER;
//       no TER means the island is flat at BASEELV 0m, so you can touch down).
// Returns {zipBytes, ident, packName}.
// GOB heading/pitch/bank ride the .fld as 32768 = pi radians (yssceneryio.cpp
// reads att * YsPi/32768); degrees convert with this.
const deg32768 = (deg) => String(Math.round(((deg || 0) % 360) * 32768 / 180));

// Engine heading convention (verified against upstream, not guessed):
// YsAtt3 heading h rotates by RotateXZ(h) in a YSLEFT_ZPLUS_YPLUS world
// (ysgeometry.h / fsmain.cpp), so forward(h) = (-sin h, cos h) in (x, z),
// i.e. world +x = east, +z = north and COMPASS = -h.  Oracle: stock .stp
// runway spawns — atsugi RW01 (compass 010) is ATTITUDE -10deg, airstrike
// RW10 is -100deg, crescent RW28 is +80deg.  All user-facing headings in
// the workbench are compass degrees; this converts them for .fld/.stp,
// normalized to (-180, 180] like the stock files.
const compassToEngineDeg = (c) => {
  let d = -((Number(c) || 0) % 360) || 0; // || 0 normalizes -0
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
};

// Recipe convention versions.  conv 1 (implicit, pre-lighting recipes) wrote
// headingDeg RAW as the engine attitude, whose compass is -headingDeg; conv 2
// stores headingDeg as COMPASS degrees.  Migrating negates every heading so a
// legacy map compiles to the same in-game orientations as before (the .fld /
// .stp attitude bytes are unchanged — only the buggy runway-spawn end and the
// default upwind spawn move, deliberately).
export const SCENERY_CONV = 2;
export function migrateScenery(sc) {
  if (!sc || (sc.conv | 0) >= SCENERY_CONV) return sc;
  const flip = (a) => a === undefined ? undefined
    : (a || []).map((o) => ({ ...o, headingDeg: ((360 - (Number(o.headingDeg) || 0)) % 360 + 360) % 360 }));
  return { ...sc, conv: SCENERY_CONV, objects: flip(sc.objects), starts: flip(sc.starts), runways: flip(sc.runways) };
}

// One cosine-falloff mountain as a TER (TerrMesh) text block: NBL n n nodes,
// green->brown elevation gradient (CBE), last-row/col nodes in the saver's
// shorthand form.  Landable real terrain: GetElevation reads the grid and the
// crash test uses the triangle normal, so gentle slopes can be touched down on.
function mountainTer({ radiusM = 1500, heightM = 300, n = 16 }) {
  const cell = (radiusM * 2) / n;
  const lines = [
    'TerrMesh',
    'SPEC FALSE',
    'NBL ' + n + ' ' + n,
    'TMS ' + num(cell, 2) + ' ' + num(cell, 2),
    'CBE 0.00 ' + num(heightM, 2) + ' 34 139 34 139 90 43',
  ];
  const c = n / 2;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const dist = Math.hypot(i - c, j - c) * cell;
      const y = dist <= radiusM ? heightM * 0.5 * (1 + Math.cos(Math.PI * dist / radiusM)) : 0;
      lines.push(i === n || j === n
        ? 'BLO ' + num(y, 2)
        : 'BLO ' + num(y, 2) + ' R 1 34 139 34 1 34 139 34');
    }
  }
  lines.push('END');
  return lines;
}

// One runway = flat pavement PLGs (grey base + white threshold bars +
// centerline dashes, all in the shared .pc2), a PST AREA LAND rectangle so it
// is landable even when it sticks out over water, an RGN id-1 rect region so
// the ENGINE treats touchdown/rollout as ON-runway, and a ground spawn point
// 60m in from the approach end (alt 0 / speed 0 = the engine starts you
// parked, gear down, ready to roll).
//
// Why the RGN matters (fsexistence.cpp FsAirplane::HitGround): on ground
// contact the engine looks up the rect regions under the aircraft
// (FsField::GetFieldRegion) and only ids 1 (runway) and 2 (taxiway) count as
// safe pavement (FsSimulation::IsSafeTerrainRegionId).  Without one, the PST
// AREA LAND only saves you from "splashed into the water": the touchdown is
// flagged out-of-runway, which either kills the flight (LANDEDOUTOFRUNWAY)
// or, when landing anywhere is allowed, sets IsOutOfRunway and the rollout
// gets the rough-field random pitch jolts above 8m/s.  Stock fields carry
// exactly this RGN over every runway (e.g. crescent.fld: ARE +-23.2 x
// +-1675.2, ID 1).
function runwayShapes({ x, z, headingDeg = 0, lengthM = 2000, widthM = 45 }) {
  const h = (headingDeg * Math.PI) / 180;          // compass: 0 = north = +Z, 90 = east = +X
  const fx = Math.sin(h), fz = Math.cos(h);        // forward (landing/takeoff direction)
  const rx = Math.cos(h), rz = -Math.sin(h);       // pilot's right
  const rect = (cf, cr, halfL, halfW) => {         // center offsets along f/r (m)
    const cx = x + fx * cf + rx * cr, cz = z + fz * cf + rz * cr;
    return [
      [cx + fx * halfL + rx * halfW, cz + fz * halfL + rz * halfW],
      [cx + fx * halfL - rx * halfW, cz + fz * halfL - rz * halfW],
      [cx - fx * halfL - rx * halfW, cz - fz * halfL - rz * halfW],
      [cx - fx * halfL + rx * halfW, cz - fz * halfL + rz * halfW],
    ];
  };
  const polys = [{ color: [88, 90, 94], points: rect(0, 0, lengthM / 2, widthM / 2) }];
  const white = [230, 232, 235];
  for (const end of [1, -1]) {                     // threshold bars
    polys.push({ color: white, points: rect(end * (lengthM / 2 - 22), 0, 10, widthM * 0.38) });
  }
  const dash = 22, gap = 38;                       // centerline dashes
  for (let s = -lengthM / 2 + 80; s + dash <= lengthM / 2 - 80; s += dash + gap) {
    polys.push({ color: white, points: rect(s + dash / 2, 0, dash / 2, 0.9) });
  }
  return {
    polys,
    landPad: rect(0, 0, lengthM / 2 + 10, widthM / 2 + 10),
    // RGN geometry: ARE is the min/max rect in the region's LOCAL frame (the
    // local +z axis runs along the runway), POS carries the rotation.  The
    // rotation is the ENGINE attitude (the same value the runway spawn
    // writes), so the region's long axis is exactly the pavement axis; 10m
    // margin matches the landPad.
    rgn: {
      x, z, headingDeg,
      halfW: widthM / 2 + 10, halfL: lengthM / 2 + 10,
    },
    start: {
      x: x - fx * (lengthM / 2 - 60), z: z - fz * (lengthM / 2 - 60),
      altM: 0, speedMS: 0, headingDeg,
    },
  };
}

// Approach aids for a runway, expressed as the stock ground objects the ENGINE
// actually interprets (there are no dedicated light primitives in .fld):
//   ILS        — fsgroundproperty.cpp reads ground/ils.acp: a 3deg / 33km
//                instrument beam offset 50m to the object's local +x.  The
//                object faces the APPROACHING aircraft (FsILS::GetDeviation
//                needs the aircraft in front), so heading = landing + 180 and
//                standing 50m right of the threshold puts the beam origin
//                exactly on the centerline (stock oracle: atsugi 01/19 — the
//                two beam origins line up at compass 010.0).
//   PAPI_LEFT / PAPI_RIGHT / VASI — VISLDAID templates; the engine recolors
//                their light faces by your live approach angle (SetPapiColor /
//                SetVasiColor).  Placement mirrors the stock fields: PAPI pair
//                ~300m past the threshold either side of the pavement,
//                VASI as near/far bar pairs (two-bar slope reference).
// Returns [{nam, x, z, headingDeg(compass), tag?}] for one runway.
export function runwayLightFixtures({ x, z, headingDeg = 0, lengthM = 2000, widthM = 45, ils, vaid, tag }) {
  const h = ((headingDeg || 0) * Math.PI) / 180;
  const fx = Math.sin(h), fz = Math.cos(h);   // landing direction
  const rx = Math.cos(h), rz = -Math.sin(h);  // pilot's right
  const at = (cf, cr) => ({ x: x + fx * cf + rx * cr, z: z + fz * cf + rz * cr });
  const back = ((headingDeg || 0) + 180) % 360; // faces the approach
  const halfL = lengthM / 2;
  const out = [];
  if (ils) out.push({ nam: 'ILS', ...at(-halfL, 50), headingDeg: back, tag });
  if (vaid === 'papi') {
    const side = widthM / 2 + 30;
    out.push({ nam: 'PAPI_LEFT',  ...at(-halfL + 300, -side), headingDeg: back });
    out.push({ nam: 'PAPI_RIGHT', ...at(-halfL + 300,  side), headingDeg: back });
  } else if (vaid === 'vasi') {
    const side = widthM / 2 + 25;
    for (const cf of [200, 375]) {   // downwind + upwind bars, 175m apart
      out.push({ nam: 'VASI', ...at(-halfL + cf, -side), headingDeg: back });
      out.push({ nam: 'VASI', ...at(-halfL + cf,  side), headingDeg: back });
    }
  }
  return out;
}

// "RW09"-style designator from a compass heading (0/360 -> 36, aviation style).
export const runwayDesignator = (headingDeg) =>
  'RW' + String(((Math.round(((headingDeg || 0) % 360 + 360) % 360 / 10) + 35) % 36) + 1).padStart(2, '0');

export function assembleSceneryZip(opts) {
  const {
    name, ground = [40, 90, 60], sky = [23, 106, 189], land = [60, 140, 80],
    startAltM = 1000, startSpeedMS = 100, islands = [],
    objects = [],    // [{nam, x, z, headingDeg?, tag?}] stock ground-object placements
    mountains = [],  // [{x, z, radiusM?, heightM?}] cosine-falloff TER hills
    starts = [],     // [{name?, x, z, altM?, speedMS?, headingDeg?}] extra spawn points
    runways = [],    // [{x, z, headingDeg?, lengthM?, widthM?, ils?, vaid?}] pavement runways
    recipe,
  } = migrateScenery(opts); // headingDeg is compass everywhere below
  const ident = sanitizeIdentify(name);
  if (!ident) throw new Error('workbench: map name is required');
  const packName = ident.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  const fileStem = packName;

  const polys = (islands || []).filter((i) => i && Array.isArray(i.points) && i.points.length >= 3);
  const rws = (runways || []).map(runwayShapes);
  const fldLines = [
    'FIELD',
    'GND ' + rgb(ground),
    'SKY ' + rgb(sky),
    'GNDSPECULAR TRUE',
    'DEFAREA WATER',
    'BASEELV 0.00m',
    'MAGVAR 0.00deg',
    'CANRESUME TRUE',
  ];
  if (polys.length > 0 || rws.length > 0) {
    // One .pc2 holding every island polygon + runway pavement (PLG paint order
    // = list order, so pavement then markings draw over the islands).
    const pc2 = ['Pict2'];
    const pc2Polys = [
      ...polys.map((p) => ({ color: p.color || land, points: p.points })),
      ...rws.flatMap((r) => r.polys),
    ];
    for (const p of pc2Polys) {
      pc2.push('PLG', 'COL ' + rgb(p.color));
      for (const [x, z] of p.points) pc2.push('VER ' + num(x, 2) + ' ' + num(z, 2));
      pc2.push('SPEC FALSE', 'ENDO');
    }
    pc2.push('ENDPICT');
    fldLines.push('PCK "00000000.pc2" ' + pc2.length);
    fldLines.push(...pc2);
    fldLines.push('', ''); // saver-style trailing blanks (ignored OUTSIDE the PCK count)
    fldLines.push('PC2', 'FIL "00000000.pc2"', 'POS 0.00 0.00 0.00 0.00 0.00 0.00', 'ID 0', 'END');
    const landLoops = [...polys.map((p) => p.points), ...rws.map((r) => r.landPad)];
    for (const points of landLoops) {
      fldLines.push('PST', 'ISLOOP TRUE', 'AREA LAND');
      for (const [x, z] of points) fldLines.push('PNT ' + num(x, 2) + ' 0.00 ' + num(z, 2));
      fldLines.push('FIL ""', 'POS 0.00 0.00 0.00 0.00 0.00 0.00', 'ID 0', 'END');
    }
    // ID-1 "safe pavement" region per runway (see runwayShapes) — this is
    // what makes touchdown and rollout count as ON the runway.
    for (const r of rws) {
      fldLines.push(
        'RGN',
        'ARE ' + num(-r.rgn.halfW, 2) + ' ' + num(-r.rgn.halfL, 2) + ' ' + num(r.rgn.halfW, 2) + ' ' + num(r.rgn.halfL, 2),
        'POS ' + num(r.rgn.x, 2) + ' 0.00 ' + num(r.rgn.z, 2) + ' ' + deg32768(compassToEngineDeg(r.rgn.headingDeg)) + ' 0 0',
        'ID 1',
        'END',
      );
    }
  }
  // Mountains: one PCK'd TER each; the PCK line count must equal the embedded
  // text EXACTLY, and the grid origin is the -X/-Z corner, so POS shifts the
  // grid by -radius to center it on the click point.  TER both draws the
  // terrain mesh and provides the ground elevation (max wins over BASEELV).
  (mountains || []).forEach((m, i) => {
    const ter = mountainTer(m);
    const fn = String(i).padStart(8, '0') + '.ter';
    fldLines.push('PCK "' + fn + '" ' + ter.length);
    fldLines.push(...ter);
    fldLines.push('', '');
    fldLines.push(
      'TER',
      'FIL "' + fn + '"',
      'POS ' + num(m.x - (m.radiusM || 1500), 2) + ' 0.00 ' + num(m.z - (m.radiusM || 1500), 2) + ' 0 0 0',
      'ID 0',
      'END',
    );
  });
  // Stock ground objects by IDENTIFY name (all 108 stock templates are in the
  // engine preload, so NAM always links).  No MPN/MPS = the object stays put —
  // including AIRCRAFTCARRIER, whose arresting wire + catapult still work.
  (objects || []).forEach((o, i) => {
    fldLines.push(
      'GOB',
      'POS ' + num(o.x, 2) + ' ' + num(o.y || 0, 2) + ' ' + num(o.z, 2) + ' ' + deg32768(compassToEngineDeg(o.headingDeg)) + ' 0 0',
      'ID 0',
      'TAG "WB_OBJ_' + i + '"',
      'NAM ' + o.nam,
      'IFF 0',
      'FLG 0',
      'END',
    );
  });
  // Runway approach aids ride as GOBs too; the ILS TAG is the name shown in
  // the in-flight ILS picker, stock style ("09-MYMAP" like "01-ATSUGI").
  (runways || []).forEach((rw) => {
    const tag = runwayDesignator(rw.headingDeg).slice(2) + '-' + ident;
    for (const g of runwayLightFixtures({ ...rw, tag })) {
      fldLines.push(
        'GOB',
        'POS ' + num(g.x, 2) + ' 0.00 ' + num(g.z, 2) + ' ' + deg32768(compassToEngineDeg(g.headingDeg)) + ' 0 0',
        'ID 0',
        ...(g.tag ? ['TAG "' + g.tag + '"'] : []),
        'NAM ' + g.nam,
        'IFF 0',
        'FLG 0',
        'END',
      );
    }
  });
  fldLines.push('');
  const fld = fldLines.join('\n');

  // Default spawn upwind of the origin so a drawn island around (0,0) is in
  // front of the nose: attitude 0 = compass north = +Z, so spawn SOUTH of the
  // origin (-Z); user-placed starts follow.
  const stpBlocks = [[
    'N ' + SCENERY_START,
    'C POSITION 0.00m ' + num(startAltM, 2) + 'm ' + num(polys.length || objects.length || mountains.length || rws.length ? -6000 : 0, 2) + 'm',
    'C ATTITUDE 0.00deg 0.00deg 0.00deg',
    'C INITSPED ' + num(startSpeedMS, 2) + 'm/s',
    'C CTLTHROT 0.80',
    'C CTLLDGEA FALSE',
  ]];
  const allStarts = [
    ...rws.map((r, i) => ({ name: 'RUNWAY' + String(i + 1).padStart(2, '0'), ...r.start })),
    ...(starts || []),
  ];
  allStarts.forEach((s, i) => {
    const speed = s.speedMS === undefined ? 100 : s.speedMS;
    stpBlocks.push([
      'N ' + sanitizeIdentify(s.name || 'START' + String(i + 2).padStart(2, '0')),
      'C POSITION ' + num(s.x, 2) + 'm ' + num(s.altM === undefined ? 1000 : s.altM, 2) + 'm ' + num(s.z, 2) + 'm',
      'C ATTITUDE ' + num(compassToEngineDeg(s.headingDeg), 2) + 'deg 0.00deg 0.00deg',
      'C INITSPED ' + num(speed, 2) + 'm/s',
      'C CTLTHROT ' + (speed > 0 ? '0.80' : '0.00'),
      'C CTLLDGEA ' + (speed < 40 ? 'TRUE' : 'FALSE'),
    ]);
  });
  const stp = stpBlocks.map((b) => b.join('\n')).join('\n\n') + '\n';

  // Community addon layout (see assembleAircraftZip): the scanned .lst stays
  // in scenery/, the payload ships under user/<packName>/.
  const enc = new TextEncoder();
  const payloadDir = 'user/' + packName + '/';
  const entries = {
    ['scenery/sce_' + packName + '.lst']: enc.encode(ident + ' ' + payloadDir + fileStem + '.fld ' + payloadDir + fileStem + '.stp\n'),
    [payloadDir + fileStem + '.fld']: enc.encode(fld),
    [payloadDir + fileStem + '.stp']: enc.encode(stp),
  };
  if (recipe) entries[RECIPE_FILE] = recipeEntry({ type: 'scenery', ...recipe, scenery: migrateScenery(recipe.scenery) });
  return { zipBytes: zipSync(entries), ident, packName };
}
