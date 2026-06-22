// e2e/tests/acidwarp-render-smoke.spec.ts
//
// PHASE-0 PROOF of the deterministic render-smoke (DRS) pattern (plan §6 Phase 0
// + §5 Layer B). ACIDWARP is a pure-GL `frame.time`-animated SOURCE: it reads
// the engine clock directly (`tNow = frame.time`; `dt = tNow - lastTime`), so
// PINNING the engine clock (`__videoEngineFreezeTime`) makes dt=0 → the scene
// cycler halts and the shader renders an IDENTICAL frame on every step. Combined
// with the paused rAF loop (`__videoEnginePause` → the test owns the exact frame
// count), this proves the whole foundation:
//   - freeze + pause + synchronous step + readPixels-once = a deterministic frame
//   - the engine-level frame-count DELTA is exactly the steps we drove
//   - NO waitForTimeout, NO poll, NO animation-diff — and (the determinism check
//     below) two independent step bursts produce a BIT-STABLE frame.
//
// This is the template every animated GPU module's DRS follows (Phase 1+).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('ACIDWARP — deterministic render smoke (Phase-0 foundation proof)', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // ACIDWARP (a pure generated source — no decode/getUserMedia/asset) → OUTPUT
    // so it definitely renders. We read ACIDWARP's OWN output texture.
    await spawnPatch(
      page,
      [
        { id: 'aw',  type: 'acidwarp', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'aw', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // First burst: drive a FIXED number of frames synchronously + read once.
    const a = await stepAndReadStats(page, { nodeId: 'aw', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (clock still frozen) must produce a
    // BIT-STABLE frame — same mean + variance to a tight epsilon. This is the
    // property the wall-clock pattern lacked (it sampled a moving target).
    const b = await stepAndReadStats(page, { nodeId: 'aw', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
