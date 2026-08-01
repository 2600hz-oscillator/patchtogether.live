// packages/web/src/lib/ui/modules/dx7/dx7-selection.svelte.ts
//
// WHICH OPERATOR the detail panel is showing — shared between the map and the
// detail panel, which are registered as two INDEPENDENT shell cells and so
// cannot share component state directly.
//
// ⚠ DELIBERATELY NOT IN `node.data`. Selection is a per-viewer VIEW concern:
// putting it in the Y.Doc means a rack-mate clicking OP 5 yanks YOUR detail
// panel to OP 5 mid-edit. It also would not be worth a collab message.
// Keyed by nodeId so two dx7s in one rack keep separate selections.

import { SvelteMap } from 'svelte/reactivity';

const selection = new SvelteMap<string, number>();

/** The selected operator 0..5 for `nodeId` (defaults to op 1). */
export function dx7Selected(nodeId: string): number {
  return selection.get(nodeId) ?? 0;
}

export function dx7Select(nodeId: string, op: number): void {
  if (!Number.isInteger(op) || op < 0 || op > 5) return;
  selection.set(nodeId, op);
}

/** Drop a node's selection — call when the node is removed so the map cannot
 *  leak one entry per spawned-and-deleted dx7 for the life of the session. */
export function dx7ForgetSelection(nodeId: string): void {
  selection.delete(nodeId);
}
