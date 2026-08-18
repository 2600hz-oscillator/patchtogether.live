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
// ⚠ THE PAINTED READOUT IS A **NAME**, NEVER A NUMBER (owner ruling,
// 2026-08-17: *"we should kill the light white decimil represebtation of knob
// state in ALL modules"* / *"i want the data gone, not there but hidden or
// something"*). Three functions, three different questions, and the split is
// the whole design:
//
//   knobNameReadout  — WHAT IS PAINTED under the dial: a BARE option/landmark
//                      NAME, else `null` ⇒ nothing renders. A name is not a
//                      decimal representation of state — it is the only surface
//                      saying a morph knob is at TRI or which of fourteen
//                      engines is loaded — and the owner's own rationale for
//                      keeping tidyVco's A/D/S/R labels (text earns its place
//                      when it disambiguates otherwise-indistinguishable
//                      things) is exactly the argument for keeping it.
//                      ⚠ A declared `format` DISQUALIFIES — see `paintsReadout`.
//   knobReadout      — the declared vocabulary's own rendering, `format` first.
//                      NOT painted; the specificity ladder aria-valuetext walks.
//   knobValueReadout — what the control is WORTH, always a string. Feeds
//                      `aria-valuetext`, so the value stays in the
//                      accessibility tree (a slider whose value is unspeakable
//                      is a real regression) and every gate that needs to prove
//                      a face still tracks the graph keeps an observable.
//
// ⚠ `persistentReadout=false` WAS THE WRONG FIX AND IS NOT COMING BACK. It left
// the number one hover away — "there but hidden", refused by name. The element
// is gone from the DOM at rest, which is why the gate that holds this line
// (`face-readout-source.test.ts`) reads SOURCE rather than a rendered page.

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
 * DOES THIS PARAM PAINT ANYTHING AT REST? The whole gate, as one named
 * predicate — because the RENDER (`knobNameReadout` → `KnobConic`) and the
 * lane cell's reserved HEIGHT (`curated-face`'s `faceLaneCellHeights`, which
 * imports this) have to answer it identically. They used to be two copies of
 * the same condition and the comment on the second one said so; two copies is
 * how a face reserves 15 px for a line it no longer draws.
 *
 * TRUE only for a bare `options` / `landmarks` roster. TWO exclusions, and both
 * are load-bearing:
 *
 *   no roster  → nothing to name. This is most params.
 *   a declared `format` → the module chose its own NUMERIC rendering, which is
 *     exactly what came off the panel (`450 ms`, `900 HZ`, `+3.0 dB`).
 *
 * ⚠ THE `format` EXCLUSION IS NOT MERELY "IT IS A NUMBER" — IT ALSO FIXES A
 * LIVE BUG THE NAIVE RULE WOULD SHIP. A param may declare BOTH, and where it
 * does the roster is often not a naming roster at all. vca's `cvAmount` is the
 * case: it is an ATTENUVERTER whose meaning is its SIGN, so its `landmarks` are
 * reduced to the single null-point detent worth marking on the arc while
 * `format` does the reading. Rank landmarks above `format` here and the nearest
 * landmark to EVERY value is that one detent, so the dial would print one
 * unchanging word across its whole travel — the −0.4 case the def's own comment
 * warns about. Deferring to `format` and then painting nothing is right on both
 * counts.
 */
export function paintsReadout(vocab: KnobVocabulary): boolean {
  return !vocab.format && !!(vocab.options?.length || vocab.landmarks?.length);
}

/**
 * THE PAINTED READOUT — a declared STATE NAME, or `null` ⇒ the dial prints
 * nothing at rest.
 *
 * A name is not a decimal representation of state. It is the only surface that
 * says which of fourteen engines a `model` dial has selected, or which waypoint
 * a shape morph is nearest — and in the LANE, where an `options` param renders
 * as a dial rather than the dock's named button row, removing it would leave a
 * genuinely unreadable control. That is the owner's own test applied to a
 * readout instead of a label: text earns its place when it disambiguates
 * otherwise-indistinguishable states.
 *
 * ⚠ IT IS NOT `knobReadout` MINUS A BRANCH. Keeping the two separate is what
 * lets `aria-valuetext` carry the FULL declared rendering (`knobValueReadout`)
 * while the panel paints only the name — one value, two audiences, no second
 * formatter to drift.
 *
 * Nearest-match, not exact, for the reason `knobReadout` states below.
 */
export function knobNameReadout(value: number, vocab: KnobVocabulary): string | null {
  if (!paintsReadout(vocab)) return null;
  if (vocab.options?.length) return nearestByValue(value, vocab.options)?.label ?? null;
  return nearestByValue(value, vocab.landmarks ?? [])?.label ?? null;
}

/**
 * The declared vocabulary's own rendering, or `null` when the param declared
 * none.
 *
 * ⚠ NOT PAINTED ANY MORE — see `knobNameReadout`. This is the specificity
 * ladder `knobValueReadout` walks on the way to `aria-valuetext`, and the
 * ordering below is why a formatted param still SPEAKS its own units even
 * though it no longer prints them.
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
 * WHAT THE CONTROL IS WORTH, as a string. Never null.
 *
 * ⚠ ITS ONE CONSUMER IS `aria-valuetext`. It used to be the DOCK's painted
 * readout (PF-20) and that is exactly what the owner removed; what survives is
 * the half nobody was objecting to — the value has to remain SPEAKABLE. A
 * `role="slider"` whose value cannot be announced is a real accessibility
 * regression, and it is not the clutter complaint: nothing about it is painted.
 *
 * ⚠ IT IS ALSO THE OBSERVABLE THE GATES MOVED TO. A spec that used to read
 * `readout-<paramId>`'s text to prove a face tracks the graph now reads
 * `aria-valuetext` off `control-<paramId>` — the SAME ladder, so the proof is
 * unchanged and no assertion had to be weakened to survive the removal. That is
 * deliberate: an assertion deleted to make a suite pass proves nothing, and
 * this function is what made deleting them unnecessary.
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
