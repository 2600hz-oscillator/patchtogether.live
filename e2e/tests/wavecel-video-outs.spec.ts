// e2e/tests/wavecel-video-outs.spec.ts
//
// E2E for WAVECEL's two new video output ports:
//   - scope_out (mono-video): waveform-trace view of the active frame.
//   - wave3d_out (video):     3D wavetable view with orange polylines +
//                              the active frame in white.
//
// Both ports are independent of the on-card scope/3D toggle (which
// drives the on-card preview only). The bridge uses
// AudioDomainNodeHandle.videoSources + drawFrame — same pattern as
// SCOPE's video out (see scope-video-out.spec.ts).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('WAVECEL video outputs (cross-domain bridge)', () => {
  test('WAVECEL.scope_out -> OUTPUT renders a waveform trace', async ({ page }) => {
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
        { id: 'a-vco',   type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
        { id: 'a-wave',  type: 'wavecel',   position: { x: 280, y: 60 }, domain: 'audio' },
        { id: 'v-out',   type: 'videoOut',  position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-vco-wave',
          from: { nodeId: 'a-vco',  portId: 'sine' },
          to:   { nodeId: 'a-wave', portId: 'pitch' },
          sourceType: 'pitch',
          targetType: 'pitch',
        },
        {
          id: 'e-wave-out',
          from: { nodeId: 'a-wave', portId: 'scope_out' },
          to:   { nodeId: 'v-out',  portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-wavecel'), 'WAVECEL visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    const wavecelCard = page.locator('.svelte-flow__node-wavecel');
    await expect(
      wavecelCard.locator('[data-handleid="scope_out"]'),
      'scope_out handle present',
    ).toHaveCount(1);
    await expect(
      wavecelCard.locator('[data-handleid="wave3d_out"]'),
      'wave3d_out handle present',
    ).toHaveCount(1);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(900);

    const stats = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const w = c.width, h = c.height;
      let n = 0, sum = 0, sumSq = 0, nonZero = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
          sum += v; sumSq += v * v;
          if (v > 8) nonZero++;
          n++;
        }
      }
      const mean = sum / n;
      return { mean, variance: sumSq / n - mean * mean, nonZero, n };
    });

    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.variance, `variance ${stats.variance} > 5`).toBeGreaterThan(5);
    expect(stats.nonZero / stats.n, 'fraction bright > 1%').toBeGreaterThan(0.01);

    expect(errors).toEqual([]);
  });

  test('WAVECEL.wave3d_out -> OUTPUT renders the 3D wavetable view (color content present)', async ({ page }) => {
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
        { id: 'a-vco',   type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
        { id: 'a-wave',  type: 'wavecel',   position: { x: 280, y: 60 }, domain: 'audio' },
        { id: 'v-out',   type: 'videoOut',  position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-vco-wave',
          from: { nodeId: 'a-vco',  portId: 'sine' },
          to:   { nodeId: 'a-wave', portId: 'pitch' },
          sourceType: 'pitch',
          targetType: 'pitch',
        },
        {
          id: 'e-wave-out',
          from: { nodeId: 'a-wave', portId: 'wave3d_out' },
          to:   { nodeId: 'v-out',  portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(900);

    // 3D mode = orange polylines on dark bg + a white-highlighted
    // active frame. The defining property vs. scope_out is that the
    // RGB cable type (`video`) preserves the orange + white colors;
    // we assert both that there are non-trivial bright pixels AND
    // that the red channel meaningfully dominates green/blue across
    // the bright region (orange).
    const stats = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const w = c.width, h = c.height;
      let nonZero = 0, n = 0;
      let rSum = 0, gSum = 0, bSum = 0, lit = 0;
      let hasOrange = false, hasWhite = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = img.data[i]!, g = img.data[i + 1]!, b = img.data[i + 2]!;
          const v = (r + g + b) / 3;
          if (v > 8) nonZero++;
          if (v > 40) {
            rSum += r; gSum += g; bSum += b; lit++;
            // Orange = R >> G > B. Active-frame white = R ~= G ~= B all high.
            if (r > 150 && g > 70 && g < 200 && b < 120) hasOrange = true;
            if (r > 200 && g > 200 && b > 200) hasWhite = true;
          }
          n++;
        }
      }
      return { nonZero, n, lit, rAvg: rSum / Math.max(1, lit), gAvg: gSum / Math.max(1, lit), bAvg: bSum / Math.max(1, lit), hasOrange, hasWhite };
    });

    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.nonZero / stats.n, 'fraction lit > 0.5%').toBeGreaterThan(0.005);
    // RGB content: avg red noticeably > avg blue across lit pixels.
    expect(
      stats.rAvg - stats.bAvg,
      `red-vs-blue separation (rAvg ${stats.rAvg.toFixed(0)} - bAvg ${stats.bAvg.toFixed(0)}) > 20`,
    ).toBeGreaterThan(20);
    // Either orange OR white should be visible — orange is the bulk,
    // white is the active-frame highlight. Asserting at least one
    // tolerates color-channel variance from the GL upload pipeline.
    expect(stats.hasOrange || stats.hasWhite, 'orange or white pixels present').toBe(true);

    expect(errors).toEqual([]);
  });

  test('on-card scope/3D toggle is independent of the video outputs', async ({ page }) => {
    // The card's viz-toggle button only flips the on-card preview;
    // the two video outs always render their own view. We can't
    // easily compare canvases in two tests at once, so we route
    // BOTH outputs (3D + scope) into two distinct video pipelines
    // — but the simpler sanity check is just: clicking the toggle
    // doesn't break the scope_out -> OUTPUT path.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'a-vco',  type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
        { id: 'a-wave', type: 'wavecel',   position: { x: 280, y: 60 }, domain: 'audio' },
        { id: 'v-out',  type: 'videoOut',  position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e-vco-wave', from: { nodeId: 'a-vco',  portId: 'sine' },      to: { nodeId: 'a-wave', portId: 'pitch' },     sourceType: 'pitch',      targetType: 'pitch' },
        { id: 'e-wave-out', from: { nodeId: 'a-wave', portId: 'scope_out' }, to: { nodeId: 'v-out',  portId: 'in' },        sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await page.waitForTimeout(600);

    const before = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      let sum = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        sum += (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!);
      }
      return sum;
    });
    expect(before, 'scope_out renders non-zero pixels initially').toBeGreaterThan(0);

    // Flip the on-card toggle. The viz-toggle button cycles
    // '3d' <-> 'scope' for the on-card preview only.
    await page.locator('[data-testid="wavecel-viz-toggle"]').first().click();
    await page.waitForTimeout(600);

    const after = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      let sum = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        sum += (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!);
      }
      return sum;
    });
    expect(after, 'scope_out still renders non-zero pixels after toggle').toBeGreaterThan(0);
  });
});
