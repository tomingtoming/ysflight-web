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
  const existing = 'DEFAIRPLN "F-15J_EAGLE"\nVISIBILIT 20000.00m\n';
  const out = mergeFlightCfg(existing, { DRAWCLOUD: false });
  assert.match(out, /DEFAIRPLN "F-15J_EAGLE"/);
  assert.match(out, /VISIBILIT 20000\.00m/);
  assert.match(out, /DRAWCLOUD FALSE/);
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
  assert.deepEqual(Object.keys(n).sort(), [...MANAGED_KEYS].sort());
});
