// OPFS staging area — the file bridge between the modeler (Polygon Crest,
// modeler.html) and the workbench (workbench.html).  Same-origin OPFS is the
// only shared, persistent surface the two wasm-and-JS pages both reach:
//
//   modeler save  ->  putStaged(name, bytes)   [modeler-bridge.js polling]
//   workbench     ->  listStaged()/getStaged() [aircraft assembly "from modeler"]
//   workbench     ->  putStaged(...)           [send a creation's model back]
//   modeler boot  ->  staged files copied into the editor VFS for File->Open
//
// Flat names only (basenames); newest first.  Distinct from the pack blob
// store (opfs-store.js) on purpose: staging holds LOOSE work-in-progress
// files, not content-addressed pack payload.

const DIR = 'workbench-staging';

const sanitize = (name) => {
  const b = String(name).split(/[\\/]/).pop();
  if (!b || b === '.' || b === '..') throw new Error('staging: bad file name: ' + name);
  return b;
};

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export async function putStaged(name, bytes) {
  const d = await dir();
  const fh = await d.getFileHandle(sanitize(name), { create: true });
  const w = await fh.createWritable();
  await w.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  await w.close();
  return { name: sanitize(name), size: bytes.length };
}

export async function listStaged() {
  const d = await dir();
  const out = [];
  for await (const [name, h] of d.entries()) {
    if (h.kind !== 'file') continue;
    const f = await h.getFile();
    out.push({ name, size: f.size, mtime: f.lastModified });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export async function getStaged(name) {
  const d = await dir();
  const f = await (await d.getFileHandle(sanitize(name))).getFile();
  return new Uint8Array(await f.arrayBuffer());
}

export async function removeStaged(name) {
  const d = await dir();
  await d.removeEntry(sanitize(name));
}
