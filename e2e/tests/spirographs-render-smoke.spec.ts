// e2e/tests/spirographs-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for SPIROGRAPHS — a pure generated video
// SOURCE (no video input; only cv inputs). Modeled on the Phase-0 template
// (acidwarp-render-smoke.spec.ts) + the shared _render-smoke harness.
//
// WHY THIS MODULE IS DETERMINISTIC WHEN FROZEN: draw(frame) derives the ENTIRE
// scene from `frame.time` alone — `const timeSec = frame.time` feeds
// resolveSpiros(timeSec), and every per-spiro center comes from the pure,
// closed-form advanceCenter(base, radius, W, H, timeSec) in spirographs-math
// (no accumulation, no per-frame stepping state). The per-spiro home/velocity
// seeds (SPIRO_DRIFT) and starting params (SPIRO_DEFAULTS) are fixed
// module-level CONSTANTS, NOT random. There is NO use of frame.timeDelta,
// Math.random(), Date.now()/performance.now(), or unbounded accumulating state
// (framesElapsed is just a counter and does not affect the drawn pixels). So
// pinning the engine clock (__videoEngineFreezeTime) makes resolveSpiros return
// an IDENTICAL spiro list on every step, and the Canvas2D→texture→shader blit
// renders a bit-stable frame. Combined with the paused rAF loop
// (__videoEnginePause → the test owns the exact frame count), two independent
// step bursts produce a frame-stable result.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('SPIROGRAPHS — deterministic render smoke', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // SPIROGRAPHS is a pure generated SOURCE (no video input) → OUTPUT so it
    // definitely renders. We read SPIROGRAPHS's OWN canonical output texture.
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'spirographs', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out', type: 'videoOut',    position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // First burst: drive a FIXED number of frames synchronously + read once.
    // SPIROGRAPHS draws THIN neon curves on black — legitimately sparse (~0.4%
    // of pixels lit), so the default 2%-non-black floor is wrong here. Lower the
    // non-black floor (bright-line coverage); the variance floor still rejects a
    // flat/black frame (sparse bright lines on black have high luma variance).
    const a = await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS, { minNonZeroFrac: 0.001 });

    // DETERMINISM: a second independent burst (clock still frozen) must produce a
    // frame-stable result — same mean + variance to a tight epsilon.
    const b = await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
