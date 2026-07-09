// e2e/tests/loopback.spec.ts
//
// LOOPBACK module e2e — the browser-viewport video source
// (getDisplayMedia -> GL texture, crop-to-viewport).
//
// getDisplayMedia CANNOT be granted in headless CI without a real display
// prompt, so — exactly like CAMERA's render-smoke (__camerainputTestFrame) —
// this spec drives a DETERMINISTIC synthetic-frame seam (__loopbackTestFrame):
// the module uploads a fixed gradient+checker frame and derives its crop purely
// from the `crop` PARAM, so the FULL upload -> crop -> letterbox -> gain GL path
// is exercised with NO display prompt, NO getUserMedia, and NO card rAF —
// bit-stable under any load (SwiftShader on CI). All pixel asserts are
// renderer-tolerant floors/deltas.
//
//   1. render smoke      — injected frame renders to a non-black, structured,
//                          frame-stable FBO.
//   2. crop toggle       — crop=1 (viewport sub-rect) vs crop=0 (whole tab)
//                          produce a DIFFERENT mean (the crop path is live).
//   3. recorderbox chain — LOOPBACK.out -> RECORDERBOX.in materializes and
//                          RECORDERBOX receives the frame (its passthrough FBO
//                          renders it), proving the record-the-viewport use case
//                          without needing an H.264 encoder.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 6;

/** Enable the deterministic synthetic-frame seam BEFORE the app boots. */
async function installLoopbackTestFrame(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __loopbackTestFrame?: boolean }).__loopbackTestFrame = true;
  });
}

/** Set a video-module param LOCALLY via the engine (no Y.Doc / reconciler
 *  round-trip) — the direct path the card's `_crop*` push + declared params use.
 *  The engine loop is paused (render-smoke hooks) so the value sticks until the
 *  next manual step. */
async function setVideoParam(
  page: import('@playwright/test').Page,
  nodeId: string,
  paramId: string,
  value: number,
): Promise<void> {
  await page.evaluate(({ nodeId, paramId, value }) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { setParam: (n: string, p: string, v: number) => void } };
    };
    w.__engine().getDomain('video').setParam(nodeId, paramId, value);
  }, { nodeId, paramId, value });
}

test.describe('LOOPBACK (deterministic render smoke)', () => {
  test('injected frame renders through the loopback pass to a non-black, frame-stable FBO', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page);
    await installLoopbackTestFrame(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-loop', type: 'loopback', position: { x: 80, y: 60 }, domain: 'video', params: { crop: 0 } },
        { id: 'v-out', type: 'videoOut', position: { x: 480, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-loop-out',
          from: { nodeId: 'v-loop', portId: 'out' },
          to: { nodeId: 'v-out', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-loopback'), 'LOOPBACK visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT visible').toBeVisible();

    const a = await stepAndReadStats(page, { nodeId: 'v-loop', steps: FIXED_STEPS });
    assertRenderStats(a, FIXED_STEPS);

    // DETERMINISM: a second frozen burst is frame-stable.
    const b = await stepAndReadStats(page, { nodeId: 'v-loop', steps: FIXED_STEPS });
    expect(b.framesDelta, 'second burst advanced the exact frame count').toBe(FIXED_STEPS);
    expect(Math.abs(b.mean - a.mean), `frozen loopback output is frame-stable (mean ${a.mean.toFixed(3)} vs ${b.mean.toFixed(3)})`).toBeLessThan(0.5);
    expect(Math.abs(b.variance - a.variance), 'frozen loopback output variance is frame-stable').toBeLessThan(1.0);

  });

  test('crop toggle changes the output: crop-to-viewport differs from whole-tab', async ({ page, errorWatch }) => {
    test.setTimeout(60_000);

    await installRenderSmokeHooks(page);
    await installLoopbackTestFrame(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // One LOOPBACK node sampling the synthetic frame; toggle `crop` between the
    // two reads via the engine directly. The gradient frame makes whole-tab vs
    // a sub-quadrant differ in mean; the checker keeps both structured.
    await spawnPatch(page, [
      { id: 'v-loop', type: 'loopback', position: { x: 80, y: 60 }, domain: 'video' },
    ]);

    await expect(page.locator('.svelte-flow__node-loopback').first(), 'LOOPBACK visible').toBeVisible();

    await setVideoParam(page, 'v-loop', 'crop', 0); // whole tab
    const full = await stepAndReadStats(page, { nodeId: 'v-loop', steps: FIXED_STEPS });
    await setVideoParam(page, 'v-loop', 'crop', 1); // crop to viewport sub-rect
    const crop = await stepAndReadStats(page, { nodeId: 'v-loop', steps: FIXED_STEPS });

    // Both render real, structured, non-black frames.
    assertRenderStats(full, FIXED_STEPS);
    assertRenderStats(crop, FIXED_STEPS);

    // The crop path is LIVE: windowing a sub-quadrant of the gradient shifts the
    // mean well beyond any renderer tolerance (SwiftShader vs GPU agree on the
    // DELTA even if absolute values drift).
    expect(
      Math.abs(full.mean - crop.mean),
      `crop-to-viewport output differs from whole-tab (full mean ${full.mean.toFixed(2)} vs crop mean ${crop.mean.toFixed(2)})`,
    ).toBeGreaterThan(12);

  });
});

test.describe('LOOPBACK -> RECORDERBOX (real chain)', () => {
  test('LOOPBACK.out -> RECORDERBOX.in materializes and RECORDERBOX receives the frame', async ({ page }) => {
    test.setTimeout(90_000);
    // Track UNCAUGHT exceptions only — RECORDERBOX may log benign encoder-probe
    // / no-H.264 badge info (per recorderbox #687), which is not a failure.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await installRenderSmokeHooks(page);
    await installLoopbackTestFrame(page);

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'v-loop', type: 'loopback', position: { x: 80, y: 60 }, domain: 'video', params: { crop: 0 } },
        { id: 'v-rec', type: 'recorderbox', position: { x: 520, y: 60 }, domain: 'video' },
      ],
      [
        {
          id: 'e-loop-rec',
          from: { nodeId: 'v-loop', portId: 'out' },
          to: { nodeId: 'v-rec', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    await expect(page.locator('.svelte-flow__node-loopback'), 'LOOPBACK visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-recorderbox'), 'RECORDERBOX visible').toBeVisible();

    // RECORDERBOX renders its `in` input into its OWN FBO (monitor + passthrough)
    // each frame. Reading that FBO non-black + structured proves the LOOPBACK
    // frame flowed across the edge — the record-the-viewport chain is live. No
    // H.264 encoder is exercised, so this stays green on CI (SwiftShader, no OS
    // encoder).
    const rec = await stepAndReadStats(page, { nodeId: 'v-rec', steps: FIXED_STEPS });
    assertRenderStats(rec, FIXED_STEPS);

    expect(pageErrors, `uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
  });
});
