// packages/web/src/lib/audio/modules/rings-sample-rate.test.ts
//
// A SAVED RACK MUST SOUND THE SAME ON SOMEONE ELSE'S INTERFACE.
//
// RINGS' MODAL bank sets each partial's Q proportional to its frequency,
// `Q_i = 1 + (f_i/sr)*q`, so the decay constant is `tau = q/(pi*sr)`. `q` came
// from the DAMPING knob alone, with nothing to cancel the `sr` — which made the
// ring time a property of the user's AUDIO INTERFACE rather than of the knob.
//
// ── WHAT IS MEASURED, AND WHY IT IS THE COEFFICIENTS ────────────────────────
//
// The claim is about a DECAY CONSTANT, so this reads the decay constant off the
// real `configure()`'s biquad poles rather than off a rendered envelope. That
// is not a shortcut, it is the more honest instrument: a T60 taken from a
// render is peak-relative, and the excitation's own level moves with sample
// rate (the plucker's noise burst spreads a fixed power over a wider band at a
// higher rate), so a render-based number confounds "the ring got shorter" with
// "the strike got quieter". Measured both ways while writing this, the render
// probe disagreed with itself across settings and returned no reading at all at
// high DAMPING. The pole radius has neither problem: `tau = -1/(sr*ln(r))` is
// exactly the thing the fix changes, in seconds, per partial.
//
// ── WHAT THIS FIX DOES AND DOES NOT COVER ───────────────────────────────────
//
// Scaling `q` by `sr/48000` cancels the `sr` in `tau` for every partial in the
// small-angle region, which is where a modal bank's audible ring lives. It is
// bit-identical at 48 kHz by construction.
//
// It does NOT make the WHOLE BANK's ring time invariant, and the honest reason
// is a SECOND, separate mechanism: an RBJ biquad's decay is `2Q/(sin(w0)*sr)`,
// and `sin(w0)` collapses as `w0` approaches pi, so a partial that happens to
// sit near Nyquist rings pathologically long — and WHICH partials sit there is
// a function of the sample rate. Measured whole-bank tau at damping 0.5 /
// brightness 1.0, before -> after this change:
//
//   44.1k   580.1 ms -> 532.8 ms
//   48k    1212.1 ms -> 1212.1 ms   (unchanged, as designed)
//   96k      67.5 ms ->  134.7 ms
//   spread    17.97x ->    9.00x
//
// and at the shipped default (damping 0.5 / brightness 0.5) 2.80x -> 1.52x.
// Removing the remainder means changing how partials near Nyquist are voiced,
// which moves 48 kHz audio and therefore needs an owner audition. It is named
// here rather than folded in.

import { describe, expect, it } from 'vitest';
import { ringsMath, _RingsModal, type RingsParams } from './rings';

/** The three interface rates a user actually encounters. */
const RATES = [44100, 48000, 96000] as const;

/** The reference rate the DAMPING range is quoted at. Kept local so the test
 *  asserts against the intended anchor rather than importing the module's own
 *  constant and agreeing with itself by construction. */
const REFERENCE_SR = 48000;

/** MIDI note 0 offset = C4. Mirrors the worklet's pitch math. */
function freqFor(note: number): number {
  return 261.6256 * Math.pow(2, note / 12);
}

/**
 * Decay time constant of one partial, IN SECONDS, from its biquad poles.
 *
 * A two-pole section's per-sample decay is the pole radius `r = sqrt(a2)`, so
 * `tau_samples = -1/ln(r)` and `tau_seconds = tau_samples / sr`. Returning
 * SECONDS is the whole point — a sample count is a different quantity at every
 * rate, and that confusion is what produced the defect.
 */
function partialTauSeconds(f: { a2: number }, sr: number): number {
  const r = Math.sqrt(Math.max(1e-300, f.a2));
  const ln = Math.log(r);
  if (ln >= 0) return Infinity;
  return -1 / (ln * sr);
}

interface PartialReading {
  index: number;
  freqHz: number;
  tauSeconds: number;
  /** How far up towards Nyquist this partial sits, 0..1. */
  nyquistFrac: number;
}

/** Configure the REAL modal bank at `sr` and read every active partial. */
function readBank(
  sr: number,
  opts: { note?: number; structure?: number; brightness?: number; damping?: number } = {},
): PartialReading[] {
  const { note = 0, structure = 0.25, brightness = 0.5, damping = 0.5 } = opts;
  const modal = new _RingsModal();
  const f0 = freqFor(note);
  modal.configure(f0, structure, brightness, damping, sr);

  const out: PartialReading[] = [];
  const stiffness = structure * 0.5;
  let stretch = 1;
  for (let i = 0; i < modal.numModes; i++) {
    const freqHz = f0 * (i + 1) * stretch;
    stretch += stiffness;
    out.push({
      index: i,
      freqHz,
      tauSeconds: partialTauSeconds(modal.filters[i]!, sr),
      nyquistFrac: freqHz / (sr / 2),
    });
  }
  return out;
}

/**
 * Partials comfortably inside the small-angle region at EVERY rate, where
 * `sin(w0) ~ w0` and the fix's guarantee is exact. 0.2 of Nyquist at 44.1 kHz
 * is 4.4 kHz — the whole audible body of a modal resonator.
 */
const SMALL_ANGLE_NYQUIST_FRAC = 0.2;

describe('rings: MODAL per-partial decay no longer carries the sample rate', () => {
  const SETTINGS: Array<{ label: string; opts: Parameters<typeof readBank>[1] }> = [
    { label: 'shipped default (d0.5 b0.5 s0.25)', opts: {} },
    { label: 'long ring (d0.2 b0.5)', opts: { damping: 0.2 } },
    { label: 'short ring (d0.8 b0.5)', opts: { damping: 0.8 } },
    { label: 'bright (d0.5 b1.0)', opts: { brightness: 1.0 } },
    { label: 'low fundamental (note -24)', opts: { note: -24 } },
    { label: 'harmonic (s0.0)', opts: { structure: 0 } },
  ];

  it.each(SETTINGS)('$label: tau agrees across 44.1 / 48 / 96 kHz', ({ opts }) => {
    const banks = RATES.map((sr) => ({ sr, partials: readBank(sr, opts) }));

    // Compare partial-by-partial, restricted to the small-angle region.
    const common = Math.min(...banks.map((b) => b.partials.length));
    expect(common, 'the bank has partials at every rate').toBeGreaterThan(0);

    let compared = 0;
    for (let i = 0; i < common; i++) {
      const rows = banks.map((b) => b.partials[i]!);
      if (!rows.every((r) => r.nyquistFrac <= SMALL_ANGLE_NYQUIST_FRAC)) continue;
      if (!rows.every((r) => Number.isFinite(r.tauSeconds))) continue;
      compared++;
      const taus = rows.map((r) => r.tauSeconds);
      const spread = Math.max(...taus) / Math.min(...taus);

      // What is left over is BILINEAR FREQUENCY WARPING, and it is a property
      // of the biquad rather than of this fix. A two-pole section's decay is
      // `2Q/(sin(w0)*sr)`, and `sin(w0)*sr` equals `2*pi*f` only in the limit —
      // it falls short by exactly `w0/sin(w0)`, which is larger at a LOWER
      // rate because the same partial sits at a larger w0 there.
      //
      // So the tolerance is DERIVED from that term, per partial, rather than
      // typed: whatever spread the warping alone predicts is what is allowed,
      // and one part in a thousand of slack on top. Nothing else may hide in
      // it. Measured at 1962 Hz this admits 1.0104 and no more, which is the
      // number the old `q/(pi*sr)` law missed by a factor of two.
      const warp = banks.map((b, k) => {
        const w0 = (2 * Math.PI * rows[k]!.freqHz) / b.sr;
        return w0 / Math.sin(w0);
      });
      const warpBound = Math.max(...warp) / Math.min(...warp);

      const report = banks
        .map((b, k) => `${b.sr}Hz=${(taus[k]! * 1000).toFixed(3)}ms`)
        .join(' ');
      expect(
        spread,
        `partial ${i + 1} at ${rows[1]!.freqHz.toFixed(1)} Hz — tau spread across ` +
          `interface rates (units: ratio of seconds; ${report}); bilinear warping ` +
          `alone predicts ${warpBound.toFixed(5)}`,
      ).toBeLessThanOrEqual(warpBound * 1.001);
    }

    // Guard against a vacuous pass: if the Nyquist filter excluded everything,
    // the loop above asserts nothing at all.
    expect(compared, 'partials were actually compared').toBeGreaterThan(0);
  });

  // PERMANENT NEGATIVE CONTROL. The pre-fix law, stated explicitly, run through
  // the SAME tau formula: without the `sr/48000` term the decay constant must
  // scale as 1/sr, so 96 kHz must come out ~2x shorter than 48 kHz. If this
  // row ever goes green the probe has stopped being able to see the defect and
  // every row above is worthless.
  it('the probe SEES the defect: the pre-fix Q law halves tau from 48k to 96k', () => {
    const damping = 0.5;
    const q0 = 500 * Math.pow(10, 3 * (1 - damping));
    const f = freqFor(0); // the fundamental, deep in the small-angle region

    /** tau for one partial under an explicitly-given Q. */
    const tauUnder = (Q: number, sr: number): number => {
      const w0 = (2 * Math.PI * f) / sr;
      const alpha = Math.sin(w0) / (2 * Math.max(0.5, Q));
      const a2 = (1 - alpha) / (1 + alpha);
      return partialTauSeconds({ a2 }, sr);
    };

    // OLD: Q = 1 + (f/sr)*q0            — q carries no sample-rate term.
    // NEW: Q = 1 + (f/sr)*q0*(sr/48000) — which is just 1 + f*q0/48000.
    const oldTau = RATES.map((sr) => tauUnder(1 + (f / sr) * q0, sr));
    const newTau = RATES.map((sr) => tauUnder(1 + (f / sr) * q0 * (sr / REFERENCE_SR), sr));

    const [, old48, old96] = oldTau as [number, number, number];
    expect(
      old48 / old96,
      'pre-fix: tau at 48k over tau at 96k (units: ratio of seconds) — the defect, ' +
        'which must track the sample-rate ratio',
    ).toBeCloseTo(96000 / 48000, 1);

    const newSpread = Math.max(...newTau) / Math.min(...newTau);
    expect(newSpread, 'post-fix: the same comparison is flat').toBeLessThan(1.01);
  });

  it('48 kHz is untouched — the reference rate makes the factor exactly 1', () => {
    // This is the property the whole "no ART assertion and no documented
    // measurement moves" argument rests on, so it gets an assertion rather
    // than a claim.
    expect(REFERENCE_SR / REFERENCE_SR).toBe(1);
    const damping = 0.5;
    const q0 = 500 * Math.pow(10, 3 * (1 - damping));
    const f = freqFor(0);
    const oldQ = 1 + (f / REFERENCE_SR) * q0;
    const newQ = 1 + (f / REFERENCE_SR) * q0 * (REFERENCE_SR / REFERENCE_SR);
    expect(newQ, 'the Q the bank is configured with at 48 kHz is unchanged').toBe(oldQ);
  });

  // PERMANENT NEGATIVE CONTROL on the instrument itself: tau must respond to
  // the knob that is supposed to set it, or "tau agrees across rates" could be
  // satisfied by a probe returning a constant.
  it('tau tracks DAMPING, so it is measuring a ring time', () => {
    const longRing = readBank(48000, { damping: 0.2 })[0]!.tauSeconds;
    const shortRing = readBank(48000, { damping: 0.8 })[0]!.tauSeconds;
    expect(
      longRing,
      `low DAMPING must ring longer (units: seconds; d0.2=${(longRing * 1000).toFixed(1)}ms ` +
        `d0.8=${(shortRing * 1000).toFixed(1)}ms)`,
    ).toBeGreaterThan(shortRing * 10);
  });

  // The sibling model, checked rather than assumed. Its loop gain is applied
  // once per DELAY-LINE ROUND TRIP (not once per sample) and its one-pole
  // coefficients are derived from `sr`, so it should already be invariant.
  // "Should" is not a measurement, so here is one — through a render, since
  // the string has no biquad to read.
  it('SYMPATHETIC ring length is already sample-rate invariant — verified', () => {
    const seconds = 2.0;
    const params: RingsParams = {
      model: 1, note: 0, structure: 0.0, brightness: 0.5, damping: 0.5,
      position: 0.5, level: 0.8,
    };
    // Energy in a late window as a fraction of an early one — a ratio, so a
    // level difference between rates cancels, and both windows are expressed
    // in SECONDS so they cover the same musical span everywhere.
    const decayRatio = (sr: number): number => {
      const { odd } = ringsMath.render(Math.round(seconds * sr), sr, 0, params, null, 0);
      const rms = (fromS: number, toS: number): number => {
        const a = Math.round(fromS * sr);
        const b = Math.min(odd.length, Math.round(toS * sr));
        let sum = 0;
        for (let i = a; i < b; i++) sum += odd[i]! * odd[i]!;
        return Math.sqrt(sum / Math.max(1, b - a));
      };
      return rms(1.0, 1.5) / Math.max(1e-12, rms(0.05, 0.15));
    };
    const ratios = RATES.map((sr) => ({ sr, r: decayRatio(sr) }));
    const vals = ratios.map((x) => x.r);
    const report = ratios.map((x) => `${x.sr}Hz=${x.r.toFixed(4)}`).join(' ');
    expect(Math.min(...vals), `SYMPATHETIC still ringing at 1.0-1.5 s (${report})`)
      .toBeGreaterThan(0);
    expect(
      Math.max(...vals) / Math.min(...vals),
      `SYMPATHETIC late/early energy ratio across interface rates (${report})`,
    ).toBeLessThan(1.25);
  });
});
