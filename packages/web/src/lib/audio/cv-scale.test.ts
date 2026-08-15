// packages/web/src/lib/audio/cv-scale.test.ts
//
// Pin the CV-scaling math: at cv=-1 the param hits its (clamped) min, at
// cv=0 the knob position passes through unchanged, and at cv=+1 the param
// hits its (clamped) max. This is the "LFO sweeps full range" guarantee
// that the standard (docs/adr/004-cv-range-convention.md) requires.

import { describe, it, expect } from 'vitest';
import { scaleCv, scaleCvDelta, buildCvCurve, sampleCvCurve, CURVE_LEN } from './cv-scale';
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
  it('curve length is ODD (a sample lands exactly on cv=0)', () => {
    const c = buildCvCurve(0, 1, 0.5, { mode: 'linear' });
    expect(c.length).toBe(CURVE_LEN);
    // The load-bearing property, stated as itself rather than as a magic
    // number: an EVEN table has no centre sample, so the shaper interpolates
    // at cv=0. See CURVE_LEN's comment.
    expect(c.length % 2, 'CURVE_LEN must be ODD — see its comment').toBe(1);
  });
  it('curve[0] (cv=-1) and curve[end] (cv=+1) span the full delta range', () => {
    // ADSR sustain 0..1, knob 0.5: cv=-1 → delta -0.5; cv=+1 → delta +0.5.
    const c = buildCvCurve(0, 1, 0.5, { mode: 'linear' });
    expect(c[0]).toBeCloseTo(-0.5, 5);
    expect(c[c.length - 1]).toBeCloseTo(0.5, 5);
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

// ─────────────────────────────────────────────────────────────────────────
// cv = 0 IS EXACTLY THE UNMODULATED VALUE — through the REAL transfer function
//
// A WaveShaperNode does not read `curve[round(i)]`; it interpolates between the
// two samples straddling its input. So the only honest way to assert what a
// patched-but-idle cable does is `sampleCvCurve`, which is that transfer
// function verbatim (validated against a real Chromium OfflineAudioContext).
//
// The claim is stated as EXACT equality, not a tolerance: with an odd
// CURVE_LEN the shaper reads the centre sample directly, so "close to zero" is
// not the property — "is the value" is. Every mode is covered, including the
// three shapes that an EVEN table got wrong (clamped-linear, log, discrete),
// and the negative control below drives this same builder with the old even
// length and pins that each one goes red.
// ─────────────────────────────────────────────────────────────────────────

interface ZeroCase {
  name: string;
  min: number;
  max: number;
  knob: number;
  hint: CvScaleHint;
}

/** Real registry shapes, chosen to cover every way the even table failed. */
const ZERO_CASES: ZeroCase[] = [
  // Interior knob, odd-symmetric — the case the even table already got right.
  { name: 'twotracks.rate_cv (linear, ±3, knob 1)', min: -3, max: 3, knob: 1, hint: { mode: 'linear' } },
  { name: 'mixmstrs EQ band (linear, ±12, knob 0)', min: -12, max: 12, knob: 0, hint: { mode: 'linear' } },
  // Knob AT a range end — the clamp flattens one side (74 registry ports).
  { name: 'analogVco.shape (linear, 0..1, knob 0 = MIN)', min: 0, max: 1, knob: 0, hint: { mode: 'linear' } },
  { name: 'destroy.wet (linear, 0..1, knob 1 = MAX)', min: 0, max: 1, knob: 1, hint: { mode: 'linear' } },
  { name: 'analogLogicMaths.attA_cv (linear, ±1, knob 1 = MAX)', min: -1, max: 1, knob: 1, hint: { mode: 'linear' } },
  { name: 'foxy.spread_cv (linear, 1..5, knob 1 = MIN)', min: 1, max: 5, knob: 1, hint: { mode: 'linear' } },
  // Log — convex, so the mean of the neighbours overshoots (all 39 log ports).
  { name: 'charlottesEchos.delay (log, 0.001..1.5, knob 0.4)', min: 0.001, max: 1.5, knob: 0.4, hint: { mode: 'log' } },
  { name: 'qbrt cutoff (log, 20..20000, knob 1000)', min: 20, max: 20000, knob: 1000, hint: { mode: 'log' } },
  { name: 'kickdrum.sub_decay_cv (log, 50..800, knob 450)', min: 50, max: 800, knob: 450, hint: { mode: 'log' } },
  // Discrete — the even table wedged 16 of 17 ports BETWEEN two buckets.
  { name: 'macrooscillator.model_cv (discrete, 0..13, knob 0)', min: 0, max: 13, knob: 0, hint: { mode: 'discrete' } },
  { name: 'qbrt.mode (discrete, 0..1, knob 0)', min: 0, max: 1, knob: 0, hint: { mode: 'discrete' } },
  { name: 'sixstrum.chord_cv (discrete, 0..7, knob 0)', min: 0, max: 7, knob: 0, hint: { mode: 'discrete' } },
  { name: 'sixstrum.dir_cv (discrete, 0..2, knob 0)', min: 0, max: 2, knob: 0, hint: { mode: 'discrete' } },
  // Passthrough + depth, for mode completeness.
  { name: 'passthrough (0..1, knob 0.7)', min: 0, max: 1, knob: 0.7, hint: { mode: 'passthrough' } },
  { name: 'linear depth 0.5 (0..1, knob 0.5)', min: 0, max: 1, knob: 0.5, hint: { mode: 'linear', depth: 0.5 } },
];

/** The delta the curve is MEANT to carry at `cv`, as a Float32 (the curve is a
 *  Float32Array, so this is the exactly-achievable target — not a fudge). */
function wantDelta(c: ZeroCase, cv: number): number {
  return Math.fround(scaleCv(cv, c.knob, c.min, c.max, c.hint) - c.knob);
}

describe('cv-scale / a patched-but-idle cable (cv=0) applies NO offset', () => {
  it.each(ZERO_CASES)('$name: the shaper emits EXACTLY the unmodulated delta', (c) => {
    const curve = buildCvCurve(c.min, c.max, c.knob, c.hint);
    const got = sampleCvCurve(curve, 0);
    const want = wantDelta(c, 0);
    expect(
      got,
      `${c.name}: a cable sitting at cv=0 must add exactly ${want}, not ${got} ` +
        `(off by ${Math.abs(got - want).toExponential(4)} = ` +
        `${((Math.abs(got - want) / (c.max - c.min)) * 100).toExponential(3)} % of range)`,
    ).toBe(want);
  });

  it.each(ZERO_CASES.filter((c) => c.hint.mode !== 'discrete'))(
    '$name: ...and for the non-bucket modes that delta is literally zero',
    (c) => {
      // Stated separately so the headline claim ("an idle cable does nothing")
      // is pinned as 0 rather than as "whatever scaleCv says", which would pass
      // even if scaleCv itself drifted.
      const got = sampleCvCurve(buildCvCurve(c.min, c.max, c.knob, c.hint), 0);
      expect(Object.is(got, 0) || Object.is(got, -0), `${c.name}: got ${got}`).toBe(true);
    },
  );

  it.each(ZERO_CASES.filter((c) => c.hint.mode === 'discrete'))(
    '$name: discrete lands ON a bucket (never wedged between two)',
    (c) => {
      // Discrete's cv=0 is the MIDDLE BUCKET by design (an absolute selector —
      // see cv-scale.ts). What must never happen is a half-integer, which is a
      // value the mode cannot produce; the even table emitted exactly that.
      const got = sampleCvCurve(buildCvCurve(c.min, c.max, c.knob, c.hint), 0);
      const effective = got + c.knob;
      expect(
        Number.isInteger(effective),
        `${c.name}: cv=0 selected ${effective} — not a bucket`,
      ).toBe(true);
      expect(effective).toBeGreaterThanOrEqual(c.min);
      expect(effective).toBeLessThanOrEqual(c.max);
    },
  );

  // The off-by-one the odd length could plausibly have introduced: shifting the
  // centre onto a sample must NOT shift the ends off theirs.
  it.each(ZERO_CASES)('$name: the ENDS still map to exactly cv=∓1', (c) => {
    const curve = buildCvCurve(c.min, c.max, c.knob, c.hint);
    expect(curve.length).toBe(CURVE_LEN);
    // The shaper clamps v to [0, N-1], so ±1 must read the terminal samples...
    expect(sampleCvCurve(curve, -1)).toBe(curve[0]);
    expect(sampleCvCurve(curve, +1)).toBe(curve[curve.length - 1]);
    // ...and those terminal samples must be the true cv=∓1 deltas, i.e. the
    // index→cv map still hits both ends dead on.
    expect(sampleCvCurve(curve, -1), `${c.name}: cv=-1`).toBe(wantDelta(c, -1));
    expect(sampleCvCurve(curve, +1), `${c.name}: cv=+1`).toBe(wantDelta(c, +1));
    // Beyond ±1 the shaper pins rather than extrapolating.
    expect(sampleCvCurve(curve, -2)).toBe(curve[0]);
    expect(sampleCvCurve(curve, +2)).toBe(curve[curve.length - 1]);
  });

  // ── NEGATIVE CONTROLS ──────────────────────────────────────────────────
  // Two of them, because there were two failures here: the CODE was wrong
  // (an even table) and so was the INSTRUMENT that first "found" it (a
  // nearest-index read). Both are pinned so neither can come back quietly.

  it('NEGATIVE CONTROL: the OLD even-length table fails the cv=0 gate', () => {
    // The real builder, driven with the old shape — not a re-typed model of it.
    const failures: string[] = [];
    for (const c of ZERO_CASES) {
      const even = buildCvCurve(c.min, c.max, c.knob, c.hint, c.hint.depth ?? 1, 4096);
      expect(even.length % 2, 'the control must actually be even-length').toBe(0);
      if (sampleCvCurve(even, 0) !== wantDelta(c, 0)) failures.push(c.name);
    }
    // If this list is ever empty, the gate above proves nothing.
    expect(
      failures.length,
      'an even-length LUT must be caught by the cv=0 gate; it was not',
    ).toBeGreaterThan(0);
    // Named, with the measured magnitudes, so the control can't silently
    // weaken into "some case, somewhere, differs".
    const evenDiscrete = buildCvCurve(0, 13, 0, { mode: 'discrete' }, 1, 4096);
    expect(sampleCvCurve(evenDiscrete, 0), 'model select wedged between buckets 6 and 7').toBe(6.5);
    const evenClamped = buildCvCurve(0, 1, 0, { mode: 'linear' }, 1, 4096);
    expect(sampleCvCurve(evenClamped, 0)).toBeCloseTo(6.105e-5, 9);
    const evenLog = buildCvCurve(0.001, 1.5, 0.4, { mode: 'log' }, 1, 4096);
    expect(sampleCvCurve(evenLog, 0)).toBeCloseTo(1.5947e-7, 11);
  });

  it('NEGATIVE CONTROL: nearest-index sampling is NOT the transfer function', () => {
    // Where the widely-quoted "an idle cv cable adds 7.33e-4" came from: a
    // ±3-range port read as `curve[round((cv+1)/2*(N-1))]` on the even table.
    // round(2047.5) = 2048, so it reported the FIRST POSITIVE sample instead of
    // the interpolated centre — a value a real WaveShaperNode never emits at
    // cv=0. The audio path rendered exactly 0.0 the whole time.
    const even = buildCvCurve(-3, 3, 1, { mode: 'linear' }, 1, 4096);
    const nearest = even[Math.round(((0 + 1) / 2) * (even.length - 1))] as number;
    expect(nearest).toBeCloseTo(7.326e-4, 7);
    expect(sampleCvCurve(even, 0), 'the REAL transfer function on that same curve').toBe(0);
    expect(nearest).not.toBe(sampleCvCurve(even, 0));
    // On the odd table the two samplers agree, because cv=0 IS a sample —
    // which is the second reason to prefer an odd length.
    const odd = buildCvCurve(-3, 3, 1, { mode: 'linear' });
    expect(odd[Math.round(((0 + 1) / 2) * (odd.length - 1))]).toBe(sampleCvCurve(odd, 0));
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
