// e2e/_helpers/preflight-devices.ts
//
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

/**
 * Clear the per-machine rig store ONCE per test, on the first page load, gated
 * by a sessionStorage sentinel that SURVIVES a reload — so a mid-test reload
 * keeps the binding under test, but a leak from a prior test can never make a
 * bind+assert pass vacuously.
 */
export async function clearRigStoreOnce(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    try {
      const ss = (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage;
      const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
      if (ss && ls && !ss.getItem('__rigTestCleared')) {
        ls.removeItem(key);
        ss.setItem('__rigTestCleared', '1');
      }
    } catch {
      /* private mode / partial window */
    }
  }, RIG_LS_KEY);
}

/** Seed the rig store directly in localStorage BEFORE boot — the shape a prior
 *  pre-flight session left on disk. Used by the relaunch-guard spec to arrive at
 *  /rack already-bound without driving the whole UI. Runs after clearRigStoreOnce
 *  so it wins. */
export async function seedRigStore(page: Page, bindings: unknown): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      try {
        (globalThis as unknown as { localStorage?: Storage }).localStorage?.setItem(
          key,
          JSON.stringify(value),
        );
      } catch {
        /* private mode */
      }
    },
    { key: RIG_LS_KEY, value: bindings },
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
