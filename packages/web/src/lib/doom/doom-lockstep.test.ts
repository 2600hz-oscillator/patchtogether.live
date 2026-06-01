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
import {
  LockstepTransport,
  ticLogName,
  computeBarrierFloor,
  type TicSet,
} from './doom-lockstep';

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

// ─────────────────────────────────────────────────────────────────────────────
// Issue #348 — BARRIER-FLOOR pruning keeps the shared log BOUNDED over a long
// run without ever dropping a tic a live peer still needs.
// ─────────────────────────────────────────────────────────────────────────────

describe('computeBarrierFloor', () => {
  it('floor = min consolidated tic across all live slots', () => {
    expect(computeBarrierFloor([100, 95, 110], 3)).toBe(95);
    expect(computeBarrierFloor([42, 42], 2)).toBe(42);
  });

  it('a live slot with NO report (undefined) forces floor to 0 (hold back)', () => {
    // Slot 1 hasn't published its consolidated tic yet → never prune.
    expect(computeBarrierFloor([100, undefined], 2)).toBe(0);
    // Reported slots above numPlayers don't help if a live slot is missing.
    expect(computeBarrierFloor([undefined, 50], 2)).toBe(0);
  });

  it('ignores reports beyond numPlayers and rejects invalid values', () => {
    expect(computeBarrierFloor([10, 20, 5 /* slot 2 not live */], 2)).toBe(10);
    expect(computeBarrierFloor([NaN, 5], 2)).toBe(0);
    expect(computeBarrierFloor([-1, 5], 2)).toBe(0);
  });

  it('numPlayers<=0 → 0', () => {
    expect(computeBarrierFloor([], 0)).toBe(0);
  });
});

describe('LockstepTransport — barrier-floor pruning (issue #348)', () => {
  it('pruneBelowFloor drops only tics strictly below the floor', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 1 });
    for (let t = 0; t < 100; t++) a.appendLocal(t, cmd(t & 0x7f));
    a.pruneBelowFloor(40); // tics 0..39 consumed by all peers
    expect(a.oldestTic()).toBe(40);
    expect(a.size()).toBe(60);
  });

  it('floor=0 (a slow/unknown peer) prunes NOTHING', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 1 });
    for (let t = 0; t < 100; t++) a.appendLocal(t, cmd(0));
    a.pruneBelowFloor(0);
    expect(a.size()).toBe(100); // conservative: nothing dropped
  });

  it('NEVER drops a tic a slow peer still needs (floor held back by slowest)', () => {
    const doc = new Y.Doc();
    const fast = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 2 });
    const slow = new LockstepTransport({ doc, moduleId: MID, slot: 1, numPlayers: 2 });
    // Both produce inputs through tic 199, but the slow peer has only
    // consolidated up to tic 50 (its recvtic) — so floor = 50.
    for (let t = 0; t < 200; t++) {
      fast.appendLocal(t, cmd(1));
      slow.appendLocal(t, cmd(-1));
    }
    const floor = computeBarrierFloor([200, 50], 2);
    expect(floor).toBe(50);
    fast.pruneBelowFloor(floor);
    // Tic 50 (the slow peer's next-awaited tic) MUST still be present.
    expect(fast.oldestTic()).toBe(50);
    // The slow peer can still consolidate tic 50 onward from the shared log.
    const stillThere = doc.getArray(ticLogName(MID)).toArray() as { t: number; s: number }[];
    expect(stillThere.some((e) => e.t === 50 && e.s === 1)).toBe(true);
  });

  it('log length PLATEAUS over a long 2-peer run (does not grow linearly)', () => {
    const doc = new Y.Doc();
    const arbiter = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 2 });
    const peer = new LockstepTransport({ doc, moduleId: MID, slot: 1, numPlayers: 2 });

    // Simulate a long game: 35Hz for ~60s = 2100 tics. Both peers consolidate
    // in lockstep with a small fixed lag (each "recvtic" trails appended by 6,
    // the input-delay). Every ~2s (70 tics) the arbiter prunes below the floor.
    const TOTAL = 2100;
    const LAG = 6;
    let sizeAtSteadyState = -1;
    for (let t = 0; t < TOTAL; t++) {
      arbiter.appendLocal(t, cmd(1));
      peer.appendLocal(t, cmd(-1));
      // Both peers have consolidated everything up to (t - LAG): floor = t-LAG.
      const recvtic = Math.max(0, t - LAG);
      if (t % 70 === 0 && t > 0) {
        const floor = computeBarrierFloor([recvtic, recvtic], 2);
        arbiter.pruneBelowFloor(floor);
        // Record the plateau size at a representative mid-run prune.
        if (t === 1050) sizeAtSteadyState = arbiter.size();
      }
    }
    // Final prune at the end.
    arbiter.pruneBelowFloor(computeBarrierFloor([TOTAL - LAG, TOTAL - LAG], 2));

    // If the log grew unbounded it would hold ~2 × TOTAL = 4200 entries. With
    // floor pruning it stays a small multiple of (LAG + prune-interval) × peers.
    expect(arbiter.size()).toBeLessThan(200);
    // Mid-run size is the SAME order as end-of-run size (plateau, not linear).
    expect(sizeAtSteadyState).toBeGreaterThan(0);
    expect(sizeAtSteadyState).toBeLessThan(200);
    // Shared state stays intact: the log still consolidates correctly for tics
    // at/after the floor — the tic right after the last floor is reconstructable.
    const floorTic = TOTAL - LAG;
    const idx = arbiter.drainReady(floorTic, () => {});
    expect(idx).toBeGreaterThanOrEqual(floorTic); // no corruption / off-by-one
  });

  it('HARD CAP bounds the log even when a wedged peer pins the floor at 0', () => {
    const doc = new Y.Doc();
    const a = new LockstepTransport({ doc, moduleId: MID, slot: 0, numPlayers: 2 });
    // A peer wedged forever: floor stays 0 the whole game. Append a huge run.
    const TOTAL = 35 * 60; // 60s at 35Hz = 2100 tics, well past the ~1050 cap.
    for (let t = 0; t < TOTAL; t++) a.appendLocal(t, cmd(0));
    a.pruneBelowFloor(0); // floor 0 → floor prune drops nothing, hard cap fires
    // Hard cap keeps ≈ MAX_KEEP_TICS_HARD_CAP (1050) tics of history, not all 2100.
    expect(a.size()).toBeLessThanOrEqual(35 * 30 + 1);
    expect(a.size()).toBeGreaterThan(0);
    // The most-recent tics survive (those a recovering peer would need first):
    // newest tic is TOTAL-1, cap cutoff = newest - 1050, so oldest kept = cutoff.
    const newest = TOTAL - 1;
    expect(a.oldestTic()).toBe(newest - 35 * 30);
  });
});
