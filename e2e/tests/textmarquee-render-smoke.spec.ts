// e2e/tests/textmarquee-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for TEXTMARQUEE — a rich-text marquee video
// SOURCE (category 'sources'; its only inputs are cv: scrollX/scrollY/posX/posY,
// no video input). It is DETERMINISTIC under the Phase-0 freeze because every
// per-frame value derives SOLELY from the engine clock `frame.time`:
//   - draw() calls computeDrawOffset({ …, time: frame.time }); the only animated
//     term is scrollOffset(speedKnob, t, …) = wrap(vel * t) with t = frame.time —
//     a pure function of the pinned clock.
//   - `lastTime = frame.time` is stored only as a telemetry read-out; it is NEVER
//     used to compute a delta inside draw().
//   - NO frame.timeDelta, NO Math.random()/RNG, NO performance.now()/Date.now(),
//     NO unbounded accumulator. The default placeholder canvas paints fixed text,
//     so a freshly-spawned node renders a non-black, structured frame.
// So __videoEngineFreezeTime pins t to a constant → the scroll offset is identical
// on every step, and combined with __videoEnginePause (the test owns the exact
// frame count) two independent step bursts produce a BIT-STABLE frame.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('TEXTMARQUEE — deterministic render smoke', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // TEXTMARQUEE is a pure generated SOURCE (renders its default placeholder
    // text canvas with no card/decode/getUserMedia) → OUTPUT so it definitely
    // renders. We read TEXTMARQUEE's OWN output texture.
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'textmarquee', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out', type: 'videoOut',    position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // First burst: drive a FIXED number of frames synchronously + read once.
    // TEXTMARQUEE renders bright text glyphs on black — legitimately sparse, so
    // the default 2%-non-black floor is wrong. Lower the non-black floor; the
    // variance floor still rejects a flat/black frame (text on black is high
    // luma variance).
    const a = await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS, { minNonZeroFrac: 0.001 });

    // DETERMINISM: a second independent burst (clock still frozen) must produce a
    // BIT-STABLE frame — same mean + variance to a tight epsilon.
    const b = await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
