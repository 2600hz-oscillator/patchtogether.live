// packages/web/src/lib/ui/modules/kickdrum-strike-actions.ts
//
// KICK DRUM's AUDITION — "hit it once" — as ONE shared implementation.
//
// The affordance did not exist on EITHER surface before this module: the
// legacy card has no strike button, and the RACKLINE face had nothing to rank,
// so an unpatched KICK DRUM was silent in the dock while its siblings (tomtom,
// karplus, sixstrum) could all be auditioned. That is the whole reason this
// file exists.
//
// The strike is NOT a param. It writes nothing to the graph — no value moves,
// nothing is persisted, nothing is shared with the rackspace, nothing lands in
// the undo stack — it fires a host-side ConstantSource summed into the SAME
// worklet trigger input a cable feeds (kickdrum.ts's factory), through the
// engine handle's `manualTrigger` read key (the samsloop/karplus seam). So the
// audible effect is identical to a patched sequencer gate, and a real cable on
// trigger_in keeps working while you use it.
//
// SPLIT DELIBERATELY IN TWO:
//   * `resolveManualStrike` is PURE over its injected engine + node — no
//     store, no globals, no DOM — so the interesting half (which of the four
//     ways this can be unavailable actually returns null) is unit-testable
//     without a browser or an AudioContext;
//   * `fireKickdrumStrike` is the thin process-wide wiring the shell cell and
//     the card button both call.
//
// `getActiveEngine()` rather than the Svelte engine CONTEXT, because
// shell-cells.ts specs are plain data called from ModuleShell — they are not
// components and cannot `getContext`. Reading the engine at the moment of the
// click is exactly right: that is when a non-null engine is required.

import { getActiveEngine } from '$lib/audio/engine-ref';
import { patch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';

/** The `read(node, key)` half of a PatchEngine — all this seam needs. */
export interface StrikeEngineLike {
  read(node: ModuleNode, key: string): unknown;
}

/** The read key kickdrum's factory answers with a one-shot trigger firing. */
export const KICKDRUM_STRIKE_KEY = 'manualTrigger';

/**
 * Resolve the node's one-shot strike function, or `null` when the audition is
 * genuinely unavailable. THREE branches, each a real state:
 *   * no engine (the AudioContext has not booted — nothing can sound yet);
 *   * no node (the module was removed between render and click);
 *   * the handle answers the read key with something that is not callable —
 *     a half-implemented seam (a number), or no `read` at all (`undefined`).
 *     ⚠ Those last two are ONE branch, not two: both fall through the same
 *     `typeof fn === 'function'` guard below. The doc used to call them
 *     distinct and the test listed "the FOUR distinct unavailable states",
 *     which reads as more coverage than the code has.
 *
 * Returning null rather than throwing is deliberate: an audition that cannot
 * fire is a no-op, never an error dialog over a rack. PURE — the engine and
 * node are injected, so the resolution is testable with fakes.
 */
export function resolveManualStrike(
  engine: StrikeEngineLike | null | undefined,
  node: ModuleNode | undefined,
): (() => void) | null {
  if (!engine || !node) return null;
  const fn = engine.read(node, KICKDRUM_STRIKE_KEY);
  return typeof fn === 'function' ? (fn as () => void) : null;
}

/**
 * Fire ONE strike at the live node — the action both faces call (the shell's
 * `kickdrum-strike` cell and KickdrumCard's STRIKE button). Silently does
 * nothing when the audition is unavailable (see resolveManualStrike).
 * Returns whether a strike actually fired, so a caller can drive a press flash
 * off the truth instead of off the click.
 */
export function fireKickdrumStrike(nodeId: string): boolean {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const strike = resolveManualStrike(getActiveEngine(), node);
  if (!strike) return false;
  strike();
  return true;
}
