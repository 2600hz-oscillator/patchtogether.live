// packages/web/src/lib/audio/modules/transport-helpers.test.ts

import { describe, it, expect } from 'vitest';
import {
  SLOT_KEYS,
  defaultSlots,
  coerceSlots,
  coercePendingMode,
  coerceSlotKey,
  createRisingEdgeDetector,
  isInputPortConnected,
  isRisingEdge,
  resolveSlotClick,
  shouldSequencerRun,
} from './transport-helpers';

describe('defaultSlots / coerceSlots', () => {
  it('defaults all 4 slots to null', () => {
    const s = defaultSlots();
    expect(Object.keys(s).sort()).toEqual(['1', '2', '3', '4']);
    for (const k of SLOT_KEYS) expect(s[k]).toBeNull();
  });

  it('coerces null / undefined / non-objects to defaults', () => {
    expect(coerceSlots(null)).toEqual(defaultSlots());
    expect(coerceSlots(undefined)).toEqual(defaultSlots());
    expect(coerceSlots(42)).toEqual(defaultSlots());
    expect(coerceSlots('whatever')).toEqual(defaultSlots());
    expect(coerceSlots([])).toEqual(defaultSlots());
  });

  it('preserves slot snapshots when present', () => {
    const raw = { '1': { steps: [1, 2, 3], length: 16 }, '3': { foo: 'bar' } };
    const out = coerceSlots(raw);
    expect(out['1']).toEqual({ steps: [1, 2, 3], length: 16 });
    expect(out['2']).toBeNull();
    expect(out['3']).toEqual({ foo: 'bar' });
    expect(out['4']).toBeNull();
  });

  it('rejects array / primitive slot values (replaces them with null)', () => {
    const raw = { '1': [1, 2, 3], '2': 5, '3': 'string' };
    const out = coerceSlots(raw);
    expect(out['1']).toBeNull();
    expect(out['2']).toBeNull();
    expect(out['3']).toBeNull();
  });
});

describe('coercePendingMode / coerceSlotKey', () => {
  it('accepts the three valid pending modes', () => {
    expect(coercePendingMode('save')).toBe('save');
    expect(coercePendingMode('load')).toBe('load');
    expect(coercePendingMode('queue')).toBe('queue');
  });

  it('rejects unknown values', () => {
    expect(coercePendingMode('whatever')).toBeNull();
    expect(coercePendingMode(null)).toBeNull();
    expect(coercePendingMode(123)).toBeNull();
  });

  it('coerceSlotKey accepts strings and numbers in 1..4', () => {
    expect(coerceSlotKey('1')).toBe('1');
    expect(coerceSlotKey(2)).toBe('2');
    expect(coerceSlotKey(4)).toBe('4');
  });

  it('rejects out-of-range', () => {
    expect(coerceSlotKey('5')).toBeNull();
    expect(coerceSlotKey(0)).toBeNull();
    expect(coerceSlotKey('whatever')).toBeNull();
  });
});

describe('createRisingEdgeDetector', () => {
  it('counts a single rising edge inside a window', () => {
    const d = createRisingEdgeDetector(0.5);
    const buf = new Float32Array([0, 0, 0.6, 0.6, 0]);
    expect(d.scan(buf, 0, buf.length)).toBe(1);
  });

  it('counts multiple edges', () => {
    const d = createRisingEdgeDetector(0.5);
    const buf = new Float32Array([0, 0.7, 0, 0.7, 0, 0.8]);
    expect(d.scan(buf, 0, buf.length)).toBe(3);
  });

  it('does not double-count a held-high signal', () => {
    const d = createRisingEdgeDetector(0.5);
    const buf = new Float32Array([0, 0.6, 0.6, 0.6, 0.6, 0.6]);
    expect(d.scan(buf, 0, buf.length)).toBe(1);
  });

  it('remembers cross-tick state — a held high across two scans counts once', () => {
    const d = createRisingEdgeDetector(0.5);
    const buf1 = new Float32Array([0, 0.6, 0.6]);
    const buf2 = new Float32Array([0.6, 0.6, 0]);
    expect(d.scan(buf1, 0, buf1.length)).toBe(1);
    expect(d.scan(buf2, 0, buf2.length)).toBe(0);
  });

  it('reset() forgets cross-tick state', () => {
    const d = createRisingEdgeDetector(0.5);
    const buf1 = new Float32Array([0.6]);
    expect(d.scan(buf1, 0, 1)).toBe(1);
    d.reset();
    // Now `last` is 0 again — a buffer starting at 0.6 reads as a rising edge.
    expect(d.scan(new Float32Array([0.6]), 0, 1)).toBe(1);
  });

  it('respects fromIdx — only scans the new-samples window', () => {
    const d = createRisingEdgeDetector(0.5);
    const buf = new Float32Array([0.6, 0, 0.6, 0]);
    // Scanning only the second half: starts at 0.6 (treated as edge from
    // initial last=0), then 0 (drop) — exactly 1 edge.
    expect(d.scan(buf, 2, buf.length)).toBe(1);
  });

  it('isRisingEdge predicate matches the detector behavior', () => {
    expect(isRisingEdge(0, 0.6)).toBe(true);
    expect(isRisingEdge(0.6, 0.7)).toBe(false);
    expect(isRisingEdge(0.4, 0.4)).toBe(false);
    expect(isRisingEdge(0.4, 0.6)).toBe(true);
  });
});

describe('resolveSlotClick', () => {
  it('routes save / load / queue to their kinds', () => {
    expect(resolveSlotClick('save', '2')).toEqual({ kind: 'save', slot: '2' });
    expect(resolveSlotClick('load', '3')).toEqual({ kind: 'load', slot: '3' });
    expect(resolveSlotClick('queue', '4')).toEqual({ kind: 'queue', slot: '4' });
  });

  it('returns noop for null pending', () => {
    expect(resolveSlotClick(null, '1')).toEqual({ kind: 'noop' });
  });
});

describe('isInputPortConnected', () => {
  const edges = [
    { target: { nodeId: 'seqA', portId: 'clock' } },
    { target: { nodeId: 'seqA', portId: 'play_cv' } },
    { target: { nodeId: 'seqB', portId: 'clock' } },
  ];

  it('returns true when an edge terminates at (nodeId, portId)', () => {
    expect(isInputPortConnected(edges, 'seqA', 'clock')).toBe(true);
    expect(isInputPortConnected(edges, 'seqA', 'play_cv')).toBe(true);
    expect(isInputPortConnected(edges, 'seqB', 'clock')).toBe(true);
  });

  it('returns false when no edge matches', () => {
    expect(isInputPortConnected(edges, 'seqA', 'reset_cv')).toBe(false);
    expect(isInputPortConnected(edges, 'seqB', 'play_cv')).toBe(false);
    expect(isInputPortConnected(edges, 'nope', 'clock')).toBe(false);
  });

  it('tolerates undefined / null entries in the edge list', () => {
    expect(isInputPortConnected([null, undefined, ...edges], 'seqA', 'clock')).toBe(true);
    expect(isInputPortConnected([null, undefined], 'seqA', 'clock')).toBe(false);
    expect(isInputPortConnected([], 'seqA', 'clock')).toBe(false);
  });
});

describe('shouldSequencerRun (transport state truth table)', () => {
  // PR fix/clock-without-play — these cases lock the orthogonality contract
  // between play_cv and the clock input. The bug PR-82 introduced was that
  // the sequencer's tick was gated on `playing` alone, so a patched-but-
  // unplayed clock couldn't drive the sequencer.

  it('runs whenever playing is true (regardless of patches)', () => {
    expect(shouldSequencerRun(true, false, false)).toBe(true);
    expect(shouldSequencerRun(true, true,  false)).toBe(true);
    expect(shouldSequencerRun(true, false, true )).toBe(true);
    expect(shouldSequencerRun(true, true,  true )).toBe(true);
  });

  it('clock-only mode: clock patched, play_cv NOT patched, isPlaying=false → runs', () => {
    // The bug fix: this used to return false. Now the clock pulses ARE the
    // play signal in this configuration.
    expect(shouldSequencerRun(false, true, false)).toBe(true);
  });

  it('play_cv patched: respect play_cv state (do NOT run on clock alone)', () => {
    // play_cv patched + low (isPlaying=false) → stay stopped, even if clock
    // is also patched. play_cv overrides.
    expect(shouldSequencerRun(false, true,  true)).toBe(false);
    expect(shouldSequencerRun(false, false, true)).toBe(false);
  });

  it('nothing patched + not playing → stopped', () => {
    expect(shouldSequencerRun(false, false, false)).toBe(false);
  });
});
