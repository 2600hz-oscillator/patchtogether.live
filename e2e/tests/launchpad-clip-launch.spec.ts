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

import { test, expect } from './_fixtures';
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

test('@launchpad a simulated pad press launches a clip → audible RMS at the clipplayer voice', async ({ page, rack, errorWatch }) => {
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

});

test('@launchpad arming REC on the deck captures a launch to the arrangement; SONG flips clipMode', async ({ page, rack, errorWatch }) => {
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

});

// ===========================================================================
// SINGLE-UNIT mode — ONE Launchpad does everything the two-device pair does over
// a 4-VIEW surface (Grid · Clip · Arranger · Control) driven by the PERMANENT
// top-CC nav row, identical in every view: 91 transport · 92 Grid · 93 Clip ·
// 94 Arranger · 95 Control · 96 undo · 97 redo · 98 shift (topRowAction). The
// GRID is TRANSPOSED vs the pair L matrix: x = channel/lane (column), the slot
// runs top→bottom, so gridPadToClipIndex(x,y) = {lane:x, slot:LP_HEIGHT-1-y}.
//
// These prove, behaviour-first, that on the ONE device: selecting GRID on the
// permanent top row + tapping a clip LAUNCHES it (audible RMS through the SAME
// real TIMELORDE→clipplayer→VCO→VCA→SCOPE chain), the transpose lands the tap on
// the right CHANNEL (column), a row/scene launch fires a slot across channels,
// and a stop→relaunch round-trip returns the RMS (the green-but-silent guard).
// ===========================================================================

// Permanent top-row CCs (topRowAction in launchpad-map.ts) — a CC on the lone
// device routes through the SAME decode/dispatch path real hardware uses.
const CC_VIEW_GRID = 92;
// Right SCENE column CCs (top→bottom = scene index 0..7). Scene index i launches
// grid SLOT i across all channels (a "song section"). SCENE_CCS[1] = slot 1.
const SCENE_CCS = [89, 79, 69, 59, 49, 39, 29, 19] as const;

/** lane-N entry of the clipplayer's synced `playing` set. */
async function lanePlayingSlot(page: import('@playwright/test').Page, lane: number) {
  return page.evaluate((l) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { playing?: unknown[] } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.playing?.[l] ?? null;
  }, lane);
}
/** Press a pad on the lone (single-mode) device. */
async function pressSingle(page: import('@playwright/test').Page, x: number, y: number) {
  await page.evaluate(({ x, y }) => {
    (globalThis as unknown as { __launchpadSingleSim?: { press: (x: number, y: number) => void } })
      .__launchpadSingleSim?.press(x, y);
  }, { x, y });
}
/** Select a view (or press any permanent top-row CC) on the lone device. */
async function ccTapSingle(page: import('@playwright/test').Page, cc: number) {
  await page.evaluate((c) => {
    const s = (globalThis as unknown as { __launchpadSingleSim?: { cc: (cc: number, v: number) => void } })
      .__launchpadSingleSim!;
    s.cc(c, 127);
    s.cc(c, 0);
  }, cc);
}
async function singleView(page: import('@playwright/test').Page) {
  return page.evaluate(
    () => (globalThis as unknown as { __launchpadSingleSim?: { state: () => { singleView: string } } })
      .__launchpadSingleSim!.state().singleView,
  );
}
/** The single-mode Grid scene-scroll offset (0 = scenes 0..7 at the top). */
async function sceneOffset(page: import('@playwright/test').Page) {
  return page.evaluate(
    () => (globalThis as unknown as { __launchpadSingleSim?: { state: () => { sceneScrollOffset: number } } })
      .__launchpadSingleSim!.state().sceneScrollOffset,
  );
}
/** The clipplayer's synced per-lane `queued` array (null when nothing queued). */
async function cpQueued(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { queued?: (number | 'stop' | null)[] } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.queued ?? null;
  });
}

async function buildSingleChain(page: import('@playwright/test').Page, prefix: string) {
  await spawnPatch(
    page,
    [
      { id: `${prefix}-cp`, type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: `${prefix}-vco`, type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: `${prefix}-vca`, type: 'vca', position: { x: 640, y: 60 }, domain: 'audio',
        params: { base: 0, cvAmount: 1 } },
      { id: `${prefix}-scp`, type: 'scope', position: { x: 920, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: `${prefix}1`, from: { nodeId: `${prefix}-cp`, portId: 'pitch1' }, to: { nodeId: `${prefix}-vco`, portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: `${prefix}2`, from: { nodeId: `${prefix}-vco`, portId: 'sine' }, to: { nodeId: `${prefix}-vca`, portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: `${prefix}3`, from: { nodeId: `${prefix}-cp`, portId: 'gate1' }, to: { nodeId: `${prefix}-vca`, portId: 'cv' },
        sourceType: 'gate', targetType: 'cv' },
      { id: `${prefix}4`, from: { nodeId: `${prefix}-vca`, portId: 'audio' }, to: { nodeId: `${prefix}-scp`, portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);
}

/** Seed note clips at the given flat indices (clipIndex = lane*64 + slot,
 *  stride-64 schema v2). Only lane-0 clips drive the audible voice (pitch1/gate1
 *  = lane 0's poly output). */
async function seedClipsAt(page: import('@playwright/test').Page, nodeId: string, indices: number[]) {
  await page.evaluate(({ id, idxs }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n.data) n.data = {};
      const clips: Record<string, unknown> = {};
      for (const i of idxs) {
        clips[String(i)] = {
          kind: 'note', lengthSteps: 4, root: 48, loop: true, scale: 'major',
          steps: [
            { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
            { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
            { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
            { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
          ],
        };
      }
      n.data.clips = clips;
      (n.data as { sv?: number }).sv = 2; // already stride-64 → skip legacy re-key
    });
  }, { id: nodeId, idxs: indices });
}

async function installSingle(page: import('@playwright/test').Page, nodeId: string) {
  const installed = await page.evaluate(async (id) => {
    const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
    if (!w.__launchpadTestInstallSingle) return false;
    return await w.__launchpadTestInstallSingle(id);
  }, nodeId);
  expect(installed, 'single-unit Launchpad install hook present (VITE_E2E_HOOKS)').toBe(true);
}

test('@launchpad single-unit GRID view: transposed pad launch → audible RMS; transpose + round-trip relaunch', async ({ page, rack, errorWatch }) => {
  await buildSingleChain(page, 's');
  // lane 0 slot 0 (index 0 — drives the voice) + lane 1 slot 0 (index 64,
  // stride-64 — a DIFFERENT channel, column 1) so the transpose is observable.
  await seedClipsAt(page, 's-cp', [0, 64]);
  await installSingle(page, 's-cp');

  // The lone device binds into the CLIP (note-editor) view; select GRID on the
  // permanent top row (CC 92) to reach the transposed clip matrix.
  await ccTapSingle(page, CC_VIEW_GRID);
  await expect.poll(() => singleView(page), { timeout: 5000 }).toBe('grid');

  // (1) Silent before the launch (transport runs but nothing launched yet).
  await setTransport(page, 1);
  const before = await readScopePeakOverWindow(page, 's-scp', 500);
  expect(before.rms, 'silent before the single-unit pad launches a clip').toBeLessThan(0.03);

  // (2) Transposed grid: (x=lane 0, y=7) = channel 0, slot 0 → launch. Drives the
  //     voice (pitch1/gate1 = lane 0) → structured audible RMS.
  await pressSingle(page, 0, 7);
  await expect.poll(() => lanePlayingSlot(page, 0), { timeout: 5000 }).toBe(0);
  const after = await readScopePeakOverWindow(page, 's-scp', 1500);
  expect(after.rms, 'audible gated RMS after the single-unit grid launch').toBeGreaterThan(0.03);
  expect(after.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);
  expect(after.rms, 'the pad launch raised the output').toBeGreaterThan(before.rms + 0.02);

  // (3) TRANSPOSE proof: (x=1, y=7) is CHANNEL 1 (column 1), slot 0 — the flat
  //     index 8 — NOT lane 0 slot 1. Launching it lights lane 1's `playing` while
  //     lane 0 keeps running.
  await pressSingle(page, 1, 7);
  await expect.poll(() => lanePlayingSlot(page, 1), { timeout: 5000 }).toBe(0);
  expect(await lanePlayingSlot(page, 0), 'lane 0 still playing (independent channel)').toBe(0);

  // (4) Round-trip: (0,7) again → the running lane-0 clip queues a STOP → falls
  //     silent; relaunch → the RMS returns.
  await pressSingle(page, 0, 7);
  await expect.poll(() => lanePlayingSlot(page, 0), { timeout: 5000 }).toBeNull();
  await expect
    .poll(async () => (await readScopePeakOverWindow(page, 's-scp', 400)).rms, { timeout: 5000 })
    .toBeLessThan(0.03);
  await pressSingle(page, 0, 7);
  await expect.poll(() => lanePlayingSlot(page, 0), { timeout: 5000 }).toBe(0);
  const relaunched = await readScopePeakOverWindow(page, 's-scp', 1500);
  expect(relaunched.rms, 'RMS returns after the round-trip relaunch').toBeGreaterThan(0.03);
});

test('@launchpad single-unit GRID scene/ROW launch fires a slot across all channels → audible', async ({ page, rack, errorWatch }) => {
  await buildSingleChain(page, 'y');
  // A clip in lane 0 SLOT 1 (index 1) — drives the voice. The scene ROW for slot
  // 1 fans out across every channel; the lane-0 clip in that slot makes it audible.
  await seedClipsAt(page, 'y-cp', [1]);
  await installSingle(page, 'y-cp');

  await ccTapSingle(page, CC_VIEW_GRID);
  await expect.poll(() => singleView(page), { timeout: 5000 }).toBe('grid');

  await setTransport(page, 1);
  const before = await readScopePeakOverWindow(page, 'y-scp', 500);
  expect(before.rms, 'silent before the row launch').toBeLessThan(0.03);

  // Scene index 1 (SCENE_CCS[1] = 79) = grid SLOT 1 across ALL channels → lane 0
  // slot 1 launches (a "scene"), sounding the real chain.
  await ccTapSingle(page, SCENE_CCS[1]);
  await expect.poll(() => lanePlayingSlot(page, 0), { timeout: 5000 }).toBe(1);
  const after = await readScopePeakOverWindow(page, 'y-scp', 1500);
  expect(after.rms, 'audible after the scene/row launch').toBeGreaterThan(0.03);
  expect(after.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);
  expect(after.rms, 'the row launch raised the output').toBeGreaterThan(before.rms + 0.02);
});

// Grid-shift right column: CC 98 = SHIFT; the amber scene-window UP/DOWN buttons
// (repurposed from PASTE-REV / NOW) are scene indices 6 / 7 under shift.
const CC_SHIFT_TOP = 98;
const G_SCROLL_UP_CC = SCENE_CCS[6]; // 29
const G_SCROLL_DOWN_CC = SCENE_CCS[7]; // 19

test('@launchpad single-unit GRID scene-scroll: UP/DOWN slide the window; a shifted scene launches; an empty scene is dark', async ({ page, rack, errorWatch }) => {
  await buildSingleChain(page, 'z');
  // Clips in slots 0..7 of lane 0 (indices 0..7) → highestContentScene 7, so DOWN
  // can reveal ONE empty scene (scene 8). Slot 1 will be the shifted launch target.
  await seedClipsAt(page, 'z-cp', [0, 1, 2, 3, 4, 5, 6, 7]);
  await installSingle(page, 'z-cp');

  await ccTapSingle(page, CC_VIEW_GRID);
  await expect.poll(() => singleView(page), { timeout: 5000 }).toBe('grid');

  // (0) The window starts at the top.
  expect(await sceneOffset(page), 'starts at offset 0').toBe(0);

  // (1) Latch shift, then DOWN slides the window; a second DOWN clamps (lazy limit).
  await ccTapSingle(page, CC_SHIFT_TOP); // latch shift → scene column = grid-shift palette
  await ccTapSingle(page, G_SCROLL_DOWN_CC);
  await expect.poll(() => sceneOffset(page), { timeout: 5000 }).toBe(1);
  await ccTapSingle(page, G_SCROLL_DOWN_CC);
  expect(await sceneOffset(page), 'DOWN clamps at the lazy reveal limit').toBe(1);

  // (2) UP slides back and clamps at the top.
  await ccTapSingle(page, G_SCROLL_UP_CC);
  await expect.poll(() => sceneOffset(page), { timeout: 5000 }).toBe(0);
  await ccTapSingle(page, G_SCROLL_UP_CC);
  expect(await sceneOffset(page), 'UP clamps at offset 0').toBe(0);

  // (3) DOWN again → offset 1, then UNLATCH shift so the scene column launches.
  await ccTapSingle(page, G_SCROLL_DOWN_CC);
  await expect.poll(() => sceneOffset(page), { timeout: 5000 }).toBe(1);
  await ccTapSingle(page, CC_SHIFT_TOP); // unlatch shift

  // (4) The scrolled-in EMPTY scene (bottom button = scene 8) is a DARK no-op.
  await ccTapSingle(page, SCENE_CCS[7]);
  expect(await cpQueued(page), 'launching the empty scene queues nothing').toBeNull();

  // (5) The POSITION-RELATIVE top scene button now addresses the SHIFTED scene 1
  //     (slot 1) → fires slot 1 across the channels. Assert the DURABLE playing
  //     state, not `queued`: QNT is off (buildSingleChain sets quantize:0), so the
  //     clipplayer's ~25 ms scheduler tick applies the launch IMMEDIATELY — the
  //     `queued` entry is a sub-tick transient that flips to `playing` before a
  //     poll can observe it (the local-pass/CI-fail race). `playing[0]===1` is the
  //     stable truth every other launch assertion in this spec reads.
  await ccTapSingle(page, SCENE_CCS[0]);
  await expect.poll(() => lanePlayingSlot(page, 0), { timeout: 5000 }).toBe(1);
});
