// packages/web/src/lib/audio/modules/foxy-map.ts
//
// FOXY — pure, table-testable bridge math for the
//   SWOLEVCO → RASTERIZE → RUTTETRA(XYZ) → realtime-wavetable → WAVECEL
// signal chain. This file owns the two deterministic transforms that turn
// the on-card video field into an animated wavetable, kept side-effect-free
// so the unit tests can pin them without a canvas, a GL context, or an
// AudioContext.
//
// Two stages live here:
//
//   1. simplifiedRuttetraField() — a LEAN, CPU-side mirror of the RUTTETRA
//      "XYZ" forward-scatter scope. The authentic RUTTETRA (video/modules/
//      ruttetra.ts) runs as WebGL2 line geometry inside the VIDEO engine.
//      FOXY is an AUDIO module, so we do NOT stand up a GL context inside
//      it. Instead we reuse RUTTETRA's pure `shapedRamp` math + the same
//      luma-displacement model to compute a 256×256 HEIGHT FIELD on the CPU
//      from the downsampled raster luma. The on-card "XYZ" window renders
//      this field as scanlines (foxy-draw.ts), exactly the look RUTTETRA
//      gives, just at small size + reduced segment count for perf.
//
//   2. fieldToWavetable() — the realtime XYZ→wavetable conversion. Reads the
//      256×256 field as FRAMES × SAMPLES (each ROW → one frame, each COLUMN →
//      one sample index) and maps the field value (which is already in a
//      bipolar [-1,1]-ish range — see below) to a wavetable sample in
//      [-1, 1]. Row-downsampling collapses the 256 source rows into N frames
//      so we never post a full 65k-number table to the WAVECEL worklet.
//
// PERF NOTE (flagged for the owner): the recommended full 256×256 → 64×256
// table is 16,384 numbers per `loadWavetable`. The module THROTTLES the post
// to ~24 Hz (foxy.ts), well under the 60fps render rate, and the field math
// here is O(rows×cols) with cheap per-cell arithmetic. See foxy.ts for the
// throttle + the readback strategy.

import { shapedRamp } from '$lib/video/modules/ruttetra';

/** The downsampled raster resolution the spec mandates feeding RUTTETRA. */
export const FOXY_FIELD_SIZE = 256;

/** Wavetable dims chosen for perf (see header). 64 frames keeps the
 *  `loadWavetable` payload at 64×256 = 16,384 numbers; throttled to ~24 Hz
 *  in foxy.ts. WAVECEL's native frame size is 256 (WAVECEL_FRAME_SIZE), so
 *  256 samples/frame needs no resampling on the worklet side. */
export const FOXY_WT_FRAMES = 64;
export const FOXY_WT_SAMPLES = 256;

/** Params that steer the simplified XYZ field. Mirror the subset of
 *  RUTTETRA params FOXY exposes on its "XYZ" window. */
export interface FoxyXyzParams {
  /** Morph for the X shaped ramp (0=linear … 1=radial). */
  xShape: number;
  /** Morph for the Y shaped ramp. */
  yShape: number;
  /** Vertical luma displacement amount (the headline Rutt-Etra heightmap
   *  knob). Bipolar; negative pushes bright pixels UP like the real one. */
  yDisp: number;
}

export const FOXY_XYZ_DEFAULTS: FoxyXyzParams = {
  xShape: 0,
  // Soft vertical bow so the XYZ window reads as 3D terrain out of the box.
  yShape: 0.2,
  // Negative = bright pushes up (matches RUTTETRA's -0.3 default character).
  yDisp: -0.5,
};

/**
 * Sample 8-bit luminance from an RGBA framebuffer at (col,row) on a
 * `srcW × srcH` grid, BILINEAR-free nearest read (the source is the raster
 * painter's own buffer, already pixel-art). Returns luma in [0,1].
 *
 * Pure helper exported for the unit test (deterministic given a buffer).
 */
export function lumaAt(
  rgba: Uint8ClampedArray | readonly number[],
  srcW: number,
  srcH: number,
  col: number,
  row: number,
): number {
  const x = Math.max(0, Math.min(srcW - 1, Math.round(col)));
  const y = Math.max(0, Math.min(srcH - 1, Math.round(row)));
  const o = (y * srcW + x) * 4;
  const r = (rgba[o] ?? 0) / 255;
  const g = (rgba[o + 1] ?? 0) / 255;
  const b = (rgba[o + 2] ?? 0) / 255;
  // Rec.601 luma — same weights RUTTETRA's vertex shader uses.
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** One scanline of the simplified XYZ field: for each column we keep the
 *  base vertical position `v` (the shaped ramp) and the luma-displaced
 *  height `y`, both in [0,1] field space (y-down). foxy-draw.ts strokes
 *  these as a polyline; fieldToWavetable reads the bipolar displacement. */
export interface FoxyFieldRow {
  /** Per-column displaced Y in [0,1] (y-down, like the GL NDC pre-flip). */
  y: Float32Array;
  /** Per-column luma in [0,1] (for the stroke brightness / color). */
  lum: Float32Array;
}

// ── The "Box" 3D heightfield ──────────────────────────────────────────────
//
// FOXY v2 is no longer "flat": instead of ONE raster's own luma driving the
// height, we now combine TWO rasters. Raster A is the TERRAIN PATTERN (its
// luma is the surface base value / shading); raster B's per-pixel LUMINOSITY
// is the VERTICAL HEIGHT (Z displacement) that lifts A's surface into 3D. So
// for each (x,y): base = lumaA(x,y) is "what the pixel looks like", and
// height = lumaB(x,y) is "how high that pixel sticks up". The wavetable is
// then sampled from this displaced surface, so successive frames vary in BOTH
// pattern (A) and height (B) → a genuinely 3D table, not a single-raster
// heightmap.

/** A combined Box surface: parallel base + height grids, row-major
 *  `size × size`. Pure data so the unit tests can pin the combine math. */
export interface FoxyBox {
  size: number;
  /** Raster A luma per cell in [0,1] — the terrain pattern / surface shade. */
  base: Float32Array;
  /** Raster B luma per cell in [0,1] — the Z height that lifts A into 3D. */
  height: Float32Array;
}

/**
 * Combine two RGBA rasters into the Box 3D heightfield.
 *
 * Raster A supplies the BASE value (its own luma — the terrain pattern that
 * gets shaded), raster B supplies the HEIGHT (its luma — the Z displacement
 * that lifts A). Both are sampled on the same `size × size` grid (nearest
 * read via lumaAt). Pure + deterministic: same buffers → same Box.
 *
 * Either buffer may be empty/short; lumaAt clamps + defaults missing channels
 * to 0, so a cold raster reads as 0 luma (flat / no lift) rather than NaN.
 */
export function boxHeightfield(
  rgbaA: Uint8ClampedArray | readonly number[],
  rgbaB: Uint8ClampedArray | readonly number[],
  srcW: number,
  srcH: number,
  size = FOXY_FIELD_SIZE,
): FoxyBox {
  const base = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  for (let r = 0; r < size; r++) {
    const v0 = size > 1 ? r / (size - 1) : 0;
    const srcRow = v0 * (srcH - 1);
    for (let c = 0; c < size; c++) {
      const h0 = size > 1 ? c / (size - 1) : 0;
      const srcCol = h0 * (srcW - 1);
      const o = r * size + c;
      base[o] = lumaAt(rgbaA, srcW, srcH, srcCol, srcRow);
      height[o] = lumaAt(rgbaB, srcW, srcH, srcCol, srcRow);
    }
  }
  return { size, base, height };
}

/**
 * Compute the simplified RUTTETRA "XYZ" field from a downsampled raster.
 *
 * `rgba` is an RGBA8 buffer of size `srcW × srcH` (the spec's 256×256
 * downsample). We walk a `rows × cols` grid (defaults to the full field),
 * read luma per grid point, compute the shaped H/V base ramp via RUTTETRA's
 * `shapedRamp`, then displace Y by (luma - 0.5) * yDisp — IDENTICAL to the
 * authentic shader's `y = v + (lum - 0.5) * uYDisp`. We DROP the X
 * displacement + frequency/phase/tint controls the full module has (that's
 * the "simplified" part — flagged): the small window doesn't need them and
 * the wavetable only reads the Y heightmap.
 *
 * Returns one FoxyFieldRow per grid row. Pure + deterministic.
 */
export function simplifiedRuttetraField(
  rgba: Uint8ClampedArray | readonly number[],
  srcW: number,
  srcH: number,
  params: FoxyXyzParams,
  rows = FOXY_FIELD_SIZE,
  cols = FOXY_FIELD_SIZE,
): FoxyFieldRow[] {
  const out: FoxyFieldRow[] = [];
  for (let r = 0; r < rows; r++) {
    const v0 = rows > 1 ? r / (rows - 1) : 0;
    const yArr = new Float32Array(cols);
    const lArr = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      const h0 = cols > 1 ? c / (cols - 1) : 0;
      // Map grid point → source pixel. The raster is srcW×srcH; the grid is
      // rows×cols (here equal, but kept general).
      const srcCol = h0 * (srcW - 1);
      const srcRow = v0 * (srcH - 1);
      const lum = lumaAt(rgba, srcW, srcH, srcCol, srcRow);
      // Shaped base ramps (reused from RUTTETRA so the look matches).
      const v = shapedRamp(v0, h0, v0, params.yShape);
      // The X shaped ramp influences nothing the wavetable reads, but we
      // fold a little of it into the luma so xShape still has a visible
      // effect in the XYZ window (keeps the knob meaningful).
      const hShade = shapedRamp(h0, h0, v0, params.xShape);
      const y = v + (lum - 0.5) * params.yDisp;
      yArr[c] = y;
      lArr[c] = Math.max(0, Math.min(1, lum * (0.6 + 0.4 * hShade)));
    }
    out.push({ y: yArr, lum: lArr });
  }
  return out;
}

/**
 * Convert the Box heightfield into the simplified XYZ scanline field.
 *
 * This is the v2 path that feeds the XYZ stage. Unlike simplifiedRuttetraField
 * (which displaced a single raster by ITS OWN luma), here the displacement is
 * driven by raster B's HEIGHT while the stroke shading (`lum`) reads raster
 * A's BASE pattern. So:
 *
 *   y   = v + (heightB - 0.5) * yDisp     ← B luma lifts the surface (Z)
 *   lum = baseA * (0.6 + 0.4*hShade)      ← A is the terrain shown/shaded
 *
 * Because B and A are independent images, the height variation no longer
 * tracks the pattern — the surface gets REAL 3D relief (bright B → tall, dark
 * B → low) over A's terrain. Pure + deterministic.
 */
export function boxToField(
  box: FoxyBox,
  params: FoxyXyzParams,
  rows = FOXY_FIELD_SIZE,
  cols = FOXY_FIELD_SIZE,
): FoxyFieldRow[] {
  const out: FoxyFieldRow[] = [];
  const size = box.size;
  for (let r = 0; r < rows; r++) {
    const v0 = rows > 1 ? r / (rows - 1) : 0;
    const br = size > 1 ? Math.round(v0 * (size - 1)) : 0;
    const yArr = new Float32Array(cols);
    const lArr = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      const h0 = cols > 1 ? c / (cols - 1) : 0;
      const bc = size > 1 ? Math.round(h0 * (size - 1)) : 0;
      const o = br * size + bc;
      const baseA = box.base[o] ?? 0;
      const heightB = box.height[o] ?? 0;
      const v = shapedRamp(v0, h0, v0, params.yShape);
      const hShade = shapedRamp(h0, h0, v0, params.xShape);
      // B's luminosity drives the vertical height of A's surface.
      const y = v + (heightB - 0.5) * params.yDisp;
      yArr[c] = y;
      lArr[c] = Math.max(0, Math.min(1, baseA * (0.6 + 0.4 * hShade)));
    }
    out.push({ y: yArr, lum: lArr });
  }
  return out;
}

/**
 * Realtime XYZ → wavetable conversion.
 *
 * Reads the simplified field as `frames × samples`. Each output FRAME is one
 * (row-averaged) scanline of the field; each SAMPLE in the frame is one
 * column. The wavetable sample value is the field's BIPOLAR vertical
 * DISPLACEMENT: we take the displaced Y minus its base ramp center (0.5) and
 * scale into [-1, 1]. Bright raster pixels (which pushed the scanline up via
 * yDisp) become positive wavetable excursions; dark pixels negative.
 *
 * Frame count `frames` (default 64) is ≤ the field's row count, so we
 * AVERAGE every `rowsPerFrame` source rows into one frame (box downsample —
 * cheap + anti-aliases the row axis). Sample count `samples` (default 256)
 * equals the field column count so no column resampling is needed.
 *
 * All output values are CLAMPED to [-1, 1] (WAVECEL expects normalized
 * frames). Returns plain number[][] (the `loadWavetable` wire format —
 * never Float32Array, never Yjs proxies; see wavecel.ts PR-94 note).
 *
 * Pure + deterministic: same field + dims → same frames.
 */
export function fieldToWavetable(
  field: FoxyFieldRow[],
  frames = FOXY_WT_FRAMES,
  samples = FOXY_WT_SAMPLES,
): number[][] {
  const out: number[][] = [];
  const srcRows = field.length;
  if (srcRows === 0) {
    // Degenerate: emit a flat table so WAVECEL still has something valid.
    for (let f = 0; f < frames; f++) out.push(new Array(samples).fill(0));
    return out;
  }
  const srcCols = field[0]!.y.length;
  for (let f = 0; f < frames; f++) {
    // Which source rows map into this frame (box average).
    const r0 = Math.floor((f / frames) * srcRows);
    const r1 = Math.max(r0 + 1, Math.floor(((f + 1) / frames) * srcRows));
    const frame = new Array<number>(samples);
    for (let s = 0; s < samples; s++) {
      // Column index (nearest — cols == samples by default so exact).
      const col = srcCols > 1 ? Math.round((s / (samples - 1)) * (srcCols - 1)) : 0;
      let acc = 0;
      let n = 0;
      for (let r = r0; r < r1 && r < srcRows; r++) {
        const yv = field[r]!.y[col] ?? 0.5;
        // Displacement about the 0.5 base center → bipolar; ×2 so a full
        // 0..1 swing reaches ±1. Clamp to WAVECEL's [-1,1] expectation.
        const samp = (yv - 0.5) * 2;
        acc += samp;
        n++;
      }
      const v = n > 0 ? acc / n : 0;
      frame[s] = v < -1 ? -1 : v > 1 ? 1 : v;
    }
    out.push(frame);
  }
  return out;
}

/** Stable cheap signature of a wavetable for change-detection (avoid
 *  re-posting an identical table to the worklet). Samples a sparse set of
 *  cells so it's O(frames) not O(frames×samples). */
export function wavetableSignature(frames: number[][]): string {
  if (frames.length === 0) return 'empty';
  const probes: number[] = [];
  const mid = frames[0]!.length >> 1;
  for (let f = 0; f < frames.length; f += Math.max(1, frames.length >> 3)) {
    probes.push(Math.round((frames[f]![mid] ?? 0) * 1000));
  }
  return `${frames.length}x${frames[0]!.length}:${probes.join(',')}`;
}
