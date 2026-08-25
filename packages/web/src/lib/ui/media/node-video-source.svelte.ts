// packages/web/src/lib/ui/media/node-video-source.svelte.ts
//
// THE REAL-DOM SINGLETON for ./node-video-source-registry — a thin binding of
// the pure core to the browser, the Y.Doc and the engine.
//
// WHY IT IS A SEPARATE FILE, and `.svelte.ts` while the core is `.ts`: the core
// must unit-test in the web package's `environment: 'node'` vitest, where there
// is no `document`, no `URL.createObjectURL`, no IndexedDB and no `$state`. So
// every outside edge is injected there and BOUND here. This file is the only
// place that names a browser global, and it is deliberately dependency-shaped
// rather than logic-shaped: if you find yourself adding a branch here, it
// belongs in the core where a test can reach it.
//
// The `$state` record is the PUBLICATION half. The core pushes a status through
// `onStatus` on every change; a surface reads `nodeVideoSource.view(id)` and
// re-renders because that record is reactive. No surface polls.

import type { ModuleNode } from '$lib/graph/types';
import type { VideoEngine } from '$lib/video/engine';
import type { PatchEngine } from '$lib/audio/engine';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { VideoboxData } from '$lib/video/modules/videobox';
import { buildSyncWrite, type VideoboxFileMeta } from '$lib/video/modules/videobox-sync';
import {
  canPersistVideoHandles,
  newVideoFileId,
  putVideoFileHandle,
  getVideoFileHandle,
  deleteVideoFileHandle,
  queryHandleReadPermission,
  requestHandleReadPermission,
  type StoredFileHandle,
} from '$lib/video/video-file-store';
import { registerVideoExport, unregisterVideoExport } from '$lib/video/video-export-registry';
import { nodeMedia } from './node-media-registry';
import {
  createNodeVideoSourceRegistry,
  NO_VIDEO_SOURCE,
  VIDEO_SOURCE_SLOT,
  type NodeVideoSourceRegistry,
  type VideoSourceEngine,
  type VideoSourceStatus,
  type VideoSourceHandleHooks,
} from './node-video-source-registry';

/** Reactive published status per node. Written ONLY by the core's `onStatus`. */
const statuses = $state<Record<string, VideoSourceStatus>>({});

/** Adapt a `PatchEngine` to the narrow surface the controller needs. Returns
 *  null before the engine has booted, which the core treats as "retry". */
function adaptEngine(engine: PatchEngine | null): VideoSourceEngine | null {
  if (!engine) return null;
  function video(): VideoEngine | null {
    try { return engine!.getDomain<VideoEngine>('video'); } catch { return null; }
  }
  return {
    attach(nodeId, el) {
      video()?.attachExternalSource(nodeId, 'video', (el as HTMLElement | null) ?? null);
    },
    hasElement(nodeId) {
      try { return video()?.read(nodeId, 'hasVideoElement') === true; } catch { return false; }
    },
    extras(nodeId) {
      try {
        const e = video()?.read(nodeId, 'extras') as
          | { wireAudio(): void; isAudioWired(): boolean }
          | undefined;
        return e ?? null;
      } catch { return null; }
    },
    readParam(node, paramId) {
      try { return engine!.readParam(node, paramId); } catch { return undefined; }
    },
  };
}

/** The FileSystemFileHandle machinery, bound to the real IDB-backed store. */
const handleHooks: VideoSourceHandleHooks = {
  canPersist: () => canPersistVideoHandles(),
  newId: () => newVideoFileId(),
  put: (id, handle) => putVideoFileHandle(id, handle as StoredFileHandle),
  get: (id) => getVideoFileHandle(id) as Promise<unknown | null>,
  queryPermission: (handle) => queryHandleReadPermission(handle as StoredFileHandle),
  requestPermission: (handle) => requestHandleReadPermission(handle as StoredFileHandle),
  getFile: (handle) => (handle as StoredFileHandle).getFile(),
};

const registry = createNodeVideoSourceRegistry<HTMLElement>(
  {
    engine: null,
    doc: {
      read(nodeId) {
        const t = patch.nodes[nodeId];
        if (!t) return null;
        const d = (t.data ?? {}) as Partial<VideoboxData>;
        return {
          fileMeta: d.fileMeta ?? null,
          isPlaying: d.isPlaying ?? false,
          lastSyncTime: d.lastSyncTime ?? 0,
          lastSyncPosition: d.lastSyncPosition ?? 0,
        };
      },
      writeSync(nodeId, args) {
        const next = buildSyncWrite({
          isPlaying: args.isPlaying,
          currentPositionSec: args.currentPositionSec,
          nowWallclockMs: Date.now(),
        });
        ydoc.transact(() => {
          const t = patch.nodes[nodeId];
          if (!t) return;
          if (!t.data) t.data = {};
          const d = t.data as Partial<VideoboxData>;
          d.isPlaying = next.isPlaying;
          d.lastSyncTime = next.lastSyncTime;
          d.lastSyncPosition = next.lastSyncPosition;
        }, LOCAL_ORIGIN);
      },
      writeFileMeta(nodeId, meta: VideoboxFileMeta, opts) {
        // Drop a stale handle from THIS browser's IDB when the file genuinely
        // changes, so it does not leak. Only when the id actually moves — a
        // reload reuses the same id.
        const prevId = (patch.nodes[nodeId]?.data as Partial<VideoboxData> | undefined)
          ?.fileMeta?.handleId;
        if (prevId && prevId !== meta.handleId) void deleteVideoFileHandle(prevId);
        ydoc.transact(() => {
          const t = patch.nodes[nodeId];
          if (!t) return;
          if (!t.data) t.data = {};
          const d = t.data as Partial<VideoboxData>;
          d.fileMeta = meta;
          if (opts.resetPlayhead) {
            d.isPlaying = false;
            d.lastSyncTime = Date.now();
            d.lastSyncPosition = 0;
          }
        }, LOCAL_ORIGIN);
      },
    },
    media: {
      ensure: (nodeId, slot) =>
        nodeMedia.ensure(nodeId, slot, {
          kind: 'video',
          init: (el) => {
            const v = el as HTMLVideoElement;
            v.playsInline = true;
            v.setAttribute('data-testid', 'videobox-video');
          },
        }),
      objectUrl: (nodeId, slot) => nodeMedia.objectUrl(nodeId, slot),
      setObjectUrl: (nodeId, slot, url, name) => nodeMedia.setObjectUrl(nodeId, slot, url, name),
      mediaName: (nodeId, slot) => nodeMedia.mediaName(nodeId, slot),
    },
    el: {
      setSrc: (el, url) => { (el as HTMLVideoElement).src = url; },
      setMuted: (el, muted) => { (el as HTMLVideoElement).muted = muted; },
      currentTime: (el) => (el as HTMLVideoElement).currentTime,
      seek: (el, to) => { (el as HTMLVideoElement).currentTime = to; },
      paused: (el) => (el as HTMLVideoElement).paused,
      play: (el) => { void (el as HTMLVideoElement).play().catch(() => { /* autoplay */ }); },
      pause: (el) => { (el as HTMLVideoElement).pause(); },
      duration: (el) => {
        const d = (el as HTMLVideoElement).duration;
        return Number.isFinite(d) ? d : 0;
      },
      awaitMetadata: (el) =>
        new Promise<void>((resolve) => {
          const v = el as HTMLVideoElement;
          if (v.readyState >= 1 /* HAVE_METADATA */) { resolve(); return; }
          const onMeta = (): void => { v.removeEventListener('loadedmetadata', onMeta); resolve(); };
          v.addEventListener('loadedmetadata', onMeta, { once: true });
        }),
    },
    clock: {
      now: () => Date.now(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
    createObjectUrl: (file) => URL.createObjectURL(file),
    registerExport: (nodeId, resolve) => registerVideoExport(nodeId, resolve),
    unregisterExport: (nodeId) => unregisterVideoExport(nodeId),
    fetchBytes: async (url) => {
      const resp = await fetch(url);
      return new Uint8Array(await (await resp.blob()).arrayBuffer());
    },
    onStatus: (nodeId, status) => { statuses[nodeId] = status; },
  },
  handleHooks,
);

/**
 * The process-wide node-owned video source registry.
 *
 * `sync` is called from `Canvas.svelte`'s graph effect and `sweep` from the same
 * effect that already retires `nodeMedia` — so a controller's lifetime is the
 * NODE's, from the graph, with no card involved at any point.
 */
export const nodeVideoSource = {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void {
    registry.sync(nodes, adaptEngine(engine));
  },
  /** Reactive: reads the `$state` record the core publishes into. */
  view(nodeId: string): VideoSourceStatus {
    return statuses[nodeId] ?? NO_VIDEO_SOURCE;
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
} satisfies Omit<NodeVideoSourceRegistry<HTMLElement>, 'sync'> & {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void;
};

/**
 * One-click "re-allow <name>": request read permission INSIDE the caller's click
 * gesture, then hand the file back through the normal load path.
 *
 * ⚠ THIS CANNOT LIVE IN THE CONTROLLER, and the reason is the whole shape of the
 * gesture seam: `requestPermission()` is only honoured inside a real user
 * gesture, so the call must originate from the surface's own event handler. The
 * controller publishes THAT a re-allow is available (`pendingHandleName`); the
 * surface performs it. Everything after the grant is the controller's again.
 */
export async function reAllowVideoHandle(nodeId: string): Promise<boolean> {
  const meta = (patch.nodes[nodeId]?.data as Partial<VideoboxData> | undefined)?.fileMeta ?? null;
  const handleId = meta?.handleId;
  if (!handleId) return false;
  const handle = await getVideoFileHandle(handleId);
  if (!handle) return false;
  const perm = await requestHandleReadPermission(handle);
  if (perm !== 'granted') return false;
  try {
    const file = await handle.getFile();
    return nodeVideoSource.request(nodeId, {
      kind: 'load',
      file,
      handle,
      reuseHandleId: handleId,
    }).delivered;
  } catch {
    return false;
  }
}

export { VIDEO_SOURCE_SLOT };
