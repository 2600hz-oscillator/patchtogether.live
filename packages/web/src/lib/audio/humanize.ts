// packages/web/src/lib/audio/humanize.ts
//
// Pure helpers for "humanize" timing offsets. Used by POLYSEQZ to nudge the
// per-voice gate-on time around the nominal step boundary, simulating the
// micro-variation of a human pianist.
//
// Mapping rules (defined here so the audio module's tick loop is free of
// magic numbers and the unit tests can exercise the distribution directly):
//
//   amount = 0       → all voices fire exactly on the tick (no offset).
//   amount = 0.5     → max delay magnitude ≈ ±15 ms; uniform-ish distribution.
//   amount = 1       → max delay magnitude ≈ ±50 ms; non-uniform / chaotic
//                      (cubic distribution favoring the extremes — gives
//                      "rushed clusters and dragged stragglers" feel).
//
// Implementation notes:
//   - We linearly interpolate the maximum magnitude between 0 and 50 ms.
//   - Distribution shape morphs from triangular (low amount → smooth, jazzy)
//     to cubic (high amount → chaotic clusters near the rails). The exponent
//     scales from 1 (uniform-ish) to 3 (heavy tail) with amount.
//   - Returns delay in SECONDS (Web Audio convention). Negative values mean
//     "fire EARLIER than the tick" — callers must clamp to >= ctx.currentTime
//     to avoid AudioParam-in-the-past errors.
//
// Determinism: callers pass an explicit `rng()` so tests can seed it. Live
// production callers pass Math.random.

/** Maximum absolute delay (seconds) at amount=1.0. Tuned by ear: 50 ms is
 *  noticeably loose without sounding "broken" through a piano-like patch. */
export const HUMANIZE_MAX_DELAY_S = 0.05;

/** Maximum absolute delay (seconds) at amount=0.5. Inflection point — below
 *  this users perceive "expressive feel"; above, "rushing/dragging". */
export const HUMANIZE_MID_DELAY_S = 0.015;

/** Clamp helper. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Maximum absolute delay (in seconds) for a given humanize amount.
 *
 * Two-piece linear ramp:
 *   amount ∈ [0, 0.5] → 0 .. HUMANIZE_MID_DELAY_S
 *   amount ∈ (0.5, 1] → HUMANIZE_MID_DELAY_S .. HUMANIZE_MAX_DELAY_S
 *
 * Below 0 returns 0; above 1 saturates at HUMANIZE_MAX_DELAY_S.
 */
export function humanizeMaxDelay(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (amount >= 1) return HUMANIZE_MAX_DELAY_S;
  if (amount <= 0.5) {
    const t = amount / 0.5;
    return HUMANIZE_MID_DELAY_S * t;
  }
  const t = (amount - 0.5) / 0.5;
  return HUMANIZE_MID_DELAY_S + (HUMANIZE_MAX_DELAY_S - HUMANIZE_MID_DELAY_S) * t;
}

/**
 * Distribution exponent for a given humanize amount.
 *
 *   amount = 0   → exponent 1   (uniform-ish, gentle).
 *   amount = 0.5 → exponent ≈ 1.5 (slight bias to small offsets).
 *   amount = 1   → exponent 3   (heavy tails — "chaotic clusters").
 */
export function humanizeShape(amount: number): number {
  const a = clamp(amount, 0, 1);
  return 1 + 2 * a; // 1 → 3
}

/**
 * Sample a single bipolar humanize delay (seconds) for one voice.
 *
 *   1. Draw u ∈ [0, 1) from rng.
 *   2. Centered: c = 2u - 1 ∈ [-1, +1).
 *   3. Shape: signed magnitude lifted by exponent: sign(c) * |c|^exp.
 *   4. Scale by maxDelay.
 *
 * For amount=0 returns exactly 0 (max delay is 0).
 */
export function sampleHumanizeOffset(
  amount: number,
  rng: () => number = Math.random,
): number {
  const max = humanizeMaxDelay(amount);
  if (max <= 0) return 0;
  const exp = humanizeShape(amount);
  const u = rng();
  const c = 2 * u - 1;
  const signed = c < 0 ? -Math.pow(-c, exp) : Math.pow(c, exp);
  return signed * max;
}

/**
 * Sample N independent humanize offsets at once. Convenience for the per-step
 * scheduler — POLYSEQZ calls sampleHumanizeOffsets(amount, 5) per step.
 */
export function sampleHumanizeOffsets(
  amount: number,
  count: number,
  rng: () => number = Math.random,
): number[] {
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = sampleHumanizeOffset(amount, rng);
  return out;
}
