// present-window.test.ts
//
// Unit coverage for the present-on-second-display controller's PURE logic,
// run in the `node` vitest env (no real DOM / second monitor). We cover:
//   1. computePopupFeatures — popup `features` string from a screen rect
//      (placement + size, integer rounding, null/degenerate fallback).
//   2. startPresent — opens a popup at the target rect, and on the `ready`
//      handshake finds the popup's sink <canvas> + 2D ctx and starts a
//      requestAnimationFrame loop that black-fills + draws the source canvas
//      into it. stop() cancels the loop AND closes the popup; the watchdog
//      detects the user closing the popup.
//   3. Graceful no-op when the popup is blocked (returns null).

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
    // Default is a large-ish window so it covers a decent area.
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

/** A fake 2D context recording its draw calls. */
function fakeCtx() {
  return {
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  };
}

/** A fake source canvas with real pixel dims so the blit actually draws. */
function fakeSourceCanvas(width = 1920, height = 1080): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement;
}

/** A fake popup Window whose document exposes the sink <canvas> (with a stub
 *  2D ctx) via querySelector. Tracks postMessage + close + closed state. */
function fakePopup(opts?: { withCanvas?: boolean; dstW?: number; dstH?: number }) {
  const ctx = fakeCtx();
  const dst = {
    width: opts?.dstW ?? 2560,
    height: opts?.dstH ?? 1440,
    getContext: vi.fn(() => ctx),
  };
  const posted: Array<{ data: unknown; origin: string }> = [];
  const popup = {
    closed: false,
    close: vi.fn(() => {
      popup.closed = true;
    }),
    postMessage: vi.fn((data: unknown, origin: string) => {
      posted.push({ data, origin });
    }),
    document: {
      querySelector: vi.fn((sel: string) =>
        opts?.withCanvas === false ? null : sel.includes('present-canvas') ? dst : null,
      ),
    },
  };
  return { popup, posted, ctx, dst };
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

/** A controllable rAF: callbacks queue, tick() runs the currently-queued ones
 *  (one frame). Tracks cancelled handles so a cancel really stops the loop. */
function fakeRaf() {
  let nextId = 1;
  const queue = new Map<number, FrameRequestCallback>();
  const cancelled = new Set<number>();
  return {
    raf: (cb: FrameRequestCallback) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    caf: (id: number) => {
      cancelled.add(id);
      queue.delete(id);
    },
    /** Run all callbacks queued at this instant (a single animation frame). */
    tick() {
      const now = [...queue.entries()];
      queue.clear();
      for (const [id, cb] of now) {
        if (!cancelled.has(id)) cb(performance.now?.() ?? 0);
      }
    },
    pending: () => queue.size,
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

  it('opens a popup at the target rect and blits the canvas into the sink on ready', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, ctx, dst } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();
    const rect: ScreenRect = { left: 1920, top: 0, width: 2560, height: 1440 };

    const session = startPresent({
      canvas,
      rect,
      openWindow,
      url: '/present',
      raf: sched.raf,
      caf: sched.caf,
    });
    expect(session).not.toBeNull();
    expect(session!.closed).toBe(false);

    // Opened at /present with the rect-derived features.
    expect(openWindow).toHaveBeenCalledWith(
      '/present',
      '_blank',
      'popup,left=1920,top=0,width=2560,height=1440',
    );
    // No blit before the popup is ready.
    expect(ctx.drawImage).not.toHaveBeenCalled();

    // Popup signals ready -> we poll for its canvas (100ms), find it, start rAF.
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);
    expect(dst.getContext).toHaveBeenCalled();

    // One animation frame -> black fill + a single letterboxed drawImage.
    sched.tick();
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    // 1920x1080 source into a 2560x1440 dst (both 16:9) -> full-bleed, centered.
    const [src, x, y, w, h] = ctx.drawImage.mock.calls[0];
    expect(src).toBe(canvas);
    expect(w).toBe(2560);
    expect(h).toBe(1440);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('delegates fullscreen to the popup on ready (Capability Delegation) so it can go true-fullscreen with no click', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, posted } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
    // Before ready: no delegation yet.
    expect(posted.some((p) => (p.data as { type?: string })?.type === 'present:go-fullscreen')).toBe(false);

    // On ready, the opener posts a fullscreen-delegated message to the popup.
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    const fs = posted.find((p) => (p.data as { type?: string })?.type === 'present:go-fullscreen');
    expect(fs, 'a present:go-fullscreen message is posted to the popup').toBeDefined();
    // The second postMessage arg carries the Capability-Delegation option.
    const opts = fs!.origin as unknown as { targetOrigin?: string; delegate?: string };
    expect(opts.delegate).toBe('fullscreen');
    expect(opts.targetOrigin).toBe('http://localhost');
  });

  it('letterboxes a 4:3 source into a 16:9 sink (pillarbox, height-fill)', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas(640, 480); // 4:3
    const { popup, ctx } = fakePopup({ dstW: 1920, dstH: 1080 }); // 16:9
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);
    sched.tick();

    const [, x, y, w, h] = ctx.drawImage.mock.calls[0];
    // 4:3 height-fills 1080 -> w = 1080 * 4/3 = 1440, centered horizontally.
    expect(h).toBe(1080);
    expect(w).toBe(1440);
    expect(x).toBe(Math.round((1920 - 1440) / 2)); // 240
    expect(y).toBe(0);
  });

  it('keeps drawing each frame while the loop runs', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, ctx } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);

    sched.tick();
    sched.tick();
    sched.tick();
    expect(ctx.drawImage).toHaveBeenCalledTimes(3);
  });

  it('ignores ready messages from a different window (same-origin guard)', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, dst } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
    // A message from some OTHER source must not start the blit.
    env.fireMessage({ source: {}, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(200);
    expect(dst.getContext).not.toHaveBeenCalled();
  });

  it('stop() closes the popup AND cancels the blit loop', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, ctx } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    const session = startPresent({
      canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf,
    })!;
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);
    sched.tick();
    const drawsBefore = ctx.drawImage.mock.calls.length;

    session.stop();
    expect(popup.close).toHaveBeenCalledOnce();
    expect(session.closed).toBe(true);

    // No further frames are scheduled/run after stop().
    sched.tick();
    expect(ctx.drawImage.mock.calls.length).toBe(drawsBefore);
  });

  it('detects the user closing the popup (watchdog) + stops the loop', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, ctx } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    const session = startPresent({
      canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf,
    })!;
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);
    sched.tick();
    const drawsBefore = ctx.drawImage.mock.calls.length;
    expect(session.closed).toBe(false);

    // Simulate the user closing the OS window, then let the watchdog tick.
    popup.closed = true;
    vi.advanceTimersByTime(600);
    expect(session.closed).toBe(true);

    // Loop cancelled -> no more draws.
    sched.tick();
    expect(ctx.drawImage.mock.calls.length).toBe(drawsBefore);
  });

  it('no-ops (null) when the popup is blocked', () => {
    installWindow();
    const canvas = fakeSourceCanvas();
    const openWindow = vi.fn(() => null); // popup blocked

    const session = startPresent({ canvas, rect: null, openWindow });
    expect(session).toBeNull();
  });
});
