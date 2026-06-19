// mappy-edit.ts — store-aware edit helpers for MAPPY surfaces, shared by the
// card overlay AND the full-window MAP editor so the Yjs in-place mutation
// discipline lives in ONE place.
//
// Yjs RULE (see control-surface #566 / repo memory yjs-save-load-real-ydoc):
// NEVER spread-reassign a live Y child. We seed node.data.surfaces ONCE with a
// fresh plain array, then mutate corner elements / surfaceCount IN PLACE.

import { patch } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import {
  MAPPY_SURFACE_COUNT,
  MAPPY_MIN_SURFACES,
  DEFAULT_SURFACE_COUNT,
  normalizeSurfaces,
  defaultSurface,
  insetQuadForIndex,
  clampSurfaceCount,
  type MappySurfaceState,
} from '$lib/video/modules/mappy';
import type { Vec2 } from '$lib/video/mappy-homography';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

type Corners = [Vec2, Vec2, Vec2, Vec2];

/** Read a surface's corners as a fresh PLAIN array (copied out of whatever Y
 *  types back it) — the base for building the replacement on every edit. */
function plainCorners(s: MappySurfaceState): Corners {
  const c = s.corners;
  return [
    [c[0]![0], c[0]![1]],
    [c[1]![0], c[1]![1]],
    [c[2]![0], c[2]![1]],
    [c[3]![0], c[3]![1]],
  ];
}

/** Ensure node.data.surfaces is a fully-populated 6-surface array of live Y
 *  objects, mutating IN PLACE. Returns the live array (or null in tests). */
export function ensureSurfaces(id: string): MappySurfaceState[] | null {
  const t = patch.nodes[id];
  if (!t) return null;
  if (!t.data) t.data = {};
  const d = t.data as { surfaces?: MappySurfaceState[] };
  if (!Array.isArray(d.surfaces) || d.surfaces.length !== MAPPY_SURFACE_COUNT) {
    // First write: seed the canonical normalized array (one assignment of a
    // FRESH array into the Y map — not a re-assignment of a live Y child).
    d.surfaces = normalizeSurfaces(d.surfaces);
  }
  return d.surfaces!;
}

/** Read the live surface-count (node.data.surfaceCount), defaulting to 1. */
export function getSurfaceCount(node: ModuleNode | undefined): number {
  const c = (node?.data as { surfaceCount?: unknown } | undefined)?.surfaceCount;
  return typeof c === 'number' ? clampSurfaceCount(c) : DEFAULT_SURFACE_COUNT;
}

/** Set the live surface-count (1..6), mirrored to the param so it persists. */
export function setSurfaceCount(id: string, n: number): void {
  const t = patch.nodes[id];
  if (!t) return;
  if (!t.data) t.data = {};
  const next = clampSurfaceCount(n);
  (t.data as { surfaceCount?: number }).surfaceCount = next;
  setNodeParam(id, 'surfaceCount', next);
}

/** True if a surface's corners are still the untouched full-frame default. */
function isFullFrame(s: MappySurfaceState | undefined): boolean {
  if (!s) return false;
  const def = defaultSurface().corners;
  return s.corners.every((c, i) => c[0] === def[i]![0] && c[1] === def[i]![1]);
}

/** Add one surface (count+1, max 6). A newly-live surface that is still at the
 *  full-frame default drops in as a staggered inset quad so it's an obviously
 *  distinct, grabbable object; a surface you'd previously shaped keeps its
 *  corners (so −/+ toggling is non-destructive). Returns the new count. */
export function addSurface(id: string): number {
  const arr = ensureSurfaces(id);
  const cur = getSurfaceCount(patch.nodes[id] as ModuleNode | undefined);
  if (cur >= MAPPY_SURFACE_COUNT) return cur;
  const newIndex = cur; // 0-based index of the surface becoming live
  if (arr && isFullFrame(arr[newIndex])) {
    // whole-array reassign (a fresh plain array of primitives — never re-spread
    // a live Y child; SyncedStore arrays reject index-assignment anyway)
    arr[newIndex]!.corners = insetQuadForIndex(newIndex);
  }
  const next = cur + 1;
  setSurfaceCount(id, next);
  return next;
}

/** Remove the last surface (count−1, min 1). Corners are preserved. */
export function removeSurface(id: string): number {
  const cur = getSurfaceCount(patch.nodes[id] as ModuleNode | undefined);
  if (cur <= MAPPY_MIN_SURFACES) return cur;
  const next = cur - 1;
  setSurfaceCount(id, next);
  return next;
}

/** Set one corner of one surface (in [0,1] output uv). Builds a fresh plain
 *  corner array and assigns it (SyncedStore arrays reject index-assignment). */
export function setCorner(id: string, surfaceIdx: number, cornerIdx: number, x: number, y: number): void {
  const arr = ensureSurfaces(id);
  if (!arr) return;
  const s = arr[surfaceIdx];
  if (!s) return;
  const next = plainCorners(s);
  next[cornerIdx] = [clamp01(x), clamp01(y)];
  s.corners = next;
}

/** Translate ALL four corners of a surface by (dx,dy) in uv, clamped so the
 *  whole quad stays on-screen. Used to drag a surface bodily. */
export function moveSurface(id: string, surfaceIdx: number, dx: number, dy: number): void {
  const arr = ensureSurfaces(id);
  if (!arr) return;
  const s = arr[surfaceIdx];
  if (!s) return;
  const cur = plainCorners(s);
  // largest shift that keeps every corner in [0,1]
  let lo = -Infinity, hiX = Infinity, loY = -Infinity, hiY = Infinity;
  for (const c of cur) {
    lo = Math.max(lo, -c[0]);
    hiX = Math.min(hiX, 1 - c[0]);
    loY = Math.max(loY, -c[1]);
    hiY = Math.min(hiY, 1 - c[1]);
  }
  const ddx = Math.max(lo, Math.min(hiX, dx));
  const ddy = Math.max(loY, Math.min(hiY, dy));
  s.corners = [
    [cur[0][0] + ddx, cur[0][1] + ddy],
    [cur[1][0] + ddx, cur[1][1] + ddy],
    [cur[2][0] + ddx, cur[2][1] + ddy],
    [cur[3][0] + ddx, cur[3][1] + ddy],
  ];
}

/** Reset one surface's corners to full-frame. */
export function resetSurface(id: string, surfaceIdx: number): void {
  const arr = ensureSurfaces(id);
  if (!arr) return;
  const s = arr[surfaceIdx];
  if (!s) return;
  s.corners = defaultSurface().corners;
}

/** Toggle the global GRID override (force the calibration grid on every live
 *  surface). Mirrored to the param so it persists + the factory reads it. */
export function toggleGrid(id: string, current: boolean): void {
  const t = patch.nodes[id];
  if (!t) return;
  if (!t.data) t.data = {};
  const next = !current;
  (t.data as { showGrid?: boolean }).showGrid = next;
  setNodeParam(id, 'showGrid', next ? 1 : 0);
}
