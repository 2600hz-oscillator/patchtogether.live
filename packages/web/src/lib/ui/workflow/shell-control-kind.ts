// packages/web/src/lib/ui/workflow/shell-control-kind.ts
//
// The PURE render-kind resolver for a ModuleShell control cell: given a curated
// FaceControl + the def, which PRIMITIVE does the shell paint?
//
// Born from the P1 batch-2 adversarial render verify (the INERT-CELL gap):
// the shell used to paint EVERY param as a KnobConic and every family/static
// key as a dashed label. Two bugs fell out of that:
//   * tomtom's momentary STRIKE pad rendered as a LATCHING rotary — dragging it
//     to 1 masked the TRIG jack and persisted a stuck value into the Y.Doc;
//   * dx7's PRESET selector and .syx import (its hero + its cartridge loader)
//     rendered as dead text, so the DX7's voice could not be changed at all.
//
// This module owns the PARAM half of the answer (pure, node-testable); the
// FAMILY/STATIC half needs live state + actions and lives in shell-cells.ts.
//
// A third case joined them: a plain 0/1 LATCHING switch (kickdrum/snaredrum
// HARD) rendered as a KnobConic reading "0.00" — technically operable, but a
// two-state control asking for a 200px drag and printing a float. It now paints
// the same <Toggle> `.switch` the legacy cards use.
//
// WHY momentary is DECLARED, not sniffed: a press-pad and a latching switch
// have the IDENTICAL ParamDef shape (`0..1 discrete default 0` — tomtom
// `strike` vs kickdrum/snaredrum `hard`, tidyVco `hold`). Only the module knows
// which it is, so the intent is declared on the def's `face.momentary` (UI
// metadata — see ModuleFace; NOT the I/O contract) and module-face-lint fails a
// promoted module that grows an unclassified switch-shaped param.

import { looksLikeToggle } from '$lib/graph/group-controls';
import type { ParamDef } from '$lib/graph/types';

/** The primitive a PARAM cell renders as. */
export type ParamCellKind = 'knob' | 'momentary' | 'toggle' | 'segmented' | 'selector';

/**
 * How many named states still fit as an inline button row before the dock
 * switches to a dropdown. Six is where a `.seg` row (24 px tall, ~8 px padding
 * per caption) stops fitting a dock band's column without either wrapping or
 * ellipsizing every caption to uselessness — past that a Selector shows the
 * SAME roster in a portaled, viewport-clamped list that stays readable.
 */
export const SEGMENTED_MAX_OPTIONS = 6;

/** Which face tier is asking. Only the dock has the room for a laid-out
 *  roster; every LANE tier (mini/compact/full) is a knob column. */
export type ParamCellTier = 'dock' | 'lane';

/**
 * Does this param have the PRESS-PARAM SHAPE — a 0/1 switch resting at 0?
 * Shape alone does NOT mean momentary (a latching toggle looks identical); it
 * only marks the params that REQUIRE an explicit momentary/latching decision.
 * `looksLikeToggle` is the ONE canonical 0/1-switch detector (group-controls),
 * shared with the auto-expose bar and the Toggle primitive. Pure.
 */
export function looksLikeSwitch(p: ParamDef): boolean {
  return looksLikeToggle(p) && p.defaultValue === 0;
}

/** The declared momentary param ids for a def (empty when none). Pure. */
export function momentaryParamIds(def: { face?: { momentary?: readonly string[] } } | undefined): ReadonlySet<string> {
  return new Set(def?.face?.momentary ?? []);
}

/**
 * Which primitive a param cell renders as. Takes the whole ParamDef (not just
 * the id) because the answer depends on the param's SHAPE and its DECLARED
 * vocabulary as well as the def's momentary list — and on the TIER, because a
 * dock band and a 46 px lane knob column have different room:
 *
 *   momentary — a DECLARED press-pad (`face.momentary`) → a momentary <Button>.
 *               The declaration WINS over the shape: a press-pad and a latching
 *               switch are the identical 0..1-discrete-at-0 ParamDef.
 *   segmented — a DECLARED `options` roster (PF-1) at the DOCK, ≤ 6 states →
 *               <Segmented>, the inline `.seg` button row. Every state is
 *               visible and one click away, which is what a named mode wants.
 *   selector  — the same roster at the DOCK with ≥ 7 states → <Selector>, whose
 *               portaled list stays readable where a button row would not.
 *   toggle    — an undeclared 0..1 discrete switch → <Toggle>, the same
 *               `.switch` primitive the legacy cards paint for it (kickdrum /
 *               snaredrum HARD read `0.00` on a rotary and took a 200 px drag
 *               to flip a two-state control).
 *   knob      — everything else, the KnobConic every other param keeps. This is
 *               ALSO where an `options` param lands at every LANE tier: a lane
 *               column cannot hold a roster, so the dial keeps the space and
 *               earns a PERSISTENT readout naming the current state (PF-1's
 *               lane half + PF-3's readout are the same code path).
 *
 * PRECEDENCE — `options` outranks `looksLikeToggle` deliberately. A two-state
 * param that DECLARED names for its states wants those names painted on two
 * captioned buttons, not an anonymous switch; declaration beating sniffed
 * shape is the same rule `momentary` already establishes above. `momentary`
 * still outranks everything: a press-pad is not a state.
 *
 * NOTE the render kind is INDEPENDENT of the momentary/latching CLASSIFICATION
 * gate in module-face-lint: a switch that renders as a Toggle here still has to
 * be classified there (face.momentary or ACKNOWLEDGED_LATCHING). One answers
 * "which primitive", the other "does releasing it write REST back". Pure.
 */
export function paramCellKind(
  p: ParamDef,
  momentary: ReadonlySet<string>,
  tier: ParamCellTier = 'lane',
): ParamCellKind {
  if (momentary.has(p.id)) return 'momentary';
  if (p.options?.length) {
    if (tier !== 'dock') return 'knob';
    return p.options.length <= SEGMENTED_MAX_OPTIONS ? 'segmented' : 'selector';
  }
  if (looksLikeToggle(p)) return 'toggle';
  return 'knob';
}

/** The value a momentary pad writes on press / release. The pad is the same
 *  0/1 press-param the legacy cards write (`strike` high while held; the
 *  worklet fires on its rising edge), so RELEASE returns it to REST — the
 *  def default — and nothing stuck is left behind in the Y.Doc. Pure. */
export function momentaryValue(high: boolean, restValue = 0): number {
  return high ? 1 : restValue;
}
