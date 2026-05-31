// packages/web/src/lib/ui/example-patches/media-burn-math.ts
//
// Pure layout math for the MEDIA BURN demo patch. Two helpers, both
// node-testable:
//
//   tileGridPosition(row, col, cardW, cardH, baseX?, baseY?)
//     -> flow-space top-left for the (row, col) PICTUREBOX tile.
//
//   cadillacStartX(rightmostTileXR, cadillacWidth, secondsUntilHit, speedPxPerSec)
//     -> the flow-space x coord to bake into the CADILLAC node's
//        `position.x` so the car's LEFT edge crosses `rightmostTileXR`
//        exactly `secondsUntilHit` seconds after spawn.
//
// Why cadillacWidth is a parameter even though the math doesn't use it:
// see the doc comment on cadillacStartX. (Spoiler: it's there so the
// signature is self-describing if anyone later moves to a "right edge of
// car kisses left edge of tile" hit definition; today the call site
// passes it through as a sanity-checked positional, and we assert it's
// positive so a 0/negative gets caught early.)
//
// Coordinate system: flow-space, same as CadillacOverlay + collision.ts.
// The car's `position.x` is its LEFT edge. Motion is R->L:
//
//     xFlow(t) = startX - speedPxPerSec * (t - spawnedAtMs)/1000
//
// "Hit" means the car's bounding box first overlaps the tile, which —
// because the car approaches from the right and `tile.x + tileW` is the
// tile's right edge — happens when the car's LEFT edge equals the tile's
// RIGHT edge. So:
//
//     startX - speed * secondsUntilHit = xR
//     startX = xR + speed * secondsUntilHit                                  (1)

export interface TilePos {
  x: number;
  y: number;
}

/**
 * Top-left flow-space coord for tile at (row, col). Adjacent tiles
 * are flush — each tile sits exactly cardW to the right of its left
 * neighbour and exactly cardH below its top neighbour (no gap, no
 * overlap), so the rendered mosaic recreates the source image.
 */
export function tileGridPosition(
  row: number,
  col: number,
  cardW: number,
  cardH: number,
  baseX = 0,
  baseY = 0,
): TilePos {
  return {
    x: baseX + col * cardW,
    y: baseY + row * cardH,
  };
}

/**
 * Right edge of the rightmost tile in a grid anchored at (baseX, baseY)
 * with `cols` columns of width `cardW` each.
 */
export function rightmostTileRightX(
  baseX: number,
  cols: number,
  cardW: number,
): number {
  return baseX + cols * cardW;
}

/**
 * Bottom edge of the bottommost tile, plus the vertical center of the
 * grid. Helpful for placing the cadillac so it ploughs through the
 * middle row.
 */
export function gridVerticalCenter(
  baseY: number,
  rows: number,
  cardH: number,
): number {
  return baseY + (rows * cardH) / 2;
}

/**
 * Compute the flow-space x to bake into a CADILLAC node's `position.x`
 * so that, given the overlay's deterministic constant-velocity drive
 * (R->L at `speedPxPerSec`), the car's LEFT edge reaches `rightmostTileXR`
 * exactly `secondsUntilHit` seconds after spawn — i.e. the moment of
 * first contact with the rightmost tile.
 *
 * Per equation (1) in this file's header: `startX = xR + speed * t`.
 * `cadillacWidth` does NOT enter the calculation today because hit is
 * defined as car-left-edge crossing tile-right-edge (R->L motion); it is
 * accepted as a parameter for two reasons:
 *
 *   1. Self-documenting call sites: every reader instantly sees that
 *      the helper KNOWS about CAR_W, so they don't have to chase its
 *      source.
 *   2. Defensive guard: a 0 or negative width is almost certainly a bug
 *      at the call site; we surface it loudly here.
 *
 * Throws on non-finite / non-positive inputs that would silently produce
 * absurd start positions.
 */
export function cadillacStartX(
  rightmostTileXR: number,
  cadillacWidth: number,
  secondsUntilHit: number,
  speedPxPerSec: number,
): number {
  if (!Number.isFinite(rightmostTileXR)) {
    throw new Error(`rightmostTileXR must be finite, got ${rightmostTileXR}`);
  }
  if (!(cadillacWidth > 0) || !Number.isFinite(cadillacWidth)) {
    throw new Error(`cadillacWidth must be positive finite, got ${cadillacWidth}`);
  }
  if (!(secondsUntilHit >= 0) || !Number.isFinite(secondsUntilHit)) {
    throw new Error(`secondsUntilHit must be >= 0 finite, got ${secondsUntilHit}`);
  }
  if (!(speedPxPerSec > 0) || !Number.isFinite(speedPxPerSec)) {
    throw new Error(`speedPxPerSec must be positive finite, got ${speedPxPerSec}`);
  }
  return rightmostTileXR + speedPxPerSec * secondsUntilHit;
}

// -- Constants shared by builder + test. Kept here so the unit test
//    asserts the same numbers the envelope builder bakes in.
export const MEDIA_BURN_LAYOUT = {
  ROWS: 3,
  COLS: 5,
  /** PictureboxCard.svelte: width=220px, min-height=240px. Using min-height
   *  as cardH guarantees flush vertical neighbours even before the card
   *  has any image-loaded growth. */
  CARD_W: 220,
  CARD_H: 240,
  BASE_X: 0,
  BASE_Y: 0,
} as const;

export const CADILLAC = {
  /** From CadillacOverlay.svelte (CAR_W). */
  WIDTH: 375,
  /** From CadillacOverlay.svelte (SPEED_PX_PER_SEC). */
  SPEED_PX_PER_SEC: 300,
  /** Demo intent: 1 full second of "the car is roaring up to the TVs"
   *  beat before the wreckage begins. */
  SECONDS_UNTIL_FIRST_HIT: 1,
} as const;
