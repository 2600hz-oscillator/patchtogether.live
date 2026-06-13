// use-fullscreen.test.ts
//
// Unit coverage for the fullscreen controller's multi-monitor support
// (Window Management API) and its graceful fallback. We run in the `node`
// vitest env, so we stub a minimal `window`/`document` and a fake target
// element whose requestFullscreen records the options it was called with.
//
// Three contracts under test:
//   1. Chromium w/ getScreenDetails + 2 screens -> availableScreens has both,
//      enter(secondaryId) calls requestFullscreen({ screen: <that screen> }),
//      and enter() / enter('primary') call PLAIN requestFullscreen().
//   2. Firefox/Safari (no getScreenDetails) -> availableScreens stays [] and
//      enter() still does plain fullscreen without throwing.
//   3. Single-monitor Chromium (1 screen) -> availableScreens stays [] (no
//      multi-display menu) but the API path still works.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFullscreen } from './use-fullscreen.svelte';

// ---- Fakes ----

interface FakeScreen {
  label: string;
  isPrimary: boolean;
  // Optional working-area geometry — present on real ScreenDetailed objects,
  // used by getScreenRect() for present-popup placement.
  availLeft?: number;
  availTop?: number;
  availWidth?: number;
  availHeight?: number;
}

/** A fake element recording each requestFullscreen call's options. */
function fakeTarget() {
  const calls: Array<{ screen?: FakeScreen } | undefined> = [];
  return {
    el: {
      requestFullscreen: vi.fn((opts?: { screen?: FakeScreen }) => {
        calls.push(opts);
        return Promise.resolve();
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    calls,
  };
}

/** A fake ScreenDetails container with a screenschange EventTarget. */
function fakeScreenDetails(screens: FakeScreen[]) {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    screens,
    addEventListener: vi.fn((type: string, fn: () => void) => {
      (listeners[type] ??= []).push(fn);
    }),
    removeEventListener: vi.fn(),
    fire(type: string) {
      for (const l of listeners[type] ?? []) l();
    },
  };
}

function installWindow(getScreenDetails?: () => Promise<unknown>) {
  const win: Record<string, unknown> = {};
  if (getScreenDetails) win.getScreenDetails = getScreenDetails;
  // Minimal document so attach()/syncFromDocument() don't explode if touched.
  const doc = {
    fullscreenElement: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  return { win, doc };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createFullscreen — multi-monitor (Window Management API)', () => {
  it('lists both displays and targets the secondary via { screen }', async () => {
    const primary: FakeScreen = { label: 'Built-in Retina', isPrimary: true };
    const secondary: FakeScreen = { label: 'DELL U2720Q', isPrimary: false };
    const details = fakeScreenDetails([primary, secondary]);
    installWindow(() => Promise.resolve(details));

    const fs = createFullscreen();
    const { el, calls } = fakeTarget();
    fs.setTarget(el as unknown as HTMLElement);

    await fs.loadScreens();

    // Both displays surfaced; primary flagged.
    expect(fs.availableScreens).toHaveLength(2);
    const prim = fs.availableScreens.find((s) => s.isPrimary);
    const sec = fs.availableScreens.find((s) => !s.isPrimary);
    expect(prim?.id).toBe('primary');
    expect(sec?.label).toBe('DELL U2720Q');

    // enter(secondaryId) -> requestFullscreen({ screen: <secondary> }).
    await fs.enter(sec!.id);
    expect(calls.at(-1)).toEqual({ screen: secondary });

    // enter('primary') -> plain fullscreen (no screen option).
    await fs.enter('primary');
    expect(calls.at(-1)).toBeUndefined();

    // enter() with no arg -> plain fullscreen.
    await fs.enter();
    expect(calls.at(-1)).toBeUndefined();
  });

  it('labels an unnamed display "Display N"', async () => {
    const details = fakeScreenDetails([
      { label: '', isPrimary: true },
      { label: '', isPrimary: false },
    ]);
    installWindow(() => Promise.resolve(details));
    const fs = createFullscreen();
    fs.setTarget(fakeTarget().el as unknown as HTMLElement);
    await fs.loadScreens();
    const sec = fs.availableScreens.find((s) => !s.isPrimary);
    expect(sec?.label).toBe('Display 2');
  });

  it('updates availableScreens on screenschange (monitor unplugged)', async () => {
    const details = fakeScreenDetails([
      { label: 'A', isPrimary: true },
      { label: 'B', isPrimary: false },
    ]);
    installWindow(() => Promise.resolve(details));
    const fs = createFullscreen();
    fs.setTarget(fakeTarget().el as unknown as HTMLElement);
    await fs.loadScreens();
    expect(fs.availableScreens).toHaveLength(2);

    // Unplug the secondary -> screenschange -> single display -> menu collapses.
    details.screens = [{ label: 'A', isPrimary: true }];
    details.fire('screenschange');
    expect(fs.availableScreens).toEqual([]);
  });

  it('loadScreens() is idempotent (only one getScreenDetails call)', async () => {
    const details = fakeScreenDetails([
      { label: 'A', isPrimary: true },
      { label: 'B', isPrimary: false },
    ]);
    const get = vi.fn(() => Promise.resolve(details));
    installWindow(get);
    const fs = createFullscreen();
    fs.setTarget(fakeTarget().el as unknown as HTMLElement);
    await fs.loadScreens();
    await fs.loadScreens();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('getScreenRect() returns the working-area rect for a known display (present popup placement)', async () => {
    // Real ScreenDetailed objects carry availLeft/Top/Width/Height; include
    // them on the fakes so getScreenRect can resolve the popup placement.
    const details = fakeScreenDetails([
      { label: 'Primary', isPrimary: true, availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 },
      { label: 'DELL U2720Q', isPrimary: false, availLeft: 1920, availTop: 0, availWidth: 2560, availHeight: 1440 },
    ] as FakeScreen[]);
    installWindow(() => Promise.resolve(details));
    const fs = createFullscreen();
    fs.setTarget(fakeTarget().el as unknown as HTMLElement);
    await fs.loadScreens();

    const sec = fs.availableScreens.find((s) => !s.isPrimary)!;
    expect(fs.getScreenRect(sec.id)).toEqual({
      left: 1920,
      top: 0,
      width: 2560,
      height: 1440,
    });
    // Unknown id -> null (caller falls back to a default popup size).
    expect(fs.getScreenRect('display-99')).toBeNull();
  });

  it('getScreenRect() returns null when a display lacks geometry (partial stub)', async () => {
    const details = fakeScreenDetails([
      { label: 'A', isPrimary: true },
      { label: 'B', isPrimary: false },
    ]);
    installWindow(() => Promise.resolve(details));
    const fs = createFullscreen();
    fs.setTarget(fakeTarget().el as unknown as HTMLElement);
    await fs.loadScreens();
    const sec = fs.availableScreens.find((s) => !s.isPrimary)!;
    expect(fs.getScreenRect(sec.id)).toBeNull();
  });
});

describe('createFullscreen — single-monitor Chromium', () => {
  it('keeps availableScreens empty (no multi-display menu) but still works', async () => {
    const details = fakeScreenDetails([{ label: 'Only', isPrimary: true }]);
    installWindow(() => Promise.resolve(details));
    const fs = createFullscreen();
    const { el, calls } = fakeTarget();
    fs.setTarget(el as unknown as HTMLElement);
    await fs.loadScreens();
    expect(fs.availableScreens).toEqual([]);
    await fs.enter();
    expect(calls.at(-1)).toBeUndefined();
  });
});

describe('createFullscreen — Firefox/Safari (no Window Management API)', () => {
  it('availableScreens stays [] and enter() does plain fullscreen (no throw)', async () => {
    installWindow(/* no getScreenDetails */);
    const fs = createFullscreen();
    const { el, calls } = fakeTarget();
    fs.setTarget(el as unknown as HTMLElement);

    await expect(fs.loadScreens()).resolves.toBeUndefined();
    expect(fs.availableScreens).toEqual([]);

    await fs.enter();
    expect(el.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toBeUndefined();
  });

  it('enter(someId) with no screens falls back to plain fullscreen', async () => {
    installWindow();
    const fs = createFullscreen();
    const { el, calls } = fakeTarget();
    fs.setTarget(el as unknown as HTMLElement);
    await fs.enter('display-1');
    expect(calls.at(-1)).toBeUndefined();
  });
});

describe('createFullscreen — permission denied', () => {
  it('getScreenDetails rejection -> availableScreens [] (single-display)', async () => {
    installWindow(() => Promise.reject(new Error('NotAllowedError')));
    const fs = createFullscreen();
    const { el, calls } = fakeTarget();
    fs.setTarget(el as unknown as HTMLElement);
    await fs.loadScreens();
    expect(fs.availableScreens).toEqual([]);
    await fs.enter();
    expect(calls.at(-1)).toBeUndefined();
  });
});
