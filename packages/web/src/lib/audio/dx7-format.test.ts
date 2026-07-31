// packages/web/src/lib/audio/dx7-format.test.ts

import { describe, it, expect } from 'vitest';
import {
  DX7_RATIO_PREFIX,
  dx7DetuneFromSigned,
  dx7DetuneSigned,
  dx7FormatDetune,
  dx7FormatFrequency,
  dx7FormatHz,
  dx7FormatLevel,
  dx7FormatRate,
  dx7FormatRatio,
  dx7FormatSeconds,
  dx7LevelDbValue,
  dx7RateToSeconds,
} from './dx7-format';
import { DX7_EG_RATE0_FULL_SCALE_S, dx7FixedHz, dx7LevelToDb, dx7Ratio } from './dx7-syx';

describe('frequency readout', () => {
  it('resolves coarse/fine to the ratio the spec asks for', () => {
    expect(dx7FormatFrequency(3, 2)).toBe('×3.06'); // the spec's own example
    expect(dx7FormatFrequency(1, 0)).toBe('×1.00');
    expect(dx7FormatFrequency(0, 0)).toBe('×0.50'); // coarse 0 is the half-pitch base
    expect(dx7FormatFrequency(14, 0)).toBe('×14.0');
    expect(DX7_RATIO_PREFIX).toBe('×');
  });

  it('agrees with dx7Ratio for every reachable (coarse, fine) pair', () => {
    for (let c = 0; c <= 31; c++) {
      for (let f = 0; f <= 99; f += 7) {
        expect(dx7FormatFrequency(c, f)).toBe(dx7FormatRatio(dx7Ratio(c, f)));
      }
    }
  });

  it('FIXED mode reads absolute Hz, not a ratio — coarse picks the decade', () => {
    expect(dx7FormatFrequency(0, 0, true)).toBe('1.00 Hz');
    expect(dx7FormatFrequency(1, 0, true)).toBe('10.0 Hz');
    expect(dx7FormatFrequency(2, 0, true)).toBe('100 Hz');
    expect(dx7FormatFrequency(3, 0, true)).toBe('1.00 kHz');
    expect(dx7FormatFrequency(3, 99, true)).toBe('9.77 kHz'); // the top of the range
    // coarse is masked to two bits in fixed mode: 4, 8, 12 all read as 1 Hz.
    for (const c of [0, 4, 8, 12, 16]) expect(dx7FormatFrequency(c, 0, true)).toBe('1.00 Hz');
    expect(dx7FormatFrequency(2, 50, true)).toBe(dx7FormatHz(dx7FixedHz(2, 50)));
  });

  it('never returns a ratio string in fixed mode, or a Hz string in ratio mode', () => {
    for (let c = 0; c <= 31; c += 3) {
      expect(dx7FormatFrequency(c, 0, true)).not.toContain(DX7_RATIO_PREFIX);
      expect(dx7FormatFrequency(c, 0, false)).toContain(DX7_RATIO_PREFIX);
      expect(dx7FormatFrequency(c, 0, false)).not.toContain('Hz');
    }
  });

  it('clamps garbage rather than printing NaN', () => {
    for (const v of [NaN, Infinity, -5, 999]) {
      expect(dx7FormatFrequency(v, 0)).not.toContain('NaN');
      expect(dx7FormatFrequency(0, v)).not.toContain('NaN');
      expect(dx7FormatHz(v)).not.toContain('NaN');
      expect(dx7FormatRatio(v)).not.toContain('NaN');
    }
  });
});

describe('level readout', () => {
  it('99 is unity and the scale is the project\'s own 0.75 dB per step', () => {
    expect(dx7FormatLevel(99)).toBe('0.0 dB');
    expect(dx7FormatLevel(91)).toBe(`${dx7LevelToDb(91).toFixed(1)} dB`);
    expect(dx7FormatLevel(91)).toBe('-6.0 dB');
    expect(dx7FormatLevel(50)).toBe('-36.8 dB');
  });

  it('level 0 reads "off", because it is a HARD zero and not merely quiet', () => {
    expect(dx7FormatLevel(0)).toBe('off');
    expect(dx7LevelDbValue(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(dx7LevelDbValue(1)).toBeCloseTo(-73.5, 6);
  });

  it('is monotonic across the whole 0..99 scale', () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (let l = 1; l <= 99; l++) {
      const db = dx7LevelDbValue(l);
      expect(db).toBeGreaterThan(prev);
      prev = db;
    }
  });
});

describe('detune readout', () => {
  it('displays SIGNED -7..+7 from the stored 0..14 byte, with 7 as centre', () => {
    expect(dx7DetuneSigned(7)).toBe(0);
    expect(dx7DetuneSigned(0)).toBe(-7);
    expect(dx7DetuneSigned(14)).toBe(7);
    expect(dx7FormatDetune(7)).toBe('0');
    expect(dx7FormatDetune(14)).toBe('+7');
    expect(dx7FormatDetune(0)).toBe('-7');
    expect(dx7FormatDetune(4)).toBe('-3');
    expect(dx7FormatDetune(10)).toBe('+3');
  });

  it('round-trips signed -> stored -> signed for the whole range', () => {
    for (let s = -7; s <= 7; s++) expect(dx7DetuneSigned(dx7DetuneFromSigned(s))).toBe(s);
    for (let b = 0; b <= 14; b++) expect(dx7DetuneFromSigned(dx7DetuneSigned(b))).toBe(b);
  });

  it('clamps out-of-range input to the real domain', () => {
    expect(dx7DetuneSigned(-5)).toBe(-7);
    expect(dx7DetuneSigned(99)).toBe(7);
    expect(dx7DetuneFromSigned(-99)).toBe(0);
    expect(dx7DetuneFromSigned(99)).toBe(14);
  });
});

describe('rate readout', () => {
  it('rate 0 is 317.487 s — NOT 90 s', () => {
    expect(dx7RateToSeconds(0)).toBeCloseTo(DX7_EG_RATE0_FULL_SCALE_S, 3);
    expect(dx7FormatRate(0)).toBe('5m 17s');
    expect(dx7FormatRate(0)).not.toContain('90');
  });

  it('rate 99 is the fastest — a few milliseconds', () => {
    const t = dx7RateToSeconds(99);
    expect(t).toBeGreaterThan(0.004);
    expect(t).toBeLessThan(0.007);
    expect(dx7FormatRate(99)).toBe('5.5 ms');
  });

  it('is monotonically FASTER as the byte rises — the DX7\'s famous inversion', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let r = 0; r <= 99; r++) {
      const t = dx7RateToSeconds(r);
      expect(t).toBeLessThanOrEqual(prev);
      prev = t;
    }
    // and the whole scale spans four orders of magnitude
    expect(dx7RateToSeconds(0) / dx7RateToSeconds(99)).toBeGreaterThan(10000);
  });

  it('formats each magnitude band readably', () => {
    expect(dx7FormatSeconds(0.0055)).toBe('5.5 ms');
    expect(dx7FormatSeconds(0.248)).toBe('248 ms');
    expect(dx7FormatSeconds(2.48)).toBe('2.48 s');
    expect(dx7FormatSeconds(59.9)).toBe('59.90 s');
    expect(dx7FormatSeconds(317.487)).toBe('5m 17s');
    expect(dx7FormatSeconds(NaN)).toBe('0.0 ms');
    expect(dx7FormatSeconds(-1)).toBe('0.0 ms');
    expect(dx7FormatSeconds(Infinity)).toBe('0.0 ms');
  });
});
