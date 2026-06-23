// ASYNCIFY hook for lazy-pack on-demand materialize.
//
// Every libc open()/fopen() in the engine funnels through __syscall_openat.  We
// override it (marked __async:'auto', so emscripten auto-registers it in
// ASYNCIFY_IMPORTS and wraps suspend/resume) so that when the engine opens a
// packs/<id>/... file that is NOT yet in MEMFS, we first await materializing it
// from OPFS (web/packs-ui.js: globalThis.ysfwMaterializeForOpen), THEN run the
// real open.  This is the single funnel for all opens -- demo, flight, selection.
//
// Two ASYNCIFY-specific gotchas handled here:
//  1) Do NOT use syscallGetVarargI() -- it mutates SYSCALLS.varargs, and ASYNCIFY
//     rewinds this async fn on resume, running the mutation twice -> assert.  Read
//     mode directly from the varargs pointer (no side effect, rewind-safe).
//  2) Overriding the syscall drops emscripten's auto try/catch wrapper, so a
//     missing file (ENOENT) would throw instead of returning -errno.  Catch
//     FS.ErrnoError ourselves and return -errno, exactly like the stock syscall,
//     so the engine treats "can't open" gracefully (skips the frame).
addToLibrary({
  __syscall_openat__deps: ['$SYSCALLS', '$FS'],
  __syscall_openat__async: 'auto',
  __syscall_openat: async (dirfd, path, flags, varargs) => {
    var mode = varargs ? {{{ makeGetValue('varargs', 0, 'i32') }}} : 0;
    try {
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      if (flags & {{{ cDefs.O_CREAT }}}) {
        mode &= ~SYSCALLS.currentUmask;
      }
      // Lazy-pack: materialize from OPFS if this packs/ file isn't in MEMFS yet.
      var inMemfs = true;
      try { FS.lookupPath(path, { follow: true }); }
      catch (e) { inMemfs = false; }
      if (!inMemfs && path.indexOf('/packs/') >= 0 &&
          typeof globalThis.ysfwMaterializeForOpen === 'function') {
        try { await globalThis.ysfwMaterializeForOpen(path); } catch (e) {}
      }
      return FS.open(path, flags, mode).fd;
    } catch (e) {
      if (typeof FS == 'undefined' || !(e instanceof FS.ErrnoError)) throw e;
      return -e.errno;
    }
  },
});
