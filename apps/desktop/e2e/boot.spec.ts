// Boot determinism — the GATING-light lane's REQUIRED subset (owner answer 3:
// "proves the harness boots and loads expected content; nothing more in the
// required path"). This spec IS that subset, exactly:
//
//   1. the built shell boots (Electron main + preload + loopback server),
//   2. /rack paints,
//   3. the AudioContext reaches 'running' with ZERO user gestures
//      (page.evaluate is not a gesture — in a stock browser this exact flow
//      parks at 'suspended'; only the shell's autoplay flag makes it run,
//      so the assertion discriminates shell from browser),
//   4. zero pageerrors, zero extra windows (permission prompts / dialogs
//      would surface as windows; requests are auto-granted in main).
//
// Everything timing-shaped (RMS instrument, supervision, continuity matrix)
// stays OUT of this family — dispatch-tier work for later PH slices.
//
// Tier A subject: unpackaged `electron .` + the PT_DESKTOP_BUILD=1 web build
// with VITE_E2E_HOOKS=1 baked (NOT the shipped artifact; packaged = Tier B).

import { test, expect, _electron } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';

const APP_DIR = path.resolve(__dirname, '..');
const WEB_ROOT = process.env.PT_DESKTOP_WEB_ROOT
  ? path.resolve(process.env.PT_DESKTOP_WEB_ROOT)
  : path.resolve(APP_DIR, '../../packages/web/build');

// Budget for the cold rack paint. The web e2e lane's BOOT_MS lesson applies
// (first paint measured 4.5–5.4 s on fast hardware, worse on CI SwiftShader);
// explicit and generous, asserted on observable state — never a sleep.
const BOOT_MS = 60_000;

test('shell boots, /rack paints, audio runs gesture-free, zero errors', async () => {
  // A gate must not skip (skips are not passes): a missing bundle is a FAIL
  // with the fix in the message, not a silent green.
  if (!fs.existsSync(path.join(WEB_ROOT, 'fallback.html'))) {
    throw new Error(
      `No desktop web bundle at ${WEB_ROOT} — run \`task desktop:build:web\` first (or set PT_DESKTOP_WEB_ROOT).`,
    );
  }

  const electronApp = await _electron.launch({
    args: [APP_DIR],
    env: {
      ...process.env,
      PT_DESKTOP_WEB_ROOT: WEB_ROOT,
      // Ephemeral port: parallel/local runs never collide with a real shell
      // on the documented default port.
      PT_DESKTOP_PORT: '0',
      // Plain window: native-fullscreen transitions are not this family's
      // subject and stall on some runners.
      PT_DESKTOP_WINDOWED: '1',
      // Helper supervision is supervision.spec.ts's subject, not boot's —
      // keep the boot proof isolated from whatever helper binaries this
      // machine does or does not have.
      PT_HELPERS: 'off',
    },
  });

  try {
    const page = await electronApp.firstWindow();

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    // 1+2: the shell served /rack from its loopback server and the rack painted.
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });
    await expect(page.locator('.svelte-flow').first()).toBeVisible({ timeout: BOOT_MS });

    // Cross-origin isolation made it through the loopback server's headers
    // (SharedArrayBuffer / Faust WASM threads depend on it).
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);

    // The preload bridge is live.
    expect(
      await page.evaluate(() => {
        const w = window as unknown as { ptNative?: { nativeAvailable?: () => boolean } };
        return w.ptNative?.nativeAvailable?.() === true;
      }),
    ).toBe(true);

    // 3: gesture-free audio. __ensureEngine comes from the VITE_E2E_HOOKS build
    // (same hook the web lane drives); state 'running' without a click is the
    // shell's autoplay flag at work.
    await page.evaluate(() => {
      (window as unknown as { __ensureEngine?: () => unknown }).__ensureEngine?.();
    });
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __engine?: () => { getDomain?: (d: string) => { ctx?: AudioContext } } | null;
        };
        return w.__engine?.()?.getDomain?.('audio')?.ctx?.state === 'running';
      },
      undefined,
      { timeout: 15_000 },
    );

    // 4: zero pageerrors, and no window beyond the shell's one (a permission
    // prompt or stray dialog would have opened another).
    expect(pageErrors).toEqual([]);
    expect(electronApp.windows().length).toBe(1);
  } finally {
    // Teardown discipline: no leaked electron processes.
    await electronApp.close();
  }
});
