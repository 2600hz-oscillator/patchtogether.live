// lockstep-barrier.acceptance.mjs — P1 TRUE-LOCKSTEP barrier harness.
//
// Copyright(C) 2026 patchtogether.live contributors. GPLv2 (lives in the
// GPLv2 doomgeneric tree).
//
// WHAT THIS PROVES (the P1 deliverable: the LIVE barrier path is bit-exact):
//
//   lockstep-determinism.acceptance.mjs (a non-CI dev harness, removed in the
//   LoC hygiene sweep — recover it from git history at the deleting commit)
//   proved the SCRIPTED overlay (dgpt_set_scripted) is bit-exact. But the LIVE
//   game does NOT use scripted mode — it uses the new P1 barrier: dgpt_set_lockstep(1) +
//   dgpt_receive_ticset(tic, ...) feeding the consolidated TicSet through
//   D_ReceiveTic-style delivery, with the engine's own GetLowTic/TryRunTics
//   gating advancement against dgpt_recvtic. This harness exercises EXACTLY that
//   barrier path across N independent sims, modeling the JS transport (each sim
//   "appends" only its OWN slot's ticcmd to a shared ordered log; a barrier
//   consolidates a tic only when ALL slots are present; the consolidated TicSet
//   is delivered to every sim via dgpt_receive_ticset), and asserts every sim's
//   dgpt_state_checksum is BYTE-IDENTICAL every tic.
//
//   This is the real-path analogue of the design spike, but it drives the
//   ACTUAL C entry points the browser uses (set_lockstep + receive_ticset +
//   the self-gating runTic) rather than the scripted overlay — so a regression
//   in the barrier wiring (a bad recvtic advance, a spin, a wrong TicSet write)
//   is caught here, in CI, without a browser.
//
// HOW TO RUN:
//   flox activate -- node \
//     packages/web/native/doomgeneric/tests/lockstep-barrier.acceptance.mjs
//
// SKIP-CLEAN when DOOM1.WAD is absent (gitignored). Exits 0 (skip).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, '..', '..', '..'); // packages/web
const BUILD_SCRIPT = resolve(WEB_DIR, 'native', 'build-doom-wasm.sh');
const ARTIFACT_JS = resolve(WEB_DIR, 'static', 'doom', 'doom-mp-node.js');
const WAD_PATH = resolve(WEB_DIR, 'static', 'doom', 'DOOM1.WAD');

const GS_LEVEL = 0;
const BT_ATTACK = 1;
// doomkeys.h movement keys (see packages/web/src/lib/doom/doomkeys.ts).
const KEY_UPARROW = 0xad;

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok   - ${msg}`);
  else { console.error(`  FAIL - ${msg}`); failures += 1; }
}

function ensureArtifact() {
  if (existsSync(ARTIFACT_JS)) {
    console.log(`[barrier] using existing artifact ${ARTIFACT_JS}`);
    return;
  }
  console.log('[barrier] building DOOM_MP=1 Node artifact (doom-mp-node.*)...');
  const res = spawnSync('bash', [BUILD_SCRIPT], {
    cwd: WEB_DIR,
    stdio: 'inherit',
    env: { ...process.env, DOOM_MP: '1', DOOM_OUT: 'doom-mp-node', DOOM_ENVIRONMENT: 'node' },
  });
  if (res.status !== 0) {
    console.error('[barrier] build failed (is emcc on PATH? run via `flox activate --`)');
    process.exit(1);
  }
}

async function loadInstance() {
  const mod = await import(ARTIFACT_JS + '?t=' + Math.random());
  return mod.default();
}

// Boot one WASM instance into a TRUE-LOCKSTEP netgame (the LIVE path):
// dgpt_start_netgame + dgpt_set_lockstep(1). NO scripted mode.
function bootLockstepSim(M, wad, { consolePlayer, numPlayers, map = 1 }) {
  M.FS.writeFile('/doom1.wad', wad);
  M.ccall('dgpt_init', null, ['number'], [wad.length]);
  M.ccall(
    'dgpt_start_netgame',
    null,
    ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
    [0, 1, map, 1, 0, 0, 0, numPlayers, consolePlayer],
  );
  M.ccall('dgpt_set_lockstep', null, ['number'], [1]);
  return M;
}

function checksum(M) { return M.ccall('dgpt_state_checksum', 'number', [], []) >>> 0; }
function gamestate(M) { return M.ccall('dgpt_get_gamestate', 'number', [], []); }
function maketic(M) { return M.ccall('dgpt_get_maketic', 'number', [], []); }
function gametic(M) { return M.ccall('dgpt_get_gametic', 'number', [], []); }
function recvtic(M) { return M.ccall('dgpt_get_recvtic', 'number', [], []); }
function setKey(M, key, pressed) {
  M.ccall('dgpt_set_key', null, ['number', 'number'], [key & 0xff, pressed ? 1 : 0]);
}

// Read THIS sim's OWN ticcmd built by G_BuildTiccmd for `tic` (the REAL local-
// input path: gamekeydown[] → G_BuildTiccmd → maketic ring), or null if out of
// range / fell out of BACKUPTICS. Mirrors DoomRuntime.readLocalTiccmdAt — the
// path the synthetic-input harness above SKIPS.
function readLocalTiccmdAt(M, tic) {
  if (M.ccall('dgpt_local_ticcmd_at', 'number', ['number'], [tic]) === 0) return null;
  return {
    forwardmove: M.ccall('dgpt_local_ticcmd_at_forwardmove', 'number', [], []),
    sidemove: M.ccall('dgpt_local_ticcmd_at_sidemove', 'number', [], []),
    angleturn: M.ccall('dgpt_local_ticcmd_at_angleturn', 'number', [], []),
    buttons: M.ccall('dgpt_local_ticcmd_at_buttons', 'number', [], []),
  };
}

// Deliver a consolidated TicSet (one ticcmd per slot) to a sim via the LIVE
// barrier entry point. Slots beyond numPlayers default to idle/absent.
function receiveTicSet(M, tic, numPlayers, set) {
  const args = [tic, numPlayers];
  for (let i = 0; i < 4; i++) {
    const c = set[i] ?? null;
    args.push(
      c ? c.forwardmove | 0 : 0,
      c ? c.sidemove | 0 : 0,
      c ? c.angleturn | 0 : 0,
      c ? c.buttons | 0 : 0,
      c ? 1 : 0,
    );
  }
  M.ccall('dgpt_receive_ticset', null, Array(22).fill('number'), args);
}

// One render frame: advance the clock + tick. With the barrier armed, the
// engine advances gametic ONLY up to dgpt_recvtic, then returns (never spins).
function frame(M) {
  M.ccall('dgpt_advance_clock', null, ['number'], [29]); // ~1 tic @ 35Hz
  M.ccall('dgpt_tick', null, [], []);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPlayerCmd(rng, p) {
  const r = rng();
  const forwardmove = r < 0.75 ? 25 : r < 0.9 ? -25 : 0;
  const turnDir = p % 2 === 0 ? 1 : -1;
  const angleturn = Math.floor(rng() * 300) * turnDir;
  const sidemove = r < 0.5 ? (p % 3) * 10 - 10 : 0;
  const buttons = rng() < 0.12 ? BT_ATTACK : 0;
  return { forwardmove, sidemove, angleturn, buttons };
}

// ── The transport model: ordered append-log + consolidation barrier ──────
// Mirrors LockstepTransport (doom-lockstep.ts): each peer appends ONLY its own
// slot's ticcmd; the barrier consolidates a tic only when EVERY slot is present.
class AppendLog {
  constructor() { this.entries = []; }
  append(tic, slot, cmd) { this.entries.push({ tic, slot, cmd }); }
  consolidate(tic, numPlayers) {
    const set = new Array(numPlayers).fill(null);
    for (const e of this.entries) if (e.tic === tic) set[e.slot] = e.cmd;
    if (set.some((c) => c === null)) return null;
    return set;
  }
}

// Drive N sims through the REAL barrier (set_lockstep + receive_ticset). Each
// sim is the authoritative tic clock for its OWN slot: we read maketic, append
// the local ticcmd for (maketic-1), consolidate, deliver to every sim, then
// frame each. Assert byte-identical checksums every advanced tic.
async function runBarrierLockstep(wad, { numPlayers, tics, seed, label }) {
  const sims = [];
  for (let s = 0; s < numPlayers; s++) {
    sims.push(bootLockstepSim(await loadInstance(), wad, { consolePlayer: s, numPlayers }));
  }

  // Settle every sim into GS_LEVEL. Each sim builds tics on its own clock; the
  // barrier holds advancement until we deliver TicSets, so we feed idle TicSets
  // in lockstep until all sims report GS_LEVEL.
  const rng = mulberry32(seed);
  const log = new AppendLog();
  const idle = { forwardmove: 0, sidemove: 0, angleturn: 0, buttons: 0 };

  let nextTic = 0;          // next tic to consolidate/deliver
  let appendedThru = -1;    // highest tic appended for every slot
  let firstDiverge = -1;
  let firstChecksum = null;
  let lastChecksum = null;
  let advancedTics = 0;
  let scripted = false;     // after settle, switch to divergent scripted input

  const MAX_FRAMES = (tics + 80) * 2;
  for (let f = 0; f < MAX_FRAMES; f++) {
    // 1. Frame each sim (advance clock + tick): builds maketic, advances gametic
    //    up to recvtic (barrier-gated), never spins.
    for (const M of sims) frame(M);

    // 2. Append each slot's local ticcmd for every built-but-not-logged tic.
    //    maketic is the same on every sim (identical clock + barrier), so we use
    //    sim 0's maketic as the shared tic clock.
    const mk = maketic(sims[0]);
    while (appendedThru < mk - 1) {
      appendedThru += 1;
      for (let p = 0; p < numPlayers; p++) {
        const cmd = scripted ? buildPlayerCmd(rng, p) : idle;
        log.append(appendedThru, p, cmd);
      }
    }

    // 3. Consolidate + deliver every ready TicSet, in order, to EVERY sim.
    let set;
    while ((set = log.consolidate(nextTic, numPlayers)) !== null) {
      for (const M of sims) receiveTicSet(M, nextTic, numPlayers, set);
      nextTic += 1;
    }

    // 4. Once gametic actually advanced, compare checksums across all sims.
    const gt = gametic(sims[0]);
    if (gt > advancedTics) {
      advancedTics = gt;
      const c0 = checksum(sims[0]);
      if (firstChecksum === null) firstChecksum = c0;
      lastChecksum = c0;
      for (let s = 1; s < numPlayers; s++) {
        if (checksum(sims[s]) !== c0 && firstDiverge < 0) firstDiverge = gt;
      }
    }

    // Switch to divergent scripted input once everyone's in the level (so the
    // worlds do interesting RNG-touching things — fire, move, hit barrels).
    if (!scripted && sims.every((M) => gamestate(M) === GS_LEVEL)) {
      scripted = true;
    }
    if (advancedTics >= tics) break;
  }

  check(sims.every((M) => gamestate(M) === GS_LEVEL),
    `[${label}] all sims reached GS_LEVEL through the live barrier`);
  check(advancedTics >= tics,
    `[${label}] barrier advanced ${advancedTics}/${tics} tics (no freeze/stall)`);
  if (firstDiverge >= 0) {
    check(false, `[${label}] sims stayed bit-exact through the LIVE barrier (first divergence at tic ${firstDiverge})`);
  } else {
    check(true, `[${label}] ${numPlayers} sims BYTE-IDENTICAL for all ${advancedTics} advanced tics through dgpt_set_lockstep + dgpt_receive_ticset`);
  }
  check(firstChecksum !== lastChecksum,
    `[${label}] world state evolved over the run (not a degenerate freeze)`);
}

// Prove the barrier PAUSES (does not advance, does not spin) when a slot's tic
// is withheld, and RESUMES the moment it arrives — the anti-freeze invariant on
// the real C path.
async function testBarrierPauseResume(wad) {
  const numPlayers = 2;
  const sims = [
    bootLockstepSim(await loadInstance(), wad, { consolePlayer: 0, numPlayers }),
    bootLockstepSim(await loadInstance(), wad, { consolePlayer: 1, numPlayers }),
  ];
  const idle = { forwardmove: 0, sidemove: 0, angleturn: 0, buttons: 0 };

  // Deliver TicSets 0..9 to BOTH sims so they advance to gametic 10.
  for (let t = 0; t < 10; t++) {
    for (const M of sims) frame(M);
    for (const M of sims) receiveTicSet(M, t, numPlayers, [idle, idle]);
  }
  for (const M of sims) frame(M);
  const advanced = gametic(sims[0]);
  check(advanced >= 9, `[pause] sims advanced to gametic ${advanced} with TicSets delivered`);

  // Now WITHHOLD tic `advanced` from sim 0 (deliver only to sim 1). Sim 0 must
  // PAUSE (gametic stops) without crashing/spinning over many frames.
  const stuckAt = gametic(sims[0]);
  for (let i = 0; i < 30; i++) frame(sims[0]); // no new TicSet → must pause
  check(gametic(sims[0]) === stuckAt,
    `[pause] sim 0 PAUSED at gametic ${stuckAt} while its next TicSet is withheld (no advance, no spin/crash)`);
  check(gamestate(sims[0]) === GS_LEVEL,
    `[pause] sim 0 still alive (GS_LEVEL) while paused — not frozen/aborted`);

  // Deliver the withheld TicSet → sim 0 RESUMES on the next frame.
  receiveTicSet(sims[0], stuckAt, numPlayers, [idle, idle]);
  frame(sims[0]);
  check(gametic(sims[0]) > stuckAt,
    `[pause] sim 0 RESUMED (gametic ${gametic(sims[0])} > ${stuckAt}) the moment the TicSet arrived`);
}

// ── REAL local-input path: gamekeydown[] → G_BuildTiccmd → consolidate ──────
//
// CLOSES THE GAP the per-player-inputs design (#353) found: runBarrierLockstep
// above SYNTHESIZES ticcmds (buildPlayerCmd/idle) and appends them straight to
// the log, SKIPPING G_BuildTiccmd + readLocalTiccmdAt entirely. So the real path
// — local key → DG_GetKey gamekeydown[] → G_BuildTiccmd → the maketic ring →
// readLocalTiccmdAt → ordered log → consolidated TicSet → checksum — was never
// exercised, which is exactly why the CV freeze shipped.
//
// Here each sim drives its OWN slot via a REAL held keyboard key (dgpt_set_key),
// lets G_BuildTiccmd produce the ticcmd, reads it back with readLocalTiccmdAt,
// and appends THAT (not a synthetic cmd) to the shared log. Each sim only ever
// appends its own slot. Asserts: every advanced tic stays byte-identical across
// peers, the keyboard-driven marine actually moved (forwardmove != 0 appeared),
// and the world evolved — proving the live local-input → checksum path is
// deterministic when each peer drives only its own slot.
async function testRealLocalInputLockstep(wad, { numPlayers, tics, label }) {
  const sims = [];
  for (let s = 0; s < numPlayers; s++) {
    sims.push(bootLockstepSim(await loadInstance(), wad, { consolePlayer: s, numPlayers }));
  }

  const log = new AppendLog();
  let nextTic = 0;
  let appendedThru = -1;
  let firstDiverge = -1;
  let firstChecksum = null;
  let lastChecksum = null;
  let advancedTics = 0;
  let sawForwardMove = false;
  let driving = false; // start holding FORWARD only once everyone's in-level

  const MAX_FRAMES = (tics + 120) * 2;
  for (let f = 0; f < MAX_FRAMES; f++) {
    // Each sim frames (G_BuildTiccmd runs for its OWN slot off gamekeydown[]).
    for (const M of sims) frame(M);

    // Append each slot's REAL built ticcmd for every built-but-unlogged tic.
    // CRUCIAL: each sim reads ONLY ITS OWN slot's ticcmd via readLocalTiccmdAt —
    // the production per-peer authority. maketic is shared (identical clock).
    const mk = maketic(sims[0]);
    while (appendedThru < mk - 1) {
      appendedThru += 1;
      for (let p = 0; p < numPlayers; p++) {
        const cmd = readLocalTiccmdAt(sims[p], appendedThru)
          ?? { forwardmove: 0, sidemove: 0, angleturn: 0, buttons: 0 };
        if (cmd.forwardmove !== 0) sawForwardMove = true;
        log.append(appendedThru, p, cmd);
      }
    }

    // Consolidate + deliver every ready TicSet in order to every sim.
    let set;
    while ((set = log.consolidate(nextTic, numPlayers)) !== null) {
      for (const M of sims) receiveTicSet(M, nextTic, numPlayers, set);
      nextTic += 1;
    }

    const gt = gametic(sims[0]);
    if (gt > advancedTics) {
      advancedTics = gt;
      const c0 = checksum(sims[0]);
      if (firstChecksum === null) firstChecksum = c0;
      lastChecksum = c0;
      for (let s = 1; s < numPlayers; s++) {
        if (checksum(sims[s]) !== c0 && firstDiverge < 0) firstDiverge = gt;
      }
    }

    // Once all sims are in-level, hold FORWARD on EVERY sim's own keyboard so
    // each marine builds a non-idle ticcmd via G_BuildTiccmd (real input path).
    if (!driving && sims.every((M) => gamestate(M) === GS_LEVEL)) {
      driving = true;
      for (const M of sims) setKey(M, KEY_UPARROW, true);
    }
    if (advancedTics >= tics) break;
  }

  check(sims.every((M) => gamestate(M) === GS_LEVEL),
    `[${label}] all sims reached GS_LEVEL`);
  check(advancedTics >= tics,
    `[${label}] advanced ${advancedTics}/${tics} tics via the REAL G_BuildTiccmd path (no freeze)`);
  check(sawForwardMove,
    `[${label}] a real held keyboard key produced a non-idle ticcmd through G_BuildTiccmd`);
  if (firstDiverge >= 0) {
    check(false, `[${label}] sims stayed bit-exact on the REAL local-input path (first divergence at tic ${firstDiverge})`);
  } else {
    check(true, `[${label}] ${numPlayers} sims BYTE-IDENTICAL for all ${advancedTics} tics built from real gamekeydown[] → G_BuildTiccmd → readLocalTiccmdAt → consolidated TicSet`);
  }
  check(firstChecksum !== lastChecksum,
    `[${label}] world state evolved (keyboard-driven marines moved, not a degenerate freeze)`);
}

async function main() {
  if (!existsSync(WAD_PATH)) {
    console.log('[barrier] SKIP: DOOM1.WAD not present (gitignored) — see ' +
      'static/doom/DOWNLOAD_INSTRUCTIONS.md. The barrier transport is also ' +
      'unit-tested in doom-lockstep.test.ts (no WAD needed).');
    process.exit(0);
  }
  ensureArtifact();
  const wad = new Uint8Array(readFileSync(WAD_PATH));

  console.log('[test] 2 sims fed via the LIVE barrier stay byte-identical every tic');
  await runBarrierLockstep(wad, { numPlayers: 2, tics: 200, seed: 0x5B1CE, label: '2p-live-barrier' });

  console.log('[test] 4 sims fed via the LIVE barrier stay byte-identical every tic');
  await runBarrierLockstep(wad, { numPlayers: 4, tics: 200, seed: 0xBA221E2, label: '4p-live-barrier' });

  console.log('[test] REAL local-input path (gamekeydown[] → G_BuildTiccmd → consolidate) stays bit-exact');
  await testRealLocalInputLockstep(wad, { numPlayers: 2, tics: 150, label: '2p-real-input' });

  console.log('[test] barrier PAUSES when a slot is withheld + RESUMES on arrival (anti-freeze)');
  await testBarrierPauseResume(wad);

  console.log('');
  if (failures === 0) {
    console.log('lockstep-barrier acceptance: ALL CHECKS PASSED ' +
      '(live dgpt_set_lockstep + dgpt_receive_ticset barrier is bit-exact + never freezes)');
    process.exit(0);
  } else {
    console.error(`lockstep-barrier acceptance: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('lockstep-barrier acceptance: harness error', e);
  process.exit(1);
});
