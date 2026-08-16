// packages/web/src/lib/ui/media/node-extras.ts
//
// The real-DOM singleton for the node-lifetime EXTRAS producer seam (#1720).
//
// Split out of ./node-extras-registry deliberately: that file is the PURE core
// (no DOM, no engine, no `lib/video/**` import) so the web package's vitest —
// which runs in `environment: 'node'` — can drive it with fakes. This file is
// the only place the two meet, and it is imported by Canvas.svelte and by the
// cards that hold a lease.

import { createNodeExtrasRegistry, type ExtrasSurface } from './node-extras-registry';
import { EXTRAS_PRODUCERS, PAINTER_SURFACE } from './extras-producers';

/** One shared scratch context for TEXT MEASUREMENT only — never drawn into, so
 *  one for the whole app is correct (and one per node would be a real cost:
 *  `measureText` needs a context, not a canvas of any particular size). */
let sharedMeasureCtx: CanvasRenderingContext2D | null = null;

export const nodeExtras = createNodeExtrasRegistry(EXTRAS_PRODUCERS, {
  createSurface(_nodeId, _type) {
    const c = document.createElement('canvas');
    // Engine resolution by default — PAINTER's output IS its canvas 1:1.
    // TEXTMARQUEE re-sizes this to its text block on every rasterize.
    c.width = PAINTER_SURFACE.width;
    c.height = PAINTER_SURFACE.height;
    return c as unknown as ExtrasSurface;
  },
  measureContext() {
    if (!sharedMeasureCtx) {
      sharedMeasureCtx = document.createElement('canvas').getContext('2d');
    }
    return sharedMeasureCtx;
  },
  startTicker(tick, intervalMs) {
    const h = setInterval(tick, intervalMs);
    return () => clearInterval(h);
  },
  scheduleRetry(fn, delayMs) {
    const h = setTimeout(fn, delayMs);
    return () => clearTimeout(h);
  },
});
