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
  surfaceFitOn,
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

// ── ⚠ THE PARAM IS THE ONE SOURCE FOR `surfaceCount` AND `showGrid` ─────────
//
// Both used to be written TWICE — once onto `node.data` and once onto the param
// — and the FACTORY preferred the `node.data` mirror. That is invisible while
// the only writers are the card and the MAP editor, which write both. It stops
// being invisible the moment a generic faceplate cell exists, because every
// shell param cell writes the PARAM ALONE: on any node that had ever been
// touched the mirror would win and the faceplate's controls would be inert,
// with every def-reading gate green.
//
// So the mirror is gone in both directions: nothing writes it, and every reader
// (the factory, the card, the MAP editor, the map exporter) reads the param.
// ⚠ Behaviour-preserving for every saved rack — the `setNodeParam` call has sat
// beside the `node.data` write since this seam was created (ea2504939) and in
// `MappyCard.svelte` before it existed (614052097), so no rack this build can
// load holds a pair that disagrees. A stale `node.data.surfaceCount` /
// `.showGrid` left in an old rack is now simply unread.

/** Read the live surface-count (param `surfaceCount`), defaulting to 1. */
export function getSurfaceCount(node: ModuleNode | undefined): number {
  const c = node?.params?.surfaceCount;
  return typeof c === 'number' ? clampSurfaceCount(c) : DEFAULT_SURFACE_COUNT;
}

/** Read the live GRID override (param `showGrid`, a 0/1 two-state). */
export function getShowGrid(node: ModuleNode | undefined): boolean {
  const v = node?.params?.showGrid;
  return typeof v === 'number' ? v >= 0.5 : false;
}

/** Set the live surface-count (1..6). */
export function setSurfaceCount(id: string, n: number): void {
  const t = patch.nodes[id];
  if (!t) return;
  setNodeParam(id, 'surfaceCount', clampSurfaceCount(n));
}

/**
 * Set the count to an ABSOLUTE value by repeated add/remove — the write the
 * faceplate's `surfaceCount` cell commits through (`SHELL_PARAM_WRITES`).
 *
 * ⚠ A PLAIN `setNodeParam` HERE WOULD BE A DIFFERENT CONTROL FROM THE CARD'S
 * `+`. `addSurface` does one thing besides raising the number: a newly-live
 * surface still sitting at the untouched full-frame default drops in as
 * `insetQuadForIndex` — a staggered box you can see and grab. Writing the param
 * directly would make every added surface a full-frame duplicate stacked
 * exactly on the one below it, i.e. a control that appears to do nothing. The
 * shape of the write matters, not just the number, which is what the override
 * registry is for.
 *
 * Idempotent, and clamped by `addSurface`/`removeSurface` themselves, so a
 * segmented jump (1 → 5) and a dial drag both land on the same state.
 */
export function setSurfaceCountTo(id: string, n: number): number {
  const target = clampSurfaceCount(n);
  let cur = getSurfaceCount(patch.nodes[id] as ModuleNode | undefined);
  // Bounded by MAPPY_SURFACE_COUNT either way; the guard is belt for a store
  // that refuses a write (a detached node) rather than a real loop risk.
  for (let i = 0; i < MAPPY_SURFACE_COUNT && cur < target; i++) cur = addSurface(id);
  for (let i = 0; i < MAPPY_SURFACE_COUNT && cur > target; i++) cur = removeSurface(id);
  return cur;
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

/** Reset one surface's corners to full-frame. FIT is left untouched (a
 *  geometry reset, not a mode reset). */
export function resetSurface(id: string, surfaceIdx: number): void {
  const arr = ensureSurfaces(id);
  if (!arr) return;
  const s = arr[surfaceIdx];
  if (!s) return;
  s.corners = defaultSurface().corners;
}

/** Read one surface's FIT mode (default ON for old/missing data). */
export function getSurfaceFit(node: ModuleNode | undefined, surfaceIdx: number): boolean {
  const arr = (node?.data as { surfaces?: unknown } | undefined)?.surfaces;
  const s = Array.isArray(arr) ? (arr[surfaceIdx] as { fit?: unknown } | undefined) : undefined;
  return surfaceFitOn(s);
}

/** Set one surface's FIT mode (true = zoom-fit, false = crop/window). Surfaces
 *  are INDEPENDENT — each holds its own `fit`. We write the PRIMITIVE boolean
 *  in place on the live surface object (assigning a primitive field is NOT the
 *  "re-spread a live Y child" trap — that only applies to nested Y types like
 *  the corners array). ensureSurfaces seeds `fit` for every surface, so the
 *  field always exists before we toggle it. */
export function setSurfaceFit(id: string, surfaceIdx: number, fit: boolean): void {
  const arr = ensureSurfaces(id);
  if (!arr) return;
  const s = arr[surfaceIdx];
  if (!s) return;
  s.fit = fit;
}

/** Toggle one surface's FIT mode; returns the NEW value. */
export function toggleSurfaceFit(id: string, surfaceIdx: number): boolean {
  const arr = ensureSurfaces(id);
  if (!arr) return true;
  const s = arr[surfaceIdx];
  if (!s) return true;
  const next = !surfaceFitOn(s);
  s.fit = next;
  return next;
}

/** Apply a whole imported surface LAYOUT (an IMPORTED MAP): REPLACE every
 *  surface's corners + FIT and set the live count, all IN PLACE on the live Y
 *  types (never spread-reassigning an integrated child — corners are rebuilt as
 *  fresh plain arrays, `fit`/`surfaceCount` are primitives). Import REPLACES the
 *  current layout. `layout.surfaces` is the canonical full 6-surface array
 *  (already normalized by applyMap). */
export function applyMapLayout(
  id: string,
  layout: { count: number; surfaces: MappySurfaceState[] },
): void {
  const arr = ensureSurfaces(id);
  if (!arr) return;
  for (let i = 0; i < MAPPY_SURFACE_COUNT; i++) {
    const src = layout.surfaces[i];
    if (!src) continue;
    const s = arr[i];
    if (!s) continue;
    const c = src.corners;
    // fresh plain corner array (SyncedStore arrays reject index-assignment)
    s.corners = [
      [clamp01(c[0]![0]), clamp01(c[0]![1])],
      [clamp01(c[1]![0]), clamp01(c[1]![1])],
      [clamp01(c[2]![0]), clamp01(c[2]![1])],
      [clamp01(c[3]![0]), clamp01(c[3]![1])],
    ];
    s.fit = surfaceFitOn(src);
  }
  setSurfaceCount(id, layout.count);
}

/** Toggle the global GRID override (force the calibration grid on every live
 *  surface). Writes the param, which is what the factory reads. */
export function toggleGrid(id: string, current: boolean): void {
  const t = patch.nodes[id];
  if (!t) return;
  setNodeParam(id, 'showGrid', current ? 0 : 1);
}

/** Set the GRID override to an ABSOLUTE state — the write the faceplate's
 *  `showGrid` Toggle commits through, and the same seam `toggleGrid` uses so a
 *  press on the card and a press on the faceplate cannot diverge. */
export function setShowGrid(id: string, on: boolean): void {
  const t = patch.nodes[id];
  if (!t) return;
  setNodeParam(id, 'showGrid', on ? 1 : 0);
}
