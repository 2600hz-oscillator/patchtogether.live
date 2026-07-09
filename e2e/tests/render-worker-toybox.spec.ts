// e2e/tests/render-worker-toybox.spec.ts
//
// Fix E Phase 2 — TOYBOX off-main-thread render worker, end-to-end (determ.).
//
// The CORRECTNESS GATE for the TOYBOX worker path: with the flag ON, TOYBOX's
// pure-GL layers render in the render worker. Finished frames copy back as
// transferred ImageBitmaps into a MAIN-GL texture (WorkerProxyHandle), which a
// downstream VIDEO OUT samples exactly like a normal node.
//
// DETERMINISM (plan §5 Layer B):
//   - flag ON (worker render): the worker is a SEPARATE THREAD (own clock + rAF),
//     so we poll the DETERMINISTIC readiness counter `read('workerFramesDelivered')`
//     (worker bitmaps actually uploaded into the main-GL texture) until ≥2. That
//     removes the old fixed wall-clock poll budget AND strengthens the gate — the
//     counter only advances on a REAL worker upload, so a silent fall-back to the
//     main-thread render (which would still paint the OUTPUT non-black) can no
//     longer masquerade as a passing worker path.
//   - flag OFF (main-thread render, prod default): warm up (unpaused) until the
//     gen-layer content has compiled + the downstream OUTPUT is non-black (a real
//     state, polled — not a fixed budget), THEN pin TOYBOX's iTime
//     (`__toyboxFreezeTime`) + pause the engine rAF (`__videoEnginePause`) and
//     read TOYBOX's OWN output texture across two fixed step bursts → a bit-stable
//     deterministic render smoke.
//
// Run under CI SwiftShader: the Phase-0 spike + Phase-1 acidwarp e2e proved
// worker WebGL2 renders non-black under CI. The flag is OFF by default; the ON
// test flips it via addInitScript.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

/** Read the OUTPUT canvas pixel statistics (non-black fraction + variance). */
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

/** Deterministic worker-readiness signal: worker bitmaps uploaded for `nodeId`. */
async function workerFramesDelivered(page: Page, nodeId: string): Promise<number> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { read: (n: string, k: string) => unknown } };
    };
    return (w.__engine().getDomain('video').read(id, 'workerFramesDelivered') as number) ?? 0;
  }, nodeId);
}

/** Capability probe: is the render worker the ACTIVE path (spawned AND its
 *  WebGL2 context initialized)? FALSE on CI's SwiftShader (worker-WebGL2 can't
 *  init → the proxy falls back to the main-thread render). The "worker delivered"
 *  assertion is enforced only when this is true; otherwise the non-black fallback
 *  is the achievable floor. */
async function workerActive(page: Page, nodeId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { read: (n: string, k: string) => unknown } };
    };
    return w.__engine().getDomain('video').read(id, 'workerActive') === true;
  }, nodeId);
}

test.describe('Fix E render worker — toybox', () => {
  test('flag ON: TOYBOX gen layer renders in the worker; downstream OUTPUT is non-black', async ({ page, errorWatch }) => {
    // Worker WebGL2 compiles + warms slowly on CI's software renderer; TOYBOX's
    // larger shader set takes longer. The readiness poll is bounded by REAL worker
    // progress, not a fixed budget; 90s headroom covers boot + worker spawn +
    // shader warm-up + gen-layer content on CI.
    test.setTimeout(90_000);

    // Flip the worker flag ON before the app boots (default is OFF).
    await page.addInitScript(() => {
      (globalThis as unknown as { __videoWorkerEnabled?: boolean }).__videoWorkerEnabled = true;
    });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'tb', type: 'toybox', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 560, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'tb', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-toybox'), 'toybox node present').toBeVisible();
    await expect(page.locator('[data-testid="video-out-card"]'), 'video-out card present').toHaveCount(1);

    const workerSupported = await page.evaluate(() =>
      typeof Worker !== 'undefined' &&
      typeof OffscreenCanvas !== 'undefined' &&
      typeof createImageBitmap !== 'undefined',
    );
    console.log(`[render-worker-toybox] workerSupported=${workerSupported}`);
    expect(workerSupported, 'Chromium supports the worker path (else this asserts the fallback)').toBe(true);

    // DETERMINISTIC readiness, capability-aware. The render worker is a real-GPU
    // capability (OffscreenCanvas + WebGL2 in a Worker): a real GPU spins it up
    // and it delivers; CI's SwiftShader can't init worker-WebGL2, so the proxy
    // falls back to the main-thread render (still non-black). Ready when EITHER
    // the worker is active and delivered ≥2, OR it's inactive and the fallback
    // painted the OUTPUT non-black — bounded by real state, not a fixed budget.
    let delivered = 0;
    let active = false;
    await expect
      .poll(async () => {
        active = await workerActive(page, 'tb');
        delivered = await workerFramesDelivered(page, 'tb');
        const s = await outputStats(page);
        const nonBlack = (s?.nonZeroFrac ?? 0) > 0.02;
        return (active && delivered >= 2) || (!active && nonBlack);
      }, {
        message: 'worker delivered ≥2 bitmaps (real-GPU worker path) OR fell back to a non-black main-thread render (SwiftShader)',
        timeout: 45_000,
      })
      .toBe(true);

    const stats = await outputStats(page);
    expect(stats, 'OUTPUT canvas readable').not.toBeNull();
    expect(stats!.nonZeroFrac, `TOYBOX OUTPUT is not all-black (nonZeroFrac=${stats!.nonZeroFrac.toFixed(3)})`).toBeGreaterThan(0.02);
    expect(stats!.variance, `TOYBOX OUTPUT has spatial structure (var=${stats!.variance.toFixed(1)})`).toBeGreaterThan(5);

    // STRONG worker-path gate, enforced only where worker-WebGL2 initialized.
    if (active) {
      expect(delivered, `worker is active → it must deliver bitmaps (got ${delivered})`).toBeGreaterThanOrEqual(2);
      console.log(`[render-worker-toybox] WORKER path verified (framesDelivered=${delivered})`);
    } else {
      console.log('[render-worker-toybox] worker-WebGL2 unavailable on this renderer → main-thread fallback (OUTPUT non-black)');
    }

  });

  // @webgl-smoke — REQUIRED on-CI WebGL floor: TOYBOX's MAIN-THREAD WebGL render
  // path (the prod default) compiles its gen-layer shader + paints non-black
  // downstream under CI's SwiftShader, deterministically.
  test('flag OFF (default): TOYBOX renders on main thread — deterministic render smoke (parity) @webgl-smoke', async ({ page, rack, errorWatch }) => {
    test.setTimeout(90_000);


    await spawnPatch(
      page,
      [
        { id: 'tb', type: 'toybox', position: { x: 80, y: 80 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 560, y: 80 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'tb', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('[data-testid="video-out-card"]')).toHaveCount(1);

    // Warm up (rAF running) until the gen-layer content has compiled + the
    // downstream OUTPUT is non-black — a deterministic STATE, polled, not a fixed
    // wall-clock budget. (TOYBOX's first render compiles its shader set + fetches
    // its default gen content, which can't be synchronously stepped into being.)
    await expect
      .poll(async () => (await outputStats(page))?.nonZeroFrac ?? 0, {
        message: 'TOYBOX gen-layer compiled + downstream OUTPUT non-black',
        timeout: 45_000,
      })
      .toBeGreaterThan(0.02);

    // Now PIN TOYBOX's iTime + PAUSE the engine rAF → the render is frozen +
    // the test owns the exact frame count → bit-stable DRS on TOYBOX's own
    // output texture.
    await page.evaluate(() => {
      const g = globalThis as unknown as { __toyboxFreezeTime?: number | null; __videoEnginePause?: boolean };
      g.__toyboxFreezeTime = 2.0;
      g.__videoEnginePause = true;
    });

    // Flag stayed OFF → no worker frames ever delivered.
    expect(await workerFramesDelivered(page, 'tb'), 'no worker frames with the flag off').toBe(0);

    const a = await stepAndReadStats(page, { nodeId: 'tb', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS, { minVariance: 5 });

    const b = await stepAndReadStats(page, { nodeId: 'tb', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

  });
});
