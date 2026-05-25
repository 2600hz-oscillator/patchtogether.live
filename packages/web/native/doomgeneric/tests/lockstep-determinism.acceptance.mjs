// lockstep-determinism.acceptance.mjs — slice-7 capstone harness.
//
// Copyright(C) 2026 patchtogether.live contributors. GPLv2 (lives in the
// GPLv2 doomgeneric tree).
//
// WHAT THIS PROVES (the slice-7 deliverable: BIT-EXACT lockstep determinism):
//
//   N independent in-process WASM sims, fed the SAME ordered consolidated
//   TicSet for ALL player slots each tic, produce BYTE-IDENTICAL game state
//   every single tic. The proof is a stable engine-computed state checksum
//   (dgpt_state_checksum — folds every player's mobj x/y/z/angle/momentum +
//   health + leveltime + the RNG indices rndindex/prndindex). After every tic
//   we assert all sims' checksums are EQUAL — not "within 25%", EQUAL.
//
// WHY THE EARLIER (slice-5) HARNESS COULDN'T DO THIS — and what we changed:
//
//   The slice-5 cross-peer test (start-netgame.acceptance.mjs) ran each sim's
//   OWN local-slot ticcmd through G_BuildTiccmd (driven by that sim's own key
//   queue) and then read-back maketic-1 + injected it into the OTHER sim. That
//   read-then-inject is one tic late on the receiving sim, so the producer's
//   marine is sampled a tic apart in the two worlds — a sub-pixel drift that
//   forced a relaxed "within-25% displacement" compare (see the long comment at
//   testCrossPeerVisibility there).
//
//   Slice 7 removes that lag at the source by adding a SCRIPTED LOCKSTEP mode to
//   d_loop.c (DGPT_LoopSetScripted): when armed, the d_loop overlay drives
//   EVERY slot — including the sim's own — from the injected stream, so all sims
//   consume one identical TicSet. There is no per-sim G_BuildTiccmd input and no
//   read-then-inject lag. This is precisely the shape of a real arbiter TicSet
//   broadcast: one authoritative {cmd[0..n)} per tic, applied identically on
//   every peer.
//
//   FINDING (documented for the PR): with the scripted overlay in place, the
//   sims are ALREADY bit-exact. doomgeneric's gameplay math is fixed-point and
//   the RNG is a shared LUT (m_random.c: rndtable[]) advanced ONLY by in-game
//   events — which, given an identical TicSet, happen identically on every sim.
//   No nondeterminism source had to be "found and fixed"; the determinism was
//   latent and the earlier harness's relaxed compare was purely an artifact of
//   the read-then-inject lag, NOT real engine divergence. The RNG indices are
//   folded into the checksum precisely so that the classic lockstep desync (one
//   sim calling P_Random a different number of times) would be caught here — it
//   is asserted equal every tic and stays equal.
//
// HOW TO RUN:
//   flox activate -- node \
//     packages/web/native/doomgeneric/tests/lockstep-determinism.acceptance.mjs
//
// SKIP-CLEAN when DOOM1.WAD is absent (gitignored). Exits 0 (skip) so it can be
// wired into a task/CI step without wedging.

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

// doomkeys.h. KEY_UPARROW = forward, RIGHTARROW = turn right, RCTRL = fire.
const KEY_UPARROW = 0xad;
const KEY_DOWNARROW = 0xaf;
const KEY_LEFTARROW = 0xac;
const KEY_RIGHTARROW = 0xae;
const KEY_RCTRL = 0x9d;

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  ok   - ${msg}`);
  } else {
    console.error(`  FAIL - ${msg}`);
    failures += 1;
  }
}

function ensureArtifact() {
  if (existsSync(ARTIFACT_JS)) {
    console.log(`[lockstep] using existing artifact ${ARTIFACT_JS}`);
    return;
  }
  console.log('[lockstep] building DOOM_MP=1 Node artifact (doom-mp-node.*)...');
  const res = spawnSync('bash', [BUILD_SCRIPT], {
    cwd: WEB_DIR,
    stdio: 'inherit',
    env: { ...process.env, DOOM_MP: '1', DOOM_OUT: 'doom-mp-node', DOOM_ENVIRONMENT: 'node' },
  });
  if (res.status !== 0) {
    console.error('[lockstep] build failed (is emcc on PATH? run via `flox activate --`)');
    process.exit(1);
  }
}

async function loadInstance() {
  const mod = await import(ARTIFACT_JS + '?t=' + Math.random());
  return mod.default();
}

// Boot one WASM instance into a scripted-lockstep netgame at the given slot.
function bootScriptedSim(M, wad, { consolePlayer, numPlayers, map = 1 }) {
  M.FS.writeFile('/doom1.wad', wad);
  M.ccall('dgpt_init', null, ['number'], [wad.length]);
  // coop (deathmatch=0), E1, given map, skill 1 (ITYTD), monsters on.
  M.ccall(
    'dgpt_start_netgame',
    null,
    ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
    [0, 1, map, 1, 0, 0, 0, numPlayers, consolePlayer],
  );
  // Arm scripted lockstep: the overlay now drives ALL slots (incl. this sim's
  // own) from the injected stream, so every sim consumes one identical TicSet.
  M.ccall('dgpt_set_scripted', null, ['number'], [1]);
  return M;
}

function checksum(M) {
  // unsigned 32-bit
  return M.ccall('dgpt_state_checksum', 'number', [], []) >>> 0;
}
function gamestate(M) {
  return M.ccall('dgpt_get_gamestate', 'number', [], []);
}
function injectTiccmd(M, slot, cmd) {
  M.ccall(
    'dgpt_inject_remote_ticcmd',
    null,
    ['number', 'number', 'number', 'number', 'number'],
    [slot, cmd.forwardmove | 0, cmd.sidemove | 0, cmd.angleturn | 0, cmd.buttons | 0],
  );
}

// Advance the virtual clock by ~1 tic so a tic is actually built/run, then run
// the tic. The scripted overlay applies the injected TicSet for every slot.
function tickOne(M) {
  M.ccall('dgpt_advance_clock', null, ['number'], [29]); // ~1 tic @ 35Hz
  M.ccall('dgpt_tick', null, [], []);
}

// ── Scripted ticcmd stream ──────────────────────────────────────────────
//
// A deterministic, seeded PRNG (mulberry32) drives a fixed scripted sequence of
// ticcmds for K players over M tics. Same seed → same stream every run, so the
// recorded TicSet log is reproducible and the test is not itself flaky.
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

// Build a TicSet log: for each tic, an array of K ticcmds. Players walk + turn +
// occasionally fire, with per-player phase offsets so they diverge (exercising
// distinct positions, distinct RNG-driven weapon/projectile events).
function buildTicSetLog(numPlayers, tics, seed) {
  const rng = mulberry32(seed);
  const ATTACK = 1; // BT_ATTACK
  const log = [];
  for (let t = 0; t < tics; t++) {
    const set = [];
    for (let p = 0; p < numPlayers; p++) {
      const r = rng();
      // Mostly walk forward, sometimes back; turn in a per-player direction;
      // fire ~12% of tics (so projectiles + RNG-driven spread happen).
      const forwardmove = r < 0.75 ? 25 : r < 0.9 ? -25 : 0;
      const turnDir = p % 2 === 0 ? 1 : -1;
      const angleturn = Math.floor(rng() * 300) * turnDir;
      const sidemove = r < 0.5 ? (p % 3) * 10 - 10 : 0;
      const buttons = rng() < 0.12 ? ATTACK : 0;
      set.push({ forwardmove, sidemove, angleturn, buttons });
    }
    log.push(set);
  }
  return log;
}

// Run K sims in lockstep on one shared TicSet log; assert byte-identical
// checksums every tic. Returns the per-tic checksum trace (from sim 0) so a
// caller can use it as a recorded baseline for replay.
async function runLockstep(wad, { numPlayers, tics, seed, label }) {
  const log = buildTicSetLog(numPlayers, tics, seed);

  // K sims = numPlayers, each with a distinct consolePlayer slot. (Slot only
  // affects which marine is "displayplayer"/local; in scripted mode every slot
  // is driven from the same stream, so the world state is identical regardless
  // of slot — which is itself part of the proof.)
  const sims = [];
  for (let s = 0; s < numPlayers; s++) {
    sims.push(bootScriptedSim(await loadInstance(), wad, { consolePlayer: s, numPlayers }));
  }

  // Settle every sim into the level (no scripted input yet — idle TicSet). We
  // inject a zeroed TicSet so the overlay keeps all slots in-game from tic 0.
  const idle = Array.from({ length: numPlayers }, () => ({
    forwardmove: 0, sidemove: 0, angleturn: 0, buttons: 0,
  }));
  for (let i = 0; i < 40; i++) {
    for (const M of sims) {
      for (let p = 0; p < numPlayers; p++) injectTiccmd(M, p, idle[p]);
      tickOne(M);
    }
  }
  for (const M of sims) {
    if (gamestate(M) !== GS_LEVEL) {
      check(false, `[${label}] all sims reached GS_LEVEL before scripted run`);
      return null;
    }
  }

  // Lockstep the scripted log. Each tic: inject the SAME TicSet into every sim,
  // run one tic on each, then assert all checksums match sim 0.
  const trace = [];
  let firstDivergeTic = -1;
  for (let t = 0; t < tics; t++) {
    const set = log[t];
    for (const M of sims) {
      for (let p = 0; p < numPlayers; p++) injectTiccmd(M, p, set[p]);
      tickOne(M);
    }
    const c0 = checksum(sims[0]);
    trace.push(c0);
    for (let s = 1; s < numPlayers; s++) {
      if (checksum(sims[s]) !== c0 && firstDivergeTic < 0) {
        firstDivergeTic = t;
      }
    }
  }

  if (firstDivergeTic >= 0) {
    check(false, `[${label}] sims stayed bit-exact (first divergence at tic ${firstDivergeTic})`);
  } else {
    check(true, `[${label}] ${numPlayers} sims byte-identical for all ${tics} tics (bit-exact lockstep)`);
  }

  // The state must actually have CHANGED over the run (not a degenerate "all
  // sims frozen at the same checksum" pass). Compare the final checksum to the
  // settle-point checksum.
  const settled = trace.length ? trace[0] : 0;
  const final = trace.length ? trace[trace.length - 1] : 0;
  check(
    settled !== final,
    `[${label}] world state evolved over the run (checksum changed) — not a degenerate freeze`,
  );

  return trace;
}

async function main() {
  if (!existsSync(WAD_PATH)) {
    console.log('[lockstep] SKIP: DOOM1.WAD not present (gitignored) — see ' +
      'static/doom/DOWNLOAD_INSTRUCTIONS.md. Bit-exact determinism needs the ' +
      'shareware WAD to load a real level.');
    process.exit(0);
  }
  ensureArtifact();
  const wad = new Uint8Array(readFileSync(WAD_PATH));

  // ── Test 1: 2-sim bit-exact lockstep over a scripted stream ──
  console.log('[test] 2 sims fed an identical TicSet stay byte-identical every tic');
  const trace2 = await runLockstep(wad, { numPlayers: 2, tics: 200, seed: 0xC0FFEE, label: '2p' });

  // ── Test 2: 4-sim bit-exact lockstep (the 4-player capstone) ──
  console.log('[test] 4 sims fed an identical TicSet stay byte-identical every tic');
  await runLockstep(wad, { numPlayers: 4, tics: 200, seed: 0xBADF00D, label: '4p' });

  // ── Test 3: trace-replay reproducibility ──
  // Re-run the exact same 2-sim scenario (same seed) and assert the per-tic
  // checksum trace reproduces byte-for-byte. This is the "record a session,
  // replay it, hashes match" guarantee — it catches any latent run-to-run
  // nondeterminism (uninitialized memory, address-dependent behavior) that a
  // single in-run equality check could miss.
  console.log('[test] trace-replay: a re-run of the same scripted seed reproduces the checksum trace');
  const trace2b = await runLockstep(wad, { numPlayers: 2, tics: 200, seed: 0xC0FFEE, label: '2p-replay' });
  if (trace2 && trace2b) {
    let mismatch = -1;
    for (let i = 0; i < trace2.length; i++) {
      if (trace2[i] !== trace2b[i]) { mismatch = i; break; }
    }
    check(
      mismatch < 0,
      mismatch < 0
        ? 'replay reproduced the recorded per-tic checksum trace EXACTLY (deterministic across runs)'
        : `replay diverged from recording at tic ${mismatch}`,
    );
  }

  console.log('');
  if (failures === 0) {
    console.log('lockstep-determinism acceptance: ALL CHECKS PASSED (bit-exact lockstep proven)');
    process.exit(0);
  } else {
    console.error(`lockstep-determinism acceptance: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('lockstep-determinism acceptance: harness error', e);
  process.exit(1);
});
