// The fake device rig for the Stage-1 pre-flight spec set. Each installer is an
// addInitScript (runs BEFORE the app boots, and RE-RUNS on every navigation, so
// a fake survives a reload/relaunch — the persistence leg depends on that). All
// fakes are REAL IN SHAPE (a genuine MediaStreamTrack whose stop() flips
// readyState; getScreenDetails resolving a live-shaped ScreenDetails), so the
// UI moves for the right reasons.
//
// The WebMIDI double is the shared `installMidiDeviceMock` from `./midi` — the
// pre-flight's push2 / launchpad / ptz rows call the real device modules'
// `connect()` → `navigator.requestMIDIAccess({sysex:true})`, which the mock
// answers with named ports the modules' own presence predicates match.

import type { Page } from '@playwright/test';

const RIG_LS_KEY = 'pt:rig-bindings:v1';
/** Where `installFakeShell`'s `bindings.*` ops persist — a localStorage stand-in
 *  for the shell's electron-store, so a bind SURVIVES a reload under the stub the
 *  way it survives a relaunch under the real shell. Never read by the app: the
 *  app only ever sees it through the fake bridge. */
export const FAKE_SHELL_STORE_KEY = 'pt:fake-shell:bindings:v1';
/** sessionStorage key the fake shell writes when `preflight.done` performed the
 *  window swap — the landing document's proof that the hand-off went through
 *  the bridge, not a client `goto`. */
export const FAKE_SHELL_SWAP_KEY = 'pt:fake-shell:last-swap';

/**
 * Clear the per-machine rig store ONCE per test, on the first page load, gated
 * by a sessionStorage sentinel that SURVIVES a reload — so a mid-test reload
 * keeps the binding under test, but a leak from a prior test can never make a
 * bind+assert pass vacuously.
 */
export async function clearRigStoreOnce(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, shellKey }) => {
      try {
        const ss = (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage;
        const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
        if (ss && ls && !ss.getItem('__rigTestCleared')) {
          ls.removeItem(key);
          ls.removeItem(shellKey); // the fake shell's electron-store stand-in (installFakeShell)
          ss.setItem('__rigTestCleared', '1');
        }
      } catch {
        /* private mode / partial window */
      }
    },
    { key: RIG_LS_KEY, shellKey: FAKE_SHELL_STORE_KEY },
  );
}

/** Seed the rig store directly in localStorage BEFORE boot — the shape a prior
 *  session left on disk. Used to arrive at /rack already-bound without driving
 *  the whole UI. Runs after clearRigStoreOnce so it wins.
 *
 *  ⚠ ONCE PER TEST (a sessionStorage sentinel, like clearRigStoreOnce): the init
 *  script re-runs on every document, and a seed that re-applied on a reload
 *  would silently overwrite whatever the rack itself wrote in between — the
 *  exact thing a "bind in the rack, reload, still bound" leg is measuring. */
export async function seedRigStore(page: Page, bindings: unknown): Promise<void> {
  await page.addInitScript(
    ({ key, shellKey, value }) => {
      try {
        const ss = (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage;
        const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
        if (!ss || !ls || ss.getItem('__rigTestSeeded')) return;
        // Both backends: the browser's own key AND the fake shell's persisted
        // store, so a seed reads the same whether or not installFakeShell ran.
        ls.setItem(key, JSON.stringify(value));
        ls.setItem(shellKey, JSON.stringify(value));
        ss.setItem('__rigTestSeeded', '1');
      } catch {
        /* private mode */
      }
    },
    { key: RIG_LS_KEY, shellKey: FAKE_SHELL_STORE_KEY, value: bindings },
  );
}

export interface FakeScreen {
  label: string;
  isPrimary?: boolean;
  isInternal?: boolean;
  width: number;
  height: number;
  devicePixelRatio?: number;
  left?: number;
  top?: number;
}

/** Stub `window.getScreenDetails()` with a live-shaped ScreenDetails. Real
 *  geometry fields so `describeScreen` produces distinct fingerprints and
 *  `assignScreenIds` gives each a stable id. */
export async function installFakeScreens(page: Page, screens: FakeScreen[]): Promise<void> {
  await page.addInitScript((list) => {
    const built = list.map((s, i) => ({
      label: s.label,
      isPrimary: s.isPrimary ?? i === 0,
      isInternal: s.isInternal ?? false,
      width: s.width,
      height: s.height,
      devicePixelRatio: s.devicePixelRatio ?? 1,
      left: s.left ?? 0,
      top: s.top ?? 0,
      availLeft: s.left ?? 0,
      availTop: s.top ?? 0,
      availWidth: s.width,
      availHeight: s.height,
    }));
    const details: EventTarget & { screens: unknown[]; currentScreen: unknown } = Object.assign(
      new EventTarget(),
      { screens: built, currentScreen: built[0] },
    );
    (window as unknown as { getScreenDetails: () => Promise<unknown> }).getScreenDetails = () =>
      Promise.resolve(details);
  }, screens);
}

export interface FakeCamera {
  deviceId: string;
  label: string;
}

/**
 * Stub `enumerateDevices` (videoinput entries, REAL labels) + `getUserMedia`
 * (a 30 fps canvas capture — a genuine live MediaStreamTrack). Non-empty labels
 * are load-bearing: the pre-flight enumerates before a grant with labels
 * redacted, and the /rack auto-acquire fires only once labels are visible.
 * Pass `labelsRedactedUntilGrant: true` to model the pre-permission state where
 * labels are empty until getUserMedia is called (like a real browser).
 */
export async function installFakeCameras(
  page: Page,
  cams: FakeCamera[],
  opts: { labelsRedactedUntilGrant?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ({ cams, redact }) => {
      const g = globalThis as unknown as {
        __fakeCamRig: { streams: MediaStream[]; timers: number[]; granted: boolean; dispose(): void };
        navigator: Navigator;
      };
      const rig = {
        streams: [] as MediaStream[],
        timers: [] as number[],
        granted: !redact,
        dispose() {
          for (const t of rig.timers) clearInterval(t);
          for (const s of rig.streams) for (const tr of s.getTracks()) tr.stop();
          rig.streams.length = 0;
          rig.timers.length = 0;
        },
      };
      g.__fakeCamRig = rig;

      const mintStream = (): MediaStream => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext('2d');
        const draw = (): void => {
          if (!ctx) return;
          ctx.fillStyle = `rgb(${(Date.now() / 33) % 200 | 0},60,90)`;
          ctx.fillRect(0, 0, 320, 240);
          ctx.fillStyle = `rgb(${(Date.now() / 17) % 255 | 0},0,0)`;
          ctx.fillRect(0, 0, 4, 4);
        };
        draw();
        const stream = (
          canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }
        ).captureStream(30);
        rig.timers.push(setInterval(draw, 33) as unknown as number);
        rig.streams.push(stream);
        return stream;
      };

      const nav = g.navigator as Navigator & { mediaDevices?: unknown };
      if (!nav.mediaDevices) {
        Object.defineProperty(nav, 'mediaDevices', { value: {}, configurable: true });
      }
      const md = nav.mediaDevices as {
        enumerateDevices: () => Promise<unknown[]>;
        getUserMedia: (c?: unknown) => Promise<MediaStream>;
        addEventListener?: (t: string, f: () => void) => void;
        removeEventListener?: (t: string, f: () => void) => void;
        dispatchEvent?: (e: Event) => boolean;
      };
      const listeners = new Set<() => void>();
      md.enumerateDevices = () =>
        Promise.resolve(
          cams.map((c) => ({
            deviceId: c.deviceId,
            kind: 'videoinput',
            label: rig.granted ? c.label : '',
            groupId: 'g-cam',
          })),
        );
      md.getUserMedia = () => {
        rig.granted = true;
        // A real grant de-redacts labels → devicechange fires.
        for (const l of listeners) l();
        return Promise.resolve(mintStream());
      };
      md.addEventListener = (t, f) => {
        if (t === 'devicechange') listeners.add(f);
      };
      md.removeEventListener = (t, f) => {
        if (t === 'devicechange') listeners.delete(f);
      };
    },
    { cams, redact: opts.labelsRedactedUntilGrant === true },
  );
}

/** Inject a fake gamepad into `navigator.getGamepads()` AFTER load, and fire a
 *  `gamepadconnected` event so the pre-flight's poll picks it up immediately. */
export async function installFakeGamepad(
  page: Page,
  pad: { id: string; index?: number },
): Promise<void> {
  await page.evaluate((p) => {
    const fake = {
      id: p.id,
      index: p.index ?? 0,
      connected: true,
      timestamp: performance.now(),
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    const w = globalThis as unknown as { __fakePad: typeof fake };
    w.__fakePad = fake;
    const slots: (typeof fake | null)[] = [null, null, null, null];
    slots[fake.index] = w.__fakePad;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).getGamepads = () => slots;
    window.dispatchEvent(new Event('gamepadconnected'));
  }, pad);
}

/** Read the current rig-store snapshot via the `__rigBindings` hook the
 *  pre-flight route publishes under testHooksEnabled(). */
export async function readRig(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __rigBindings?: () => Record<string, unknown> };
    return w.__rigBindings ? w.__rigBindings() : {};
  });
}

/** Dispose the fake camera rig (afterEach). */
export async function disposeFakeCameras(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      (globalThis as unknown as { __fakeCamRig?: { dispose(): void } }).__fakeCamRig?.dispose();
    })
    .catch(() => {});
}

// ── THE FAKE NATIVE SHELL ─────────────────────────────────────────────────────
//
// `/preflight` is SHELL-ONLY and the `/rack` relaunch guard runs only under the
// shell, so every pre-flight spec boots under this stub: a `window.ptNative`
// that mirrors the preload contract exactly (apps/desktop/src/preload.ts) —
// `nativeAvailable()` → true (so `nativeAvailable()` takes the shell branch AND
// the rig store picks the bridge backend), `command()` RESOLVES the
// `{ok,result}|{ok,error}` envelope, `onEvent()` delivers live `helpers.status`
// pushes. `bindings.get/set` persist in localStorage under FAKE_SHELL_STORE_KEY
// (the electron-store stand-in) and `preflight.done` performs the shell's window
// swap (`win.loadURL('/rack')`, main.ts) as a plain navigation. That is enough
// to drive every shell-gated branch without an Electron process; the REAL
// supervisors + electron-store round-trip live in apps/desktop/e2e.

export type FakeHelperMode = 'ok' | 'fail';

export interface FakeShellOptions {
  /** How `helpers.status` answers: 'ok' → es9 running / ptz stopped (binary not
   *  found); 'fail' → a RETRYABLE error envelope (the shape the pre-flight retry
   *  affordance keys off). Default 'ok'. */
  helpers?: FakeHelperMode;
}

/** Install the fake shell BEFORE boot (re-runs on every navigation, so the
 *  stub survives a reload / the preflight.done swap). Exposes `__ptCalls` (every
 *  op issued, in order) and `__fireHelper(status)` (a live helpers.status push). */
export async function installFakeShell(page: Page, opts: FakeShellOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ mode, storeKey, swapKey }) => {
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
      const readStore = (): unknown => {
        try {
          const raw = localStorage.getItem(storeKey);
          return raw ? JSON.parse(raw) : {};
        } catch {
          return {};
        }
      };
      const writeStore = (v: unknown): void => {
        try {
          localStorage.setItem(storeKey, JSON.stringify(v ?? {}));
        } catch {
          /* private mode */
        }
      };
      w.ptNative = {
        nativeAvailable: () => true,
        shellVersion: () => '0.0.0-test',
        bridgeVersion: () => 1,
        command: (op: string, payload?: unknown) => {
          w.__ptCalls.push(op);
          if (op === 'helpers.status') {
            return mode === 'ok'
              ? Promise.resolve(okStatus)
              : Promise.resolve({ ok: false, error: { code: 'internal', message: 'transient', retryable: true } });
          }
          if (op === 'bindings.get') return Promise.resolve({ ok: true, result: readStore() });
          if (op === 'bindings.set') {
            writeStore(payload);
            return Promise.resolve({ ok: true, result: {} });
          }
          if (op === 'preflight.done') {
            // The shell swaps the SAME window from /preflight to /rack. The
            // swap is a new document (this closure's `__ptCalls` dies with the
            // old one), so the fact of the swap is left in sessionStorage
            // under FAKE_SHELL_SWAP_KEY for the landing page's spec to read.
            try {
              sessionStorage.setItem(swapKey, 'preflight.done');
            } catch {
              /* private mode */
            }
            queueMicrotask(() => location.assign('/rack'));
            return Promise.resolve({ ok: true, result: {} });
          }
          return Promise.resolve({ ok: true, result: {} });
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
    },
    { mode: opts.helpers ?? 'ok', storeKey: FAKE_SHELL_STORE_KEY, swapKey: FAKE_SHELL_SWAP_KEY },
  );
}

/**
 * Add `audiooutput` entries to whatever `enumerateDevices` is already installed
 * (installFakeCameras, or the real one) and make `AudioContext.setSinkId`
 * feature-detect as SUPPORTED, recording the id it was last called with on
 * `__appliedSink` — the in-rack audio-out picker's write is observable through
 * the rig store, and its APPLY through that recorder. Install BEFORE boot,
 * AFTER installFakeCameras.
 */
export async function installFakeAudioSinks(
  page: Page,
  sinks: { deviceId: string; label: string }[],
): Promise<void> {
  await page.addInitScript((list) => {
    const g = globalThis as unknown as {
      __appliedSink: string | null;
      navigator: Navigator;
      AudioContext?: { prototype: { setSinkId?: (id: string) => Promise<void> } };
    };
    g.__appliedSink = null;
    const md = g.navigator.mediaDevices as { enumerateDevices: () => Promise<unknown[]> };
    const inner = md.enumerateDevices.bind(md);
    md.enumerateDevices = async () => [
      ...(await inner()),
      ...list.map((s) => ({ deviceId: s.deviceId, kind: 'audiooutput', label: s.label, groupId: 'g-sink' })),
    ];
    const proto = g.AudioContext?.prototype;
    if (proto) {
      proto.setSinkId = function (id: string): Promise<void> {
        g.__appliedSink = id;
        return Promise.resolve();
      };
    }
  }, sinks);
}
