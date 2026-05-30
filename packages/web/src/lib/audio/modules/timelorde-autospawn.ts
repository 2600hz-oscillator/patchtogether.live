// packages/web/src/lib/audio/modules/timelorde-autospawn.ts
//
// TIMELORDE auto-spawn helper.
//
// The promise that timelorde.ts's module-def header makes — "if a rack is
// opened without a TIMELORDE, the auto-spawn path drops one in at a fixed
// position so the rack is always musically coherent" — is implemented here.
// Canvas.svelte's snapshot effect calls shouldAutoSpawnTimelorde(snapshot)
// and, if true, adds a TIMELORDE via the same Yjs transact path the palette
// uses (so multiplayer + reconciler see it identically).
//
// Idempotency / multiplayer safety:
//   - The predicate is a pure "does any node in the snapshot have
//     type='timelorde'?" check. Two clients racing the spawn both observe
//     the same snapshot before either's write lands; the second client's
//     write is rejected by TIMELORDE's maxInstances=1 cap (enforced inside
//     the engine + the palette + the per-spawn check the caller does).
//     Worst case: both clients write a node, Y.Doc merges them, and one
//     gets garbage-collected on the next snapshot — the user just sees
//     one TIMELORDE. The double-write is harmless.
//   - The helper takes a list of node-shaped values rather than the live
//     Y.Doc so callers can pass either the snapshot bus output or a
//     hand-built test fixture. Pure, no I/O, runs in vitest without any
//     setup.
//
// Default position:
//   - Top-left of the visible viewport, nudged in 24px so the card sits
//     comfortably under the canvas controls instead of being clipped by
//     the topbar / palette. The card is `undeletable: true` so users
//     rarely move it; if they DO want it elsewhere, drag works normally.
//   - Callers without a viewport (e.g. unit tests, mid-boot effects) get
//     the fallback default (24, 24) — same coordinates, just expressed
//     as constants rather than viewport-relative.

/** Minimal node shape this helper inspects. Defined here so the helper
 *  doesn't transitively pull in the whole graph/types tree — keeps the
 *  unit tests honest about what's actually being read. */
export interface NodeLike {
  type: string;
}

/** Returns true iff the snapshot contains no TIMELORDE node. */
export function shouldAutoSpawnTimelorde(nodes: ReadonlyArray<NodeLike>): boolean {
  for (const n of nodes) {
    if (n.type === 'timelorde') return false;
  }
  return true;
}

/** Viewport extent in flow-space coordinates (the same coordinate system
 *  ModuleNode.position uses). When provided, the auto-spawn pins TIMELORDE
 *  to the user's CURRENT view rather than a flow-space (0,0) that may be
 *  miles offscreen after panning. */
export interface ViewportRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/** Pixels in from the top + left of the visible viewport. Keeps the card
 *  away from the topbar (which overlaps the canvas's top edge) without
 *  pushing it so far in that it overlaps the user's existing patches. */
const VIEWPORT_INSET_PX = 24;

/** Fallback for callers with no viewport. Matches VIEWPORT_INSET_PX so the
 *  visual result is the same in both code paths when the viewport is at
 *  origin (the boot state). */
const FALLBACK_POSITION = { x: VIEWPORT_INSET_PX, y: VIEWPORT_INSET_PX } as const;

/** Picks a sensible default position for an auto-spawned TIMELORDE. */
export function pickTimelordeDefaultPosition(
  viewport?: ViewportRect | null,
): { x: number; y: number } {
  if (!viewport || !Number.isFinite(viewport.originX) || !Number.isFinite(viewport.originY)) {
    return { ...FALLBACK_POSITION };
  }
  return {
    x: viewport.originX + VIEWPORT_INSET_PX,
    y: viewport.originY + VIEWPORT_INSET_PX,
  };
}
