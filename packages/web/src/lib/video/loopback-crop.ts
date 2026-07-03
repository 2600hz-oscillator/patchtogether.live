// packages/web/src/lib/video/loopback-crop.ts
//
// Pure crop-rectangle math for the LOOPBACK module (browser-viewport video
// source). GL-free + side-effect free so it unit-tests deterministically (see
// loopback-crop.test.ts).
//
// LOOPBACK captures the CURRENT TAB via getDisplayMedia (preferCurrentTab). The
// captured MediaStream surface is the tab's LAYOUT VIEWPORT — its pixels map
// 1:1 (up to device-pixel scaling) onto `window.innerWidth × innerHeight` CSS
// pixels. To honour "just the ACTIVE VIEWPORT the user sees, not surrounding
// app chrome", the card measures an app viewport element's
// getBoundingClientRect (top-origin CSS px, relative to the layout viewport)
// and this module converts it to the GL texture SAMPLE-SPACE sub-rectangle the
// shader windows into.
//
// Two conversions live here:
//   1. computeCropUv — element rect (top-origin CSS px) + viewport size →
//      { u0,u1,v0,v1 } UV bounds in GL SAMPLE space. The vertical axis is
//      FLIPPED because LOOPBACK uploads its capture frame with
//      UNPACK_FLIP_Y_WEBGL = true (same as CAMERA), so texture-v = 0 is the
//      BOTTOM of the captured surface. Baking the flip in here (not the shader)
//      keeps the orientation regression-pinned by a unit test.
//   2. cropRegionAspect — the width/height aspect of the cropped region in REAL
//      capture pixels, so the draw pass can letterbox-fit it into the engine FBO
//      without stretching.
//
// The surface's own pixel dimensions cancel out of the UV computation (a rect at
// x = 40% of the viewport is at u = 0.40 of the surface regardless of the
// surface's pixel size), so computeCropUv needs only the viewport CSS size — it
// is resolution-independent. The surface dims re-enter for cropRegionAspect
// (aspect = croppedPixelWidth / croppedPixelHeight).

export interface ElementRect {
  /** Distance from the layout viewport's LEFT edge, in CSS px. */
  x: number;
  /** Distance from the layout viewport's TOP edge, in CSS px (top-origin). */
  y: number;
  width: number;
  height: number;
}

export interface CropUv {
  /** Left  UV bound (min u), 0..1. */
  u0: number;
  /** Right UV bound (max u), 0..1. */
  u1: number;
  /** Bottom UV bound (min v) in GL sample space, 0..1. */
  v0: number;
  /** Top    UV bound (max v) in GL sample space, 0..1. */
  v1: number;
}

/** The whole captured surface — the default when nothing is cropped, when
 *  crop-to-viewport is off, or when a rect is degenerate/off-screen. */
export const FULL_FRAME_CROP: CropUv = { u0: 0, u1: 1, v0: 0, v1: 1 };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Convert an app viewport element's bounding rect (top-origin CSS px, relative
 * to the layout viewport) into the GL SAMPLE-space UV sub-rectangle to window
 * into the captured tab frame.
 *
 * The vertical axis is flipped (top-origin CSS → bottom-origin GL sample v)
 * because the capture frame is uploaded with UNPACK_FLIP_Y_WEBGL = true:
 *   * the element's TOP edge (small CSS y) → LARGE sample v (v1, max)
 *   * the element's BOTTOM edge (large CSS y) → SMALL sample v (v0, min)
 *
 * All bounds are clamped to [0,1] (an element partially scrolled off the
 * viewport still yields the visible slice). Degenerate inputs — non-positive
 * viewport or rect dimensions, or a rect fully outside the viewport so the
 * clamped region collapses — fall back to the full frame.
 */
export function computeCropUv(
  rect: ElementRect,
  viewportW: number,
  viewportH: number,
): CropUv {
  if (!(viewportW > 0) || !(viewportH > 0)) return { ...FULL_FRAME_CROP };
  if (!(rect.width > 0) || !(rect.height > 0)) return { ...FULL_FRAME_CROP };

  const u0 = clamp01(rect.x / viewportW);
  const u1 = clamp01((rect.x + rect.width) / viewportW);
  // Top-origin normalized (CSS): 0 = viewport top, 1 = viewport bottom.
  const tTop = rect.y / viewportH;
  const tBot = (rect.y + rect.height) / viewportH;
  // Flip to bottom-origin GL sample space.
  const v0 = clamp01(1 - tBot); // element bottom edge → min v
  const v1 = clamp01(1 - tTop); // element top    edge → max v

  // Collapsed after clamp (element entirely outside the viewport) → full frame.
  if (u1 <= u0 || v1 <= v0) return { ...FULL_FRAME_CROP };
  return { u0, u1, v0, v1 };
}

/**
 * The width/height aspect of a cropped region in REAL capture pixels, so the
 * draw pass can aspect-fit (letterbox) it into the engine FBO without
 * stretching. `surfaceW`/`surfaceH` are the capture frame's intrinsic pixel
 * dims (videoEl.videoWidth / .videoHeight). Degenerate inputs fall back to
 * `fallback` (default 4:3, the engine's native aspect).
 */
export function cropRegionAspect(
  crop: CropUv,
  surfaceW: number,
  surfaceH: number,
  fallback = 4 / 3,
): number {
  if (!(surfaceW > 0) || !(surfaceH > 0)) return fallback;
  const wPx = (crop.u1 - crop.u0) * surfaceW;
  const hPx = (crop.v1 - crop.v0) * surfaceH;
  if (!(wPx > 0) || !(hPx > 0)) return fallback;
  return wPx / hPx;
}
