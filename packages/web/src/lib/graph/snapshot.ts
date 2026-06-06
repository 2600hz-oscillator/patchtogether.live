// packages/web/src/lib/graph/snapshot.ts
//
// B3 — single subscription point for the patch graph.
//
// Why this exists: we used to have two independent subscriptions to the
// same Yjs doc — one in the audio reconciler, one in the Svelte UI — each
// with its own scheduler. They could (and did) reach different conclusions
// about "what's in the graph right now" when ops arrived back-to-back
// (e.g. clear → load-example), producing the "heard but didn't see" bug
// reported across two browser windows.
//
// This module collapses both into one. Subscribers receive the SAME
// array references in the SAME deterministic (id-sorted) order on the
// same tick. Both the audio engine and the UI consume the snapshot;
// neither reads `patch.nodes` / `patch.edges` directly anymore for the
// purpose of "what should I render / materialize?".
//
// The snapshot is recomputed lazily — once per `ydoc.update` event,
// regardless of how many subscribers there are.

import * as Y from 'yjs';
import type { Edge, ModuleNode } from './types';
import {
  patch as defaultPatch,
  ydoc as defaultYdoc,
  onBindRackspace,
} from './store';

// SyncedStore proxies expose every entry as `Partial<T[key]>` (see
// MappedTypeDescription), but we don't depend on @syncedstore type
// internals directly — that subpath isn't an exported entrypoint. We
// accept the live patch store shape via its exported PatchStore alias
// and treat each entry as Partial<...> for defensive reads.
type LivePatch = {
  nodes: Record<string, Partial<ModuleNode> | undefined>;
  edges: Record<string, Partial<Edge> | undefined>;
};

export interface PatchSnapshot {
  /** Nodes sorted lexicographically by id. */
  nodes: ModuleNode[];
  /** Edges sorted lexicographically by id. */
  edges: Edge[];
}

export type PatchSnapshotListener = (snapshot: PatchSnapshot) => void;

/**
 * Build a deterministic snapshot from the live SyncedStore proxy.
 *
 * - Plain-object copies (no Yjs proxies escape).
 * - Both arrays sorted by id so two clients applying identical ops
 *   produce identical iteration order — the B3 tiebreak.
 * - Defensive: skips entries with missing required fields (transient
 *   state during deletion can briefly expose half-applied entries).
 */
export function buildPatchSnapshot(
  patch: LivePatch = defaultPatch as unknown as LivePatch,
): PatchSnapshot {
  const nodes: ModuleNode[] = [];
  for (const [id, n] of Object.entries(patch.nodes)) {
    if (!n || !n.domain || !n.type) continue;
    nodes.push({
      id: n.id ?? id,
      type: n.type,
      domain: n.domain,
      position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
      params: { ...(n.params ?? {}) },
      data: n.data,
    });
  }
  const edges: Edge[] = [];
  for (const [id, e] of Object.entries(patch.edges)) {
    if (!e || !e.source || !e.target) continue;
    edges.push({
      id: e.id ?? id,
      source: { nodeId: e.source.nodeId, portId: e.source.portId },
      target: { nodeId: e.target.nodeId, portId: e.target.portId },
      sourceType: e.sourceType ?? 'audio',
      targetType: e.targetType ?? 'audio',
    });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { nodes, edges };
}

interface SnapshotBus {
  /** Latest snapshot. Recomputed lazily on first read after an update. */
  current(): PatchSnapshot;
  /** Subscribe; receives the current snapshot synchronously then on every update. */
  subscribe(listener: PatchSnapshotListener): () => void;
  /**
   * Swap the underlying (patch, ydoc) pair WITHOUT dropping existing
   * subscribers. Used by `bindRackspace()` so that rebinding the
   * store's singleton trio re-points the bus at the new doc and every
   * subscriber (reconciler + Canvas UI) keeps receiving snapshots
   * against the live rackspace. Without this the singleton bus stayed
   * permanently attached to the FIRST rackspace's (now-destroyed) doc,
   * so no further updates ever reached the engine or canvas.
   *
   * Emits a fresh snapshot to all current subscribers as part of the
   * swap so they see the new doc's contents on the same tick.
   *
   * Idempotent for the same (patch, ydoc) pair — no-op if nothing
   * actually changed.
   */
  rebind(patch: LivePatch, ydoc: Y.Doc): void;
  /** Tear down the doc-update listener. Idempotent. */
  dispose(): void;
}

interface SubscribeOpts {
  patch?: LivePatch;
  ydoc?: Y.Doc;
}

let defaultBus: SnapshotBus | null = null;
let bindUnsubscribe: (() => void) | null = null;

/**
 * Get (or create on first call) the singleton snapshot bus for the default
 * patch + ydoc. The audio reconciler and the Svelte UI both attach here,
 * guaranteeing they observe a consistent ordering.
 *
 * On first creation, we register with the store's `onBindRackspace` event
 * so the bus rebinds to the fresh (patch, ydoc) pair every time a new
 * rackspace mounts. The store's rebinding singleton + this listener are
 * the two halves of "live import binding for the patch graph": without
 * the listener, the singleton bus would stay attached to the FIRST
 * rackspace's (now-destroyed) doc, and the reconciler + Canvas UI would
 * never see any subsequent update — which manifested as the @collab
 * `clear+load-multiwindow` regression after PR #432.
 */
export function getDefaultSnapshotBus(): SnapshotBus {
  if (!defaultBus) {
    defaultBus = createSnapshotBus({
      patch: defaultPatch as unknown as LivePatch,
      ydoc: defaultYdoc,
    });
    // Refresh the bus's (patch, ydoc) refs on every bindRackspace().
    // The unsubscribe is retained so __resetDefaultSnapshotBusForTest()
    // can detach it cleanly between test runs.
    bindUnsubscribe = onBindRackspace((nextPatch, nextYdoc) => {
      defaultBus?.rebind(nextPatch as unknown as LivePatch, nextYdoc);
    });
  }
  return defaultBus;
}

/**
 * Create a fresh snapshot bus for a specific (patch, ydoc) pair. Useful
 * for tests where the global default isn't appropriate.
 */
export function createSnapshotBus(opts: SubscribeOpts = {}): SnapshotBus {
  // Live refs — `rebind()` reassigns these so future emits read the new
  // doc + patch while preserving the existing listener set.
  let patch: LivePatch = opts.patch ?? (defaultPatch as unknown as LivePatch);
  let doc: Y.Doc = opts.ydoc ?? defaultYdoc;

  let cached: PatchSnapshot | null = null;
  const listeners = new Set<PatchSnapshotListener>();
  let disposed = false;

  function recompute(): void {
    cached = buildPatchSnapshot(patch);
  }

  function emit(): void {
    if (disposed) return;
    recompute();
    // Iterate a copy in case a listener unsubscribes mid-flight.
    for (const fn of [...listeners]) {
      try {
        fn(cached!);
      } catch (err) {
        console.error('[snapshot-bus] listener threw:', err);
      }
    }
  }

  // One subscription to Yjs for the whole app, regardless of subscriber count.
  const onUpdate = (): void => {
    emit();
  };
  doc.on('update', onUpdate);

  return {
    current(): PatchSnapshot {
      if (!cached) recompute();
      return cached!;
    },
    subscribe(listener: PatchSnapshotListener): () => void {
      listeners.add(listener);
      // Push the current snapshot so consumers don't need a separate
      // "warm me up" call after subscribe.
      try {
        listener(this.current());
      } catch (err) {
        console.error('[snapshot-bus] initial push threw:', err);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    rebind(nextPatch: LivePatch, nextDoc: Y.Doc): void {
      if (disposed) return;
      if (nextPatch === patch && nextDoc === doc) return;
      // Detach from the previous doc. Safe even if it was destroyed —
      // Y.Doc.off() is defensive against missing handlers.
      try {
        doc.off('update', onUpdate);
      } catch {
        /* ignore — old doc may be destroyed */
      }
      patch = nextPatch;
      doc = nextDoc;
      doc.on('update', onUpdate);
      // Invalidate the cached snapshot so the next `current()` recomputes
      // against the new patch — and emit immediately so existing
      // subscribers see the fresh state on this tick.
      cached = null;
      emit();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        doc.off('update', onUpdate);
      } catch {
        /* ignore */
      }
      listeners.clear();
      cached = null;
    },
  };
}

/** Reset the default singleton — TEST ONLY. */
export function __resetDefaultSnapshotBusForTest(): void {
  if (bindUnsubscribe) {
    bindUnsubscribe();
    bindUnsubscribe = null;
  }
  if (defaultBus) defaultBus.dispose();
  defaultBus = null;
}
