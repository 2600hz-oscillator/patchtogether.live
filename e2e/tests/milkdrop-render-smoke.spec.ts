// e2e/tests/milkdrop-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke (DRS) for MILKDROP — the butterchurn (Winamp
// Milkdrop) visualizer. Unlike a pure `frame.time` module, butterchurn keeps its
// OWN internal clock advanced by the `elapsedTime` we pass each frame, so we make
// the frame DETERMINISTIC + CI-faithful by pinning three test seams BEFORE boot:
//
//   * __videoEnginePause / __videoEngineFreezeTime (installRenderSmokeHooks) —
//     the test owns the exact engine frame count.
//   * __milkdropFixedDelta — a fixed per-frame elapsedTime so butterchurn's
//     internal clock advances by a constant step (not jittery wall-clock).
//   * __milkdropTestAudio — feed a fixed synthetic sine into the audio bytes so
//     the visualizer is audio-reactive (guaranteed non-black + structured)
//     without wiring a live source.
//
// The preset pack loads behind a dynamic import(), so we POLL the module's
// read('ready') until the first preset is loaded, THEN drive a fixed number of
// synchronous steps and read MILKDROP's own output FBO once. We assert the DRS
// floors (exact frame delta, FBO readable, zero GL errors, non-black,
// structured) — renderer-tolerant, so a genuine black/flat/GL-error regression
// fails while SwiftShader-vs-real-GPU pixel divergence never trips it.
//
// CAPABILITY-GATED: WebGL2 is required (the whole video engine needs it). On a
// runtime without WebGL2 (shouldn't happen in our CI Chromium, but be safe) the
// test SKIPS rather than failing.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

// Enough steps (× the fixed 50 ms delta = 0.8 s of evolution) for the
// reaction-diffusion default preset to develop visible structure + the synthetic
// waveform to render. butterchurn is multi-pass, so SCALE the timeout by steps
// (CI's SwiftShader software renderer is slow on warp-mesh + blur passes) rather
// than a flat value.
const FIXED_STEPS = 16;

test.describe('MILKDROP — deterministic render smoke (butterchurn)', () => {
  test('freeze + fixed delta + synthetic audio → non-black, structured, zero GL errors', async ({ page }) => {
    // Base budget + per-step cost on the software renderer (multi-pass engine).
    test.setTimeout(45_000 + FIXED_STEPS * 3_000);

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop + pin the clock BEFORE boot…
    await installRenderSmokeHooks(page);
    // …and pin MILKDROP's own determinism seams (fixed butterchurn delta +
    // synthetic audio) the same way (addInitScript before goto).
    await page.addInitScript(() => {
      const g = globalThis as unknown as { __milkdropFixedDelta?: number; __milkdropTestAudio?: boolean };
      g.__milkdropFixedDelta = 0.05; // 50 ms / frame — deterministic clock advance
      g.__milkdropTestAudio = true;  // fixed synthetic sine → audio-reactive frame
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // CAPABILITY PROBE: WebGL2 must be available (the video engine needs it).
    const hasWebgl2 = await page.evaluate(() => {
      try {
        return !!document.createElement('canvas').getContext('webgl2');
      } catch {
        return false;
      }
    });
    test.skip(!hasWebgl2, 'WebGL2 unsupported in this runtime — MILKDROP cannot render');

    // MILKDROP (a generated source) → OUTPUT so it definitely renders; we read
    // MILKDROP's OWN output texture.
    await spawnPatch(
      page,
      [
        { id: 'mk', type: 'milkdrop', position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'out', type: 'videoOut', position: { x: 560, y: 100 }, domain: 'video' },
      ],
      [
        { id: 'e', from: { nodeId: 'mk', portId: 'out' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // The preset pack loads behind a dynamic import() — wait for the first preset
    // to land (read('ready')) before stepping, else the first frames are black.
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as { __engine?: () => { getDomain: (d: string) => { read: (id: string, k: string) => unknown } } };
        try {
          return w.__engine?.().getDomain('video').read('mk', 'ready') === true;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 30_000 },
    );

    // Drive a FIXED number of frames synchronously + read MILKDROP's FBO once.
    const stats = await stepAndReadStats(page, { nodeId: 'mk', steps: FIXED_STEPS });
    assertRenderStats(stats, FIXED_STEPS);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
