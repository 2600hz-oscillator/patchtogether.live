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
 *
 * @deprecated v3 (3-axis distribution wavetable) replaced the Box heightfield
 *   path. Kept for back-compat + reference; `threeAxisWavetable` is now the
 *   realtime path FOXY's bridge calls.
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
 *
 * @deprecated v3 routes the realtime path through `threeAxisWavetable` +
 *   `threeAxisFieldForDisplay`. Kept for back-compat + the legacy test suite.
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
 *
 * @deprecated v3 replaced this with `threeAxisWavetable` (X = raster A's
 *   column distribution, Y = raster B's row distribution, Z = raster C as a
 *   1-D amplitude LUT). Kept exported for back-compat + the legacy unit tests.
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

// ── v3: 3-axis distribution wavetable ─────────────────────────────────────
//
// FOXY v3 replaces the Box heightfield with a 3-axis DISTRIBUTION model. Each
// of the three rasters projects to a 1-D distribution; the wavetable cell
// (frame f, sample s) is built by SUMMING the bipolar X and Y projections and
// then RESHAPING the amplitude through Z. So instead of one raster pattern
// "lifted" by another, all three rasters jointly redistribute data along the
// wavetable's three axes:
//
//   • X axis (sample s) = raster A's COLUMN-mean luma → xDist[s]
//   • Y axis (frame  f) = raster B's ROW-mean    luma → yDist[f]
//   • Z axis (amplitude) = raster C's COLUMN-mean luma → zLut[k] (1-D LUT)
//
// raw   (f,s) = (xDist[s] - 0.5) + (yDist[f] - 0.5)        ∈ [-1, 1]
// shaped(f,s) = applyZLut(raw, zLut)                       ∈ [-1, 1]
//
// Why this shape? It keeps each raster's contribution INDEPENDENT (no cross-
// pixel coupling), so the three sources read as three orthogonal axes the
// user can dial separately, and the math is O(frames + samples) instead of
// O(frames × samples × resamples). Z as a LUT means C acts as a waveSHAPER
// over the amplitude axis: bright C cells push the signal toward ±1, dark C
// cells compress it toward 0.

/**
 * Project an RGBA buffer onto a 1-D distribution along either the COLUMN
 * (mean of each column → length-`len` array indexed by horizontal position)
 * or the ROW (mean of each row → length-`len` array indexed by vertical
 * position) axis.
 *
 * Pure + deterministic. Empty/short buffer ⇒ all 0.5 so downstream math sees
 * a "neutral" distribution (xDist 0.5 + yDist 0.5 → raw 0 → silence, not NaN).
 *
 * `axis = 'col'` averages each source COLUMN's luma over its rows then maps
 * the source's `srcW` columns to `len` output bins (nearest). `axis = 'row'`
 * does the same with rows ↔ columns.
 */
export function axisDistribution(
  rgba: Uint8ClampedArray | readonly number[],
  srcW: number,
  srcH: number,
  len: number,
  axis: 'col' | 'row',
): Float32Array {
  const out = new Float32Array(len);
  // Empty / undersized buffer: neutral 0.5 distribution.
  const needed = srcW * srcH * 4;
  if (!rgba || rgba.length < 4 || srcW <= 0 || srcH <= 0 || len <= 0 || rgba.length < needed) {
    for (let i = 0; i < len; i++) out[i] = 0.5;
    return out;
  }
  if (axis === 'col') {
    // Average each source column over rows → 0..srcW-1 distribution, then
    // resample to `len` bins (nearest).
    const colMeans = new Float32Array(srcW);
    for (let x = 0; x < srcW; x++) {
      let acc = 0;
      for (let y = 0; y < srcH; y++) acc += lumaAt(rgba, srcW, srcH, x, y);
      colMeans[x] = acc / srcH;
    }
    for (let i = 0; i < len; i++) {
      const src = len > 1 ? Math.round((i / (len - 1)) * (srcW - 1)) : 0;
      out[i] = colMeans[src] ?? 0.5;
    }
  } else {
    const rowMeans = new Float32Array(srcH);
    for (let y = 0; y < srcH; y++) {
      let acc = 0;
      for (let x = 0; x < srcW; x++) acc += lumaAt(rgba, srcW, srcH, x, y);
      rowMeans[y] = acc / srcW;
    }
    for (let i = 0; i < len; i++) {
      const src = len > 1 ? Math.round((i / (len - 1)) * (srcH - 1)) : 0;
      out[i] = rowMeans[src] ?? 0.5;
    }
  }
  return out;
}

/**
 * Reshape a bipolar raw value through the Z LUT (raster C's column
 * distribution). Maps raw ∈ [-1, 1] → unipolar u = (raw + 1) / 2 → LUT index
 * (nearest) → bipolar output (lut[idx] - 0.5) * 2.
 *
 * Identity LUT (`lut[k] = k / (len - 1)`) → output == raw. Flat LUT
 * (`lut[k] = 0.5`) → output == 0 always.
 *
 * Pure 1-line helper, exported for unit testing.
 */
export function applyZLut(raw: number, lut: Float32Array | readonly number[]): number {
  const n = lut.length;
  if (n === 0) return 0;
  const u = (raw + 1) * 0.5;
  const cu = u < 0 ? 0 : u > 1 ? 1 : u;
  const idx = n > 1 ? Math.round(cu * (n - 1)) : 0;
  return ((lut[idx] ?? 0.5) - 0.5) * 2;
}

/**
 * Build the v3 wavetable as `frames × samples` from the three axis
 * distributions.
 *
 *   cell(f, s) = clamp(applyZLut((xDist[s] - 0.5) + (yDist[f] - 0.5), zLut), -1, 1)
 *
 * Dims are determined by `frames` × `samples`, NOT the input distribution
 * lengths — distributions are nearest-sampled into the wavetable axes.
 *
 * Wire format: plain `number[][]` (matches `loadWavetable`'s shape — never
 * Float32Array, never Yjs proxies). Pure + deterministic.
 */
export function threeAxisWavetable(
  xDist: Float32Array | readonly number[],
  yDist: Float32Array | readonly number[],
  zLut: Float32Array | readonly number[],
  frames = FOXY_WT_FRAMES,
  samples = FOXY_WT_SAMPLES,
): number[][] {
  const out: number[][] = [];
  const xn = xDist.length, yn = yDist.length;
  for (let f = 0; f < frames; f++) {
    const yi = yn > 1 ? Math.round((f / Math.max(1, frames - 1)) * (yn - 1)) : 0;
    const yv = (yDist[yi] ?? 0.5) - 0.5;
    const frame = new Array<number>(samples);
    for (let s = 0; s < samples; s++) {
      const xi = xn > 1 ? Math.round((s / Math.max(1, samples - 1)) * (xn - 1)) : 0;
      const xv = (xDist[xi] ?? 0.5) - 0.5;
      const raw = xv + yv;
      const shaped = applyZLut(raw, zLut);
      frame[s] = shaped < -1 ? -1 : shaped > 1 ? 1 : shaped;
    }
    out.push(frame);
  }
  return out;
}

/**
 * Convert the v3 wavetable back into a FoxyFieldRow[] for the on-card XYZ
 * scope. Per frame, `y[s] = (wavetable[f][s] + 1) / 2` (re-pack bipolar
 * audio → [0,1] field space, y-down like the legacy XYZ window) and
 * `lum[s] = xDist[s]` (so stroke shading reads raster A's column projection).
 *
 * This keeps the XYZ display showing the ACTUAL audio data the worklet sees,
 * not a separate heightfield computation.
 */
export function threeAxisFieldForDisplay(
  wavetable: number[][],
  xDist: Float32Array | readonly number[],
): FoxyFieldRow[] {
  const out: FoxyFieldRow[] = [];
  if (wavetable.length === 0) return out;
  const samples = wavetable[0]!.length;
  const xn = xDist.length;
  // Pre-sample xDist onto the output sample axis so all rows share the same
  // lum (it's column-keyed, not frame-keyed — that's the X-axis interp).
  const lumShared = new Float32Array(samples);
  for (let s = 0; s < samples; s++) {
    const xi = xn > 1 ? Math.round((s / Math.max(1, samples - 1)) * (xn - 1)) : 0;
    lumShared[s] = xDist[xi] ?? 0.5;
  }
  for (let f = 0; f < wavetable.length; f++) {
    const src = wavetable[f]!;
    const y = new Float32Array(samples);
    for (let s = 0; s < samples; s++) {
      const v = (src[s] ?? 0) * 0.5 + 0.5;
      y[s] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    out.push({ y, lum: lumShared });
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
