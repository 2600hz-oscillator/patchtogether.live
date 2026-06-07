// fullscreen-canvas-dims.ts
//
// Shared helper for the canvas-based video preview cards (VideoOut / Bentbox /
// B3ntb0x) when they go to TRUE fullscreen or in-app full-frame.
//
// WHY THIS EXISTS — the letterbox bug:
//   In the rack, each card paints the live engine frame into a card-sized
//   <canvas> drawing buffer (width=innerWidth, height=innerHeight ≈ the card's
//   inner area), aspect-fitting the engine content with black bars baked into
//   the buffer pixels (see each card's `fitRect`). That's correct for the
//   in-rack preview.
//
//   But on FULLSCREEN the card left the canvas buffer at the *card* aspect and
//   relied on CSS `width/height:100%; object-fit:contain` to scale it up. So
//   the displayed content carried the CARD aspect (e.g. ~1.85:1 for a default
//   360×240 OUTPUT), which `object-fit:contain` then fit into the physical
//   screen — adding TOP/BOTTOM black bars whenever the card aspect was
//   narrower than the screen, ON TOP OF the bars already baked into the buffer
//   by fitRect. Result: a double-letterboxed, never-height-filled fullscreen.
//
// THE FIX — match the buffer to the ENGINE aspect while fullscreen/full-frame:
//   When fullscreen/full-frame we size the canvas drawing buffer to the live
//   ENGINE dimensions (ew×eh). Then each card's fitRect, called with the same
//   engine aspect, returns a FULL-BLEED rect (x=0,y=0,w=cw,h=ch) — no bars
//   baked into the buffer. The CSS then displays an engine-aspect canvas with
//   `object-fit:contain`, so a 4:3 source HEIGHT-FILLS a 16:9 screen with only
//   the unavoidable side pillarbox — no top/bottom letterbox.
//
// Pure + GL-free so it unit-tests deterministically.

import { VIDEO_RES } from '$lib/video/engine';

export interface CanvasDims {
  /** Drawing-buffer width (the <canvas> `width` attribute). */
  width: number;
  /** Drawing-buffer height (the <canvas> `height` attribute). */
  height: number;
  /** CSS `aspect-ratio` string for the element (width / height). */
  aspectRatio: string;
}

interface EngineLike {
  canvas?: { width?: number; height?: number };
}

/**
 * Even-round + floor a dimension at 2px (chroma-friendly, never 0/NaN).
 */
function evenFloor(n: number): number {
  let v = Math.round(Number.isFinite(n) && n > 0 ? n : 0);
  v -= v & 1;
  return v < 2 ? 2 : v;
}

/** Keep the in-rack path byte-identical: the card already clamps innerWidth/
 *  innerHeight to sane minimums, so we pass them through untouched (no even
 *  rounding) to avoid a 1px VRT diff vs. the prior behavior. */
function rawOr2(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 2;
}

/**
 * Compute the canvas drawing-buffer dimensions + CSS aspect-ratio for a
 * canvas-based video preview card.
 *
 * @param fullscreen  Whether the card is in TRUE fullscreen or in-app full-frame.
 * @param engine      The live VideoEngine (read for its current canvas dims).
 * @param cardInner   The in-rack inner buffer dims used when NOT fullscreen.
 *
 * - NOT fullscreen → the card's own inner dims (unchanged, byte-identical to
 *   before): a card-aspect buffer that the in-rack CSS displays 1:1.
 * - Fullscreen → the live ENGINE dims (VIDEO_RES), so fitRect fills the buffer
 *   edge-to-edge and the CSS object-fit:contain pillarboxes the true engine
 *   aspect into the screen (height-fill, side pillarbox only for 4:3 — no
 *   top/bottom letterbox).
 */
export function fullscreenCanvasDims(
  fullscreen: boolean,
  engine: EngineLike | null | undefined,
  cardInner: { width: number; height: number },
): CanvasDims {
  if (!fullscreen) {
    const w = rawOr2(cardInner.width);
    const h = rawOr2(cardInner.height);
    return { width: w, height: h, aspectRatio: `${w} / ${h}` };
  }
  // Fullscreen / full-frame: mirror the live engine dims so the buffer carries
  // the ENGINE aspect, not the card aspect.
  const ew = engine?.canvas?.width ?? 0;
  const eh = engine?.canvas?.height ?? 0;
  let w: number;
  let h: number;
  if (ew > 0 && eh > 0) {
    w = evenFloor(ew);
    h = evenFloor(eh);
  } else {
    // Engine canvas not readable yet — fall back to the fixed VIDEO_RES so the
    // fullscreen view still pillarboxes at the correct 4:3 aspect.
    w = evenFloor(VIDEO_RES.width);
    h = evenFloor(VIDEO_RES.height);
  }
  return { width: w, height: h, aspectRatio: `${w} / ${h}` };
}
