// menu-viewport.test.ts — exhaustive unit suite for the shared PURE
// viewport-clamp helper every context menu positions through.
//
// Invariant under test (owner requirement): for ANY anchor, the returned
// position keeps the ENTIRE menu inside the viewport — flip across the anchor
// on far-edge overflow, clamp as last resort, pin-at-margin when the menu is
// bigger than the viewport (the DOM action adds internal scroll there).

import { describe, expect, it } from 'vitest';
import { clampMenuToViewport } from './menu-viewport';

const VP = { width: 1280, height: 800 };
const MENU = { width: 200, height: 300 };
const M = 6; // default margin

function place(anchor: { x: number; y: number }, over: Partial<Parameters<typeof clampMenuToViewport>[0]> = {}) {
  return clampMenuToViewport({ anchor, menu: MENU, viewport: VP, ...over });
}

/** The whole-menu-in-viewport invariant. */
function expectInViewport(
  pos: { left: number; top: number },
  menu = MENU,
  vp = VP,
  margin = M,
) {
  expect(pos.left).toBeGreaterThanOrEqual(margin);
  expect(pos.top).toBeGreaterThanOrEqual(margin);
  if (menu.width <= vp.width - 2 * margin) {
    expect(pos.left + menu.width).toBeLessThanOrEqual(vp.width - margin);
  }
  if (menu.height <= vp.height - 2 * margin) {
    expect(pos.top + menu.height).toBeLessThanOrEqual(vp.height - margin);
  }
}

describe('clampMenuToViewport — ideal placement', () => {
  it('anchor with room on both axes → menu opens down-right AT the anchor', () => {
    const pos = place({ x: 400, y: 200 });
    expect(pos).toEqual({ left: 400, top: 200 });
  });

  it('exactly fitting at the far edges is NOT moved', () => {
    const pos = place({ x: VP.width - M - MENU.width, y: VP.height - M - MENU.height });
    expect(pos).toEqual({ left: VP.width - M - MENU.width, top: VP.height - M - MENU.height });
  });
});

describe('clampMenuToViewport — the four edges', () => {
  it('RIGHT edge (the owner screenshot case) → flips to open leftward of the anchor', () => {
    const pos = place({ x: VP.width - 10, y: 200 });
    expect(pos.left).toBe(VP.width - 10 - MENU.width); // right edge of menu at anchor
    expect(pos.top).toBe(200);
    expectInViewport(pos);
  });

  it('BOTTOM edge → flips to open upward of the anchor', () => {
    const pos = place({ x: 400, y: VP.height - 10 });
    expect(pos.left).toBe(400);
    expect(pos.top).toBe(VP.height - 10 - MENU.height); // bottom edge at anchor
    expectInViewport(pos);
  });

  it('LEFT edge (anchor left of the margin) → clamps to the margin', () => {
    const pos = place({ x: 2, y: 200 });
    expect(pos).toEqual({ left: M, top: 200 });
    expectInViewport(pos);
  });

  it('TOP edge (anchor above the margin) → clamps to the margin', () => {
    const pos = place({ x: 400, y: -5 });
    expect(pos).toEqual({ left: 400, top: M });
    expectInViewport(pos);
  });
});

describe('clampMenuToViewport — the four corners', () => {
  // Anchors INSIDE the margin band (4px < margin 6px): the flip lands the
  // menu's far edge at the anchor, then the margin clamp trims the last 2px —
  // the menu always keeps the full margin off the edge.
  it('BOTTOM-RIGHT corner → flips BOTH axes (margin kept)', () => {
    const pos = place({ x: VP.width - 4, y: VP.height - 4 });
    expect(pos.left).toBe(VP.width - M - MENU.width);
    expect(pos.top).toBe(VP.height - M - MENU.height);
    expectInViewport(pos);
  });

  it('TOP-RIGHT corner → flips horizontally (margin kept), clamps top', () => {
    const pos = place({ x: VP.width - 4, y: 0 });
    expect(pos.left).toBe(VP.width - M - MENU.width);
    expect(pos.top).toBe(M);
    expectInViewport(pos);
  });

  it('BOTTOM-LEFT corner → clamps left, flips vertically (margin kept)', () => {
    const pos = place({ x: 0, y: VP.height - 4 });
    expect(pos.left).toBe(M);
    expect(pos.top).toBe(VP.height - M - MENU.height);
    expectInViewport(pos);
  });

  it('corner anchors OUTSIDE the margin band flip EXACTLY across the anchor', () => {
    const pos = place({ x: VP.width - 40, y: VP.height - 40 });
    expect(pos.left).toBe(VP.width - 40 - MENU.width);
    expect(pos.top).toBe(VP.height - 40 - MENU.height);
    expectInViewport(pos);
  });

  it('TOP-LEFT corner → clamps both to the margin', () => {
    const pos = place({ x: -20, y: -20 });
    expect(pos).toEqual({ left: M, top: M });
    expectInViewport(pos);
  });
});

describe('clampMenuToViewport — flip fails → clamp as last resort', () => {
  it('anchor past the right edge but too close to the left for a full flip → slides to fit', () => {
    // Menu 200 wide, viewport 220: anchor at 150 overflows right; flipped
    // (150-200 = -50) pokes past the left margin → clamp to hi - size.
    const vp = { width: 220, height: 800 };
    const pos = clampMenuToViewport({ anchor: { x: 150, y: 100 }, menu: MENU, viewport: vp });
    expect(pos.left).toBe(220 - M - MENU.width);
    expectInViewport(pos, MENU, vp);
  });

  it('vertical flip that would poke past the top → slides to fit instead', () => {
    const vp = { width: 1280, height: 320 };
    const pos = clampMenuToViewport({ anchor: { x: 100, y: 250 }, menu: MENU, viewport: vp });
    expect(pos.top).toBe(320 - M - MENU.height);
    expectInViewport(pos, MENU, vp);
  });
});

describe('clampMenuToViewport — menu bigger than the viewport → pin + internal scroll', () => {
  it('wider than the viewport → pins left at the margin', () => {
    const vp = { width: 180, height: 800 };
    const pos = clampMenuToViewport({ anchor: { x: 90, y: 100 }, menu: MENU, viewport: vp });
    expect(pos.left).toBe(M);
    expect(pos.top).toBe(100);
  });

  it('taller than the viewport → pins top at the margin', () => {
    const vp = { width: 1280, height: 200 };
    const pos = clampMenuToViewport({ anchor: { x: 100, y: 150 }, menu: MENU, viewport: vp });
    expect(pos.left).toBe(100);
    expect(pos.top).toBe(M);
  });

  it('bigger than the viewport on BOTH axes → pins to the top-left margin', () => {
    const vp = { width: 100, height: 100 };
    const pos = clampMenuToViewport({ anchor: { x: 50, y: 50 }, menu: MENU, viewport: vp });
    expect(pos).toEqual({ left: M, top: M });
  });
});

describe('clampMenuToViewport — options', () => {
  it('custom margin is respected on clamp and flip decisions', () => {
    const pos = clampMenuToViewport({
      anchor: { x: -50, y: -50 },
      menu: MENU,
      viewport: VP,
      margin: 20,
    });
    expect(pos).toEqual({ left: 20, top: 20 });
  });

  it('flip: false slides (clamps) instead of jumping across the anchor', () => {
    const pos = place({ x: VP.width - 10, y: VP.height - 10 }, { flip: false });
    expect(pos.left).toBe(VP.width - M - MENU.width);
    expect(pos.top).toBe(VP.height - M - MENU.height);
    expectInViewport(pos);
  });

  it('zero-size menu (unmeasured) still lands inside the viewport', () => {
    const pos = clampMenuToViewport({
      anchor: { x: VP.width + 50, y: VP.height + 50 },
      menu: { width: 0, height: 0 },
      viewport: VP,
    });
    expectInViewport(pos, { width: 0, height: 0 });
  });
});

describe('clampMenuToViewport — invariant sweep (every anchor region × sizes)', () => {
  const anchors = [
    { x: -100, y: -100 }, { x: 0, y: 0 }, { x: 640, y: 0 }, { x: 1280, y: 0 },
    { x: 1400, y: -50 }, { x: 0, y: 400 }, { x: 640, y: 400 }, { x: 1280, y: 400 },
    { x: 0, y: 800 }, { x: 640, y: 800 }, { x: 1280, y: 800 }, { x: 1400, y: 900 },
    { x: 1279.5, y: 799.5 }, // fractional (DPR) anchors
  ];
  const menus = [
    { width: 1, height: 1 },
    { width: 200, height: 300 },
    { width: 640, height: 400 },
    { width: 1268, height: 788 }, // exactly viewport minus margins
    { width: 2000, height: 2000 }, // oversized
  ];
  for (const flip of [true, false]) {
    for (const menu of menus) {
      for (const anchor of anchors) {
        it(`flip=${flip} menu=${menu.width}×${menu.height} anchor=(${anchor.x},${anchor.y}) stays fully in view`, () => {
          const pos = clampMenuToViewport({ anchor, menu, viewport: VP, flip });
          expectInViewport(pos, menu);
        });
      }
    }
  }
});
