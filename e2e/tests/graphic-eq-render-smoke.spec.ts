// e2e/tests/graphic-eq-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for GRAPHIC EQ — the Winamp-style VU-meter
// video OUTPUT. STEREO audio in → 8 log-spaced bands per channel drawn as
// bars/boxes. No video input.
//
// WHY THIS IS DETERMINISTIC WHEN FROZEN: GRAPHIC EQ's draw() has NO time term
// at all — it reads its two AnalyserNodes' frequency data, folds them into
// bands, updates a per-band peak-hold, and emits bar/box geometry. With NO
// audio patched, the analysers read all-zero, the peak-hold caps decay to 0,
// and the only thing rendered is the ALWAYS-ON dim meter frame (the unlit LED
// ladder / dim solid-bar tracks) — a fixed, input-independent grid. So pinning
// the engine clock (__videoEngineFreezeTime) + pausing the rAF loop
// (__videoEnginePause → the test owns the exact frame count) makes every step
// render a BIT-STABLE frame: the dim meter grid. Two independent step bursts
// produce identical luma stats. (The default STYLE = stacked boxes draws the
// full 16-rung dim ladder per band → guaranteed non-black + structured even at
// silence.) Follows the LINES / ACIDWARP DRS template exactly. SwiftShader-
// frugal: 6 fixed steps, renderer-tolerant floors.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('GRAPHIC EQ — deterministic render smoke', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // GRAPHIC EQ standalone → OUTPUT so it definitely renders. We read GRAPHIC
    // EQ's OWN output texture (the always-on dim meter frame, no audio needed).
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'graphicEq', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out', type: 'videoOut',  position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // First burst: drive a FIXED number of frames synchronously + read once.
    const a = await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (clock still frozen, still silent)
    // must produce a BIT-STABLE frame — same mean + variance to a tight epsilon.
    const b = await stepAndReadStats(page, { nodeId: 'm', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
