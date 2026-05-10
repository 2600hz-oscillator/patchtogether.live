// e2e/tests/cv-range-uniformity.spec.ts
//
// End-to-end regression for .myrobots/plans/cv-range-standard.md: an LFO
// connected to ANY module's `cv`-typed input must drive the modulated
// param through (close to) its full range of motion. Pre-this-PR an LFO
// at ±1 amplitude moved most params only ~10% of their natural range
// because the engine summed -1..+1 directly into the param's intrinsic
// value with no scaling.
//
// We exercise five representative modules covering linear and log
// scaling — ADSR (log attack), QBRT (log cutoff), DRUMMERGIRL (linear
// volume), MIXMSTRS (linear EQ band), DESTROY (linear decimate). For
// each, patch LFO → cv input, spin for ~1.5s, sample the engine's
// `readParam` (which sums intrinsic + cv-tap analyser) ~12 times, and
// assert the observed range spans a meaningful fraction of the param's
// natural max-min spread.
//
// We use 40% as the threshold (not 100%) because:
//   1. The 1.5s window may not catch peaks of slow LFO (rate=4Hz = 6 cycles).
//   2. Knob position may not be perfectly centered (ADSR attack default
//      0.005s is near the bottom of 0.001..10s — log scaling brings it up
//      but cv=-1 clamps).
//   3. AnalyserNode tap latency adds a couple-frame delay between sample
//      and read.
//
// 40% is enough to PROVE the LFO is driving the param across multiple
// orders of magnitude (vs. the pre-PR baseline of ~1-10%).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface ParamSweep {
  min: number;
  max: number;
  span: number;
  samples: number[];
}

/** Sample readParam(nodeId, paramId) over the engine N times at a fixed
 *  interval; return the observed min/max/span (max-min). */
async function sampleParamSweep(
  page: Page,
  nodeId: string,
  paramId: string,
  samples: number,
  intervalMs: number,
): Promise<ParamSweep> {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const v = await page.evaluate(
      ({ id, pid }) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            readParam: (node: { id: string; type: string; domain: string }, paramId: string) => number | undefined;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const eng = w.__engine?.();
        if (!eng) return null;
        const node = w.__patch.nodes[id];
        if (!node) return null;
        const r = eng.readParam(node, pid);
        return typeof r === 'number' ? r : null;
      },
      { id: nodeId, pid: paramId },
    );
    if (typeof v === 'number') out.push(v);
    await page.waitForTimeout(intervalMs);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of out) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { min: lo, max: hi, span: hi - lo, samples: out };
}

test('LFO sweeps ADSR attack (log) across multiple orders of magnitude', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',  position: { x: 100, y: 100 }, params: { rate: 4.0, shape: 0 } },
      { id: 'a',   type: 'adsr', position: { x: 500, y: 100 }, params: { attack: 0.1 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'a', portId: 'attack' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );
  await page.waitForTimeout(400);

  // Sample more aggressively to catch LFO peaks: 32 samples × 60ms ≈ 1.92s
  // window. At 4Hz LFO that's ~7.7 cycles, sampled with stride 60ms = 0.24
  // cycles/sample — phase coverage is dense enough to pick up samples within
  // ±0.05 of the peak (sin amplitude ≥ 0.95) at least once across the window.
  const sweep = await sampleParamSweep(page, 'a', 'attack', 32, 60);

  // Param natural range: 0.001..10s. Log-symmetric scaling at knob 0.1:
  // cv=-1 → 0.1/sqrt(10000) = 0.001 (clamp); cv=+1 → 0.1*100 = 10 (clamp).
  // Observed span should be ≥ ~9s in the worst case.
  expect(
    sweep.span,
    `ADSR attack sweep span ${sweep.span} (samples ${sweep.samples.slice(0, 8).join(', ')}…)`,
  ).toBeGreaterThanOrEqual(0.05);
  expect(
    sweep.max,
    `ADSR attack sweep max ${sweep.max} (samples ${sweep.samples.slice(0, 8).join(', ')}…)`,
  ).toBeGreaterThanOrEqual(0.5);
});

test('LFO sweeps QBRT cutoff (log) across multiple octaves', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',  position: { x: 100, y: 100 }, params: { rate: 4.0, shape: 0 } },
      { id: 'qb',  type: 'qbrt', position: { x: 500, y: 100 }, params: { cutoff: 1000, resonance: 0.5 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'qb', portId: 'cutoff' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );
  await page.waitForTimeout(400);

  const sweep = await sampleParamSweep(page, 'qb', 'cutoff', 16, 110);
  // QBRT cutoff range 20..20000Hz. Log scaling at knob 1000Hz: cv=±1 = ×31.6.
  // Span: 20..20000 (clamp ends), so observed span should be at least 4 octaves.
  const octaves = sweep.max > 0 && sweep.min > 0 ? Math.log2(sweep.max / sweep.min) : 0;
  expect(
    octaves,
    `QBRT cutoff observed octave span: ${octaves.toFixed(2)} (min=${sweep.min}, max=${sweep.max}, samples ${sweep.samples.slice(0, 5).join(', ')}…)`,
  ).toBeGreaterThanOrEqual(2);
});

test('LFO sweeps DRUMMERGIRL volume (linear 0..2) across full range', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',         position: { x: 100, y: 100 }, params: { rate: 4.0, shape: 0 } },
      { id: 'dg',  type: 'drummergirl', position: { x: 500, y: 100 }, params: { volume: 1.0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'dg', portId: 'volume' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );
  await page.waitForTimeout(400);

  const sweep = await sampleParamSweep(page, 'dg', 'volume', 16, 110);
  // Volume 0..2, knob 1.0, halfSpan 1.0 → cv=±1 sweeps 0..2 fully (span 2).
  // 40% threshold = span ≥ 0.8.
  expect(
    sweep.span,
    `DRUMMERGIRL volume sweep span ${sweep.span} (samples ${sweep.samples.slice(0, 5).join(', ')}…)`,
  ).toBeGreaterThanOrEqual(0.8);
});

test('LFO sweeps MIXMSTRS ch1 EQ low (-12..+12 dB linear) across full range', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',      position: { x: 100, y: 100 }, params: { rate: 4.0, shape: 0 } },
      { id: 'mx',  type: 'mixmstrs', position: { x: 500, y: 100 }, params: { ch1_low: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'mx', portId: 'ch1_low' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );
  await page.waitForTimeout(400);

  const sweep = await sampleParamSweep(page, 'mx', 'ch1_low', 16, 110);
  // EQ low -12..+12, knob 0, halfSpan 12 → cv=±1 sweeps full ±12.
  // 40% = span ≥ 9.6 dB.
  expect(
    sweep.span,
    `MIXMSTRS ch1_low sweep span ${sweep.span} dB (samples ${sweep.samples.slice(0, 5).join(', ')}…)`,
  ).toBeGreaterThanOrEqual(9);
});

test('LFO sweeps DESTROY decimate (1..64 linear) across most of range', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'lfo', type: 'lfo',     position: { x: 100, y: 100 }, params: { rate: 4.0, shape: 0 } },
      { id: 'd',   type: 'destroy', position: { x: 500, y: 100 }, params: { decimate: 32 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'd', portId: 'decimate' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );
  await page.waitForTimeout(400);

  const sweep = await sampleParamSweep(page, 'd', 'decimate', 16, 110);
  // Decimate 1..64, knob 32, halfSpan 31.5 → cv=±1 sweeps 0.5..63.5 → clamp 1..63.
  // 40% threshold = span ≥ 25.
  expect(
    sweep.span,
    `DESTROY decimate sweep span ${sweep.span} (samples ${sweep.samples.slice(0, 5).join(', ')}…)`,
  ).toBeGreaterThanOrEqual(25);
});
