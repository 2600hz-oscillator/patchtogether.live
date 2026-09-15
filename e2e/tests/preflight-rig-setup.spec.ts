// NATIVE-SHELL STAGE-1 PRE-FLIGHT — the per-slot rig setup panel, driven end to
// end through TEST DOUBLES (never real hardware). Each device class is a row
// that (1) renders LIVE presence from its double and (2) writes the per-machine
// rig store when a device is picked. The store write is asserted via the
// `__rigBindings` hook the /preflight route publishes under testHooksEnabled().
//
// ⚠ /preflight IS SHELL-ONLY (owner ruling 2026-09-15): the web binds every
// device IN THE RACK, so a plain browser is redirected to /rack before the
// page mounts. Every row test therefore boots under the fake shell
// (`installFakeShell` — `window.ptNative` with the bridge-backed rig store
// persisted like electron-store, and `preflight.done` performing the window
// swap), and the PLAIN-BROWSER leg at the bottom proves the redirect.
//
// Covered here (the shell's rows + the launch swap + pre-flight persistence):
//   * displays  → getScreenDetails double → setOutput
//   * cameras   → enumerateDevices/getUserMedia double → setCamera (+ the grant
//                 gesture that de-redacts labels)
//   * push2 / launchpad / ptz → the shared WebMIDI double (installMidiDeviceMock),
//                 named so the real device modules' presence predicates match
//   * gamepad   → navigator.getGamepads double → setGamepad
//   * the panel SCROLLS on a short shell window
//   * enter rack → preflight.done → /rack; a bind SURVIVES a reload (the
//                 bridge store, persisted)
//   * a PLAIN BROWSER never sees the page: /preflight lands on /rack
//
// The ES-9 / PTZ HELPER presence, the retryable retry affordance and the
// electron-store round-trip are shell concerns — they live in
// preflight-shell-helpers.spec.ts (renderer lane) and
// apps/desktop/e2e/preflight-helpers.spec.ts (Tier-A). The bound-device-MISSING
// bounce and the bind→enter→LIVE-camera leg live in preflight-relaunch-guard.spec.ts.
//
// ARMED WITH errorWatch (the page-error guard every shell/face spec carries).

import { test, expect, type Page } from './_fixtures';
import { installMidiDeviceMock } from '../_helpers/midi';
import {
  clearRigStoreOnce,
  installFakeShell,
  FAKE_SHELL_SWAP_KEY,
  installFakeScreens,
  installFakeCameras,
  installFakeGamepad,
  readRig,
  disposeFakeCameras,
  type FakeScreen,
} from '../_helpers/preflight-devices';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

const SCREENS: FakeScreen[] = [
  { label: 'Built-in Retina', isInternal: true, width: 3024, height: 1964, devicePixelRatio: 2 },
  { label: 'DELL U2720Q', width: 3840, height: 2160, devicePixelRatio: 2, left: 3024 },
];
const DELL_OPTION = 'DELL U2720Q · 3840×2160';

const CAMERAS = [
  { deviceId: 'cam-a', label: 'Studio Cam A' },
  { deviceId: 'cam-b', label: 'Studio Cam B' },
];

// Named to match the real device modules' presence predicates: push2 wants a
// "push 2" Live port, launchpad an "lpmini/mk3" MIDI (not DAW/session) port, ptz
// a "PT-PTZ*" output.
const MIDI_OUTPUTS = [
  { id: 'push2-out', name: 'Ableton Push 2 Live Port' },
  { id: 'lp-out', name: 'LPMiniMK3 MIDI Out' },
  { id: 'ptz-out', name: 'PT-PTZ-CAM1' },
];
const MIDI_INPUTS = [
  { id: 'push2-in', name: 'Ableton Push 2 Live Port' },
  { id: 'lp-in', name: 'LPMiniMK3 MIDI In' },
  { id: 'ptz-in', name: 'PT-PTZ-CAM1' },
];

async function gotoPreflight(page: Page): Promise<void> {
  await page.goto('/preflight');
  await expect(page.getByTestId('preflight-panel')).toBeVisible();
  await page.waitForFunction(
    () => (globalThis as unknown as { __preflightReady?: boolean }).__preflightReady === true,
    undefined,
    { timeout: 15_000 },
  );
}

test.describe('STAGE-1 pre-flight — per-slot rig setup', () => {
  test.beforeEach(async ({ page }) => {
    await clearRigStoreOnce(page);
    await installFakeShell(page);
    await installFakeScreens(page, SCREENS);
    await installFakeCameras(page, CAMERAS, { labelsRedactedUntilGrant: true });
    await installMidiDeviceMock(page, { outputs: MIDI_OUTPUTS, inputs: MIDI_INPUTS });
  });
  test.afterEach(async ({ page }) => {
    await disposeFakeCameras(page);
  });

  test('DISPLAYS: detect lists screens; picking one writes setOutput', async ({ page, errorWatch }) => {
    await gotoPreflight(page);
    const row = page.getByTestId('preflight-output-select').and(page.locator('[data-slot="output1"]'));

    // Before detect, no live screens are listed (only "none").
    await expect(row.locator('option')).toHaveCount(1);
    await page.getByTestId('preflight-displays-detect').click();
    // The Window-Management double resolves both screens.
    await expect(row.locator('option')).toHaveCount(3);

    await row.selectOption({ label: DELL_OPTION });
    await expect
      .poll(async () => ((await readRig(page)).outputs as Record<string, { screen?: { label?: string } }>)?.output1?.screen?.label, {
        message: 'picking a display writes rigBindings().setOutput(output1, {screen})',
      })
      .toBe('DELL U2720Q');
    // Presence reflects the live resolution.
    await expect(
      page.getByTestId('preflight-output-presence').and(page.locator('[data-slot="output1"]')),
    ).toHaveAttribute('data-state', 'ok');
    errorWatch.assertClean();
  });

  test('CAMERAS: the grant gesture de-redacts labels; picking one writes setCamera', async ({ page, errorWatch }) => {
    await gotoPreflight(page);
    const sel = page.getByTestId('preflight-camera-select').and(page.locator('[data-slot="cam2"]'));

    // Pre-grant: the devices enumerate but labels are redacted (real-browser
    // shape), so the option falls back to a truncated id.
    await expect(sel.locator('option', { hasText: /camera cam-a/i })).toHaveCount(1);

    // The grant gesture (getUserMedia) unlocks labels → real names appear.
    await page.getByTestId('preflight-cameras-grant').click();
    await expect(sel.locator('option', { hasText: 'Studio Cam A' })).toHaveCount(1);

    await sel.selectOption('cam-b');
    await expect
      .poll(async () => ((await readRig(page)).cameras as Record<string, { deviceId?: string; deviceLabel?: string }>)?.cam2, {
        message: 'picking a camera writes rigBindings().setCamera(cam2, {deviceId, deviceLabel})',
      })
      .toEqual({ deviceId: 'cam-b', deviceLabel: 'Studio Cam B' });
    await expect(
      page.getByTestId('preflight-camera-presence').and(page.locator('[data-slot="cam2"]')),
    ).toHaveAttribute('data-state', 'ok');
    errorWatch.assertClean();
  });

  test('PUSH 2: enable MIDI lists the Live port; picking it writes setPush', async ({ page, errorWatch }) => {
    await gotoPreflight(page);
    await page.getByTestId('preflight-push2-connect').click();
    const sel = page.getByTestId('preflight-push2-select');
    await expect(sel.locator('option', { hasText: 'Ableton Push 2 Live Port' })).toHaveCount(1);

    await sel.selectOption({ label: 'Ableton Push 2 Live Port' });
    await expect
      .poll(async () => ((await readRig(page)).push as { deviceId?: string })?.deviceId, {
        message: 'picking Push 2 writes rigBindings().setPush({deviceId})',
      })
      .toEqual(expect.any(String));
    await expect(page.getByTestId('preflight-push2-presence')).toHaveAttribute('data-state', 'ok');
    errorWatch.assertClean();
  });

  test('LAUNCHPAD: pick the port + a MODE writes setLaunchpad', async ({ page, errorWatch }) => {
    await gotoPreflight(page);
    await page.getByTestId('preflight-launchpad-connect').click();
    const sel = page.getByTestId('preflight-launchpad-select');
    await expect(sel.locator('option', { hasText: /LPMiniMK3/ })).toHaveCount(1);

    await sel.selectOption({ index: 1 });
    await expect
      .poll(async () => ((await readRig(page)).launchpad as { deviceId?: string; mode?: string })?.deviceId, {
        message: 'picking a Launchpad writes rigBindings().setLaunchpad({deviceId, mode})',
      })
      .toEqual(expect.any(String));

    // The MODE select is the second control on the row and writes the mode
    // without disturbing the device.
    await page.getByTestId('preflight-launchpad-mode').selectOption('out-to-launch');
    await expect
      .poll(async () => ((await readRig(page)).launchpad as { mode?: string })?.mode)
      .toBe('out-to-launch');
    await expect(page.getByTestId('preflight-launchpad-presence')).toHaveAttribute('data-state', 'ok');
    errorWatch.assertClean();
  });

  test('PTZ: enable MIDI lists the PT-PTZ port; picking it writes setPtz', async ({ page, errorWatch }) => {
    await gotoPreflight(page);
    await page.getByTestId('preflight-ptz-connect').click();
    const sel = page.getByTestId('preflight-ptz-select');
    await expect(sel.locator('option', { hasText: 'PT-PTZ-CAM1' })).toHaveCount(1);

    await sel.selectOption('PT-PTZ-CAM1');
    await expect
      .poll(async () => ((await readRig(page)).ptz as { deviceId?: string })?.deviceId, {
        message: 'picking a PTZ port writes rigBindings().setPtz({deviceId})',
      })
      .toBe('PT-PTZ-CAM1');
    await expect(page.getByTestId('preflight-ptz-presence')).toHaveAttribute('data-state', 'ok');
    errorWatch.assertClean();
  });

  test('GAMEPAD: a connected pad shows presence; picking it writes setGamepad', async ({ page, errorWatch }) => {
    await gotoPreflight(page);
    await installFakeGamepad(page, { id: 'Xbox Wireless Controller (STD STUB)', index: 0 });

    // The poll (gamepadconnected + interval) sees the injected pad → presence.
    await expect
      .poll(async () => page.getByTestId('preflight-gamepad-presence').getAttribute('data-state'))
      .not.toBe('idle');
    const sel = page.getByTestId('preflight-gamepad-select');
    await expect(sel.locator('option', { hasText: /Xbox/ })).toHaveCount(1);

    await sel.selectOption('0');
    await expect
      .poll(async () => (await readRig(page)).gamepad, {
        message: 'picking a gamepad writes rigBindings().setGamepad({id, index})',
      })
      .toEqual({ id: 'Xbox Wireless Controller (STD STUB)', index: 0 });
    await expect(page.getByTestId('preflight-gamepad-presence')).toHaveAttribute('data-state', 'ok');
    errorWatch.assertClean();
  });

  test('the panel SCROLLS on a short shell window — every row and ENTER stay reachable', async ({ page, errorWatch }) => {
    // The owner could not scroll the page and had to shrink the window:
    // global.css pins `html, body { overflow: hidden }` for the rack canvas, so
    // the panel must be its own scroll container. A viewport far shorter than
    // the eight sections is the shape that clipped.
    await page.setViewportSize({ width: 900, height: 420 });
    await gotoPreflight(page);
    const panel = page.getByTestId('preflight-panel');
    const metrics = await panel.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(metrics.scrollHeight, 'the content is taller than the viewport (the scenario)').toBeGreaterThan(metrics.clientHeight);
    expect(metrics.overflowY).toBe('auto');
    // A wheel gesture over the panel actually moves it (the body cannot scroll).
    await panel.hover();
    await page.mouse.wheel(0, 4000);
    await expect
      .poll(() => panel.evaluate((el) => el.scrollTop), { message: 'the panel scrolled under the wheel' })
      .toBeGreaterThan(0);
    // The ENTER button — the very last row — is clickable without resizing.
    const enter = page.getByTestId('preflight-enter');
    await enter.scrollIntoViewIfNeeded();
    await expect(enter).toBeInViewport();
    errorWatch.assertClean();
  });

  test('enter rack hands off through preflight.done and lands on /rack (an unbound rig does not bounce)', async ({ page, errorWatch }) => {
    await gotoPreflight(page);
    await page.getByTestId('preflight-enter').click();
    await page.waitForURL(/\/rack(\?|$)/, { timeout: 30_000 });
    // The shell performed the swap (a NEW document — the fake bridge leaves the
    // fact in sessionStorage) — and an unbound rig does not bounce back.
    expect(
      await page.evaluate((k) => sessionStorage.getItem(k), FAKE_SHELL_SWAP_KEY),
      'the swap went through the bridge, not a client goto',
    ).toBe('preflight.done');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
    errorWatch.assertClean();
  });

  test('a pre-flight bind SURVIVES a reload (the shell\'s persisted bindings store)', async ({ page, errorWatch }) => {
    await gotoPreflight(page);
    await page.getByTestId('preflight-cameras-grant').click();
    const sel = page.getByTestId('preflight-camera-select').and(page.locator('[data-slot="cam1"]'));
    await expect(sel.locator('option', { hasText: 'Studio Cam A' })).toHaveCount(1);
    await sel.selectOption('cam-a');
    await expect
      .poll(async () => ((await readRig(page)).cameras as Record<string, { deviceId?: string }>)?.cam1?.deviceId)
      .toBe('cam-a');

    // ── THE RELOAD — a fresh document + a store re-hydrated through
    // `bindings.get` from the shell's persisted store.
    await page.reload();
    await expect(page.getByTestId('preflight-panel')).toBeVisible();
    await page.waitForFunction(
      () => (globalThis as unknown as { __preflightReady?: boolean }).__preflightReady === true,
      undefined,
      { timeout: 15_000 },
    );
    await expect
      .poll(async () => ((await readRig(page)).cameras as Record<string, { deviceId?: string; deviceLabel?: string }>)?.cam1, {
        message: 'the camera binding survived the reload in the per-machine rig store',
      })
      .toEqual({ deviceId: 'cam-a', deviceLabel: 'Studio Cam A' });
    // And the control reflects it (the select is on the persisted value).
    await expect(sel).toHaveValue('cam-a');
    errorWatch.assertClean();
  });
});

// ── THE PLAIN-BROWSER LEG: no ptNative, no rig-setup page ────────────────────
//
// The web product binds in the rack. A browser that navigates to /preflight —
// a bookmark, a typed URL, an old link — lands on /rack before anything of the
// setup screen paints. The row tests above are the positive control (the same
// doubles, under the fake shell, render the page).
test.describe('PRE-FLIGHT in a PLAIN browser — the route is shell-only', () => {
  test.beforeEach(async ({ page }) => {
    await clearRigStoreOnce(page);
    await installFakeScreens(page, SCREENS);
    await installFakeCameras(page, CAMERAS);
    await installMidiDeviceMock(page, { outputs: MIDI_OUTPUTS, inputs: MIDI_INPUTS });
  });
  test.afterEach(async ({ page }) => {
    await disposeFakeCameras(page);
  });

  test('/preflight redirects to /rack before the panel mounts', async ({ page, errorWatch }) => {
    const mounted: string[] = [];
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) mounted.push(f.url());
    });
    await page.goto('/preflight');
    await page.waitForURL(/\/rack(\?|$)/, { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    await expect(page.getByTestId('preflight-panel')).toHaveCount(0);
    expect(
      await page.evaluate(() => (globalThis as unknown as { __preflightReady?: boolean }).__preflightReady),
      'the page component never ran its onMount',
    ).toBeUndefined();
    expect(mounted.some((u) => /\/rack(\?|$)/.test(u)), `landed on /rack — ${mounted.join(' → ')}`).toBe(true);
    errorWatch.assertClean();
  });
});
