// packages/web/src/lib/audio/reconciler.ts
//
// Auto-reactive reconciler. Subscribes to the shared PatchSnapshot bus
// (`$lib/graph/snapshot`) and diffs the current snapshot against what the
// engine currently has materialized. Applies adds/removes/param-changes
// per pass.
//
// B3 (May 2026) — moved off `doc.on('update')` and `patchStore.nodes`
// direct reads to the snapshot bus, sharing one subscription with the
// Svelte UI. Both consumers see the same id-sorted ordering, eliminating
// the "heard but didn't see" divergence between two browser windows.
//
// Within-pass ordering is now id-sorted at every bucket (removed-edges,
// removed-nodes, added-nodes, added-edges, params) so two clients
// applying identical Yjs ops drive engine.addNode in identical order
// — the deterministic tiebreak that B3 calls for.

import type { Edge, ModuleNode } from '$lib/graph/types';
import type { PatchEngine } from './engine';
import {
  getDefaultSnapshotBus,
  type PatchSnapshot,
} from '$lib/graph/snapshot';
import { projectGroups } from '$lib/graph/group-projection';

interface ReconcilerHandle {
  /** Run a reconcile pass immediately against the current snapshot. */
  reconcile(): Promise<void>;
  /** Detach. */
  dispose(): void;
}

interface AttachOpts {
  /** Override the default snapshot bus. Tests use this to pass a doc-scoped bus. */
  bus?: ReturnType<typeof getDefaultSnapshotBus>;
}

export function attachReconciler(
  engine: PatchEngine,
  opts: AttachOpts = {},
): ReconcilerHandle {
  const bus = opts.bus ?? getDefaultSnapshotBus();

  const appliedNodes = new Map<string, ModuleNode>();
  const appliedEdges = new Map<string, Edge>();

  let latest: PatchSnapshot = bus.current();
  let scheduled = false;
  let inFlight: Promise<void> = Promise.resolve();

  function enqueue(): Promise<void> {
    const next = inFlight.then(() => doReconcile(latest));
    inFlight = next.catch((err) => {
      console.error('[reconciler] reconcile failed:', err);
    });
    return next;
  }

  async function doReconcile(rawSnap: PatchSnapshot): Promise<void> {
    // Module-grouping Phase 1 — project the snapshot through any GROUP!
    // nodes BEFORE the reconciler reads it. Edge endpoints that name a
    // group's exposed port are rewritten to point at the real child port,
    // so the engine never knows groups exist. Empty fast-path: when no
    // group nodes are present, projectGroups returns the snapshot
    // unchanged (same reference) → zero overhead for the common case.
    const snap = projectGroups(rawSnap);

    // Meta-domain nodes (e.g. STICKY notes, GROUP! collapses) are pure-UI
    // cards with no engine binding. Filter them out of every map this
    // reconciler builds so PatchEngine.addNode + setParam never see them
    // — there's no DomainEngine registered for 'meta' and the dispatch
    // would throw. Edges referencing meta nodes are dropped too; the type
    // system already forbids cables to/from sticky (no ports), and
    // projectGroups has already rewritten edges to/from groups.
    const isMeta = (n: ModuleNode): boolean => n.domain === 'meta';
    const currentNodes = new Map<string, ModuleNode>();
    for (const n of snap.nodes) {
      if (isMeta(n)) continue;
      currentNodes.set(n.id, n);
    }
    const currentEdges = new Map<string, Edge>();
    for (const e of snap.edges) currentEdges.set(e.id, e);

    // Within-pass id-sorted iteration so two clients run identical ops in
    // identical order. The snapshot is already sorted, but applied* maps
    // are insertion-order; we explicitly sort the key sets we iterate.

    // Helper: pick an edge's transport domain from its source node's
    // domain. The source's engine owns the routing primitives. The first
    // generation of this code hardcoded 'audio'; the Phase-0 video spike
    // (.myrobots/plans/video-modules-mvp.md §1) introduces a second
    // domain so we now look it up. Cross-domain edges (e.g. audio CV
    // feeding a video module's param input) keep the source-side dispatch
    // — the bridge module on the audio side handles the rate conversion.
    function edgeDomain(edge: Edge): string {
      const sourceNode = currentNodes.get(edge.source.nodeId)
        ?? appliedNodes.get(edge.source.nodeId);
      return sourceNode?.domain ?? 'audio';
    }

    /** Target node's domain. Mirrors edgeDomain but for the destination
     *  endpoint. PatchEngine.addEdge uses this to detect cross-domain
     *  cv → video param bridges. */
    function edgeTargetDomain(edge: Edge): string {
      const targetNode = currentNodes.get(edge.target.nodeId)
        ?? appliedNodes.get(edge.target.nodeId);
      return targetNode?.domain ?? 'audio';
    }

    // 1. Removed edges first (release node references).
    const removedEdgeIds = [...appliedEdges.keys()]
      .filter((id) => !currentEdges.has(id))
      .sort();
    for (const id of removedEdgeIds) {
      const prev = appliedEdges.get(id)!;
      engine.removeEdge(prev, edgeDomain(prev));
      appliedEdges.delete(id);
    }

    // 2. Removed nodes.
    const removedNodeIds = [...appliedNodes.keys()]
      .filter((id) => !currentNodes.has(id))
      .sort();
    for (const id of removedNodeIds) {
      const prev = appliedNodes.get(id)!;
      engine.removeNode(prev);
      appliedNodes.delete(id);
    }

    // 3. Added nodes (await — async factories). Snapshot is sorted; we
    // iterate it directly, skipping ids we already have AND any meta-
    // domain nodes (which carry no engine binding).
    for (const node of snap.nodes) {
      if (isMeta(node)) continue;
      if (appliedNodes.has(node.id)) continue;
      await engine.addNode(node);
      appliedNodes.set(node.id, snapshotNode(node));
    }

    // 4. Added edges. Skip edges whose source or target is a meta node —
    // sticky notes have no ports so legitimate edges never reference
    // them, but defending against corrupt envelopes keeps the reconciler
    // robust.
    for (const edge of snap.edges) {
      if (appliedEdges.has(edge.id)) continue;
      const src = currentNodes.get(edge.source.nodeId);
      const dst = currentNodes.get(edge.target.nodeId);
      if (!src || !dst) continue;
      // engine.addEdge THROWS on a missing/mismatched port (a stale portId, an
      // output-as-target, an incompatible cable type). Without this guard, ONE
      // bad edge would abort the rest of THIS pass — every remaining edge AND
      // every param change below — and in multiuser that aborted pass replays
      // identically on every peer. Imports are now structurally validated
      // up-front (persistence.ts validateEdge drop-invalid), so a throw here is
      // belt-and-suspenders: log it, mark the edge applied so we don't retry it
      // every pass, and keep going so all the VALID work in the pass still lands.
      try {
        engine.addEdge(edge, edgeDomain(edge), edgeTargetDomain(edge));
      } catch (err) {
        console.warn(
          `[reconciler] skipping edge ${edge.id} (${edge.source.nodeId}.${edge.source.portId} → ${edge.target.nodeId}.${edge.target.portId}): ${(err as Error).message}`,
        );
      }
      appliedEdges.set(edge.id, { ...edge });
    }

    // 5. Param changes on existing nodes.
    for (const node of snap.nodes) {
      if (isMeta(node)) continue;
      const prev = appliedNodes.get(node.id);
      if (!prev) continue;
      const paramKeys = Object.keys(node.params).sort();
      for (const paramId of paramKeys) {
        const value = node.params[paramId];
        if (prev.params[paramId] !== value) {
          engine.setParam(node, paramId, value);
        }
      }
      appliedNodes.set(node.id, snapshotNode(node));
    }
  }

  function schedule(snap: PatchSnapshot) {
    latest = snap;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      enqueue().catch(() => {});
    });
  }

  // The bus calls our listener synchronously with the current snapshot
  // immediately, then again on each Yjs update. We schedule a microtask
  // reconcile each time; the inFlight chain serializes them.
  const unsubscribe = bus.subscribe((snap) => schedule(snap));

  return {
    reconcile: enqueue,
    dispose() {
      unsubscribe();
    },
  };
}

function snapshotNode(node: ModuleNode): ModuleNode {
  let dataCopy: Record<string, unknown> | undefined;
  if (node.data) {
    try {
      dataCopy = JSON.parse(JSON.stringify(node.data));
    } catch {
      dataCopy = undefined;
    }
  }
  return {
    id: node.id,
    type: node.type,
    domain: node.domain,
    position: { ...node.position },
    params: { ...node.params },
    data: dataCopy,
  };
}
