// packages/web/src/lib/control/push2/push-card-encoder.ts
//
// TURNING a push-card encoder — the WRITE half of the card, where
// push-card-model.ts is the READ half (pixels ← value). Two directions of the
// same contract, kept in two files so neither grows a dependency on the other.
//
// PURE: value in, value out. No node, no store, no engine — the commit seam
// lives in push2-control.svelte.ts, which is the only place allowed to write.
//
// ── THE THREE MOVEMENT MODES, AND WHY IT IS NOT JUST ONE ──────────────────
//
// A Push encoder sends a RELATIVE delta ("I moved n detents"), so the app
// chooses what a detent means. One rule cannot serve every param:
//
//   1. A DECLARED OPTION ROSTER moves by option INDEX. A roster may be sparse
//      (states at 0, 4 and 9 across a 0..9 range); stepping in value space
//      would stall for three detents between states and then jump two.
//   2. A `discrete` curve moves by ONE INTEGER. This is load-bearing, not a
//      nicety: dx7's `algorithm` spans 1..32, so a 0.01 step in FRACTION space
//      is 0.31 of an algorithm — `Math.round` sends it straight back where it
//      started and the encoder appears DEAD. `voiceCount` (1..5) would need 25
//      detents per voice.
//   3. Everything else moves in FRACTION space through `knobFracToValue` ∘
//      `knobValueToFrac` — the same pair KnobConic drags through — so a detent
//      is a constant fraction of the ARC, not of the raw range. On a log param
//      that is what makes the low end usable: a linear 1 % of `filter.cutoff`'s
//      20..20000 range would be 200 Hz per detent, which cannot address
//      anything below 200 Hz at all.
//
// The ±4 clamp is on the RAW delta: `decodeRelativeCc` legitimately reports up
// to ±63 on a hard flick, and a param that leaps from one end of its range to
// the other because you spun the knob is not an instrument.

import type { ParamDef } from '$lib/graph/types';
import { knobValueToFrac, knobFracToValue } from '$lib/ui/controls/knob-conic-model';
import { nearestByValue } from '$lib/ui/controls/knob-vocabulary-model';

/** Fraction of the arc one detent covers. Matches the feel of the encoder step
 *  the Push already shipped with (0.01 over the 0..1 mixer ranges). */
export const ENCODER_FRAC_STEP = 0.01;
/** Fine step, held under SHIFT — 5× slower, for dialling in a cutoff. */
export const ENCODER_FRAC_STEP_FINE = 0.002;
/** Most detents one relative-CC message may be worth. */
export const MAX_ENCODER_STEP = 4;

/** Clamp + integerize a decoded relative-CC delta. */
export function clampEncoderDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  return Math.max(-MAX_ENCODER_STEP, Math.min(MAX_ENCODER_STEP, Math.trunc(delta)));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The value `p` should hold after turning its encoder by `delta` detents from
 * `cur`. Always inside [p.min, p.max]. Returns `cur` unchanged for a zero (or
 * non-finite) delta, so a no-op message never reaches the commit seam.
 *
 * `fine` = the SHIFT modifier — a smaller fraction step. It deliberately does
 * NOT apply to the option/discrete modes: there is no such thing as a fifth of
 * an algorithm, and slowing a state selector would only make it feel broken.
 */
export function nudgeParamValue(p: ParamDef, cur: number, delta: number, fine = false): number {
  const step = clampEncoderDelta(delta);
  if (step === 0) return cur;
  const base = Number.isFinite(cur) ? cur : p.defaultValue;

  // 1 — a declared roster: step by INDEX so sparse states are one detent apart.
  if (p.options?.length) {
    const near = nearestByValue(base, p.options);
    const i = near ? p.options.indexOf(near) : 0;
    const next = clamp(i + step, 0, p.options.length - 1);
    return clamp(p.options[next].value, p.min, p.max);
  }

  // 2 — a discrete curve with no roster: step by exactly one integer.
  if (p.curve === 'discrete') {
    return clamp(Math.round(base) + step, p.min, p.max);
  }

  // 3 — continuous: a constant fraction of the ARC, under the param's own curve.
  const frac = knobValueToFrac(base, p.min, p.max, p.curve);
  const size = fine ? ENCODER_FRAC_STEP_FINE : ENCODER_FRAC_STEP;
  return knobFracToValue(clamp(frac + step * size, 0, 1), p.min, p.max, p.curve);
}
