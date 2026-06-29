// packages/dsp/src/lib/moog-filterbank-dsp.test.ts
//
// Pins the shared Moog FIXED-FILTER-BANK data table (914 / 907A). This core is
// DATA-ONLY (1/3-octave-ish band centers + Q + the bandN param-id contract);
// the filtering itself is native BiquadFilterNodes, so there's no per-sample
// math to assert — but the FREQUENCY GRID is a documented fact a typo could
// silently corrupt (a wrong center detunes a band; a wrong count desyncs the
// def's `params` array from the factory's gain map). It was the last extracted
// `lib/` core without a DIRECT test (covered only indirectly via moog907a/914),
// so this closes that gap. Deterministic + pure → zero flake risk.

import { describe, it, expect } from 'vitest';
import {
  FILTERBANK_Q,
  FILTERBANK_914_CENTERS,
  FILTERBANK_907A_CENTERS,
  FILTERBANK_914_LP_HZ,
  FILTERBANK_914_HP_HZ,
  FILTERBANK_907A_LP_HZ,
  FILTERBANK_907A_HP_HZ,
  bandParamId,
} from './moog-filterbank-dsp';

describe('FILTERBANK_Q', () => {
  it('is the shared narrow-ish 1/3-octave Q (4)', () => {
    expect(FILTERBANK_Q).toBe(4);
  });
});

describe('914 centers (System 55 extended bank)', () => {
  it('pins the twelve documented Moog-914 band centers (Hz)', () => {
    expect(FILTERBANK_914_CENTERS).toEqual([
      125, 175, 250, 350, 500, 700, 1000, 1400, 2000, 2800, 4000, 5600,
    ]);
  });
  it('is strictly ascending with a consistent ~1/3-to-1/2-octave step', () => {
    for (let i = 1; i < FILTERBANK_914_CENTERS.length; i++) {
      const ratio = FILTERBANK_914_CENTERS[i]! / FILTERBANK_914_CENTERS[i - 1]!;
      expect(ratio).toBeGreaterThan(1.25);
      expect(ratio).toBeLessThan(1.5);
    }
  });
});

describe('907A centers (System 35 standard bank)', () => {
  it('pins the eight documented 907A band centers (Hz)', () => {
    expect(FILTERBANK_907A_CENTERS).toEqual([250, 350, 500, 700, 1000, 1400, 2000, 2800]);
  });
  it('is a contiguous subset of the 914 grid (they share one grid + factory)', () => {
    for (const c of FILTERBANK_907A_CENTERS) {
      expect(FILTERBANK_914_CENTERS).toContain(c);
    }
  });
});

describe('end-shelf corners bracket the bandpass cells', () => {
  it('914: LP below the lowest band, HP above the highest', () => {
    expect(FILTERBANK_914_LP_HZ).toBeLessThan(FILTERBANK_914_CENTERS[0]!);
    expect(FILTERBANK_914_HP_HZ).toBeGreaterThan(
      FILTERBANK_914_CENTERS[FILTERBANK_914_CENTERS.length - 1]!,
    );
  });
  it('907A: LP below the lowest band, HP above the highest', () => {
    expect(FILTERBANK_907A_LP_HZ).toBeLessThan(FILTERBANK_907A_CENTERS[0]!);
    expect(FILTERBANK_907A_HP_HZ).toBeGreaterThan(
      FILTERBANK_907A_CENTERS[FILTERBANK_907A_CENTERS.length - 1]!,
    );
  });
  it('the 914 (extended) shelves span wider than the 907A (standard) shelves', () => {
    expect(FILTERBANK_914_LP_HZ).toBeLessThan(FILTERBANK_907A_LP_HZ);
    expect(FILTERBANK_914_HP_HZ).toBeGreaterThan(FILTERBANK_907A_HP_HZ);
  });
});

describe('bandParamId — def/factory lock-step contract', () => {
  it('is band${n} (1-based)', () => {
    expect(bandParamId(1)).toBe('band1');
    expect(bandParamId(8)).toBe('band8');
    expect(bandParamId(12)).toBe('band12');
  });
  it('produces a unique id per band across the full 914 width', () => {
    const ids = FILTERBANK_914_CENTERS.map((_, i) => bandParamId(i + 1));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
