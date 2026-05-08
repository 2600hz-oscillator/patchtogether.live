// e2e/tests/video-phase1.spec.ts
//
// Phase-1 video-domain demo: build a multi-module video graph and assert
// the OUTPUT canvas renders a non-trivial pattern.
//
// Graph:
//   LINES    \
//   INWARDS   --> V-MIXER (in1, in2) --> DESTRUCTOR --> OUTPUT
//
// Why this graph: it exercises the whole Phase-1 op chain end-to-end —
// two procedural sources, the new mixer, an effect that mangles RGB
// channels, and the existing OUTPUT sink. If any link breaks (a
// shader compile fails, a port id mismatches, the topo sort is wrong)
// the canvas goes flat and pixel variance plummets.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('video Phase-1: multi-module graph renders to OUTPUT', () => {
  test('LINES + INWARDS -> V-MIXER -> DESTRUCTOR -> OUTPUT produces a varying canvas', async ({ page }) => {
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
        { id: 'v-lines',   type: 'lines',      position: { x: 40,  y: 40 },  domain: 'video' },
        { id: 'v-inwards', type: 'inwards',    position: { x: 40,  y: 280 }, domain: 'video' },
        { id: 'v-mixer',   type: 'videoMixer', position: { x: 320, y: 80 },  domain: 'video', params: { amount1: 0.6, amount2: 0.6, amount3: 0, amount4: 0 } },
        { id: 'v-destr',   type: 'destructor', position: { x: 700, y: 80 },  domain: 'video', params: { shift: 0.7, scanline: 0.5, posterize: 0.4, mangle: 0.8 } },
        { id: 'v-out',     type: 'videoOut',   position: { x: 1000, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e-lines-mixer',   from: { nodeId: 'v-lines',   portId: 'out' }, to: { nodeId: 'v-mixer', portId: 'in1' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-inwards-mixer', from: { nodeId: 'v-inwards', portId: 'out' }, to: { nodeId: 'v-mixer', portId: 'in2' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-mixer-destr',   from: { nodeId: 'v-mixer',   portId: 'out' }, to: { nodeId: 'v-destr', portId: 'in' },  sourceType: 'video',      targetType: 'video' },
        { id: 'e-destr-out',     from: { nodeId: 'v-destr',   portId: 'out' }, to: { nodeId: 'v-out',   portId: 'in' },  sourceType: 'video',      targetType: 'video' },
      ],
    );

    // All cards visible.
    await expect(page.locator('.svelte-flow__node-lines'),      'LINES visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-inwards'),    'INWARDS visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoMixer'), 'V-MIXER visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-destructor'), 'DESTRUCTOR visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),   'OUTPUT visible').toBeVisible();

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas, 'video-out canvas in DOM').toHaveCount(1);

    // Allow several rAF ticks. ~600ms covers slow CI runners.
    await page.waitForTimeout(800);

    const stats = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const data = img.data;
      let n = 0, sum = 0, sumSq = 0, nonZero = 0;
      for (let i = 0; i < data.length; i += 16) {
        const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
        sum += v;
        sumSq += v * v;
        if (v > 8) nonZero++;
        n++;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      return { mean, variance, nonZero, samples: n };
    });

    expect(stats, 'pixel-stats sample').not.toBeNull();
    if (!stats) return;

    expect(stats.variance, `variance ${stats.variance} > 50 (non-flat)`).toBeGreaterThan(50);
    expect(stats.nonZero / stats.samples, 'fraction of bright pixels > 5%').toBeGreaterThan(0.05);

    await page.screenshot({ path: 'test-results/video-phase1-demo.png', fullPage: false });

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});

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

    // Sample mean luma at two distinct LFO phases. Phase A: ~250ms
    // (about a half-cycle into the LFO). Phase B: another ~500ms later
    // (LFO has completed another cycle, but timing is approximate;
    // we just need two non-equal samples).
    await page.waitForTimeout(250);
    const sampleA = await canvas.evaluate((el) => {
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

    await page.waitForTimeout(500);
    const sampleB = await canvas.evaluate((el) => {
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

    expect(sampleA, 'sampleA non-null').not.toBeNull();
    expect(sampleB, 'sampleB non-null').not.toBeNull();
    if (!sampleA || !sampleB) return;

    // The output ALWAYS has variance from the line pattern. The LFO
    // bridge effect is observed via mean shifting between samples (since
    // mangle changes brightness roll-off through posterize/scanline).
    // Tolerance: at minimum we want some statistic to differ. A
    // strict assertion is risky if the LFO phases coincidentally align,
    // so we accept "at least one of mean/variance differs by >1%".
    const meanDelta = Math.abs(sampleA.mean - sampleB.mean);
    const varianceDelta = Math.abs(sampleA.variance - sampleB.variance);
    const meanScale = Math.max(1, sampleA.mean, sampleB.mean);
    const varianceScale = Math.max(1, sampleA.variance, sampleB.variance);
    const moved = (meanDelta / meanScale) > 0.01 || (varianceDelta / varianceScale) > 0.01;

    expect(moved, `pixel pattern shifted between LFO phases (meanΔ=${meanDelta.toFixed(2)}, varΔ=${varianceDelta.toFixed(2)})`).toBe(true);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
