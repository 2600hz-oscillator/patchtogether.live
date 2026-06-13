// present-window.test.ts
//
// Unit coverage for the present-on-second-display controller's PURE logic,
// run in the `node` vitest env (no real DOM / second monitor). We cover:
//   1. computePopupFeatures — popup `features` string from a screen rect
//      (placement + size, integer rounding, null/degenerate fallback).
//   2. startPresent — taps the canvas (captureStream), opens a popup at the
//      target rect, hands over the stream on the ready handshake, and on
//      stop() closes the popup AND stops every captured track.
//   3. Graceful no-op when captureStream is unsupported or the popup is
//      blocked (returns null, no leaked tracks).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computePopupFeatures, startPresent } from './present-window';
import type { ScreenRect } from './use-fullscreen.svelte';

describe('computePopupFeatures', () => {
  it('places + sizes the popup from a screen working-area rect', () => {
    const rect: ScreenRect = { left: 1920, top: 0, width: 2560, height: 1440 };
    expect(computePopupFeatures(rect)).toBe(
      'popup,left=1920,top=0,width=2560,height=1440',
    );
  });

  it('rounds fractional rect values to integers', () => {
    const rect: ScreenRect = { left: 1919.6, top: 12.4, width: 2559.9, height: 1439.2 };
    expect(computePopupFeatures(rect)).toBe(
      'popup,left=1920,top=12,width=2560,height=1439',
    );
  });

  it('falls back to a default size when rect is null', () => {
    const f = computePopupFeatures(null);
    expect(f).toContain('popup');
    expect(f).toMatch(/width=\d+/);
    expect(f).toMatch(/height=\d+/);
    // Default is a large-ish window so the sink has room to fullscreen.
    expect(f).toContain('width=1280');
    expect(f).toContain('height=720');
  });

  it('falls back to default WxH on a degenerate 0x0 rect (keeps the placement)', () => {
    const rect: ScreenRect = { left: 100, top: 50, width: 0, height: 0 };
    expect(computePopupFeatures(rect)).toBe(
      'popup,left=100,top=50,width=1280,height=720',
    );
  });
});

// ---- startPresent fakes ----

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
}
interface FakeStream {
  getTracks: () => FakeTrack[];
}

/** A fake canvas whose captureStream returns a stream with one stoppable track. */
function fakeCanvas(opts?: { noCapture?: boolean }) {
  const track: FakeTrack = { stop: vi.fn() };
  const stream: FakeStream = { getTracks: () => [track] };
  const canvas = {
    captureStream: opts?.noCapture ? undefined : vi.fn(() => stream),
  } as unknown as HTMLCanvasElement;
  return { canvas, stream, track };
}

/** A fake popup Window: tracks postMessage + close + whether it's closed, and
 *  records anything assigned to __presentStream. */
function fakePopup() {
  const posted: Array<{ data: unknown; origin: string }> = [];
  let closed = false;
  const popup = {
    closed: false,
    close: vi.fn(() => {
      closed = true;
      popup.closed = true;
    }),
    postMessage: vi.fn((data: unknown, origin: string) => {
      posted.push({ data, origin });
    }),
    __presentStream: undefined as unknown,
    get isClosed() {
      return closed;
    },
  };
  return { popup, posted };
}

/** Install a minimal window (origin + add/removeEventListener) so startPresent
 *  can register its message listener + watchdog. Returns a fire() to dispatch
 *  a fake message event to the registered handler. */
function installWindow() {
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const win = {
    location: { origin: 'http://localhost' },
    addEventListener: vi.fn((type: string, fn: (ev: unknown) => void) => {
      (listeners[type] ??= []).push(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (ev: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    }),
  };
  vi.stubGlobal('window', win);
  return {
    win,
    fireMessage(ev: unknown) {
      for (const fn of listeners['message'] ?? []) fn(ev);
    },
    messageListenerCount: () => (listeners['message'] ?? []).length,
  };
}

describe('startPresent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('captures the canvas, opens a popup at the target rect, and hands over the stream on ready', () => {
    const env = installWindow();
    const { canvas, stream } = fakeCanvas();
    const { popup, posted } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const rect: ScreenRect = { left: 1920, top: 0, width: 2560, height: 1440 };

    const session = startPresent({ canvas, rect, openWindow, url: '/present' });
    expect(session).not.toBeNull();
    expect(session!.closed).toBe(false);

    // Opened at /present with the rect-derived features.
    expect(openWindow).toHaveBeenCalledWith(
      '/present',
      '_blank',
      'popup,left=1920,top=0,width=2560,height=1440',
    );

    // Popup signals ready -> stream is handed over + sink told to attach.
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    expect(popup.__presentStream).toBe(stream);
    expect(posted.at(-1)?.data).toEqual({ type: 'present:stream-ready' });
    expect(posted.at(-1)?.origin).toBe('http://localhost');
  });

  it('ignores ready messages from a different window (same-origin guard)', () => {
    const env = installWindow();
    const { canvas } = fakeCanvas();
    const { popup } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);

    startPresent({ canvas, rect: null, openWindow });
    // A message from some OTHER source must not deliver the stream.
    env.fireMessage({ source: {}, data: { type: 'present:ready' } });
    expect(popup.__presentStream).toBeUndefined();
  });

  it('stop() closes the popup AND stops every captured track', () => {
    installWindow();
    const { canvas, track } = fakeCanvas();
    const { popup } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);

    const session = startPresent({ canvas, rect: null, openWindow })!;
    session.stop();

    expect(popup.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(session.closed).toBe(true);
  });

  it('detects the user closing the popup (watchdog) + releases the tap', () => {
    installWindow();
    const { canvas, track } = fakeCanvas();
    const { popup } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);

    const session = startPresent({ canvas, rect: null, openWindow })!;
    expect(session.closed).toBe(false);

    // Simulate the user closing the OS window, then let the watchdog tick.
    popup.closed = true;
    vi.advanceTimersByTime(600);

    expect(session.closed).toBe(true);
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('no-ops (null) when captureStream is unsupported — nothing opened', () => {
    installWindow();
    const { canvas } = fakeCanvas({ noCapture: true });
    const openWindow = vi.fn(() => fakePopup().popup as unknown as Window);

    const session = startPresent({ canvas, rect: null, openWindow });
    expect(session).toBeNull();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('no-ops (null) + releases the tap when the popup is blocked', () => {
    installWindow();
    const { canvas, track } = fakeCanvas();
    const openWindow = vi.fn(() => null); // popup blocked

    const session = startPresent({ canvas, rect: null, openWindow });
    expect(session).toBeNull();
    // The capture tap we opened before the blocked popup must be released.
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
