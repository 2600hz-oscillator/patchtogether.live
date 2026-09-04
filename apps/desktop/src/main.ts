// patchtogether native shell — Electron main process (P2, minimal shell).
//
// Boots the built web bundle from a loopback static server (COOP/COEP intact),
// applies the device/continuity flag set, and opens one fullscreen window on
// /rack. Native menus own Quit (owner ruling: Quit lives in the native menu
// only) and File ▸ Load Patch…
//
// Env (documented defaults):
//   PT_DESKTOP_PORT      loopback port (default 9409 — es9-bridge owns 9209,
//                        vst-bridge 9309; the shell continues the x409 slot.
//                        "0" = ephemeral, used by the e2e harness)
//   PT_DESKTOP_WEB_ROOT  web bundle dir (default: packaged Resources/web, else
//                        ../../packages/web/build — the PT_DESKTOP_BUILD=1 output)
//   PT_DESKTOP_WINDOWED  "1" = plain window instead of fullscreen (harness/dev)

import { app, BrowserWindow, Menu, dialog, ipcMain, powerSaveBlocker, session, desktopCapturer } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { startStaticServer } from './server';
import { HelperSupervisor, type HelperSpec, type HelperStatus } from './supervisor';

const DEFAULT_PORT = 9409;

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
      ...tuning,
    },
    {
      id: 'vst',
      binary: resolveHelperBinary('vst', 'apps/helpers/nativeapps/.build/release/vst-bridge'),
      args: argsOf('vst', []),
      port: portOf('vst', 9309),
      ...tuning,
    },
    {
      // pt-ptz has no socket: health = process alive in this slice (its
      // virtual-CoreMIDI-port probe is a later, macOS-only leg).
      id: 'ptz',
      binary: resolveHelperBinary('ptz', 'tools/pt-ptz/pt-ptz'),
      args: argsOf('ptz', []),
      port: portOf('ptz', null),
      ...tuning,
    },
  ];
}

function startSupervisors(win: BrowserWindow): void {
  if (process.env.PT_HELPERS === 'off') return;
  for (const spec of helperSpecs()) {
    const sup = new HelperSupervisor(spec);
    supervisors.push(sup);
    sup.onStatus((status: HelperStatus) => {
      if (!win.isDestroyed()) win.webContents.send('pt:helper-status-changed', status);
    });
    sup.start();
  }
}

function installPermissionGrants(): void {
  const ses = session.defaultSession;
  // The shell IS the permission UI: everything the loopback origin asks for is
  // pre-granted — a browser-style prompt on stage is the exact failure mode
  // this app exists to delete. (Scoping beyond the loopback origin is moot:
  // the shell only ever loads 127.0.0.1.)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  ses.setPermissionCheckHandler(() => true);
  // WebUSB / Web Serial / WebHID device-chooser flows have no picker UI in
  // Electron — grant, and pick the first candidate when asked to choose.
  ses.setDevicePermissionHandler(() => true);
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    callback(details.deviceList[0]?.deviceId);
  });
  ses.on('select-serial-port', (event, portList, _wc, callback) => {
    event.preventDefault();
    callback(portList[0]?.portId ?? '');
  });
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    callback(details.deviceList[0]?.deviceId ?? '');
  });
  // Without a display-media handler, getDisplayMedia FAILS OUTRIGHT in
  // Electron — and with it, capture is picker-free: hand over the primary
  // screen (output-window loopback capture lands in P4 on this same seam).
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        const first = sources[0];
        if (first) callback({ video: first });
        else callback({});
      })
      .catch(() => callback({}));
  });
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

  installPermissionGrants();

  // Keep the display awake for the whole app lifetime — this is a performance
  // instrument; the OS dimming mid-set is a continuity failure.
  powerSaveBlocker.start('prevent-display-sleep');

  const requestedPort = Number(process.env.PT_DESKTOP_PORT ?? DEFAULT_PORT);
  const server = await startStaticServer(webRoot, Number.isFinite(requestedPort) ? requestedPort : DEFAULT_PORT);

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
      preload: path.join(__dirname, 'preload.js'),
      // Occluded/background windows keep rendering + timers keep firing —
      // renderer throttling is a continuity hazard for a live instrument.
      backgroundThrottling: false,
    },
  });

  installMenu(win);
  ipcMain.handle('pt:quit', () => app.quit());

  // Helper status feed for ptNative.helperStatus (the future pre-flight UI's
  // rows). `get` returns current + bounded history so a late subscriber (or
  // the harness) never misses a transition; live changes push over IPC.
  ipcMain.handle('pt:helper-status', () => ({
    current: supervisors.map((s) => s.status()),
    history: supervisors.flatMap((s) => s.history),
  }));
  startSupervisors(win);

  // Renderer death: reload the WINDOW; supervisors, helpers, and the loopback
  // server live in main and are untouched (brief P3 task 4).
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[shell] renderer gone (${details.reason}) — reloading`);
    if (!win.isDestroyed()) win.webContents.reload();
  });

  // window.open from the loopback origin is ALLOWED — P4's present/output
  // design rests on same-origin opener→popup DOM access through this handler
  // (the captureStream fallback rendered BLACK on real dual-monitor hardware).
  // P4 refines this into the output1..4 ↔ display map; the P2 spike records
  // that the mechanism holds on the pinned Electron.
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));

  await win.loadURL(`http://127.0.0.1:${server.port}/rack`);

  app.on('window-all-closed', () => {
    void server.close();
    app.quit();
  });
}

// A dead shell must never orphan helpers: stop every supervisor (SIGTERM,
// SIGKILL escalation) on the way out. The stubs additionally exit when their
// piped stdin closes, so even a hard shell death reaps them.
app.on('will-quit', () => {
  for (const sup of supervisors) sup.stop();
});

app.whenReady().then(boot);
