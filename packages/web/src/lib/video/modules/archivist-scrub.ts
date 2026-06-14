// packages/web/src/lib/video/modules/archivist-scrub.ts
//
// ARCHIVIST pure scrub/seek math for time-based media (audio + video).
// NO DOM: every function maps numbers→numbers so the card's transport can be
// unit-tested without a real <audio>/<video> element. The card applies the
// result to element.currentTime.

/** Default skip step for the ±N-second buttons. */
export const SKIP_STEP_S = 10;

/** Clamp a target seek time into [0, duration]. Non-finite duration (a
 *  stream with unknown length) clamps only at the low end. */
export function clampSeek(target: number, duration: number): number {
  if (!Number.isFinite(target)) return 0;
  const lo = Math.max(0, target);
  if (!Number.isFinite(duration) || duration <= 0) return lo;
  return Math.min(duration, lo);
}

/** Position after skipping by `deltaS` seconds from `current`, clamped. */
export function skipBy(current: number, deltaS: number, duration: number): number {
  return clampSeek((Number.isFinite(current) ? current : 0) + deltaS, duration);
}

/**
 * A random seek position in [0, duration). Uses an injectable RNG so tests
 * are deterministic. Returns 0 for a zero/unknown duration. We bias slightly
 * away from the very end (× 0.98) so "jump to random" rarely lands on the
 * final frame / immediate `ended`.
 */
export function randomSeek(duration: number, rng: () => number = Math.random): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return clampSeek(rng() * duration * 0.98, duration);
}

/** Playhead position as a 0..1 fraction of duration (0 when no duration). */
export function positionFraction(current: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(current) || current <= 0) return 0;
  return Math.min(1, current / duration);
}

/** Convert a 0..1 fraction back to a seconds position (clamped). */
export function fractionToSeconds(fraction: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return f * duration;
}

/** mm:ss formatter shared by the card readout + tests. */
export function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60)
    .toString()
    .padStart(2, '0');
  return `${mm}:${ss}`;
}
