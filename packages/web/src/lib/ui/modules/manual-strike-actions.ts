// packages/web/src/lib/ui/modules/manual-strike-actions.ts
//
// THE AUDITION SEAM — "hit it once" — as ONE implementation for every
// externally-struck voice in the rack.
//
// An externally-struck voice has no internal exciter: with nothing patched
// into its trigger input it is SILENT, on the legacy card and in the RACKLINE
// dock alike. kickdrum, karplus, sixstrum and samsloop all answer the SAME
// engine read key with a one-shot firing function, so the host side of
// "audition it" is not per-module behaviour — it is one function and a nodeId.
//
// ⚠ THIS FILE WAS `kickdrum-strike-actions.ts` (renamed by the karplus face
// PR). It was already generic — the key, the resolver and the wiring never
// mentioned kickdrum — so the choice karplus faced was a second copy of a
// 20-line resolver or a rename. Renamed. NOTHING about the behaviour moved:
// same key, same three branches, same return contract, same call sites.
//
// The strike is NOT a param. It writes nothing to the graph — no value moves,
// nothing is persisted, nothing is shared with the rackspace, nothing lands in
// the undo stack — it fires a host-side ConstantSource summed into the SAME
// worklet trigger input a cable feeds (each module's factory), through the
// engine handle's `manualTrigger` read key. So the audible effect is identical
// to a patched sequencer gate, and a real cable on the trigger input keeps
// working while you use it.
//
// SPLIT DELIBERATELY IN TWO:
//   * `resolveManualStrike` is PURE over its injected engine + node — no
//     store, no globals, no DOM — so the interesting half (which of the ways
//     this can be unavailable actually returns null) is unit-testable without
//     a browser or an AudioContext;
//   * `fireManualStrike` is the thin process-wide wiring the shell cells and
//     the card buttons both call.
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

/** The read key a struck voice's factory answers with a one-shot firing. */
export const MANUAL_STRIKE_KEY = 'manualTrigger';

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
  const fn = engine.read(node, MANUAL_STRIKE_KEY);
  return typeof fn === 'function' ? (fn as () => void) : null;
}

/**
 * Fire ONE strike at the live node — the action both surfaces call (a module's
 * shell `action` cell and its legacy card's audition button). Silently does
 * nothing when the audition is unavailable (see resolveManualStrike). Returns
 * whether a strike actually fired, so a caller can drive a press flash off the
 * truth instead of off the click.
 */
export function fireManualStrike(nodeId: string): boolean {
  const node = patch.nodes[nodeId] as ModuleNode | undefined;
  const strike = resolveManualStrike(getActiveEngine(), node);
  if (!strike) return false;
  strike();
  return true;
}
