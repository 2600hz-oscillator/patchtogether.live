// packages/web/src/lib/ui/modules/group-viz-hosts.ts
//
// THE ONE MEMBERSHIP TRUTH for "GroupCard hidden-mounts this child's REAL card
// while the group is COLLAPSED" (module-grouping Phase 3B).
//
// WHY IT EXISTS: a SECOND consumer needs that answer. Canvas's headless-source
// host (#1721) must NOT keep a collapsed producer's card alive when GroupCard is
// already holding it — that would be two live mounts, two rAF loops and two
// canvases for one node, the same double-mount hazard the dock-full-view and
// 'stub' arms of `needsHeadlessSourceMount` already avoid.
//
// ⚠ WHY THIS FILE HOLDS TYPE IDS AND NOT THE COMPONENTS — and why moving the
// components here was a REAL defect, caught by a gate, not a style preference.
//
// The first draft of #1721 put the `type → CardComponent` map here and had
// GroupCard import it. That silently DEMOTED a component edge the
// `dom-source-modules.test.ts` subtree walk depends on. That walk (#1724/#1749)
// follows `.svelte` imports only and STOPS AT `.ts` — a boundary chosen with a
// measurement, because following `.ts` enrols all 195 cards through
// `$lib/video/engine.ts`, which defines `attachExternalSource`. So routing
// `GroupCard → ScopeCard` through a `.ts` module put a live component mount
// inside the walk's own declared blind spot, and the gate said so: its
// `GroupCard → ScopeCard.svelte` exemption went stale ("not in that card's
// subtree") the moment the direct import disappeared.
//
// The blind spot was harmless THAT DAY — the only thing it hid was a false
// positive that was already exempted — but the mechanism is exactly the one
// #1724 was filed for: CUBE shipped black behind a file the walk could not
// reach. And the gate's own SCOPE assertion argues the `.ts` blind spot is safe
// by naming the ONE `.ts` module a card reaches that carries a seam
// (`ui/media/node-media-registry.ts`, node-keyed by construction, which must not
// enrol anything). A `.ts` module that resolves to a MOUNTING COMPONENT is the
// opposite shape and breaks that argument.
//
// So: the COMPONENT stays a direct `.svelte` import in GroupCard, where the walk
// can see it; only the TYPE IDS live here, where both consumers can read them.
// `group-viz-hosts.test.ts` asserts the two agree in BOTH directions, so the
// split cannot drift.
//
// ⚠ MEMBERSHIP IS NARROWER THAN `vizPassthrough`. A def declaring
// `vizPassthrough: true` says "my card's <canvas data-viz-passthrough> MAY be
// portaled into a containing group"; this set says "GroupCard actually mounts
// that card". Defs declare the flag and are NOT mounted (the four game modules —
// #1755), so the two are not the same population and asserting them equal would
// be a false statement about the product.
//
// PURE — a plain string set and one boolean, no Svelte, no DOM, no registry — so
// Canvas can read it without pulling a card component into its import graph, and
// so this file itself can never become a component edge.

/**
 * Child module TYPE IDs whose REAL card `GroupCard` mounts (hidden,
 * `display:none`) for as long as the parent group is COLLAPSED. The card's own
 * rAF loop keeps running there, which is why the canvas GroupCard portals out of
 * it stays live — and why such a node needs no other host.
 *
 * MEASURED (`?shell=legacy` and the default shell, group created collapsed):
 * SCOPE keeps `nonBlack 3072/3072, maxLuma 151` across the collapse with
 * `viz-hidden-mount` count 1, while WAVESCULPT — not a member — went
 * `170/3072 → 0/3072` before #1721 hosted it instead.
 */
export const GROUP_VIZ_HOST_TYPES: ReadonlySet<string> = new Set<string>(['scope']);

/**
 * Does GroupCard itself keep this module type's REAL card mounted while its
 * parent group is collapsed?
 *
 * ⚠ SCOPE OF THIS PREDICATE, stated because a caller can easily over-read it:
 * it answers "would GroupCard mount this type", NOT "is a group collapsed around
 * this node right now". The caller owns that half — `true` here is only
 * meaningful inside the collapsed window.
 */
export function groupCardHostsChildCard(type: string): boolean {
  return GROUP_VIZ_HOST_TYPES.has(type);
}
