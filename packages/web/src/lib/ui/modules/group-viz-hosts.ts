// packages/web/src/lib/ui/modules/group-viz-hosts.ts
//
// THE ONE REGISTRY of cards `GroupCard` hidden-mounts for a viz-passthrough
// child while the group is COLLAPSED (module-grouping Phase 3B).
//
// WHY IT IS ITS OWN MODULE rather than a `componentForType` local in
// GroupCard.svelte: a SECOND consumer needs the same answer, and a second
// hand-typed copy of it is exactly the drift this repo forbids. Canvas's
// headless-source host (#1721) must NOT keep a collapsed producer's card alive
// when GroupCard is already holding it — that would be two live mounts, two rAF
// loops and two canvases for one node, the same double-mount hazard the dock
// full-view / 'stub' arms of `needsHeadlessSourceMount` already avoid. With one
// registry there is one truth, and a new opt-in is a one-line edit HERE that
// both consumers pick up.
//
// ⚠ MEMBERSHIP IS NARROWER THAN `vizPassthrough`. A def declaring
// `vizPassthrough: true` says "my card's <canvas data-viz-passthrough> MAY be
// portaled into a containing group"; this map says "GroupCard actually knows
// how to mount that card". Today five defs declare the flag (scope + the four
// game modules) and only SCOPE is mounted, so the two are NOT the same set and
// asserting them equal would be wrong. What IS asserted (group-viz-hosts.test.ts,
// both directions): every key here resolves to a real module type whose def
// declares `vizPassthrough`, and the map is exactly what GroupCard renders.

import type { Component } from 'svelte';
import type { NodeProps } from '@xyflow/svelte';
import ScopeCard from './ScopeCard.svelte';

/**
 * child module type → the card component GroupCard mounts (hidden, `display:
 * none`) for it while the group is collapsed. The card's own rAF loop keeps
 * running there, which is why the canvas GroupCard portals out of it stays
 * live — and why that node needs no other host.
 */
export const GROUP_VIZ_HOST_CARDS: Readonly<Record<string, Component<NodeProps>>> = {
  scope: ScopeCard,
};

/**
 * Does GroupCard itself keep this module type's REAL card mounted while its
 * parent group is collapsed?
 *
 * ⚠ SCOPE OF THIS PREDICATE, stated because a caller can easily over-read it:
 * it answers "is there a component to mount", NOT "is a group collapsed around
 * this node right now". The caller owns that half — `true` here is only
 * meaningful inside the collapsed window.
 */
export function groupCardHostsChildCard(type: string): boolean {
  return Object.hasOwn(GROUP_VIZ_HOST_CARDS, type);
}
