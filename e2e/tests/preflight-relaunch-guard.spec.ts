// NATIVE-SHELL PRE-FLIGHT — THE RELAUNCH BOUNCE + the bind→enter→LIVE leg.
//
// Owner rule: force setup only on FIRST RUN (the shell main-process decides) or
// a MISSING BOUND DEVICE. This proves the renderer half — the `/rack` mount
// guard (rig-relaunch-guard.ts, wired into /rack/+page.svelte): a bound device
// that is now GONE bounces the rack back to /preflight, and a bound device that
// is PRESENT does not (the positive control, doubled as the liveness proof —
// the pre-flight write drives a REAL camera acquisition on the rack).
//
// ⚠ SHELL-ONLY (owner ruling 2026-09-15). The bounce is a native-shell feature;
// every bounce leg boots under the fake shell (`installFakeShell`), and the
// PLAIN-BROWSER leg at the bottom proves the same stale rig never moves /rack —
// the web binds in the rack, and #2374's browser-side bounce stranded dev in a
// /rack → /preflight → enter rack → /preflight loop.
//
// ⚠ LIVENESS, NOT PRESENCE. The positive leg does not assert "cam1 exists"; it
// asserts the reserved slot holds a LIVE MediaStreamTrack whose <video> keeps
// PRESENTING NEW FRAMES (sampled twice, asserted on the second) — the shape a
// wiped binding or a frozen stream fails. ARMED WITH errorWatch.

import { test, expect, type Page } from './_fixtures';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import {
  clearRigStoreOnce,
  installFakeShell,
  seedRigStore,
  installFakeScreens,
  installFakeCameras,
  readRig,
  disposeFakeCameras,
} from '../_helpers/preflight-devices';

const CAM_SLOT = 'slot:cam1';

interface CamSample {
  found: boolean;
  trackState: string | null;
  frames: number;
}
async function sampleLiveCamera(page: Page, nodeId: string): Promise<CamSample> {
  return page.evaluate((id) => {
    const el = document.querySelector(
      `video[data-testid="camera-preview"][data-node-id="${CSS.escape(id)}"]`,
    ) as HTMLVideoElement | null;
    const stream = (el?.srcObject as MediaStream | null) ?? null;
    const track = stream ? stream.getVideoTracks()[0] ?? null : null;
    const q = el as unknown as { getVideoPlaybackQuality?: () => { totalVideoFrames: number } } | null;
    let frames = -1;
    try {
      frames = q?.getVideoPlaybackQuality ? q.getVideoPlaybackQuality().totalVideoFrames : -1;
    } catch {
      frames = -1;
    }
    return { found: !!el && !!stream, trackState: track ? track.readyState : null, frames };
  }, nodeId);
}

async function waitPreflight(page: Page): Promise<void> {
  await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await page.waitForFunction(
    () => (globalThis as unknown as { __preflightReady?: boolean }).__preflightReady === true,
    undefined,
    { timeout: 15_000 },
  );
}

test.describe('PRE-FLIGHT relaunch guard — bound-device-missing bounce', () => {
  test.afterEach(async ({ page }) => {
    await disposeFakeCameras(page);
  });

  test('a bound CAMERA that is gone bounces /rack back to /preflight', async ({ page, errorWatch }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await clearRigStoreOnce(page);
    await installFakeShell(page);
    // The store arrives already-bound to a camera the machine no longer has…
    await seedRigStore(page, { cameras: { cam1: { deviceId: 'gone', deviceLabel: 'Old Cam' } }, outputs: {} });
    // …and the live device list is REAL (a usable entry) but does not contain it.
    await installFakeCameras(page, [{ deviceId: 'other', label: 'Some Other Cam' }]);

    await page.goto('/rack?seed=none');
    // The mount guard positively determines cam1 absent → redirect.
    await page.waitForURL(/\/preflight(\?|$)/, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await waitPreflight(page);
    errorWatch.assertClean();
  });

  test('a bound DISPLAY that is gone bounces /rack back to /preflight', async ({ page, errorWatch }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await clearRigStoreOnce(page);
    await installFakeShell(page);
    await seedRigStore(page, {
      cameras: {},
      outputs: {
        output1: {
          screen: {
            label: 'DELL U2720Q',
            isInternal: false,
            width: 3840,
            height: 2160,
            dpr: 2,
            left: 3024,
            top: 0,
          },
        },
      },
    });
    // Only the internal display is live — the DELL is unplugged.
    await installFakeScreens(page, [
      { label: 'Built-in Retina', isInternal: true, width: 3024, height: 1964, devicePixelRatio: 2 },
    ]);

    await page.goto('/rack?seed=none');
    await page.waitForURL(/\/preflight(\?|$)/, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await waitPreflight(page);
    errorWatch.assertClean();
  });

  test('bind a camera in pre-flight, enter rack, and the slot acquires a LIVE session (no false bounce)', async ({
    page,
    errorWatch,
  }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
    await clearRigStoreOnce(page);
    await installFakeShell(page);
    // Labels visible from the start so the rack's bootstrap auto-acquire fires.
    await installFakeCameras(page, [
      { deviceId: 'cam-a', label: 'Studio Cam A' },
      { deviceId: 'cam-b', label: 'Studio Cam B' },
    ]);

    // Bind cam1 through the REAL pre-flight control.
    await page.goto('/preflight');
    await waitPreflight(page);
    const sel = page.getByTestId('preflight-camera-select').and(page.locator('[data-slot="cam1"]'));
    await sel.selectOption('cam-a');
    await expect
      .poll(async () => ((await readRig(page)).cameras as Record<string, { deviceId?: string }>)?.cam1?.deviceId)
      .toBe('cam-a');

    // Enter the rack (the shell's `preflight.done` window swap). cam1 is bound
    // AND present, so the guard must NOT bounce — instead the store drives a
    // real acquisition of the reserved slot.
    await page.getByTestId('preflight-enter').click();
    await page.waitForURL(/\/rack(\?|$)/, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    // It stayed on the rack (no bounce).
    await expect(page.getByTestId('preflight-panel')).toHaveCount(0);

    // The bound slot acquired a LIVE track…
    await expect
      .poll(async () => (await sampleLiveCamera(page, CAM_SLOT)).trackState, {
        message:
          'the pre-flight camera binding must drive a real acquisition of slot:cam1 on the rack — ' +
          'a dropped binding would leave the slot dark',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe('live');

    // …and keeps PRESENTING FRAMES (sample twice, assert on the second).
    const mid = await sampleLiveCamera(page, CAM_SLOT);
    expect(mid.frames, `frame counter present — ${JSON.stringify(mid)}`).toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => (await sampleLiveCamera(page, CAM_SLOT)).frames, {
        message: 'the acquired camera keeps presenting new frames (not frozen on one)',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBeGreaterThan(mid.frames);
    errorWatch.assertClean();
  });
});

// ── THE PLAIN-BROWSER LEG: the same stale rig never moves /rack ──────────────
test.describe('PRE-FLIGHT relaunch guard — a PLAIN browser never bounces', () => {
  test.afterEach(async ({ page }) => {
    await disposeFakeCameras(page);
  });

  test('gone camera + gone display + an ES-9 binding: /rack mounts and stays', async ({
    page,
    errorWatch,
  }) => {
    test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);
    await clearRigStoreOnce(page);
    // No installFakeShell: `window.ptNative` is absent, as in the owner's browser.
    await seedRigStore(page, {
      cameras: { cam1: { deviceId: 'gone', deviceLabel: 'Old Cam' } },
      outputs: {
        output1: {
          screen: { label: 'DELL U2720Q', isInternal: false, width: 3840, height: 2160, dpr: 2, left: 3024, top: 0 },
        },
      },
      es9: { pushPolicy: 'auto' },
    });
    // The live lists are REAL and usable and lack both devices — the exact
    // evidence the shell guard calls "positively absent".
    await installFakeCameras(page, [{ deviceId: 'other', label: 'Some Other Cam' }]);
    await installFakeScreens(page, [
      { label: 'Built-in Retina', isInternal: true, width: 3024, height: 1964, devicePixelRatio: 2 },
    ]);
    // (The "gathers nothing" half is pinned at the seam by
    // rig-relaunch-guard.test.ts with spies: the rack's OWN present restore and
    // camera bootstrap legitimately call getScreenDetails / enumerateDevices on
    // a mount, so a probe count here would not discriminate the guard. The URL
    // is the signal.)
    const navigations: string[] = [];
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navigations.push(f.url());
    });

    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    // The guard's window is the mount; the device-slot ensure runs AFTER it, so
    // the reserved slots appearing is a later-than-the-guard observable.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
            return !!w.__patch?.nodes['slot:cam1'];
          }),
        { message: 'the rack finished its own boot after the guard had its chance', timeout: SLOW_BOOT_TEST_TIMEOUT_MS },
      )
      .toBe(true);
    await expect(page.getByTestId('preflight-panel')).toHaveCount(0);
    expect(page.url()).toMatch(/\/rack(\?|$)/);
    expect(navigations.filter((u) => /\/preflight/.test(u)), `never navigated to /preflight — ${navigations.join(' → ')}`).toEqual([]);
    // The stale bindings are STILL THERE — nothing wiped them. (cam1 stays a
    // BOUND slot; the rack's own camera core re-acquires and may rewrite the
    // per-session device id under the kept label — the point is that the slot
    // is re-picked in the rack, never bounced to a setup page.)
    const rig = await readRig(page);
    expect((rig.cameras as Record<string, { deviceLabel?: string }>)?.cam1?.deviceLabel).toBe('Old Cam');
    expect(rig.es9).toEqual({ pushPolicy: 'auto' });
    errorWatch.assertClean();
  });
});
