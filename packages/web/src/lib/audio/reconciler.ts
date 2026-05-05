// packages/web/src/lib/audio/reconciler.ts
//
// Auto-reactive reconciler. Subscribes to Yjs doc updates and diffs the
// current SyncedStore patch graph against a snapshot of what the engine
// currently has materialized. Applies adds/removes/param-changes per pass.
//
// Day 7 design — runs after each Yjs update, batched via microtask so a
// burst of mutations (e.g., adding 10 nodes via paste) collapses to one
// reconcile call.

import * as Y from 'yjs';
import type { Edge, ModuleNode } from '$lib/graph/types';
import type { PatchEngine } from './engine';
import { patch as patchStore, ydoc } from '$lib/graph/store';

interface ReconcilerHandle {
  /** Run a reconcile pass immediately. */
  reconcile(): Promise<void>;
  /** Detach. */
  dispose(): void;
}

export function attachReconciler(engine: PatchEngine, doc: Y.Doc = ydoc): ReconcilerHandle {
  // Cached snapshot of last-applied state, keyed by node/edge id.
  const appliedNodes = new Map<string, ModuleNode>();
  const appliedEdges = new Map<string, Edge>();

  let scheduled = false;
  let inFlight: Promise<void> = Promise.resolve();

  /** Run reconcile through the in-flight chain so concurrent callers serialize. */
  function enqueue(): Promise<void> {
    inFlight = inFlight.then(() => doReconcile()).catch((err) => {
      console.error('[reconciler] reconcile failed:', err);
      throw err;
    });
    return inFlight;
  }

  async function doReconcile(): Promise<void> {
    // Snapshot primitive fields at iteration time. Async work between filter
    // and engine.addNode would otherwise see undefined fields if the entry
    // was deleted/mutated mid-flight. We keep `data` as a live reference for
    // modules that need per-tick reads (e.g., Sequencer); when the patch
    // entry is deleted, the engine disposes the handle and the live read
    // stops via the handle's alive flag.
    const currentNodes = new Map<string, ModuleNode>();
    for (const [id, n] of Object.entries(patchStore.nodes)) {
      if (n && n.domain && n.type) {
        currentNodes.set(id, {
          id: n.id,
          type: n.type,
          domain: n.domain,
          position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
          params: { ...(n.params ?? {}) },
          data: n.data,
        });
      }
    }
    const currentEdges = new Map<string, Edge>();
    for (const [id, e] of Object.entries(patchStore.edges)) {
      if (e && e.source && e.target) {
        currentEdges.set(id, {
          id: e.id,
          source: { nodeId: e.source.nodeId, portId: e.source.portId },
          target: { nodeId: e.target.nodeId, portId: e.target.portId },
          sourceType: e.sourceType,
          targetType: e.targetType,
        });
      }
    }

    // 1. Removed edges first (release node references).
    for (const [id, prev] of appliedEdges) {
      if (!currentEdges.has(id)) {
        engine.removeEdge(prev, 'audio');
        appliedEdges.delete(id);
      }
    }

    // 2. Removed nodes.
    for (const [id, prev] of appliedNodes) {
      if (!currentNodes.has(id)) {
        engine.removeNode(prev);
        appliedNodes.delete(id);
      }
    }

    // 3. Added nodes (await — async factories).
    for (const [id, node] of currentNodes) {
      if (!appliedNodes.has(id)) {
        await engine.addNode(node);
        appliedNodes.set(id, snapshotNode(node));
      }
    }

    // 4. Added edges.
    for (const [id, edge] of currentEdges) {
      if (!appliedEdges.has(id)) {
        engine.addEdge(edge, 'audio');
        appliedEdges.set(id, { ...edge });
      }
    }

    // 5. Param changes on existing nodes.
    for (const [id, node] of currentNodes) {
      const prev = appliedNodes.get(id);
      if (!prev) continue;
      for (const [paramId, value] of Object.entries(node.params)) {
        if (prev.params[paramId] !== value) {
          engine.setParam(node, paramId, value);
        }
      }
      appliedNodes.set(id, snapshotNode(node));
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      // Quietly absorb errors here — the explicit reconcile() caller will
      // see them via its returned promise.
      enqueue().catch(() => {});
    });
  }

  doc.on('update', schedule);

  // Manual reconcile() also rides the same in-flight chain, so external
  // callers can't race against the auto-scheduled microtask reconcile.
  return {
    reconcile: enqueue,
    dispose() {
      doc.off('update', schedule);
    },
  };
}

function snapshotNode(node: ModuleNode): ModuleNode {
  // structuredClone fails on SyncedStore/Yjs proxies; JSON round-trip is
  // sufficient for our diff purposes (we only compare primitives).
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
