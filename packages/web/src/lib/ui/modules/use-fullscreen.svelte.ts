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
//
// Multi-monitor: on Chromium with the Window Management API
// (window.getScreenDetails) we can target a SPECIFIC display, so a video
// display can go fullscreen on a secondary monitor while the app keeps
// running in the browser window on the primary. We expose the available
// screens reactively (lazily, since the first getScreenDetails() call
// prompts for the `window-management` permission and must run on a user
// gesture) and accept an optional screenId in enter(). On Firefox/Safari or
// single-monitor setups the API is absent / yields one screen and we behave
// exactly as before: plain element.requestFullscreen() on the current
// display, byte-identical to the prior implementation.

/** Vendored shape of the prefixed fullscreen API (older WebKit). The
 *  standard API covers modern browsers; these are defensive fallbacks. */
interface FullscreenElementExt extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
  /** Standard Fullscreen API accepts FullscreenOptions, which (per the
   *  Window Management spec) may carry a `screen: ScreenDetailed`. TS's lib
   *  doesn't model the `screen` field yet, so we widen it locally. */
  requestFullscreen(options?: FullscreenOptions & { screen?: ScreenDetailedLike }): Promise<void>;
}

// ---- Window Management API (Chromium) — minimal structural typings. ----
// We avoid depending on @types lib coverage (varies by version) and model
// only the fields we touch. A `ScreenDetailed` is one entry in
// ScreenDetails.screens; `getScreenDetails()` returns the live container.
interface ScreenDetailedLike {
  readonly label?: string;
  readonly isPrimary?: boolean;
}
interface ScreenDetailsLike extends EventTarget {
  readonly screens: ScreenDetailedLike[];
  readonly currentScreen?: ScreenDetailedLike;
}
interface WindowWithScreenDetails extends Window {
  getScreenDetails?: () => Promise<ScreenDetailsLike>;
}

/** A display offered in the menu. `id` is an opaque, stable-within-session
 *  handle the card passes back to enter(); we map it to the live
 *  ScreenDetailed internally so callers never hold the platform object. */
export interface AvailableScreen {
  readonly id: string;
  readonly label: string;
  readonly isPrimary: boolean;
}
interface FullscreenDocumentExt extends Document {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
}

function currentFullscreenElement(): Element | null {
  const d = document as FullscreenDocumentExt;
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

function requestFs(el: HTMLElement, screen?: ScreenDetailedLike): Promise<void> {
  const e = el as FullscreenElementExt;
  if (typeof el.requestFullscreen === 'function') {
    // When a target display is given, pass the Window-Management `{ screen }`
    // option. Older Chromium without that option simply ignores the extra
    // field (harmless). If anything throws (or the screen handle is stale),
    // fall back to plain fullscreen on the current display so we never break.
    if (screen) {
      try {
        const p = e.requestFullscreen({ screen });
        return Promise.resolve(p).catch(() =>
          // Targeted request rejected (e.g. permission revoked) — retry plain.
          Promise.resolve(el.requestFullscreen()).catch(() => {}),
        );
      } catch {
        return Promise.resolve(el.requestFullscreen()).catch(() => {});
      }
    }
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
  /** Reactive list of displays available for targeted fullscreen. Empty
   *  until `loadScreens()` has run (or when the Window Management API is
   *  unsupported / permission denied / only one display exists, in which
   *  case it stays empty and the UI shows a single "Fullscreen" item). */
  readonly availableScreens: AvailableScreen[];
  /** Lazily query the Window Management API (Chromium). MUST be called from
   *  a user gesture — the FIRST call may prompt for the `window-management`
   *  permission. Safe + a no-op on unsupported browsers. Idempotent: caches
   *  the ScreenDetails and subscribes to `screenschange` for live updates. */
  loadScreens(): Promise<void>;
  /** Enter true fullscreen. MUST be called from a user-gesture handler
   *  (e.g. a click) per the Fullscreen API spec. When `screenId` matches a
   *  known display, fullscreen targets THAT monitor (Window Management API);
   *  otherwise it uses the current display. Returns a promise. */
  enter(screenId?: string): Promise<void>;
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

  // ---- Window Management (multi-monitor) state ----
  let availableScreens = $state<AvailableScreen[]>([]);
  // The live ScreenDetails container (cached after first load) + the mapping
  // from the opaque ids we hand the UI back to the real ScreenDetailed.
  let screenDetails: ScreenDetailsLike | null = null;
  let idToScreen = new Map<string, ScreenDetailedLike>();
  let screensLoaded = false;

  /** Build a stable-ish id + human label for one display. The platform gives
   *  no stable id, so we derive one from index + label; primary is always
   *  "primary" so THIS-display selection survives a screenschange. */
  function refreshScreenList(): void {
    const list = screenDetails?.screens ?? [];
    idToScreen = new Map();
    const next: AvailableScreen[] = [];
    list.forEach((s, i) => {
      const isPrimary = s.isPrimary === true;
      const id = isPrimary ? 'primary' : `display-${i}`;
      const label = s.label && s.label.length > 0 ? s.label : `Display ${i + 1}`;
      idToScreen.set(id, s);
      next.push({ id, label, isPrimary });
    });
    // Only surface a multi-display choice when there's genuinely more than
    // one screen; a lone screen keeps the single-item menu (byte-identical
    // to the no-API path).
    availableScreens = next.length > 1 ? next : [];
  }

  async function loadScreens(): Promise<void> {
    if (screensLoaded) return; // idempotent; live updates come via the event.
    const w = window as WindowWithScreenDetails;
    if (typeof w.getScreenDetails !== 'function') return; // Firefox/Safari.
    try {
      const details = await w.getScreenDetails(); // may prompt (user gesture).
      screenDetails = details;
      screensLoaded = true;
      refreshScreenList();
      // Live updates: monitors plugged/unplugged, labels change, etc.
      details.addEventListener('screenschange', () => refreshScreenList());
    } catch {
      // Permission denied or API failed -> single-display fallback.
      screenDetails = null;
      availableScreens = [];
    }
  }

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
    get availableScreens() {
      return availableScreens;
    },
    loadScreens,
    async enter(screenId?: string) {
      if (!target) return;
      enterCount++;
      // Resolve the chosen display (if any). "primary"/current and unknown
      // ids both fall through to plain fullscreen on the current display.
      const screen =
        screenId && screenId !== 'primary' ? idToScreen.get(screenId) : undefined;
      await requestFs(target, screen);
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
