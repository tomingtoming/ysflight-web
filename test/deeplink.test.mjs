// Unit tests for web/deeplink.js — the URL → engine-argv contract.
//
// The module is a classic script (index.html needs it before Module is
// defined), so it publishes on globalThis instead of exporting; import it for
// the side effect and read the API off globalThis.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../web/deeplink.js';

const { buildEngineArgs, deepLinkKind, isDirectBoot, USER_DIR } = globalThis.ysfwDeepLink;

test('no params -> empty argv (manual launch)', () => {
  assert.deepEqual(buildEngineArgs(''), []);
  assert.equal(deepLinkKind(''), null);
  assert.equal(isDirectBoot(''), false);
});

test('lang alone -> -language only', () => {
  assert.deepEqual(buildEngineArgs('?lang=ja'), ['-language', 'ja']);
  assert.equal(deepLinkKind('?lang=ja'), null);
});

test('freeflight full triple', () => {
  assert.deepEqual(
    buildEngineArgs('?freeflight=F-18C_HORNET,ATSUGI_AIRBASE,RW01_01'),
    ['-freeflight', 'F-18C_HORNET', 'ATSUGI_AIRBASE', 'RW01_01', '-autoexit']);
  assert.equal(deepLinkKind('?freeflight=X'), 'freeflight');
});

test('freeflight defaults: bare aircraft gets Atsugi + airborne start', () => {
  assert.deepEqual(
    buildEngineArgs('?freeflight=CESSNA_172R'),
    ['-freeflight', 'CESSNA_172R', 'ATSUGI_AIRBASE', 'NORTH10000_01', '-autoexit']);
});

test('lang + freeflight compose in order (language first)', () => {
  assert.deepEqual(
    buildEngineArgs('?freeflight=B747,HEATHROW,RW27R&lang=en'),
    ['-language', 'en', '-freeflight', 'B747', 'HEATHROW', 'RW27R', '-autoexit']);
});

test('endurance full: aircraft,field,wingmen,level,aam', () => {
  assert.deepEqual(
    buildEngineArgs('?endurance=F-15J_EAGLE,SMALL_MAP,1,4,0'),
    ['-endurance', 'F-15J_EAGLE', 'SMALL_MAP', '1', '4', '0', '-autoexit']);
  assert.equal(deepLinkKind('?endurance=F-15J_EAGLE'), 'endurance');
  assert.equal(isDirectBoot('?endurance=F-15J_EAGLE'), true);
});

test('endurance defaults: bare aircraft -> Atsugi, 2 wingmen, level 3, AAM on', () => {
  assert.deepEqual(
    buildEngineArgs('?endurance=F-15J_EAGLE'),
    ['-endurance', 'F-15J_EAGLE', 'ATSUGI_AIRBASE', '2', '3', '1', '-autoexit']);
});

test('endurance numeric params are clamped and junk-proofed', () => {
  // wingmen 9 -> 2 (max), level 0 -> 1 (min), aam junk -> default 1
  assert.deepEqual(
    buildEngineArgs('?endurance=A,F,9,0,junk'),
    ['-endurance', 'A', 'F', '2', '1', '1', '-autoexit']);
});

test('replay name is sanitized to a bare file name under replays/', () => {
  assert.deepEqual(
    buildEngineArgs('?replay=rec1.yfs'),
    ['-replayrecord', USER_DIR + '/replays/rec1.yfs', '-autoexit']);
  // Path-escape attempts collapse to a safe bare name.
  assert.deepEqual(
    buildEngineArgs('?replay=' + encodeURIComponent('../../etc/passwd')),
    ['-replayrecord', USER_DIR + '/replays/....etcpasswd', '-autoexit']);
});

test('replay that sanitizes to nothing adds no args', () => {
  assert.deepEqual(buildEngineArgs('?replay=' + encodeURIComponent('/\\:')), []);
});

test('URLSearchParams input is accepted as well as strings', () => {
  assert.deepEqual(
    buildEngineArgs(new URLSearchParams('?endurance=A')),
    ['-endurance', 'A', 'ATSUGI_AIRBASE', '2', '3', '1', '-autoexit']);
});

test('intercept full: argv mirrors the engine flag order', () => {
  assert.deepEqual(
    buildEngineArgs('?intercept=F-15J_EAGLE,SMALL_MAP,1,0,0,1,5,0'),
    ['-intercept', 'F-15J_EAGLE', 'SMALL_MAP', '1', '0', '0', '1', '5', '0', '-autoexit']);
  assert.equal(deepLinkKind('?intercept=F-15J_EAGLE'), 'intercept');
  assert.equal(isDirectBoot('?intercept=F-15J_EAGLE'), true);
});

test('intercept defaults: escorted heavy-bomber raid, 3 attackers, 2 wingmen', () => {
  assert.deepEqual(
    buildEngineArgs('?intercept=F-15J_EAGLE'),
    ['-intercept', 'F-15J_EAGLE', 'ATSUGI_AIRBASE', '0', '1', '1', '1', '3', '2', '-autoexit']);
});

test('intercept numeric params are clamped and junk-proofed', () => {
  // stealth 9 -> 1, attackers 0 -> 1, wingmen junk -> default 2
  assert.deepEqual(
    buildEngineArgs('?intercept=A,F,9,1,1,1,0,junk'),
    ['-intercept', 'A', 'F', '1', '1', '1', '1', '1', '2', '-autoexit']);
});
