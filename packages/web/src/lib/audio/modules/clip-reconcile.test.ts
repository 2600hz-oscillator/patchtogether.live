// packages/web/src/lib/audio/modules/clip-reconcile.test.ts
//
// The per-machine stale-note RECONCILE channel (redesign §3.1) — push (merged
// per lane) / drain / clear, plus the SHARED removal-detect helper both editors
// (Launchpad + card) call. Set-difference detection (B2/N4): a poly voice-steal
// with unchanged count is still a removal.

import { describe, it, expect } from 'vitest';
import {
  pushReconcile,
  drainReconcile,
  clearReconcile,
  reconcileClipRemoval,
} from './clip-reconcile';
import { clipIndex, type NoteClipRecord, type ClipPlayerData } from './clip-types';

const NODE = 'rn';
function clip(steps: NoteClipRecord['steps']): NoteClipRecord {
  return { kind: 'note', steps, lengthSteps: 16, root: 48, loop: true };
}

describe('clip-reconcile queue', () => {
  it('drains what was pushed, carrying the erased steps', () => {
    pushReconcile('n1', { lane: 0, steps: [4] });
    pushReconcile('n1', { lane: 3, steps: [1, 2] });
    expect(drainReconcile('n1')).toEqual([
      { lane: 0, steps: [4] },
      { lane: 3, steps: [1, 2] },
    ]);
    expect(drainReconcile('n1')).toEqual([]); // drained
  });
  it('MERGES repeated removals on the same lane into one reconcile (UNION of steps)', () => {
    pushReconcile('n2', { lane: 2, steps: [4] });
    pushReconcile('n2', { lane: 2, steps: [4, 7] });
    pushReconcile('n2', { lane: 2, steps: [9] });
    expect(drainReconcile('n2')).toEqual([{ lane: 2, steps: [4, 7, 9] }]);
    clearReconcile('n2');
  });
  it('is isolated per node and cleared on dispose', () => {
    pushReconcile('a', { lane: 1, steps: [0] });
    pushReconcile('b', { lane: 5, steps: [3] });
    clearReconcile('a');
    expect(drainReconcile('a')).toEqual([]);
    expect(drainReconcile('b')).toEqual([{ lane: 5, steps: [3] }]);
  });
  it('an unknown node drains empty', () => {
    expect(drainReconcile('nope')).toEqual([]);
  });
});

describe('reconcileClipRemoval — shared removal-detect + publish', () => {
  const idx = clipIndex(0, 0); // lane 0, slot 0
  const data: ClipPlayerData = { playing: [0, null, null, null, null, null, null, null] };

  it('publishes the erased STEPS when a note is removed from a PLAYING clip', () => {
    clearReconcile(NODE);
    const prev = clip([{ step: 4, midi: 60 }, { step: 6, midi: 62 }]);
    const next = clip([{ step: 6, midi: 62 }]); // removed step 4
    reconcileClipRemoval(NODE, prev, next, idx, data);
    expect(drainReconcile(NODE)).toEqual([{ lane: 0, steps: [4] }]);
  });

  it('detects a poly voice-STEAL with UNCHANGED length (set-difference, not length compare — N4)', () => {
    clearReconcile(NODE);
    const prev = clip([{ step: 3, midi: 60 }, { step: 3, midi: 64 }]);
    const next = clip([{ step: 3, midi: 64 }, { step: 3, midi: 67 }]); // dropped 60, added 67
    reconcileClipRemoval(NODE, prev, next, idx, data);
    expect(drainReconcile(NODE)).toEqual([{ lane: 0, steps: [3] }]); // step 3 lost an onset
  });

  it('does NOT publish for a pure ADD', () => {
    clearReconcile(NODE);
    const prev = clip([{ step: 4, midi: 60 }]);
    const next = clip([{ step: 4, midi: 60 }, { step: 5, midi: 62 }]);
    reconcileClipRemoval(NODE, prev, next, idx, data);
    expect(drainReconcile(NODE)).toEqual([]);
  });

  it('does NOT publish when the edited clip is NOT the one playing on its lane', () => {
    clearReconcile(NODE);
    const notPlaying: ClipPlayerData = { playing: [1, null, null, null, null, null, null, null] }; // slot 1, not 0
    const prev = clip([{ step: 4, midi: 60 }]);
    const next = clip([]);
    reconcileClipRemoval(NODE, prev, next, idx, notPlaying);
    expect(drainReconcile(NODE)).toEqual([]);
  });

  it('a clear-clip publishes every removed step (deduped)', () => {
    clearReconcile(NODE);
    const prev = clip([{ step: 1, midi: 60 }, { step: 4, midi: 62 }, { step: 4, midi: 65 }]);
    const next = clip([]);
    reconcileClipRemoval(NODE, prev, next, idx, data);
    const drained = drainReconcile(NODE);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.lane).toBe(0);
    expect(new Set(drained[0]!.steps)).toEqual(new Set([1, 4])); // deduped
  });
});
