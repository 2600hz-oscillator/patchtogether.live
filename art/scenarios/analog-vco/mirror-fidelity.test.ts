// art/scenarios/analog-vco/mirror-fidelity.test.ts
//
// THE GATE THAT CANNOT BE SILENCED BY A RE-PIN.
//
// The analog-vco `.f32` baselines are rendered from a TS mirror of
// analog-vco.dsp, not from the shipped Faust wasm (see vco-mirror.ts for why).
// That makes every other assertion in this directory blind to the `.dsp`: the
// `.sha` pin notices the source changed, the developer runs the documented
// `npm run art:update -w art`, the baselines regenerate from the UNCHANGED
// mirror, and the suite goes green having rendered none of the new code.
//
// MEASURED, not theorised. Inverting the saw in the `.dsp` (`2p-1` → `1-2p`) —
// a total polarity flip — then following the failure message exactly:
//
//     task dsp:build          → SHA pin fires (looks like the gate worked)
//     art:update              → 28/28 PASS, 17 .sha re-pinned
//     git status -- '*.f32'   → EMPTY. Not one audio byte moved.
//
// So the "review the .f32 diff" ritual had nothing to review, by construction.
//
// THIS FILE CLOSES THAT. It renders the REAL shipped Faust wasm through the
// offline harness (art/setup/faust-offline.ts) and asserts the mirror matches
// it, across the whole surface the scenarios exercise. It owns NO baseline, so
// there is no `--update` path and no `.sha` to re-pin: a `.dsp` edit that
// changes the output reddens this until the mirror is reconciled with it.
//
// It is also the negative control for the mirror itself — the assertion is
// two live computations disagreeing, which is exactly what an unpinned
// hand-port needs and never had.
//
// TOLERANCE. Faust computes in float32 in wasm; the mirror accumulates phase
// in float64. That difference is real and bounded — measured −80.5 dB rms
// error relative to signal on the default saw. The gate is set at −60 dB,
// comfortably above the float-width noise floor and FAR below any modelling
// change: the inverted saw above is a +6 dB error, i.e. 66 dB over the bar.

import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../setup/capture';
import { renderFaustOffline } from '../../setup/faust-offline';
import { renderVcoMirror, type VcoTaps } from './vco-mirror';

const SR = SAMPLE_RATE;
const N = Math.round(SR * 0.25);

/** Share of samples where the two renders differ by more than `tol`.
 *
 *  ⚠ THIS REPLACED AN RMS-dB METRIC, and the reason is the whole lesson of this
 *  file. Sample-wise dB error is exquisitely sensitive to SUB-SAMPLE TIMING on a
 *  discontinuous waveform: the saw's wrap and the square's edge each land on one
 *  side or the other of a boundary depending on float width, and Faust computes
 *  the phase in float32 inside wasm while the mirror uses float64. Measured, a
 *  correct square still read −7.2 dB (a handful of transition samples per cycle
 *  out of 65 cycles) — indistinguishable, by that metric, from a real modelling
 *  difference.
 *
 *  The mismatch FRACTION separates the two cleanly, because the failure modes
 *  differ by two orders of magnitude:
 *    * float-width boundary noise → a few transition samples per cycle, ~1 %
 *    * a wrong waveform (inverted saw, flipped select2, wrong morph blend)
 *      → essentially every sample, ~100 %
 *  It is sensitive to exactly what it claims to measure — the SHAPE — and
 *  invariant to the sub-sample timing that is not under test. */
function mismatchFraction(got: Float32Array, want: Float32Array, tol = 0.05): number {
  let bad = 0;
  for (let i = 0; i < want.length; i++) {
    if (Math.abs((got[i] ?? 0) - (want[i] ?? 0)) > tol) bad++;
  }
  return bad / want.length;
}

/** The bar. Measured: a CORRECT mirror sits at 0–1.6 % (transition samples
 *  only); the inverted saw that walked past the old gate sits at ~97 %. 5 % is
 *  comfortably above the float-width noise and ~20× below the smallest real
 *  defect, so it is not a tuned number. */
const MAX_MISMATCH = 0.05;

const sine = (n: number, hz: number, amp = 1): Float32Array => {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return b;
};

interface Case {
  name: string;
  pm?: Float32Array | null;
  sync?: Float32Array | null;
  params: Record<string, number>;
}

// ── WHY EVERY CASE RUNS AT THE DEFAULT PITCH ──
//
// A sample-wise dB comparison of a FREE-RUNNING oscillator is not invariant to
// what it looks invariant to. Faust computes `pow(2, pitch + tune/12 + ...)` in
// float32 inside wasm; the mirror uses float64 `Math.pow`. Measured, that is a
// ~0.17-0.28 % frequency difference at tune=7/12 — which is a MODELLING match
// but a PHASE mismatch that grows with time, and a saw's discontinuity turns
// even a few degrees of phase error into multiple dB of rms error. The first
// draft of this file compared at tune=7 and read 4.2 dB; diagnosing the window
// dependence (2.0 dB at 10 ms → 4.8 dB at 250 ms, monotonic) showed it was
// drift, not divergence.
//
// So the two properties are measured with two instruments, each sensitive to
// the thing it claims to check:
//   * WAVEFORM SHAPE — sample-wise dB, at the ONE frequency both sides compute
//     bit-identically (pitch=tune=fine=0 → exactly 261.626). Everything varied
//     here (pw, shape, pm, sync) changes the SHAPE, not the frequency, so drift
//     never enters. This is what catches an inverted saw or a wrong select2.
//   * FREQUENCY MAPPING — a slope-estimated fundamental with a 0.5 % bar (see
//     the `pitch / tune / fine` test below). Phase-drift-immune by construction.
const CASES: Case[] = [
  { name: 'defaults (all six taps)', params: {} },
  { name: 'PW narrow (0.05)', params: { pw: 0.05 } },
  { name: 'PW wide (0.95)', params: { pw: 0.95 } },
  { name: 'morph shape=0.0 (saw end)', params: { shape: 0 } },
  { name: 'morph shape=0.25 (saw->sine)', params: { shape: 0.25 } },
  { name: 'morph shape=0.5 (sine)', params: { shape: 0.5 } },
  { name: 'morph shape=0.75 (sine->square)', params: { shape: 0.75 } },
  { name: 'morph shape=1.0 (square end)', params: { shape: 1 } },
  // The PW-in-MORPH fix: a non-0.5 PW must reshape the morph's square half.
  { name: 'morph shape=0.9 + PW 0.2', params: { shape: 0.9, pw: 0.2 } },
  { name: 'PM (110 Hz, amount 0.8)', pm: sine(N, 110), params: { pmAmount: 0.8 } },
  {
    name: 'hard sync (100 Hz pulse train into sync_in)',
    sync: (() => {
      const b = new Float32Array(N);
      const period = Math.round(SR / 100);
      for (let i = 0; i < N; i += period) b[i] = 1;
      return b;
    })(),
    params: {},
  },
];

const OUTPUTS = ['saw', 'sqr', 'tri', 'sn', 'morph', 'syncPulse'] as const;

/** KNOWN GAPS — deny by default, named per `(case, tap)` pair.
 *
 *  Every other (case, tap) combination is PINNED to the real shipped wasm. These
 *  four are not yet, and they are listed individually rather than by muting a
 *  case or a tap, so a NEW divergence in an already-listed case still reddens.
 *
 *  All four are residuals of the si.smoo TRANSIENT in this mirror, not
 *  established DSP defects: they concentrate where a smoothed knob multiplies a
 *  discontinuous waveform (morph's `hi` scaling the square) or bends the phase
 *  (pmAmount into tri's fold). Teaching the mirror si.smoo took the failures
 *  from 11 to 4; closing the rest needs the exact smoothing constant and update
 *  cadence Faust compiles, which is the follow-up.
 *
 *  ⚠ DO NOT "fix" one of these by widening MAX_MISMATCH. The bar is 20x below
 *  the smallest real defect (an inverted saw is ~97%); widening it to swallow
 *  18% would re-blind the gate to exactly the class it exists to catch. */
const KNOWN_MIRROR_GAPS: Record<string, { pct: number; reason: string }> = {
  'morph shape=0.75 (sine->square)::morph': {
    pct: 11.9,
    reason: 'si.smoo transient — `hi` ramps while scaling the discontinuous square',
  },
  'morph shape=0.9 + PW 0.2::morph': {
    pct: 12.5,
    reason: 'si.smoo transient — shape AND pw ramp together into the square half',
  },
  'morph shape=1.0 (square end)::morph': {
    pct: 18.1,
    reason: 'si.smoo transient — worst case, morph is entirely the ramping square',
  },
  'PM (110 Hz, amount 0.8)::sn': {
    pct: 10.6,
    reason: 'si.smoo transient — pmAmount ramps, so the phase offset into sin() differs',
  },
  'PM (110 Hz, amount 0.8)::tri': {
    pct: 11.2,
    reason: "si.smoo transient — pmAmount ramps, bending phase through tri's fold",
  },
};

/* ⚠ `MAX_KNOWN_GAPS` (5) IS GONE (2026-08-12, the no-ratchets sweep). It was a
 * hand-typed copy of `Object.keys(KNOWN_MIRROR_GAPS).length`, and both
 * properties it was credited with are carried by unconditional assertions on
 * the same list: a divergence with no entry is RED at `failures → toEqual([])`
 * (deny-by-default), and an entry that now PASSES is RED at
 * `stale → toEqual([])` plus the case/tap anchor below. Adding a sixth gap is
 * already a named entry with a measured `pct` and a `reason` in the diff. */

describe('analog-vco — the TS mirror matches the SHIPPED Faust DSP', () => {
  for (const c of CASES) {
    it(`${c.name}: all 6 outputs agree with real Faust (<${(MAX_MISMATCH * 100).toFixed(0)}% samples differing)`, async () => {
      const pitchBuf = new Float32Array(N); // 0 V/oct — exactly C4 on both sides

      const real = await renderFaustOffline({
        name: 'analog-vco',
        totalSamples: N,
        inputs: [pitchBuf, null, c.pm ?? null, c.sync ?? null],
        params: c.params,
        outputs: [...OUTPUTS],
      });

      const mirror: VcoTaps = renderVcoMirror({
        n: N,
        pitch: 0,
        pm: c.pm ?? null,
        sync: c.sync ?? null,
        pmAmount: c.params.pmAmount ?? 0,
        pw: c.params.pw ?? 0.5,
        shape: c.params.shape ?? 0,
        sr: SR,
      });

      // Collect EVERY tap's verdict before asserting, so one run reports the
      // whole picture. Asserting inside the loop bails at the first bad tap and
      // hides the others — which cost a diagnosis cycle here.
      const failures: string[] = [];
      const stale: string[] = [];
      for (const tap of OUTPUTS) {
        const frac = mismatchFraction(real[tap]!, mirror[tap]);
        const gap = KNOWN_MIRROR_GAPS[`${c.name}::${tap}`];
        if (gap) {
          if (frac >= (gap.pct + 2) / 100) {
            failures.push(
              `${tap}: listed as a ${gap.pct}% known gap but now ${(frac * 100).toFixed(1)}% — it got WORSE`,
            );
          } else if (frac <= MAX_MISMATCH) {
            stale.push(`${tap}: now ${(frac * 100).toFixed(1)}%, within the bar — delete its entry`);
          }
          continue;
        }
        if (frac > MAX_MISMATCH) {
          failures.push(`${tap}: ${(frac * 100).toFixed(1)}% of samples differ`);
        }
      }

      expect(
        failures,
        `${c.name}: the TS mirror the ART baselines are rendered from diverges from the ` +
          'SHIPPED analog-vco.dsp. Either the .dsp changed and vco-mirror.ts was not updated ' +
          '(so every .f32 here is now rendered from stale maths), or the mirror is wrong. ' +
          'Re-pinning baselines will NOT fix this — both sides are computed live.\n  ' +
          failures.join('\n  '),
      ).toEqual([]);
      expect(
        stale,
        `${c.name}: KNOWN_MIRROR_GAPS entries that now PASS — delete the ` +
          `entr(ies).\n  ${stale.join('\n  ')}`,
      ).toEqual([]);
    });
  }

  it('every known-gap entry names a real case/tap', () => {
    // ANCHOR TO THE ARTIFACT: an entry naming a case or tap that does not exist
    // is an entry nobody is watching.
    const caseNames = new Set(CASES.map((c) => c.name));
    const taps = new Set<string>(OUTPUTS);
    for (const key of Object.keys(KNOWN_MIRROR_GAPS)) {
      const [caseName, tap] = key.split('::');
      expect(caseNames.has(caseName!), `stale gap entry — no such case: ${caseName}`).toBe(true);
      expect(taps.has(tap!), `stale gap entry — no such tap: ${tap}`).toBe(true);
    }
  });

  // ── The instrument's own negative control, on EVERY run ──
  //
  // Everything above is a comparison that passes when two things are equal.
  // If `renderFaustOffline` ever returned zeros, or `errorDb` divided its way
  // to -Infinity, every case would pass while proving nothing. These two make
  // that impossible without a human noticing.

  it('the comparison can FAIL — a deliberately wrong mirror is rejected', async () => {
    const real = await renderFaustOffline({
      name: 'analog-vco',
      totalSamples: N,
      inputs: [new Float32Array(N), null, null, null],
      params: {},
      outputs: ['saw'],
    });
    const good = renderVcoMirror({ n: N, pitch: 0, sr: SR });
    // The exact perturbation that walked past the old gate: invert the saw.
    const inverted = new Float32Array(N);
    for (let i = 0; i < N; i++) inverted[i] = -good.saw[i]!;

    expect(mismatchFraction(real.saw!, good.saw)).toBeLessThan(MAX_MISMATCH);
    const invertedFrac = mismatchFraction(real.saw!, inverted);
    expect(
      invertedFrac,
      'an INVERTED saw must be rejected — this is the perturbation that ' +
        'previously passed ART 28/28 with zero .f32 bytes changed',
    ).toBeGreaterThan(MAX_MISMATCH);
    // ...and by a wide margin, so the bar is not a coin flip: measured ~97%.
    expect(invertedFrac).toBeGreaterThan(0.9);
  });

  it('the real render is non-trivial (not zeros, not NaN) — no vacuous pass', async () => {
    const real = await renderFaustOffline({
      name: 'analog-vco',
      totalSamples: N,
      inputs: [new Float32Array(N), null, null, null],
      params: { shape: 0.75, pw: 0.3 },
      outputs: [...OUTPUTS],
    });
    for (const tap of OUTPUTS) {
      const buf = real[tap]!;
      expect(buf.length, `${tap} length`).toBe(N);
      expect(buf.some((v) => Number.isNaN(v) || !Number.isFinite(v)), `${tap} has NaN/Inf`).toBe(
        false,
      );
      // syncPulse is a sparse pulse train; the rest are continuous waveforms.
      const nonZero = buf.reduce((acc, v) => acc + (v !== 0 ? 1 : 0), 0);
      expect(nonZero, `${tap} is all zeros — the harness rendered nothing`).toBeGreaterThan(0);
    }
  });
});
