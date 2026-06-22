// e2e/tests/camera-input-integration.spec.ts
//
// CAMERA module — getUserMedia INTEGRATION coverage (device enumeration, the
// request-access flow, the 'streaming' state, the local-only hint, and the
// 'no-cameras-found' state). This is the DOM/state-machine half of the CAMERA
// e2e: it exercises the real browser media flow against Chromium's fake video
// device but asserts STATE, not rendered pixels.
//
// WHY IT LIVES IN ITS OWN FILE: the live getUserMedia → 'streaming' flow is
// inherently async/wall-clock and CANNOT be made bit-deterministic the way a
// render can. It is stable in the functional (sharded) e2e lane — which runs
// fresh, lightly loaded workers — but flaked under the WebGL attest's CUMULATIVE
// GPU load (Pass C runs after the heavy passes). So this file is deliberately
// OUT of the attest basis: the attest's camera pass runs only
// camera-input.spec.ts (the deterministic render smoke), while this integration
// spec runs in the sharded lane via the chromium-camera project's testMatch.
//
// The pixel-render coverage that used to live here moved to the deterministic
// `__camerainputTestFrame` smoke in camera-input.spec.ts.
//
// Runs under the `chromium-camera` Playwright project — see playwright.config.ts.
// The fake-camera flag is project-scoped so other tests don't see a synthetic
// webcam.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe('CAMERA → OUTPUT (fake webcam) — getUserMedia integration', () => {
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
