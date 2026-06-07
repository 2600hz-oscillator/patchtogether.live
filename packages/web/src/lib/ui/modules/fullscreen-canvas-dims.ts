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
// HD composition (#653): in HD mode the engine renders at the viewport aspect
// (computeHdRes → e.g. 1920×1080 / 1440×1080), so the engine dims we read here
// already follow HD. In a fullscreen-on-the-current-monitor case the engine
// aspect ≈ the screen aspect, so object-fit:contain fills edge-to-edge with no
// bars at all; in SD (4:3) it pillarboxes. Either way we don't fight HD's
// aspect math — we simply mirror the engine's live dimensions.
//
// Pure + GL-free so it unit-tests deterministically.

import { liveEngineAspect } from './video-card-aspect';

/** SD short-edge fallback (the VIDEO_RES height) used to size the fallback
 *  buffer at the SD 4:3 aspect when the engine canvas isn't readable yet. */
const SD_H = 480;

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
 * - Fullscreen → the live ENGINE dims, so fitRect fills the buffer edge-to-edge
 *   and the CSS object-fit:contain pillar/letterboxes the true engine aspect
 *   into the screen (height-fill, side pillarbox only for 4:3).
 */
export function fullscreenCanvasDims(
  fullscreen: boolean,
  engine: EngineLike | null | undefined,
  cardInner: { width: number; height: number },
): CanvasDims {
  if (!fullscreen) {
    const w = evenFloorOrRaw(cardInner.width);
    const h = evenFloorOrRaw(cardInner.height);
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
    // Engine canvas not readable yet (mid-rebuild on HD toggle) — fall back to
    // the SD 4:3 ratio so the fullscreen view still pillarboxes correctly.
    const aspect = liveEngineAspect(engine);
    h = evenFloor(SD_H);
    w = evenFloor(h * aspect);
  }
  return { width: w, height: h, aspectRatio: `${w} / ${h}` };
}

/** Keep the in-rack path byte-identical: the card already clamps innerWidth/
 *  innerHeight to sane minimums, so we pass them through untouched (no even
 *  rounding) to avoid a 1px VRT diff vs. the prior behavior. */
function evenFloorOrRaw(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 2;
}
