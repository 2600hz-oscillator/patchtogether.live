// packages/web/src/lib/video/crop-core.ts
//
// REUSABLE crop-rectangle model + math for video modules. A "crop" is a
// resizable, aspect-locked rectangle over a module's OUTPUT frame; the module's
// Crop output re-samples that sub-rectangle at full output resolution (a zoom).
// VIDEOVARISPEED wires it up first; this core is deliberately MODULE-AGNOSTIC so
// other video modules can adopt the same Crop output + overlay later (see
// crop-render.ts for the GL pass + ui/video/CropOverlay.svelte for the editor).
//
// GL-free + side-effect free so it unit-tests deterministically
// (crop-core.test.ts) — the same discipline as loopback-crop.ts / mappy-hit.ts.
//
// ── Coordinate model ──────────────────────────────────────────────────────
// The crop rect is stored NORMALIZED on node.data, TOP-LEFT origin, y-DOWN
// (image/screen convention, matching the overlay's pointer space):
//   x, y  ∈ [0,1]  — the rect's top-left corner, as a fraction of the frame
//   w     ∈ (0,1]  — the rect's width, as a fraction of the frame width
// The HEIGHT is DERIVED (never stored) so the cropped REGION keeps a locked
// aspect. In a normalized frame whose real display aspect is `frameAspect`
// (width/height) a rect of normalized size (w,h) has real aspect
//   region = (w·frameW)/(h·frameH) = (w/h)·frameAspect
// so to pin region === `regionAspect`:
//   h = w · frameAspect / regionAspect.
// For VIDEOVARISPEED the crop samples the module's OWN output frame, so
// frameAspect === regionAspect === the live output aspect ⇒ h = w (a
// normalized SQUARE, which on an output-aspect frame IS an output-aspect
// region). Keeping the two aspects as explicit inputs makes the core general:
// a future module whose editing frame aspect differs from its output aspect
// gets a correct non-square rect for free.
//
// ── GL sample window ──────────────────────────────────────────────────────
// cropSampleWindow() flips the stored (y-down) rect into the GL sample space
// (y-up) the render pass windows into — the same y-flip loopback-crop bakes in,
// pinned here by a unit test.

/** A stored crop rectangle (normalized, top-left origin, y-down). Height is
 *  derived from the width + the locked aspect and is NEVER stored. */
export interface CropRect {
  /** Left edge, fraction of frame width [0,1]. */
  x: number;
  /** Top edge, fraction of frame height [0,1] (y-down). */
  y: number;
  /** Width, fraction of frame width (0,1]. */
  w: number;
}

/** Persisted crop state on node.data. `active` false ⇒ the Crop output passes
 *  the full frame through (never black; keeps the output alive). ONE per node. */
export interface CropState {
  active: boolean;
  rect: CropRect;
}

/** A crop rect resolved to explicit edges (top-left origin, y-down) — the shape
 *  the overlay draws + the render pass windows. */
export interface ResolvedCrop {
  x: number;
  y: number;
  w: number;
  /** Derived height (fraction of frame height). */
  h: number;
}

/** GL sample window (y-UP) into the source texture. */
export interface CropSampleWindow {
  /** Left sample-UV bound. */
  u0: number;
  /** Bottom sample-UV bound (y-up). */
  v0: number;
  /** Sample-UV width. */
  w: number;
  /** Sample-UV height. */
  h: number;
}

/** The default "add crop" width — a centered rect at ~50% of the frame width. */
export const DEFAULT_CROP_W = 0.5;

/** Smallest allowed crop width/height (keeps the rect grabbable + avoids a
 *  degenerate zero-area sample). */
export const MIN_CROP = 0.05;

/** Full-frame passthrough window — the Crop output when no crop is defined. */
export const FULL_FRAME_WINDOW: CropSampleWindow = { u0: 0, v0: 0, w: 1, h: 1 };

function clampNum(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function finiteOr(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Derive the crop's normalized HEIGHT from its width so the cropped REGION has
 *  `regionAspect` (width/height) when the rect lives in a normalized frame whose
 *  real display aspect is `frameAspect`. h = w · frameAspect / regionAspect.
 *  Both aspects must be > 0; a non-positive/garbage aspect degrades to h = w. */
export function deriveCropHeight(w: number, frameAspect: number, regionAspect: number): number {
  if (!(frameAspect > 0) || !(regionAspect > 0)) return w;
  return w * (frameAspect / regionAspect);
}

/** Inverse of deriveCropHeight — the width that yields normalized height `h`. */
export function widthForCropHeight(h: number, frameAspect: number, regionAspect: number): number {
  if (!(frameAspect > 0) || !(regionAspect > 0)) return h;
  return h * (regionAspect / frameAspect);
}

/**
 * FIT a requested rect fully inside the unit frame at the locked aspect,
 * preserving its CENTER as far as possible:
 *   1. clamp the width to [MIN_CROP, 1];
 *   2. derive the height; if it exceeds 1, shrink the width so height === 1;
 *   3. place the (now guaranteed ≤1×1) rect at the requested center, then clamp
 *      the top-left so both edges stay inside [0,1].
 * Garbage / non-finite inputs collapse to a centered default-width rect.
 */
export function fitCrop(rect: CropRect, frameAspect: number, regionAspect: number): CropRect {
  const reqW = clampNum(finiteOr(rect.w, DEFAULT_CROP_W), MIN_CROP, 1);
  let w = reqW;
  let h = deriveCropHeight(w, frameAspect, regionAspect);
  if (h > 1) {
    // Too tall — shrink the width until the derived height just fits.
    w = clampNum(widthForCropHeight(1, frameAspect, regionAspect), MIN_CROP, 1);
    h = deriveCropHeight(w, frameAspect, regionAspect);
  }
  // Requested center, from the requested (pre-shrink) rect.
  const reqH = deriveCropHeight(reqW, frameAspect, regionAspect);
  const cx = finiteOr(rect.x, (1 - reqW) / 2) + reqW / 2;
  const cy = finiteOr(rect.y, (1 - reqH) / 2) + reqH / 2;
  const x = clampNum(cx - w / 2, 0, 1 - w);
  const y = clampNum(cy - h / 2, 0, 1 - h);
  return { x, y, w };
}

/** A centered crop rect of the given normalized width, fitted to the frame. */
export function defaultCropRect(
  frameAspect: number,
  regionAspect: number,
  width = DEFAULT_CROP_W,
): CropRect {
  const w = clampNum(width, MIN_CROP, 1);
  const h = deriveCropHeight(w, frameAspect, regionAspect);
  return fitCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w }, frameAspect, regionAspect);
}

/**
 * RE-FIT on an output-mode flip (16:9 ↔ 4:3): preserve the rect's center +
 * width, recompute the height for the new aspect, and clamp back inside the
 * frame. For a module where frameAspect === regionAspect (VIDEOVARISPEED) the
 * height is unchanged and this is a clamp; for a decoupled module the height
 * genuinely changes. Identical to fitCrop given the same requested width — kept
 * as a named entry point so the call site reads intentionally.
 */
export function refitCrop(rect: CropRect, frameAspect: number, regionAspect: number): CropRect {
  return fitCrop(rect, frameAspect, regionAspect);
}

/** Coerce arbitrary (possibly garbage / partial / undefined) stored crop data
 *  into a valid CropState whose rect is fully inside the frame at the locked
 *  aspect. The single reader of node.data.crop. */
export function coerceCrop(raw: unknown, frameAspect: number, regionAspect: number): CropState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const active = o.active === true;
  const rect = fitCrop(
    { x: finiteOr(o.x, 0), y: finiteOr(o.y, 0), w: finiteOr(o.w, DEFAULT_CROP_W) },
    frameAspect,
    regionAspect,
  );
  return { active, rect };
}

/** Resolve a stored rect to explicit edges + derived height (overlay + render). */
export function resolveCrop(rect: CropRect, frameAspect: number, regionAspect: number): ResolvedCrop {
  const h = deriveCropHeight(rect.w, frameAspect, regionAspect);
  return { x: rect.x, y: rect.y, w: rect.w, h };
}

/** True iff a state renders the FULL frame (inactive, or a rect covering it). */
export function cropIsPassthrough(
  state: CropState,
  frameAspect: number,
  regionAspect: number,
): boolean {
  if (!state.active) return true;
  const r = resolveCrop(state.rect, frameAspect, regionAspect);
  return r.x <= 1e-4 && r.y <= 1e-4 && r.w >= 1 - 1e-4 && r.h >= 1 - 1e-4;
}

/** Map a resolved rect (y-down) to the GL sample window (y-up) the render pass
 *  windows into. Passthrough (x=0,y=0,w=1,h=1) → the full frame. */
export function cropSampleWindow(resolved: ResolvedCrop): CropSampleWindow {
  return {
    u0: resolved.x,
    v0: 1 - (resolved.y + resolved.h),
    w: resolved.w,
    h: resolved.h,
  };
}

/** Corner indices, matching the overlay handles: 0=TL, 1=TR, 2=BR, 3=BL. */
export type CropCorner = 0 | 1 | 2 | 3;

/**
 * Aspect-LOCKED corner resize. The corner OPPOSITE the dragged one stays pinned;
 * the new width is driven by the pointer's horizontal distance to that pinned x
 * (so the aspect stays locked — the height follows from the aspect, never from
 * the pointer's y). Returns a fitted rect.
 *
 * `resolvedH` is the rect's current derived height (so we know its live edges).
 */
export function resizeCropCorner(
  rect: CropRect,
  resolvedH: number,
  corner: CropCorner,
  pointerX: number,
  frameAspect: number,
  regionAspect: number,
): CropRect {
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + resolvedH;
  // The pinned corner is the OPPOSITE of the dragged one.
  let fixedX: number;
  let fixedY: number;
  switch (corner) {
    case 0: fixedX = x1; fixedY = y1; break; // drag TL → pin BR
    case 1: fixedX = x0; fixedY = y1; break; // drag TR → pin BL
    case 2: fixedX = x0; fixedY = y0; break; // drag BR → pin TL
    case 3: default: fixedX = x1; fixedY = y0; break; // drag BL → pin TR
  }
  let w = clampNum(Math.abs(finiteOr(pointerX, fixedX) - fixedX), MIN_CROP, 1);
  let h = deriveCropHeight(w, frameAspect, regionAspect);
  if (h > 1) {
    w = clampNum(widthForCropHeight(1, frameAspect, regionAspect), MIN_CROP, 1);
    h = deriveCropHeight(w, frameAspect, regionAspect);
  }
  const movingLeft = corner === 0 || corner === 3; // TL / BL move the left edge
  const movingTop = corner === 0 || corner === 1; // TL / TR move the top edge
  const x = movingLeft ? fixedX - w : fixedX;
  const y = movingTop ? fixedY - h : fixedY;
  return fitCrop({ x, y, w }, frameAspect, regionAspect);
}

/** Translate the whole rect by (dx,dy) in normalized frame units, clamped so it
 *  stays fully inside the frame (width + derived height preserved). */
export function translateCrop(
  rect: CropRect,
  dx: number,
  dy: number,
  frameAspect: number,
  regionAspect: number,
): CropRect {
  const h = deriveCropHeight(rect.w, frameAspect, regionAspect);
  const x = clampNum(finiteOr(rect.x + dx, rect.x), 0, 1 - rect.w);
  const y = clampNum(finiteOr(rect.y + dy, rect.y), 0, 1 - h);
  return { x, y, w: rect.w };
}
