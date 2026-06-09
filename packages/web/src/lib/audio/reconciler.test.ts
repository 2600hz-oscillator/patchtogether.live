// B3 — reconciler determinism test. Uses a fake DomainEngine that records
// the order of operations rather than touching Web Audio. The point is to
// prove that two patches with identical end-states produce identical
// engine call sequences regardless of insertion order.

import { describe, it, expect, beforeEach } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { PatchEngine, type DomainEngine } from './engine';
import { attachReconciler } from './reconciler';
import { createSnapshotBus } from '$lib/graph/snapshot';
import type { ModuleNode, Edge } from '$lib/graph/types';

type PatchStore = { nodes: Record<string, ModuleNode>; edges: Record<string, Edge> };

class RecordingEngine implements DomainEngine {
  domain = 'audio' as const;
  ops: string[] = [];
  async addNode(n: ModuleNode): Promise<void> {
    this.ops.push(`addNode ${n.id}`);
  }
  removeNode(id: string): void {
    this.ops.push(`removeNode ${id}`);
  }
  addEdge(e: Edge): void {
    this.ops.push(`addEdge ${e.id}`);
  }
  removeEdge(id: string): void {
    this.ops.push(`removeEdge ${id}`);
  }
  setParam(id: string, p: string, v: number): void {
    this.ops.push(`setParam ${id}.${p}=${v}`);
  }
  readParam(): undefined {
    return undefined;
  }
  read(): unknown {
    return undefined;
  }
  dispose(): void {
    /* no-op */
  }
}

function freshPatch() {
  const patch = syncedStore<PatchStore>({ nodes: {}, edges: {} });
  const ydoc = getYjsDoc(patch);
  return { patch, ydoc };
}

function makePatchEngine(): { pe: PatchEngine; rec: RecordingEngine } {
  const pe = new PatchEngine();
  const rec = new RecordingEngine();
  pe.registerDomain(rec);
  return { pe, rec };
}

function n(id: string, type = 'analogVco'): ModuleNode {
  return { id, type, domain: 'audio', position: { x: 0, y: 0 }, params: {} };
}

function e(id: string, src: string, dst: string): Edge {
  return {
    id,
    source: { nodeId: src, portId: 'out' },
    target: { nodeId: dst, portId: 'in' },
    sourceType: 'audio',
    targetType: 'audio',
  };
}

async function flushMicrotasks(): Promise<void> {
  // The reconciler schedules via queueMicrotask + chains through inFlight.
  // A pair of awaits is enough to drain both layers.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('reconciler — determinism (B3)', () => {
  let A: ReturnType<typeof freshPatch>;
  let B: ReturnType<typeof freshPatch>;
  let busA: ReturnType<typeof createSnapshotBus>;
  let busB: ReturnType<typeof createSnapshotBus>;
  let recA: RecordingEngine;
  let recB: RecordingEngine;
  let handleA: ReturnType<typeof attachReconciler>;
  let handleB: ReturnType<typeof attachReconciler>;

  beforeEach(() => {
    A = freshPatch();
    B = freshPatch();
    busA = createSnapshotBus({ patch: A.patch as never, ydoc: A.ydoc });
    busB = createSnapshotBus({ patch: B.patch as never, ydoc: B.ydoc });
    const peA = makePatchEngine();
    const peB = makePatchEngine();
    recA = peA.rec;
    recB = peB.rec;
    handleA = attachReconciler(peA.pe, { bus: busA });
    handleB = attachReconciler(peB.pe, { bus: busB });
  });

  it('produces identical engine call sequences for identical end-states (different insert order)', async () => {
    A.ydoc.transact(() => {
      A.patch.nodes['c'] = n('c');
      A.patch.nodes['a'] = n('a');
      A.patch.nodes['b'] = n('b');
      A.patch.edges['e-2'] = e('e-2', 'a', 'b');
      A.patch.edges['e-1'] = e('e-1', 'a', 'c');
    });

    B.ydoc.transact(() => {
      B.patch.nodes['a'] = n('a');
      B.patch.nodes['b'] = n('b');
      B.patch.nodes['c'] = n('c');
      B.patch.edges['e-1'] = e('e-1', 'a', 'c');
      B.patch.edges['e-2'] = e('e-2', 'a', 'b');
    });

    await flushMicrotasks();
    await handleA.reconcile();
    await handleB.reconcile();

    expect(recA.ops).toEqual(recB.ops);
    // Sanity: confirm sort order is genuinely id-ascending.
    expect(recA.ops).toContain('addNode a');
    const idxA = recA.ops.indexOf('addNode a');
    const idxB = recA.ops.indexOf('addNode b');
    const idxC = recA.ops.indexOf('addNode c');
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  it('clear+add (the bug) produces identical ops on both clients', async () => {
    // Pre-state: stale leftover.
    for (const p of [A, B]) {
      p.ydoc.transact(() => {
        p.patch.nodes['leftover'] = n('leftover');
      });
    }
    await flushMicrotasks();
    await handleA.reconcile();
    await handleB.reconcile();
    recA.ops.length = 0;
    recB.ops.length = 0;

    // Clear in two transacts on each side, then load-example with reverse order.
    A.ydoc.transact(() => {
      delete A.patch.nodes['leftover'];
    });
    A.ydoc.transact(() => {
      A.patch.nodes['vd-out'] = n('vd-out');
      A.patch.nodes['vd-vca'] = n('vd-vca');
      A.patch.nodes['vd-vco'] = n('vd-vco');
      A.patch.edges['e-vd-vca-vd-out'] = e('e-vd-vca-vd-out', 'vd-vca', 'vd-out');
      A.patch.edges['e-vd-vco-vd-vca'] = e('e-vd-vco-vd-vca', 'vd-vco', 'vd-vca');
    });

    B.ydoc.transact(() => {
      delete B.patch.nodes['leftover'];
    });
    B.ydoc.transact(() => {
      B.patch.nodes['vd-vco'] = n('vd-vco');
      B.patch.nodes['vd-out'] = n('vd-out');
      B.patch.nodes['vd-vca'] = n('vd-vca');
      B.patch.edges['e-vd-vco-vd-vca'] = e('e-vd-vco-vd-vca', 'vd-vco', 'vd-vca');
      B.patch.edges['e-vd-vca-vd-out'] = e('e-vd-vca-vd-out', 'vd-vca', 'vd-out');
    });

    await flushMicrotasks();
    await handleA.reconcile();
    await handleB.reconcile();

    expect(recA.ops).toEqual(recB.ops);
  });

  it('skips meta-domain nodes (no engine binding)', async () => {
    A.ydoc.transact(() => {
      A.patch.nodes['st-1'] = {
        id: 'st-1',
        type: 'sticky',
        domain: 'meta',
        position: { x: 0, y: 0 },
        params: {},
        data: { text: 'hello' },
      };
      A.patch.nodes['v-1'] = n('v-1', 'analogVco');
    });
    await flushMicrotasks();
    await handleA.reconcile();
    // Engine receives the audio node but NOT the sticky.
    expect(recA.ops).toContain('addNode v-1');
    expect(recA.ops).not.toContain('addNode st-1');

    // Updating the sticky's data does not produce engine ops.
    recA.ops.length = 0;
    A.ydoc.transact(() => {
      const target = A.patch.nodes['st-1']!;
      if (!target.data) target.data = {};
      target.data.text = 'updated';
    });
    await flushMicrotasks();
    await handleA.reconcile();
    expect(recA.ops).toEqual([]);
  });

  it('a single throwing addEdge does NOT abort the rest of the pass (Phase 4d)', async () => {
    // Real-world repro: an aged/hand-edited import carries one structurally
    // bad edge. engine.addEdge THROWS on it. Before Phase 4d the throw
    // propagated out of doReconcile and was swallowed at the pass level, so
    // EVERY edge + param ordered after the bad one silently never applied.
    // After the fix the bad edge is logged + skipped and the pass completes.

    // An engine whose addEdge throws for one specific edge id, records the rest.
    class OneBadEdgeEngine extends RecordingEngine {
      badId: string;
      constructor(badId: string) {
        super();
        this.badId = badId;
      }
      addEdge(e: Edge): void {
        if (e.id === this.badId) {
          throw new Error(`AudioEngine.addEdge: no target port on ${e.target.nodeId}`);
        }
        super.addEdge(e);
      }
    }

    const pe = new PatchEngine();
    const rec = new OneBadEdgeEngine('e-bad');
    pe.registerDomain(rec);
    const bus = createSnapshotBus({ patch: A.patch as never, ydoc: A.ydoc });
    const handle = attachReconciler(pe, { bus });

    // Pass 1: materialize the nodes only (params at their initial values), so
    // they're in appliedNodes and the NEXT pass's step 5 sees genuine param
    // CHANGES (step 5 only fires setParam when prev != current).
    A.ydoc.transact(() => {
      A.patch.nodes['a'] = n('a');
      A.patch.nodes['b'] = n('b');
      A.patch.nodes['c'] = n('c');
    });
    await flushMicrotasks();
    await handle.reconcile();
    rec.ops.length = 0;

    // Pass 2: add three edges (the BAD one sorts in the MIDDLE) AND change a
    // param. The throwing edge (step 4) must NOT abort the param pass (step 5)
    // nor the good edge ordered after it.
    A.ydoc.transact(() => {
      A.patch.edges['e-good-1'] = e('e-good-1', 'a', 'b');
      A.patch.edges['e-bad'] = e('e-bad', 'a', 'c');
      A.patch.edges['e-good-2'] = e('e-good-2', 'b', 'c');
      A.patch.nodes['a']!.params = { tune: 5 };
    });

    await flushMicrotasks();
    await handle.reconcile();

    // The two GOOD edges both applied — including the one AFTER the bad edge.
    expect(rec.ops).toContain('addEdge e-good-1');
    expect(rec.ops).toContain('addEdge e-good-2');
    // The bad edge was NOT recorded (its addEdge threw before super.addEdge).
    expect(rec.ops).not.toContain('addEdge e-bad');
    // The param pass (step 5) still ran AFTER the throwing edge — the proof the
    // whole pass wasn't aborted.
    expect(rec.ops).toContain('setParam a.tune=5');

    // And it doesn't re-throw / re-attempt the bad edge every subsequent pass.
    rec.ops.length = 0;
    await handle.reconcile();
    expect(rec.ops).not.toContain('addEdge e-bad');

    handle.dispose();
  });

  it('removed-edges run before removed-nodes, both sorted by id', async () => {
    A.ydoc.transact(() => {
      A.patch.nodes['x'] = n('x');
      A.patch.nodes['y'] = n('y');
      A.patch.edges['e-z'] = e('e-z', 'x', 'y');
      A.patch.edges['e-a'] = e('e-a', 'x', 'y');
    });
    await flushMicrotasks();
    await handleA.reconcile();
    recA.ops.length = 0;

    A.ydoc.transact(() => {
      delete A.patch.edges['e-z'];
      delete A.patch.edges['e-a'];
      delete A.patch.nodes['y'];
      delete A.patch.nodes['x'];
    });
    await flushMicrotasks();
    await handleA.reconcile();

    expect(recA.ops).toEqual([
      'removeEdge e-a',
      'removeEdge e-z',
      'removeNode x',
      'removeNode y',
    ]);
  });
});
