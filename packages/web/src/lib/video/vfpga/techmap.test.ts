// packages/web/src/lib/video/vfpga/techmap.test.ts
//
// Pure unit tests for the LUT technology-mapper (A5).

import { describe, expect, it } from 'vitest';
import { compileLut, lutInitToTruthTable } from './techmap';

/** Reference truth-table builder (independent of the parser) for cross-checks. */
function ref(fn: (a: number, b: number, c: number, d: number) => boolean): number {
  let init = 0;
  for (let i = 0; i < 16; i++) {
    if (fn(i & 1, (i >> 1) & 1, (i >> 2) & 1, (i >> 3) & 1)) init |= 1 << i;
  }
  return init >>> 0;
}

describe('compileLut', () => {
  it('reproduces databend-cvbs 0x6996 from 4-input parity (the readable form)', () => {
    expect(compileLut('a ^ b ^ c ^ d')).toBe(0x6996);
  });

  it('single variables map to the right bit pattern', () => {
    expect(compileLut('a')).toBe(ref((a) => a === 1));
    expect(compileLut('b')).toBe(ref((_a, b) => b === 1));
    expect(compileLut('c')).toBe(ref((_a, _b, c) => c === 1));
    expect(compileLut('d')).toBe(ref((_a, _b, _c, d) => d === 1));
  });

  it('constants: 0 → all-zero, 1 → all-ones (0xFFFF)', () => {
    expect(compileLut('0')).toBe(0);
    expect(compileLut('1')).toBe(0xffff);
  });

  it('and / or / not / xor match a reference evaluator', () => {
    expect(compileLut('a & b')).toBe(ref((a, b) => a === 1 && b === 1));
    expect(compileLut('a | b')).toBe(ref((a, b) => a === 1 || b === 1));
    expect(compileLut('~a')).toBe(ref((a) => a === 0));
    expect(compileLut('!a')).toBe(ref((a) => a === 0));
    expect(compileLut('a ^ b')).toBe(ref((a, b) => (a === 1) !== (b === 1)));
  });

  it('respects precedence (~ > & > ^ > |) and parens', () => {
    // a | b & c  ==  a | (b & c)
    expect(compileLut('a | b & c')).toBe(ref((a, b, c) => a === 1 || (b === 1 && c === 1)));
    expect(compileLut('(a | b) & c')).toBe(ref((a, b, c) => (a === 1 || b === 1) && c === 1));
    // ~a & b  ==  (~a) & b
    expect(compileLut('~a & b')).toBe(ref((a, b) => a === 0 && b === 1));
    // a ^ b & c  ==  a ^ (b & c)
    expect(compileLut('a ^ b & c')).toBe(ref((a, b, c) => (a === 1) !== (b === 1 && c === 1)));
  });

  it('is whitespace-insensitive', () => {
    expect(compileLut('a^b')).toBe(compileLut('  a   ^ b '));
  });

  it('always returns a 16-bit unsigned value', () => {
    const v = compileLut('a | b | c | d | ~a');
    expect(v).toBe(0xffff);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffff);
  });

  it('throws on malformed expressions', () => {
    expect(() => compileLut('')).toThrow();
    expect(() => compileLut('a &')).toThrow();
    expect(() => compileLut('(a | b')).toThrow();
    expect(() => compileLut('a b')).toThrow(); // trailing
    expect(() => compileLut('z')).toThrow(); // unknown var
  });
});

describe('lutInitToTruthTable', () => {
  it('is the inverse view of an INIT (round-trips parity)', () => {
    const t = lutInitToTruthTable(0x6996);
    expect(t).toHaveLength(16);
    // parity: output set iff popcount(idx) is odd
    for (let i = 0; i < 16; i++) {
      const pop = ((i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1)) % 2;
      expect(t[i]).toBe(pop === 1);
    }
  });
});
