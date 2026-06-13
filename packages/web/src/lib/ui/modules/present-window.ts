// present-window.ts
//
// "Present an OUTPUT on a second display" — the lightweight popup + direct
// canvas-blit route. Unlike the Fullscreen API (per-document + exclusive, which
// relocates the WHOLE tab to display 2 and makes the patcher unusable), this
// opens a SEPARATE chrome-less popup window, places it on the chosen display at
// its full working-area rect, and DRAWS the OUTPUT card's live canvas into the
// popup's own <canvas> every frame from the opener. The main browser window
// stays interactive on the primary display.
//
// How it works:
//   1. `window.open('/present', …, popup features sized/placed for the target
//      screen)` opens the pure sink route (routes/present/+page.svelte), which
//      is just a black page with a full-viewport <canvas>. The popup already
//      covers the whole target display, so NO fullscreen is needed.
//   2. Once the popup signals `present:ready` (same-origin postMessage from the
//      sink), the opener locates the popup's <canvas> + 2D context (same-origin,
//      so it can reach popup.document directly) and starts a requestAnimationFrame
//      loop that black-fills + letterbox-`drawImage`s the source OUTPUT canvas
//      into the popup canvas — exactly the fit the in-rack/fullscreen path uses.
//   3. The handle is tracked so the card can `stop()` — cancelling the rAF loop
//      AND closing the popup.
//
// Why a direct blit instead of captureStream → a popup <video>.srcObject? On
// real dual-monitor hardware that pipeline rendered a BLACK popup: a cross-realm
// MediaStream set as srcObject in the popup often won't render, and the popup's
// autoplay()/requestFullscreen() are user-gesture-gated so they reject without a
// click. The direct same-origin blit has none of those failure modes — no
// MediaStream, no <video>, no autoplay, no fullscreen gesture.
//
// Everything is capability-gated by the CALLER (the card only shows a "Present
// on …" item when window.getScreenDetails exists + there's >1 screen), but the
// controller is also defensive: if window.open is blocked (returns null) it
// no-ops cleanly, and all popup messaging/DOM access is same-origin so no
// secrets leak.
//
// Chromium-only in practice (the placement relies on the Window Management API
// the caller already gates on), but the window.open + blit core is portable; on
// a single screen the caller simply never offers the item.

import type { ScreenRect } from './use-fullscreen.svelte';

/** Default popup size when no target-screen rect is known (we still open a
 *  reasonably-large window; the user can move it manually). */
const DEFAULT_POPUP = { left: 100, top: 100, width: 1280, height: 720 } as const;

/** Build the `features` string for window.open from a target screen's
 *  working-area rect. Pure + exported so it's unit-testable without a DOM.
 *  Rounds to integers (window.open ignores fractions) and always requests a
 *  chrome-less `popup`. A null/empty rect falls back to a sane default. */
export function computePopupFeatures(rect: ScreenRect | null): string {
  const r = rect ?? DEFAULT_POPUP;
  const left = Math.round(r.left);
  const top = Math.round(r.top);
  // Guard against a degenerate (0×0) rect from a partial stub — fall back to
  // the default size so we never open an invisible window.
  const width = r.width > 0 ? Math.round(r.width) : DEFAULT_POPUP.width;
  const height = r.height > 0 ? Math.round(r.height) : DEFAULT_POPUP.height;
  // `popup` asks for a minimal, chrome-less window. left/top place it on the
  // target display; width/height fill its working area so the popup covers the
  // whole monitor without needing requestFullscreen().
  return `popup,left=${left},top=${top},width=${width},height=${height}`;
}

/** A live present session: the popup handle + the running blit loop, so we can
 *  tear both down. `closed` reflects whether the popup is gone. */
export interface PresentSession {
  /** Stop the blit loop AND close the popup. */
  stop(): void;
  /** True once the popup has been closed (by stop() or the user). */
  readonly closed: boolean;
}

/** Minimal structural typing of a same-origin popup Window we touch. */
type PresentPopup = Window;

export interface StartPresentArgs {
  /** The OUTPUT card's live <canvas> to mirror onto the second display. */
  canvas: HTMLCanvasElement;
  /** Working-area rect of the target display (from the fullscreen controller's
   *  getScreenRect); null falls back to a default-sized popup. */
  rect: ScreenRect | null;
  // ---- Injection seams (tests stub these; prod uses the real DOM) ----
  /** Defaults to window.open. */
  openWindow?: (url: string, target: string, features: string) => Window | null;
  /** The route the popup loads. Defaults to '/present'. */
  url?: string;
  /** rAF scheduler — defaults to requestAnimationFrame (test seam). */
  raf?: (cb: FrameRequestCallback) => number;
  /** rAF canceller — defaults to cancelAnimationFrame (test seam). */
  caf?: (handle: number) => void;
}

/** Open a present popup on the target display and start blitting the canvas
 *  into it. Returns a PresentSession (track it on the card so delete / "stop
 *  presenting" can tear it down), or null if the popup couldn't open (blocked)
 *  — in which case nothing was started and there's nothing to clean up. Never
 *  throws. */
export function startPresent(args: StartPresentArgs): PresentSession | null {
  const { canvas, rect } = args;
  const openWindow = args.openWindow ?? ((u, t, f) => window.open(u, t, f));
  const url = args.url ?? '/present';
  const raf = args.raf ?? ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  const caf = args.caf ?? ((h: number) => cancelAnimationFrame(h));

  const features = computePopupFeatures(rect);
  const opened = openWindow(url, '_blank', features) as PresentPopup | null;
  if (!opened) return null; // popup blocked — nothing started.
  // Non-null binding so the nested closures (handshake/beginBlit/watchdog) see
  // a non-nullable popup without re-narrowing.
  const popup: PresentPopup = opened;

  let closed = false;
  let started = false;
  let rafId: number | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let findTimer: ReturnType<typeof setInterval> | null = null;

  const handshake = (ev: MessageEvent) => {
    // Same-origin only: ignore anything not from our own popup window.
    if (ev.source !== popup) return;
    const data = ev.data as { type?: string } | null;
    if (data?.type === 'present:ready') beginBlit();
  };

  /** Locate the popup's sink canvas + 2D ctx, then start the blit loop. The
   *  /present route loads async, so the canvas may not exist the instant the
   *  popup posts ready — poll briefly until it appears. */
  function beginBlit() {
    if (started || closed) return;
    started = true;
    let attempts = 0;
    findTimer = setInterval(() => {
      if (closed) return;
      attempts++;
      let ctx: CanvasRenderingContext2D | null = null;
      let dst: HTMLCanvasElement | null = null;
      try {
        dst = popup.document?.querySelector<HTMLCanvasElement>(
          '[data-testid="present-canvas"]',
        ) ?? null;
        if (dst) ctx = dst.getContext('2d', { alpha: false });
      } catch {
        // Popup navigated away / closed mid-lookup — let the watchdog finish.
        dst = null;
        ctx = null;
      }
      if (dst && ctx) {
        if (findTimer) {
          clearInterval(findTimer);
          findTimer = null;
        }
        runLoop(dst, ctx);
      } else if (attempts > 100) {
        // ~10s with no canvas — give up looking (watchdog still guards close).
        if (findTimer) {
          clearInterval(findTimer);
          findTimer = null;
        }
      }
    }, 100);
  }

  /** The per-frame blit: black-fill the popup canvas, then letterbox-fit
   *  (object-fit: contain) the source OUTPUT canvas into it. */
  function runLoop(dst: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    const frame = () => {
      if (closed) return;
      try {
        const dw = dst.width;
        const dh = dst.height;
        const sw = canvas.width || 1;
        const sh = canvas.height || 1;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, dw, dh);
        const fit = letterbox(sw, sh, dw, dh);
        // Only draw once the source has real pixels (avoids a 1×1 stretch on
        // the very first frames before the OUTPUT card's rAF has run).
        if (sw > 1 && sh > 1 && fit.w > 0 && fit.h > 0) {
          ctx.drawImage(canvas, fit.x, fit.y, fit.w, fit.h);
        }
      } catch {
        // A transient draw error (e.g. popup mid-teardown) must not kill the
        // loop's ability to be cancelled — just skip this frame.
      }
      rafId = raf(frame);
    };
    rafId = raf(frame);
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', handshake);
    }
    if (rafId != null) {
      caf(rafId);
      rafId = null;
    }
    if (findTimer) {
      clearInterval(findTimer);
      findTimer = null;
    }
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }

  window.addEventListener('message', handshake);

  // Poll for the user closing the popup so we stop the blit loop even when the
  // sink never posts a teardown (e.g. the user hits the OS window close
  // button). Guarded so a cross-origin `.closed` read (shouldn't happen — same
  // origin) can't throw the watchdog dead.
  watchdog = setInterval(() => {
    let isClosed = false;
    try {
      isClosed = popup.closed;
    } catch {
      isClosed = true;
    }
    if (isClosed) cleanup();
  }, 500);

  return {
    stop() {
      try {
        if (!popup.closed) popup.close();
      } catch {
        /* already gone */
      }
      cleanup();
    },
    get closed() {
      return closed;
    },
  };
}

/** Letterbox (object-fit: contain) a (sw×sh) source into a (dw×dh) destination:
 *  the largest centered rect with the source aspect that fits inside dst. */
function letterbox(
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): { x: number; y: number; w: number; h: number } {
  const srcAspect = sw / sh;
  const dstAspect = dw / dh;
  if (dstAspect > srcAspect) {
    // Destination is wider than source: pillarbox left/right.
    const h = dh;
    const w = Math.round(h * srcAspect);
    return { x: Math.round((dw - w) / 2), y: 0, w, h };
  }
  // Destination is taller than (or equal to) source: letterbox top/bottom.
  const w = dw;
  const h = Math.round(w / srcAspect);
  return { x: 0, y: Math.round((dh - h) / 2), w, h };
}
