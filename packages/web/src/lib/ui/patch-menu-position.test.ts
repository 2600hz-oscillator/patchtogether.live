// patch-menu-position.test.ts — unit coverage for the pure edge-align +
// viewport-clamp math, and the lane-rail ADJACENT anchor (P1 dock-UX fix).

import { describe, it, expect } from 'vitest';
import { computeAdjacentRect, computeEdgeAlignedRect, type Rect } from './patch-menu-position';

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

const VP = { width: 1280, height: 800 };

describe('computeEdgeAlignedRect', () => {
  it('right trigger: menu RIGHT edge aligns to card RIGHT edge', () => {
    const card = rect(400, 100, 200, 300); // right = 600
    const menuWidth = 180;
    const { left } = computeEdgeAlignedRect({ cardRect: card, side: 'right', menuWidth, viewport: VP });
    // menu.right should equal card.right (600).
    expect(left + menuWidth).toBe(600);
    expect(left).toBe(420);
  });

  it('right trigger: menu never spills PAST the card right edge', () => {
    const card = rect(400, 100, 200, 300);
    const menuWidth = 180;
    const { left } = computeEdgeAlignedRect({ cardRect: card, side: 'right', menuWidth, viewport: VP });
    expect(left + menuWidth).toBeLessThanOrEqual(card.right + 0.001);
  });

  it('left trigger: menu LEFT edge aligns to card LEFT edge', () => {
    const card = rect(400, 100, 200, 300); // left = 400
    const menuWidth = 180;
    const { left } = computeEdgeAlignedRect({ cardRect: card, side: 'left', menuWidth, viewport: VP });
    expect(left).toBe(400);
  });

  it('left trigger: menu never spills PAST the card left edge', () => {
    const card = rect(400, 100, 200, 300);
    const menuWidth = 180;
    const { left } = computeEdgeAlignedRect({ cardRect: card, side: 'left', menuWidth, viewport: VP });
    expect(left).toBeGreaterThanOrEqual(card.left - 0.001);
  });

  it('opens just below the card top by topOffset', () => {
    const card = rect(400, 100, 200, 300);
    const { top } = computeEdgeAlignedRect({ cardRect: card, side: 'left', menuWidth: 180, viewport: VP });
    expect(top).toBe(128); // 100 + default 28
  });

  it('viewport-clamps a right-aligned menu that would go off the left of screen', () => {
    // Card hugging the left edge; a wide menu right-aligned would push left
    // negative. Clamp keeps left >= margin.
    const card = rect(20, 100, 80, 300); // right = 100
    const menuWidth = 200; // right-aligned: left = 100 - 200 = -100
    const { left } = computeEdgeAlignedRect({ cardRect: card, side: 'right', menuWidth, viewport: VP, margin: 4 });
    expect(left).toBeGreaterThanOrEqual(4);
  });

  it('viewport-clamps a left-aligned menu that would go off the right of screen', () => {
    const card = rect(1200, 100, 60, 300); // left = 1200
    const menuWidth = 200; // left-aligned: left = 1200, right = 1400 > 1280
    const { left } = computeEdgeAlignedRect({ cardRect: card, side: 'left', menuWidth, viewport: VP, margin: 4 });
    expect(left + menuWidth).toBeLessThanOrEqual(VP.width - 4 + 0.001);
  });

  it('clamps the vertical bottom on-screen when menuHeight is provided', () => {
    const card = rect(400, 700, 200, 80); // top 700; menu would extend below 800
    const { top } = computeEdgeAlignedRect({
      cardRect: card,
      side: 'left',
      menuWidth: 180,
      menuHeight: 300,
      viewport: VP,
      margin: 4,
    });
    expect(top + 300).toBeLessThanOrEqual(VP.height - 4 + 0.001);
  });

  it('pins the anchored edge to the viewport side when menu wider than viewport', () => {
    const narrowVp = { width: 200, height: 800 };
    const card = rect(50, 100, 100, 300);
    const menuWidth = 400; // wider than the 200px viewport
    const rightRes = computeEdgeAlignedRect({ cardRect: card, side: 'right', menuWidth, viewport: narrowVp, margin: 4 });
    // Right anchored edge pinned to the viewport right.
    expect(rightRes.left + menuWidth).toBeCloseTo(narrowVp.width - 4, 3);
    const leftRes = computeEdgeAlignedRect({ cardRect: card, side: 'left', menuWidth, viewport: narrowVp, margin: 4 });
    expect(leftRes.left).toBe(4);
  });
});

describe('computeAdjacentRect (lane-rail tiles)', () => {
  it('opens on the tile RIGHT side with the gap, top-aligned', () => {
    const tile = rect(100, 200, 192, 180);
    const { left, top } = computeAdjacentRect({ anchorRect: tile, menuWidth: 280, viewport: VP });
    expect(left).toBe(tile.right + 8);
    expect(top).toBe(tile.top);
  });

  it('FLIPS to the tile LEFT side when the right side would run off-screen', () => {
    const tile = rect(VP.width - 200, 200, 192, 180); // right = 1272
    const { left } = computeAdjacentRect({ anchorRect: tile, menuWidth: 280, viewport: VP });
    // Flipped: menu.right == tile.left - gap.
    expect(left + 280).toBe(tile.left - 8);
    expect(left).toBeGreaterThanOrEqual(4);
  });

  it('stays fully on-screen when NEITHER side fits (full-width anchor)', () => {
    const tile = rect(8, 200, VP.width - 16, 180); // the dock faceplate tile
    const { left, top } = computeAdjacentRect({ anchorRect: tile, menuWidth: 280, viewport: VP });
    expect(left).toBeGreaterThanOrEqual(4);
    expect(left + 280).toBeLessThanOrEqual(VP.width - 4 + 0.001);
    expect(top).toBe(200); // still top-aligned to the anchor
  });

  it('NEVER returns the viewport origin for a degenerate 0×0 anchor', () => {
    // The pre-fix bug class: a display:contents host measured 0×0 at (0,0).
    // Even then the result is a sane on-screen position, not (0,0).
    const zero = rect(0, 0, 0, 0);
    const { left, top } = computeAdjacentRect({ anchorRect: zero, menuWidth: 280, viewport: VP });
    expect(left).toBeGreaterThanOrEqual(4);
    expect(top).toBeGreaterThanOrEqual(4);
  });

  it('clamps the bottom on-screen when menuHeight is provided', () => {
    const tile = rect(100, 700, 192, 180); // near the viewport bottom
    const { top } = computeAdjacentRect({
      anchorRect: tile,
      menuWidth: 280,
      menuHeight: 300,
      viewport: VP,
      margin: 4,
    });
    expect(top + 300).toBeLessThanOrEqual(VP.height - 4 + 0.001);
  });

  it('honours a custom gap', () => {
    const tile = rect(100, 200, 192, 180);
    const { left } = computeAdjacentRect({ anchorRect: tile, menuWidth: 280, viewport: VP, gap: 16 });
    expect(left).toBe(tile.right + 16);
  });
});
