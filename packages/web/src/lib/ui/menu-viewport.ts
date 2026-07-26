// menu-viewport.ts
//
// PURE viewport-clamp positioning for ALL cursor/anchor-opened context menus
// and popovers. No Svelte / DOM imports — takes a plain anchor point, a
// measured menu size, and the viewport size, and returns the {left, top} a
// `position: fixed` menu must use so the ENTIRE menu is inside the viewport.
//
// OWNER REQUIREMENT (2026-07 screenshot: clip-editor grid right-click menu
// clipped at the right window edge): menus must open in a position ensured to
// be fully in view horizontally AND vertically, in ALL cases, in ALL views.
//
// Placement policy per axis (the OS-context-menu convention):
//   1. IDEAL   — the menu's top-left corner sits at the anchor (menu opens
//                down-right of the pointer).
//   2. FLIP    — if that would overflow the far edge, open to the OTHER side
//                of the anchor (right overflow → menu's right edge at the
//                anchor; bottom overflow → menu's bottom edge at the anchor;
//                corners flip both axes).
//   3. CLAMP   — if the flipped position would poke past the near edge too
//                (tiny viewport / anchor near both edges), slide the menu to
//                fit inside [margin, extent - margin].
//   4. PIN     — a menu BIGGER than the viewport span pins at the near margin;
//                the caller gives the box internal scroll (the clampMenu DOM
//                action does this automatically).
//
// All inputs/outputs are CLIENT-viewport (window) coordinates — callers inside
// scrolled or docked containers must anchor with clientX/clientY (or
// getBoundingClientRect) and render the menu with no transformed ancestor
// (portal to <body> when in doubt). See menu-viewport-action.ts for the DOM
// side (measure + apply + re-clamp on resize).
//
// Sibling module: patch-menu-position.ts holds the PATCH-menu-specific
// edge-aligned/adjacent variants (menus that align to a CARD edge rather than
// opening at a pointer). Both are pure; this one is the general helper.

export interface MenuAnchorPoint {
  /** Client-viewport coordinates (e.g. MouseEvent.clientX/clientY). */
  x: number;
  y: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ClampMenuToViewportArgs {
  /** The pointer/anchor point the menu opens from (client coords). */
  anchor: MenuAnchorPoint;
  /** The MEASURED size of the menu chrome (px). */
  menu: MenuSize;
  /** The client viewport (window.innerWidth/innerHeight). */
  viewport: ViewportSize;
  /** Minimum margin kept between the menu and every viewport edge (default 6). */
  margin?: number;
  /** Flip to the other side of the anchor before clamping (default true).
   *  Pass false for pre-aligned anchors (an already edge-aligned top-left)
   *  where sliding is preferable to jumping across the anchor. */
  flip?: boolean;
}

/** Place one axis: ideal at `anchor`, flip across the anchor on far-edge
 *  overflow, clamp into [margin, extent - margin - size], pin at margin when
 *  the menu is bigger than the available span. */
function placeAxis(
  anchor: number,
  size: number,
  extent: number,
  margin: number,
  flip: boolean,
): number {
  const lo = margin;
  const hi = extent - margin;
  if (size >= hi - lo) return lo; // oversized → pin (caller scrolls internally)
  let pos = anchor;
  if (pos + size > hi && flip) {
    const flipped = anchor - size; // far edge of the menu at the anchor
    if (flipped >= lo) pos = flipped;
  }
  return Math.min(Math.max(pos, lo), hi - size);
}

/**
 * Compute the {left, top} that keeps the WHOLE menu inside the viewport.
 * Deterministic + total: any finite inputs produce an in-viewport position
 * (best-effort margin pin when the menu is bigger than the viewport).
 */
export function clampMenuToViewport(args: ClampMenuToViewportArgs): {
  left: number;
  top: number;
} {
  const { anchor, menu, viewport, margin = 6, flip = true } = args;
  return {
    left: placeAxis(anchor.x, menu.width, viewport.width, margin, flip),
    top: placeAxis(anchor.y, menu.height, viewport.height, margin, flip),
  };
}
