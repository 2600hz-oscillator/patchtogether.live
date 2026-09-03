// packages/web/src/lib/ui/media/node-loopback-source.svelte.ts
//
// THE REAL-DOM SINGLETON for ./node-loopback-source-registry — a thin binding of
// the pure core to the browser, the graph store and the engine.
//
// Same split, same reason, as `./node-video-source.svelte.ts`: the core must
// unit-test in the web package's `environment: 'node'` vitest, where there is
// no `document`, no `navigator.mediaDevices` and no `$state`. Every outside
// edge is injected there and BOUND here. This file is the only place that names
// a browser global, and it is deliberately dependency-shaped rather than
// logic-shaped — a branch that appears here belongs in the core where a test
// can reach it.
//
// ⚠ THIS FILE ALSO FEEDS `loopback-status-registry`, and that is the whole
// migration in one line. `LoopbackOutputBody.svelte` (the faceplate) is written
// against that seam and is UNTOUCHED by this change; what moved is who
// publishes into it and who owns the two commands. The card used to; the
// controller does now. Keeping one status truth rather than minting a second is
// what stops the card and the faceplate from ever disagreeing about whether a
// capture is running.

import type { ModuleNode } from '$lib/graph/types';
import type { PatchEngine } from '$lib/audio/engine';
import type { VideoEngine } from '$lib/video/engine';
import { patch } from '$lib/graph/store';
import { loopbackDef } from '$lib/video/modules/loopback';
import {
  acquireViewportStream,
  isViewportCaptureSupported,
} from '$lib/ui/viewport-acquire';
import { nodeMedia } from './node-media-registry';
import { loopbackCropPump } from './loopback-crop-pump';
import { loopbackStatus, type LoopbackCommandLease } from './loopback-status-registry';
import {
  createNodeLoopbackSourceRegistry,
  LOOPBACK_SOURCE_SLOT,
  NO_LOOPBACK_SOURCE,
  NODE_LOOPBACK_SOURCE_TYPES,
  type LoopbackSourceEngine,
  type LoopbackSourceStatus,
  type NodeLoopbackSourceRegistry,
} from './node-loopback-source-registry';

/** Reactive published status per node. Written ONLY by the core's `onStatus`. */
const statuses = $state<Record<string, LoopbackSourceStatus>>({});

/** The command leases this file holds on the cross-surface status seam. One per
 *  node, taken on first publish and released when the node is swept. */
const commandLeases = new Map<string, LoopbackCommandLease>();

function adaptEngine(engine: PatchEngine | null): LoopbackSourceEngine | null {
  if (!engine) return null;
  function video(): VideoEngine | null {
    try {
      return engine!.getDomain<VideoEngine>('video');
    } catch {
      return null;
    }
  }
  return {
    attach(nodeId, el) {
      video()?.attachExternalSource(nodeId, 'video', (el as HTMLElement | null) ?? null);
    },
    hasElement(nodeId) {
      try {
        return video()?.read(nodeId, 'hasVideoElement') === true;
      } catch {
        return false;
      }
    },
    setCrop(nodeId, crop) {
      const ve = video();
      if (!ve) return;
      ve.setParam(nodeId, '_cropU0', crop.u0);
      ve.setParam(nodeId, '_cropU1', crop.u1);
      ve.setParam(nodeId, '_cropV0', crop.v0);
      ve.setParam(nodeId, '_cropV1', crop.v1);
    },
  };
}

/** Take (or keep) the command slot for a node. `registerCommands` TRANSFERS to
 *  the newest registrant, so re-taking it is how the controller reclaims the
 *  slot from a legacy card mount that registered first. */
function ensureCommands(nodeId: string): void {
  if (commandLeases.has(nodeId)) return;
  commandLeases.set(
    nodeId,
    loopbackStatus.registerCommands(nodeId, {
      acquire: () => void registry.request(nodeId, 'acquire'),
      stop: () => void registry.request(nodeId, 'stop'),
    }),
  );
}

function releaseCommands(nodeId: string): void {
  commandLeases.get(nodeId)?.release();
  commandLeases.delete(nodeId);
}

const registry = createNodeLoopbackSourceRegistry<HTMLElement>({
  engine: null,
  media: {
    ensure: (nodeId, slot) =>
      nodeMedia.ensure(nodeId, slot, {
        kind: 'video',
        init: (el) => {
          const v = el as HTMLVideoElement;
          v.playsInline = true;
          v.muted = true;
          v.autoplay = true;
          // ⚠ THE TESTID IS SET HERE, NOT IN A SURFACE. The element is node-owned
          // and adopted by whichever surface is showing it, so a testid applied
          // at adoption time would exist only while that surface was mounted —
          // which is exactly the coupling this move removes.
          v.setAttribute('data-testid', 'loopback-preview');
        },
      }),
    setStream: (nodeId, slot, stream) => nodeMedia.setStream(nodeId, slot, stream),
    stream: (nodeId, slot) => nodeMedia.stream(nodeId, slot),
  },
  el: {
    setStream: (el, stream) => {
      (el as HTMLVideoElement).srcObject = stream;
    },
    play: (el) => {
      void (el as HTMLVideoElement).play().catch((err) => {
        console.warn('[loopback] video.play() rejected:', err);
      });
    },
  },
  capture: {
    supported: () => isViewportCaptureSupported(),
    acquire: async () => {
      const md = navigator.mediaDevices as unknown as {
        getDisplayMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
      };
      // ⚠ `acquireViewportStream` calls `getDisplayMedia` on its FIRST line —
      // the user activation reaches it because nothing on this path awaits
      // first. See the gesture note in the core.
      const r = await acquireViewportStream((c) => md.getDisplayMedia(c));
      return {
        stream: r.stream,
        error: r.error ? { name: r.error.name, message: r.error.message } : null,
      };
    },
    onEnded: (stream, fn) => {
      const track = stream.getVideoTracks()[0];
      if (!track) return () => {};
      track.addEventListener('ended', fn);
      return () => track.removeEventListener('ended', fn);
    },
  },
  pump: {
    start: (nodeId, d) => loopbackCropPump.start(nodeId, d),
    stop: (nodeId) => loopbackCropPump.stop(nodeId),
  },
  doc: {
    // ⚠ READ FROM THE STORE, never from a controller field. The pump calls this
    // every frame and outlives every surface; a captured value would freeze at
    // whatever it was when the capture started.
    cropEnabled: (nodeId) => {
      const raw = patch.nodes[nodeId]?.params?.crop;
      const dflt = loopbackDef.params.find((x) => x.id === 'crop')?.defaultValue ?? 1;
      return (typeof raw === 'number' ? raw : dflt) >= 0.5;
    },
  },
  clock: {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  },
  onStatus: (nodeId, status) => {
    statuses[nodeId] = status;
    // The cross-surface seam. Published on every change, exactly as the card
    // did, so the faceplate's lamp/error/button-enablement keep deriving from
    // one place.
    loopbackStatus.publish(nodeId, {
      state: status.state,
      errorMsg: status.errorMsg,
      supported: status.supported,
    });
    ensureCommands(nodeId);
  },
});

/**
 * The process-wide node-owned LOOPBACK capture registry.
 *
 * `sync` is called from `Canvas.svelte`'s graph effect and `sweep` from the same
 * effect that already retires `nodeMedia` — so a controller's lifetime is the
 * NODE's, from the graph, with no card involved at any point.
 */
export const nodeLoopbackSource = {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void {
    registry.sync(nodes, adaptEngine(engine));
  },
  /** Reactive: reads the `$state` record the core publishes into. */
  view(nodeId: string): LoopbackSourceStatus {
    return statuses[nodeId] ?? NO_LOOPBACK_SOURCE;
  },
  request: registry.request,
  has: registry.has,
  disposeNode(nodeId: string): void {
    registry.disposeNode(nodeId);
    releaseCommands(nodeId);
    delete statuses[nodeId];
  },
  sweep(liveIds: Iterable<string>): void {
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
    registry.sweep(live);
    for (const id of Object.keys(statuses)) {
      if (!live.has(id)) {
        releaseCommands(id);
        delete statuses[id];
      }
    }
  },
  snapshot: registry.snapshot,
} satisfies Omit<NodeLoopbackSourceRegistry<HTMLElement>, 'sync'> & {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void;
};

export { LOOPBACK_SOURCE_SLOT, NODE_LOOPBACK_SOURCE_TYPES };
