// Palette store — Svelte 5 runes. Singleton per page.
//
// P0.1 re-tier: a palette is now COLOR-ONLY (see ./types.ts). The store
// applies a palette's colour vars inline on document.documentElement and
// CLEARS the legacy structural/sprite theme tokens that were moved out of the
// theme surface into the ONE fixed dark structure — so a stale inline value
// (an old persisted skin, a pre-boot :root) can never leave rounded corners /
// neon glow / a sprite panel bleeding onto the fixed structure.
//
// On boot: read localStorage["pt.skin"] and apply. On setSkin(): write every
// var in the palette's `vars` map to document.documentElement inline (so it
// overrides anything declared in :root / tokens.css) and persist the id.
//
// SSR safety: the store uses `document` and `localStorage`. Construction is
// gated on `typeof document !== 'undefined'`; under SSR it holds the default
// palette in memory but skips DOM writes.
//
// The public API keeps its historical names (`skinStore`, `setSkin`,
// `currentSkin`, `current`) so existing importers (SkinSwitcher, +layout,
// window.__skinStore e2e hook) are untouched by the re-tier.

import {
  PALETTES,
  getPalette,
  isPaletteId,
  DEFAULT_PALETTE_ID,
  type PaletteId,
  type Palette,
} from './index';

const STORAGE_KEY = 'pt.skin';

/** Legacy structural / sprite theme tokens that a COLOR-ONLY palette no longer
 *  sets. They were moved OUT of the theme surface into the fixed structure
 *  (the CSS fallbacks in _module-card.css / Fader). We REMOVE them on every
 *  apply so a previous skin's rounded/glow/sprite values don't survive a swap
 *  or a stale :root. Listed explicitly so the clear step is auditable. */
const LEGACY_STRUCTURAL_TOKENS = [
  '--module-radius',
  '--module-stripe-radius',
  '--module-glow',
  '--module-border-color',
  '--control-style',
  '--panel-bg',
  '--fader-track-bg',
  '--font-silkscreen',
] as const;

class SkinStore {
  /** The currently-active palette id. Reactive — components reading this
   *  re-render when setSkin is called. */
  current = $state<PaletteId>(DEFAULT_PALETTE_ID);

  constructor() {
    if (typeof document !== 'undefined') {
      try {
        const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
        if (stored && isPaletteId(stored)) {
          this.setSkin(stored, /*persist*/ false);
          return;
        }
      } catch {
        // localStorage can throw in restricted contexts (Safari private,
        // sandboxed iframes). Fall through to default.
      }
      this.setSkin(DEFAULT_PALETTE_ID, /*persist*/ false);
    }
  }

  /**
   * Activate a palette by id.
   *
   * @param id   The palette id to activate. Unknown ids fall back to default.
   * @param persist  When true (default), write to localStorage. The boot path
   *                 passes false so reading from storage doesn't immediately
   *                 re-write the same value.
   */
  setSkin(id: PaletteId, persist = true): void {
    const safeId: PaletteId = isPaletteId(id) ? id : DEFAULT_PALETTE_ID;
    const palette = getPalette(safeId);
    this.current = safeId;
    if (typeof document !== 'undefined') {
      applyPaletteToRoot(palette);
    }
    if (persist && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, safeId);
      } catch {
        // Quota / disabled storage — non-fatal.
      }
    }
  }

  /** Convenience accessor for the active Palette object (vars, label, etc.). */
  get currentSkin(): Palette {
    return getPalette(this.current);
  }

  /** Read-only list of all in-tree palettes. */
  list(): readonly Palette[] {
    return PALETTES;
  }
}

/** Write every colour var in `palette.vars` to documentElement.style, and
 *  CLEAR the legacy structural/sprite tokens (see LEGACY_STRUCTURAL_TOKENS).
 *  Public so tests can drive the applier without going through the store. */
export function applyPaletteToRoot(palette: Palette): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(palette.vars)) {
    root.style.setProperty(k, v);
  }
  // Drop any structural/sprite token a previous (structural) skin may have
  // left inline, so the fixed dark structure's CSS fallbacks render.
  for (const k of LEGACY_STRUCTURAL_TOKENS) {
    root.style.removeProperty(k);
  }
  // Expose the active palette id as `data-palette` on <html> for any scoped
  // CSS that wants it (none by default — the structure is fixed).
  root.setAttribute('data-palette', palette.id);
  // Drop any stale skin-font <link> a previous structural skin injected.
  if (typeof document !== 'undefined' && document.head) {
    const existing = document.head.querySelector('link[data-skin-font]');
    if (existing) existing.remove();
  }
}

/** Singleton — exported so any component can import + call `setSkin()`. */
export const skinStore = new SkinStore();

// Dev-only: expose on window so e2e tests can drive the store without
// rendering the switcher UI. Stripped in prod builds.
if (
  typeof import.meta !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).env?.DEV &&
  typeof window !== 'undefined'
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__skinStore = skinStore;
}
