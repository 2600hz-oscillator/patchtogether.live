// packages/web/src/lib/doom/doom-input-mode.ts
//
// Pure predicate for DOOM's input-mode switch (owner-approved
// simplification): a DOOM node is driven by EITHER its CV-gate jacks OR
// the keyboard, never both.
//
//   patched (any cv-gate input has an incoming edge) ⇒ CV-only;
//                                                        keyboard inert.
//   unpatched (no cv-gate input has an edge)          ⇒ keyboard-only.
//
// Lives in its own file because it's pure + trivially unit-testable
// without mounting the (heavy, multiplayer-bound) DoomCard component. The
// card imports `isCvGatePatched` and gates its keyboard-capture on it.

import { parseSlotPortId } from './doomkeys';

/** Minimal edge shape this predicate needs (subset of graph Edge). */
export interface IncomingEdgeLike {
  target: { nodeId: string; portId: string };
}

/**
 * True iff ANY edge in `edges` targets one of `nodeId`'s per-slot CV-gate input
 * ports (p1_up … p4_alt). When true SOMEWHERE on the node, CV is in play —
 * callers that care about a SPECIFIC viewer's slot should use
 * `isOwnSlotCvGatePatched`. Kept for the node-wide check.
 *
 * `edges` is the graph's edge collection — accepts the live record
 * (Object.values) or any iterable of edge-likes, so callers can pass
 * `Object.values(patch.edges)` directly.
 */
export function isCvGatePatched(
  edges: Iterable<IncomingEdgeLike | undefined | null>,
  nodeId: string,
): boolean {
  for (const e of edges) {
    if (!e) continue;
    if (e.target.nodeId !== nodeId) continue;
    if (parseSlotPortId(e.target.portId)) return true;
  }
  return false;
}

/**
 * Per-slot variant (#353): true iff any edge targets `nodeId`'s OWN-SLOT CV-gate
 * group (p{slot+1}_*). This is the keyboard-vs-CV precedence rule applied PER
 * SLOT: if YOUR own slot's group has a CV edge, your keyboard is inert for your
 * slot; another slot's CV must NOT gate your keyboard. A spectator (slot null)
 * is never CV-patched (it owns no group).
 */
export function isOwnSlotCvGatePatched(
  edges: Iterable<IncomingEdgeLike | undefined | null>,
  nodeId: string,
  slot: number | null,
): boolean {
  if (slot === null) return false;
  for (const e of edges) {
    if (!e) continue;
    if (e.target.nodeId !== nodeId) continue;
    const parsed = parseSlotPortId(e.target.portId);
    if (parsed && parsed.slot === slot) return true;
  }
  return false;
}
