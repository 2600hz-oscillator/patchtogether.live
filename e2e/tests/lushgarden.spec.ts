// e2e/tests/lushgarden.spec.ts
//
// LUSH GARDEN — bespoke behavioral spec for the generative garden video
// source. Everything asserts through the module's deterministic engine
// probes (read('plantCount') / read('spawnCount') — the SHAPEGEN
// regenCount pattern) plus ONE renderer-tolerant preview-pixel check, so
// the assertions survive CI's SwiftShader software renderer.
//
// Coverage:
//   1. Continuous mode: plants spawn at the RATE clock on their own, the
//      cutout atlas loads (manifest + baked textures), and the card
//      preview (the CLEAN composite) renders non-black.
//   2. Gated mode: patching a gate into `grow` latches gated growth (the
//      [GATED] badge appears + continuous spawning STOPS) and each rising
//      edge spawns EXACTLY one plant (count-based, no pixel diffs); a
//      rising edge on `reset` clears the bed (plantCount → 0).
//   3. Background input: an upstream video passes through the CLEAN
//      output even with ZERO plants spawned (coarse non-black pixel count
//      on the VIDEOOUT sink = pixels outside every plant silhouette).
//
// Clock-period note (from shapegen-clock.spec.ts): the sequencer's
// `clock` output fires per STEP = a 16th note (60/bpm/4 seconds). 30 BPM
// → 500 ms period.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Read a numeric lushgarden engine probe via the video-domain read API. */
async function readProbe(page: Page, nodeId: string, key: string): Promise<number> {
  return await page.evaluate(([nodeId, key]) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => {
          read?: (n: string, k: string) => unknown;
        } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    const v = ve?.read?.(nodeId!, key!);
    return typeof v === 'number' ? v : Number.NaN;
  }, [nodeId, key] as const);
}

/** Poll a probe until pred holds or timeout (shapegen-clock pattern). */
async function waitForProbe(
  page: Page,
  nodeId: string,
  key: string,
  pred: (n: number) => boolean,
  timeout = 10000,
): Promise<{ ok: boolean; last: number }> {
  const deadline = Date.now() + timeout;
  let last = await readProbe(page, nodeId, key);
  if (pred(last)) return { ok: true, last };
  while (Date.now() < deadline) {
    await page.waitForTimeout(80);
    last = await readProbe(page, nodeId, key);
    if (pred(last)) return { ok: true, last };
  }
  return { ok: false, last };
}

/** Luma stats of a card canvas (2D readback — SwiftShader-tolerant floors
 *  only; mirrors shapegen.spec.ts / edges.spec.ts readEdgeStats). */
async function readCanvasStats(
  page: Page,
  testid: string,
): Promise<{ nonZeroFrac: number; variance: number }> {
  return await page.evaluate((testid) => {
    const canvas = document.querySelector(
      `canvas[data-testid="${testid}"]`,
    ) as HTMLCanvasElement | null;
    if (!canvas) return { nonZeroFrac: 0, variance: 0 };
    const probe = document.createElement('canvas');
    probe.width = canvas.width;
    probe.height = canvas.height;
    const ctx = probe.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const img = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let nonZero = 0;
    let sum = 0;
    let sumSq = 0;
    const n = probe.width * probe.height;
    for (let i = 0; i < n; i++) {
      const l = 0.299 * img[i * 4]! + 0.587 * img[i * 4 + 1]! + 0.114 * img[i * 4 + 2]!;
      if (l > 8) nonZero++;
      sum += l;
      sumSq += l * l;
    }
    const mean = sum / n;
    return { nonZeroFrac: nonZero / n, variance: sumSq / n - mean * mean };
  }, testid);
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

test.describe('LUSH GARDEN — generative garden source', () => {
  // Heavy WebGL module on CI's software renderer: pause-resume jitter can
  // starve the anchored polls (same guard as shapegen-clock FLAKE #232).
  test.describe.configure({ retries: 2 });

  test('continuous mode: plants spawn at RATE and the clean preview renders non-black', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'lg', type: 'lushgarden', position: { x: 300, y: 100 }, domain: 'video' },
    ]);
    await expect(page.locator('[data-testid="lushgarden-card"]')).toHaveCount(1);
    // No gate patched → no badge.
    await expect(page.locator('[data-testid="lushgarden-gated-badge"]')).toHaveCount(0);

    // Manifest loads, plants spawn on the internal RATE clock (default
    // 2/s), and at least one cutout finishes its texture bake.
    const manifest = await waitForProbe(page, 'lg', 'manifestCount', (n) => n > 0, 15000);
    expect(manifest.ok, `manifest loaded (entries=${manifest.last})`).toBe(true);
    // ≥6 plants (default 2/s → ~3 s) so the pixel floor below has margin
    // even when the random depths land far (small sprites).
    const spawned = await waitForProbe(page, 'lg', 'plantCount', (n) => n >= 6, 20000);
    expect(spawned.ok, `continuous spawning advanced (plantCount=${spawned.last})`).toBe(true);
    const bakedTex = await waitForProbe(page, 'lg', 'readyCount', (n) => n > 0, 15000);
    expect(bakedTex.ok, `at least one cutout baked (readyCount=${bakedTex.last})`).toBe(true);

    // Preview = the CLEAN composite. Renderer-tolerant floors only
    // (SwiftShader): some plant pixels lit + non-flat content.
    await page.waitForTimeout(700); // one grow-in + a few blits
    const stats = await readCanvasStats(page, 'lushgarden-screen');
    expect(stats.nonZeroFrac, `preview lit fraction ${stats.nonZeroFrac}`).toBeGreaterThan(0.005);
    expect(stats.variance, `preview variance ${stats.variance}`).toBeGreaterThan(5);

    expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('grow gate: [GATED] badge, rate-spawning stops, one plant per rising edge, reset clears', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // Two STOPPED sequencers: growSeq → grow, rstSeq → reset. Both idle at
    // spawn so we control exactly when edges arrive. 30 BPM → 500 ms step.
    await spawnPatch(
      page,
      [
        { id: 'lg', type: 'lushgarden', position: { x: 500, y: 100 }, domain: 'video' },
        { id: 'growSeq', type: 'sequencer', position: { x: 100, y: 100 }, domain: 'audio',
          params: { bpm: 30, length: 8, isPlaying: 0 } },
        { id: 'rstSeq', type: 'sequencer', position: { x: 100, y: 380 }, domain: 'audio',
          params: { bpm: 30, length: 8, isPlaying: 0 } },
      ],
      [
        { id: 'e_grow', from: { nodeId: 'growSeq', portId: 'clock' }, to: { nodeId: 'lg', portId: 'grow' },
          sourceType: 'gate', targetType: 'cv' },
        { id: 'e_rst', from: { nodeId: 'rstSeq', portId: 'clock' }, to: { nodeId: 'lg', portId: 'reset' },
          sourceType: 'gate', targetType: 'cv' },
      ],
    );
    await expect(page.locator('[data-testid="lushgarden-card"]')).toHaveCount(1);

    // Badge: the grow edge is wired (regardless of pulses).
    await expect(
      page.locator('[data-testid="lushgarden-gated-badge"]'),
      '[GATED] badge appears when grow is patched',
    ).toBeVisible();

    // The CV bridge writes the (low) gate level every block → gated mode
    // latches even with the sequencer stopped.
    const latched = await waitForProbe(page, 'lg', 'growPatched', (n) => n === 1, 15000);
    expect(latched.ok, 'gated mode latched via the CV bridge').toBe(true);

    // 1. Rate-spawning is OFF: spawnCount must hold over >2 default spawn
    //    periods (default rate 2/s → 500 ms period; hold 1.5 s).
    const before = await readProbe(page, 'lg', 'spawnCount');
    await page.waitForTimeout(1500);
    const after = await readProbe(page, 'lg', 'spawnCount');
    expect(after, 'no continuous spawns while grow is patched').toBe(before);

    // 2. Start the grow clock → spawns advance, one per rising edge. We
    //    anchor on the first observed spawn and verify the count keeps
    //    tracking edges (≥2 more within a few 500 ms periods).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      w.__ydoc.transact(() => {
        const s = w.__patch.nodes['growSeq'];
        if (s) s.params.isPlaying = 1;
      });
    });
    const grew = await waitForProbe(page, 'lg', 'spawnCount', (n) => n >= before + 2, 15000);
    expect(grew.ok, `edge-driven spawns advanced (spawnCount=${grew.last})`).toBe(true);

    // 3. Stop the grow clock → the count freezes again (edge-driven only).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      w.__ydoc.transact(() => {
        const s = w.__patch.nodes['growSeq'];
        if (s) s.params.isPlaying = 0;
      });
    });
    // Absorb any in-flight edge, then anchor.
    await page.waitForTimeout(700);
    const frozen = await readProbe(page, 'lg', 'spawnCount');
    await page.waitForTimeout(1200);
    expect(await readProbe(page, 'lg', 'spawnCount'), 'stopped clock → no more spawns').toBe(frozen);
    expect(frozen).toBeGreaterThanOrEqual(before + 2);

    // 4. RESET: a rising edge clears the bed. plantCount → 0 and STAYS 0
    //    (grow clock stopped + rate-spawning latched off).
    expect(await readProbe(page, 'lg', 'plantCount')).toBeGreaterThan(0);
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      w.__ydoc.transact(() => {
        const s = w.__patch.nodes['rstSeq'];
        if (s) s.params.isPlaying = 1;
      });
    });
    const cleared = await waitForProbe(page, 'lg', 'plantCount', (n) => n === 0, 15000);
    expect(cleared.ok, `reset edge cleared the bed (plantCount=${cleared.last})`).toBe(true);
    expect(await readProbe(page, 'lg', 'resetCount')).toBeGreaterThanOrEqual(1);

    expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('background input passes through the clean output outside plant silhouettes', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // Keep the garden EMPTY (gated mode via a stopped sequencer → zero
    // spawns, ever) so every pixel is "outside a plant silhouette": the
    // VIDEOOUT sink then shows exactly the background passthrough.
    await spawnPatch(
      page,
      [
        { id: 'bg', type: 'acidwarp', position: { x: 100, y: 100 }, domain: 'video',
          params: { speed: 1 } },
        { id: 'lg', type: 'lushgarden', position: { x: 500, y: 100 }, domain: 'video' },
        { id: 'sink', type: 'videoOut', position: { x: 900, y: 100 }, domain: 'video' },
        { id: 'idleSeq', type: 'sequencer', position: { x: 100, y: 380 }, domain: 'audio',
          params: { bpm: 30, length: 8, isPlaying: 0 } },
      ],
      [
        { id: 'e_bg', from: { nodeId: 'bg', portId: 'out' }, to: { nodeId: 'lg', portId: 'background' },
          sourceType: 'video', targetType: 'video' },
        { id: 'e_out', from: { nodeId: 'lg', portId: 'clean' }, to: { nodeId: 'sink', portId: 'in' },
          sourceType: 'video', targetType: 'video' },
        { id: 'e_gate', from: { nodeId: 'idleSeq', portId: 'clock' }, to: { nodeId: 'lg', portId: 'grow' },
          sourceType: 'gate', targetType: 'cv' },
      ],
      { mountTimeout: 30000 },
    );

    // Gated (empty) garden: nothing ever spawns.
    const latched = await waitForProbe(page, 'lg', 'growPatched', (n) => n === 1, 15000);
    expect(latched.ok, 'gated mode latched (empty garden)').toBe(true);
    expect(await readProbe(page, 'lg', 'plantCount')).toBe(0);

    // The VIDEOOUT canvas must show the acidwarp backdrop through the
    // (plantless) clean composite — a large lit fraction, since with zero
    // plants EVERY pixel is outside a silhouette. Coarse floors only.
    await expect
      .poll(async () => (await readCanvasStats(page, 'video-out-canvas')).nonZeroFrac, {
        message: 'background passthrough lights the clean output',
        timeout: 15000,
      })
      .toBeGreaterThan(0.2);
    const stats = await readCanvasStats(page, 'video-out-canvas');
    expect(stats.variance, `backdrop variance ${stats.variance}`).toBeGreaterThan(5);
    expect(await readProbe(page, 'lg', 'plantCount'), 'garden stayed empty').toBe(0);

    expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
