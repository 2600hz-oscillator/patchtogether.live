// e2e/tests/mandleblot-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for MANDLEBLOT — a pure-GL Mandelbrot
// fractal VIDEO SOURCE (no video input; its only input is `zoom_cv`). Modeled
// EXACTLY on spirographs-render-smoke.spec.ts + the shared _render-smoke harness
// (installRenderSmokeHooks / stepAndReadStats / assertRenderStats).
//
// WHY THIS WAS DEFERRED IN PHASE 1 (rendered fully black, nonZeroFrac=0):
//   MANDLEBLOT's DEFAULTS are zoom=0.2 (→ ~10× via jsZoomFromKnob) centred at
//   (-0.7, 0) — that's deep inside the main cardioid, so most of the visible
//   frame is IN-SET. The COLOUR pass renders in-set points as PURE BLACK
//   (`if (iter >= uIterations) col = vec3(0.0)`), so at the default ~10× cardioid
//   view the lit fraction collapses toward zero and the generic DRS template
//   (which spawns with no params) fell under the non-black floor → "all black".
//   Nothing about the module is non-deterministic; the default *view* was the
//   problem.
//
// THE UNBLOCK — set a view that renders structured, non-black fractal content:
//   zoom=0 → 1× (full Mandelbrot set in view), center_x=-0.5, center_y=0,
//   iterations=100. At full zoom-out the boundary fills the frame, so the
//   escape-count distribution is rich and the COLOUR hue ramp lights up a large
//   fraction of the canvas (this is the SAME view mandleblot.spec.ts already
//   proves paints >10% bright pixels, variance in the thousands).
//   color_cycle=0 additionally drops the uTime + log(uZoom) terms out of the hue
//   entirely, so the painted colour does not depend on the clock value AT ALL —
//   belt-and-suspenders determinism on top of the frozen-clock template.
//
// WHY DETERMINISTIC WHEN FROZEN: draw(frame) reads ONLY `frame.time` (→ uTime)
// plus the static params. There is NO frame.timeDelta, NO Math.random()/RNG, NO
// own Date.now()/performance.now(), and NO accumulating per-frame state. Pinning
// the engine clock (__videoEngineFreezeTime) makes uTime identical on every step
// → the shader renders a bit-stable frame; with color_cycle=0 even uTime drops
// out of the output. Combined with the paused rAF loop (__videoEnginePause →
// the test owns the exact frame count), two independent step bursts produce a
// frame-stable result.
//
// PORT: MANDLEBLOT has TWO outputs — `mono_out` (mono-video) and `color_out`
// (the canonical COLOUR surface). We wire + read the COLOUR output (`color_out`).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('MANDLEBLOT — deterministic render smoke', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // MANDLEBLOT is a pure generated SOURCE (no decode/getUserMedia/asset) →
    // OUTPUT so it definitely renders. Spawn with the proven non-black view
    // (zoom=0 full set, centred on the boundary-rich -0.5 framing, color_cycle=0
    // so the painted colour is clock-independent) and read its COLOUR output.
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'mandleblot', position: { x: 100, y: 100 }, domain: 'video',
          params: { zoom: 0, center_x: -0.5, center_y: 0, iterations: 100, color_cycle: 0, rotation: 0 } },
        { id: 'out', type: 'videoOut',   position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'color_out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // First burst: drive a FIXED number of frames synchronously + read once.
    const a = await stepAndReadStats(page, { nodeId: 'm', portId: 'color_out', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (clock still frozen) must produce a
    // frame-stable result — same mean + variance to a tight epsilon.
    const b = await stepAndReadStats(page, { nodeId: 'm', portId: 'color_out', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
