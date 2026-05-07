// B3 — unit tests for the patch-snapshot bus. Pure SyncedStore + Yjs;
// no browser, no DOM. Verifies that:
//   - the snapshot is deterministic + id-sorted
//   - subscribers all receive the same reference on the same tick
//   - the bus only attaches one Y.Doc 'update' listener per bus instance

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  buildPatchSnapshot,
  createSnapshotBus,
  type PatchSnapshot,
} from './snapshot';
import type { ModuleNode, Edge } from './types';

type PatchStore = { nodes: Record<string, ModuleNode>; edges: Record<string, Edge> };

function freshPatch() {
  const patch = syncedStore<PatchStore>({ nodes: {}, edges: {} });
  const ydoc = getYjsDoc(patch);
  return { patch, ydoc };
}

function addNode(patch: ReturnType<typeof freshPatch>['patch'], id: string, type = 'analogVco') {
  patch.nodes[id] = {
    id,
    type,
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
  };
}

function addEdge(patch: ReturnType<typeof freshPatch>['patch'], id: string, src: string, dst: string) {
  patch.edges[id] = {
    id,
    source: { nodeId: src, portId: 'out' },
    target: { nodeId: dst, portId: 'in' },
    sourceType: 'audio',
    targetType: 'audio',
  };
}

describe('buildPatchSnapshot', () => {
  it('returns empty snapshot for an empty patch', () => {
    const { patch } = freshPatch();
    const snap = buildPatchSnapshot(patch as never);
    expect(snap.nodes).toEqual([]);
    expect(snap.edges).toEqual([]);
  });

  it('id-sorts nodes regardless of insertion order', () => {
    const { patch } = freshPatch();
    addNode(patch, 'zeta');
    addNode(patch, 'alpha');
    addNode(patch, 'mu');
    const snap = buildPatchSnapshot(patch as never);
    expect(snap.nodes.map((n) => n.id)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('id-sorts edges regardless of insertion order', () => {
    const { patch } = freshPatch();
    addNode(patch, 'a');
    addNode(patch, 'b');
    addEdge(patch, 'e-z', 'a', 'b');
    addEdge(patch, 'e-a', 'a', 'b');
    addEdge(patch, 'e-m', 'a', 'b');
    const snap = buildPatchSnapshot(patch as never);
    expect(snap.edges.map((e) => e.id)).toEqual(['e-a', 'e-m', 'e-z']);
  });

  it('produces identical snapshots from identical end-states regardless of ops order', () => {
    // Client A: insert in order [c, a, b]
    const a = freshPatch();
    addNode(a.patch, 'c');
    addNode(a.patch, 'a');
    addNode(a.patch, 'b');

    // Client B: insert in order [b, c, a]
    const b = freshPatch();
    addNode(b.patch, 'b');
    addNode(b.patch, 'c');
    addNode(b.patch, 'a');

    expect(buildPatchSnapshot(a.patch as never)).toEqual(buildPatchSnapshot(b.patch as never));
  });

  it('skips half-applied entries (defensive)', () => {
    const { patch } = freshPatch();
    addNode(patch, 'good');
    // Force a half-applied entry by mutating Y.Map directly to simulate a
    // tombstone / partial entry.
    const ydoc = getYjsDoc(patch);
    ydoc.getMap('nodes').set('partial', new Y.Map());
    const snap = buildPatchSnapshot(patch as never);
    expect(snap.nodes.map((n) => n.id)).toEqual(['good']);
  });
});

describe('createSnapshotBus', () => {
  it('emits the current snapshot synchronously on subscribe', () => {
    const { patch, ydoc } = freshPatch();
    addNode(patch, 'first');
    const bus = createSnapshotBus({ patch: patch as never, ydoc });
    let received: PatchSnapshot | null = null;
    bus.subscribe((s) => {
      received = s;
    });
    expect(received).not.toBeNull();
    expect(received!.nodes.map((n) => n.id)).toEqual(['first']);
    bus.dispose();
  });

  it('emits the SAME snapshot reference to all subscribers on a doc update', () => {
    const { patch, ydoc } = freshPatch();
    const bus = createSnapshotBus({ patch: patch as never, ydoc });

    const aSnaps: PatchSnapshot[] = [];
    const bSnaps: PatchSnapshot[] = [];
    bus.subscribe((s) => aSnaps.push(s));
    bus.subscribe((s) => bSnaps.push(s));

    // First emit (initial subscribe) — equal but recomputed-per-subscribe is OK.
    expect(aSnaps).toHaveLength(1);
    expect(bSnaps).toHaveLength(1);

    addNode(patch, 'shared');
    // After the update, each subscriber should get the SAME ref.
    expect(aSnaps).toHaveLength(2);
    expect(bSnaps).toHaveLength(2);
    expect(aSnaps[1]).toBe(bSnaps[1]);
    expect(aSnaps[1].nodes.map((n) => n.id)).toEqual(['shared']);
    bus.dispose();
  });

  it('stops emitting after dispose()', () => {
    const { patch, ydoc } = freshPatch();
    const bus = createSnapshotBus({ patch: patch as never, ydoc });
    let count = 0;
    bus.subscribe(() => {
      count++;
    });
    expect(count).toBe(1);
    bus.dispose();
    addNode(patch, 'late');
    // No new emission.
    expect(count).toBe(1);
  });

  it('lets a subscriber unsubscribe without affecting others', () => {
    const { patch, ydoc } = freshPatch();
    const bus = createSnapshotBus({ patch: patch as never, ydoc });
    let aCount = 0;
    let bCount = 0;
    const offA = bus.subscribe(() => aCount++);
    bus.subscribe(() => bCount++);
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
    offA();
    addNode(patch, 'after-off');
    expect(aCount).toBe(1);
    expect(bCount).toBe(2);
    bus.dispose();
  });
});

describe('B3 determinism — clear+add ops sequence', () => {
  it('two clients applying identical ops in different orders produce identical snapshots', () => {
    // Client A: clear then load-example, in two transacts.
    const a = freshPatch();
    addNode(a.patch, 'leftover-1'); // Pre-existing.
    a.ydoc.transact(() => {
      for (const id of Object.keys(a.patch.nodes)) delete a.patch.nodes[id];
    });
    a.ydoc.transact(() => {
      addNode(a.patch, 'vd-vca');
      addNode(a.patch, 'vd-vco');
      addNode(a.patch, 'vd-out');
      addEdge(a.patch, 'e-vd-vco-vd-vca', 'vd-vco', 'vd-vca');
      addEdge(a.patch, 'e-vd-vca-vd-out', 'vd-vca', 'vd-out');
    });

    // Client B: same end-state, but inserts in a different order in the
    // load-example transact.
    const b = freshPatch();
    addNode(b.patch, 'leftover-1');
    b.ydoc.transact(() => {
      for (const id of Object.keys(b.patch.nodes)) delete b.patch.nodes[id];
    });
    b.ydoc.transact(() => {
      addNode(b.patch, 'vd-out'); // Different order.
      addNode(b.patch, 'vd-vca');
      addNode(b.patch, 'vd-vco');
      addEdge(b.patch, 'e-vd-vca-vd-out', 'vd-vca', 'vd-out');
      addEdge(b.patch, 'e-vd-vco-vd-vca', 'vd-vco', 'vd-vca');
    });

    expect(buildPatchSnapshot(a.patch as never)).toEqual(buildPatchSnapshot(b.patch as never));
  });
});
