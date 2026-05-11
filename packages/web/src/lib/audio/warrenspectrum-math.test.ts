// packages/web/src/lib/audio/warrenspectrum-math.test.ts
//
// Pure-math tests for the WARRENSPECTRUM DSP. The worklet (packages/dsp/
// src/warrenspectrum.ts) inlines its own copies of these functions;
// equivalence is asserted behaviorally via the unit + ART scenarios.

import { describe, it, expect } from 'vitest';
import {
  WARRENSPECTRUM_NUM_BANDS,
  WARRENSPECTRUM_BLEED,
  WARRENSPECTRUM_CENTER_HZ,
  applyPing,
  bleedWeight,
  biquadBpfCoeffs,
  makeEnv,
  stepEnv,
  vactrolShape,
} from './warrenspectrum-math';

describe('bleed matrix', () => {
  it('distance 0 → 1.0, distance 1 → 0.35, distance 2 → 0.12, distance ≥ 3 → 0', () => {
    expect(bleedWeight(4, 4)).toBe(1.0);
    expect(bleedWeight(4, 3)).toBe(0.35);
    expect(bleedWeight(4, 5)).toBe(0.35);
    expect(bleedWeight(4, 2)).toBe(0.12);
    expect(bleedWeight(4, 6)).toBe(0.12);
    expect(bleedWeight(4, 1)).toBe(0);
    expect(bleedWeight(4, 7)).toBe(0);
  });

  it('applyPing seeds excitation on bands 2..6 when band 4 is pinged', () => {
    const envs = Array.from({ length: WARRENSPECTRUM_NUM_BANDS }, () => makeEnv());
    let r = 0;
    const rand = (): number => {
      // Sequence chosen so jitter doesn't change the truthy assertions
      // (always 0.5 → jitter coefficient = 1.0).
      r = (r + 1) % 4;
      return 0.5;
    };
    applyPing(envs, 4, 0.2, 20, 48000, rand);

    // Bands 2..6 received excitation in the documented ratios.
    expect(envs[4]!.excitation).toBeCloseTo(WARRENSPECTRUM_BLEED[0]!, 6);
    expect(envs[3]!.excitation).toBeCloseTo(WARRENSPECTRUM_BLEED[1]!, 6);
    expect(envs[5]!.excitation).toBeCloseTo(WARRENSPECTRUM_BLEED[1]!, 6);
    expect(envs[2]!.excitation).toBeCloseTo(WARRENSPECTRUM_BLEED[2]!, 6);
    expect(envs[6]!.excitation).toBeCloseTo(WARRENSPECTRUM_BLEED[2]!, 6);

    // Bands 0, 1, 7 untouched.
    expect(envs[0]!.excitation).toBe(0);
    expect(envs[1]!.excitation).toBe(0);
    expect(envs[7]!.excitation).toBe(0);

    // Each touched band has phase=attack and a valid attackSamples count.
    for (const idx of [2, 3, 4, 5, 6]) {
      expect(envs[idx]!.phase).toBe(1);
      expect(envs[idx]!.attackSamples).toBeGreaterThan(0);
      expect(envs[idx]!.decayCoef).toBeGreaterThan(0);
      expect(envs[idx]!.decayCoef).toBeLessThan(1);
    }
  });

  it('ping at band 0 only affects bands 0..2 (clamped, no wraparound)', () => {
    const envs = Array.from({ length: WARRENSPECTRUM_NUM_BANDS }, () => makeEnv());
    applyPing(envs, 0, 0.2, 20, 48000, () => 0.5);
    expect(envs[0]!.excitation).toBeCloseTo(1.0, 6);
    expect(envs[1]!.excitation).toBeCloseTo(0.35, 6);
    expect(envs[2]!.excitation).toBeCloseTo(0.12, 6);
    expect(envs[3]!.excitation).toBe(0);
    expect(envs[7]!.excitation).toBe(0);
  });

  it('ping at band 7 only affects bands 5..7', () => {
    const envs = Array.from({ length: WARRENSPECTRUM_NUM_BANDS }, () => makeEnv());
    applyPing(envs, 7, 0.2, 20, 48000, () => 0.5);
    expect(envs[7]!.excitation).toBeCloseTo(1.0, 6);
    expect(envs[6]!.excitation).toBeCloseTo(0.35, 6);
    expect(envs[5]!.excitation).toBeCloseTo(0.12, 6);
    expect(envs[4]!.excitation).toBe(0);
    expect(envs[0]!.excitation).toBe(0);
  });
});

describe('vactrol envelope shape', () => {
  it('vactrolShape is monotonic increasing, hits ~1.0 at env=1 (drive=4)', () => {
    expect(vactrolShape(0, 4)).toBe(0);
    expect(vactrolShape(1, 4)).toBeCloseTo(1.0, 6);
    let prev = -1;
    for (let env = 0; env <= 1; env += 0.05) {
      const y = vactrolShape(env, 4);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1.0);
      prev = y;
    }
  });

  it('stepEnv produces a soft-attack then exponential-decay shape', () => {
    const e = makeEnv();
    // Direct ping at band 0 only — short decay (50ms) so the trace
    // settles cleanly inside our 1.5-second window even after the
    // tanh-shaping stretches the perceived tail.
    applyPing([e], 0, 0.05, 20, 48000, () => 0.5);

    const trace: number[] = [];
    const totalSamples = Math.round(1.5 * 48000); // 1.5s window
    for (let i = 0; i < totalSamples; i++) {
      trace.push(stepEnv(e, 4));
    }

    // Attack: first ~20ms (~960 samples) should rise from 0 to peak.
    const attackEnd = e.attackSamples;
    const peak = Math.max(...trace);
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThanOrEqual(1.0);

    // Trace starts at 0, climbs to peak during attack.
    expect(trace[0]).toBeGreaterThanOrEqual(0);
    expect(trace[Math.min(attackEnd, trace.length - 1)]!).toBeGreaterThan(0.5);

    // Decay: monotone descent across post-attack samples.
    // pingDecay = 0.05s → decay coefficient takes us to near-zero
    // within ~10 time constants ≈ 500 ms.
    const idxA = attackEnd + 100;
    const idxB = attackEnd + 1000;
    const idxC = attackEnd + 5000;
    expect(trace[idxA]).toBeGreaterThan(trace[idxB]!);
    expect(trace[idxB]).toBeGreaterThan(trace[idxC]!);
    // And the very last sample is essentially 0 (decay coefficient
    // takes us under 1e-5 well within the 1500ms window).
    expect(trace[trace.length - 1]).toBeLessThan(0.05);
  });

  it('attack jitter keeps attack within ±10% of base', () => {
    // Force the random to extremes and confirm attack samples stay in bounds.
    for (const fixed of [0, 0.5, 1]) {
      const envs = [makeEnv()];
      applyPing(envs, 0, 0.2, 20, 48000, () => fixed);
      const expectedJitter = 1 + (fixed - 0.5) * 0.2; // 0.9, 1.0, 1.1
      const expectedSamples = Math.round((20 * expectedJitter / 1000) * 48000);
      expect(envs[0]!.attackSamples).toBe(expectedSamples);
    }
  });
});

describe('biquad bandpass coefficients', () => {
  it('Center frequencies are octave-spaced 80..10240 Hz', () => {
    expect(WARRENSPECTRUM_CENTER_HZ.length).toBe(8);
    for (let i = 1; i < WARRENSPECTRUM_CENTER_HZ.length; i++) {
      const ratio = WARRENSPECTRUM_CENTER_HZ[i]! / WARRENSPECTRUM_CENTER_HZ[i - 1]!;
      expect(ratio).toBeCloseTo(2.0, 6);
    }
  });

  it('Biquad coefficients are finite + a0-normalized', () => {
    for (const fc of WARRENSPECTRUM_CENTER_HZ) {
      const c = biquadBpfCoeffs(fc, 6.0, 48000);
      for (const v of [c.b0, c.b1, c.b2, c.a1, c.a2]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      // RBJ bandpass: b1 == 0; b0 == -b2 (alpha symmetry).
      expect(c.b1).toBeCloseTo(0, 12);
      expect(c.b0).toBeCloseTo(-c.b2, 12);
    }
  });

  it('Biquad bandpass peak frequency response matches center freq', () => {
    // Pick band 3 (640 Hz). Compute |H(e^jw)| at several frequencies;
    // peak should be near fc. We use the closed-form transfer function
    // H(z) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2).
    const sr = 48000;
    const fc = WARRENSPECTRUM_CENTER_HZ[3]!;
    const c = biquadBpfCoeffs(fc, 6.0, sr);

    function mag(f: number): number {
      const w = (2 * Math.PI * f) / sr;
      const cos1 = Math.cos(-w);
      const sin1 = Math.sin(-w);
      const cos2 = Math.cos(-2 * w);
      const sin2 = Math.sin(-2 * w);
      // numerator
      const nr = c.b0 + c.b1 * cos1 + c.b2 * cos2;
      const ni = c.b1 * sin1 + c.b2 * sin2;
      // denominator
      const dr = 1 + c.a1 * cos1 + c.a2 * cos2;
      const di = c.a1 * sin1 + c.a2 * sin2;
      // |num| / |den|
      const num = Math.sqrt(nr * nr + ni * ni);
      const den = Math.sqrt(dr * dr + di * di);
      return num / den;
    }

    const mFc = mag(fc);
    // Skirts: 2 octaves below/above should be considerably attenuated.
    expect(mag(fc / 4)).toBeLessThan(mFc * 0.5);
    expect(mag(fc * 4)).toBeLessThan(mFc * 0.5);
    // Peak gain is ~1 (RBJ "constant 0dB peak" parameterization).
    expect(mFc).toBeGreaterThan(0.9);
    expect(mFc).toBeLessThan(1.1);
  });
});
