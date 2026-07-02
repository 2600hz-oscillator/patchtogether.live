// e2e/tests/hydrogen-cv-per-voice.spec.ts
//
// Per-voice CV E2E smoke. HYDROGEN exposes 9 CV inputs (vol/pan/pi/cf/q/
// a/d/s/r) per voice for each of its 16 voices = 144 ports. Exhaustively
// E2E'ing all 144 would be brittle; instead we spot-check three
// (voice-0 vol, voice-3 pitch, voice-15 release) across the three
// cvScale modes (linear + linear + log) so we cover the routing fan-out
// + the cvScale chain that actually runs.
//
// Strategy: patch LFO → cv_<param>_<voice>, then read the per-port
// modulator tap via engine.readModulatorTap(). The tap captures the
// SCALED CV signal that the engine sums into the AudioParam — so a
// non-zero observed span proves the engine successfully (a) resolved
// the port's paramTarget, (b) ran the cvScale chain, and (c) connected
// the result to hydrogen's per-voice ConstantSource.offset. The
// hydrogen tick reads back from the same constant source so this also
// implies the audio path is being modulated; we don't capture audio
// directly because Web Audio decoded buffers don't decode in CI's
// headless test env (FLAC samples).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function readTap(page: Page, nodeId: string, portId: string): Promise<number> {
  return await page.evaluate(
    ({ nid, pid }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          readModulatorTap?: (nodeId: string, portId: string, domain?: string) => number;
        } | null;
      };
      const eng = w.__engine?.();
      if (!eng || !eng.readModulatorTap) return 0;
      return eng.readModulatorTap(nid, pid, 'audio');
    },
    { nid: nodeId, pid: portId },
  );
}

/** Sample the per-port modulator tap N times and return min/max/span.
 *  The tap value is a sample-and-hold of the most-recent CV sample at
 *  the AudioParam summation point. With a 4Hz LFO into a -1..+1 cv-input
 *  the tap sees the SCALED CV (cv-range-standard.md) so the observed
 *  span should be much larger than the natural -1..+1 CV span for
 *  non-trivial param ranges. */
async function sampleTap(page: Page, nodeId: string, portId: string, samples: number, intervalMs: number) {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    out.push(await readTap(page, nodeId, portId));
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

test.describe('HYDROGEN per-voice CV inputs route LFO → param', () => {
  test('LFO → cv_vol_0 modulates voice-0 volume (linear cvScale)', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'lfo', type: 'lfo',      position: { x: 100, y: 100 }, params: { rate: 4.0, shape: 0 } },
        { id: 'h',   type: 'hydrogen', position: { x: 500, y: 100 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'h', portId: 'cv_vol_0' }, sourceType: 'cv', targetType: 'cv' },
      ],
    );
    await page.waitForTimeout(400);

    // vol param min=0 max=2 → linear cvScale maps -1..+1 to full range.
    // 32 × 60ms ≈ 1.92s window at 4Hz LFO = ~7.7 cycles, plenty for the
    // tap to land near both peaks. Expect span ≥ 1.0 (50% of natural).
    const sweep = await sampleTap(page, 'h', 'cv_vol_0', 32, 60);
    expect(sweep.span, `expected vol CV to span at least 1.0 of [0,2] (got ${sweep.span.toFixed(3)} from ${sweep.samples.length} samples)`).toBeGreaterThan(1.0);
  });

  test('LFO → cv_pi_3 modulates voice-3 pitch (linear cvScale, ±24st range)', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'lfo', type: 'lfo',      position: { x: 100, y: 100 }, params: { rate: 4.0, shape: 0 } },
        { id: 'h',   type: 'hydrogen', position: { x: 500, y: 100 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'h', portId: 'cv_pi_3' }, sourceType: 'cv', targetType: 'cv' },
      ],
    );
    await page.waitForTimeout(400);

    // pitch param min=-24 max=24 → linear cvScale maps -1..+1 to ±24 st.
    // Expect span ≥ 20 (well over the natural ±1 of an un-scaled cv).
    const sweep = await sampleTap(page, 'h', 'cv_pi_3', 32, 60);
    expect(sweep.span, `expected pitch CV to span ≥ 20 st (got ${sweep.span.toFixed(3)})`).toBeGreaterThan(20);
  });

  test('LFO → cv_r_15 modulates voice-15 release (log cvScale)', async ({ page }) => {
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'lfo', type: 'lfo',      position: { x: 100, y: 100 }, params: { rate: 4.0, shape: 0 } },
        { id: 'h',   type: 'hydrogen', position: { x: 500, y: 100 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'h', portId: 'cv_r_15' }, sourceType: 'cv', targetType: 'cv' },
      ],
    );
    await page.waitForTimeout(400);

    // release param min=0.01 max=5, log curve. Log cvScale spans the
    // full range geometrically — span should easily exceed 1.0s of
    // observed modulation despite the log compression of small values.
    const sweep = await sampleTap(page, 'h', 'cv_r_15', 32, 60);
    expect(sweep.span, `expected release CV to span ≥ 1.0s (got ${sweep.span.toFixed(3)})`).toBeGreaterThan(1.0);
  });
});
