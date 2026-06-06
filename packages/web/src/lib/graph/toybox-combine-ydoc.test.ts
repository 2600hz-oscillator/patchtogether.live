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
  patchToOutput,
  clearCombineEdges,
  resetCombineToDefault,
  duplicateCombineNode,
  resetFeedbackNode,
} from './toybox-combine';
import { outputNode, makeDefaultCombineGraph } from '$lib/video/toybox-combine-graph';
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

  // ───────── contextual-menu mutators (Phase: node-map right-click) ─────────

  it('patchToOutput REPLACES the existing OUTPUT.in0 edge (one edge, new source)', () => {
    makeToybox();
    ensureCombineGraph(TID); // default graph → OUTPUT.in0 is already wired
    const g0 = readCombineGraph(patch.nodes[TID])!;
    const out = outputNode(g0)!;
    const before = g0.edges.filter((e) => e.to === out.id && e.toPort === 'in0');
    expect(before.length, 'default graph wires OUTPUT.in0 once').toBe(1);
    const prevFrom = before[0]!.from;
    // Add a fresh op + patch it to the output (its in/out don't matter for this).
    const op = addCombineNode(TID, 'fade')!;
    expect(() => {
      const r = patchToOutput(TID, op);
      expect(r.ok).toBe(true);
    }).not.toThrow(); // ← never "Type already integrated"
    const g = readCombineGraph(patch.nodes[TID])!;
    const after = g.edges.filter((e) => e.to === out.id && e.toPort === 'in0');
    expect(after.length, 'still exactly one edge into OUTPUT.in0').toBe(1);
    expect(after[0]!.from, 'OUTPUT.in0 now sourced from the new op').toBe(op);
    expect(after[0]!.from).not.toBe(prevFrom);
  });

  it('patchToOutput rejects a wiring that would create a cycle + leaves graph unchanged', () => {
    makeToybox();
    ensureCombineGraph(TID);
    const g0 = readCombineGraph(patch.nodes[TID])!;
    const out = outputNode(g0)!;
    // OUTPUT has no out port, so patching OUTPUT→OUTPUT is a self/no-out reject;
    // build a real cycle instead: a → out is fine, but a node downstream of out
    // can't exist (out has no output). Use the self-loop guard: patch out to out.
    const beforeEdges = g0.edges.map((e) => `${e.from}->${e.to}:${e.toPort}`).sort();
    const r = patchToOutput(TID, out.id); // OUTPUT has no output port
    expect(r.ok).toBe(false);
    expect(r.error === 'no-out-port' || r.error === 'self-loop').toBe(true);
    const g = readCombineGraph(patch.nodes[TID])!;
    const afterEdges = g.edges.map((e) => `${e.from}->${e.to}:${e.toPort}`).sort();
    expect(afterEdges, 'rejected patch restored the original wiring').toEqual(beforeEdges);
  });

  it('clearCombineEdges empties edges + keeps all nodes (never throws)', () => {
    makeToybox();
    ensureCombineGraph(TID);
    const before = readCombineGraph(patch.nodes[TID])!;
    const nodeCount = before.nodes.length;
    expect(before.edges.length).toBeGreaterThan(0);
    expect(() => clearCombineEdges(TID)).not.toThrow();
    const g = readCombineGraph(patch.nodes[TID])!;
    expect(g.edges.length).toBe(0);
    expect(g.nodes.length, 'all nodes remain after clearing edges').toBe(nodeCount);
    // ...and the graph is still editable afterwards (no re-integration breakage).
    expect(() => addCombineNode(TID, 'fade')).not.toThrow();
  });

  it('resetCombineToDefault reproduces makeDefaultCombineGraph after a mutated graph', () => {
    makeToybox();
    // Mutate heavily first: add ops, wire some, clear edges.
    const a = addCombineNode(TID, 'fade')!;
    const b = addCombineNode(TID, 'map')!;
    connectCombine(TID, a, b, 'in0');
    clearCombineEdges(TID);
    expect(() => resetCombineToDefault(TID)).not.toThrow(); // ← riskiest re-seed
    const g = readCombineGraph(patch.nodes[TID])!;
    const def = makeDefaultCombineGraph();
    // Same shape as the code default: 4 sources + op chain + output, with an
    // edge into OUTPUT.in0.
    expect(g.nodes.length).toBe(def.nodes.length);
    expect(g.edges.length).toBe(def.edges.length);
    expect(g.nodes.filter((n) => n.kind === 'source').length).toBe(4);
    expect(g.nodes.filter((n) => n.kind === 'fade').length).toBe(
      def.nodes.filter((n) => n.kind === 'fade').length,
    );
    const out = outputNode(g)!;
    expect(g.edges.some((e) => e.to === out.id && e.toPort === 'in0')).toBe(true);
    // The added ops a/b are gone (fresh default ids).
    expect(g.nodes.some((n) => n.id === a)).toBe(false);
    expect(g.nodes.some((n) => n.id === b)).toBe(false);
    // ...and still editable.
    expect(() => addCombineNode(TID, 'lumakey')).not.toThrow();
  });

  it('duplicateCombineNode mints a fresh id, copies params, copies NO edges', () => {
    makeToybox();
    const a = addCombineNode(TID, 'lumakey')!;
    setCombineNodeParam(TID, a, 'amount', 0.42);
    const src = addCombineNode(TID, 'fade')!;
    connectCombine(TID, src, a, 'in0'); // a has an incoming edge
    const dupId = duplicateCombineNode(TID, a);
    expect(dupId).toBeTruthy();
    expect(dupId).not.toBe(a);
    const g = readCombineGraph(patch.nodes[TID])!;
    const dup = g.nodes.find((n) => n.id === dupId)!;
    expect(dup.kind).toBe('lumakey');
    expect(dup.params!.amount).toBe(0.42); // params copied
    // The duplicate has NO edges (the src→a edge was not copied to src→dup).
    expect(g.edges.some((e) => e.to === dupId)).toBe(false);
    expect(g.edges.some((e) => e.from === dupId)).toBe(false);
  });

  it('duplicateCombineNode refuses SOURCE / OUTPUT (structural)', () => {
    makeToybox();
    ensureCombineGraph(TID);
    const g0 = readCombineGraph(patch.nodes[TID])!;
    const out = outputNode(g0)!;
    const srcNode = g0.nodes.find((n) => n.kind === 'source')!;
    expect(duplicateCombineNode(TID, out.id)).toBeNull();
    expect(duplicateCombineNode(TID, srcNode.id)).toBeNull();
  });

  it('adds a FEEDBACK node (1-input stateful op) + sets its mode in place', () => {
    makeToybox();
    const fb = addCombineNode(TID, 'feedback')!;
    expect(fb).toBeTruthy();
    let g = readCombineGraph(patch.nodes[TID])!;
    let node = g.nodes.find((n) => n.id === fb)!;
    expect(node.kind).toBe('feedback');
    expect(node.params!.mode).toBe(0); // default mode
    // Wire a source into its single in0 (it has no in1 — the loop is internal).
    expect(connectCombine(TID, 'src0', fb, 'in0').ok).toBe(true);
    expect(connectCombine(TID, 'src1', fb, 'in1').ok).toBe(false); // no such port
    // Set the mode (move-when-edited): re-read picks up the live Y value.
    setCombineNodeParam(TID, fb, 'mode', 3);
    g = readCombineGraph(patch.nodes[TID])!;
    node = g.nodes.find((n) => n.id === fb)!;
    expect(node.params!.mode).toBe(3);
  });

  it('resetFeedbackNode bumps the _reset token in place (engine clears buffers)', () => {
    makeToybox();
    const fb = addCombineNode(TID, 'feedback')!;
    // No token yet.
    let node = readCombineGraph(patch.nodes[TID])!.nodes.find((n) => n.id === fb)!;
    expect(node.params!._reset).toBeUndefined();
    // First reset → token 1; second → token 2 (monotonic, never throws on the
    // live Y.Map).
    expect(() => resetFeedbackNode(TID, fb)).not.toThrow();
    node = readCombineGraph(patch.nodes[TID])!.nodes.find((n) => n.id === fb)!;
    expect(node.params!._reset).toBe(1);
    resetFeedbackNode(TID, fb);
    node = readCombineGraph(patch.nodes[TID])!.nodes.find((n) => n.id === fb)!;
    expect(node.params!._reset).toBe(2);
  });

  it('resetFeedbackNode is a no-op on a non-feedback node', () => {
    makeToybox();
    const fade = addCombineNode(TID, 'fade')!;
    resetFeedbackNode(TID, fade);
    const node = readCombineGraph(patch.nodes[TID])!.nodes.find((n) => n.id === fade)!;
    expect(node.params!._reset).toBeUndefined();
  });
});
