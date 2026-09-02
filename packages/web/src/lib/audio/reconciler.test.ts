// B3 — reconciler determinism test. Uses a fake DomainEngine that records
// the order of operations rather than touching Web Audio. The point is to
// prove that two patches with identical end-states produce identical
// engine call sequences regardless of insertion order.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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

// ── data-clone hardening (the MIDI-CC render-starvation fix) ────────────────
//
// Step 5 used to run `appliedNodes.set(id, snapshotNode(node))` for EVERY
// node on EVERY pass, where snapshotNode JSON round-trips node.data — so a
// toybox holding base64 image layers was deep-cloned per param write on ANY
// module (the rank-1 amplifier of the CC-storm cascade). The reconciler now
// keeps the existing clone unless the node is NEW or its data IDENTITY
// changed (the snapshot leaks the live SyncedStore proxy, whose identity is
// stable per node). These tests pin: (a) param-only writes trigger ZERO data
// re-serialization, (b) diff semantics survive — repeated writes to the same
// param still emit one setParam each, and (c) a wholesale data replacement
// re-clones so a later structural read of prev stays coherent.
describe('reconciler — a node whose factory THROWS must not abort the pass', () => {
  // ⚠ WHY THIS MATTERS BEYOND ONE MODULE. `engine.addNode` throws on an
  // unknown/removed module type. Unguarded, that one throw aborted the WHOLE
  // pass — every later node, every edge, every param — and on a live relay the
  // aborted pass replays identically on every peer, so a single stale node type
  // wedges the rackspace for everyone, permanently, with no way out. The edge
  // loop had per-item containment for exactly this reason; addNode did not.
  //
  // Snapshot node order is SORTED, so 'a' … 'z' below guarantees the failing
  // node is processed before the ones that must still land.

  /**
   * A stronger drain than `flushMicrotasks`. Each `addNode` is AWAITED, so a
   * pass over N nodes needs N+ turns — three `Promise.resolve()`s only ever
   * completed the first node. The NEGATIVE CONTROL below is what exposed that:
   * with nothing throwing, only `addNode a` had landed, which means every other
   * assertion here would have been measuring the flush rather than the fix.
   */
  async function drain(): Promise<void> {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  }

  class ThrowingEngine extends RecordingEngine {
    failIds = new Set<string>();
    override async addNode(nd: ModuleNode): Promise<void> {
      if (this.failIds.has(nd.id)) throw new Error(`unknown module type ${nd.type}`);
      await super.addNode(nd);
    }
  }

  function makeThrowing(): { pe: PatchEngine; rec: ThrowingEngine } {
    const pe = new PatchEngine();
    const rec = new ThrowingEngine();
    pe.registerDomain(rec);
    return { pe, rec };
  }

  it('later nodes, edges and params STILL apply after a failed node', async () => {
    const P = freshPatch();
    const bus = createSnapshotBus({ patch: P.patch as never, ydoc: P.ydoc });
    const { pe, rec } = makeThrowing();
    rec.failIds.add('a-bad');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = attachReconciler(pe, { bus });

    P.ydoc.transact(() => {
      P.patch.nodes['a-bad'] = n('a-bad', 'nonexistentModuleType');
      P.patch.nodes['z-good'] = n('z-good');
      P.patch.nodes['y-good'] = n('y-good');
    });
    await drain();

    expect(rec.ops, 'the failing node did not materialize').not.toContain('addNode a-bad');
    // THE POINT: everything after it still did.
    expect(rec.ops, 'a later node still applied').toContain('addNode y-good');
    expect(rec.ops, 'and the one after that').toContain('addNode z-good');

    // …and a param on a healthy node still lands in the SAME pass.
    P.ydoc.transact(() => { P.patch.nodes['z-good']!.params.freq = 440; });
    await drain();
    expect(rec.ops).toContain('setParam z-good.freq=440');

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    handle.dispose();
  });

  it('warns ONCE per node id, not once per pass', async () => {
    // Without a failed-set the warning repeats on every reconcile, which buries
    // the real cause in a scrolling console — and re-runs a factory that cannot
    // succeed (the registry is static for the life of the build).
    const P = freshPatch();
    const bus = createSnapshotBus({ patch: P.patch as never, ydoc: P.ydoc });
    const { pe, rec } = makeThrowing();
    rec.failIds.add('bad');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = attachReconciler(pe, { bus });

    P.ydoc.transact(() => { P.patch.nodes['bad'] = n('bad', 'nope'); });
    await drain();
    // Several more passes.
    for (let i = 0; i < 3; i++) {
      P.ydoc.transact(() => { P.patch.nodes[`ok${i}`] = n(`ok${i}`); });
      await drain();
    }

    const badWarns = warn.mock.calls.filter((c) => String(c[0]).includes('bad'));
    expect(badWarns.length, 'exactly one warning for the bad node').toBe(1);
    warn.mockRestore();
    handle.dispose();
  });

  it('a node DELETED and re-added gets a genuine second attempt', async () => {
    // The failed-set must not be a permanent blacklist: removing the node
    // clears its mark, so a re-add (or a fixed build) can succeed.
    const P = freshPatch();
    const bus = createSnapshotBus({ patch: P.patch as never, ydoc: P.ydoc });
    const { pe, rec } = makeThrowing();
    rec.failIds.add('flaky');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = attachReconciler(pe, { bus });

    P.ydoc.transact(() => { P.patch.nodes['flaky'] = n('flaky', 'nope'); });
    await drain();
    expect(rec.ops).not.toContain('addNode flaky');

    P.ydoc.transact(() => { delete P.patch.nodes['flaky']; });
    await drain();

    rec.failIds.delete('flaky'); // the type now resolves
    P.ydoc.transact(() => { P.patch.nodes['flaky'] = n('flaky'); });
    await drain();
    expect(rec.ops, 'the retry succeeded').toContain('addNode flaky');

    warn.mockRestore();
    handle.dispose();
  });

  it('NEGATIVE CONTROL — with nothing throwing, every node applies and nothing warns', async () => {
    // Guards the instrument: the assertions above would all pass against a
    // reconciler that silently dropped EVERY node.
    const P = freshPatch();
    const bus = createSnapshotBus({ patch: P.patch as never, ydoc: P.ydoc });
    const { pe, rec } = makeThrowing(); // failIds empty
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = attachReconciler(pe, { bus });

    P.ydoc.transact(() => {
      P.patch.nodes['a'] = n('a');
      P.patch.nodes['b'] = n('b');
    });
    await drain();
    expect(rec.ops).toContain('addNode a');
    expect(rec.ops).toContain('addNode b');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    handle.dispose();
  });
});

describe('reconciler — no per-pass data deep-clone (CC-storm hardening)', () => {
  let A: ReturnType<typeof freshPatch>;
  let busA: ReturnType<typeof createSnapshotBus>;
  let recA: RecordingEngine;
  let handleA: ReturnType<typeof attachReconciler>;

  beforeEach(() => {
    A = freshPatch();
    busA = createSnapshotBus({ patch: A.patch as never, ydoc: A.ydoc });
    const peA = makePatchEngine();
    recA = peA.rec;
    handleA = attachReconciler(peA.pe, { bus: busA });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Count JSON.stringify invocations whose payload contains our marker —
   *  i.e. serializations of THIS node's data blob (snapshotNode's clone).
   *  Restores the spy FIRST so the containment probe below doesn't feed the
   *  very mock it is counting. */
  function countDataSerializations(
    spy: { mock: { calls: unknown[][] }; mockRestore: () => void },
    marker: string,
  ): number {
    const calls = spy.mock.calls.slice();
    spy.mockRestore();
    return calls.filter((c) => {
      try {
        return JSON.stringify(c[0])?.includes(marker) ?? false;
      } catch {
        return false;
      }
    }).length;
  }

  it('param-only writes do NOT re-serialize node.data (one setParam, zero clones)', async () => {
    const marker = 'cc-storm-data-marker';
    A.ydoc.transact(() => {
      A.patch.nodes['tb'] = {
        ...n('tb'),
        data: { blob: marker, layers: [{ kind: 'gen', params: { a: 1 } }] },
      };
    });
    await flushMicrotasks();
    await handleA.reconcile(); // initial add — clones once, that's fine

    const spy = vi.spyOn(JSON, 'stringify');
    recA.ops.length = 0;

    // A burst of param writes (what a coalesced CC stream lands as).
    for (const v of [0.1, 0.2, 0.3]) {
      A.ydoc.transact(() => {
        A.patch.nodes['tb']!.params['mix'] = v;
      });
      await flushMicrotasks();
      await handleA.reconcile();
    }

    // Diff semantics intact: each write emitted exactly one setParam…
    expect(recA.ops).toEqual([
      'setParam tb.mix=0.1',
      'setParam tb.mix=0.2',
      'setParam tb.mix=0.3',
    ]);
    // …and an IDENTICAL re-write emits nothing (prev.params was refreshed).
    A.ydoc.transact(() => {
      A.patch.nodes['tb']!.params['mix'] = 0.3;
    });
    await flushMicrotasks();
    await handleA.reconcile();
    expect(recA.ops).toHaveLength(3);

    // The bomb is defused: ZERO serializations of the data blob across all
    // four param-only passes (pre-fix this was one full JSON round-trip of
    // every node's data per pass).
    expect(countDataSerializations(spy, marker)).toBe(0);
  });

  it('a wholesale node.data replacement DOES re-clone (identity change)', async () => {
    const marker = 'cc-storm-replaced-marker';
    A.ydoc.transact(() => {
      A.patch.nodes['tb'] = { ...n('tb'), data: { blob: 'original' } };
    });
    await flushMicrotasks();
    await handleA.reconcile();

    const spy = vi.spyOn(JSON, 'stringify');
    A.ydoc.transact(() => {
      A.patch.nodes['tb']!.data = { blob: marker };
    });
    await flushMicrotasks();
    await handleA.reconcile();

    expect(countDataSerializations(spy, marker)).toBeGreaterThanOrEqual(1);
  });

  it('remove after param-only writes still hands removeNode a coherent node', async () => {
    A.ydoc.transact(() => {
      A.patch.nodes['tb'] = { ...n('tb'), data: { blob: 'x' } };
    });
    await flushMicrotasks();
    await handleA.reconcile();
    A.ydoc.transact(() => {
      A.patch.nodes['tb']!.params['mix'] = 0.7;
    });
    await flushMicrotasks();
    await handleA.reconcile();
    recA.ops.length = 0;

    A.ydoc.transact(() => {
      delete A.patch.nodes['tb'];
    });
    await flushMicrotasks();
    await handleA.reconcile();
    expect(recA.ops).toEqual(['removeNode tb']);

    // And re-adding the same id re-clones fresh (no stale applied entry).
    A.ydoc.transact(() => {
      A.patch.nodes['tb'] = { ...n('tb'), data: { blob: 'y' } };
    });
    await flushMicrotasks();
    await handleA.reconcile();
    expect(recA.ops).toContain('addNode tb');
  });
});

// ── A TYPE CHANGE AT A REUSED ID IS A REMOVE + AN ADD ───────────────────────
//
// THE DEFECT. Step 2 removed only ids that had LEFT the snapshot and step 3
// skips any id it already holds, so a node whose `type` (or `domain`) changed
// AT A REUSED ID produced NO removeNode and NO addNode — the previous module's
// engine handle stayed bound to that id. `engine.read(node, key)` is keyed by
// node id with NO type check, and a dozen modules answer the SAME
// `read('snapshot')` key with their OWN shape (pong, frogger, scope, dockscope,
// nibbles, skifree, gamepad, featurecv, cube, synesthesia, modtris), so the new
// module's surface was handed the OLD module's snapshot: SYNESTHESIA's card
// passes a missing `levelsA` into `drawVuMeters`, whose `levels[c] ?? 0` throws
// on the INDEX READ before the `??` applies — `Cannot read properties of
// undefined (reading '0')`. MODTRIS is the same shape via `state.well[…]`.
//
// The engine below deliberately mirrors the two AudioEngine properties that
// make this unrecoverable downstream: handles are keyed by ID ALONE, and
// `addNode` is IDEMPOTENT PER ID (`if (this.nodes.has(node.id)) return`), so a
// stale binding can ONLY be repaired by removing it first.
describe('reconciler — a type/domain change at a REUSED node id', () => {
  /** Per-type snapshot shapes, standing in for the real `read('snapshot')`
   *  contract each module owns. */
  const SNAPSHOT_BY_TYPE: Record<string, Record<string, unknown>> = {
    scope: { window: [1, 2, 3] },
    synesthesia: { levelsA: [0, 0, 0, 0], levelsB: [0, 0, 0, 0] },
  };

  /** A DomainEngine that binds a per-id handle, exactly like AudioEngine. */
  class HandleEngine extends RecordingEngine {
    /** nodeId → the type whose handle is currently bound at that id. */
    handles = new Map<string, string>();
    /** Resolves when `gate` is released; `undefined` means "don't block". */
    private gate: Promise<void> | undefined;
    private releaseGate: (() => void) | undefined;
    /** ids whose addNode must await the gate. */
    blockIds = new Set<string>();

    constructor(domainName = 'audio') {
      super();
      this.domain = domainName as 'audio';
    }

    /** Arm a gate so the NEXT blocked addNode parks the reconcile pass. */
    arm(): void {
      this.gate = new Promise<void>((r) => { this.releaseGate = r; });
    }
    release(): void {
      this.releaseGate?.();
      this.gate = undefined;
      this.releaseGate = undefined;
    }

    override async addNode(nd: ModuleNode): Promise<void> {
      // ⚠ THE IDEMPOTENCE THAT MAKES THE BUG UNRECOVERABLE IN THE ADD PASS.
      if (this.handles.has(nd.id)) return;
      if (this.blockIds.has(nd.id) && this.gate) await this.gate;
      this.handles.set(nd.id, nd.type);
      this.ops.push(`addNode ${nd.id}:${nd.type}`);
    }
    override removeNode(id: string): void {
      this.ops.push(`removeNode ${id}:${this.handles.get(id) ?? '?'}`);
      this.handles.delete(id);
    }
    // Params are OPTIONAL so this stays assignable to RecordingEngine's
    // zero-arg `read()`; the reconciler's engine always passes both.
    override read(id?: string, key?: string): unknown {
      if (key !== 'snapshot' || id === undefined) return undefined;
      const boundType = this.handles.get(id);
      return boundType ? SNAPSHOT_BY_TYPE[boundType] : undefined;
    }
  }

  function makeHandleEngine(extraDomains: string[] = []): {
    pe: PatchEngine;
    rec: HandleEngine;
    byDomain: Map<string, HandleEngine>;
  } {
    const pe = new PatchEngine();
    const rec = new HandleEngine('audio');
    const byDomain = new Map<string, HandleEngine>([['audio', rec]]);
    pe.registerDomain(rec);
    for (const d of extraDomains) {
      const other = new HandleEngine(d);
      byDomain.set(d, other);
      pe.registerDomain(other);
    }
    return { pe, rec, byDomain };
  }

  /** `addNode` is awaited, so a pass over N nodes needs N+ turns. */
  async function drain(): Promise<void> {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it('ONE transaction that deletes and re-adds id `sut` at a NEW type removes then adds', async () => {
    // This is the shape both real writers produce: `loadEnvelopeIntoStore`
    // swapping the live store, and the e2e `spawnPatch` helper clearing and
    // rebuilding the rack. ONE transaction is ONE snapshot, so the empty
    // intermediate state never exists to be observed — the reconciler sees
    // only "id sut, different type".
    const P = freshPatch();
    const bus = createSnapshotBus({ patch: P.patch as never, ydoc: P.ydoc });
    const { pe, rec } = makeHandleEngine();
    const handle = attachReconciler(pe, { bus });

    P.ydoc.transact(() => { P.patch.nodes['sut'] = n('sut', 'scope'); });
    await drain();
    expect(rec.ops).toEqual(['addNode sut:scope']);
    rec.ops.length = 0;

    P.ydoc.transact(() => {
      delete P.patch.nodes['sut'];
      P.patch.nodes['sut'] = n('sut', 'synesthesia');
    });
    await drain();

    // THE ASSERTION: removal of the OLD module, then the add of the new one,
    // in that order. Before the fix this was `[]`.
    expect(rec.ops).toEqual(['removeNode sut:scope', 'addNode sut:synesthesia']);

    // …and the observable consequence: `read` settles to the NEW module's
    // snapshot shape. Before the fix it returned SCOPE's `{ window }`, which
    // is what a synesthesia surface throws on.
    const after = pe.read(n('sut', 'synesthesia'), 'snapshot') as
      | { levelsA?: number[]; window?: number[] }
      | undefined;
    expect(after?.levelsA, 'the NEW module answers read()').toEqual([0, 0, 0, 0]);
    expect(after?.window, 'no trace of the OLD module').toBeUndefined();

    handle.dispose();
  });

  it('THE CI CONDITION — an empty state COALESCED away by an in-flight pass still swaps', async () => {
    // ⚠ THE FLAKE. The e2e shared rack session clears the graph in its OWN
    // transaction before each row, so an intermediate empty state DOES exist —
    // and it is still not always seen. `enqueue` chains
    // `inFlight.then(() => doReconcile(latest))` and reads `latest` when the
    // pass RUNS, not when it is queued: while a slow factory is awaited, the
    // clear and the re-add both land, `latest` advances past the empty state,
    // and the queued pass reads only the final one. That is the difference
    // between "the previous row's module is torn down" and "it isn't", and it
    // is decided by machine contention — hence recovered-on-retry.
    const P = freshPatch();
    const bus = createSnapshotBus({ patch: P.patch as never, ydoc: P.ydoc });
    const { pe, rec } = makeHandleEngine();
    const handle = attachReconciler(pe, { bus });

    P.ydoc.transact(() => { P.patch.nodes['sut'] = n('sut', 'scope'); });
    await drain();
    rec.ops.length = 0;

    // Park a pass mid-flight on a slow factory.
    rec.blockIds.add('slow');
    rec.arm();
    P.ydoc.transact(() => { P.patch.nodes['slow'] = n('slow', 'scope'); });
    await new Promise((r) => setTimeout(r, 0));

    // Clear and re-add as SEPARATE transactions while that pass is parked.
    P.ydoc.transact(() => { delete P.patch.nodes['sut']; });
    await new Promise((r) => setTimeout(r, 0));
    P.ydoc.transact(() => { P.patch.nodes['sut'] = n('sut', 'synesthesia'); });
    await new Promise((r) => setTimeout(r, 0));

    // Nothing has run for `sut` yet — the empty state was coalesced away.
    expect(rec.ops.filter((o) => o.startsWith('removeNode sut'))).toEqual([]);

    rec.release();
    await drain();

    expect(rec.ops.filter((o) => o.includes('sut'))).toEqual([
      'removeNode sut:scope',
      'addNode sut:synesthesia',
    ]);
    expect(rec.handles.get('sut')).toBe('synesthesia');
    handle.dispose();
  });

  it('a DOMAIN change at a reused id removes from the OLD domain and adds to the NEW', async () => {
    // `removeNode(prev)` has to route by the PREVIOUS node's domain — the
    // handle lives in the engine that built it, not the one the new node names.
    const P = freshPatch();
    const bus = createSnapshotBus({ patch: P.patch as never, ydoc: P.ydoc });
    const { pe, byDomain } = makeHandleEngine(['video']);
    const audio = byDomain.get('audio')!;
    const video = byDomain.get('video')!;
    const handle = attachReconciler(pe, { bus });

    P.ydoc.transact(() => { P.patch.nodes['sut'] = n('sut', 'scope'); });
    await drain();
    audio.ops.length = 0;

    P.ydoc.transact(() => {
      P.patch.nodes['sut'] = { ...n('sut', 'picturebox'), domain: 'video' };
    });
    await drain();

    expect(audio.ops, 'torn down where it was built').toEqual(['removeNode sut:scope']);
    expect(video.ops, 'built where it now belongs').toEqual(['addNode sut:picturebox']);
    expect(audio.handles.has('sut'), 'no stale audio handle').toBe(false);
    handle.dispose();
  });

  it('NEGATIVE CONTROL — an UNCHANGED type at the same id is never churned', async () => {
    // Guards the instrument. A filter that removed on any re-observation would
    // pass every assertion above while tearing the whole rack down and
    // rebuilding it on every pass — audible as a click on every param write.
    const P = freshPatch();
    const bus = createSnapshotBus({ patch: P.patch as never, ydoc: P.ydoc });
    const { pe, rec } = makeHandleEngine();
    const handle = attachReconciler(pe, { bus });

    P.ydoc.transact(() => { P.patch.nodes['sut'] = n('sut', 'scope'); });
    await drain();
    rec.ops.length = 0;

    // A param write, a data write, and a same-type re-assignment of the node.
    P.ydoc.transact(() => { P.patch.nodes['sut']!.params['gain'] = 0.5; });
    await drain();
    P.ydoc.transact(() => { P.patch.nodes['sut'] = n('sut', 'scope'); });
    await drain();
    P.ydoc.transact(() => { P.patch.nodes['other'] = n('other', 'scope'); });
    await drain();

    expect(rec.ops.filter((o) => o.startsWith('removeNode'))).toEqual([]);
    expect(rec.ops.filter((o) => o.startsWith('addNode'))).toEqual(['addNode other:scope']);
    expect(rec.ops).toContain('setParam sut.gain=0.5');
    handle.dispose();
  });

  it('a factory that THREW at one type does not blacklist the ADDRESS for another', async () => {
    // The failed-node mark is keyed id → TYPE. Its stated rationale — "the same
    // factory throws identically every time" — is about the type, and step 2 can
    // now re-materialize a node whose type changed at a reused id, so an id-only
    // mark would make the DIFFERENT module the operator puts there next silently
    // never appear.
    const P = freshPatch();
    const bus = createSnapshotBus({ patch: P.patch as never, ydoc: P.ydoc });
    const pe = new PatchEngine();
    class SelectivelyBadEngine extends HandleEngine {
      override async addNode(nd: ModuleNode): Promise<void> {
        if (nd.type === 'brokenType') throw new Error(`no def for ${nd.type}`);
        await super.addNode(nd);
      }
    }
    const rec = new SelectivelyBadEngine('audio');
    pe.registerDomain(rec);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = attachReconciler(pe, { bus });

    P.ydoc.transact(() => { P.patch.nodes['sut'] = n('sut', 'brokenType'); });
    await drain();
    expect(rec.ops).toEqual([]);

    P.ydoc.transact(() => { P.patch.nodes['sut'] = n('sut', 'synesthesia'); });
    await drain();
    expect(rec.ops, 'the healthy module at the same id still materializes')
      .toEqual(['addNode sut:synesthesia']);

    warn.mockRestore();
    handle.dispose();
  });
});
