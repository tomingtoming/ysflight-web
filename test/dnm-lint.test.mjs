// Unit tests for the nightmare linter (web/dnm-lint.js): every pathology gets
// a sick/healthy fixture pair (the sick one must be detected, the healthy one
// must stay silent), plus a stock-fleet smoke that pins the calibration —
// stock aircraft lint with zero errors and their warns stay in the known,
// explicable set.  Pure parser + linter, no Three.js: runs under plain Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintDnm, lintSrf, lintAuto, RULES } from '../web/dnm-lint.js';

const here = dirname(fileURLToPath(import.meta.url));
const enc = (s) => new TextEncoder().encode(s);

// --- tiny DNM builder ---------------------------------------------------------------

// srf: array of raw SRF lines (SURF / V / F..E / ZA...).
// node: {label, srf, cla, sta, pos, cnt, children}
function dnm(pcks, nodes) {
  const out = ['DYNAMODEL', 'DNMVER 1'];
  for (const p of pcks) {
    out.push('PCK ' + p.name + ' ' + p.lines.length);
    out.push(...p.lines);
  }
  for (const n of nodes) {
    out.push('SRF "' + n.label + '"');
    out.push('FIL ' + n.srf);
    out.push('CLA ' + (n.cla || 0));
    const sta = n.sta || [[0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 1]];
    out.push('NST ' + sta.length);
    for (const s of sta) out.push('STA ' + s.join(' '));
    out.push('POS ' + (n.pos || [0, 0, 0, 0, 0, 0]).join(' ') + ' 1');
    out.push('CNT ' + (n.cnt || [0, 0, 0]).join(' '));
    out.push('NCH ' + (n.children || []).length);
    for (const c of n.children || []) out.push('CLD "' + c + '"');
    out.push('END');
  }
  out.push('END');
  return enc(out.join('\n') + '\n');
}

// A unit quad in the y=0 plane at offset (ox, oy, oz); winding gives the
// Newell normal (0,-1,0).  extra: lines injected inside the F block.
const quadSrf = (opts) => {
  const { ox = 0, oy = 0, oz = 0, n = null, extra = [] } = opts || {};
  return [
    'SURF',
    `V ${ox} ${oy} ${oz}`, `V ${ox + 1} ${oy} ${oz}`, `V ${ox + 1} ${oy} ${oz + 1}`, `V ${ox} ${oy} ${oz + 1}`,
    'F', ...(extra), 'V 0 1 2 3', ...(n ? ['N ' + n] : []), 'C 100 100 100', 'E',
  ];
};

const rulesOf = (res) => res.findings.map((f) => f.rule);
const get = (res, rule) => res.findings.find((f) => f.rule === rule);

// --- rule metadata ------------------------------------------------------------------

test('every rule carries ja+en title/why/fix', () => {
  for (const [id, r] of Object.entries(RULES)) {
    for (const lang of ['ja', 'en']) {
      assert.ok(r[lang] && r[lang].title && r[lang].why && r[lang].fix, id + ' ' + lang);
    }
  }
});

// --- #1 missing N -------------------------------------------------------------------

test('missing-normal: N-less faces are flagged, N-carrying twin is clean', () => {
  const sick = lintDnm(dnm([{ name: 'a.srf', lines: quadSrf() }], [{ label: 'P', srf: 'a.srf' }]));
  const f = get(sick, 'missing-normal');
  assert.ok(f, 'detected');
  assert.equal(f.severity, 'error'); // 100% of shaded faces
  assert.equal(f.nightmare, 1);

  const ok = lintDnm(dnm(
    [{ name: 'a.srf', lines: quadSrf({ n: '0.5 0 0.5 0 -1 0' }) }],
    [{ label: 'P', srf: 'a.srf' }]));
  assert.ok(!get(ok, 'missing-normal'), 'healthy twin silent');
});

test('missing-normal: self-lit (B) faces are exempt (stock bakes N-less lights)', () => {
  const res = lintDnm(dnm(
    [{ name: 'a.srf', lines: quadSrf({ extra: ['B'] }) }],
    [{ label: 'Nav', srf: 'a.srf', cla: 30 }]));
  assert.ok(!get(res, 'missing-normal'), 'B faces need no N');
});

// --- #2 N vs winding ----------------------------------------------------------------

test('normal-winding-mismatch: reported as info (engine self-heals), agreeing twin clean', () => {
  const mk = (nline) => dnm(
    Array.from({ length: 12 }, (_, i) => ({ name: 's' + i + '.srf', lines: quadSrf({ oz: i * 2, n: nline(i) }) })),
    Array.from({ length: 12 }, (_, i) => ({ label: 'P' + i, srf: 's' + i + '.srf' })));
  const sick = lintDnm(mk((i) => `0.5 0 ${i * 2 + 0.5} 0 1 0`)); // N opposes the winding
  const f = get(sick, 'normal-winding-mismatch');
  assert.ok(f, 'detected');
  assert.equal(f.severity, 'info');
  assert.equal(f.nightmare, 2);
  const ok = lintDnm(mk((i) => `0.5 0 ${i * 2 + 0.5} 0 -1 0`));
  assert.ok(!get(ok, 'normal-winding-mismatch'), 'agreeing twin silent');
});

// --- #7 edge-on R on thin plates ------------------------------------------------------

// A strip of triangle pairs in one plane with opposite windings, sharing R
// vertices: the averaged normal cancels to edge-on (the black wing edge).
function thinStrip(count, opposite) {
  const lines = ['SURF'];
  for (let i = 0; i <= count; i++) lines.push(`V ${i} 0 0 R`, `V ${i} 0 1`);
  for (let i = 0; i < count; i++) {
    const a = i * 2, b = i * 2 + 2, c = i * 2 + 1; // (i,0,0) (i+1,0,0) (i,0,1)
    lines.push('F', `V ${a} ${b} ${c}`, 'C 100 100 100', 'E');
    lines.push('F', opposite ? `V ${c} ${b} ${a}` : `V ${a} ${b} ${c}`, 'C 100 100 100', 'E');
  }
  return lines;
}

test('edge-on-round-vertex: R shared by opposed skins goes black (warn at scale)', () => {
  const sick = lintDnm(dnm([{ name: 'w.srf', lines: thinStrip(24, true) }], [{ label: 'Wing', srf: 'w.srf' }]));
  const f = get(sick, 'edge-on-round-vertex');
  assert.ok(f, 'detected');
  assert.equal(f.severity, 'warn'); // >= 20 strongly edge-on R vertices
  assert.equal(f.nightmare, 7);

  const ok = lintDnm(dnm([{ name: 'w.srf', lines: thinStrip(24, false) }], [{ label: 'Wing', srf: 'w.srf' }]));
  assert.ok(!get(ok, 'edge-on-round-vertex'), 'same-orientation twin silent');
});

// --- #8 spurious R spray ---------------------------------------------------------------

// A flat grid, every vertex marked R: nothing to smooth -> converter spray.
function flatGrid(nx, nz, markR) {
  const lines = ['SURF'];
  for (let z = 0; z <= nz; z++) {
    for (let x = 0; x <= nx; x++) lines.push(`V ${x} 0 ${z}${markR ? ' R' : ''}`);
  }
  const at = (x, z) => z * (nx + 1) + x;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      lines.push('F', `V ${at(x, z)} ${at(x + 1, z)} ${at(x + 1, z + 1)} ${at(x, z + 1)}`, 'C 100 100 100', 'E');
    }
  }
  return lines;
}

test('spurious-round-vertex: R sprayed over a flat grid is flagged (info), plain grid clean', () => {
  const sick = lintDnm(dnm([{ name: 'g.srf', lines: flatGrid(5, 5, true) }], [{ label: 'Plate', srf: 'g.srf' }]));
  const f = get(sick, 'spurious-round-vertex');
  assert.ok(f, 'detected');
  assert.equal(f.severity, 'info');
  assert.equal(f.nightmare, 8);

  const ok = lintDnm(dnm([{ name: 'g.srf', lines: flatGrid(5, 5, false) }], [{ label: 'Plate', srf: 'g.srf' }]));
  assert.ok(!get(ok, 'spurious-round-vertex'), 'no R, no spray');
});

// --- hinge-line z-fight -----------------------------------------------------------------

const bigQuad = (x0, x1, z0, z1, rev) => {
  const v = [`V ${x0} 0 ${z0}`, `V ${x1} 0 ${z0}`, `V ${x1} 0 ${z1}`, `V ${x0} 0 ${z1}`];
  return ['SURF', ...v, 'F', rev ? 'V 3 2 1 0' : 'V 0 1 2 3', 'C 100 100 100', 'E'];
};

test('coplanar-overlap: same-facing duplicate footprint across nodes = warn', () => {
  const sick = lintDnm(dnm([
    { name: 'a.srf', lines: bigQuad(0, 2, 0, 1) },
    { name: 'b.srf', lines: bigQuad(0.05, 1.95, 0, 1) }, // same plane, same facing, ~same footprint
  ], [{ label: 'WingTE', srf: 'a.srf' }, { label: 'RudderLE', srf: 'b.srf' }]));
  const f = get(sick, 'coplanar-overlap');
  assert.ok(f, 'detected');
  assert.equal(f.severity, 'warn');

  // the compiler's cure: a 5cm gap
  const gap = lintDnm(dnm([
    { name: 'a.srf', lines: bigQuad(0, 2, 0, 1) },
    { name: 'b.srf', lines: ['SURF', 'V 0.05 0.05 0', 'V 1.95 0.05 0', 'V 1.95 0.05 1', 'V 0.05 0.05 1', 'F', 'V 0 1 2 3', 'C 100 100 100', 'E'] },
  ], [{ label: 'WingTE', srf: 'a.srf' }, { label: 'RudderLE', srf: 'b.srf' }]));
  assert.ok(!get(gap, 'coplanar-overlap'), '5cm apart is fine');
});

test('coplanar-overlap: the stock two-sided idiom (reversed twin, same verts) stays silent', () => {
  const res = lintDnm(dnm([
    { name: 'a.srf', lines: [...bigQuad(0, 2, 0, 1), 'F', 'V 3 2 1 0', 'C 100 100 100', 'E'] },
  ], [{ label: 'Sheet', srf: 'a.srf' }]));
  assert.ok(!get(res, 'coplanar-overlap'), 'reversed twin is deliberate');
});

test('coplanar-overlap: opposed partial overlap across nodes = info, not warn', () => {
  const res = lintDnm(dnm([
    { name: 'a.srf', lines: bigQuad(0, 2, 0, 1) },
    { name: 'b.srf', lines: bigQuad(1.2, 3.2, 0, 1, true) }, // opposed facing, partial overlap
  ], [{ label: 'A', srf: 'a.srf' }, { label: 'B', srf: 'b.srf' }]));
  const f = get(res, 'coplanar-overlap');
  assert.ok(f, 'detected');
  assert.equal(f.severity, 'info');
});

// --- double-applied absolute coordinates -------------------------------------------------

test('rest-transform-displacement: POS re-applied to absolute verts = info; POS==CNT clean', () => {
  const geom = { name: 'g.srf', lines: quadSrf({ oz: -10 }) }; // absolute geometry near z=-10
  const sick = lintDnm(dnm([geom], [{ label: 'Engine', srf: 'g.srf', pos: [0, 0, -10, 0, 0, 0] }]));
  const f = get(sick, 'rest-transform-displacement');
  assert.ok(f, 'detected');
  assert.equal(f.severity, 'info');

  const ok = lintDnm(dnm([geom], [{ label: 'Engine', srf: 'g.srf', pos: [0, 0, -10, 0, 0, 0], cnt: [0, 0, -10] }]));
  assert.ok(!get(ok, 'rest-transform-displacement'), 'stock POS==CNT idiom silent');
});

// --- ZA / B attributes --------------------------------------------------------------------

test('za-invalid: out-of-range value and dangling face index = warn; stock-style ZA clean', () => {
  const mk = (za) => dnm([{ name: 'a.srf', lines: [...quadSrf({ n: '0.5 0 0.5 0 -1 0' }), za] }], [{ label: 'P', srf: 'a.srf' }]);
  const sick = lintDnm(mk('ZA 0 300'));
  assert.ok(get(sick, 'za-invalid'), 'value 300 out of range');
  const sick2 = lintDnm(mk('ZA 5 180'));
  assert.ok(get(sick2, 'za-invalid'), 'face 5 does not exist');
  const ok = lintDnm(mk('ZA 0 180'));
  assert.ok(!get(ok, 'za-invalid'), 'stock afterburner alpha is fine');
});

test('bright-outside-light-node: small B quad in a static node = info; CLA 30 node clean', () => {
  const lines = [
    'SURF', 'V 0 0 0', 'V 0.1 0 0', 'V 0.1 0 0.1', 'V 0 0 0.1',
    'F', 'B', 'V 0 1 2 3', 'C 255 0 0', 'E',
  ];
  const sick = lintDnm(dnm([{ name: 'l.srf', lines }], [{ label: 'Body', srf: 'l.srf', cla: 0 }]));
  const f = get(sick, 'bright-outside-light-node');
  assert.ok(f, 'detected');
  assert.equal(f.severity, 'info');

  const ok = lintDnm(dnm([{ name: 'l.srf', lines }], [{ label: 'Beacon', srf: 'l.srf', cla: 30 }]));
  assert.ok(!get(ok, 'bright-outside-light-node'), 'a real light node is the fix');
});

// --- STA visibility -----------------------------------------------------------------------

test('retract-never-hidden: animated gear without vis=0 = info; hidden endpoint clean', () => {
  const geom = { name: 'g.srf', lines: quadSrf({ n: '0.5 0 0.5 0 -1 0' }) };
  const sick = lintDnm(dnm([geom], [{
    label: 'Gear', srf: 'g.srf', cla: 0,
    sta: [[0, 0, 0, 0, 16384, 0, 1], [0, 0, 0, 0, 0, 0, 1]],
  }]));
  const f = get(sick, 'retract-never-hidden');
  assert.ok(f, 'detected');
  assert.equal(f.severity, 'info');

  const ok = lintDnm(dnm([geom], [{
    label: 'Gear', srf: 'g.srf', cla: 0,
    sta: [[0, 0, 0, 0, 16384, 0, 0], [0, 0, 0, 0, 0, 0, 1]],
  }]));
  assert.ok(!get(ok, 'retract-never-hidden'), 'vis=0 endpoint silences it');
});

// --- colors / indices / references ----------------------------------------------------------

test('bad-color: out-of-range RGB and packed values = error; 15-bit packed clean', () => {
  const mk = (c) => dnm([{ name: 'a.srf', lines: [
    'SURF', 'V 0 0 0', 'V 1 0 0', 'V 1 0 1',
    'F', 'V 0 1 2', 'N 0.6 0 0.3 0 -1 0', c, 'E',
  ] }], [{ label: 'P', srf: 'a.srf' }]);
  assert.ok(get(lintDnm(mk('C 300 100 100')), 'bad-color'), 'r=300');
  assert.equal(get(lintDnm(mk('C 300 100 100')), 'bad-color').severity, 'error');
  assert.ok(get(lintDnm(mk('C 40000')), 'bad-color'), 'packed > 32767');
  assert.ok(!get(lintDnm(mk('C 100 100 100')), 'bad-color'), 'plain RGB fine');
  assert.ok(!get(lintDnm(mk('C 12345')), 'bad-color'), '15-bit packed fine');
});

test('bad-face-index: face referencing a missing vertex = error', () => {
  const res = lintDnm(dnm([{ name: 'a.srf', lines: [
    'SURF', 'V 0 0 0', 'V 1 0 0', 'V 1 0 1',
    'F', 'V 0 1 9', 'C 100 100 100', 'E',
  ] }], [{ label: 'P', srf: 'a.srf' }]));
  const f = get(res, 'bad-face-index');
  assert.ok(f, 'detected');
  assert.equal(f.severity, 'error');
});

test('broken-reference: dangling FIL and CLD = warn', () => {
  const res = lintDnm(dnm(
    [{ name: 'a.srf', lines: quadSrf({ n: '0.5 0 0.5 0 -1 0' }) }],
    [{ label: 'P', srf: 'ghost.srf', children: ['NoSuchChild'] }]));
  const refs = res.findings.filter((f) => f.rule === 'broken-reference');
  assert.equal(refs.length, 2);
  assert.ok(refs.every((f) => f.severity === 'warn'));
});

// --- bare SRF + auto dispatch ----------------------------------------------------------------

test('lintSrf: a collision shell skips shading rules, a visual SRF does not', () => {
  const srfText = ['SURF', 'V 0 0 0', 'V 1 0 0', 'V 1 0 1', 'F', 'V 0 1 2', 'C 100 100 100', 'E', 'E', ''].join('\n');
  const coll = lintSrf(enc(srfText), { name: 'x_coll.srf', kind: 'collision' });
  assert.ok(!get(coll, 'missing-normal'), 'collision is never shaded');
  const vis = lintSrf(enc(srfText), { name: 'x.srf', kind: 'visual' });
  assert.ok(get(vis, 'missing-normal'), 'visual SRF wants N');
});

test('lintAuto: sniffs DNM vs SRF and classifies *coll* names', () => {
  const d = lintAuto(dnm([{ name: 'a.srf', lines: quadSrf({ n: '0.5 0 0.5 0 -1 0' }) }], [{ label: 'P', srf: 'a.srf' }]), 'x.dnm');
  assert.ok(d.stats.nodes === 1, 'parsed as DNM');
  const srfText = ['SURF', 'V 0 0 0', 'V 1 0 0', 'V 1 0 1', 'F', 'V 0 1 2', 'C 100 100 100', 'E', 'E', ''].join('\n');
  const s = lintAuto(enc(srfText), 'f22coll.srf');
  assert.equal(s.counts.error, 0, 'collision shell not shamed for missing N');
});

// --- stock-fleet calibration pins --------------------------------------------------------------

const stock = (f) => readFileSync(join(here, '..', 'upstream', 'YSFLIGHT', 'runtime', 'aircraft', f));

test('stock smoke: f22 / f15 / b747 / concorde lint with 0 errors and 0 warns', () => {
  for (const f of ['f22.dnm', 'f15.dnm', 'b747.dnm', 'concorde.dnm']) {
    const res = lintDnm(stock(f));
    assert.equal(res.counts.error, 0, f + ' errors');
    assert.equal(res.counts.warn, 0, f + ' warns');
  }
});

test('stock smoke: collision + cockpit SRFs are clean via lintAuto', () => {
  for (const f of ['f22coll.srf', 'f22cockpit.srf', 'f15coll.srf']) {
    const res = lintAuto(stock(f), f);
    assert.equal(res.counts.error, 0, f + ' errors');
    assert.equal(res.counts.warn, 0, f + ' warns');
  }
});

test('templates: the compiled b747-8i is fully clean; the starter has only infos', () => {
  const b747 = lintDnm(readFileSync(join(here, '..', 'templates', 'b747-8i.dnm')));
  assert.equal(b747.counts.error, 0);
  assert.equal(b747.counts.warn, 0);
  assert.equal(b747.counts.info, 0);
  const starter = lintDnm(readFileSync(join(here, '..', 'templates', 'aircraft-starter.dnm')));
  assert.equal(starter.counts.error, 0);
  assert.equal(starter.counts.warn, 0);
});

test('stock smoke: known same-facing duplicates stay bounded (calibration pin)', () => {
  // gripen carries genuine same-facing duplicate-footprint faces; the pin
  // keeps the detector from regressing into either silence or spam.
  const res = lintDnm(stock('gripen.dnm'));
  assert.equal(res.counts.error, 0);
  assert.ok(res.counts.warn >= 1 && res.counts.warn <= 3, 'gripen warns: ' + res.counts.warn);
  assert.ok(res.findings.filter((f) => f.severity === 'warn').every((f) => f.rule === 'coplanar-overlap'));
});
