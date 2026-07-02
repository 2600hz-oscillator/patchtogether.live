// e2e/tests/nibbles-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for NIBBLES (plan §5 Layer B), modeled on
// acidwarp-render-smoke.spec.ts.
//
// WHY NIBBLES IS DETERMINISTIC WHEN FROZEN:
// NIBBLES is a `category: 'sources'` video module (no video input) whose game
// only advances on a time-accumulated tick. Its `draw(frame)` derives ALL
// per-frame progression from the engine clock: `dt = frame.time - lastDrawTimeS`.
// With the Phase-0 hooks the engine clock is PINNED (`__videoEngineFreezeTime`),
// so every draw reads the SAME `frame.time` — after the first frame
// `lastDrawTimeS === frame.time`, hence `dt === 0` on every step. With dt=0 the
// tick accumulator (`tickAccumS += dt`) never reaches `tickPeriodS`, so
// `advanceGame()` (the ONLY path that runs the bot / `Date.now()` auto-restart /
// RNG / repaint) NEVER fires under freeze. The shader (`FRAG_SRC`) just blits the
// one CPU framebuffer painted once at factory init — no time/frame/random uniform
// — so the output texture is bit-stable across independent step bursts. Combined
// with the paused rAF loop (`__videoEnginePause` → the test owns the exact frame
// count), this gives a deterministic, non-black, structured frame with zero GL
// errors and an exact engine frame-count delta.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('NIBBLES — deterministic render smoke', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // NIBBLES is a generated SOURCE (no video input) → OUTPUT so it renders.
    // We read NIBBLES's OWN output texture (`out`).
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'nibbles',  position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // First burst: drive a FIXED number of frames synchronously + read once.
    const a = await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (clock still frozen) must produce a
    // BIT-STABLE frame — same mean + variance to a tight epsilon.
    const b = await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
