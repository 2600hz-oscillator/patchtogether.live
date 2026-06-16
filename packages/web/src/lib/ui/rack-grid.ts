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

/** One rack U, in flow-space px (the VERTICAL pitch). Mirrors `--rack-unit`
 *  (180px) in _module-card.css — the row height cards snap to vertically. */
export const RACK_UNIT = 180;

/** Like a real rack, U matters only VERTICALLY; the HORIZONTAL plane locks to a
 *  finer "HP" pitch. We define 1u = 8hp → 8 horizontal lock positions per 1u of
 *  width. (Module widths becoming exact even-HP multiples is a follow-up UI
 *  pass; this file only governs WHERE a card's left edge locks.) */
export const HP_PER_U = 8;
/** Horizontal lock pitch in flow-space px: 180 / 8 = 22.5px. */
export const HP_UNIT = RACK_UNIT / HP_PER_U;

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
 * Snap an {x, y} position onto the rack grid — ANISOTROPIC like a real rack:
 * X locks to the HP pitch (22.5px → 8 positions per 1u), Y locks to the U row
 * (180px). Snapping Y to every U line makes a 1u card land on a third of a 3u
 * slot for free (no special-casing). The defaults are the production pitches;
 * pass explicit units in tests.
 */
export function snapPositionToGrid(
  pos: { x: number; y: number },
  xUnit: number = HP_UNIT,
  yUnit: number = RACK_UNIT,
): { x: number; y: number } {
  return { x: snapToGrid(pos.x, xUnit), y: snapToGrid(pos.y, yUnit) };
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
 * there doesn't overlap any `others`, lock there. Otherwise search outward —
 * HORIZONTALLY in HP steps (22.5px), VERTICALLY in U steps (180px), like a real
 * rack — and return the FREE position with the smallest REAL-PX displacement
 * from `snapped` ("move it whichever direction needs the least relocation").
 * Because an HP step (22.5px) is far cheaper than a U step (180px), a clashing
 * card slides along its row to the nearest free HP before it ever jumps a row.
 *
 * Pure (no DOM/Yjs) so it's unit-testable; the caller supplies the locking
 * card's footprint + every other card's rect (in the same flow-space). The unit
 * defaults are the production pitches; tests may pass explicit units.
 */
export function findFreeRackSlot(
  snapped: { x: number; y: number },
  size: { w: number; h: number },
  others: readonly RackRect[],
  xUnit: number = HP_UNIT,
  yUnit: number = RACK_UNIT,
): { x: number; y: number } {
  const fits = (x: number, y: number): boolean =>
    !others.some((o) => rectsOverlap({ x, y, w: size.w, h: size.h }, o));

  if (fits(snapped.x, snapped.y)) return { x: snapped.x, y: snapped.y };

  // Anisotropic bounded scan: HP columns out to ~MAX_HP, U rows out to ~MAX_U.
  // Track the FREE candidate with the smallest squared real-px displacement
  // (monotonic ⇒ no sqrt); this yields the true Euclidean-nearest free slot.
  const MAX_HP = 200; // 200 × 22.5px = 4500px of horizontal search
  const MAX_U = 24; //   24 × 180px  = 4320px of vertical search
  let best: { x: number; y: number; d: number } | null = null;
  for (let ix = -MAX_HP; ix <= MAX_HP; ix++) {
    const dx = ix * xUnit;
    const dx2 = dx * dx;
    // Once even this column's pure-horizontal distance can't beat `best`, no
    // cell in it can — skip the whole column.
    if (best && dx2 >= best.d) continue;
    for (let iy = -MAX_U; iy <= MAX_U; iy++) {
      if (ix === 0 && iy === 0) continue;
      const dy = iy * yUnit;
      const d = dx2 + dy * dy;
      if (best && d >= best.d) continue;
      const x = snapped.x + dx;
      const y = snapped.y + dy;
      if (!fits(x, y)) continue;
      best = { x, y, d };
    }
  }
  // Pathological (rack impossibly dense) — lock at the snapped spot anyway.
  return best ? { x: best.x, y: best.y } : { x: snapped.x, y: snapped.y };
}
