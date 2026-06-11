// e2e/tests/video-phase1.spec.ts
//
// Phase-1 video-domain: the cross-domain CV bridge.
//
// Phase 2 lean (webgl-suite-optimization §2/§7-4): the old test 1
// (LINES + INWARDS → V-MIXER → DESTRUCTOR → OUTPUT renders non-flat) was DROPPED
// — "a multi-module video graph composes through the engine and paints non-flat
// content" is owned by video-chain (incl. its @webgl-smoke floor case) and
// video-controls. What remains is the UNIQUE cross-domain proof a chain test
// can't give: an AUDIO LFO modulating a VIDEO param (DESTRUCTOR.mangle) actually
// MOVES the rendered pixels over an LFO cycle (the audio-CV→video-param bridge).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('video Phase-1: cross-domain CV bridge', () => {
  // Verifies the audio CV → video param bridge wires through correctly.
  // Spawns an LFO (audio) modulating DESTRUCTOR.mangle (video) on a
  // patch that renders LINES → DESTRUCTOR → OUTPUT. Without the bridge,
  // mangle stays at its default and the output is steady; WITH the
  // bridge sweeping mangle from -1..1, two snapshots taken across an
  // LFO cycle look different.
  test('LFO -> DESTRUCTOR.mangle changes pixel pattern over time', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // LFO at ~2Hz so a full cycle fits in ~500ms — easy to capture two
    // distinct phases inside a Playwright timeout budget.
    await spawnPatch(
      page,
      [
        { id: 'a-lfo',   type: 'lfo',        position: { x: 40,  y: 300 }, domain: 'audio', params: { rate: 2 } },
        { id: 'v-lines', type: 'lines',      position: { x: 40,  y: 40 },  domain: 'video' },
        { id: 'v-destr', type: 'destructor', position: { x: 360, y: 40 },  domain: 'video', params: { shift: 0.9, scanline: 0.5, posterize: 0.3, mangle: 0 } },
        { id: 'v-out',   type: 'videoOut',   position: { x: 700, y: 40 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-destr', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-destr', portId: 'in' },     sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-destr-out',   from: { nodeId: 'v-destr', portId: 'out' }, to: { nodeId: 'v-out',   portId: 'in' },     sourceType: 'video',      targetType: 'video' },
        // The cross-domain bridge: LFO's CV out -> DESTRUCTOR mangle CV in.
        { id: 'e-lfo-mangle',  from: { nodeId: 'a-lfo',   portId: 'out' }, to: { nodeId: 'v-destr', portId: 'mangle' }, sourceType: 'cv',         targetType: 'cv' },
      ],
    );

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);

    // The naive "two samples 500ms apart on a 2Hz LFO" approach aliases:
    // both samples land at the same LFO phase (sin zero crossings at
    // t=0.25s and t=0.75s), so DESTRUCTOR's mangle reads the same value
    // both times and the global mean/variance are nearly identical
    // (LINES is a periodic pattern, so its phase scroll barely shifts
    // the GLOBAL stats — only DESTRUCTOR's mangle-driven mode change
    // does). Plus, on a cold engine, the very first read can land
    // before any frames have rendered (both samples = empty canvas =
    // 0,0 deltas).
    //
    // Fix: warm-up wait that confirms the engine has actually rendered
    // (variance > 50 — same threshold the multi-module test uses), then
    // take SIX snapshots across non-aliased intervals (37ms gaps; the
    // LFO period is 500ms so 37ms gaps cover ~7° of phase per step,
    // hitting many distinct LFO phases including non-zero-crossings).
    // The assertion: max-pairwise mean OR variance delta exceeds 1% of
    // the corresponding scale. With mangle sweeping -1..1, at least
    // one pair of samples MUST land at clearly different LFO phases
    // and produce a measurable global-stat shift.
    const sampleStats = async () =>
      canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        const img = ctx.getImageData(0, 0, c.width, c.height);
        let sum = 0, sumSq = 0, n = 0;
        for (let i = 0; i < img.data.length; i += 16) {
          const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
          sum += v; sumSq += v * v; n++;
        }
        const mean = sum / n;
        const variance = sumSq / n - mean * mean;
        return { mean, variance };
      });

    // Warm up: wait until the engine has actually started rendering.
    // Polls every 50ms up to 3s; fails the test if the canvas stays
    // flat (which would indicate the bridge OR the chain is broken).
    let warm = false;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(50);
      const s = await sampleStats();
      if (s && s.variance > 50) { warm = true; break; }
    }
    expect(warm, 'engine warmed up: canvas variance > 50').toBe(true);

    const samples: Array<{ mean: number; variance: number }> = [];
    for (let i = 0; i < 6; i++) {
      const s = await sampleStats();
      expect(s, `sample ${i} non-null`).not.toBeNull();
      if (s) samples.push(s);
      await page.waitForTimeout(37);
    }

    let maxMeanDelta = 0;
    let maxVarianceDelta = 0;
    let meanScale = 1;
    let varianceScale = 1;
    for (let i = 0; i < samples.length; i++) {
      meanScale = Math.max(meanScale, samples[i]!.mean);
      varianceScale = Math.max(varianceScale, samples[i]!.variance);
      for (let j = i + 1; j < samples.length; j++) {
        maxMeanDelta = Math.max(maxMeanDelta, Math.abs(samples[i]!.mean - samples[j]!.mean));
        maxVarianceDelta = Math.max(maxVarianceDelta, Math.abs(samples[i]!.variance - samples[j]!.variance));
      }
    }
    const moved = (maxMeanDelta / meanScale) > 0.01 || (maxVarianceDelta / varianceScale) > 0.01;

    expect(moved, `pixel pattern shifted across LFO phases (maxMeanΔ=${maxMeanDelta.toFixed(2)}, maxVarΔ=${maxVarianceDelta.toFixed(2)}, meanScale=${meanScale.toFixed(2)}, varScale=${varianceScale.toFixed(2)})`).toBe(true);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
