// e2e/tests/inwards-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for INWARDS — a pure-GL procedural SOURCE
// (concentric inward-zooming rings; category "sources", no video input — only
// per-param CV). Its draw() animates SOLELY off `frame.time`: the fragment
// shader's only time term is `phase = r*uDensity - uTime*uSpeed`, where uTime =
// frame.time and the params are static defaults (no CV driven here). There is no
// `frame.timeDelta`, no Math.random(), no own performance.now()/Date.now(), and
// no accumulating state. So PINNING the engine clock (`__videoEngineFreezeTime`)
// makes uTime constant → the shader renders an IDENTICAL frame on every step,
// and PAUSING the rAF loop (`__videoEnginePause`) lets the test own the exact
// frame count. This is the same `frame.time`-only pattern ACIDWARP proves.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('INWARDS — deterministic render smoke', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // INWARDS is a pure generated source (no decode / getUserMedia / asset) → OUTPUT
    // so it definitely renders. We read INWARDS's OWN output texture.
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'inwards',  position: { x: 100, y: 100 }, domain: 'video' },
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
