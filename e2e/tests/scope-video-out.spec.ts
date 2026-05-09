// e2e/tests/scope-video-out.spec.ts
//
// E2E for SCOPE's new mono-video output port. Spawn ANALOG-VCO ->
// SCOPE.ch1, SCOPE.out -> OUTPUT, hit play, assert OUTPUT canvas
// shows non-zero pixel variance reflecting the audio waveform.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('SCOPE.out (mono-video) -> OUTPUT', () => {
  test('SCOPE patched into OUTPUT renders a waveform trace', async ({ page }) => {
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
        { id: 'a-scope', type: 'scope',     position: { x: 280, y: 60 }, domain: 'audio' },
        { id: 'v-out',   type: 'videoOut',  position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-vco-scope',
          from: { nodeId: 'a-vco', portId: 'saw' },
          to:   { nodeId: 'a-scope', portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
        {
          id: 'e-scope-out',
          from: { nodeId: 'a-scope', portId: 'out' },
          to:   { nodeId: 'v-out', portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-scope'), 'SCOPE visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    // SCOPE card must render the new `out` handle (io-spec consistency
    // covers this elsewhere; cheap sanity here too).
    const scopeCard = page.locator('.svelte-flow__node-scope');
    const outHandle = scopeCard.locator('[data-handleid="out"]');
    await expect(outHandle, 'scope.out handle present').toHaveCount(1);

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
      // Trace shape: a flat line at canvas center occupies just a few
      // adjacent rows. A real waveform spans many distinct rows. Counting
      // bright rows catches the Bug-2 regression (LINEAR-filtered R32F
      // texture returning all-zeros under WebGL2 without
      // OES_texture_float_linear, which silently produced a flat trace
      // that still passed a bare variance>5 assertion).
      const brightRows = new Set<number>();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
          sum += v; sumSq += v * v;
          if (v > 8) nonZero++;
          if (v > 100) brightRows.add(y);
          n++;
        }
      }
      const mean = sum / n;
      return { mean, variance: sumSq / n - mean * mean, nonZero, n, brightRows: brightRows.size };
    });

    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.variance, `variance ${stats.variance} > 5`).toBeGreaterThan(5);
    expect(stats.nonZero / stats.n, 'fraction bright > 1%').toBeGreaterThan(0.01);
    expect(
      stats.brightRows,
      `trace must span many rows, not just a flat line at center (got ${stats.brightRows})`,
    ).toBeGreaterThanOrEqual(20);

    expect(errors).toEqual([]);
  });

  test('SCOPE params change the video output (PR-69 user-reported bug fix)', async ({ page }) => {
    // User report (verbatim): "when scope is patched to the video output,
    // we just see noise, not the same lines on the scope. we should see
    // the data of the scope as a 2-d mono layer, and it should change
    // as we change the controls on the scope."
    //
    // Pre-fix: the bridge ignored every scope param (timeMs, scale,
    // offset, range, XY, ch2). It uploaded the raw 2048-sample analyser
    // buffer through a generic GL renderer at rangeMax=1.0. At 44.1kHz
    // that's many cycles densely packed across the canvas — looked like
    // noise vs. the on-card timeMs window.
    //
    // Post-fix: scope's videoSources.drawFrame runs the same drawScope
    // function the on-card canvas uses, against live params. Changing
    // the user-visible XY toggle MUST visibly change the OUTPUT pixels.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'a-vco',   type: 'analogVco', position: { x: 60,  y: 60 }, domain: 'audio' },
        { id: 'a-scope', type: 'scope',     position: { x: 280, y: 60 }, domain: 'audio' },
        { id: 'v-out',   type: 'videoOut',  position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e-vco-scope-1', from: { nodeId: 'a-vco',   portId: 'saw' },     to: { nodeId: 'a-scope', portId: 'ch1' }, sourceType: 'audio',     targetType: 'audio' },
        { id: 'e-vco-scope-2', from: { nodeId: 'a-vco',   portId: 'sine' },    to: { nodeId: 'a-scope', portId: 'ch2' }, sourceType: 'audio',     targetType: 'audio' },
        { id: 'e-scope-out',   from: { nodeId: 'a-scope', portId: 'out' },     to: { nodeId: 'v-out',   portId: 'in' },  sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(900);

    // Helper: hash the canvas's pixel data to a single number so we can
    // assert "different render" without comparing every pixel. We use
    // a per-row brightness sum since the row-distribution is what
    // changes most when toggling XY (split = horizontal traces;
    // XY = a circular Lissajous around center).
    const rowSig = async (): Promise<number[]> => {
      return canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return [];
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const w = c.width, h = c.height;
        const out = new Array<number>(h).fill(0);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
            if (v > 100) out[y]! += 1;
          }
        }
        return out;
      });
    };

    const before = await rowSig();
    expect(before.some((v) => v > 0), 'baseline render is non-empty').toBe(true);

    // Flip XY mode via the patch graph (the same store the user mutates
    // when they click the XY button). The reconciler picks it up and
    // calls scope.setParam('mode', 1) on the audio handle, which flows
    // straight into the local params cache the bridge's drawFrame
    // reads.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['a-scope']!.params.mode = 1;
      });
    });
    await page.waitForTimeout(700);
    const afterXy = await rowSig();
    // XY mode collapses traces toward the canvas center; the row
    // distribution differs from the split layout.
    let differingRows = 0;
    for (let i = 0; i < before.length; i++) {
      if (Math.abs((before[i] ?? 0) - (afterXy[i] ?? 0)) > 2) differingRows++;
    }
    expect(
      differingRows,
      `flipping XY mode must change the output (got ${differingRows} differing rows)`,
    ).toBeGreaterThan(10);
  });
});
