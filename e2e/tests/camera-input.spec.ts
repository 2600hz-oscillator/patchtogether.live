// e2e/tests/camera-input.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for CAMERA's render path.
//
// WHY THIS REPLACED THE OLD LIVE-STREAM TEST: the previous version spawned
// CAMERA → OUTPUT, kicked off getUserMedia (Chromium's fake device), waited for
// the card's state machine to reach 'streaming', then waitForTimeout(800) and
// sampled the OUTPUT canvas for live frames. That chain depends on THREE
// un-synchronized async clocks — getUserMedia delivery, the card state machine,
// and the rAF render/blit — and under the attest's CUMULATIVE GPU load (Pass C
// runs after the heavy passes have hammered the GPU) the stream stalled past the
// 10s 'streaming' timeout → the test hit its 30s ceiling and the worker tore
// down ("Target page … has been closed"). It passed 10/10 in isolation but
// flaked under load: a classic wall-clock-sampling-of-an-unsynchronized-signal
// flake (the GPU-attest-rebuild target).
//
// This DRS version pins the engine clock + pauses its rAF loop and injects a
// DETERMINISTIC synthetic frame via the module's `__camerainputTestFrame` seam,
// then drives engine.step() a FIXED number of frames synchronously and reads
// CAMERA's OWN output FBO once with gl.readPixels. It exercises the real render
// path (source-texture upload → pass-through shader → gain → cover-scale → FBO)
// with NO dependency on getUserMedia, the 'streaming' state, or rAF timing — so
// it is bit-stable on every run regardless of GPU load. No waitForTimeout, no
// poll, no animation-diff, no exact-pixel assert.
//
// The getUserMedia INTEGRATION coverage (device enumeration, request flow,
// 'streaming' state, local-only hint, 'no-cameras-found') lives in
// camera-input-integration.spec.ts, which runs ONLY in the lighter functional
// (sharded) e2e lane — where the live-stream flow has always been stable — and
// is deliberately OUT of the cumulative-load attest basis.
//
// Runs under the `chromium-camera` Playwright project (camera permission
// pre-granted) so the card's onMount auto-acquire succeeds quietly; the injected
// frame, not the acquired stream, drives the asserted pixels.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

test.describe('CAMERA → OUTPUT (deterministic render smoke)', () => {
  test('injected frame renders through the camera pass to a non-black, frame-stable FBO', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop (the test owns the exact frame count), pin the
    // clock, AND enable the deterministic camera frame — all BEFORE boot so the
    // very first draw uploads the synthetic frame.
    await installRenderSmokeHooks(page);
    await page.addInitScript(() => {
      (window as unknown as { __camerainputTestFrame?: boolean }).__camerainputTestFrame = true;
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video' },
        { id: 'v-out', type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-cam-out',
          from: { nodeId: 'v-cam', portId: 'out' },
          to: { nodeId: 'v-out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-cameraInput'), 'CAMERA visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    // Drive a FIXED burst synchronously (no rAF, no waitForTimeout) so the
    // injected frame uploads + renders, then read CAMERA's OWN output texture.
    // The synthetic checker is dense + saturated → the DEFAULT non-black floor
    // (2%) and variance floor apply (no sparse override needed).
    const a = await stepAndReadStats(page, { nodeId: 'v-cam', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second independent burst (clock still frozen, frame fixed)
    // must produce a frame-stable result — same mean + variance to a tight
    // epsilon. A genuine black/flat regression still fails; driver pixel
    // divergence never trips it.
    const b = await stepAndReadStats(page, { nodeId: 'v-cam', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst also advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen camera output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen camera output variance is frame-stable').toBeLessThan(1.0);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
