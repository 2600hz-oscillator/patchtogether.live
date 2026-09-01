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
import type { CableType, Edge, ModuleNode, PortDef } from './types';
import { canConnect } from './types';
// ONE upstream walk, shared with the connect-time validators — see
// ./adopted-type for why it no longer lives in this file.
import { resolveEmittedType, type AdoptionGraph } from './adopted-type';
import {
  patch as defaultPatch,
  ydoc as defaultYdoc,
  onBindRackspace,
} from './store';
import { getModuleDef } from '$lib/audio/module-registry';
import { getVideoModuleDef } from '$lib/video/module-registry';
import { getMetaModuleDef } from '$lib/meta/module-registry';

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

/**
 * Incremental-rebuild memo (the per-commit-cascade fix, phase 2).
 *
 * When provided, `buildPatchSnapshot` REUSES the previous snapshot's entry
 * objects for every node/edge whose id is NOT in the dirty sets — so a
 * param write on one module produces a snapshot where every OTHER entry is
 * reference-identical to the previous snapshot. Downstream consumers
 * (Canvas flowNodes/flowEdges, the reconciler) get change detection by
 * identity for free.
 *
 * The dirty sets are fed by `observeDeep` on the two root Y.Maps (see
 * createSnapshotBus): a deep event's `path[0]` is the entry id for any
 * nested change (params/data/position/label), and a root-level event's
 * `changes.keys` covers add/remove/replace. Yjs fires deep observers
 * BEFORE the doc-level 'update' event inside the same transaction
 * cleanup, so the sets are complete when the bus recomputes (pinned by a
 * unit test — a yjs upgrade that reorders cleanup fails loudly).
 *
 * ALIASING CONTRACT: reused entries are shared across successive
 * snapshots. NOTHING may mutate a snapshot entry in place (the adopted-
 * type resolver is copy-on-write; a DEV-mode freeze trips any violation).
 */
export interface SnapshotMemo {
  prevNodesById: ReadonlyMap<string, ModuleNode>;
  prevEdgesById: ReadonlyMap<string, Edge>;
  dirtyNodeIds: ReadonlySet<string>;
  dirtyEdgeIds: ReadonlySet<string>;
  /** True on the first build / after a rebind — ignore the maps + sets. */
  fullRebuild: boolean;
}

export type PatchSnapshotListener = (snapshot: PatchSnapshot) => void;

/** Narrow def view the upstream-type resolver needs: the in/out port lists. */
interface PortsDef {
  inputs?: readonly PortDef[];
  outputs?: readonly PortDef[];
}

/** (type) => def lookup over all three registries. Mirrors persistence.ts's
 *  defLookup so the resolver sees audio + video + meta module ports. */
function lookupPortsDef(type: string): PortsDef | undefined {
  return (getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type)) as
    | PortsDef
    | undefined;
}

/**
 * TYPE-TRANSPARENT pass-through resolution (PortDef.adoptsUpstreamFrom).
 *
 * For each edge whose SOURCE output port declares `adoptsUpstreamFrom: <inId>`
 * (e.g. SCALER's `out` adopts `in`), re-derive the edge's `sourceType` from the
 * cable feeding the source node's named input — so a CV source upstream makes
 * the pass-through emit `cv` (not its declared `audio` fallback). This is what
 * lets the cross-domain video bridge read the scaled signal on the raw
 * tail-sample path instead of the RMS envelope-follower (the SCALER dead-knob
 * bug). Resolution is LIVE: re-run on every snapshot, so re-patching the
 * upstream re-types the output.
 *
 * Guards (each falls back to the declared output type):
 *   - no upstream edge feeding the named input → keep declared type.
 *   - the adopted type can't legally reach this edge's own target
 *     (canConnect false) → keep declared type, so we never manufacture an
 *     illegal cable (e.g. an audio source must still emit `audio`, not be
 *     coerced to `cv` into a `cv`-only target it can't drive).
 *   - chained pass-throughs resolve transitively (bounded depth) so
 *     SCALER → SCALER → video still carries the original source's type.
 *
 * Pure: takes the already-built edge list + a def lookup. COPY-ON-WRITE: a
 * type flip REPLACES the array slot with a fresh `{ ...e, sourceType }` copy
 * instead of mutating in place — snapshot entries may be reused (aliased) by
 * previous snapshots under the SnapshotMemo path, and an in-place write
 * would silently retype an already-emitted snapshot.
 *
 * ⚠ THE WALK ITSELF NOW LIVES IN `./adopted-type`. It used to be a closure in
 * here, which made this function the only thing in the tree that knew what a
 * pass-through emits — so the CONNECT-time validators judged SCALER's `out` on
 * its declared `audio`, refused every `cv` target, and the adoption never got
 * the chance to apply (the owner's "scaler's output wont patch to cv ins").
 * Both readers share one walk now; a second copy would drift, and a drifted
 * copy is exactly how "connectable" and "connected" come to disagree.
 */
function resolveAdoptedSourceTypes(
  edges: Edge[],
  resolveDef: (type: string) => PortsDef | undefined,
  nodeType: (nodeId: string) => string | undefined,
): void {
  const graph: AdoptionGraph = {
    resolveDef,
    nodeType,
    inboundEdge: (() => {
      // Index the single inbound edge per (node, input port), ONCE.
      const inbound = new Map<string, Edge>();
      for (const e of edges) inbound.set(`${e.target.nodeId}\u0000${e.target.portId}`, e);
      return (nodeId: string, portId: string) => inbound.get(`${nodeId}\u0000${portId}`);
    })(),
  };
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const srcDef = resolveDef(nodeType(e.source.nodeId) ?? '');
    const outPort = srcDef?.outputs?.find((p) => p.id === e.source.portId);
    if (!outPort?.adoptsUpstreamFrom) continue;
    const adopted = resolveEmittedType(e.source.nodeId, e.source.portId, graph);
    // Keep declared type if nothing upstream, or the adopted type can't
    // legally reach THIS edge's target (don't manufacture an illegal cable).
    if (!adopted || adopted === e.sourceType) continue;
    if (!canConnect(adopted, e.targetType)) continue;
    // Copy-on-write (never mutate — the entry may alias a prior snapshot).
    edges[i] = { ...e, sourceType: adopted };
  }
}

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
  /** Def lookup for the TYPE-TRANSPARENT pass-through resolution
   *  (PortDef.adoptsUpstreamFrom). Defaults to the live registry chain;
   *  injectable for unit tests (mirrors validate-edge's ResolveDef pattern). */
  resolveDef: (type: string) => PortsDef | undefined = lookupPortsDef,
  /** Optional incremental-rebuild memo (see SnapshotMemo). Absent → the
   *  legacy full rebuild (every entry a fresh copy). */
  memo?: SnapshotMemo,
): PatchSnapshot {
  const reuse = !!memo && !memo.fullRebuild;
  const nodes: ModuleNode[] = [];
  for (const [id, n] of Object.entries(patch.nodes)) {
    if (!n || !n.domain || !n.type) continue;
    if (reuse && !memo!.dirtyNodeIds.has(id)) {
      // Identity-stable path: nothing under nodes[id] changed since the
      // previous build — emit the SAME entry object. Deleted ids fall out
      // naturally (iteration is over the live map).
      const prev = memo!.prevNodesById.get(id);
      if (prev) {
        nodes.push(prev);
        continue;
      }
    }
    nodes.push({
      id: n.id ?? id,
      type: n.type,
      domain: n.domain,
      position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
      params: { ...(n.params ?? {}) },
      data: n.data,
    });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const nodeTypeById = new Map(nodes.map((n) => [n.id, n.type]));

  /** True when the edge's SOURCE output port declares adoptsUpstreamFrom —
   *  its resolved sourceType depends on OTHER edges (an upstream re-patch
   *  can flip it, and an un-patch must revert it to the declared type), so
   *  it can never be identity-reused: it is rebuilt fresh from the store
   *  and re-resolved every snapshot, exactly like the pre-memo behavior. */
  function sourcePortAdopts(e: { source: { nodeId: string; portId: string } }): boolean {
    const def = resolveDef(nodeTypeById.get(e.source.nodeId) ?? '');
    const outPort = def?.outputs?.find((p) => p.id === e.source.portId);
    return !!outPort?.adoptsUpstreamFrom;
  }

  const edges: Edge[] = [];
  for (const [id, e] of Object.entries(patch.edges)) {
    if (!e || !e.source || !e.target) continue;
    if (reuse && !memo!.dirtyEdgeIds.has(id)) {
      const prev = memo!.prevEdgesById.get(id);
      if (prev && !sourcePortAdopts(prev)) {
        edges.push(prev);
        continue;
      }
    }
    edges.push({
      id: e.id ?? id,
      source: { nodeId: e.source.nodeId, portId: e.source.portId },
      target: { nodeId: e.target.nodeId, portId: e.target.portId },
      sourceType: e.sourceType ?? 'audio',
      targetType: e.targetType ?? 'audio',
    });
  }
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // TYPE-TRANSPARENT pass-through: rewrite sourceType for adoptsUpstreamFrom
  // outputs (SCALER's `out` adopts `in`) so a scaled CV stays CV through the
  // cross-domain video bridge (otherwise it hits the RMS follower → dead
  // AMOUNT knob). Done AFTER the build so the resolver sees the full edge set.
  resolveAdoptedSourceTypes(edges, resolveDef, (id) => nodeTypeById.get(id));

  // DEV-mode aliasing tripwire (memo path only — that's where entries are
  // shared across snapshots): any consumer mutating an entry in place now
  // throws in strict mode instead of silently corrupting older snapshots.
  // `data` stays unfrozen — it is the LIVE SyncedStore proxy by design.
  if (memo && import.meta.env.DEV) {
    for (const n of nodes) {
      Object.freeze(n.position);
      Object.freeze(n.params);
      Object.freeze(n);
    }
    for (const e of edges) Object.freeze(e);
  }

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

  // ── Incremental-rebuild memo (see SnapshotMemo) ──
  //
  // Deep observers on the two root Y.Maps collect DIRTY entry ids per
  // transaction. Yjs invokes deep observers during transaction cleanup
  // BEFORE it emits the doc-level 'update' event (pinned by a unit test),
  // so by the time onUpdate → emit() → recompute() runs, the sets are
  // complete for that transaction. recompute() consumes + clears them.
  let prevNodesById = new Map<string, ModuleNode>();
  let prevEdgesById = new Map<string, Edge>();
  let dirtyNodeIds = new Set<string>();
  let dirtyEdgeIds = new Set<string>();
  let fullRebuild = true;

  function collectDirtyIds(
    events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
    into: Set<string>,
  ): void {
    for (const ev of events) {
      if (ev.path.length === 0) {
        // Root-level map event: entry add / replace / delete.
        for (const key of ev.changes.keys.keys()) into.add(key);
      } else {
        // Nested change anywhere under an entry (params / data / position /
        // a sequencer steps-key reassign under a stable data ref, …):
        // path[0] is the entry id.
        into.add(String(ev.path[0]));
      }
    }
  }
  const onNodesDeep = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): void => {
    collectDirtyIds(events, dirtyNodeIds);
  };
  const onEdgesDeep = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): void => {
    collectDirtyIds(events, dirtyEdgeIds);
  };

  function attachDeepObservers(d: Y.Doc): void {
    d.getMap('nodes').observeDeep(onNodesDeep);
    d.getMap('edges').observeDeep(onEdgesDeep);
  }
  function detachDeepObservers(d: Y.Doc): void {
    try {
      d.getMap('nodes').unobserveDeep(onNodesDeep);
      d.getMap('edges').unobserveDeep(onEdgesDeep);
    } catch {
      /* old doc may be destroyed */
    }
  }

  function recompute(): void {
    cached = buildPatchSnapshot(patch, undefined, {
      prevNodesById,
      prevEdgesById,
      dirtyNodeIds,
      dirtyEdgeIds,
      fullRebuild,
    });
    // The freshly-emitted entries become the reuse pool for the next build.
    const nextNodes = new Map<string, ModuleNode>();
    for (const n of cached.nodes) nextNodes.set(n.id, n);
    const nextEdges = new Map<string, Edge>();
    for (const e of cached.edges) nextEdges.set(e.id, e);
    prevNodesById = nextNodes;
    prevEdgesById = nextEdges;
    dirtyNodeIds = new Set();
    dirtyEdgeIds = new Set();
    fullRebuild = false;
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
  attachDeepObservers(doc);

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
      detachDeepObservers(doc);
      patch = nextPatch;
      doc = nextDoc;
      doc.on('update', onUpdate);
      attachDeepObservers(doc);
      // The memo belongs to the OLD doc's entries — drop it entirely so the
      // first build against the new doc is a full rebuild (never resurrect
      // a previous rackspace's entries by id collision).
      prevNodesById = new Map();
      prevEdgesById = new Map();
      dirtyNodeIds = new Set();
      dirtyEdgeIds = new Set();
      fullRebuild = true;
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
      detachDeepObservers(doc);
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
