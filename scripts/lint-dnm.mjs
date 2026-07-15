#!/usr/bin/env node
// CLI for the DNM/SRF geometry linter (web/dnm-lint.js) — the "nightmare
// linter".  Runs under Node AND Deno (node: specifiers only):
//
//   node scripts/lint-dnm.mjs [--lang en|ja] [--summary] <file.dnm|.srf> [more...]
//   deno run --allow-read scripts/lint-dnm.mjs templates/b747-8i.dnm
//
// One table row per finding; exit code 1 when any file has error-severity
// findings (warn/info exit 0, so CI can gate on real breakage only).
// --summary prints one line per file (handy for sweeping a whole fleet).

import { readFileSync } from 'node:fs';
import process from 'node:process';

const { lintAuto } = await import(new URL('../web/dnm-lint.js', import.meta.url));

const args = process.argv.slice(2);
const files = [];
let lang = 'ja', summary = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--lang') lang = args[++i] === 'en' ? 'en' : 'ja';
  else if (args[i] === '--summary') summary = true;
  else if (args[i] === '--help' || args[i] === '-h') { files.length = 0; break; }
  else files.push(args[i]);
}
if (!files.length) {
  console.error('usage: node scripts/lint-dnm.mjs [--lang en|ja] [--summary] <file.dnm|.srf> [more...]');
  process.exit(2);
}

const MARK = { error: '✖ error', warn: '▲ warn ', info: 'ℹ info ' };
let sawError = false;

for (const path of files) {
  let res;
  try {
    res = lintAuto(readFileSync(path), path);
  } catch (e) {
    console.error(path + ': lint failed: ' + ((e && e.message) || e));
    sawError = true;
    continue;
  }
  const { findings, counts, stats } = res;
  if (summary) {
    console.log(
      (counts.error ? '✖' : counts.warn ? '▲' : '✓') + ' ' + path +
      '  error ' + counts.error + ' / warn ' + counts.warn + ' / info ' + counts.info +
      '  (' + (stats.nodes || 0) + ' nodes, ' + stats.faces + ' faces)');
  } else {
    console.log('── ' + path + '  (' + (stats.nodes || 0) + ' nodes, ' + stats.faces + ' faces)');
    if (!findings.length) {
      console.log('   ✓ clean');
    }
    for (const f of findings) {
      const where = [f.node, f.srf].filter(Boolean).join(' / ') || '-';
      const nm = f.nightmare ? ' [悪夢#' + f.nightmare + ']' : '';
      console.log('  ' + MARK[f.severity] + '  ' + f.rule + nm + '  ×' + f.count + '  @ ' + where);
      console.log('           ' + f.title[lang] + (f.detail ? ' — ' + f.detail : ''));
      console.log('           ' + f.why[lang]);
      console.log('           → ' + f.fix[lang]);
    }
    console.log('   ' + ['error ' + counts.error, 'warn ' + counts.warn, 'info ' + counts.info].join(' / '));
  }
  if (counts.error) sawError = true;
}

process.exit(sawError ? 1 : 0);
