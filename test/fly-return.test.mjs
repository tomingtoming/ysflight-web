// Unit tests for the ?return= whitelist validator (web/fly-return.js).
// Runs with node --test (CI: scripts/test.sh) and also with deno test.
//
// The validator is the security gate that prevents open-redirect attacks when
// index.html navigates back to the originating studio page after a Quick Flight.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateReturnPage, RETURN_WHITELIST } from '../web/fly-return.js';

// ── Whitelist completeness ───────────────────────────────────────────────────

test('RETURN_WHITELIST contains exactly the four expected pages', () => {
  const sorted = [...RETURN_WHITELIST].sort();
  assert.deepEqual(sorted, [
    'studio-aircraft.html',
    'studio-pack.html',
    'studio-scenery.html',
    'workbench.html',
  ]);
});

// ── Valid pages ──────────────────────────────────────────────────────────────

test('accepts workbench.html', () => {
  assert.equal(validateReturnPage('workbench.html'), 'workbench.html');
});

test('accepts studio-aircraft.html', () => {
  assert.equal(validateReturnPage('studio-aircraft.html'), 'studio-aircraft.html');
});

test('accepts studio-scenery.html', () => {
  assert.equal(validateReturnPage('studio-scenery.html'), 'studio-scenery.html');
});

test('accepts studio-pack.html', () => {
  assert.equal(validateReturnPage('studio-pack.html'), 'studio-pack.html');
});

// ── Rejection cases ───────────────────────────────────────────────────────────

test('rejects empty string', () => {
  assert.equal(validateReturnPage(''), null);
});

test('rejects null', () => {
  assert.equal(validateReturnPage(null), null);
});

test('rejects undefined', () => {
  assert.equal(validateReturnPage(undefined), null);
});

test('rejects absolute URL (https://)', () => {
  assert.equal(validateReturnPage('https://evil.example.com/'), null);
});

test('rejects absolute URL (http://)', () => {
  assert.equal(validateReturnPage('http://evil.example.com/'), null);
});

test('rejects protocol-relative URL (//)', () => {
  assert.equal(validateReturnPage('//evil.example.com/workbench.html'), null);
});

test('rejects dot-dot path traversal (../)', () => {
  assert.equal(validateReturnPage('../index.html'), null);
});

test('rejects dot-dot embedded in value', () => {
  assert.equal(validateReturnPage('workbench.html/../../../etc/passwd'), null);
});

test('rejects forward-slash injection', () => {
  assert.equal(validateReturnPage('workbench.html/../../etc/passwd'), null);
});

test('rejects backslash injection', () => {
  assert.equal(validateReturnPage('workbench.html\\..\\evil'), null);
});

test('rejects colon (scheme separator / javascript:)', () => {
  assert.equal(validateReturnPage('javascript:alert(1)'), null);
});

test('rejects unknown filename (index.html)', () => {
  assert.equal(validateReturnPage('index.html'), null);
});

test('rejects unknown filename (admin.html)', () => {
  assert.equal(validateReturnPage('admin.html'), null);
});

test('rejects whitespace-only value', () => {
  assert.equal(validateReturnPage('   '), null);
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test('case-insensitive: Workbench.html is accepted (returns original case)', () => {
  assert.equal(validateReturnPage('Workbench.html'), 'Workbench.html');
});

test('case-insensitive: Studio-Aircraft.html is accepted (returns original case)', () => {
  assert.equal(validateReturnPage('Studio-Aircraft.html'), 'Studio-Aircraft.html');
});