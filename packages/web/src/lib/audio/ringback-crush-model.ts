// packages/web/src/lib/audio/ringback-crush-model.ts
//
// RINGBACK's CRUSH LAW as a pure model — the four declared ranges in ONE place,
// the two derived quantities the dial cannot show on its own (the decimation
// divisor and the ring's decay in LAPS), and the readouts the curated face
// paints.
//
// WHY A MODEL MODULE FOR A FOUR-KNOB EFFECT. Three structural reasons:
//
//  1. **The ranges exist in THREE places today and must exist in one.**
//     `packages/dsp/src/ringback.ts`'s `parameterDescriptors` is the real
//     clamp (a Web Audio `AudioParam` pins to `minValue`/`maxValue` whatever
//     the UI sends); `ringback.ts`'s `ParamDef`s restate it; and
//     `RingbackCard.svelte` restated it a third time as literal knob props.
//     Every gate we own reads the DEF, so the card→def half of that was
//     invisible (CLAUDE.md, the BACKDRAFT ±1-vs-±0.2 XyPads) and the
//     def→worklet half had no reader at all. The def and the card now import
//     these consts, and `ringback-crush-model.test.ts` parses the worklet's
//     descriptor table and asserts the third copy agrees.
//
//  2. **Two of the four knobs carry a number that does not say what it does.**
//     `rate = 0.5` is not "half" of anything a player can hear — it is the ring
//     cursor's advance per input sample, and its audible meaning is that the
//     wet path keeps one input sample in every 1/rate. `feedback = 0.3` does
//     not say how long the ring rings. Both conversions are real arithmetic
//     with a right answer, so they live here as tested functions rather than as
//     a table inside a Svelte component.
//
//  3. **The GLYPH CHOICE is an empirical claim** ("an RMS meter is nearly blind
//     to this module's two hero controls") and the test file measures it
//     against the real DSP core rather than asserting it in a comment.
//
// PURE: it imports only the DSP core's clamp constants (no DOM, no registry, no
// AudioContext), so it runs in the `unit` lane at ~0 added CI wall-time.

// The ring's own limits are DSP facts and already exported by the core the
// worklet runs — importing them is what makes SIZE and FEEDBACK single-sourced
// all the way down to the sample loop. Relative path, not the package alias:
// svelte-check only resolves the TS source out of node_modules via the dist
// build (the same reason `modules/ringback.ts` re-exports this way).
import {
  RINGBACK_MIN_SIZE,
  RINGBACK_MAX_SIZE,
  RINGBACK_MAX_FEEDBACK,
} from '../../../../dsp/src/lib/ringback-core';

/** ONE declared range, shared by the def, the card and the worklet gate. */
export interface RingbackRange {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/**
 * `rate` — the ring cursor's advance, in CELLS PER INPUT SAMPLE.
 *
 * Below 1 the cursor moves less than one cell per sample, so `1/rate`
 * consecutive input samples land in the SAME integer cell and only the last
 * survives (`ringWriteSpan` writes `[floor(cursor), ceil(cursor+rate))`, a
 * single cell when the span is short). That is the crush: the wet path is
 * decimated to `rate × SR` with no anti-alias filter anywhere.
 *
 * At and above 1 no input sample is discarded. The bounds are the worklet's
 * (`packages/dsp/src/ringback.ts` parameterDescriptors) — they are not
 * exported from the DSP package, which is exactly why the test file reads them
 * out of the source and compares.
 */
export const RINGBACK_RATE: RingbackRange = { min: 0.05, max: 4, default: 0.5 };

/** `size` — ring length in samples. Bounds are the DSP core's own clamp. */
export const RINGBACK_SIZE: RingbackRange = {
  min: RINGBACK_MIN_SIZE,
  max: RINGBACK_MAX_SIZE,
  default: 64,
};

/** `feedback` — read-back re-injected into the ring. `RINGBACK_MAX_FEEDBACK`
 *  is strictly below 1 so the ring can never self-amplify without bound. */
export const RINGBACK_FEEDBACK: RingbackRange = {
  min: 0,
  max: RINGBACK_MAX_FEEDBACK,
  default: 0.3,
};

/** `mix` — dry/wet. Defaults to 1: a freshly spawned RINGBACK is FULLY WET. */
export const RINGBACK_MIX: RingbackRange = { min: 0, max: 1, default: 1 };

/** Total, NaN-safe clamp into a declared range (a `ParamDef.format` runs on
 *  every animation frame while a value moves, so it must never throw). */
function clampTo(v: number, r: RingbackRange): number {
  if (!Number.isFinite(v)) return r.default;
  return v < r.min ? r.min : v > r.max ? r.max : v;
}

/**
 * How many consecutive input samples collapse into ONE ring cell — the wet
 * path's decimation divisor.
 *
 * Exactly `1/rate` below 1, and exactly 1 at or above it (nothing is dropped
 * once the cursor advances a full cell or more per sample). This is the
 * quantity `rate` actually means, and the one the dial's own number does not
 * carry.
 */
export function crushDivisor(rate: number): number {
  const r = clampTo(rate, RINGBACK_RATE);
  return r < 1 ? 1 / r : 1;
}

/**
 * `rate`'s persistent readout: the SAMPLE RATE the wet path runs at.
 *
 * `SR/2.0` says the thing the number `0.50` does not — half the input samples
 * never reach the ring, so the crushed copy is a 24 kHz signal interpolated
 * back up. The divisor drops its decimal past 10 (`SR/20` at the bottom of the
 * range) purely for width: the lane knob column is capped at
 * `LANE_KCOL_MAX_PX` (46) and at `READOUT_CHAR_PX` (5.97 px/glyph, measured)
 * that budget is 7 glyphs. Every string this function can return is ≤ 7, swept
 * in the test.
 *
 * ⚠ WHAT `FULL SR` CLAIMS, AND WHAT IT DOES NOT. It claims only that no input
 * sample is discarded, which is exactly true for every `rate ≥ 1`. It does NOT
 * claim the output is clean: measured on the real core over a C4 saw, the
 * normalised first-difference energy (how jagged the drawn waveform is) reads
 * 0.290 / 0.256 / 0.235 / 0.221 at the INTEGER rates 1 / 2 / 3 / 4 — around the
 * dry saw's own 0.255 — but 0.805 at 1.25 and 0.731 at 1.5, because a
 * fractional cursor smears the write across a fractional cell span and reads
 * back interpolated. RINGBACK is at its cleanest at INTEGER rates, which is not
 * a fact a single knob label can carry; the authored `docs.controls` entry
 * says it in prose instead.
 */
export function formatRingbackRate(rate: number): string {
  const r = clampTo(rate, RINGBACK_RATE);
  if (r >= 1) return 'FULL SR';
  const n = crushDivisor(r);
  return `SR/${n < 10 ? n.toFixed(1) : Math.round(n)}`;
}

/**
 * How many times the ring's contents circulate before the regenerated tail has
 * fallen 60 dB.
 *
 * Each LAP (one trip of the cursor around the ring, `size/rate` input samples)
 * multiplies the stored signal by `feedback`, so the tail is geometric and the
 * count is `ln(0.001)/ln(feedback)`. Reported in LAPS rather than in
 * milliseconds on purpose: a lap's duration depends on SIZE, RATE *and* the
 * hardware sample rate, none of which a per-param formatter is given — but the
 * LAP COUNT is exact and sample-rate independent.
 *
 * Returns 0 at `feedback = 0` (there is no regeneration to decay: the ring is
 * heard once and overwritten), and is floored at 1 elsewhere.
 */
export function ringLapsToSilence(feedback: number): number {
  const f = clampTo(feedback, RINGBACK_FEEDBACK);
  if (f <= 0) return 0;
  return Math.max(1, Math.round(Math.log(0.001) / Math.log(f)));
}

/**
 * Past this many laps the tail stops reading as a decay and starts reading as a
 * held tone, so the readout stops counting and names the behaviour instead.
 *
 * The threshold is also a WIDTH boundary and it is honest to say so: the
 * count reaches 342 laps at the top of the range, and `342 LAPS` is 8 glyphs
 * against a 7-glyph column budget. 100 laps is where the two constraints meet
 * — `99 LAPS` is the widest count that fits, and it corresponds to
 * `feedback ≈ 0.933`, i.e. the top ~7 % of the knob.
 */
export const RINGBACK_RINGING_LAPS = 100;

/**
 * `feedback`'s persistent readout: how long the ring RINGS.
 *
 * `0.30` does not say "about six laps and it is gone"; `6 LAPS` does. The two
 * named ends are the ones a patcher aims for — `1 PASS` (no regeneration at
 * all: the crushed copy is heard once) and `RINGING` (the regime the module's
 * own documentation calls a self-oscillating metallic drone).
 */
export function formatRingbackFeedback(feedback: number): string {
  const laps = ringLapsToSilence(feedback);
  if (laps === 0) return '1 PASS';
  if (laps >= RINGBACK_RINGING_LAPS) return 'RINGING';
  return laps === 1 ? '1 LAP' : `${laps} LAPS`;
}

/**
 * `mix`'s persistent readout: which END is which.
 *
 * A bare `0.35` on a dry/wet control does not say which direction is wet, and
 * this module ships at `mix = 1` — FULLY WET the instant you spawn it, which is
 * unusual for an insert effect and is the first thing a player has to
 * understand about it. `DRY` / `WET` are decided on the ROUNDED percentage so
 * the readout can never contradict the number beside it, and so the widest
 * string is `99% WET` (7 glyphs, exactly the column budget).
 */
export function formatRingbackMix(mix: number): string {
  const pct = Math.round(clampTo(mix, RINGBACK_MIX) * 100);
  if (pct <= 0) return 'DRY';
  if (pct >= 100) return 'WET';
  return `${pct}% WET`;
}
