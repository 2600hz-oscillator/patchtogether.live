// packages/web/src/lib/video/hd-res.ts
//
// Pure aspect → internal-render-resolution math for the HD toggle.
//
// HD mode renders every per-module FBO at ~1080 short-edge lines, preserving
// the current display aspect, with the LONG edge capped at 1920 ("1080p-class")
// so an ultra-wide / portrait viewport can't blow texture budgets. Output is
// even-rounded (chroma-subsample-friendly + avoids odd-pixel sampling
// artifacts). Default (HD OFF) stays exactly VIDEO_RES 640×480.
//
// This module is intentionally GL-free + side-effect-free so it's cheap to unit
// test deterministically (see hd-res.test.ts). The engine consumes the result
// via its `res` constructor option (see engine.ts).

/** Short-ish edge target — HD renders ~1080 lines on the SHORT axis. */
export const HD_TARGET_LINES = 1080;
/** Don't exceed a 1080p-class LONG edge (ultra-wide / tall would otherwise
 *  balloon texture memory). */
export const HD_LONG_EDGE_CAP = 1920;

export interface Res {
  width: number;
  height: number;
}

/**
 * Compute the HD internal render resolution for a given display aspect ratio
 * (width / height).
 *
 * - Landscape (aspect ≥ 1): height is the short edge → 1080; width = h·aspect,
 *   capped so width ≤ 1920 (then height recomputed to preserve aspect).
 * - Portrait (aspect < 1): width is the short edge → 1080; height = w/aspect,
 *   capped so height ≤ 1920.
 * - Result rounded to EVEN on both axes.
 *
 * Examples: 16:9 → 1920×1080, 4:3 → 1440×1080, 21:9 → long-edge-capped 1920×…,
 * 9:16 portrait → 1080×1920.
 *
 * Non-finite / non-positive aspects fall back to 16:9 (a sane HD default) so a
 * caller passing a degenerate `innerWidth/innerHeight` (e.g. 0-height during a
 * layout glitch) never produces a 0- or NaN-sized FBO.
 */
export function computeHdRes(aspect: number): Res {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;

  let w: number;
  let h: number;
  if (a >= 1) {
    // Landscape: short edge is the height.
    h = HD_TARGET_LINES;
    w = Math.round(h * a);
    if (w > HD_LONG_EDGE_CAP) {
      w = HD_LONG_EDGE_CAP;
      h = Math.round(w / a);
    }
  } else {
    // Portrait: short edge is the width.
    w = HD_TARGET_LINES;
    h = Math.round(w / a);
    if (h > HD_LONG_EDGE_CAP) {
      h = HD_LONG_EDGE_CAP;
      w = Math.round(h * a);
    }
  }

  // Round to even (drop the low bit). Guard against a degenerate 0 from the
  // even-round of a tiny value — min 2px per axis.
  w -= w & 1;
  h -= h & 1;
  if (w < 2) w = 2;
  if (h < 2) h = 2;
  return { width: w, height: h };
}

/**
 * Compute the HD resolution from the current browser viewport. SSR-safe: with
 * no `window` (or a degenerate 0-size viewport) it falls back to a 16:9 HD
 * target. The HD store captures this at toggle time so reload is deterministic.
 */
export function computeHdResFromViewport(): Res {
  if (typeof window === 'undefined') return computeHdRes(16 / 9);
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  if (w <= 0 || h <= 0) return computeHdRes(16 / 9);
  return computeHdRes(w / h);
}
