// packages/web/src/lib/ui/workflow/face-tab-request.svelte.ts
//
// WHICH TAB of a tabbed dock faceplate is open, per NODE — and the seam a
// module's own surface uses to NAVIGATE the rail.
//
// ⚠ WHY THIS EXISTS AT ALL. `DockFullView` held the requested tab in a local
// `$state`, which answers "the player clicked a rail chip" and nothing else. A
// tabbed face whose own content performs a navigation — the clip player's
// double-click-a-pad-to-edit-it, the legacy card's gesture verbatim — has no
// way to reach that state: the pad lives inside `ModuleShell` inside a panel
// cell, several component boundaries below the rail, and the shell deliberately
// imports nothing from a module's extension (`module-shell-import-guard`). A
// registry keyed by nodeId is the seam both ends can already reach, and it is
// the same shape the dx7 operator selection and the clip player's own clip
// selection use.
//
// ⚠ NODE-KEYED, NOT COMPONENT STATE, and that is a fix rather than a side
// effect (#1531/#1574/#1583). The dock pane mounts and unmounts every time the
// full view is closed and re-opened, so the local `$state` reset the face to
// its first tab each time. The legacy card's `cardView` survives for as long as
// the node is on the canvas, because the card stays mounted — so a node-keyed
// request is the FAITHFUL behaviour here, not merely the convenient one.
//
// ⚠ AND IT IS NEVER SYNCED. Which page of a faceplate you are reading is a
// personal authoring lens: putting it in `node.data` would move a
// collaborator's screen mid-edit and dirty the patch with a view setting. Same
// argument, in the same words, as `clipplayer-face-selection.svelte.ts`.
//
// The VALUE is only a REQUEST: `activeDockTab` resolves it against the live tab
// roster and falls back to the first tab when the id no longer exists, so a
// re-paged module can never leave a node pointing at a band that is gone.

import { SvelteMap } from 'svelte/reactivity';
import { patch } from '$lib/graph/store';

const requested = new SvelteMap<string, string>();

/** The dock band id this node's faceplate should open on, or undefined for
 *  "whatever the roster's first tab is". */
export function faceTabRequest(nodeId: string): string | undefined {
  return requested.get(nodeId);
}

/** Open `pageId` on this node's dock faceplate. A no-op on an untabbed face —
 *  the request is simply never read, because `dockTabPlan` returned null and
 *  every band is visible anyway. */
export function requestFaceTab(nodeId: string, pageId: string): void {
  requested.set(nodeId, pageId);
  pruneDeletedNodes();
}

/** Drop requests for nodes that no longer exist.
 *
 * ⚠ IT RUNS ON WRITE rather than being exported for a caller to remember — the
 * `clipplayer-face-selection` argument, verbatim: an unwired cleanup export is
 * a leak wearing a tidy name (dx7's `dx7ForgetSelection` has never been called
 * anywhere in the tree). Requesting is the only event that can grow this map,
 * so it is also the only place that needs to bound it. */
function pruneDeletedNodes(): void {
  for (const id of requested.keys()) {
    if (!patch.nodes[id]) requested.delete(id);
  }
}
