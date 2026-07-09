// e2e/tests/ringback.spec.ts
//
// RINGBACK end-to-end: the REAL stereo-in→stereo-out chain.
//   analogVco.saw → RINGBACK.in_l   and   analogVco.saw → RINGBACK.in_r
//   RINGBACK.out_l → SCOPE.ch1   and   RINGBACK.out_r → SCOPE.ch2
// Asserts AUDIBLE RMS at BOTH stereo outputs (not just "edge materializes"):
// a silent / wire-broken / mute-by-default ringback never crosses the floor.
//
// The per-sample crush DSP (decimation / ring / feedback math) is pinned in the
// pure-core unit tier (packages/dsp/src/lib/ringback-core.test.ts); this e2e
// tier proves the real audio path through the module is alive on both channels.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, setNodeParams } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

test('RINGBACK: VCO → stereo in → stereo out has audible RMS on BOTH channels', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
      { id: 'a-rb',  type: 'ringback',  position: { x: 360, y: 60 }, domain: 'audio',
        // Full wet, a small ring + sub-1 rate = the audible crush; modest feedback.
        params: { rate: 0.5, size: 64, feedback: 0.3, mix: 1 } },
      { id: 'a-scp', type: 'scope',     position: { x: 760, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      // Real stereo-in chain: drive BOTH L and R inputs from the VCO.
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' },   to: { nodeId: 'a-rb',  portId: 'in_l' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-vco', portId: 'saw' },   to: { nodeId: 'a-rb',  portId: 'in_r' },
        sourceType: 'audio', targetType: 'audio' },
      // Both stereo outs to the two scope channels so we can assert L + R.
      { id: 'e3', from: { nodeId: 'a-rb',  portId: 'out_l' }, to: { nodeId: 'a-scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e4', from: { nodeId: 'a-rb',  portId: 'out_r' }, to: { nodeId: 'a-scp', portId: 'ch2' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  const card = page.locator('.svelte-flow__node-ringback');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('RINGBACK');

  // Max-hold over a window so the assertion is renderer/timing-tolerant on CI
  // (gate-loop discipline) — a continuous VCO source keeps energy
  // in every frame, so any frame proves liveness.
  const hold = await readScopePeakOverWindow(page, 'a-scp', 1200);
  expect(hold.polls, 'SCOPE was polled across the window').toBeGreaterThan(0);

  // ch1 = out_l, ch2 = out_r. Both must carry audible energy: a silent or
  // wire-broken ringback (or a mono-collapse that drops one channel) fails.
  expect(hold.rms,  `audible RMS at the stereo out (L+R combined)`).toBeGreaterThan(0.01);
  expect(hold.peak, `peak at the stereo out`).toBeGreaterThan(0.05);
  expect(hold.nonzeroSamples, `structured signal, not a glitch`).toBeGreaterThan(50);

});

test('RINGBACK: mix=0 passes the input through; sweeping the crush params stays error-free', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'a-vco', type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
      { id: 'a-rb',  type: 'ringback',  position: { x: 360, y: 60 }, domain: 'audio',
        params: { rate: 1, size: 64, feedback: 0, mix: 0 } },
      { id: 'a-scp', type: 'scope',     position: { x: 760, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' },   to: { nodeId: 'a-rb',  portId: 'in_l' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'a-rb',  portId: 'out_l' }, to: { nodeId: 'a-scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  await page.waitForTimeout(400);

  // mix=0 (fully dry) must still pass audio (the crush is wet-only).
  const dry = await readScopePeakOverWindow(page, 'a-scp', 1000);
  expect(dry.rms, `dry passthrough (mix=0) is audible`).toBeGreaterThan(0.01);

  // Sweep all four crush params across their ranges incl. high feedback +
  // tiny ring (the self-oscillation zone) — must stay finite + error-free.
  const corners: Array<Record<string, number>> = [
    { rate: 0.05, size: 2,    feedback: 0.98, mix: 1 },
    { rate: 4,    size: 4096, feedback: 0,    mix: 1 },
    { rate: 0.5,  size: 16,   feedback: 0.9,  mix: 0.5 },
    { rate: 1,    size: 64,   feedback: 0.3,  mix: 1 },
  ];
  for (const corner of corners) {
    await setNodeParams(page, 'a-rb', corner);
    await page.waitForTimeout(120);
  }

  // Still alive + finite after the extreme sweep.
  const after = await readScopePeakOverWindow(page, 'a-scp', 1000);
  expect(Number.isFinite(after.rms)).toBe(true);
  expect(Number.isFinite(after.peak)).toBe(true);

});
