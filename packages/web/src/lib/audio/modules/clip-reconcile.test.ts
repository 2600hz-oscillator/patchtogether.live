// packages/web/src/lib/audio/modules/clip-reconcile.test.ts
//
// The per-machine stale-note RECONCILE channel (redesign §3.1) — push (deduped
// per lane) / drain / clear, mirroring clip-audition.ts.

import { describe, it, expect } from 'vitest';
import { pushReconcile, drainReconcile, clearReconcile } from './clip-reconcile';

describe('clip-reconcile', () => {
  it('drains what was pushed, in order', () => {
    pushReconcile('n1', { lane: 0 });
    pushReconcile('n1', { lane: 3 });
    expect(drainReconcile('n1')).toEqual([{ lane: 0 }, { lane: 3 }]);
    expect(drainReconcile('n1')).toEqual([]); // drained
  });
  it('DEDUPES repeated removals on the same lane into one reconcile', () => {
    pushReconcile('n2', { lane: 2 });
    pushReconcile('n2', { lane: 2 });
    pushReconcile('n2', { lane: 2 });
    expect(drainReconcile('n2')).toEqual([{ lane: 2 }]);
    clearReconcile('n2');
  });
  it('is isolated per node and cleared on dispose', () => {
    pushReconcile('a', { lane: 1 });
    pushReconcile('b', { lane: 5 });
    clearReconcile('a');
    expect(drainReconcile('a')).toEqual([]);
    expect(drainReconcile('b')).toEqual([{ lane: 5 }]);
  });
  it('an unknown node drains empty', () => {
    expect(drainReconcile('nope')).toEqual([]);
  });
});
