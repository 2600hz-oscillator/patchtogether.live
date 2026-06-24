// mappy-hit.ts — pure pointer hit-testing for MAPPY surface drag, shared by the
// card preview overlay AND the full-window MAP editor. Kept pure (no DOM / no
// Svelte) so the corner-vs-interior decision is exhaustively unit-testable.
//
// Both call sites map a pointer to a uv in [0,1] output space and then ask:
//   1. is it within grab range of one of this surface's 4 CORNERS? → corner-drag
//   2. else, is it INSIDE this surface's quad? → whole-surface move-drag
// (1) wins over (2) so the existing corner-drag is never shadowed by the new
// interior-move — a click on a corner handle still pins that corner.

import type { Vec2 } from '$lib/video/mappy-homography';

export type Corners = readonly [Vec2, Vec2, Vec2, Vec2];

/** Index of the nearest corner within `threshold` uv-distance of `p`, or -1 if
 *  none. Euclidean distance in uv space (the overlay is the engine aspect, so a
 *  uv-radius matches the on-screen handle radius closely enough for grab). */
export function nearestCornerWithin(
  corners: Corners,
  p: Vec2,
  threshold: number,
): number {
  let best = -1;
  let bestD2 = threshold * threshold;
  for (let i = 0; i < 4; i++) {
    const dx = corners[i][0] - p[0];
    const dy = corners[i][1] - p[1];
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

/** Is point `p` inside the (possibly non-convex, possibly self-intersecting)
 *  quad `corners`? Ray-cast / even-odd winding — robust to a concave quad a user
 *  may drag into, and to the corner order (TL,TR,BR,BL). Boundary counts as in.
 */
export function pointInQuad(corners: Corners, p: Vec2): boolean {
  const [px, py] = p;
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = corners[i][0], yi = corners[i][1];
    const xj = corners[j][0], yj = corners[j][1];
    const intersect =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** The result of hit-testing a pointer against a list of surfaces (drawn in
 *  painter order, so the LAST matching surface — the one on top — wins). */
export type SurfaceHit =
  | { kind: 'corner'; surface: number; corner: number }
  | { kind: 'move'; surface: number }
  | null;

/**
 * Decide what a pointer-down at `p` (uv) grabs, given the LIVE surfaces and a
 * per-surface corner-grab `threshold`. Only surfaces flagged live are tested.
 *
 * Priority, matching the user's mental model:
 *   • A corner within grab range of ANY live surface wins outright (so corner
 *     pinning is never lost to interior-move). Among corner hits, the closest
 *     corner across all surfaces is chosen.
 *   • Otherwise, the TOP-MOST (last in painter order) surface whose interior
 *     contains `p` is moved bodily.
 *   • Otherwise null (empty space — caller ignores / starts a marquee, etc.).
 *
 * `selected` is preferred only as a tie-break for equal corner distances so the
 * focused surface stays grabbable in a dense scene.
 */
export function hitTestSurfaces(
  surfaces: readonly { corners: Corners }[],
  live: readonly boolean[],
  p: Vec2,
  threshold: number,
  selected = -1,
): SurfaceHit {
  // 1) closest corner across all live surfaces
  let bestSurface = -1;
  let bestCorner = -1;
  let bestD2 = threshold * threshold;
  for (let s = 0; s < surfaces.length; s++) {
    if (!live[s]) continue;
    const c = surfaces[s].corners;
    for (let i = 0; i < 4; i++) {
      const dx = c[i][0] - p[0];
      const dy = c[i][1] - p[1];
      const d2 = dx * dx + dy * dy;
      // strict-less wins; on a tie prefer the selected surface so the focused
      // surface's handle stays grabbable when two corners overlap.
      if (d2 < bestD2 || (d2 === bestD2 && s === selected)) {
        bestD2 = d2;
        bestSurface = s;
        bestCorner = i;
      }
    }
  }
  if (bestSurface >= 0) {
    return { kind: 'corner', surface: bestSurface, corner: bestCorner };
  }

  // 2) top-most surface whose interior contains p (painter order → iterate back)
  for (let s = surfaces.length - 1; s >= 0; s--) {
    if (!live[s]) continue;
    if (pointInQuad(surfaces[s].corners, p)) {
      return { kind: 'move', surface: s };
    }
  }
  return null;
}
