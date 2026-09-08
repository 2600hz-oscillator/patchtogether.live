// e2e/tests/preflight-shell-helpers.spec.ts
//
// NATIVE-SHELL PRE-FLIGHT — the SHELL-only rows (ES-9 + PTZ helper presence, the
// `retryable` retry affordance, the ES-9 config write) exercised in the RENDERER
// lane through a fake `window.ptNative` bridge. This is the fast, deterministic
// half; the REAL supervisors + the electron-store round-trip live in
// apps/desktop/e2e/preflight-helpers.spec.ts (Tier-A Electron harness).
//
// The fake bridge mirrors the preload contract exactly: nativeAvailable()→true
// (so `nativeAvailable()` takes the shell branch AND the rig store picks the
// bridge backend), command() resolves the {ok,result}|{ok,error} envelope, and
// onEvent() delivers live `helpers.status` pushes. That is enough to drive every
// shell-gated branch the pre-flight has, without an Electron process.
//
// ARMED WITH errorWatch.

import { test, expect, type Page } from './_fixtures';
import { clearRigStoreOnce, readRig } from '../_helpers/preflight-devices';

type HelperMode = 'ok' | 'fail';

/** Install a fake ptNative BEFORE boot. `mode` decides how helpers.status
 *  answers: 'ok' → es9 running / ptz stopped(binary not found); 'fail' → a
 *  retryable error envelope (the shape the retry affordance keys off). */
async function installFakeShell(page: Page, mode: HelperMode): Promise<void> {
  await page.addInitScript((mode) => {
    const w = window as unknown as {
      ptNative: unknown;
      __ptCalls: string[];
      __fireHelper: (s: unknown) => void;
    };
    w.__ptCalls = [];
    let helperCb: ((p: unknown) => void) | null = null;
    const okStatus = {
      ok: true,
      result: {
        current: [
          { id: 'es9', state: 'running', pid: 4242, port: 9209, attempt: 0, delayMs: null, detail: null, ts: 1 },
          { id: 'ptz', state: 'stopped', pid: null, port: null, attempt: 0, delayMs: null, detail: 'binary not found', ts: 1 },
        ],
        history: [],
      },
    };
    w.ptNative = {
      nativeAvailable: () => true,
      shellVersion: () => '0.0.0-test',
      bridgeVersion: () => 1,
      command: (op: string) => {
        w.__ptCalls.push(op);
        if (op === 'helpers.status') {
          return mode === 'ok'
            ? Promise.resolve(okStatus)
            : Promise.resolve({ ok: false, error: { code: 'internal', message: 'transient', retryable: true } });
        }
        // bindings.get / bindings.set / preflight.done all succeed.
        return Promise.resolve({ ok: true, result: op === 'bindings.get' ? {} : {} });
      },
      cancel: () => {},
      onEvent: (topic: string, cb: (p: unknown) => void) => {
        if (topic === 'helpers.status') helperCb = cb;
        return () => {
          helperCb = null;
        };
      },
    };
    w.__fireHelper = (s: unknown) => helperCb?.(s);
  }, mode);
}

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
  test('renders es9 (running) + ptz (stopped: binary not found) and follows a live onEvent', async ({
    page,
    errorWatch,
  }) => {
    await clearRigStoreOnce(page);
    await installFakeShell(page, 'ok');
    await gotoPreflight(page);

    // Initial helpers.status → the row paints the helper STATE.
    await expect(page.getByTestId('preflight-es9-state')).toHaveText(/running/);
    await expect(page.getByTestId('preflight-es9-state')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('preflight-ptz-state')).toHaveText(/stopped.*binary not found/);
    await expect(page.getByTestId('preflight-ptz-state')).toHaveAttribute('data-state', 'down');

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
    await installFakeShell(page, 'fail');
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

  test('the ES-9 config select writes setEs9 through the bridge', async ({ page, errorWatch }) => {
    await clearRigStoreOnce(page);
    await installFakeShell(page, 'ok');
    await gotoPreflight(page);

    await page.getByTestId('preflight-es9-config').selectOption('always');
    await expect
      .poll(async () => ((await readRig(page)).es9 as { pushPolicy?: string })?.pushPolicy, {
        message: 'picking an ES-9 output-push policy writes rigBindings().setEs9({pushPolicy})',
      })
      .toBe('always');
    // …and it went through the bridge backend (bindings.set), not localStorage.
    expect(
      await page.evaluate(() =>
        (window as unknown as { __ptCalls: string[] }).__ptCalls.includes('bindings.set'),
      ),
    ).toBe(true);
    errorWatch.assertClean();
  });
});
