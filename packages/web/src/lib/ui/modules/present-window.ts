// present-window.ts
//
// "Present an OUTPUT on a second display" — the lightweight popup+captureStream
// route. Unlike the Fullscreen API (per-document + exclusive, which relocates
// the WHOLE tab to display 2 and makes the patcher unusable), this opens a
// SEPARATE chrome-less popup window, places + fullscreens it on the chosen
// display, and feeds it the OUTPUT card's live canvas via a MediaStream. The
// main browser window stays interactive on the primary display.
//
// How it works:
//   1. `canvas.captureStream(fps)` taps the OUTPUT card's <canvas> as a live
//      MediaStream (the rAF blit keeps drawing, so the popup stays live).
//   2. `window.open('/present', …, popup features sized/placed for the target
//      screen)` opens the pure sink route (routes/present/+page.svelte).
//   3. Once the popup signals `ready` (same-origin postMessage from the sink),
//      we hand it the stream by assigning `popup.__presentStream` and posting
//      `present` so the sink attaches it to its <video> and best-effort
//      fullscreens itself.
//   4. The handle is tracked so the card can `stop()` — closing the popup AND
//      stopping every track so the capture tap is released.
//
// Everything is capability-gated by the CALLER (the card only shows a "Present
// on …" item when window.getScreenDetails exists + there's >1 screen), but the
// controller is also defensive: if window.open is blocked (returns null) it
// no-ops cleanly, and all popup messaging is same-origin so no secrets leak.
//
// Chromium-only in practice (the placement relies on the Window Management API
// the caller already gates on), but the captureStream + window.open core is
// portable; on a single screen the caller simply never offers the item.

import type { ScreenRect } from './use-fullscreen.svelte';

/** Default popup size when no target-screen rect is known (we still open a
 *  reasonably-large window; the user can move/fullscreen it manually). */
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
  // target display; width/height fill its working area so the subsequent
  // requestFullscreen() in the sink has the whole monitor to expand into.
  return `popup,left=${left},top=${top},width=${width},height=${height}`;
}

/** A live present session: the popup handle + the captured stream, so we can
 *  tear both down. `closed` reflects whether the popup is gone. */
export interface PresentSession {
  /** Close the popup AND stop every captured track (releases the canvas tap). */
  stop(): void;
  /** True once the popup has been closed (by stop() or the user). */
  readonly closed: boolean;
}

/** Minimal structural typing of the bits of Window we touch on the popup, so
 *  we can assign the same-origin stream handle + post messages without `any`. */
interface PresentPopup extends Window {
  __presentStream?: MediaStream;
}

export interface StartPresentArgs {
  /** The OUTPUT card's live <canvas> to mirror onto the second display. */
  canvas: HTMLCanvasElement;
  /** Working-area rect of the target display (from the fullscreen controller's
   *  getScreenRect); null falls back to a default-sized popup. */
  rect: ScreenRect | null;
  /** Capture frame-rate. 30 fps matches the engine cadence + keeps the encode
   *  cheap; the canvas rAF keeps drawing regardless. */
  fps?: number;
  // ---- Injection seams (tests stub these; prod uses the real DOM) ----
  /** Defaults to window.open. */
  openWindow?: (url: string, target: string, features: string) => Window | null;
  /** The route the popup loads. Defaults to '/present'. */
  url?: string;
}

/** Open a present popup on the target display and feed it the canvas stream.
 *  Returns a PresentSession (track it on the card so delete / "stop presenting"
 *  can tear it down), or null if the popup couldn't open (blocked / no
 *  captureStream support) — in which case nothing was started and there's
 *  nothing to clean up. Never throws. */
export function startPresent(args: StartPresentArgs): PresentSession | null {
  const { canvas, rect, fps = 30 } = args;
  const openWindow = args.openWindow ?? ((u, t, f) => window.open(u, t, f));
  const url = args.url ?? '/present';

  // captureStream may be absent on very old browsers — bail cleanly.
  if (typeof canvas.captureStream !== 'function') return null;

  let stream: MediaStream;
  try {
    stream = canvas.captureStream(fps);
  } catch {
    return null;
  }

  const features = computePopupFeatures(rect);
  const popup = openWindow(url, '_blank', features) as PresentPopup | null;
  if (!popup) {
    // Popup blocked — release the tap we just opened and report failure.
    stopTracks(stream);
    return null;
  }

  let closed = false;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const handshake = (ev: MessageEvent) => {
    // Same-origin only: ignore anything not from our own popup window.
    if (ev.source !== popup) return;
    const data = ev.data as { type?: string } | null;
    if (data?.type === 'present:ready') {
      // Hand the stream over same-origin (structured clone can't carry a
      // MediaStream, so we assign it directly on the popup window object) and
      // tell the sink to attach + fullscreen.
      try {
        popup.__presentStream = stream;
        popup.postMessage({ type: 'present:stream-ready' }, window.location.origin);
      } catch {
        // If the popup vanished between ready + assign, treat as closed.
        cleanup();
      }
    }
  };

  function cleanup() {
    if (closed) return;
    closed = true;
    window.removeEventListener('message', handshake);
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    stopTracks(stream);
  }

  window.addEventListener('message', handshake);

  // Poll for the user closing the popup so we release the capture tap even
  // when the sink never posts a teardown (e.g. the user just hits the OS
  // window close button). Guarded so a cross-origin `.closed` read (shouldn't
  // happen — same origin) can't throw the watchdog dead.
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

/** Stop + release every track on a captured stream. */
function stopTracks(stream: MediaStream): void {
  try {
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    /* no tracks / not a real stream */
  }
}
