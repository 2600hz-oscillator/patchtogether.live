// packages/web/src/lib/graph/toybox-combine-ydoc.test.ts
//
// REAL-Y.Doc regression tests for the TOYBOX Phase-4 combine-graph mutators.
// These run against the SAME syncedStore + Y.Doc the live patch uses, so graph
// nodes/edges become real Y.Maps once written — the only way to catch the "Type
// already integrated" trap (a 2nd add that spreads an already-integrated array).
// Mirrors control-surface-ydoc.test.ts + the sequencer save-to-slot discipline
// ([[yjs-save-load-real-ydoc]]).

import { describe, it, expect, afterEach } from 'vitest';
import { patch } from '$lib/graph/store';
import {
  addCombineNode,
  connectCombine,
  deleteCombineEdge,
  deleteCombineNode,
  setCombineNodeParam,
  ensureCombineGraph,
  readCombineGraph,
} from './toybox-combine';
import { outputNode } from '$lib/video/toybox-combine-graph';
import type { ModuleNode } from './types';

const TID = 'toybox-ydoc-test';

function makeToybox(): void {
  patch.nodes[TID] = {
    id: TID,
    type: 'toybox',
    domain: 'video',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
}

afterEach(() => {
  delete patch.nodes[TID];
});

describe('toybox combine graph — real Y.Doc mutators', () => {
  it('seeds the default graph in place on first touch', () => {
    makeToybox();
    expect(() => ensureCombineGraph(TID)).not.toThrow();
    const g = readCombineGraph(patch.nodes[TID])!;
    expect(g.nodes.some((n) => n.kind === 'output')).toBe(true);
    expect(g.nodes.filter((n) => n.kind === 'source').length).toBeGreaterThanOrEqual(4);
  });

  it('adds MULTIPLE op nodes without throwing (the 2nd-add regression)', () => {
    makeToybox();
    expect(() => {
      addCombineNode(TID, 'fade');
      addCombineNode(TID, 'lumakey'); // ← used to break here in the spread pattern
      addCombineNode(TID, 'chromakey');
      addCombineNode(TID, 'map');
    }).not.toThrow();
    const g = readCombineGraph(patch.nodes[TID])!;
    const added = g.nodes.filter((n) => ['lumakey', 'chromakey', 'map'].includes(n.kind));
    expect(added.length).toBe(3);
  });

  it('connects nodes (append a new edge in place) + rejects a cycle', () => {
    makeToybox();
    const a = addCombineNode(TID, 'fade')!;
    const b = addCombineNode(TID, 'fade')!;
    // a → b (legal)
    const r1 = connectCombine(TID, a, b, 'in0');
    expect(r1.ok).toBe(true);
    // b → a would close a cycle → rejected, graph unchanged.
    const r2 = connectCombine(TID, b, a, 'in0');
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('cycle');
    const g = readCombineGraph(patch.nodes[TID])!;
    expect(g.edges.some((e) => e.from === a && e.to === b)).toBe(true);
    expect(g.edges.some((e) => e.from === b && e.to === a)).toBe(false);
  });

  it('rejects wiring into an already-occupied input port', () => {
    makeToybox();
    const a = addCombineNode(TID, 'fade')!;
    const b = addCombineNode(TID, 'fade')!;
    const c = addCombineNode(TID, 'fade')!;
    expect(connectCombine(TID, a, c, 'in0').ok).toBe(true);
    const r = connectCombine(TID, b, c, 'in0'); // in0 taken
    expect(r.ok).toBe(false);
    expect(r.error).toBe('occupied');
  });

  it('deletes an op node + its touching edges, leaving the rest intact', () => {
    makeToybox();
    const a = addCombineNode(TID, 'fade')!;
    const b = addCombineNode(TID, 'lumakey')!;
    connectCombine(TID, a, b, 'in0');
    const before = readCombineGraph(patch.nodes[TID])!;
    const beforeEdges = before.edges.length;
    expect(() => deleteCombineNode(TID, b)).not.toThrow();
    const g = readCombineGraph(patch.nodes[TID])!;
    expect(g.nodes.some((n) => n.id === b)).toBe(false);
    expect(g.nodes.some((n) => n.id === a)).toBe(true);
    // The a → b edge is gone with b.
    expect(g.edges.length).toBeLessThan(beforeEdges);
    expect(g.edges.some((e) => e.from === a && e.to === b)).toBe(false);
    // ...and we can keep editing afterward.
    expect(() => addCombineNode(TID, 'map')).not.toThrow();
  });

  it('refuses to delete a structural SOURCE / OUTPUT node', () => {
    makeToybox();
    ensureCombineGraph(TID);
    const g0 = readCombineGraph(patch.nodes[TID])!;
    const out = outputNode(g0)!;
    const src = g0.nodes.find((n) => n.kind === 'source')!;
    deleteCombineNode(TID, out.id);
    deleteCombineNode(TID, src.id);
    const g = readCombineGraph(patch.nodes[TID])!;
    expect(g.nodes.some((n) => n.id === out.id)).toBe(true);
    expect(g.nodes.some((n) => n.id === src.id)).toBe(true);
  });

  it('deletes a single edge by id in place', () => {
    makeToybox();
    const a = addCombineNode(TID, 'fade')!;
    const b = addCombineNode(TID, 'fade')!;
    connectCombine(TID, a, b, 'in0');
    const g0 = readCombineGraph(patch.nodes[TID])!;
    const edge = g0.edges.find((e) => e.from === a && e.to === b)!;
    expect(() => deleteCombineEdge(TID, edge.id)).not.toThrow();
    const g = readCombineGraph(patch.nodes[TID])!;
    expect(g.edges.some((e) => e.id === edge.id)).toBe(false);
  });

  it('sets an op param in place + re-updates it (move-when-edited)', () => {
    makeToybox();
    const a = addCombineNode(TID, 'fade')!;
    expect(() => {
      setCombineNodeParam(TID, a, 'amount', 0.5);
      setCombineNodeParam(TID, a, 'amount', 0.9); // re-set the same key
    }).not.toThrow();
    const g = readCombineGraph(patch.nodes[TID])!;
    expect(g.nodes.find((n) => n.id === a)!.params!.amount).toBe(0.9);
  });

  it('full lifecycle: seed → add many → connect chain → set params → delete, never throws', () => {
    makeToybox();
    expect(() => {
      const a = addCombineNode(TID, 'fade')!;
      const b = addCombineNode(TID, 'lumakey')!;
      const c = addCombineNode(TID, 'map')!;
      connectCombine(TID, a, b, 'in0');
      connectCombine(TID, b, c, 'in0');
      setCombineNodeParam(TID, b, 'thr' in {} ? 'thr' : 'amount', 0.3);
      setCombineNodeParam(TID, c, 'amount', 0.7);
      deleteCombineNode(TID, b); // removes b + its 2 edges
    }).not.toThrow();
    const g = readCombineGraph(patch.nodes[TID])!;
    expect(g.nodes.length).toBeGreaterThan(0);
  });
});
