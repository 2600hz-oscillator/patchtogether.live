// packages/web/src/lib/ui/annotate-mode.svelte.ts
//
// Per-node "Annotate" mode — a PERSONAL view mode that arms an on-card hover
// resolver showing each control / port's AUTHORED docs in an anchored popover.
//
// Deliberately NOT synced to Yjs: annotate is a local lens onto one user's view
// of a live module (like a tooltip you toggle for yourself), not shared rack
// state — a collaborator turning it on must not change what anyone else sees.
// State is a reactive SvelteSet of active nodeIds in a module-level singleton,
// keyed by nodeId, so the per-card AnnotateLayer reads `isActive(nodeId)` and the
// right-click menu calls `toggle(nodeId)`. Cleared for a node when it's deleted.
// SvelteSet (not a plain Set in `$state`) is required so `.add()/.delete()`
// mutations actually notify the reactive readers — a plain Set is only reactive
// on reassignment.

import { SvelteSet } from 'svelte/reactivity';

const active = new SvelteSet<string>();

/** Is annotate mode currently ON for this node? (Reactive.) */
export function isAnnotating(nodeId: string): boolean {
  return active.has(nodeId);
}

/** Toggle annotate mode for one node (the right-click "Annotate" entry). */
export function toggleAnnotate(nodeId: string): void {
  if (active.has(nodeId)) active.delete(nodeId);
  else active.add(nodeId);
}

/** Force annotate mode off for a node (e.g. on node delete / unmount). */
export function clearAnnotate(nodeId: string): void {
  active.delete(nodeId);
}
