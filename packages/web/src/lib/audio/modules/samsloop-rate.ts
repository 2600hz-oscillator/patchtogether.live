// packages/web/src/lib/audio/modules/samsloop-rate.ts
//
// SAMSLOOP rate-fader visual mapping.
//
// The underlying `rate` AudioParam ranges over [-2, +2] where the numeric
// value IS the playback multiplier (1.0 = unity forward, 2.0 = forward
// 2×, −2.0 = reverse 2×, 0 = stopped, negative = reverse).
//
// The visual fader, however, must place its dead-center at rate=+1.0
// ("100% normal playback") rather than rate=0 — because musically, the
// natural rest position for a sample looper is "play the sample as
// recorded", not "stopped". That makes the mapping ASYMMETRIC:
//
//   knob 0      → rate -2    (full left  = reverse 2×)
//   knob 0.5    → rate +1    (CENTER     = unity forward)
//   knob 1      → rate +2    (full right = forward 2×)
//
// So the left half of the knob covers a 3-unit rate-range (−2 → +1) and
// the right half covers a 1-unit range (+1 → +2). The Fader component
// renders this by being fed a `[0, 1]` synthetic range with these helpers
// translating between visual position and the actual rate value at the
// drag/commit boundary.
//
// Keep these helpers pure — they're testable in isolation and the card
// + tests share one source of truth.

import { SAMSLOOP_RATE_RANGE } from './samsloop';

/** Numeric tolerance for the round-trip + continuity tests. */
export const SAMSLOOP_RATE_EPS = 1e-9;

/**
 * Map a knob position in [0, 1] to a playback rate in [-2, +2], with the
 * geometric center (k=0.5) landing on rate=+1.0.
 *
 *   k ≤ 0.5 → rate ∈ [-2, +1]      (linear, slope 6)
 *   k > 0.5 → rate ∈ (+1, +2]      (linear, slope 2)
 *
 * Continuous at k=0.5: both branches yield +1.0.
 * Out-of-range k is clamped to [0, 1] before the piecewise step so
 * callers don't have to guard against floating-point overshoot.
 */
export function knobToRate(k: number): number {
  if (!Number.isFinite(k)) return SAMSLOOP_RATE_RANGE.defaultValue;
  const c = Math.max(0, Math.min(1, k));
  if (c <= 0.5) return -2 + c * 6;
  return 1 + (c - 0.5) * 2;
}

/**
 * Inverse of `knobToRate`. Map a playback rate in [-2, +2] to a knob
 * position in [0, 1], with rate=+1.0 landing on k=0.5.
 *
 *   rate ≤ +1 → k ∈ [0, 0.5]       (linear, slope 1/6)
 *   rate > +1 → k ∈ (0.5, 1]       (linear, slope 1/2)
 *
 * Out-of-range rate is clamped to [-2, +2] first.
 */
export function rateToKnob(rate: number): number {
  if (!Number.isFinite(rate)) return 0.5;
  const r = Math.max(SAMSLOOP_RATE_RANGE.min, Math.min(SAMSLOOP_RATE_RANGE.max, rate));
  if (r <= 1) return (r + 2) / 6;
  return 0.5 + (r - 1) / 2;
}

/**
 * Format a playback-rate value as a percentage with sign prefix.
 *   +1.0  → "+100%"
 *    0    → "0%"
 *   −0.5  → "-50%"
 *   +2.0  → "+200%"
 *   −2.0  → "-200%"
 *
 * The card's rate-fader uses this in its `formatValue` callback so the
 * value-tag shows "+100%" at the dead-center position, telegraphing the
 * "100% = normal" convention at a glance.
 */
export function formatRatePercent(rate: number): string {
  if (!Number.isFinite(rate)) return '0%';
  const pct = Math.round(rate * 100);
  if (pct > 0) return `+${pct}%`;
  if (pct === 0) return '0%';
  return `${pct}%`;
}
