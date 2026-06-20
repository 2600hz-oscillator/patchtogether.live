// e2e/tests/launchpad-clip-launch.spec.ts
//
// LAUNCHPAD real-source-chain proof (the poly/MIDI discipline, CLAUDE.md): a
// pad press on a (simulated) Novation Launchpad must LAUNCH a clip on the bound
// clip-player and drive a downstream VOICE to AUDIBLE output through the REAL
// TIMELORDE-locked clock — not just "a pad maps to a clip". The chain is the
// real one a user builds:
//
//   [simulated Launchpad LEFT pad (slot0, lane0)] → clipplayer.queued[0]
//   clipplayer.pitch1 → VCO.pitch ; VCO.sine → VCA.audio ;
//   clipplayer.gate1  → VCA.cv    ; VCA.audio → SCOPE.ch1
//
// The pad press goes through the SAME decode/dispatch path real hardware uses
// (installSimulatedLaunchpad → the launchpad-control binding writes the synced
// node.data.queued), so this exercises the device + map + binding end to end.
//
// The clip player has NO internal BPM — it runs only while TIMELORDE runs, so
// the test proves the launch produces sound only once the transport runs
// (silent before launch → audible after), catching the green-but-silent class.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

async function setTransport(page: import('@playwright/test').Page, running: number) {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-lp-test'] = {
          id: 'tl-lp-test', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
          params: { running: run, bpm: 200 }, data: {},
        } as never;
      } else {
        for (const n of tls) {
          if (!n.params) n.params = {};
          n.params.running = run;
          n.params.bpm = 200;
        }
      }
    });
  }, running);
}

/** lane-0 entry of the clipplayer's synced `playing` set. */
async function lane0Playing(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { playing?: unknown[] } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.playing?.[0] ?? null;
  });
}

/** Read the clipplayer's synced arranger state (recording / clipMode / # events). */
async function arrangeState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<
          string,
          { type?: string; data?: { recording?: boolean; clipMode?: string; arrangement?: { events?: unknown[] } } }
        >;
      };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return {
      recording: cp?.data?.recording === true,
      clipMode: cp?.data?.clipMode ?? 'session',
      events: Array.isArray(cp?.data?.arrangement?.events) ? cp!.data!.arrangement!.events!.length : 0,
    };
  });
}

// Arranger SONG controls on the R deck (top row). REC = CC 91, SONG = CC 92 —
// confirmed in launchpad-map.ts (CC_REC / CC_SONG). The Launchpad sim routes a
// CC through the SAME decode/dispatch path real hardware uses.
const CC_REC = 91;
const CC_SONG = 92;

test('@launchpad a simulated pad press launches a clip → audible RMS at the clipplayer voice', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'a-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        // quantize off → the first launch fires immediately; 1/16 steps.
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: 'a-vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'a-vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio',
        params: { base: 0, cvAmount: 1 } },
      { id: 'a-scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-cp', portId: 'pitch1' }, to: { nodeId: 'a-vco', portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'sine' }, to: { nodeId: 'a-vca', portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e3', from: { nodeId: 'a-cp', portId: 'gate1' }, to: { nodeId: 'a-vca', portId: 'cv' },
        sourceType: 'gate', targetType: 'cv' },
      { id: 'e4', from: { nodeId: 'a-vca', portId: 'audio' }, to: { nodeId: 'a-scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);

  // Seed a clip in lane 0 / slot 0 (drives pitch1/gate1) — the same data the
  // card/grid write. (We launch it via the LAUNCHPAD, not by writing queued[].)
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['a-cp'];
      if (!n.data) n.data = {};
      n.data.clips = {
        '0': {
          kind: 'note', lengthSteps: 4, root: 48, loop: true,
          steps: [
            { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
            { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
            { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
            { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
          ],
        },
      };
    });
  });

  // Install the SIMULATED Launchpad pair + bind it to the clip-player. No Web
  // MIDI prompt; presses route through the real decode/dispatch path.
  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __launchpadTestInstall?: (id: string) => Promise<boolean> };
    if (!w.__launchpadTestInstall) return false;
    return await w.__launchpadTestInstall('a-cp');
  });
  expect(installed, 'simulated Launchpad install hook present (VITE_E2E_HOOKS)').toBe(true);

  // (1) Before the pad press the lane isn't playing → the VCA is closed → silent.
  await setTransport(page, 1); // transport runs, but nothing launched yet
  const before = await readScopePeakOverWindow(page, 'a-scp', 500);
  expect(before.rms, 'silent before the pad launches a clip').toBeLessThan(0.03);

  // (2) Press the LEFT-unit pad for (slot 0, lane 0) → launches clip 0 in lane 0.
  // The matrix maps lane 0 → the TOP physical row (y=7) so it matches the
  // on-screen card (lane 1 is the top grid row), so the top-left pad is (0, 7).
  await page.evaluate(() => {
    const w = globalThis as unknown as { __launchpadSim?: { pressL: (x: number, y: number) => void } };
    w.__launchpadSim?.pressL(0, 7);
  });

  // The synced playing set must show lane 0 launched (the binding wrote queued,
  // the engine applied it on the next tick) — proves pad → synced launch.
  await expect.poll(() => lane0Playing(page), { timeout: 5000 }).toBe(0);

  // (3) The launched clip runs out lane-0's pitch/gate → AUDIBLE structured RMS.
  const after = await readScopePeakOverWindow(page, 'a-scp', 1500);
  expect(after.polls, 'SCOPE was polled across the window').toBeGreaterThan(0);
  expect(after.rms, 'audible gated RMS after the pad launch').toBeGreaterThan(0.03);
  expect(after.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);
  expect(after.rms, 'the pad launch raised the output').toBeGreaterThan(before.rms + 0.02);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('@launchpad arming REC on the deck captures a launch to the arrangement; SONG flips clipMode', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // The SAME real chain (TIMELORDE-clocked clip → VCO → VCA → SCOPE) so the
  // arranger capture is proven on an audibly-running launch, not a dry write.
  await spawnPatch(
    page,
    [
      { id: 'b-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: 'b-vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'b-vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio',
        params: { base: 0, cvAmount: 1 } },
      { id: 'b-scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'f1', from: { nodeId: 'b-cp', portId: 'pitch1' }, to: { nodeId: 'b-vco', portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: 'f2', from: { nodeId: 'b-vco', portId: 'sine' }, to: { nodeId: 'b-vca', portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'f3', from: { nodeId: 'b-cp', portId: 'gate1' }, to: { nodeId: 'b-vca', portId: 'cv' },
        sourceType: 'gate', targetType: 'cv' },
      { id: 'f4', from: { nodeId: 'b-vca', portId: 'audio' }, to: { nodeId: 'b-scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['b-cp'];
      if (!n.data) n.data = {};
      n.data.clips = {
        '0': {
          kind: 'note', lengthSteps: 4, root: 48, loop: true,
          steps: [
            { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
            { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
          ],
        },
      };
    });
  });

  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __launchpadTestInstall?: (id: string) => Promise<boolean> };
    if (!w.__launchpadTestInstall) return false;
    return await w.__launchpadTestInstall('b-cp');
  });
  expect(installed, 'simulated Launchpad install hook present').toBe(true);

  await setTransport(page, 1); // transport runs (so song-time advances)

  // (1) Before arming there are no recorded events + we're in SESSION.
  const idle = await arrangeState(page);
  expect(idle.recording, 'starts disarmed').toBe(false);
  expect(idle.clipMode, 'starts in SESSION').toBe('session');
  expect(idle.events, 'no events yet').toBe(0);

  // (2) Arm REC on the DECK (CC 91 on the R unit) → node.data.recording flips.
  await page.evaluate((cc) => {
    const w = globalThis as unknown as { __launchpadSim?: { ccR: (cc: number, v: number) => void } };
    w.__launchpadSim?.ccR(cc, 127);
  }, CC_REC);
  await expect.poll(() => arrangeState(page).then((s) => s.recording), { timeout: 5000 }).toBe(true);

  // (3) Launch a clip from the matrix (top-left pad = lane 0, slot 0 = physical
  //     y=7 after the card-matching Y-flip). The engine applies it + (because
  //     REC is armed in SESSION) captures it into node.data.arrangement.
  await page.evaluate(() => {
    const w = globalThis as unknown as { __launchpadSim?: { pressL: (x: number, y: number) => void } };
    w.__launchpadSim?.pressL(0, 7);
  });
  await expect.poll(() => lane0Playing(page), { timeout: 5000 }).toBe(0);

  // (4) The launch produced sound (real chain) AND was captured to the arrangement.
  const after = await readScopePeakOverWindow(page, 'b-scp', 1500);
  expect(after.rms, 'audible after the armed launch').toBeGreaterThan(0.03);
  await expect
    .poll(() => arrangeState(page).then((s) => s.events), { timeout: 5000 })
    .toBeGreaterThan(0);

  // (5) SONG (CC 92) flips clipMode SESSION → ARRANGEMENT.
  await page.evaluate((cc) => {
    const w = globalThis as unknown as { __launchpadSim?: { ccR: (cc: number, v: number) => void } };
    w.__launchpadSim?.ccR(cc, 127);
  }, CC_SONG);
  await expect.poll(() => arrangeState(page).then((s) => s.clipMode), { timeout: 5000 }).toBe('arrangement');

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
