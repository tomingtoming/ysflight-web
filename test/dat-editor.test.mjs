// Tests for the .dat editor: parseDat / serializeDat / editDatKey (non-destructive),
// plus schema coverage against the C++ keyWordSource[] array.
//
// Run: node --test test/dat-editor.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDat, serializeDat, editDatKey, splitUnit } from '../web/studio-dat.js';
import { DAT_SCHEMA } from '../web/dat-schema.js';

const here = dirname(fileURLToPath(import.meta.url));

// The upstream submodule may not be initialized in a worktree; fall back to
// the nearest ancestor repo that has it checked out.
function findUpstream() {
  let dir = join(here, '..');
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'upstream', 'YSFLIGHT');
    if (existsSync(join(candidate, 'runtime', 'aircraft'))) return candidate;
    // Also try walking upward from a worktree (main checkout is 4 levels up).
    dir = join(dir, '..');
  }
  return join(here, '..', 'upstream', 'YSFLIGHT'); // best-effort fallback
}

const UPSTREAM = findUpstream();
const AIRCRAFT_DIR = join(UPSTREAM, 'runtime', 'aircraft');
const CPP_PATH = join(UPSTREAM, 'src', 'vehicle', 'fsairplaneproperty.cpp');

// latin1 helpers (same codec as the modules).
const s2b = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const b2s = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};

// ---- Test a) Non-destructive round-trip ------------------------------------------------

test('round-trip: parseDat + serializeDat is byte-identical for real .dat files', () => {
  const datFiles = readdirSync(AIRCRAFT_DIR).filter((n) => n.endsWith('.dat'));
  assert.ok(datFiles.length >= 3, 'need at least 3 .dat files; found: ' + datFiles.length);

  // Test at least f15.dat + 2 others.
  const targets = ['f15.dat', datFiles[1] || '', datFiles[2] || ''].filter(Boolean).slice(0, 5);

  for (const name of targets) {
    const bytes = readFileSync(join(AIRCRAFT_DIR, name));
    const parsed = parseDat(bytes);
    const out = serializeDat(parsed);
    assert.equal(
      Buffer.from(out).compare(Buffer.from(bytes)),
      0,
      name + ': round-trip produced different bytes',
    );
  }
});

// ---- Test b) Form edit: only the target line changes --------------------------------

test('form edit: MAXSPEED change only modifies that line, line count unchanged, REM untouched', () => {
  const datText =
    'REM TEST FILE\n' +
    'IDENTIFY "TEST"\n' +
    'CATEGORY FIGHTER\n' +
    'MAXSPEED 2.0MACH\n' +
    'STRENGTH 10\n' +
    'REM another comment\n';
  const bytes = s2b(datText);
  const parsed = parseDat(bytes);

  const origLineCount = parsed.lines.length;
  editDatKey(parsed, 'MAXSPEED', '3.0MACH');

  // Line count unchanged (MAXSPEED was already present).
  assert.equal(parsed.lines.length, origLineCount, 'line count must not change when editing existing key');

  // MAXSPEED line changed.
  const outText = b2s(serializeDat(parsed));
  assert.match(outText, /^MAXSPEED 3\.0MACH$/m, 'new MAXSPEED value must appear');
  assert.doesNotMatch(outText, /^MAXSPEED 2\.0MACH$/m, 'old MAXSPEED value must be gone');

  // REM lines untouched.
  assert.match(outText, /^REM TEST FILE$/m, 'first REM line preserved');
  assert.match(outText, /^REM another comment$/m, 'second REM line preserved');

  // Other lines untouched.
  assert.match(outText, /^IDENTIFY "TEST"$/m);
  assert.match(outText, /^CATEGORY FIGHTER$/m);
  assert.match(outText, /^STRENGTH 10$/m);
});

test('form edit: adding a new keyword appends it without disturbing existing lines', () => {
  const datText = 'IDENTIFY "NEWBIRD"\nCATEGORY ATTACKER\n';
  const parsed = parseDat(s2b(datText));
  const origCount = parsed.lines.length;

  editDatKey(parsed, 'MAXSPEED', '1.5MACH');

  // Line count increased by 1.
  assert.equal(parsed.lines.length, origCount + 1, 'new keyword adds one line');
  const outText = b2s(serializeDat(parsed));
  assert.match(outText, /^MAXSPEED 1\.5MACH$/m, 'new keyword present');
  assert.match(outText, /^IDENTIFY "NEWBIRD"$/m, 'existing line unchanged');
});

test('form edit: real stock f15.dat — MAXSPEED edit preserves everything else byte-for-byte', () => {
  const bytes = readFileSync(join(AIRCRAFT_DIR, 'f15.dat'));
  const parsed = parseDat(bytes);
  const origText = b2s(bytes);
  const origLines = origText.split('\n');

  editDatKey(parsed, 'MAXSPEED', '999m/s');

  const outText = b2s(serializeDat(parsed));
  const outLines = outText.split('\n');

  // Same total line count.
  assert.equal(outLines.length, origLines.length, 'line count must be identical');

  // Only the MAXSPEED line differs.
  let diffCount = 0;
  for (let i = 0; i < origLines.length; i++) {
    if (origLines[i] !== outLines[i]) diffCount++;
  }
  assert.equal(diffCount, 1, 'exactly one line should differ');

  // The differing line contains MAXSPEED with new value.
  assert.match(outText, /^MAXSPEED 999m\/s$/m);
});

// ---- Test c) Schema coverage -------------------------------------------------------

test('schema: all 189 keywords from keyWordSource[] are in DAT_SCHEMA in index order', () => {
  // Extract quoted strings from keyWordSource[] in the C++ file.
  const cpp = readFileSync(CPP_PATH, 'latin1');

  // Find the keyWordSource array between the two markers.
  const startIdx = cpp.indexOf('FsAirplaneProperty::keyWordSource[]');
  assert.ok(startIdx >= 0, 'could not find keyWordSource in cpp file');
  const blockEnd = cpp.indexOf('NULL', startIdx);
  assert.ok(blockEnd >= 0, 'could not find NULL terminator in keyWordSource');
  const block = cpp.slice(startIdx, blockEnd);

  // Extract keyword array entries: lines starting with optional whitespace then a quoted
  // uppercase string followed by a comma (the C++ array entry pattern).
  // This deliberately excludes strings in inline comments like "PILOT" or "GUNNER".
  const cppKws = [];
  const re = /^[ \t]+"([A-Z_0-9]{3,8})",/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    cppKws.push(m[1]);
  }

  assert.ok(cppKws.length >= 180, 'should find at least 180 keywords in C++ source; found: ' + cppKws.length);
  assert.equal(cppKws.length, 189, 'C++ keyWordSource must have exactly 189 entries (0-188)');

  const schemaKws = DAT_SCHEMA.map((k) => k.kw);
  assert.equal(schemaKws.length, 189, 'DAT_SCHEMA must have exactly 189 entries');

  // Every C++ keyword must appear in the schema (same order).
  for (let i = 0; i < cppKws.length; i++) {
    assert.equal(
      schemaKws[i], cppKws[i],
      `index ${i}: schema has "${schemaKws[i]}" but C++ has "${cppKws[i]}"`,
    );
  }
});

test('schema: SCHEMA_BY_KW map has all 189 keywords', async () => {
  const { SCHEMA_BY_KW } = await import('../web/dat-schema.js');
  assert.equal(SCHEMA_BY_KW.size, 189);
  assert.ok(SCHEMA_BY_KW.has('MAXSPEED'));
  assert.ok(SCHEMA_BY_KW.has('AFTBURNR'));
  assert.ok(SCHEMA_BY_KW.has('INITZOOM'));
});

// ---- Test d) Unknown keyword preservation ------------------------------------------

test('unknown keyword: FUTUREKEY is preserved unchanged through a MAXSPEED edit', () => {
  const datText =
    'IDENTIFY "FUTURE"\n' +
    'MAXSPEED 2.0MACH\n' +
    'FUTUREKEY some args here\n' +
    'STRENGTH 10\n';
  const parsed = parseDat(s2b(datText));

  editDatKey(parsed, 'MAXSPEED', '3.0MACH');

  const outText = b2s(serializeDat(parsed));
  assert.match(outText, /^FUTUREKEY some args here$/m, 'unknown keyword line preserved exactly');
  assert.match(outText, /^MAXSPEED 3\.0MACH$/m, 'edited line changed');
  assert.match(outText, /^IDENTIFY "FUTURE"$/m, 'other lines untouched');
  assert.match(outText, /^STRENGTH 10$/m, 'other lines untouched');
});

test('unknown keyword: multiple unknown keywords all survive a round-trip', () => {
  const datText =
    'NEWKEY1 value1\n' +
    'NEWKEY2 value2\n' +
    'MAXSPEED 1.5MACH\n' +
    'NEWKEY3 value3 with spaces\n';
  const bytes = s2b(datText);
  const parsed = parseDat(bytes);
  const out = serializeDat(parsed);
  assert.equal(Buffer.from(out).compare(Buffer.from(bytes)), 0, 'no-edit round-trip must be byte-identical');

  editDatKey(parsed, 'MAXSPEED', '2.0MACH');
  const outText = b2s(serializeDat(parsed));
  assert.match(outText, /^NEWKEY1 value1$/m);
  assert.match(outText, /^NEWKEY2 value2$/m);
  assert.match(outText, /^NEWKEY3 value3 with spaces$/m);
});

// ---- splitUnit: unit-suffix preservation for numeric form fields ---------------------

test('splitUnit: splits number and unit suffix, round-trips exactly', () => {
  assert.deepEqual(splitUnit('2.2MACH'), { num: '2.2', suffix: 'MACH' });
  assert.deepEqual(splitUnit('13.6t'), { num: '13.6', suffix: 't' });
  assert.deepEqual(splitUnit('0.35rad'), { num: '0.35', suffix: 'rad' });
  assert.deepEqual(splitUnit('100%'), { num: '100', suffix: '%' });
  assert.deepEqual(splitUnit('-12.5deg'), { num: '-12.5', suffix: 'deg' });
  assert.deepEqual(splitUnit('58m^2'), { num: '58', suffix: 'm^2' });
  assert.deepEqual(splitUnit('40kt'), { num: '40', suffix: 'kt' });
  assert.deepEqual(splitUnit('999m/s'), { num: '999', suffix: 'm/s' });
  assert.deepEqual(splitUnit('8.0'), { num: '8.0', suffix: '' });
  assert.deepEqual(splitUnit('.5t'), { num: '.5', suffix: 't' });

  // Round-trip invariant: num + suffix reconstructs the original (trimmed) value.
  for (const v of ['2.2MACH', '13.6t', '0.35rad', '100%', '-12.5deg', '58m^2', '6.5kg', '2000ft', '8.0', '.5t']) {
    const { num, suffix } = splitUnit(v);
    assert.equal(num + suffix, v, v + ': num+suffix must reconstruct the original');
  }
});

test('splitUnit: unparseable values return num=null (raw-text fallback)', () => {
  assert.equal(splitUnit('').num, null);
  assert.equal(splitUnit('TRUE').num, null);
  assert.equal(splitUnit('"F-15C_EAGLE"').num, null);
  assert.equal(splitUnit('FIGHTER').num, null);
});

test('splitUnit: every numeric value in stock f15.dat splits and round-trips', () => {
  // Regression net for the editor's numeric fields: each single-arg numeric
  // keyword in a real stock file must be splittable so the form shows the
  // number and preserves the suffix on write-back.
  const bytes = readFileSync(join(AIRCRAFT_DIR, 'f15.dat'));
  const { parsed } = parseDat(bytes);
  const NUMERIC = new Set(['force', 'weight', 'speed', 'angle', 'length', 'area', 'scalar']);
  let checked = 0;
  for (const schema of DAT_SCHEMA) {
    if (!NUMERIC.has(schema.type)) continue;
    for (const entry of parsed.get(schema.kw) || []) {
      const val = entry.value.split(/\s+|#/)[0]; // first token, comments off
      if (!val) continue;
      const { num, suffix } = splitUnit(val);
      assert.notEqual(num, null, schema.kw + ' "' + val + '" must split');
      assert.equal(num + suffix, val, schema.kw + ' "' + val + '" must round-trip');
      checked++;
    }
  }
  assert.ok(checked >= 20, 'expected many numeric values in f15.dat; checked ' + checked);
});
