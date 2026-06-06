// HD-toggle store — Svelte 5 runes. Singleton per page. Cloned from
// skin-store.svelte.ts (same persistence + SSR + dev-hook model).
//
// HD mode renders every video module's internal FBOs at a viewport-derived
// ~1080-line resolution instead of the default 640×480. It is a DEVICE/GPU
// capability (a 4090 wants it; an M-series/laptop may not), NOT patch content —
// so it persists per-browser in localStorage and is deliberately NOT synced to
// collaborators via Y.Doc. Default OFF: byte-for-byte identical to today.
//
// On toggle ON: capture a target {width,height} from the current viewport
// aspect (so a reload is deterministic — we persist the captured res, not just
// the bool). Canvas.svelte observes `on` via a $effect and rebuilds the
// VideoEngine at the new res (dispose + reconstruct; the reconciler re-adds
// nodes/edges). See .myrobots/plans/hd-toggle.md §5.
//
// SSR safety: gated on `typeof window`/`localStorage`. Under SSR the store
// holds the default (OFF) in memory and skips storage.

import { computeHdResFromViewport, type Res } from '$lib/video/hd-res';
import { VIDEO_RES } from '$lib/video/engine';

const STORAGE_KEY = 'pt.hd';

interface PersistedHd {
  on: boolean;
  /** The render res captured at toggle time (so reload is deterministic and
   *  doesn't re-derive from a possibly-different reload viewport). */
  res: Res;
}

class HdStore {
  /** Whether HD mode is active. Reactive — Canvas.svelte's rebuild $effect
   *  observes this. Default OFF. */
  on = $state(false);

  /** The target internal render resolution to use when `on` is true. Captured
   *  from the viewport at toggle time + persisted. When OFF, the engine uses
   *  VIDEO_RES regardless of this value. */
  res = $state<Res>({ width: VIDEO_RES.width, height: VIDEO_RES.height });

  constructor() {
    if (typeof window !== 'undefined') {
      try {
        const raw =
          typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<PersistedHd>;
          if (parsed && typeof parsed.on === 'boolean') {
            this.on = parsed.on;
            if (
              parsed.res &&
              Number.isFinite(parsed.res.width) &&
              Number.isFinite(parsed.res.height) &&
              parsed.res.width > 0 &&
              parsed.res.height > 0
            ) {
              this.res = { width: parsed.res.width, height: parsed.res.height };
            } else if (parsed.on) {
              // ON but no valid persisted res (older format) — re-derive.
              this.res = computeHdResFromViewport();
            }
          }
        }
      } catch {
        // Corrupt JSON / restricted storage (Safari private) — stay OFF.
      }
    }
  }

  /**
   * Turn HD on or off. When turning ON, (re)capture the target res from the
   * current viewport aspect unless an explicit res is supplied (e2e). Persists
   * the {on,res} pair so a reload restores the exact resolution.
   *
   * @param on       The desired state.
   * @param resOverride  Optional explicit res (mainly for e2e determinism).
   */
  set(on: boolean, resOverride?: Res): void {
    this.on = on;
    if (on) {
      this.res = resOverride ?? computeHdResFromViewport();
    }
    // When OFF we keep the last captured res in memory (harmless — the engine
    // ignores it), but persist the bool so reload restores OFF.
    this.persist();
  }

  /** Convenience toggle for the pill button. */
  toggle(): void {
    this.set(!this.on);
  }

  /**
   * The resolution the engine should be constructed with RIGHT NOW. OFF →
   * VIDEO_RES (byte-for-byte today); ON → the captured HD res. Canvas.svelte
   * reads this when (re)building the VideoEngine.
   */
  get engineRes(): Res {
    return this.on
      ? { width: this.res.width, height: this.res.height }
      : { width: VIDEO_RES.width, height: VIDEO_RES.height };
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const payload: PersistedHd = { on: this.on, res: this.res };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Quota / disabled — non-fatal.
    }
  }
}

/** Singleton — import + call `hdStore.set()` / `hdStore.toggle()` anywhere. */
export const hdStore = new HdStore();

// Dev-only: expose on window so e2e tests can drive HD without clicking the
// pill. Stripped in prod builds. Optional-chained `import.meta.env` so vitest's
// node runner (no Vite import-meta replacement) doesn't crash on module eval.
if (
  typeof import.meta !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).env?.DEV &&
  typeof window !== 'undefined'
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__hdStore = hdStore;
}
