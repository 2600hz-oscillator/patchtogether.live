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
import { patch as defaultPatch, ydoc as defaultYdoc } from './store';

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
  /** Tear down the doc-update listener. Idempotent. */
  dispose(): void;
}

interface SubscribeOpts {
  patch?: LivePatch;
  ydoc?: Y.Doc;
}

let defaultBus: SnapshotBus | null = null;

/**
 * Get (or create on first call) the singleton snapshot bus for the default
 * patch + ydoc. The audio reconciler and the Svelte UI both attach here,
 * guaranteeing they observe a consistent ordering.
 */
export function getDefaultSnapshotBus(): SnapshotBus {
  if (!defaultBus) {
    defaultBus = createSnapshotBus({
      patch: defaultPatch as unknown as LivePatch,
      ydoc: defaultYdoc,
    });
  }
  return defaultBus;
}

/**
 * Create a fresh snapshot bus for a specific (patch, ydoc) pair. Useful
 * for tests where the global default isn't appropriate.
 */
export function createSnapshotBus(opts: SubscribeOpts = {}): SnapshotBus {
  const patch = opts.patch ?? (defaultPatch as unknown as LivePatch);
  const doc = opts.ydoc ?? defaultYdoc;

  let cached: PatchSnapshot | null = null;
  let listeners = new Set<PatchSnapshotListener>();
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      doc.off('update', onUpdate);
      listeners.clear();
      cached = null;
    },
  };
}

/** Reset the default singleton — TEST ONLY. */
export function __resetDefaultSnapshotBusForTest(): void {
  if (defaultBus) defaultBus.dispose();
  defaultBus = null;
}
