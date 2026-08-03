// packages/web/src/lib/audio/momentary-params.ts
//
// A PRESS IS NOT STATE — the one rule, and the one place it is enforced.
//
// A `face.momentary` param is a PAD: the user's finger, live, right now. It has
// the identical ParamDef shape as a latching switch (`0..1 discrete, default 0`
// — tomtom `strike` vs kickdrum `hard`), which is exactly why the intent has to
// be DECLARED (shell-control-kind.ts). What was never enforced anywhere is the
// consequence of that declaration: **a pad has no saved value**, because a
// finger is not something a rack can be saved holding.
//
// ⚠ THE BUG THIS CLOSES, and it is a data-integrity bug, not a UI one.
// Both press pads in the repo wrote the pressed value into the Y.DOC
// (`setNodeParam`) and relied on the RELEASE writing rest back. The release is
// not guaranteed: pointer capture protects a moving pointer, not a DELETED
// element, so unmounting the card mid-hold (close the dock, delete the module,
// hide the tab, navigate away) leaves the pressed value durable. It then:
//
//   * PERSISTS — it is an ordinary param, so it rides the save envelope and
//     syncs to every peer;
//   * SURVIVES RELOAD — the factory seeds AudioParams from `node.params`;
//   * and on tomtom it is worse than cosmetic. The worklet ORs the pad with
//     the jack as LEVELS (`max(trigger_in, strike)`, packages/dsp/src/tomtom.ts),
//     so a stuck 1 holds the combined trigger permanently high and the
//     rising-edge detector never fires again: **`trigger_in` is masked
//     forever.** A rack can be saved into a state where an external sequencer
//     can never play the drum. tidyVco's `hold` is the same class with the
//     opposite symptom — the voice drones on load and nothing stops it.
//
// Nothing caught it: `contract-lock` reads the def (the def is fine), the
// faces-parity sweep presses the pad and asserts it is enabled, and the
// sibling ENGINE-side audition seam (manual-strike-actions.ts) is leak-proof
// by construction — it writes no param at all — so the discipline existed
// right next door and the param path simply never adopted it. A shell comment
// even asserted the opposite: *"Because the release always writes REST back,
// nothing latched survives in the Y.Doc."*
//
// THE FIX IS TWO-SIDED, and both sides are needed:
//   * NEW presses never become durable — the press path writes the ENGINE only
//     (manual-strike-actions.ts `setMomentaryParam`), latched against the same
//     window-level panic listeners the held audition already uses.
//   * ALREADY-SAVED racks are repaired — this module. `restedParams` is applied
//     at spawn (AudioEngine.addNode) so a persisted press NEVER reaches a
//     factory, whatever route the rack arrived by: file load, multiplayer
//     join, duplicate, page reload or an audio restart. A rack saved with
//     `strike: 1` is playable again on the next load with no migration step
//     and no user action.
//
// PURE — no store, no engine, no DOM — so every branch is unit-testable, and
// the engine can call it without importing UI.

/** The shape this module needs from a module def: params + the face's declared
 *  momentary list. Structural on purpose, so audio and video defs (and a test
 *  fixture) all satisfy it without importing a registry. */
export interface MomentaryDefLike {
  params?: readonly { id: string; defaultValue: number }[];
  face?: { momentary?: readonly string[] };
}

/**
 * The declared press-pad ids for a def that are also REAL params, as a set.
 * Filtering against `params` matters: `face.momentary` is hand-maintained UI
 * metadata, and a stale id there must not invent a param that does not exist.
 */
export function momentaryIds(def: MomentaryDefLike | undefined): ReadonlySet<string> {
  const declared = def?.face?.momentary;
  if (!declared || declared.length === 0) return EMPTY;
  const real = new Set((def?.params ?? []).map((p) => p.id));
  return new Set(declared.filter((id) => real.has(id)));
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * A param's REST value — where a pad sits when nobody is touching it. That is
 * the def's own `defaultValue`, not a hardcoded 0: the rest position is the
 * module's to declare, and `momentaryValue(high, pd.defaultValue)` on the
 * render side already reads it that way. Undeclared params rest at 0.
 */
export function momentaryRest(def: MomentaryDefLike | undefined, paramId: string): number {
  return (def?.params ?? []).find((p) => p.id === paramId)?.defaultValue ?? 0;
}

/**
 * Which of this node's params are a press-pad PERSISTED AWAY FROM REST — i.e.
 * the stuck ones. Empty for every module that declares no momentary param,
 * which is all but two of them, so the common path allocates nothing.
 *
 * Reported as a list rather than a boolean because the caller wants to SAY
 * what it repaired: a silent repair of a data-integrity bug is indistinguishable
 * from no bug, and that is how this survived.
 */
export function stuckMomentaryIds(
  def: MomentaryDefLike | undefined,
  params: Readonly<Record<string, number>> | undefined,
): string[] {
  const ids = momentaryIds(def);
  if (ids.size === 0 || !params) return [];
  const out: string[] = [];
  for (const id of ids) {
    const v = params[id];
    if (typeof v === 'number' && v !== momentaryRest(def, id)) out.push(id);
  }
  return out;
}

/**
 * The node's params with every declared press-pad forced back to REST.
 *
 * Returns the ORIGINAL object by identity when nothing is stuck — so the
 * overwhelmingly common case (no momentary params, or none pressed) costs one
 * set lookup and no allocation, and a caller can cheaply tell "unchanged" from
 * "repaired" with `===`.
 */
export function restedParams(
  def: MomentaryDefLike | undefined,
  params: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  const stuck = stuckMomentaryIds(def, params);
  if (stuck.length === 0) return params;
  const next: Record<string, number> = { ...(params as Record<string, number>) };
  for (const id of stuck) next[id] = momentaryRest(def, id);
  return next;
}
