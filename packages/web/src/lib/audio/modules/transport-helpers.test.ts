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
  occupiedSlots,
  resolveNavTarget,
  type SlotKey,
} from './transport-helpers';

describe('defaultSlots / coerceSlots', () => {
  it('defaults all 8 slots to null (feat/seq 8-slots)', () => {
    const s = defaultSlots();
    expect(Object.keys(s).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    for (const k of SLOT_KEYS) expect(s[k]).toBeNull();
  });

  it('backward-compat: a 4-slot save coerces with 5..8 defaulting to null', () => {
    const old = { '1': { steps: [1] }, '2': null, '3': { foo: 'bar' }, '4': null };
    const out = coerceSlots(old);
    expect(out['1']).toEqual({ steps: [1] });
    expect(out['3']).toEqual({ foo: 'bar' });
    for (const k of ['5', '6', '7', '8'] as const) expect(out[k]).toBeNull();
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

  it('coerceSlotKey accepts strings and numbers in 1..8 (feat/seq 8-slots)', () => {
    expect(coerceSlotKey('1')).toBe('1');
    expect(coerceSlotKey(2)).toBe('2');
    expect(coerceSlotKey(4)).toBe('4');
    expect(coerceSlotKey('5')).toBe('5');
    expect(coerceSlotKey(8)).toBe('8');
  });

  it('rejects out-of-range', () => {
    expect(coerceSlotKey('9')).toBeNull();
    expect(coerceSlotKey(0)).toBeNull();
    expect(coerceSlotKey(9)).toBeNull();
    expect(coerceSlotKey(2.5)).toBeNull();
    expect(coerceSlotKey('whatever')).toBeNull();
  });
});

describe('occupiedSlots', () => {
  it('returns only the keys whose snapshot is non-null, in SLOT_KEYS order', () => {
    const slots = coerceSlots({
      '1': { a: 1 }, '3': { a: 3 }, '4': { a: 4 }, '5': { a: 5 }, '6': { a: 6 },
    });
    expect(occupiedSlots(slots)).toEqual(['1', '3', '4', '5', '6']);
  });

  it('empty map → empty list', () => {
    expect(occupiedSlots(defaultSlots())).toEqual([]);
  });

  it('all occupied → all 8 keys', () => {
    const slots = coerceSlots(Object.fromEntries(SLOT_KEYS.map((k) => [k, { a: 1 }])));
    expect(occupiedSlots(slots)).toEqual([...SLOT_KEYS]);
  });
});

describe('resolveNavTarget (occupied-slot-aware NEXT / PREV / RANDOM)', () => {
  const occ = (...keys: string[]) => keys as SlotKey[];

  it('NO occupied slots → null no-op for every direction', () => {
    expect(resolveNavTarget(occ(), '3', 'next')).toBeNull();
    expect(resolveNavTarget(occ(), '3', 'prev')).toBeNull();
    expect(resolveNavTarget(occ(), null, 'random', () => 0.5)).toBeNull();
    expect(resolveNavTarget(occ(), null, 'next')).toBeNull();
  });

  it('exactly ONE occupied slot → always that slot (any direction, any current)', () => {
    expect(resolveNavTarget(occ('2'), '2', 'next')).toBe('2');
    expect(resolveNavTarget(occ('2'), '5', 'prev')).toBe('2');
    expect(resolveNavTarget(occ('2'), null, 'random', () => 0.99)).toBe('2');
    expect(resolveNavTarget(occ('7'), '7', 'next')).toBe('7');
  });

  it('NEXT walks forward through the occupied set and WRAPS last → first', () => {
    // occupied = {1,3,4,5,6}; spec example mirror of PREV.
    const o = occ('1', '3', '4', '5', '6');
    expect(resolveNavTarget(o, '1', 'next')).toBe('3');
    expect(resolveNavTarget(o, '3', 'next')).toBe('4');
    expect(resolveNavTarget(o, '4', 'next')).toBe('5');
    expect(resolveNavTarget(o, '5', 'next')).toBe('6');
    // wrap: last → first
    expect(resolveNavTarget(o, '6', 'next')).toBe('1');
  });

  it('PREV walks backward through the occupied set and WRAPS first → last', () => {
    // Spec example: occupied = {1,3,4,5,6}, playing 3 → PREV→1, another PREV→6.
    const o = occ('1', '3', '4', '5', '6');
    expect(resolveNavTarget(o, '3', 'prev')).toBe('1');
    expect(resolveNavTarget(o, '1', 'prev')).toBe('6'); // wrap first → last
    expect(resolveNavTarget(o, '6', 'prev')).toBe('5');
    expect(resolveNavTarget(o, '4', 'prev')).toBe('3');
  });

  it('current not in the occupied set (null / cleared) anchors NEXT→first, PREV→last', () => {
    const o = occ('2', '4', '7');
    expect(resolveNavTarget(o, null, 'next')).toBe('2');
    expect(resolveNavTarget(o, null, 'prev')).toBe('7');
    // '5' is not occupied → treated like "no anchor".
    expect(resolveNavTarget(o, '5', 'next')).toBe('2');
    expect(resolveNavTarget(o, '5', 'prev')).toBe('7');
  });

  it('RANDOM always lands within the occupied set (sweeps the rng range)', () => {
    const o = occ('1', '4', '6', '8');
    // rng 0 → first, just-under-1 → last, mid → middle.
    expect(resolveNavTarget(o, '4', 'random', () => 0)).toBe('1');
    expect(resolveNavTarget(o, '4', 'random', () => 0.999999)).toBe('8');
    expect(resolveNavTarget(o, '4', 'random', () => 0.5)).toBe('6');
    // Exhaustive: 1000 picks across the unit interval stay in-set.
    const set = new Set(o);
    for (let i = 0; i < 1000; i++) {
      const r = i / 1000;
      const got = resolveNavTarget(o, '4', 'random', () => r);
      expect(got).not.toBeNull();
      expect(set.has(got!)).toBe(true);
    }
  });

  it('RANDOM clamps a degenerate rng that returns exactly 1.0', () => {
    const o = occ('1', '2', '3');
    expect(resolveNavTarget(o, '1', 'random', () => 1.0)).toBe('3');
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
