// Unit tests for web/deeplink.js — the URL → engine-argv contract.
//
// The module is a classic script (index.html needs it before Module is
// defined), so it publishes on globalThis instead of exporting; import it for
// the side effect and read the API off globalThis.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../web/deeplink.js';

const { buildEngineArgs, deepLinkKind, isDirectBoot, launchTargets, USER_DIR } = globalThis.ysfwDeepLink;

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

test('host with a name -> -server + autoexit (direct boot)', () => {
  assert.deepEqual(
    buildEngineArgs('?host=1&name=Pilot'),
    ['-server', 'Pilot', '-autoexit']);
  assert.equal(deepLinkKind('?host=1&name=Pilot'), 'host');
  assert.equal(isDirectBoot('?host=1&name=Pilot'), true);
});

test('host field override rides along after the name', () => {
  assert.deepEqual(
    buildEngineArgs('?host=1&name=Pilot&field=ATSUGI_AIRBASE'),
    ['-server', 'Pilot', 'ATSUGI_AIRBASE', '-autoexit']);
});

test('host without a name adds no args (manual launch shows the host form)', () => {
  assert.deepEqual(buildEngineArgs('?host=1'), []);
  assert.equal(deepLinkKind('?host=1'), null);
  assert.equal(isDirectBoot('?host=1'), false);
  // Whitespace-only name is still "no name".
  assert.deepEqual(buildEngineArgs('?host=1&name=%20%20'), []);
  assert.equal(deepLinkKind('?host=1&name=%20%20'), null);
});

test('join wins over host: no -server in the argv', () => {
  // The join IIFE appends -client later; the engine acts on the LAST execution
  // mode parsed, so ?host= must stay out of the argv entirely.
  assert.deepEqual(buildEngineArgs('?host=1&name=Pilot&join=12345678'), []);
  assert.equal(deepLinkKind('?host=1&name=Pilot&join=12345678'), null);
});

test('landing practice: level clamped, aircraft/field default to F-18 at Aomori', () => {
  assert.deepEqual(
    buildEngineArgs('?landing=1'),
    ['-landingpractice', '1', 'F-18C_HORNET', 'AOMORI', '-autoexit']);
  assert.deepEqual(
    buildEngineArgs('?landing=12,F-15J_EAGLE,ATSUGI_AIRBASE'),
    ['-landingpractice', '12', 'F-15J_EAGLE', 'ATSUGI_AIRBASE', '-autoexit']);
  // Level junk/overflow clamps into 1-15.
  assert.deepEqual(
    buildEngineArgs('?landing=99')[1], '15');
  assert.deepEqual(
    buildEngineArgs('?landing=junk')[1], '1');
  assert.equal(deepLinkKind('?landing=1'), 'landing');
  assert.equal(isDirectBoot('?landing=1'), true);
});

test('auto demo: -demoforever with NO autoexit (the mode never returns to menu)', () => {
  assert.deepEqual(buildEngineArgs('?demo=1'), ['-demoforever']);
  assert.equal(deepLinkKind('?demo=1'), 'demo');
  assert.equal(isDirectBoot('?demo=1'), true);
});

test('extension missions: ?mission= boots the generated .yfs via -flyyfs', () => {
  assert.deepEqual(
    buildEngineArgs('?mission=racing'),
    ['-flyyfs', USER_DIR + '/__createflight.yfs', '-autoexit']);
  assert.equal(deepLinkKind('?mission=racing'), 'mission');
  assert.equal(isDirectBoot('?mission=cas'), true);
  // createflight wins when both are present (no double -flyyfs).
  const both = buildEngineArgs('?createflight=1&mission=racing');
  assert.equal(both.filter((t) => t === '-flyyfs').length, 1);
  assert.equal(deepLinkKind('?createflight=1&mission=racing'), 'createflight');
});

test('retry / openyfs: native Sim>Retry and File>Open as -flyyfs boots', () => {
  assert.deepEqual(
    buildEngineArgs('?retry=1'),
    ['-flyyfs', USER_DIR + '/prevflight.dat', '-autoexit']);
  assert.deepEqual(
    buildEngineArgs('?openyfs=1'),
    ['-flyyfs', USER_DIR + '/__openflight.yfs', '-autoexit']);
  assert.equal(deepLinkKind('?retry=1'), 'retry');
  assert.equal(deepLinkKind('?openyfs=1'), 'openyfs');
  assert.equal(isDirectBoot('?retry=1'), true);
  // Never two -flyyfs: createflight/mission win over retry/openyfs.
  const both = buildEngineArgs('?mission=racing&retry=1');
  assert.equal(both.filter((t) => t === '-flyyfs').length, 1);
  assert.match(both[1], /__createflight\.yfs$/);
});

test('openreplay: a recorded .yfs plays back via -replayrecord', () => {
  assert.deepEqual(
    buildEngineArgs('?openreplay=1'),
    ['-replayrecord', USER_DIR + '/__openflight.yfs', '-autoexit']);
  assert.equal(deepLinkKind('?openreplay=1'), 'openreplay');
  assert.equal(isDirectBoot('?openreplay=1'), true);
});

// ---- launchTargets: what the engine will actually fly (web/metrics.js) ------
// Read off buildEngineArgs's output on purpose, so the defaults are never
// duplicated: a usage metric that reported "no field" for a bare
// ?freeflight=CESSNA_172R would be describing a flight that never happened.

test('launchTargets: nothing to report for a manual launch', () => {
  assert.deepEqual(launchTargets(''), { aircraft: '', field: '' });
});

test('launchTargets: freeflight, with the default field filled in', () => {
  assert.deepEqual(launchTargets('?freeflight=CESSNA_172R'),
    { aircraft: 'CESSNA_172R', field: 'ATSUGI_AIRBASE' });
  assert.deepEqual(launchTargets('?freeflight=F-18C_HORNET,HEATHROW,RW27R'),
    { aircraft: 'F-18C_HORNET', field: 'HEATHROW' });
});

test('launchTargets: the other engine missions', () => {
  assert.deepEqual(launchTargets('?endurance=F-18C_HORNET,AOMORI,2,3,1'),
    { aircraft: 'F-18C_HORNET', field: 'AOMORI' });
  assert.deepEqual(launchTargets('?intercept=F-18C_HORNET,AOMORI'),
    { aircraft: 'F-18C_HORNET', field: 'AOMORI' });
  // -landingpractice LEVEL AIRPLANE FIELD -- the level sits where the aircraft
  // does in the others, so the offsets are not interchangeable.
  assert.deepEqual(launchTargets('?landing=7'),
    { aircraft: 'F-18C_HORNET', field: 'AOMORI' });
  assert.deepEqual(launchTargets('?landing=3,CESSNA_172R,HEATHROW'),
    { aircraft: 'CESSNA_172R', field: 'HEATHROW' });
});

test('launchTargets: hosting reports the field, never the pilot name', () => {
  assert.deepEqual(launchTargets('?host=1&name=toming'), { aircraft: '', field: '' });
  assert.deepEqual(launchTargets('?host=1&name=toming&field=AOMORI'),
    { aircraft: '', field: 'AOMORI' });
});

test('launchTargets: the .yfs kinds hide the aircraft in a file, and say so', () => {
  for (const q of ['?createflight=1', '?mission=racing', '?retry=1', '?openyfs=1', '?replay=x.yfs']) {
    assert.deepEqual(launchTargets(q), { aircraft: '', field: '' }, q);
  }
});
