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
