// The modeler side of the workbench file bridge (see staging.js).
//
// Import: at boot, every staged file is copied into the editor's VFS under
// /home/web_user/workbench/ so File->Open sees it immediately.
//
// Export: the editor saves through its own dialog into the in-memory VFS; the
// bridge polls the tree every couple of seconds and pushes any NEW or MODIFIED
// .srf/.dnm/.dat out to the staging area, with a small toast so the user knows
// the file reached the workbench.  (Emscripten FS has no change notification;
// the whole VFS outside the preload is a few files, so a 2s stat-walk is free.)

import { putStaged, listStaged, getStaged } from './staging.js';

const EXT = /\.(srf|dnm|dat)$/i;
const SKIP = new Set(['/ysgebl', '/dev', '/proc', '/tmp']);
const IMPORT_DIR = '/home/web_user/workbench';
const POLL_MS = 2000;

const LANG = (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
const T = LANG === 'ja'
  ? { sent: (n) => '→ ワークベンチに送りました: ' + n, link: '🛠 ワークベンチへ', linkTitle: '送ったファイルは機体組み立ての「モデラから」に届いています' }
  : { sent: (n) => '→ sent to the workbench: ' + n, link: '🛠 To the workbench', linkTitle: 'Saved files arrive in the aircraft assembly under “From the modeler”' };

function walk(FS, path, out) {
  let names;
  try { names = FS.readdir(path); } catch (e) { return; }
  for (const n of names) {
    if (n === '.' || n === '..') continue;
    const p = (path === '/' ? '' : path) + '/' + n;
    if (SKIP.has(p)) continue;
    let st;
    try { st = FS.stat(p); } catch (e) { continue; }
    if (FS.isDir(st.mode)) walk(FS, p, out);
    else if (EXT.test(n)) out.push({ path: p, mtime: st.mtime instanceof Date ? st.mtime.getTime() : Number(st.mtime) });
  }
}

function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:30;padding:8px 14px;border-radius:7px;' +
    'background:rgba(13,20,29,.95);border:1px solid #4da3ff;color:#cfe0f5;' +
    'font:13px system-ui,sans-serif;transition:opacity .4s;opacity:1';
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 500); }, 3500);
}

function chip() {
  const a = document.createElement('a');
  a.href = './workbench.html';
  a.textContent = T.link;
  a.title = T.linkTitle;
  a.style.cssText =
    'position:fixed;right:12px;top:12px;z-index:30;padding:6px 12px;border-radius:7px;' +
    'background:rgba(13,20,29,.9);border:1px solid #2a3647;color:#8fa3bb;' +
    'font:12.5px system-ui,sans-serif;text-decoration:none';
  document.body.appendChild(a);
}

async function start() {
  // Wait for the editor runtime (classic script sets window.Module).
  while (!(window.Module && window.Module.calledRun)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const FS = window.Module.FS;
  const seen = new Map(); // path -> mtime already pushed (or pre-existing)

  // Import staged files for File->Open, and record them as seen so the import
  // itself is not echoed straight back out.
  try { FS.mkdirTree(IMPORT_DIR); } catch (e) {}
  let imported = 0;
  try {
    for (const s of await listStaged()) {
      if (!EXT.test(s.name)) continue;
      const p = IMPORT_DIR + '/' + s.name;
      try {
        FS.writeFile(p, await getStaged(s.name));
        seen.set(p, FS.stat(p).mtime instanceof Date ? FS.stat(p).mtime.getTime() : Number(FS.stat(p).mtime));
        imported++;
      } catch (e) { /* single bad entry must not kill the import */ }
    }
  } catch (e) { console.warn('[bridge] staging import failed', e); }

  // Baseline scan: everything present now (preload leftovers, imports) is NOT
  // a fresh save — record silently, then push only what changes from here on.
  const base = [];
  walk(FS, '/', base);
  for (const f of base) if (!seen.has(f.path)) seen.set(f.path, f.mtime);

  chip();
  window.__ysfwBridgeReady = true; // smoke probe
  console.log('[bridge] ready (' + imported + ' staged file(s) imported to ' + IMPORT_DIR + ')');

  setInterval(async () => {
    const found = [];
    walk(FS, '/', found);
    for (const f of found) {
      if (seen.get(f.path) === f.mtime) continue;
      seen.set(f.path, f.mtime);
      const name = f.path.split('/').pop();
      try {
        await putStaged(name, FS.readFile(f.path));
        toast(T.sent(name));
        console.log('[bridge] staged ' + name + ' (' + f.path + ')');
      } catch (e) {
        console.warn('[bridge] stage failed for ' + f.path, e);
      }
    }
  }, POLL_MS);
}

start();
