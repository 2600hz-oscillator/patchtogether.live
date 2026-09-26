// NATIVE-SHELL PRE-FLIGHT — Tier-A Electron harness. Two shell-only claims the
// browser lane structurally cannot make:
//
//   1. HELPER PRESENCE ON THE /preflight UI. The ES-9 + PTZ rows read the REAL
//      supervisor via `helpers.status`: with the es9 Node stub injected (the
//      same seam supervision.spec.ts drives) the ES-9 row reaches 'running';
//      with NO ptz binary the PTZ row degrades to 'stopped — binary not found'
//      (a status row, never spawn churn).
//
//   2. THE ELECTRON-STORE ROUND-TRIP. Binding the ES-9 output-push policy on
//      /preflight round-trips through `bindings.set` into the on-disk rig record
//      (rig-store.ts). A RELAUNCH against the SAME userData dir then (a) boots
//      to /preflight with the saved selection — and (b) reads the
//      policy back through `bindings.get`. That is "bindings applied at boot;
//      relaunch restores everything," proven end to end.
//
// Subject: unpackaged `electron .` + the PT_DESKTOP_BUILD=1 / VITE_E2E_HOOKS=1
// web build (task desktop:build:web). Fresh ports per launch + a per-test
// userData dir REUSED across the relaunch (the round-trip needs the same disk).
// Every wait is observable state (status feed, URL, expect.poll) — no sleeps.

import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { midiDeviceMockScript } from '../../../e2e/_helpers/midi';

const APP_DIR = path.resolve(__dirname, '..');
const WEB_ROOT = process.env.PT_DESKTOP_WEB_ROOT
  ? path.resolve(process.env.PT_DESKTOP_WEB_ROOT)
  : path.resolve(APP_DIR, '../../packages/web/build');
const STUBS = path.join(APP_DIR, 'dist', 'stubs');
const BOOT_MS = 60_000;

let portSlot = 0;

/** Launch the shell against `userDataDir`, with the es9 Node stub wired and no
 *  ptz binary. Returns the app + its first window. */
async function launch(userDataDir: string): Promise<ElectronApplication> {
  const es9Port = 19410 + 2 * (portSlot % 40);
  const vstPort = 19510 + 2 * (portSlot % 40);
  portSlot += 1;
  return _electron.launch({
    args: [`--user-data-dir=${userDataDir}`, APP_DIR],
    env: {
      ...process.env,
      PT_DESKTOP_WEB_ROOT: WEB_ROOT,
      PT_DESKTOP_PORT: '0',
      PT_DESKTOP_WINDOWED: '1',
      PT_HELPER_ES9_BIN: process.execPath,
      PT_HELPER_ES9_ARGS: `${path.join(STUBS, 'es9-stub.js')} --port ${es9Port}`,
      PT_HELPER_ES9_PORT: String(es9Port),
      // No VST / PTZ binaries — those rows must read 'stopped: binary not found'.
      PT_HELPER_VST_BIN: '/nonexistent/vst-bridge',
      PT_HELPER_VST_PORT: String(vstPort),
      PT_HELPER_PTZ_BIN: '/nonexistent/pt-ptz',
      PT_HELPER_BACKOFF_BASE_MS: '200',
      PT_HELPER_STABLE_RESET_MS: '600000',
    },
  });
}

test.beforeAll(() => {
  if (!fs.existsSync(path.join(WEB_ROOT, 'fallback.html'))) {
    throw new Error(
      `No desktop web bundle at ${WEB_ROOT} — run \`task desktop:build:web\` first (or set PT_DESKTOP_WEB_ROOT).`,
    );
  }
});

test('TRAILS selection survives a real process relaunch and connects without another gesture', async () => {
  test.setTimeout(BOOT_MS * 3);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-shell-trails-'));
  const input = { id: 'native-trails', name: 'Bela Trails' };
  const script = midiDeviceMockScript([], [input], 'instant');
  try {
    const first = await launch(profile);
    try {
      const page = await first.firstWindow();
      await page.addInitScript({ content: script });
      await page.reload();
      await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: BOOT_MS });
      await page.getByTestId('preflight-trails-connect').click();
      await page.getByTestId('preflight-trails-select').selectOption(input.id);
      await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'rig-bindings.json'), 'utf8')).trails)
        .toEqual({ deviceId: input.id, deviceName: input.name });
    } finally { await first.close(); }
    const second = await launch(profile);
    try {
      const page = await second.firstWindow();
      await page.addInitScript({ content: script });
      await page.reload();
      await expect(page.getByTestId('preflight-trails-select')).toHaveValue(input.id, { timeout: BOOT_MS });
      await expect(page.getByTestId('preflight-trails-presence')).toHaveAttribute('data-state', 'ok');
      const screenshot = test.info().outputPath('restored-trails-setup.png');
      await page.getByTestId('preflight-section-trails').screenshot({ path: screenshot });
      await test.info().attach('restored-trails-setup', { path: screenshot, contentType: 'image/png' });
      expect(await page.evaluate((id) => {
        const w = window as unknown as { __midiDeviceMock: { inject(id: string, bytes: number[]): boolean } };
        return w.__midiDeviceMock.inject(id, [0xf8]);
      }, input.id)).toBe(true);
    } finally { await second.close(); }
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});

test('pre-flight renders es9/ptz helper presence, and an ES-9 bind survives a relaunch (electron-store round-trip)', async () => {
  test.setTimeout(BOOT_MS * 3);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-shell-preflight-'));

  // ── FIRST LAUNCH — fresh rig → the shell opens /preflight ─────────────────
  const app1 = await launch(userDataDir);
  try {
    const page = await app1.firstWindow();
    page.on('pageerror', (e) => console.error(`[preflight pageerror] ${String(e)}`));
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/preflight/, { timeout: BOOT_MS });
    await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: BOOT_MS });

    // 1a. The ES-9 row reaches 'running' off the real supervisor (helpers.status
    //     + live onEvent), and the PTZ row degrades to a status row.
    await expect(page.getByTestId('preflight-es9-state')).toHaveText(/running/, { timeout: BOOT_MS });
    await expect(page.getByTestId('preflight-es9-state')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('preflight-ptz-state')).toHaveText(/stopped.*binary not found/, {
      timeout: BOOT_MS,
    });

    // 1b. Bind the ES-9 output-push policy — this round-trips through bindings.set.
    await page.getByTestId('preflight-es9-config').selectOption('always');

    // Confirm MAIN persisted it (bindings.get reads the on-disk-backed cache) —
    // so the write has landed before we relaunch.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const w = window as unknown as {
              ptNative: { command: (op: string) => Promise<{ ok?: boolean; result?: { es9?: { pushPolicy?: string } } }> };
            };
            const r = await w.ptNative.command('bindings.get');
            return r.result?.es9?.pushPolicy ?? null;
          }),
        { timeout: BOOT_MS },
      )
      .toBe('always');

    // Enter the rack (preflight.done) — the SAME window swaps /preflight → /rack.
    await page.getByTestId('preflight-enter').click();
    await page.waitForURL(/\/rack(\?|$)/, { timeout: BOOT_MS });
  } finally {
    await app1.close();
  }

  // RELAUNCH: review hardware again, with the saved selection restored.
  const app2 = await launch(userDataDir);
  const app2Process = app2.process();
  try {
    const page = await app2.firstWindow();
    await page.waitForURL(/\/preflight(\?|$)/, { timeout: BOOT_MS });
    await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: BOOT_MS });
    await expect(page.getByTestId('preflight-es9-config')).toHaveValue('always');

    // The ES-9 policy came back from disk through bindings.get.
    const policy = await page.evaluate(async () => {
      const w = window as unknown as {
        ptNative: { command: (op: string) => Promise<{ ok?: boolean; result?: { es9?: { pushPolicy?: string } } }> };
      };
      const r = await w.ptNative.command('bindings.get');
      return r.result?.es9?.pushPolicy ?? null;
    });
    expect(policy, 'the ES-9 policy survived the relaunch in the electron-store').toBe('always');
    await page.getByTestId('preflight-enter').click();
    await page.waitForURL(/\/rack(\?|$)/, { timeout: BOOT_MS });
    await expect(page.locator('.svelte-flow').first()).toBeVisible({ timeout: BOOT_MS });

    // Both File menus expose Exit. The renderer action must close the shell
    // through normal app.quit(), including its owned helper and output windows.
    expect(await app2.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === 'File');
      return file?.submenu?.items.some((item) => item.label === 'Exit' && item.role === 'quit');
    })).toBe(true);
    const helperPid = await page.evaluate(async () => {
      const w = window as unknown as { ptNative: { command: (op: string) => Promise<{ result: { current: { id: string; pid: number | null; state: string }[] } }> } };
      const reply = await w.ptNative.command('helpers.status');
      const es9 = reply.result.current.find((row) => row.id === 'es9');
      if (es9?.state !== 'running' || !es9.pid) throw new Error('ES-9 stub must be running before Exit');
      return es9.pid;
    });
    await app2.evaluate(({ BrowserWindow }) => { new BrowserWindow({ show: false }); });
    await page.getByTestId('workflow-file-trigger').click();
    await expect(page.getByTestId('workflow-file-exit')).toBeVisible();
    const closed = app2.waitForEvent('close');
    await page.getByTestId('workflow-file-exit').click();
    await closed;
    await expect.poll(() => {
      try { process.kill(helperPid, 0); return true; } catch { return false; }
    }, { message: 'Exit stops the owned ES-9 helper' }).toBe(false);
  } finally {
    if (app2Process.exitCode === null) await app2.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
