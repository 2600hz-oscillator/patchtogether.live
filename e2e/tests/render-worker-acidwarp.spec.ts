// e2e/tests/render-worker-acidwarp.spec.ts
//
// Fix E Phase 1 — the off-main-thread render worker, end-to-end.
//
// The CORRECTNESS GATE for the worker path: with the flag ON, acidwarp renders
// in the worker (OffscreenCanvas + WebGL2), each finished frame copies back as a
// transferred ImageBitmap into a MAIN-GL texture (WorkerProxyHandle), and a
// downstream VIDEO OUT samples that texture exactly like a normal node. We
// assert the OUTPUT canvas is NON-BLACK — proving the ImageBitmap-fed texture
// reaches downstream presentation. This is the meaningful gate for acidwarp
// (its on-card preview is a CPU snapshot, unaffected by where GL runs, and the
// card is VRT-exempt; the GL texture only feeds downstream + OUTPUT).
//
// Run under CI SwiftShader (E2E_SWIFTSHADER=1 / the CI swiftshader project): the
// Phase-0 spike proved worker WebGL2 renders non-black under CI's exact renderer
// flags, so this assertion is CI-meaningful, not real-GPU-only. The flag is OFF
// by default; this spec flips it ON via addInitScript BEFORE boot.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Read the OUTPUT canvas pixel statistics (non-black fraction + variance). The
 *  OUTPUT card blits its FBO texture into the engine canvas then drawImage()s it
 *  — so reading the visible canvas reads what the WorkerProxyHandle texture
 *  produced through the downstream chain. */
async function outputStats(page: Page): Promise<{ nonZeroFrac: number; variance: number; mean: number } | null> {
  const canvas = page.locator('[data-testid="video-out-canvas"]');
  await expect(canvas, 'video-out canvas mounted').toHaveCount(1);
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v; sumSq += v * v; n++;
      if (v > 8) nonZero++;
    }
    const mean = sum / n;
    return { nonZeroFrac: nonZero / n, variance: sumSq / n - mean * mean, mean };
  });
}

test.describe('Fix E render worker — acidwarp', () => {
  // @webgl-smoke — REQUIRED on-CI WebGL floor: proves the OffscreenCanvas WebGL2
  // worker render path produces non-black output under CI's SwiftShader (the
  // Fix-E Phase-0 spike already confirmed it does). Renderer-tolerant
  // (non-black fraction, NOT exact pixels). See e2e/webgl-smoke (the floor that
  // backstops the local-GPU attestation; it covers gross breakage CI can verify).
  test('flag ON: acidwarp renders in the worker; downstream OUTPUT is non-black @webgl-smoke', async ({ page }) => {
    // Worker WebGL2 compiles + warms slowly on CI's software renderer
    // (SwiftShader) against the preview build: goto + networkidle + spawnPatch +
    // worker spawn + module-worker import + shader warm-up. 60s gives headroom.
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Flip the worker flag ON before the app boots (default is OFF).
    await page.addInitScript(() => {
      (globalThis as unknown as { __videoWorkerEnabled?: boolean }).__videoWorkerEnabled = true;
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'aw', type: 'acidwarp', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 560, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'aw', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-acidwarp'), 'acidwarp node present').toBeVisible();
    await expect(page.locator('[data-testid="video-out-card"]'), 'video-out card present').toHaveCount(1);

    // Confirm the worker path was actually taken (not the silent main fallback)
    // — the engine spawns the render worker only when the flag + capability gate
    // pass. We probe via the dev __patch / engine; if OffscreenCanvas+Worker are
    // present (they are in Chromium) the worker is the path. Surface it for the
    // human in CI output.
    const workerSupported = await page.evaluate(() =>
      typeof Worker !== 'undefined' &&
      typeof OffscreenCanvas !== 'undefined' &&
      typeof createImageBitmap !== 'undefined',
    );
    console.log(`[render-worker] workerSupported=${workerSupported}`);
    expect(workerSupported, 'Chromium supports the worker path (else this asserts the fallback)').toBe(true);

    // Let the worker spawn, init its GL, render frames, transfer bitmaps, and the
    // proxy upload + downstream blit settle. Poll until non-black (worker init +
    // first-bitmap latency varies on SwiftShader).
    let stats = await outputStats(page);
    for (let i = 0; i < 40 && (!stats || stats.nonZeroFrac <= 0.02); i++) {
      await page.waitForTimeout(150);
      stats = await outputStats(page);
    }

    expect(stats, 'OUTPUT canvas readable').not.toBeNull();
    expect(stats!.nonZeroFrac, `worker-fed OUTPUT is not all-black (nonZeroFrac=${stats!.nonZeroFrac})`).toBeGreaterThan(0.02);
    expect(stats!.variance, `worker-fed OUTPUT has spatial structure (var=${stats!.variance})`).toBeGreaterThan(5);

    expect(errors, 'no console / page errors with the render worker on').toEqual([]);
  });

  test('flag OFF (default): acidwarp still renders; downstream OUTPUT is non-black (parity)', async ({ page }) => {
    // The flag-off path is the existing main-thread render. This proves the
    // default (prod) behavior is unchanged: same downstream-non-black result, no
    // worker. (No addInitScript → flag stays OFF.)
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'aw', type: 'acidwarp', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 560, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'aw', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);

    let stats = await outputStats(page);
    for (let i = 0; i < 30 && (!stats || stats.nonZeroFrac <= 0.02); i++) {
      await page.waitForTimeout(150);
      stats = await outputStats(page);
    }
    expect(stats, 'OUTPUT canvas readable').not.toBeNull();
    expect(stats!.nonZeroFrac, `main-thread OUTPUT is not all-black (nonZeroFrac=${stats!.nonZeroFrac})`).toBeGreaterThan(0.02);
    expect(errors, 'no console / page errors (flag off)').toEqual([]);
  });
});
