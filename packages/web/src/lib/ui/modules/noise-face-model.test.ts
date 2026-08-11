// packages/web/src/lib/ui/modules/noise-face-model.test.ts
//
// THE ORACLE for the NOISE faceplate model.
//
// `noise-face-model.ts` restates three coefficients that live in the DSP
// (`ROWS = 16`, `LEAK = 0.99`, `NORM = 1/8`) and derives every printed number
// from them in closed form. A restated constant is a drift hazard, and a
// comment claiming the restatement is right is worth nothing — this repo's
// noise module is itself the proof: `noise-dsp.ts` has carried "the integrator
// steady-state RMS is ~3.5" (it is 2.05) and "peak excursions stay comfortably
// under ±1" (118 of 200 shipped-length tables peak above 1.0) for as long as
// the file has existed, and no gate could see either.
//
// So nothing here is checked against prose. Every claim is RE-DERIVED from the
// SHIPPING GENERATORS on every run:
//
//   · the three closed-form RMS values, against a measured RMS over seeded
//     tables of the SHIPPED length (2 s at 48 kHz = 96 000 samples);
//   · the two analytic spectra, against a Welch PSD of the same generators;
//   · pink's steady-state-vs-shipped deficit, as a DIRECTION and not just a
//     magnitude (the slow Voss rows are still filling for the first third of
//     the table);
//   · brown's corner, against the transfer function the corner is a root of.
//
// ⚠ AND THE INSTRUMENT IS NEGATIVE-CONTROLLED, PERMANENTLY, IN BOTH
// DIRECTIONS. A comparison that passes tells you nothing until you know it can
// fail, so every oracle leg below is paired with a leg proving the SAME
// predicate rejects a wrong answer — and the wrong answers are REAL ARTIFACTS
// (the other two taps' generators) rather than a re-typed copy of the DSP,
// because a re-typed copy is exactly how the previous generation of self-tests
// in this repo went blind (CLAUDE.md).

import { describe, expect, it } from 'vitest';
import { noiseGenerators } from '$lib/audio/modules/noise';
import {
  NOISE_BROWN_PEAK_MEDIAN,
  NOISE_BROWN_PEAK_WORST,
  NOISE_BUFFER_SECONDS,
  NOISE_LADDER_FLOOR_DB,
  NOISE_LEAK,
  NOISE_PLOT_MAX_HZ,
  NOISE_PLOT_MIN_HZ,
  NOISE_REFERENCE_SAMPLE_RATE,
  NOISE_ROWS,
  NOISE_TAPS,
  NOISE_TAP_RMS,
  noiseBrownCornerHz,
  noiseBrownCornerText,
  noiseFaceParams,
  noiseLadderFill,
  noisePlotX,
  noisePlotY,
  noiseTapDb,
  noiseTapDbText,
  noiseTapOffsetDb,
  noiseTapRelDb,
  type NoiseTap,
} from './noise-face-model';

/** The table the module actually ships: `BUFFER_SECONDS * ctx.sampleRate`. */
const BUFLEN = NOISE_BUFFER_SECONDS * NOISE_REFERENCE_SAMPLE_RATE;
/** Enough seeds that the MEAN is stable (per-seed sd is 0.9 % on white and
 *  5.7 % on pink), few enough that the whole file runs in ~2 s. */
const SEEDS = [11, 23, 37, 53, 71, 97, 113, 131];

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / x.length);
}

/** Mean RMS of a tap over the seed set, at the SHIPPED table length. */
function measuredRms(tap: NoiseTap): number {
  let s = 0;
  for (const seed of SEEDS) s += rms(noiseGenerators[tap](BUFLEN, seed));
  return s / SEEDS.length;
}

// ── a small radix-2 FFT + Welch PSD, for the spectrum oracle ────────────────

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cwr - im[i + k + len / 2]! * cwi;
        const vi = re[i + k + len / 2]! * cwi + im[i + k + len / 2]! * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

const PSD_N = 8192;

/** Welch PSD (Hann, half-overlap) of one tap, averaged over the seed set. */
function welchPsd(tap: NoiseTap): Float64Array {
  const out = new Float64Array(PSD_N / 2);
  const win = new Float64Array(PSD_N);
  for (let i = 0; i < PSD_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / PSD_N);
  let blocks = 0;
  for (const seed of SEEDS) {
    const x = noiseGenerators[tap](BUFLEN, seed);
    for (let off = 0; off + PSD_N <= x.length; off += PSD_N / 2) {
      const re = new Float64Array(PSD_N);
      const im = new Float64Array(PSD_N);
      for (let i = 0; i < PSD_N; i++) re[i] = x[off + i]! * win[i]!;
      fft(re, im);
      for (let k = 0; k < PSD_N / 2; k++) out[k] = out[k]! + re[k]! * re[k]! + im[k]! * im[k]!;
      blocks++;
    }
  }
  for (let k = 0; k < PSD_N / 2; k++) out[k] = out[k]! / blocks;
  return out;
}

/** MEASURED PSD of `tap` relative to the white tap, in dB, at `hz`. */
function measuredRelDb(psd: Record<string, Float64Array>, tap: NoiseTap, hz: number): number {
  const k = Math.round(hz / (NOISE_REFERENCE_SAMPLE_RATE / PSD_N));
  return 10 * Math.log10(psd[tap]![k]! / psd.white![k]!);
}

/** The frequencies the spectrum oracle probes. Deliberately IRREGULAR and
 *  spanning brown's corner, because an evenly-spaced grid over a smooth curve
 *  can agree on average while missing the shape (CLAUDE.md: sample at
 *  co-prime / irregular offsets). */
const PROBE_HZ = [47, 100, 211, 499, 1013, 2029, 5003, 10007, 17011];

// The spectrum legs render 8 × 96 000 samples per tap and run ~23 FFTs of
// 8192 each — ~1.5 s locally, and the unit lane's default budget is 5 s.
const SLOW = 20_000;

describe('noise face model — the CLOSED FORMS match the shipping generators', () => {
  it('every tap RMS is within 1 % of a measured 2 s table (ORACLE)', () => {
    for (const tap of NOISE_TAPS) {
      const measured = measuredRms(tap);
      const model = NOISE_TAP_RMS[tap];
      // Pink's model is the STEADY STATE and the shipped table sits under it —
      // see the direction leg below — so its band is one-sided-wide here and
      // pinned tight there.
      const tol = tap === 'pink' ? 0.045 : 0.01;
      expect(
        Math.abs(model / measured - 1),
        `${tap}: closed form ${model.toFixed(6)} vs measured ${measured.toFixed(6)} ` +
          `(${(20 * Math.log10(model / measured)).toFixed(3)} dB)`,
      ).toBeLessThan(tol);
    }
  });

  it("NEGATIVE CONTROL: each tap's closed form REJECTS the other two taps", () => {
    // The instrument, not the code: if the comparison above cannot tell brown's
    // RMS from white's it is not measuring anything. Uses REAL generators as
    // the wrong answers rather than a re-typed copy of the DSP.
    for (const tap of NOISE_TAPS) {
      for (const other of NOISE_TAPS) {
        if (other === tap) continue;
        const wrong = measuredRms(other);
        expect(
          Math.abs(NOISE_TAP_RMS[tap] / wrong - 1),
          `${tap}'s closed form must NOT match ${other}'s measured RMS`,
        ).toBeGreaterThan(0.045);
      }
    }
  });

  it('NEGATIVE CONTROL: the tolerance is tight enough to catch a 0.5 dB error', () => {
    // A band wide enough to pass whatever the model said would be decoration.
    // 0.5 dB is a factor of 1.059 — outside every band used above.
    for (const tap of NOISE_TAPS) {
      const measured = measuredRms(tap);
      const perturbed = NOISE_TAP_RMS[tap] * Math.pow(10, 0.5 / 20);
      const tol = tap === 'pink' ? 0.045 : 0.01;
      expect(
        Math.abs(perturbed / measured - 1),
        `${tap}: a +0.5 dB model error must exceed the ${tol} band`,
      ).toBeGreaterThan(tol);
    }
  });

  it("pink's shipped table sits BELOW its steady state — the row fill-in, as a DIRECTION", () => {
    // Voss row 15 re-rolls every 2^16 = 65 536 samples and STARTS AT ZERO, so a
    // 96 000-sample table is missing part of its slowest rows' variance. The
    // magnitude is small (~0.24 dB); the SIGN is the finding, and a model that
    // drifted the other way would still pass a two-sided band.
    const measured = measuredRms('pink');
    expect(measured, 'shipped pink RMS < steady-state closed form').toBeLessThan(
      NOISE_TAP_RMS.pink,
    );
    expect(
      20 * Math.log10(NOISE_TAP_RMS.pink / measured),
      'the deficit is a fraction of a dB, not a broken constant',
    ).toBeLessThan(1);

    // …and it is a START-OF-TABLE effect, not a global scale error: the first
    // 32 768 samples read quieter than the tail on the SAME table.
    let headSum = 0;
    let tailSum = 0;
    for (const seed of SEEDS) {
      const x = noiseGenerators.pink(BUFLEN, seed);
      headSum += rms(x.subarray(0, 32768));
      tailSum += rms(x.subarray(32768));
    }
    expect(
      headSum / SEEDS.length,
      'the first 32 768 samples are quieter than the rest of the table',
    ).toBeLessThan(tailSum / SEEDS.length);
  });
});

describe('noise face model — the SPECTRA match a Welch PSD of the generators', () => {
  it(
    'brown is its EXACT one-pole transfer (ORACLE, ±0.6 dB)',
    () => {
      const psd = { white: welchPsd('white'), brown: welchPsd('brown') } as Record<
        string,
        Float64Array
      >;
      for (const hz of PROBE_HZ) {
        const measured = measuredRelDb(psd, 'brown', hz);
        const model = noiseTapRelDb('brown', hz);
        expect(
          Math.abs(measured - model),
          `brown @ ${hz} Hz: measured ${measured.toFixed(2)} dB vs model ${model.toFixed(2)} dB`,
        ).toBeLessThan(0.6);
      }
    },
    SLOW,
  );

  it(
    'pink is its ZERO-ORDER-HOLD row sum (ORACLE, ±1.6 dB)',
    () => {
      const psd = { white: welchPsd('white'), pink: welchPsd('pink') } as Record<
        string,
        Float64Array
      >;
      for (const hz of PROBE_HZ) {
        const measured = measuredRelDb(psd, 'pink', hz);
        const model = noiseTapRelDb('pink', hz);
        expect(
          Math.abs(measured - model),
          `pink @ ${hz} Hz: measured ${measured.toFixed(2)} dB vs model ${model.toFixed(2)} dB`,
        ).toBeLessThan(1.6);
      }
    },
    SLOW,
  );

  it(
    'NEGATIVE CONTROL: neither spectrum model fits the OTHER tap',
    () => {
      // Same predicate, wrong subject. Brown and pink both fall with frequency,
      // so "it slopes downward" is not enough to tell them apart — this asserts
      // the comparison discriminates them at real frequencies.
      const psd = {
        white: welchPsd('white'),
        pink: welchPsd('pink'),
        brown: welchPsd('brown'),
      } as Record<string, Float64Array>;
      const swapped: Array<[NoiseTap, NoiseTap]> = [
        ['brown', 'pink'],
        ['pink', 'brown'],
      ];
      for (const [model, subject] of swapped) {
        const worst = Math.max(
          ...PROBE_HZ.map((hz) => Math.abs(measuredRelDb(psd, subject, hz) - noiseTapRelDb(model, hz))),
        );
        expect(
          worst,
          `the ${model} model must NOT fit ${subject}'s measured PSD (worst |Δ| ${worst.toFixed(2)} dB)`,
        ).toBeGreaterThan(3);
      }
      // And neither fits WHITE, whose relative curve is 0 dB everywhere.
      for (const model of ['pink', 'brown'] as const) {
        const worst = Math.max(...PROBE_HZ.map((hz) => Math.abs(noiseTapRelDb(model, hz))));
        expect(worst, `the ${model} model must not be a flat line`).toBeGreaterThan(3);
      }
    },
    SLOW,
  );

  it('white is the reference line — 0 dB at every probe, by construction', () => {
    for (const hz of PROBE_HZ) expect(noiseTapRelDb('white', hz)).toBe(0);
  });
});

describe("noise face model — brown's CORNER", () => {
  it('is the −3 dB point of the SAME transfer the picture draws', () => {
    // Not circular: `noiseBrownCornerHz` solves `cos ω = (1+a²−2(1−a)²)/2a`
    // analytically, and this checks that root against the magnitude function
    // it is supposed to be a root OF (which the leg above pins to the real
    // generator). A wrong algebraic rearrangement fails here.
    const fc = noiseBrownCornerHz();
    const dc = noiseTapRelDb('brown', 0);
    expect(Math.abs(noiseTapRelDb('brown', fc) - (dc - 3.0103)), 'the root is the −3 dB point')
      .toBeLessThan(0.02);
  });

  it('MOVES WITH THE SAMPLE RATE — the defect the readout has to state', () => {
    // `LEAK` carries no `sampleRate` term, so the same coefficient is a
    // different corner on every interface. This is the reason the face prints
    // "at 48 kHz" instead of a bare number.
    expect(noiseBrownCornerHz(44100)).toBeCloseTo(70.54, 1);
    expect(noiseBrownCornerHz(48000)).toBeCloseTo(76.78, 1);
    expect(noiseBrownCornerHz(96000)).toBeCloseTo(153.56, 1);
    expect(noiseBrownCornerText(48000)).toBe('77 Hz');
    // NEGATIVE CONTROL: a corner that did NOT scale would print the same text
    // on every rate, which is what the face would be doing if it printed one.
    expect(noiseBrownCornerText(96000)).not.toBe(noiseBrownCornerText(48000));
  });

  it('brown is FLAT below the corner and −6 dB/oct well above it', () => {
    // The claim the def, the DSP comment and the module manifest all denied:
    // "1/f², heavy low-frequency content" is wrong about the bottom octaves.
    const oct = (a: number, b: number): number =>
      (noiseTapRelDb('brown', b) - noiseTapRelDb('brown', a)) / Math.log2(b / a);
    expect(oct(20, 40), '20→40 Hz is nearly flat').toBeGreaterThan(-1.6);
    expect(oct(1000, 2000), '1→2 kHz is a real −6 dB/oct').toBeLessThan(-5.5);
  });
});

describe('noise face model — the READOUTS say what one knob cannot', () => {
  const at = (level: number) => noiseFaceParams((id) => (id === 'level' ? level : undefined));

  it('ONE level produces THREE different numbers — the whole reason they are derived', () => {
    const p = at(0.5);
    const texts = NOISE_TAPS.map((t) => noiseTapDbText(t, p));
    expect(new Set(texts).size, `three distinct readouts, got ${texts.join(' / ')}`).toBe(3);
    // A `paramId: 'level'` readout would print one number for all three. These
    // are 12.3 dB and 7.1 dB apart, and that gap is LEVEL-INVARIANT.
    expect(noiseTapOffsetDb('white')).toBe(0);
    expect(noiseTapOffsetDb('pink')).toBeCloseTo(-12.3, 1);
    expect(noiseTapOffsetDb('brown')).toBeCloseTo(-7.07, 1);
    for (const level of [0.1, 0.25, 0.75, 1]) {
      expect(
        noiseTapDb('pink', at(level)) - noiseTapDb('white', at(level)),
        'the spread does not move with LEVEL',
      ).toBeCloseTo(noiseTapOffsetDb('pink'), 6);
    }
  });

  it('every readout MOVES with LEVEL, decade for decade', () => {
    for (const tap of NOISE_TAPS) {
      expect(noiseTapDb(tap, at(1)) - noiseTapDb(tap, at(0.5))).toBeCloseTo(6.0206, 3);
      expect(noiseTapDbText(tap, at(0.5))).not.toBe(noiseTapDbText(tap, at(1)));
    }
  });

  it('LEVEL 0 prints `silent`, never `-Infinity dB`', () => {
    // `fmtDb` returns `${v}` for a non-finite input, so the guard is real: a
    // faceplate reading "-Infinity dB" is the kind of thing only a screenshot
    // catches (CLAUDE.md), and the whole rack rests at LEVEL 0 the moment
    // anyone automates it down.
    for (const tap of NOISE_TAPS) {
      expect(noiseTapDbText(tap, at(0))).toBe('silent');
      expect(noiseTapDb(tap, at(0))).toBe(Number.NEGATIVE_INFINITY);
    }
  });

  it('an ABSENT param falls back to the def default, not to 0', () => {
    // `node.params` is a sparse overlay of what has been TOUCHED — reading it
    // bare prints `silent` on a fresh spawn (the StereoCrossoverPanel scar).
    expect(noiseFaceParams(() => undefined).level).toBe(0.5);
    expect(noiseTapDbText('white', noiseFaceParams(() => undefined))).toBe(
      noiseTapDbText('white', at(0.5)),
    );
  });
});

describe('noise face model — the PICTURE geometry is total and clamped', () => {
  it('the log-frequency axis spans the window and clamps outside it', () => {
    expect(noisePlotX(NOISE_PLOT_MIN_HZ)).toBeCloseTo(0, 6);
    expect(noisePlotX(NOISE_PLOT_MAX_HZ)).toBeCloseTo(1, 6);
    expect(noisePlotX(1)).toBe(0);
    expect(noisePlotX(1e9)).toBe(1);
    expect(noisePlotX(0)).toBe(0);
    // Monotone: a decade rule must never land left of a lower one.
    const xs = [20, 100, 1000, 10000, 20000].map(noisePlotX);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
  });

  it('the dB axis contains every curve the picture draws', () => {
    // A window that clipped brown's DC shelf or pink's top end would silently
    // flatten the very difference the picture exists to show.
    for (const tap of NOISE_TAPS) {
      for (const hz of [NOISE_PLOT_MIN_HZ, ...PROBE_HZ, NOISE_PLOT_MAX_HZ]) {
        const y = noisePlotY(noiseTapRelDb(tap, hz));
        expect(y, `${tap} @ ${hz} Hz is inside the dB window`).toBeGreaterThan(0);
        expect(y).toBeLessThan(1);
      }
    }
  });

  it('the LEVEL ladder is the one part of the picture that moves', () => {
    const at = (level: number) => noiseFaceParams((id) => (id === 'level' ? level : undefined));
    for (const tap of NOISE_TAPS) {
      expect(noiseLadderFill(tap, at(0))).toBe(0);
      expect(noiseLadderFill(tap, at(1))).toBeGreaterThan(noiseLadderFill(tap, at(0.25)));
      expect(noiseLadderFill(tap, at(1))).toBeLessThanOrEqual(1);
    }
    // …and it preserves the ORDER, which is the fact it is drawing.
    const p = at(0.6);
    expect(noiseLadderFill('white', p)).toBeGreaterThan(noiseLadderFill('brown', p));
    expect(noiseLadderFill('brown', p)).toBeGreaterThan(noiseLadderFill('pink', p));
    expect(NOISE_LADDER_FLOOR_DB).toBeLessThan(0);
  });
});

describe("noise face model — the two statistics it prints as PROSE, not as readouts", () => {
  it(
    "brown's peak exceeds full scale at LEVEL 1 on most spawns (ORACLE)",
    () => {
      // The `noise-dsp.ts` header says peaks "stay comfortably under ±1 …
      // (verified to ~64k samples)". The SHIPPED table is 96 000. This is the
      // measurement that contradicts it, re-run every time.
      let over = 0;
      let worst = 0;
      const peaks: number[] = [];
      for (const seed of SEEDS) {
        const x = noiseGenerators.brown(BUFLEN, seed);
        let pk = 0;
        for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]!));
        peaks.push(pk);
        worst = Math.max(worst, pk);
        if (pk > 1) over++;
      }
      peaks.sort((a, b) => a - b);
      const median = peaks[peaks.length >> 1]!;
      expect(over, `brown tables over full scale: ${over}/${SEEDS.length} (worst ${worst.toFixed(3)})`)
        .toBeGreaterThan(0);
      // The two numbers the sidebar states, bracketed rather than asserted to
      // the digit — they are statistics of a per-spawn random table.
      expect(Math.abs(median - NOISE_BROWN_PEAK_MEDIAN)).toBeLessThan(0.12);
      expect(NOISE_BROWN_PEAK_WORST).toBeGreaterThan(NOISE_BROWN_PEAK_MEDIAN);
      // NEGATIVE CONTROL: white and pink do NOT do this. White is bounded at
      // exactly 1 by its own uniform draw and pink at 1 by its normaliser, so
      // "some tap peaks over 1" is a fact about BROWN, not about the measurement.
      for (const tap of ['white', 'pink'] as const) {
        for (const seed of SEEDS) {
          const x = noiseGenerators[tap](BUFLEN, seed);
          let pk = 0;
          for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]!));
          expect(pk, `${tap} seed ${seed} peak ${pk.toFixed(4)} must not exceed 1`).toBeLessThanOrEqual(1);
        }
      }
    },
    SLOW,
  );

  it('the mirrored coefficients are the ones the DSP ships', () => {
    // Not a comment check — the three legs above are what anchor these to the
    // generators. This is the cheap tripwire that says WHICH numbers moved when
    // one of those legs goes red.
    expect(NOISE_ROWS).toBe(16);
    expect(NOISE_LEAK).toBe(0.99);
    expect(NOISE_BUFFER_SECONDS).toBe(2);
  });
});
