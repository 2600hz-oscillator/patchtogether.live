// packages/web/src/lib/audio/rbj-biquad.property.test.ts
//
// fast-check property suite for the OWN-CODE RBJ biquads in
// `packages/dsp/src/lib/rbj-biquad.ts` (#1526) — the shared filter section
// under the kick voice's EQ, the snare's wire highpass and every own-code
// filter stage added since.
//
// WHY IT LIVES UNDER packages/web. `fast-check` is a devDependency of the WEB
// workspace, and touching `packages/dsp/src/lib/rbj-biquad.ts` at all costs an
// ART re-pin (it is a DSP source-basis core). It also used to cost a real-GPU
// grand re-attest — that attest was deleted 2026-08-17, so the ART re-pin is
// the remaining cost. Testing it from here via a relative import
// costs nothing and is the established pattern (cf. wavecel-spread-parity,
// resofilter-face-model, videocube-core). NOTHING under packages/dsp is
// modified by this file.
//
// Why properties. A filter is a stability argument, and a stability argument is
// universally quantified over its parameters by definition: "the poles are
// inside the unit circle for every (fc, Q, sr) a caller can pass" is not a
// statement any finite list of examples can make. The example suite next door
// pins RESPONSES at chosen settings; this pins the laws.
//
// The laws:
//   L1 FINITE   — every coefficient is finite for every in-domain setting.
//   L2 STABLE   — the poles are strictly inside the unit circle (Jury: |a2| < 1
//                 and |a1| < 1 + a2). This is what makes the `Math.min(fc,
//                 sr*0.45)` guard load-bearing rather than decorative.
//   L3 GAIN     — the closed-form gains hold: lowpass |H(DC)| = 1, highpass
//                 |H(Nyquist)| = 1, peaking = 1 at BOTH ends, low shelf =
//                 10^(dB/20) at DC, high shelf the same at Nyquist.
//   L4 CACHE    — at a fixed sample rate, changing ANY argument the updater's
//                 math reads changes at least one coefficient. This is the
//                 measured #1425-era `k3` bug ("a Q-only change early-returned
//                 the previous filter's coefficients verbatim — bit-identical
//                 b0..a2, a 1.85 dB response error") as a law.
//   L5 NO BLOWUP — biquadStep over a bounded input never emits NaN/Infinity.
//
// ⚠ SCOPE — the domain these laws are asserted over, and what is deliberately
// OUTSIDE it. Generators use fc ≥ 10 Hz, Q > 0 and a FIXED sr per Biquad
// instance, because that is the domain every caller actually occupies
// (`kickdrum-dsp.ts` and `snaredrum-dsp.ts` pass positive literal/clamped
// frequencies, fixed Q, and the worklet's constant `sr`). Three inputs OUTSIDE
// that domain do NOT satisfy the laws, are unreachable today, and are filed
// rather than silently asserted — see #1659:
//   * fc ≤ 0 — `Math.min(fc, sr*0.45)` clamps only the TOP. fc = -100 @ 48 kHz
//     yields a2 = 1.0186844217663669, i.e. poles OUTSIDE the unit circle.
//   * Q = 0  — alpha = sin(w0)/0 = Infinity, and a2 comes out NaN.
//   * a changed `sr` on a REUSED Biquad — `sr` is in none of the five cache
//     keys, so updateLowpass(bq, 1000, 48000) then (bq, 1000, 96000) returns
//     the 48 kHz coefficients verbatim (a 2× cutoff error), contradicting the
//     file's own "EVERY parameter the updater's math reads must appear here".
// Asserting the buggy behaviour here would be a green gate certifying a live
// defect; asserting the correct behaviour would red the suite for a case no
// caller reaches. So the scope is stated, the issue carries the reproducers,
// and L4 fixes `sr` per instance.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  makeBiquad,
  biquadStep,
  resetBiquad,
  updateHighpass,
  updateHighShelf,
  updateLowpass,
  updateLowShelf,
  updatePeaking,
  type Biquad,
} from '../../../../dsp/src/lib/rbj-biquad';

// ---------------------------------------------------------------------------
// Generators — the caller domain.
// ---------------------------------------------------------------------------

const sampleRate = fc.constantFrom(44100, 48000, 96000);
/** Up to 3× the sample rate: the top clamp is IN the domain under test, so a
 *  regression that removed it must red L2. */
const cutoffFor = (sr: number) =>
  fc.double({ min: 10, max: 3 * sr, noNaN: true, noDefaultInfinity: true });
const qFactor = fc.double({ min: 0.05, max: 40, noNaN: true, noDefaultInfinity: true });
const dbGain = fc.double({ min: -24, max: 24, noNaN: true, noDefaultInfinity: true });

const COEFFS = ['b0', 'b1', 'b2', 'a1', 'a2'] as const;

function coeffs(bq: Biquad): Record<string, number> {
  return { b0: bq.b0, b1: bq.b1, b2: bq.b2, a1: bq.a1, a2: bq.a2 };
}
function coeffStr(bq: Biquad): string {
  return COEFFS.map((k) => `${k}=${bq[k]}`).join(' ');
}

/** |H(z)| at z = +1 (DC) and z = -1 (Nyquist) — the two points with a closed
 *  form, so the assertion is against arithmetic rather than against a
 *  re-implementation of the filter. */
function gainAtDc(bq: Biquad): number {
  return Math.abs((bq.b0 + bq.b1 + bq.b2) / (1 + bq.a1 + bq.a2));
}
function gainAtNyquist(bq: Biquad): number {
  return Math.abs((bq.b0 - bq.b1 + bq.b2) / (1 - bq.a1 + bq.a2));
}

/** Jury stability for a 2nd-order section: poles strictly inside |z| = 1. */
function isStable(bq: Biquad): boolean {
  return Math.abs(bq.a2) < 1 && Math.abs(bq.a1) < 1 + bq.a2;
}

/** Every updater, as (label, apply) so the universal laws iterate them rather
 *  than repeating five near-identical properties (and so a NEW updater added
 *  to rbj-biquad.ts is a one-line enrolment here). */
type Updater = { label: string; apply: (bq: Biquad, sr: number, fc_: number, q: number, db: number) => void };
const UPDATERS: Updater[] = [
  { label: 'lowpass', apply: (bq, sr, f, q) => updateLowpass(bq, f, sr, q) },
  { label: 'highpass', apply: (bq, sr, f, q) => updateHighpass(bq, f, sr, q) },
  { label: 'peaking', apply: (bq, sr, f, q, db) => updatePeaking(bq, f, db, q, sr) },
  { label: 'lowShelf', apply: (bq, sr, f, _q, db) => updateLowShelf(bq, f, db, sr) },
  { label: 'highShelf', apply: (bq, sr, f, _q, db) => updateHighShelf(bq, f, db, sr) },
];

const setting = sampleRate.chain((sr) =>
  fc.record({
    sr: fc.constant(sr),
    fc_: cutoffFor(sr),
    q: qFactor,
    db: dbGain,
  }),
);

function settingStr(s: { sr: number; fc_: number; q: number; db: number }): string {
  return `sr=${s.sr} fc=${s.fc_} Q=${s.q} dB=${s.db}`;
}

describe('rbj-biquad properties', () => {
  it('L1: every coefficient is finite, for every updater over the caller domain', () => {
    fc.assert(
      fc.property(fc.constantFrom(...UPDATERS.map((u) => u.label)), setting, (label, s) => {
        const u = UPDATERS.find((x) => x.label === label) as Updater;
        const bq = makeBiquad();
        u.apply(bq, s.sr, s.fc_, s.q, s.db);
        for (const k of COEFFS) {
          expect(
            Number.isFinite(bq[k]),
            `${label}: ${k} is ${bq[k]} — ${settingStr(s)}`,
          ).toBe(true);
        }
      }),
      { numRuns: 600, seed: 15291 },
    );
  });

  it('L2: the poles stay strictly inside the unit circle (the sr*0.45 clamp is load-bearing)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...UPDATERS.map((u) => u.label)), setting, (label, s) => {
        const u = UPDATERS.find((x) => x.label === label) as Updater;
        const bq = makeBiquad();
        u.apply(bq, s.sr, s.fc_, s.q, s.db);
        expect(
          isStable(bq),
          `${label} is UNSTABLE (|a2| must be < 1 and |a1| < 1 + a2): ${coeffStr(bq)} — ` +
            `${settingStr(s)}. An unstable section does not "sound wrong", it diverges.`,
        ).toBe(true);
      }),
      { numRuns: 600, seed: 15292 },
    );
  });

  it('L3: the closed-form gains hold at DC and Nyquist', () => {
    fc.assert(
      fc.property(setting, (s) => {
        const lp = makeBiquad();
        updateLowpass(lp, s.fc_, s.sr, s.q);
        expect(gainAtDc(lp), `lowpass DC gain — ${settingStr(s)} ${coeffStr(lp)}`)
          .toBeCloseTo(1, 6);

        const hp = makeBiquad();
        updateHighpass(hp, s.fc_, s.sr, s.q);
        expect(gainAtNyquist(hp), `highpass Nyquist gain — ${settingStr(s)} ${coeffStr(hp)}`)
          .toBeCloseTo(1, 6);

        // A peaking EQ is unity at BOTH ends by construction — that is what
        // makes it "peaking" rather than a shelf.
        const pk = makeBiquad();
        updatePeaking(pk, s.fc_, s.db, s.q, s.sr);
        expect(gainAtDc(pk), `peaking DC gain — ${settingStr(s)}`).toBeCloseTo(1, 6);
        expect(gainAtNyquist(pk), `peaking Nyquist gain — ${settingStr(s)}`).toBeCloseTo(1, 6);

        // Shelves: A² = 10^(dB/20) in the band they act on, unity in the other.
        const want = Math.pow(10, s.db / 20);
        const ls = makeBiquad();
        updateLowShelf(ls, s.fc_, s.db, s.sr);
        expect(gainAtDc(ls) / want, `low shelf DC gain vs 10^(${s.db}/20) — ${settingStr(s)}`)
          .toBeCloseTo(1, 6);
        expect(gainAtNyquist(ls), `low shelf Nyquist gain — ${settingStr(s)}`).toBeCloseTo(1, 6);

        const hs = makeBiquad();
        updateHighShelf(hs, s.fc_, s.db, s.sr);
        expect(
          gainAtNyquist(hs) / want,
          `high shelf Nyquist gain vs 10^(${s.db}/20) — ${settingStr(s)}`,
        ).toBeCloseTo(1, 6);
        expect(gainAtDc(hs), `high shelf DC gain — ${settingStr(s)}`).toBeCloseTo(1, 6);
      }),
      { numRuns: 400, seed: 15293 },
    );
  });

  // -------------------------------------------------------------------
  // L4 — CACHE-KEY COMPLETENESS. The `k3` bug as a law.
  //
  // `sr` is held FIXED per instance: see the ⚠ SCOPE block at the top —
  // sr is in none of the five cache keys (#1659), unreachable today, filed
  // rather than asserted in either direction.
  // -------------------------------------------------------------------
  it('L4: at fixed sr, changing any argument the math reads changes the coefficients', () => {
    fc.assert(
      fc.property(
        sampleRate,
        fc.double({ min: 50, max: 8000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 50, max: 8000, noNaN: true, noDefaultInfinity: true }),
        qFactor,
        qFactor,
        dbGain,
        dbGain,
        (sr, f1, f2, q1, q2, db1, db2) => {
          // Meaningfully different, so "unchanged" can only mean a stale cache.
          fc.pre(Math.abs(f1 - f2) > 1 && Math.abs(q1 - q2) > 0.05 && Math.abs(db1 - db2) > 0.5);

          // peaking reads THREE parameters — the one that had a two-slot key.
          const pk = makeBiquad();
          updatePeaking(pk, f1, db1, q1, sr);
          const base = coeffs(pk);

          updatePeaking(pk, f1, db1, q2, sr); // Q ONLY — the measured bug
          expect(
            coeffs(pk),
            `updatePeaking ignored a Q-only change (${q1} → ${q2}) at fc=${f1} ` +
              `dB=${db1} sr=${sr}: coefficients came back bit-identical. This is ` +
              `the k3 defect — a stale cache key silently reuses the previous ` +
              `filter's response.`,
          ).not.toEqual(base);

          const pk2 = makeBiquad();
          updatePeaking(pk2, f1, db1, q1, sr);
          updatePeaking(pk2, f1, db2, q1, sr); // dbGain ONLY
          expect(coeffs(pk2), `updatePeaking ignored a dB-only change`).not.toEqual(base);

          const pk3 = makeBiquad();
          updatePeaking(pk3, f1, db1, q1, sr);
          updatePeaking(pk3, f2, db1, q1, sr); // fc ONLY
          expect(coeffs(pk3), `updatePeaking ignored an fc-only change`).not.toEqual(base);

          // The two-parameter updaters, same law over their own arguments.
          for (const [label, apply] of [
            ['lowpass', (b: Biquad, f: number, q: number) => updateLowpass(b, f, sr, q)],
            ['highpass', (b: Biquad, f: number, q: number) => updateHighpass(b, f, sr, q)],
          ] as const) {
            const b = makeBiquad();
            apply(b, f1, q1);
            const b0 = coeffs(b);
            apply(b, f1, q2); // Q only
            expect(coeffs(b), `${label} ignored a Q-only change (${q1} → ${q2})`).not.toEqual(b0);
            const c = makeBiquad();
            apply(c, f1, q1);
            apply(c, f2, q1); // fc only
            expect(coeffs(c), `${label} ignored an fc-only change`).not.toEqual(b0);
          }

          for (const [label, apply] of [
            ['lowShelf', (b: Biquad, f: number, db: number) => updateLowShelf(b, f, db, sr)],
            ['highShelf', (b: Biquad, f: number, db: number) => updateHighShelf(b, f, db, sr)],
          ] as const) {
            const b = makeBiquad();
            apply(b, f1, db1);
            const b0 = coeffs(b);
            apply(b, f1, db2);
            expect(coeffs(b), `${label} ignored a dB-only change`).not.toEqual(b0);
            const c = makeBiquad();
            apply(c, f1, db1);
            apply(c, f2, db1);
            expect(coeffs(c), `${label} ignored an fc-only change`).not.toEqual(b0);
          }
        },
      ),
      { numRuns: 300, seed: 15294 },
    );
  });

  it('L5: biquadStep never emits NaN/Infinity over a bounded input', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...UPDATERS.map((u) => u.label)),
        setting,
        fc.integer({ min: 1, max: 2 ** 30 }),
        (label, s, seed) => {
          const u = UPDATERS.find((x) => x.label === label) as Updater;
          const bq = makeBiquad();
          u.apply(bq, s.sr, s.fc_, s.q, s.db);
          resetBiquad(bq);
          // SEEDED LCG — never Math.random(); the seed is printed on failure so
          // a red CI run reproduces exactly.
          let st = seed >>> 0;
          const next = (): number => {
            st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
            return st / 0x100000000;
          };
          for (let i = 0; i < 4096; i++) {
            const y = biquadStep(bq, next() * 2 - 1);
            if (!Number.isFinite(y)) {
              expect.fail(
                `${label} emitted ${y} at sample ${i} — ${settingStr(s)} seed=${seed} ` +
                  `${coeffStr(bq)}`,
              );
            }
          }
        },
      ),
      { numRuns: 200, seed: 15295 },
    );
  });

  // -------------------------------------------------------------------
  // PERMANENT NEGATIVE CONTROLS.
  // -------------------------------------------------------------------

  it('CONTROL: removing the sr*0.45 clamp VIOLATES L2 (so L2 guards that clamp)', () => {
    // The real updateLowpass with ONE change: `Math.min(fc, sr*0.45)` → `fc`.
    function updateLowpassUnclamped(bq: Biquad, fc_: number, sr: number, Q = Math.SQRT1_2): void {
      const w0 = (2 * Math.PI * fc_) / sr; // ← THE DEFECT
      const cw = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * Q);
      const a0 = 1 + alpha;
      bq.b0 = (1 - cw) / 2 / a0;
      bq.b1 = (1 - cw) / a0;
      bq.b2 = (1 - cw) / 2 / a0;
      bq.a1 = (-2 * cw) / a0;
      bq.a2 = (1 - alpha) / a0;
    }

    let unstable = 0;
    const examples: string[] = [];
    fc.assert(
      fc.property(setting, (s) => {
        const broken = makeBiquad();
        updateLowpassUnclamped(broken, s.fc_, s.sr, s.q);
        if (!isStable(broken)) {
          unstable++;
          if (examples.length < 3) examples.push(`${settingStr(s)} → ${coeffStr(broken)}`);
        }
        // The REAL one must be stable on the very same input.
        const real = makeBiquad();
        updateLowpass(real, s.fc_, s.sr, s.q);
        expect(isStable(real), `the real lowpass went unstable at ${settingStr(s)}`).toBe(true);
      }),
      { numRuns: 400, seed: 15296 },
    );
    expect(
      unstable,
      'an UNCLAMPED lowpass stayed stable across every generated setting. Either ' +
        'the generator stopped producing fc above Nyquist, or isStable() stopped ' +
        'discriminating — in both cases L2 is no longer able to catch a removed clamp.',
    ).toBeGreaterThan(0);
    expect(examples.join('\n')).toMatch(/a2=/);
  });

  it('CONTROL: a two-slot cache key VIOLATES L4 on a Q-only change (the k3 bug)', () => {
    // updatePeaking as it was BEFORE k3 existed: key = (fc, dbGain), no Q.
    function updatePeakingTwoSlotKey(
      bq: Biquad,
      fc_: number,
      db: number,
      Q: number,
      sr: number,
    ): void {
      if (bq.k1 === fc_ && bq.k2 === db) return; // ← THE DEFECT: Q not in the key
      bq.k1 = fc_;
      bq.k2 = db;
      const A = Math.pow(10, db / 40);
      const w0 = (2 * Math.PI * Math.min(fc_, sr * 0.45)) / sr;
      const alpha = Math.sin(w0) / (2 * Q);
      const cw = Math.cos(w0);
      const a0 = 1 + alpha / A;
      bq.b0 = (1 + alpha * A) / a0;
      bq.b1 = (-2 * cw) / a0;
      bq.b2 = (1 - alpha * A) / a0;
      bq.a1 = (-2 * cw) / a0;
      bq.a2 = (1 - alpha / A) / a0;
    }

    // The exact measured case from rbj-biquad.ts's own k3 comment.
    const SR = 48000;
    const FC = 150;
    const DB = 6;
    const broken = makeBiquad();
    updatePeakingTwoSlotKey(broken, FC, DB, 1.0, SR);
    const before = coeffs(broken);
    updatePeakingTwoSlotKey(broken, FC, DB, 8.0, SR);
    expect(
      coeffs(broken),
      'the two-slot-key variant DID respond to a Q-only change — the control is ' +
        'not reproducing the k3 defect, so L4 is not demonstrably able to catch it.',
    ).toEqual(before);

    // …and the real one does not have the bug, on the identical inputs.
    const real = makeBiquad();
    updatePeaking(real, FC, DB, 1.0, SR);
    const realBefore = coeffs(real);
    updatePeaking(real, FC, DB, 8.0, SR);
    expect(
      coeffs(real),
      `updatePeaking regressed to a Q-blind cache key at fc=${FC} dB=${DB} sr=${SR}`,
    ).not.toEqual(realBefore);
  });
});
