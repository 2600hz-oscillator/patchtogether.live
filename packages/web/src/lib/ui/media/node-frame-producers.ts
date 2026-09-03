// packages/web/src/lib/ui/media/node-frame-producers.ts
//
// The real-DOM singleton for the node-lifetime PER-FRAME producer seam
// (legacy-removal S1).
//
// Split out of ./node-frame-producer-registry deliberately, exactly as
// ./node-extras.ts is split out of ./node-extras-registry: that file is the PURE
// core (no DOM, no engine, no graph store) so the web package's vitest — which
// runs in `environment: 'node'` — can drive it with fakes. This file is the only
// place the three meet, and it is imported by `Canvas.svelte`.
//
// It is deliberately DEPENDENCY-SHAPED rather than logic-shaped: a branch that
// appears here belongs in the core or in a producer, where a test can reach it.

import type { ModuleNode } from '$lib/graph/types';
import type { PatchEngine } from '$lib/audio/engine';
import type { VideoEngine } from '$lib/video/engine';
import { patch } from '$lib/graph/store';
import { FRAME_PRODUCERS, NODE_FRAME_PRODUCER_TYPES } from './frame-producers';
import {
  createNodeFrameProducerRegistry,
  type FrameGraph,
  type FrameImage,
  type FrameProducerEngine,
  type FrameSurface,
} from './node-frame-producer-registry';

/** Re-exported for callers that already hold the singleton. The set is DERIVED
 *  in `./frame-producers`, so a gate can ask "who owns this module" without
 *  importing the graph store and the engine adapters below. */
export { NODE_FRAME_PRODUCER_TYPES };

/** The graph reads, bound to the live store.
 *
 *  ⚠ READ FROM THE STORE ON EVERY CALL, never from a captured value. These run
 *  once per frame for the life of the NODE and outlive every surface; a cached
 *  edge map would freeze at whatever was patched when the node appeared. */
const graph: FrameGraph = {
  findSource(targetNodeId, targetPortId) {
    for (const eid of Object.keys(patch.edges)) {
      const e = patch.edges[eid];
      if (!e) continue;
      if (e.target?.nodeId === targetNodeId && e.target?.portId === targetPortId) {
        return { nodeId: e.source.nodeId, portId: e.source.portId };
      }
    }
    return null;
  },
  node(nodeId) {
    return patch.nodes[nodeId] as ModuleNode | undefined;
  },
};

function adaptEngine(engine: PatchEngine | null): FrameProducerEngine | null {
  if (!engine) return null;
  return {
    read: (node, key) => engine.read(node, key),
    readParam: (node, paramId) => engine.readParam(node, paramId),
    write: (node, key, value) => engine.write(node, key, value),
    blitVideoNode(nodeId) {
      let ve: VideoEngine | undefined;
      try {
        ve = engine.getDomain<VideoEngine>('video');
      } catch {
        return null;
      }
      if (!ve) return null;
      try {
        ve.blitOutputToDrawingBuffer(nodeId);
      } catch {
        return null;
      }
      return (ve.canvas as unknown) ?? null;
    },
    videoSource(nodeId, portId) {
      let ae:
        | {
            getVideoSource?: (
              n: string,
              p: string,
            ) => { drawFrame?: (c: unknown) => void } | null;
          }
        | undefined;
      try {
        ae = engine.getDomain('audio') as unknown as typeof ae;
      } catch {
        return null;
      }
      return ae?.getVideoSource?.(nodeId, portId) ?? null;
    },
  };
}

/** Mint an off-DOM compositing surface — `OffscreenCanvas` where the runtime has
 *  one, a detached `<canvas>` otherwise. Never attached to the document: this
 *  seam composites, it never paints anything a user looks at. */
function createSurface(_nodeId: string, _type: string, w: number, h: number): FrameSurface | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h) as unknown as FrameSurface;
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c as unknown as FrameSurface;
  }
  return null;
}

const registry = createNodeFrameProducerRegistry(
  FRAME_PRODUCERS,
  {
    createSurface,
    /**
     * ONE shared `requestAnimationFrame` for every producer node — see the
     * core's header for why this is the meter-frame argument WITHOUT its
     * IntersectionObserver gate. Started when the first producer node appears,
     * stopped when the last one leaves, so a rack with none costs nothing.
     */
    startTicker(tick) {
      if (typeof requestAnimationFrame !== 'function') return () => {};
      let raf: number | null = null;
      const loop = (): void => {
        tick();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => {
        if (raf !== null) cancelAnimationFrame(raf);
        raf = null;
      };
    },
    env: {
      prefersReducedMotion() {
        return (
          typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        );
      },
      createImageBitmap:
        typeof createImageBitmap === 'function'
          ? (src: unknown) => createImageBitmap(src as ImageBitmapSource)
          : null,
      /**
       * ⚠ RESOLVES ON *DECODE*, NOT ON *LOAD*, and the difference is measured.
       * `TimelordeCard` used to flip its ready flag in `onload`, which fires
       * when the bytes have arrived and not when the bitmap is rasterised — so
       * the first `drawImage` could paint from a partially-rastered source, and
       * under `prefers-reduced-motion` (the VRT capture) exactly one frame is
       * painted and whatever raster state Chromium was in is LATCHED forever.
       * 13 of 20 separate processes failed unmasked on that. `onload` stays the
       * trigger (`decode()` on an image with no src rejects) and the fallback
       * for a runtime without `decode`.
       */
      loadImage(url) {
        if (typeof Image === 'undefined') return Promise.resolve(null);
        return new Promise<FrameImage | null>((resolve) => {
          const img = new Image();
          img.decoding = 'async';
          const ready = (): void => resolve(img as unknown as FrameImage);
          img.onload = () => {
            if (typeof img.decode === 'function') void img.decode().then(ready).catch(ready);
            else ready();
          };
          img.onerror = () => resolve(null);
          img.src = url;
        });
      },
    },
  },
  graph,
);

/**
 * The process-wide node-owned PER-FRAME producer registry.
 *
 * `sync` is called from `Canvas.svelte`'s graph effect and `sweep` from the same
 * effect that already retires the other node-keyed owners — so a producer's
 * lifetime is the NODE's, from the graph, with no card involved at any point.
 */
export const nodeFrameProducers = {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void {
    registry.sync(nodes, adaptEngine(engine));
  },
  sweep: registry.sweep,
  disposeNode: registry.disposeNode,
  has: registry.has,
  snapshot: registry.snapshot,
  /** The ticker drives this; exposed so an e2e probe can force a frame without
   *  waiting on rAF in a throttled context. */
  tick: registry.tick,
};
