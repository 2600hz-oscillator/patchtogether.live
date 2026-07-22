// e2e/tests/push2-clip-launch.spec.ts
//
// PUSH 2 real-source-chain proof (the poly/MIDI discipline, CLAUDE.md): a pad
// press on a (simulated) Ableton Push 2 must LAUNCH a clip on the bound
// clip-player and drive a downstream VOICE to AUDIBLE output through the REAL
// TIMELORDE-locked clock — not just "a pad maps to a clip". The Push drives the
// SAME clip brain the Launchpad does, by injecting itself as the control surface
// (no forked parity logic), so this exercises the Push device + map + control
// adapter + the shipped launchpad-control end to end:
//
//   [sim Push pad (grid top-left = lane 0)] → clipplayer.queued[0]
//   clipplayer.pitch1 → VCO.pitch ; VCO.sine → VCA.audio ;
//   clipplayer.gate1  → VCA.cv    ; VCA.audio → SCOPE.ch1
//
// Plus the additive Phase-1 features on the same rack: the Play button toggles
// the transport, an above-display button selects a channel, a display encoder
// nudges a MixMasters volume, and the D-Pad scrolls the CLIP-view window.
//
// CI has no Push + no Web MIDI — everything routes through installSimulatedPush2,
// so this is capability-independent (no getUserMedia / WebUSB / hardware encoder).

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
      for (const n of tls) {
        if (!n.params) n.params = {};
        n.params.running = run;
        n.params.bpm = 200;
      }
    });
  }, running);
}

async function timelordeRunning(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> } };
    const tl = Object.values(w.__patch.nodes).find((n) => n.type === 'timelorde');
    return tl?.params?.running ?? null;
  });
}

async function mixParam(page: import('@playwright/test').Page, paramId: string) {
  return page.evaluate((pid) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> } };
    const mx = Object.values(w.__patch.nodes).find((n) => n.type === 'mixmstrs');
    return mx?.params?.[pid] ?? null;
  }, paramId);
}

async function pushState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __push2Sim?: { state: () => Record<string, unknown> } };
    return w.__push2Sim?.state() ?? null;
  });
}

// Push 2 CC map (owner-confirmed on hardware).
const CC_PLAY = 85;
// CLIP (note-editor) view: the permanent-controls row button 2 (CC 22) → the
// Launchpad top-row CLIP CC (93). The dedicated "Note" button was a wrong guess.
const CC_CLIP_VIEW = 22;
const CC_SHIFT = 49;
const CC_DPAD_UP = 46;
const CC_ABOVE_DISPLAY_BASE = 102; // channel-select 1..8
const CC_ENCODER_BASE = 71; // display encoders → ch volume

test('@push2 a simulated pad press launches a clip → audible RMS at the clipplayer voice', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'p-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: 'p-vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'p-vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio', params: { base: 0, cvAmount: 1 } },
      { id: 'p-scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio', params: { timeMs: 200 } },
      { id: 'p-tl', type: 'timelorde', position: { x: 60, y: 320 }, domain: 'audio', params: { running: 0, bpm: 200 } },
    ],
    [
      { id: 'pe1', from: { nodeId: 'p-cp', portId: 'pitch1' }, to: { nodeId: 'p-vco', portId: 'pitch' }, sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: 'pe2', from: { nodeId: 'p-vco', portId: 'sine' }, to: { nodeId: 'p-vca', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'pe3', from: { nodeId: 'p-cp', portId: 'gate1' }, to: { nodeId: 'p-vca', portId: 'cv' }, sourceType: 'gate', targetType: 'cv' },
      { id: 'pe4', from: { nodeId: 'p-vca', portId: 'audio' }, to: { nodeId: 'p-scp', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);

  // Seed a clip in lane 0 / slot 0 (drives pitch1/gate1). Launched via the PUSH.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['p-cp'];
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

  // Install the SIMULATED Push + inject it as the control surface + bind. No Web
  // MIDI prompt; presses route through the real decode/classify/dispatch path.
  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __push2TestInstall?: (id: string) => Promise<boolean> };
    if (!w.__push2TestInstall) return false;
    return await w.__push2TestInstall('p-cp');
  });
  expect(installed, 'simulated Push 2 install hook present (VITE_E2E_HOOKS)').toBe(true);

  // (1) Before the pad press the lane isn't playing → the VCA is closed → silent.
  await setTransport(page, 1);
  const before = await readScopePeakOverWindow(page, 'p-scp', 500);
  expect(before.rms, 'silent before the pad launches a clip').toBeLessThan(0.03);

  // (2) Press the grid top-left pad (x0, y7) → grid view maps it to lane 0.
  await page.evaluate(() => {
    const w = globalThis as unknown as { __push2Sim?: { press: (x: number, y: number) => void } };
    w.__push2Sim?.press(0, 7);
  });

  // The synced playing set must show lane 0 launched (pad → synced launch).
  await expect
    .poll(() => page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { type?: string; data?: { playing?: unknown[] } }> } };
      const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
      return cp?.data?.playing?.[0] ?? null;
    }), { timeout: 5000 })
    .toBe(0);

  // (3) The launched clip runs out lane-0's pitch/gate → AUDIBLE structured RMS.
  const after = await readScopePeakOverWindow(page, 'p-scp', 1500);
  expect(after.polls, 'SCOPE was polled across the window').toBeGreaterThan(0);
  expect(after.rms, 'audible gated RMS after the pad launch').toBeGreaterThan(0.03);
  expect(after.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);
  expect(after.rms, 'the pad launch raised the output').toBeGreaterThan(before.rms + 0.02);
});

test('@push2 Play toggles transport; a channel-select + encoder drives MixMasters; D-Pad scrolls the clip window', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'q-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio', params: { quantize: 0, stepDiv: 2 } },
      { id: 'q-mx', type: 'mixmstrs', position: { x: 360, y: 60 }, domain: 'audio', params: { ch1_volume: 0.8 } },
      { id: 'q-tl', type: 'timelorde', position: { x: 60, y: 320 }, domain: 'audio', params: { running: 0, bpm: 120 } },
    ],
    [],
  );
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);

  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __push2TestInstall?: (id: string) => Promise<boolean> };
    if (!w.__push2TestInstall) return false;
    return await w.__push2TestInstall('q-cp');
  });
  expect(installed, 'simulated Push 2 install hook present').toBe(true);

  const cc = (n: number, v: number) =>
    page.evaluate(([num, val]) => {
      const w = globalThis as unknown as { __push2Sim?: { cc: (c: number, v: number) => void } };
      w.__push2Sim?.cc(num as number, val as number);
    }, [n, v] as const);

  // (A) Play button (CC 85) → START/STOP the transport (moved off the grid).
  expect(await timelordeRunning(page)).toBe(0);
  await cc(CC_PLAY, 127); await cc(CC_PLAY, 0);
  await expect.poll(() => timelordeRunning(page), { timeout: 3000 }).toBe(1);
  await cc(CC_PLAY, 127); await cc(CC_PLAY, 0);
  await expect.poll(() => timelordeRunning(page), { timeout: 3000 }).toBe(0);

  // (B) Above-display button 3 (CC 104) → select channel index 2 (Push-local).
  await cc(CC_ABOVE_DISPLAY_BASE + 2, 127);
  await expect.poll(async () => (await pushState(page))?.selectedChannel, { timeout: 3000 }).toBe(2);

  // (C) Display encoder 1 (CC 71) +5 detents → ch1_volume = 0.8 + 5*0.01 = 0.85.
  await cc(CC_ENCODER_BASE, 5);
  await expect.poll(() => mixParam(page, 'ch1_volume'), { timeout: 3000 }).toBeGreaterThan(0.83);
  expect(await mixParam(page, 'ch1_volume')).toBeLessThan(0.87);

  // (D) D-Pad → CLIP-view nav. Switch to CLIP view (permanent-row button 2,
  // CC 22 → top CC 93), read the pitch-window offset, press D-Pad ↑ → +1; hold
  // SHIFT (CC 49) + ↑ → +8.
  await cc(CC_CLIP_VIEW, 127); await cc(CC_CLIP_VIEW, 0);
  await expect.poll(async () => (await pushState(page))?.singleView, { timeout: 3000 }).toBe('clip');
  const base = Number((await pushState(page))?.editRowOffset ?? 0);
  await cc(CC_DPAD_UP, 127); await cc(CC_DPAD_UP, 0);
  await expect.poll(async () => (await pushState(page))?.editRowOffset, { timeout: 3000 }).toBe(base + 1);
  await cc(CC_SHIFT, 127); // hold shift
  await cc(CC_DPAD_UP, 127); await cc(CC_DPAD_UP, 0);
  await cc(CC_SHIFT, 0); // release shift
  await expect.poll(async () => (await pushState(page))?.editRowOffset, { timeout: 3000 }).toBe(base + 1 + 8);
});
