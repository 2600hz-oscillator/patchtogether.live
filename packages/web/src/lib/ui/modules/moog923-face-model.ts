// packages/web/src/lib/ui/modules/moog923-face-model.ts
//
// The PURE model behind the MOOG 923 faceplate — the arithmetic for its five
// derived readouts.
//
// WHY A MODEL FOR A THREE-KNOB MODULE. Because none of the three knobs can say
// what it did. The 923 is TWO instruments sharing a panel and NO signal path:
// one LEVEL feeds two noise jacks, two cutoffs feed two filter jacks, and
// nothing crosses (measured: driving a 200 Hz sine through `audio` and taking
// `lp`/`hp` gives a BIT-IDENTICAL 3.6421e-1 / 1.8171e-2 RMS at LEVEL 1 and at
// LEVEL 0). Four facts follow that no knob readback can reach:
//
//   1. THE TWO NOISE TAPS ARE NOT LEVEL-MATCHED. `setParam('level')` writes the
//      SAME gain to both, and the two tables leave 12.30 dB apart. The dial
//      prints `0.80` for both jacks.
//   2. THE CUTOFF DIALS ARE 0..1 WITH NO `units`, so the frequency they set
//      appears NOWHERE in the product.
//   3. ⚠ AND THE FREQUENCY THEY SET IS NOT WHERE THE FILTER IS −3 dB. This is
//      the kick-drum TAIL of this module: the obvious answer — `cutoffToHz`
//      of the knob, which is what a relabelled dial would print — is WRONG by
//      +33 % on `lp` and −25 % on `hp`. See THE Q FINDING below.
//   4. THE TWO FILTER TAPS OVERLAP, AND BY HOW MUCH IS A JOIN OVER BOTH DIALS.
//      At the shipped defaults BOTH dials read 0.50, so the naive reading is
//      "aligned, a clean crossover". The taps actually overlap by 0.82 octaves,
//      because their −3 dB points move in OPPOSITE directions off the shared
//      corner. Neither dial's readback can see it; each is blind to the other.
//
// EVERY CONSTANT HERE IS MIRRORED FROM THE PLATFORM AND RE-DERIVED BY AN
// ORACLE. `art/scenarios/moog923/face-audit.test.ts` renders the SHIPPING
// `moog923Def.factory` under node-web-audio-api and measures the real biquads
// and the real noise tables, so a closed form that drifts from the filter it
// describes is RED rather than merely stale. That is the `noise-face-model`
// discipline, which this file also reuses outright: moog923 builds its tables
// from the SAME `noiseGenerators`, so `NOISE_TAP_RMS` is the same truth and is
// imported rather than restated.
//
// ── THE Q FINDING ───────────────────────────────────────────────────────────
//
// `moog923.ts` creates two `BiquadFilterNode`s and never touches `Q`. For
// `lowpass` and `highpass` the Web Audio API interprets `Q` in DECIBELS
// (`α = sin ω0 / (2 · 10^(Q/20))`), and its default is `1` — so both filters
// ship with +1 dB of resonance that nobody chose. Measured off the shipping
// factory at 48 kHz, at knob 0, 0.25, 0.5, 0.75 and 1:
//
//   · at the declared corner both taps read +1.00 dB, not −3 dB;
//   · each tap peaks +1.96 dB about 0.36 oct INSIDE its own passband;
//   · the real −3 dB point is 1.3293x the declared corner on `lp` and
//     0.7520x on `hp` (measured at knob 0.5: corner 894.4 Hz, `lp` −3 dB at
//     1188.9 Hz, `hp` at 672.6 Hz).
//
// Whether the 923 SHOULD resonate is an audio-character question on a clone
// module and belongs to the owner's ears, not to a faceplate PR — it is filed
// separately. What the face does is stop the product from implying otherwise:
// it prints the frequency the filter actually turns over at, and the def's
// prose no longer calls the knob's frequency "the corner".
//
// PURE: no DOM, no engine, no store, no fs. Every function is a pure function
// of the live params.

import { fmtDb, fmtHz } from '$lib/audio/modules/kickdrum-format';
import { CUTOFF_MAX_HZ, CUTOFF_MIN_HZ, cutoffToHz } from '$lib/audio/modules/moog923';
import { NOISE_TAP_RMS } from '$lib/ui/modules/noise-face-model';

// ── THE MIRRORED PLATFORM CONSTANT ──────────────────────────────────────────

/**
 * The `Q` both biquads run at, in the units the Web Audio API uses for
 * `lowpass`/`highpass` — DECIBELS.
 *
 * ⚠ IT IS NOT A CHOICE `moog923.ts` MADE. `BiquadFilterNode.Q` defaults to 1
 * and the factory never assigns it, so this constant mirrors a PLATFORM
 * default. It is stated here, once, because every number below is a function
 * of it and because a future `lpFilter.Q.value = …` must make this file red
 * rather than silently wrong — which is what the ART oracle enforces by
 * measuring the shipping filter instead of reading this line.
 */
export const MOOG923_FILTER_Q_DB = 1;

/** The same Q as the analog prototype's dimensionless Q (`10^(Q_dB/20)`). */
export const MOOG923_FILTER_Q = Math.pow(10, MOOG923_FILTER_Q_DB / 20);

export type Moog923NoiseTap = 'white' | 'pink';
export type Moog923FilterTap = 'lp' | 'hp';

/** The noise taps in `moog923Def.outputs` declaration order — which is also the
 *  order `primaryAudioOutPortId` resolves (`white` wins; see the face). */
export const MOOG923_NOISE_TAPS: readonly Moog923NoiseTap[] = ['white', 'pink'];

// ── THE FILTER'S REAL SHAPE ─────────────────────────────────────────────────

/**
 * The gain AT the declared corner, in dB. For an RBJ lowpass/highpass this is
 * exactly the dimensionless Q — so at the shipped default it is +1.00 dB and
 * the word "corner" is doing no work at all.
 */
export function moog923CornerGainDb(): number {
  return 20 * Math.log10(MOOG923_FILTER_Q);
}

/**
 * The ratio of the LOWPASS's true −3 dB frequency to its declared corner.
 *
 * From the analog prototype `H(s) = 1/(s² + s/Q + 1)`: `|H|² = ½` at `x² = u`
 * where `u² − (2 − 1/Q²)u − 1 = 0`, so `u` is the positive root. At Q = 1 dB
 * this is 1.330597. The HIGHPASS is the frequency-inverse of the same filter,
 * so its ratio is exactly `1/x` — which is why one function serves both and
 * the two can never drift apart.
 */
export function moog923MinusThreeDbRatio(tap: Moog923FilterTap): number {
  const q2 = MOOG923_FILTER_Q * MOOG923_FILTER_Q;
  const b = 2 - 1 / q2;
  const u = (b + Math.sqrt(b * b + 4)) / 2;
  const x = Math.sqrt(u);
  return tap === 'lp' ? x : 1 / x;
}

/**
 * Where a tap's resonant hump sits, as a ratio to the declared corner, and how
 * tall it is. Only defined for `Q > 1/√2`, which the shipped Q is.
 *
 * PRINTED NOWHERE — it is the sidebar's fixed prose, and it is here so the ART
 * oracle can measure the shipping filter against it rather than against a
 * comment.
 */
export function moog923PeakRatio(tap: Moog923FilterTap): number {
  const q2 = MOOG923_FILTER_Q * MOOG923_FILTER_Q;
  const x = Math.sqrt(1 - 1 / (2 * q2));
  return tap === 'lp' ? x : 1 / x;
}

/** The height of that hump above the passband, in dB (+1.96 at the shipped Q). */
export function moog923PeakGainDb(): number {
  const q2 = MOOG923_FILTER_Q * MOOG923_FILTER_Q;
  return 20 * Math.log10(MOOG923_FILTER_Q / Math.sqrt(1 - 1 / (4 * q2)));
}

// ── THE LIVE PARAMS ─────────────────────────────────────────────────────────

export interface Moog923FaceParams {
  /** One linear 0..1 gain, written to BOTH noise tap gains at once. */
  level: number;
  /** The LOWPASS dial, 0..1 — mapped log onto 40 Hz..20 kHz by the def. */
  lpCutoff: number;
  /** The HIGHPASS dial, same map. */
  hpCutoff: number;
}

/** Read the face's params off a live reader, falling back to the DEF's own
 *  defaults. (`node.params` is a SPARSE overlay of what has been TOUCHED, so
 *  reading it bare prints the wrong number on a fresh spawn.) */
export function moog923FaceParams(read: (paramId: string) => number | undefined): Moog923FaceParams {
  const pick = (id: string, fallback: number): number => {
    const v = read(id);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    level: pick('level', 0.8),
    lpCutoff: pick('lpCutoff', 0.5),
    hpCutoff: pick('hpCutoff', 0.5),
  };
}

// ── THE NOISE HALF ──────────────────────────────────────────────────────────

/** A noise tap's RMS at the live LEVEL (linear). Both taps share ONE gain. */
export function moog923TapRms(tap: Moog923NoiseTap, p: Moog923FaceParams): number {
  return Math.max(0, p.level) * NOISE_TAP_RMS[tap];
}

/** A noise tap's RMS in dBFS. `-Infinity` at LEVEL 0. */
export function moog923TapDb(tap: Moog923NoiseTap, p: Moog923FaceParams): number {
  const r = moog923TapRms(tap, p);
  return r > 0 ? 20 * Math.log10(r) : Number.NEGATIVE_INFINITY;
}

/** What the hero prints for a noise tap. `silent` at LEVEL 0 — never
 *  `-Infinity dB`, which is what `fmtDb` emits for a non-finite input. */
export function moog923TapDbText(tap: Moog923NoiseTap, p: Moog923FaceParams): string {
  const d = moog923TapDb(tap, p);
  return Number.isFinite(d) ? fmtDb(d) : 'silent';
}

/** PINK's level relative to WHITE, in dB. LEVEL-invariant BY CONSTRUCTION —
 *  one gain drives both — which is exactly why it is worth printing. */
export function moog923TapOffsetDb(): number {
  return 20 * Math.log10(NOISE_TAP_RMS.pink / NOISE_TAP_RMS.white);
}

// ── THE FILTER HALF ─────────────────────────────────────────────────────────

/** A filter tap's DECLARED corner in Hz — `cutoffToHz` of its own dial. This is
 *  the number the face deliberately does NOT print; it is here so the negative
 *  control can assert the printed value is not it. */
export function moog923DeclaredCornerHz(tap: Moog923FilterTap, p: Moog923FaceParams): number {
  return cutoffToHz(tap === 'lp' ? p.lpCutoff : p.hpCutoff);
}

/**
 * A filter tap's TRUE −3 dB frequency in Hz.
 *
 * CLAMPED TO THE DECLARED BAND, and that is a decision rather than hygiene:
 * `cutoffToHz` tops out at 20 kHz, so an un-clamped `lp` at dial 1 would print
 * 26.6 kHz — a frequency the module cannot reach and, at a 44.1/48 kHz
 * interface, one the biquad itself clamps to Nyquist. The face prints the edge
 * of the band and the sidebar says the band's ends are ends.
 */
export function moog923MinusThreeDbHz(tap: Moog923FilterTap, p: Moog923FaceParams): number {
  const hz = moog923DeclaredCornerHz(tap, p) * moog923MinusThreeDbRatio(tap);
  return Math.min(CUTOFF_MAX_HZ, Math.max(CUTOFF_MIN_HZ, hz));
}

/** What the sidebar prints for a filter tap. */
export function moog923MinusThreeDbText(tap: Moog923FilterTap, p: Moog923FaceParams): string {
  return fmtHz(moog923MinusThreeDbHz(tap, p));
}

/**
 * THE SPLIT — the signed distance in OCTAVES between the two taps' −3 dB
 * points, positive when they OVERLAP.
 *
 * `lp` passes everything below its point and `hp` everything above its own, so
 * `log2(lp / hp)` is positive when a band passes through BOTH jacks (patch them
 * into a mixer and that band arrives twice) and negative when a band arrives at
 * NEITHER (sum them and it is a notch).
 *
 * ⚠ THIS IS THE ONE READOUT NO SINGLE DIAL CAN EVEN APPROXIMATE, and the
 * shipped defaults are the proof: both dials read 0.50, so the naive answer is
 * zero — and the true answer is +0.82 oct, because the two −3 dB points move in
 * OPPOSITE directions off the shared corner (x and 1/x).
 */
export function moog923SplitOct(p: Moog923FaceParams): number {
  return Math.log2(moog923MinusThreeDbHz('lp', p) / moog923MinusThreeDbHz('hp', p));
}

/** What the hero prints for the split. Names the DIRECTION, because `-1.2 oct`
 *  and `+1.2 oct` are opposite patches and a bare sign says neither. */
export function moog923SplitText(p: Moog923FaceParams): string {
  const oct = moog923SplitOct(p);
  if (!Number.isFinite(oct)) return 'aligned';
  const mag = Math.abs(oct);
  if (mag < 0.005) return 'aligned';
  return `${oct > 0 ? 'overlap' : 'gap'} ${mag.toFixed(2)} oct`;
}
