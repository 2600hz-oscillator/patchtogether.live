// e2e/tests/video-controls.spec.ts
//
// Regression suite: every video module's params actually drive its GL
// output. The original Phase-0 / Phase-1 specs only asserted the canvas
// renders something non-flat; they did NOT assert that knob/fader changes
// reach the shader and reach the visible canvas. The user flagged that
// LINES + INWARDS controls didn't drive output (and was suspect of every
// other video module); this suite is the codified gate so a future
// regression breaks a test, not the live demo.
//
// Test pattern, per module:
//   1. Spawn the module with default params (plus OUTPUT downstream where
//      applicable, plus an upstream source for effect modules).
//   2. Wait for the engine to render a few frames.
//   3. Capture a baseline pixel sample (mean + variance).
//   4. Mutate ONE specific param via the dev-mode __patch global so the
//      reconciler routes the change through engine.setParam.
//   5. Wait again, capture a second sample.
//   6. Assert at least one stat moved by more than the time-domain noise
//      floor (LINES auto-scrolls phase, so equal samples can drift on
//      their own — we set the threshold above that drift).
//
// The test mutates patch state directly rather than dragging the Fader
// component because (a) Playwright drag synthesis is flaky on CI, (b)
// what we want to prove is the param chain (UI → store → reconciler →
// engine → shader), not the Fader's own pointer math.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PixelStats {
  mean: number;
  variance: number;
  nonZero: number;
  samples: number;
}

async function readCanvasStats(canvas: Locator): Promise<PixelStats | null> {
  return canvas.evaluate((el) => {
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
}

/** Mutate a single patch-graph param via the dev `__patch` global, then
 *  yield a microtask so the reconciler picks the change up before the
 *  next pixel sample. */
async function setNodeParam(
  page: Page,
  nodeId: string,
  paramId: string,
  value: number,
): Promise<void> {
  await page.evaluate(
    ({ nodeId, paramId, value }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const target = w.__patch.nodes[nodeId];
        if (target) target.params[paramId] = value;
      });
    },
    { nodeId, paramId, value },
  );
}

/** Two pixel-stat samples are "different" when at least one of mean /
 *  variance / nonZero shifted by more than the per-frame drift floor.
 *  LINES auto-scrolls phase ~0.15Hz, so a steady patch with no param
 *  change can still drift a few percent in any one statistic across two
 *  samples — we ask the difference to be substantially larger than that. */
function statsDiffer(a: PixelStats, b: PixelStats): boolean {
  const meanDelta = Math.abs(a.mean - b.mean);
  const varianceDelta = Math.abs(a.variance - b.variance);
  const nzDelta = Math.abs(a.nonZero - b.nonZero);
  // Relative thresholds. mean is in 0..255; variance can be huge.
  const meanThreshold = 4; // 4 luminance levels
  const varianceRel = 0.10; // 10% of the larger sample
  const nzRel = 0.10;
  const meanScale = Math.max(1, a.variance, b.variance);
  const nzScale = Math.max(1, a.nonZero, b.nonZero);
  return (
    meanDelta > meanThreshold ||
    varianceDelta / meanScale > varianceRel ||
    nzDelta / nzScale > nzRel
  );
}

const VIDEO_OUT_CANVAS = 'canvas[data-testid="video-out-canvas"]';

/** Sample twice with a small wait between captures. Returns the latest
 *  pair so callers can diff. */
async function takePair(page: Page, canvas: Locator, gapMs = 350): Promise<[PixelStats, PixelStats]> {
  await page.waitForTimeout(gapMs);
  const before = await readCanvasStats(canvas);
  await page.waitForTimeout(gapMs);
  const after = await readCanvasStats(canvas);
  expect(before, 'before non-null').not.toBeNull();
  expect(after, 'after non-null').not.toBeNull();
  return [before!, after!];
}

test.describe('video controls drive output', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('LINES amp knob changes pixel pattern', async ({ page }) => {
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',    position: { x: 80, y: 60 },  domain: 'video', params: { amp: 4, thickness: 0.4 } },
        { id: 'v-out',   type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e-lines-out', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    const canvas = page.locator(VIDEO_OUT_CANVAS);
    await expect(canvas).toHaveCount(1);

    await page.waitForTimeout(500);
    const before = (await readCanvasStats(canvas))!;
    expect(before.variance).toBeGreaterThan(50);

    // Crank amp up dramatically — far more lines per screen → many more
    // bright/dark transitions → variance shifts. (Auto-scroll keeps the
    // pattern moving but the per-sample variance is dominated by amp.)
    await setNodeParam(page, 'v-lines', 'amp', 40);
    await page.waitForTimeout(500);
    const after = (await readCanvasStats(canvas))!;

    expect(
      statsDiffer(before, after),
      `LINES amp 4→40: pre=mean=${before.mean.toFixed(1)},var=${before.variance.toFixed(1)} post=mean=${after.mean.toFixed(1)},var=${after.variance.toFixed(1)}`,
    ).toBe(true);
  });

  test('INWARDS density knob changes pixel pattern', async ({ page }) => {
    await spawnPatch(
      page,
      [
        { id: 'v-in',  type: 'inwards',  position: { x: 80, y: 60 },  domain: 'video', params: { density: 4, speed: 0.1, thickness: 0.4 } },
        { id: 'v-out', type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e-in-out', from: { nodeId: 'v-in', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    const canvas = page.locator(VIDEO_OUT_CANVAS);
    await page.waitForTimeout(500);
    const before = (await readCanvasStats(canvas))!;
    expect(before.variance).toBeGreaterThan(20);

    await setNodeParam(page, 'v-in', 'density', 30);
    await page.waitForTimeout(500);
    const after = (await readCanvasStats(canvas))!;

    expect(
      statsDiffer(before, after),
      `INWARDS density 4→30: pre=mean=${before.mean.toFixed(1)},var=${before.variance.toFixed(1)} post=mean=${after.mean.toFixed(1)},var=${after.variance.toFixed(1)}`,
    ).toBe(true);
  });

  test('DESTRUCTOR mangle knob changes pixel pattern', async ({ page }) => {
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',      position: { x: 40,  y: 60 },  domain: 'video' },
        { id: 'v-destr', type: 'destructor', position: { x: 320, y: 60 },  domain: 'video', params: { shift: 0, scanline: 0, posterize: 0, mangle: 0 } },
        { id: 'v-out',   type: 'videoOut',   position: { x: 700, y: 60 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-destr', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-destr', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-destr-out',   from: { nodeId: 'v-destr', portId: 'out' }, to: { nodeId: 'v-out',   portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    const canvas = page.locator(VIDEO_OUT_CANVAS);
    await page.waitForTimeout(500);
    const before = (await readCanvasStats(canvas))!;

    // Crank everything destructor-side.
    await setNodeParam(page, 'v-destr', 'shift',     0.9);
    await setNodeParam(page, 'v-destr', 'scanline',  0.8);
    await setNodeParam(page, 'v-destr', 'posterize', 0.7);
    await setNodeParam(page, 'v-destr', 'mangle',    0.9);
    await page.waitForTimeout(500);
    const after = (await readCanvasStats(canvas))!;

    expect(
      statsDiffer(before, after),
      `DESTRUCTOR all-on: pre=mean=${before.mean.toFixed(1)},var=${before.variance.toFixed(1)} post=mean=${after.mean.toFixed(1)},var=${after.variance.toFixed(1)}`,
    ).toBe(true);
  });

  test('LUMA threshold knob changes pixel pattern', async ({ page }) => {
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',    position: { x: 40, y: 60 },   domain: 'video' },
        { id: 'v-luma',  type: 'luma',     position: { x: 320, y: 60 },  domain: 'video', params: { threshold: 0.1, softness: 0.1 } },
        { id: 'v-out',   type: 'videoOut', position: { x: 700, y: 60 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-luma', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-luma', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-luma-out',   from: { nodeId: 'v-luma',  portId: 'out' }, to: { nodeId: 'v-out',  portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    const canvas = page.locator(VIDEO_OUT_CANVAS);
    await page.waitForTimeout(500);
    const before = (await readCanvasStats(canvas))!;

    await setNodeParam(page, 'v-luma', 'threshold', 0.9);
    await page.waitForTimeout(500);
    const after = (await readCanvasStats(canvas))!;

    expect(
      statsDiffer(before, after),
      `LUMA threshold 0.1→0.9: pre=mean=${before.mean.toFixed(1)},var=${before.variance.toFixed(1)} post=mean=${after.mean.toFixed(1)},var=${after.variance.toFixed(1)}`,
    ).toBe(true);
  });

  test('CHROMA tolerance knob changes pixel pattern', async ({ page }) => {
    await spawnPatch(
      page,
      [
        { id: 'v-lines',  type: 'lines',    position: { x: 40, y: 60 },   domain: 'video' },
        { id: 'v-chroma', type: 'chroma',   position: { x: 320, y: 60 },  domain: 'video', params: { keyR: 1.0, keyG: 1.0, keyB: 1.0, tolerance: 0.0, softness: 0.05 } },
        { id: 'v-out',    type: 'videoOut', position: { x: 700, y: 60 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-chroma', from: { nodeId: 'v-lines',  portId: 'out' }, to: { nodeId: 'v-chroma', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-chroma-out',   from: { nodeId: 'v-chroma', portId: 'out' }, to: { nodeId: 'v-out',    portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );
    const canvas = page.locator(VIDEO_OUT_CANVAS);
    await page.waitForTimeout(500);
    const before = (await readCanvasStats(canvas))!;

    await setNodeParam(page, 'v-chroma', 'tolerance', 1.0);
    await page.waitForTimeout(500);
    const after = (await readCanvasStats(canvas))!;

    expect(
      statsDiffer(before, after),
      `CHROMA tolerance 0→1: pre=mean=${before.mean.toFixed(1)},var=${before.variance.toFixed(1)} post=mean=${after.mean.toFixed(1)},var=${after.variance.toFixed(1)}`,
    ).toBe(true);
  });

  test('COLORIZER tintR knob changes pixel pattern', async ({ page }) => {
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',     position: { x: 40, y: 60 },   domain: 'video' },
        { id: 'v-color', type: 'colorizer', position: { x: 320, y: 60 },  domain: 'video', params: { tintR: 0.0, tintG: 0.5, tintB: 0.5 } },
        { id: 'v-out',   type: 'videoOut',  position: { x: 700, y: 60 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-color', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-color', portId: 'in' }, sourceType: 'mono-video', targetType: 'mono-video' },
        { id: 'e-color-out',   from: { nodeId: 'v-color', portId: 'out' }, to: { nodeId: 'v-out',   portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    const canvas = page.locator(VIDEO_OUT_CANVAS);
    await page.waitForTimeout(500);
    const before = (await readCanvasStats(canvas))!;

    await setNodeParam(page, 'v-color', 'tintR', 1.0);
    await page.waitForTimeout(500);
    const after = (await readCanvasStats(canvas))!;

    expect(
      statsDiffer(before, after),
      `COLORIZER tintR 0→1: pre=mean=${before.mean.toFixed(1)},var=${before.variance.toFixed(1)} post=mean=${after.mean.toFixed(1)},var=${after.variance.toFixed(1)}`,
    ).toBe(true);
  });

  test('FEEDBACK wet knob changes pixel pattern', async ({ page }) => {
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',    position: { x: 40, y: 60 },   domain: 'video' },
        { id: 'v-fb',    type: 'feedback', position: { x: 320, y: 60 },  domain: 'video', params: { wet: 0.0, decay: 0.95, zoom: 1.05, offsetX: 0, offsetY: 0, rotate: 0 } },
        { id: 'v-out',   type: 'videoOut', position: { x: 700, y: 60 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-fb', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-fb',  portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-fb-out',   from: { nodeId: 'v-fb',    portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video',      targetType: 'video' },
      ],
    );
    const canvas = page.locator(VIDEO_OUT_CANVAS);
    await page.waitForTimeout(500);
    const before = (await readCanvasStats(canvas))!;

    await setNodeParam(page, 'v-fb', 'wet', 1.0);
    await page.waitForTimeout(800);
    const after = (await readCanvasStats(canvas))!;

    expect(
      statsDiffer(before, after),
      `FEEDBACK wet 0→1: pre=mean=${before.mean.toFixed(1)},var=${before.variance.toFixed(1)} post=mean=${after.mean.toFixed(1)},var=${after.variance.toFixed(1)}`,
    ).toBe(true);
  });

  test('V-MIXER amount2 knob changes pixel pattern', async ({ page }) => {
    // Two visually-distinct sources so cross-fading between them via a
    // mixer-amount knob produces a visible pixel-stat shift.
    await spawnPatch(
      page,
      [
        { id: 'v-lines', type: 'lines',      position: { x: 40,  y: 40 },  domain: 'video', params: { amp: 8 } },
        { id: 'v-in',    type: 'inwards',    position: { x: 40,  y: 280 }, domain: 'video', params: { density: 25, speed: 0.05 } },
        { id: 'v-mix',   type: 'videoMixer', position: { x: 320, y: 80 },  domain: 'video', params: { amount1: 1.0, amount2: 0.0, amount3: 0, amount4: 0 } },
        { id: 'v-out',   type: 'videoOut',   position: { x: 700, y: 80 },  domain: 'video' },
      ],
      [
        { id: 'e-lines-mix', from: { nodeId: 'v-lines', portId: 'out' }, to: { nodeId: 'v-mix', portId: 'in1' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-in-mix',    from: { nodeId: 'v-in',    portId: 'out' }, to: { nodeId: 'v-mix', portId: 'in2' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-mix-out',   from: { nodeId: 'v-mix',   portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' },  sourceType: 'video',      targetType: 'video' },
      ],
    );
    const canvas = page.locator(VIDEO_OUT_CANVAS);
    await page.waitForTimeout(500);
    const before = (await readCanvasStats(canvas))!;

    // Cross-fade: drop amount1 to 0, raise amount2 to 1. Different
    // pattern dominates → stats should shift.
    await setNodeParam(page, 'v-mix', 'amount1', 0.0);
    await setNodeParam(page, 'v-mix', 'amount2', 1.0);
    await page.waitForTimeout(500);
    const after = (await readCanvasStats(canvas))!;

    expect(
      statsDiffer(before, after),
      `V-MIXER cross-fade: pre=mean=${before.mean.toFixed(1)},var=${before.variance.toFixed(1)} post=mean=${after.mean.toFixed(1)},var=${after.variance.toFixed(1)}`,
    ).toBe(true);
  });
});

test.describe('module palette: VIDEO grouping + V-MIXER visibility', () => {
  test('palette renders AUDIO + VIDEO domain headers and lists V-MIXER', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Bootstrap the engine + register video module defs (their
    // registration runs on Canvas mount).
    await page.waitForFunction(() => {
      const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
      return typeof w.__ensureEngine === 'function';
    });

    // Open the palette via right-click on the canvas pane (xyflow's
    // background pane catches the contextmenu and Canvas.svelte routes
    // it through onPaneContextMenu → paletteOpen=true).
    const pane = page.locator('.svelte-flow__pane').first();
    await expect(pane).toBeVisible();
    await pane.click({ button: 'right', position: { x: 200, y: 200 } });

    // Nested-palette: Audio modules top row appears before Video modules.
    const audioTop = page.getByTestId('palette-top-audio-modules');
    const videoTop = page.getByTestId('palette-top-video-modules');
    await expect(audioTop, 'Audio modules header rendered').toBeVisible();
    await expect(videoTop, 'Video modules header rendered').toBeVisible();
    const audioBox = await audioTop.boundingBox();
    const videoBox = await videoTop.boundingBox();
    expect(audioBox && videoBox, 'both top headers measured').toBeTruthy();
    if (audioBox && videoBox) {
      expect(audioBox.y, 'Audio modules above Video modules').toBeLessThan(videoBox.y);
    }

    // Drill into Video modules → Utilities to confirm V-MIXER is reachable.
    await videoTop.click();
    await page.getByTestId('palette-sub-utilities').click();
    await expect(
      page.locator('[data-testid="palette-item-videoMixer"]'),
      'V-MIXER appears in palette',
    ).toBeVisible();

    // Other Phase-1 video modules — switch into Sources / Processors via
    // search-mode so we don't have to drill into each sub explicitly.
    // Refocus the search input first (the previous click stole focus).
    await page.locator('.module-palette input').click();
    await page.keyboard.type('LINES');
    await expect(page.locator('[data-testid="palette-item-lines"]')).toBeVisible();
  });
});
