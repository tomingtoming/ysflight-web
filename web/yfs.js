// .yfs flight generator — the "Create Flight" core.
//
// The engine loads a flight from a .yfs file (FsWorld::Load, fsworld.cpp) and
// -flyyfs boots straight into it (fsmain EXEMODE_FLYYFS).  This module builds a
// minimal, canonical .yfs from a plain spec so the web shell can author a
// flight (player + AI aircraft, field, time of day, weapons) WITHOUT the
// engine's Create-Flight menu — the web-shell direction (docs/web-shell.md).
//
// The grammar mirrors what the engine itself writes (fssimulationfileio.cpp
// FsSimulation::Save): YFSVERSI, FIELDNAM, ENVIRONM, ALLOW*, then per aircraft
// AIRPLANE / STARTPOS / IDENTIFY, then per ground object GROUNDOB / IDENTIFY /
// GNDPOSIT / GNDATTIT.  We keep to that subset — no flight records.
//
// Classic script (loaded before Module like deeplink.js), publishes on
// globalThis; test/yfs.test.mjs imports it for the side effect.
globalThis.ysfwYfs = (function () {
  'use strict';

  // Matches fsdef.h YSFLIGHT_YFSVERSION (upstream is frozen at this value).
  var YFS_VERSION = 20180930;

  // IFF/side is 0..3 in the engine (IDENTIFY): 0 is the player's side, others
  // are hostile/neutral sides.  We clamp defensively; the engine indexes an
  // iffTab with this, so out-of-range would read garbage.
  function clampIff(v) {
    var n = parseInt(v, 10);
    if (isNaN(n) || n < 0) return 0;
    if (n > 3) return 3;
    return n;
  }

  // A start position is a named entry from the field's .stp (e.g. RW36_01,
  // NORTH10000_01).  Restrict to the characters real names use so a spec can't
  // inject extra tokens into the STARTPOS line.
  function sanitizeStartPos(s) {
    return String(s == null ? '' : s).replace(/[^A-Za-z0-9_.-]/g, '');
  }

  // An identifier (aircraft/field) is an uppercase token with digits, dashes,
  // underscores, slashes and dots in stock names.  Same anti-injection intent.
  function sanitizeIdent(s) {
    return String(s == null ? '' : s).replace(/[^A-Za-z0-9_./-]/g, '');
  }

  function boolLine(name, v) {
    return name + ' ' + (v ? 'TRUE' : 'FALSE');
  }

  // Mission extensions the web may enable (fssimextension.cpp registry).  Only
  // the two that fully work from a plain .yfs: RACINGMODE (gates are RACECHKP
  // ground objects in the field's own scenery; the extension just adds the lap
  // timer and strips weapons) and CLOSEAIRSUPPORT (persists NO state — its
  // StartSimulation/OnInterval generate the friendly and enemy tanks on every
  // sim start).  GROUNDTOAIR is excluded: its player is a GROUND object, which
  // -flyyfs's PlayerPlaneIsReady() gate rejects (a fork change, later).
  var EXTENSIONS = ['RACINGMODE', 'CLOSEAIRSUPPORT'];

  // spec:
  //   field:    stock/add-on field identifier (required)
  //   env:      'DAY' | 'NIGHT' (default DAY)
  //   weapons:  { gun, aam, agm, bomb, rocket } booleans (default all true)
  //   aircraft: [ { id, player, iff, startPos } ... ]  (>=1, exactly one player)
  //   ground:   [ { id, x, y, z, h, iff } ... ]  (optional; CONCRETE placements
  //             in meters/degrees — the page computes coordinates around a
  //             ground start position, this stays a dumb writer)
  //   extensions: [ 'RACINGMODE' | 'CLOSEAIRSUPPORT' ... ]  (optional; each
  //             becomes an EXTENSIO line the engine's loader restores via its
  //             extension registry — fsworld.cpp case 52)
  //
  // Returns the .yfs file text (LF-terminated).  Throws on a spec that could
  // not boot (no field, no aircraft, no player) so the caller fails loudly
  // rather than writing a file the engine would silently reject.
  function buildYfs(spec) {
    spec = spec || {};
    var field = sanitizeIdent(spec.field);
    if (!field) throw new Error('yfs: field is required');
    var aircraft = Array.isArray(spec.aircraft) ? spec.aircraft : [];
    if (aircraft.length === 0) throw new Error('yfs: at least one aircraft is required');

    var w = spec.weapons || {};
    var each = function (k) { return w[k] === undefined ? true : !!w[k]; };
    var env = (spec.env === 'NIGHT') ? 'NIGHT' : 'DAY';

    var lines = [];
    lines.push('YFSVERSI ' + YFS_VERSION);
    // loadYFS=TRUE loads the field's own scenery; LOADAIR:FALSE keeps the
    // field's default aircraft out so the flight contains only our list.
    lines.push('FIELDNAM ' + field + ' 0 0 0 0 0 0 TRUE LOADAIR:FALSE');
    lines.push('ENVIRONM ' + env);
    lines.push(boolLine('ALLOWGUN', each('gun')));
    lines.push(boolLine('ALLOWAAM', each('aam')));
    lines.push(boolLine('ALLOWAGM', each('agm')));
    lines.push(boolLine('ALLOWBOM', each('bomb')));
    lines.push(boolLine('ALLOWRKT', each('rocket')));

    // Mission extensions come early, mirroring the engine's own save order
    // (fssimulationfileio.cpp dumps the extension list near the top).
    var exts = Array.isArray(spec.extensions) ? spec.extensions : [];
    for (var x = 0; x < exts.length; x++) {
      if (EXTENSIONS.indexOf(exts[x]) === -1) {
        throw new Error('yfs: unknown extension "' + exts[x] + '"');
      }
      lines.push('EXTENSIO ' + exts[x]);
    }

    var players = 0;
    for (var i = 0; i < aircraft.length; i++) {
      var ac = aircraft[i] || {};
      var id = sanitizeIdent(ac.id);
      if (!id) throw new Error('yfs: aircraft[' + i + '] has no id');
      var isPlayer = !!ac.player;
      if (isPlayer) players++;
      lines.push('AIRPLANE ' + id + ' ' + (isPlayer ? 'TRUE' : 'FALSE'));
      var sp = sanitizeStartPos(ac.startPos) || 'NORTH10000_01';
      lines.push('STARTPOS NA ' + sp);
      lines.push('IDENTIFY ' + clampIff(isPlayer ? 0 : (ac.iff == null ? 1 : ac.iff)));
    }
    if (players !== 1) throw new Error('yfs: exactly one player aircraft is required (got ' + players + ')');

    // Ground objects (web-shell increment 8).  Grammar mirrors the engine's
    // save block: GROUNDOB <identify> <isPlayer>, IDENTIFY <iff>, GNDPOSIT
    // (absolute meters — the engine does NOT snap to terrain, so callers must
    // anchor at known ground coordinates), GNDATTIT (heading; .stp-style
    // degrees, the loader's angle parser accepts the unit suffix).
    var round2 = function (v) { return String(Math.round(v * 100) / 100); };
    var ground = Array.isArray(spec.ground) ? spec.ground : [];
    for (var g = 0; g < ground.length; g++) {
      var go = ground[g] || {};
      var gid = sanitizeIdent(go.id);
      if (!gid) throw new Error('yfs: ground[' + g + '] has no id');
      var gx = Number(go.x), gy = Number(go.y), gz = Number(go.z);
      if (!isFinite(gx) || !isFinite(gy) || !isFinite(gz)) {
        throw new Error('yfs: ground[' + g + '] has a non-numeric position');
      }
      var gh = Number(go.h);
      if (!isFinite(gh)) gh = 0;
      lines.push('GROUNDOB ' + gid + ' FALSE');
      lines.push('IDENTIFY ' + clampIff(go.iff == null ? 1 : go.iff));
      lines.push('GNDPOSIT ' + round2(gx) + 'm ' + round2(gy) + 'm ' + round2(gz) + 'm');
      lines.push('GNDATTIT ' + round2(gh) + 'deg 0deg 0deg');
    }

    return lines.join('\n') + '\n';
  }

  // Built-in mission presets for the ?mission= deep link:
  //   'racing[,AIRCRAFT[,FIELD]]' — lap race through the field's RACECHKP
  //     gates.  Default field RACING_VALLEY, whose single .stp entry is START
  //     (the designed grid position; RACING_DESERT matches).
  //   'cas[,AIRCRAFT[,FIELD]]' — close air support over TOHOKU (the classic
  //     tank-country map); airborne start (NORTH10000_01 exists in every
  //     bundled field's .stp).
  // Returns a spec for buildYfs, or null for an unknown kind.  Note: mission
  // GOALS are not part of the .yfs grammar (the engine does not persist them),
  // so these play as open-ended missions — same as the engine's own
  // prevflight reload.
  function missionSpec(str) {
    var p = String(str == null ? '' : str).split(',');
    var kind = (p[0] || '').toLowerCase();
    if (kind === 'racing') {
      return {
        field: p[2] || 'RACING_VALLEY',
        extensions: ['RACINGMODE'],
        aircraft: [{ id: p[1] || 'F-15J_EAGLE', player: true, startPos: 'START' }],
      };
    }
    if (kind === 'cas') {
      return {
        field: p[2] || 'TOHOKU',
        extensions: ['CLOSEAIRSUPPORT'],
        aircraft: [{ id: p[1] || 'F-15J_EAGLE', player: true, startPos: 'NORTH10000_01' }],
      };
    }
    return null;
  }

  return {
    YFS_VERSION: YFS_VERSION,
    EXTENSIONS: EXTENSIONS,
    buildYfs: buildYfs,
    missionSpec: missionSpec,
    sanitizeIdent: sanitizeIdent,
    sanitizeStartPos: sanitizeStartPos,
  };
})();
