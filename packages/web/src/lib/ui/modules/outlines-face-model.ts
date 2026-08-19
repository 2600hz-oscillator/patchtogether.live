// packages/web/src/lib/ui/modules/outlines-face-model.ts
//
// The PURE model behind the OUTLINES faceplate — four readouts, each of which
// exists because ITS KNOB'S MAPPING IS DISCONTINUOUS WHERE THE DIAL IS NOT.
//
// ⚠ THIS IS A DIFFERENT JUSTIFICATION FROM THE USUAL DERIVED READOUT, and it is
// worth naming because the usual one does not apply here. The canonical case
// (kick drum's TAIL) is a JOIN: the number is a function of several knobs, so no
// single readback can reach it. None of these four is a join — each is a pure
// function of one param. What makes them not "a knob relabelled" is that each
// mapping has a STEP or a MODE that the dial position cannot express:
//
//   rate   `mapRateIntervalMs` returns **null** at or below 0.001 (the internal
//          clock is OFF — gate-only spawning) and the instant it engages it is
//          at **3996.50 ms**, tightening to 500 ms at 1.0. Two dial positions a
//          thousandth apart are "no clock at all" and "a shape every four
//          seconds", and they look identical on a knob.
//   decay  `decay = 0` is a MODE, not a time: `alphaFor(age, 0)` is **1.0000**
//          at every age (persist forever, FIFO-culled), while `decay = 0.0001`
//          gives **0.0000** at 5 s — a 1 ms fade. ⚠ A face printing "0.0 s"
//          under DECAY would be actively lying, and the default sits EXACTLY on
//          the discontinuity.
//   shape  six bands of 0.166667. A dial at 0.16 and one at 0.17 are visually
//          the same and are TRIANGLE and SQUARE.
//   spin   `mapAngularVel` is zero at EXACTLY 0.5 and nowhere else.
//
// ⚠ AND THE SHAPE + SPIN READOUTS ARE A PARITY REQUIREMENT, NOT AN ADDITION.
// `OutlinesCard.svelte` already prints both (`outlines-shape-readout`,
// `outlines-rot-readout`). Promotion deletes that card, so a face without them
// REMOVES a working affordance — functional parity is a hard requirement, not a
// nice-to-have. (#1866 asserted the card "has no shape-name formatter at all";
// that claim is false and was corrected on the issue.)
//
// ⚠ ONE OF THE TWO IS REPRODUCED, THE OTHER IS CORRECTED — deliberately.
// The card's spin readout uses a ±0.02 DEADBAND around centre, but
// `mapAngularVel` has no deadband: it is `(r − 0.5) · 2 · ROT_MAX_RAD_S`. So at
// `rotation = 0.52` the field genuinely turns at **0.5027 rad/s** — a full
// revolution every 12.5 s — while the card prints `·` for "no spin". This model
// asks the SIM's own function instead, so the readout cannot disagree with the
// picture. That is a fix, not a parity loss.
//
// PURE: no DOM, no engine, no store, no fs.

import { outlinesDef } from '$lib/video/modules/outlines';
import {
  mapShape,
  mapDecay,
  mapAngularVel,
  mapRateIntervalMs,
  SHAPE_COUNT,
} from '$lib/video/modules/outlines-sim';

/**
 * The six shape names, in sim index order. ⚠ ASSERTED against `SHAPE_COUNT` in
 * the test beside this file rather than trusted: a seventh shape added to the
 * sim must not silently fall off the end of this list and print `CIRCLE`.
 */
export const OUTLINES_SHAPE_NAMES: readonly string[] = [
  'CIRCLE', 'TRI', 'SQUARE', 'PENTA', 'HEXA', 'OCTA',
];

type Read = (paramId: string) => number | undefined;

/** One param, with the def's default substituted for an unwritten key and for
 *  any non-finite value. The readouts run on every render, so a NaN reaching a
 *  comparison would print a confident wrong word rather than throwing. */
function paramOr(read: Read, id: string): number {
  const v = read(id);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return outlinesDef.params.find((p) => p.id === id)!.defaultValue;
}

/** WHAT THE NEXT SHAPE WILL BE. Latched at spawn, so this describes the future,
 *  not what is on screen. */
export function outlinesShapeText(read: Read): string {
  return OUTLINES_SHAPE_NAMES[mapShape(paramOr(read, 'shape'))] ?? OUTLINES_SHAPE_NAMES[0];
}

/**
 * FIELD SPIN DIRECTION — the one LIVE control, read through the sim's own
 * `mapAngularVel` so there is no deadband to disagree with the picture.
 */
export function outlinesSpinText(read: Read): string {
  const w = mapAngularVel(paramOr(read, 'rotation'));
  if (w === 0) return 'still';
  return w > 0 ? 'CW' : 'CCW';
}

/**
 * THE SPAWN CLOCK. `gate only` below the engage threshold — where the module
 * still spawns, but only on a gate edge — otherwise the interval in ms.
 */
export function outlinesSpawnText(read: Read): string {
  const ms = mapRateIntervalMs(paramOr(read, 'rate'));
  if (ms === null) return 'gate only';
  return `${Math.round(ms)} ms`;
}

/**
 * HOW LONG A SHAPE LIVES. `persist` at 0 — the shipped default, and a MODE
 * rather than a duration: shapes never fade and leave only via the FIFO cull.
 */
export function outlinesDecayText(read: Read): string {
  const s = mapDecay(paramOr(read, 'decay'));
  if (s <= 0) return 'persist';
  const ms = s * 1000;
  // ⚠ NEVER PRINT A ZERO DURATION. A decay one nanosecond above the persist
  // mode rounds to `0 ms`, which is the exact lie this readout exists to
  // prevent — it would read the same as the persist case while meaning its
  // opposite. Caught by this file's own totality leg, not by review.
  if (ms < 1) return '<1 ms';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${s.toFixed(1)} s`;
}

/** Exported so the test can assert the name list tracks the sim's shape count
 *  rather than a typed number. */
export const OUTLINES_SIM_SHAPE_COUNT = SHAPE_COUNT;
