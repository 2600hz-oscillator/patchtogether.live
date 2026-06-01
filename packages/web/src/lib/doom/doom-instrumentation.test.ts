// packages/web/src/lib/doom/doom-instrumentation.test.ts
//
// Guards the monotonic, remount-proof counter store (FAILURE 2 fix). The probe
// measures the awareness flood by baseline-then-final subtraction; if the
// counters reset to 0 mid-run (a card remount) that subtraction went NEGATIVE.
// These counters are module-scoped + keyed by node id so they survive a remount
// and only ever increase.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  bumpAwarenessUpdate,
  bumpElectionRecompute,
  bumpTiccmdWrite,
  readCounters,
  __resetDoomCounters,
} from './doom-instrumentation';

describe('doom-instrumentation — monotonic, remount-proof counters', () => {
  beforeEach(() => __resetDoomCounters());

  it('starts at zero for an unseen node', () => {
    expect(readCounters('n1')).toEqual({
      awarenessUpdateCount: 0,
      electionRecomputeCount: 0,
      ticcmdWriteCount: 0,
    });
  });

  it('bumps increment monotonically and return the new value', () => {
    expect(bumpAwarenessUpdate('n1')).toBe(1);
    expect(bumpAwarenessUpdate('n1')).toBe(2);
    expect(bumpElectionRecompute('n1')).toBe(1);
    expect(bumpTiccmdWrite('n1')).toBe(1);
    expect(bumpTiccmdWrite('n1')).toBe(2);
    expect(readCounters('n1')).toEqual({
      awarenessUpdateCount: 2,
      electionRecomputeCount: 1,
      ticcmdWriteCount: 2,
    });
  });

  it('keeps separate counts per node id', () => {
    bumpAwarenessUpdate('a');
    bumpAwarenessUpdate('a');
    bumpAwarenessUpdate('b');
    expect(readCounters('a').awarenessUpdateCount).toBe(2);
    expect(readCounters('b').awarenessUpdateCount).toBe(1);
  });

  it('SURVIVES a "remount": a fresh card reusing the same id keeps counting up', () => {
    // Simulate the original DoomCard lifecycle: a component instance bumps,
    // then unmounts. The counters live in module scope (not the closure), so a
    // re-created instance reusing the SAME node id sees the accumulated total —
    // it does NOT reset to 0. This is precisely what stops the probe's
    // (end - baseline) aggregate from going negative on a mid-run remount.
    bumpAwarenessUpdate('shared');
    bumpAwarenessUpdate('shared');
    const baseline = readCounters('shared').awarenessUpdateCount; // 2
    // ...component remounts (no reset)...
    bumpAwarenessUpdate('shared');
    const final = readCounters('shared').awarenessUpdateCount; // 3
    expect(baseline).toBe(2);
    expect(final).toBe(3);
    expect(final - baseline).toBeGreaterThanOrEqual(0); // never negative
  });

  it('readCounters returns a copy (caller cannot mutate the store)', () => {
    bumpAwarenessUpdate('n1');
    const snap = readCounters('n1');
    snap.awarenessUpdateCount = 999;
    expect(readCounters('n1').awarenessUpdateCount).toBe(1);
  });
});
