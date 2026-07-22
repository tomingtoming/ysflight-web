// Unit tests for web/controls.js — the ctlassign.cfg merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../web/controls.js';

const { mergeCtlAssign, normalize, gamepadPreset, AXIS_FUNCS, BUTTON_FUNCS } = globalThis.ysfwControls;

// A miniature default-ish file: keyboard, mouse, an old pad line, dead zones.
const BASE = [
  'VER 20181124',
  'AXS M 0 TURRETHDG ',
  'AXS 0 0 THROTTLE ',       // old pad binding the web must replace
  'TRG M 0 FIREWEAPON',
  'TRG 2 5 RADAR',           // old pad binding on another device
  'KEY SPACE FIREWEAPON',
  'KEY G LANDINGGEAR',
  'DZELV2 0.030',
  'HATSW TRUE',
  'END',
  'REM documentation tail',
].join('\n');

test('pad lines are replaced wholesale; mouse/KEY/HATSW/REM pass through', () => {
  const out = mergeCtlAssign(BASE, {
    axes: [{ dev: 0, axis: 1, func: 'ELEVATOR', rev: true }],
    btns: [{ dev: 0, btn: 2, func: 'LANDINGGEAR' }],
  });
  assert.match(out, /AXS 0 1 ELEVATOR REV/);
  assert.match(out, /TRG 0 2 LANDINGGEAR/);
  // Old pad lines gone — including on OTHER devices (web owns all pads).
  assert.doesNotMatch(out, /AXS 0 0 THROTTLE/);
  assert.doesNotMatch(out, /TRG 2 5 RADAR/);
  // Non-pad lines intact.
  assert.match(out, /AXS M 0 TURRETHDG/);
  assert.match(out, /TRG M 0 FIREWEAPON/);
  assert.match(out, /KEY SPACE FIREWEAPON/);
  assert.match(out, /KEY G LANDINGGEAR/);
  assert.match(out, /HATSW TRUE/);
  assert.match(out, /REM documentation tail/);
  // Web lines come before END.
  assert.ok(out.indexOf('AXS 0 1 ELEVATOR') < out.indexOf('END'));
});

test('dead zones rewrite existing lines and add missing ones before END', () => {
  const out = mergeCtlAssign(BASE, { dz: { elv: 0.05, rud: 0.01 } });
  assert.match(out, /DZELV2 0\.050/);   // rewritten in place
  assert.match(out, /DZRUD2 0\.010/);   // added (was missing)
  assert.doesNotMatch(out, /DZELV2 0\.030/);
  assert.ok(out.indexOf('DZRUD2') < out.indexOf('END'));
});

test('a file with NO pad lines gets the web lines inserted before END', () => {
  const noPad = 'VER 20181124\nKEY SPACE FIREWEAPON\nEND\n';
  const out = mergeCtlAssign(noPad, { btns: [{ dev: 1, btn: 0, func: 'FIREWEAPON' }] });
  assert.match(out, /TRG 1 0 FIREWEAPON/);
  assert.ok(out.indexOf('TRG 1 0') < out.indexOf('END'));
});

test('no existing file -> merge into the synthesized engine default', () => {
  const out = mergeCtlAssign(null, { btns: [{ dev: 1, btn: 0, func: 'FIREWEAPON' }] });
  // The web binding is there, the default KEYBOARD map is fully carried
  // (a partial file would wipe it — Load's CleanUp runs when the file opens),
  // and the default pad-0 lines were replaced by the model's.
  assert.match(out, /TRG 1 0 FIREWEAPON/);
  assert.match(out, /^VER 20181124/);
  assert.match(out, /KEY SPACE FIREWEAPON/);
  assert.match(out, /KEY G LANDINGGEAR/);
  assert.match(out, /KEY F12 INFLTMESSAGE/);
  assert.match(out, /KEY HOME OPENSUPPLYDLG/);
  assert.match(out, /AXS M 0 TURRETHDG/);
  assert.match(out, /HATSW TRUE/);
  assert.doesNotMatch(out, /AXS 0 0 AILERON/);  // default pad lines replaced
  assert.ok(out.indexOf('TRG 1 0') < out.indexOf('END'));
  // 57 KEY lines = the full SetDefaultKeyAssign map (non-Apple branch).
  assert.equal((out.match(/^KEY /gm) || []).length, 57);
});

test('defaultCtlAssign alone is a complete default file', () => {
  const d = globalThis.ysfwControls.defaultCtlAssign();
  assert.match(d, /AXS 0 0 AILERON/);
  assert.match(d, /TRG 0 3 DISPENSEFLARE/);
  assert.match(d, /DZRUD2 0\.030/);
  assert.match(d, /\nEND\n/);
});

test('merge is idempotent', () => {
  const model = { axes: [{ dev: 0, axis: 0, func: 'AILERON' }], dz: { elv: 0.04 } };
  const once = mergeCtlAssign(BASE, model);
  assert.equal(mergeCtlAssign(once, model), once);
});

test('normalize drops invalid entries and clamps dead zones', () => {
  const n = normalize({
    axes: [
      { dev: 0, axis: 0, func: 'AILERON' },
      { dev: 9, axis: 0, func: 'AILERON' },     // bad device
      { dev: 0, axis: 7, func: 'AILERON' },     // bad axis
      { dev: 0, axis: 1, func: 'NOTAFUNC' },    // unknown token
    ],
    btns: [{ dev: 0, btn: 40, func: 'RADAR' }], // bad button
    dz: { elv: 5, ail: -1, rud: 'junk' },
  });
  assert.equal(n.axes.length, 1);
  assert.equal(n.btns.length, 0);
  assert.equal(n.dz.elv, 0.2);   // clamped
  assert.equal(n.dz.ail, 0);
  assert.equal(n.dz.rud, null);  // invalid -> unset (line left alone)
});

test('normalize keeps ONE binding per (dev,axis) slot — last wins', () => {
  const n = normalize({ axes: [
    { dev: 0, axis: 0, func: 'AILERON' },
    { dev: 0, axis: 0, func: 'RUDDER' },
  ] });
  assert.equal(n.axes.length, 1);
  assert.equal(n.axes[0].func, 'RUDDER');
});

test('gamepad preset mirrors the engine SetDefaultGamePad shape', () => {
  const p = gamepadPreset(0);
  assert.equal(p.axes.length, 4);
  assert.deepEqual(p.axes[3], { dev: 0, axis: 3, func: 'THROTTLEUPDOWN', rev: true });
  assert.equal(p.btns.length, 8);
  assert.equal(p.btns[0].func, 'FIREWEAPON');
  // Every preset token is on the curated lists (page can render them).
  for (const a of p.axes) assert.ok(AXIS_FUNCS.includes(a.func));
  for (const b of p.btns) assert.ok(BUTTON_FUNCS.includes(b.func));
});
