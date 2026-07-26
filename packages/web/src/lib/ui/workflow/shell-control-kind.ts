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
// WHY momentary is DECLARED, not sniffed: a press-pad and a latching switch
// have the IDENTICAL ParamDef shape (`0..1 discrete default 0` — tomtom
// `strike` vs kickdrum/snaredrum `hard`, tidyVco `hold`). Only the module knows
// which it is, so the intent is declared on the def's `face.momentary` (UI
// metadata — see ModuleFace; NOT the I/O contract) and module-face-lint fails a
// promoted module that grows an unclassified switch-shaped param.

import { looksLikeToggle } from '$lib/graph/group-controls';
import type { ParamDef } from '$lib/graph/types';

/** The primitive a PARAM cell renders as. */
export type ParamCellKind = 'knob' | 'momentary';

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
 * Which primitive a param cell renders as: a momentary <Button> for a DECLARED
 * press-pad, else the KnobConic every other param keeps. Pure.
 */
export function paramCellKind(paramId: string, momentary: ReadonlySet<string>): ParamCellKind {
  return momentary.has(paramId) ? 'momentary' : 'knob';
}

/** The value a momentary pad writes on press / release. The pad is the same
 *  0/1 press-param the legacy cards write (`strike` high while held; the
 *  worklet fires on its rising edge), so RELEASE returns it to REST — the
 *  def default — and nothing stuck is left behind in the Y.Doc. Pure. */
export function momentaryValue(high: boolean, restValue = 0): number {
  return high ? 1 : restValue;
}
