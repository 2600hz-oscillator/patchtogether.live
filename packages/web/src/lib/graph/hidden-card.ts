// packages/web/src/lib/graph/hidden-card.ts
//
// WORKFLOW MODE P4 — the `hiddenCard` node-data flag: a CANVAS-LEVEL
// "render no card" marker for graph nodes whose face lives in a workflow
// topbar menu instead of on the canvas (today: the camera manager's
// headless CAMERA instances).
//
// hiddenCard vs pinned (graph/workflow-pins.ts):
//   - `pinned` marks the ALWAYS-ON singletons: auto-ensured, UNDELETABLE
//     (removePatchNode refuses them), excluded from `maxInstances`.
//   - `hiddenCard` is ONLY a presentation flag: the node is user-created,
//     user-DELETABLE via the standard remove path, and COUNTS toward its
//     def's `maxInstances` cap like any ordinary instance. The one thing
//     it changes is rendering: Canvas's flowNodes derivation skips it (and
//     its touching edges), exactly like a pinned node.
//
// The flag lives at `node.data.hiddenCard` — the platform's documented
// home for cross-cutting per-node keys (`name`, `controlColor`, `pinned`,
// `rackLocked`) — NOT a def field, so no def (and no WebGL-attest basis
// file) changes when a type gains a headless presentation. Because it's
// node DATA it syncs to collaborators (who also see no card) and
// round-trips every persistence path (quicksave slots, .set files, .ptperf
// zips, raw JSON) with zero extra plumbing.
//
// PURE + framework-free (no Svelte, no Yjs) so the canvas-visibility
// decision is unit-testable against plain fixtures.

import { isPinnedNode, type PinnedNodeLike } from './workflow-pins';

/** Minimal node shape the visibility predicates inspect. */
export interface HiddenCardNodeLike {
  type: string;
  data?: { pinned?: unknown; hiddenCard?: unknown } | null;
}

/** True when the node carries the `hiddenCard` presentation flag (a
 *  headless instance whose face is a workflow topbar menu). */
export function isHiddenCardNode(node: HiddenCardNodeLike | null | undefined): boolean {
  return node?.data?.hiddenCard === true;
}

/**
 * The SINGLE canvas-visibility rule: should this node render NO canvas
 * card (and none of its touching cables)? True for pinned always-on
 * singletons (P1/P2) and for hiddenCard headless instances (P4). Canvas's
 * flowNodes derivation and its defensive edge filter both call this, so
 * the two hide mechanisms can never drift apart.
 */
export function isCanvasHiddenNode(node: HiddenCardNodeLike | null | undefined): boolean {
  return isPinnedNode(node as PinnedNodeLike | null | undefined) || isHiddenCardNode(node);
}
