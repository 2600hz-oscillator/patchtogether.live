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

/** An axis-aligned footprint in flow-space px. */
export interface RackRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** True iff two axis-aligned rects overlap (touching edges do NOT count). */
export function rectsOverlap(a: RackRect, b: RackRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Find the rack slot to lock a card into so it NEVER sits on top of another
 * module. Start at `snapped` (already grid-snapped). If a card of `size` placed
 * there doesn't overlap any `others`, lock there. Otherwise search outward in
 * `unit`-step rings and return the FREE position with the smallest displacement
 * from `snapped` — "move it whichever direction needs the least relocation".
 *
 * Pure (no DOM/Yjs) so it's unit-testable; the caller supplies the locking
 * card's footprint + every other card's rect (in the same flow-space).
 *
 * Search order guarantees nearest-first: candidates are visited by increasing
 * Chebyshev ring (every flow slot exactly once), and the first ring that yields
 * any free slot necessarily contains the Euclidean-nearest one (ring-r's min
 * Euclidean distance `r` exceeds ring-(r-1)'s max `(r-1)·√2` for r ≥ 1, so no
 * later ring can beat an earlier ring's hit). Within that ring we pick the
 * smallest Euclidean displacement, preferring straight axis moves over diagonals.
 */
export function findFreeRackSlot(
  snapped: { x: number; y: number },
  size: { w: number; h: number },
  others: readonly RackRect[],
  unit: number = RACK_UNIT,
): { x: number; y: number } {
  const fits = (x: number, y: number): boolean =>
    !others.some((o) => rectsOverlap({ x, y, w: size.w, h: size.h }, o));

  if (fits(snapped.x, snapped.y)) return { x: snapped.x, y: snapped.y };

  const MAX_RING = 64; // 64 × 180px ≈ 11.5k px of search — far beyond any rack
  for (let r = 1; r <= MAX_RING; r++) {
    let best: { x: number; y: number; d: number } | null = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter only
        const x = snapped.x + dx * unit;
        const y = snapped.y + dy * unit;
        if (!fits(x, y)) continue;
        const d = dx * dx + dy * dy; // squared Euclidean (monotonic ⇒ no sqrt)
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (best) return { x: best.x, y: best.y };
  }
  // Pathological (rack impossibly dense) — lock at the snapped spot anyway.
  return { x: snapped.x, y: snapped.y };
}
