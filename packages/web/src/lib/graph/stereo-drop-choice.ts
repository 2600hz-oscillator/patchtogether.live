// packages/web/src/lib/graph/stereo-drop-choice.ts
//
// THE WIDTH-MISMATCH CHOOSER — "you dropped a mono source on a stereo jack;
// which hole did you mean?" — pure, framework-free.
//
// OWNER SPEC (2026-08-12), which SUPERSEDES the silent double-patch:
//
//   "whenever we drop a mono source on a stereo jack or a stereo source on a
//    mono jack, is that we prompt a quick dialog asking which of the 2 or both
//    L/R to connect to, and then in the case of stereo → mono ask which channel
//    we want. that's the right way to fix that and it's never really been specd"
//
//   | source → target   | the user is asked                                  |
//   |-------------------|----------------------------------------------------|
//   | mono   → stereo   | L, R, or BOTH                                      |
//   | stereo → mono     | which channel — L or R (there is no BOTH)          |
//
// The two rows that are NOT ambiguous are not asked about: stereo → stereo is
// L→L / R→R and mono → mono is one leg. Nothing to choose, so no dialog.
//
// ⚠ WHAT THIS REPLACED. `planAudioCommit`'s matrix wrote both of the ambiguous
// rows silently — mono → stereo DOUBLE-PATCHED the one output into both target
// legs, and stereo → mono sent BOTH legs into the one mono input (dual-mono,
// owner 2026-08-07). The owner has replaced BOTH with "ask". There is no
// preference toggle and no surviving silent path: the planner still knows how
// to write every one of those shapes — `channelMode` is unchanged and is what
// this module drives — but on a USER GESTURE the mode now comes from a person
// instead of from a default.
//
// ⚠ AND IT IS THE DESTRUCTIVE-DROP FIX. Dropping a second source on an already
// patched stereo jack used to evict both legs of the live cable with no
// notice — leg-level occupancy is correct policy (Q4) and was simply invisible.
// Every option carries the exact `replaceEdgeIds` IT would evict, read off the
// SAME `planAudioCommit` call that would commit it, so the dialog can say what
// each choice costs before the user makes it. That the numbers agree with the
// commit is a property of them being the same computation, not of two lists
// being kept in step.
//
// PURITY — no Svelte, no Yjs, no registry, no label resolution. It answers in
// PORT IDS; the caller renders them. Same rule as `stereo-autowire`, which it
// is the decision layer above.

import {
  planAudioCommit,
  type ChannelMode,
  type PlanAudioCommitArgs,
} from './stereo-autowire';
import { wiringPairForPort } from './stereo-pairs';

/** Which side of the drop carries the stereo image the user must resolve. */
export type DropChoiceKind = 'mono-to-stereo' | 'stereo-to-mono';

/** One row of the chooser — a `channelMode` plus everything the row must say
 *  about itself. Every field is READ OFF THE PLAN that mode would commit, so a
 *  row cannot describe a patch different from the one it makes. */
export interface DropChoiceOption {
  mode: ChannelMode;
  /** The INPUT port ids this option writes to (LEFT before RIGHT). */
  toPortIds: string[];
  /** The OUTPUT port ids this option reads from (LEFT before RIGHT). */
  fromPortIds: string[];
  /** Live edge ids this option would DELETE. Empty = it destroys nothing. */
  replaceEdgeIds: string[];
}

export interface DropChoice {
  kind: DropChoiceKind;
  /** The stereo side's two port ids — the pair that makes the drop ambiguous.
   *  For `mono-to-stereo` these are TARGET inputs; for `stereo-to-mono` they
   *  are SOURCE outputs. */
  pair: { left: string; right: string };
  /** The rows, in display order: L, R, then BOTH where BOTH is offered. */
  options: DropChoiceOption[];
  /** TRUE when ANY option would evict a live edge — the "this jack is already
   *  patched" headline. Derived from the options, never counted separately. */
  destroys: boolean;
}

/**
 * The order the rows render. L and R first because they are the question being
 * asked; BOTH last because it is the answer that declines to choose a side.
 */
const MONO_TO_STEREO_MODES: readonly ChannelMode[] = ['left', 'right', 'both'];
const STEREO_TO_MONO_MODES: readonly ChannelMode[] = ['left', 'right'];

/**
 * Does this drop need to ask, and if so what are the choices?
 *
 * Returns `null` when the drop is unambiguous and must commit silently — which
 * is every case except the two rows above, INCLUDING:
 *
 *   * stereo → stereo and mono → mono (nothing to choose);
 *   * any non-audio cable — `wiringPairForPort` is audio-typed-ports-only by
 *     construction, so a cv `strength_l`/`strength_r` drop resolves no pair and
 *     falls out here with no special case;
 *   * an endpoint whose def the caller could not resolve (a group exposed
 *     port). Undefined ⇒ unpaired ⇒ no question, which is the safe direction:
 *     the commit does exactly what it did before rather than prompting about a
 *     pair nobody can name.
 *
 * ⚠ AND when fewer than two options survive. An option is only real if it
 * actually commits something, so each mode is PLANNED and a mode that yields no
 * legs is dropped (a pair whose sibling port is missing or type-incompatible —
 * `planAudioCommit` refuses to invent it). A one-option "choice" is not a
 * choice; the caller commits it the ordinary way. This is also why the options
 * are built by calling the real planner rather than by reasoning about the
 * matrix: a row that cannot be committed must not be offered.
 *
 * `args.channelMode` is IGNORED — this function's whole job is to decide it.
 */
export function planDropChoice(args: PlanAudioCommitArgs): DropChoice | null {
  const srcPair = args.fromDef
    ? wiringPairForPort(args.fromDef, args.fromPortId, 'output')
    : null;
  const dstPair = args.toDef ? wiringPairForPort(args.toDef, args.toPortId, 'input') : null;

  // Both paired, or neither — the matrix answers it and no human is needed.
  if (!!srcPair === !!dstPair) return null;

  const kind: DropChoiceKind = dstPair ? 'mono-to-stereo' : 'stereo-to-mono';
  const pairSide = (dstPair ?? srcPair)!;
  const modes = kind === 'mono-to-stereo' ? MONO_TO_STEREO_MODES : STEREO_TO_MONO_MODES;

  const options: DropChoiceOption[] = [];
  for (const mode of modes) {
    const plan = planAudioCommit({ ...args, channelMode: mode });
    if (plan.legs.length === 0) continue;
    options.push({
      mode,
      // `plan.legs` is already LEFT-before-RIGHT; dedupe preserves that order
      // and collapses the dual-mono case where both legs share one input port.
      toPortIds: [...new Set(plan.legs.map((l) => l.toPortId))],
      fromPortIds: [...new Set(plan.legs.map((l) => l.fromPortId))],
      replaceEdgeIds: plan.replaceEdgeIds,
    });
  }
  if (options.length < 2) return null;

  return {
    kind,
    pair: { left: pairSide.left, right: pairSide.right },
    options,
    destroys: options.some((o) => o.replaceEdgeIds.length > 0),
  };
}

/**
 * The option for one mode, or undefined.
 *
 * The commit path re-plans from `mode` rather than replaying a stored plan, so
 * this exists for the UI and for tests — never as the thing that decides what
 * gets written. (A stored plan is a snapshot of an edge set that may have moved
 * under a collaborator's edit between the dialog opening and the user picking.)
 */
export function dropChoiceOption(
  choice: DropChoice,
  mode: ChannelMode,
): DropChoiceOption | undefined {
  return choice.options.find((o) => o.mode === mode);
}
