// packages/web/src/lib/graph/singleton-cleanup-ydoc.test.ts
//
// THE SELF-MERGE GATE — multi-peer no-double-delete proof.
//
// Two REAL syncedStore-backed Y.Docs act as two collab peers. Both concurrently
// insert their OWN TIMELORDE (the exact undeletable-ghost race: each passes the
// pre-write check before seeing the other's write). We sync the docs so they
// CONVERGE to two TIMELORDE nodes — reproducing the bug. Then we run the Phase 4c
// cleanup pass — election + deterministic lex-survivor plan + in-transact
// never-delete-last guard — through the SAME pure helpers Canvas.svelte uses, and
// assert the converged doc ends with EXACTLY ONE TIMELORDE: not zero (no peer
// raced the survivor away), not two (the duplicate is gone), no error, and the
// pass is idempotent on re-run.
//
// This is the proof that the cleanup is collab-safe. If this test cannot be made
// convincing, the change must NOT self-merge.

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import type { ModuleNode, Edge } from './types';
import {
  planSingletonCleanup,
  isElectedDeleter,
  isSafeToDelete,
  type CleanupDef,
  type CleanupPeer,
} from './singleton-cleanup';

type PatchStore = { nodes: Record<string, ModuleNode>; edges: Record<string, Edge> };

// The only def the cleanup needs to know about for this test: TIMELORDE, the
// real singleton+undeletable module. (Other types are uncapped → ignored.)
const DEFS: Record<string, CleanupDef> = {
  timelorde: { type: 'timelorde', maxInstances: 1, undeletable: true },
};
const defForType = (t: string): CleanupDef | undefined => DEFS[t];

/** A peer: a syncedStore proxy + its backing Y.Doc + a fake awareness clientID. */
interface Peer {
  patch: ReturnType<typeof syncedStore<PatchStore>>;
  doc: Y.Doc;
  clientID: number;
  isRackOwner?: boolean;
}

function makePeer(clientID: number, isRackOwner = false): Peer {
  const patch = syncedStore<PatchStore>({ nodes: {}, edges: {} });
  const doc = getYjsDoc(patch);
  return { patch, doc, clientID, isRackOwner };
}

/** Insert a TIMELORDE node with the given id into a peer's doc. */
function insertTimelorde(peer: Peer, id: string): void {
  peer.doc.transact(() => {
    peer.patch.nodes[id] = {
      id,
      type: 'timelorde',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: {},
    } as ModuleNode;
  });
}

/** Sync `from` → `to` (apply from's full state onto to). */
function syncOneWay(from: Peer, to: Peer): void {
  Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc));
}

/** Bidirectional converge of two peers. */
function converge(a: Peer, b: Peer): void {
  syncOneWay(a, b);
  syncOneWay(b, a);
}

function timelordeIds(peer: Peer): string[] {
  return Object.values(peer.patch.nodes)
    .filter((n): n is ModuleNode => !!n && n.type === 'timelorde')
    .map((n) => n.id)
    .sort();
}

/**
 * Run the Phase 4c cleanup pass on `peer` AS IF this peer's awareness clientID
 * is `peer.clientID` and the roster is `peers`. Mirrors the Canvas snapshot
 * $effect EXACTLY: election → plan against live nodes → delete in ONE transact,
 * each guarded by isSafeToDelete (never-delete-last). Returns the # deleted.
 */
function runCleanup(peer: Peer, peers: readonly CleanupPeer[]): number {
  if (!isElectedDeleter(peer.clientID, peers)) return 0; // not our job
  const plan = planSingletonCleanup(
    peer.patch.nodes as Record<string, { id: string; type: string } | null | undefined>,
    defForType,
  );
  if (plan.length === 0) return 0;
  let deleted = 0;
  peer.doc.transact(() => {
    for (const d of plan) {
      if (!isSafeToDelete(
        peer.patch.nodes as Record<string, { type: string } | null | undefined>,
        d.id,
        d.type,
      )) {
        continue;
      }
      for (const [eid, edge] of Object.entries(peer.patch.edges)) {
        if (!edge) continue;
        if (edge.source.nodeId === d.id || edge.target.nodeId === d.id) {
          delete peer.patch.edges[eid];
        }
      }
      delete peer.patch.nodes[d.id];
      deleted++;
    }
  });
  return deleted;
}

describe('Phase 4c multi-peer no-double-delete proof', () => {
  let A: Peer;
  let B: Peer;
  // Awareness roster the elected-deleter logic sees. A has the lower clientID,
  // so A is the elected deleter (no owner set → lex-min clientID).
  let roster: CleanupPeer[];

  beforeEach(() => {
    A = makePeer(10);
    B = makePeer(20);
    roster = [
      { clientID: A.clientID, isRackOwner: A.isRackOwner },
      { clientID: B.clientID, isRackOwner: B.isRackOwner },
    ];
  });

  it('reproduces the race: two peers concurrently insert → converged doc has TWO timelordes', () => {
    insertTimelorde(A, 'timelorde-aaa');
    insertTimelorde(B, 'timelorde-zzz');
    converge(A, B);
    expect(timelordeIds(A)).toEqual(['timelorde-aaa', 'timelorde-zzz']);
    expect(timelordeIds(B)).toEqual(['timelorde-aaa', 'timelorde-zzz']);
  });

  it('after cleanup runs on BOTH peers, EXACTLY ONE timelorde remains (the lex-smallest)', () => {
    insertTimelorde(A, 'timelorde-aaa'); // lex-smaller → survivor
    insertTimelorde(B, 'timelorde-zzz'); // lex-larger → deleted
    converge(A, B);

    // BOTH peers run the cleanup. Only A (lower clientID, no owner) is elected;
    // B is a no-op. This is the every-peer-deletes guard: B must NOT also delete.
    const deletedByA = runCleanup(A, roster);
    const deletedByB = runCleanup(B, roster);
    expect(deletedByA).toBe(1);
    expect(deletedByB).toBe(0); // non-elected peer does nothing

    // Propagate A's delete to B.
    converge(A, B);

    // EXACTLY ONE timelorde on both peers — not zero, not two — and it's the
    // deterministic lex-smallest survivor.
    expect(timelordeIds(A)).toEqual(['timelorde-aaa']);
    expect(timelordeIds(B)).toEqual(['timelorde-aaa']);
  });

  it('is collab-safe even if BOTH peers (wrongly) run the cleanup as if elected', () => {
    // Worst case: awareness churn makes EACH peer momentarily believe it's the
    // elected deleter (each sees only itself). The in-transact never-delete-last
    // guard must still leave exactly one — never zero.
    insertTimelorde(A, 'timelorde-aaa');
    insertTimelorde(B, 'timelorde-zzz');
    converge(A, B);

    // Each peer runs as if it's the SOLE elected deleter (roster = just itself).
    const dA = runCleanup(A, [{ clientID: A.clientID }]);
    const dB = runCleanup(B, [{ clientID: B.clientID }]);
    // A deletes the surplus (timelorde-zzz). B, against its OWN live state
    // (still 2 nodes pre-sync), also tries to delete the lex-larger (zzz). Both
    // act, but each only ever removes the lex-larger, never the survivor.
    expect(dA).toBe(1);
    expect(dB).toBe(1);

    // Converge the two independent deletes. Yjs merges the two "delete zzz" ops
    // idempotently (same key) → the survivor aaa is untouched on both.
    converge(A, B);
    expect(timelordeIds(A)).toEqual(['timelorde-aaa']);
    expect(timelordeIds(B)).toEqual(['timelorde-aaa']);
    expect(timelordeIds(A)).not.toEqual([]); // NEVER zero
  });

  it('never deletes the last one: a single (already-converged) timelorde survives cleanup', () => {
    insertTimelorde(A, 'timelorde-only');
    converge(A, B);
    const dA = runCleanup(A, roster);
    const dB = runCleanup(B, roster);
    expect(dA).toBe(0);
    expect(dB).toBe(0);
    converge(A, B);
    expect(timelordeIds(A)).toEqual(['timelorde-only']);
    expect(timelordeIds(B)).toEqual(['timelorde-only']);
  });

  it('is IDEMPOTENT: re-running cleanup after convergence is a no-op (still exactly one)', () => {
    insertTimelorde(A, 'timelorde-aaa');
    insertTimelorde(B, 'timelorde-zzz');
    converge(A, B);
    runCleanup(A, roster);
    converge(A, B);
    // Re-run on both, repeatedly — must stay at exactly one with zero deletes.
    expect(runCleanup(A, roster)).toBe(0);
    expect(runCleanup(B, roster)).toBe(0);
    expect(runCleanup(A, roster)).toBe(0);
    converge(A, B);
    expect(timelordeIds(A)).toEqual(['timelorde-aaa']);
    expect(timelordeIds(B)).toEqual(['timelorde-aaa']);
  });

  it('three-way race (3 distinct timelordes) converges to exactly one survivor', () => {
    const C = makePeer(30);
    const roster3: CleanupPeer[] = [
      { clientID: A.clientID },
      { clientID: B.clientID },
      { clientID: C.clientID },
    ];
    insertTimelorde(A, 'timelorde-a');
    insertTimelorde(B, 'timelorde-b');
    insertTimelorde(C, 'timelorde-c');
    // Converge all three.
    syncOneWay(A, B); syncOneWay(B, C); syncOneWay(C, A);
    syncOneWay(A, B); syncOneWay(B, C); syncOneWay(C, A);
    syncOneWay(A, B); syncOneWay(B, C); syncOneWay(C, A);
    expect(timelordeIds(A)).toEqual(['timelorde-a', 'timelorde-b', 'timelorde-c']);

    // Only A (lex-min clientID) is elected → deletes the two surplus.
    expect(runCleanup(A, roster3)).toBe(2);
    expect(runCleanup(B, roster3)).toBe(0);
    expect(runCleanup(C, roster3)).toBe(0);

    // Converge the deletes across all three.
    syncOneWay(A, B); syncOneWay(A, C);
    syncOneWay(B, A); syncOneWay(C, A);
    syncOneWay(B, C); syncOneWay(C, B);
    expect(timelordeIds(A)).toEqual(['timelorde-a']);
    expect(timelordeIds(B)).toEqual(['timelorde-a']);
    expect(timelordeIds(C)).toEqual(['timelorde-a']);
  });

  it('owner-preferred election: the owner peer (even with higher id) is the deleter', () => {
    // B is the owner with the HIGHER clientID; A is a non-owner with lower id.
    // Owner-preferred election makes B the deleter, A the no-op.
    const ownerRoster: CleanupPeer[] = [
      { clientID: A.clientID, isRackOwner: false },
      { clientID: B.clientID, isRackOwner: true },
    ];
    insertTimelorde(A, 'timelorde-aaa');
    insertTimelorde(B, 'timelorde-zzz');
    converge(A, B);

    expect(runCleanup(A, ownerRoster)).toBe(0); // non-owner waits
    expect(runCleanup(B, ownerRoster)).toBe(1); // owner deletes
    converge(A, B);
    expect(timelordeIds(A)).toEqual(['timelorde-aaa']);
    expect(timelordeIds(B)).toEqual(['timelorde-aaa']);
  });
});
