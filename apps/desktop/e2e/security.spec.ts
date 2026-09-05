// Shell trust boundary — the REFUSALS.
//
// A grant handler is worth exactly what it denies, so every leg here is a
// negative control paired with a positive one on the same mechanism. The pair
// is the point: "camera is denied for evil.example" proves nothing on its own,
// because a handler that denies EVERYTHING passes it while silently killing
// ES-9, PTZ, four webcams and four displays. Each leg therefore shows the same
// mechanism SAYING YES to the shell and NO to everything else.
//
// The negative origin is not a remote site (this lane runs offline): it is
// `http://localhost:<port>` — the SAME loopback server, the SAME bytes, a
// DIFFERENT origin string from the shell's `http://127.0.0.1:<port>`. If a
// decision ever came from "it looks local" rather than from the exact origin,
// these legs go green when they should not, so they are also a control on the
// control.
//
// Same lane, same runner as boot/supervision (playwright.config testDir globs
// ./e2e) — no new job, no new lane, no CI wall-time delta beyond this file.

import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as http from 'node:http';

const APP_DIR = path.resolve(__dirname, '..');
const WEB_ROOT = process.env.PT_DESKTOP_WEB_ROOT
  ? path.resolve(process.env.PT_DESKTOP_WEB_ROOT)
  : path.resolve(APP_DIR, '../../packages/web/build');
const BOOT_MS = 60_000;

/** Each launch gets its own userData dir, because the shell now holds a
 *  SINGLE-INSTANCE LOCK keyed on exactly that path. The lock's own leg below
 *  deliberately shares one — that is the collision under test. */
function freshUserDataDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pt-shell-${tag}-`));
}

async function launch(opts: { userDataDir: string; port?: string }): Promise<ElectronApplication> {
  if (!fs.existsSync(path.join(WEB_ROOT, 'fallback.html'))) {
    throw new Error(
      `No desktop web bundle at ${WEB_ROOT} — run \`task desktop:build:web\` first (or set PT_DESKTOP_WEB_ROOT).`,
    );
  }
  return _electron.launch({
    args: [`--user-data-dir=${opts.userDataDir}`, APP_DIR],
    env: {
      ...process.env,
      PT_DESKTOP_WEB_ROOT: WEB_ROOT,
      PT_DESKTOP_PORT: opts.port ?? '0',
      PT_DESKTOP_WINDOWED: '1',
      PT_HELPERS: 'off',
    },
  });
}

/** The shell's own origin, read back off the loaded page. */
async function shellOrigin(app: ElectronApplication): Promise<string> {
  const page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });
  return new URL(page.url()).origin;
}

// ---------------------------------------------------------------------------
// 1. The pure policy, driven directly in the MAIN process.
//
// electronApp.evaluate runs in main, so this requires the SHIPPED dist module —
// the same file main.ts imports, not a copy. Every arm of the decision is
// reachable here; over a socket, most of them are not.
// ---------------------------------------------------------------------------

test('policy predicates: shell origin yes, everything else no', async () => {
  const app = await launch({ userDataDir: freshUserDataDir('policy') });
  try {
    const origin = await shellOrigin(app);
    const verdicts = await app.evaluate(async (_electronApi, args) => {
      // `require` is not in scope inside electronApp.evaluate; the main
      // process's own module loader is. This pulls in the SHIPPED dist file —
      // the same module main.ts imports, not a copy of the logic.
      const sec = process.mainModule!.require(args.mod) as typeof import('../src/security');
      const o = args.origin;
      const port = new URL(o).port;
      return {
        // permission handlers
        shellFrame: sec.permissionAllowed({ shellOrigin: o, requestingUrl: `${o}/rack`, topLevelUrl: `${o}/rack` }),
        shellSubframe: sec.permissionAllowed({ shellOrigin: o, requestingUrl: `${o}/present`, topLevelUrl: `${o}/rack` }),
        remoteFrame: sec.permissionAllowed({ shellOrigin: o, requestingUrl: 'https://evil.example/x', topLevelUrl: 'https://evil.example/x' }),
        // same content, same port, different origin
        localhostAlias: sec.permissionAllowed({ shellOrigin: o, requestingUrl: `http://localhost:${port}/rack` }),
        // a shell-origin frame embedded in a hostile top-level document
        shellFrameHostileTop: sec.permissionAllowed({ shellOrigin: o, requestingUrl: `${o}/rack`, topLevelUrl: 'https://evil.example/' }),
        // a remote subframe of the shell
        remoteSubframe: sec.permissionAllowed({ shellOrigin: o, requestingUrl: 'https://evil.example/x', embeddingOrigin: o }),
        // fail closed: nothing identifies the caller
        noSignals: sec.permissionAllowed({ shellOrigin: o }),
        // window.open
        openShell: sec.windowOpenDecision(`${o}/present`, o),
        openBlank: sec.windowOpenDecision('about:blank', o),
        openRemote: sec.windowOpenDecision('https://joinpeertube.org/', o),
        openLocalhostAlias: sec.windowOpenDecision(`http://localhost:${port}/rack`, o),
        openFile: sec.windowOpenDecision('file:///etc/passwd', o),
        openJs: sec.windowOpenDecision('javascript:fetch("/x")', o),
        // navigation
        navShell: sec.navigationAllowed(`${o}/docs`, o),
        navBlob: sec.navigationAllowed(`blob:${o}/2f8a-…`, o),
        navRemote: sec.navigationAllowed('https://evil.example/', o),
        navLocalhostAlias: sec.navigationAllowed(`http://localhost:${port}/rack`, o),
        // ipc sender gate
        ipcShell: sec.ipcSenderAllowed({ senderFrame: { url: `${o}/rack` } }, o),
        ipcRemote: sec.ipcSenderAllowed({ senderFrame: { url: 'https://evil.example/' } }, o),
        ipcNoFrame: sec.ipcSenderAllowed({ senderFrame: null }, o),
      };
    }, { mod: path.join(APP_DIR, 'dist', 'security.js'), origin });

    // POSITIVE control — the shell keeps everything it needs.
    expect(verdicts.shellFrame).toBe(true);
    expect(verdicts.shellSubframe).toBe(true);
    expect(verdicts.openShell).toBe('allow');
    expect(verdicts.openBlank).toBe('allow');
    expect(verdicts.navShell).toBe(true);
    expect(verdicts.navBlob).toBe(true); // blob: of the shell origin is the shell
    expect(verdicts.ipcShell).toBe(true);

    // NEGATIVE control — and note localhostAlias: a decision made on "looks
    // local" instead of the exact origin would pass the remote legs and fail
    // right here.
    expect(verdicts.remoteFrame).toBe(false);
    expect(verdicts.localhostAlias).toBe(false);
    expect(verdicts.shellFrameHostileTop).toBe(false);
    expect(verdicts.remoteSubframe).toBe(false);
    expect(verdicts.noSignals).toBe(false);
    expect(verdicts.navRemote).toBe(false);
    expect(verdicts.navLocalhostAlias).toBe(false);
    expect(verdicts.ipcRemote).toBe(false);
    expect(verdicts.ipcNoFrame).toBe(false);

    // Remote links are not blocked — they are REDIRECTED to the real browser.
    // (A plain 'deny' here would be a functional regression: the PeerTube and
    // archive.org pickers ship those links.)
    expect(verdicts.openRemote).toBe('external');
    expect(verdicts.openLocalhostAlias).toBe('external');
    expect(verdicts.openFile).toBe('deny');
    expect(verdicts.openJs).toBe('deny');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 2. The handlers as INSTALLED — end to end, through Chromium.
// ---------------------------------------------------------------------------

test('permission checks: granted for the shell, denied for a non-shell origin serving the same bytes', async () => {
  const app = await launch({ userDataDir: freshUserDataDir('perm') });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });
    const port = new URL(page.url()).port;

    const query = async (target: 'shell' | 'alias'): Promise<string[]> => {
      if (target === 'shell') {
        return page.evaluate(async () => {
          const names = ['camera', 'microphone', 'midi'] as const;
          return Promise.all(
            names.map(async (name) => {
              try {
                const s = await navigator.permissions.query({ name: name as PermissionName });
                return s.state;
              } catch (err) {
                return `threw:${String(err)}`;
              }
            }),
          );
        });
      }
      // A second window on http://localhost:<port> — same server, same html,
      // an origin that is NOT the shell's.
      return app.evaluate(async ({ BrowserWindow }, url) => {
        const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        try {
          await w.loadURL(url);
          return (await w.webContents.executeJavaScript(`
            Promise.all(['camera','microphone','midi'].map(n =>
              navigator.permissions.query({name:n}).then(s => s.state).catch(e => 'threw:'+e)))
          `)) as string[];
        } finally {
          w.destroy();
        }
      }, `http://localhost:${port}/rack`);
    };

    // POSITIVE control: the app's own device permissions are still pre-granted.
    // If this ever reads 'prompt'/'denied', the hardening broke the product —
    // that is the whole risk this change carries, asserted directly.
    expect(await query('shell')).toEqual(['granted', 'granted', 'granted']);

    // NEGATIVE control: identical content, different origin, nothing granted.
    const alias = await query('alias');
    expect(alias.every((s) => s !== 'granted')).toBe(true);
  } finally {
    await app.close();
  }
});

/**
 * The REQUEST handler, not the check handler.
 *
 * navigator.permissions.query above goes through setPermissionCheckHandler;
 * getUserMedia goes through setPermissionRequestHandler, and the two are
 * separate installs (missing one is the classic gap). This is also the leg
 * that answers the hard constraint on this whole change: device access must
 * NEVER break. A deny-by-default handler that also denied the app's own
 * cameras and audio interfaces would be a regression, not a hardening — so the
 * positive arm here is the one that matters most.
 *
 * `--use-fake-device-for-media-stream` gives Chromium a synthetic camera and
 * mic so the lane needs no hardware. It is a HARNESS argument only, and
 * deliberately NOT `--use-fake-ui-for-media-stream`, which would bypass the
 * permission handler and make the whole test vacuous.
 */
test('getUserMedia succeeds for the shell and is refused for a non-shell origin', async () => {
  const userDataDir = freshUserDataDir('gum');
  if (!fs.existsSync(path.join(WEB_ROOT, 'fallback.html'))) {
    throw new Error(`No desktop web bundle at ${WEB_ROOT} — run \`task desktop:build:web\` first.`);
  }
  const app = await _electron.launch({
    args: ['--use-fake-device-for-media-stream', `--user-data-dir=${userDataDir}`, APP_DIR],
    env: {
      ...process.env,
      PT_DESKTOP_WEB_ROOT: WEB_ROOT,
      PT_DESKTOP_PORT: '0',
      PT_DESKTOP_WINDOWED: '1',
      PT_HELPERS: 'off',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });
    const port = new URL(page.url()).port;

    // POSITIVE: real tracks, from the shell, with no prompt and no gesture.
    const shellTracks = await page.evaluate(async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const kinds = s.getTracks().map((t) => t.kind).sort();
        s.getTracks().forEach((t) => t.stop());
        return kinds.join(',');
      } catch (err) {
        return `threw:${String(err)}`;
      }
    });
    expect(shellTracks).toBe('audio,video');

    // NEGATIVE: the same call from the alias origin is refused.
    const aliasResult = await app.evaluate(async ({ BrowserWindow }, url) => {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        await w.loadURL(url);
        return (await w.webContents.executeJavaScript(`
          navigator.mediaDevices.getUserMedia({video:true, audio:true})
            .then(s => { s.getTracks().forEach(t => t.stop()); return 'granted'; })
            .catch(e => 'refused:' + e.name)
        `)) as string;
      } finally {
        w.destroy();
      }
    }, `http://localhost:${port}/rack`);
    expect(aliasResult).not.toBe('granted');
    expect(aliasResult).toMatch(/^refused:/);
  } finally {
    await app.close();
  }
});

test('window.open and navigation stay on the shell origin', async () => {
  const app = await launch({ userDataDir: freshUserDataDir('nav') });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });
    const before = page.url();

    // POSITIVE control: same-origin window.open still yields a REAL popup with
    // opener DOM access. P4's blit design depends on exactly this, so a leg
    // that only proved denial would be the wrong instrument.
    const openedSameOrigin = await page.evaluate(() => {
      const w = window.open('/docs', '_blank', 'width=400,height=300');
      const ok = w !== null && typeof w.document !== 'undefined';
      w?.close();
      return ok;
    });
    expect(openedSameOrigin).toBe(true);

    // NEGATIVE control: a remote window.open opens NO Electron window (it is
    // handed to the OS browser instead).
    //
    // ⚠ Counted in MAIN, via BrowserWindow.getAllWindows(). `app.windows()`
    // (Playwright's view) is structurally blind here: with the guard removed
    // as a negative control, main reported ['', '…/rack'] — the popup WAS
    // created — while Playwright still said 1, because it never attaches to a
    // window whose navigation fails (no network in this lane). The obvious
    // instrument passed the broken build; this one does not.
    const urls = (): Promise<string[]> =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));
    const before2 = await urls();
    await page.evaluate(() => {
      window.open('https://example.com/', '_blank');
    });
    // Give Electron a real chance to create one: a round trip to main plus a
    // frame, rather than reading in the same tick.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await urls()).toEqual(before2);

    // NEGATIVE control: top-level navigation off the shell origin is refused.
    await page.evaluate(() => {
      window.location.href = 'https://example.com/';
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(new URL(page.url()).origin).toBe(new URL(before).origin);
    // …and main agrees: the shell window itself never left the origin.
    expect(new URL((await urls())[0] ?? '').origin).toBe(new URL(before).origin);
  } finally {
    await app.close();
  }
});

test('loopback server rejects a rebound Host header but serves the loopback ones', async () => {
  const app = await launch({ userDataDir: freshUserDataDir('host') });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });
    const port = Number(new URL(page.url()).port);

    // Driven from the TEST process: the loopback server is reachable from here
    // too, and a raw request is the only way to forge a Host header — a page
    // cannot set one.
    const status = (host: string): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/rack', method: 'GET', headers: { Host: host } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });

    // POSITIVE control: both loopback spellings still serve.
    expect(await status(`127.0.0.1:${port}`)).toBe(200);
    expect(await status(`localhost:${port}`)).toBe(200);
    // NEGATIVE control: a rebound attacker domain gets nothing.
    expect(await status(`evil.example:${port}`)).toBe(403);
    expect(await status(`127.0.0.1`)).toBe(403); // right host, wrong port
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 3. The bridge envelope.
// ---------------------------------------------------------------------------

test('bridge envelope: versioned, correlated, structured errors, cancellable', async () => {
  const app = await launch({ userDataDir: freshUserDataDir('bridge') });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/rack/, { timeout: BOOT_MS });

    const out = await page.evaluate(async () => {
      const w = window as unknown as {
        ptNative: {
          bridgeVersion: () => number;
          command: (
            op: string,
            payload?: unknown,
            opts?: { requestId?: string },
          ) => Promise<Record<string, unknown>>;
          cancel: (id: string) => void;
          quit?: unknown;
        };
      };
      const ok = await w.ptNative.command('helpers.status');
      const unsupported = await w.ptNative.command('slots.assign', { slot: 1 });
      const named = await w.ptNative.command('helpers.status', undefined, { requestId: 'caller-chosen' });
      return {
        version: w.ptNative.bridgeVersion(),
        ok,
        unsupported,
        named,
        hasQuit: typeof w.ptNative.quit,
        hasCancel: typeof w.ptNative.cancel,
      };
    });

    expect(out.version).toBe(1);

    // POSITIVE control: a registered op round-trips inside the envelope, with
    // its id echoed — the shape P1/P4/P5 will land their write ops in.
    expect(out.ok.v).toBe(1);
    expect(out.ok.ok).toBe(true);
    expect(typeof out.ok.id).toBe('string');
    expect(out.ok.result).toHaveProperty('current');

    // A caller-chosen id comes back verbatim: that is what makes cancel(id)
    // addressable from anywhere in the renderer.
    expect(out.named.id).toBe('caller-chosen');
    expect(out.named.ok).toBe(true);
    expect(out.hasCancel).toBe('function');

    // NEGATIVE control: an op that does not exist yet fails STRUCTURALLY —
    // a code to branch on and a retryable flag, not a string to match.
    expect(out.unsupported.ok).toBe(false);
    expect((out.unsupported.error as { code: string }).code).toBe('unsupported-op');
    expect((out.unsupported.error as { retryable: boolean }).retryable).toBe(false);
    expect(out.unsupported.id).not.toBe(out.ok.id); // ids are per-call, not shared

    // quit() is gone from the bridge entirely (owner ruling: Quit is native
    // menu only). Its absence is asserted, not assumed.
    expect(out.hasQuit).toBe('undefined');
  } finally {
    await app.close();
  }
});

/**
 * Cancellation, and the sender gate, driven against the SHIPPED dispatcher.
 *
 * These two arms cannot be reached through the product's current op set: the
 * only registered op returns instantly (nothing to cancel), and the shell
 * window is the shell origin by construction (nothing to refuse). Inventing a
 * slow op or a hostile window in PRODUCT code to make a test reachable would
 * be building the hole to prove the patch, so the dispatcher class is driven
 * directly, in main, with handlers the test owns.
 */
test('dispatcher: cancellation aborts a slow op, and a non-shell sender gets nothing', async () => {
  const app = await launch({ userDataDir: freshUserDataDir('dispatch') });
  try {
    const origin = await shellOrigin(app);
    const out = await app.evaluate(async (_electronApi, args) => {
      const { PtBridge } = process.mainModule!.require(args.bridgeMod) as typeof import('../src/bridge');
      const bridge = new PtBridge(args.origin);

      // Observable state, not sleeps: the handler announces when it has
      // entered (so the cancel lands on a call that is genuinely in flight)
      // and records which ids were aborted (so "the off-origin cancel did
      // nothing" is an assertion about a list, not about elapsed time).
      const entered = new Set<string>();
      const aborted: string[] = [];
      let finishedAnyway = false;
      bridge.register('test.slow', async (payload, ctx) => {
        const id = String((payload as { id: string }).id);
        entered.add(id);
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            aborted.push(id);
            resolve();
            return;
          }
          ctx.signal.addEventListener('abort', () => {
            aborted.push(id);
            resolve();
          });
          // A generous upper bound that only fires if cancellation NEVER
          // arrives — reaching it is the failure, never the wait.
          setTimeout(() => {
            finishedAnyway = true;
            resolve();
          }, 5_000);
        });
        return 'slow-result';
      });

      /** Yield until the handler for `id` has actually started. */
      const untilEntered = async (id: string): Promise<void> => {
        while (!entered.has(id)) await new Promise((r) => setImmediate(r));
      };

      // Drive the dispatcher exactly as ipcMain.handle does, with a fake event
      // carrying the sender frame under test — and without touching the real
      // channel, which the live bridge already owns.
      type FakeEvent = { senderFrame: { url: string } };
      const invoke = (e: FakeEvent, raw: unknown) =>
        bridge.dispatch(e as unknown as Parameters<typeof bridge.dispatch>[0], raw);
      const cancelFor = (e: FakeEvent, raw: unknown) =>
        bridge.handleCancel(e as unknown as Parameters<typeof bridge.handleCancel>[0], raw);

      const shellEvent = { senderFrame: { url: `${args.origin}/rack` } };
      const remoteEvent = { senderFrame: { url: 'https://evil.example/' } };

      // NEGATIVE: a non-shell sender is refused before any op lookup.
      const refused = await invoke(remoteEvent, {
        v: 1,
        id: 'from-evil',
        op: 'test.slow',
        payload: { id: 'from-evil' },
      });
      const evilEverEntered = entered.has('from-evil');

      // POSITIVE + cancellation: the shell's own call starts, then is
      // cancelled by id and comes back 'cancelled' rather than running out the
      // handler's 5 s bound.
      const pending = invoke(shellEvent, { v: 1, id: 'slow-1', op: 'test.slow', payload: { id: 'slow-1' } });
      await untilEntered('slow-1');
      cancelFor(shellEvent, { v: 1, id: 'slow-1' });
      const cancelled = await pending;

      // NEGATIVE: a cancel from a non-shell sender must not touch our calls.
      // handleCancel is SYNCHRONOUS — if it were going to abort, it would have
      // done so by the time it returns — so this needs no delay at all.
      const pending2 = invoke(shellEvent, { v: 1, id: 'slow-2', op: 'test.slow', payload: { id: 'slow-2' } });
      await untilEntered('slow-2');
      cancelFor(remoteEvent, { v: 1, id: 'slow-2' });
      const abortedAfterEvilCancel = [...aborted];
      // …and a cancel with the WRONG envelope version is ignored too.
      cancelFor(shellEvent, { v: 99, id: 'slow-2' });
      const abortedAfterBadVersion = [...aborted];
      cancelFor(shellEvent, { v: 1, id: 'slow-2' }); // the real one
      await pending2;

      // Version mismatch on a command.
      const mismatched = await invoke(shellEvent, { v: 99, id: 'x', op: 'test.slow', payload: { id: 'x' } });
      // Duplicate in-flight id.
      const dupPending = invoke(shellEvent, { v: 1, id: 'dup', op: 'test.slow', payload: { id: 'dup' } });
      await untilEntered('dup');
      const duplicate = await invoke(shellEvent, { v: 1, id: 'dup', op: 'test.slow', payload: { id: 'dup' } });
      cancelFor(shellEvent, { v: 1, id: 'dup' });
      await dupPending;

      // Flatten to plain data: the discriminated union does not survive the
      // evaluate boundary usefully, and the assertions want the codes.
      const code = (r: typeof refused): string | null => (r.ok ? null : r.error.code);
      return {
        refusedCode: code(refused),
        cancelledCode: code(cancelled),
        mismatchedCode: code(mismatched),
        duplicateCode: code(duplicate),
        evilEverEntered,
        aborted,
        abortedAfterEvilCancel,
        abortedAfterBadVersion,
        finishedAnyway,
      };
    }, { bridgeMod: path.join(APP_DIR, 'dist', 'bridge.js'), origin });

    // NEGATIVE control: off-origin sender → 'denied', and the handler was
    // never even entered — refusal happens before op lookup, so a remote frame
    // cannot use error codes to discover which ops exist.
    expect(out.refusedCode).toBe('denied');
    expect(out.evilEverEntered).toBe(false);

    // POSITIVE control: cancellation actually reached the handler, and the
    // handler's 5 s upper bound was never the thing that ended the call.
    expect(out.cancelledCode).toBe('cancelled');
    expect(out.aborted).toContain('slow-1');
    expect(out.finishedAnyway).toBe(false);

    // NEGATIVE control: a cancel from an off-origin sender does nothing, and
    // neither does one carrying a foreign envelope version. handleCancel is
    // synchronous, so these are assertions about a list — no sleep, no race.
    expect(out.abortedAfterEvilCancel).not.toContain('slow-2');
    expect(out.abortedAfterBadVersion).not.toContain('slow-2');
    // …and the shell's own cancel for the same id DID work, which is what
    // makes the two above a refusal rather than a broken cancel path.
    expect(out.aborted).toContain('slow-2');

    // NEGATIVE control: a foreign envelope version is refused structurally,
    // and a reused in-flight id is refused rather than aliasing two calls onto
    // one cancel.
    expect(out.mismatchedCode).toBe('protocol-mismatch');
    expect(out.duplicateCode).toBe('bad-request');
  } finally {
    await app.close();
  }
});
