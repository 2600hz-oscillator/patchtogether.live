// packages/web/src/lib/video/modules/cellshade.ts
//
// CELLSHADE — real cel-shader (toon) video PROCESSOR. Total rebuild
// (design + findings: .myrobots/plans/cellshade-rebuild-2026-07-11.md).
//
// The canonical live-video cel pipeline (Winnemöller, Olsen & Gooch,
// "Real-Time Video Abstraction", SIGGRAPH 2006) is: (1) edge-preserving
// smoothing → large flat hand-painted regions, (2) SOFT quantization of the
// LUMINANCE channel only (chroma is never quantized — hue rides through, so
// a band is a flat TONAL step of consistent hue), (3) dark contour lines
// composited on top. The previous engine (PR #695) banded HSV V = max(R,G,B)
// instead of luminance, posterized hue with a linear quantizer on a circular
// quantity (the whole hue wheel collapsed to {red, cyan} at the default),
// binarized saturation (skin → gray), had zero smoothing and hard floor()
// bands — findings F-CS1..F-CS7, all fixed here by construction.
//
// ── Pipeline: 4 passes, single module (FADER/B3NTB0X multi-FBO precedent) ──
//
//   in ──► P1 bilateralH ──► P2 bilateralV ──► P3 quantizeY ──► P4 ink ──► out
//            (fboA)             (fboB)            (fboC)       (out fbo)
//                                 │                               ▲
//                                 └── smoothed image for Sobel ───┘
//
//   P1/P2  Separable bilateral approximation (Winnemöller §3.1): radius 3
//          (7 taps per axis), fixed spatial σ_d = 2 px, range weight on the
//          Rec.601 luma difference with σ_r = mix(0.03, 0.4, SMOOTH).
//          SMOOTH = 0 is a TRUE bypass: the two passes are SKIPPED in JS
//          (draw() routes the raw input to P3/P4 directly) — bit-identity by
//          branch, not by limit (§12 R4).
//   P3     SOFT LUMINANCE QUANTIZATION. Y = Rec.601 luma (the SAME weights
//          the ink pass uses); Y is banded into N ∈ {2,3,4,6,8} levels with a
//          smoothstep transition of half-width w = mix(1e-3, 0.5, SOFTNESS)
//          (band units). Reconstruction is the additive luma shift
//          out = clamp(rgb + (Yq − Y)) — exactly YCbCr Y-replacement (YCbCr
//          is linear in RGB), so Cb/Cr pass through untouched and hue is
//          preserved modulo the gamut clamp. At SOFTNESS = 0 this reproduces
//          floor(Y·n)/(n−1) exactly (thresholds at i/n) — the hard-band
//          regression anchor.
//   P4     Ink: the EDGES Sobel + THRESHOLD gate + THICKNESS dilation,
//          unchanged semantics, but measured on the SMOOTHED image (sensor
//          noise no longer inks — F-CS6) and composited with a strength:
//          col = mix(quantized, black, edge · INK).
//
// CELLSHADE is STATELESS per frame — no feedback, no history; the look is a
// pure function of the current input frame + the six knobs.
//
// ── BANDS (param id `bits` — kept verbatim for zero-migration) ────────────
// One discrete knob (5 steps, index 0..4) selects the luminance band count
// {2, 3, 4, 6, 8}. The param id, 0..4 range and discrete curve are UNCHANGED
// from the old colour-depth knob, so existing patches and CV cables load with
// no migration code (the param stores the step INDEX, never a colour count).
// The retro 8/16-bit per-channel RGB posterize modes (3-3-2 / 5-6-5) were
// DROPPED — they are posterization, not cel shading (F-CS5/F-CS7); a future
// POSTERBOX module is the right home for that look.
//
// THRESHOLD / THICKNESS behave EXACTLY like EDGES (shared constants + CPU
// mirror). SOFTNESS widens the band transitions (0 = hard, 1 = near-
// continuous); SMOOTH drives the bilateral abstraction (0 = off/bypass,
// 1 = heavy flattening); INK scales the outline darkness (0 = none,
// 1 = solid black).
//
// Inputs:
//   in (video): RGB source to cel-shade.
//   threshold / thickness / bits / softness / smooth / ink (cv,
//     paramTarget=…): per-param CV (port id == param id). `bits` uses a
//     DISCRETE cvScale so the CV snaps to the 5 band-count steps.
//
// Outputs:
//   out (video): the cel-shaded frame (soft luminance bands + black ink).
//
// Every pure function below is the EXACT CPU mirror of the GLSL — the same
// source-of-truth pattern EDGES / FREEZEFRAME / MAPPER use.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  EDGES_MAX_THICKNESS,
  EDGES_LUMA_WEIGHTS,
  EDGES_SOBEL_NORM,
} from './edges';

// ----------------------------------------------------------------------
// Band model — exported for unit tests + the card readout (no GL).
// ----------------------------------------------------------------------

/** The 5 luminance band counts the BANDS knob snaps to. Index into this
 *  array == the `bits` param value (a discrete 0..4 fader — the id is the
 *  legacy colour-depth knob's, kept verbatim so saved patches + CV cables
 *  load unchanged). */
export const CELLSHADE_BAND_STEPS: readonly number[] = [2, 3, 4, 6, 8];

/** Default BANDS step index — 4 luminance bands, the classic cel read. */
export const CELLSHADE_DEFAULT_BANDS_INDEX = 2;

/** Clamp + round a raw `bits` param (possibly fractional from a CV write)
 *  to a valid step INDEX 0..4. The discrete fader + discrete cvScale both
 *  already snap, but we re-snap here so the shader/CPU-mirror always see a
 *  clean integer step (defensive against a fractional value bleeding in). */
export function cellshadeBandsIndex(rawBits: number): number {
  const n = CELLSHADE_BAND_STEPS.length;
  if (!Number.isFinite(rawBits)) return CELLSHADE_DEFAULT_BANDS_INDEX;
  return Math.max(0, Math.min(n - 1, Math.round(rawBits)));
}

/** The luminance band count (2/3/4/6/8) for a `bits` step index. */
export function cellshadeBandCount(rawBits: number): number {
  return CELLSHADE_BAND_STEPS[cellshadeBandsIndex(rawBits)]!;
}

// ----------------------------------------------------------------------
// Shared scalar helpers — transliterated 1:1 into the GLSL below.
// ----------------------------------------------------------------------

/** Rec. 601 luminance of a normalized RGB triple (each 0..1) — the SAME
 *  weights the EDGES Sobel uses, so P3's bands and P4's ink agree on what
 *  "brightness" is (the F-CS3 fix). */
export function cellshadeLuma(r: number, g: number, b: number): number {
  return (
    r * EDGES_LUMA_WEIGHTS[0] + g * EDGES_LUMA_WEIGHTS[1] + b * EDGES_LUMA_WEIGHTS[2]
  );
}

/** GLSL mix(). */
export function cellshadeMix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** GLSL smoothstep(). */
export function cellshadeSmoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ----------------------------------------------------------------------
// P1/P2 — separable bilateral (edge-preserving smoothing) mirror.
// ----------------------------------------------------------------------

/** Fixed spatial sigma of the bilateral kernel (texels). */
export const CELLSHADE_SIGMA_D = 2.0;

/** Bilateral kernel radius (taps per axis = 2·R + 1 = 7). */
export const CELLSHADE_SMOOTH_RADIUS = 3;

/** Range sigma from the SMOOTH knob: σ_r = mix(0.03, 0.4, smooth). Small
 *  σ_r keeps only near-identical luma neighbours; large σ_r flattens across
 *  bigger luma differences (still edge-preserving at strong contours). */
export function cellshadeSigmaR(smooth: number): number {
  return cellshadeMix(0.03, 0.4, clamp01(smooth));
}

/** One bilateral tap weight: spatial Gaussian over the tap offset `i` ×
 *  range Gaussian over the luma difference to the centre. */
export function cellshadeBilateralWeight(i: number, dLuma: number, sigmaR: number): number {
  return (
    Math.exp(-(i * i) / (2 * CELLSHADE_SIGMA_D * CELLSHADE_SIGMA_D)) *
    Math.exp(-(dLuma * dLuma) / (2 * sigmaR * sigmaR))
  );
}

/** Read one RGB texel from a row-major grid with CLAMP_TO_EDGE addressing. */
function texelAt(
  width: number,
  height: number,
  grid: ArrayLike<number>,
  x: number,
  y: number,
): [number, number, number] {
  const cx = Math.max(0, Math.min(width - 1, x));
  const cy = Math.max(0, Math.min(height - 1, y));
  const i = (cy * width + cx) * 3;
  return [grid[i]!, grid[i + 1]!, grid[i + 2]!];
}

/** One 1-D bilateral pass (P1 dir=(1,0) / P2 dir=(0,1)) at a single texel —
 *  exact mirror of BILATERAL_FRAG. */
function bilateral1D(
  width: number,
  height: number,
  grid: ArrayLike<number>,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  sigmaR: number,
): [number, number, number] {
  const [cr, cg, cb] = texelAt(width, height, grid, x, y);
  const lc = cellshadeLuma(cr, cg, cb);
  let wsum = 0;
  let ar = 0, ag = 0, ab = 0;
  for (let i = -CELLSHADE_SMOOTH_RADIUS; i <= CELLSHADE_SMOOTH_RADIUS; i++) {
    const [r, g, b] = texelAt(width, height, grid, x + i * dirX, y + i * dirY);
    const w = cellshadeBilateralWeight(i, cellshadeLuma(r, g, b) - lc, sigmaR);
    ar += r * w; ag += g * w; ab += b * w;
    wsum += w;
  }
  return [ar / wsum, ag / wsum, ab / wsum];
}

/** Full-grid separable bilateral (H then V), the P1→P2 chain. `smooth <= 0`
 *  returns the INPUT GRID REFERENCE unchanged — the JS-side true bypass the
 *  factory's draw() mirrors (§12 R4: identity by branch, not by limit). */
export function cellshadeSmoothGrid(
  width: number,
  height: number,
  grid: ArrayLike<number>,
  smooth: number,
): ArrayLike<number> {
  if (clamp01(smooth) <= 0) return grid;
  const sigmaR = cellshadeSigmaR(smooth);
  const h = new Float64Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = bilateral1D(width, height, grid, x, y, 1, 0, sigmaR);
      const i = (y * width + x) * 3;
      h[i] = r; h[i + 1] = g; h[i + 2] = b;
    }
  }
  const v = new Float64Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = bilateral1D(width, height, h, x, y, 0, 1, sigmaR);
      const i = (y * width + x) * 3;
      v[i] = r; v[i + 1] = g; v[i + 2] = b;
    }
  }
  return v;
}

// ----------------------------------------------------------------------
// P3 — soft luminance quantization mirror.
// ----------------------------------------------------------------------

/** Soft band-transition half-width (in BAND units) from the SOFTNESS knob:
 *  w = mix(1e-3, 0.5, softness). w is CAPPED at 0.5 by construction —
 *  beyond that adjacent smoothstep windows would overlap at band centres
 *  (the round()-tie continuity proof only holds for w ≤ 0.5). */
export function cellshadeSoftWidth(softness: number): number {
  return cellshadeMix(1e-3, 0.5, clamp01(softness));
}

/** Quantize a luminance value into `bands` levels with a soft (smoothstep)
 *  transition — the scalar heart of P3 (mirror of QUANT_FRAG):
 *
 *    x  = Y·n                 (thresholds sit at integers 1..n−1)
 *    b  = clamp(round(x), 1, n−1)      (nearest threshold)
 *    t  = smoothstep(−w, w, x − b)     (soft step across it)
 *    Yq = (b − 1 + t) / (n − 1)        (levels i/(n−1))
 *
 *  softness = 0 degenerates to floor(Y·n)/(n−1) exactly (hard bands,
 *  thresholds at i/n — the pre-rebuild band values); softness = 1
 *  approaches a continuous piecewise-linear transfer. */
export function cellshadeQuantizeLuma(y: number, bands: number, softness: number): number {
  const n = Math.max(2, Math.round(bands));
  const w = cellshadeSoftWidth(softness);
  const x = clamp01(y) * n;
  const b = Math.max(1, Math.min(n - 1, Math.round(x)));
  const t = cellshadeSmoothstep(-w, w, x - b);
  return (b - 1 + t) / (n - 1);
}

/** The full P3 texel transform: band the Rec.601 luma, keep chroma — the
 *  additive luma shift out = clamp(rgb + (Yq − Y)). Equivalent to YCbCr
 *  Y-replacement with BT.601 (YCbCr is linear in RGB: fixing Cb/Cr and
 *  moving Y by Δ moves each channel by Δ), clamped to gamut. Chroma is
 *  never quantized (F-CS1/F-CS2 fix); bands follow LUMINANCE (F-CS3 fix). */
export function cellshadeQuantizeY(
  r: number,
  g: number,
  b: number,
  rawBits: number,
  softness: number,
): [number, number, number] {
  const y = cellshadeLuma(r, g, b);
  const yq = cellshadeQuantizeLuma(y, cellshadeBandCount(rawBits), softness);
  const d = yq - y;
  return [clamp01(r + d), clamp01(g + d), clamp01(b + d)];
}

// ----------------------------------------------------------------------
// P4 — ink (EDGES Sobel + dilation + strength composite) mirror.
// ----------------------------------------------------------------------

/** Ink composite: mix(quantized, black, edge · ink) per channel. */
export function cellshadeInkComposite(
  rgb: [number, number, number],
  edge: number,
  ink: number,
): [number, number, number] {
  const k = 1 - Math.max(0, Math.min(1, edge)) * clamp01(ink);
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

export interface CellshadeParams {
  threshold: number; // 0..1 normalised gradient-magnitude ink gate (EDGES)
  thickness: number; // 1..EDGES_MAX_THICKNESS px ink stroke width (EDGES)
  bits: number;      // discrete 0..4 band-count step index (legacy id)
  softness: number;  // 0..1 band-transition half-width (0 = hard)
  smooth: number;    // 0..1 bilateral abstraction (0 = true bypass)
  ink: number;       // 0..1 outline darkness (0 = none, 1 = solid black)
}

export const CELLSHADE_DEFAULTS: CellshadeParams = {
  // EDGES' defaults so the ink reads exactly like the dedicated module.
  threshold: 0.2,
  thickness: 2,
  // 4 luminance bands — the classic cel read out of the box.
  bits: CELLSHADE_DEFAULT_BANDS_INDEX,
  softness: 0.25,
  smooth: 0.35,
  ink: 1,
};

/**
 * Pure CPU mirror of the FULL 4-pass pipeline at one texel: separable
 * bilateral (skipped entirely at smooth = 0 — the JS bypass), soft luminance
 * quantization of the smoothed image, Sobel + dilation on the SMOOTHED luma,
 * ink-strength composite. Shared by the unit tests so JS + GLSL agree on the
 * whole chain.
 *
 * @param width/height — grid dimensions.
 * @param rgbGrid      — row-major RGB grid (length width*height*3, 0..1).
 * @param x/y          — the texel under test.
 * @param params       — the six knobs (defaults merged for omitted keys).
 * @returns the output RGB triple.
 */
export function cellshadePixel(
  width: number,
  height: number,
  rgbGrid: ArrayLike<number>,
  x: number,
  y: number,
  params: Partial<CellshadeParams> = {},
): [number, number, number] {
  const p: CellshadeParams = { ...CELLSHADE_DEFAULTS, ...params };
  const smoothed = cellshadeSmoothGrid(width, height, rgbGrid, p.smooth);

  const idx = (y * width + x) * 3;
  const quant = cellshadeQuantizeY(
    smoothed[idx]!, smoothed[idx + 1]!, smoothed[idx + 2]!, p.bits, p.softness,
  );

  // Sobel on the SMOOTHED image's luminance — same algorithm + normalisation
  // as EDGES (inlined against the smoothed grid).
  const lumaAt = (ax: number, ay: number): number => {
    const [r, g, b] = texelAt(width, height, smoothed, ax, ay);
    return cellshadeLuma(r, g, b);
  };
  const radius = Math.max(0, Math.min(EDGES_MAX_THICKNESS - 1, Math.round(p.thickness) - 1));
  const isEdge = (ax: number, ay: number): boolean => {
    const tl = lumaAt(ax - 1, ay - 1), t = lumaAt(ax, ay - 1), tr = lumaAt(ax + 1, ay - 1);
    const l = lumaAt(ax - 1, ay), rr = lumaAt(ax + 1, ay);
    const bl = lumaAt(ax - 1, ay + 1), bb = lumaAt(ax, ay + 1), br = lumaAt(ax + 1, ay + 1);
    const gx = tr + 2 * rr + br - (tl + 2 * l + bl);
    const gy = bl + 2 * bb + br - (tl + 2 * t + tr);
    return Math.sqrt(gx * gx + gy * gy) / EDGES_SOBEL_NORM >= p.threshold;
  };
  let edge = 0;
  for (let dy = -radius; dy <= radius && edge === 0; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (isEdge(x + dx, y + dy)) { edge = 1; break; }
    }
  }
  return cellshadeInkComposite(quant, edge, p.ink);
}

// ----------------------------------------------------------------------
// GLSL — the 4 passes. Each fragment is the transliteration of the CPU
// mirror above (shared constants interpolated in).
// ----------------------------------------------------------------------

const GLSL_HEADER = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

const float LUMA_R = ${EDGES_LUMA_WEIGHTS[0]};
const float LUMA_G = ${EDGES_LUMA_WEIGHTS[1]};
const float LUMA_B = ${EDGES_LUMA_WEIGHTS[2]};

float luma(vec3 c) { return dot(c, vec3(LUMA_R, LUMA_G, LUMA_B)); }
`;

// P1/P2 — one program, uDir picks the axis ((1,0) = H, (0,1) = V).
const BILATERAL_FRAG = `${GLSL_HEADER}
uniform sampler2D uTex;
uniform vec2  uTexel;   // 1/resolution — one texel step in UV
uniform vec2  uDir;     // (1,0) horizontal pass, (0,1) vertical pass
uniform float uSigmaR;  // range sigma (luma units) — cellshadeSigmaR(smooth)

const float SIGMA_D = ${CELLSHADE_SIGMA_D.toFixed(1)};
const int   RADIUS  = ${CELLSHADE_SMOOTH_RADIUS};

void main() {
  float lc = luma(texture(uTex, vUv).rgb);
  float wsum = 0.0;
  vec3  acc  = vec3(0.0);
  for (int i = -RADIUS; i <= RADIUS; i++) {
    vec2 off = uTexel * uDir * float(i);
    vec3 c = texture(uTex, vUv + off).rgb;
    float dl = luma(c) - lc;
    float w = exp(-float(i * i) / (2.0 * SIGMA_D * SIGMA_D))
            * exp(-(dl * dl) / (2.0 * uSigmaR * uSigmaR));
    acc += c * w;
    wsum += w;
  }
  outColor = vec4(acc / max(wsum, 1e-6), 1.0);
}`;

// P3 — soft luminance quantization (mirror cellshadeQuantizeLuma /
// cellshadeQuantizeY). Chroma passes through via the additive luma shift.
const QUANT_FRAG = `${GLSL_HEADER}
uniform sampler2D uTex;    // the smoothed image (or the raw input when P1/P2
                           // are bypassed at smooth == 0)
uniform float uBands;      // luminance band count n (2..8)
uniform float uSoftW;      // soft half-width w — cellshadeSoftWidth(softness)

void main() {
  vec3  c  = texture(uTex, vUv).rgb;
  float Y  = luma(c);
  float n  = uBands;
  float x  = Y * n;
  float b  = clamp(round(x), 1.0, n - 1.0);
  float t  = smoothstep(-uSoftW, uSoftW, x - b);
  float Yq = (b - 1.0 + t) / (n - 1.0);
  outColor = vec4(clamp(c + vec3(Yq - Y), 0.0, 1.0), 1.0);
}`;

// P4 — ink: EDGES Sobel + gate + dilation on the SMOOTHED image, composited
// over the quantized colour with the INK strength.
const INK_FRAG = `${GLSL_HEADER}
uniform sampler2D uQuant;    // P3 output — the banded colour
uniform sampler2D uEdgeSrc;  // the smoothed image (fboB, or raw input at
                             // smooth == 0) — the Sobel source
uniform vec2  uTexel;
uniform float uThreshold;   // 0..1 normalised gradient-magnitude trigger
uniform float uThickness;   // 1..EDGES_MAX_THICKNESS px (dilation radius+1)
uniform float uInk;         // 0..1 outline darkness

const float SOBEL_NORM = ${EDGES_SOBEL_NORM.toFixed(1)};
const int   MAX_R = ${EDGES_MAX_THICKNESS - 1};   // max dilation radius (texels)

float lumaAt(vec2 uv) { return luma(texture(uEdgeSrc, uv).rgb); }

// Normalised Sobel gradient magnitude (mirror EDGES).
float sobelMag(vec2 uv) {
  float tl = lumaAt(uv + uTexel * vec2(-1.0, -1.0));
  float  t = lumaAt(uv + uTexel * vec2( 0.0, -1.0));
  float tr = lumaAt(uv + uTexel * vec2( 1.0, -1.0));
  float  l = lumaAt(uv + uTexel * vec2(-1.0,  0.0));
  float  r = lumaAt(uv + uTexel * vec2( 1.0,  0.0));
  float bl = lumaAt(uv + uTexel * vec2(-1.0,  1.0));
  float  b = lumaAt(uv + uTexel * vec2( 0.0,  1.0));
  float br = lumaAt(uv + uTexel * vec2( 1.0,  1.0));
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  return sqrt(gx * gx + gy * gy) / SOBEL_NORM;
}
float isEdge(vec2 uv) { return sobelMag(uv) >= uThreshold ? 1.0 : 0.0; }

void main() {
  // Sobel edge mask, dilated by THICKNESS (same loop as EDGES).
  int radius = int(clamp(floor(uThickness + 0.5), 1.0, float(MAX_R + 1)) - 1.0);
  float edge = 0.0;
  for (int dy = -MAX_R; dy <= MAX_R; dy++) {
    if (dy < -radius || dy > radius) continue;
    for (int dx = -MAX_R; dx <= MAX_R; dx++) {
      if (dx < -radius || dx > radius) continue;
      vec2 off = uTexel * vec2(float(dx), float(dy));
      edge = max(edge, isEdge(vUv + off));
      if (edge >= 1.0) break;
    }
    if (edge >= 1.0) break;
  }

  vec3 col = texture(uQuant, vUv).rgb;
  col = mix(col, vec3(0.0), edge * uInk);
  outColor = vec4(col, 1.0);
}`;

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(CELLSHADE_DEFAULTS));

export const cellshadeDef: VideoModuleDef = {
  type: 'cellshade',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'cellshade',
  category: 'effects',
  inputs: [
    { id: 'in', type: 'video' },
    // Per-param CV inputs — port id == param id (the cross-domain CV bridge
    // routes audio-side cv onto VideoEngine.setParam(portId)). BITS keeps its
    // DISCRETE cvScale so the CV snaps to the 5 band-count steps (0..4).
    { id: 'threshold', type: 'cv', paramTarget: 'threshold', cvScale: { mode: 'linear' } },
    { id: 'thickness', type: 'cv', paramTarget: 'thickness', cvScale: { mode: 'linear' } },
    { id: 'bits',      type: 'cv', paramTarget: 'bits',      cvScale: { mode: 'discrete' } },
    { id: 'softness',  type: 'cv', paramTarget: 'softness',  cvScale: { mode: 'linear' } },
    { id: 'smooth',    type: 'cv', paramTarget: 'smooth',    cvScale: { mode: 'linear' } },
    { id: 'ink',       type: 'cv', paramTarget: 'ink',       cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'threshold', label: 'Thresh', defaultValue: CELLSHADE_DEFAULTS.threshold, min: 0, max: 1,                  curve: 'linear' },
    { id: 'thickness', label: 'Thick',  defaultValue: CELLSHADE_DEFAULTS.thickness, min: 1, max: EDGES_MAX_THICKNESS, curve: 'linear', units: 'px' },
    // The step INDEX 0..4 into CELLSHADE_BAND_STEPS (discrete fader). The id
    // `bits` is the legacy colour-depth knob's — kept verbatim (same range +
    // discrete curve) so saved patches and CV cables need zero migration.
    { id: 'bits',      label: 'Bands',  defaultValue: CELLSHADE_DEFAULTS.bits,      min: 0, max: CELLSHADE_BAND_STEPS.length - 1, curve: 'discrete' },
    { id: 'softness',  label: 'Soft',   defaultValue: CELLSHADE_DEFAULTS.softness,  min: 0, max: 1,                  curve: 'linear' },
    { id: 'smooth',    label: 'Smooth', defaultValue: CELLSHADE_DEFAULTS.smooth,    min: 0, max: 1,                  curve: 'linear' },
    { id: 'ink',       label: 'Ink',    defaultValue: CELLSHADE_DEFAULTS.ink,       min: 0, max: 1,                  curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "cellshade is a real cel-shader: it remakes the incoming video as flat, hand-painted toon art using the canonical live-video cel pipeline (Winnemöller's Real-Time Video Abstraction). Three stages run per frame: an edge-preserving bilateral smoothing pass (the Smooth knob) flattens low-contrast texture and noise into the large flat regions that read as painted cels while keeping strong contours crisp; a soft luminance quantization pass collapses the image's Rec. 601 brightness into a small number of flat tonal bands (the Bands knob picks 2/3/4/6/8, Soft widens the band transitions) while hue and saturation ride through untouched — a yellow stays yellow, a skin tone stays warm, and each band is a flat tonal step of consistent colour; finally a Sobel ink pass (the same edge machinery as the EDGES module, measured on the smoothed image so noise never inks) draws the salient contours as dark outline strokes, scaled by the Ink knob. It is stateless per frame, so the look tracks the live source with no feedback. Dial Bands low and Ink up for bold comic cels, raise Smooth for painterly abstraction, and use Soft to trade crisp band edges against shimmer-free gradients on live video.",
    inputs: {
      in: "The RGB video source to cel-shade. It is smoothed, luminance-banded and inked; with no input the output is solid black.",
      threshold: "CV input that modulates Thresh, sweeping the ink gate linearly over its full 0..1 range — higher CV inks fewer, stronger contours.",
      thickness: "CV input that modulates Thick, sweeping the ink stroke width linearly over its 1..max px range — higher CV makes the outlines wider.",
      bits: "CV input that modulates Bands using a discrete cvScale, so the CV snaps to the 5 band-count steps (2/3/4/6/8 luminance bands) rather than sweeping continuously.",
      softness: "CV input that modulates Soft, sweeping the band-transition width linearly over its full 0..1 range — higher CV melts the band edges toward a continuous ramp.",
      smooth: "CV input that modulates Smooth, sweeping the bilateral abstraction linearly over its full 0..1 range — higher CV flattens more texture into painted regions.",
      ink: "CV input that modulates Ink, sweeping the outline darkness linearly over its full 0..1 range — 0 removes the lines, 1 draws them solid black.",
    },
    outputs: {
      out: "The cel-shaded video frame: flat soft luminance bands with the source's hue preserved, plus dark ink strokes over the detected contours.",
    },
    controls: {
      threshold: "Thresh — the ink gate (normalized Sobel gradient magnitude, 0..1, default 0.2, shared with EDGES, measured on the smoothed image). Lower inks more/weaker contours; higher inks only the strongest edges.",
      thickness: "Thick — ink stroke width in pixels (1..max, default 2, shared with EDGES). It dilates the edge mask, so higher values make the outlines wider; 1 is a thin single-pixel line.",
      bits: "Bands — a 5-step discrete control selecting the luminance band count: 2, 3, 4 (default), 6 or 8 flat tonal bands. Fewer bands is a bolder, more graphic cel; more bands keeps subtler tonal detail. Only brightness is banded — hue and saturation always pass through. (The param id is the legacy `bits` so old patches load unchanged.)",
      softness: "Soft — the band-transition half-width (0..1, default 0.25). 0 is hard-edged bands (crisp but can shimmer on live video); raising it widens the smoothstep between bands until, near 1, the transfer is almost continuous.",
      smooth: "Smooth — the edge-preserving bilateral abstraction (0..1, default 0.35). 0 is a true bypass (the smoothing passes are skipped entirely); raising it flattens texture and noise into larger painted regions while strong contours stay put.",
      ink: "Ink — outline darkness (0..1, default 1). Scales the black contour composite: 0 draws no lines at all, 1 inks them solid black, in between dims them proportionally.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const bilateralProgram = ctx.compileFragment(BILATERAL_FRAG);
    const quantProgram = ctx.compileFragment(QUANT_FRAG);
    const inkProgram = ctx.compileFragment(INK_FRAG);

    const bU = {
      uTex:    gl.getUniformLocation(bilateralProgram, 'uTex'),
      uTexel:  gl.getUniformLocation(bilateralProgram, 'uTexel'),
      uDir:    gl.getUniformLocation(bilateralProgram, 'uDir'),
      uSigmaR: gl.getUniformLocation(bilateralProgram, 'uSigmaR'),
    };
    const qU = {
      uTex:   gl.getUniformLocation(quantProgram, 'uTex'),
      uBands: gl.getUniformLocation(quantProgram, 'uBands'),
      uSoftW: gl.getUniformLocation(quantProgram, 'uSoftW'),
    };
    const iU = {
      uQuant:     gl.getUniformLocation(inkProgram, 'uQuant'),
      uEdgeSrc:   gl.getUniformLocation(inkProgram, 'uEdgeSrc'),
      uTexel:     gl.getUniformLocation(inkProgram, 'uTexel'),
      uThreshold: gl.getUniformLocation(inkProgram, 'uThreshold'),
      uThickness: gl.getUniformLocation(inkProgram, 'uThickness'),
      uInk:       gl.getUniformLocation(inkProgram, 'uInk'),
    };

    const fboA = ctx.createFbo(); // P1 bilateral H
    const fboB = ctx.createFbo(); // P2 bilateral V (the smoothed image)
    const fboC = ctx.createFbo(); // P3 quantized colour
    const outFbo = ctx.createFbo(); // P4 ink composite — the canonical OUT

    // Strip stray non-numeric / unknown keys so they can't bleed in.
    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    }
    const params: CellshadeParams = { ...CELLSHADE_DEFAULTS, ...(filtered as Partial<CellshadeParams>) };

    const surface: VideoNodeSurface = {
      fbo: outFbo.fbo,
      texture: outFbo.texture,
      draw(frame) {
        const g = frame.gl;
        const W = ctx.res.width;
        const H = ctx.res.height;

        const inputTex = frame.getInputTexture(node.id, 'in');
        if (!inputTex) {
          // No input → solid black out (cheaper than running the chain).
          g.bindFramebuffer(g.FRAMEBUFFER, outFbo.fbo);
          g.viewport(0, 0, W, H);
          g.clearColor(0, 0, 0, 1);
          g.clear(g.COLOR_BUFFER_BIT);
          g.bindFramebuffer(g.FRAMEBUFFER, null);
          return;
        }

        const smooth = clamp01(params.smooth);

        // P1 + P2 — separable bilateral. TRUE BYPASS at smooth === 0: skip
        // both draws and route the raw input onward (§12 R4 — bit-identity
        // by branch, and it saves the two passes).
        let edgeSrcTex: WebGLTexture = inputTex;
        if (smooth > 0) {
          const sigmaR = cellshadeSigmaR(smooth);
          g.useProgram(bilateralProgram);
          g.uniform2f(bU.uTexel, 1 / W, 1 / H);
          g.uniform1f(bU.uSigmaR, sigmaR);
          // P1: input → fboA (horizontal).
          g.bindFramebuffer(g.FRAMEBUFFER, fboA.fbo);
          g.viewport(0, 0, W, H);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex);
          g.uniform1i(bU.uTex, 0);
          g.uniform2f(bU.uDir, 1, 0);
          ctx.drawFullscreenQuad();
          // P2: fboA → fboB (vertical).
          g.bindFramebuffer(g.FRAMEBUFFER, fboB.fbo);
          g.viewport(0, 0, W, H);
          g.bindTexture(g.TEXTURE_2D, fboA.texture);
          g.uniform2f(bU.uDir, 0, 1);
          ctx.drawFullscreenQuad();
          edgeSrcTex = fboB.texture;
        }

        // P3: smoothed (or raw) → fboC — soft luminance quantization.
        g.bindFramebuffer(g.FRAMEBUFFER, fboC.fbo);
        g.viewport(0, 0, W, H);
        g.useProgram(quantProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, edgeSrcTex);
        g.uniform1i(qU.uTex, 0);
        g.uniform1f(qU.uBands, cellshadeBandCount(params.bits));
        g.uniform1f(qU.uSoftW, cellshadeSoftWidth(params.softness));
        ctx.drawFullscreenQuad();

        // P4: quantized + smoothed → out — Sobel ink composite.
        g.bindFramebuffer(g.FRAMEBUFFER, outFbo.fbo);
        g.viewport(0, 0, W, H);
        g.useProgram(inkProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, fboC.texture);
        g.uniform1i(iU.uQuant, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, edgeSrcTex);
        g.uniform1i(iU.uEdgeSrc, 1);
        g.uniform2f(iU.uTexel, 1 / W, 1 / H);
        g.uniform1f(iU.uThreshold, Math.max(0, Math.min(1, params.threshold)));
        g.uniform1f(
          iU.uThickness,
          Math.max(1, Math.min(EDGES_MAX_THICKNESS, params.thickness)),
        );
        g.uniform1f(iU.uInk, clamp01(params.ink));
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        for (const f of [fboA, fboB, fboC, outFbo]) {
          gl.deleteFramebuffer(f.fbo);
          gl.deleteTexture(f.texture);
        }
        gl.deleteProgram(bilateralProgram);
        gl.deleteProgram(quantProgram);
        gl.deleteProgram(inkProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Card readout hook: the current luminance band count (2/3/4/6/8).
        if (key === 'bands') return cellshadeBandCount(params.bits);
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
