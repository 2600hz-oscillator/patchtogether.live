// packages/web/src/lib/ui/media/node-varispeed.svelte.ts
//
// THE REAL-DOM SINGLETON for ./node-varispeed-registry — a thin binding of the
// pure core to the browser, the Y.Doc and the engine.
//
// Same split, and the same reason, as ./node-video-source.svelte.ts: the core
// must unit-test under `environment: 'node'`, where there is no `document`, no
// `requestAnimationFrame` and no `$state`. Every outside edge is injected there
// and bound here. This file is deliberately dependency-shaped rather than
// logic-shaped — a branch belongs in the core, where a test can reach it.

import type { ModuleNode } from '$lib/graph/types';
import type { VideoEngine } from '$lib/video/engine';
import type { PatchEngine } from '$lib/audio/engine';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import { videoVarispeedDef } from '$lib/video/modules/videovarispeed';
import { readCrop } from '$lib/ui/modules/crop-edit';
import { videoAspectStore } from '$lib/ui/video-aspect-store.svelte';
import type { ModuleNode as GraphNode } from '$lib/graph/types';
import { ASSET_SLOTS } from '$lib/video/asset-select';
import type { VideoboxFileMeta } from '$lib/video/modules/videobox-sync';
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
import {
  registerVideoExport,
  unregisterVideoExport,
} from '$lib/video/video-export-registry';
import { nodeMedia } from './node-media-registry';
import type { VideoSourceHandleHooks } from './node-video-source-registry';
import {
  createNodeVarispeedRegistry,
  varispeedSlotKey,
  VARISPEED_DEFAULT_LOOP,
  NO_VARISPEED,
  type NodeVarispeedRegistry,
  type VarispeedEngine,
  type VarispeedStatus,
} from './node-varispeed-registry';

/** Reactive published status per node. Written ONLY by the core's `onStatus`. */
const statuses = $state<Record<string, VarispeedStatus>>({});

/** The synced keys this module owns on `node.data`. */
interface VarispeedData {
  isPlaying?: boolean;
  loop?: boolean;
  fileMeta?: VideoboxFileMeta | null;
  slotMeta?: (VideoboxFileMeta | null)[];
  crop?: { active: boolean; x: number; y: number; w: number };
}

/** PLAIN clone of a (possibly live Y) file-meta record. */
function cloneMeta(m: VideoboxFileMeta | null | undefined): VideoboxFileMeta | null {
  return m ? { name: m.name, duration: m.duration, size: m.size, handleId: m.handleId } : null;
}

/** The live OUTPUT aspect the crop is locked to. ONE reader, shared by the doc
 *  seam's coercion and by the aspect re-fit that consumes it. */
function liveOutAspect(): number {
  return videoAspectStore.engineRes.height > 0
    ? videoAspectStore.engineRes.width / videoAspectStore.engineRes.height
    : 4 / 3;
}

/** The FileSystemFileHandle machinery, bound to the real IDB-backed store —
 *  the SAME hooks shape the P1 (videobox) controller takes, imported rather
 *  than re-declared so the two restore paths cannot drift. */
const handleHooks: VideoSourceHandleHooks = {
  canPersist: () => canPersistVideoHandles(),
  newId: () => newVideoFileId(),
  put: (id, handle) => putVideoFileHandle(id, handle as StoredFileHandle),
  get: (id) => getVideoFileHandle(id) as Promise<unknown | null>,
  queryPermission: (handle) => queryHandleReadPermission(handle as StoredFileHandle),
  requestPermission: (handle) => requestHandleReadPermission(handle as StoredFileHandle),
  getFile: (handle) => (handle as StoredFileHandle).getFile(),
};

function adaptEngine(engine: PatchEngine | null): VarispeedEngine | null {
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
          | {
              wireAudio(): void;
              isAudioWired(): boolean;
              keepSlotAlive(el: unknown): void;
              setCrop(rect: unknown | null): void;
            }
          | undefined;
        return e ?? null;
      } catch { return null; }
    },
    readParam(node, paramId) {
      try { return engine!.readParam(node, paramId); } catch { return undefined; }
    },
    knob(node, paramId) {
      // Exactly `cardParams(...).paramVal`: the node's own value, else the DEF's
      // declared default. See the seam's doc comment for why `readParam` is the
      // wrong reader here (`end` defaults to 1 and reads 0).
      const v = (node.params as Record<string, number> | undefined)?.[paramId];
      if (typeof v === 'number') return v;
      const def = videoVarispeedDef.params?.find((p) => p.id === paramId);
      return def?.defaultValue ?? 0;
    },
    isConnected(node, portId) {
      // Same predicate the card used: scan the live edge map for anything
      // landing on this node's port. An UNPATCHED cv input is ignored by the
      // window math; one patched and sitting at zero is not.
      for (const e of Object.values(patch.edges)) {
        const edge = e as { to?: { nodeId?: string; portId?: string } };
        if (edge?.to?.nodeId === node.id && edge?.to?.portId === portId) return true;
      }
      return false;
    },
  };
}

const registry = createNodeVarispeedRegistry<HTMLElement>({
  engine: null,
  doc: {
    read(nodeId) {
      const t = patch.nodes[nodeId];
      if (!t) return null;
      const d = (t.data ?? {}) as VarispeedData;
      // ⚠ The crop is COERCED here, not in the core, and the split is
      // deliberate. `node.data.crop` is stored raw as `{active,x,y,w}`, and
      // `readCrop` normalises it against the live OUTPUT ASPECT — which lives
      // in a browser-side store the pure core has no business importing. The
      // core receives the same rect-or-null the card used to push, so there is
      // exactly one coercion in the codebase and the two cannot disagree.
      const outAspect = liveOutAspect();
      const cropState = readCrop(t as unknown as GraphNode, outAspect, outAspect);
      const rawCrop = d.crop
        ? { x: d.crop.x, y: d.crop.y, w: d.crop.w }
        : null;
      return {
        outAspect,
        rawCrop,
        // ⚠ PLAIN CLONES, never the live Y children. The core compares these
        // against what it just wrote and hands them back through
        // `writeSlotMeta`; re-inserting a live Y type throws "reassigning
        // object that already occurs in the tree" and aborts the transaction —
        // the trap `writeSlotMeta` below was written for.
        fileMeta: cloneMeta(d.fileMeta ?? null),
        slotMeta: Array.from({ length: ASSET_SLOTS }, (_, i) => cloneMeta(d.slotMeta?.[i] ?? null)),
        isPlaying: d.isPlaying ?? false,
        // ⚠ `?? true`, NOT `?? false`. LOOP is ON by default for this module
        // (`VideoVarispeedCard` read `data.loop ?? true`), and getting the
        // fallback wrong makes a FRESH node behave as ONE-SHOT: the transport
        // reaches the window END, latches `oneShotEnded`, and PAUSES the
        // element — so the engine stops uploading frames and the picture
        // freezes. MEASURED: `videovarispeed-switch.spec.ts` failed with
        // "engine frame uploads must climb after the switch (was 38)" and the
        // reverse-scrub leg of `videovarispeed-output.spec.ts` saw a single
        // distinct position, while both PASS on main. A default that differs
        // between the old owner and the new one is invisible until the node is
        // in the state nobody sets explicitly — which is every fresh node.
        loop: d.loop ?? VARISPEED_DEFAULT_LOOP,
        crop: cropState.active ? cropState.rect : null,
      };
    },
    writePlaying(nodeId, next) {
      ydoc.transact(() => {
        const t = patch.nodes[nodeId];
        if (!t) return;
        if (!t.data) t.data = {};
        (t.data as VarispeedData).isPlaying = next;
      }, LOCAL_ORIGIN);
    },
    writeLoop(nodeId, next) {
      ydoc.transact(() => {
        const t = patch.nodes[nodeId];
        if (!t) return;
        if (!t.data) t.data = {};
        (t.data as VarispeedData).loop = next;
      }, LOCAL_ORIGIN);
    },
    writeFileMeta(nodeId, meta) {
      // Drop a stale remembered handle in THIS browser's IDB when the id
      // changes (a fresh pick); a reload reuses the same id, so no churn there.
      const prevId = (patch.nodes[nodeId]?.data as VarispeedData | undefined)?.fileMeta?.handleId;
      if (prevId && prevId !== meta.handleId) void deleteVideoFileHandle(prevId);
      ydoc.transact(() => {
        const t = patch.nodes[nodeId];
        if (!t) return;
        if (!t.data) t.data = {};
        // ⚠ DELIBERATELY NOT resetting `isPlaying`. It used to, which was an
        // independent cause of "it stopped playing": the handle-reload path
        // runs through here, so a node that restored its own file came back
        // PAUSED even when the synced state said it was playing.
        (t.data as VarispeedData).fileMeta = { ...meta };
      }, LOCAL_ORIGIN);
    },
    writeSlotMeta(nodeId, slot, meta) {
      // ⚠ REBUILD FROM PLAIN CLONES. Reading back a previously-written entry
      // yields a LIVE Y type (already integrated into the doc); putting it in
      // the new array and reassigning throws "reassigning object that already
      // occurs in the tree" and aborts the transaction — before which every
      // slot AFTER the first silently failed to persist (only slot 0 saved).
      ydoc.transact(() => {
        const t = patch.nodes[nodeId];
        if (!t) return;
        if (!t.data) t.data = {};
        const d = t.data as VarispeedData;
        const cur = Array.isArray(d.slotMeta) ? d.slotMeta : [];
        const arr: (VideoboxFileMeta | null)[] = [];
        for (let i = 0; i < ASSET_SLOTS; i++) {
          arr.push(i === slot ? (meta ? { ...meta } : null) : cloneMeta(cur[i] ?? null));
        }
        d.slotMeta = arr;
      }, LOCAL_ORIGIN);
    },
    writeCrop(nodeId, active, rect) {
      ydoc.transact(() => {
        const t = patch.nodes[nodeId];
        if (!t) return;
        if (!t.data) t.data = {};
        (t.data as VarispeedData).crop = { active, x: rect.x, y: rect.y, w: rect.w };
      }, LOCAL_ORIGIN);
    },
  },
  media: {
    objectUrl: (nodeId, slot) => nodeMedia.objectUrl(nodeId, slot),
    setObjectUrl: (nodeId, slot, url, name) => { nodeMedia.setObjectUrl(nodeId, slot, url, name); },
    ensure: (nodeId, slot) =>
      nodeMedia.ensure(nodeId, slot, {
        kind: 'video',
        init: (el) => {
          const v = el as HTMLVideoElement;
          v.playsInline = true;
          // Slot 0 is the MAIN preview (audible); 1..6 are the hidden preloaded
          // pool and stay muted — exactly what the card's markup declared.
          const i = Number(slot.replace('slot', ''));
          if (i > 0) v.muted = true;
          v.setAttribute(
            'data-testid',
            i === 0 ? 'videovarispeed-video' : `videovarispeed-slot-video-${i}`,
          );
        },
      }),
    mediaName: (nodeId, slot) => nodeMedia.mediaName(nodeId, slot),
  },
  el: {
    currentTime: (el) => (el as HTMLVideoElement).currentTime,
    seek: (el, to) => { (el as HTMLVideoElement).currentTime = to; },
    paused: (el) => (el as HTMLVideoElement).paused,
    play: (el) => { void (el as HTMLVideoElement).play().catch(() => { /* autoplay */ }); },
    pause: (el) => { (el as HTMLVideoElement).pause(); },
    setMuted: (el, m) => { (el as HTMLVideoElement).muted = m; },
    setPlaybackRate: (el, r) => { (el as HTMLVideoElement).playbackRate = r; },
    playbackRate: (el) => (el as HTMLVideoElement).playbackRate,
    duration: (el) => {
      const d = (el as HTMLVideoElement).duration;
      return Number.isFinite(d) ? d : 0;
    },
    setSrc: (el, url) => { (el as HTMLVideoElement).src = url; },
    clearSrc: (el) => {
      const v = el as HTMLVideoElement;
      v.removeAttribute('src');
      v.load();
    },
    awaitMetadata: (el) =>
      new Promise<void>((resolve) => {
        const v = el as HTMLVideoElement;
        if (v.readyState >= 1 /* HAVE_METADATA */) { resolve(); return; }
        v.addEventListener('loadedmetadata', () => resolve(), { once: true });
      }),
  },
  createObjectUrl: (file) => URL.createObjectURL(file),
  registerExport: (nodeId, resolve) => { registerVideoExport(nodeId, resolve); },
  unregisterExport: (nodeId) => { unregisterVideoExport(nodeId); },
  fetchBytes: async (url) => {
    const resp = await fetch(url);
    return new Uint8Array(await (await resp.blob()).arrayBuffer());
  },
  clock: {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  },
  frames: {
    // ⚠ rAF, NOT an interval, and the distinction is the transport's whole
    // character: forward playback writes `playbackRate` and lets the element
    // advance itself, while REVERSE scrubs `currentTime` on a ~10 Hz throttle
    // derived from elapsed frame time. Driving that from a fixed interval would
    // re-time the scrub against a clock the renderer does not share.
    start(tick) {
      let handle = 0;
      const loop = (nowMs: number): void => {
        handle = requestAnimationFrame(loop);
        tick(nowMs);
      };
      handle = requestAnimationFrame(loop);
      return { get id() { return handle; } };
    },
    stop(h) {
      const holder = h as { id: number } | null;
      if (holder) cancelAnimationFrame(holder.id);
    },
  },
  onStatus: (nodeId, status) => { statuses[nodeId] = status; },
}, handleHooks);

/**
 * The process-wide node-owned varispeed registry.
 *
 * `sync` runs from `Canvas.svelte`'s graph effect and `sweep` from the same
 * effect that already retires `nodeMedia` — so a controller's lifetime is the
 * NODE's, with no card involved at any point.
 */
export const nodeVarispeed = {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void {
    registry.sync(nodes, adaptEngine(engine));
  },
  view(nodeId: string): VarispeedStatus {
    return statuses[nodeId] ?? NO_VARISPEED;
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
} satisfies Omit<NodeVarispeedRegistry, 'sync'> & {
  sync(nodes: readonly ModuleNode[], engine: PatchEngine | null): void;
};

/**
 * E2E hook: read a node's live slot state.
 *
 * ⚠ REGISTERED FROM THE SINGLETON, NOT FROM THE CARD, and the move is the point.
 * The card used to register a per-node reader closure in its own `$effect`, so
 * the hook returned NULL whenever no card was mounted — which is precisely the
 * condition `node-source-videovarispeed.spec.ts` has to observe. A probe that
 * cannot see the state under test is not a probe.
 */
if (typeof window !== 'undefined') {
  (window as unknown as {
    __vvsVirtualPlayhead?: (nodeId: string) => { activeSlot: number; slotPos: number[] } | null;
  }).__vvsVirtualPlayhead = (nodeId: string) => {
    const row = registry.snapshot().find((r) => r.nodeId === nodeId);
    return row ? { activeSlot: row.activeSlot, slotPos: [...row.slotPos] } : null;
  };
}

/**
 * One-click "re-allow <name>" for the SLOT-0 remembered handle.
 *
 * ⚠ THIS CANNOT LIVE IN THE CONTROLLER, and the reason is the browser's, not a
 * layering preference: `requestPermission()` is honoured only INSIDE a real
 * user gesture. The controller can discover that a handle's permission lapsed
 * and publish its NAME (`status.pendingHandleName`); performing the re-grant is
 * necessarily a surface's job. Mirrors `reAllowVideoHandle` exactly.
 */
export async function reAllowVarispeedHandle(nodeId: string): Promise<boolean> {
  const meta = (patch.nodes[nodeId]?.data as VarispeedData | undefined)?.fileMeta ?? null;
  const handleId = meta?.handleId;
  if (!handleId) return false;
  const handle = await getVideoFileHandle(handleId);
  if (!handle) return false;
  const perm = await requestHandleReadPermission(handle);
  if (perm !== 'granted') return false;
  try {
    const file = await handle.getFile();
    return nodeVarispeed.request(nodeId, {
      kind: 'loadFile',
      slot: 0,
      file,
      handle,
      reuseHandleId: handleId,
    }).delivered;
  } catch {
    return false;
  }
}

export { varispeedSlotKey };
