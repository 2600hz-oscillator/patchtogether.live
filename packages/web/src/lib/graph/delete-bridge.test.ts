// packages/web/src/lib/graph/delete-bridge.test.ts
//
// BRIDGE-ON-DELETE (#1821), pure tier. No Yjs, no DOM — fake defs and a fake
// resolver, the `validate-edge.test.ts` shape.
//
// The four cases the owner named are each a NAMED test here, because each is a
// case where "join the two ends" is WRONG rather than merely unhandled:
// one side free, the SELF-PATCH, fan-out, and a join the cable lattice refuses.

import { describe, it, expect } from 'vitest';
import {
  planDeleteBridge,
  bridgesOnDelete,
  BRIDGE_ON_DELETE,
  type BridgeDefLike,
  type BridgeResolveDef,
} from './delete-bridge';
import type { ModuleNode, Edge, CableType } from './types';
// Side-effect import: the video registry is populated by the module barrel's
// `registerVideoModule` calls, so the anchor below reads the LIVE roster rather
// than a hand-listed one (module-face-lint.test.ts does the same).
import '$lib/video/modules';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { videoPortsOf } from '$lib/ui/patch-drop/drop-plan';

// ---- fixtures -------------------------------------------------------------

function n(id: string, type: string): ModuleNode {
  return { id, type, domain: 'video', position: { x: 0, y: 0 }, params: {} };
}

function e(
  id: string,
  srcN: string,
  srcP: string,
  dstN: string,
  dstP: string,
  sourceType: CableType = 'video',
  targetType: CableType = 'video',
): Edge {
  return {
    id,
    source: { nodeId: srcN, portId: srcP },
    target: { nodeId: dstN, portId: dstP },
    sourceType,
    targetType,
  };
}

/**
 * Fake registry. `videoOut` mirrors the real def (one video in, one video out).
 * `backdraft`/`sourcery` stand in for an upstream source and a downstream sink;
 * `monoSrc` emits `mono-video` and `colourSink` takes `video` only — the pair
 * that makes a bridge ILLEGAL while the through-path was legal.
 */
const DEFS: Record<string, BridgeDefLike> = {
  videoOut: {
    type: 'videoOut',
    inputs: [{ id: 'in', type: 'video' }],
    outputs: [{ id: 'out', type: 'video' }],
  },
  backdraft: {
    type: 'backdraft',
    inputs: [{ id: 'in_a', type: 'video' }],
    outputs: [{ id: 'out', type: 'video' }],
  },
  sourcery: {
    type: 'sourcery',
    inputs: [{ id: 'in', type: 'video' }],
    outputs: [{ id: 'out', type: 'video' }],
  },
  recorderbox: { type: 'recorderbox', inputs: [{ id: 'in', type: 'video' }], outputs: [] },
  // Emits the NARROW video type. `mono-video` upcasts to `video`, so
  // monoSrc → videoOut is legal and so is monoSrc → monoSink.
  monoSrc: { type: 'monoSrc', inputs: [], outputs: [{ id: 'out', type: 'mono-video' }] },
  monoSink: { type: 'monoSink', inputs: [{ id: 'in', type: 'mono-video' }], outputs: [] },
  // Two video inputs ⇒ NOT a 1-in/1-out pass-through, even though it is scoped
  // in the negative-control below.
  twoIn: {
    type: 'twoIn',
    inputs: [
      { id: 'a', type: 'video' },
      { id: 'b', type: 'video' },
    ],
    outputs: [{ id: 'out', type: 'video' }],
  },
};

const resolveDef: BridgeResolveDef = (type: string) => DEFS[type];

/** The canonical chain the owner described: backdraft ▸ videoOut ▸ sourcery. */
function chain(): { nodes: ModuleNode[]; edges: Edge[] } {
  return {
    nodes: [n('bd', 'backdraft'), n('vo', 'videoOut'), n('src', 'sourcery')],
    edges: [
      e('e-bd-out-vo-in', 'bd', 'out', 'vo', 'in'),
      e('e-vo-out-src-in', 'vo', 'out', 'src', 'in'),
    ],
  };
}

// ---- the scope + the derived condition ------------------------------------

describe('the SCOPE is declared, the CONDITION is derived', () => {
  it('every BRIDGE_ON_DELETE entry names a LIVE video def that IS a 1-in/1-out pass-through', () => {
    // ANCHORED TO THE ARTIFACT, both halves: a name with no def is red, and a
    // name whose def stopped being a pass-through is red too — so the scope
    // cannot outlive the shape it depends on.
    const live = new Map(listVideoModuleDefs().map((d) => [d.type, d]));
    const broken = BRIDGE_ON_DELETE.map((entry) => {
      const def = live.get(entry.type);
      if (!def) return `${entry.type}: names no registered video def`;
      const ins = videoPortsOf(def, 'inputs').length;
      const outs = videoPortsOf(def, 'outputs').length;
      if (ins !== 1 || outs !== 1) {
        return `${entry.type}: ${ins} video in / ${outs} video out — no longer a pass-through`;
      }
      return null;
    }).filter((x): x is string => x !== null);
    expect(broken, 'BRIDGE_ON_DELETE entries that no longer resolve').toEqual([]);
  });

  it('every entry carries a real WHY (the type requires the field; this requires it to say something)', () => {
    const thin = BRIDGE_ON_DELETE.filter((entry) => entry.why.trim().length < 40).map((e2) => e2.type);
    expect(thin, 'BRIDGE_ON_DELETE entries whose `why` is a placeholder').toEqual([]);
  });

  it('bridgesOnDelete needs BOTH halves — the scope AND the derived shape', () => {
    expect(bridgesOnDelete('videoOut', DEFS.videoOut)).toBe(true);
    // In scope, wrong shape: two video inputs ⇒ no unambiguous upstream.
    expect(bridgesOnDelete('videoOut', DEFS.twoIn)).toBe(false);
    // Right shape, out of scope: sourcery is 1-in/1-out and deliberately does
    // NOT bridge — the owner scoped this to the OUTPUT monitor.
    expect(bridgesOnDelete('sourcery', DEFS.sourcery)).toBe(false);
    expect(bridgesOnDelete('videoOut', undefined)).toBe(false);
  });
});

// ---- the happy path -------------------------------------------------------

describe('planDeleteBridge — the chain is maintained', () => {
  it("backdraft ▸ videoOut ▸ sourcery: deleting the OUTPUT patches backdraft's out into sourcery", () => {
    const { nodes, edges } = chain();
    const plan = planDeleteBridge('vo', nodes, edges, resolveDef);
    expect(plan).not.toBeNull();
    expect(plan!.removeEdgeIds.sort()).toEqual(['e-bd-out-vo-in', 'e-vo-out-src-in']);
    expect(plan!.refused).toEqual([]);
    expect(plan!.bridgeEdges).toHaveLength(1);
    expect(plan!.bridgeEdges[0]!.source).toEqual({ nodeId: 'bd', portId: 'out' });
    expect(plan!.bridgeEdges[0]!.target).toEqual({ nodeId: 'src', portId: 'in' });
    // The deterministic id every other writer in the repo produces.
    expect(plan!.bridgeEdges[0]!.id).toBe('e-bd-out-src-in');
  });
});

// ---- ORDINARY DELETE: the precondition is BOTH sides patched ---------------

describe('one side free ⇒ ORDINARY delete (null plan, caller falls through)', () => {
  it('input patched, output FREE', () => {
    const { nodes } = chain();
    const edges = [e('e-bd-out-vo-in', 'bd', 'out', 'vo', 'in')];
    expect(planDeleteBridge('vo', nodes, edges, resolveDef)).toBeNull();
  });

  it('output patched, input FREE', () => {
    const { nodes } = chain();
    const edges = [e('e-vo-out-src-in', 'vo', 'out', 'src', 'in')];
    expect(planDeleteBridge('vo', nodes, edges, resolveDef)).toBeNull();
  });

  it('nothing patched at all', () => {
    const { nodes } = chain();
    expect(planDeleteBridge('vo', nodes, [], resolveDef)).toBeNull();
  });

  it('an OUT-OF-SCOPE 1-in/1-out module in the identical chain does NOT bridge', () => {
    // The negative control for the scope: same topology, same shape, different
    // type — so a green result above cannot be "any pass-through bridges".
    const nodes = [n('bd', 'backdraft'), n('mid', 'sourcery'), n('rec', 'recorderbox')];
    const edges = [
      e('e-bd-out-mid-in', 'bd', 'out', 'mid', 'in'),
      e('e-mid-out-rec-in', 'mid', 'out', 'rec', 'in'),
    ];
    expect(planDeleteBridge('mid', nodes, edges, resolveDef)).toBeNull();
  });
});

// ---- THE SELF-PATCH (the owner's "silly edge case") ------------------------

describe('SELF-PATCH ⇒ plain delete', () => {
  it("an OUTPUT wired to itself has no upstream/downstream pair, so it does NOT bridge", () => {
    const nodes = [n('vo', 'videoOut')];
    const edges = [e('e-vo-out-vo-in', 'vo', 'out', 'vo', 'in')];
    // Both sides read as "patched" — that is exactly why this needs detecting
    // rather than falling out of the both-sides precondition.
    expect(planDeleteBridge('vo', nodes, edges, resolveDef)).toBeNull();
  });

  it('self-patched AND fed from upstream / feeding downstream STILL does not bridge', () => {
    // The combination is legal to build and is not obviously safe: there IS a
    // real upstream and a real downstream here, so a self-patch check written
    // as "the node has no other cables" would wrongly bridge this.
    const { nodes } = chain();
    const edges = [
      e('e-bd-out-vo-in', 'bd', 'out', 'vo', 'in'),
      e('e-vo-out-vo-in', 'vo', 'out', 'vo', 'in'),
      e('e-vo-out-src-in', 'vo', 'out', 'src', 'in'),
    ];
    expect(planDeleteBridge('vo', nodes, edges, resolveDef)).toBeNull();
  });

  it('NEGATIVE CONTROL: the SAME graph without the self-cable DOES bridge', () => {
    // The self-patch leg above must fail for the self-cable and nothing else.
    const { nodes } = chain();
    const edges = [
      e('e-bd-out-vo-in', 'bd', 'out', 'vo', 'in'),
      e('e-vo-out-src-in', 'vo', 'out', 'src', 'in'),
    ];
    expect(planDeleteBridge('vo', nodes, edges, resolveDef)?.bridgeEdges).toHaveLength(1);
  });
});

// ---- FAN-OUT: the bridge ADDS, it never moves or drops ---------------------

describe('FAN-OUT', () => {
  it('one bridge edge PER downstream target', () => {
    const nodes = [
      n('bd', 'backdraft'),
      n('vo', 'videoOut'),
      n('src', 'sourcery'),
      n('rec', 'recorderbox'),
    ];
    const edges = [
      e('e-bd-out-vo-in', 'bd', 'out', 'vo', 'in'),
      e('e-vo-out-src-in', 'vo', 'out', 'src', 'in'),
      e('e-vo-out-rec-in', 'vo', 'out', 'rec', 'in'),
    ];
    const plan = planDeleteBridge('vo', nodes, edges, resolveDef)!;
    expect(plan.bridgeEdges.map((b) => `${b.source.nodeId}.${b.source.portId}→${b.target.nodeId}.${b.target.portId}`).sort())
      .toEqual(['bd.out→rec.in', 'bd.out→src.in']);
  });

  it("the UPSTREAM's existing fan-out is untouched — the bridge ADDS an edge", () => {
    // backdraft already feeds recorderbox directly. Deleting the OUTPUT must
    // not move or drop that cable; `removeEdgeIds` names only the OUTPUT's own.
    const nodes = [
      n('bd', 'backdraft'),
      n('vo', 'videoOut'),
      n('src', 'sourcery'),
      n('rec', 'recorderbox'),
    ];
    const edges = [
      e('e-bd-out-rec-in', 'bd', 'out', 'rec', 'in'), // the sibling
      e('e-bd-out-vo-in', 'bd', 'out', 'vo', 'in'),
      e('e-vo-out-src-in', 'vo', 'out', 'src', 'in'),
    ];
    const plan = planDeleteBridge('vo', nodes, edges, resolveDef)!;
    expect(plan.removeEdgeIds).not.toContain('e-bd-out-rec-in');
    expect(plan.removeEdgeIds.sort()).toEqual(['e-bd-out-vo-in', 'e-vo-out-src-in']);
    expect(plan.bridgeEdges).toHaveLength(1);
  });

  it('two downstream cables landing on the SAME target port produce ONE bridge, not a duplicate id', () => {
    const nodes = [n('bd', 'backdraft'), n('vo', 'videoOut'), n('src', 'sourcery')];
    const edges = [
      e('e-bd-out-vo-in', 'bd', 'out', 'vo', 'in'),
      e('e-vo-out-src-in', 'vo', 'out', 'src', 'in'),
      e('dupe', 'vo', 'out', 'src', 'in'),
    ];
    const plan = planDeleteBridge('vo', nodes, edges, resolveDef)!;
    expect(plan.bridgeEdges).toHaveLength(1);
  });
});

// ---- AN ILLEGAL BRIDGE ----------------------------------------------------

describe('a bridge the CABLE LATTICE refuses is not created', () => {
  it('mono-video ▸ OUTPUT ▸ mono-only sink: the through-path is legal, the JOIN is too', () => {
    // The positive control for the pair below: mono → mono needs no widening.
    const nodes = [n('m', 'monoSrc'), n('vo', 'videoOut'), n('ms', 'monoSink')];
    const edges = [
      e('e-m-out-vo-in', 'm', 'out', 'vo', 'in', 'mono-video', 'video'),
      e('e-vo-out-ms-in', 'vo', 'out', 'ms', 'in', 'video', 'mono-video'),
    ];
    const plan = planDeleteBridge('vo', nodes, edges, resolveDef)!;
    expect(plan.refused).toEqual([]);
    expect(plan.bridgeEdges).toHaveLength(1);
  });

  it('colour ▸ OUTPUT ▸ MONO sink: the OUTPUT was doing the narrowing, so the join is REFUSED with a reason', () => {
    // backdraft emits `video` (colour+animated). `monoSink` takes `mono-video`.
    // The chain is legal only because the OUTPUT sits between them; joining the
    // ends directly would push colour into a mono input, which the lattice
    // forbids (colour ⋢ mono).
    const nodes = [n('bd', 'backdraft'), n('vo', 'videoOut'), n('ms', 'monoSink')];
    const edges = [
      e('e-bd-out-vo-in', 'bd', 'out', 'vo', 'in'),
      e('e-vo-out-ms-in', 'vo', 'out', 'ms', 'in', 'video', 'mono-video'),
    ];
    const plan = planDeleteBridge('vo', nodes, edges, resolveDef)!;
    expect(plan.bridgeEdges).toEqual([]);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]!.reason).toMatch(/incompatible cable types/);
    // The node still goes away — the user asked for a delete, and refusing the
    // bridge is not refusing the delete.
    expect(plan.removeEdgeIds.sort()).toEqual(['e-bd-out-vo-in', 'e-vo-out-ms-in']);
  });

  it('a MIXED fan-out keeps the legal half and refuses only the illegal one', () => {
    const nodes = [
      n('bd', 'backdraft'),
      n('vo', 'videoOut'),
      n('src', 'sourcery'),
      n('ms', 'monoSink'),
    ];
    const edges = [
      e('e-bd-out-vo-in', 'bd', 'out', 'vo', 'in'),
      e('e-vo-out-src-in', 'vo', 'out', 'src', 'in'),
      e('e-vo-out-ms-in', 'vo', 'out', 'ms', 'in', 'video', 'mono-video'),
    ];
    const plan = planDeleteBridge('vo', nodes, edges, resolveDef)!;
    expect(plan.bridgeEdges.map((b) => b.target.nodeId)).toEqual(['src']);
    expect(plan.refused.map((r) => r.target.nodeId)).toEqual(['ms']);
  });
});

// ---- totality -------------------------------------------------------------

describe('totality — the planner never throws on a graph it does not understand', () => {
  it('an absent node, an unknown type and an undefined edge slot are all null/ignored', () => {
    const { nodes, edges } = chain();
    expect(planDeleteBridge('nope', nodes, edges, resolveDef)).toBeNull();
    expect(planDeleteBridge('vo', [n('vo', 'unregistered')], edges, resolveDef)).toBeNull();
    expect(planDeleteBridge('vo', nodes, [...edges, undefined], resolveDef)?.bridgeEdges).toHaveLength(1);
  });
});
