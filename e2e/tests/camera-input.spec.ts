// e2e/tests/camera-input.spec.ts
//
// CAMERA module e2e — TWO describes, ONE file, split by load profile:
//
//   1. "deterministic render smoke" (UNTAGGED) — the GPU render path. This is
//      what the WebGL attest's Pass C runs (Pass C selects this file with a
//      `--grep-invert @camera-integration`, so only this describe attests).
//
//   2. "@camera-integration" (TAGGED) — the getUserMedia integration (device
//      enumeration, request flow, 'streaming' state, local-only hint,
//      'no-cameras-found'). The attest GREP-INVERTS this tag, so it runs ONLY in
//      the lighter functional (sharded) e2e lane, NOT in the cumulative-load
//      attest. (It must stay in THIS file rather than a new file because the
//      chromium-camera project's testMatch is `camera-input.spec.ts` and adding
//      a new file there would edit playwright.config.ts — which is in the collab
//      attest basis, forcing an unrelated collab re-attest.)
//
// WHY THE RENDER TEST IS DETERMINISTIC: the old render test depended on the LIVE
// getUserMedia → 'streaming' → rAF-render chain (three un-synchronized async
// clocks). It passed 10/10 in isolation but stalled past its 'streaming' timeout
// under Pass C's CUMULATIVE GPU load → 30s ceiling → "Target page has been
// closed", and the retries=1 backstop didn't recover it (the GPU-attest-rebuild
// flake). The render smoke now pins the engine clock + pauses its rAF loop and
// injects a DETERMINISTIC synthetic frame via the module's `__camerainputTestFrame`
// seam, then drives engine.step() a FIXED burst and reads CAMERA's own FBO once —
// no getUserMedia, no 'streaming', no rAF timing → bit-stable under any load.
//
// The live getUserMedia → 'streaming' flow is inherently async/wall-clock and
// CANNOT be made bit-deterministic; it belongs in the light sharded lane (where
// it's always been stable), NOT in the GPU attest. Hence the tag split.
//
// Runs under the `chromium-camera` Playwright project (camera permission
// pre-granted) so the card's onMount auto-acquire succeeds quietly.

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

// The attest GREP-INVERTS "@camera-integration" (see scripts/webgl-attest.ts
// Pass C), so everything in this describe runs ONLY in the functional lane.
test.describe('CAMERA → OUTPUT (fake webcam) — getUserMedia integration @camera-integration', () => {
  test('enumerates the fake device, reaches streaming, and shows the local-only hint', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
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

    // The device dropdown should populate from enumerateDevices on mount.
    // With the fake-device flag, Chromium emits at least one virtual
    // 'videoinput' entry. Wait for it to land before clicking Request.
    const select = page.locator('[data-testid="camera-device-select"]');
    await expect(select).toBeVisible();
    // Give the async refreshDevices() a beat to populate options.
    await page.waitForFunction(() => {
      const el = document.querySelector(
        '[data-testid="camera-device-select"]',
      ) as HTMLSelectElement | null;
      return el ? el.options.length > 0 : false;
    }, undefined, { timeout: 5_000 });

    // Under Chromium's --use-fake-ui-for-media-stream + camera permission
    // pre-granted (project-level), the card's onMount auto-acquire fires
    // because labels are visible immediately and node.params.enabled is 1
    // by default. So the state machine may already be 'streaming' before
    // we get here, OR still 'idle'. Handle both: click Request Access if
    // visible, then wait for streaming. (If it's not visible, we're
    // already in streaming/paused/etc.)
    const requestBtn = page.locator('[data-testid="camera-request-access"]');
    // Only click when the button is actually ENABLED. On a fast machine the
    // onMount auto-acquire has often already fired by the time we get here, so
    // the button is rendered DISABLED and about to detach (it swaps to
    // Pause/Resume) — a force-click then races the detach and hangs the full
    // 30s ("element was detached from the DOM, retrying"). A disabled button
    // means streaming is already on its way, so skip the click and fall through
    // to the streaming wait. The .catch() covers the residual detach-mid-click
    // race when the button WAS enabled at check time.
    if (
      (await requestBtn.count()) > 0 &&
      (await requestBtn.isVisible().catch(() => false)) &&
      (await requestBtn.isEnabled().catch(() => false))
    ) {
      await requestBtn.click({ noWaitAfter: true }).catch(() => {
        /* auto-acquire detached the button — streaming is already starting */
      });
    }

    // Wait for the state machine to reach 'streaming'.
    const status = page.locator('[data-testid="camera-status"]');
    await expect(status).toHaveAttribute('data-state', 'streaming', {
      timeout: 10_000,
    });

    // Local-only hint must be visible while streaming. The CAMERA stream
    // is not multiplayer-streamed (deferred to a future phase — see
    // .myrobots/plans/module-camera-input.md); the in-card text keeps
    // user expectations honest.
    const localOnlyHint = page.locator('[data-testid="camera-local-only-hint"]');
    await expect(localOnlyHint, 'local-only hint visible while streaming').toBeVisible();
    await expect(localOnlyHint).toContainText(/local only/i);
    await expect(localOnlyHint).toContainText(/won't see/i);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('shows "no cameras" if enumerateDevices returns empty', async ({ page }) => {
    // Override navigator.mediaDevices.enumerateDevices BEFORE any module
    // mounts so the CAMERA card sees an empty device list. Verifies the
    // 'no-cameras-found' state is reachable from the UI without us
    // having to disable the fake-camera flag at the browser level.
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md) return;
      const orig = md.enumerateDevices.bind(md);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (md as any).enumerateDevices = async () => {
        const all = await orig();
        // Strip videoinput entries to simulate no camera.
        return all.filter((d) => d.kind !== 'videoinput');
      };
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'v-cam', type: 'cameraInput', position: { x: 80, y: 60 }, domain: 'video' },
    ]);

    const status = page.locator('[data-testid="camera-status"]');
    await expect(status).toHaveAttribute('data-state', 'no-cameras-found', {
      timeout: 5_000,
    });
  });
});
