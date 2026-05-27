// doom-lockstep.test.ts
//
// Unit tests for the P1 ordered-append-log + consolidation barrier
// (doom-lockstep.ts). These mirror, at the JS-transport layer, the property the
// C-side spike proves at the WASM layer: an ordered log + a barrier that
// withholds a tic until ALL slots are present reconstructs an IDENTICAL ordered
// TicSet stream on every peer. We use TWO LockstepTransports bound to the SAME
// in-memory Y.Doc (no relay, no WASM) — exactly how two browser peers share the
// CRDT log — and assert both reconstruct the same TicSet sequence in order, and
// the barrier holds when a slot's tic is missing.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { LockstepTransport, ticLogName, type TicSet } from './doom-lockstep';

const MID = 'doomNode1';

function cmd(fwd: number, side = 0, ang = 0, btn = 0) {
  return { forwardmove: fwd, sidemove: side, angleturn: ang, buttons: btn };
}

/** Drain ALL ready tics from `t` and collect them. */
function collect(t: LockstepTransport, from: number): { tic: number; set: TicSet }[] {
  const out: { tic: number; set: TicSet }[] = [];
  t.drainReady(from, (tic, _np, set) => out.push({ tic, set }));
  return out;
}

describe('LockstepTransport — ordered log', () => {
  it('shares one Y.Array log across two peers bound to the same doc', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 2 });
    const b = new LockstepTransport({ doc, moduleId: MID, slot: 1, numPlayers: 2 });
    a.appendLocal(0, cmd(10));
    b.appendLocal(0, cmd(-10));
    // Both transports see both entries (same underlying CRDT array).
    expect(doc.getArray(ticLogName(MID)).length).toBe(2);
    expect(a.size()).toBe(2);
    expect(b.size()).toBe(2);
  });

  it('appendLocal is idempotent per tic (no duplicate entries)', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 1 });
    a.appendLocal(0, cmd(5));
    a.appendLocal(0, cmd(5)); // same tic again
    a.appendLocal(0, cmd(9)); // still same tic, different value
    expect(a.size()).toBe(1);
  });
});

describe('LockstepTransport — consolidation barrier', () => {
  it('WITHHOLDS a tic until every live slot has submitted, then RELEASES it', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 2 });
    const b = new LockstepTransport({ doc, moduleId: MID, slot: 1, numPlayers: 2 });

    a.appendLocal(0, cmd(10)); // only slot 0 present at tic 0
    expect(collect(a, 0)).toEqual([]); // barrier holds — slot 1 missing

    b.appendLocal(0, cmd(-10)); // slot 1 arrives
    const ready = collect(a, 0);
    expect(ready.length).toBe(1);
    expect(ready[0]!.tic).toBe(0);
    expect(ready[0]!.set[0]).toEqual(cmd(10));
    expect(ready[0]!.set[1]).toEqual(cmd(-10));
  });

  it('reconstructs the IDENTICAL ordered TicSet stream on BOTH peers, even with out-of-order arrival', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 2 });
    const b = new LockstepTransport({ doc, moduleId: MID, slot: 1, numPlayers: 2 });

    // Each peer appends its OWN slot monotonically (real play), but the two
    // peers' appends INTERLEAVE in the shared log in an order that is NOT tic
    // order across slots (peer arrival jitter): the log ends up as
    // s1.t0, s0.t0, s1.t1, s0.t1, s1.t2, s0.t2 — slot 1 consistently lands
    // before slot 0 within each tic. The barrier + total order must still
    // reconstruct the same per-tic TicSet on both peers.
    b.appendLocal(0, cmd(-1));
    a.appendLocal(0, cmd(1));
    b.appendLocal(1, cmd(-2));
    a.appendLocal(1, cmd(2));
    b.appendLocal(2, cmd(-3));
    a.appendLocal(2, cmd(3));

    const fromA = collect(a, 0);
    const fromB = collect(b, 0);
    // Both peers must produce tics 0,1,2 IN ORDER with the same per-slot sets.
    expect(fromA.map((x) => x.tic)).toEqual([0, 1, 2]);
    expect(fromB.map((x) => x.tic)).toEqual([0, 1, 2]);
    expect(fromA).toEqual(fromB);
    expect(fromA[0]!.set).toEqual([cmd(1), cmd(-1)]);
    expect(fromA[1]!.set).toEqual([cmd(2), cmd(-2)]);
    expect(fromA[2]!.set).toEqual([cmd(3), cmd(-3)]);
  });

  it('STOPS at the first gap (a missing intermediate tic pauses the stream)', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 2 });
    const b = new LockstepTransport({ doc, moduleId: MID, slot: 1, numPlayers: 2 });

    // Each peer appends its OWN slot monotonically (as in real play). Slot 0
    // gets ahead to tics 0,1,2; slot 1 has only delivered tic 0 so far (its
    // tic-1 entry is in flight / lost) → the barrier holds at tic 1.
    a.appendLocal(0, cmd(1));
    a.appendLocal(1, cmd(2));
    a.appendLocal(2, cmd(3));
    b.appendLocal(0, cmd(-1)); // slot 1 only up to tic 0

    const ready = collect(a, 0);
    // Only tic 0 releases — tic 1's gap holds tic 2 too (strict in-order).
    expect(ready.map((x) => x.tic)).toEqual([0]);

    // Slot 1 catches up (tic 1, then tic 2) → 1 and 2 release together, in order.
    b.appendLocal(1, cmd(-2));
    b.appendLocal(2, cmd(-3));
    const next = collect(a, 1);
    expect(next.map((x) => x.tic)).toEqual([1, 2]);
  });

  it('drainReady returns the next-awaited tic (== fromTic when the first is incomplete)', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 2 });
    new LockstepTransport({ doc, moduleId: MID, slot: 1, numPlayers: 2 });
    a.appendLocal(0, cmd(1)); // slot 1 missing
    const next = a.drainReady(0, () => {});
    expect(next).toBe(0); // still awaiting tic 0
  });
});

describe('LockstepTransport — single player', () => {
  it('a lone player (numPlayers=1) releases every tic immediately', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 1 });
    a.appendLocal(0, cmd(1));
    a.appendLocal(1, cmd(2));
    const ready = collect(a, 0);
    expect(ready.map((x) => x.tic)).toEqual([0, 1]);
    expect(ready[0]!.set).toEqual([cmd(1)]);
  });
});

describe('LockstepTransport — pruning', () => {
  it('arbiter prunes a stale prefix without dropping live tics', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 1 });
    // Fill 400 tics (PRUNE_KEEP_TICS = 256).
    for (let t = 0; t < 400; t++) a.appendLocal(t, cmd(t & 0x7f));
    expect(a.size()).toBe(400);
    a.pruneBelow(400); // cutoff = 400 - 256 = 144 → tics < 144 pruned
    expect(a.size()).toBe(400 - 144);
    // The remaining oldest tic is >= 144 (no live tic dropped).
    const remaining = doc.getArray(ticLogName(MID)).toArray() as { t: number }[];
    expect(remaining[0]!.t).toBe(144);
  });

  it('pruneBelow is a no-op below the keep window', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 1 });
    for (let t = 0; t < 50; t++) a.appendLocal(t, cmd(0));
    a.pruneBelow(50); // cutoff 50-256 < 0 → no prune
    expect(a.size()).toBe(50);
  });
});
