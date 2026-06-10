// patch-menu-position.test.ts — unit coverage for the pure edge-align +
// viewport-clamp math.

import { describe, it, expect } from 'vitest';
import { computeEdgeAlignedRect, type Rect } from './patch-menu-position';

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
