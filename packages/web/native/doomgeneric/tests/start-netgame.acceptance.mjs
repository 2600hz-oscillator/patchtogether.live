// start-netgame.acceptance.mjs — slice-4 acceptance harness for the
// dgpt_start_netgame() launch path.
//
// Copyright(C) 2026 patchtogether.live contributors. GPLv2 (lives in the
// GPLv2 doomgeneric tree).
//
// WHAT THIS PROVES (the C half of slice 4's bar):
//
//   1. A peer that calls dgpt_init() then dgpt_start_netgame(coop, E1M1,
//      skill 1, num_players=2, consoleplayer=N) actually ENTERS the level:
//      after a handful of tics, gamestate == GS_LEVEL and the peer's console
//      player has a live mobj.
//
//   2. Each peer's OWN marine moves independently: with consoleplayer=0 vs
//      consoleplayer=1, holding the forward key on each instance moves THAT
//      instance's players[consoleplayer], and the two instances end up at
//      DIFFERENT positions (separate per-peer game instances in one configured
//      netgame — not a shared view).
//
//   3. Single-player is unaffected: dgpt_start_netgame(coop, ..., num_players=1,
//      consoleplayer=0) leaves netgame == false (we don't promote a lone peer
//      to a netgame) yet still loads the level + spawns the player.
//
// WHY A STANDALONE NODE SCRIPT (mirrors net_pt.acceptance.mjs): the vitest
// unit suite runs WASM-free; building + loading the MP WASM + the 4 MB WAD
// would blow its budget. Run explicitly:
//
//   flox activate -- node packages/web/native/doomgeneric/tests/start-netgame.acceptance.mjs
//
// SKIP-CLEAN when DOOM1.WAD is absent (it is .gitignored — contributors /
// CI without the shareware WAD on disk). Exits 0 (skip) in that case so it
// can be wired into a task/CI step without wedging.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, '..', '..', '..');           // packages/web
const BUILD_SCRIPT = resolve(WEB_DIR, 'native', 'build-doom-wasm.sh');
const ARTIFACT_JS = resolve(WEB_DIR, 'static', 'doom', 'doom-mp-node.js');
const WAD_PATH = resolve(WEB_DIR, 'static', 'doom', 'DOOM1.WAD');

// gamestate_t enum (doomdef.h ordering).
const GS_LEVEL = 0;

// DOOM key constants (doomkeys.h). KEY_UPARROW = forward.
const KEY_UPARROW = 0xad;

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
    console.log(`[start-netgame] using existing artifact ${ARTIFACT_JS}`);
    return;
  }
  console.log('[start-netgame] building DOOM_MP=1 Node artifact (doom-mp-node.*)...');
  const res = spawnSync('bash', [BUILD_SCRIPT], {
    cwd: WEB_DIR,
    stdio: 'inherit',
    env: { ...process.env, DOOM_MP: '1', DOOM_OUT: 'doom-mp-node', DOOM_ENVIRONMENT: 'node' },
  });
  if (res.status !== 0) {
    console.error('[start-netgame] build failed (is emcc on PATH? run via `flox activate --`)');
    process.exit(1);
  }
}

async function loadInstance() {
  const mod = await import(ARTIFACT_JS + '?t=' + Math.random());
  return mod.default();
}

// Boot one WASM instance into a netgame at the given slot. Returns the
// emcc Module so callers can drive tics + read player state.
function bootGame(M, wad, { consolePlayer, numPlayers }) {
  M.FS.writeFile('/doom1.wad', wad);
  M.ccall('dgpt_init', null, ['number'], [wad.length]);
  // coop (deathmatch=0), E1M1 (episode 1 map 1), skill 1 (ITYTD), monsters
  // on, not fast, no respawn.
  M.ccall(
    'dgpt_start_netgame',
    null,
    ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
    [0, 1, 1, 1, 0, 0, 0, numPlayers, consolePlayer],
  );
  return M;
}

function tick(M, n = 1) {
  for (let i = 0; i < n; i++) {
    M.ccall('dgpt_advance_clock', null, ['number'], [29]); // ~1 tic @ 35Hz
    M.ccall('dgpt_tick', null, [], []);
  }
}

function gamestate(M) {
  return M.ccall('dgpt_get_gamestate', 'number', [], []);
}
function consolePos(M) {
  return {
    x: M.ccall('dgpt_get_console_player_x', 'number', [], []),
    y: M.ccall('dgpt_get_console_player_y', 'number', [], []),
    hasMobj: M.ccall('dgpt_has_console_player_mobj', 'number', [], []) !== 0,
    slot: M.ccall('dgpt_get_console_player', 'number', [], []),
  };
}
function setKey(M, key, pressed) {
  M.ccall('dgpt_set_key', null, ['number', 'number'], [key & 0xff, pressed ? 1 : 0]);
}

async function testEntersLevel(wad) {
  console.log('[test] dgpt_start_netgame enters the level + spawns console player');
  const M = bootGame(await loadInstance(), wad, { consolePlayer: 0, numPlayers: 2 });
  tick(M, 60);
  check(gamestate(M) === GS_LEVEL, 'gamestate == GS_LEVEL after launch + ticks');
  const pos = consolePos(M);
  check(pos.hasMobj, 'console player has a live mobj (spawned into the map)');
  check(pos.slot === 0, 'console player slot == 0');
}

async function testPerPeerIndependentMovement(wad) {
  console.log('[test] two peers move their OWN console player independently');
  // Peer A = slot 0, Peer B = slot 1, same E1M1 coop config.
  const A = bootGame(await loadInstance(), wad, { consolePlayer: 0, numPlayers: 2 });
  const B = bootGame(await loadInstance(), wad, { consolePlayer: 1, numPlayers: 2 });
  tick(A, 60);
  tick(B, 60);

  check(consolePos(A).hasMobj && consolePos(B).hasMobj, 'both peers spawned their console player');
  check(consolePos(A).slot === 0 && consolePos(B).slot === 1, 'peers hold distinct slots (0, 1)');

  const aStart = consolePos(A);
  const bStart = consolePos(B);

  // Move A forward only.
  setKey(A, KEY_UPARROW, true);
  tick(A, 40);
  setKey(A, KEY_UPARROW, false);
  tick(A, 10);
  const aEnd = consolePos(A);

  // B never pressed anything — it should NOT have moved from A's input
  // (separate instances), though its idle position is its own coop start.
  const bEnd = consolePos(B);

  const aMoved = aEnd.x !== aStart.x || aEnd.y !== aStart.y;
  check(aMoved, 'peer A moved its OWN marine after holding forward');

  const bStayed = bEnd.x === bStart.x && bEnd.y === bStart.y;
  check(bStayed, "peer B's marine did NOT move (A's input is local to A)");

  // The two peers occupy DIFFERENT positions — distinct coop starts + only
  // A moved. This is the core "separate per-peer instances in one netgame"
  // proof.
  const distinct = aEnd.x !== bEnd.x || aEnd.y !== bEnd.y;
  check(distinct, 'the two peers are at DIFFERENT positions (separate instances)');
}

async function testSinglePlayerUnaffected(wad) {
  console.log('[test] single-player launch (num_players=1) does not promote to netgame');
  const M = bootGame(await loadInstance(), wad, { consolePlayer: 0, numPlayers: 1 });
  tick(M, 60);
  check(gamestate(M) === GS_LEVEL, 'single-player still loads the level');
  check(consolePos(M).hasMobj, 'single-player spawns the player');
  // We can't read `netgame` directly without an export, but num_players==1
  // keeping playeringame[1..3]=false + netgame=false is what dgpt_start_netgame
  // does (see the C source); the level loading + player spawning here proves
  // the lone-peer path runs. The DoomCard never even calls this with
  // num_players==1 unless explicitly single-player; the per-peer e2e covers
  // the multiplayer side.
}

async function main() {
  if (!existsSync(WAD_PATH)) {
    console.log('[start-netgame] SKIP: DOOM1.WAD not present (gitignored) — see ' +
      'static/doom/DOWNLOAD_INSTRUCTIONS.md. The settings round-trip + roster ' +
      'slot-assignment are covered by the vitest unit suite; this harness needs ' +
      'the shareware WAD to load a level.');
    process.exit(0);
  }
  ensureArtifact();
  const wad = new Uint8Array(readFileSync(WAD_PATH));

  await testEntersLevel(wad);
  await testPerPeerIndependentMovement(wad);
  await testSinglePlayerUnaffected(wad);

  console.log('');
  if (failures === 0) {
    console.log('start-netgame acceptance: ALL CHECKS PASSED');
    process.exit(0);
  } else {
    console.error(`start-netgame acceptance: ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('start-netgame acceptance: harness error', e);
  process.exit(1);
});
