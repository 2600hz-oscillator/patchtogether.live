// patch-menu-position.ts
//
// PURE positioning math for the body-portaled patch menu. No Svelte / DOM
// imports — takes plain rects + a viewport size and returns the {left, top}
// the fixed-positioned menu CHROME should use.
//
// REQUIREMENT (user spec item 1): the menu EDGE-ALIGNS to the module side it
// opened from. Opening from the RIGHT trigger => the menu's RIGHT edge aligns to
// the module's RIGHT edge. Opening from the LEFT trigger => the menu's LEFT edge
// aligns to the module's LEFT edge. The menu must NEVER spill past that side of
// the module.
//
// "Never spill past that side" interpretation:
//   * side==='right': the menu's right edge == card.right. Growing leftward, the
//     menu may extend left of card.left for a wide menu / narrow card — that's
//     fine; it must not poke past the card's RIGHT edge.
//   * side==='left': the menu's left edge == card.left. Growing rightward, it may
//     extend right of card.right — must not poke past the card's LEFT edge.
//
// On top of edge-alignment we clamp to the viewport so the menu always stays
// fully on-screen: if edge-aligning would push the menu off the left/right or
// bottom of the viewport, we slide it back in. The edge-alignment is the IDEAL;
// the viewport clamp is the safety net.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface ComputeEdgeAlignedRectArgs {
  /** The card's bounding rect in viewport (screen) coordinates. */
  cardRect: Rect;
  /** Which trigger fired: 'left' aligns the menu's LEFT edge to card.left;
   *  'right' aligns the menu's RIGHT edge to card.right. */
  side: 'left' | 'right';
  /** Measured width of the menu chrome (px). */
  menuWidth: number;
  /** Measured height of the menu chrome (px). Optional — when provided, the
   *  vertical clamp keeps the menu's bottom on-screen. */
  menuHeight?: number;
  /** The viewport size (px). */
  viewport: Viewport;
  /** Vertical offset below the card top where the menu opens (default 28 — just
   *  below the trigger glyph row, matching the legacy `top: 28px`). */
  topOffset?: number;
  /** Minimum on-screen margin kept on every side when clamping (default 4). */
  margin?: number;
}

/**
 * Compute the {left, top} for the body-portaled, position:fixed patch menu so
 * its anchored edge aligns to the matching card edge, never spilling past that
 * side, then clamp to keep it fully on-screen.
 */
export function computeEdgeAlignedRect(args: ComputeEdgeAlignedRectArgs): { left: number; top: number } {
  const {
    cardRect,
    side,
    menuWidth,
    menuHeight,
    viewport,
    topOffset = 28,
    margin = 4,
  } = args;

  // --- Horizontal: edge-align, then viewport-clamp ---
  let left: number;
  if (side === 'right') {
    // Right edge of menu == right edge of card.
    left = cardRect.right - menuWidth;
  } else {
    // Left edge of menu == left edge of card.
    left = cardRect.left;
  }

  // Viewport clamp. Keep the WHOLE menu on-screen. If the menu is wider than
  // the available viewport span, prefer pinning the menu's anchored edge to the
  // matching viewport edge (left for 'left', right for 'right') so the anchored
  // side stays visible.
  const minLeft = margin;
  const maxLeft = viewport.width - menuWidth - margin;
  if (maxLeft < minLeft) {
    // Menu wider than viewport — pin the anchored edge to its viewport side.
    left = side === 'right' ? viewport.width - menuWidth - margin : margin;
  } else {
    left = Math.max(minLeft, Math.min(left, maxLeft));
  }

  // --- Vertical: open just below the card top, clamp bottom on-screen ---
  let top = cardRect.top + topOffset;
  if (menuHeight !== undefined) {
    const maxTop = viewport.height - menuHeight - margin;
    if (maxTop >= margin) {
      top = Math.max(margin, Math.min(top, maxTop));
    } else {
      // Menu taller than viewport — pin to top margin (the scrollable menu
      // chrome owns its own overflow).
      top = margin;
    }
  } else {
    top = Math.max(margin, top);
  }

  return { left, top };
}
