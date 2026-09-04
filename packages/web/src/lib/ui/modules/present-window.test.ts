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
import {
  automaticFullscreenBlockedAdvisory,
  computePopupFeatures,
  sinkUrl,
  startPresent,
  type StartPresentArgs,
} from './present-window';
import { presentBlitSevered, setPresentBlitSevered } from './present-blit-sever';
import { testHooksEnabled } from '$lib/dev/test-hooks';
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
    /** Dispatch a fake non-message window event (pointerdown / keydown).
     *  Iterates a copy: a one-shot handler removes itself mid-dispatch. */
    fire(type: string, ev: unknown = {}) {
      for (const fn of [...(listeners[type] ?? [])]) fn(ev);
    },
    listenerCount: (type: string) => (listeners[type] ?? []).length,
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
      source: () => canvas,
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

  it('installs the frame on the POPUP so the SINK owns the clock (#2235)', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, ctx } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ source: () => canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);

    const pull = (popup as unknown as { __presentFrame?: () => void }).__presentFrame;
    expect(pull, 'the opener must install a frame the sink can pull').toBeTypeOf('function');

    // The sink pulling draws a frame WITHOUT the opener's rAF running at all —
    // which is the whole point: the projector keeps painting while the opener
    // is unfocused and its rAF is throttled to nothing.
    pull!();
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it('the opener STOPS drawing once the sink pulls, so one frame is never blitted twice', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, ctx } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ source: () => canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);

    const pull = (popup as unknown as { __presentFrame?: () => void }).__presentFrame!;
    pull();
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);

    // Opener frames now supervise only.
    sched.tick();
    sched.tick();
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it('the OPENER keeps drawing for a sink that never pulls (cached older /present)', () => {
    // The fallback is not decoration: a projector that went black because the
    // two clocks disagreed would be worse than the freeze this change fixes.
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, ctx } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ source: () => canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);

    sched.tick();
    sched.tick();
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
  });

  it('RECLAIMS the clock when a sink that was pulling stops', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, ctx } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ source: () => canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);

    (popup as unknown as { __presentFrame?: () => void }).__presentFrame!();
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    sched.tick();
    expect(ctx.drawImage).toHaveBeenCalledTimes(1); // opener stood down

    // The sink goes quiet (a popup reload). The watchdog hands the clock back.
    vi.advanceTimersByTime(2000);
    sched.tick();
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
  });

  it('delegates fullscreen to the popup on ready (Capability Delegation) so it can go true-fullscreen with no click', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, posted } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ source: () => canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
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

    startPresent({ source: () => canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
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

    startPresent({ source: () => canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
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

    startPresent({ source: () => canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
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
      source: () => canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf,
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
      source: () => canvas, rect: null, openWindow, raf: sched.raf, caf: sched.caf,
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

    const session = startPresent({ source: () => canvas, rect: null, openWindow });
    expect(session).toBeNull();
  });

  // ── THE SOURCE IS RE-RESOLVED EVERY FRAME, AND `prepare` RUNS FIRST ────────
  // Both properties exist because the projector must outlive the CARD that
  // opened it (owner P0 2026-08-12, $lib/ui/modules/node-present-registry).
  // A captured element is the card's; a getter is the node's. And `prepare` is
  // where the registry renders ITS node into the shared engine drawing buffer,
  // which is only valid if it happens in the same synchronous block as the read.
  it('re-reads the source EVERY frame, so a swapped surface is followed', () => {
    const env = installWindow();
    const first = fakeSourceCanvas(1920, 1080);
    const second = fakeSourceCanvas(1920, 1080);
    let current = first;
    const { popup, ctx } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ source: () => current, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);

    sched.tick();
    expect(ctx.drawImage.mock.calls.at(-1)![0]).toBe(first);
    // The surface is replaced underneath the running loop.
    current = second;
    sched.tick();
    expect(
      ctx.drawImage.mock.calls.at(-1)![0],
      'a captured reference would still be drawing the OLD surface here',
    ).toBe(second);
  });

  it('calls prepare() before EVERY read, and stops calling it once cancelled', () => {
    const env = installWindow();
    const canvas = fakeSourceCanvas();
    const { popup, ctx } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();
    const order: string[] = [];
    const prepare = vi.fn(() => order.push('prepare'));
    const drawing = ctx.drawImage as unknown as { mockImplementation: (f: () => void) => void };
    drawing.mockImplementation(() => order.push('draw'));

    const session = startPresent({
      source: () => canvas, prepare, rect: null, openWindow, raf: sched.raf, caf: sched.caf,
    })!;
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);
    // Not before the loop starts.
    expect(prepare).not.toHaveBeenCalled();

    sched.tick();
    sched.tick();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['prepare', 'draw', 'prepare', 'draw']);

    session.stop();
    sched.tick();
    expect(prepare, 'a cancelled loop prepares nothing').toHaveBeenCalledTimes(2);
  });

  it('survives a null source (engine not up yet) without drawing or throwing', () => {
    const env = installWindow();
    const { popup, ctx } = fakePopup();
    const openWindow = vi.fn(() => popup as unknown as Window);
    const sched = fakeRaf();

    startPresent({ source: () => null, rect: null, openWindow, raf: sched.raf, caf: sched.caf });
    env.fireMessage({ source: popup, data: { type: 'present:ready' } });
    vi.advanceTimersByTime(100);
    sched.tick();

    expect(ctx.fillRect, 'still black-fills the sink').toHaveBeenCalled();
    expect(ctx.drawImage, 'but draws nothing').not.toHaveBeenCalled();
  });

  // ── FULLSCREEN VIA THE NEXT GESTURE ────────────────────────────────────────
  // window.open() consumes the click's transient activation, so the on-ready
  // delegation carries none; and without an automatic-fullscreen grant every
  // gesture-less sink attempt rejects ("TypeError: Permissions check failed",
  // Edge 152). The controller therefore re-delegates from the user's NEXT real
  // gesture in the patcher, armed by the sink's own NOT-fullscreen report.

  /** Count present:go-fullscreen posts to the popup. */
  function goFullscreenPosts(posted: Array<{ data: unknown; origin: string }>) {
    return posted.filter(
      (p) => (p.data as { type?: string })?.type === 'present:go-fullscreen',
    );
  }

  it('a sink NOT-fullscreen report arms the NEXT gesture, which delegates ONCE', () => {
    const env = installWindow();
    const { popup, posted } = fakePopup();
    const sched = fakeRaf();
    startPresent({
      source: () => fakeSourceCanvas(), rect: null,
      openWindow: () => popup as unknown as Window, raf: sched.raf, caf: sched.caf,
    });

    env.fireMessage({ source: popup, data: { type: 'present:fs-state', entered: false } });
    expect(goFullscreenPosts(posted).length, 'arming alone posts nothing').toBe(0);

    env.fire('pointerdown');
    const posts = goFullscreenPosts(posted);
    expect(posts.length, 'the gesture handler delegates synchronously').toBe(1);
    // The second postMessage arg must carry the Capability-Delegation option.
    const opts = posts[0].origin as unknown as { delegate?: string; targetOrigin?: string };
    expect(opts.delegate).toBe('fullscreen');
    expect(opts.targetOrigin).toBe('http://localhost');

    // ONE-SHOT: the same arming must not fire again — a delegating post
    // consumes the gesture's activation, so repeating it could only throw.
    env.fire('pointerdown');
    env.fire('keydown');
    expect(goFullscreenPosts(posted).length).toBe(1);
  });

  it('re-arms on every NOT-fullscreen report, and keydown delegates too', () => {
    const env = installWindow();
    const { popup, posted } = fakePopup();
    const sched = fakeRaf();
    startPresent({
      source: () => fakeSourceCanvas(), rect: null,
      openWindow: () => popup as unknown as Window, raf: sched.raf, caf: sched.caf,
    });

    env.fireMessage({ source: popup, data: { type: 'present:fs-state', entered: false } });
    env.fire('keydown');
    expect(goFullscreenPosts(posted).length).toBe(1);

    // The delegated attempt failed too (e.g. delegation unsupported) — the
    // sink's next failing loop re-reports and the opener re-arms.
    env.fireMessage({ source: popup, data: { type: 'present:fs-state', entered: false } });
    env.fire('pointerdown');
    expect(goFullscreenPosts(posted).length).toBe(2);
  });

  it('an entered:true report DISARMS a pending gesture (fullscreen achieved)', () => {
    const env = installWindow();
    const { popup, posted } = fakePopup();
    const sched = fakeRaf();
    startPresent({
      source: () => fakeSourceCanvas(), rect: null,
      openWindow: () => popup as unknown as Window, raf: sched.raf, caf: sched.caf,
    });

    env.fireMessage({ source: popup, data: { type: 'present:fs-state', entered: false } });
    env.fireMessage({ source: popup, data: { type: 'present:fs-state', entered: true } });
    env.fire('pointerdown');
    expect(goFullscreenPosts(posted).length, 'a later gesture delegates nothing').toBe(0);
    expect(env.listenerCount('pointerdown'), 'gesture listeners removed').toBe(0);
    expect(env.listenerCount('keydown')).toBe(0);
  });

  it('stop() disarms the pending gesture with the rest of the teardown', () => {
    const env = installWindow();
    const { popup, posted } = fakePopup();
    const sched = fakeRaf();
    const session = startPresent({
      source: () => fakeSourceCanvas(), rect: null,
      openWindow: () => popup as unknown as Window, raf: sched.raf, caf: sched.caf,
    })!;

    env.fireMessage({ source: popup, data: { type: 'present:fs-state', entered: false } });
    expect(env.listenerCount('pointerdown')).toBe(1);
    session.stop();
    expect(env.listenerCount('pointerdown'), 'stop() removes the gesture listener').toBe(0);
    expect(env.listenerCount('keydown')).toBe(0);
    env.fire('pointerdown');
    expect(goFullscreenPosts(posted).length).toBe(0);
  });

  it('a DENIED automatic-fullscreen permission prints the advisory ONCE and still arms', () => {
    const env = installWindow();
    const { popup, posted } = fakePopup();
    const sched = fakeRaf();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      startPresent({
        source: () => fakeSourceCanvas(), rect: null,
        openWindow: () => popup as unknown as Window, raf: sched.raf, caf: sched.caf,
      });

      env.fireMessage({
        source: popup,
        data: { type: 'present:fs-state', entered: false, permission: 'denied' },
      });
      const advisories = warn.mock.calls.filter((c) =>
        String(c[1] ?? c[0]).includes('Automatic fullscreen is blocked'),
      );
      expect(advisories.length, 'the one actionable line').toBe(1);
      // The advisory names both no-setup recovery paths AND the setting/policy.
      expect(automaticFullscreenBlockedAdvisory()).toContain('next click');
      expect(automaticFullscreenBlockedAdvisory()).toContain('Automatic full screen');
      expect(automaticFullscreenBlockedAdvisory()).toContain(
        'AutomaticFullscreenAllowedForUrls',
      );

      // Repeat reports do not spam the console…
      env.fireMessage({
        source: popup,
        data: { type: 'present:fs-state', entered: false, permission: 'denied' },
      });
      expect(
        warn.mock.calls.filter((c) =>
          String(c[1] ?? c[0]).includes('Automatic fullscreen is blocked'),
        ).length,
      ).toBe(1);

      // …and the gesture path is still armed alongside the advisory.
      env.fire('pointerdown');
      expect(goFullscreenPosts(posted).length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores fs-state from a window that is not OUR popup (same-origin guard)', () => {
    const env = installWindow();
    const { popup, posted } = fakePopup();
    const sched = fakeRaf();
    startPresent({
      source: () => fakeSourceCanvas(), rect: null,
      openWindow: () => popup as unknown as Window, raf: sched.raf, caf: sched.caf,
    });

    env.fireMessage({ source: {}, data: { type: 'present:fs-state', entered: false } });
    env.fire('pointerdown');
    expect(goFullscreenPosts(posted).length, 'a foreign report must not arm').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE FRAME TRANSPORT REPORTS BACK
// ---------------------------------------------------------------------------
//
// ⚠ WHAT WAS WRONG WITH THE OLD PROTOCOL. `__presentFrame` returned `void`, so
// the sink learned nothing from pulling it, and the opener's own liveness flags
// (`popupDriving`, `lastPullAt`) are set BEFORE the draw and OUTSIDE its
// try/catch. A projector painting pure black — null source, 1×1 source, a lost
// GL context swallowed by the frame's bare catch — therefore reported perfect
// health forever while showing a frozen last frame on a wall. These tests pin
// the return value that makes the black case visible, in BOTH directions: a
// painting link must keep saying `painted`, or the sink would banner over a
// working show.

/** Drive the sink's pull and hand back what the opener reported. */
function pull(popup: unknown) {
  const fn = (popup as { __presentFrame?: () => unknown }).__presentFrame;
  return fn?.() as
    | { protocol: number; outcome: string; painted: number; errors: number; slot: string }
    | undefined;
}

/** Open a session and drive it to the point where the sink is pulling frames. */
function readySession(args: Partial<StartPresentArgs> = {}) {
  const env = installWindow();
  const { popup, ctx, dst } = fakePopup();
  const sched = fakeRaf();
  const session = startPresent({
    source: () => fakeSourceCanvas(),
    rect: null,
    openWindow: () => popup as unknown as Window,
    raf: sched.raf,
    caf: sched.caf,
    ...args,
  });
  env.fireMessage({ source: popup, data: { type: 'present:ready' } });
  vi.advanceTimersByTime(100);
  return { env, popup, ctx, dst, sched, session };
}

describe('startPresent — the sink is TOLD what each frame did', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a frame that drew source pixels reports PAINTED and advances the count', () => {
    const { popup, ctx } = readySession();
    const first = pull(popup);
    expect(first?.protocol).toBe(1);
    expect(first?.outcome).toBe('painted');
    expect(first?.painted).toBe(1);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(pull(popup)?.painted, 'monotonic, so the sink can measure staleness').toBe(2);
  });

  it('THE BLACK PROJECTOR: a null source reports BLANK and never advances painted', () => {
    // This is the exact state the old signal called healthy: the black-fill
    // runs every frame, nothing throws, the sink pulls on schedule.
    const { popup, ctx } = readySession({ source: () => null });
    const status = pull(popup);
    expect(status?.outcome).toBe('blank');
    expect(status?.painted).toBe(0);
    expect(ctx.fillRect, 'it still black-fills — that is what made it invisible').toHaveBeenCalled();
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(pull(popup)?.painted).toBe(0);
  });

  it('a 1×1 source is BLANK too — real pixels, not merely a non-null object', () => {
    const { popup } = readySession({ source: () => fakeSourceCanvas(1, 1) });
    expect(pull(popup)?.outcome).toBe('blank');
  });

  it('a THROWING draw is counted and warned ONCE, not silently swallowed', () => {
    // node-present-registry.test.ts pins that a lost GL context must not kill
    // the loop, and that absorption is deliberate. What was missing is any
    // trace at all: an absorbed throw looked exactly like a good frame.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { popup } = readySession({
      source: () => {
        throw new Error('GL context lost');
      },
    });
    const a = pull(popup);
    expect(a?.outcome).toBe('error');
    expect(a?.errors).toBe(1);
    expect(a?.painted).toBe(0);
    expect(pull(popup)?.errors, 'still counting').toBe(2);
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('[present]')).length,
      'ONE line per session — enough to diagnose, never enough to bury the console',
    ).toBe(1);
    warn.mockRestore();
  });

  it('carries the SLOT so a four-projector rig knows which link died', () => {
    const { popup } = readySession({ slot: 'bd::DELL' });
    expect(pull(popup)?.slot).toBe('bd::DELL');
  });

  it('the OPENER FALLBACK counts the same frames (a sink that never pulls)', () => {
    // A cached older /present drives nothing, so the opener's own rAF keeps
    // drawing. Those frames must count too, or a sink that arrives late would
    // report a picture that has been running for minutes as never painted.
    const { popup, sched } = readySession();
    sched.tick();
    sched.tick();
    expect(pull(popup)?.painted).toBe(3);
  });
});

describe('startPresent — the sink URL carries an identity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('appends ?slot= so a native window-open handler can route the sink', () => {
    // Without it every projector is `window.open('/present', '_blank',
    // '<geometry>')` — identical URL, window name and feature shape — and a
    // shell cannot tell an output slot's sink from an old patch's projector.
    installWindow();
    const { popup } = fakePopup();
    const opened: string[] = [];
    const openWindow = (u: string) => {
      opened.push(u);
      return popup as unknown as Window;
    };
    startPresent({
      source: () => fakeSourceCanvas(),
      rect: null,
      slot: 'bd::DELL U2720Q|2560x1440|@2|ext',
      openWindow,
      raf: () => 1,
      caf: () => {},
    });
    const url = opened[0]!;
    expect(url.startsWith('/present?slot=')).toBe(true);
    expect(new URL(url, 'http://x').searchParams.get('slot')).toBe(
      'bd::DELL U2720Q|2560x1440|@2|ext',
    );
  });

  it('an EMPTY slot leaves the URL untouched (every existing caller is unchanged)', () => {
    expect(sinkUrl('/present', '')).toBe('/present');
    expect(sinkUrl('/present?x=1', 'a::b')).toBe('/present?x=1&slot=a%3A%3Ab');
  });
});

describe('startPresent — THE SEVERED-BLIT NEGATIVE CONTROL', () => {
  // ⚠ THE POINT OF THIS HOOK IS THAT THE GATE CAN GO RED. A continuity probe
  // nobody has ever seen fail is not an instrument. `present-blit-sever` cuts
  // exactly one link — the source read — leaving `prepare` (the engine render)
  // running, so what a test proves by severing is that its probe follows the
  // BLIT and not something upstream of it. The e2e drives the same seam through
  // `window.__severPresentBlit`.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
    setPresentBlitSevered(false);
  });
  afterEach(() => {
    setPresentBlitSevered(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('severing turns a PAINTED link black, and un-severing brings it back', () => {
    const prepare = vi.fn();
    const { popup, ctx } = readySession({ prepare });
    expect(pull(popup)?.outcome, 'healthy first — the positive half').toBe('painted');

    setPresentBlitSevered(true);
    const cut = pull(popup);
    expect(cut?.outcome).toBe('blank');
    expect(cut?.painted, 'the painted count freezes — this is what a stalled sink sees').toBe(1);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(
      prepare,
      'the ENGINE keeps rendering — only the blit is cut, so a probe that still ' +
        'sees change is reading something other than the projector',
    ).toHaveBeenCalledTimes(2);

    setPresentBlitSevered(false);
    expect(pull(popup)?.outcome).toBe('painted');
    expect(pull(popup)?.painted).toBe(3);
  });

  it('the hook is INERT unless test hooks are on', () => {
    // In a real production build `testHooksEnabled()` is false, the setter is a
    // no-op and the read is a constant-false branch. This asserts the gate
    // exists rather than trying to fake a prod bundle inside vitest.
    expect(testHooksEnabled(), 'vitest runs with DEV hooks on').toBe(true);
    expect(presentBlitSevered()).toBe(false);
  });
});
