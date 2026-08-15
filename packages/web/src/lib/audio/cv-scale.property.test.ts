// packages/web/src/lib/audio/cv-scale.property.test.ts
//
// fast-check property suite for the CV → AudioParam scaling math (#1526).
// Pairs with cv-scale.test.ts (the example-based file): the example file pins
// the cases someone thought of; this file pins the laws that must hold for
// EVERY (cv, knob, range, mode, depth) the registry can produce.
//
// Why this core. `scaleCv` is what decides the value a modulated param
// actually takes, for all 317 curve-backed ports. It is the one place in the
// audio path where a range violation is INVISIBLE at runtime — the AudioParam
// clamps outliers silently, so an unclamped scale reads as "quiet weirdness"
// rather than an error. A range law is exactly the shape a property test
// proves and an example test cannot.
//
// The laws:
//   P1 RANGE      — linear/log/discrete never escape [paramMin, paramMax].
//   P2 FINITE     — no NaN and no Infinity for any finite input.
//   P3 CV CLAMP   — the cv domain saturates: |c| > 1 behaves as ±1.
//   P4 MONOTONE   — the effective value is non-decreasing in cv.
//   P5 ZERO IDENT — cv = 0 leaves the knob alone (linear/log). `discrete` is
//                   DELIBERATELY exempt (an absolute bucket map — see the
//                   ⚠ block in cv-scale.ts); it gets the narrower law that the
//                   value is an exact bucket.
//   P6 SYMMETRY   — the linear delta is odd about cv = 0 while unclamped.
//   P7 CURVE      — reading the built LUT the way the AUDIO THREAD reads it
//                   reproduces the math at cv = 0 for every mode. This is the
//                   `CURVE_LEN` odd-length guarantee.
//
// ⚠ `passthrough` is EXCLUDED from P1/P4/P5 on purpose, not by oversight: it
// is documented as "sum directly, no clamping here — the AudioParam clamps",
// so asserting a range law over it would be asserting the opposite of the
// contract. It is still covered by P2 and P3.
//
// NEGATIVE CONTROL (permanent leg, see `even-length table` below): P7 is run a
// second time against an EVEN-length table and REQUIRED to fail. `buildCvCurve`
// takes `len` for exactly this reason — production always passes CURVE_LEN.
// Without that leg, P7 would pass just as happily on a shaper that never reads
// the centre sample at all.
//
// Seeds are fixed per property so a CI failure reproduces verbatim.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  buildCvCurve,
  sampleCvCurve,
  scaleCv,
  scaleCvDelta,
  CURVE_LEN,
} from './cv-scale';
import type { CvScaleHint } from '$lib/graph/types';

// ---------------------------------------------------------------------------
// Generators — shaped like the REAL registry, not like the number line.
// ---------------------------------------------------------------------------

/** Param ranges the registry actually declares: bipolar, unipolar, wide
 *  positive (log-friendly), and tiny. `min < max` always. */
const positiveRange = fc
  .tuple(
    fc.double({ min: 1e-4, max: 1e3, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 1e-3, max: 2e4, noNaN: true, noDefaultInfinity: true }),
  )
  .filter(([a, b]) => b > a * 1.000001)
  .map(([a, b]) => ({ paramMin: a, paramMax: b }));

const anyRange = fc.oneof(
  positiveRange,
  fc
    .tuple(
      fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true }),
    )
    .filter(([a, b]) => b > a)
    .map(([a, b]) => ({ paramMin: a, paramMax: b })),
);

/** Integer-bucket ranges — the shape `discrete` is declared over. */
const discreteRange = fc
  .tuple(fc.integer({ min: -8, max: 8 }), fc.integer({ min: 1, max: 24 }))
  .map(([lo, span]) => ({ paramMin: lo, paramMax: lo + span }));

const cv = fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true });
const depth = fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true });

/** A knob inside the param's own range — the only position a real param holds
 *  (setParam clamps), and the precondition P5 needs. */
function knobIn(paramMin: number, paramMax: number) {
  return fc
    .double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
    .map((t) => paramMin + t * (paramMax - paramMin));
}

const CLAMPING_MODES = ['linear', 'log', 'discrete'] as const;
const ALL_MODES = ['linear', 'log', 'discrete', 'passthrough'] as const;

/** Report every input in the assertion message. A property failure that does
 *  not print its counterexample costs a debugging session. */
function ctx(
  mode: string,
  c: number,
  knob: number,
  paramMin: number,
  paramMax: number,
  d: number,
): string {
  return `mode=${mode} cv=${c} knob=${knob} range=[${paramMin}, ${paramMax}] depth=${d}`;
}

describe('cv-scale properties', () => {
  // -------------------------------------------------------------------
  // P1 — RANGE
  // -------------------------------------------------------------------
  it('P1: linear/log/discrete never escape [paramMin, paramMax]', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CLAMPING_MODES),
        anyRange,
        cv,
        depth,
        fc.double({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true }),
        (mode, { paramMin, paramMax }, c, d, knob) => {
          const hint: CvScaleHint = { mode, depth: d };
          const v = scaleCv(c, knob, paramMin, paramMax, hint);
          // The knob itself is generated UNCLAMPED here on purpose: a param
          // whose stored value drifted outside its declared range (a loaded
          // patch from before a range narrowed) must still be pinned by the
          // scale, not amplified by it.
          expect(v, `range violated — ${ctx(mode, c, knob, paramMin, paramMax, d)}`)
            .toBeGreaterThanOrEqual(paramMin);
          expect(v, `range violated — ${ctx(mode, c, knob, paramMin, paramMax, d)}`)
            .toBeLessThanOrEqual(paramMax);
        },
      ),
      { numRuns: 500, seed: 15261 },
    );
  });

  // -------------------------------------------------------------------
  // P2 — FINITE
  // -------------------------------------------------------------------
  it('P2: no NaN and no Infinity escapes, for any mode and any finite input', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_MODES),
        anyRange,
        fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }),
        depth,
        fc.double({ min: -1e5, max: 1e5, noNaN: true, noDefaultInfinity: true }),
        (mode, { paramMin, paramMax }, c, d, knob) => {
          const hint: CvScaleHint = { mode, depth: d };
          const v = scaleCv(c, knob, paramMin, paramMax, hint);
          expect(
            Number.isFinite(v),
            `non-finite ${v} — ${ctx(mode, c, knob, paramMin, paramMax, d)}`,
          ).toBe(true);
          const delta = scaleCvDelta(c, knob, paramMin, paramMax, hint);
          expect(
            Number.isFinite(delta),
            `non-finite delta ${delta} — ${ctx(mode, c, knob, paramMin, paramMax, d)}`,
          ).toBe(true);
        },
      ),
      { numRuns: 500, seed: 15262 },
    );
  });

  // -------------------------------------------------------------------
  // P3 — CV DOMAIN SATURATION
  // -------------------------------------------------------------------
  it('P3: the cv domain saturates — |cv| > 1 behaves exactly as ±1', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_MODES),
        anyRange,
        fc.double({ min: 1.0000001, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        depth,
        (mode, { paramMin, paramMax }, over, d) => {
          const hint: CvScaleHint = { mode, depth: d };
          const knob = (paramMin + paramMax) / 2;
          expect(
            scaleCv(over, knob, paramMin, paramMax, hint),
            `+${over} must read as +1 — ${ctx(mode, over, knob, paramMin, paramMax, d)}`,
          ).toBe(scaleCv(1, knob, paramMin, paramMax, hint));
          expect(
            scaleCv(-over, knob, paramMin, paramMax, hint),
            `-${over} must read as -1 — ${ctx(mode, -over, knob, paramMin, paramMax, d)}`,
          ).toBe(scaleCv(-1, knob, paramMin, paramMax, hint));
        },
      ),
      { numRuns: 300, seed: 15263 },
    );
  });

  // -------------------------------------------------------------------
  // P4 — MONOTONICITY
  // -------------------------------------------------------------------
  it('P4: the effective value is non-decreasing in cv (linear/log/discrete)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CLAMPING_MODES),
        positiveRange,
        cv,
        cv,
        depth,
        (mode, { paramMin, paramMax }, a, b, d) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const hint: CvScaleHint = { mode, depth: d };
          const knob = (paramMin + paramMax) / 2;
          const vLo = scaleCv(lo, knob, paramMin, paramMax, hint);
          const vHi = scaleCv(hi, knob, paramMin, paramMax, hint);
          expect(
            vHi,
            `monotonicity violated: cv ${lo} → ${vLo} but cv ${hi} → ${vHi} ` +
              `(${ctx(mode, hi, knob, paramMin, paramMax, d)})`,
          ).toBeGreaterThanOrEqual(vLo);
        },
      ),
      { numRuns: 500, seed: 15264 },
    );
  });

  // -------------------------------------------------------------------
  // P5 — cv = 0 IS THE UNMODULATED VALUE
  // -------------------------------------------------------------------
  it('P5: cv=0 returns the knob EXACTLY for linear + log (a patched idle cable must not detune)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('linear', 'log'),
        positiveRange,
        depth,
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (mode, { paramMin, paramMax }, d, t) => {
          const knob = paramMin + t * (paramMax - paramMin);
          const v = scaleCv(0, knob, paramMin, paramMax, { mode, depth: d });
          expect(v, `cv=0 must be a no-op — ${ctx(mode, 0, knob, paramMin, paramMax, d)}`)
            .toBe(knob);
        },
      ),
      { numRuns: 400, seed: 15265 },
    );
  });

  it('P5b: `discrete` at cv=0 selects an EXACT bucket (its documented, narrower guarantee)', () => {
    fc.assert(
      fc.property(discreteRange, depth, (range, d) => {
        const { paramMin, paramMax } = range;
        const knob = (paramMin + paramMax) / 2;
        const v = scaleCv(0, knob, paramMin, paramMax, { mode: 'discrete', depth: d });
        expect(
          Number.isInteger(v),
          `discrete produced the half-integer ${v} — a value the mode can never ` +
            `legitimately emit (${ctx('discrete', 0, knob, paramMin, paramMax, d)})`,
        ).toBe(true);
      }),
      { numRuns: 300, seed: 15266 },
    );
  });

  // -------------------------------------------------------------------
  // P6 — ODD SYMMETRY OF THE LINEAR DELTA
  // -------------------------------------------------------------------
  it('P6: the linear delta is odd about cv=0 wherever neither side clamps', () => {
    fc.assert(
      fc.property(positiveRange, cv, depth, (range, c, d) => {
        const { paramMin, paramMax } = range;
        const knob = (paramMin + paramMax) / 2; // centred → symmetric headroom
        const hint: CvScaleHint = { mode: 'linear', depth: d };
        const plus = scaleCvDelta(c, knob, paramMin, paramMax, hint);
        const minus = scaleCvDelta(-c, knob, paramMin, paramMax, hint);
        const span = paramMax - paramMin;
        // Precondition: BOTH sides strictly inside, i.e. the clamp did not
        // engage. `fc.pre` discards rather than passing vacuously.
        fc.pre(Math.abs(plus) < span / 2 && Math.abs(minus) < span / 2);
        expect(
          Math.abs(plus + minus),
          `delta(+${c})=${plus} and delta(-${c})=${minus} are not opposite ` +
            `(span=${span}, depth=${d})`,
        ).toBeLessThanOrEqual(1e-9 * span);
      }),
      { numRuns: 400, seed: 15267 },
    );
  });

  // -------------------------------------------------------------------
  // P7 — THE LUT, READ THE WAY THE AUDIO THREAD READS IT
  // -------------------------------------------------------------------

  /** The LUT is a Float32Array (WaveShaperNode.curve's required type), so the
   *  guarantee is "reproduces the math to FLOAT32 precision", not to double
   *  precision. Comparing raw doubles reports a failure on any range whose
   *  delta has no float32 representation — measured: range [-1e-323, 0] made
   *  `5e-324` read back as `0`. That is the type, not a defect, so the
   *  comparison is stated in the units the artifact is actually stored in. */
  const f32 = (v: number): number => Math.fround(v);

  /** The property under test, factored so the negative control below calls the
   *  IDENTICAL predicate against an even table (same function, one argument
   *  different — never a re-implementation). */
  function centreSampleMatchesMath(
    mode: (typeof ALL_MODES)[number],
    paramMin: number,
    paramMax: number,
    knob: number,
    d: number,
    len: number,
  ): { ok: boolean; got: number; want: number } {
    const hint: CvScaleHint = { mode, depth: d };
    const curve = buildCvCurve(paramMin, paramMax, knob, hint, d, len);
    const got = sampleCvCurve(curve, 0);
    const want = f32(scaleCvDelta(0, knob, paramMin, paramMax, hint));
    return { ok: got === want, got, want };
  }

  it('P7: at cv=0 the ODD production table reproduces the math EXACTLY, every mode', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CLAMPING_MODES),
        anyRange,
        depth,
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (mode, { paramMin, paramMax }, d, t) => {
          const knob = paramMin + t * (paramMax - paramMin);
          const r = centreSampleMatchesMath(mode, paramMin, paramMax, knob, d, CURVE_LEN);
          expect(
            r.ok,
            `LUT centre sample ${r.got} != math ${r.want} at cv=0 ` +
              `(len=${CURVE_LEN}, ${ctx(mode, 0, knob, paramMin, paramMax, d)})`,
          ).toBe(true);
        },
      ),
      { numRuns: 400, seed: 15268 },
    );
  });

  it('P7 endpoints: curve[0] and curve[len-1] are the math at cv=∓1', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CLAMPING_MODES),
        anyRange,
        depth,
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (mode, { paramMin, paramMax }, d, t) => {
          const knob = paramMin + t * (paramMax - paramMin);
          const hint: CvScaleHint = { mode, depth: d };
          const curve = buildCvCurve(paramMin, paramMax, knob, hint, d, CURVE_LEN);
          expect(
            sampleCvCurve(curve, -1),
            `curve[0] (float32) — ${ctx(mode, -1, knob, paramMin, paramMax, d)}`,
          ).toBe(f32(scaleCvDelta(-1, knob, paramMin, paramMax, hint)));
          expect(
            sampleCvCurve(curve, 1),
            `curve[len-1] (float32) — ${ctx(mode, 1, knob, paramMin, paramMax, d)}`,
          ).toBe(f32(scaleCvDelta(1, knob, paramMin, paramMax, hint)));
        },
      ),
      { numRuns: 300, seed: 15269 },
    );
  });

  // -------------------------------------------------------------------
  // PERMANENT NEGATIVE CONTROL for P7.
  //
  // A property that cannot fail is worse than none. P7 asserts the odd-length
  // guarantee; this leg proves the assertion is SENSITIVE to it, by driving
  // the SAME predicate with an even table and requiring counterexamples. If
  // this ever goes green (i.e. finds none), P7 has stopped measuring the
  // centre sample and is certifying nothing.
  // -------------------------------------------------------------------
  it('CONTROL: the SAME predicate FAILS on an even-length table (P7 can fail)', () => {
    const evenLen = CURVE_LEN - 1; // 4096 — the power-of-two someone would "fix" it to
    expect(evenLen % 2, 'the control table must be even-length').toBe(0);

    // A deterministic grid, not a random one: this leg must never be flaky in
    // either direction, and the cases are the exact ones cv-scale.ts documents
    // (discrete buckets straddling the centre; linear with the knob AT an end).
    const cases: { mode: (typeof ALL_MODES)[number]; min: number; max: number; knob: number }[] = [
      { mode: 'discrete', min: 0, max: 13, knob: 6 }, // macrooscillator.model_cv
      { mode: 'discrete', min: 0, max: 1, knob: 0 }, // mixmstr compEnable — a boolean
      { mode: 'linear', min: 0, max: 1, knob: 0 }, // analogVco.shape at its floor
      { mode: 'log', min: 0.001, max: 10, knob: 0.1 }, // adsr.attack
    ];

    const offenders: string[] = [];
    for (const c of cases) {
      const r = centreSampleMatchesMath(c.mode, c.min, c.max, c.knob, 1, evenLen);
      if (!r.ok) {
        offenders.push(
          `${c.mode} [${c.min}, ${c.max}] knob=${c.knob}: even table read ${r.got}, math says ${r.want}`,
        );
      }
      // …and the SAME case must be clean on the production odd table, or the
      // control is showing a defect in the math rather than in the table shape.
      const odd = centreSampleMatchesMath(c.mode, c.min, c.max, c.knob, 1, CURVE_LEN);
      expect(
        odd.ok,
        `${c.mode} [${c.min}, ${c.max}] knob=${c.knob} is broken on the PRODUCTION ` +
          `table too (read ${odd.got}, math says ${odd.want}) — this control is ` +
          `pointing at a real bug, not at the even-length table`,
      ).toBe(true);
    }

    expect(
      offenders.length,
      'an EVEN-length curve table produced NO cv=0 error across the four documented ' +
        'cases. Either sampleCvCurve stopped modelling the WaveShaperNode transfer ' +
        'function, or buildCvCurve stopped honouring `len` — in both cases P7 above ' +
        'is no longer able to fail and the CURVE_LEN guarantee is unguarded.',
    ).toBeGreaterThan(0);
    // Print what it caught, so a future reader sees the control is live.
    expect(offenders.join('\n')).toMatch(/even table read/);
  });
});
