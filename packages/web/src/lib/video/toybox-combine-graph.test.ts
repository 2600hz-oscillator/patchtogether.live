// packages/web/src/lib/video/toybox-combine-graph.test.ts
//
// Pure-function coverage for the TOYBOX Phase-4 combine GRAPH: the default
// graph shape, topo-sort (Kahn), cycle detection, and the connect/add/delete
// validators the editor + Yjs mutators are built on. Mirrors how the linear
// combine + the topo-sort elsewhere are unit-tested.
import { describe, it, expect } from 'vitest';
import { LAYER_COUNT } from './toybox-content';
import {
  OP_KINDS,
  OP_PARAMS,
  OP_SHADER_INDEX,
  FEEDBACK_SHADER_INDEX,
  EXQUISITE_SHADER_INDEX,
  HISTORY_SHADER_INDEX,
  COMBINE_OP_KINDS,
  HISTORY_OP_KINDS,
  MAX_HISTORY_FRAMES,
  KEYER_OP_KINDS,
  isKeyerKind,
  isCombineOpKind,
  isStatefulKind,
  opHistoryDepth,
  combineExtraFor,
  opParamVal,
  exquisiteUniforms,
  combineDisplayNames,
  combineNodeDisplayName,
  defaultOpParams,
  inPortsFor,
  hasOutPort,
  isCombineGraph,
  makeDefaultCombineGraph,
  makeOpNode,
  opSlotXY,
  validateConnect,
  wouldCreateCycle,
  topoSort,
  canDeleteNode,
  edgesTouching,
  outputNode,
  nextNodeId,
  nextEdgeId,
  type ToyboxCombineGraph,
  type ToyboxGraphNode,
  type ToyboxOpKind,
} from './toybox-combine-graph';

/** A clone so mutations in one test never leak into another. */
function defGraph(): ToyboxCombineGraph {
  const g = makeDefaultCombineGraph();
  return JSON.parse(JSON.stringify(g));
}

describe('makeDefaultCombineGraph', () => {
  const g = makeDefaultCombineGraph();
  it('has one SOURCE per layer + exactly one OUTPUT', () => {
    const sources = g.nodes.filter((n) => n.kind === 'source');
    const outs = g.nodes.filter((n) => n.kind === 'output');
    expect(sources).toHaveLength(LAYER_COUNT);
    expect(outs).toHaveLength(1);
    // sources map 1:1 onto layer indices 0..LAYER_COUNT-1
    expect(sources.map((s) => s.layer).sort()).toEqual(
      Array.from({ length: LAYER_COUNT }, (_, i) => i),
    );
  });
  it('is a valid DAG (topo-sorts every node)', () => {
    const { ok, order } = topoSort(g);
    expect(ok).toBe(true);
    expect(order).toHaveLength(g.nodes.length);
  });
  it('every op node carries default params + the OUTPUT is reachable from src0', () => {
    const out = outputNode(g)!;
    // Walk back from OUTPUT: there must be a path to at least one source.
    const reachesSource = (start: string): boolean => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const n = g.nodes.find((x) => x.id === cur);
        if (n?.kind === 'source') return true;
        for (const e of g.edges) if (e.to === cur) stack.push(e.from);
      }
      return false;
    };
    expect(reachesSource(out.id)).toBe(true);
  });
  it('round-trips through JSON (persistence shape is plain data)', () => {
    expect(isCombineGraph(JSON.parse(JSON.stringify(g)))).toBe(true);
  });
});

describe('isCombineGraph', () => {
  it('accepts a {nodes,edges} shape', () => {
    expect(isCombineGraph({ nodes: [], edges: [] })).toBe(true);
  });
  it('rejects the legacy linear {steps} shape + junk', () => {
    expect(isCombineGraph({ steps: [] })).toBe(false);
    expect(isCombineGraph(null)).toBe(false);
    expect(isCombineGraph(undefined)).toBe(false);
    expect(isCombineGraph(42)).toBe(false);
  });
});

describe('ports', () => {
  it('sources have no input port + have an output', () => {
    expect(inPortsFor('source')).toEqual([]);
    expect(hasOutPort('source')).toBe(true);
  });
  it('the classic blend ops have in0 + in1 + an output; FEEDBACK has only in0', () => {
    for (const k of ['fade', 'lumakey', 'chromakey', 'map'] as const) {
      expect(hasOutPort(k)).toBe(true);
      expect(inPortsFor(k)).toEqual(['in0', 'in1']);
    }
    // FEEDBACK's loop is INTERNAL (its own previous frame) — a single input.
    expect(inPortsFor('feedback')).toEqual(['in0']);
  });
  it('every op kind has an output port + at least one input port', () => {
    for (const k of OP_KINDS) {
      expect(hasOutPort(k)).toBe(true);
      expect(inPortsFor(k).length).toBeGreaterThanOrEqual(1);
    }
  });
  it('output has a single input + no output port', () => {
    expect(inPortsFor('output')).toEqual(['in0']);
    expect(hasOutPort('output')).toBe(false);
  });
});

describe('defaultOpParams', () => {
  it('seeds every declared param at its default for each op', () => {
    for (const k of OP_KINDS) {
      const p = defaultOpParams(k);
      for (const def of OP_PARAMS[k]) expect(p[def.id]).toBe(def.default);
    }
  });
});

describe('FEEDBACK op (the first STATEFUL combine node)', () => {
  it('is a registered op kind in OP_KINDS', () => {
    expect(OP_KINDS).toContain('feedback');
  });
  it('has a SENTINEL shader index (not a real combine uOp 0..3)', () => {
    // FEEDBACK runs its own program; its OP_SHADER_INDEX must not collide with
    // the four stateless blends (0=fade 1=lumakey 2=chromakey 3=map).
    const idx = OP_SHADER_INDEX.feedback;
    expect(idx).toBe(FEEDBACK_SHADER_INDEX);
    expect([0, 1, 2, 3]).not.toContain(idx);
  });
  it('exposes a discrete MODE param (0..11) + the per-mode float superset', () => {
    const params = OP_PARAMS.feedback;
    const byId = Object.fromEntries(params.map((p) => [p.id, p]));
    // The discrete mode selector.
    expect(byId.mode).toMatchObject({ min: 0, max: 11, default: 0 });
    // The 12 float params (CV-targetable + card knobs) with their ranges.
    expect(byId.zoom).toMatchObject({ min: 0.5, max: 1, default: 0.95 });
    expect(byId.scaleP).toMatchObject({ min: 0.5, max: 1.5, default: 1 });
    expect(byId.decay).toMatchObject({ min: 0, max: 1.5, default: 0.9 });
    expect(byId.gain).toMatchObject({ min: 0, max: 2, default: 1 });
    expect(byId.thresh).toMatchObject({ min: 0, max: 1, default: 0.5 });
    expect(byId.blur).toMatchObject({ min: 0, max: 4, default: 1 });
    expect(byId.slitPos).toMatchObject({ min: 0, max: 1, default: 0.5 });
    expect(byId.slitWidth).toMatchObject({ min: 0, max: 1, default: 0.1 });
    expect(byId.flow).toMatchObject({ min: 0, max: 1, default: 0 });
    // tx/ty/rotate/hue present.
    for (const k of ['tx', 'ty', 'rotate', 'hue']) expect(byId[k]).toBeDefined();
  });
  it('defaultOpParams seeds every feedback param including mode', () => {
    const p = defaultOpParams('feedback');
    expect(p.mode).toBe(0);
    for (const def of OP_PARAMS.feedback) expect(p[def.id]).toBe(def.default);
  });
  it('makeOpNode("feedback") mints a feedback node with default params', () => {
    const g = defGraph();
    const n = makeOpNode(g, 'feedback');
    expect(n.kind).toBe('feedback');
    expect(n.params?.mode).toBe(0);
    expect(n.params?.zoom).toBe(0.95);
  });
  it('a feedback node can be deleted (it is a non-structural op)', () => {
    const g = defGraph();
    const n = makeOpNode(g, 'feedback');
    g.nodes.push(n);
    expect(canDeleteNode(g, n.id)).toBe(true);
  });
  it('a feedback node has a unique ordinal display name (FBK N)', () => {
    const g = defGraph();
    const a = makeOpNode(g, 'feedback'); g.nodes.push(a);
    const b = makeOpNode(g, 'feedback'); g.nodes.push(b);
    const names = combineDisplayNames(g);
    expect(names.get(a.id)).toBe('FBK 1');
    expect(names.get(b.id)).toBe('FBK 2');
  });
  it('connecting a source → feedback.in0 is valid; in1 is rejected (no such port)', () => {
    const g = defGraph();
    const fb = makeOpNode(g, 'feedback');
    g.nodes.push(fb);
    expect(validateConnect(g, 'src0', fb.id, 'in0').ok).toBe(true);
    // FEEDBACK has no in1 — wiring it is a bad-in-port.
    const bad = validateConnect(g, 'src1', fb.id, 'in1');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('bad-in-port');
  });
  it('a feedback node topo-sorts + can feed the output (DAG-valid)', () => {
    const g = defGraph();
    const fb = makeOpNode(g, 'feedback');
    g.nodes.push(fb);
    g.edges.push({ id: 'ef1', from: 'src0', to: fb.id, toPort: 'in0' });
    const { ok } = topoSort(g);
    expect(ok).toBe(true);
  });
});

describe('topoSort', () => {
  it('orders dependencies before dependents', () => {
    const g = defGraph();
    const { order } = topoSort(g);
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const e of g.edges) {
      expect(pos.get(e.from)!).toBeLessThan(pos.get(e.to)!);
    }
  });
  it('reports ok=false + omits cycle members when a cycle exists', () => {
    // Two nodes pointing at each other → neither has indegree 0 → both omitted.
    const g: ToyboxCombineGraph = {
      nodes: [
        { id: 'a', kind: 'fade', x: 0, y: 0, params: {} },
        { id: 'b', kind: 'fade', x: 0, y: 0, params: {} },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'b', toPort: 'in0' },
        { id: 'e2', from: 'b', to: 'a', toPort: 'in0' },
      ],
    };
    const { ok, order } = topoSort(g);
    expect(ok).toBe(false);
    expect(order).toHaveLength(0);
  });
  it('is robust to edges referencing missing endpoints', () => {
    const g: ToyboxCombineGraph = {
      nodes: [{ id: 'a', kind: 'source', x: 0, y: 0, layer: 0 }],
      edges: [{ id: 'e1', from: 'a', to: 'ghost', toPort: 'in0' }],
    };
    const { order } = topoSort(g);
    expect(order).toEqual(['a']);
  });
});

describe('wouldCreateCycle', () => {
  it('detects a back-edge', () => {
    const g = defGraph();
    // OUTPUT's upstream chain ends at op1..op3 / sources. Wiring OUTPUT → op1
    // (impossible via UI since OUTPUT has no out port, but tests the predicate)
    // would close a loop because op1 → ... → OUTPUT already exists.
    const out = outputNode(g)!;
    const op1 = g.nodes.find((n) => n.id === 'op1')!;
    expect(wouldCreateCycle(g, out.id, op1.id)).toBe(true);
  });
  it('allows a forward edge', () => {
    const g = defGraph();
    // src0 → op2.in1 does not create a cycle (op2 doesn't reach src0).
    expect(wouldCreateCycle(g, 'src0', 'op2')).toBe(false);
  });
  it('treats a self-edge as a cycle', () => {
    const g = defGraph();
    expect(wouldCreateCycle(g, 'op1', 'op1')).toBe(true);
  });
});

describe('validateConnect', () => {
  it('accepts a legal new edge to a free input port', () => {
    const g: ToyboxCombineGraph = {
      nodes: [
        { id: 'src0', kind: 'source', x: 0, y: 0, layer: 0 },
        { id: 'op1', kind: 'fade', x: 0, y: 0, params: {} },
      ],
      edges: [],
    };
    const r = validateConnect(g, 'src0', 'op1', 'in0');
    expect(r.ok).toBe(true);
    expect(r.edge).toMatchObject({ from: 'src0', to: 'op1', toPort: 'in0' });
  });
  it('rejects a missing endpoint', () => {
    const g = defGraph();
    expect(validateConnect(g, 'nope', 'op1', 'in0').error).toBe('missing-node');
  });
  it('rejects a self-loop', () => {
    const g = defGraph();
    expect(validateConnect(g, 'op1', 'op1', 'in0').error).toBe('self-loop');
  });
  it('rejects connecting FROM the output node (no out port)', () => {
    const g = defGraph();
    const out = outputNode(g)!;
    expect(validateConnect(g, out.id, 'op1', 'in0').error).toBe('no-out-port');
  });
  it('rejects an already-occupied input port', () => {
    const g = defGraph();
    // op1.in0 is wired (src0 → op1) in the default chain.
    expect(validateConnect(g, 'src1', 'op1', 'in0').error).toBe('occupied');
  });
  it('rejects an edge that would create a cycle', () => {
    // Build a chain a → b → c, then try c → a (closes the loop).
    const g: ToyboxCombineGraph = {
      nodes: [
        { id: 'a', kind: 'fade', x: 0, y: 0, params: {} },
        { id: 'b', kind: 'fade', x: 0, y: 0, params: {} },
        { id: 'c', kind: 'fade', x: 0, y: 0, params: {} },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'b', toPort: 'in0' },
        { id: 'e2', from: 'b', to: 'c', toPort: 'in0' },
      ],
    };
    expect(validateConnect(g, 'c', 'a', 'in0').error).toBe('cycle');
  });
  it('rejects a bad input port on a node', () => {
    const g = defGraph();
    const out = outputNode(g)!;
    // OUTPUT only has in0 — wiring to in1 is invalid.
    expect(validateConnect(g, 'src0', out.id, 'in1').error).toBe('bad-in-port');
  });
});

describe('makeOpNode', () => {
  it('returns a node with a fresh unique id + default params', () => {
    const g = defGraph();
    const n = makeOpNode(g, 'lumakey');
    expect(g.nodes.some((x) => x.id === n.id)).toBe(false); // not yet inserted
    expect(n.kind).toBe('lumakey');
    expect(n.params).toEqual(defaultOpParams('lumakey'));
  });

  // Regression (user patch.imp #21): adding a LUMAKEY landed EXACTLY on top of an
  // existing CHROMAKEY. Root cause: the lone op sat at slot 1's position (it was
  // `op2`, created when an `op1` still existed, then `op1` was deleted), and the
  // old code positioned the new op at opSlotXY(ops.length) = opSlotXY(1) — the
  // same slot. The new node was independent (fresh id) but drawn stacked on the
  // old one. makeOpNode must pick a FREE slot.
  it('never stacks a new op on top of an existing op left at a non-zero slot', () => {
    const slot1 = opSlotXY(1);
    const g: ToyboxCombineGraph = {
      nodes: [
        { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
        { id: 'out', kind: 'output', x: 286, y: 66 },
        // The lone op is `op2`, sitting at slot 1 (mirrors the user's patch).
        { id: 'op2', kind: 'chromakey', x: slot1.x, y: slot1.y, params: defaultOpParams('chromakey') },
      ],
      edges: [],
    };
    const n = makeOpNode(g, 'lumakey');
    expect(n.id).not.toBe('op2'); // independent node
    expect(`${n.x},${n.y}`).not.toBe(`${slot1.x},${slot1.y}`); // NOT stacked on the chroma
  });

  it('places successive added ops at mutually-distinct grid slots (no overlaps)', () => {
    const g = defGraph();
    for (let i = 0; i < 5; i++) g.nodes.push(makeOpNode(g, 'lumakey'));
    const ops = g.nodes.filter((x) => x.kind !== 'source' && x.kind !== 'output');
    const positions = ops.map((x) => `${x.x},${x.y}`);
    expect(new Set(positions).size).toBe(positions.length); // every op at a unique (x,y)
  });
});

describe('delete helpers', () => {
  it('source + output nodes cannot be deleted; op nodes can', () => {
    const g = defGraph();
    expect(canDeleteNode(g, 'src0')).toBe(false);
    expect(canDeleteNode(g, outputNode(g)!.id)).toBe(false);
    expect(canDeleteNode(g, 'op1')).toBe(true);
    expect(canDeleteNode(g, 'ghost')).toBe(false);
  });
  it('edgesTouching lists every edge in or out of a node', () => {
    const g = defGraph();
    // op1: src0 → op1.in0, src1 → op1.in1, op1 → op2.in0 = 3 edges.
    const touching = edgesTouching(g, 'op1');
    expect(touching.length).toBe(3);
  });
});

describe('id generators', () => {
  it('nextNodeId / nextEdgeId avoid collisions', () => {
    const g = defGraph();
    expect(g.nodes.some((n) => n.id === nextNodeId(g))).toBe(false);
    expect(g.edges.some((e) => e.id === nextEdgeId(g))).toBe(false);
  });
});

describe('default graph composites like the Phase-1..3 base', () => {
  it('every fold op is a FADE at amount 0 (base passes through)', () => {
    const g = makeDefaultCombineGraph();
    const ops = g.nodes.filter((n: ToyboxGraphNode) => n.kind === 'fade');
    expect(ops.length).toBe(LAYER_COUNT - 1);
    for (const o of ops) expect(o.params?.amount).toBe(0);
  });
});

describe('chromakey OP_PARAMS (HSV key migration)', () => {
  it('exposes amount(THRESHOLD) + soft(SHARPNESS) + keyR/keyG/keyB (green default)', () => {
    const ck = OP_PARAMS.chromakey;
    expect(ck.map((p) => p.id)).toEqual(['amount', 'soft', 'keyR', 'keyG', 'keyB']);
    // the old single `key` channel-select scalar is gone.
    expect(ck.some((p) => p.id === 'key')).toBe(false);
    const byId = Object.fromEntries(ck.map((p) => [p.id, p]));
    expect(byId.amount!.label).toBe('THRESHOLD');
    expect(byId.soft!.label).toBe('SHARPNESS');
    // green-screen default colour (0,1,0).
    expect(byId.keyR!.default).toBe(0);
    expect(byId.keyG!.default).toBe(1);
    expect(byId.keyB!.default).toBe(0);
    for (const id of ['keyR', 'keyG', 'keyB']) {
      expect(byId[id]!.min).toBe(0);
      expect(byId[id]!.max).toBe(1);
    }
  });
  it('lumakey relabels amount→THRESHOLD, soft→SHARPNESS (UI surface only)', () => {
    const byId = Object.fromEntries(OP_PARAMS.lumakey.map((p) => [p.id, p]));
    expect(byId.amount!.label).toBe('THRESHOLD');
    expect(byId.soft!.label).toBe('SHARPNESS');
  });
});

describe('isKeyerKind / KEYER_OP_KINDS', () => {
  it('lumakey + chromakey are keyers; fade/map/source/output are not', () => {
    expect(KEYER_OP_KINDS).toEqual(['lumakey', 'chromakey']);
    expect(isKeyerKind('lumakey')).toBe(true);
    expect(isKeyerKind('chromakey')).toBe(true);
    expect(isKeyerKind('fade')).toBe(false);
    expect(isKeyerKind('map')).toBe(false);
    expect(isKeyerKind('source')).toBe(false);
    expect(isKeyerKind('output')).toBe(false);
    expect(isKeyerKind(undefined)).toBe(false);
  });
});

describe('combineDisplayNames (#56 1-based sources + #58 unique ops)', () => {
  it('sources are 1-based L1..L4; output is OUT', () => {
    const names = combineDisplayNames(makeDefaultCombineGraph());
    expect(names.get('src0')).toBe('L1');
    expect(names.get('src1')).toBe('L2');
    expect(names.get('src3')).toBe('L4');
    expect(names.get('out')).toBe('OUT');
  });
  it('default fade ops are FADE 1..3 in graph order', () => {
    const names = combineDisplayNames(makeDefaultCombineGraph());
    expect(names.get('op1')).toBe('FADE 1');
    expect(names.get('op2')).toBe('FADE 2');
    expect(names.get('op3')).toBe('FADE 3');
  });
  it('two same-kind nodes get distinct ordinals (LUMA 1 / LUMA 2)', () => {
    const g: ToyboxCombineGraph = {
      nodes: [
        { id: 'a', kind: 'lumakey', x: 0, y: 0 },
        { id: 'b', kind: 'chromakey', x: 0, y: 0 },
        { id: 'c', kind: 'lumakey', x: 0, y: 0 },
        { id: 'd', kind: 'chromakey', x: 0, y: 0 },
      ],
      edges: [],
    };
    const names = combineDisplayNames(g);
    expect(names.get('a')).toBe('LUMA 1');
    expect(names.get('c')).toBe('LUMA 2');
    expect(names.get('b')).toBe('CHROMA 1');
    expect(names.get('d')).toBe('CHROMA 2');
  });
  it('combineNodeDisplayName resolves a single id (falls back to id)', () => {
    const g = makeDefaultCombineGraph();
    expect(combineNodeDisplayName(g, 'op2')).toBe('FADE 2');
    expect(combineNodeDisplayName(g, 'ghost')).toBe('ghost');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch op nodes (#node-batch): 12 new combine ops. The SHADER itself is
// e2e/VRT-only (jsdom can't render); these cover the pure DATA MODEL — every op
// is registered, has params, a unique non-colliding shader index, the right port
// shape, default params, a unique ordinal name, and topo-sorts into a valid DAG.
// ─────────────────────────────────────────────────────────────────────────────

/** The 12 batch ops added in this PR + their expected port count + statefulness. */
const BATCH_OPS: Array<{
  kind: ToyboxOpKind;
  ports: number;
  stateful: boolean;
  combineStep: boolean;
  shaderIndex: number;
}> = [
  { kind: 'over', ports: 2, stateful: false, combineStep: true, shaderIndex: 4 },
  { kind: 'tile', ports: 1, stateful: false, combineStep: true, shaderIndex: 5 },
  { kind: 'mirror', ports: 1, stateful: false, combineStep: true, shaderIndex: 6 },
  { kind: 'displace', ports: 2, stateful: false, combineStep: true, shaderIndex: 7 },
  { kind: 'bitbend', ports: 1, stateful: false, combineStep: true, shaderIndex: 8 },
  { kind: 'biocells', ports: 1, stateful: false, combineStep: true, shaderIndex: 9 },
  { kind: 'exquisite', ports: 4, stateful: false, combineStep: false, shaderIndex: EXQUISITE_SHADER_INDEX },
  { kind: 'framedelay', ports: 1, stateful: true, combineStep: false, shaderIndex: HISTORY_SHADER_INDEX },
  { kind: 'channeldesync', ports: 1, stateful: true, combineStep: false, shaderIndex: HISTORY_SHADER_INDEX },
  { kind: 'flowsmear', ports: 1, stateful: true, combineStep: false, shaderIndex: HISTORY_SHADER_INDEX },
  { kind: 'dreammelt', ports: 2, stateful: true, combineStep: false, shaderIndex: HISTORY_SHADER_INDEX },
  { kind: 'datamosh', ports: 1, stateful: true, combineStep: false, shaderIndex: HISTORY_SHADER_INDEX },
];

describe('batch op nodes (12 new combine ops)', () => {
  it('registers exactly the expected 17 op kinds in OP_KINDS (no dupes)', () => {
    expect(OP_KINDS.length).toBe(17);
    expect(new Set(OP_KINDS).size).toBe(OP_KINDS.length);
    for (const { kind } of BATCH_OPS) expect(OP_KINDS).toContain(kind);
  });

  it('OP_SHADER_INDEX is a total map with the stateless single-pass ops on 0..9', () => {
    // Stateless single-pass ops occupy contiguous uOp indices 0..9; the
    // feedback/exquisite/history ops are sentinels (>=100).
    const stateless = OP_KINDS.filter((k) => isCombineOpKind(k)).map((k) => OP_SHADER_INDEX[k]);
    expect([...stateless].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(OP_SHADER_INDEX.exquisite).toBe(EXQUISITE_SHADER_INDEX);
    for (const k of HISTORY_OP_KINDS) expect(OP_SHADER_INDEX[k]).toBe(HISTORY_SHADER_INDEX);
    // sentinels never collide with a real uOp.
    for (const s of [FEEDBACK_SHADER_INDEX, EXQUISITE_SHADER_INDEX, HISTORY_SHADER_INDEX]) {
      expect(s).toBeGreaterThanOrEqual(100);
    }
  });

  for (const { kind, ports, stateful, combineStep, shaderIndex } of BATCH_OPS) {
    describe(kind, () => {
      it(`is registered with shader index ${shaderIndex} + classified correctly`, () => {
        expect(OP_KINDS).toContain(kind);
        expect(OP_SHADER_INDEX[kind]).toBe(shaderIndex);
        expect(isCombineOpKind(kind)).toBe(combineStep);
        expect(isStatefulKind(kind)).toBe(stateful);
      });

      it(`exposes ${ports} input port(s)`, () => {
        expect(inPortsFor(kind)).toHaveLength(ports);
        expect(hasOutPort(kind)).toBe(true);
        // exactly the canonical in0..inN ids.
        expect(inPortsFor(kind)).toEqual(['in0', 'in1', 'in2', 'in3'].slice(0, ports));
      });

      it('has at least one declared param, all seeded by defaultOpParams', () => {
        expect(OP_PARAMS[kind].length).toBeGreaterThan(0);
        const p = defaultOpParams(kind);
        for (const def of OP_PARAMS[kind]) {
          expect(p[def.id]).toBe(def.default);
          expect(def.default).toBeGreaterThanOrEqual(def.min);
          expect(def.default).toBeLessThanOrEqual(def.max);
        }
      });

      it('makeOpNode mints a node with default params + a unique ordinal name', () => {
        const g = defGraph();
        const a = makeOpNode(g, kind); g.nodes.push(a);
        const b = makeOpNode(g, kind); g.nodes.push(b);
        expect(a.kind).toBe(kind);
        expect(a.params).toEqual(defaultOpParams(kind));
        const names = combineDisplayNames(g);
        // two same-kind nodes get distinct ordinals.
        expect(names.get(a.id)).not.toBe(names.get(b.id));
        expect(canDeleteNode(g, a.id)).toBe(true);
      });

      it('connect rules match the port shape', () => {
        const g = defGraph();
        const n = makeOpNode(g, kind); g.nodes.push(n);
        expect(validateConnect(g, 'src0', n.id, 'in0').ok).toBe(true);
        if (ports >= 2) {
          expect(validateConnect(g, 'src1', n.id, 'in1').ok).toBe(true);
        } else {
          // a 1-input op rejects in1 as a bad port (like FEEDBACK).
          const bad = validateConnect(g, 'src1', n.id, 'in1');
          expect(bad.ok).toBe(false);
          expect(bad.error).toBe('bad-in-port');
        }
        if (ports >= 4) {
          expect(validateConnect(g, 'src2', n.id, 'in2').ok).toBe(true);
          expect(validateConnect(g, 'src3', n.id, 'in3').ok).toBe(true);
        }
      });

      it('topo-sorts into a valid DAG when wired to the output', () => {
        const g = defGraph();
        const n = makeOpNode(g, kind); g.nodes.push(n);
        g.edges.push({ id: 'eb', from: 'src0', to: n.id, toPort: 'in0' });
        const { ok } = topoSort(g);
        expect(ok).toBe(true);
      });
    });
  }
});

describe('opParamVal / combineExtraFor (the engine slot mapping)', () => {
  it('opParamVal reads a value or falls back to the schema default', () => {
    expect(opParamVal('tile', { tilesX: 7 }, 'tilesX')).toBe(7);
    expect(opParamVal('tile', {}, 'tilesX')).toBe(3); // default
    expect(opParamVal('tile', { tilesX: NaN }, 'tilesX')).toBe(3); // NaN → default
  });

  it('packs each stateless op param into the right uP slot', () => {
    // TILE: uP0 tilesX, uP1 tilesY, uP2 mirror, uP3 offX, uP4 offY, uP5 rotate.
    const tile = combineExtraFor('tile', { tilesX: 4, tilesY: 5, mirror: 1, offX: 0.2, offY: -0.3, rotate: 1 });
    expect(tile).toMatchObject({ p0: 4, p1: 5, p2: 1, p3: 0.2, p4: -0.3, p5: 1 });
    // MIRROR: uMode = mode, uP0 = segments, uP1 = rotation.
    expect(combineExtraFor('mirror', { mode: 3, segments: 8, rotation: 0.5 }))
      .toMatchObject({ mode: 3, p0: 8, p1: 0.5 });
    // DISPLACE: amount = amount, uMode = channel.
    expect(combineExtraFor('displace', { amount: 0.25, channel: 1 }))
      .toMatchObject({ amount: 0.25, mode: 1 });
    // BITBEND: uMode = op, uP0 = mask, uP3/4/5 = perR/G/B.
    expect(combineExtraFor('bitbend', { op: 2, mask: 170, perR: 1, perG: 0, perB: 1 }))
      .toMatchObject({ mode: 2, p0: 170, p3: 1, p4: 0, p5: 1 });
    // BIOCELLS: uP0 cellCount, uP1 lumaJitter, uP2 edgeWidth, uP3 edgeColor.
    expect(combineExtraFor('biocells', { cellCount: 32, lumaJitter: 0.5, edgeWidth: 0.2, edgeColor: 0.1 }))
      .toMatchObject({ p0: 32, p1: 0.5, p2: 0.2, p3: 0.1 });
    // OVER: amount = OPACITY.
    expect(combineExtraFor('over', { amount: 0.7 })).toMatchObject({ amount: 0.7 });
  });

  it('keeps the legacy ops on their historical channels', () => {
    expect(combineExtraFor('chromakey', { amount: 0.3, soft: 0.1, keyR: 0, keyG: 1, keyB: 0 }))
      .toMatchObject({ amount: 0.3, soft: 0.1, keyR: 0, keyG: 1, keyB: 0 });
    expect(combineExtraFor('lumakey', { amount: 0.5, soft: 0.2, invert: 1 }))
      .toMatchObject({ amount: 0.5, soft: 0.2, invert: 1 });
  });
});

describe('exquisiteUniforms', () => {
  it('clamps + rounds + defaults', () => {
    expect(exquisiteUniforms(undefined)).toEqual({ bands: 4, boundaryWarp: 0.2, seamBlend: 0.1, hueShift: 0 });
    expect(exquisiteUniforms({ bands: 99, boundaryWarp: 2, seamBlend: -1, hueShift: 0.5 }))
      .toEqual({ bands: 8, boundaryWarp: 1, seamBlend: 0, hueShift: 0.5 });
    expect(exquisiteUniforms({ bands: 3.7 }).bands).toBe(4); // rounded
  });
});

describe('history op classification + ring depth', () => {
  it('COMBINE_OP_KINDS = the 10 stateless single-pass ops', () => {
    expect([...COMBINE_OP_KINDS].sort()).toEqual(
      ['biocells', 'bitbend', 'chromakey', 'displace', 'fade', 'lumakey', 'map', 'mirror', 'over', 'tile'].sort(),
    );
  });
  it('feedback + the 5 history ops are stateful; the rest are not', () => {
    expect(isStatefulKind('feedback')).toBe(true);
    for (const k of HISTORY_OP_KINDS) expect(isStatefulKind(k)).toBe(true);
    expect(isStatefulKind('fade')).toBe(false);
    expect(isStatefulKind('exquisite')).toBe(false);
    expect(isStatefulKind('source')).toBe(false);
  });
  it('framedelay/channeldesync need an N-frame ring; the others are 1-deep', () => {
    expect(opHistoryDepth('framedelay')).toBe(MAX_HISTORY_FRAMES);
    expect(opHistoryDepth('channeldesync')).toBe(MAX_HISTORY_FRAMES);
    expect(opHistoryDepth('feedback')).toBe(1);
    expect(opHistoryDepth('flowsmear')).toBe(1);
    expect(opHistoryDepth('dreammelt')).toBe(1);
    expect(opHistoryDepth('datamosh')).toBe(1);
    expect(opHistoryDepth('fade')).toBe(0); // not stateful
  });
  it('frame-delay params clamp to a valid ring tap (< MAX_HISTORY_FRAMES)', () => {
    const byId = Object.fromEntries(OP_PARAMS.framedelay.map((p) => [p.id, p]));
    expect(byId.delay!.max).toBe(MAX_HISTORY_FRAMES - 1);
  });
});

describe('EXQUISITE multi-input (the 4-port surgery)', () => {
  it('exposes in0..in3 + lays out 4 distinct input ports', () => {
    expect(inPortsFor('exquisite')).toEqual(['in0', 'in1', 'in2', 'in3']);
  });
  it('a partially-wired exquisite (2 of 4) still topo-sorts', () => {
    const g = defGraph();
    const n = makeOpNode(g, 'exquisite'); g.nodes.push(n);
    g.edges.push({ id: 'x0', from: 'src0', to: n.id, toPort: 'in0' });
    g.edges.push({ id: 'x1', from: 'src1', to: n.id, toPort: 'in1' });
    const { ok } = topoSort(g);
    expect(ok).toBe(true);
  });
});
