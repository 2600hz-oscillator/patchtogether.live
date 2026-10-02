// NATIVE-SHELL PRE-FLIGHT — Tier-A Electron harness. Three shell-only claims
// the browser lane structurally cannot make:
//
//   1. HELPER PRESENCE ON THE /preflight UI. The ES-9 + PTZ rows read the REAL
//      supervisor via `helpers.status`: with the es9 Node stub injected (the
//      same seam supervision.spec.ts drives) the ES-9 row reaches 'running';
//      with NO ptz binary the PTZ row degrades to 'unavailable — binary not
//      found' (a status row, never spawn churn, and never `stopped`).
//
//   2. THE ELECTRON-STORE ROUND-TRIP. Picking a PT-PTZ port on /preflight
//      round-trips through `bindings.set` into the on-disk rig record
//      (rig-store.ts). A RELAUNCH against the SAME userData dir then (a) boots
//      to /preflight with the saved selection — and (b) reads the pick back
//      through `bindings.get`. That is "bindings applied at boot; relaunch
//      restores everything," proven end to end. (The ES-9 output-push policy
//      this leg used to bind had no reader; the splash no longer offers it.)
//
//   3. THE SPLASH NEVER LOCKS THE SHELL. With NEITHER helper binary present
//      (PT_HELPER_ES9_BIN / PT_HELPER_PTZ_BIN = /nonexistent/…) and a PT-PTZ
//      port picked, Enter rack lands on /rack and STAYS — across a reload,
//      which re-runs the relaunch guard without the splash's one-shot skip.
//      Before this, `binary not found` was reported as `stopped`, the guard
//      read `stopped` as "positively absent", `/rack` bounced to `/preflight`,
//      and Enter rack bounced straight back: a /preflight ↔ /rack loop on any
//      machine that had not built the helpers.
//
// Subject: unpackaged `electron .` + the PT_DESKTOP_BUILD=1 / VITE_E2E_HOOKS=1
// web build (task desktop:build:web). Fresh ports per launch + a per-test
// userData dir REUSED across the relaunch (the round-trip needs the same disk).
// Every wait is observable state (status feed, URL, expect.poll) — no sleeps.

import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
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

/** The PT-PTZ virtual pair the pt-ptz helper would mint, as a WebMIDI double
 *  (the same mock the renderer lane drives through `installMidiDeviceMock`). */
const PTZ_PORT = 'PT-PTZ-CAM1';
const PTZ_MIDI_SCRIPT = midiDeviceMockScript(
  [{ id: 'ptz-out', name: PTZ_PORT }],
  [{ id: 'ptz-in', name: PTZ_PORT }],
  'instant',
);

let portSlot = 0;

/** Launch the shell against `userDataDir`. `es9: 'stub'` wires the es9 Node
 *  stub (the supervision seam); `es9: 'missing'` points at a path that does not
 *  exist. The ptz binary is ALWAYS missing — the row this file is about. */
async function launch(userDataDir: string, opts: { es9: 'stub' | 'missing' } = { es9: 'stub' }): Promise<ElectronApplication> {
  const es9Port = 19410 + 2 * (portSlot % 40);
  const vstPort = 19510 + 2 * (portSlot % 40);
  portSlot += 1;
  const es9: Record<string, string> =
    opts.es9 === 'stub'
      ? { PT_HELPER_ES9_BIN: process.execPath, PT_HELPER_ES9_ARGS: `${path.join(STUBS, 'es9-stub.js')} --port ${es9Port}` }
      : { PT_HELPER_ES9_BIN: '/nonexistent/es9-bridge' };
  return _electron.launch({
    args: [`--user-data-dir=${userDataDir}`, APP_DIR],
    env: {
      ...process.env,
      PT_DESKTOP_WEB_ROOT: WEB_ROOT,
      PT_DESKTOP_PORT: '0',
      PT_DESKTOP_WINDOWED: '1',
      ...es9,
      PT_HELPER_ES9_PORT: String(es9Port),
      // No VST / PTZ binaries — those rows must read 'unavailable: binary not found'.
      PT_HELPER_VST_BIN: '/nonexistent/vst-bridge',
      PT_HELPER_VST_PORT: String(vstPort),
      PT_HELPER_PTZ_BIN: '/nonexistent/pt-ptz',
      PT_HELPER_BACKOFF_BASE_MS: '200',
      PT_HELPER_STABLE_RESET_MS: '600000',
    },
  });
}

/** The splash, with the PT-PTZ WebMIDI double installed. `firstWindow` only
 *  guarantees a BrowserWindow exists, and an init script added after the
 *  initial loadURL has started applies to the NEXT document, so the splash is
 *  reloaded once it is up (a reload during the initial navigation races it
 *  and fails with ERR_ABORTED). */
async function splashWithPtzMidi(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.error(`[preflight pageerror] ${String(e)}`));
  await page.addInitScript({ content: PTZ_MIDI_SCRIPT });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/preflight/, { timeout: BOOT_MS });
  await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: BOOT_MS });
  await page.reload();
  await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: BOOT_MS });
  return page;
}

async function readPtzPick(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      ptNative: { command: (op: string) => Promise<{ ok?: boolean; result?: { ptz?: { deviceId?: string } } }> };
    };
    const r = await w.ptNative.command('bindings.get');
    return r.result?.ptz?.deviceId ?? null;
  });
}

/** Pick the PT-PTZ port on the splash and wait until MAIN has persisted it
 *  (`bindings.get` reads the on-disk-backed cache). */
async function pickPtzPort(page: Page): Promise<void> {
  await page.getByTestId('preflight-ptz-connect').click();
  await page.getByTestId('preflight-ptz-select').selectOption(PTZ_PORT);
  await expect.poll(() => readPtzPick(page), { timeout: BOOT_MS }).toBe(PTZ_PORT);
  await expect(page.getByTestId('preflight-ptz-presence')).toHaveAttribute('data-state', 'ok');
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
      // firstWindow only guarantees a BrowserWindow exists. A reload during
      // its initial loadURL races that navigation and fails with ERR_ABORTED.
      await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: BOOT_MS });
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
      // firstWindow only guarantees a BrowserWindow exists. A reload during
      // its initial loadURL races that navigation and fails with ERR_ABORTED.
      await expect(page.getByTestId('preflight-panel')).toBeVisible({ timeout: BOOT_MS });
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

test('pre-flight renders es9/ptz helper presence, and a PTZ pick survives a relaunch (electron-store round-trip)', async () => {
  test.setTimeout(BOOT_MS * 3);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-shell-preflight-'));

  // ── FIRST LAUNCH — fresh rig → the shell opens /preflight ─────────────────
  const app1 = await launch(userDataDir);
  try {
    const page = await splashWithPtzMidi(app1);

    // 1a. The ES-9 row reaches 'running' off the real supervisor (helpers.status
    //     + live onEvent), and the PTZ row degrades to a status row — grey
    //     `unavailable`, never red `stopped`.
    await expect(page.getByTestId('preflight-es9-state')).toHaveText(/running/, { timeout: BOOT_MS });
    await expect(page.getByTestId('preflight-es9-state')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('preflight-ptz-state')).toHaveText(/unavailable.*binary not found/, {
      timeout: BOOT_MS,
    });
    await expect(page.getByTestId('preflight-ptz-state')).toHaveAttribute('data-state', 'idle');
    // The ES-9 section is status only: nothing to pick, nothing that could
    // write a binding nobody reads.
    await expect(page.getByTestId('preflight-es9-config')).toHaveCount(0);
    await expect(page.getByTestId('preflight-section-es9').locator('select')).toHaveCount(0);
    // And no display rows: the shell opens no output windows.
    await expect(page.getByTestId('preflight-section-displays')).toHaveCount(0);

    // 1b. Pick the PT-PTZ port — this round-trips through bindings.set, and
    //     MAIN confirms it before we relaunch.
    await pickPtzPort(page);

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
    const page = await splashWithPtzMidi(app2);
    await expect(page.getByTestId('preflight-ptz-select')).toHaveValue(PTZ_PORT, { timeout: BOOT_MS });

    // The PTZ pick came back from disk through bindings.get.
    expect(await readPtzPick(page), 'the PTZ pick survived the relaunch in the electron-store').toBe(PTZ_PORT);
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

test('with NO helper binaries a PTZ pick never locks the shell: Enter rack lands on /rack and stays across a reload', async () => {
  test.setTimeout(BOOT_MS * 3);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-shell-nolock-'));
  // The exact shape of the lock: /nonexistent/es9-bridge AND /nonexistent/pt-ptz
  // (a fresh checkout, a box that never ran `task helpers:build`).
  const app = await launch(userDataDir, { es9: 'missing' });
  try {
    const page = await splashWithPtzMidi(app);
    const navigations: string[] = [];
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navigations.push(f.url());
    });

    // Both helper rows are `unavailable` status rows.
    await expect(page.getByTestId('preflight-es9-state')).toHaveText(/unavailable.*binary not found/, { timeout: BOOT_MS });
    await expect(page.getByTestId('preflight-ptz-state')).toHaveText(/unavailable.*binary not found/, { timeout: BOOT_MS });

    // The operator binds the PT-PTZ port (the row whose helper is "configured"
    // in the guard's sense) and enters.
    await pickPtzPort(page);
    await page.getByTestId('preflight-enter').click();
    await page.waitForURL(/\/rack(\?|$)/, { timeout: BOOT_MS });
    await expect(page.locator('.svelte-flow').first()).toBeVisible({ timeout: BOOT_MS });
    // The rack's own boot finished with the guard's chance behind it.
    await expect
      .poll(
        () => page.evaluate(() => !!(globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } }).__patch?.nodes['slot:cam1']),
        { message: 'the rack finished its own boot after the guard had its chance', timeout: BOOT_MS },
      )
      .toBe(true);
    expect(page.url()).toMatch(/\/rack(\?|$)/);

    // A RELOAD is a fresh /rack mount WITHOUT the splash's one-shot skip: the
    // guard runs for real against `unavailable` and keeps the rack.
    await page.reload();
    await expect(page.locator('.svelte-flow').first()).toBeVisible({ timeout: BOOT_MS });
    await expect
      .poll(
        () => page.evaluate(() => !!(globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } }).__patch?.nodes['slot:cam1']),
        { message: 'the reloaded rack finished its own boot after the guard had its chance', timeout: BOOT_MS },
      )
      .toBe(true);
    expect(page.url()).toMatch(/\/rack(\?|$)/);
    await expect(page.getByTestId('preflight-panel')).toHaveCount(0);
    expect(
      navigations.filter((u) => /\/preflight/.test(u)),
      `never bounced back to /preflight — ${navigations.join(' → ')}`,
    ).toEqual([]);
    // The pick is still on disk: nothing had to be hand-edited to escape.
    expect(await readPtzPick(page)).toBe(PTZ_PORT);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
