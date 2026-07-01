// e2e/tests/lines-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for LINES — a pure-GL procedural mono-video
// SOURCE (category 'sources'; the `fm` mono-video input is a Phase-0 stub the
// shader multiplies by 0.0, so it is never sampled — LINES renders standalone).
//
// WHY THIS IS DETERMINISTIC WHEN FROZEN: draw() derives its ONLY time-varying
// term from the engine clock — `autoPhase = (frame.time * 0.15) % 1` — and feeds
// it into the `uPhase` uniform. There is NO frame.timeDelta read, NO Math.random,
// NO own performance.now()/Date.now(), and NO accumulating state: the shader is a
// pure function of its uniforms, all of which are constant (defaults) except
// uPhase, which is itself a pure function of frame.time. So pinning the engine
// clock (__videoEngineFreezeTime) makes autoPhase constant → every step renders a
// BIT-STABLE frame. Combined with the paused rAF loop (__videoEnginePause → the
// test owns the exact frame count), two independent step bursts produce identical
// luma stats. This follows the ACIDWARP DRS template exactly.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('LINES — deterministic render smoke', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // LINES (a pure procedural source — no decode/getUserMedia/asset) → OUTPUT
    // so it definitely renders. We read LINES's OWN output texture.
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'lines',    position: { x: 100, y: 100 }, domain: 'video' },
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
