// e2e/tests/seqtris.spec.ts
//
// ═══════════ THE REAL-SOURCE-CHAIN GATE FOR SEQTRIS ═══════════
//
// The poly/MIDI rule (AGENTS.md boundary 8) demands the REAL default-mode
// source driven through the module to an AUDIBLE assertion — never the engine
// class directly, never "an edge materialized". SEQTRIS's default-mode source
// is a NOVATION LAUNCHPAD, so every test here goes:
//
//     simulated Launchpad hardware
//       → the app's own CONNECT gesture (a real click on the card)
//       → bindUnit + the shared onKey decode path
//       → the scene-launch CC the owner mapped
//       → the pure game core
//       → the PIECE poly cable
//       → a real DX7 voice
//       → SCOPE RMS
//
// Nothing in that chain is stubbed past the MIDI bytes. The game RULES are not
// re-asserted here — seqtris-engine.test.ts owns those; this file owns the
// wiring, which is the part a unit test structurally cannot see.
//
// ── THIS FILE NEGATIVE-CONTROLS ITS OWN INSTRUMENT ──────────────────────────
// `silent until played` patches the identical graph and drives NOTHING, then
// asserts silence over the FULL window with no early exit. If the sampler ever
// manufactures signal — or if SEQTRIS ever starts droning on its own — that
// test goes red, and the three positive tests stop being able to pass
// vacuously. `readScopePeakOverWindow` additionally throws when it took zero
// samples, so "the instrument never looked" cannot print as "the module is
// silent".

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, seedKriaGate, type SpawnEdge, type SpawnNode } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

const NODE = 'sq';

/** CAP on the "wait until audible" observation — it BOUNDS THE FAILURE and is
 *  not the gate; a sounding voice ends the window the moment it crosses the
 *  floor. Sized for a contended CI shard where the main-thread step scheduler
 *  can stall for most of a second at a time. */
const AUDIBLE_CAP_MS = 10_000;
/** Full-window observation for the SILENCE assertion — deliberately no early
 *  exit, because "it never got loud" only means something if we watched. */
const SILENCE_WINDOW_MS = 800;
const AUDIBLE_FLOOR = 0.01;

/** Scene-launch indices, TOP-origin, as the owner specified them. */
const SCENE = {
  reset: 0,
  drop: 3,
  rotateLeft: 4,
  rotateRight: 5,
  moveLeft: 6,
  moveRight: 7,
} as const;

interface SeqtrisState {
  divisor: number;
  lines: number;
  notesFired: number;
  spawns: number;
  tiedDrops: number;
  clockPulses: number;
  clockPatched: boolean;
}

/** Read the module's own state off the LIVE engine handle. */
async function readState(page: Page): Promise<SeqtrisState> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const engine = w.__engine?.();
    const node = w.__patch.nodes[id];
    return engine!.read(node, 'state') as SeqtrisState;
  }, NODE);
}

/** Install the in-memory Launchpad. Must run before the CONNECT click. */
async function installLaunchpad(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (globalThis as Record<string, unknown>).__seqtrisTestInstall === 'function');
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __seqtrisTestInstall: () => Promise<boolean> };
    await w.__seqtrisTestInstall();
  });
}

/** Press one scene-launch button on the simulated hardware (down + up). */
async function pressScene(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => {
    const w = globalThis as unknown as { __seqtrisSim: { scene: (n: number) => void } };
    w.__seqtrisSim.scene(i);
  }, index);
}

/** Read one of the host's LED writes, by programmer-mode index. */
async function ledAt(page: Page, index: number): Promise<number[] | null> {
  return page.evaluate((i) => {
    const w = globalThis as unknown as { __seqtrisSim: { ledAt: (n: number) => number[] | null } };
    return w.__seqtrisSim.ledAt(i);
  }, index);
}

/**
 * Drive the app's OWN connect gesture: click CONNECT on the card, then click
 * the port it lists. ⚠ Deliberately NOT a `bindUnit` call from the harness —
 * the gesture, the enumeration and the claim are exactly the code path this
 * spec exists to prove, and pre-wiring them would leave it untested.
 */
async function connectAndBind(page: Page): Promise<void> {
  await page.getByTestId(`seqtris-connect-${NODE}`).click();
  const port = page.getByTestId(`seqtris-port-0-${NODE}`);
  await port.waitFor({ state: 'visible' });
  await port.click();
  await expect(page.getByTestId(`seqtris-unbind-${NODE}`)).toBeVisible();
}

/** SEQTRIS → DX7 → SCOPE, optionally with a KRIA clock into the game. */
function graph(opts: { clocked: boolean; gravity?: number }): {
  nodes: SpawnNode[];
  edges: SpawnEdge[];
} {
  const nodes: SpawnNode[] = [
    {
      id: NODE,
      type: 'seqtris',
      position: { x: 340, y: 60 },
      domain: 'audio',
      params: { gravity: opts.gravity ?? 1 },
    },
    {
      id: 'dx',
      type: 'dx7',
      position: { x: 680, y: 60 },
      domain: 'audio',
      params: { algorithm: 5, voiceCount: 5, attack: 0.02, decay: 0.2, sustain: 0.9, release: 0.4, level: 1 },
    },
    { id: 'sc', type: 'scope', position: { x: 1020, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
  ];
  const edges: SpawnEdge[] = [
    {
      id: 'e_piece',
      from: { nodeId: NODE, portId: 'piece' },
      to: { nodeId: 'dx', portId: 'poly' },
      sourceType: 'polyPitchGate',
      targetType: 'polyPitchGate',
    },
    {
      id: 'e_out',
      from: { nodeId: 'dx', portId: 'out' },
      to: { nodeId: 'sc', portId: 'ch1' },
      sourceType: 'audio',
      targetType: 'audio',
    },
  ];
  if (opts.clocked) {
    nodes.push({
      id: 'clk',
      type: 'kria',
      position: { x: 40, y: 60 },
      domain: 'audio',
      params: { bpm: 240, running: 1 },
    });
    edges.push({
      id: 'e_clk',
      from: { nodeId: 'clk', portId: 'gate1' },
      to: { nodeId: NODE, portId: 'clock' },
      sourceType: 'gate',
      targetType: 'gate',
    });
  }
  return { nodes, edges };
}

// ────────────────────────────────────────────────────────────────────────────

test('the real chain: a clock falls pieces through PIECE into a voice, audibly', async ({
  page,
  rack,
  errorWatch,
}) => {
  test.setTimeout(60_000);
  const g = graph({ clocked: true, gravity: 1 });
  await spawnPatch(page, g.nodes, g.edges);
  await seedKriaGate(page, 'clk');

  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, { untilPeak: AUDIBLE_FLOOR });
  expect(
    w.peak,
    `PIECE should drive the voice as gravity falls — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);

  const state = await readState(page);
  expect(state.clockPatched, 'gravity must be running off the patched clock').toBe(true);
  expect(state.clockPulses, 'the clock jack should have counted pulses').toBeGreaterThan(0);
  expect(state.notesFired, 'falling should have fired notes').toBeGreaterThan(0);
});

test('the real chain: LAUNCHPAD scene presses ALONE make sound, with no clock patched', async ({
  page,
  rack,
  errorWatch,
}) => {
  test.setTimeout(60_000);
  // ⚠ NO CLOCK. This is the load-bearing test for the poly/MIDI rule: the ONLY
  // thing that can move a piece here is a real MIDI scene-launch CC arriving on
  // the port the app itself claimed. If the Launchpad path were broken, gravity
  // could not paper over it.
  const g = graph({ clocked: false });
  await spawnPatch(page, g.nodes, g.edges);
  await installLaunchpad(page);
  await connectAndBind(page);

  const before = await readState(page);
  expect(before.clockPatched).toBe(false);
  expect(before.notesFired, 'nothing has been played yet').toBe(0);

  for (const i of [SCENE.moveRight, SCENE.moveLeft, SCENE.rotateRight, SCENE.moveRight]) {
    await pressScene(page, i);
  }

  const after = await readState(page);
  expect(after.notesFired, 'scene presses should have played notes').toBeGreaterThan(0);

  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, {
    untilPeak: AUDIBLE_FLOOR,
    // Keep pressing while we listen, so a note's own decay cannot end the run
    // before the sampler's first peek.
  });
  expect(
    w.peak,
    `a Launchpad press should be audible through PIECE → DX7 — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});

test('the board reaches the hardware: binding lights the pads and the control column', async ({
  page,
  rack,
  errorWatch,
}) => {
  test.setTimeout(60_000);
  const g = graph({ clocked: false });
  await spawnPatch(page, g.nodes, g.edges);
  await installLaunchpad(page);
  await connectAndBind(page);

  // The scene-launch column: the six live controls are lit, the two the owner
  // specified as "nothing" are dark. CC numbers, top to bottom.
  const SCENE_CCS = [89, 79, 69, 59, 49, 39, 29, 19];
  for (let i = 0; i < SCENE_CCS.length; i++) {
    const led = await ledAt(page, SCENE_CCS[i]!);
    if (i === 1 || i === 2) expect(led, `scene ${i} is a dead button`).toBeNull();
    else expect(led, `scene ${i} is a live control`).not.toBeNull();
  }

  // The 8×8 grid: at least one pad carries the spawned piece. Programmer-mode
  // note = (y + 1) * 10 + (x + 1), y from the BOTTOM — the piece spawns on the
  // TOP row, which is y = 7, so notes 81..88.
  const topRow: (number[] | null)[] = [];
  for (let x = 0; x < 8; x++) topRow.push(await ledAt(page, 8 * 10 + (x + 1)));
  expect(
    topRow.filter((c) => c !== null).length,
    'the spawned piece should be lit on the TOP pad row',
  ).toBeGreaterThan(0);
});

test('a DROP is ONE tied gate carrying every row it falls through', async ({
  page,
  rack,
  errorWatch,
}) => {
  test.setTimeout(60_000);
  const g = graph({ clocked: false });
  await spawnPatch(page, g.nodes, g.edges);
  await installLaunchpad(page);
  await connectAndBind(page);

  await pressScene(page, SCENE.drop);

  const state = await readState(page);
  expect(state.tiedDrops, 'the drop should have emitted a tie, not a burst').toBe(1);
  // The drop locks the piece and spawns the next one, so a spawn happened too.
  expect(state.spawns, 'a locked piece is followed by a spawn').toBeGreaterThan(0);
  // ⚠ notesFired counts SCHEDULING EVENTS, not rows: the tie is ONE of them
  // however many rows it carries. A drop from the top of an empty 8-row well
  // plus the following spawn note is two — if this ever reads ~8, the tie has
  // silently become a per-row retrigger, which is exactly the shape the spec
  // rules out.
  expect(state.notesFired, 'a tie plus the next spawn note is two scheduling events').toBe(2);

  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, { untilPeak: AUDIBLE_FLOOR });
  expect(
    w.peak,
    `the tied drop chord should be audible — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});

test('silent until played — the negative control for this file\'s instrument', async ({
  page,
  rack,
  errorWatch,
}) => {
  test.setTimeout(60_000);
  // The IDENTICAL graph as the positive tests, with nothing driving it: no
  // clock patched, no Launchpad bound, no press. If this ever reads audio, the
  // sampler is manufacturing signal or the module is droning, and the three
  // tests above stop meaning anything.
  const g = graph({ clocked: false });
  await spawnPatch(page, g.nodes, g.edges);

  const w = await readScopePeakOverWindow(page, 'sc', SILENCE_WINDOW_MS);
  expect(
    w.peak,
    `an undriven SEQTRIS must be silent — ${describeScopeWindow(w)}`,
  ).toBeLessThan(AUDIBLE_FLOOR);
  const state = await readState(page);
  expect(state.notesFired, 'nothing should have been played').toBe(0);
});
