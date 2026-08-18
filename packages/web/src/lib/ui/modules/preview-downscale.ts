// packages/web/src/lib/ui/modules/preview-downscale.ts
//
// THE ONE PLACE A VIDEO PREVIEW SHRINKS A FULL-RES FRAME (#1846).
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//
// Owner, 2026-08-17, with screenshots: the on-card video previews paint a heavy
// horizontal comb that is NOT in the source, and the pattern strobes —
// *"whatever is going on we're not seeing real frames … it makes these displays
// unusable."*
//
// It is a RESAMPLING bug, not a frame-delivery bug, and the diagnostic fact is
// that FULLSCREEN IS FINE:
//
//   * `VideoEngine.blitTexToDrawingBufferInner` renders the drawing buffer at
//     the FULL engine resolution — `gl.viewport(0, 0, res.width, res.height)`,
//     VIDEO_RES = 1024×768.
//   * On FULLSCREEN / full-frame / projector, `fullscreenCanvasDims` sizes the
//     card's 2D drawing buffer to those SAME engine dims, so the card's
//     `drawImage` is 1:1 — no resampling, no artifact. Correct today.
//   * IN THE RACK the buffer is the card's inner size. A default OUTPUT card is
//     360×360, so its fit rect is ≈340×255 (a 3× reduction); the RACKLINE lane
//     thumbnail (`VideoTileThumb`, VIDEO_THUMB_W/H = 160×120) is a 6.4×
//     reduction.
//   * Chrome's `drawImage` downscale is a SINGLE BILINEAR TAP: 2×2 source
//     samples per destination pixel. At 2× reduction that 2×2 footprint covers
//     the whole source block and the result is a correct box filter. Past 2× it
//     covers a shrinking fraction of it, so most source rows are never read at
//     all — textbook aliasing, and the discarded rows are what paint as a comb.
//     As content moves, WHICH rows survive changes, so the moiré walks: the
//     strobe.
//
// The 30 fps preview cadence cap (#1802/#1836) did not cause this and must not
// be reverted — it only makes the moiré advance in bigger visible jumps.
//
// ── THE FIX, AND WHY THIS SHAPE ────────────────────────────────────────────
//
// Progressive halving on the 2D side: shrink by ≤2× per step into a scratch
// canvas until the remaining reduction is under 2×, then draw. Every step is
// therefore inside the range a single bilinear tap resolves correctly, so no
// source row is ever skipped.
//
// Chosen over the GL-side alternative (blit the FBO at preview size with a
// multi-tap box filter) for three measured reasons:
//
//   1. THE DRAWING BUFFER IS SHARED. `engine.canvas` is not the preview's
//      private surface — WAVESCULPT uploads it as a texture, SYNESTHESIA reads
//      channel levels off it, TIMELORDE composites it back, RECORDERBOX
//      captures it, and every card mirrors `canvas.width/height` into its own
//      aspect maths. Rendering it at one card's preview size would corrupt all
//      of those, and N cards of different sizes cannot each own it.
//   2. FBO COLOUR TARGETS ARE `NEAREST` ON PURPOSE (`engine.ts`, "WARNING:
//      LINEAR on a float colour target silently reads 0.0"). Anything that
//      relaxes that default risks black or garbage on float attachments.
//   3. HASH TRANSPARENCY. `packages/web/src/lib/video/**` is in the WebGL
//      attest basis; this directory's `.ts` files are not (the basis walks
//      `lib/ui/modules` for `.svelte` files that create a WebGL context). A
//      2D-canvas resampling change moves ZERO GL pixels, so it should not cost
//      a trusted-GPU re-attest — and living here, it does not.
//
// ── COST ───────────────────────────────────────────────────────────────────
//
// The expensive, synchronising half is the FIRST read of the WebGL canvas, and
// there is still exactly one of those per painted frame — unchanged. What is
// added is 1–2 canvas→canvas draws of rapidly halving size (for the 1024×768
// engine: 512×384, then 256×192). The GL blit and the #1802/#1836 preview gate
// are untouched: this code runs strictly INSIDE the `blitted === true` branch
// every caller already had, so off-screen still costs nothing and on-screen is
// still capped at PREVIEW_FPS / VIDEO_THUMB_FPS.
//
// ── ⚠ WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
//
//   * IT IS A NO-OP WHEN THE REDUCTION IS UNDER 2×. `planDownscaleSteps`
//     returns an empty plan and the call degenerates to the single `drawImage`
//     that was there before. ⚠ At a genuine (sub-2×) reduction that direct draw
//     still asks for `imageSmoothingQuality = 'high'`, which is a real request
//     to the sampler — so "no-op" is exact only where there IS no reduction.
//     That is the case that matters: FULLSCREEN / full-frame / projector are
//     EXACTLY 1:1 (`fullscreenCanvasDims` sizes the buffer to the engine dims),
//     the smoothing assignment is skipped there by an explicit `sw > dw` guard,
//     and the surviving call is the one that was already there. Fullscreen is
//     unchanged BY CONSTRUCTION rather than by promise.
//   * IT DOES NOT TOUCH DELIBERATELY-CRISP SURFACES. `FoxyCard` and
//     `RasterizeCard` set `imageSmoothingEnabled = false` for pixel-art
//     hardness; they never blit the engine drawing buffer and must never call
//     this. `preview-downscale-source.test.ts` holds both halves of that.
//   * IT IS NOT AN ANALYSIS PATH. A downscale whose output is read back with
//     `getImageData` and turned into numbers (SYNESTHESIA's channel levels,
//     WAVESCULPT's luma grid) is measuring, not displaying, and changing its
//     filter changes the numbers. Those stay as they are.
//
// ⚠ MUTATES THE DESTINATION CONTEXT. Sets `imageSmoothingEnabled = true` and
// `imageSmoothingQuality = 'high'` on `ctx`. Every caller is a smooth video
// preview and wants both; a caller that wants hard pixels must not use this.

/** Runaway guard on the halving loop, not a tuning knob: the loop already stops
 *  on its own the moment the remaining reduction drops under 2×, which for the
 *  1024×768 engine happens after 2 steps at the 160×120 lane thumb (the worst
 *  reduction that ships, 6.4×). 8 leaves the cap unreachable for any preview
 *  down to ~4 px. A bound on recursion depth — a physical constant, not a count
 *  of anything in this repo. */
export const MAX_DOWNSCALE_STEPS = 8;

/** One intermediate size in a downscale plan. */
export interface DownscaleStep {
  w: number;
  h: number;
}

/**
 * PURE. The intermediate sizes to shrink through so that no single step is a
 * reduction of more than 2× (the footprint a bilinear tap resolves without
 * discarding source pixels).
 *
 * Returns `[]` when the reduction is already under 2× on either axis — meaning
 * "draw it directly, there is nothing to fix". A 1:1 draw (fullscreen) and a
 * mild shrink both take that path.
 *
 * Pure so the decision can be tested without a canvas: the DOM half below
 * degenerates to a plain `drawImage` in any environment without a real 2D
 * context, which would otherwise make the interesting case untestable.
 */
export function planDownscaleSteps(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  maxSteps: number = MAX_DOWNSCALE_STEPS,
): DownscaleStep[] {
  const steps: DownscaleStep[] = [];
  if (
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    !Number.isFinite(dstW) ||
    !Number.isFinite(dstH) ||
    srcW <= 0 ||
    srcH <= 0 ||
    dstW <= 0 ||
    dstH <= 0
  ) {
    return steps;
  }
  const targetW = Math.max(1, Math.ceil(dstW));
  const targetH = Math.max(1, Math.ceil(dstH));
  let w = Math.floor(srcW);
  let h = Math.floor(srcH);
  // STRICTLY greater: at EXACTLY 2× the 2×2 bilinear footprint covers the whole
  // source block, so that reduction is already a correct box filter and
  // halving first would only add a redundant 1:1 draw.
  while (steps.length < maxSteps && w > targetW * 2 && h > targetH * 2) {
    w = Math.max(targetW, w >> 1);
    h = Math.max(targetH, h >> 1);
    steps.push({ w, h });
  }
  return steps;
}

/** A source rectangle, for callers that already draw a sub-region. */
export interface SourceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Pad {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/**
 * Two reusable scratch surfaces, ping-ponged between steps so a step never
 * reads and writes the same canvas (self-`drawImage` with overlapping regions
 * is the kind of thing that is "fine in practice" right up until it is not).
 *
 * Module-level and GROW-ONLY: every card's preview runs to completion inside
 * one synchronous call, so sharing is safe, and sizing to the largest first
 * step any caller has needed avoids reallocating (which also clears) per frame.
 * Sub-rects are always addressed explicitly, so surplus area is never read.
 */
const pads: (Pad | null)[] = [null, null];
/** Set once a real 2D context has proven unavailable (jsdom, SSR) so we do not
 *  retry — and log nothing — on every animation frame. */
let padsUnavailable = false;

function acquirePad(slot: number, w: number, h: number): Pad | null {
  if (padsUnavailable) return null;
  let pad = pads[slot] ?? null;
  if (!pad) {
    if (typeof document === 'undefined') {
      padsUnavailable = true;
      return null;
    }
    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D | null;
    try {
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, w);
      canvas.height = Math.max(1, h);
      ctx = canvas.getContext('2d');
    } catch {
      padsUnavailable = true;
      return null;
    }
    if (!ctx) {
      padsUnavailable = true;
      return null;
    }
    // `copy` rather than the default `source-over`: each step fully REPLACES
    // the pad, so a previous (larger) frame can never blend through a source
    // with alpha, and no clearRect is needed.
    ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    pad = { canvas, ctx };
    pads[slot] = pad;
  }
  if (pad.canvas.width < w || pad.canvas.height < h) {
    // Grow only. Resizing resets context state, so re-apply it.
    pad.canvas.width = Math.max(pad.canvas.width, w);
    pad.canvas.height = Math.max(pad.canvas.height, h);
    pad.ctx.globalCompositeOperation = 'copy';
    pad.ctx.imageSmoothingEnabled = true;
    pad.ctx.imageSmoothingQuality = 'high';
  }
  return pad;
}

/** TEST SEAM. Drop the cached scratch surfaces and the unavailable latch. */
export function __resetPreviewDownscalePads(): void {
  pads[0] = null;
  pads[1] = null;
  padsUnavailable = false;
}

/**
 * Read a source's intrinsic dimensions. Every source a video preview passes is
 * canvas-like (the engine's drawing buffer, a module's render canvas, an
 * ImageBitmap) and carries `width`/`height`, but `CanvasImageSource` is a union
 * that also admits `HTMLVideoElement` — which does not. Returning 0 for the
 * unreadable case makes `planDownscaleSteps` return an empty plan, i.e. "draw
 * it directly", which is exactly the pre-existing behaviour.
 *
 * ⚠ The parameter type stays the plain `CanvasImageSource` ON PURPOSE: every
 * call site already writes `engine.canvas as CanvasImageSource`, so a narrower
 * type would turn a one-token swap into 30 cast edits.
 */
function intrinsicSize(src: CanvasImageSource): { w: number; h: number } {
  const s = src as unknown as { width?: unknown; height?: unknown };
  return {
    w: typeof s.width === 'number' ? s.width : 0,
    h: typeof s.height === 'number' ? s.height : 0,
  };
}

/**
 * DROP-IN FOR `ctx.drawImage(src, dx, dy, dw, dh)` ON A PREVIEW SURFACE.
 *
 * Shrinks through `planDownscaleSteps` so no step exceeds 2×, then draws.
 * Falls back to the plain single `drawImage` — byte-identical to the call it
 * replaced — whenever the plan is empty (reduction already under 2×, source
 * dimensions unreadable) or no scratch context is available.
 *
 * @returns how many halving steps were used; 0 means it drew directly.
 */
export function drawPreviewDownscaled(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  srcRect?: SourceRect,
): number {
  const intrinsic = intrinsicSize(src);
  const sx = srcRect ? srcRect.x : 0;
  const sy = srcRect ? srcRect.y : 0;
  const sw = srcRect ? srcRect.w : intrinsic.w;
  const sh = srcRect ? srcRect.h : intrinsic.h;

  const drawDirect = (): void => {
    // ⚠ ONLY touch the sampler when this draw actually REDUCES. The browser
    // default quality is 'low', and Skia does pick a different filter for
    // 'high' — so setting it unconditionally would make the 1:1 FULLSCREEN
    // path a change rather than a no-op. Gated on a real reduction, "fullscreen
    // is untouched" is a property of the code, not a hope about the sampler.
    if (sw > dw || sh > dh) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
    if (srcRect) ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
    else ctx.drawImage(src, dx, dy, dw, dh);
  };

  const steps = planDownscaleSteps(sw, sh, dw, dh);
  if (steps.length === 0) {
    drawDirect();
    return 0;
  }

  let curSrc: CanvasImageSource = src;
  let cx = sx;
  let cy = sy;
  let cw = sw;
  let ch = sh;
  let applied = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const pad = acquirePad(i % 2, step.w, step.h);
    if (!pad) {
      // No scratch surface (jsdom/SSR). Whatever we have shrunk so far is
      // still a strict improvement; finish from there.
      break;
    }
    pad.ctx.drawImage(curSrc, cx, cy, cw, ch, 0, 0, step.w, step.h);
    curSrc = pad.canvas;
    cx = 0;
    cy = 0;
    cw = step.w;
    ch = step.h;
    applied++;
  }

  if (applied === 0) {
    // No pad was available. Preserve the original single-call shape exactly.
    drawDirect();
    return 0;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(curSrc, cx, cy, cw, ch, dx, dy, dw, dh);
  return applied;
}
