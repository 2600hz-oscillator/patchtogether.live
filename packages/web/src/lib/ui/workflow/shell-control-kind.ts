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

import { looksLikeToggle } from '$lib/graph/exposable-controls';
import type { ParamDef } from '$lib/graph/types';

/** The primitive a PARAM cell renders as. */
export type ParamCellKind =
  | 'knob'
  | 'momentary'
  | 'toggle'
  | 'segmented'
  | 'selector'
  | 'grid'
  | 'color'
  | 'hue'
  | 'fader'
  // ⚠ `neon-fader` WAS A SECOND NAME FOR THIS KIND AND IS GONE (#1794). It
  // existed only for the transition: #1738 introduced `NeonFader.svelte`
  // while `Fader.svelte` was still mounted by ~90 cards whose baselines could
  // not move for one face's look, so a module opted into the new throw one
  // declaration at a time. `Fader.svelte` is deleted, `fader` IS the neon
  // throw, and a def that still declares `'neon-fader'` no longer typechecks.
  | 'xy';

/**
 * The primitives a module must DECLARE (`face.paramCells`) because no property
 * of the ParamDef can imply them. Both are discrete integer params; what
 * distinguishes them is what the integers MEAN, which is knowledge only the
 * module has:
 *
 *   'grid'  — the states are PICTURES (dx7's 32 algorithm topologies).
 *   'color' — the integer is a PACKED 0xRRGGBB, not a position on a scale
 *             (wavesculpt's `red_color`/`grn_color`/`blu_color`).
 *   'hue'   — the scalar is an ANGLE ON THE COLOUR WHEEL, and it WRAPS
 *             (spirographs' `chroma`). See the note below: it is a different
 *             kind from `color`, not a variant of it.
 *   'fader' — the param is a LEVEL the player expects to see as a THROW, not a
 *             dial. Nothing in a ParamDef distinguishes "level" from any other
 *             continuous scalar, so it can only be declared.
 *
 * ⚠ 'hue' IS NOT 'color', AND THE DIFFERENCE IS THE PARAM'S SHAPE. `color` is
 * DISCRETE over the packed-RGB space (0..0xffffff) and picks an arbitrary
 * sRGB triple; `hue` is CONTINUOUS over 0..1 and picks a position on a ring at
 * full saturation. Handing a 0..1 hue to `ColorField` would clamp a 16.7-million
 * state picker onto two values; handing a packed RGB to the wheel would make one
 * turn sweep the whole 24-bit space. They are declared separately because no
 * property of the ParamDef distinguishes them from a plain scalar, and
 * `module-face-lint` refuses each on the other's shape.
 *
 * ⚠ AND 'hue' IS NOT A KNOB. A hue is CIRCULAR — 0.99 and 0.01 are adjacent
 * reds — so a linear dial puts the cut at an arbitrary place in the middle of a
 * continuous space and makes the player travel the long way round. The wheel is
 * the affordance the module's own legacy card already used.
 *
 * ⚠ 'grid' AND 'color' ARE INDISTINGUISHABLE TO EVERY RESOLVER IN THE REPO,
 * and that is the argument for declaring rather than sniffing. `1..32 discrete`
 * and `0..16777215 discrete` differ only in MAGNITUDE, and no gate reads
 * magnitude — a heuristic here would be a rule about how big a number is
 * allowed to get before it stops being a scale.
 *
 * ⚠ 'fader' IS DECLARED FOR A DIFFERENT REASON: not because it is ambiguous
 * with another primitive, but because the AFFORDANCE IS THE MODULE'S CHOICE.
 * A face has no way to know that a card drew a throw rather than a dial, and
 * silently substituting one for the other is a real regression even though the
 * value semantics are identical — 1-D to 1-D, so unlike a 2-D pad flattened to
 * two knobs no GESTURE is lost, but the control still stops looking like
 * itself. (Owner directive 2026-08-10, prompted by `noise`: its LEVEL is a
 * fader on the card and rendered as a KnobConic on the face.)
 *
 * ⚠ THE OLD VERSION OF THAT SENTENCE PREDICTED `clouds`, `mixer` and `vca`
 * would "hit this the day they are faced". ALL THREE ARE FACED AND NONE
 * DECLARES IT, so the prediction came true and read as a future tense. It is
 * not three modules either: measured 2026-08-12, TWENTY-THREE faced modules
 * rank ONE HUNDRED AND TWENTY-ONE params their cards draw as faders and their
 * faceplates paint as knobs, and `noise` is still the only declarer. Whether
 * to convert them is a LOOK ruling with real cost — `LANE_CELL_H.fader` is 96
 * against a 42 px plate row, so declaring one halves that module's lane plate
 * from six cells to three — and it is with the owner. Recorded here in the
 * past tense so the note cannot read as "not yet" again.
 *
 * ⚠ 'xy' IS DECLARED THROUGH A DIFFERENT FIELD — `face.xyPads`, not
 * `face.paramCells` — because it is the one kind that binds TWO params, and
 * this map is keyed by one id. It appears in this union because it still
 * ARRIVES BY DECLARATION (nothing in a pair of ParamDefs says "these two are
 * one gesture"), and `declaredParamCells` folds it in so every consumer of
 * "which kind did the module declare" keeps one answer to read.
 */
export type DeclaredParamCell = 'grid' | 'color' | 'hue' | 'fader' | 'xy';

/** The subset a module writes in `face.paramCells` — the single-id kinds. `xy`
 *  is absent BY CONSTRUCTION: a pad hand-written here would have no partner,
 *  and a pad with one axis is not a degraded pad, it is a broken one. */
export type AuthoredParamCell = Exclude<DeclaredParamCell, 'xy'>;

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
 * `looksLikeToggle` is the ONE canonical 0/1-switch detector (exposable-controls),
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
 * The param ids whose DOCK cell paints no caption (`face.bareCells`), empty
 * when none. Pure.
 *
 * ⚠ A SET OF IDS, NOT A FLAG ON THE FACE, and the shape is the argument. The
 * rule this serves is "a caption is clutter when a section heading already says
 * it, and load-bearing when it is the only thing separating four identical
 * knobs" (owner, 2026-08-17). That is a per-CONTROL fact — tidyVco's `A`/`D`/
 * `S`/`R` and mixmstrs' `1LO…8LO` sit under equally-labelled cluster headings
 * and only one of the two pairs is redundant — so a per-face or per-tier
 * boolean could not express it without being wrong on one of them.
 */
export function bareCaptionParamIds(
  def: { face?: { bareCells?: readonly string[] } } | undefined,
): ReadonlySet<string> {
  return new Set(def?.face?.bareCells ?? []);
}

/** Shared empty map so the common (undeclared) case allocates nothing. */
const EMPTY_CELLS: ReadonlyMap<string, DeclaredParamCell> = new Map();

/** The declaration fields, for a def-like that only needs them. */
export interface DeclaringDefLike {
  face?: {
    paramCells?: Readonly<Record<string, AuthoredParamCell>>;
    xyPads?: readonly { x: string; y: string; label?: string; surface?: 'band' | 'body' }[];
  };
}

/** The params folded INTO another cell rather than rendering one of their own —
 *  today, exactly the `y` axis of each declared pad. A consumer that walks a
 *  face's controls must drop these or the pad's partner renders twice: once
 *  inside the pad and once as a stray knob beside it. Pure. */
export function foldedParamIds(def: DeclaringDefLike | undefined): ReadonlySet<string> {
  return new Set((def?.face?.xyPads ?? []).map((p) => p.y));
}

/**
 * The param ids painted by the module's OWN `fullViewBody` instead of by a dock
 * band — BOTH axes of every pad declaring `surface: 'body'` (`FaceXyPad`).
 * Empty for every face that declares none, which is all of them but one.
 *
 * ⚠ THE CALLER OWNS THE TIER, AND THIS FUNCTION DELIBERATELY DOES NOT. It
 * answers "which params does the body claim", not "should they be dropped
 * here". The body is dock-only (`dockFullViewHeadPlan`), so the two call sites
 * are both inside the dock branch of `curatedFace` and the lane branch never
 * asks.
 *
 * ⚠ THE LANE IS UNAFFECTED EITHER WAY, and for a reason worth stating because
 * the obvious guess is wrong: `laneOrder` ALREADY drops every declared pad's
 * anchor at every lane tier (a pad is square; a lane knob column is 46 px). So
 * a lane tier that DID ask this function would get the same answer it already
 * has. Keeping the call inside the dock branch is about where the QUESTION
 * belongs, not about protecting the lane from it. Pure.
 */
export function bodyPaintedParamIds(def: DeclaringDefLike | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const pad of def?.face?.xyPads ?? []) {
    if (pad.surface !== 'body') continue;
    out.add(pad.x);
    out.add(pad.y);
  }
  return out;
}

/** The declared pad ANCHORED at each x param id (empty when none). Pure. */
export function xyPadsByAnchor(
  def: DeclaringDefLike | undefined,
): ReadonlyMap<string, { x: string; y: string; label?: string }> {
  return new Map((def?.face?.xyPads ?? []).map((p) => [p.x, p]));
}

/**
 * The param ids a def DECLARES a primitive for (`face.paramCells`), as
 * `id → kind` — empty when none.
 *
 * ⚠ A MAP, NOT A SET PER KIND. It was `gridParamIds(): Set<string>` while
 * `'grid'` was the only declarable primitive, and adding `'color'` beside it
 * would have meant a second parallel getter plus a second positional argument
 * on `paramCellKind` — which is how a resolver ends up with one boolean per
 * primitive and a precedence order nobody can read. One map keeps the
 * declaration surface single-valued BY CONSTRUCTION: a param cannot be
 * declared two primitives at once, because the record cannot hold two values
 * for one key. Pure.
 */
export function declaredParamCells(
  def: DeclaringDefLike | undefined,
): ReadonlyMap<string, DeclaredParamCell> {
  const decl = def?.face?.paramCells;
  const pads = def?.face?.xyPads;
  if (!decl && !pads?.length) return EMPTY_CELLS;
  const out = new Map<string, DeclaredParamCell>(Object.entries(decl ?? {}));
  // A pad's X param anchors an 'xy' cell. Folded in HERE rather than resolved
  // at each call site so "which primitive did the module declare" stays one
  // question with one answer — the same argument the map-not-a-set-per-kind
  // note above makes, one field wider.
  for (const pad of pads ?? []) out.set(pad.x, 'xy');
  return out;
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
 *   grid      — a DECLARED `face.paramCells` entry (PF-15) → <ParamGrid>: a
 *               chip plus a PORTALED, viewport-clamped grid popover. Unlike
 *               every other kind this is TIER-INDEPENDENT — the grid does not
 *               live in the cell's column, so a 32-cell diagram chart is just
 *               as reachable from a 46 px lane knob column as from the dock.
 *               Declared rather than inferred because "these states are
 *               PICTURES" is knowledge only the module has.
 *   color     — a DECLARED `face.paramCells` entry → <ColorField>: a native
 *               colour swatch over a PACKED 0xRRGGBB integer. Also
 *               TIER-INDEPENDENT (a 40 px swatch fits a lane column; a knob
 *               there would be a dial over 16.7 M states, which is the defect
 *               this kind exists for). Declared for the same reason as `grid`
 *               and with less margin: `0..16777215 discrete` is the same SHAPE
 *               as any other discrete param and differs only in magnitude.
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
 * still outranks everything: a press-pad is not a state. The DECLARED cells
 * (`grid`/`color`) sit directly under it — mutually exclusive with `momentary`
 * by face-lint rule, so the ordering is unobservable in a valid face and is
 * fixed here only so an invalid one fails toward the SAFE render (a press-pad
 * that never latches).
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
  declared: ReadonlyMap<string, DeclaredParamCell> = EMPTY_CELLS,
): ParamCellKind {
  if (momentary.has(p.id)) return 'momentary';
  const decl = declared.get(p.id);
  if (decl) return decl;
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
