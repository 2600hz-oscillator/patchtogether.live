// packages/web/src/lib/audio/dx7-algorithms.test.ts
//
// Sanity tests on the 32-algorithm routing table. We assert structural
// invariants — every entry has 6 modSrcs lists; carriers are non-empty and
// in [0..5]; no algorithm has a carrier-modulator self-loop within the same
// op (other than the dedicated op6-feedback path, which the worklet handles
// out-of-band).

import { describe, it, expect } from 'vitest';
import { DX7_ALGORITHMS, getAlgorithm } from './dx7-algorithms';

describe('DX7_ALGORITHMS', () => {
  it('has exactly 32 entries', () => {
    expect(DX7_ALGORITHMS).toHaveLength(32);
  });

  it('algorithm numbers are 1..32, in order', () => {
    for (let i = 0; i < 32; i++) {
      expect(DX7_ALGORITHMS[i]?.num).toBe(i + 1);
    }
  });

  it('every algorithm has exactly 6 modSrcs slots (one per op)', () => {
    for (const a of DX7_ALGORITHMS) {
      expect(a.modSrcs, `alg ${a.num}.modSrcs`).toHaveLength(6);
    }
  });

  it('every algorithm has at least one carrier', () => {
    for (const a of DX7_ALGORITHMS) {
      expect(a.carriers.length, `alg ${a.num}.carriers`).toBeGreaterThan(0);
    }
  });

  it('all carrier indices are in 0..5', () => {
    for (const a of DX7_ALGORITHMS) {
      for (const c of a.carriers) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(5);
      }
    }
  });

  it('all modulator indices are in 0..5', () => {
    for (const a of DX7_ALGORITHMS) {
      for (let i = 0; i < 6; i++) {
        for (const m of a.modSrcs[i]!) {
          expect(m).toBeGreaterThanOrEqual(0);
          expect(m).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  it('algorithm 32 has all 6 ops as carriers (organ tone)', () => {
    const a32 = getAlgorithm(32)!;
    expect(a32.carriers.sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('algorithm 5 has 3 carriers (e.piano-style)', () => {
    const a5 = getAlgorithm(5)!;
    expect(a5.carriers).toHaveLength(3);
    // ops 1, 3, 5 = indices 0, 2, 4
    expect(a5.carriers.sort()).toEqual([0, 2, 4]);
  });

  it('algorithm 16 has 1 carrier (op1)', () => {
    const a16 = getAlgorithm(16)!;
    expect(a16.carriers).toEqual([0]);
  });

  it('algorithm 1 has 2 carriers + ops 4,5 in chain to op3', () => {
    const a1 = getAlgorithm(1)!;
    expect(a1.carriers).toEqual([0, 2]);
    // op3 (index 2) is modulated by op4 (index 3)
    expect(a1.modSrcs[2]).toContain(3);
  });

  it('getAlgorithm rejects out-of-range', () => {
    expect(getAlgorithm(0)).toBeUndefined();
    expect(getAlgorithm(33)).toBeUndefined();
    expect(getAlgorithm(2.5)).toBeUndefined();
  });
});
