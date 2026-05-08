// packages/web/src/lib/audio/euclidean.test.ts
//
// Bjorklund correctness for the DRUMSEQZ Euclidean fill slider.

import { describe, it, expect } from 'vitest';
import { bjorklund, bjorklundIndices } from './euclidean';

describe('bjorklund: edge cases', () => {
  it('k=0 yields all zeros', () => {
    expect(bjorklund(0, 16)).toEqual(new Array(16).fill(0));
    expect(bjorklund(0, 8)).toEqual(new Array(8).fill(0));
  });

  it('k=n yields all ones', () => {
    expect(bjorklund(16, 16)).toEqual(new Array(16).fill(1));
    expect(bjorklund(8, 8)).toEqual(new Array(8).fill(1));
  });

  it('n=0 yields empty array', () => {
    expect(bjorklund(0, 0)).toEqual([]);
    expect(bjorklund(5, 0)).toEqual([]);
  });

  it('clamps k > n down to n (all ones, no overflow)', () => {
    expect(bjorklund(20, 16)).toEqual(new Array(16).fill(1));
  });

  it('clamps negative k to zero', () => {
    expect(bjorklund(-3, 8)).toEqual(new Array(8).fill(0));
  });
});

describe('bjorklund: spec patterns', () => {
  it('E(4, 16) = downbeats every 4 steps', () => {
    expect(bjorklund(4, 16)).toEqual([
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ]);
  });

  it('E(5, 16) is the canonical 3-3-3-3-4 spread', () => {
    // Standard Euclidean (5,16) = 10010010010010 0 0
    // Pulses at indices 0, 3, 6, 9, 12.
    expect(bjorklund(5, 16)).toEqual([
      1, 0, 0,
      1, 0, 0,
      1, 0, 0,
      1, 0, 0,
      1, 0, 0, 0,
    ]);
  });

  it('E(3, 8) = tresillo pattern 1-0-0-1-0-0-1-0', () => {
    expect(bjorklund(3, 8)).toEqual([1, 0, 0, 1, 0, 0, 1, 0]);
  });

  it('E(2, 16) places pulses on beats 1 and 9', () => {
    const pat = bjorklund(2, 16);
    expect(pat[0]).toBe(1);
    expect(pat[8]).toBe(1);
    expect(pat.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('always downbeat-aligned (index 0 = 1 when k > 0)', () => {
    for (let k = 1; k <= 16; k++) {
      expect(bjorklund(k, 16)[0], `k=${k}`).toBe(1);
    }
  });

  it('pulse count equals k for every k in 0..n', () => {
    for (let k = 0; k <= 16; k++) {
      const pat = bjorklund(k, 16);
      const sum = pat.reduce((a, b) => a + b, 0);
      expect(sum, `k=${k}`).toBe(k);
    }
  });
});

describe('bjorklundIndices: convenience extractor', () => {
  it('E(4, 16) hits at 0, 4, 8, 12', () => {
    expect(bjorklundIndices(4, 16)).toEqual([0, 4, 8, 12]);
  });

  it('E(3, 8) hits at 0, 3, 6', () => {
    expect(bjorklundIndices(3, 8)).toEqual([0, 3, 6]);
  });

  it('E(0, 16) is empty', () => {
    expect(bjorklundIndices(0, 16)).toEqual([]);
  });
});
