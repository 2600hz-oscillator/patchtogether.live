// packages/web/src/lib/audio/dx7-op-role.ts
//
// WHAT JOB DOES THIS OPERATOR DO IN THIS ALGORITHM — carrier, modulator, or
// both — derived from the same `DX7_ALGORITHMS` table the engine routes with,
// so a role colour can never disagree with what you hear.
//
// ⚠ COLOUR IS REINFORCEMENT, NOT THE CUE. Carrier-warm / modulator-cool /
// both-purple is the deuteranopia trap: red-green colour blindness is ~8 % of
// men, and warm-vs-cool is precisely the axis it collapses. The PRIMARY cue is
// `onCarrierRail` — the horizontal rail under the bottom row that every
// carrier drops onto, which makes the output sum literal and is readable with
// no colour vision at all. A renderer that draws only the colour has shipped
// an inaccessible picture; draw the rail first.
//
// WHERE "BOTH" COMES FROM, and the one judgement call in this file:
// an operator is `both` when it is summed to the output AND its output bends
// another operator's phase. The audio-path modulations live in `modSrcs`; the
// feedback loop does NOT, so it is considered here too — but only when it
// crosses operators (`from !== to`). A SELF-loop is an operator re-entering
// its own phase, not a second job, so algorithm 32's op6 (a carrier with a
// self-loop) stays a plain `carrier`. That leaves exactly two `both` cells in
// the shipped table — algorithm 4's op4 and algorithm 6's op5, the two
// multi-operator loops — and the test pins that count so a future table edit
// that grows or loses one is a visible diff rather than a silent recolour.

import { getAlgorithm } from './dx7-algorithms';

export type Dx7OpRoleKind = 'carrier' | 'modulator' | 'both';

export interface Dx7OpRoleInfo {
  /** Operator index 0..5 (op1 = 0). */
  op: number;
  role: Dx7OpRoleKind;
  /**
   * CSS custom property reference (with a built-in fallback) for the role
   * colour. A card uses it directly — `fill={info.colorToken}` — and a theme
   * overrides `--dx7-op-carrier` / `--dx7-op-modulator` / `--dx7-op-both`
   * without this module knowing anything about themes.
   */
  colorToken: string;
  /** Bare custom-property NAME, no `var()` wrapper, for callers that compose
   *  their own fallback chain. */
  colorVar: string;
  /**
   * TRUE when this operator is summed to the audio output — i.e. it sits on
   * the CARRIER RAIL. This is the accessible primary cue; `role` and
   * `colorToken` are the reinforcement. `both` operators are on the rail too.
   */
  onCarrierRail: boolean;
  /** This operator's output feeds the algorithm's feedback memory. */
  feedbackSource: boolean;
  /** The feedback memory modulates this operator's phase. */
  feedbackTarget: boolean;
}

const ROLE_VAR: Record<Dx7OpRoleKind, string> = {
  // Warm = carrier (it is what you hear), cool = modulator (it shapes what you
  // hear), purple = both. Fallbacks are literal so a card renders correctly
  // before any theme is loaded.
  carrier: '--dx7-op-carrier',
  modulator: '--dx7-op-modulator',
  both: '--dx7-op-both',
};

const ROLE_FALLBACK: Record<Dx7OpRoleKind, string> = {
  carrier: '#ffb46b',
  modulator: '#6bc6ff',
  both: '#b386ff',
};

/**
 * The role operator `op` (0..5) plays in algorithm `num` (1..32).
 *
 * Returns `undefined` for an out-of-range algorithm or operator index — a bad
 * stored value must not take a card down.
 */
export function dx7OpRole(num: number, op: number): Dx7OpRoleInfo | undefined {
  if (!Number.isInteger(op) || op < 0 || op > 5) return undefined;
  const algo = getAlgorithm(num);
  if (!algo) return undefined;

  const carries = algo.carriers.includes(op);

  // Does this operator's output bend anybody ELSE's phase?
  let modulates = false;
  for (let to = 0; to < 6; to++) {
    if (to !== op && (algo.modSrcs[to] ?? []).includes(op)) modulates = true;
  }
  const feedbackSource = algo.feedback.from === op;
  const feedbackTarget = algo.feedback.to === op;
  // A cross-operator feedback loop IS a modulation edge — it is only absent
  // from `modSrcs` because the table stores it separately. A self-loop is not.
  if (feedbackSource && algo.feedback.to !== op) modulates = true;

  const role: Dx7OpRoleKind = carries && modulates ? 'both' : carries ? 'carrier' : 'modulator';

  return {
    op,
    role,
    colorVar: ROLE_VAR[role],
    colorToken: `var(${ROLE_VAR[role]}, ${ROLE_FALLBACK[role]})`,
    onCarrierRail: carries,
    feedbackSource,
    feedbackTarget,
  };
}

/** Every operator's role for one algorithm, in operator order. `undefined` for
 *  an out-of-range algorithm number. */
export function dx7OpRoles(num: number): Dx7OpRoleInfo[] | undefined {
  if (!getAlgorithm(num)) return undefined;
  const out: Dx7OpRoleInfo[] = [];
  for (let op = 0; op < 6; op++) out.push(dx7OpRole(num, op)!);
  return out;
}

/** The default role colour for a kind, with no theme override applied — for
 *  contexts that cannot resolve a CSS variable (canvas 2D, an OffscreenCanvas
 *  glyph, a unit test). */
export function dx7RoleFallbackColor(role: Dx7OpRoleKind): string {
  return ROLE_FALLBACK[role];
}
