// packages/web/src/lib/ui/example-patches/media-burn-math.test.ts
//
// Pin the layout + 1-second-to-hit math for the MEDIA BURN demo patch.
// Keeps the envelope builder + the CadillacOverlay's overlay-side math
// in lock-step. If either side drifts (e.g. CAR_W changes, speed
// changes) one of these assertions will fail and force a deliberate
// reconciliation.

import { describe, expect, it } from 'vitest';
import {
  cadillacStartX,
  rightmostTileRightX,
  tileGridPosition,
  CADILLAC,
  MEDIA_BURN_LAYOUT,
} from './media-burn-math';

describe('tileGridPosition', () => {
  it('top-left tile sits at the base origin', () => {
    expect(tileGridPosition(0, 0, 220, 240)).toEqual({ x: 0, y: 0 });
  });

  it('5x3 grid: bottom-right tile is at (4*220, 2*240)', () => {
    expect(tileGridPosition(2, 4, 220, 240)).toEqual({ x: 880, y: 480 });
  });

  it('respects a non-zero base offset', () => {
    expect(tileGridPosition(1, 2, 220, 240, 100, 50)).toEqual({
      x: 100 + 2 * 220,
      y: 50 + 1 * 240,
    });
  });
});

describe('rightmostTileRightX', () => {
  it('with the demo layout it is 1100', () => {
    expect(
      rightmostTileRightX(
        MEDIA_BURN_LAYOUT.BASE_X,
        MEDIA_BURN_LAYOUT.COLS,
        MEDIA_BURN_LAYOUT.CARD_W,
      ),
    ).toBe(1100);
  });
});

describe('cadillacStartX', () => {
  // Four pinned cases — each isolates a different axis. If any drifts,
  // the demo's "1s to first hit" beat breaks.

  it('xR=0, 1s @ 300 px/s -> 300 (the canonical units case)', () => {
    // car-LEFT crosses xR=0 at t=1s when startX=300. Width is irrelevant
    // to the math but must be > 0; we pass the real CAR_W.
    expect(cadillacStartX(0, 375, 1, 300)).toBe(300);
  });

  it('the MEDIA BURN demo: xR=1100, 1s @ 300 -> 1400', () => {
    expect(
      cadillacStartX(
        rightmostTileRightX(
          MEDIA_BURN_LAYOUT.BASE_X,
          MEDIA_BURN_LAYOUT.COLS,
          MEDIA_BURN_LAYOUT.CARD_W,
        ),
        CADILLAC.WIDTH,
        CADILLAC.SECONDS_UNTIL_FIRST_HIT,
        CADILLAC.SPEED_PX_PER_SEC,
      ),
    ).toBe(1400);
  });

  it('xR=500, 2s @ 300 -> 1100 (longer wind-up)', () => {
    expect(cadillacStartX(500, 375, 2, 300)).toBe(1100);
  });

  it('xR=500, 1s @ 600 -> 1100 (double speed, same wind-up)', () => {
    // Demonstrates the linearity in speed: doubling speed at fixed t
    // doubles the distance the car has to start back from.
    expect(cadillacStartX(500, 375, 1, 600)).toBe(1100);
  });

  it('rejects 0/negative width as a likely call-site bug', () => {
    expect(() => cadillacStartX(0, 0, 1, 300)).toThrow(/cadillacWidth/);
    expect(() => cadillacStartX(0, -1, 1, 300)).toThrow(/cadillacWidth/);
  });

  it('rejects 0/negative speed', () => {
    expect(() => cadillacStartX(0, 375, 1, 0)).toThrow(/speedPxPerSec/);
    expect(() => cadillacStartX(0, 375, 1, -300)).toThrow(/speedPxPerSec/);
  });
});
