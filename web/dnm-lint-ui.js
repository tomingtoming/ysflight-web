// Studio UI for the nightmare linter (web/dnm-lint.js): a "🩺 検査" section
// that runs the geometry linter over the files currently assigned to the
// studio slots and lists the findings with severity badges and fix hints.
//
// The host page stays thin: it calls buildLintSection(rail, getTargets) once,
// where getTargets() returns [{name, bytes, kind}] for whatever is assembled
// right now (kind: 'visual' | 'collision' | 'cockpit' — collision shells are
// never shaded, so the linter mutes shading rules for them).  Everything else
// — running, rendering, i18n — lives here.

import { el, LANG } from './studio-shared.js';
import { lintDnm, lintSrf } from './dnm-lint.js';

const S = ({
  ja: {
    title: '🩺 検査',
    intro: '組み立て中のモデルを「悪夢リンター」にかけます。実飛行で画面に化けて出た病理（N法線欠落・薄板の黒縁・ヒンジ線のZファイト…）を機械検出。',
    run: '検査する',
    none: '検査対象がありません（外観 .dnm などを割り当ててください）',
    clean: (name) => '✓ ' + name + ' — 問題なし',
    summary: (e, w, i) => '検査結果: error ' + e + ' / warn ' + w + ' / info ' + i,
    nightmare: (n) => '悪夢第' + n + '項',
    failed: (name, m) => '⚠ ' + name + ' を検査できませんでした: ' + m,
  },
  en: {
    title: '🩺 Inspect',
    intro: 'Run the assembled model through the "nightmare linter" — machine checks for the pathologies real flights surfaced (missing N normals, black thin-plate edges, hinge-line z-fighting...).',
    run: 'Inspect',
    none: 'Nothing to inspect (assign a visual .dnm first)',
    clean: (name) => '✓ ' + name + ' — clean',
    summary: (e, w, i) => 'Result: ' + e + ' error / ' + w + ' warn / ' + i + ' info',
    nightmare: (n) => 'nightmare #' + n,
    failed: (name, m) => '⚠ could not inspect ' + name + ': ' + m,
  },
})[LANG];

const BADGE = {
  error: ['error', '#3d1512', '#ff7b72'],
  warn: ['warn', '#3a2d10', '#e3b341'],
  info: ['info', '#0f2a45', '#79c0ff'],
};

function badge(sev) {
  const [label, bg, fg] = BADGE[sev];
  const b = el('span', null, label);
  b.style.cssText = 'display:inline-block;padding:0 6px;border-radius:4px;font-size:10.5px;' +
    'font-weight:600;margin-right:6px;background:' + bg + ';color:' + fg + ';border:1px solid ' + fg + '33';
  return b;
}

function renderFinding(box, f) {
  const item = el('div');
  item.style.cssText = 'border:1px solid #2a3647;border-radius:6px;padding:6px 8px;margin:4px 0;font-size:12px';
  const head = el('div');
  head.appendChild(badge(f.severity));
  const where = [f.node, f.srf].filter(Boolean).join(' / ');
  const nm = f.nightmare ? '（' + S.nightmare(f.nightmare) + '）' : '';
  head.appendChild(el('span', null, f.title[LANG] + nm + ' ×' + f.count + (where ? ' — ' + where : '')));
  item.appendChild(head);
  if (f.detail) {
    const d = el('div', null, f.detail);
    d.style.cssText = 'color:#7d93b0;font-size:11px;margin:2px 0 0';
    item.appendChild(d);
  }
  const why = el('div', null, f.why[LANG]);
  why.style.cssText = 'color:#8fa3bb;margin:3px 0 0';
  item.appendChild(why);
  const fix = el('div', null, '→ ' + f.fix[LANG]);
  fix.style.cssText = 'color:#9ece6a;margin:2px 0 0';
  item.appendChild(fix);
  box.appendChild(item);
}

// Lint every current target and render the findings.  Returns the totals
// (also handy for the smoke test via window hooks the host may expose).
export function runLint(box, targets) {
  box.innerHTML = '';
  if (!targets.length) {
    box.appendChild(el('div', 'msg', S.none));
    return { error: 0, warn: 0, info: 0 };
  }
  const totals = { error: 0, warn: 0, info: 0 };
  const sections = [];
  for (const t of targets) {
    try {
      const res = /\.dnm$/i.test(t.name)
        ? lintDnm(t.bytes)
        : lintSrf(t.bytes, { name: t.name, kind: t.kind || 'visual' });
      totals.error += res.counts.error;
      totals.warn += res.counts.warn;
      totals.info += res.counts.info;
      sections.push({ name: t.name, res });
    } catch (e) {
      sections.push({ name: t.name, err: (e && e.message) || String(e) });
      totals.error++;
    }
  }
  const sum = el('div', 'msg', S.summary(totals.error, totals.warn, totals.info));
  sum.style.fontWeight = '600';
  box.appendChild(sum);
  for (const s of sections) {
    const h = el('div', null, '📄 ' + s.name);
    h.style.cssText = 'color:#c9d5e3;font-size:12px;margin:8px 0 2px;font-weight:600';
    box.appendChild(h);
    if (s.err) {
      box.appendChild(el('div', 'msg', S.failed(s.name, s.err)));
      continue;
    }
    if (!s.res.findings.length) {
      box.appendChild(el('div', 'msg', S.clean(s.name)));
      continue;
    }
    for (const f of s.res.findings) renderFinding(box, f);
  }
  return totals;
}

// Mount the section on the studio rail.  getTargets: () => [{name, bytes, kind}].
export function buildLintSection(rail, getTargets) {
  rail.appendChild(el('h2', null, S.title));
  rail.appendChild(el('p', 'intro', S.intro));
  const btnR = el('div', 'btnrow');
  const btn = el('button', 'accent', S.run);
  btnR.appendChild(btn);
  rail.appendChild(btnR);
  const box = el('div');
  rail.appendChild(box);
  let last = null;
  btn.addEventListener('click', () => { last = runLint(box, (getTargets && getTargets()) || []); });
  return { run: () => { btn.click(); return last; } };
}
