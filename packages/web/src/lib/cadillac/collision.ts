// packages/web/src/lib/cadillac/collision.ts
//
// Pure collision + position math for CADILLAC. Zero DOM access: every
// function takes plain inputs (positions, bounds, time) and returns
// plain outputs. Easy to unit-test, easy to reason about determinism
// (every client computes the same answer for the same inputs).
//
// Coordinate system: flow-space. The overlay component is responsible
// for converting flow-space points to screen-space via xyflow's
// `flowToScreenPosition`. We compute *where* the car is in flow-space
// from spawn time, then translate that to screen-space when drawing.

export interface Vec2 {
  x: number;
  y: number;
}

export interface AABB {
  /** Top-left in flow-space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OtherNode {
  id: string;
  position: Vec2;
  /** Measured size in flow-space — usually pulled from
   *  xyflow's getInternalNode(id).measured. May be undefined briefly
   *  right after spawn before xyflow has measured the new card. */
  width?: number;
  height?: number;
}

/**
 * Constant left-ward motion. The car starts at `startX` (right edge of
 * the viewport at spawn time, baked into the node's flow-space x) and
 * subtracts `speedPxPerSec * elapsed` to get the current flow-space x.
 *
 * Strictly monotonic-decreasing in `now`. Always negative slope.
 */
export function currentX(
  now: number,
  spawnedAtMs: number,
  speedPxPerSec: number,
  startX: number,
): number {
  const dtSec = Math.max(0, (now - spawnedAtMs) / 1000);
  return startX - speedPxPerSec * dtSec;
}

/**
 * Find the leftmost x-edge among all "other" (deletable) nodes — used
 * by `selfDestructX` to decide when the car has driven past the last
 * surviving module.
 *
 * Excludes the car itself (so it doesn't chase its own ghost) and any
 * node ids in `skipIds` (in practice: nodes flagged undeletable +
 * already-deleted-this-frame).
 *
 * Returns `null` when there are no other nodes — the caller uses the
 * wall-clock fallback in that case.
 */
export function leftmostOtherX(
  nodes: OtherNode[],
  cadillacId: string,
  skipIds: ReadonlySet<string> = new Set(),
): number | null {
  let leftmost: number | null = null;
  for (const n of nodes) {
    if (n.id === cadillacId) continue;
    if (skipIds.has(n.id)) continue;
    if (leftmost === null || n.position.x < leftmost) leftmost = n.position.x;
  }
  return leftmost;
}

/**
 * Plain AABB overlap. Returns the ids of every `other` whose box
 * intersects the car's box. Nodes missing measured width/height are
 * skipped (xyflow hasn't measured yet → don't kill).
 */
export function hits(car: AABB, others: OtherNode[]): string[] {
  const out: string[] = [];
  const carRight = car.x + car.width;
  const carBottom = car.y + car.height;
  for (const o of others) {
    if (o.width === undefined || o.height === undefined) continue;
    const oRight = o.position.x + o.width;
    const oBottom = o.position.y + o.height;
    const overlap =
      car.x < oRight &&
      carRight > o.position.x &&
      car.y < oBottom &&
      carBottom > o.position.y;
    if (overlap) out.push(o.id);
  }
  return out;
}

/**
 * Decide when the car should self-destruct.
 *
 * - If there's a `leftmost` (other modules still on-canvas), the car
 *   self-destructs once its x has driven `pastPx` (default 200) PAST
 *   that leftmost edge. This gives a moment of dramatic over-shoot
 *   before the car disappears.
 * - If `leftmost` is null (no other modules — either none were ever
 *   spawned, or the car ate them all), the car self-destructs after
 *   `fallbackMs` of elapsed wall-clock (default 8000 ms).
 *
 * Returns whether the car should be removed THIS tick.
 */
export function shouldSelfDestruct(opts: {
  now: number;
  spawnedAtMs: number;
  currentCarX: number;
  leftmost: number | null;
  fallbackMs?: number;
  pastPx?: number;
}): boolean {
  const fallbackMs = opts.fallbackMs ?? 8000;
  const pastPx = opts.pastPx ?? 200;
  if (opts.leftmost === null) {
    return opts.now - opts.spawnedAtMs >= fallbackMs;
  }
  return opts.currentCarX <= opts.leftmost - pastPx;
}
