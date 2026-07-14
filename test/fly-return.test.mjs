// Unit tests for the ?return= whitelist validator (web/fly-return.js).
// Run with:  deno test test/fly-return.test.mjs
//
// The validator is the security gate that prevents open-redirect attacks when
// index.html navigates back to the originating studio page after a Quick Flight.

import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { validateReturnPage, RETURN_WHITELIST } from '../web/fly-return.js';

// ── Whitelist completeness ───────────────────────────────────────────────────

Deno.test('RETURN_WHITELIST contains exactly the four expected pages', () => {
  const sorted = [...RETURN_WHITELIST].sort();
  assertEquals(sorted, [
    'studio-aircraft.html',
    'studio-pack.html',
    'studio-scenery.html',
    'workbench.html',
  ]);
});

// ── Valid pages ──────────────────────────────────────────────────────────────

Deno.test('accepts workbench.html', () => {
  assertEquals(validateReturnPage('workbench.html'), 'workbench.html');
});

Deno.test('accepts studio-aircraft.html', () => {
  assertEquals(validateReturnPage('studio-aircraft.html'), 'studio-aircraft.html');
});

Deno.test('accepts studio-scenery.html', () => {
  assertEquals(validateReturnPage('studio-scenery.html'), 'studio-scenery.html');
});

Deno.test('accepts studio-pack.html', () => {
  assertEquals(validateReturnPage('studio-pack.html'), 'studio-pack.html');
});

// ── Rejection cases ───────────────────────────────────────────────────────────

Deno.test('rejects empty string', () => {
  assertEquals(validateReturnPage(''), null);
});

Deno.test('rejects null', () => {
  assertEquals(validateReturnPage(null), null);
});

Deno.test('rejects undefined', () => {
  assertEquals(validateReturnPage(undefined), null);
});

Deno.test('rejects absolute URL (https://)', () => {
  assertEquals(validateReturnPage('https://evil.example.com/'), null);
});

Deno.test('rejects absolute URL (http://)', () => {
  assertEquals(validateReturnPage('http://evil.example.com/'), null);
});

Deno.test('rejects protocol-relative URL (//)', () => {
  assertEquals(validateReturnPage('//evil.example.com/workbench.html'), null);
});

Deno.test('rejects dot-dot path traversal (../)', () => {
  assertEquals(validateReturnPage('../index.html'), null);
});

Deno.test('rejects dot-dot embedded in value (../evil)', () => {
  assertEquals(validateReturnPage('workbench.html/../../../etc/passwd'), null);
});

Deno.test('rejects forward-slash injection', () => {
  assertEquals(validateReturnPage('workbench.html/../../etc/passwd'), null);
});

Deno.test('rejects backslash injection', () => {
  assertEquals(validateReturnPage('workbench.html\\..\\evil'), null);
});

Deno.test('rejects colon (scheme separator / javascript:)', () => {
  assertEquals(validateReturnPage('javascript:alert(1)'), null);
});

Deno.test('rejects unknown filename not in whitelist (index.html)', () => {
  assertEquals(validateReturnPage('index.html'), null);
});

Deno.test('rejects unknown filename not in whitelist (admin.html)', () => {
  assertEquals(validateReturnPage('admin.html'), null);
});

Deno.test('rejects whitespace-only value', () => {
  assertEquals(validateReturnPage('   '), null);
});

// ── Edge cases ────────────────────────────────────────────────────────────────

Deno.test('case-insensitive: Workbench.html passes whitelist', () => {
  // validateReturnPage lower-cases for the whitelist check but returns the original.
  assertEquals(validateReturnPage('Workbench.html'), 'Workbench.html');
});

Deno.test('case-insensitive: Studio-Aircraft.html passes whitelist', () => {
  assertEquals(validateReturnPage('Studio-Aircraft.html'), 'Studio-Aircraft.html');
});
