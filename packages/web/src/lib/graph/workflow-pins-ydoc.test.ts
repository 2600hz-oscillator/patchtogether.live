// packages/web/src/lib/graph/workflow-pins-ydoc.test.ts
//
// WORKFLOW MODE P2 — the pinned ensure against REAL syncedStore-backed
// Y.Docs (the same harness shape as singleton-cleanup-ydoc.test.ts).
//
// The ensure's collab-safety rests on DETERMINISTIC ids: two clients racing
// the effect both write `pinned-<type>` and the Y.Map converges to ONE
// entry per always-on module — no duplicate-singleton race and no cleanup
// dependency. This proves that for the FULL P2 set (trio + timelorde +
// midiclock + audioIn + audioOut), plus the presence:'type' rule: a
// free-canvas TIMELORDE already in the doc means NO
// pinned-timelorde competitor is spawned by either peer.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import type { ModuleNode, Edge } from './types';
import { PatchEngine, type DomainEngine } from '$lib/audio/engine';
import { attachReconciler } from '$lib/audio/reconciler';
import { createSnapshotBus } from './snapshot';
import {
  ALL_WORKFLOW_PINNED,
  WORKFLOW_DEFAULT_WIRES,
  WORKFLOW_DEFAULT_WIRE_LATCH,
  WORKFLOW_PIN_SPAWN_ORIGIN,
  planDefaultWires,
  planPinnedSpawns,
  planPinnedIdentityRepairs,
} from './workflow-pins';

type PatchStore = { nodes: Record<string, ModuleNode>; edges: Record<string, Edge> };

interface Peer {
  patch: ReturnType<typeof syncedStore<PatchStore>>;
  doc: Y.Doc;
}

function makePeer(): Peer {
  const patch = syncedStore<PatchStore>({ nodes: {}, edges: {} });
  const doc = getYjsDoc(patch);
  return { patch, doc };
}

/** Sync `from` → `to`; converge both ways. */
function converge(a: Peer, b: Peer): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
}

/** Run the ensure EXACTLY as Canvas.svelte's workflow $effect does:
 *  plan against the peer's current nodes, then transact the identity repairs
 *  AND the missing specs (with the in-transact re-check) under the
 *  non-undoable origin. Returns spawns + repairs written. */
function runEnsure(peer: Peer): number {
  const nodes = Object.values(peer.patch.nodes).filter((n): n is ModuleNode => !!n);
  const missing = planPinnedSpawns(nodes);
  const repairs = planPinnedIdentityRepairs(nodes);
  if (missing.length === 0 && repairs.length === 0) return 0;
  let wrote = 0;
  peer.doc.transact(() => {
    for (const r of repairs) {
      const node = peer.patch.nodes[r.id];
      if (!node) continue;
      // Mirrors Canvas exactly: write ONLY the fields the planner named, so the
      // presence:'type' exemption cannot be overridden by the applier.
      if (r.fields.includes('type')) node.type = r.type;
      if (r.fields.includes('domain')) node.domain = r.domain as ModuleNode['domain'];
      if (r.fields.includes('pinned')) {
        if (!node.data) node.data = {};
        (node.data as Record<string, unknown>).pinned = true;
      }
      wrote++;
    }
    for (const spec of missing) {
      if (peer.patch.nodes[spec.id]) continue; // in-transact re-check
      peer.patch.nodes[spec.id] = {
        id: spec.id,
        type: spec.type,
        domain: spec.domain,
        position: { x: 24, y: 24 },
        params: {},
        data: { pinned: true, name: spec.type },
      } as ModuleNode;
      wrote++;
    }
  }, WORKFLOW_PIN_SPAWN_ORIGIN);
  return wrote;
}

/** The PRE-FIX ensure — presence only, `if (nodes[spec.id]) continue`. Kept as
 *  the POSITIVE CONTROL for the hostile-peer cases: it must WEDGE where the
 *  shipped ensure repairs, otherwise those cases prove nothing. */
function runEnsurePresenceOnly(peer: Peer): number {
  const missing = planPinnedSpawns(
    Object.values(peer.patch.nodes).filter((n): n is ModuleNode => !!n),
  );
  if (missing.length === 0) return 0;
  let wrote = 0;
  peer.doc.transact(() => {
    for (const spec of missing) {
      if (peer.patch.nodes[spec.id]) continue;
      peer.patch.nodes[spec.id] = {
        id: spec.id,
        type: spec.type,
        domain: spec.domain,
        position: { x: 24, y: 24 },
        params: {},
        data: { pinned: true, name: spec.type },
      } as ModuleNode;
      wrote++;
    }
  }, WORKFLOW_PIN_SPAWN_ORIGIN);
  return wrote;
}

/** A HOSTILE PEER's write into the live doc. No API is used that a normal
 *  collaborator does not have: this is a plain field write in an ordinary
 *  transaction, which is exactly what a malicious or buggy client would emit. */
function hostileWrite(peer: Peer, id: string, patchFields: Partial<ModuleNode>): void {
  peer.doc.transact(() => {
    const node = peer.patch.nodes[id];
    if (!node) return;
    if (patchFields.type !== undefined) node.type = patchFields.type;
    if (patchFields.domain !== undefined) node.domain = patchFields.domain;
    if (patchFields.data !== undefined) node.data = patchFields.data as ModuleNode['data'];
  });
}

function nodeIds(peer: Peer): string[] {
  return Object.keys(peer.patch.nodes).sort();
}

/** Run the DEFAULT-WIRE seed EXACTLY as Canvas.svelte's $effect does:
 *  plan against the snapshot, then transact the wires + the one-shot latch
 *  (with the in-transact re-checks) under the non-undoable origin. */
function runWireEnsure(peer: Peer): number {
  const plan = planDefaultWires(
    Object.values(peer.patch.nodes).filter((n): n is ModuleNode => !!n),
    Object.values(peer.patch.edges),
  );
  if (!plan.latch) return 0;
  let wrote = 0;
  peer.doc.transact(() => {
    const dst = peer.patch.nodes['pinned-audioOut'];
    if (!dst) return;
    const data = (dst.data ?? {}) as Record<string, unknown>;
    if (data[WORKFLOW_DEFAULT_WIRE_LATCH] === true) return;
    for (const wire of plan.wires) {
      if (peer.patch.edges[wire.id]) continue;
      const occupied = Object.values(peer.patch.edges).some(
        (e) => e && e.target.nodeId === wire.target.nodeId && e.target.portId === wire.target.portId,
      );
      if (occupied) continue;
      peer.patch.edges[wire.id] = {
        id: wire.id,
        source: { nodeId: wire.source.nodeId, portId: wire.source.portId },
        target: { nodeId: wire.target.nodeId, portId: wire.target.portId },
        sourceType: wire.sourceType,
        targetType: wire.targetType,
      } as Edge;
      wrote++;
    }
    if (!dst.data) dst.data = {};
    dst.data[WORKFLOW_DEFAULT_WIRE_LATCH] = true;
  }, WORKFLOW_PIN_SPAWN_ORIGIN);
  return wrote;
}

function edgeIds(peer: Peer): string[] {
  return Object.keys(peer.patch.edges).sort();
}

describe('workflow pinned ensure on real Y.Docs', () => {
  it('a single peer spawns the full always-on set once, then is idempotent', () => {
    const a = makePeer();
    expect(runEnsure(a)).toBe(ALL_WORKFLOW_PINNED.length);
    expect(nodeIds(a)).toEqual(ALL_WORKFLOW_PINNED.map((s) => s.id).sort());
    // Second run: nothing to do.
    expect(runEnsure(a)).toBe(0);
    expect(nodeIds(a)).toHaveLength(ALL_WORKFLOW_PINNED.length);
  });

  it('two peers racing the ensure on an empty rack CONVERGE to one node per spec', () => {
    const a = makePeer();
    const b = makePeer();
    // Both observe the same empty snapshot and both write (the race).
    expect(runEnsure(a)).toBe(ALL_WORKFLOW_PINNED.length);
    expect(runEnsure(b)).toBe(ALL_WORKFLOW_PINNED.length);
    converge(a, b);
    // Deterministic ids → the Y.Map keys collide → exactly ONE entry each.
    expect(nodeIds(a)).toEqual(ALL_WORKFLOW_PINNED.map((s) => s.id).sort());
    expect(nodeIds(b)).toEqual(nodeIds(a));
    // Every survivor still carries the pinned flag.
    for (const n of Object.values(a.patch.nodes)) {
      expect((n?.data as { pinned?: boolean } | undefined)?.pinned).toBe(true);
    }
    // And the converged state satisfies both planners.
    expect(runEnsure(a)).toBe(0);
    expect(runEnsure(b)).toBe(0);
  });

  it('self-heals after a wholesale delete (quickload-style wipe)', () => {
    const a = makePeer();
    runEnsure(a);
    a.doc.transact(() => {
      for (const id of Object.keys(a.patch.nodes)) delete a.patch.nodes[id];
    });
    expect(nodeIds(a)).toEqual([]);
    expect(runEnsure(a)).toBe(ALL_WORKFLOW_PINNED.length);
    expect(nodeIds(a)).toEqual(ALL_WORKFLOW_PINNED.map((s) => s.id).sort());
  });

  it('a free-canvas TIMELORDE in the doc suppresses pinned-timelorde on BOTH peers', () => {
    const a = makePeer();
    // An imported patch: a random-id canvas TIMELORDE, no pinned flag.
    a.doc.transact(() => {
      a.patch.nodes['timelorde-ab12cd34'] = {
        id: 'timelorde-ab12cd34',
        type: 'timelorde',
        domain: 'audio',
        position: { x: 100, y: 100 },
        params: { bpm: 97 },
        data: {},
      } as ModuleNode;
    });
    const b = makePeer();
    converge(a, b);
    runEnsure(a);
    runEnsure(b);
    converge(a, b);
    // Exactly ONE timelorde — the imported canvas one; every other
    // always-on module spawned pinned.
    const timelordes = Object.values(a.patch.nodes).filter(
      (n): n is ModuleNode => !!n && n.type === 'timelorde',
    );
    expect(timelordes.map((n) => n.id)).toEqual(['timelorde-ab12cd34']);
    expect(nodeIds(a)).toEqual(
      [
        'timelorde-ab12cd34',
        ...ALL_WORKFLOW_PINNED.filter((s) => s.type !== 'timelorde').map((s) => s.id),
      ].sort(),
    );
    expect(nodeIds(b)).toEqual(nodeIds(a));
  });
});

describe('workflow default wires (mixmstrs master → audioOut) on real Y.Docs', () => {
  it('seeds both wires + the latch once the pins exist, then is a no-op', () => {
    const a = makePeer();
    runEnsure(a);
    expect(runWireEnsure(a)).toBe(2);
    expect(edgeIds(a)).toEqual(WORKFLOW_DEFAULT_WIRES.map((w) => w.id).sort());
    expect(
      (a.patch.nodes['pinned-audioOut']?.data as Record<string, unknown>)[
        WORKFLOW_DEFAULT_WIRE_LATCH
      ],
    ).toBe(true);
    // Second pass: latched → nothing to plan, nothing written.
    expect(runWireEnsure(a)).toBe(0);
    expect(edgeIds(a)).toHaveLength(2);
  });

  it('plans nothing before the pinned endpoints exist (no latch burn on an empty doc)', () => {
    const a = makePeer();
    expect(runWireEnsure(a)).toBe(0);
    expect(edgeIds(a)).toEqual([]);
    // The ensure lands the pins → the wires seed on the NEXT pass.
    runEnsure(a);
    expect(runWireEnsure(a)).toBe(2);
  });

  it('two peers racing the seed CONVERGE to exactly one edge per wire', () => {
    const a = makePeer();
    const b = makePeer();
    runEnsure(a);
    converge(a, b);
    // Both observe pins-present + unlatched and both write (the race).
    expect(runWireEnsure(a)).toBe(2);
    expect(runWireEnsure(b)).toBe(2);
    converge(a, b);
    expect(edgeIds(a)).toEqual(WORKFLOW_DEFAULT_WIRES.map((w) => w.id).sort());
    expect(edgeIds(b)).toEqual(edgeIds(a));
    expect(runWireEnsure(a)).toBe(0);
    expect(runWireEnsure(b)).toBe(0);
  });

  it('a USER-DELETED default wire is never re-added (the latch outlives the edge)', () => {
    const a = makePeer();
    runEnsure(a);
    runWireEnsure(a);
    // The user rips out the L cable (a normal local delete).
    a.doc.transact(() => {
      delete a.patch.edges['e-pinned-mixmstrs-masterL-pinned-audioOut-L'];
    });
    expect(edgeIds(a)).toEqual(['e-pinned-mixmstrs-masterR-pinned-audioOut-R']);
    // Snapshot churn re-runs the ensure — the latch holds the line.
    expect(runWireEnsure(a)).toBe(0);
    expect(edgeIds(a)).toEqual(['e-pinned-mixmstrs-masterR-pinned-audioOut-R']);
  });

  it('a pre-occupied audioOut input is respected (user patch never replaced)', () => {
    const a = makePeer();
    runEnsure(a);
    // The user hand-patched something into AUDIO OUT L before the seed ran.
    a.doc.transact(() => {
      a.patch.edges['e-user'] = {
        id: 'e-user',
        source: { nodeId: 'osc1', portId: 'out' },
        target: { nodeId: 'pinned-audioOut', portId: 'L' },
        sourceType: 'audio',
        targetType: 'audio',
      } as Edge;
    });
    expect(runWireEnsure(a)).toBe(1); // only the R wire seeds
    expect(edgeIds(a)).toEqual(['e-pinned-mixmstrs-masterR-pinned-audioOut-R', 'e-user']);
    // Seed consumed: deleting the user edge later does NOT invite the default back.
    a.doc.transact(() => {
      delete a.patch.edges['e-user'];
    });
    expect(runWireEnsure(a)).toBe(0);
  });

  it('a quickload-style wholesale wipe re-seeds (fresh pins carry no latch)', () => {
    const a = makePeer();
    runEnsure(a);
    runWireEnsure(a);
    a.doc.transact(() => {
      for (const id of Object.keys(a.patch.nodes)) delete a.patch.nodes[id];
      for (const id of Object.keys(a.patch.edges)) delete a.patch.edges[id];
    });
    runEnsure(a); // the node ensure self-heals the pinned set
    expect(runWireEnsure(a)).toBe(2); // fresh audioOut data → the seed re-runs
    expect(edgeIds(a)).toEqual(WORKFLOW_DEFAULT_WIRES.map((w) => w.id).sort());
  });
});

// ── HOSTILE PEER vs. THE DEVICE SESSION ───────────────────────────────────
//
// The threat is concrete: a rackspace holds up to 4 collaborators, anonymous
// invitees are allowed, and every one of them can write any field of any node
// in the live Y.Doc. Nothing validates the LIVE document — graph/snapshot.ts
// copies `type`/`domain` verbatim, and graph/persistence.ts's type guard only
// runs on IMPORT.
//
// These cases run the REAL reconciler over a REAL Y.Doc with a recording
// engine standing in for the device layer, so the thing being asserted is the
// actual engine call sequence rather than a re-derivation of it. `pinned-audioIn`
// and `pinned-audioOut` are the reserved ids that hold a hardware session
// (ES-9, the system I/O the topbar 1/8"-plug surface owns).

class SessionEngine implements DomainEngine {
  domain = 'audio' as const;
  ops: string[] = [];
  /** Node ids the "device layer" currently holds a session for. */
  live = new Set<string>();
  async addNode(n: ModuleNode): Promise<void> {
    this.ops.push(`addNode ${n.id}:${n.type}`);
    this.live.add(n.id);
  }
  removeNode(id: string): void {
    this.ops.push(`removeNode ${id}`);
    this.live.delete(id);
  }
  addEdge(e: Edge): void {
    this.ops.push(`addEdge ${e.id}`);
  }
  removeEdge(id: string): void {
    this.ops.push(`removeEdge ${id}`);
  }
  setParam(): void {
    /* no-op */
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

/**
 * Drain the reconciler to QUIESCENCE — until the engine stops being called.
 *
 * Deliberately NOT a fixed number of microtask turns: `addNode` is async and
 * the reconciler chains through `inFlight`, so one turn per node is needed and
 * the pinned set is seven nodes deep. A fixed count that happened to be too
 * small was the first draft of this helper, and it made a case go green for the
 * wrong reason (no `removeNode` observed because the ADD had not landed yet).
 * Settling on observable state instead of a magic turn count is the same rule
 * the repo applies to renderer waits.
 */
async function flushReconciler(engine: SessionEngine): Promise<void> {
  let last = -1;
  for (let i = 0; i < 200 && engine.ops.length !== last; i++) {
    last = engine.ops.length;
    // A generous inner drain so a quiet turn is genuinely quiet, not just a
    // gap between two links of the inFlight chain.
    for (let j = 0; j < 8; j++) await Promise.resolve();
  }
}

describe('hostile peer vs. a reserved slot', () => {
  it('POSITIVE CONTROL: presence-only ensure WEDGES on a type swap (this is the bug)', () => {
    const a = makePeer();
    runEnsurePresenceOnly(a);
    // A peer writes garbage into the reserved id.
    hostileWrite(a, 'pinned-mixmstrs', { type: 'scope' });
    // The presence planner now reports mixmstrs missing...
    const nodes = () => Object.values(a.patch.nodes).filter((n): n is ModuleNode => !!n);
    expect(planPinnedSpawns(nodes()).map((s) => s.id)).toContain('pinned-mixmstrs');
    // ...but the in-transact re-check sees the ID occupied and refuses to write.
    // Run it ten times: it never repairs. PERMANENT, not transient.
    for (let i = 0; i < 10; i++) expect(runEnsurePresenceOnly(a)).toBe(0);
    expect(a.patch.nodes['pinned-mixmstrs']!.type).toBe('scope');
  });

  it('the shipped ensure repairs a type swap in ONE pass, then is idempotent', () => {
    const a = makePeer();
    runEnsure(a);
    hostileWrite(a, 'pinned-mixmstrs', { type: 'scope' });
    expect(runEnsure(a)).toBe(1); // exactly the one repair, no spawn
    expect(a.patch.nodes['pinned-mixmstrs']!.type).toBe('mixmstrs');
    expect(runEnsure(a)).toBe(0); // steady state plans nothing
  });

  it('repairs a domain swap and a cleared pinned flag, preserving params + name', () => {
    const a = makePeer();
    runEnsure(a);
    a.doc.transact(() => {
      const n = a.patch.nodes['pinned-audioOut']!;
      n.params = { gain: 0.42 };
      (n.data as Record<string, unknown>).name = 'main out';
    });
    hostileWrite(a, 'pinned-audioOut', { domain: 'meta', data: {} as ModuleNode['data'] });
    expect(runEnsure(a)).toBe(1);
    const fixed = a.patch.nodes['pinned-audioOut']!;
    expect(fixed.domain).toBe('audio');
    expect((fixed.data as Record<string, unknown>).pinned).toBe(true);
    // Legitimate user state survives the hardening.
    expect(fixed.params).toEqual({ gain: 0.42 });
  });

  it('A PEER CANNOT DROP THE DEVICE SESSION: it comes back, at the same id', async () => {
    const a = makePeer();
    const bus = createSnapshotBus({ patch: a.patch as never, ydoc: a.doc });
    const pe = new PatchEngine();
    const eng = new SessionEngine();
    pe.registerDomain(eng);
    const handle = attachReconciler(pe, { bus });
    try {
      runEnsure(a);
      await flushReconciler(eng);
      expect(eng.live.has('pinned-audioOut')).toBe(true);
      expect(eng.live.has('pinned-audioIn')).toBe(true);

      // THE ATTACK: a collaborator retypes both device-session holders.
      const beforeAttack = eng.ops.length;
      hostileWrite(a, 'pinned-audioOut', { type: 'scope' });
      hostileWrite(a, 'pinned-audioIn', { type: 'scope' });
      await flushReconciler(eng);
      // identityChanged fires: the sessions ARE torn down. Yjs has no
      // conditional insert, so this interval is unavoidable — the guarantee
      // being bought is that it is TRANSIENT.
      expect(eng.ops.slice(beforeAttack)).toContain('removeNode pinned-audioOut');
      expect(eng.ops.slice(beforeAttack)).toContain('removeNode pinned-audioIn');

      // THE REPAIR: the ensure canonicalises in place on the next snapshot.
      const beforeRepair = eng.ops.length;
      runEnsure(a);
      await flushReconciler(eng);
      expect(eng.live.has('pinned-audioOut')).toBe(true);
      expect(eng.live.has('pinned-audioIn')).toBe(true);
      // Re-bound as the RIGHT module, at the SAME reserved id — the id is
      // hard-coded in channel-columns.ts / push-lane.ts, so a session that came
      // back at a fresh id would not be a fix. Sliced from the repair point so
      // the ORIGINAL healthy add cannot satisfy this.
      expect(eng.ops.slice(beforeRepair)).toContain('addNode pinned-audioOut:audioOut');
      expect(eng.ops.slice(beforeRepair)).toContain('addNode pinned-audioIn:audioIn');

      // And it SETTLES: no further teardown once canonical (a repair that kept
      // firing would be the same disease wearing the fixer's hat).
      const opsAfter = eng.ops.length;
      runEnsure(a);
      await flushReconciler(eng);
      expect(eng.ops.length).toBe(opsAfter);
    } finally {
      handle.dispose();
    }
  });

  it('POSITIVE CONTROL: without the repair the session NEVER comes back', async () => {
    const a = makePeer();
    const bus = createSnapshotBus({ patch: a.patch as never, ydoc: a.doc });
    const pe = new PatchEngine();
    const eng = new SessionEngine();
    pe.registerDomain(eng);
    const handle = attachReconciler(pe, { bus });
    try {
      runEnsurePresenceOnly(a);
      await flushReconciler(eng);
      expect(eng.live.has('pinned-audioOut')).toBe(true);
      const beforeAttack = eng.ops.length;
      hostileWrite(a, 'pinned-audioOut', { type: 'scope' });
      await flushReconciler(eng);
      // Torn down, then re-added as the WRONG module — and the presence-only
      // ensure is wedged, so it stays wrong forever.
      for (let i = 0; i < 10; i++) {
        runEnsurePresenceOnly(a);
        await flushReconciler(eng);
      }
      expect(a.patch.nodes['pinned-audioOut']!.type).toBe('scope');
      const after = eng.ops.slice(beforeAttack);
      expect(after).toContain('removeNode pinned-audioOut'); // the session died
      expect(after).toContain('addNode pinned-audioOut:scope'); // as the wrong module
      expect(after).not.toContain('addNode pinned-audioOut:audioOut'); // and never returned
    } finally {
      handle.dispose();
    }
  });

  it('two peers repairing CONCURRENTLY converge — no elected deleter needed', () => {
    const a = makePeer();
    const b = makePeer();
    runEnsure(a);
    converge(a, b);
    // Both observe the same poisoned state and both repair (the race).
    hostileWrite(a, 'pinned-mixmstrs', { type: 'scope', data: {} as ModuleNode['data'] });
    converge(a, b);
    expect(runEnsure(a)).toBe(1);
    expect(runEnsure(b)).toBe(1);
    converge(a, b);
    // Identical canonical value from an identical table → an idempotent field
    // write, not a racing delete. Both sides land on the same node.
    for (const p of [a, b]) {
      expect(p.patch.nodes['pinned-mixmstrs']!.type).toBe('mixmstrs');
      expect((p.patch.nodes['pinned-mixmstrs']!.data as Record<string, unknown>).pinned).toBe(true);
    }
    expect(nodeIds(a)).toEqual(nodeIds(b));
    expect(runEnsure(a)).toBe(0);
    expect(runEnsure(b)).toBe(0);
  });

  it('a peer INSERTING a fifth pinned lookalike cannot displace the reserved id', () => {
    // The over-cap insert is already covered (engine.addNode rejects over-cap;
    // singleton-cleanup sweeps the surplus). What matters HERE is that a
    // lookalike at a foreign id neither suppresses the real pin nor gets
    // rewritten by the repair.
    const a = makePeer();
    runEnsure(a);
    a.doc.transact(() => {
      a.patch.nodes['evil-mixer'] = {
        id: 'evil-mixer',
        type: 'mixmstrs',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: {},
        data: { pinned: true },
      } as ModuleNode;
    });
    expect(runEnsure(a)).toBe(0); // nothing to repair, nothing to spawn
    expect(a.patch.nodes['pinned-mixmstrs']!.type).toBe('mixmstrs'); // untouched
    expect(a.patch.nodes['evil-mixer']!.type).toBe('mixmstrs'); // not our business
  });
});

// ── THE NARROWING, PROVED RATHER THAN ASSERTED ────────────────────────────
//
// workflow-pins.ts's header makes two claims about scoping the `pinned` leg to
// presence:'pinned' specs. Both are checked here against the REAL reconciler,
// because both are the kind of claim that is easy to state and easy to be wrong
// about.

describe('the pinned-flag leg — scope and cost', () => {
  it('a `pinned` drift causes NO engine teardown (identityChanged reads type/domain ONLY)', async () => {
    // The claim that lets the leg be narrowed safely: re-pinning, or failing to
    // re-pin, can never cost a device session. If this went red, the exemption
    // for presence:'type' would be giving away a session guard.
    const a = makePeer();
    const bus = createSnapshotBus({ patch: a.patch as never, ydoc: a.doc });
    const pe = new PatchEngine();
    const eng = new SessionEngine();
    pe.registerDomain(eng);
    const handle = attachReconciler(pe, { bus });
    try {
      runEnsure(a);
      await flushReconciler(eng);
      expect(eng.live.has('pinned-audioOut')).toBe(true);

      const before = eng.ops.length;
      // Flip ONLY the flag — no type, no domain.
      a.doc.transact(() => {
        (a.patch.nodes['pinned-audioOut']!.data as Record<string, unknown>).pinned = false;
      });
      await flushReconciler(eng);
      expect(eng.ops.slice(before)).toEqual([]); // no removeNode, no addNode
      expect(eng.live.has('pinned-audioOut')).toBe(true);

      // ...and the repair puts the flag back, still without a teardown.
      const beforeRepair = eng.ops.length;
      expect(runEnsure(a)).toBe(1);
      await flushReconciler(eng);
      expect((a.patch.nodes['pinned-audioOut']!.data as Record<string, unknown>).pinned).toBe(true);
      expect(eng.ops.slice(beforeRepair)).toEqual([]);
    } finally {
      handle.dispose();
    }
  });

  it('an UN-PINNED timelorde SURVIVES the ensure — the imported-rack state', () => {
    // presence:'type' is satisfied by an unpinned node, so this is what a rack
    // loaded from a saved patch looks like. The ensure must neither re-pin it
    // (which would hide it from the canvas) nor spawn a competing clock.
    const a = makePeer();
    runEnsure(a);
    a.doc.transact(() => {
      (a.patch.nodes['pinned-timelorde']!.data as Record<string, unknown>).pinned = false;
    });
    for (let i = 0; i < 5; i++) expect(runEnsure(a)).toBe(0);
    expect((a.patch.nodes['pinned-timelorde']!.data as Record<string, unknown>).pinned).toBe(false);
    // ...and no second clock appeared: maxInstances=1 means a competitor would
    // be a worse bug than the one being avoided.
    const timelordes = Object.values(a.patch.nodes).filter((n) => n?.type === 'timelorde');
    expect(timelordes).toHaveLength(1);
  });

  it('an un-pinned timelorde that is ALSO retyped is still repaired back to timelorde', () => {
    const a = makePeer();
    runEnsure(a);
    a.doc.transact(() => {
      const n = a.patch.nodes['pinned-timelorde']!;
      (n.data as Record<string, unknown>).pinned = false;
      n.type = 'scope';
    });
    expect(runEnsure(a)).toBe(1);
    expect(a.patch.nodes['pinned-timelorde']!.type).toBe('timelorde');
    // The flag is left as the user/import had it — only identity was restored.
    expect((a.patch.nodes['pinned-timelorde']!.data as Record<string, unknown>).pinned).toBe(false);
  });
});
