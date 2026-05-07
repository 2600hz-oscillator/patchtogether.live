// Organize-modules layout pass.
//
// Decluttering pass for the canvas: take the current set of module bounding
// boxes and nudge any pair that overlaps until none do, while preserving the
// user's overall arrangement. The bounding box of the whole layout may grow
// (xyflow pans/zooms freely), but a node never teleports — moves are local,
// so a left-to-right signal flow stays left-to-right.
//
// Algorithm (chosen for "preserve layout, just declutter"):
//   1. Sort boxes by id (stable, deterministic) so two clients with identical
//      input always produce identical output.
//   2. Iterate pairwise. For each overlapping pair, compute the smaller of the
//      X and Y overlap; push them apart along that axis (less disruptive than
//      pushing along the larger axis). Each box moves by half the overlap +
//      half the configured gap, in opposite directions.
//   3. Repeat until a full pass finds no overlaps OR maxIterations is hit
//      (worst-case polynomial; in practice 2–4 passes suffice).
//
// We rejected dagre / elkjs (overshoots — re-flows from scratch, abandons the
// user's hand-placed arrangement) and grid-snap (loses fine vertical grouping
// the user established for related modules).
//
// Pure-data, no DOM, no xyflow — easy to unit test.

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OrganizedPosition {
  id: string;
  x: number;
  y: number;
}

const DEFAULT_MIN_GAP = 16;
const DEFAULT_MAX_ITERATIONS = 64;
const EPSILON = 0.5;

export interface OrganizeOptions {
  /** Minimum spacing between boxes after the pass. */
  minGap?: number;
  /** Safety cap on iterations for pathological inputs. */
  maxIterations?: number;
}

/**
 * Resolve overlaps in a set of bounding boxes by pushing overlapping pairs
 * apart along their axis of smaller overlap. Returns the new positions for
 * every input box (always returned, even when unchanged).
 *
 * Stable: identical input produces identical output across runs.
 * Order-preserving: result array is sorted by id.
 */
export function organizeLayout(
  boxes: readonly Box[],
  options: OrganizeOptions = {},
): OrganizedPosition[] {
  const minGap = options.minGap ?? DEFAULT_MIN_GAP;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const work = boxes
    .map((b) => ({ ...b }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (work.length < 2) {
    return work.map((b) => ({ id: b.id, x: b.x, y: b.y }));
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    let movedThisPass = false;
    for (let i = 0; i < work.length; i++) {
      for (let j = i + 1; j < work.length; j++) {
        const a = work[i];
        const b = work[j];
        const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (xOverlap <= -minGap + EPSILON || yOverlap <= -minGap + EPSILON) continue;
        if (xOverlap <= EPSILON && yOverlap <= EPSILON) continue;

        const aCenterX = a.x + a.w / 2;
        const aCenterY = a.y + a.h / 2;
        const bCenterX = b.x + b.w / 2;
        const bCenterY = b.y + b.h / 2;

        const pushX = xOverlap + minGap;
        const pushY = yOverlap + minGap;

        if (pushX <= pushY) {
          const half = pushX / 2;
          if (aCenterX <= bCenterX) {
            a.x -= half;
            b.x += half;
          } else {
            a.x += half;
            b.x -= half;
          }
        } else {
          const half = pushY / 2;
          if (aCenterY <= bCenterY) {
            a.y -= half;
            b.y += half;
          } else {
            a.y += half;
            b.y -= half;
          }
        }
        movedThisPass = true;
      }
    }
    if (!movedThisPass) break;
  }

  return work.map((b) => ({ id: b.id, x: b.x, y: b.y }));
}

/**
 * Returns true iff no two boxes overlap (after applying the new positions).
 * Helper for tests + an in-app post-condition check.
 */
export function hasNoOverlaps(
  boxes: readonly Box[],
  positions: readonly OrganizedPosition[],
): boolean {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const placed = boxes.map((b) => {
    const p = byId.get(b.id);
    return { id: b.id, x: p?.x ?? b.x, y: p?.y ?? b.y, w: b.w, h: b.h };
  });
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (xOverlap > EPSILON && yOverlap > EPSILON) return false;
    }
  }
  return true;
}

export const ORGANIZE_DEFAULTS = Object.freeze({
  minGap: DEFAULT_MIN_GAP,
  maxIterations: DEFAULT_MAX_ITERATIONS,
});
