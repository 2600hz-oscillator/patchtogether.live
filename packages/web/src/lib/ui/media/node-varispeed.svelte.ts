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
import { nodeMedia } from './node-media-registry';
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
}

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
      const outAspect =
        videoAspectStore.engineRes.height > 0
          ? videoAspectStore.engineRes.width / videoAspectStore.engineRes.height
          : 4 / 3;
      const cropState = readCrop(t as unknown as GraphNode, outAspect, outAspect);
      return {
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
  },
  media: {
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
});

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

export { varispeedSlotKey };
