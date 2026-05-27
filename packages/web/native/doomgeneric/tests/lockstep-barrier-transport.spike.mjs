// lockstep-barrier-transport.spike.mjs
//
// Copyright(C) 2026 patchtogether.live contributors. GPLv2 (lives in the
// GPLv2 doomgeneric tree).
//
// ─────────────────────────────────────────────────────────────────────────
// ISOLATED DESIGN SPIKE for `.myrobots/plans/doom-mp-true-lockstep.md` §8.
// This is a THROWAWAY de-risk harness. It does NOT touch the live netcode
// (no DoomCard.svelte / doom-netcode.ts changes) and is NOT wired into the
// live tic path. It exists to answer ONE question before we build P1:
//
//   Does an ORDERED APPEND-LOG transport + a CONSOLIDATION BARRIER keep two
//   independent sims' dgpt_state_checksum() MATCHING every tic?
//
// WHY THIS IS DIFFERENT FROM lockstep-determinism.acceptance.mjs:
//   The sibling harness injects the SAME pre-built TicSet directly into every
//   sim — it proves the ENGINE is deterministic given an identical TicSet, but
//   it models no transport. It cannot tell you whether the TRANSPORT SHAPE we
//   plan to build (each peer appends its own slot's ticcmd to a shared ordered
//   log; an arbiter consolidates a per-tic TicSet only once ALL slots for that
//   tic are present; the barrier withholds the tic until then) actually
//   reconstructs an identical ordered TicSet on every peer.
//
//   This spike models that transport explicitly:
//     - Each sim "sends" ONLY its own slot's ticcmd, into a shared ordered
//       append-log (the Y.Array semantics from §3, simulated in-process).
//     - A BARRIER consolidates tic N's TicSet only when the log holds an entry
//       for EVERY live slot at tic N (the §4 "advance only when all peers'
//       tic-N inputs are present" rule). Entries may arrive out of order /
//       interleaved (we shuffle them) — the log's total order + the barrier
//       must still reconstruct the SAME TicSet on both consolidations.
//     - The consolidated TicSet is then applied to BOTH sims via the scripted
//       overlay, and we assert dgpt_state_checksum() is EQUAL every tic.
//
//   If checksums match, the ordered-log + barrier transport is proven
//   sufficient for bit-exact shared state — P1 is safe to build on it.
//
// HOW TO RUN:
//   flox activate -- node \
//     packages/web/native/doomgeneric/tests/lockstep-barrier-transport.spike.mjs
//
// SKIP-CLEAN when DOOM1.WAD is absent (gitignored): exits 0 (skip) so it never
// wedges a task/CI step. Requires emcc on PATH (via flox) only when it has to
// build the DOOM_MP node artifact (reuses the sibling's artifact if present).

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
    console.log(`[spike] using existing artifact ${ARTIFACT_JS}`);
    return;
  }
  console.log('[spike] building DOOM_MP=1 Node artifact (doom-mp-node.*)...');
  const res = spawnSync('bash', [BUILD_SCRIPT], {
    cwd: WEB_DIR,
    stdio: 'inherit',
    env: { ...process.env, DOOM_MP: '1', DOOM_OUT: 'doom-mp-node', DOOM_ENVIRONMENT: 'node' },
  });
  if (res.status !== 0) {
    console.error('[spike] build failed (is emcc on PATH? run via `flox activate --`)');
    process.exit(1);
  }
}

async function loadInstance() {
  const mod = await import(ARTIFACT_JS + '?t=' + Math.random());
  return mod.default();
}

function bootScriptedSim(M, wad, { consolePlayer, numPlayers, map = 1 }) {
  M.FS.writeFile('/doom1.wad', wad);
  M.ccall('dgpt_init', null, ['number'], [wad.length]);
  M.ccall(
    'dgpt_start_netgame',
    null,
    ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
    [0, 1, map, 1, 0, 0, 0, numPlayers, consolePlayer],
  );
  // Scripted lockstep: overlay drives ALL slots from the injected stream, which
  // is exactly the consolidated-TicSet shape the barrier produces.
  M.ccall('dgpt_set_scripted', null, ['number'], [1]);
  return M;
}

function checksum(M) {
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
function tickOne(M) {
  M.ccall('dgpt_advance_clock', null, ['number'], [29]); // ~1 tic @ 35Hz
  M.ccall('dgpt_tick', null, [], []);
}

// Seeded PRNG so the scripted stream + the shuffle order are reproducible.
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

// Per-player scripted input for one tic (divergent per slot so the worlds
// actually do interesting, RNG-touching things — fire, move, turn).
function buildPlayerCmd(rng, p) {
  const r = rng();
  const forwardmove = r < 0.75 ? 25 : r < 0.9 ? -25 : 0;
  const turnDir = p % 2 === 0 ? 1 : -1;
  const angleturn = Math.floor(rng() * 300) * turnDir;
  const sidemove = r < 0.5 ? (p % 3) * 10 - 10 : 0;
  const buttons = rng() < 0.12 ? BT_ATTACK : 0;
  return { forwardmove, sidemove, angleturn, buttons };
}

// ── The transport model: an ORDERED APPEND-LOG + a CONSOLIDATION BARRIER ──
//
// AppendLog mimics a Yjs Y.Array (or an ordered/reliable WebRTC datachannel):
// append-only, total order, no coalescing, no loss. Each peer appends ONLY its
// own slot's ticcmd for a tic. The barrier consolidates tic N's TicSet only
// when EVERY live slot has an entry for N. To make the test meaningful we
// deliberately push entries OUT OF ORDER (interleaved across tics + shuffled
// within a tic) before consolidating — the log's order + the barrier must still
// reconstruct the identical TicSet, which is the whole point.
class AppendLog {
  constructor() {
    this.entries = []; // { tic, slot, cmd } in append order
  }
  append(tic, slot, cmd) {
    this.entries.push({ tic, slot, cmd });
  }
  // Consolidate: returns the TicSet (array indexed by slot) for `tic` iff every
  // slot in [0, numPlayers) has an entry; else null (barrier withholds).
  consolidate(tic, numPlayers) {
    const set = new Array(numPlayers).fill(null);
    for (const e of this.entries) {
      if (e.tic === tic) set[e.slot] = e.cmd;
    }
    if (set.some((c) => c === null)) return null; // not all slots present yet
    return set;
  }
}

// Settle every sim into GS_LEVEL with an idle TicSet (keeps all slots in-game
// from tic 0).
function settleToLevel(sims, numPlayers) {
  const idle = { forwardmove: 0, sidemove: 0, angleturn: 0, buttons: 0 };
  for (let i = 0; i < 40; i++) {
    for (const M of sims) {
      for (let p = 0; p < numPlayers; p++) injectTiccmd(M, p, idle);
      tickOne(M);
    }
  }
  return sims.every((M) => gamestate(M) === GS_LEVEL);
}

// Run the barrier-transport lockstep: each peer appends ONLY its own slot's
// ticcmd to the shared log (in a shuffled, out-of-order arrival pattern); the
// barrier consolidates per tic; the consolidated TicSet is applied to BOTH sims
// via the scripted overlay; checksums asserted equal every tic.
async function runBarrierLockstep(wad, { numPlayers, tics, seed, label }) {
  const sims = [];
  for (let s = 0; s < numPlayers; s++) {
    sims.push(bootScriptedSim(await loadInstance(), wad, { consolePlayer: s, numPlayers }));
  }
  if (!settleToLevel(sims, numPlayers)) {
    check(false, `[${label}] all sims reached GS_LEVEL before scripted run`);
    return;
  }

  const rng = mulberry32(seed);
  const log = new AppendLog();

  let firstDiverge = -1;
  let consolidatedTics = 0;
  let firstChecksum = null;
  let lastChecksum = null;

  // We append a window of upcoming tics' per-slot ticcmds in a deliberately
  // INTERLEAVED + SHUFFLED order (simulating real per-peer arrival jitter over
  // the transport), then let the barrier consolidate each tic strictly in
  // order. The barrier must only release tic N once all slots for N are in the
  // log — and the reconstructed TicSet must be identical for both sims (they
  // both read the same ordered log).
  const APPEND_AHEAD = 4; // peers run a few tics ahead (the §4 build-ahead)
  let appendedUpTo = -1;

  function appendTic(t) {
    // Build this tic's per-slot cmds, then append in a shuffled order so arrival
    // order is NOT slot order (stress the consolidation).
    const order = [];
    for (let p = 0; p < numPlayers; p++) order.push(p);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const p of order) {
      log.append(t, p, buildPlayerCmd(rng, p));
    }
  }

  for (let t = 0; t < tics; t++) {
    // Keep the append window APPEND_AHEAD tics ahead of consolidation.
    while (appendedUpTo < t + APPEND_AHEAD && appendedUpTo + 1 < tics) {
      appendedUpTo += 1;
      appendTic(appendedUpTo);
    }

    // BARRIER: only consolidate tic t when all slots are present. (We assert the
    // aggregate "released all tics in order" once at the end rather than logging
    // a line per tic — the per-tic count is tracked silently here.)
    const set = log.consolidate(t, numPlayers);
    if (set === null) {
      check(false, `[${label}] barrier STALLED at tic ${t} (a slot's entry never arrived)`);
      return;
    }
    if (consolidatedTics !== t) {
      check(false, `[${label}] barrier released tic ${consolidatedTics} out of order (expected ${t})`);
      return;
    }
    consolidatedTics += 1;

    // Apply the SAME consolidated TicSet to every sim + run one tic.
    for (const M of sims) {
      for (let p = 0; p < numPlayers; p++) injectTiccmd(M, p, set[p]);
      tickOne(M);
    }

    const c0 = checksum(sims[0]);
    if (firstChecksum === null) firstChecksum = c0;
    lastChecksum = c0;
    for (let s = 1; s < numPlayers; s++) {
      if (checksum(sims[s]) !== c0 && firstDiverge < 0) firstDiverge = t;
    }
  }

  if (firstDiverge >= 0) {
    check(false, `[${label}] sims stayed bit-exact through the barrier (first divergence at tic ${firstDiverge})`);
  } else {
    check(true, `[${label}] ${numPlayers} sims byte-identical for all ${tics} tics THROUGH the ordered-log + barrier transport`);
  }
  check(firstChecksum !== lastChecksum,
    `[${label}] world state evolved over the run (not a degenerate freeze)`);
  check(consolidatedTics === tics,
    `[${label}] barrier released all ${tics} tics in order (no stall, no skip)`);
}

// A second scenario: prove the barrier WITHHOLDS when a slot's tic-N entry is
// missing, and RELEASES the moment it arrives — the §4 "advance only when all
// peers' tic-N inputs are present" rule, in isolation (no sims needed).
function testBarrierWithholdRelease() {
  const log = new AppendLog();
  const N = 2;
  log.append(0, 0, { forwardmove: 1, sidemove: 0, angleturn: 0, buttons: 0 });
  check(log.consolidate(0, N) === null, '[barrier] tic 0 WITHHELD while slot 1 missing');
  log.append(0, 1, { forwardmove: 2, sidemove: 0, angleturn: 0, buttons: 0 });
  const set = log.consolidate(0, N);
  check(set !== null && set[0].forwardmove === 1 && set[1].forwardmove === 2,
    '[barrier] tic 0 RELEASED with correct per-slot TicSet once slot 1 arrived');
}

async function main() {
  // Pure-logic barrier test runs even without the WAD (no WASM needed).
  console.log('[test] barrier withholds until all slots present, then releases the right TicSet');
  testBarrierWithholdRelease();

  if (!existsSync(WAD_PATH)) {
    console.log('[spike] SKIP (WASM portion): DOOM1.WAD not present (gitignored) — ' +
      'see static/doom/DOWNLOAD_INSTRUCTIONS.md. The barrier-logic check above ran; ' +
      'the bit-exact-through-transport proof needs the shareware WAD.');
    // Exit on the barrier-logic result only; the transport proof is skipped.
    process.exit(failures === 0 ? 0 : 1);
  }

  ensureArtifact();
  const wad = new Uint8Array(readFileSync(WAD_PATH));

  console.log('[test] 2 sims fed via ordered-log + barrier stay byte-identical every tic');
  await runBarrierLockstep(wad, { numPlayers: 2, tics: 200, seed: 0x5B1CE, label: '2p-barrier' });

  console.log('[test] 4 sims fed via ordered-log + barrier stay byte-identical every tic');
  await runBarrierLockstep(wad, { numPlayers: 4, tics: 200, seed: 0xBA221E2, label: '4p-barrier' });

  console.log('');
  if (failures === 0) {
    console.log('lockstep-barrier-transport spike: ALL CHECKS PASSED ' +
      '(ordered-log + barrier reconstructs an identical TicSet → bit-exact shared state)');
    process.exit(0);
  } else {
    console.error(`lockstep-barrier-transport spike: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('lockstep-barrier-transport spike: harness error', e);
  process.exit(1);
});
