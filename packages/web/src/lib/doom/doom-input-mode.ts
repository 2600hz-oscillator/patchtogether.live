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

import { CV_GATE_PORT_IDS } from './doomkeys';

/** Minimal edge shape this predicate needs (subset of graph Edge). */
export interface IncomingEdgeLike {
  target: { nodeId: string; portId: string };
}

const CV_GATE_PORT_ID_SET: ReadonlySet<string> = new Set(CV_GATE_PORT_IDS);

/**
 * True iff ANY edge in `edges` targets one of `nodeId`'s CV-gate input
 * ports (up/down/left/right/space/ctrl/alt). When true, the DOOM card
 * MUST ignore the keyboard (CV drives movement); when false, the keyboard
 * path runs.
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
    if (CV_GATE_PORT_ID_SET.has(e.target.portId)) return true;
  }
  return false;
}
