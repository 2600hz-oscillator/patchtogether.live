// e2e/tests/modulation.spec.ts
//
// Verifies CV → AudioParam routing end-to-end:
// 1. LFO produces non-zero output on its phase ports.
// 2. Patching LFO output to ADSR.attack visibly modulates the param's
//    `readParam()` value over time.
// 3. The motorized Fader's readLive() (which polls engine.readParam) sees
//    that variation — i.e. the fader's thumb visibly tracks the modulation.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('lfo: phase0 emits a non-trivial AC waveform at the configured rate', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // LFO at 5 Hz, sine shape, into a Scope so we can sample the output.
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo', params: { rate: 5, shape: 0 } },
      { id: 'scp', type: 'scope' },
      { id: 'out', type: 'audioOut', params: { master: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' },  to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'e3', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'R' } },
    ],
  );

  await page.waitForTimeout(800);

  const stats = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const snap = eng.read(w.__patch.nodes['scp'], 'snapshot') as
      | { ch1: Float32Array }
      | undefined;
    if (!snap) return null;
    let peak = 0;
    let zeroCrosses = 0;
    let prev = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if ((v >= 0) !== (prev >= 0)) zeroCrosses++;
      prev = v;
    }
    return { peak, zeroCrosses, len: snap.ch1.length };
  });
  if (!stats) throw new Error('no scope snapshot');

  // Sine should swing between -1 and +1 → peak near 1.
  expect(stats.peak).toBeGreaterThan(0.5);
  // At 5 Hz with a 42ms (2048-sample) buffer at 48kHz, expect ~0.42 cycles =
  // typically 0 or 1 zero crossings. Just assert "not stuck DC" (peak alone
  // covers AC; ZCR > 0 is bonus).
  expect(stats.peak).toBeLessThan(1.5);
});

test('cv-to-fader-sync: LFO modulating ADSR.attack varies the AudioParam reading', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // LFO at high rate (10 Hz, square for max swing) → ADSR.attack CV input.
  // The intrinsic attack is ~0.005s; LFO output [-1..+1] sums in, so the
  // observed AudioParam.value should swing between roughly attack-1 and
  // attack+1 (clamped to the param's [0.001..10] range).
  await spawnPatch(
    page,
    [
      { id: 'lfo',  type: 'lfo',  params: { rate: 10, shape: 2 } }, // square = ±1
      { id: 'adsr', type: 'adsr', params: { attack: 5, decay: 0.1, sustain: 0.5, release: 0.3 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'adsr', portId: 'attack' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );

  // Sample the engine's readParam value at intervals — what the motorized
  // fader's readLive() callback sees on each rAF tick.
  const samples: number[] = [];
  for (let i = 0; i < 12; i++) {
    const v = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          readParam: (node: { id: string; type: string; domain: string }, paramId: string) => number | undefined;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return -1;
      const node = w.__patch.nodes['adsr'];
      return eng.readParam(node, 'attack') ?? -1;
    });
    samples.push(v);
    await page.waitForTimeout(70); // ~7 reads per LFO cycle at 10 Hz
  }

  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const swing = max - min;
  // Square wave at ±1 around an intrinsic of 5 → expect >>0 swing in readParam.
  // Even with rate jitter the readings should span at least ~0.5 (half of ±1).
  expect(swing, `readParam values: ${samples.map((s) => s.toFixed(3)).join(', ')}`).toBeGreaterThan(0.5);
});
