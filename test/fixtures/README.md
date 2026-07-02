# Test fixtures

## testpack.zip

A synthetic community-style aircraft add-on pack used by the unit tests
(`test/packs.test.mjs`) and the pack smokes (`scripts/smoke-pack.mjs`,
`scripts/smoke-mp-*.mjs`).

- **Contents**: two aircraft (`YSFW_TEST1`, `YSFW_TEST2`) under
  `user/toming/`.  The model data is copied from two aircraft in the upstream
  YSFLIGHT runtime (`upstream/YSFLIGHT/runtime/aircraft/`: f117a, f5 — 3-clause
  BSD, (c) Soji Yamakawa/CaptainYS), with `REM`/`IDENTIFY` renamed so the
  engine sees them as **pack-only** aircraft.  The smokes' negative controls
  (freeflight without the pack must NOT resolve the aircraft) depend on these
  names not existing in the base install.
- **Deliberate messiness** (what the pack normalizer must survive, modeled on
  real community zips): the `.lst` references files with the wrong case
  (`User/...` vs stored `user/...`), `.lst` lines end in CRLF, and the archive
  carries `__MACOSX/` AppleDouble entries and `.DS_Store` files.
- One aircraft has 3 `.lst` tokens (dat/dnm/coll), the other 4 (+cockpit), so
  list rewriting is exercised for both shapes.
