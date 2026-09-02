// packages/web/src/lib/ui/modules/clipplayer/clipplayer-face-selection.svelte.ts
//
// WHICH CLIP the face's piano roll is editing — shared between the LAUNCH
// panel (where you double-click a pad to open it) and the NOTE panel (which
// draws it), which are registered as two INDEPENDENT shell cells and therefore
// cannot share component state directly. The dx7 map/detail precedent
// (`dx7-selection.svelte.ts`), applied to a launcher.
//
// ⚠ DELIBERATELY NOT IN `node.data`, and the spec is explicit about why: the
// card's `cardView` and its clip selection are "personal authoring lenses" —
// syncing them would move a collaborator's screen mid-edit. Keyed by nodeId so
// two clip players in one rack keep separate selections.
//
// ⚠ NODE-KEYED, NOT COMPONENT-STATE, which is the whole point (#1531/#1574/
// #1583): the dock full view and the lane tile mount and unmount around the
// same node constantly, and a selection held in either component would reset
// every time the dock collapsed. It survives unmount because it is not owned
// by a mount.

import { SvelteMap } from 'svelte/reactivity';
import { patch } from '$lib/graph/store';
import { CLIP_COUNT } from '$lib/audio/modules/clip-types';

const selection = new SvelteMap<string, number>();

/** The flat clip index the face's editor is showing for `nodeId` (default 0 —
 *  lane 1, slot 1, the pad a fresh player's eye lands on). */
export function clipplayerSelectedClip(nodeId: string): number {
  return selection.get(nodeId) ?? 0;
}

/** Open a clip in the face's editor. Out-of-range indices are IGNORED rather
 *  than clamped: a clamp would silently open a DIFFERENT clip than the one the
 *  caller named, which on a launcher is an edit landing in the wrong lane. */
export function clipplayerSelectClip(nodeId: string, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= CLIP_COUNT) return;
  selection.set(nodeId, index);
  pruneDeletedNodes();
}

/** Drop selections for nodes that no longer exist.
 *
 * ⚠ IT RUNS ON WRITE RATHER THAN BEING EXPORTED FOR A CALLER TO REMEMBER, and
 * that is deliberate: the sibling `dx7ForgetSelection` has been exported since
 * it was written and has NEVER been called anywhere in the tree, so dx7's map
 * grows one entry per spawned-and-deleted node for the life of the session.
 * An unwired cleanup export is a leak wearing a tidy name. Selecting is the
 * only event that can grow this map, so it is also the only place that needs
 * to bound it. */
function pruneDeletedNodes(): void {
  for (const id of selection.keys()) {
    if (!patch.nodes[id]) selection.delete(id);
  }
}
