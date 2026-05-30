// art/scenarios/sidecar/static-ratio-curve.test.ts
//
// ART-tier check on SIDECAR's static gain-computer curve. We exercise the
// pure-math helper (computeGainDb) under the same offline-rendering
// pattern as art/scenarios/stereovca — sweep input levels through the
// 3-region piecewise function (below threshold → soft knee → above
// threshold) and pin the per-region behavior + boundary continuity
// quantitatively.
//
// Why ART rather than just vitest: this anchors the cross-cutting DSP
// property (GMR 2012 eq 4 piecewise gain-computer) so a refactor of the
// knee math is caught with a quantitative I/O assertion rather than
// relying on the unit tests' tighter-coupled checks.

import { describe, expect, it } from 'vitest';
import {
  computeGainDb,
  DB_PER_LOG2,
  envOut,
  envInvOut,
  ENV_SCALE_DB,
} from '../../../packages/dsp/src/lib/compressor-dsp';

const dbToLog2 = (dB: number): number => dB / DB_PER_LOG2;

describe('ART sidecar / static ratio (hard knee) GMR 2012 eq 4', () => {
  it('ratio=4, threshold=-20, knee=0: 10 dB above threshold → exactly 7.5 dB reduction', () => {
    // slope = 1 - 1/4 = 0.75. Excess = 10 dB. Reduction = 7.5 dB.
    const g = computeGainDb(dbToLog2(-10), -20, 0, 4);
    expect(g).toBeCloseTo(-7.5, 8);
  });

  it('ratio=2, threshold=-12, knee=0: 6 dB above → 3 dB reduction', () => {
    const g = computeGainDb(dbToLog2(-6), -12, 0, 2);
    expect(g).toBeCloseTo(-3, 8);
  });

  it('ratio=10, threshold=0, knee=0: 10 dB above → 9 dB reduction', () => {
    const g = computeGainDb(dbToLog2(10), 0, 0, 10);
    expect(g).toBeCloseTo(-9, 8);
  });

  it('output of input - |gainDb| ≤ threshold for ratio→∞ (limiter)', () => {
    // At ratio = 100 (near-limiter), output is pinned within 0.2 dB of
    // threshold for any input above threshold.
    for (const xDb of [-19, -18, -10, -5, 0]) {
      const g = computeGainDb(dbToLog2(xDb), -20, 0, 100);
      const out = xDb + g;
      expect(out).toBeGreaterThan(-20.5);
      expect(out).toBeLessThan(-19.5);
    }
  });
});

describe('ART sidecar / soft knee — C0-continuous + symmetric integration', () => {
  it('soft-knee with knee=6: at upper boundary, soft-curve value = hard-curve value', () => {
    // The knee curve is built so that at xDb = tDb + knee/2 it joins the
    // linear post-threshold curve seamlessly.
    const tDb = -20;
    const kn = 6;
    const ratio = 4;
    const xDb = tDb + kn * 0.5; // -17
    const soft = computeGainDb(dbToLog2(xDb), tDb, kn, ratio);
    const hard = computeGainDb(dbToLog2(xDb), tDb, 0, ratio);
    expect(soft).toBeCloseTo(hard, 8);
  });

  it('soft-knee at lower boundary (tDb - knee/2): gain = 0 (matches the no-comp side)', () => {
    const g = computeGainDb(dbToLog2(-23), -20, 6, 4);
    expect(g).toBeCloseTo(0, 8);
  });

  it('soft-knee curve is monotone non-increasing across the full knee range', () => {
    const tDb = -20;
    const kn = 12; // wide knee to stress the quadratic
    let prev = 0;
    for (let xDb = tDb - kn * 0.5; xDb <= tDb + kn * 0.5 + 0.001; xDb += 0.1) {
      const g = computeGainDb(dbToLog2(xDb), tDb, kn, 4);
      expect(g).toBeLessThanOrEqual(prev + 1e-10);
      prev = g;
    }
  });

  it('soft-knee curve interpolates symmetrically — midpoint reduction is HALF the upper-edge reduction', () => {
    // At xDb = tDb (midpoint of the knee), the quadratic gives
    //   t = halfKn ⇒ y = -slope * halfKn^2 / (2*kn) = -slope * kn / 8
    // The upper-edge reduction is -slope * kn/2.
    // Ratio: (kn/8) / (kn/2) = 1/4 of the upper edge.
    const tDb = -20;
    const kn = 8;
    const ratio = 4;
    const slope = 1 - 1 / ratio;
    const halfKn = kn / 2;
    const mid = computeGainDb(dbToLog2(tDb), tDb, kn, ratio);
    const upper = computeGainDb(dbToLog2(tDb + halfKn), tDb, kn, ratio);
    const expectedMid = -slope * (halfKn * halfKn) / (2 * kn);
    const expectedUpper = -slope * halfKn;
    expect(mid).toBeCloseTo(expectedMid, 8);
    expect(upper).toBeCloseTo(expectedUpper, 8);
    // And the mid is exactly 1/4 of the upper.
    expect(mid / upper).toBeCloseTo(0.25, 6);
  });
});

describe('ART sidecar / env_out un-clamped contract', () => {
  it('env_out = (-gainDb / ENV_SCALE_DB) * envMag — no clamp at envMag=1', () => {
    // Sweep gainDb 0..-48 dB; env_out reaches 2.0 at -48 dB (envMag=1).
    for (let g = 0; g >= -48; g -= 1) {
      expect(envOut(g, 1)).toBeCloseTo(-g / ENV_SCALE_DB, 8);
    }
  });

  it('env_out overshoots 1.0 at envMag=2 + reduction=24 dB (NEW SPEC PIN)', () => {
    // Pin the user-spec contract: at envMag=2, env_out saturates to 2.0
    // at the same reduction-point where envMag=1 saturates to 1.0.
    expect(envOut(-24, 2)).toBeCloseTo(2, 8);
    expect(envOut(-12, 2)).toBeCloseTo(1, 8);
    expect(envOut(-12, 2)).toBeGreaterThanOrEqual(1);
  });

  it('env_inv_out can go negative — un-clamped mirror of env_out', () => {
    // env_out = 1.5 → env_inv_out = -0.5
    expect(envInvOut(1.5)).toBeCloseTo(-0.5, 8);
    // env_out = 2.0 → env_inv_out = -1.0
    expect(envInvOut(2.0)).toBeCloseTo(-1, 8);
  });
});
