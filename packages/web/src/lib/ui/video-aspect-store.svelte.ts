// packages/web/src/lib/ui/video-aspect-store.svelte.ts
//
// Video OUTPUT aspect store (Svelte 5 runes). Singleton per page. Tracks the
// 4:3 ↔ 16:9 switch + derives the engine resolution for the active aspect.
//
// Source-of-truth model:
//   - The CANONICAL persisted value lives in the patch Y.Doc's `settings` map
//     (see graph/persistence.ts SETTINGS_VIDEO_ASPECT) so it rides save/load,
//     performance export, AND multiplayer sync with no extra plumbing. This
//     store is the reactive REFLECTION the UI binds to + the bridge that pushes
//     the resolution into the live VideoEngine.
//   - On set(), we (1) update the reactive `aspect`, (2) compute the engine res
//     for that aspect, (3) call the registered engine applier (Canvas wires
//     VideoEngine.setResolution — an IN-PLACE realloc, NOT a teardown), and
//     (4) persist into the Y.Doc via the registered writer.
//
// HEIGHT-anchored at 768: 4:3 = 1024×768 (default), 16:9 = 1366×768. See
// video-res.ts aspectRes().
//
// SSR/test safety: no DOM/localStorage access at module-eval — the store holds
// the default ('4:3') in memory; Canvas wires the engine + doc on boot.

import { aspectRes, coerceAspect, DEFAULT_ASPECT, type VideoAspect, type Res } from '$lib/video/video-res';
import { testHooksEnabled } from '$lib/dev/test-hooks';

/** Applier the engine registers: push a new render res into the live engine
 *  (in-place realloc). Returns true if it changed something. */
export type EngineResApplier = (res: Res) => boolean;
/** Writer the doc layer registers: persist the aspect into the patch Y.Doc. */
export type AspectPersist = (aspect: VideoAspect) => void;

class VideoAspectStore {
  /** The active output aspect. Reactive — components re-render on set(). */
  aspect = $state<VideoAspect>(DEFAULT_ASPECT);

  private applier: EngineResApplier | null = null;
  private persist: AspectPersist | null = null;

  /** The engine render res for the current aspect. */
  get engineRes(): Res {
    return aspectRes(this.aspect);
  }

  /** True when 16:9 is active. */
  get isWide(): boolean {
    return this.aspect === '16:9';
  }

  /**
   * Register the engine applier (Canvas → VideoEngine.setResolution). Called on
   * engine boot. Immediately applies the current aspect's res so an aspect
   * picked before the engine existed (e.g. restored from a loaded patch) takes
   * effect.
   */
  setEngineApplier(applier: EngineResApplier | null): void {
    this.applier = applier;
    if (applier) applier(this.engineRes);
  }

  /** Register the doc persister (Canvas → writeVideoAspectToDoc). */
  setPersist(persist: AspectPersist | null): void {
    this.persist = persist;
  }

  /**
   * Set the output aspect. `persist` defaults true; the load path passes false
   * so applying a value just READ from the doc doesn't immediately re-write it.
   * Always re-applies the engine res (idempotent in the engine on no change).
   */
  set(aspect: VideoAspect, persist = true): void {
    const a = coerceAspect(aspect);
    this.aspect = a;
    this.applier?.(this.engineRes);
    if (persist) this.persist?.(a);
  }

  /** Toggle 4:3 ↔ 16:9 (the topbar pill). */
  toggle(): void {
    this.set(this.aspect === '16:9' ? '4:3' : '16:9');
  }
}

/** Singleton — imported by the topbar pill, Canvas (engine + doc wiring), and
 *  the preview cards (to read the live aspect for thumbnail sizing decisions). */
export const videoAspectStore = new VideoAspectStore();

// Dev/e2e hook — drive the aspect without the UI. Gated on testHooksEnabled()
// (DEV OR VITE_E2E_HOOKS=1) so it survives the prod `vite preview` bundle the
// CI e2e shards run against — matching the peer __engine/__patch/__ydoc hooks
// (the reverted #653 learned this: a DEV-only gate is tree-shaken out of the
// preview build and the e2e hook assertion fails).
if (typeof window !== 'undefined' && testHooksEnabled()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__videoAspectStore = videoAspectStore;
}
