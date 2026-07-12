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
// dawless-authored canvas TIMELORDE already in the doc means NO
// pinned-timelorde competitor is spawned by either peer.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import type { ModuleNode, Edge } from './types';
import {
  ALL_WORKFLOW_PINNED,
  WORKFLOW_DEFAULT_WIRES,
  WORKFLOW_DEFAULT_WIRE_LATCH,
  WORKFLOW_PIN_SPAWN_ORIGIN,
  planDefaultWires,
  planPinnedSpawns,
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
 *  plan against the peer's current nodes, then transact the missing specs
 *  (with the in-transact re-check) under the non-undoable origin. */
function runEnsure(peer: Peer): number {
  const missing = planPinnedSpawns(
    Object.values(peer.patch.nodes).filter((n): n is ModuleNode => !!n),
  );
  if (missing.length === 0) return 0;
  let wrote = 0;
  peer.doc.transact(() => {
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

  it('a dawless canvas TIMELORDE in the doc suppresses pinned-timelorde on BOTH peers', () => {
    const a = makePeer();
    // A dawless import: a random-id canvas TIMELORDE, no pinned flag.
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
