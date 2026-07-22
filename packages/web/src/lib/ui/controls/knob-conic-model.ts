// packages/web/src/lib/ui/controls/knob-conic-model.ts
//
// PURE value-arc math for KnobConic.svelte (the RACKLINE conic dial). The
// component is a thin shell over these: it drives the CSS value-arc (`--v`,
// 0..1) + the pointer rotation from a single normalized fraction, exactly
// like the ux-fullview mock (`.knob` conic-gradient + `.ptr` rotate). Keeping
// the mapping here makes "does the arc track the value under each curve"
// unit-testable without a DOM.
//
// Mirrors Knob.svelte's curve mapping so a card can swap Knob → KnobConic with
// identical drag/wheel feel; adds correct `discrete` rounding on the way back
// to a value (Knob left that to callers).

import type { KnobCurve } from '$lib/graph/types';

/** Total sweep of the dial, in degrees (225° start → 315° span in the mock). */
export const KNOB_ARC_DEG = 270;
/** Pointer angle at value = min (0 frac). The arc opens symmetrically around 0°. */
export const KNOB_START_DEG = -135;

function clamp01(f: number): number {
  if (!Number.isFinite(f)) return f > 0 ? 1 : 0;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * Map an internal value to the normalized arc fraction [0,1] under the
 * declared curve. This is the `--v` custom property the conic gradient + the
 * pointer rotation both read. Endpoints pin to 0/1; out-of-range clamps.
 */
export function knobValueToFrac(
  value: number,
  min: number,
  max: number,
  curve: KnobCurve = 'linear',
): number {
  if (max === min) return 0;
  const clamped = Math.max(min, Math.min(max, value));
  if (curve === 'log') {
    // Log needs strictly-positive endpoints; fall back to linear otherwise.
    if (min <= 0 || max <= 0) return (clamped - min) / (max - min);
    return Math.log(clamped / min) / Math.log(max / min);
  }
  if (curve === 'exp') {
    const frac = (clamped - min) / (max - min);
    return frac * frac;
  }
  // linear + discrete both normalize linearly for the ARC position.
  return (clamped - min) / (max - min);
}

/**
 * Inverse of knobValueToFrac — the arc fraction back to a value under the
 * curve. `discrete` snaps to the nearest integer step (the arc still moves
 * continuously; only the committed value quantizes).
 */
export function knobFracToValue(
  frac: number,
  min: number,
  max: number,
  curve: KnobCurve = 'linear',
): number {
  const fr = clamp01(frac);
  if (curve === 'log') {
    if (min <= 0 || max <= 0) return min + fr * (max - min);
    return min * Math.pow(max / min, fr);
  }
  if (curve === 'exp') {
    return min + Math.sqrt(fr) * (max - min);
  }
  if (curve === 'discrete') {
    return Math.round(min + fr * (max - min));
  }
  return min + fr * (max - min);
}

/**
 * Pointer rotation (degrees) for an arc fraction [0,1]: −135° at min, 0° at
 * centre, +135° at max. Matches the mock's `rotate(calc(var(--v)*270deg -
 * 135deg))`.
 */
export function knobPointerAngle(frac: number): number {
  return clamp01(frac) * KNOB_ARC_DEG + KNOB_START_DEG;
}
