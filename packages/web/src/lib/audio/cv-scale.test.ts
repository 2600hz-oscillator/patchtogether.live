// packages/web/src/lib/audio/cv-scale.test.ts
//
// Pin the CV-scaling math: at cv=-1 the param hits its (clamped) min, at
// cv=0 the knob position passes through unchanged, and at cv=+1 the param
// hits its (clamped) max. This is the "LFO sweeps full range" guarantee
// that the standard (.myrobots/plans/cv-range-standard.md) requires.

import { describe, it, expect } from 'vitest';
import { scaleCv, scaleCvDelta, buildCvCurve } from './cv-scale';
import type { ParamDef, CvScaleHint } from '$lib/graph/types';

describe('cv-scale / linear', () => {
  const hint: CvScaleHint = { mode: 'linear' };
  // ADSR sustain: 0..1, knob 0.7. cv=-1 → 0.2, cv=0 → 0.7, cv=+1 → 1.0 (clamped).
  it('cv=0 returns the knob value (no modulation)', () => {
    expect(scaleCv(0, 0.7, 0, 1, hint)).toBeCloseTo(0.7, 12);
  });
  it('cv=-1 sweeps to (or past) the min', () => {
    // knob 0.5, range 0..1, halfSpan 0.5 → cv=-1 → 0.5 - 0.5 = 0.0
    expect(scaleCv(-1, 0.5, 0, 1, hint)).toBeCloseTo(0, 12);
  });
  it('cv=+1 sweeps to (or past) the max', () => {
    expect(scaleCv(1, 0.5, 0, 1, hint)).toBeCloseTo(1, 12);
  });
  it('clamps to min/max when knob is off-center', () => {
    // ADSR sustain knob 0.7 → cv=-1 = 0.7 - 0.5 = 0.2 (in range, no clamp).
    expect(scaleCv(-1, 0.7, 0, 1, hint)).toBeCloseTo(0.2, 12);
    // cv=+1 = 0.7 + 0.5 = 1.2 (above max, clamps to 1.0).
    expect(scaleCv(1, 0.7, 0, 1, hint)).toBeCloseTo(1, 12);
  });
  it('mixmstrs EQ band ±12dB at knob=0 sweeps full ±12', () => {
    expect(scaleCv(-1, 0, -12, 12, hint)).toBeCloseTo(-12, 12);
    expect(scaleCv(1, 0, -12, 12, hint)).toBeCloseTo(12, 12);
  });
});

describe('cv-scale / log', () => {
  const hint: CvScaleHint = { mode: 'log' };
  // QBRT cutoff: 20..20000 Hz, knob 1000. cv=±1 should sweep musically.
  it('cv=0 returns the knob value (no modulation)', () => {
    expect(scaleCv(0, 1000, 20, 20000, hint)).toBeCloseTo(1000, 8);
  });
  it('cv=-1 multiplies knob by sqrt(min/max)', () => {
    // knob 1000, ratio = (20/20000)^(1/2) = 0.0316; effective ≈ 31.6.
    const v = scaleCv(-1, 1000, 20, 20000, hint);
    expect(v).toBeGreaterThan(20);
    expect(v).toBeLessThan(50);
  });
  it('cv=+1 multiplies knob by sqrt(max/min)', () => {
    const v = scaleCv(1, 1000, 20, 20000, hint);
    // knob 1000, ratio = sqrt(20000/20) = sqrt(1000) ≈ 31.6; effective ≈ 31600 → clamp 20000.
    expect(v).toBeCloseTo(20000, 0);
  });
  it('symmetric in log space — cv=±1 around geometric center', () => {
    const center = Math.sqrt(20 * 20000); // ~632.46
    const lo = scaleCv(-1, center, 20, 20000, hint);
    const hi = scaleCv(1, center, 20, 20000, hint);
    // Geometric center: cv=-1 reaches min (clamped at 20), cv=+1 reaches max (20000).
    expect(lo).toBeCloseTo(20, 1);
    expect(hi).toBeCloseTo(20000, 0);
  });
  it('ADSR attack 0.001..10s, knob 0.005s', () => {
    const lo = scaleCv(-1, 0.005, 0.001, 10, hint);
    const hi = scaleCv(1, 0.005, 0.001, 10, hint);
    // cv=-1: 0.005 / sqrt(10000) = 0.00005 → clamp 0.001.
    expect(lo).toBeCloseTo(0.001, 4);
    // cv=+1: 0.005 * sqrt(10000) = 0.5 (well within max).
    expect(hi).toBeCloseTo(0.5, 4);
  });
});

describe('cv-scale / discrete', () => {
  const hint: CvScaleHint = { mode: 'discrete' };
  // QBRT mode 0..1: cv<0 → 0, cv≥0 → 1.
  it('binary discrete: -1 → 0, +1 → 1', () => {
    expect(scaleCv(-1, 0, 0, 1, hint)).toBe(0);
    expect(scaleCv(1, 0, 0, 1, hint)).toBe(1);
  });
  it('3-state discrete: -1 → 0, 0 → 1, +1 → 2', () => {
    expect(scaleCv(-1, 0, 0, 2, hint)).toBe(0);
    expect(scaleCv(0, 0, 0, 2, hint)).toBe(1);
    expect(scaleCv(1, 0, 0, 2, hint)).toBe(2);
  });
});

describe('cv-scale / passthrough', () => {
  it('preserves legacy sum-into-AudioParam behavior', () => {
    expect(scaleCv(-1, 0.7, 0, 1, { mode: 'passthrough' })).toBeCloseTo(-0.3, 12);
    expect(scaleCv(0, 0.7, 0, 1, { mode: 'passthrough' })).toBeCloseTo(0.7, 12);
    expect(scaleCv(1, 0.7, 0, 1, { mode: 'passthrough' })).toBeCloseTo(1.7, 12);
  });
});

describe('cv-scale / depth', () => {
  it('depth=0.5 halves the modulation amplitude', () => {
    const hint: CvScaleHint = { mode: 'linear', depth: 0.5 };
    // sustain 0.5, range 0..1, halfSpan 0.5 × 0.5 = 0.25 sweep around knob.
    expect(scaleCv(-1, 0.5, 0, 1, hint)).toBeCloseTo(0.25, 12);
    expect(scaleCv(1, 0.5, 0, 1, hint)).toBeCloseTo(0.75, 12);
  });
  it('depth=0 produces no modulation', () => {
    const hint: CvScaleHint = { mode: 'linear', depth: 0 };
    expect(scaleCv(-1, 0.5, 0, 1, hint)).toBeCloseTo(0.5, 12);
    expect(scaleCv(1, 0.5, 0, 1, hint)).toBeCloseTo(0.5, 12);
  });
});

describe('cv-scale / scaleCvDelta (audio-graph delta)', () => {
  it('delta=0 at cv=0 (no modulation)', () => {
    expect(scaleCvDelta(0, 0.7, 0, 1, { mode: 'linear' })).toBeCloseTo(0, 12);
  });
  it('delta is bounded by half-span at cv=±1 for linear', () => {
    expect(scaleCvDelta(1, 0.5, 0, 1, { mode: 'linear' })).toBeCloseTo(0.5, 12);
    expect(scaleCvDelta(-1, 0.5, 0, 1, { mode: 'linear' })).toBeCloseTo(-0.5, 12);
  });
});

describe('cv-scale / buildCvCurve (WaveShaper LUT)', () => {
  it('curve length is 4096 (matches CURVE_LEN)', () => {
    const c = buildCvCurve(0, 1, 0.5, { mode: 'linear' });
    expect(c.length).toBe(4096);
  });
  it('curve[0] (cv=-1) and curve[end] (cv=+1) span the full delta range', () => {
    // ADSR sustain 0..1, knob 0.5: cv=-1 → delta -0.5; cv=+1 → delta +0.5.
    const c = buildCvCurve(0, 1, 0.5, { mode: 'linear' });
    expect(c[0]).toBeCloseTo(-0.5, 5);
    expect(c[c.length - 1]).toBeCloseTo(0.5, 5);
  });
  it('curve[mid] (cv≈0) is ~0 (no modulation at cv=0)', () => {
    const c = buildCvCurve(0, 1, 0.5, { mode: 'linear' });
    const mid = c[Math.floor(c.length / 2)];
    expect(mid).toBeCloseTo(0, 3);
  });
  it('log curve clamps within [min-knob, max-knob]', () => {
    // cutoff 20..20000, knob 1000.
    const c = buildCvCurve(20, 20000, 1000, { mode: 'log' });
    // cv=-1: effective 1000/sqrt(1000) ≈ 31.6, delta ≈ -968.
    expect(c[0]).toBeGreaterThan(-1000);
    expect(c[0]).toBeLessThan(-900);
    // cv=+1: effective ≈ 31623 → clamp 20000, delta = 19000.
    expect(c[c.length - 1]).toBeCloseTo(19000, 0);
  });
});

// Sanity smoke: real ParamDef → buildCvCurve doesn't throw and produces
// a finite, non-zero spread.
describe('cv-scale / integration', () => {
  it('builds a valid curve for a real ADSR attack ParamDef', () => {
    const adsrAttack: ParamDef = {
      id: 'attack',
      label: 'A',
      defaultValue: 0.005,
      min: 0.001,
      max: 10,
      curve: 'log',
    };
    const c = buildCvCurve(adsrAttack.min, adsrAttack.max, adsrAttack.defaultValue, { mode: 'log' });
    let allFinite = true;
    let spread = 0;
    let lo = Infinity, hi = -Infinity;
    for (const v of c) {
      if (!Number.isFinite(v)) allFinite = false;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    spread = hi - lo;
    expect(allFinite).toBe(true);
    expect(spread).toBeGreaterThan(0.01);
  });

  // Regression for the e2e cv-range-uniformity ADSR-attack failure: the
  // LUT MUST be built around the runtime knob value, not the static
  // ParamDef.defaultValue. ADSR attack defaults to 0.005s; if the user
  // turns the knob to 0.1s and patches an LFO, cv=+1 should sweep up to
  // 0.1 × √(10000) = 10s (clamped to the param's max). With the bug,
  // the LUT was always built at knob=0.005, capping cv=+1 at 0.5s and
  // making `sweep.max ≥ 0.5` an unreliable threshold.
  it('builds the curve at the live knob position, not the def default', () => {
    const adsrAttack: ParamDef = {
      id: 'attack',
      label: 'A',
      defaultValue: 0.005,
      min: 0.001,
      max: 10,
      curve: 'log',
    };
    const liveKnob = 0.1;
    const c = buildCvCurve(adsrAttack.min, adsrAttack.max, liveKnob, { mode: 'log' });
    // cv=+1 with knob=0.1 → effective 10s; delta = 10 - 0.1 = 9.9.
    expect(c[c.length - 1]).toBeCloseTo(9.9, 1);
    // Sanity: cv=-1 should clamp at min (0.001), delta = 0.001 - 0.1 = -0.099.
    expect(c[0]).toBeCloseTo(-0.099, 3);
  });
});
