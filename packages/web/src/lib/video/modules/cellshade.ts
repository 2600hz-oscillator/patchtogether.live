// packages/web/src/lib/video/modules/cellshade.ts
//
// CELLSHADE — cel-shader (toon / retro-video-game) video PROCESSOR.
//
// Takes a `video` input and emits a cel-shaded version: the colour is
// QUANTIZED to a retro N-bit palette and the salient CONTOURS are inked in
// as BLACK outline strokes (a reused Sobel edge pass). The combination is
// the classic "rendered in N-bit colour" + hand-painted-cel look.
//
// CELLSHADE is STATELESS per frame — the look moves/transforms live with
// the source (no feedback, no history), so it's a pure function of the
// current input frame + the three knobs.
//
// ── Pipeline ──────────────────────────────────────────────────────────
//   1. QUANTIZE the colour to the chosen bit depth (see below).
//   2. EDGE pass: a 3×3 Sobel on the input's Rec. 601 LUMINANCE (reused
//      verbatim from EDGES — same normalisation, same THRESHOLD gate, same
//      THICKNESS dilation), producing a 0/1 edge mask.
//   3. INK: composite the edge mask as BLACK lines over the quantized
//      colour — `color = mix(quantizedColor, vec3(0.0), edgeMask)`.
//
// ── BITS — RETRO TOTAL COLOR-DEPTH (5 discrete steps) ─────────────────
// One discrete knob snaps to 5 colour depths. The param value is the STEP
// INDEX 0..4 (so the discrete fader + the discrete-cvScale CV both snap to
// the 5 steps); the index maps to a total colour count:
//
//   idx 0 →  1-bit →     2 colours
//   idx 1 →  2-bit →     4 colours
//   idx 2 →  4-bit →    16 colours
//   idx 3 →  8-bit →   256 colours  (RGB 3-3-2)
//   idx 4 → 16-bit → 65536 colours  (RGB 5-6-5)
//
// HOW each depth quantizes (this is the craft — done WELL, not a naive
// per-channel RGB floor which shifts hue toward channel-clipped mush):
//
//   * LOW depths (1/2/4-bit = 2/4/16 colours) — LUMA-BAND quantization.
//     Convert RGB → HSV, keep HUE + SATURATION (mostly) intact, and
//     quantize only the BRIGHTNESS (V) into a small number of bands, then
//     reconstruct RGB. This gives the hand-painted CEL look (flat tonal
//     bands of the same hue) rather than the RGB-clipping rainbow a naive
//     floor produces. The band count is derived from the colour budget so
//     2 colours ≈ 2 luma bands, 4 ≈ a few, 16 ≈ ~6 bands with a couple of
//     coarse hue/sat steps layered in for the 16-colour budget.
//   * 8-bit (256 colours) — the authentic console RGB 3-3-2 allocation:
//     8 R levels, 8 G levels, 4 B levels (8×8×4 = 256).
//   * 16-bit (65536 colours) — the authentic RGB 5-6-5 allocation:
//     32 R levels, 64 G levels, 32 B levels (32×64×32 = 65536).
//
// The per-channel floor for 332/565 reads as the recognisable hi-colour /
// SNES-era look; the luma-band path reads as the low-colour cel/retro art
// look. Use the depth the source calls for.
//
// THRESHOLD / THICKNESS behave EXACTLY like EDGES (shared constants +
// shared CPU mirror), so the ink reads the same gate/width the dedicated
// EDGES module does. Raising THRESHOLD inks FEWER lines (only the
// strongest contours); raising THICKNESS makes the ink strokes WIDER.
//
// Inputs:
//   in (video): RGB source to cel-shade.
//   threshold / thickness / bits (cv, paramTarget=…): per-param CV
//     (port id == param id). `bits` uses a DISCRETE cvScale so the CV
//     snaps to the 5 colour-depth steps.
//
// Outputs:
//   out (video): the cel-shaded frame (quantized colour + black ink edges).
//
// Params:
//   threshold (linear 0..1): edge gate (default 0.2, from EDGES).
//   thickness (linear 1..EDGES_MAX_THICKNESS px): ink stroke width (default 2).
//   bits (discrete 0..4): colour-depth step index (default 2 = 4-bit/16 col).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  EDGES_MAX_THICKNESS,
  EDGES_LUMA_WEIGHTS,
  EDGES_SOBEL_NORM,
} from './edges';

// ----------------------------------------------------------------------
// Bit-depth model — exported for unit tests + the card readout (no GL).
// ----------------------------------------------------------------------

/** The 5 colour-depth steps the BITS knob snaps to. `bits` is the
 *  conventional bit-depth name; `colors` is the total colour count. Index
 *  into this array == the `bits` param value (a discrete 0..4 fader). */
export const CELLSHADE_BIT_STEPS: readonly { bits: number; colors: number }[] = [
  { bits: 1, colors: 2 },
  { bits: 2, colors: 4 },
  { bits: 4, colors: 16 },
  { bits: 8, colors: 256 },
  { bits: 16, colors: 65536 },
];

/** Default BITS step index — 4-bit / 16 colours, a recognisably "retro"
 *  cel look that still carries enough hue to read the source. */
export const CELLSHADE_DEFAULT_BITS_INDEX = 2;

/** Clamp + round a raw `bits` param (possibly fractional from a CV write)
 *  to a valid step INDEX 0..4. The discrete fader + discrete cvScale both
 *  already snap, but we re-snap here so the shader/CPU-mirror always see a
 *  clean integer step (defensive against a fractional value bleeding in). */
export function cellshadeBitsIndex(rawBits: number): number {
  const n = CELLSHADE_BIT_STEPS.length;
  if (!Number.isFinite(rawBits)) return CELLSHADE_DEFAULT_BITS_INDEX;
  return Math.max(0, Math.min(n - 1, Math.round(rawBits)));
}

/** The conventional bit-depth value (1/2/4/8/16) for a `bits` step index. */
export function cellshadeBitDepth(rawBits: number): number {
  return CELLSHADE_BIT_STEPS[cellshadeBitsIndex(rawBits)]!.bits;
}

/** The total colour count (2/4/16/256/65536) for a `bits` step index. */
export function cellshadeColorCount(rawBits: number): number {
  return CELLSHADE_BIT_STEPS[cellshadeBitsIndex(rawBits)]!.colors;
}

// ----------------------------------------------------------------------
// Colour-space helpers — shared by the shader (transliterated) + the CPU
// mirror so JS + GLSL agree exactly.
// ----------------------------------------------------------------------

/** Rec. 601 luminance of a normalized RGB triple (each 0..1). */
export function cellshadeLuma(r: number, g: number, b: number): number {
  return (
    r * EDGES_LUMA_WEIGHTS[0] + g * EDGES_LUMA_WEIGHTS[1] + b * EDGES_LUMA_WEIGHTS[2]
  );
}

/** RGB → HSV (all components 0..1; hue normalized to 0..1). */
export function rgbToHsv(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max <= 0 ? 0 : d / max;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, s, v];
}

/** HSV → RGB (all components 0..1; hue 0..1). */
export function hsvToRgb(
  h: number,
  s: number,
  v: number,
): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/** Quantize one normalized value (0..1) to `levels` discrete steps.
 *  Mirrors the GLSL `floor(c*levels)/(levels-1)` with the same clamping. */
export function quantizeUnit(value: number, levels: number): number {
  const v = Math.min(1, Math.max(0, value));
  const n = Math.max(2, Math.round(levels));
  const idx = Math.min(n - 1, Math.floor(v * n));
  return idx / (n - 1);
}

/**
 * The number of BRIGHTNESS (V) bands + HUE steps + SAT steps the luma-band
 * path uses for a given LOW colour budget (2 / 4 / 16). Tuned so the total
 * achievable distinct tones is in the spirit of the budget while keeping a
 * flat-band cel look (most of the budget goes to luminance bands):
 *
 *   2  colours → 2 V bands, 1 hue, 1 sat (pure light/dark posterize).
 *   4  colours → 4 V bands, 1 hue, 1 sat (4 tonal bands of the live hue).
 *   16 colours → 6 V bands, 3 hue, 2 sat (banded tone + a little hue/sat
 *                step → a small painted palette, still cel-flat).
 */
export function cellshadeLumaBandConfig(
  colors: number,
): { vBands: number; hueSteps: number; satSteps: number } {
  if (colors <= 2) return { vBands: 2, hueSteps: 1, satSteps: 1 };
  if (colors <= 4) return { vBands: 4, hueSteps: 1, satSteps: 1 };
  return { vBands: 6, hueSteps: 3, satSteps: 2 };
}

/**
 * Pure CPU mirror of the per-texel COLOUR QUANTIZATION (no edge ink).
 * Shared by the unit tests + the GLSL `quantizeColor()`.
 *
 *   - LOW depths (2/4/16 colours): HSV luma-band — keep H/S (quantized
 *     gently for the 16-colour budget), quantize V into bands, → RGB.
 *   - 8-bit (256): RGB 3-3-2 (8 R, 8 G, 4 B levels).
 *   - 16-bit (65536): RGB 5-6-5 (32 R, 64 G, 32 B levels).
 *
 * Returns the quantized RGB triple (each 0..1).
 */
export function cellshadeQuantize(
  r: number,
  g: number,
  b: number,
  rawBits: number,
): [number, number, number] {
  const colors = cellshadeColorCount(rawBits);

  if (colors === 256) {
    // RGB 3-3-2 — 8 / 8 / 4 per-channel levels.
    return [quantizeUnit(r, 8), quantizeUnit(g, 8), quantizeUnit(b, 4)];
  }
  if (colors === 65536) {
    // RGB 5-6-5 — 32 / 64 / 32 per-channel levels.
    return [quantizeUnit(r, 32), quantizeUnit(g, 64), quantizeUnit(b, 32)];
  }

  // LOW depths: luma-band in HSV.
  const { vBands, hueSteps, satSteps } = cellshadeLumaBandConfig(colors);
  const [h, s, v] = rgbToHsv(r, g, b);
  const vq = quantizeUnit(v, vBands);
  // Hue/sat: 1 step == passthrough (preserve fully); >1 == a gentle posterize
  // that keeps the band cel-flat. quantizeUnit with levels=1 is undefined
  // (clamped to 2), so guard the passthrough case explicitly.
  const hq = hueSteps <= 1 ? h : quantizeUnit(h, hueSteps);
  const sq = satSteps <= 1 ? s : quantizeUnit(s, satSteps);
  return hsvToRgb(hq, sq, vq);
}

/**
 * Pure CPU mirror of the FULL per-texel CELLSHADE decision: quantize the
 * colour, then ink the Sobel edge mask as black. Shared by the unit tests
 * so JS + GLSL agree on the whole pipeline.
 *
 * @param width/height — grid dimensions.
 * @param rgbGrid      — row-major RGB grid (length width*height*3, 0..1).
 * @param x/y          — the texel under test.
 * @param threshold/thickness — the EDGES gate/width (same semantics).
 * @param rawBits      — the BITS param (step index, possibly fractional).
 * @returns the output RGB triple (quantized colour, black where an edge is).
 */
export function cellshadePixel(
  width: number,
  height: number,
  rgbGrid: ArrayLike<number>,
  x: number,
  y: number,
  threshold: number,
  thickness: number,
  rawBits: number,
): [number, number, number] {
  const idx = (y * width + x) * 3;
  const [qr, qg, qb] = cellshadeQuantize(
    rgbGrid[idx]!, rgbGrid[idx + 1]!, rgbGrid[idx + 2]!, rawBits,
  );
  // Sobel on luminance — same algorithm + normalisation EDGES uses (we
  // inline it rather than going through edgesPixel's luma-grid signature so
  // the luma is read straight from the RGB grid via cellshadeLuma).
  const lumaAt = (ax: number, ay: number): number => {
    const cx = Math.max(0, Math.min(width - 1, ax));
    const cy = Math.max(0, Math.min(height - 1, ay));
    const li = (cy * width + cx) * 3;
    return cellshadeLuma(rgbGrid[li]!, rgbGrid[li + 1]!, rgbGrid[li + 2]!);
  };
  // Dilation loop against lumaAt directly (identical algorithm + the same
  // EDGES_SOBEL_NORM normalisation as the EDGES module).
  const radius = Math.max(0, Math.min(EDGES_MAX_THICKNESS - 1, Math.round(thickness) - 1));
  const isEdge = (ax: number, ay: number): boolean => {
    const tl = lumaAt(ax - 1, ay - 1), t = lumaAt(ax, ay - 1), tr = lumaAt(ax + 1, ay - 1);
    const l = lumaAt(ax - 1, ay), rr = lumaAt(ax + 1, ay);
    const bl = lumaAt(ax - 1, ay + 1), bb = lumaAt(ax, ay + 1), br = lumaAt(ax + 1, ay + 1);
    const gx = tr + 2 * rr + br - (tl + 2 * l + bl);
    const gy = bl + 2 * bb + br - (tl + 2 * t + tr);
    return Math.sqrt(gx * gx + gy * gy) / EDGES_SOBEL_NORM >= threshold;
  };
  let edge = 0;
  for (let dy = -radius; dy <= radius && edge === 0; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (isEdge(x + dx, y + dy)) { edge = 1; break; }
    }
  }
  if (edge === 1) return [0, 0, 0];
  return [qr, qg, qb];
}

// ----------------------------------------------------------------------
// GLSL — quantize the colour (luma-band / 332 / 565) + ink the Sobel edge.
// ----------------------------------------------------------------------

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform vec2  uTexel;       // 1/resolution — one texel step in UV
uniform float uThreshold;   // 0..1 normalised gradient-magnitude trigger
uniform float uThickness;   // 1..EDGES_MAX_THICKNESS px (dilation radius+1)
uniform float uColors;      // total colour budget: 2/4/16/256/65536

const float LUMA_R = ${EDGES_LUMA_WEIGHTS[0]};
const float LUMA_G = ${EDGES_LUMA_WEIGHTS[1]};
const float LUMA_B = ${EDGES_LUMA_WEIGHTS[2]};
const float SOBEL_NORM = ${EDGES_SOBEL_NORM.toFixed(1)};
const int   MAX_R = ${EDGES_MAX_THICKNESS - 1};   // max dilation radius (texels)

// --- colour-space helpers (mirror rgbToHsv / hsvToRgb / quantizeUnit) ---
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
// floor(v*n)/(n-1), n>=2 — matches quantizeUnit().
float quant(float v, float n) {
  float nn = max(2.0, n);
  float idx = min(nn - 1.0, floor(clamp(v, 0.0, 1.0) * nn));
  return idx / (nn - 1.0);
}

// Quantize a colour to the chosen budget (mirror cellshadeQuantize()).
vec3 quantizeColor(vec3 c) {
  if (uColors > 60000.0) {
    // 16-bit RGB 5-6-5.
    return vec3(quant(c.r, 32.0), quant(c.g, 64.0), quant(c.b, 32.0));
  }
  if (uColors > 200.0) {
    // 8-bit RGB 3-3-2.
    return vec3(quant(c.r, 8.0), quant(c.g, 8.0), quant(c.b, 4.0));
  }
  // LOW depths: HSV luma-band.
  vec3 hsv = rgb2hsv(c);
  float vBands, hueSteps, satSteps;
  if (uColors <= 2.0)      { vBands = 2.0; hueSteps = 1.0; satSteps = 1.0; }
  else if (uColors <= 4.0) { vBands = 4.0; hueSteps = 1.0; satSteps = 1.0; }
  else                     { vBands = 6.0; hueSteps = 3.0; satSteps = 2.0; }
  float vq = quant(hsv.z, vBands);
  float hq = hueSteps <= 1.0 ? hsv.x : quant(hsv.x, hueSteps);
  float sq = satSteps <= 1.0 ? hsv.y : quant(hsv.y, satSteps);
  return hsv2rgb(vec3(hq, sq, vq));
}

float lumaAt(vec2 uv) {
  vec3 c = texture(uTex, uv).rgb;
  return dot(c, vec3(LUMA_R, LUMA_G, LUMA_B));
}
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
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 src = texture(uTex, vUv).rgb;
  vec3 col = quantizeColor(src);

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

  // Ink the edges as BLACK lines over the quantized colour.
  col = mix(col, vec3(0.0), edge);
  outColor = vec4(col, 1.0);
}`;

export interface CellshadeParams {
  threshold: number; // 0..1 normalised gradient-magnitude trigger (EDGES)
  thickness: number; // 1..EDGES_MAX_THICKNESS px ink stroke width (EDGES)
  bits: number;      // discrete 0..4 colour-depth step index
}

export const CELLSHADE_DEFAULTS: CellshadeParams = {
  // EDGES' defaults so the ink reads exactly like the dedicated module.
  threshold: 0.2,
  thickness: 2,
  // 4-bit / 16 colours — a recognisably retro cel look out of the box.
  bits: CELLSHADE_DEFAULT_BITS_INDEX,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(CELLSHADE_DEFAULTS));

export const cellshadeDef: VideoModuleDef = {
  type: 'cellshade',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'cellshade',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in', type: 'video' },
    // Per-param CV inputs — port id == param id (the cross-domain CV bridge
    // routes audio-side cv onto VideoEngine.setParam(portId)). THRESHOLD +
    // THICKNESS sweep their full range linearly; BITS uses a DISCRETE cvScale
    // so the CV snaps to the 5 colour-depth steps (0..4).
    { id: 'threshold', type: 'cv', paramTarget: 'threshold', cvScale: { mode: 'linear' } },
    { id: 'thickness', type: 'cv', paramTarget: 'thickness', cvScale: { mode: 'linear' } },
    { id: 'bits',      type: 'cv', paramTarget: 'bits',      cvScale: { mode: 'discrete' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'threshold', label: 'Thresh', defaultValue: CELLSHADE_DEFAULTS.threshold, min: 0, max: 1,                  curve: 'linear' },
    { id: 'thickness', label: 'Thick',  defaultValue: CELLSHADE_DEFAULTS.thickness, min: 1, max: EDGES_MAX_THICKNESS, curve: 'linear', units: 'px' },
    // The step INDEX 0..4 into CELLSHADE_BIT_STEPS (discrete fader). The card
    // formats it as the bit value (1/2/4/8/16); the shader reads the colour
    // count derived from the index.
    { id: 'bits',      label: 'Bits',   defaultValue: CELLSHADE_DEFAULTS.bits,      min: 0, max: CELLSHADE_BIT_STEPS.length - 1, curve: 'discrete' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex       = gl.getUniformLocation(program, 'uTex');
    const uHasInput  = gl.getUniformLocation(program, 'uHasInput');
    const uTexel     = gl.getUniformLocation(program, 'uTexel');
    const uThreshold = gl.getUniformLocation(program, 'uThreshold');
    const uThickness = gl.getUniformLocation(program, 'uThickness');
    const uColors    = gl.getUniformLocation(program, 'uColors');

    const { fbo, texture } = ctx.createFbo();

    // Strip stray non-numeric / unknown keys so they can't bleed in.
    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    }
    const params: CellshadeParams = { ...CELLSHADE_DEFAULTS, ...(filtered as Partial<CellshadeParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        const inputTex = frame.getInputTexture(node.id, 'in');
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        if (inputTex) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex);
          g.uniform1i(uTex, 0);
        }

        g.uniform2f(uTexel, 1 / ctx.res.width, 1 / ctx.res.height);
        g.uniform1f(uThreshold, Math.max(0, Math.min(1, params.threshold)));
        g.uniform1f(
          uThickness,
          Math.max(1, Math.min(EDGES_MAX_THICKNESS, params.thickness)),
        );
        // Resolve the BITS step index → total colour budget for the shader.
        g.uniform1f(uColors, cellshadeColorCount(params.bits));

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteProgram(program);
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
        // Card readout hook: the current bit-depth value (1/2/4/8/16).
        if (key === 'bitDepth') return cellshadeBitDepth(params.bits);
        if (key === 'colorCount') return cellshadeColorCount(params.bits);
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
