// packages/web/src/lib/ui/media/node-hls-source.svelte.ts
//
// THE REAL-DOM SINGLETON for ./node-hls-source-registry — a thin binding of the
// pure core to the browser, hls.js, the Y.Doc and the engine.
//
// WHY IT IS A SEPARATE FILE, and `.svelte.ts` while the core is `.ts`: the core
// must unit-test in the web package's `environment: 'node'` vitest, where there
// is no `document`, no `HTMLVideoElement`, no `fetch` worth using, no hls.js and
// no `$state`. So every outside edge is injected there and BOUND here. This file
// is the only place that names a browser global, and it is deliberately
// dependency-shaped rather than logic-shaped: if you find yourself adding a
// branch here, it belongs in the core where a test can reach it.
//
// The `$state` record is the PUBLICATION half. The core pushes a status through
// `onStatus` on every change; a surface reads `nodeHlsSource.view(id)` and
// re-renders because that record is reactive. No surface polls.

import Hls from 'hls.js';
import type { ModuleNode } from '$lib/graph/types';
import type { VideoEngine } from '$lib/video/engine';
import type { PatchEngine } from '$lib/audio/engine';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import { nodeMedia } from './node-media-registry';
import { setNodeHls, destroyNodeHls } from './node-hls';
import {
  createNodeHlsSourceRegistry,
  HLS_SOURCE_SLOT,
  NO_HLS_SOURCE,
  NODE_HLS_SOURCE_TYPES,
  type HlsSourceEngine,
  type HlsSourceStatus,
  type HlsTunerExtras,
  type NodeHlsSourceRegistry,
} from './node-hls-source-registry';

/** Reactive published status per node. Written ONLY by the core's `onStatus`. */
const statuses = $state<Record<string, HlsSourceStatus>>({});

/** Adapt a `PatchEngine` to the narrow surface the controller needs. Returns
 *  null before the engine has booted, which the core treats as "retry". */
function adaptEngine(engine: PatchEngine | null): HlsSourceEngine | null {
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
    extras(nodeId) {
      try {
        return (video()?.read(nodeId, 'extras') as HlsTunerExtras | undefined) ?? null;
      } catch {
        return null;
      }
    },
    readParam(node, paramId) {
      try {
        return engine!.readParam(node, paramId);
      } catch {
        return undefined;
      }
    },
  };
}

const registry = createNodeHlsSourceRegistry<HTMLElement>({
  engine: null,
  doc: {
    read(nodeId) {
      const t = patch.nodes[nodeId];
      if (!t) return null;
      return (t.data ?? {}) as Readonly<Record<string, unknown>>;
    },
    write(nodeId, next) {
      ydoc.transact(() => {
        const t = patch.nodes[nodeId];
        if (!t) return;
        if (!t.data) t.data = {};
        const d = t.data as Record<string, unknown>;
        for (const [k, v] of Object.entries(next)) d[k] = v;
      }, LOCAL_ORIGIN);
    },
  },
  media: {
    ensure: (nodeId, slot, opts) =>
      nodeMedia.ensure(nodeId, slot, {
        kind: 'video',
        init: (el) => {
          const v = el as HTMLVideoElement;
          // PeerTube sends `ACAO: *` and famelack's HLS is untainted, so the
          // texture is CLEAN — but the attribute must be set before any src, or
          // the very first load is the one that taints.
          v.crossOrigin = 'anonymous';
          v.playsInline = true;
          v.setAttribute('data-testid', opts.testId);
          opts.init(v);
        },
      }),
    setDisposer: (nodeId, slot, dispose) => nodeMedia.setDisposer(nodeId, slot, dispose),
  },
  el: {
    setSrc: (el, url) => {
      (el as HTMLVideoElement).src = url;
    },
    clearSrc: (el) => {
      (el as HTMLVideoElement).removeAttribute('src');
    },
    setMuted: (el, muted) => {
      (el as HTMLVideoElement).muted = muted;
    },
    play: (el) => {
      void (el as HTMLVideoElement).play().catch(() => {
        /* autoplay blocked → the next user gesture retries */
      });
    },
    pause: (el) => {
      try {
        (el as HTMLVideoElement).pause();
      } catch {
        /* */
      }
    },
    paused: (el) => (el as HTMLVideoElement).paused,
    positionFrac: (el) => {
      const v = el as HTMLVideoElement;
      if (!(v.duration > 0) || !Number.isFinite(v.duration)) return 0;
      return Math.min(1, Math.max(0, v.currentTime / v.duration));
    },
    ended: (el) => (el as HTMLVideoElement).ended,
    hasCurrentData: (el) => (el as HTMLVideoElement).readyState >= 2 /* HAVE_CURRENT_DATA */,
    canPlayNativeHls: (el) =>
      (el as HTMLVideoElement).canPlayType('application/vnd.apple.mpegurl') !== '',
    on: (el, event, fn) => {
      el.addEventListener(event, fn);
      return () => el.removeEventListener(event, fn);
    },
  },
  player: {
    supported: () => Hls.isSupported(),
    create: (nodeId, el, url, handlers) => {
      const inst = new Hls({ enableWorker: true, lowLatencyMode: false });
      // `setNodeHls` destroys any PREVIOUS instance for this node, so a channel
      // swap replaces the demuxer instead of leaking a socket and a worker.
      setNodeHls(nodeId, inst);
      inst.on(Hls.Events.MANIFEST_PARSED, () => handlers.onManifestParsed());
      inst.on(Hls.Events.ERROR, (_e, d) => {
        // Fatal errors (including COEP/CORS blocks on a misconfigured instance)
        // surface as unavailable; hls.js recovers from non-fatal ones itself.
        if (d?.fatal) handlers.onFatalError();
      });
      inst.loadSource(url);
      inst.attachMedia(el as HTMLVideoElement);
    },
    destroy: (nodeId) => destroyNodeHls(nodeId),
  },
  clock: {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: () => Math.random(),
  },
  io: {
    fetchJson: async (url) => {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return (await resp.json()) as unknown;
    },
  },
  onStatus: (nodeId, status) => {
    statuses[nodeId] = status;
  },
});

/**
 * The process-wide node-owned HLS tuner registry.
 *
 * `sync` is called from `Canvas.svelte`'s graph effect and `sweep` from the same
 * effect that already retires `nodeMedia` — so a controller's lifetime is the
 * NODE's, from the graph, with no card involved at any point.
 */
export const nodeHlsSource = {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void {
    registry.sync(nodes, adaptEngine(engine));
  },
  /** Reactive: reads the `$state` record the core publishes into. */
  view(nodeId: string): HlsSourceStatus {
    return statuses[nodeId] ?? NO_HLS_SOURCE;
  },
  request: registry.request,
  has: registry.has,
  disposeNode(nodeId: string): void {
    registry.disposeNode(nodeId);
    delete statuses[nodeId];
  },
  sweep(liveIds: Iterable<string>): void {
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
    registry.sweep(live);
    for (const id of Object.keys(statuses)) if (!live.has(id)) delete statuses[id];
  },
  snapshot: registry.snapshot,
} satisfies Omit<NodeHlsSourceRegistry<HTMLElement>, 'sync'> & {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void;
};

export { HLS_SOURCE_SLOT, NODE_HLS_SOURCE_TYPES };
