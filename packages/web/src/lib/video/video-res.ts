// packages/web/src/lib/video/video-res.ts
//
// Pure aspect → resolution math for the OUTPUT aspect switch (4:3 ↔ 16:9).
// GL-free + side-effect free so it unit-tests deterministically (see
// video-res.test.ts). Modelled on p10entrancer's OutputGeometry/OutputResolution
// split (../p10entrancer Mixer/MixerState.swift): geometry = the canvas ASPECT,
// resolution = the pixel size derived from it. Both aspects share the same
// HEIGHT (the vertical pixel budget is constant); only the width changes.
//
// Spec (LOCKED — height-anchored at 768):
//   - 4:3  → 1024×768 (the #662 baseline VIDEO_RES — unchanged DEFAULT).
//   - 16:9 → 1366×768 (768 · 16/9 = 1365.33 → even-rounded to 1366).
//
// Why height-anchored: matches p10entrancer (its option lists are height-
// anchored — 4:3 tops at 1440×1080, 16:9 at 1920×1080, same 1080 short axis)
// and keeps the OUTPUT card's vertical pixel budget constant across the toggle,
// so thumbnails + fullscreen don't jump in size — only the width grows wider.

/** The two output aspect ratios. Geometry = canvas shape; the pixel size comes
 *  from aspectRes(). */
export type VideoAspect = '4:3' | '16:9';

export interface Res {
  readonly width: number;
  readonly height: number;
}

/** The vertical pixel budget both aspects share (the #662 768p baseline). */
export const BASE_HEIGHT = 768;

/** The 4:3 default render resolution — the #662 baseline (1024×768). The single
 *  source of truth re-exported by engine.ts as the engine's default + every
 *  card's seed constant + fullscreen-canvas-dims' fallback. Unchanged by the
 *  aspect switch (16:9 is opt-in), so existing patches/baselines stay identical. */
export const VIDEO_RES: Res = { width: 1024, height: 768 };

/** The default output aspect. 4:3 keeps every existing patch + VRT baseline
 *  byte-identical; 16:9 is opt-in via the toggle. */
export const DEFAULT_ASPECT: VideoAspect = '4:3';

/** The numeric ratio (width / height) of an aspect. */
export function aspectRatio(aspect: VideoAspect): number {
  return aspect === '16:9' ? 16 / 9 : 4 / 3;
}

/** Round to the NEAREST EVEN integer ≥ 2. Even dims are chroma-subsample
 *  friendly and avoid odd-pixel sampling artifacts on the fullscreen quad.
 *  Nearest-even (not floor-to-even): 1365.33 → 1366 (0.67 away) not 1364. */
function even(n: number): number {
  const v = Math.max(2, Math.round(n / 2) * 2);
  return v;
}

/**
 * The engine render resolution for an output aspect — HEIGHT-anchored at
 * BASE_HEIGHT (768), width = even(768 · ratio).
 *
 *   4:3  → 1024×768
 *   16:9 → 1366×768   (1365.33 → even 1366)
 *
 * The single entry point the aspect store + engine use. 4:3 returns the exact
 * VIDEO_RES values so it's byte-identical to the #662 default.
 */
export function aspectRes(aspect: VideoAspect): Res {
  if (aspect !== '16:9') {
    return { width: VIDEO_RES.width, height: VIDEO_RES.height };
  }
  const height = even(BASE_HEIGHT);
  const width = even(BASE_HEIGHT * (16 / 9));
  return { width, height };
}

/** Coerce an unknown value to a VideoAspect, defaulting to DEFAULT_ASPECT. */
export function coerceAspect(v: unknown): VideoAspect {
  return v === '16:9' ? '16:9' : '4:3';
}

export interface FitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Aspect-fit (letterbox) destination rect for a source of `srcAspect`
 * (width/height) drawn into a `dstW`×`dstH` area, centered, with black bars on
 * the short axis. The preview cards' 2D blit + the fullscreen presenter use
 * this. Resolution-independent: it only depends on the aspects, mirroring the
 * reference's shader-side `aspectUV` letterbox fit (../p10entrancer
 * Shaders/MasterMixer.metal) — so a smaller source scales UP and a bigger one
 * scales DOWN with no extra branches. A 4:3 source in a wider 16:9 dst gets
 * left/right PILLARBOX; a 16:9 source in a 4:3 dst gets top/bottom LETTERBOX.
 */
export function fitRect(srcAspect: number, dstW: number, dstH: number): FitRect {
  const sa = Number.isFinite(srcAspect) && srcAspect > 0 ? srcAspect : 4 / 3;
  if (dstW <= 0 || dstH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const dstAspect = dstW / dstH;
  if (dstAspect > sa) {
    // Destination wider than source → left/right pillarbox.
    const h = dstH;
    const w = Math.round(h * sa);
    return { x: Math.round((dstW - w) / 2), y: 0, w, h };
  }
  // Destination taller than source → top/bottom letterbox.
  const w = dstW;
  const h = Math.round(w / sa);
  return { x: 0, y: Math.round((dstH - h) / 2), w, h };
}

/** Per-source fit mode (p10entrancer PadFillMode): how a source's native
 *  content maps into the output canvas. Never stretches/distorts. */
export type SourceFillMode = 'letterbox' | 'fill';

/**
 * The (sx, sy) UV scale that maps a source of native aspect `srcAspect` into a
 * canvas of aspect `dstAspect` under a fit `mode`, WITHOUT stretching. Feeds the
 * source shaders' `centered = (vUv - 0.5) / (sx, sy) + 0.5`. Mirrors the
 * reference's `aspectUV` (../p10entrancer Shaders/MasterMixer.metal):
 *
 *   - 'fill'      (cover): (sx, sy) ≥ 1 — zoom IN so the source fills the canvas
 *     edge-to-edge, cropping the overflow on the long axis. No black bars.
 *   - 'letterbox' (contain): (sx, sy) ≤ 1 — shrink so the source fits inside the
 *     canvas; the off-axis renders black bars (the shader clamps to black
 *     outside [0,1]).
 *
 * Degenerate inputs (zero/NaN) → (1, 1).
 */
export function aspectFitScale(
  srcAspect: number,
  dstAspect: number,
  mode: SourceFillMode,
): { sx: number; sy: number } {
  const sa = Number.isFinite(srcAspect) && srcAspect > 0 ? srcAspect : 4 / 3;
  const da = Number.isFinite(dstAspect) && dstAspect > 0 ? dstAspect : 4 / 3;
  if (mode === 'fill') {
    // Cover: scale the smaller-relative axis up so the larger overflows + crops.
    const sx = Math.max(1, sa / da);
    const sy = Math.max(1, da / sa);
    return { sx, sy };
  }
  // Letterbox/contain: shrink the off-axis so the whole source fits with bars.
  const sx = Math.min(1, sa / da);
  const sy = Math.min(1, da / sa);
  return { sx, sy };
}

/** True iff a source's native aspect matches the output aspect (within a small
 *  tolerance) — the "Native" badge condition (../p10entrancer
 *  PadFillModeToggle.swift `isNative`). When native there's nothing to fit, so
 *  fill and letterbox are identical and the toggle is replaced by an "N" badge. */
export function isNativeAspect(srcAspect: number, dstAspect: number): boolean {
  if (!(srcAspect > 0) || !(dstAspect > 0)) return false;
  return Math.abs(srcAspect - dstAspect) < 0.02;
}
