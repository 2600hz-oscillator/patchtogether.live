// use-fullscreen.svelte.ts
//
// Small Svelte-5-runes helper for putting a single element into TRUE
// browser fullscreen (the same Fullscreen API a web video player uses —
// element.requestFullscreen() / document.exitFullscreen()), and tracking
// that state reactively.
//
// Shared by VideoOutCard + BentboxCard so the "right-click -> Fullscreen,
// double-click / Esc to exit" behavior is authored once. Each card creates
// its own instance, binds `target` to the wrapper element that should fill
// the screen (which contains the live <canvas>), and reads `isFullscreen`
// for styling.
//
// While fullscreen we attach a `dblclick` listener on the target so a
// double-click anywhere exits. Esc is handled by the browser default; we
// don't fight it — we just listen for `fullscreenchange` to sync our flag
// and tear down the dblclick listener when fullscreen ends by any path
// (Esc, exitFullscreen(), or the user navigating away).
//
// The card's rAF blit keeps running independent of this helper, so the
// fullscreen view stays live — we only change CSS + which element owns
// the screen, never the render loop.

/** Vendored shape of the prefixed fullscreen API (older WebKit). The
 *  standard API covers modern browsers; these are defensive fallbacks. */
interface FullscreenElementExt extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}
interface FullscreenDocumentExt extends Document {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
}

function currentFullscreenElement(): Element | null {
  const d = document as FullscreenDocumentExt;
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

function requestFs(el: HTMLElement): Promise<void> {
  const e = el as FullscreenElementExt;
  if (typeof el.requestFullscreen === 'function') {
    return Promise.resolve(el.requestFullscreen()).catch(() => {});
  }
  if (typeof e.webkitRequestFullscreen === 'function') {
    return Promise.resolve(e.webkitRequestFullscreen()).catch(() => {});
  }
  return Promise.resolve();
}

function exitFs(): Promise<void> {
  const d = document as FullscreenDocumentExt;
  if (typeof document.exitFullscreen === 'function') {
    return Promise.resolve(document.exitFullscreen()).catch(() => {});
  }
  if (typeof d.webkitExitFullscreen === 'function') {
    return Promise.resolve(d.webkitExitFullscreen()).catch(() => {});
  }
  return Promise.resolve();
}

export interface FullscreenController {
  /** Reactive: is OUR target element currently the fullscreen element? */
  readonly isFullscreen: boolean;
  /** Set the element to fullscreen (the wrapper that contains the canvas). */
  setTarget(el: HTMLElement | null): void;
  /** Enter true fullscreen. MUST be called from a user-gesture handler
   *  (e.g. a click) per the Fullscreen API spec. Returns a promise. */
  enter(): Promise<void>;
  /** Exit fullscreen (also bound to dblclick on the target while active). */
  exit(): Promise<void>;
  /** Wire up the fullscreenchange listener + dblclick lifecycle. Call from
   *  an $effect so it tears down on unmount. Returns a cleanup fn. */
  attach(): () => void;
  /** For tests: how many times enter() has been invoked. Lets the e2e
   *  assert the state machine even if headless OS-fullscreen is unavailable. */
  readonly enterCount: number;
}

export function createFullscreen(): FullscreenController {
  let target: HTMLElement | null = null;
  let isFullscreen = $state(false);
  let enterCount = $state(0);

  function onDblClick(): void {
    // Double-click anywhere in the fullscreen view exits, like a video player.
    if (currentFullscreenElement() === target) void exitFs();
  }

  function syncFromDocument(): void {
    const active = currentFullscreenElement() === target && target !== null;
    isFullscreen = active;
    // Manage the dblclick listener in lockstep with fullscreen state so we
    // never leave a stray listener on the wrapper when not fullscreen.
    if (target) {
      target.removeEventListener('dblclick', onDblClick);
      if (active) target.addEventListener('dblclick', onDblClick);
    }
  }

  return {
    get isFullscreen() {
      return isFullscreen;
    },
    get enterCount() {
      return enterCount;
    },
    setTarget(el: HTMLElement | null) {
      target = el;
    },
    async enter() {
      if (!target) return;
      enterCount++;
      await requestFs(target);
      // fullscreenchange will flip the flag; sync defensively too in case
      // the event is delayed (and so the state machine is observable even
      // where the OS denies real fullscreen, e.g. some headless contexts).
      syncFromDocument();
    },
    async exit() {
      await exitFs();
      syncFromDocument();
    },
    attach() {
      const onChange = () => syncFromDocument();
      document.addEventListener('fullscreenchange', onChange);
      // WebKit fallback event name.
      document.addEventListener('webkitfullscreenchange', onChange);
      syncFromDocument();
      return () => {
        document.removeEventListener('fullscreenchange', onChange);
        document.removeEventListener('webkitfullscreenchange', onChange);
        if (target) target.removeEventListener('dblclick', onDblClick);
      };
    },
  };
}
