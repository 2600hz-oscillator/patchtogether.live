// packages/web/src/lib/audio/modules/midiclock.test.ts
//
// Unit tests for MIDICLOCK pure helpers + divider semantics. Avoids
// AudioContext / Web MIDI plumbing; the factory itself is exercised
// transitively via the e2e smoke spec.

import { describe, it, expect } from 'vitest';
import {
  CLOCK_DIVISORS,
  MIDI_PPQN,
  divisorLabel,
  isSystemRealTime,
  isValidDivisor,
} from './midiclock';

describe('isSystemRealTime', () => {
  it('returns true for 0xF8..0xFF', () => {
    for (let b = 0xf8; b <= 0xff; b++) {
      expect(isSystemRealTime(b)).toBe(true);
    }
  });

  it('returns false for channel-voice and SysEx ranges', () => {
    // Note on, note off, CC, pitch-bend (any channel), SysEx start.
    for (const b of [0x80, 0x90, 0xb0, 0xe0, 0xf0, 0xf7]) {
      expect(isSystemRealTime(b)).toBe(false);
    }
  });
});

describe('CLOCK_DIVISORS', () => {
  it('contains exactly the five allowed values', () => {
    expect([...CLOCK_DIVISORS]).toEqual([24, 12, 6, 3, 1]);
  });

  it('matches the MIDI_PPQN constant for the quarter-note divisor', () => {
    expect(CLOCK_DIVISORS[0]).toBe(MIDI_PPQN);
  });

  it('isValidDivisor accepts allowed values and rejects others', () => {
    for (const d of CLOCK_DIVISORS) expect(isValidDivisor(d)).toBe(true);
    for (const bad of [0, 2, 4, 5, 8, 16, 25, -1, 1.5, 'raw', null, undefined]) {
      expect(isValidDivisor(bad)).toBe(false);
    }
  });
});

describe('divisorLabel', () => {
  it('maps each divisor to its musical label', () => {
    expect(divisorLabel(24)).toBe('1/4');
    expect(divisorLabel(12)).toBe('1/8');
    expect(divisorLabel(6)).toBe('1/16');
    expect(divisorLabel(3)).toBe('1/32');
    expect(divisorLabel(1)).toBe('raw');
  });
});

describe('divider semantics (modeled outside the factory)', () => {
  // Re-implementation of the factory's tickCounter logic so we can
  // pin the "every Nth tick fires an edge" invariant without booting
  // an AudioContext. The real factory does the same arithmetic; if it
  // ever diverges from this model the e2e spec will catch it.
  function runTicks(numTicks: number, divisor: number): number {
    let counter = 0;
    let edges = 0;
    for (let i = 0; i < numTicks; i++) {
      counter++;
      if (counter >= divisor) {
        counter = 0;
        edges++;
      }
    }
    return edges;
  }

  it('emits one edge per quarter at the default divisor (24)', () => {
    // 4 bars × 4 beats × 24 ticks = 384 input ticks → 16 edges
    expect(runTicks(MIDI_PPQN * 16, 24)).toBe(16);
  });

  it('emits two edges per quarter for the eighth-note divisor (12)', () => {
    expect(runTicks(MIDI_PPQN * 4, 12)).toBe(8);
  });

  it('emits one edge per input tick at the raw divisor (1)', () => {
    expect(runTicks(100, 1)).toBe(100);
  });

  it('drops the partial-count remainder when the input cuts short', () => {
    // 23 ticks at divisor=24 → no edge fired yet
    expect(runTicks(23, 24)).toBe(0);
    // 47 ticks at divisor=24 → one edge (at tick 24); remainder of 23 doesn't fire
    expect(runTicks(47, 24)).toBe(1);
  });
});
