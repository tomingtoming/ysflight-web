// Unit tests for web/settings.js — the flight.cfg merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../web/settings.js';

const { mergeFlightCfg, normalize, MANAGED_KEYS } = globalThis.ysfwSettings;

test('empty existing -> only the provided managed keys, appended', () => {
  assert.equal(
    mergeFlightCfg('', { DRWSHADOW: false, ANTIALIAS: true }),
    'DRWSHADOW FALSE\nANTIALIAS TRUE\n');
});

test('null existing behaves like empty', () => {
  assert.equal(mergeFlightCfg(null, { SIMPLEHUD: true }), 'SIMPLEHUD TRUE\n');
});

test('managed key present is rewritten IN PLACE, order preserved', () => {
  const existing = 'JSWARNING FALSE\nDRWSHADOW TRUE\nHUDALWAYS TRUE\n';
  assert.equal(
    mergeFlightCfg(existing, { DRWSHADOW: false }),
    'JSWARNING FALSE\nDRWSHADOW FALSE\nHUDALWAYS TRUE\n');
});

test('non-managed lines pass through verbatim', () => {
  const existing = 'DEFAIRPLN "F-15J_EAGLE"\nRADARALTI 3000.00m\n';
  const out = mergeFlightCfg(existing, { DRAWCLOUD: false });
  assert.match(out, /DEFAIRPLN "F-15J_EAGLE"/);
  assert.match(out, /RADARALTI 3000\.00m/);
  assert.match(out, /DRAWCLOUD FALSE/);
});

test('a managed line NOT in values passes through untouched', () => {
  // VISIBILIT is managed (increment 7) but absent from values here — e.g. an
  // engine-written line before the user ever opened the web Settings page.
  const out = mergeFlightCfg('VISIBILIT 5000.00m\n', { DRAWCLOUD: false });
  assert.match(out, /VISIBILIT 5000\.00m/);
});

test('mix of present-and-absent managed keys', () => {
  const existing = 'DRWSHADOW TRUE\n';
  const out = mergeFlightCfg(existing, { DRWSHADOW: false, SMKPARTCL: false });
  assert.equal(out, 'DRWSHADOW FALSE\nSMKPARTCL FALSE\n');
});

test('idempotent: merging the same values twice is stable', () => {
  const v = { DRWSHADOW: false, ANTIALIAS: true, SIMPLEHUD: true };
  const once = mergeFlightCfg('HUDALWAYS TRUE\n', v);
  const twice = mergeFlightCfg(once, v);
  assert.equal(once, twice);
});

test('a value for a non-managed key is ignored (never written)', () => {
  const out = mergeFlightCfg('', { HUDALWAYS: false, DRWSHADOW: true });
  assert.doesNotMatch(out, /HUDALWAYS/);
  assert.match(out, /DRWSHADOW TRUE/);
});

test('normalize fills engine defaults for missing/invalid entries', () => {
  const n = normalize({ DRWSHADOW: false, ANTIALIAS: 'yes' });
  assert.equal(n.DRWSHADOW, false);      // provided
  assert.equal(n.ANTIALIAS, false);      // invalid -> engine default (false)
  assert.equal(n.DRAWCLOUD, true);       // missing -> engine default (true)
  assert.equal(n.VISIBILIT, 20000);      // missing -> engine default (max)
  assert.equal(n.AIRLVODTL, 0);          // missing -> engine default (Automatic)
  assert.deepEqual(Object.keys(n).sort(), [...MANAGED_KEYS].sort());
});

// ---- Numeric/enum options (web-shell increment 7) ---------------------------

test('length option is written in the engine save format (N.00m), appended or in place', () => {
  assert.equal(mergeFlightCfg('', { VISIBILIT: 12500 }), 'VISIBILIT 12500.00m\n');
  assert.equal(
    mergeFlightCfg('VISIBILIT 20000.00m\nJSWARNING FALSE\n', { VISIBILIT: 800 }),
    'VISIBILIT 800.00m\nJSWARNING FALSE\n');
});

test('enum option is written as a bare integer', () => {
  assert.equal(mergeFlightCfg('', { AIRLVODTL: 2 }), 'AIRLVODTL 2\n');
});

test('normalize clamps a length to the engine bounds and rounds it', () => {
  assert.equal(normalize({ VISIBILIT: 100 }).VISIBILIT, 800);      // below min
  assert.equal(normalize({ VISIBILIT: 99999 }).VISIBILIT, 20000);  // above max
  assert.equal(normalize({ VISIBILIT: 12345.6 }).VISIBILIT, 12346);
  assert.equal(normalize({ VISIBILIT: '5000' }).VISIBILIT, 5000);  // numeric string ok
  assert.equal(normalize({ VISIBILIT: 'junk' }).VISIBILIT, 20000); // -> default
});

test('normalize rejects out-of-range or fractional enum values', () => {
  assert.equal(normalize({ AIRLVODTL: 2 }).AIRLVODTL, 2);
  assert.equal(normalize({ AIRLVODTL: '1' }).AIRLVODTL, 1);
  assert.equal(normalize({ AIRLVODTL: 3 }).AIRLVODTL, 0);    // out of range -> default
  assert.equal(normalize({ AIRLVODTL: -1 }).AIRLVODTL, 0);
  assert.equal(normalize({ AIRLVODTL: 1.5 }).AIRLVODTL, 0);  // fractional -> default
});

test('idempotent with numerics in the mix', () => {
  const v = normalize({ DRWSHADOW: false, VISIBILIT: 5000, AIRLVODTL: 1 });
  const once = mergeFlightCfg('HUDALWAYS TRUE\n', v);
  const twice = mergeFlightCfg(once, v);
  assert.equal(once, twice);
  assert.match(once, /VISIBILIT 5000\.00m/);
  assert.match(once, /AIRLVODTL 1/);
});
