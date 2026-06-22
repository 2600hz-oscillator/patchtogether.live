// e2e/tests/vfpga-runner-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for the vfpga-runner HOST module (plan §5
// Layer B; template = acidwarp-render-smoke.spec.ts + _render-smoke.ts).
//
// SOURCE: vfpga-runner is a `category: 'sources'` HOST. On a fresh spawn (no
// node.data.vfpga) it loads DEFAULT_VFPGA_ID = 'smpte-bars', a PURE PATTERN
// GENERATOR (videoIn: 0, videoOut: 1) — it produces a frame from nothing, so we
// wire its OWN output (vout1) → OUTPUT and read vout1.
//
// WHY DETERMINISTIC WHEN FROZEN: under the Phase-0 hooks the engine pins
// frame.time (__videoEngineFreezeTime) and pauses the rAF loop
// (__videoEnginePause), so frame.frame/frameCount advance ONLY per test step.
// The vfpga-runner draw() loop derives every per-frame value from frozen/static
// inputs:
//   - setAllUniforms writes uTime = frame.time (PINNED) + uResolution (constant);
//     all other uniforms come from spec consts / param-slot defaults / cvRoles /
//     gateRoles, every one of which is a static param default here (no knob, no
//     patched CV/gate). No frame.timeDelta, no Math.random, no own
//     performance.now()/Date.now(), no wall-clock accumulation.
//   - the default smpte-bars FRAG is purely SPATIAL — it ignores uTime entirely
//     (the colour math reads only vUv + the static uShift/uBrightness/uSaturation
//     uniforms), so the rendered frame is bit-identical step to step.
//   - tickGates() only bumps a count on a rising gate edge; gates are unpatched
//     (synthetic gN_evt default 0), so nothing accumulates.
//   - swapRegisters() runs only when the effect declares registers; smpte-bars is
//     a single-pass generator with NONE, so there is no ping-pong feedback state.
// => two independent step bursts produce a frame-stable result.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('vfpga-runner — deterministic render smoke', () => {
  test('freeze + pause + synchronous step → non-black, structured, frame-stable, zero GL errors', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // vfpga-runner defaults to the smpte-bars generator (0 video in) → OUTPUT so
    // it definitely renders. We read the module's OWN output texture (vout1).
    await spawnPatch(
      page,
      [
        { id: 'm',   type: 'vfpgaRunner', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out', type: 'videoOut',    position: { x: 540, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'm', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // First burst: drive a FIXED number of frames synchronously + read vout1 once.
    const a = await stepAndReadStats(page, { nodeId: 'm', portId: 'vout1', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (clock still frozen) must produce a
    // frame-stable result — same mean + variance to a tight epsilon.
    const b = await stepAndReadStats(page, { nodeId: 'm', portId: 'vout1', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
