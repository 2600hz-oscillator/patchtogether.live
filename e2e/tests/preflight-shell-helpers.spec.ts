// NATIVE-SHELL PRE-FLIGHT — the SHELL-only rows (ES-9 + PTZ helper presence, the
// `retryable` retry affordance) exercised in the RENDERER lane through a fake
// `window.ptNative` bridge. This is the fast, deterministic half; the REAL
// supervisors + the electron-store round-trip live in
// apps/desktop/e2e/preflight-helpers.spec.ts (Tier-A Electron harness).
//
// The ES-9 section is STATUS ONLY: its former output-push policy select wrote a
// rig key nothing read, and that write armed the relaunch guard on any machine
// without the helper binary (a /preflight ↔ /rack loop). The last test pins its
// absence — and that the section writes the store ZERO times.
//
// The fake bridge (`installFakeShell`, e2e/_helpers/preflight-devices.ts — the
// SAME stub every pre-flight spec boots under, since /preflight is shell-only)
// mirrors the preload contract exactly: nativeAvailable()→true (so
// `nativeAvailable()` takes the shell branch AND the rig store picks the bridge
// backend), command() resolves the {ok,result}|{ok,error} envelope, and
// onEvent() delivers live `helpers.status` pushes. That is enough to drive every
// shell-gated branch the pre-flight has, without an Electron process.
//
// ARMED WITH errorWatch.

import { test, expect, type Page } from './_fixtures';
import { clearRigStoreOnce, installFakeShell, readRig } from '../_helpers/preflight-devices';

async function gotoPreflight(page: Page): Promise<void> {
  await page.goto('/preflight');
  await expect(page.getByTestId('preflight-panel')).toBeVisible();
  await page.waitForFunction(
    () => (globalThis as unknown as { __preflightReady?: boolean }).__preflightReady === true,
    undefined,
    { timeout: 15_000 },
  );
}

test.describe('PRE-FLIGHT shell rows — ES-9 / PTZ helper presence', () => {
  test('renders es9 (running) + ptz (unavailable: binary not found) and follows a live onEvent', async ({
    page,
    errorWatch,
  }) => {
    await clearRigStoreOnce(page);
    await installFakeShell(page, { helpers: 'ok' });
    await gotoPreflight(page);

    // Initial helpers.status → the row paints the helper STATE. A helper that
    // was never built is `unavailable`: an idle (grey) status row with the
    // detail, not a red "down" — nothing is failing, there is nothing to run.
    await expect(page.getByTestId('preflight-es9-state')).toHaveText(/running/);
    await expect(page.getByTestId('preflight-es9-state')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('preflight-ptz-state')).toHaveText(/unavailable.*binary not found/);
    await expect(page.getByTestId('preflight-ptz-state')).toHaveAttribute('data-state', 'idle');

    // A LIVE push flips es9 to stopped — the row must follow onEvent('helpers.status').
    await page.evaluate(() => {
      (window as unknown as { __fireHelper: (s: unknown) => void }).__fireHelper({
        id: 'es9',
        state: 'stopped',
        detail: 'device unplugged',
      });
    });
    await expect(page.getByTestId('preflight-es9-state')).toHaveText(/stopped.*device unplugged/);
    await expect(page.getByTestId('preflight-es9-state')).toHaveAttribute('data-state', 'down');
    errorWatch.assertClean();
  });

  test('a retryable helpers.status failure shows the retry affordance and re-issues on click', async ({
    page,
    errorWatch,
  }) => {
    await clearRigStoreOnce(page);
    await installFakeShell(page, { helpers: 'fail' });
    await gotoPreflight(page);

    // The command failed with error.retryable=true → the retry button appears.
    const retry = page.getByTestId('preflight-es9-retry');
    await expect(retry).toBeVisible();
    await expect(page.getByTestId('preflight-es9-state')).toHaveText(/unknown/);

    const before = await page.evaluate(
      () => (window as unknown as { __ptCalls: string[] }).__ptCalls.filter((o) => o === 'helpers.status').length,
    );
    await retry.click();
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __ptCalls: string[] }).__ptCalls.filter((o) => o === 'helpers.status').length,
        ),
      )
      .toBeGreaterThan(before);
    // Still failing → the affordance stays.
    await expect(retry).toBeVisible();
    errorWatch.assertClean();
  });

  test('the ES-9 section carries NO control: a status row only, and the splash writes the store zero times on its own', async ({
    page,
    errorWatch,
  }) => {
    await clearRigStoreOnce(page);
    await installFakeShell(page, { helpers: 'ok' });
    await gotoPreflight(page);

    const section = page.getByTestId('preflight-section-es9');
    await expect(section.getByTestId('preflight-es9-state')).toHaveText(/running/);
    await expect(section.locator('select, input, [role="combobox"]'), 'nothing to pick — nothing to bind').toHaveCount(0);
    await expect(page.getByTestId('preflight-es9-config')).toHaveCount(0);
    // A mount with nothing picked issues no write: the rig record is empty and
    // `bindings.set` never crossed the bridge (every pick that remains has a
    // reader; an idle splash arms nothing).
    expect(await readRig(page)).toEqual({ cameras: {}, outputs: {} });
    expect(
      await page.evaluate(() => (window as unknown as { __ptCalls: string[] }).__ptCalls.filter((op) => op === 'bindings.set')),
    ).toEqual([]);
    errorWatch.assertClean();
  });
});
