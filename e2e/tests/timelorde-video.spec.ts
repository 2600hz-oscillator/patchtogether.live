// e2e/tests/timelorde-video.spec.ts
//
// LIVE-patch coverage for TIMELORDE's new VIDEO IN / VIDEO OUT jacks + the
// big-display redesign. Claims:
//
//   1. OWL render (no feed): with nothing patched into video_in + the owl ON,
//      the big display canvas renders a non-blank picture (the owner's owl
//      painting) — proving the ~4× display paints. (data-display-mode 'wizard'
//      is the owl-art mode — the enum name predates the owl swap.)
//   2. OWL ↔ VIDEO toggle: patch a self-running video source (ACIDWARP) into
//      video_in and the display flips to the LIVE FEED (data-display-mode goes
//      wizard→video); unpatch and it returns to the owl.
//   3. VIDEO passthrough (in → display → out): TIMELORDE.video_out wired into
//      OUTPUT renders the SAME live feed downstream — proving the cross-domain
//      passthrough is genuine (TIMELORDE can sit inline in a video chain).
//
// The pure decision (feed wins over owl) + the videoSources/write→drawFrame
// handoff are unit-tested in timelorde-wizard.test.ts + timelorde.test.ts; this
// spec proves the real end-to-end wiring through the card's rAF.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';

const TL = 'tl'; // explicit TIMELORDE node id (spawnPatch clears the rack first)

/** Pixel stats for a 2D canvas: variance + the fraction of bright pixels. */
async function canvasStats(
  canvas: Locator,
): Promise<{ variance: number; brightFrac: number } | null> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx || c.width === 0 || c.height === 0) return null;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const n = c.width * c.height;
    let sum = 0, sumSq = 0, bright = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
      sum += v; sumSq += v * v;
      if (v > 16) bright++;
    }
    const mean = sum / n;
    return { variance: sumSq / n - mean * mean, brightFrac: bright / n };
  });
}

/** The TIMELORDE big-display canvas's reported mode (video | wizard | off). */
async function displayMode(page: Page, nodeId: string): Promise<string | null> {
  return page
    .locator(`canvas[data-testid="timelorde-display-${nodeId}"]`)
    .getAttribute('data-display-mode');
}

test.describe('TIMELORDE big display: owl ↔ live video + passthrough', () => {
  test('renders the owl painting when nothing is patched into video_in', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: TL, type: 'timelorde', position: { x: 200, y: 80 }, domain: 'audio', params: { bpm: 240 } }],
      [],
    );

    const display = page.locator(`canvas[data-testid="timelorde-display-${TL}"]`);
    await expect(display, 'big display canvas present').toHaveCount(1);
    // ~4× the old sprite: a large square surface.
    const box = await display.boundingBox();
    expect(box, 'display has a bounding box').toBeTruthy();
    if (box) {
      expect(box.width, 'display is large (≥180px)').toBeGreaterThanOrEqual(180);
      expect(box.height, 'display is large + square-ish').toBeGreaterThanOrEqual(180);
    }

    expect(await displayMode(page, TL)).toBe('wizard');

    // The owl painting fills the display — a non-blank, varying picture.
    await page.waitForTimeout(700);
    const stats = await canvasStats(display);
    expect(stats, 'display pixels readable').not.toBeNull();
    if (stats) {
      expect(stats.brightFrac, `owl lights some pixels (got ${stats.brightFrac})`).toBeGreaterThan(0.01);
      expect(stats.variance, `owl has pixel variance (got ${stats.variance})`).toBeGreaterThan(5);
    }

    expect(errors).toEqual([]);
  });

  test('patching video_in flips the display from the OWL to the LIVE FEED, and back', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // ACIDWARP (self-running video source) + TIMELORDE; patch the feed in.
    const nodes: SpawnNode[] = [
      { id: 'acid', type: 'acidwarp', position: { x: 40, y: 360 }, domain: 'video' },
      { id: TL, type: 'timelorde', position: { x: 420, y: 80 }, domain: 'audio', params: { bpm: 240 } },
    ];
    const edges: SpawnEdge[] = [
      { id: 'e_acid_tl', from: { nodeId: 'acid', portId: 'out' }, to: { nodeId: TL, portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
    ];
    await spawnPatch(page, nodes, edges);

    // Display shows the live feed (the feed wins over the owl).
    await expect
      .poll(() => displayMode(page, TL), { timeout: 4000, message: 'display flips to video' })
      .toBe('video');

    // The feed renders (ACIDWARP plasma → non-blank display pixels).
    await page.waitForTimeout(700);
    const feedStats = await canvasStats(page.locator(`canvas[data-testid="timelorde-display-${TL}"]`));
    expect(feedStats, 'feed pixels readable').not.toBeNull();
    if (feedStats) {
      expect(feedStats.brightFrac, 'live feed lights the display').toBeGreaterThan(0.02);
    }

    // Unpatch the video_in edge → back to the owl.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      if (w.__patch.edges['e_acid_tl']) {
        w.__ydoc.transact(() => { delete w.__patch.edges['e_acid_tl']; });
      }
    });
    await expect
      .poll(() => displayMode(page, TL), { timeout: 4000, message: 'display returns to wizard' })
      .toBe('wizard');

    expect(errors).toEqual([]);
  });

  test('VIDEO OUT passes the live feed through to a downstream OUTPUT (in → display → out)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // ACIDWARP → TIMELORDE.video_in → (display) → TIMELORDE.video_out → OUTPUT.
    const nodes: SpawnNode[] = [
      { id: 'acid', type: 'acidwarp', position: { x: 40, y: 360 }, domain: 'video' },
      { id: TL, type: 'timelorde', position: { x: 380, y: 80 }, domain: 'audio', params: { bpm: 240 } },
      { id: 'vout', type: 'videoOut', position: { x: 760, y: 360 }, domain: 'video' },
    ];
    const edges: SpawnEdge[] = [
      { id: 'e_acid_tl', from: { nodeId: 'acid', portId: 'out' }, to: { nodeId: TL, portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
      { id: 'e_tl_vout', from: { nodeId: TL, portId: 'video_out' }, to: { nodeId: 'vout', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ];
    await spawnPatch(page, nodes, edges);

    // The TIMELORDE card's video_out handle must render (so the passthrough port exists).
    const tlCard = page.locator(`.svelte-flow__node[data-id="${TL}"]`);
    await expect(tlCard.locator('[data-handleid="video_out"]'), 'video_out handle present').toHaveCount(1);

    // The display itself is on the live feed.
    await expect
      .poll(() => displayMode(page, TL), { timeout: 4000, message: 'display is on the feed' })
      .toBe('video');

    // OUTPUT renders the passed-through feed.
    const outCanvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(outCanvas).toHaveCount(1);
    await page.waitForTimeout(1200);
    const stats = await canvasStats(outCanvas);
    expect(stats, 'OUTPUT pixels readable').not.toBeNull();
    if (stats) {
      // A genuine passthrough → the downstream OUTPUT shows a non-blank,
      // varying picture (the ACIDWARP feed TIMELORDE relayed).
      expect(stats.brightFrac, `passthrough lights OUTPUT (got ${stats.brightFrac})`).toBeGreaterThan(0.02);
      expect(stats.variance, `passthrough has variance (got ${stats.variance})`).toBeGreaterThan(5);
    }

    expect(errors).toEqual([]);
  });
});
