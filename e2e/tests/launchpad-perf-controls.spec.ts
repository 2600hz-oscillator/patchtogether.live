// e2e/tests/launchpad-perf-controls.spec.ts
//
// SINGLE-UNIT CONTROL-view PERFORMANCE controls, driven through the SAME
// decode/dispatch path real hardware uses (installSimulatedLaunchpadSingle +
// selecting the CONTROL view on the PERMANENT top row — CC 95). These pads write
// the SAME synced node state the card/engine already consume:
//
//   RESET (deck row 1 col 2)  → node.data.resetNonce → every active lane snaps to
//                               step 1 (the card RST / reset-gate field).
//   MUTE  (deck row 3, per-lane) → node.data.muted[lane] → the lane KEEPS
//                               advancing its playhead but emits NO audio.
//   MONO  (deck row 2) / RATE (deck row 4) → the mono[]/rate[] arrays.
//   TEMPO −/+ → the re-homed CONTROL-view grid pads (0,7)/(1,7) → TIMELORDE bpm
//               (the permanent top row now owns CC 91..98, so tempo moved off the
//               old CC 93/94 onto dark CONTROL grid pads — controlRehomePad).
//
// Deck pad coordinates mirror launchpad-map (DECK_RESET/MONO/MUTE/RATE rows); the
// lone device is the L slot, routed by the active VIEW, so we select CONTROL via
// the permanent top-row CC 95.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// Deck pad placements (launchpad-map: DECK_RESET_COL/ROW, DECK_MONO/MUTE/RATE_ROW).
const RESET_PAD = { x: 2, y: 1 };
const MONO_ROW = 2;
const MUTE_ROW = 3;
const RATE_ROW = 4;
// Permanent top-row CONTROL-view select (topRowAction: CC 95 = control).
const CC_VIEW_CONTROL = 95;
// Re-homed TEMPO −/+ pads on the CONTROL grid's top row (controlRehomePad:
// CTRL_TEMPO_DOWN_COL=0, CTRL_TEMPO_UP_COL=1, CTRL_TEMPO_ROW=7).
const TEMPO_DOWN_PAD = { x: 0, y: 7 };
const TEMPO_UP_PAD = { x: 1, y: 7 };

type EngineW = {
  __engine?: () => { read: (node: { id: string; type: string; domain: string }, key: string) => unknown } | null;
  __patch: { nodes: Record<string, { id: string; type: string; domain: string; params?: Record<string, number>; data?: Record<string, unknown> }> };
  __ydoc: { transact: (fn: () => void) => void };
};

async function readEngine(page: Page, nodeId: string, key: string): Promise<number | null> {
  return await page.evaluate(({ id, k }) => {
    const w = globalThis as unknown as EngineW;
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const v = eng.read(node, k);
    return typeof v === 'number' ? v : null;
  }, { id: nodeId, k: key });
}
async function waitForEngine(page: Page, nodeId: string, key: string, pred: (v: number) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: number | null = null;
  while (Date.now() < deadline) {
    last = await readEngine(page, nodeId, key);
    if (typeof last === 'number' && pred(last)) return { ok: true, last };
    await page.waitForTimeout(50);
  }
  return { ok: false, last };
}

/** Seed DENSE 128-step note clips (a note every step) in slot 0 of `lanes`, and
 *  queue them — via the same Y.Doc path the card/grid use. */
async function seedDenseClips(page: Page, nodeId: string, lanes: number[]) {
  await page.evaluate(({ id, ls }) => {
    const w = globalThis as unknown as EngineW;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n.data) n.data = {};
      const clips: Record<string, unknown> = {};
      const queued: (number | null)[] = new Array(8).fill(null);
      // Flat clip key is stride-64 (schema v2): clipIndex(slot=0, lane) = lane*64.
      // (The old `lane*8` only matched lane 0 → other lanes were never found = "saw -1".)
      for (const lane of ls) {
        clips[String(lane * 64)] = {
          kind: 'note', lengthSteps: 128, root: 48, loop: true,
          steps: Array.from({ length: 128 }, (_, s) => ({ step: s, midi: 72, velocity: 127, lengthSteps: 1 })),
        };
        queued[lane] = 0;
      }
      n.data.clips = clips;
      n.data.sv = 2; // already stride-64 → skip the legacy re-key migration
      n.data.queued = queued;
    });
  }, { id: nodeId, ls: lanes });
}

async function setTransport(page: Page, running: number, bpm = 240) {
  await page.evaluate(({ run, b }) => {
    const w = globalThis as unknown as EngineW;
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-perf'] = {
          id: 'tl-perf', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
          params: { running: run, bpm: b }, data: {},
        } as never;
      } else {
        for (const n of tls) { if (!n.params) n.params = {}; n.params.running = run; n.params.bpm = b; }
      }
    });
  }, { run: running, b: bpm });
}

async function installSingle(page: Page, nodeId: string) {
  const ok = await page.evaluate(async (id) => {
    const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
    return w.__launchpadTestInstallSingle ? await w.__launchpadTestInstallSingle(id) : false;
  }, nodeId);
  expect(ok, 'single simulated Launchpad install hook present').toBe(true);
}
const press = (page: Page, x: number, y: number) =>
  page.evaluate(({ x, y }) => (globalThis as unknown as { __launchpadSingleSim?: { press: (x: number, y: number) => void } }).__launchpadSingleSim!.press(x, y), { x, y });
// Select the CONTROL view via the PERMANENT top row (CC 95, press+release). The
// lone device binds into the CLIP view, so every perf test selects CONTROL first.
const selectControl = (page: Page) =>
  page.evaluate((c) => {
    const s = (globalThis as unknown as { __launchpadSingleSim?: { cc: (c: number, v: number) => void } }).__launchpadSingleSim!;
    s.cc(c, 127);
    s.cc(c, 0);
  }, CC_VIEW_CONTROL);
const nodeData = (page: Page, nodeId: string) =>
  page.evaluate((id) => (globalThis as unknown as EngineW).__patch.nodes[id]?.data ?? null, nodeId);

test('@launchpad RESET pad snaps every active lane back to step 1 (control-deck)', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
      params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio', params: { running: 0, bpm: 240 } },
  ]);
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);
  await installSingle(page, 'cp');

  await seedDenseClips(page, 'cp', [0, 1]);
  await setTransport(page, 1);

  // both lanes well past the top (128-step clip → no wrap in this window).
  const l0 = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 8, 6000);
  expect(l0.ok, `lane 0 mid-clip before reset (saw ${l0.last})`).toBe(true);

  // Select the CONTROL view (permanent top row) + press the hardware RESET pad.
  await selectControl(page);
  await press(page, RESET_PAD.x, RESET_PAD.y);

  // Snap back near the top LONG before a natural wrap. Band <=6 (the fast clock
  // keeps climbing during dispatch latency — same tolerance as the card RST test).
  // Timeout 5000 ms (was 2500): `currentStep` rides the AUDIO clock and climbs
  // even while the MAIN-THREAD scheduler tick (the only consumer of resetNonce)
  // is momentarily starved on a loaded CI runner — that stall left the snap
  // unprocessed and the poll expired at step ~45 (CI-only; passes locally + at
  // 4 workers). 5000 ms tolerates the stall and stays WELL under the 8 s /
  // 128-step wrap horizon, so a loop wrap can never fake the low reading.
  const s0 = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 0 && v <= 6, 5000);
  expect(s0.ok, `lane 0 snapped toward the top (saw ${s0.last})`).toBe(true);
  const s1 = await waitForEngine(page, 'cp', 'currentStep:1', (v) => v >= 0 && v <= 6, 5000);
  expect(s1.ok, `lane 1 snapped with the same reset (saw ${s1.last})`).toBe(true);
  // Still PLAYING (reset ≠ stop) + advancing.
  expect(await readEngine(page, 'cp', 'activeLane:0')).toBe(0);
  const resumed = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 6, 4000);
  expect(resumed.ok, `lane 0 kept advancing after reset (saw ${resumed.last})`).toBe(true);
});

test('@launchpad MUTE pad silences a running lane in place — RMS drops to ~0 while its step keeps advancing; unmute returns audio', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: 'vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio', params: { base: 0, cvAmount: 1 } },
      { id: 'scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio', params: { timeMs: 200 } },
      { id: 'tl', type: 'timelorde', position: { x: 60, y: 360 }, domain: 'audio', params: { running: 0, bpm: 240 } },
    ],
    [
      { id: 'h1', from: { nodeId: 'cp', portId: 'pitch1' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: 'h2', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'h3', from: { nodeId: 'cp', portId: 'gate1' }, to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'gate', targetType: 'cv' },
      { id: 'h4', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);
  await installSingle(page, 'cp');

  await seedDenseClips(page, 'cp', [0]); // dense lane 0 → continuous audio
  await setTransport(page, 1);

  // Lane 0 runs → AUDIBLE.
  let live = await readScopePeakOverWindow(page, 'scp', 600);
  await expect
    .poll(async () => { live = await readScopePeakOverWindow(page, 'scp', 600); return live.rms; }, { timeout: 15000, message: 'audible while lane 0 runs' })
    .toBeGreaterThan(0.03);
  const stepBeforeMute = (await readEngine(page, 'cp', 'currentStep:0')) ?? -1;
  expect(stepBeforeMute).toBeGreaterThanOrEqual(0);

  // MUTE lane 0 (control deck, row 3 col 0) → output falls to ~0.
  await selectControl(page);
  await press(page, 0, MUTE_ROW);
  expect((await nodeData(page, 'cp') as { muted?: boolean[] } | null)?.muted?.[0]).toBe(true);
  await expect
    .poll(async () => (await readScopePeakOverWindow(page, 'scp', 400)).rms, { timeout: 8000, message: 'muted lane falls silent' })
    .toBeLessThan(0.03);
  // ...but its playhead KEEPS advancing (mute ≠ stop, still locked to transport).
  const advanced = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v > (stepBeforeMute % 128) || v < stepBeforeMute, 4000);
  expect(advanced.ok, `muted lane kept advancing (saw ${advanced.last}, was ${stepBeforeMute})`).toBe(true);
  expect(await readEngine(page, 'cp', 'activeLane:0'), 'still active (mute ≠ stop)').toBe(0);

  // UNMUTE → audio returns.
  await press(page, 0, MUTE_ROW);
  expect((await nodeData(page, 'cp') as { muted?: boolean[] } | null)?.muted?.[0]).toBe(false);
  await expect
    .poll(async () => (await readScopePeakOverWindow(page, 'scp', 600)).rms, { timeout: 15000, message: 'audio returns after unmute' })
    .toBeGreaterThan(0.03);
});

test('@launchpad MONO / RATE / tempo deck pads write the synced node state', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio', params: {} },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio', params: { running: 0, bpm: 120 } },
  ]);
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);
  await installSingle(page, 'cp');
  await selectControl(page); // → CONTROL (the deck)

  // MONO lane 3 (row 2, col 3).
  await press(page, 3, MONO_ROW);
  expect((await nodeData(page, 'cp') as { mono?: boolean[] } | null)?.mono?.[3]).toBe(true);
  // RATE lane 1 cycles up from the default '1' (index 3) → 2x (index 4).
  await press(page, 1, RATE_ROW);
  expect((await nodeData(page, 'cp') as { rate?: number[] } | null)?.rate?.[1]).toBe(4);
  // Tempo nudge − / + (the re-homed CONTROL-view grid pads) step TIMELORDE bpm
  // (clamped 10..300).
  const bpm0 = await page.evaluate(() => (globalThis as unknown as EngineW).__patch.nodes['tl'].params?.bpm);
  await press(page, TEMPO_UP_PAD.x, TEMPO_UP_PAD.y);
  const bpmUp = await page.evaluate(() => (globalThis as unknown as EngineW).__patch.nodes['tl'].params?.bpm);
  expect(bpmUp!).toBeGreaterThan(bpm0!);
  await press(page, TEMPO_DOWN_PAD.x, TEMPO_DOWN_PAD.y);
  await press(page, TEMPO_DOWN_PAD.x, TEMPO_DOWN_PAD.y);
  const bpmDown = await page.evaluate(() => (globalThis as unknown as EngineW).__patch.nodes['tl'].params?.bpm);
  expect(bpmDown!).toBeLessThan(bpmUp!);
});
