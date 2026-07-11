// packages/web/src/lib/video/modules/posterbox.ts
//
// POSTERBOX — retro PALETTE-CRUSH (posterizer) video PROCESSOR.
//
// Takes a `video` input and truncates every pixel to an authentic retro
// per-channel bit allocation — the classic "8-bit" / "hi-colour" palette
// crush. This module is the dedicated home of the per-channel RGB
// posterize looks that CELLSHADE's rebuild dropped (they are
// POSTERIZATION, not cel shading): the 8-bit RGB 3-3-2 and 16-bit RGB
// 5-6-5 floor-quantization paths are ported here EXACTLY, so an old
// cellshade retro patch recreates byte-for-byte by swapping in POSTERBOX.
//
// "Tints neutral grays" is a FEATURE here, not a bug: an asymmetric
// allocation (3-3-2, 5-6-5) has different level grids per channel, so a
// neutral gray quantizes to a slightly tinted colour — e.g. gray 0.2 at
// 3-3-2 → (36,36,0), a dark olive. That channel-clipped cast IS the
// period-correct 8-bit look.
//
// POSTERBOX is STATELESS per frame — a pure function of the current input
// frame + the three knobs (no feedback, no history, no neighbourhood
// taps: one texture sample + one Bayer matrix lookup per pixel).
//
// ── DEPTH — the retro bit-allocation ladder (5 discrete steps) ────────
// The param value is the STEP INDEX 0..4 (discrete fader + discrete
// cvScale both snap); each index is a real hardware palette era:
//
//   idx 0 → 1-1-1 →     8 colours  (3-bit RGB — ZX Spectrum / Teletext)
//   idx 1 → 2-2-2 →    64 colours  (6-bit RGB — the EGA master palette)
//   idx 2 → 3-3-2 →   256 colours  (8-bit truecolor — VGA / MSX2 screen 8)
//   idx 3 → 4-4-4 →  4096 colours  (12-bit RGB — Amiga OCS)
//   idx 4 → 5-6-5 → 65536 colours  (16-bit hi-colour — RGB565)
//
// idx 2 and idx 4 are THE legacy CELLSHADE "8-bit"/"16-bit" modes: the
// same floor(v*n)/(n-1) per-channel quantizer with the same 8/8/4 and
// 32/64/32 level allocations.
//
// ── DITHER — Bayer 4×4 ordered dither (0..1) ──────────────────────────
// The classic companion to palette crush (Bayer 1973; the PlayStation
// applied exactly this — a 4×4 ordered-dither offset added BEFORE
// truncating to 15-bit). The screen-position threshold from the standard
// Bayer 4×4 index matrix perturbs the quantizer DECISION in index space:
//
//   idx = floor(v*n + (bayerT - 0.5) * dither),  bayerT = (B[x%4,y%4]+0.5)/16
//
// At dither 0 the offset vanishes and the quantizer is EXACTLY the legacy
// hard-band floor (the continuity guarantee). At dither 1 the decision is
// perturbed by a full quantization step, so a smooth gradient renders as
// the retro cross-hatch — band edges dissolve into alternating checkered
// pixels whose local density tracks the underlying value.
//
// ── MIX — dry/wet (0..1) ──────────────────────────────────────────────
// out = mix(src, crushed, mix). 1 = full crush (default); 0 = bypass.
//
// Inputs:
//   in (video): RGB source to crush.
//   depth / dither / mix (cv, paramTarget=…): per-param CV (port id ==
//     param id). `depth` uses a DISCRETE cvScale so the CV snaps to the
//     5 ladder steps; dither/mix sweep linearly.
//
// Outputs:
//   out (video): the palette-crushed frame.
//
// Params:
//   depth  (discrete 0..4): bit-allocation step index (default 2 = 3-3-2).
//   dither (linear 0..1):  Bayer 4×4 ordered-dither amount (default 0).
//   mix    (linear 0..1):  dry/wet (default 1 = full crush).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// ----------------------------------------------------------------------
// Depth-ladder model — exported for unit tests + the card readout (no GL).
// ----------------------------------------------------------------------

/** The 5 per-channel bit-allocation steps the DEPTH knob snaps to.
 *  `bits` is the R/G/B bit split; `levels` = 2^bits per channel;
 *  `colors` the total palette size; `name` the era label the card shows.
 *  Index into this array == the `depth` param value (discrete 0..4).
 *  idx 2 (3-3-2) and idx 4 (5-6-5) are the legacy CELLSHADE allocations. */
export const POSTERBOX_DEPTH_STEPS: readonly {
  bits: readonly [number, number, number];
  levels: readonly [number, number, number];
  colors: number;
  name: string;
}[] = [
  { bits: [1, 1, 1], levels: [2, 2, 2],    colors: 8,     name: '1-bit' },
  { bits: [2, 2, 2], levels: [4, 4, 4],    colors: 64,    name: '2-2-2' },
  { bits: [3, 3, 2], levels: [8, 8, 4],    colors: 256,   name: '3-3-2' },
  { bits: [4, 4, 4], levels: [16, 16, 16], colors: 4096,  name: '4-4-4' },
  { bits: [5, 6, 5], levels: [32, 64, 32], colors: 65536, name: '5-6-5' },
];

/** Default DEPTH step index — 3-3-2 (256 colours), the flagship legacy
 *  "8-bit" look POSTERBOX exists to carry forward. */
export const POSTERBOX_DEFAULT_DEPTH_INDEX = 2;

/** Clamp + round a raw `depth` param (possibly fractional from a CV write)
 *  to a valid step INDEX 0..4 — same defensive snap CELLSHADE's bits used. */
export function posterboxDepthIndex(rawDepth: number): number {
  const n = POSTERBOX_DEPTH_STEPS.length;
  if (!Number.isFinite(rawDepth)) return POSTERBOX_DEFAULT_DEPTH_INDEX;
  return Math.max(0, Math.min(n - 1, Math.round(rawDepth)));
}

/** Per-channel level counts [R, G, B] for a `depth` step. */
export function posterboxLevels(rawDepth: number): readonly [number, number, number] {
  return POSTERBOX_DEPTH_STEPS[posterboxDepthIndex(rawDepth)]!.levels;
}

/** Total palette size (8/64/256/4096/65536) for a `depth` step. */
export function posterboxColorCount(rawDepth: number): number {
  return POSTERBOX_DEPTH_STEPS[posterboxDepthIndex(rawDepth)]!.colors;
}

/** Total bits per pixel (3/6/8/12/16) for a `depth` step. */
export function posterboxBitDepth(rawDepth: number): number {
  const { bits } = POSTERBOX_DEPTH_STEPS[posterboxDepthIndex(rawDepth)]!;
  return bits[0] + bits[1] + bits[2];
}

// ----------------------------------------------------------------------
// Bayer 4×4 ordered dither — shared by the shader (constant-interpolated)
// + the CPU mirror so JS + GLSL agree exactly.
// ----------------------------------------------------------------------

/** The standard Bayer 4×4 index matrix (row-major; Bayer 1973). Each cell
 *  0..15; every 2×2 quadrant spreads the full range, which is what makes
 *  the pattern read as an even cross-hatch rather than clumps. */
export const POSTERBOX_BAYER4: readonly number[] = [
   0,  8,  2, 10,
  12,  4, 14,  6,
   3, 11,  1,  9,
  15,  7, 13,  5,
];

/** The normalized Bayer threshold for a texel: (B + 0.5)/16 ∈ (0, 1).
 *  Row-major indexing (y selects the row) — the GLSL lookup mirrors this. */
export function posterboxBayerThreshold(x: number, y: number): number {
  const ix = ((Math.floor(x) % 4) + 4) % 4;
  const iy = ((Math.floor(y) % 4) + 4) % 4;
  return (POSTERBOX_BAYER4[iy * 4 + ix]! + 0.5) / 16;
}

/**
 * Quantize one channel value (0..1) to `levels` steps with an ordered-
 * dither perturbation. Mirrors the GLSL `quantD()` exactly:
 *
 *   idx = floor(clamp(v)*n + (bayerT - 0.5)*dither), clamped to 0..n-1
 *   out = idx / (n - 1)
 *
 * At dither 0 this is EXACTLY the legacy CELLSHADE quantizeUnit floor
 * (`floor(v*n)/(n-1)` with the same clamping) — the byte-exact continuity
 * path. At dither 1 the decision is perturbed by a full quantization step
 * (the authentic offset-before-truncate hardware scheme).
 */
export function posterboxQuantizeChannel(
  v: number,
  levels: number,
  bayerT: number,
  dither: number,
): number {
  const n = Math.max(2, Math.round(levels));
  const d = Math.min(1, Math.max(0, dither));
  const x = Math.min(1, Math.max(0, v)) * n + (bayerT - 0.5) * d;
  const idx = Math.max(0, Math.min(n - 1, Math.floor(x)));
  return idx / (n - 1);
}

/**
 * Pure CPU mirror of the per-texel PALETTE CRUSH (before MIX): quantize
 * each channel to its DEPTH-step level count, with the shared Bayer
 * threshold for this texel scaled by DITHER. Returns the crushed RGB
 * triple (each 0..1).
 */
export function posterboxCrush(
  r: number,
  g: number,
  b: number,
  x: number,
  y: number,
  rawDepth: number,
  dither: number,
): [number, number, number] {
  const [nr, ng, nb] = posterboxLevels(rawDepth);
  const t = posterboxBayerThreshold(x, y);
  return [
    posterboxQuantizeChannel(r, nr, t, dither),
    posterboxQuantizeChannel(g, ng, t, dither),
    posterboxQuantizeChannel(b, nb, t, dither),
  ];
}

/**
 * Pure CPU mirror of the FULL per-texel POSTERBOX decision: crush, then
 * dry/wet against the source. Shared by the unit tests so JS + GLSL agree
 * on the whole pipeline.
 */
export function posterboxPixel(
  r: number,
  g: number,
  b: number,
  x: number,
  y: number,
  rawDepth: number,
  dither: number,
  mix: number,
): [number, number, number] {
  const [qr, qg, qb] = posterboxCrush(r, g, b, x, y, rawDepth, dither);
  const m = Math.min(1, Math.max(0, mix));
  return [r + (qr - r) * m, g + (qg - g) * m, b + (qb - b) * m];
}

// ----------------------------------------------------------------------
// GLSL — one texture sample + one Bayer lookup per pixel, single pass.
// ----------------------------------------------------------------------

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform vec3  uLevels;   // per-channel level counts (from the DEPTH step)
uniform float uDither;   // 0..1 Bayer ordered-dither amount
uniform float uMix;      // 0..1 dry/wet

// The standard Bayer 4×4 index matrix — constant-interpolated from
// POSTERBOX_BAYER4 (row-major; y selects the row), mirroring
// posterboxBayerThreshold().
const float BAYER[16] = float[16](${POSTERBOX_BAYER4.map((v) => v.toFixed(1)).join(', ')});

// floor(v*n + (t-0.5)*d) / (n-1) — matches posterboxQuantizeChannel().
// At d = 0 this is the legacy hard-band floor quantizer exactly.
float quantD(float v, float n, float t, float d) {
  float x = clamp(v, 0.0, 1.0) * n + (t - 0.5) * d;
  return clamp(floor(x), 0.0, n - 1.0) / (n - 1.0);
}

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 src = texture(uTex, vUv).rgb;

  // Bayer threshold for this texel — gl_FragCoord.xy is texel + 0.5, so
  // floor() gives the integer texel coordinate posterboxBayerThreshold uses.
  int ix = int(mod(floor(gl_FragCoord.x), 4.0));
  int iy = int(mod(floor(gl_FragCoord.y), 4.0));
  float t = (BAYER[iy * 4 + ix] + 0.5) / 16.0;

  float d = clamp(uDither, 0.0, 1.0);
  vec3 crushed = vec3(
    quantD(src.r, uLevels.r, t, d),
    quantD(src.g, uLevels.g, t, d),
    quantD(src.b, uLevels.b, t, d)
  );

  outColor = vec4(mix(src, crushed, clamp(uMix, 0.0, 1.0)), 1.0);
}`;

export interface PosterboxParams {
  depth: number;  // discrete 0..4 bit-allocation step index
  dither: number; // 0..1 Bayer ordered-dither amount
  mix: number;    // 0..1 dry/wet
}

export const POSTERBOX_DEFAULTS: PosterboxParams = {
  // 3-3-2 — the legacy "8-bit" look, hard bands, full crush out of the box.
  depth: POSTERBOX_DEFAULT_DEPTH_INDEX,
  dither: 0,
  mix: 1,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(POSTERBOX_DEFAULTS));

export const posterboxDef: VideoModuleDef = {
  type: 'posterbox',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'posterbox',
  category: 'effects',
  inputs: [
    { id: 'in', type: 'video' },
    // Per-param CV inputs — port id == param id (the cross-domain CV bridge
    // routes audio-side cv onto VideoEngine.setParam(portId)). DITHER + MIX
    // sweep their full 0..1 range linearly; DEPTH uses a DISCRETE cvScale so
    // the CV snaps to the 5 ladder steps (0..4).
    { id: 'depth',  type: 'cv', paramTarget: 'depth',  cvScale: { mode: 'discrete' } },
    { id: 'dither', type: 'cv', paramTarget: 'dither', cvScale: { mode: 'linear' } },
    { id: 'mix',    type: 'cv', paramTarget: 'mix',    cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    // The step INDEX 0..4 into POSTERBOX_DEPTH_STEPS (discrete fader). The
    // card formats it as the allocation name (1-bit/2-2-2/3-3-2/4-4-4/5-6-5);
    // the shader reads the per-channel level counts derived from the index.
    { id: 'depth',  label: 'Depth',  defaultValue: POSTERBOX_DEFAULTS.depth,  min: 0, max: POSTERBOX_DEPTH_STEPS.length - 1, curve: 'discrete' },
    { id: 'dither', label: 'Dither', defaultValue: POSTERBOX_DEFAULTS.dither, min: 0, max: 1, curve: 'linear' },
    { id: 'mix',    label: 'Mix',    defaultValue: POSTERBOX_DEFAULTS.mix,    min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "posterbox is a retro palette crusher: it truncates every pixel of the incoming video to an authentic per-channel bit allocation, reproducing the look of real palette-era hardware. The Depth ladder steps through five allocations — 1-1-1 (8 colours, ZX-Spectrum-style brutal posterize), 2-2-2 (64 colours, the EGA master palette), 3-3-2 (256 colours, the VGA-era 8-bit truecolor split), 4-4-4 (4096 colours, Amiga OCS), and 5-6-5 (65536 colours, RGB565 hi-colour). The 3-3-2 and 5-6-5 steps are the exact per-channel floor quantizers CELLSHADE's original 8-bit/16-bit retro modes used, ported unchanged, so old cellshade retro patches recreate byte-for-byte here. Because the asymmetric allocations give each channel a different level grid, neutral grays come out slightly tinted (gray 0.2 at 3-3-2 becomes a dark olive) — that channel-clipped cast is the period-correct look and is intentional. Dither adds the classic companion: a Bayer 4×4 ordered dither that perturbs the quantizer threshold per screen pixel, so smooth gradients render as retro cross-hatch instead of hard bands (the same offset-before-truncate scheme the PlayStation used for its 15-bit output). Mix is a straight dry/wet. The effect is stateless per frame — one texture sample and one Bayer lookup per pixel, no feedback and no neighbourhood taps.",
    inputs: {
      in: "The RGB video source to palette-crush. Each channel is quantized to the Depth step's per-channel level count; with no input the output is solid black.",
      depth: "CV input that modulates Depth using a discrete cvScale, so the CV snaps to the 5 bit-allocation steps (1-1-1 / 2-2-2 / 3-3-2 / 4-4-4 / 5-6-5) rather than sweeping continuously.",
      dither: "CV input that modulates Dither, sweeping the Bayer ordered-dither amount linearly over its full 0..1 range — higher CV dissolves the hard palette bands into cross-hatch.",
      mix: "CV input that modulates Mix, sweeping the dry/wet linearly over its full 0..1 range — 0 is the untouched source, 1 the full palette crush.",
    },
    outputs: {
      out: "The palette-crushed video frame: the source truncated to the chosen retro bit allocation, dithered by the Bayer amount, blended dry/wet by Mix.",
    },
    controls: {
      depth: "Depth — a 5-step discrete ladder of per-channel bit allocations: 1-1-1 (8 colours), 2-2-2 (64), 3-3-2 (256, the legacy 8-bit look, default), 4-4-4 (4096), 5-6-5 (65536, the legacy 16-bit look). Low steps are brutal posterize; high steps a subtle hi-colour rounding. The card shows the allocation name and palette size.",
      dither: "Dither — Bayer 4×4 ordered-dither amount (0..1, default 0). At 0 the palette bands are hard (the pure legacy crush); raising it perturbs the quantizer per screen pixel so band edges dissolve into alternating checkered pixels and gradients read as retro cross-hatch.",
      mix: "Mix — dry/wet (0..1, default 1). 1 is the full crush, 0 passes the source through untouched; in between blends the crushed and clean frames linearly.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex      = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');
    const uLevels   = gl.getUniformLocation(program, 'uLevels');
    const uDither   = gl.getUniformLocation(program, 'uDither');
    const uMix      = gl.getUniformLocation(program, 'uMix');

    const { fbo, texture } = ctx.createFbo();

    // Strip stray non-numeric / unknown keys so they can't bleed in.
    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    }
    const params: PosterboxParams = { ...POSTERBOX_DEFAULTS, ...(filtered as Partial<PosterboxParams>) };

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

        // Resolve the DEPTH step index → per-channel level counts.
        const [nr, ng, nb] = posterboxLevels(params.depth);
        g.uniform3f(uLevels, nr, ng, nb);
        g.uniform1f(uDither, Math.max(0, Math.min(1, params.dither)));
        g.uniform1f(uMix, Math.max(0, Math.min(1, params.mix)));

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
        // Card readout hooks: the current total bit depth + palette size.
        if (key === 'bitDepth') return posterboxBitDepth(params.depth);
        if (key === 'colorCount') return posterboxColorCount(params.depth);
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
