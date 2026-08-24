// menu-viewport-action.ts
//
// The DOM side of menu-viewport.ts: a Svelte action that OWNS the position of
// a `position: fixed` context menu so the whole menu is always inside the
// client viewport (the pure math lives in clampMenuToViewport — flip across
// the anchor on overflow, clamp as last resort, pin + internal scroll when
// bigger than the viewport).
//
//   <div class="ctx-menu" use:clampMenu={{ x, y }}> … </div>
//
// The host element must be `position: fixed` and must resolve against the REAL
// client viewport — i.e. it must have NO transformed ancestor (SvelteFlow's
// pan/zoom `.svelte-flow__viewport` is the classic trap: a CSS transform makes
// an ancestor the containing block for fixed descendants, so "fixed" coords
// silently become pane-local). Portal the menu to <body> when in doubt — the
// shared `portal` action below does exactly that.
//
// The action:
//   * positions SYNCHRONOUSLY on mount (before first paint — no flash at the
//     raw anchor),
//   * re-clamps when the anchor params change,
//   * re-clamps when the menu RESIZES (submenu cascades growing a flyout
//     column, async content) via ResizeObserver,
//   * re-clamps on window resize,
//   * measures the NATURAL size at the viewport origin first, so fixed-pos
//     shrink-to-fit against the right/bottom edges can't fake a smaller menu,
//   * caps an oversized menu to the viewport (max-width/max-height + auto
//     overflow) so every item stays reachable by internal scroll.

import { clampMenuToViewport } from './menu-viewport';
import { computeAdjacentRect } from './patch-menu-position';

export interface ClampMenuParams {
  /** Anchor point in CLIENT viewport coords (e.g. MouseEvent.clientX/Y). */
  x: number;
  y: number;
  /** Margin kept off every viewport edge (default 6). */
  margin?: number;
  /** Flip across the anchor on overflow (default true). Pass false for
   *  pre-aligned anchors where sliding beats jumping across the anchor. */
  flip?: boolean;
}

export function clampMenu(node: HTMLElement, params: ClampMenuParams) {
  let current = params;
  let raf = 0;

  const apply = () => {
    const margin = current.margin ?? 6;
    // Measure the NATURAL size from the origin: a fixed box seeded near the
    // right/bottom edge shrink-to-fits against the remaining space, which
    // under-reports the menu size and defeats the clamp. Same-task style
    // writes never paint, so this is invisible.
    node.style.left = '0px';
    node.style.top = '0px';
    node.style.maxWidth = '';
    node.style.maxHeight = '';
    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { left, top } = clampMenuToViewport({
      anchor: { x: current.x, y: current.y },
      menu: { width: rect.width, height: rect.height },
      viewport: { width: vw, height: vh },
      margin,
      flip: current.flip,
    });
    // Degenerate case (menu bigger than the viewport): cap the box and let it
    // scroll internally so the far items stay reachable.
    if (rect.width > vw - 2 * margin) {
      node.style.maxWidth = `${Math.max(0, vw - 2 * margin)}px`;
      node.style.overflowX = 'auto';
    }
    if (rect.height > vh - 2 * margin) {
      node.style.maxHeight = `${Math.max(0, vh - 2 * margin)}px`;
      node.style.overflowY = 'auto';
    }
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  };

  // Coalesce observer/resize bursts into one post-layout pass (also avoids
  // "ResizeObserver loop" warnings from mutating layout inside the callback).
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      apply();
    });
  };

  apply(); // synchronous first position — mounts already clamped
  const ro = new ResizeObserver(schedule);
  ro.observe(node);
  window.addEventListener('resize', schedule);

  return {
    update(next: ClampMenuParams) {
      current = next;
      apply();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
    },
  };
}

export interface CascadeMenuParams {
  /** The PARENT ROW's bounding rect in client-viewport coords. */
  rect: { left: number; top: number; right: number; bottom: number };
  /** Gap between the parent row and the flyout (default 2 — a cascade reads as
   *  attached to its parent, unlike the rail's detached tile menu). */
  gap?: number;
  /** Margin kept off every viewport edge (default 6). */
  margin?: number;
}

/**
 * Position a CASCADING SUBMENU flyout beside its parent ROW.
 *
 * ⚠ NOT `clampMenu` with the row's right edge as the anchor. That was the first
 * attempt and it is wrong in a way only the edge case shows: `clampMenu` flips
 * or slides across a POINT, so at the window's right edge it slides the flyout
 * back LEFT — straight over the parent menu it flew out of (measured: 26 x 147
 * CSS px of overlap on the clipplayer note menu with the card panned right).
 * The menu was fully in the viewport and completely unusable, so an
 * in-viewport-only assertion certified it.
 *
 * A cascade has to flip across the parent's BOX, not a point: right of the row
 * by default, LEFT of the row when the right side has no room. That is exactly
 * `computeAdjacentRect`'s policy (written for the RACKLINE lane rail), so this
 * action is the DOM half — measure, cap an oversized box to the viewport with
 * internal scroll (a 40-level option list is routinely taller than the window),
 * and apply. The placement math itself stays pure and shared.
 */
export function cascadeMenu(node: HTMLElement, params: CascadeMenuParams) {
  let current = params;
  let raf = 0;

  const apply = () => {
    const margin = current.margin ?? 6;
    const gap = current.gap ?? 2;
    // Measure NATURAL size from the origin first — same reason as clampMenu: a
    // fixed box seeded near an edge shrink-to-fits and under-reports itself.
    node.style.left = '0px';
    node.style.top = '0px';
    node.style.maxWidth = '';
    node.style.maxHeight = '';
    const natural = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Cap BEFORE positioning, so the position is computed from the size the box
    // will actually have (capping afterwards would place a stale height).
    let width = natural.width;
    let height = natural.height;
    if (width > vw - 2 * margin) {
      width = Math.max(0, vw - 2 * margin);
      node.style.maxWidth = `${width}px`;
      node.style.overflowX = 'auto';
    }
    if (height > vh - 2 * margin) {
      height = Math.max(0, vh - 2 * margin);
      node.style.maxHeight = `${height}px`;
      node.style.overflowY = 'auto';
    }
    const { left, top } = computeAdjacentRect({
      anchorRect: current.rect,
      menuWidth: width,
      menuHeight: height,
      viewport: { width: vw, height: vh },
      gap,
      margin,
    });
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  };

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      apply();
    });
  };

  apply(); // synchronous first position — mounts already placed
  const ro = new ResizeObserver(schedule);
  ro.observe(node);
  window.addEventListener('resize', schedule);

  return {
    update(next: CascadeMenuParams) {
      current = next;
      apply();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
    },
  };
}

/** Portal the node to <body> so `position: fixed` resolves against the real
 *  client viewport instead of a transformed ancestor (SvelteFlow's pan/zoom
 *  viewport, a scaled dock pane). Shared by menu open sites — pair with
 *  `use:clampMenu` on the fixed menu element inside. */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}
