// Port and instance OWNERSHIP — "is this thing mine?"
//
// The supervisor used to answer that question with "something alive answered
// on the port", which is not an answer: a stale orphan of the previous launch,
// or any local process that replies at all, satisfies it identically. Measured
// against the real class before this change: a foreign server replying with
// the literal string "go away" produced `running pid=40174` for a child that
// had already exited.
//
// The specs below are the ownership questions, each as a PAIR — the same
// mechanism adopting our own helper and refusing everything else. A leg that
// only proved refusal would be satisfied by a supervisor that never goes
// running at all, which is why every one of them carries its positive control.
//
// ⚠ These specs use FIXED ports on purpose. boot.spec and supervision.spec set
// PT_DESKTOP_PORT=0 and allocate a fresh helper port per test precisely so
// runs never collide — engineering out the exact collision that hides this
// class of bug. Nothing here may inherit that.
//
// Same lane, same runner as boot/supervision (playwright.config testDir globs
// ./e2e) — no new job, no new lane.

import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { WebSocketServer, type WebSocket } from 'ws';

const APP_DIR = path.resolve(__dirname, '..');
const WEB_ROOT = process.env.PT_DESKTOP_WEB_ROOT
  ? path.resolve(process.env.PT_DESKTOP_WEB_ROOT)
  : path.resolve(APP_DIR, '../../packages/web/build');
const STUBS = path.join(APP_DIR, 'dist', 'stubs');
const BOOT_MS = 60_000;

interface HelperStatusLike {
  id: string;
  state: string;
  pid: number | null;
  detail: string | null;
}

function requireBundle(): void {
  if (!fs.existsSync(path.join(WEB_ROOT, 'fallback.html'))) {
    throw new Error(
      `No desktop web bundle at ${WEB_ROOT} — run \`task desktop:build:web\` first (or set PT_DESKTOP_WEB_ROOT).`,
    );
  }
}

function freshUserDataDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pt-shell-${tag}-`));
}

async function status(app: ElectronApplication, id: string): Promise<HelperStatusLike | null> {
  const page = await app.firstWindow();
  return page.evaluate(async (helperId) => {
    const w = window as unknown as {
      ptNative?: { helperStatus: { get: () => Promise<{ current: HelperStatusLike[] }> } };
    };
    const snap = await w.ptNative?.helperStatus.get();
    return snap?.current.find((s) => s.id === helperId) ?? null;
  }, id);
}

/** A local WebSocket listener that is emphatically NOT one of our helpers. */
function foreignListener(port: number, reply: (msg: unknown) => unknown): Promise<{ close: () => Promise<void>; pid: number }> {
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        /* not our problem — we are the hostile party here */
      }
      const out = reply(parsed);
      ws.send(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        pid: process.pid,
        close: () =>
          new Promise<void>((r) => {
            wss.close();
            server.close(() => r());
          }),
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// 1. Single instance.
// ---------------------------------------------------------------------------

test('a second launch on the same fixed port does not open a second shell', async () => {
  requireBundle();
  const userDataDir = freshUserDataDir('single');
  // A fixed, high port: the DEFAULT would collide with a real shell on the
  // developer's machine, and an ephemeral one would hide the whole test.
  const port = '19409';

  const launch = (): Promise<ElectronApplication> =>
    _electron.launch({
      args: [`--user-data-dir=${userDataDir}`, APP_DIR],
      env: {
        ...process.env,
        PT_DESKTOP_WEB_ROOT: WEB_ROOT,
        PT_DESKTOP_PORT: port,
        PT_DESKTOP_WINDOWED: '1',
        PT_HELPERS: 'off',
      },
    });

  const first = await launch();
  try {
    const page = await first.firstWindow();
    await page.waitForURL(new RegExp(`^http://127\\.0\\.0\\.1:${port}/rack`), { timeout: BOOT_MS });
    // POSITIVE control: the first instance really did get the port and a window.
    expect(first.windows().length).toBe(1);

    // NEGATIVE control: the second launch takes the lock's "no" and exits 0.
    //
    // Spawned RAW, not through _electron.launch: Playwright's launcher waits
    // for a debugger handshake that an instance which correctly exits before
    // opening a window will never complete, so driving it that way asserts the
    // harness's patience rather than the product's behaviour.
    // Outside Electron, requiring the `electron` package yields the path to
    // its binary. createRequire, not a bare require(): this spec file is ESM
    // to the toolchain.
    const electronBin = createRequire(__filename)('electron') as unknown as string;
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const proc = spawn(electronBin, [`--user-data-dir=${userDataDir}`, APP_DIR], {
        env: {
          ...process.env,
          PT_DESKTOP_WEB_ROOT: WEB_ROOT,
          PT_DESKTOP_PORT: port,
          PT_DESKTOP_WINDOWED: '1',
          PT_HELPERS: 'off',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      proc.stderr.on('data', (d: Buffer) => (err += String(d)));
      proc.stdout.resume();
      proc.on('exit', (c) => resolve({ code: c, stderr: err }));
    });

    expect(code).toBe(0);
    // It said so, out loud, instead of dying in an unhandled rejection — a
    // performer double-clicking the dock icon has no terminal to read.
    expect(stderr).toMatch(/already running/);
    expect(stderr).not.toMatch(/EADDRINUSE|UnhandledPromiseRejection/);

    // The FIRST instance is untouched — still serving, still one window.
    expect(first.windows().length).toBe(1);
    await expect(page.locator('.svelte-flow').first()).toBeVisible({ timeout: BOOT_MS });
  } finally {
    await first.close();
  }
});

/**
 * POSITIVE control for the lock: with a DIFFERENT userData directory (and so a
 * different lock), a second shell boots normally. Without this, a shell that
 * had simply stopped launching would pass the leg above.
 */
test('the lock is per-instance, not a blanket refusal to start twice', async () => {
  requireBundle();
  const a = await _electron.launch({
    args: [`--user-data-dir=${freshUserDataDir('twinA')}`, APP_DIR],
    env: { ...process.env, PT_DESKTOP_WEB_ROOT: WEB_ROOT, PT_DESKTOP_PORT: '0', PT_DESKTOP_WINDOWED: '1', PT_HELPERS: 'off' },
  });
  let b: ElectronApplication | null = null;
  try {
    await (await a.firstWindow()).waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });
    b = await _electron.launch({
      args: [`--user-data-dir=${freshUserDataDir('twinB')}`, APP_DIR],
      env: { ...process.env, PT_DESKTOP_WEB_ROOT: WEB_ROOT, PT_DESKTOP_PORT: '0', PT_DESKTOP_WINDOWED: '1', PT_HELPERS: 'off' },
    });
    await (await b.firstWindow()).waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });
    expect(a.windows().length).toBe(1);
    expect(b.windows().length).toBe(1);
  } finally {
    if (b) await b.close();
    await a.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Port ownership: a listener we did not spawn is never adopted.
// ---------------------------------------------------------------------------

/**
 * The core case, exactly as measured before the fix.
 *
 * A foreign process holds the es9 port and answers protocol-shaped JSON. Our
 * own child therefore cannot bind and exits immediately — the same thing the
 * real bridges do on a busy port (vst-bridge `portInUse` → exit(1)). The
 * pre-change supervisor reported `running` with the dead child's pid.
 */
test('a foreign listener on a helper port is reported, never adopted and never killed', async () => {
  requireBundle();
  const es9Port = 19260;
  // Perfect protocol — deviceInfo, correct protocolVersion. The ONLY thing
  // wrong with it is that we did not spawn it, which is the entire point.
  const foreign = await foreignListener(es9Port, () => ({
    type: 'deviceInfo',
    protocolVersion: 1,
    name: 'not-ours',
    rate: 48000,
    inputChannels: 16,
    outputChannels: 16,
  }));
  const app = await _electron.launch({
    args: [`--user-data-dir=${freshUserDataDir('foreign')}`, APP_DIR],
    env: {
      ...process.env,
      PT_DESKTOP_WEB_ROOT: WEB_ROOT,
      PT_DESKTOP_PORT: '0',
      PT_DESKTOP_WINDOWED: '1',
      // Our child cannot get the port; it exits, exactly like a real bridge.
      PT_HELPER_ES9_BIN: process.execPath,
      PT_HELPER_ES9_ARGS: `${path.join(STUBS, 'es9-stub.js')} --port ${es9Port}`,
      PT_HELPER_ES9_PORT: String(es9Port),
      PT_HELPER_VST_BIN: '/nonexistent/vst-bridge',
      PT_HELPER_PTZ_BIN: '/nonexistent/pt-ptz',
      PT_HELPER_HEALTH_TIMEOUT_MS: '4000',
      PT_HELPER_BACKOFF_BASE_MS: '200',
    },
  });
  app.process().stderr?.on('data', (d: Buffer) => console.error(`[main] ${String(d).trimEnd()}`));
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });

    // NEGATIVE control: the row settles on the terminal foreign state, and it
    // NAMES the holder so the pre-flight UI can say what is wrong.
    await expect
      .poll(async () => (await status(app, 'es9'))?.state, { timeout: 40_000 })
      .toBe('foreign-listener');
    const row = await status(app, 'es9');
    expect(row?.detail).toContain(String(es9Port));
    expect(row?.detail).toMatch(/not by our child/);

    // It must NEVER have passed through 'running' — a transient green is the
    // exact lie this fixes, and a status row nobody was watching at that
    // moment is still a row P5 would have painted.
    const states = await page.evaluate(async () => {
      const w = window as unknown as {
        ptNative: { helperStatus: { get: () => Promise<{ history: HelperStatusLike[] }> } };
      };
      return (await w.ptNative.helperStatus.get()).history.filter((s) => s.id === 'es9').map((s) => s.state);
    });
    expect(states).not.toContain('running');

    // ⚠ NEVER KILL AN UNKNOWN LISTENER. The foreign server is still up and
    // still answering — asserted, because "we only ever kill our own child" is
    // a claim a future refactor can quietly break.
    const stillAlive = await new Promise<boolean>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: es9Port, path: '/', method: 'GET' }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.end();
    });
    expect(stillAlive).toBe(true);
  } finally {
    await app.close();
    await foreign.close();
  }
});

/**
 * POSITIVE control for the leg above, and the one that keeps it honest: with
 * the port free, the SAME supervisor, the SAME probe and the SAME ownership
 * check take our own stub all the way to `running`. Without this, a supervisor
 * that had simply stopped working would pass the foreign-listener test.
 */
test('our own helper on the same port reaches running with ownership proven', async () => {
  requireBundle();
  const es9Port = 19262;
  const app = await _electron.launch({
    args: [`--user-data-dir=${freshUserDataDir('own')}`, APP_DIR],
    env: {
      ...process.env,
      PT_DESKTOP_WEB_ROOT: WEB_ROOT,
      PT_DESKTOP_PORT: '0',
      PT_DESKTOP_WINDOWED: '1',
      PT_HELPER_ES9_BIN: process.execPath,
      PT_HELPER_ES9_ARGS: `${path.join(STUBS, 'es9-stub.js')} --port ${es9Port}`,
      PT_HELPER_ES9_PORT: String(es9Port),
      PT_HELPER_VST_BIN: '/nonexistent/vst-bridge',
      PT_HELPER_PTZ_BIN: '/nonexistent/pt-ptz',
      PT_HELPER_HEALTH_TIMEOUT_MS: '10000',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });
    await expect.poll(async () => (await status(app, 'es9'))?.state, { timeout: 40_000 }).toBe('running');
    const row = await status(app, 'es9');
    // Ownership was PROVEN, not skipped: an unverifiable port says so on the row.
    expect(row?.detail).toBeNull();
    expect(row?.pid).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 3. The reply judge, arm by arm.
//
// The two legs above prove the PID layer end to end. The message layer's arms
// — a stale build's protocol version, another launch's nonce — cannot be
// staged over a socket without building a fake helper per arm, which is
// exactly why a socket-only suite quietly never covers them. The judge is
// pure and exported; drive it directly.
// ---------------------------------------------------------------------------

test('reply judge: our helper is accepted, every impostor shape is not', async () => {
  const verdicts = judgeArms();

  // POSITIVE control — the real replies every tier actually sends.
  expect(verdicts.deviceInfo).toBe(true);
  expect(verdicts.helperInfo).toBe(true);
  expect(verdicts.busyStatus).toBe(true); // es9 single-client 'busy' IS protocol
  expect(verdicts.noVersionField).toBe(true); // absent is not wrong
  expect(verdicts.matchingNonce).toBe(true);
  expect(verdicts.absentNonce).toBe(true); // the Swift tier, today

  // NEGATIVE control — one arm each.
  expect(verdicts.goAway).toBe(false); // the literal measured case
  expect(verdicts.notJson).toBe(false);
  expect(verdicts.jsonArray).toBe(false);
  expect(verdicts.unknownType).toBe(false);
  expect(verdicts.staleProtocol).toBe(false); // an older build's orphan
  expect(verdicts.wrongNonce).toBe(false); // a previous launch's helper
});

function judgeArms(): Record<string, boolean> {
  const { judgeProtocolReply } = createRequire(__filename)(
    path.join(APP_DIR, 'dist', 'supervisor.js'),
  ) as {
    judgeProtocolReply: (raw: string, opts: { port: number; launchId?: string }) => { ok: boolean };
  };
  const j = (raw: unknown, launchId = 'launch-A'): boolean =>
    judgeProtocolReply(typeof raw === 'string' ? raw : JSON.stringify(raw), { port: 9209, launchId }).ok;
  return {
    deviceInfo: j({ type: 'deviceInfo', protocolVersion: 1, inputChannels: 16 }),
    helperInfo: j({ type: 'helperInfo', protocolVersion: 1 }),
    busyStatus: j({ type: 'status', state: 'busy', detail: 'another client is connected' }),
    noVersionField: j({ type: 'deviceInfo' }),
    matchingNonce: j({ type: 'deviceInfo', protocolVersion: 1, shellLaunchId: 'launch-A' }),
    absentNonce: j({ type: 'deviceInfo', protocolVersion: 1 }),
    goAway: j('go away'),
    notJson: j('<html>404</html>'),
    jsonArray: j('[1,2,3]'),
    unknownType: j({ type: 'greetings', protocolVersion: 1 }),
    staleProtocol: j({ type: 'deviceInfo', protocolVersion: 0 }),
    wrongNonce: j({ type: 'deviceInfo', protocolVersion: 1, shellLaunchId: 'launch-B' }),
  };
}
