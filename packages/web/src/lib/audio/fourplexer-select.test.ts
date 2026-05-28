// packages/web/src/lib/audio/fourplexer-select.test.ts
//
// Unit tests for the pure 4PLEXER selector-advance logic — gate edge →
// next index, with 3 → 0 wrap. Fast + deterministic; the worklet carries
// an inlined mirror of fourplexerNextSelector and the unit test pins the
// canonical wrap rule here.

import { describe, it, expect } from 'vitest';
import {
  fourplexerNextSelector,
  fourplexerClampSelector,
  fourplexerAdvanceBy,
  FOURPLEXER_INPUTS,
} from './fourplexer-select';

describe('fourplexerNextSelector — gate advance', () => {
  it('advances 0→1→2→3 then wraps 3→0', () => {
    expect(fourplexerNextSelector(0)).toBe(1);
    expect(fourplexerNextSelector(1)).toBe(2);
    expect(fourplexerNextSelector(2)).toBe(3);
    expect(fourplexerNextSelector(3)).toBe(0);
  });

  it('a full cycle of 4 advances returns to the start', () => {
    let idx = 0;
    for (let i = 0; i < FOURPLEXER_INPUTS; i++) idx = fourplexerNextSelector(idx);
    expect(idx).toBe(0);
  });

  it('normalises out-of-range / non-integer inputs before advancing', () => {
    expect(fourplexerNextSelector(4)).toBe(1); // 4 ≡ 0 → next 1
    expect(fourplexerNextSelector(-1)).toBe(0); // -1 ≡ 3 → next 0
    expect(fourplexerNextSelector(2.4)).toBe(3); // rounds to 2 → next 3
    expect(fourplexerNextSelector(2.6)).toBe(0); // rounds to 3 → next 0 (wrap)
  });
});

describe('fourplexerClampSelector', () => {
  it('keeps valid indices', () => {
    for (const i of [0, 1, 2, 3]) expect(fourplexerClampSelector(i)).toBe(i);
  });
  it('wraps + rounds out-of-range values into 0..3', () => {
    expect(fourplexerClampSelector(4)).toBe(0);
    expect(fourplexerClampSelector(5)).toBe(1);
    expect(fourplexerClampSelector(-1)).toBe(3);
    expect(fourplexerClampSelector(2.5)).toBe(3);
  });
  it('defaults non-finite values to 0 (corrupt saved param)', () => {
    expect(fourplexerClampSelector(NaN)).toBe(0);
    expect(fourplexerClampSelector(Infinity)).toBe(0);
  });
});

describe('fourplexerAdvanceBy — multi-pulse wrap', () => {
  it('5 pulses from 0 lands on 1 (one full wrap + 1)', () => {
    expect(fourplexerAdvanceBy(0, 5)).toBe(1);
  });
  it('0 pulses is a no-op (after clamp)', () => {
    expect(fourplexerAdvanceBy(2, 0)).toBe(2);
  });
  it('8 pulses from any start returns to that start (two full cycles)', () => {
    for (const start of [0, 1, 2, 3]) {
      expect(fourplexerAdvanceBy(start, 8)).toBe(start);
    }
  });
});
