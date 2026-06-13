// packages/web/src/lib/ui/rack-grid.ts
//
// Rack GRID geometry (virtual-rack Phase 2). One square grid tile = the
// `--rack-unit` (180px) — the same tile Phase-1 sizing snaps every card's box
// to (see _module-card.css + rack-sizes.ts). This module owns the PURE math for
// snapping a node's free-floating position onto that grid when it's locked
// ("screwed down") to a rack slot.
//
// Keeping the snap math pure (no Svelte / no Yjs) lets it be unit-tested in
// isolation and reused by both the lock action (Canvas.svelte) and any future
// rack-aware layout code. The Canvas owns the SIDE EFFECTS (writing the snapped
// position back through the multiplayer-aware position seam); this file only
// computes coordinates.

/** One square rack tile, in flow-space px. Mirrors `--rack-unit` (180px) in
 *  _module-card.css — the unit both card sizing AND the canvas grid snap to. */
export const RACK_UNIT = 180;

/**
 * Snap a single scalar to the nearest multiple of `unit` (default the 180px
 * rack tile). Standard round-half-up at the .5 boundary (`Math.round`), so a
 * value exactly between two grid lines lands on the HIGHER line — matching the
 * dotted overlay the user sees.
 *
 * Negative inputs snap symmetrically (canvas flow-space extends both ways), e.g.
 * `snapToGrid(-100)` → `-180`, `snapToGrid(-80)` → `-0`.
 */
export function snapToGrid(value: number, unit: number = RACK_UNIT): number {
  // `+ 0` normalises the `-0` that Math.round can yield for small negatives, so
  // callers (and tests) compare against a clean `0`.
  return Math.round(value / unit) * unit + 0;
}

/**
 * Snap an {x, y} position onto the rack grid — both axes to the nearest 180px
 * line. Because the grid is uniform in Y, a 1u module dropped into a 3u (540px)
 * slot naturally lands on the slot's top/middle/bottom third with no special
 * casing — that "1u-in-3u-slot" behaviour falls out of snapping Y to every
 * 180px line (Phase-2 spec §3).
 */
export function snapPositionToGrid(
  pos: { x: number; y: number },
  unit: number = RACK_UNIT,
): { x: number; y: number } {
  return { x: snapToGrid(pos.x, unit), y: snapToGrid(pos.y, unit) };
}
