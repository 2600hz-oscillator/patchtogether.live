// patchtogether native shell — Electron main process (P2, minimal shell).
//
// Boots the built web bundle from a loopback static server (COOP/COEP intact),
// applies the device/continuity flag set, and opens ONE fullscreen window on
// /rack. Native menus own Quit (owner ruling: Quit lives in the native menu
// only — and the preload no longer exposes a quit() either) and File ▸ Load
// Patch…
//
// TRUST BOUNDARY: security.ts. This shell pre-grants camera, mic, MIDI/SysEx,
// USB/HID/serial and screen capture with no prompts — that is the product, not
// an oversight — and confines them to the loopback origin it serves, which is
// the part that used to be an unenforced assumption. The webPreferences pinned
// below and every handler in security.ts are one policy; read them together.
//
// Env (documented defaults):
//   PT_DESKTOP_PORT      loopback port (default 9409 — es9-bridge owns 9209,
//                        vst-bridge 9309; the shell continues the x409 slot.
//                        "0" = ephemeral, used by the e2e harness)
//   PT_DESKTOP_WEB_ROOT  web bundle dir (default: packaged Resources/web, else
//                        ../../packages/web/build — the PT_DESKTOP_BUILD=1 output)
//   PT_DESKTOP_WINDOWED  "1" = plain window instead of fullscreen (harness/dev)
//   --user-data-dir=…    (Chromium switch) keys the single-instance lock; the
//                        harness gives each launch its own

import { app, BrowserWindow, Menu, dialog, powerSaveBlocker, session } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startStaticServer } from './server';
import { HelperSupervisor, type HelperSpec, type HelperStatus } from './supervisor';
import { HARDENED_WEB_PREFERENCES, installSecurity, installWindowGuards } from './security';
import { PtBridge } from './bridge';

const DEFAULT_PORT = 9409;

/** Per-launch nonce. Handed to every helper child in its environment; a helper
 *  that echoes it proves it belongs to THIS launch rather than being an orphan
 *  of the previous one squatting the same fixed port. See supervisor.ts. */
const LAUNCH_ID = randomUUID();

// ---- Chromium flag set (must land BEFORE app ready) -------------------------
// SysEx dies silently on Chromium ≥152 macOS without this: the MidiMacUmp
// backend reports send() success while transmitting nothing (Electra flashes /
// PTZ moves just vanish). Re-check exposure at EVERY Electron pin bump.
app.commandLine.appendSwitch('disable-features', 'MidiMacUmp');
// AudioContext starts 'running' with zero gestures — the whole point of the
// shell. The boot-proof e2e asserts this exact state.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function resolveWebRoot(): string {
  const fromEnv = process.env.PT_DESKTOP_WEB_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  if (app.isPackaged) return path.join(process.resourcesPath, 'web');
  return path.resolve(__dirname, '../../../packages/web/build');
}

// ---- Helper supervision (P3) ------------------------------------------------
// One supervisor per native helper, living HERE in main: a renderer crash
// (`render-process-gone`) reloads the window while helpers keep running.
// Binary resolution is injectable per helper (PT_HELPER_<ID>_BIN/_ARGS/_PORT),
// so the harness drives the SAME state machine with the Node stubs on any OS.
// PT_HELPERS=off disables the layer for specs it is not the subject of.

const supervisors: HelperSupervisor[] = [];

/** The one shell window, for `second-instance` to raise. */
let mainWindow: BrowserWindow | null = null;

function helperEnv(id: string, key: string): string | undefined {
  return process.env[`PT_HELPER_${id.toUpperCase()}_${key}`];
}

function resolveHelperBinary(id: string, unpackagedRel: string): string {
  const fromEnv = helperEnv(id, 'BIN');
  if (fromEnv) return path.resolve(fromEnv);
  return app.isPackaged
    ? path.join(process.resourcesPath, 'helpers', path.basename(unpackagedRel))
    : path.resolve(__dirname, '../../..', unpackagedRel);
  // A missing path is fine: the supervisor reports 'stopped' with the detail
  // instead of spawning — the pre-flight status row shows exactly that.
}

function helperSpecs(): HelperSpec[] {
  const tuning = {
    backoffBaseMs: Number(process.env.PT_HELPER_BACKOFF_BASE_MS ?? 300),
    backoffMaxMs: Number(process.env.PT_HELPER_BACKOFF_MAX_MS ?? 10_000),
    stableResetMs: Number(process.env.PT_HELPER_STABLE_RESET_MS ?? 10_000),
    healthTimeoutMs: Number(process.env.PT_HELPER_HEALTH_TIMEOUT_MS ?? 10_000),
  };
  const argsOf = (id: string, dflt: string[]): string[] => {
    const raw = helperEnv(id, 'ARGS');
    return raw ? raw.split(/\s+/).filter(Boolean) : dflt;
  };
  const portOf = (id: string, dflt: number | null): number | null => {
    const raw = helperEnv(id, 'PORT');
    if (raw === undefined) return dflt;
    const n = Number(raw);
    return Number.isFinite(n) ? n : dflt;
  };
  return [
    {
      id: 'es9',
      binary: resolveHelperBinary('es9', 'apps/helpers/es9/.build/release/es9-bridge'),
      args: argsOf('es9', []),
      port: portOf('es9', 9209),
      launchId: LAUNCH_ID,
      ...tuning,
    },
    {
      id: 'vst',
      binary: resolveHelperBinary('vst', 'apps/helpers/nativeapps/.build/release/vst-bridge'),
      args: argsOf('vst', []),
      port: portOf('vst', 9309),
      launchId: LAUNCH_ID,
      ...tuning,
    },
    {
      // pt-ptz has no socket: health = process alive in this slice (its
      // virtual-CoreMIDI-port probe is a later, macOS-only leg).
      id: 'ptz',
      binary: resolveHelperBinary('ptz', 'tools/pt-ptz/pt-ptz'),
      args: argsOf('ptz', []),
      port: portOf('ptz', null),
      launchId: LAUNCH_ID,
      ...tuning,
    },
  ];
}

function startSupervisors(win: BrowserWindow, bridge: PtBridge): void {
  if (process.env.PT_HELPERS === 'off') return;
  for (const spec of helperSpecs()) {
    const sup = new HelperSupervisor(spec);
    supervisors.push(sup);
    sup.onStatus((status: HelperStatus) => {
      if (!win.isDestroyed()) bridge.emit(win.webContents, 'helpers.status', status);
    });
    sup.start();
  }
}

function installMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu — Quit lives HERE and only here (native-only Quit; the web UI
    // never grows a quit affordance).
    ...(isMac
      ? [{ label: app.name, submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Load Patch…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(win, {
              title: 'Load Patch',
              properties: ['openFile'],
              filters: [{ name: 'patchtogether patches', extensions: ['json', 'zip'] }],
            });
            const file = result.filePaths[0];
            if (!result.canceled && file) {
              win.webContents.send('pt:load-patch-requested', file);
            }
          },
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot(): Promise<void> {
  const webRoot = resolveWebRoot();
  if (!fs.existsSync(path.join(webRoot, 'fallback.html'))) {
    // Fail loudly and early — a shell without its bundle is a black window.
    dialog.showErrorBox(
      'patchtogether — missing web bundle',
      `No built web bundle at:\n${webRoot}\n\nRun: task desktop:build:web (or set PT_DESKTOP_WEB_ROOT).`,
    );
    app.exit(1);
    return;
  }

  // Keep the display awake for the whole app lifetime — this is a performance
  // instrument; the OS dimming mid-set is a continuity failure.
  powerSaveBlocker.start('prevent-display-sleep');

  const requestedPort = Number(process.env.PT_DESKTOP_PORT ?? DEFAULT_PORT);
  const server = await startStaticServer(webRoot, Number.isFinite(requestedPort) ? requestedPort : DEFAULT_PORT);

  // The security policy IS "=== this origin", so it cannot exist before the
  // server has a port. Installing the grants earlier (as this did) is what
  // made "the shell only ever loads 127.0.0.1" an unenforced assumption.
  const shellOrigin = `http://127.0.0.1:${server.port}`;
  installSecurity(session.defaultSession, shellOrigin);

  const windowed = process.env.PT_DESKTOP_WINDOWED === '1';
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    // NATIVE fullscreen (not HTML5 element fullscreen), so there is no
    // Chromium "Press Esc to exit full screen" toast by construction — the
    // window is fullscreen; the page never calls requestFullscreen for it.
    fullscreen: !windowed,
    backgroundColor: '#000000',
    webPreferences: {
      // Electron 44 already defaults every one of these to the safe value.
      // Pinning them is not a fix — it is the record: a later "just for this
      // asset" edit becomes a reviewable line, and a pin bump that moves a
      // default fails the boot spec instead of the show.
      ...HARDENED_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload.js'),
      // Occluded/background windows keep rendering + timers keep firing —
      // renderer throttling is a continuity hazard for a live instrument.
      backgroundThrottling: false,
    },
  });
  mainWindow = win;

  installMenu(win);
  installWindowGuards(win.webContents, shellOrigin);

  // ONE ipc entry point for every renderer command (bridge.ts): sender
  // validation is written once instead of once per verb — the shape that let
  // `pt:quit` and `pt:helper-status` both ship with no senderFrame check.
  // Note there is no quit op: Quit is native-menu-only (see this file's
  // header), and the preload no longer exposes one.
  const bridge = new PtBridge(shellOrigin);
  bridge.register('helpers.status', () => ({
    current: supervisors.map((s) => s.status()),
    history: supervisors.flatMap((s) => s.history),
  }));
  bridge.install();

  startSupervisors(win, bridge);

  // Renderer death: reload the WINDOW; supervisors, helpers, and the loopback
  // server live in main and are untouched (brief P3 task 4).
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[shell] renderer gone (${details.reason}) — reloading`);
    if (!win.isDestroyed()) win.webContents.reload();
  });

  // window.open / navigation policy now lives in installWindowGuards above:
  // shell-origin urls open as real popups WITH opener→popup DOM access (P4's
  // blit design rests on it — the captureStream fallback rendered BLACK on
  // real dual-monitor hardware), and every other http(s) url is handed to the
  // user's browser instead of a preload-carrying Electron window.

  await win.loadURL(`${shellOrigin}/rack`);

  app.on('window-all-closed', () => {
    void server.close();
    app.quit();
  });
}

// A dead shell must never orphan helpers: stop every supervisor (SIGTERM,
// SIGKILL escalation) on the way out.
//
// ⚠ The stdin-close orphan guard this used to claim for "every tier" is real
// ONLY in the Node stubs (src/stubs/*.ts). The shipped Swift bridges handle
// SIGINT and never read stdin, so a SIGKILL'd or crashed shell DOES orphan the
// real es9/vst bridges on 9209/9309. That is precisely the stale-listener the
// supervisor's port-ownership check now refuses to adopt; adding the guard to
// the two helper repos is the remaining fix and lives in their commits.
app.on('will-quit', () => {
  for (const sup of supervisors) sup.stop();
});

// ---- single instance -------------------------------------------------------
// The shell owns a FIXED port (9409) and fixed helper ports. Two live shells
// cannot both have them: the second one's static server rejected on EADDRINUSE
// inside an unhandled promise — a stack trace on a terminal a performer does
// not have, no window, no explanation. So: one instance, and a second launch
// raises the one that already exists (a double-clicked dock icon must never be
// a silent no-op).
//
// The lock is keyed on the userData directory, which is why the harness gives
// each launch its own via --user-data-dir; the second-instance leg deliberately
// SHARES one, because that is the collision being tested.
if (!app.requestSingleInstanceLock()) {
  console.error('[shell] another patchtogether shell is already running — exiting');
  app.exit(0);
} else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(boot).catch((err: unknown) => {
    // Fail closed and LOUD, exactly like the missing-bundle path: a shell that
    // cannot bind its port has no window to complain in.
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      'patchtogether — cannot start',
      `The shell failed to boot:\n\n${message}\n\n` +
        `If this mentions EADDRINUSE, something else holds the shell's port ` +
        `(default ${DEFAULT_PORT}). Set PT_DESKTOP_PORT to move it.`,
    );
    app.exit(1);
  });
}
