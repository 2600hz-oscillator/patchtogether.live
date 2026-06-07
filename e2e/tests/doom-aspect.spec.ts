// e2e/tests/doom-aspect.spec.ts
//
// The engine FBO is 4:3 (VIDEO_RES, currently 1024×768). DOOM is natively
// 640×400 (1.6:1), so the engine's letterbox math gives thin top + bottom
// bars (DOOM is WIDER than 4:3). The bar fractions are aspect-derived, so
// they're identical at any 4:3 backing resolution.
//
// This spec catches a future regression to the letterbox formula by
// wiring DOOM into a VideoOut and asserting the actual on-screen pixel
// shape:
//   1. Top + bottom rows of the VideoOut canvas are predominantly BLACK
//      (the engine's letterbox bars carry through the VideoOut blit
//      since the FBO is 4:3 and the VideoOut inner canvas is also 4:3).
//   2. The middle band has real gameplay variance (DOOM content is
//      visible there, not clipped).
//
// Together: DOOM is fit edge-to-edge horizontally with thin bars
// top + bottom (the 4:3-correct shape) and the gameplay is not clipped
// off the top/bottom by a bad shader letterbox.
//
// The DOOM letterbox math:
//   fboAspect = 4 / 3 = 1.333
//   doomAspect = 640 / 400 = 1.6
//   letterboxU = min(1, 1.6 / 1.333) = 1.0          → full width
//   letterboxV = min(1, 1.333 / 1.6) = 0.8333        → V shrinks
//   bar fraction per side = (1 - 0.8333) / 2 ≈ 8.3%
//
// The unit test pins the uniform values directly (doom.test.ts —
// "aspect-rendering / letterbox math"). This e2e covers the end-to-end
// path: shader + FBO + VideoOut blit + canvas pixel read.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('DOOM — aspect / letterbox shape in the 4:3 engine pipeline', () => {
  // Cold WASM init + 4 MB WAD fetch is ~10–20 s on CI; matches doom-wasm
  // spec's budget. We add a few extra seconds for the DOOM → VideoOut
  // blit pipeline to settle.
  test.setTimeout(90_000);

  test('DOOM letterboxed into the 4:3 FBO: top + bottom bands BLACK, middle band has gameplay content', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Pre-flight: WASM + WAD on the dev server. Skip clean if missing —
    // doom-wasm.spec.ts already turns this into a hard fail; here we keep
    // the run green when the build hasn't been done so the aspect-shape
    // assertion stays single-purpose.
    const wasmShim = await page.request.get('/doom/doom.js');
    if (!wasmShim.ok()) {
      test.skip(
        true,
        `DOOM WASM not built (status ${wasmShim.status()}). ` +
          `Run \`bash packages/web/native/build-doom-wasm.sh\` locally; ` +
          `CI's "Build DOOM WASM (emcc)" step handles this.`,
      );
      return;
    }
    const wadResp = await page.request.get('/doom/DOOM1.WAD');
    if (!wadResp.ok()) {
      test.skip(true, `DOOM1.WAD not on dev server (status ${wadResp.status()}).`);
      return;
    }

    // Wire DOOM → VideoOut. The VideoOut card aspect-fits the 4:3 engine FBO
    // into its canvas, so the engine's letterbox bars carry through to the
    // canvas (within the fitted 4:3 region).
    await spawnPatch(
      page,
      [
        { id: 'v-doom', type: 'doom',     position: { x: 80,  y: 80 }, domain: 'video' },
        { id: 'v-out',  type: 'videoOut', position: { x: 560, y: 80 }, domain: 'video' },
      ],
      [
        {
          id: 'e-doom-out',
          from: { nodeId: 'v-doom', portId: 'out' },
          to: { nodeId: 'v-out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    const doomCard = page.locator('[data-testid="doom-card"]');
    await expect(doomCard, 'DOOM card mounts').toHaveCount(1);
    const outCanvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(outCanvas, 'VideoOut canvas mounts').toHaveCount(1);

    // Click the load-overlay button to kick off the WASM + WAD load. The
    // overlay sits over the DOOM canvas; clearing it transitions the card
    // into the rAF blit loop that drives the engine FBO every frame.
    const loadBtn = doomCard.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn, 'load-overlay button visible').toBeVisible();
    await loadBtn.click();
    await expect(
      doomCard.locator('.overlay'),
      'load overlay clears (success or error)',
    ).toHaveCount(0, { timeout: 25_000 });

    // Let the title-demo settle into actively-animating frames so the
    // middle band has real content variance. doomgeneric's title sits
    // static for ~2 s before the demo lump replays.
    await page.waitForTimeout(2500);

    // The VideoOut card's canvas can have ANY aspect ratio (it's a free-resize
    // card). The card aspect-fits the 4:3 engine FBO into the canvas — so when
    // the canvas is WIDER than 4:3, there are additional side bars from the
    // card's fitRect, and when TALLER than 4:3 there are additional top/bottom
    // bars. Either way, INSIDE the fitted 4:3 region the engine's DOOM
    // letterbox shows up as horizontal black bars (top + bottom of the FBO).
    //
    // The test sampling is therefore done in 3 steps:
    //   1) Read the canvas dims (W, H).
    //   2) Compute the fitRect of the engine FBO (4:3) inside the canvas —
    //      this is the actual region where DOOM pixels (and the engine's
    //      shader letterbox bars) live.
    //   3) Sample TOP, MIDDLE, BOTTOM strips INSIDE that fitRect — the FBO
    //      vertical extent — so we observe the shader's letterbox math
    //      independently of the card's own fitRect bars.
    const stats = await outCanvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const W = c.width;
      const H = c.height;
      const img = ctx.getImageData(0, 0, W, H);

      // Engine FBO is 4:3. fitRect mirrors VideoOutCard.svelte's logic.
      const srcAspect = 4 / 3;
      const dstAspect = W / H;
      let fitX: number, fitY: number, fitW: number, fitH: number;
      if (dstAspect > srcAspect) {
        // Canvas is wider → height-locked, side bars.
        fitH = H;
        fitW = Math.round(H * srcAspect);
        fitX = Math.round((W - fitW) / 2);
        fitY = 0;
      } else {
        // Canvas is taller → width-locked, top/bottom bars.
        fitW = W;
        fitH = Math.round(W / srcAspect);
        fitX = 0;
        fitY = Math.round((H - fitH) / 2);
      }

      // Inside fitRect, the engine's shader letterboxes DOOM (1.6:1) into
      // the 4:3 FBO: top/bottom V-bars of ~8.33% each side. We sample:
      //   - TOP    : rows fitY + [1%..6.5%] of fitH                    (engine bar)
      //   - BOTTOM : rows fitY + fitH - [6.5%..1%] of fitH             (engine bar)
      //   - MIDDLE : rows fitY + [20%..80%] of fitH                    (DOOM content)
      // Always sampled across the fitRect's WIDTH (fitX .. fitX+fitW), so we
      // never include the card's own side-bar pixels.
      const barInnerStart = Math.floor(fitH * 0.01);
      const barInnerEnd = Math.floor(fitH * 0.065);
      const topStripStart = fitY + barInnerStart;
      const topStripEnd = fitY + barInnerEnd;
      const bottomStripStart = fitY + fitH - barInnerEnd;
      const bottomStripEnd = fitY + fitH - barInnerStart;
      const midStripStart = fitY + Math.floor(fitH * 0.20);
      const midStripEnd = fitY + Math.floor(fitH * 0.80);

      function stripStats(yStart: number, yEnd: number): { mean: number; max: number; variance: number; n: number } {
        let sum = 0, sumSq = 0, max = 0, n = 0;
        for (let y = yStart; y < yEnd; y++) {
          for (let x = fitX; x < fitX + fitW; x++) {
            const i = (y * W + x) * 4;
            const r = img.data[i]!;
            const g = img.data[i + 1]!;
            const b = img.data[i + 2]!;
            const v = (r + g + b) / 3;
            sum += v; sumSq += v * v;
            if (v > max) max = v;
            n++;
          }
        }
        const mean = sum / Math.max(1, n);
        const variance = sumSq / Math.max(1, n) - mean * mean;
        return { mean, max, variance, n };
      }

      return {
        W, H, fitX, fitY, fitW, fitH,
        top: stripStats(topStripStart, topStripEnd),
        bottom: stripStats(bottomStripStart, bottomStripEnd),
        middle: stripStats(midStripStart, midStripEnd),
      };
    });

    expect(stats, 'VideoOut getImageData returned a value').not.toBeNull();
    const { W, H, fitW, fitH, top, bottom, middle } = stats!;

    // Sanity: VideoOut canvas + fitRect have real dimensions.
    expect(W, `VideoOut canvas width = ${W}`).toBeGreaterThan(100);
    expect(H, `VideoOut canvas height = ${H}`).toBeGreaterThan(75);
    expect(fitW, `4:3 fit-rect width inside canvas = ${fitW}`).toBeGreaterThan(50);
    expect(fitH, `4:3 fit-rect height inside canvas = ${fitH}`).toBeGreaterThan(50);
    // The fit rect itself is 4:3 (engine FBO aspect).
    expect(fitW / fitH, `fit-rect aspect (got ${(fitW / fitH).toFixed(3)})`).toBeCloseTo(4 / 3, 1);

    // TOP and BOTTOM bands: predominantly BLACK. Mean luminance < 8 (out
    // of 255) — leaves room for a stray bright pixel at the boundary from
    // sub-pixel scaling, but the bar is clearly dark. Max luminance
    // staying under 64 doubles up on that — even the brightest pixel in
    // the bar is well below mid-gray.
    expect(
      top.mean,
      `TOP letterbox bar mean luminance should be near zero (got ${top.mean.toFixed(2)} over ${top.n} px). ` +
        `If > 8, the shader's vertical letterbox isn't black — letterbox math regression?`,
    ).toBeLessThan(8);
    expect(top.max, `TOP letterbox bar max luminance (got ${top.max})`).toBeLessThan(64);

    expect(
      bottom.mean,
      `BOTTOM letterbox bar mean luminance should be near zero (got ${bottom.mean.toFixed(2)} over ${bottom.n} px).`,
    ).toBeLessThan(8);
    expect(bottom.max, `BOTTOM letterbox bar max luminance (got ${bottom.max})`).toBeLessThan(64);

    // MIDDLE band: real gameplay content. Variance must be substantial —
    // a solid colour fill or a clipped framebuffer would have variance
    // ~0; the DOOM title screen alone has > 500 variance (text + tinted
    // background), and the demo loop is much higher.
    expect(
      middle.variance,
      `MIDDLE gameplay band variance should be substantial (got ${middle.variance.toFixed(2)}). ` +
        `If ~0, DOOM is clipped to nothing OR the FBO is solid — letterbox math regression?`,
    ).toBeGreaterThan(200);

    // Save an artifact for triage on failure.
    await outCanvas.screenshot({ path: 'test-results/doom-aspect-frame.png' });

    // Ignore benign console noise.
    const realErrors = errors.filter(
      (e) =>
        !e.includes('autoplay') &&
        !e.includes('AudioContext') &&
        !e.includes('favicon'),
    );
    expect(realErrors, `unexpected errors: ${realErrors.join(' | ')}`).toEqual([]);
  });

  test('content band contains non-zero pixels at multiple sample coordinates (DOOM not clipped to nothing)', async ({ page }) => {
    // Companion: single-context sanity check that the gameplay band
    // covers MOST of the canvas — sample 5 widely-spread points in the
    // active band and assert at least 3 are non-black. Even a static
    // title (intermission frozen) would satisfy this; a clipped FBO
    // would not.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const wasmShim = await page.request.get('/doom/doom.js');
    if (!wasmShim.ok()) { test.skip(true, 'DOOM WASM not built'); return; }
    const wadResp = await page.request.get('/doom/DOOM1.WAD');
    if (!wadResp.ok()) { test.skip(true, 'DOOM1.WAD missing'); return; }

    await spawnPatch(
      page,
      [
        { id: 'v-doom', type: 'doom',     position: { x: 80,  y: 80 }, domain: 'video' },
        { id: 'v-out',  type: 'videoOut', position: { x: 560, y: 80 }, domain: 'video' },
      ],
      [
        {
          id: 'e-doom-out',
          from: { nodeId: 'v-doom', portId: 'out' },
          to: { nodeId: 'v-out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    const doomCard = page.locator('[data-testid="doom-card"]');
    const outCanvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(doomCard).toHaveCount(1);
    await expect(outCanvas).toHaveCount(1);

    const loadBtn = doomCard.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await loadBtn.click();
    await expect(doomCard.locator('.overlay')).toHaveCount(0, { timeout: 25_000 });

    await page.waitForTimeout(2500);

    // Sample 5 points inside the active gameplay band. We first compute
    // the 4:3 fit-rect (matches VideoOutCard.fitRect), then sample 5
    // points well inside the inner active band — the 5 points are placed
    // within fitX..fitX+fitW horizontally and fitY+0.3*fitH..fitY+0.7*fitH
    // vertically (i.e. well inside the engine's ~8.3% top/bottom bars).
    const samples = await outCanvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const W = c.width;
      const H = c.height;
      const img = ctx.getImageData(0, 0, W, H);

      const srcAspect = 4 / 3;
      const dstAspect = W / H;
      let fitX: number, fitY: number, fitW: number, fitH: number;
      if (dstAspect > srcAspect) {
        fitH = H; fitW = Math.round(H * srcAspect);
        fitX = Math.round((W - fitW) / 2); fitY = 0;
      } else {
        fitW = W; fitH = Math.round(W / srcAspect);
        fitX = 0; fitY = Math.round((H - fitH) / 2);
      }

      const pts = [
        { x: fitX + Math.floor(fitW * 0.50), y: fitY + Math.floor(fitH * 0.50) }, // center
        { x: fitX + Math.floor(fitW * 0.25), y: fitY + Math.floor(fitH * 0.30) }, // upper-left
        { x: fitX + Math.floor(fitW * 0.75), y: fitY + Math.floor(fitH * 0.30) }, // upper-right
        { x: fitX + Math.floor(fitW * 0.25), y: fitY + Math.floor(fitH * 0.70) }, // lower-left
        { x: fitX + Math.floor(fitW * 0.75), y: fitY + Math.floor(fitH * 0.70) }, // lower-right
      ];
      return pts.map((p) => {
        const i = (p.y * W + p.x) * 4;
        const r = img.data[i]!;
        const g = img.data[i + 1]!;
        const b = img.data[i + 2]!;
        return { x: p.x, y: p.y, r, g, b, lum: (r + g + b) / 3 };
      });
    });

    expect(samples).not.toBeNull();
    // At least 3 of 5 samples have non-zero luminance (DOOM's title +
    // demo are far from being mostly-black; this is generous to handle
    // intermission/blank-frame transitions).
    const nonBlackCount = samples!.filter((s) => s.lum > 4).length;
    expect(
      nonBlackCount,
      `≥3 of 5 active-band samples should be non-black, got ${nonBlackCount}/5 ` +
        `(samples: ${samples!.map((s) => `(${s.x},${s.y})=${s.lum.toFixed(0)}`).join(', ')}). ` +
        `If 0 or 1: DOOM content is clipped to nothing — letterbox math regression?`,
    ).toBeGreaterThanOrEqual(3);

    await outCanvas.screenshot({ path: 'test-results/doom-aspect-content-frame.png' });
  });
});
