// e2e/tests/mandelbulb-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for MANDELBULB — a pure-GL ray-marched 3D
// fractal VIDEO SOURCE (no video input; all inputs are CV). It is DETERMINISTIC
// under the Phase-0 freeze hooks for the SAME reason ACIDWARP is: every per-frame
// animation term derives SOLELY from the engine clock (`frame.time`), which the
// hooks PIN via `__videoEngineFreezeTime`.
//
// In draw():
//   - tNow = frame.time  (pinned constant when frozen)
//   - dt   = lastTime < 0 ? 0 : max(0, tNow - lastTime)  → 0 on every step
//            (first step: lastTime=-1 → 0; later steps: tNow-tNow = 0)
//   - autospin (default ON) accumulates spinPhase += dt * AUTOSPIN_RATE, but
//     dt == 0 while frozen, so spinPhase never advances → rotY stays constant.
//   - the scene-dirty throttle's signature is built only from params
//     (eyeDist/rotX/rotY/power/iter/hue) — all constant when frozen — so after
//     the first render every later step short-circuits, leaving an IDENTICAL
//     frame in the FBO.
// There is NO use of frame.timeDelta (real wall-clock), NO Math.random / RNG, NO
// own performance.now()/Date.now(), and NO accumulating state independent of
// frame.time. Pinning the clock therefore makes the shader render a BIT-STABLE
// frame on every step. Combined with the paused rAF loop (`__videoEnginePause`,
// so the test owns the exact frame count) this is the standard DRS shape.
//
// MANDELBULB defaults `screen_on=1` (SCRN perf gate ON) so the raymarch runs even
// though we also patch its OUTPUT (video_out → videoOut.in), and the module's
// OUTPUT port id is `video_out` (not the bare `out`), so we read that port.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('MANDELBULB — deterministic render smoke', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // MANDELBULB is a pure generated SOURCE (no decode/getUserMedia/asset) → OUTPUT
    // so it definitely renders. We read MANDELBULB's OWN output texture (video_out).
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'mandelbulb', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out', type: 'videoOut',   position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'video_out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // First burst: drive a FIXED number of frames synchronously + read once.
    const a = await stepAndReadStats(page, { nodeId: 'm', portId: 'video_out', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (clock still frozen) must produce a
    // BIT-STABLE frame — same mean + variance to a tight epsilon.
    const b = await stepAndReadStats(page, { nodeId: 'm', portId: 'video_out', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
