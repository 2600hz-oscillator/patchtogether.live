// Skin store — Svelte 5 runes. Singleton per page.
//
// On boot: read localStorage["pt.skin"] and apply. On setSkin(): write
// every variable in the skin's `vars` map to document.documentElement
// inline (so it overrides anything declared in :root) and persist the
// new id to localStorage.
//
// Persistence model: localStorage only. Per-rack via Y.Doc and per-user
// via Clerk are documented as follow-up PRs in
// .myrobots/plans/ui-skins-v2.md §8.
//
// SSR safety: the store uses `document` and `localStorage`. Construction
// is gated on `typeof document !== 'undefined'`; under SSR the store
// holds the default skin in memory but skips DOM writes.
// Components import the store at module-eval time, but the .svelte.ts
// file only constructs on the client (SvelteKit imports it once during
// hydration).

import { SKINS, getSkin, isSkinId, DEFAULT_SKIN_ID, type SkinId, type Skin } from './index';

const STORAGE_KEY = 'pt.skin';

class SkinStore {
  /** The currently-active skin id. Reactive — components reading this
   *  re-render when setSkin is called. */
  current = $state<SkinId>(DEFAULT_SKIN_ID);

  constructor() {
    // Boot: read persisted preference (if any) and apply.
    if (typeof document !== 'undefined') {
      try {
        const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
        if (stored && isSkinId(stored)) {
          this.setSkin(stored, /*persist*/ false);
          return;
        }
      } catch {
        // localStorage can throw in restricted contexts (Safari private,
        // sandboxed iframes). Fall through to default.
      }
      // Default skin — apply inline so the var values are deterministic
      // even without :root (e.g. when something else has set vars before
      // us). Cheap, idempotent.
      this.setSkin(DEFAULT_SKIN_ID, /*persist*/ false);
    }
  }

  /**
   * Activate a skin by id.
   *
   * @param id   The skin id to activate. Unknown ids fall back to default.
   * @param persist  When true (default), write to localStorage. The boot
   *                 path passes false so reading from storage doesn't
   *                 immediately re-write the same value.
   */
  setSkin(id: SkinId, persist = true): void {
    const safeId: SkinId = isSkinId(id) ? id : DEFAULT_SKIN_ID;
    const skin = getSkin(safeId);
    this.current = safeId;
    if (typeof document !== 'undefined') {
      applySkinToRoot(skin);
    }
    if (persist && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, safeId);
      } catch {
        // Quota / disabled storage — non-fatal.
      }
    }
  }

  /** Convenience accessor for the active Skin object (vars, label, etc.). */
  get currentSkin(): Skin {
    return getSkin(this.current);
  }

  /** Read-only list of all in-tree skins. */
  list(): readonly Skin[] {
    return SKINS;
  }
}

/** Write every var in `skin.vars` to documentElement.style. Public so
 *  tests can drive the applier without going through the store.
 *
 *  Also writes the sprite-extension CSS vars (--panel-bg, --fader-track-bg,
 *  --font-silkscreen, --control-style) so components can consume them
 *  via plain CSS without importing the skin object. Each var is REMOVED
 *  rather than left stale when the new skin doesn't define it — that
 *  way switching from Vintage back to Default fully unsets the panel bg
 *  instead of leaving a vestigial overlay. */
export function applySkinToRoot(skin: Skin): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(skin.vars)) {
    root.style.setProperty(k, v);
  }
  // Sprite-extension CSS vars — write or clear.
  const ext: Array<[string, string | undefined]> = [
    ['--control-style', skin.controlStyle],
    ['--panel-bg', skin.panelBg],
    ['--fader-track-bg', skin.faderTrackBg],
    ['--font-silkscreen', skin.silkscreenFontFamily],
  ];
  for (const [k, v] of ext) {
    if (v) root.style.setProperty(k, v);
    else root.style.removeProperty(k);
  }
  // Optional font stylesheet — inject as a <link rel=stylesheet> tagged
  // with data-skin-font so we can swap/remove on subsequent skin changes.
  if (typeof document !== 'undefined' && document.head) {
    const FONT_TAG = 'data-skin-font';
    const existing = document.head.querySelector(`link[${FONT_TAG}]`);
    if (skin.silkscreenFontStylesheet) {
      if (existing instanceof HTMLLinkElement) {
        if (existing.href !== skin.silkscreenFontStylesheet) {
          existing.href = skin.silkscreenFontStylesheet;
        }
      } else {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = skin.silkscreenFontStylesheet;
        link.setAttribute(FONT_TAG, '');
        document.head.appendChild(link);
      }
    } else if (existing) {
      existing.remove();
    }
  }
}

/** Singleton — exported so any component can import + call `setSkin()`. */
export const skinStore = new SkinStore();

// Dev-only: expose on window so e2e tests can drive the store without
// rendering the SkinSwitcher UI. Stripped in prod builds.
//
// `import.meta.env?.DEV` rather than the bare access — vitest in node env
// without Vite's import-meta replacement leaves env undefined; the
// optional chain keeps unit tests from crashing during module eval.
if (
  typeof import.meta !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).env?.DEV &&
  typeof window !== 'undefined'
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__skinStore = skinStore;
}
