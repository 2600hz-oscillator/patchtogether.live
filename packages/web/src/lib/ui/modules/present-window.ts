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

/** The operator-facing advisory for a projector that opened WINDOWED because
 *  the browser denies gesture-less (automatic) fullscreen. One copyable line
 *  in the OPENER's console — the place this failure class is actually debugged
 *  from (the projector's own devtools are impractical on a second display), and
 *  the same shape as the Electra transport gate's browser advisory. It names
 *  every working path: the two that need nothing (next gesture in the patcher —
 *  the armed delegation below — or any click on the projector window) and the
 *  browser setting that makes fullscreen automatic again. */
export function automaticFullscreenBlockedAdvisory(): string {
  return (
    'Automatic fullscreen is blocked by this browser, so the projector opened ' +
    'windowed. Your next click or keypress in the patcher will fullscreen it ' +
    '(any click on the projector window works too). To make it automatic ' +
    'again, allow this site under Edge: Settings → Cookies and site ' +
    'permissions → Automatic full screen (chrome://settings/content/automaticFullScreen ' +
    'on Chrome), or the AutomaticFullscreenAllowedForUrls policy.'
  );
}

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

/** The sink pulls frames through this, installed by the opener. Same-origin, so
 *  the call executes in the OPENER's realm on the SINK's frame clock. */
type PresentPopupWithPull = Window & { __presentFrame?: () => void };

/** Anything the blit loop can read a frame out of: an HTMLCanvasElement, or the
 *  VideoEngine's OffscreenCanvas. Both are CanvasImageSource with real dims. */
export type PresentSource = CanvasImageSource & { readonly width: number; readonly height: number };

export interface StartPresentArgs {
  /**
   * The live surface to mirror onto the second display, as a GETTER resolved
   * every frame.
   *
   * ⚠ IT IS A GETTER, AND NOT A CARD ELEMENT, FOR A REASON. This used to be a
   * captured `canvas: HTMLCanvasElement` — the presenting CARD's own canvas —
   * which made the projector's lifetime the card's lifetime: collapsing the
   * card detached that element and the loop went on drawing its last bitmap
   * forever (owner P0, 2026-08-12; see $lib/ui/modules/node-present-registry).
   * A getter also follows an engine that swaps its canvas on a resolution
   * change, which a captured reference silently would not.
   */
  source: () => PresentSource | null;
  /** Run immediately before each frame's read — the caller's chance to render
   *  the node it wants into a shared drawing buffer. */
  prepare?: () => void;
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
  const { source, prepare, rect } = args;
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
  // ⚠ WHOSE FRAME CLOCK DRIVES THE PROJECTOR (#2235). Set once the SINK starts
  // pulling; the opener's own loop then stops drawing and only supervises.
  let popupDriving = false;
  let lastPullAt = 0;
  let rafId: number | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let findTimer: ReturnType<typeof setInterval> | null = null;

  const handshake = (ev: MessageEvent) => {
    // Same-origin only: ignore anything not from our own popup window.
    if (ev.source !== popup) return;
    const data = ev.data as { type?: string } | null;
    if (data?.type === 'present:fs-report') {
      // The sink cannot practically show its own console on a projector, so it
      // reports fullscreen outcomes here.
      const detail = (ev.data as { detail?: string }).detail ?? '';
      // A recovered retry is information; a give-up is a problem.
      if (detail.startsWith('fullscreen entered')) console.info('[present] sink:', detail);
      else console.warn('[present] sink:', detail);
      return;
    }
    if (data?.type === 'present:fs-state') {
      // Machine-readable fullscreen state from the sink (the fs-report above
      // stays the human console line). Not fullscreen → arm the user's NEXT
      // real gesture in the patcher to delegate activation; fullscreen →
      // stand down.
      const st = ev.data as { entered?: boolean; permission?: string };
      if (st.entered) {
        disarmGestureDelegation();
        return;
      }
      // A DENIED automatic-fullscreen permission is the one deterministic
      // refusal (no policy / content-setting grant) — say the actionable thing
      // exactly once per session instead of letting 40 retries bury it.
      if (st.permission === 'denied' && !advisoryPrinted) {
        advisoryPrinted = true;
        console.warn('[present]', automaticFullscreenBlockedAdvisory());
      }
      armGestureDelegation();
      return;
    }
    if (data?.type === 'present:ready') {
      beginBlit();
      // Try to put the popup into TRUE fullscreen WITHOUT a click by delegating
      // the opener's transient activation (the menu click that opened it) to the
      // popup — the Capability Delegation API. If unsupported / the activation
      // has expired, the popup's own click-anywhere affordance covers it.
      delegateFullscreen();
    }
  };

  /** Best-effort: hand the opener's transient activation to the popup so its
   *  document can call requestFullscreen() with no click (Chromium). `delegate`
   *  is a Capability-Delegation postMessage option not yet in lib.dom typings. */
  function delegateFullscreen() {
    try {
      const post = popup.postMessage as (
        message: unknown,
        options: WindowPostMessageOptions & { delegate?: string },
      ) => void;
      post({ type: 'present:go-fullscreen' }, {
        targetOrigin: window.location.origin,
        delegate: 'fullscreen',
      });
    } catch {
      /* delegation unsupported — the popup's click-to-fullscreen affordance covers it */
    }
  }

  // ── FULLSCREEN VIA THE **NEXT** GESTURE ──────────────────────────────────
  // The on-ready delegation above cannot carry activation: window.open()
  // CONSUMES the click's transient activation (HTML spec), so by the time the
  // sink posts ready there is nothing left to delegate and the token never
  // arms. It looked automatic on the owner's rig anyway because Edge ≤151 ran
  // with an AutomaticFullscreenAllowedForUrls grant that let the sink's
  // gesture-less requestFullscreen through; with that grant gone (the Edge 152
  // update / the hand-planted managed-prefs file wiped) every gesture-less
  // attempt rejects with "TypeError: Permissions check failed" (Blink
  // fullscreen.cc: no transient activation AND the automatic-fullscreen
  // permission check denied).
  //
  // So when the sink reports it is NOT fullscreen, arm a ONE-SHOT capture
  // listener and, SYNCHRONOUSLY inside the user's next pointerdown/keydown in
  // the patcher, post the delegating message — fresh activation at send time
  // is all Capability Delegation needs. The performer's next interaction with
  // the patcher fullscreens the projector; nobody walks to the second display.
  //
  // One gesture arms ONE delegation (the send consumes the activation; a
  // sibling session's delegate in the same event throws and is swallowed), so
  // with N projectors the Nth gesture converges the last one — each
  // still-windowed sink re-reports NOT-fullscreen and re-arms. The pointerdown
  // spend is safe for the patcher's own popups: the pointerup of that same
  // click is itself activation-triggering, so a subsequent click-handler
  // window.open still has activation.
  let gestureArmed = false;
  let advisoryPrinted = false;
  const delegateOnGesture = () => {
    disarmGestureDelegation();
    delegateFullscreen();
  };
  function armGestureDelegation() {
    if (gestureArmed || closed || typeof window === 'undefined') return;
    gestureArmed = true;
    window.addEventListener('pointerdown', delegateOnGesture, true);
    window.addEventListener('keydown', delegateOnGesture, true);
  }
  function disarmGestureDelegation() {
    if (!gestureArmed || typeof window === 'undefined') return;
    gestureArmed = false;
    window.removeEventListener('pointerdown', delegateOnGesture, true);
    window.removeEventListener('keydown', delegateOnGesture, true);
  }

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
   *  (object-fit: contain) the source OUTPUT canvas into it.
   *
   * ⚠ THE SINK OWNS THE CLOCK, AND THAT IS THE WHOLE POINT (#2235). This loop
   * used to run on the OPENER's requestAnimationFrame. Chrome throttles rAF in
   * an unfocused window, so ANY modal that takes focus from the patcher — the
   * recorder's directory picker, a permission prompt, an OS dialog — starved
   * this loop and every projector froze on its last frame. Measured by the
   * owner: picking a record folder froze all outputs instantly, recoverable
   * only by re-selecting the display, and with no way to avoid it because a
   * restored patch (#2230) brings its projectors up before a folder is chosen.
   *
   * So the frame is installed ON THE POPUP and called from the POPUP's rAF.
   * The popup is the window that is actually on the projector and always
   * visible, so its clock keeps running whatever the opener is doing. The
   * engine work still happens here — same-origin, so the sink calling this
   * executes in the opener's realm — only the TIMING moved.
   *
   * The opener's loop stays as a FALLBACK for a sink that never pulls (a
   * cached older /present), and the watchdog reclaims the clock if the sink
   * stops. A projector that goes black because two clocks disagreed would be
   * worse than the bug this fixes. */
  function runLoop(dst: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    const drawFrame = () => {
      if (closed) return;
      try {
        // Let the caller render what it wants into the source first (the
        // registry blits ITS node's output into the shared engine buffer here),
        // then read it in the SAME synchronous block — a WebGL drawing buffer is
        // only guaranteed to hold that content until the frame ends.
        prepare?.();
        const src = source();
        const dw = dst.width;
        const dh = dst.height;
        const sw = src ? src.width || 1 : 1;
        const sh = src ? src.height || 1 : 1;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, dw, dh);
        const fit = letterbox(sw, sh, dw, dh);
        // Only draw once the source has real pixels (avoids a 1×1 stretch on
        // the very first frames before the engine has rendered).
        if (src && sw > 1 && sh > 1 && fit.w > 0 && fit.h > 0) {
          ctx.drawImage(src, fit.x, fit.y, fit.w, fit.h);
        }
      } catch {
        // A transient draw error (e.g. popup mid-teardown) must not kill the
        // loop's ability to be cancelled — just skip this frame.
      }
    };

    try {
      (popup as PresentPopupWithPull).__presentFrame = () => {
        popupDriving = true;
        lastPullAt = Date.now();
        drawFrame();
      };
    } catch {
      /* popup navigated away mid-install — the opener fallback below covers it */
    }

    const frame = () => {
      if (closed) return;
      if (!popupDriving) drawFrame();
      rafId = raf(frame);
    };
    rafId = raf(frame);
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    disarmGestureDelegation();
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', handshake);
    }
    if (rafId != null) {
      caf(rafId);
      rafId = null;
    }
    try {
      delete (popup as PresentPopupWithPull).__presentFrame;
    } catch {
      /* popup already gone */
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
    if (isClosed) {
      cleanup();
      return;
    }
    // RECLAIM THE CLOCK if the sink stopped pulling — a reload of the popup, or
    // a build whose loop died. The opener's rAF is still scheduled, so handing
    // it back is enough to keep the picture alive.
    if (popupDriving && Date.now() - lastPullAt > 1000) popupDriving = false;
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
