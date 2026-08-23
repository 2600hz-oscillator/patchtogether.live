// packages/web/src/lib/ui/modules/resofilter-face-model.test.ts
//
// The PERMANENT gate behind resofilter's three derived readouts and its
// sidebar curve. Three jobs, and the middle one is the one that matters:
//
//   1. ORACLE — every closed form is re-derived from the SHIPPING DSP
//      (`renderResofilter`, the same code the worklet runs) on every run, so a
//      DSP change turns a stale faceplate claim RED instead of leaving the
//      panel confidently wrong.
//   2. NEGATIVE CONTROLS, in both directions, on the input a knob readback
//      would be BLIND to — and here the two headline readouts are each other's
//      control: `peak` is live in LP/HP/BP and `width` in BP/NT/AP, so a
//      derivation that got the MODE partition wrong prints a number exactly
//      where the other prints `—`.
//   3. A TOLERANCE LEG — a deliberately wrong model must redden the oracle. An
//      oracle nobody has proven can fail is decoration.
//
// ⚠ COST. The unit lane runs ~2.5× slower than local against vitest's 5000 ms
// default, so the audio legs are deliberately small: every render is ≤ 2 s of
// 48 kHz mono and there is not a single FREQUENCY SCAN in this file. Where a
// −3 dB crossing is needed the closed form PREDICTS the frequency and the
// oracle checks the gain THERE, which is one render instead of a few hundred —
// and is a strictly stronger assertion, because a scan can only find whatever
// crossing exists while this one has to find it at the predicted place.

import { describe, expect, it } from 'vitest';
import { renderResofilter, resToK } from '../../../../../dsp/src/lib/resofilter-dsp';
import { resofilterDef, RESOFILTER_MODE_NAMES, RESOFILTER_MODE_SHORT } from '$lib/audio/modules/resofilter';
import {
  MODES_WITH_PEAK,
  MODES_WITH_WIDTH,
  RESOFILTER_CLAMP_RES,
  RESOFILTER_K_FLOOR,
  resofilterCvReachText,
  resofilterFaceParams,
  resofilterPeakText,
  resofilterWidthText,
  svfCutoffReach,
  svfDamping,
  svfDelivered,
  svfModeIndex,
  svfPeakDb,
  svfPhaseCurve,
  svfResponseCurve,
  svfWidthOct,
  type ResofilterFaceParams,
  type SvfModeIndex,
} from './resofilter-face-model';

const SR = 48000;
const MODES: readonly SvfModeIndex[] = [0, 1, 2, 3, 4];
const TAG = (m: SvfModeIndex): string => RESOFILTER_MODE_SHORT[m]!;

// ── the measuring instruments ───────────────────────────────────────────────

function sine(hz: number, n: number, amp = 0.5): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return a;
}
/** Deterministic broadband source — a plain LCG, so every run measures the
 *  same signal and a "flake" here can only be a real change. */
function noise(n: number, seed = 12345): Float32Array {
  const a = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    a[i] = (s / 4294967296) * 2 - 1;
  }
  return a;
}
const rmsFrom = (a: Float32Array, from: number): number => {
  let s = 0;
  let n = 0;
  for (let i = from; i < a.length; i++) {
    s += a[i]! * a[i]!;
    n++;
  }
  return Math.sqrt(s / Math.max(1, n));
};
const dbOf = (x: number): number => 20 * Math.log10(Math.max(x, 1e-15));

/**
 * The SHIPPING filter's steady-state gain at one frequency, in dB.
 *
 * ⚠ `secs` IS NOT A TUNING KNOB, IT IS THE WHOLE POINT OF TWO OF THIS FILE'S
 * FINDINGS. A resonance-1.0 SVF is Q ≈ 333 and rings for ~0.1 s per time
 * constant; the batch-4 spec measured it on a 1 s render and reported BOTH the
 * plateau gain (50.441 dB, converging to 50.4576) and the notch depth
 * (−68.0 dB, converging to −154.9) as if they were properties of the filter.
 * Measure over the LAST quarter-second of a render long enough to have settled.
 */
function gainDb(hz: number, fc: number, res: number, mode: SvfModeIndex, mix = 1, secs = 2): number {
  const n = Math.round(SR * secs);
  const inp = sine(hz, n);
  const out = renderResofilter(inp, { cutoffHz: fc, res, mode, mix, sr: SR });
  const from = n - SR / 4;
  return dbOf(rmsFrom(out, from)) - dbOf(rmsFrom(inp, from));
}

const params = (over: Partial<ResofilterFaceParams> = {}): ResofilterFaceParams => ({
  cutoff: 1000,
  resonance: 0.3,
  mode: 0,
  mix: 1,
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
describe('resofilter face model — ORACLE: every printed number comes from the shipping DSP', () => {
  // ── the PEAK ──────────────────────────────────────────────────────────────
  it('the PEAK readout is the measured gain at cutoff, in LP, HP and BP alike', () => {
    // 1/k, and the measurement says so to a hundredth of a dB in all three
    // modes. This is the number the whole faceplate is built on.
    const rows: string[] = [];
    for (const mode of [0, 1, 2] as SvfModeIndex[]) {
      for (const res of [0, 0.6, 0.9]) {
        const measured = gainDb(1000, 1000, res, mode);
        const printed = svfPeakDb(res);
        rows.push(`${TAG(mode)} res ${res}: model ${printed.toFixed(3)} vs DSP ${measured.toFixed(3)} dB`);
        expect(Math.abs(printed - measured), rows.at(-1)).toBeLessThan(0.05);
      }
    }
    expect(rows).toHaveLength(9);
  });

  it('the PEAK is INVARIANT TO CUTOFF — the TPT prewarp puts the resonance exactly at fc', () => {
    // The reason `svfPeakDb` needs no cutoff argument and no sample rate, and
    // the reason it is EXACT where the width is only close (see below).
    for (const fc of [50, 1000, 15000]) {
      const measured = gainDb(fc, fc, 0.9, 0);
      expect(Math.abs(svfPeakDb(0.9) - measured), `fc ${fc} Hz: gain at cutoff is still 1/k`).toBeLessThan(0.05);
    }
  });

  it('the PLATEAU is real and its floor is the SHIPPING constant, not a back-derived one', () => {
    // ⚠ THE SPEC GOT THIS WRONG BY INFERRING A DSP CONSTANT FROM A MEASUREMENT.
    // It reports 50.441 dB and an "implied k_min ≈ 0.003006". `resToK` floors k
    // at EXACTLY 0.003 — 50.4576 dB — and the 0.017 dB gap was a 1 s render
    // that had not settled.
    expect(RESOFILTER_K_FLOOR).toBe(0.003);
    expect(RESOFILTER_CLAMP_RES).toBeCloseTo(0.9985, 12);
    // everything from the clamp to 1.0 is the SAME filter…
    expect(svfPeakDb(1)).toBe(svfPeakDb(RESOFILTER_CLAMP_RES));
    // …and just below it, it is not — so the plateau is a real edge, not a
    // rounding artifact of the formatter.
    expect(svfPeakDb(0.998)).toBeLessThan(svfPeakDb(RESOFILTER_CLAMP_RES) - 2);
    // and the DSP agrees, on a render long enough to have settled.
    expect(Math.abs(gainDb(1000, 1000, 1, 0) - svfPeakDb(1))).toBeLessThan(0.05);
    expect(svfPeakDb(1)).toBeCloseTo(50.4576, 3);
  });

  // ── the WIDTH ─────────────────────────────────────────────────────────────
  it('the WIDTH readout lands the −3 dB edges where it says they are (BP and NT)', () => {
    // No scan: the closed form NAMES the two frequencies and the DSP is asked
    // for the gain THERE. A scan could only find whatever edge exists; this has
    // to find it at the predicted place.
    for (const res of [0.3, 0.9]) {
      const halfOct = svfWidthOct(res) / 2;
      const hi = 1000 * Math.pow(2, halfOct);
      const lo = 1000 / Math.pow(2, halfOct);

      // BAND-PASS: 3 dB below its own peak.
      const bpPeak = gainDb(1000, 1000, res, 2);
      for (const [f, side] of [[hi, 'upper'], [lo, 'lower']] as const) {
        const d = gainDb(f, 1000, res, 2) - bpPeak;
        expect(Math.abs(d + 3), `BP res ${res} ${side} edge: ${d.toFixed(3)} dB from peak`).toBeLessThan(0.15);
      }
      // NOTCH: 3 dB below unity — the same two frequencies, same denominator.
      for (const [f, side] of [[hi, 'upper'], [lo, 'lower']] as const) {
        const d = gainDb(f, 1000, res, 3);
        expect(Math.abs(d + 3), `NT res ${res} ${side} edge: ${d.toFixed(3)} dB`).toBeLessThan(0.15);
      }
    }
  });

  it('the NOTCH is a TRUE ZERO at every resonance — only its WIDTH moves', () => {
    // ⚠ THE SECOND SPEC FIGURE THAT WAS A SETTLING ARTIFACT. It reports the
    // notch as "50 dB deep and zero octaves wide" at resonance 1.0 against
    // −155 dB elsewhere, and concludes the DEPTH is resonance-dependent. On a
    // settled render it is −154.9 dB at resonance 1.0 too: the depth is the
    // f64 noise floor at every setting and the dial only ever moves the width.
    for (const res of [0, 0.3, 0.9, 1]) {
      expect(gainDb(1000, 1000, res, 3), `NT res ${res}: depth at cutoff`).toBeLessThan(-100);
    }
    // …and the width genuinely collapses over that same travel.
    expect(svfWidthOct(0)).toBeGreaterThan(2.5);
    expect(svfWidthOct(1)).toBeLessThan(0.01);
  });

  it('the WIDTH is the PREWARP-FREE value — the gap to the shipping filter is MEASURED, not assumed', () => {
    // The one approximation on this face, pinned in both directions so the
    // stated limitation cannot silently grow. The digital width uses the same
    // crossing condition through the bilinear warp.
    const digitalWidthOct = (res: number, fc: number): number => {
      const k = resToK(res);
      const root = Math.sqrt(k * k + 4);
      const g = Math.tan((Math.PI * Math.min(fc, SR * 0.49)) / SR);
      const f = (w: number): number => (SR / Math.PI) * Math.atan(w * g);
      return Math.log2(f((k + root) / 2) / f((root - k) / 2));
    };
    // negligible where the module lives…
    expect(Math.abs(svfWidthOct(0.3) - digitalWidthOct(0.3, 1000))).toBeLessThan(0.01);
    expect(Math.abs(svfWidthOct(0.3) - digitalWidthOct(0.3, 2000))).toBeLessThan(0.04);
    // …and genuinely large near Nyquist, which is why `docs.controls.resonance`
    // says so. If this ever passes at 15 kHz, the model changed and the prose
    // is stale.
    expect(svfWidthOct(0.3) - digitalWidthOct(0.3, 15000)).toBeGreaterThan(0.5);
  });

  // ── the ALLPASS, in both directions ───────────────────────────────────────
  it('ALLPASS: the level does not move at all, and the SIGNAL does — both legs', () => {
    // The two-sided control the whole `width`-in-AP decision rests on. A
    // readout claiming "no effect" in allpass would be as wrong as the level
    // metric that reports 0.00 dB of span.
    const inp = noise(SR, 4242);
    const ref = renderResofilter(inp, { cutoffHz: 1000, res: 0, mode: 4, sr: SR });
    const hot = renderResofilter(inp, { cutoffHz: 1000, res: 0.9, mode: 4, sr: SR });
    const from = SR / 2;
    // (a) INVARIANT IN LEVEL — the instrument a level-based readout would use.
    expect(
      Math.abs(dbOf(rmsFrom(hot, from)) - dbOf(rmsFrom(ref, from))),
      'AP: broadband RMS is unchanged by RESONANCE',
    ).toBeLessThan(0.01);
    // (b) NOT INERT — the fact that instrument cannot see.
    let maxDelta = 0;
    for (let i = from; i < inp.length; i++) maxDelta = Math.max(maxDelta, Math.abs(hot[i]! - ref[i]!));
    expect(maxDelta, 'AP: the samples genuinely differ (pure phase rotation)').toBeGreaterThan(0.5);
  });

  it('ALLPASS: the model draws PHASE there because the magnitude curve is a flat line', () => {
    const ap = params({ mode: 4, resonance: 0.9 });
    const mags = svfResponseCurve(ap, 64).map((p) => p.db);
    expect(Math.max(...mags) - Math.min(...mags), 'AP fully wet: magnitude is flat').toBeLessThan(0.01);
    // …and the phase trace is emphatically not.
    const phase = svfPhaseCurve(ap, 64).map((p) => p.db);
    expect(Math.max(...phase) - Math.min(...phase), 'AP: phase sweeps').toBeGreaterThan(180);
  });

  // ── MIX ───────────────────────────────────────────────────────────────────
  it('MIX crossfades COMPLEX values — a magnitude blend gets the PHASER completely wrong', () => {
    // LP, resonance 0.9, at cutoff. Dry and wet are 90° apart there, so the
    // naive `(1-m)·|dry| + m·|wet|` is not merely imprecise.
    const k = svfDamping(0.9);
    const modelDb = (mode: SvfModeIndex, mix: number, w = 1): number => {
      const c = svfDelivered(w, k, mode, mix);
      return 20 * Math.log10(Math.max(Math.hypot(c.re, c.im), 1e-15));
    };
    for (const mix of [0, 0.25, 0.5, 0.75, 1]) {
      const model = modelDb(0, mix);
      const measured = gainDb(1000, 1000, 0.9, 0, mix);
      expect(Math.abs(model - measured), `mix ${mix}: model ${model.toFixed(3)} vs DSP ${measured.toFixed(3)}`)
        .toBeLessThan(0.05);
    }

    // ── THE NEGATIVE CONTROL ON THE MODEL'S OWN ARITHMETIC ──
    // (a) In LOW-PASS the plausible wrong implementation is off by 1.41 dB at
    //     mix 0.5 — 9.542 dB against a measured 8.129 — which is 28× the 0.05
    //     dB tolerance above, so the loop would have caught it. Modest, and
    //     stated as the modest number it is rather than the dramatic one: an
    //     earlier draft of this comment claimed "14 dB" from a broken scratch
    //     formula and this leg is what found it.
    const naiveLp = 20 * Math.log10(0.5 * 1 + 0.5 * (1 / k));
    expect(naiveLp).toBeCloseTo(9.542, 2);
    expect(Math.abs(naiveLp - gainDb(1000, 1000, 0.9, 0, 0.5))).toBeGreaterThan(1.3);

    // (b) In ALLPASS it is not a tolerance question at all. |H_AP| ≡ 1, so a
    //     magnitude blend predicts a FLAT 0 dB at every frequency and every
    //     mix — while the real thing is a deep null at cutoff, because the
    //     rotating phase cancels against the dry path. That is the phaser, and
    //     it is the entire reason MIX is worth drawing on this face.
    const naiveAp = 20 * Math.log10(0.5 * 1 + 0.5 * 1);
    expect(naiveAp).toBe(0);
    expect(modelDb(4, 0.5), 'AP at mix 0.5: the model predicts a null at cutoff').toBeLessThan(-60);
    expect(gainDb(1000, 1000, 0.6, 4, 0.5), 'AP at mix 0.5: the DSP delivers one').toBeLessThan(-60);
    // …and away from cutoff the same mixed allpass is essentially untouched,
    // so it is a NOTCH and not an attenuator.
    expect(Math.abs(gainDb(250, 1000, 0.6, 4, 0.5))).toBeLessThan(0.5);
  });

  it('MIX 0 is BIT-EXACT dry in all five modes', () => {
    const inp = noise(SR / 4, 7);
    for (const mode of MODES) {
      const out = renderResofilter(inp, { cutoffHz: 1000, res: 0.9, mode, mix: 0, sr: SR });
      let worst = 0;
      for (let i = 0; i < inp.length; i++) worst = Math.max(worst, Math.abs(out[i]! - inp[i]!));
      expect(worst, `${TAG(mode)}: mix 0 is the input, sample for sample`).toBe(0);
    }
  });

  it('an unpatched insert is silent — the `scope` glyph has nothing to draw, by construction', () => {
    // Why the compact VRT tile baselines flat, stated as a measurement rather
    // than as an assumption: a linear filter with no input has nothing to ring,
    // even a hair below self-oscillation.
    for (const mode of MODES) {
      const out = renderResofilter(new Float32Array(4800), { cutoffHz: 1000, res: 0.999, mode, sr: SR });
      let peak = 0;
      for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
      expect(peak, `${TAG(mode)}: silent in, silent out`).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('resofilter face model — NEGATIVE CONTROLS (the blindness each readout exists for)', () => {
  it('THE BLINDNESS: a `paramId: resonance` readout prints the SAME string in all five modes', () => {
    // The declaration this face rejected, stated as the assertion that
    // justifies rejecting it. The knob is right and says nothing.
    const readback = new Set(MODES.map(() => (0.3).toFixed(2)));
    expect(readback.size, 'a resonance readback is mode-invariant').toBe(1);
    // …while what the dial DOES changes kind across the same five states.
    const printed = MODES.map((mode) => {
      const p = params({ mode, resonance: 0.9 });
      return `${resofilterPeakText(p)} / ${resofilterWidthText(p)}`;
    });
    expect(new Set(printed).size, `the pair distinguishes the modes: ${printed.join(' · ')}`).toBeGreaterThan(2);
  });

  it('PEAK and WIDTH are each other’s MODE control — exactly one is live, except in BP', () => {
    for (const mode of MODES) {
      const p = params({ mode, resonance: 0.9 });
      const peak = resofilterPeakText(p);
      const width = resofilterWidthText(p);
      expect(peak === '—', `${TAG(mode)}: peak`).toBe(!MODES_WITH_PEAK.has(mode));
      expect(width === '—', `${TAG(mode)}: width`).toBe(!MODES_WITH_WIDTH.has(mode));
      // never both blank: every mode says something about what RESO is doing.
      expect(peak === '—' && width === '—', `${TAG(mode)}: at least one is live`).toBe(false);
    }
    // and the partitions are the measured ones, not a convenient split
    expect([...MODES_WITH_PEAK].sort()).toEqual([0, 1, 2]);
    expect([...MODES_WITH_WIDTH].sort()).toEqual([2, 3, 4]);
  });

  it('PEAK and WIDTH move with RESONANCE — in OPPOSITE directions — and neither moves with CUTOFF or MIX', () => {
    const lo = params({ mode: 2, resonance: 0.2 });
    const hi = params({ mode: 2, resonance: 0.95 });
    expect(svfPeakDb(hi.resonance)).toBeGreaterThan(svfPeakDb(lo.resonance) + 15);
    expect(svfWidthOct(hi.resonance)).toBeLessThan(svfWidthOct(lo.resonance) / 5);
    // invariance, both readouts, both other knobs
    for (const over of [{ cutoff: 80 }, { cutoff: 12000 }, { mix: 0 }, { mix: 0.5 }]) {
      const moved = params({ mode: 2, resonance: 0.9, ...over });
      const base = params({ mode: 2, resonance: 0.9 });
      expect(resofilterPeakText(moved), `peak is invariant to ${JSON.stringify(over)}`)
        .toBe(resofilterPeakText(base));
      expect(resofilterWidthText(moved), `width is invariant to ${JSON.stringify(over)}`)
        .toBe(resofilterWidthText(base));
    }
  });

  it('CV REACH is the MIRROR: it moves with CUTOFF and is blind to everything the other two see', () => {
    const base = params();
    const moved = params({ cutoff: 8000 });
    expect(resofilterCvReachText(moved)).not.toBe(resofilterCvReachText(base));
    for (const over of [{ resonance: 0 }, { resonance: 1 }, { mode: 4 as SvfModeIndex }, { mix: 0 }]) {
      expect(resofilterCvReachText(params(over)), `cv reach is invariant to ${JSON.stringify(over)}`)
        .toBe(resofilterCvReachText(base));
    }
    // Publishing all three together is the set's own control: perturb one input
    // and EXACTLY the readouts that depend on it move.
    expect(resofilterCvReachText(base)).toBe('20 Hz – 10.99 kHz');
  });

  it('CV REACH reports the ASYMMETRY that motivated it — linear-in-Hz CV on a log taper', () => {
    // At the bottom of the dial the CUTOFF CV cannot travel DOWNWARD at all,
    // and near the top it is nine octaves of downward sweep. A `log` cvScale
    // would be ±4.98 octaves everywhere. Measured off the def's own min/max,
    // never typed.
    const atMin = svfCutoffReach(params({ cutoff: 20 }));
    expect(atMin.octavesDown).toBe(0);
    expect(atMin.octavesUp).toBeGreaterThan(8.9);
    const atDefault = svfCutoffReach(params({ cutoff: 1000 }));
    expect(atDefault.octavesDown).toBeCloseTo(5.644, 2);
    expect(atDefault.octavesUp).toBeCloseTo(3.458, 2);
    expect(
      Math.abs(atDefault.octavesDown - atDefault.octavesUp),
      'the window is asymmetric — this is the finding',
    ).toBeGreaterThan(2);
  });

  it('TOLERANCE LEG: a 0.5 dB error in the peak law would REDDEN the oracle', () => {
    // An oracle nobody has proven can fail is decoration. The peak leg asserts
    // to 0.05 dB, so a model 10× that far out must be caught.
    const wrong = (res: number): number => svfPeakDb(res) + 0.5;
    const measured = gainDb(1000, 1000, 0.9, 0);
    expect(Math.abs(svfPeakDb(0.9) - measured)).toBeLessThan(0.05);
    expect(Math.abs(wrong(0.9) - measured)).toBeGreaterThan(0.05);
  });

  it('TOLERANCE LEG: the ANALOG width standing in for the DIGITAL one at 15 kHz would be caught', () => {
    // The stated approximation, negative-controlled: if someone "fixed" the
    // model to the digital form the two would agree at 1 kHz and diverge at
    // 15 kHz, which is exactly what the divergence pin above asserts.
    expect(svfWidthOct(0.3)).toBeCloseTo(1.8832, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('resofilter face model — the WORKLET’s own rounding, and the def wiring', () => {
  it('MODE rounds at EXACTLY 0.5 and clamps — the same arithmetic resofilter.ts:117 runs', () => {
    expect(svfModeIndex(0.4)).toBe(0);
    expect(svfModeIndex(0.5)).toBe(1); // Math.round(0.5) === 1
    expect(svfModeIndex(4.6)).toBe(4);
    expect(svfModeIndex(-3)).toBe(0);
    expect(svfModeIndex(undefined)).toBe(0);
    expect(svfModeIndex(Number.NaN)).toBe(0);
  });

  it('the def’s MODE roster is DERIVED from the shipping name tables, not re-typed', () => {
    const mode = resofilterDef.params.find((p) => p.id === 'mode')!;
    expect(mode.options?.map((o) => o.label)).toEqual([...RESOFILTER_MODE_SHORT]);
    expect(mode.options?.map((o) => o.title)).toEqual([...RESOFILTER_MODE_NAMES]);
    expect(mode.options?.map((o) => o.value)).toEqual([0, 1, 2, 3, 4]);
    // every value is inside the declared range — a roster is a set of DETENTS
    expect(mode.options?.every((o) => o.value >= mode.min && o.value <= mode.max)).toBe(true);
  });

  it('the MODE captions are the SHORTEST the roster has — and three still clip at the dock', () => {
    // ⚠ THIS TEST USED TO ASSERT THE OPPOSITE CONCLUSION FROM THE SAME FACT,
    // and the correction is worth keeping because the reasoning was seductive.
    // It said: `.seg` is `flex: 1 1 0%`, so buttons split the group EQUALLY and
    // every caption gets the roster MEAN — therefore an EVEN roster cannot
    // clip. Evenness is real; the conclusion does not follow, because the split
    // is of a FIXED TOTAL. Measured on the rendered dock: cell 182.5 px → 31 px
    // per button → 15.0 px of content box, against captions laying out at
    // LP 14.13 · HP 16.02 · BP 15.11 · NT 15.72 px. THREE OF FIVE paint as
    // `H…`, `N…`, `A…`, exactly as the shipped `filter` dock does with three.
    //
    // ⚠ NOTHING IN THIS PROCESS CAN ASSERT THAT. It is a browser-layout fact at
    // one viewport in one font, and the two DOM predicates a unit-adjacent gate
    // would reach for are both blind: `scrollWidth === clientWidth` for a
    // single-line ellipsis, and `measureText` DROPS `letter-spacing` (0.6 px ×
    // 2 chars = the exact 1.2 px it under-reports). So the assertion here is
    // the one this file CAN make honestly — the captions are already the
    // shortest form the DSP names them by, so nothing on the def side is
    // available to shorten. The pixels are pinned by the VRT dock baseline,
    // and `_shell-faces.ts` says what that baseline is expected to show.
    expect([...RESOFILTER_MODE_SHORT]).toEqual(['LP', 'HP', 'BP', 'NT', 'AP']);
    const lengths = new Set(RESOFILTER_MODE_SHORT.map((s) => s.length));
    expect(lengths.size, `captions: ${RESOFILTER_MODE_SHORT.join(' ')}`).toBe(1);
    expect([...lengths][0]).toBe(2);
    // …and the long forms are strictly longer, so the `title` really is the
    // place the full name lives rather than a duplicate of the caption.
    for (const [i, short] of RESOFILTER_MODE_SHORT.entries()) {
      expect(RESOFILTER_MODE_NAMES[i]!.length).toBeGreaterThan(short.length);
    }
  });

  it('resofilterFaceParams resolves the DEF DEFAULT for anything untouched', () => {
    // `node.params` is a SPARSE overlay: reading it bare draws a 20 Hz filter
    // beside a dial saying 1.0 kHz (the crossover-panel scar).
    const empty = resofilterFaceParams(() => undefined);
    expect(empty).toEqual({ cutoff: 1000, resonance: 0.3, mode: 0, mix: 1 });
    const partial = resofilterFaceParams((id) => (id === 'mode' ? 3 : undefined));
    expect(partial.mode).toBe(3);
    expect(partial.cutoff).toBe(1000);
  });

  it('the sidebar curve is TOTAL and stays inside the plot box at the +50 dB plateau', () => {
    // A face that throws mid-drag takes the dock down; a curve that leaves
    // [0,1] draws outside its own frame.
    for (const mode of MODES) {
      for (const res of [0, 0.5, 1]) {
        for (const mix of [0, 0.5, 1]) {
          const pts = svfResponseCurve(params({ mode, resonance: res, mix }), 48);
          expect(pts).toHaveLength(48);
          for (const p of pts) {
            expect(Number.isFinite(p.y) && p.y >= 0 && p.y <= 1, `${TAG(mode)} res ${res} mix ${mix}`).toBe(true);
          }
        }
      }
    }
  });

  it('the printed strings are the shapes the faceplate promises: a value and a unit', () => {
    expect(resofilterPeakText(params({ mode: 0, resonance: 0.9 }))).toBe('+14.0 dB');
    expect(resofilterPeakText(params({ mode: 0, resonance: 0 }))).toBe('−6.0 dB');
    expect(resofilterPeakText(params({ mode: 0, resonance: 0.5 }))).toBe('0.0 dB');
    expect(resofilterWidthText(params({ mode: 3, resonance: 0.3 }))).toBe('1.88 oct');
    expect(resofilterWidthText(params({ mode: 3, resonance: 0.9 }))).toBe('0.288 oct');
    expect(resofilterCvReachText(params({ cutoff: 100 }))).toBe('20 Hz – 10.09 kHz');
  });
});
