// e2e/tests/render-worker-acidwarp.spec.ts
//
// Fix E Phase 1 — the off-main-thread render worker, end-to-end (deterministic).
//
// The CORRECTNESS GATE for the worker path: with the flag ON, acidwarp renders
// in the worker (OffscreenCanvas + WebGL2), each finished frame copies back as a
// transferred ImageBitmap into a MAIN-GL texture (WorkerProxyHandle), and a
// downstream VIDEO OUT samples that texture exactly like a normal node.
//
// DETERMINISM (plan §5 Layer B):
//   - flag OFF (main-thread render): pure DRS — pause the engine rAF + pin the
//     clock, drive a FIXED step count, read acidwarp's OWN output texture once.
//     acidwarp reads `frame.time`, so a frozen clock → a bit-stable frame.
//   - flag ON (worker render): the worker is a SEPARATE THREAD with its own clock
//     + rAF, so the first worker frame can't be synchronously step()'d into
//     existence and its output isn't frozen. Instead we poll a DETERMINISTIC
//     readiness counter — `read('workerFramesDelivered')`, the number of worker
//     bitmaps actually uploaded into the main-GL texture — until ≥2. That both
//     removes the old fixed wall-clock poll budget (the flake) AND strengthens
//     the gate: the counter only advances on a REAL worker upload, so a silent
//     fall-back to main-thread render (which would still paint the OUTPUT
//     non-black) can no longer masquerade as a passing worker path.
//
// Run under CI SwiftShader: the Phase-0 spike proved worker WebGL2 renders
// non-black under CI's exact renderer flags. The flag is OFF by default; the ON
// test flips it via addInitScript BEFORE boot.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

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

/** Deterministic worker-readiness signal: how many worker bitmaps have actually
 *  been uploaded into the main-GL texture for `nodeId` (0 if the worker isn't the
 *  active path / hasn't delivered). */
async function workerFramesDelivered(page: Page, nodeId: string): Promise<number> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { read: (n: string, k: string) => unknown } };
    };
    return (w.__engine().getDomain('video').read(id, 'workerFramesDelivered') as number) ?? 0;
  }, nodeId);
}

test.describe('Fix E render worker — acidwarp', () => {
  // @webgl-smoke — REQUIRED on-CI WebGL floor: proves the OffscreenCanvas WebGL2
  // worker render path produces non-black output under CI's SwiftShader (the
  // Fix-E Phase-0 spike already confirmed it does). Renderer-tolerant (non-black
  // fraction + delivered-frame count, NOT exact pixels).
  test('flag ON: acidwarp renders in the worker; downstream OUTPUT is non-black @webgl-smoke', async ({ page }) => {
    // Worker WebGL2 compiles + warms slowly on CI's software renderer. The
    // readiness poll below is bounded by REAL worker progress, not a fixed
    // budget; 60s headroom covers boot + worker spawn + shader warm-up on CI.
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

    const workerSupported = await page.evaluate(() =>
      typeof Worker !== 'undefined' &&
      typeof OffscreenCanvas !== 'undefined' &&
      typeof createImageBitmap !== 'undefined',
    );
    console.log(`[render-worker] workerSupported=${workerSupported}`);
    expect(workerSupported, 'Chromium supports the worker path (else this asserts the fallback)').toBe(true);

    // DETERMINISTIC readiness: wait until the WORKER has actually delivered ≥2
    // bitmaps through the upload (a real state, polled until true — NOT a fixed
    // time budget). This proves the worker path is live, not the silent
    // main-thread fallback.
    await expect
      .poll(() => workerFramesDelivered(page, 'aw'), {
        message: 'worker delivered ≥2 bitmaps into the main-GL texture',
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(2);

    // Now the worker-fed texture is live → the downstream OUTPUT is non-black +
    // structured. Floors only (the worker clock is unfrozen → frame content
    // varies; renderer-tolerant).
    const stats = await outputStats(page);
    expect(stats, 'OUTPUT canvas readable').not.toBeNull();
    expect(stats!.nonZeroFrac, `worker-fed OUTPUT is not all-black (nonZeroFrac=${stats!.nonZeroFrac})`).toBeGreaterThan(0.02);
    expect(stats!.variance, `worker-fed OUTPUT has spatial structure (var=${stats!.variance})`).toBeGreaterThan(5);

    expect(errors, 'no console / page errors with the render worker on').toEqual([]);
  });

  test('flag OFF (default): acidwarp renders on the main thread — deterministic render smoke (parity)', async ({ page }) => {
    // The flag-off path is the existing main-thread render: prod's default. With
    // no worker, acidwarp reads `frame.time` directly, so a frozen clock + paused
    // rAF make it bit-stable → pure DRS on its OWN output texture.
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);

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

    // Worker flag stayed OFF → workerFramesDelivered must be 0 (no worker path).
    expect(await workerFramesDelivered(page, 'aw'), 'no worker frames with the flag off').toBe(0);

    const a = await stepAndReadStats(page, { nodeId: 'aw', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // Frame-stable across two frozen bursts (the property the old fixed-wait poll
    // lacked).
    const b = await stepAndReadStats(page, { nodeId: 'aw', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors (flag off)').toEqual([]);
  });
});
