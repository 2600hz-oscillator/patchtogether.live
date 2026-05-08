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

  async function doReconcile(snap: PatchSnapshot): Promise<void> {
    const currentNodes = new Map<string, ModuleNode>();
    for (const n of snap.nodes) currentNodes.set(n.id, n);
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
    // iterate it directly, skipping ids we already have.
    for (const node of snap.nodes) {
      if (appliedNodes.has(node.id)) continue;
      await engine.addNode(node);
      appliedNodes.set(node.id, snapshotNode(node));
    }

    // 4. Added edges.
    for (const edge of snap.edges) {
      if (appliedEdges.has(edge.id)) continue;
      engine.addEdge(edge, edgeDomain(edge));
      appliedEdges.set(edge.id, { ...edge });
    }

    // 5. Param changes on existing nodes.
    for (const node of snap.nodes) {
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
