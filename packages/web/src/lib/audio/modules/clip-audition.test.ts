// Tests for the live-audition side-channel (design P0/P3): an in-memory per-node
// queue the launchpad KEYS binding pushes note edges into + the clipplayer tick
// drains. Mirrors clip-playhead's simple-store discipline (no engine, no Y.Doc).

import { describe, it, expect } from 'vitest';
import { pushAudition, drainAudition, clearAudition } from './clip-audition';

describe('clip-audition side-channel', () => {
  it('drains queued events in push order, then empties', () => {
    clearAudition('n1');
    pushAudition('n1', { lane: 0, midi: 60, velocity: 100, on: true });
    pushAudition('n1', { lane: 0, midi: 64, velocity: 90, on: true });
    pushAudition('n1', { lane: 0, midi: 60, velocity: 0, on: false });
    const out = drainAudition('n1');
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ midi: 60, on: true });
    expect(out[2]).toMatchObject({ midi: 60, on: false });
    // second drain is empty (drain clears)
    expect(drainAudition('n1')).toHaveLength(0);
  });

  it('is keyed per node — nodes never see each other', () => {
    clearAudition('a');
    clearAudition('b');
    pushAudition('a', { lane: 1, midi: 62, velocity: 80, on: true });
    expect(drainAudition('b')).toHaveLength(0);
    expect(drainAudition('a')).toHaveLength(1);
  });

  it('clearAudition drops pending events', () => {
    pushAudition('c', { lane: 0, midi: 60, velocity: 100, on: true });
    clearAudition('c');
    expect(drainAudition('c')).toHaveLength(0);
  });

  it('drain on an unknown node is an empty array (no throw)', () => {
    expect(drainAudition('never-seen')).toEqual([]);
  });
});
