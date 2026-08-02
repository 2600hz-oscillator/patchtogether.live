// packages/web/src/lib/ui/modules/manual-gate-latch.test.ts
//
// The held-gate latch, proved as a state machine. The claim under test is not
// "the functions return plausible objects" — it is THE INVARIANT: after any
// sequence of opens, closes and panics, a node is either open in the state or
// has had a `closed` report handed to the caller. A gate that is neither is the
// forever-rolling drum.

import { describe, it, expect } from 'vitest';
import {
  closeGate,
  emptyGateLatch,
  isGateOpen,
  openGate,
  panicGates,
  type GateLatchState,
} from './manual-gate-latch';

describe('manual gate latch — the held-audition state machine', () => {
  it('opens and closes one node, reporting each edge exactly once', () => {
    const a = openGate(emptyGateLatch(), 'n1');
    expect(a.opened, 'the first press OPENS').toBe(true);
    expect(isGateOpen(a.state, 'n1')).toBe(true);

    const b = closeGate(a.state, 'n1');
    expect(b.closed, 'the release CLOSES').toBe(true);
    expect(isGateOpen(b.state, 'n1')).toBe(false);
  });

  it('a repeated press does NOT re-open (no duplicate openGate at one timestamp)', () => {
    const a = openGate(emptyGateLatch(), 'n1');
    const again = openGate(a.state, 'n1');
    expect(again.opened, 'the second press is a no-op').toBe(false);
    expect(again.state.open, 'and it does not double-list the node').toEqual(['n1']);
  });

  it('a SECOND close is a no-op — the button release and the window panic both fire', () => {
    // The real sequence on an ordinary pointerup: <Button> dispatches
    // onGate(false) AND the window-level pointerup panic runs. Both call in.
    const held = openGate(emptyGateLatch(), 'n1').state;
    const viaButton = closeGate(held, 'n1');
    expect(viaButton.closed).toBe(true);
    const viaPanic = closeGate(viaButton.state, 'n1');
    expect(viaPanic.closed, 'the redundant close reports NOTHING to do').toBe(false);
    expect(viaPanic.state.open).toEqual([]);
  });

  it('closing a node that never rolled is a no-op', () => {
    const r = closeGate(emptyGateLatch(), 'ghost');
    expect(r.closed).toBe(false);
    expect(r.state.open).toEqual([]);
  });

  it('two nodes hold INDEPENDENTLY — closing one leaves the other rolling', () => {
    // Two snaredrums can share the dock (fullViewNodeIds is a Set), and a
    // multi-touch player can hold both pads. An "at most one" latch would
    // silently kill the first drum's roll on the second press.
    let s: GateLatchState = emptyGateLatch();
    s = openGate(s, 'n1').state;
    s = openGate(s, 'n2').state;
    expect([...s.open].sort()).toEqual(['n1', 'n2']);

    const closed = closeGate(s, 'n1');
    expect(closed.closed).toBe(true);
    expect(isGateOpen(closed.state, 'n1')).toBe(false);
    expect(isGateOpen(closed.state, 'n2'), 'the other hand is still rolling').toBe(true);
  });

  it('PANIC returns EVERY open gate, in open order, and empties the latch', () => {
    let s: GateLatchState = emptyGateLatch();
    s = openGate(s, 'n1').state;
    s = openGate(s, 'n2').state;
    s = openGate(s, 'n3').state;
    s = closeGate(s, 'n2').state;

    const p = panicGates(s);
    expect(p.closed, 'the panic hands the caller exactly the gates it must close').toEqual(['n1', 'n3']);
    expect(p.state.open, 'and the latch is empty afterwards').toEqual([]);
  });

  it('PANIC is idempotent — a second panic closes nothing', () => {
    const s = openGate(emptyGateLatch(), 'n1').state;
    const first = panicGates(s);
    expect(first.closed).toEqual(['n1']);
    const second = panicGates(first.state);
    expect(second.closed).toEqual([]);
    expect(second.state.open).toEqual([]);
  });

  it('THE INVARIANT: no sequence can leave a gate open that was never reported closed', () => {
    // The property the whole module exists for, swept over a deterministic
    // pseudo-random script rather than the three hand-picked orders above.
    // `net` counts opens minus reported closes per node; at the end, a node
    // with net > 0 MUST still be listed as open (i.e. still reachable by a
    // panic). A node with net > 0 and NOT open is a leaked gate.
    let s: GateLatchState = emptyGateLatch();
    const net = new Map<string, number>();
    const ids = ['a', 'b', 'c'];
    let seed = 20260802;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);

    for (let i = 0; i < 500; i++) {
      const id = ids[next() % ids.length]!;
      const op = next() % 10;
      if (op < 5) {
        const r = openGate(s, id);
        s = r.state;
        if (r.opened) net.set(id, (net.get(id) ?? 0) + 1);
      } else if (op < 9) {
        const r = closeGate(s, id);
        s = r.state;
        if (r.closed) net.set(id, (net.get(id) ?? 0) - 1);
      } else {
        const r = panicGates(s);
        s = r.state;
        for (const n of r.closed) net.set(n, (net.get(n) ?? 0) - 1);
      }
      // Every open must be balanced by a report, or still be open.
      for (const [n, v] of net) {
        expect(v, `${n}: net open/closed reports must be 0 or 1, got ${v}`).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(
          v === 1,
          `${n}: net=${v} but isGateOpen=${isGateOpen(s, n)} — an unreported open gate ROLLS FOREVER`,
        ).toBe(isGateOpen(s, n));
      }
    }
  });

  it('NEGATIVE CONTROL: the invariant sweep can actually FAIL', () => {
    // A property test that cannot fail is decoration. Re-run the sweep against
    // a DELIBERATELY LEAKY panic (one that empties the latch but reports only
    // the FIRST gate) and assert the invariant clause catches it. This is the
    // exact bug shape — state says "nothing held", the engine still has a gate
    // open — and it must be visible to the assertion above.
    const leakyPanic = (state: GateLatchState) => ({
      state: emptyGateLatch(),
      closed: state.open.slice(0, 1),
    });

    let s: GateLatchState = emptyGateLatch();
    s = openGate(s, 'a').state;
    s = openGate(s, 'b').state;
    const p = leakyPanic(s);
    s = p.state;
    const net = new Map<string, number>([['a', 1], ['b', 1]]);
    for (const n of p.closed) net.set(n, (net.get(n) ?? 0) - 1);

    // 'b' reads net=1 (an open gate the caller was never told about) while
    // isGateOpen(s,'b') is false — precisely the clause the sweep asserts.
    expect(net.get('b')).toBe(1);
    expect(isGateOpen(s, 'b')).toBe(false);
    expect(
      () => expect(net.get('b') === 1).toBe(isGateOpen(s, 'b')),
      'the invariant clause must reject a leaked gate',
    ).toThrow();
  });
});
