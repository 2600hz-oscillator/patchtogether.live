// packages/web/src/lib/ui/modules/noise-face-model.ts
//
// The PURE model behind the NOISE faceplate — the arithmetic for its three
// derived readouts and for the TAPS picture in its dock sidebar.
//
// WHY A MODEL AT ALL FOR A ONE-KNOB MODULE. Because the one knob is the thing
// that cannot say what this module does. `level` is a single linear gain
// written to all three tap gains simultaneously (noise.ts `setParam`), so a
// `paramId: 'level'` readout prints ONE number — `0.50` — for THREE outputs
// that are 12.3 dB and 7.1 dB apart. The knob readback is not merely
// incomplete about that; it is INVARIANT to it, which is the exact blindness
// `FaceReadout.valueId` exists for (see face-readout-values.ts).
//
// EVERY CONSTANT HERE IS MIRRORED FROM THE DSP AND RE-DERIVED BY AN ORACLE.
// The generators live in `packages/dsp/src/lib/noise-dsp.ts` and export their
// functions, not their coefficients, so this file restates ROWS / LEAK / NORM.
// A restated constant is a drift hazard, so `noise-face-model.test.ts` does
// not check them against a comment: it RENDERS the shipping generators and
// asserts each closed form matches the measured statistic, with a negative
// control in both directions. That is the bluebox discipline ("the one worklet
// constant the model has to mirror is anchored by measuring the shipping DSP").
//
// PURE: no DOM, no engine, no store, no fs. Every function is a pure function
// of the live `level` (and, where the answer genuinely depends on it, an
// explicitly-passed sample rate).

import { fmtDb, fmtHz } from '$lib/audio/modules/kickdrum-format';

// ── THE MIRRORED DSP COEFFICIENTS ───────────────────────────────────────────

/** Voss-McCartney row count (`noise-dsp.ts` pink: `const ROWS = 16`). */
export const NOISE_ROWS = 16;
/** Brown's leaky-integrator pole (`noise-dsp.ts` brown: `const LEAK = 0.99`). */
export const NOISE_LEAK = 0.99;
/** Brown's output scaler (`noise-dsp.ts` brown: `const NORM = 1 / 8`). */
export const NOISE_NORM = 1 / 8;
/** The white driver's step scaler inside brown's integrator (`0.5 * w`). */
export const NOISE_BROWN_INPUT_GAIN = 0.5;
/** The looping table length (`noise.ts` `BUFFER_SECONDS = 2`). */
export const NOISE_BUFFER_SECONDS = 2;

/**
 * The rate every printed sample-rate-dependent number is stated AT.
 *
 * ⚠ IT HAS TO BE STATED, and that is a finding rather than a formatting
 * choice. `LEAK` is a bare z-domain constant with no `sampleRate` term, while
 * the table length DOES scale with the rate (`noise.ts`: `BUFFER_SECONDS *
 * ctx.sampleRate`), so brown's corner MOVES WITH THE USER'S INTERFACE —
 * 70.5 Hz at 44.1 k, 76.8 at 48 k, 153.6 at 96 k. A `FaceReadoutValue` is
 * `(read) => string` and receives no sample rate (face-readout-values.ts), so
 * the faceplate cannot print the live one; it prints the 48 kHz value and
 * SAYS SO rather than printing a number that is silently wrong on half the
 * interfaces out there.
 */
export const NOISE_REFERENCE_SAMPLE_RATE = 48000;

// ── THE TAPS ────────────────────────────────────────────────────────────────

export type NoiseTap = 'white' | 'pink' | 'brown';

/** Declaration order — the same order `noiseDef.outputs` declares them, which
 *  is also the order `primaryAudioOutPortId` resolves (white wins). */
export const NOISE_TAPS: readonly NoiseTap[] = ['white', 'pink', 'brown'];

/**
 * Each tap's RMS at LEVEL = 1, in CLOSED FORM from the coefficients above.
 *
 *   white  uniform on [−1, +1)                       → σ = 1/√3        = 0.5774
 *   pink   (ROWS independent uniforms + 1) / (ROWS+1) → σ = 1/√(3(R+1)) = 0.1400
 *   brown  AR(1) driven by 0.5·uniform, scaled NORM   → σ = NORM·√(¼·⅓/(1−a²))
 *                                                                      = 0.2558
 *
 * ⚠ PINK'S IS THE STEADY-STATE VALUE and the shipped 2-second table measures
 * ~2.7 % (0.24 dB) UNDER it, because Voss row 15 only updates every 32 768
 * samples and starts at zero — so the slow rows are still filling for the
 * first third of the table. That deficit is not an error bar, it is a
 * DIRECTION, and the oracle pins the direction as well as the magnitude
 * (`noise-face-model.test.ts`). It is also the mechanism behind the ~0.5 dB
 * LF ramp-in that repeats every 2 s on the pink tap.
 */
export const NOISE_TAP_RMS: Readonly<Record<NoiseTap, number>> = {
  white: 1 / Math.sqrt(3),
  pink: 1 / Math.sqrt(3 * (NOISE_ROWS + 1)),
  brown:
    NOISE_NORM *
    Math.sqrt(
      (NOISE_BROWN_INPUT_GAIN * NOISE_BROWN_INPUT_GAIN * (1 / 3)) / (1 - NOISE_LEAK * NOISE_LEAK),
    ),
};

/**
 * BROWN'S PEAK at LEVEL = 1, as a typical value and as a measured worst case.
 *
 * ⚠ THESE ARE STATISTICS OF A PER-SPAWN RANDOM TABLE, not constants, and the
 * face treats them as such: they are never printed as a live readout, only as
 * fixed sidebar prose. Brown is a random walk with a 0.99 pole — its extreme
 * value over 96 000 samples varies from spawn to spawn, and 118 of 200 seeded
 * tables PEAK ABOVE 1.0 at LEVEL 1 (median 1.021, p95 1.167, worst 1.362).
 * The `noise-dsp.ts` comment claiming "peak excursions stay comfortably under
 * ±1" was measured to ~64 k samples; the shipped table is 96 000.
 */
export const NOISE_BROWN_PEAK_MEDIAN = 1.021;
/** Worst peak seen over 200 seeded 2 s tables at LEVEL 1. */
export const NOISE_BROWN_PEAK_WORST = 1.362;
/** Fraction of seeded 2 s tables whose brown peak exceeds 1.0 at LEVEL 1. */
export const NOISE_BROWN_OVER_FULL_SCALE_FRACTION = 118 / 200;

// ── THE LIVE PARAM ──────────────────────────────────────────────────────────

export interface NoiseFaceParams {
  /** The one knob: a linear 0..1 gain applied to ALL THREE taps at once. */
  level: number;
}

/** Read the face's params off a live reader, falling back to the def default.
 *  (`node.params` is a SPARSE overlay of what has been TOUCHED — reading it
 *  bare prints the wrong number on a fresh spawn.) */
export function noiseFaceParams(read: (paramId: string) => number | undefined): NoiseFaceParams {
  const level = read('level');
  return { level: Number.isFinite(level) ? (level as number) : 0.5 };
}

/** A tap's RMS amplitude at the live LEVEL (linear, 0..1). */
export function noiseTapRms(tap: NoiseTap, p: NoiseFaceParams): number {
  return Math.max(0, p.level) * NOISE_TAP_RMS[tap];
}

/** A tap's RMS in dBFS at the live LEVEL. `-Infinity` at LEVEL 0. */
export function noiseTapDb(tap: NoiseTap, p: NoiseFaceParams): number {
  const r = noiseTapRms(tap, p);
  return r > 0 ? 20 * Math.log10(r) : Number.NEGATIVE_INFINITY;
}

/** What the hero prints for a tap. `silent` at LEVEL 0 — never `-Infinity dB`,
 *  which is what `fmtDb` would emit for a non-finite input. */
export function noiseTapDbText(tap: NoiseTap, p: NoiseFaceParams): string {
  const d = noiseTapDb(tap, p);
  return Number.isFinite(d) ? fmtDb(d) : 'silent';
}

/** A tap's level relative to WHITE, in dB. LEVEL-invariant BY CONSTRUCTION —
 *  one gain drives all three — which is exactly why it is worth printing. */
export function noiseTapOffsetDb(tap: NoiseTap): number {
  return 20 * Math.log10(NOISE_TAP_RMS[tap] / NOISE_TAP_RMS.white);
}

// ── BROWN'S CORNER ──────────────────────────────────────────────────────────

/**
 * The −3 dB corner of brown's one-pole integrator, in Hz, at a given rate.
 *
 * `y[n] = a·y[n−1] + …` has |H|² half its DC value where
 * `cos ω = (1 + a² − 2(1−a)²) / 2a`, so `fc = fs·acos(…)/2π`. THE POINT OF
 * PRINTING IT: brown is a LOW-PASS, not a slope — it is FLAT below this
 * frequency and only −6 dB/oct above it, so "1/f², heavy low-frequency
 * content" (which is what the def, the DSP comment and the module manifest
 * all said before this face) describes the tap everywhere except the bottom
 * two octaves, where it is white.
 */
export function noiseBrownCornerHz(sampleRate: number = NOISE_REFERENCE_SAMPLE_RATE): number {
  const a = NOISE_LEAK;
  const cosW = (1 + a * a - 2 * (1 - a) * (1 - a)) / (2 * a);
  return (sampleRate * Math.acos(Math.min(1, Math.max(-1, cosW)))) / (2 * Math.PI);
}

/** `≈ 77 Hz` — the corner, formatted, at the stated reference rate. */
export function noiseBrownCornerText(sampleRate: number = NOISE_REFERENCE_SAMPLE_RATE): string {
  return fmtHz(noiseBrownCornerHz(sampleRate));
}

// ── THE SPECTRA (the sidebar picture) ───────────────────────────────────────
//
// Both curves are the tap's POWER SPECTRAL DENSITY RELATIVE TO THE WHITE TAP,
// in dB — so white is a flat 0 dB reference line by construction and the other
// two are drawn against it. Neither is a cartoon `f^-n` line: both come from
// the generators' own arithmetic, and `noise-face-model.test.ts` pins both
// against a Welch PSD of the REAL generators (measured agreement: brown within
// ±0.05 dB at every probed frequency, pink within ±1.2 dB).

/**
 * BROWN, exactly. The generator is a first-order IIR — `y = a·y + 0.5·w`,
 * `out = NORM·y` — so its transfer is `NORM·0.5 / (1 − a·z⁻¹)` and its
 * magnitude is available in closed form. No fitting, no approximation.
 */
export function noiseBrownRelDb(
  hz: number,
  sampleRate: number = NOISE_REFERENCE_SAMPLE_RATE,
): number {
  const w = (2 * Math.PI * hz) / sampleRate;
  const denom = Math.sqrt(1 + NOISE_LEAK * NOISE_LEAK - 2 * NOISE_LEAK * Math.cos(w));
  return 20 * Math.log10((NOISE_NORM * NOISE_BROWN_INPUT_GAIN) / denom);
}

/**
 * PINK, from the algorithm rather than from `1/f`.
 *
 * Voss-McCartney row k is a ZERO-ORDER HOLD of white with period
 * `T_k = 2^(k+1)` samples (`counter & −counter` isolates the lowest set bit,
 * so row k re-rolls every 2^(k+1) counts). A ZOH of an iid sequence has a
 * triangular autocorrelation, hence PSD `σ²·T·sinc²(fT)`. The output is the
 * sum of ROWS such holds PLUS one fresh white sample, all divided by ROWS+1,
 * so relative to a flat white PSD:
 *
 *     S_pink(f)/S_white(f) = ( 1 + Σ_{k<ROWS} T_k·sinc²(π f T_k / fs) )
 *                            / (ROWS+1)²
 *
 * ⚠ THE LEADING `1` IS THE ADDED WHITE SAMPLE, and it is why the code adds one
 * at all — the DSP's own comment says "Voss-McCartney without this sounds
 * dull". It sets a FLOOR the row stack sinks toward at high frequency, which
 * is why the measured slope steepens past −3 dB/oct near Nyquist (model:
 * −3.01 dB/oct at 25→50 Hz, −3.46 at 8→16 kHz) instead of holding −3 forever.
 */
export function noisePinkRelDb(
  hz: number,
  sampleRate: number = NOISE_REFERENCE_SAMPLE_RATE,
): number {
  const cyclesPerSample = hz / sampleRate;
  let rel = 1; // the fresh white sample: a hold of period 1
  for (let k = 0; k < NOISE_ROWS; k++) {
    const period = Math.pow(2, k + 1);
    const x = Math.PI * cyclesPerSample * period;
    const sinc = x === 0 ? 1 : Math.sin(x) / x;
    rel += period * sinc * sinc;
  }
  return 10 * Math.log10(rel / ((NOISE_ROWS + 1) * (NOISE_ROWS + 1)));
}

/** A tap's PSD relative to the white tap, in dB. White is 0 by definition. */
export function noiseTapRelDb(
  tap: NoiseTap,
  hz: number,
  sampleRate: number = NOISE_REFERENCE_SAMPLE_RATE,
): number {
  if (tap === 'white') return 0;
  return tap === 'pink' ? noisePinkRelDb(hz, sampleRate) : noiseBrownRelDb(hz, sampleRate);
}

/** The picture's frequency window. FIXED, not fitted: nothing here moves with
 *  a control, so a window that rescaled would only hide that. */
export const NOISE_PLOT_MIN_HZ = 20;
export const NOISE_PLOT_MAX_HZ = 20000;
/** The picture's dB window, chosen to contain brown's +15.9 dB DC shelf and
 *  its −29 dB top end with a little air. */
export const NOISE_PLOT_TOP_DB = 20;
export const NOISE_PLOT_BOTTOM_DB = -34;

/** 0..1 across the LOG frequency axis. Clamped, so a decade rule outside the
 *  window lands on the edge instead of drawing off-canvas. */
export function noisePlotX(hz: number): number {
  const t =
    Math.log2(Math.max(1e-6, hz) / NOISE_PLOT_MIN_HZ) /
    Math.log2(NOISE_PLOT_MAX_HZ / NOISE_PLOT_MIN_HZ);
  return Math.min(1, Math.max(0, t));
}

/** 0 (top) .. 1 (bottom) down the dB axis. Clamped for the same reason. */
export function noisePlotY(db: number): number {
  const t = (NOISE_PLOT_TOP_DB - db) / (NOISE_PLOT_TOP_DB - NOISE_PLOT_BOTTOM_DB);
  return Math.min(1, Math.max(0, t));
}

/** The floor of the LEVEL LADDER under the curves, in dBFS. */
export const NOISE_LADDER_FLOOR_DB = -60;

/** 0 (silent) .. 1 (full scale) for a tap's RMS at the live LEVEL — the
 *  ladder's fill fraction. This is the ONE part of the picture that moves
 *  with the knob, and it is what makes the 12.3 dB / 7.1 dB spread visible
 *  rather than merely stated. */
export function noiseLadderFill(tap: NoiseTap, p: NoiseFaceParams): number {
  const d = noiseTapDb(tap, p);
  if (!Number.isFinite(d)) return 0;
  return Math.min(1, Math.max(0, (d - NOISE_LADDER_FLOOR_DB) / -NOISE_LADDER_FLOOR_DB));
}
