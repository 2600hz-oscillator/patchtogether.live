// packages/web/src/lib/ui/controls/knob-vocabulary-model.ts
//
// PURE resolvers for the KnobConic PARAM VOCABULARY (PF-1 / PF-3 / PF-10):
// given a live value plus whatever a ParamDef declared about what its numbers
// MEAN, what text does the dial print and where do its detent ticks sit?
//
// WHY A SEPARATE PURE LAYER: the dial is the ONE place all three vocabulary
// features converge, and all three are "what does this number mean" questions
// with no DOM in them. Keeping the answers here makes the interesting cases —
// an off-detent saved value, a landmark exactly between two ticks, a format
// that throws — unit-testable without a browser, and leaves KnobConic.svelte a
// thin shell (the knob-conic-model precedent).
//
// THE READOUT GATE IS THE POINT (PF-3). `knobReadout` returns `null` for a
// plain param, and KnobConic renders NOTHING when it is null. That is not a
// micro-optimization: the dial already shows its value on hover/drag, so a
// persistent readout on every knob would add a text row to ~17 dock faceplates
// and move every one of their baselines to say what hovering already said.
// A persistent readout is earned by DECLARING a meaning the number does not
// carry on its own.

import type { KnobCurve, ParamLandmark, ParamOption } from '$lib/graph/types';
import { knobValueToFrac } from './knob-conic-model';
import { formatParamNumber } from './param-format';

/** What a param declared about the meaning of its numbers. All optional; a
 *  param that declares none of it gets the classic bare dial. */
export interface KnobVocabulary {
  options?: readonly ParamOption[];
  landmarks?: readonly ParamLandmark[];
  format?: (v: number) => string;
}

/** A rendered detent tick: WHERE on the arc, and (for a landmark) WHAT it is. */
export interface KnobMark {
  /** Normalized arc position [0,1] — the same space as KnobConic's `--v`. */
  frac: number;
  /** The mark's own value in param units (stable key + a11y/debug). */
  value: number;
  /** Shown text, '' for an unlabeled tick. */
  label: string;
}

/**
 * The nearest entry of a value-keyed roster, by absolute distance. Returns
 * `undefined` for an empty roster. Ties resolve to the EARLIER entry, so the
 * result is deterministic for a value sitting exactly between two detents
 * (a rounding-dependent answer would make the readout flicker under a
 * motorized/CV-driven value).
 */
export function nearestByValue<T extends { value: number }>(
  value: number,
  roster: readonly T[],
): T | undefined {
  let best: T | undefined;
  let bestD = Infinity;
  for (const entry of roster) {
    const d = Math.abs(entry.value - value);
    // STRICTLY less-than: the first entry at a tied distance wins.
    if (d < bestD) {
      bestD = d;
      best = entry;
    }
  }
  return best;
}

/**
 * The PERSISTENT readout text for a dial, or `null` when the param declared no
 * vocabulary (the gate — see the header note).
 *
 * Precedence is by SPECIFICITY, and it is deliberate:
 *   1. `format`     — the param supplied its own renderer; nothing outranks that.
 *   2. `options`    — a discrete state HAS a name; print the name, never `2.00`.
 *   3. `landmarks`  — a continuous morph is BETWEEN names; print the nearest.
 *
 * An `options` roster resolves by NEAREST rather than exact match on purpose.
 * A saved value can sit off-detent (a pre-`options` rack, a CV-motorized read,
 * a param whose curve was widened) and an exact-match lookup would print
 * nothing at all for it — which is strictly worse than the bare number the
 * readout replaced. `Segmented` has the same exposure and takes the same fix
 * (`nearestSegmentValue`); the two must agree or the dock and the lane would
 * disagree about which state the module is in.
 */
export function knobReadout(value: number, vocab: KnobVocabulary): string | null {
  if (vocab.format) return vocab.format(value);
  if (vocab.options?.length) return nearestByValue(value, vocab.options)?.label ?? null;
  if (vocab.landmarks?.length) return nearestByValue(value, vocab.landmarks)?.label ?? null;
  return null;
}

/**
 * The DOCK-TIER readout: the declared vocabulary NAME when there is one, else
 * the plain numeric ladder with units. Never null.
 *
 * PF-20 — WHY THIS EXISTS AND WHY IT IS NOT `knobReadout`. The PF-3 gate above
 * is right for a LANE tile: a 46px knob column cannot afford a text row for
 * something hovering already shows. It was wrong for the DOCK. Every mocked
 * faceplate prints a value under every knob (`SUB DEC 450 ms`, `P AMT 24 st`),
 * and shipping bare labels there is the single largest share of the drift the
 * owner put next to the mock — a readout you must hover to see does not exist
 * on a panel you are reading.
 *
 * So the GATE MOVES TO THE CALLER instead of disappearing: `knobReadout` still
 * answers "did this param declare a meaning", this answers "print the value
 * whatever it declared", and KnobConic picks per view. The lane keeps the bare
 * dial; the dock always prints. Same ladder either way, which is what stops the
 * hero readout and the dial under it from disagreeing about one number.
 */
export function knobValueReadout(value: number, vocab: KnobVocabulary, units = ''): string {
  return knobReadout(value, vocab) ?? formatParamNumber(value, units);
}

/**
 * The detent ticks to paint around the arc, sorted by position and free of
 * duplicates. BOTH vocabularies produce marks — a discrete `options` roster
 * has a detent at every state, a `landmarks` roster at every named waypoint —
 * but they mean different things and the LABEL is where that shows: an option
 * tick is unlabeled (the Segmented/Selector alongside it already names every
 * state, and the readout names the current one), while a landmark tick carries
 * its name because there is no other surface naming the waypoints.
 *
 * Positions run through `knobValueToFrac`, so a mark lands where the pointer
 * lands under the SAME curve — a log-curve landmark ticks at its log position,
 * not at a linear fraction of the range.
 */
export function knobMarks(
  vocab: KnobVocabulary,
  min: number,
  max: number,
  curve: KnobCurve = 'linear',
): readonly KnobMark[] {
  const source: readonly { value: number; label?: string }[] = vocab.landmarks?.length
    ? vocab.landmarks
    : (vocab.options ?? []);
  if (!source.length) return [];
  const marks: KnobMark[] = [];
  const seen = new Set<number>();
  for (const entry of source) {
    if (entry.value < min || entry.value > max) continue;
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    marks.push({
      frac: knobValueToFrac(entry.value, min, max, curve),
      value: entry.value,
      // Options are named by their own control; landmarks are named here.
      label: vocab.landmarks?.length ? (entry.label ?? '') : '',
    });
  }
  marks.sort((a, b) => a.value - b.value);
  return marks;
}
