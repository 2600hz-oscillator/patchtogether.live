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

// ───────────────────── TYPE-TRANSPARENT pass-through (SCALER dead-knob fix) ─────────────────────
// buildPatchSnapshot accepts an injected def-lookup so the adoptsUpstreamFrom
// resolution is unit-testable without the real registry. A SCALER-like def
// declares `out` adopting `in`; the resolver rewrites the edge's sourceType to
// the UPSTREAM cable's type so a CV source → a CV out (the bug was an
// audio-typed out hitting the video bridge's RMS follower → dead AMOUNT knob).
describe('buildPatchSnapshot: adoptsUpstreamFrom output type resolution', () => {
  // Minimal def fixtures.
  const SCALER_DEF = {
    inputs: [{ id: 'in', type: 'audio', accepts: ['cv', 'pitch', 'gate'] }],
    outputs: [{ id: 'out', type: 'audio', adoptsUpstreamFrom: 'in' }],
  };
  const LFO_DEF = { inputs: [], outputs: [{ id: 'phase0', type: 'cv' }] };
  const VCO_DEF = { inputs: [{ id: 'in', type: 'audio' }], outputs: [{ id: 'out', type: 'audio' }] };
  // A video module with a cv-typed modulation input (LINES.orient shape).
  const LINES_DEF = { inputs: [{ id: 'orient', type: 'cv' }], outputs: [{ id: 'out', type: 'mono-video' }] };

  const defs: Record<string, unknown> = {
    scaler: SCALER_DEF,
    lfo: LFO_DEF,
    vco: VCO_DEF,
    lines: LINES_DEF,
  };
  const resolveDef = (t: string) => defs[t] as never;

  function node(patch: ReturnType<typeof freshPatch>['patch'], id: string, type: string) {
    patch.nodes[id] = { id, type, domain: 'audio', position: { x: 0, y: 0 }, params: {} } as ModuleNode;
  }
  function edge(
    patch: ReturnType<typeof freshPatch>['patch'],
    id: string,
    from: [string, string],
    to: [string, string],
    sourceType: string,
    targetType: string,
  ) {
    patch.edges[id] = {
      id,
      source: { nodeId: from[0], portId: from[1] },
      target: { nodeId: to[0], portId: to[1] },
      sourceType,
      targetType,
    } as Edge;
  }

  it('adopts a CV upstream: LFO(cv) → SCALER → LINES.orient makes SCALER.out emit cv', () => {
    const { patch } = freshPatch();
    node(patch, 'lfo', 'lfo');
    node(patch, 'sc', 'scaler');
    node(patch, 'ln', 'lines');
    // LFO → SCALER.in (the upstream that out should adopt).
    edge(patch, 'e1', ['lfo', 'phase0'], ['sc', 'in'], 'cv', 'audio');
    // SCALER.out → LINES.orient — stored as 'audio' (what a naive connect wrote);
    // the resolver must rewrite it to 'cv'.
    edge(patch, 'e2', ['sc', 'out'], ['ln', 'orient'], 'audio', 'cv');
    const snap = buildPatchSnapshot(patch as never, resolveDef);
    const out = snap.edges.find((e) => e.id === 'e2')!;
    expect(out.sourceType).toBe('cv'); // adopted from the LFO upstream — NOT 'audio'
  });

  it('falls back to the declared audio type when nothing is patched upstream', () => {
    const { patch } = freshPatch();
    node(patch, 'sc', 'scaler');
    node(patch, 'ln', 'lines');
    // No edge into SCALER.in. SCALER.out → LINES.orient.
    edge(patch, 'e2', ['sc', 'out'], ['ln', 'orient'], 'audio', 'cv');
    const snap = buildPatchSnapshot(patch as never, resolveDef);
    const out = snap.edges.find((e) => e.id === 'e2')!;
    // Declared fallback type — unchanged (canConnect audio→cv is false anyway,
    // so even if we tried we wouldn't coerce).
    expect(out.sourceType).toBe('audio');
  });

  it('keeps audio when an AUDIO source feeds it into an audio target (no spurious coercion)', () => {
    const { patch } = freshPatch();
    node(patch, 'vco', 'vco');
    node(patch, 'sc', 'scaler');
    node(patch, 'vco2', 'vco');
    edge(patch, 'e1', ['vco', 'out'], ['sc', 'in'], 'audio', 'audio');
    edge(patch, 'e2', ['sc', 'out'], ['vco2', 'in'], 'audio', 'audio');
    const snap = buildPatchSnapshot(patch as never, resolveDef);
    expect(snap.edges.find((e) => e.id === 'e2')!.sourceType).toBe('audio');
  });

  it('does NOT adopt when the upstream type can not legally reach the downstream target', () => {
    // CV into SCALER.in, but SCALER.out → an AUDIO input. canConnect(cv, audio)
    // is false, so we must NOT coerce out to cv (that would manufacture an
    // illegal cable the engine would reject) — keep the declared audio type.
    const { patch } = freshPatch();
    node(patch, 'lfo', 'lfo');
    node(patch, 'sc', 'scaler');
    node(patch, 'vco', 'vco');
    edge(patch, 'e1', ['lfo', 'phase0'], ['sc', 'in'], 'cv', 'audio');
    edge(patch, 'e2', ['sc', 'out'], ['vco', 'in'], 'audio', 'audio');
    const snap = buildPatchSnapshot(patch as never, resolveDef);
    expect(snap.edges.find((e) => e.id === 'e2')!.sourceType).toBe('audio');
  });

  it('resolves transitively through a chain of pass-throughs (SCALER → SCALER → video)', () => {
    const { patch } = freshPatch();
    node(patch, 'lfo', 'lfo');
    node(patch, 'sc1', 'scaler');
    node(patch, 'sc2', 'scaler');
    node(patch, 'ln', 'lines');
    edge(patch, 'e1', ['lfo', 'phase0'], ['sc1', 'in'], 'cv', 'audio');
    edge(patch, 'e2', ['sc1', 'out'], ['sc2', 'in'], 'audio', 'audio');
    edge(patch, 'e3', ['sc2', 'out'], ['ln', 'orient'], 'audio', 'cv');
    const snap = buildPatchSnapshot(patch as never, resolveDef);
    // The final hop into the video module must carry the original LFO's cv type.
    expect(snap.edges.find((e) => e.id === 'e3')!.sourceType).toBe('cv');
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

// ───────────────────── Identity-stable entries (per-commit-cascade fix, phase 2) ─────────────────────
//
// The bus feeds buildPatchSnapshot a SnapshotMemo built from observeDeep
// dirty-id sets, so a param write on ONE module emits a snapshot where every
// OTHER entry is reference-identical to the previous one. These tests pin:
//   - the yjs deep-observer-before-'update' cleanup ordering the memo relies on
//   - per-entry reuse/rebuild semantics for params, deep data, structure
//   - fresh wrapper arrays every emit (multiplayer layouts stay responsive)
//   - remote-transaction + rebind correctness
//   - copy-on-write for adoptsUpstreamFrom edges (never reused, never mutated)
describe('snapshot memo: yjs ordering pin', () => {
  it('deep observers fire BEFORE the doc-level update event in the same transaction cleanup', () => {
    // The memo is only correct if the dirty sets are complete when the bus's
    // onUpdate → recompute runs. Yjs calls deep observers (_dEH) during
    // transaction cleanup before doc.emit('update'). If a yjs upgrade
    // reorders that, this test fails loudly instead of the app serving
    // stale snapshot entries.
    const { patch, ydoc } = freshPatch();
    const order: string[] = [];
    ydoc.getMap('nodes').observeDeep(() => order.push('deep'));
    ydoc.on('update', () => order.push('update'));
    addNode(patch, 'n1');
    expect(order).toEqual(['deep', 'update']);

    // Nested (params) writes too — path-based deep events, same ordering.
    order.length = 0;
    ydoc.transact(() => {
      patch.nodes['n1']!.params['freq'] = 0.5;
    });
    expect(order).toEqual(['deep', 'update']);
  });
});

describe('snapshot bus: identity-stable entries', () => {
  function busWithLog(patch: ReturnType<typeof freshPatch>['patch'], ydoc: Y.Doc) {
    const bus = createSnapshotBus({ patch: patch as never, ydoc });
    const snaps: PatchSnapshot[] = [];
    bus.subscribe((s) => snaps.push(s));
    return { bus, snaps };
  }

  it('a param write rebuilds ONLY that node entry; all others identity-reused', () => {
    const { patch, ydoc } = freshPatch();
    addNode(patch, 'a');
    addNode(patch, 'b');
    addEdge(patch, 'e1', 'a', 'b');
    const { bus, snaps } = busWithLog(patch, ydoc);

    ydoc.transact(() => {
      patch.nodes['a']!.params['freq'] = 0.5;
    });

    expect(snaps).toHaveLength(2);
    const [prev, next] = [snaps[0]!, snaps[1]!];
    // Fresh wrapper + arrays every emit (bus contract unchanged).
    expect(next).not.toBe(prev);
    expect(next.nodes).not.toBe(prev.nodes);
    expect(next.edges).not.toBe(prev.edges);
    // The written node is a fresh entry carrying the new value…
    const nextA = next.nodes.find((n) => n.id === 'a')!;
    expect(nextA).not.toBe(prev.nodes.find((n) => n.id === 'a'));
    expect(nextA.params['freq']).toBe(0.5);
    // …every untouched entry is the SAME object.
    expect(next.nodes.find((n) => n.id === 'b')).toBe(prev.nodes.find((n) => n.id === 'b'));
    expect(next.edges[0]).toBe(prev.edges[0]);
    bus.dispose();
  });

  it('a deep data write under a STABLE data ref still dirties the node (sequencer steps reassign)', () => {
    // SequencerCard's write path REASSIGNS the `steps` KEY under a data
    // proxy whose REF stays stable — invisible to ref-compare, visible to
    // observeDeep path[0]. A regression here = cards render stale steps.
    const { patch, ydoc } = freshPatch();
    patch.nodes['seq'] = {
      id: 'seq',
      type: 'sequencer',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: { steps: [1, 2, 3] },
    } as never;
    addNode(patch, 'other');
    const { bus, snaps } = busWithLog(patch, ydoc);

    ydoc.transact(() => {
      (patch.nodes['seq']!.data as { steps: number[] }).steps = [7, 8, 9];
    });

    const [prev, next] = [snaps[0]!, snaps[1]!];
    expect(next.nodes.find((n) => n.id === 'seq')).not.toBe(prev.nodes.find((n) => n.id === 'seq'));
    expect(next.nodes.find((n) => n.id === 'other')).toBe(prev.nodes.find((n) => n.id === 'other'));
    bus.dispose();
  });

  it('a write to a NON-graph root map (per-user layouts) still emits fresh wrappers with every entry reused', () => {
    const { patch, ydoc } = freshPatch();
    addNode(patch, 'a');
    addNode(patch, 'b');
    const { bus, snaps } = busWithLog(patch, ydoc);

    // multiplayer/layouts.ts stores per-user positions OUTSIDE the nodes map.
    ydoc.transact(() => {
      const layouts = ydoc.getMap('layouts');
      const mine = new Y.Map();
      layouts.set('user-1', mine);
    });

    expect(snaps).toHaveLength(2);
    const [prev, next] = [snaps[0]!, snaps[1]!];
    expect(next).not.toBe(prev); // Canvas still re-resolves getNodePosition per transaction
    expect(next.nodes).not.toBe(prev.nodes);
    expect(next.nodes[0]).toBe(prev.nodes[0]);
    expect(next.nodes[1]).toBe(prev.nodes[1]);
    bus.dispose();
  });

  it('node add/remove: the new entry is fresh, survivors are reused, deleted ids fall out', () => {
    const { patch, ydoc } = freshPatch();
    addNode(patch, 'a');
    const { bus, snaps } = busWithLog(patch, ydoc);

    addNode(patch, 'c');
    let [prev, next] = [snaps.at(-2)!, snaps.at(-1)!];
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(next.nodes.find((n) => n.id === 'a')).toBe(prev.nodes.find((n) => n.id === 'a'));

    ydoc.transact(() => {
      delete patch.nodes['a'];
    });
    [prev, next] = [snaps.at(-2)!, snaps.at(-1)!];
    expect(next.nodes.map((n) => n.id)).toEqual(['c']);
    expect(next.nodes[0]).toBe(prev.nodes.find((n) => n.id === 'c'));
    bus.dispose();
  });

  it('a REMOTE peer transaction dirties the right node (observeDeep covers applied updates)', () => {
    const a = freshPatch();
    const b = freshPatch();
    addNode(a.patch, 'x');
    addNode(a.patch, 'y');
    // Wire A → B like a provider relay, then seed B with A's state.
    a.ydoc.on('update', (u: Uint8Array) => Y.applyUpdate(b.ydoc, u));
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));

    const { bus, snaps } = busWithLog(b.patch, b.ydoc);
    a.ydoc.transact(() => {
      a.patch.nodes['x']!.params['gain'] = 0.9;
    });

    expect(snaps.length).toBeGreaterThanOrEqual(2);
    const [prev, next] = [snaps.at(-2)!, snaps.at(-1)!];
    const nextX = next.nodes.find((n) => n.id === 'x')!;
    expect(nextX).not.toBe(prev.nodes.find((n) => n.id === 'x'));
    expect(nextX.params['gain']).toBe(0.9);
    expect(next.nodes.find((n) => n.id === 'y')).toBe(prev.nodes.find((n) => n.id === 'y'));
    bus.dispose();
  });

  it('rebind() drops the memo: same-id entries are NOT resurrected and the new doc dirties correctly', () => {
    const one = freshPatch();
    addNode(one.patch, 'a');
    const { bus, snaps } = busWithLog(one.patch, one.ydoc);
    const oldA = snaps[0]!.nodes.find((n) => n.id === 'a')!;

    const two = freshPatch();
    addNode(two.patch, 'a'); // SAME id in a different rackspace
    bus.rebind(two.patch as never, two.ydoc);

    const rebound = snaps.at(-1)!;
    const newA = rebound.nodes.find((n) => n.id === 'a')!;
    expect(newA).not.toBe(oldA); // full rebuild — never reuse across docs

    // Old doc is detached: its edits no longer emit.
    const count = snaps.length;
    addNode(one.patch, 'ghost');
    expect(snaps).toHaveLength(count);

    // New doc's observers are live: a param write reuses untouched entries.
    addNode(two.patch, 'b');
    two.ydoc.transact(() => {
      two.patch.nodes['b']!.params['p'] = 1;
    });
    const [prev, next] = [snaps.at(-2)!, snaps.at(-1)!];
    expect(next.nodes.find((n) => n.id === 'a')).toBe(prev.nodes.find((n) => n.id === 'a'));
    expect(next.nodes.find((n) => n.id === 'b')).not.toBe(prev.nodes.find((n) => n.id === 'b'));
    bus.dispose();
  });

  it('DEV aliasing tripwire: bus-emitted entries are frozen', () => {
    // Reused entries alias prior snapshots — any in-place mutation must
    // throw (strict mode) instead of silently corrupting older snapshots.
    const { patch, ydoc } = freshPatch();
    addNode(patch, 'a');
    addNode(patch, 'b');
    addEdge(patch, 'e1', 'a', 'b');
    const { bus, snaps } = busWithLog(patch, ydoc);
    const snap = snaps[0]!;
    expect(Object.isFrozen(snap.nodes[0])).toBe(true);
    expect(Object.isFrozen(snap.nodes[0]!.params)).toBe(true);
    expect(Object.isFrozen(snap.nodes[0]!.position)).toBe(true);
    expect(Object.isFrozen(snap.edges[0])).toBe(true);
    expect(() => {
      (snap.edges[0] as { sourceType: string }).sourceType = 'cv';
    }).toThrow();
    bus.dispose();
  });
});

describe('buildPatchSnapshot memo: adoptsUpstreamFrom edges are copy-on-write, never reused', () => {
  // Same fixtures as the pass-through describe above (redeclared locally —
  // that block's consts are scoped to it).
  const SCALER_DEF = {
    inputs: [{ id: 'in', type: 'audio', accepts: ['cv', 'pitch', 'gate'] }],
    outputs: [{ id: 'out', type: 'audio', adoptsUpstreamFrom: 'in' }],
  };
  const LFO_DEF = { inputs: [], outputs: [{ id: 'phase0', type: 'cv' }] };
  const LINES_DEF = { inputs: [{ id: 'orient', type: 'cv' }], outputs: [{ id: 'out', type: 'mono-video' }] };
  const defs: Record<string, unknown> = { scaler: SCALER_DEF, lfo: LFO_DEF, lines: LINES_DEF };
  const resolveDef = (t: string) => defs[t] as never;

  function memoFrom(snap: PatchSnapshot, dirty: { nodes?: string[]; edges?: string[] } = {}) {
    return {
      prevNodesById: new Map(snap.nodes.map((n) => [n.id, n])),
      prevEdgesById: new Map(snap.edges.map((e) => [e.id, e])),
      dirtyNodeIds: new Set(dirty.nodes ?? []),
      dirtyEdgeIds: new Set(dirty.edges ?? []),
      fullRebuild: false,
    };
  }

  function passThroughPatch() {
    const { patch, ydoc } = freshPatch();
    patch.nodes['sc'] = { id: 'sc', type: 'scaler', domain: 'audio', position: { x: 0, y: 0 }, params: {} } as never;
    patch.nodes['lfo'] = { id: 'lfo', type: 'lfo', domain: 'audio', position: { x: 0, y: 0 }, params: {} } as never;
    patch.nodes['ln'] = { id: 'ln', type: 'lines', domain: 'video', position: { x: 0, y: 0 }, params: {} } as never;
    // SCALER.out → LINES.orient, declared audio (what a naive connect wrote).
    patch.edges['e2'] = {
      id: 'e2',
      source: { nodeId: 'sc', portId: 'out' },
      target: { nodeId: 'ln', portId: 'orient' },
      sourceType: 'audio',
      targetType: 'cv',
    } as never;
    return { patch, ydoc };
  }

  it('an upstream RE-PATCH retypes the downstream pass-through edge even though it is not dirty', () => {
    const { patch } = passThroughPatch();
    const first = buildPatchSnapshot(patch as never, resolveDef);
    expect(first.edges.find((e) => e.id === 'e2')!.sourceType).toBe('audio');

    // Patch LFO → SCALER.in. Only e1 is dirty; e2 is untouched — but its
    // RESOLVED type must flip to cv on a NEW object (the reused-entry
    // aliasing hazard the copy-on-write resolver exists for).
    patch.edges['e1'] = {
      id: 'e1',
      source: { nodeId: 'lfo', portId: 'phase0' },
      target: { nodeId: 'sc', portId: 'in' },
      sourceType: 'cv',
      targetType: 'audio',
    } as never;
    const second = buildPatchSnapshot(patch as never, resolveDef, memoFrom(first, { edges: ['e1'] }));
    const e2 = second.edges.find((e) => e.id === 'e2')!;
    expect(e2.sourceType).toBe('cv');
    expect(e2).not.toBe(first.edges.find((e) => e.id === 'e2'));
    // The PREVIOUS snapshot's entry is untouched (no in-place retype).
    expect(first.edges.find((e) => e.id === 'e2')!.sourceType).toBe('audio');
  });

  it('an upstream UNPATCH reverts the pass-through edge to its declared type', () => {
    const { patch } = passThroughPatch();
    patch.edges['e1'] = {
      id: 'e1',
      source: { nodeId: 'lfo', portId: 'phase0' },
      target: { nodeId: 'sc', portId: 'in' },
      sourceType: 'cv',
      targetType: 'audio',
    } as never;
    const first = buildPatchSnapshot(patch as never, resolveDef);
    expect(first.edges.find((e) => e.id === 'e2')!.sourceType).toBe('cv');

    delete patch.edges['e1'];
    const second = buildPatchSnapshot(patch as never, resolveDef, memoFrom(first, { edges: ['e1'] }));
    // A naive identity-reuse of e2 would leave the stale adopted 'cv' here.
    expect(second.edges.find((e) => e.id === 'e2')!.sourceType).toBe('audio');
  });

  it('non-adopting edges ARE identity-reused when not dirty', () => {
    const { patch } = freshPatch();
    addNode(patch, 'a');
    addNode(patch, 'b');
    addEdge(patch, 'plain', 'a', 'b');
    const resolveNone = () => undefined;
    const first = buildPatchSnapshot(patch as never, resolveNone);
    const second = buildPatchSnapshot(patch as never, resolveNone, memoFrom(first, { nodes: ['a'] }));
    expect(second.edges[0]).toBe(first.edges[0]);
  });
});
