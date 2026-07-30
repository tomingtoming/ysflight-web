// Flight replays UI for ysflight-web.
//
// The engine records every flight in memory.  An emscripten-branch hook
// (fsrunloop.cpp ChangeRunMode) saves that recording to a fixed
// ysfw-lastreplay.yfs in the IDBFS-persisted user dir whenever a real flight ends.
// This module copies that file into a replays/ history (named by timestamp; the
// aircraft/field are read from the .yfs header for display), lists the history on
// the top page, and plays a replay back via the ?replay deep-link — index.html turns
// ?replay=<file> into the engine's `-replayrecord <path>`, which auto-starts playback
// because a loaded flight record makes PlayerPlaneIsReady() false.
//
// index.html drives the lifecycle: it calls window.ysfwReplaysInit() once IDBFS is
// synced, watches for replay-end to return to the top, and routes ?replay launches.

const USER_DIR = '/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT';
const REPLAYS_DIR = USER_DIR + '/replays';
const LAST_REPLAY = USER_DIR + '/ysfw-lastreplay.yfs';
const ACCENT = '#0046D5';

const LANG = ((typeof window !== 'undefined' && window.ysfwLang) || 'en').indexOf('ja') === 0 ? 'ja' : 'en';
const S = ({
  ja: {
    title: '飛行履歴 ／ リプレイ',
    hint: '直前の飛行を自動で記録。クリックで再生、「共有」でリンクをコピー',
    play: 'リプレイ:',
    shareBtn: '共有',
    shareTitle: '共有リンクをコピー',
    shareCopied: '✓ リンクをコピーしました',
    delTitle: '削除',
    confirmDel: (n) => '「' + n + '」を削除しますか？',
    at: ' @ ',
  },
  en: {
    title: 'Flight log / Replays',
    hint: 'Your last flights are recorded automatically. Click to replay; Share copies a link.',
    play: 'Replay:',
    shareBtn: 'Share',
    shareTitle: 'Copy share link',
    shareCopied: '✓ Share link copied',
    delTitle: 'Delete',
    confirmDel: (n) => 'Delete “' + n + '”?',
    at: ' @ ',
  },
})[LANG];

function FS() { return (typeof window !== 'undefined' && window.Module && window.Module.FS) || null; }

function ensureDir() {
  const F = FS(); if (!F) return;
  try { F.mkdirTree ? F.mkdirTree(REPLAYS_DIR) : F.mkdir(REPLAYS_DIR); } catch (e) { /* exists */ }
}

function sync() {
  const F = FS(); if (!F) return Promise.resolve();
  return new Promise((res) => { try { F.syncfs(false, () => res()); } catch (e) { res(); } });
}

// Read only the first chunk of a file (the .yfs header holds FIELDNAM/AIRPLANE), so
// listing the history never reads whole multi-MB recordings.
function readHead(path, n) {
  const F = FS(); if (!F) return '';
  let stream = null;
  try {
    stream = F.open(path, 'r');
    const buf = new Uint8Array(n);
    const got = F.read(stream, buf, 0, n, 0);
    return new TextDecoder().decode(buf.subarray(0, got));
  } catch (e) { return ''; }
  finally { if (stream) { try { F.close(stream); } catch (e) {} } }
}

function parseHeader(text) {
  let field = '', air = '';
  const lines = String(text || '').split('\n');
  for (const l of lines) {
    if (!field && l.indexOf('FIELDNAM ') === 0) field = (l.split(/\s+/)[1] || '');
    else if (!air && l.indexOf('AIRPLANE ') === 0) air = (l.split(/\s+/)[1] || '');
    if (field && air) break;
  }
  return { field, air };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function prettyWhen(ts) {
  // ts = YYYYMMDD-HHMMSS
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(ts || '');
  return m ? (m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]) : '';
}

let capturing = false;
// Copy a just-finished recording (ysfw-lastreplay.yfs, written by the engine hook on
// flight-end) into the replays/ history.  The file's PRESENCE means "uncaptured", so
// we delete it after copying — idempotent across the in-page flight-end edge AND the
// next page load (a ?freeflight return-to-top reloads before the edge is seen).
async function capture() {
  const F = FS(); if (!F || capturing) return null;
  capturing = true;
  try {
    let text;
    try { F.stat(LAST_REPLAY); text = F.readFile(LAST_REPLAY, { encoding: 'utf8' }); }
    catch (e) { return null; } // nothing pending
    if (!text || text.indexOf('NUMRECOR ') === -1) { // no records -> discard, don't keep a start-snapshot
      try { F.unlink(LAST_REPLAY); } catch (e) {}
      return null;
    }
    ensureDir();
    const name = stamp() + '.yfs';
    try {
      F.writeFile(REPLAYS_DIR + '/' + name, text);
      F.unlink(LAST_REPLAY);
    } catch (e) { return null; }
    await sync();
    return name;
  } finally { capturing = false; }
}

// List the saved replays, newest first.  file is the bare name (a timestamp);
// air/field are read lazily from each .yfs header for display.
function list() {
  const F = FS(); if (!F) return [];
  let names;
  try { names = F.readdir(REPLAYS_DIR); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    if (n === '.' || n === '..' || !/\.yfs$/i.test(n)) continue;
    let size = 0;
    try { size = F.stat(REPLAYS_DIR + '/' + n).size; } catch (e) {}
    const hdr = parseHeader(readHead(REPLAYS_DIR + '/' + n, 4096));
    out.push({ file: n, size: size, when: n.replace(/\.yfs$/i, ''), air: hdr.air, field: hdr.field });
  }
  out.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0)); // newest first
  return out;
}

function remove(file) {
  const F = FS(); if (!F) return Promise.resolve();
  try { F.unlink(REPLAYS_DIR + '/' + file); } catch (e) {}
  return sync();
}

function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

// Render the history panel onto the loading overlay (manual top-page launch only).
// Hidden entirely when there are no replays, so it never clutters a first visit.
function renderPanel() {
  const overlay = document.getElementById('overlay');
  if (!overlay) return;
  const existing = document.getElementById('ysfw-replays-panel');
  if (existing) existing.remove();
  const items = list();
  if (!items.length) return;

  const curLang = new URLSearchParams(location.search).get('lang');
  const panel = document.createElement('div');
  panel.id = 'ysfw-replays-panel';
  panel.style.cssText =
    'margin-top:0;margin-bottom:12px;width:100%;background:#F2F1E5;border:1px solid #D0D0BF;' +
    'border-radius:5px;padding:10px 10px 12px;text-align:left;box-sizing:border-box';

  const title = document.createElement('div');
  title.textContent = S.title;
  title.style.cssText = 'color:#0046D5;font-size:13px;margin-bottom:2px';
  panel.appendChild(title);
  const hint = document.createElement('div');
  hint.textContent = S.hint;
  hint.style.cssText = 'color:#555;font-size:11px;margin-bottom:10px';
  panel.appendChild(hint);

  const listWrap = document.createElement('div');
  listWrap.style.cssText = 'max-height:40vh;overflow-y:auto';
  for (const it of items) {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;gap:8px;' +
      'padding:7px 10px;border:1px solid #ACA899;border-radius:2px;margin-bottom:6px;background:#fff';
    const left = document.createElement('button');
    left.style.cssText = 'flex:1;min-width:0;text-align:left;background:none;border:0;cursor:pointer;padding:0';
    const nm = document.createElement('div');
    nm.textContent = S.play + '  ' + (it.air || 'flight') + (it.field ? S.at + it.field : '');
    nm.style.cssText = 'color:' + ACCENT + ';font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const sub = document.createElement('div');
    sub.textContent = prettyWhen(it.when) + (it.size ? '  ·  ' + fmtBytes(it.size) : '');
    sub.style.cssText = 'color:#555;font-size:11px;margin-top:1px';
    left.appendChild(nm); left.appendChild(sub);
    left.addEventListener('click', () => {
      location.assign(location.origin + location.pathname + '?replay=' + encodeURIComponent(it.file) + (curLang ? '&lang=' + encodeURIComponent(curLang) : ''));
    });

    const ctl = document.createElement('div');
    ctl.style.cssText = 'flex:none;display:flex;gap:6px;align-items:center';
    const share = document.createElement('button');
    share.textContent = S.shareBtn;
    share.title = S.shareTitle;
    share.style.cssText = 'font-size:12px;padding:4px 10px;border-radius:3px;border:1px solid #003C74;background:linear-gradient(180deg,#FFFFFF,#E7E3D3);color:#000;cursor:pointer';
    share.addEventListener('click', () => {
      const url = location.origin + '/?replay=' + encodeURIComponent(it.file);
      const done = () => { const o = share.textContent; share.textContent = '✓'; const s = document.getElementById('ysfw-replays-status'); if (s) { s.textContent = S.shareCopied; } setTimeout(() => { share.textContent = o; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, done);
      else { const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); done(); }
    });
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.title = S.delTitle;
    del.style.cssText = 'font-size:12px;padding:4px 8px;border-radius:3px;border:1px solid #9C6A66;background:linear-gradient(180deg,#FFFFFF,#E7E3D3);color:#C33B1E;cursor:pointer';
    del.addEventListener('click', async () => {
      if (!self.confirm(S.confirmDel((it.air || 'flight') + (it.field ? S.at + it.field : '')))) return;
      del.disabled = true;
      await remove(it.file);
      renderPanel();
    });
    ctl.appendChild(share); ctl.appendChild(del);
    row.appendChild(left); row.appendChild(ctl);
    listWrap.appendChild(row);
  }
  panel.appendChild(listWrap);
  const status = document.createElement('div');
  status.id = 'ysfw-replays-status';
  status.style.cssText = 'color:#555;font-size:11px;min-height:1em;margin-top:4px';
  panel.appendChild(status);

  // Append after the pack panel if present, else at the end of the window body.
  const packPanel = document.getElementById('ysfw-pack-panel');
  const host = document.getElementById('ysfw-win-body') || overlay;
  if (packPanel && packPanel.parentNode === host) host.insertBefore(panel, packPanel.nextSibling);
  else host.appendChild(panel);
}

// Capture any pending recording, then (on a manual top-page launch) show the history.
async function init() {
  await capture();
  try {
    const q = new URLSearchParams(location.search);
    const manual = !q.get('join') && !q.get('freeflight') && !q.get('replay');
    if (manual) renderPanel();
  } catch (e) { /* non-fatal */ }
}

// Capture on every flight-end edge too (covers an in-engine flight that returns to
// the menu without a page reload).  Cheap polling; capture() is a no-op when there is
// nothing pending.
let prevInFlight = false;
if (typeof window !== 'undefined') {
  setInterval(function () {
    const now = !!globalThis.ysfwInFlight;
    if (prevInFlight && !now) { capture(); }
    prevInFlight = now;
  }, 800);
}

window.ysfwReplays = { capture, list, remove, renderPanel, init };
window.ysfwReplaysInit = init;

// If index.html already signalled FS readiness before this module evaluated, init now.
if (typeof window !== 'undefined' && window.__ysfwFsReady) init();
