// packages/web/src/lib/video/modules/quadralogical.ts
//
// QUADRALOGICAL — 4-input video MIXER / processor driven by an XY joystick.
//
// ──────────────────────────────────────────────────────────────────────────
// HARD CONSTRAINT: this module is fully self-contained. It MUST NOT import or
// reference any TOYBOX code, nor chromakey.ts / lumakey.ts. Any shared
// algorithm (chroma / luma keying in Phase 2) is RE-IMPLEMENTED as GLSL text
// inside this file's shader sources — never imported. Phase 1 ships only the
// Cross-Dissolve composite; the transition framework + uniforms are present so
// Phase 2 can light up the other seven modes without re-plumbing the engine.
// ──────────────────────────────────────────────────────────────────────────
//
// WEIGHT MODEL — the joystick (pos_x, pos_y) in [-1, +1] maps to four
// per-input weights [w1, w2, w3, w4]. Corner → input map:
//   (-1, +1) = in1 (TL)   (+1, +1) = in2 (TR)
//   (-1, -1) = in3 (BL)   (+1, -1) = in4 (BR)
//
// Base is bilinear over the unit square (u = (x+1)/2, v = (y+1)/2):
//   b1 = (1-u)*v   b2 = u*v   b3 = (1-u)*(1-v)   b4 = u*(1-v)
// which already gives every corner (one-hot) + every edge (2-input) for free.
// Then a DIAMOND-AWARE power-sharpening forces a crisp 2-input region once the
// stick pushes past the inner yellow diamond toward an edge, while keeping a
// balanced 4-way blend INSIDE the diamond (the "all-4 composite" zone):
//   m = |x| + |y|                              (L1 distance from center)
//   t = smoothstep(MARGIN, 1.0, m)             (0 in diamond, 1 by inscribed sq)
//   p = 1 + K*t                                (sharpening power)
//   si = bi^p ; wi = si / sum(sj)              (renormalize, +1e-6 guard)
// MARGIN (diamond_margin, default 0.5) + K (blend_sharp, default 3) are exposed
// params, so the drawn diamond geometry is 1:1 with the math. The SAME math is
// implemented (a) as the pure TS helper quadWeights() below (unit-tested + used
// by the card's live dot) and (b) inline in MIX_FRAG_SRC, so the visual dot,
// the diamond, and the rendered composite agree to the number.
//
// NORMALLED INPUTS — an unpatched in{N} falls through to the nearest LOWER-
// indexed PATCHED input (in4→in3→in2→in1), Eurorack-style. So a single patched
// source blends against itself (never a black hole), and patching more inputs
// lights up their quadrants independently. If NOTHING is patched, all four bind
// the standalone emptyTex sentinel (true black). normalizeInputs() is the pure
// helper that resolves present[] → sourceIndex[4] for unit-test parity.
//
// RENDER — two FBOs per frame:
//   * MIX (canonical = surface.texture): the joystick-weighted composite. This
//     is what blitOutputToDrawingBuffer + the on-card preview + the default VRT
//     capture show, and what the `out` port emits.
//   * PREVIEW (read('outputTexture:preview')): a 2×2 tile of the four RAW
//     inputs (in1 TL, in2 TR, in3 BL, in4 BR), exposed via the `preview` port.
//     engine.lookupInput checks read('outputTexture:preview') BEFORE
//     surface.texture, so `preview` resolves to previewFbo while `out` falls
//     through to surface.texture (MIX).
//
// Inputs:
//   in1..in4 (video): four channel inputs (normalled down the chain).
//   pos_x / pos_y / diamond_margin / blend_sharp + the per-transition CV
//   params (cv, paramTarget == id).
//
// Outputs:
//   out (video): the MIX composite (canonical surface).
//   preview (video): the 2×2 raw-input monitor tile.
//
// Params:
//   pos_x / pos_y ([-1,1]): joystick position.
//   transition (discrete 0..7): active transition mode (Phase 1 = 0 live).
//   diamond_margin (default 0.5) / blend_sharp (default 3): weight-model tuning.
//   amount / threshold / softness / wipe_angle / feather / radius / fg_index /
//     bg_index / invert: per-transition controls (uniforms present in Phase 1,
//     consumed by the Phase-2 GLSL branches).
//   freeze (0..1, hidden): ≥0.5 → draw() is a no-op (VRT deterministic capture).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// ───────────────────────── pure weight-model helpers ─────────────────────────

/** Clamp v to [-1, +1] (the joystick / CV convention). NaN → 0. */
export function clampJoy(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}

/**
 * Joystick (x, y) → [w1, w2, w3, w4] per-input weights. The reference
 * implementation of the documented weight model — IDENTICAL math runs inline
 * in MIX_FRAG_SRC, so the card's live dot, the drawn diamond, and the rendered
 * composite agree. Always returns non-negative weights summing to 1.
 *
 *   margin = diamond half-diagonal (the |x|+|y| boundary of the all-4 zone)
 *   K      = sharpening strength outside the diamond
 */
export function quadWeights(
  x: number,
  y: number,
  margin = 0.5,
  K = 3,
): [number, number, number, number] {
  const cx = clampJoy(x);
  const cy = clampJoy(y);
  const u = (cx + 1) / 2;
  const v = (cy + 1) / 2;

  // Bilinear base — corner-mapped: w1 TL, w2 TR, w3 BL, w4 BR.
  const b1 = (1 - u) * v;
  const b2 = u * v;
  const b3 = (1 - u) * (1 - v);
  const b4 = u * (1 - v);

  const m = Math.abs(cx) + Math.abs(cy);
  const t = smoothstep(margin, 1.0, m);
  const p = 1 + K * t;

  const s1 = Math.pow(b1, p);
  const s2 = Math.pow(b2, p);
  const s3 = Math.pow(b3, p);
  const s4 = Math.pow(b4, p);
  // +1e-6 guard so the renormalize never divides by zero at exact corners
  // (where three of the four bilinear weights are 0 → s = 0 each).
  const S = s1 + s2 + s3 + s4 + 1e-6;
  return [s1 / S, s2 / S, s3 / S, s4 / S];
}

/** Scalar smoothstep matching the GLSL builtin (edge0 < edge1 assumed). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Eurorack normalling resolver. Given which inputs are physically patched,
 * return the SOURCE INDEX each of the four channels should sample:
 *   - a patched channel samples itself,
 *   - an unpatched channel falls through to the nearest LOWER-indexed patched
 *     channel (in4→in3→in2→in1),
 *   - if NOTHING is patched, every channel maps to -1 (the emptyTex sentinel /
 *     true black).
 * Pure so the draw()-side texture resolve + the unit test stay in lockstep.
 */
export function normalizeInputs(present: readonly boolean[]): number[] {
  const out: number[] = [];
  let lastPatched = -1;
  for (let i = 0; i < 4; i++) {
    if (present[i]) {
      lastPatched = i;
      out.push(i);
    } else {
      out.push(lastPatched); // -1 while no upstream seen yet (forward fill)
    }
  }
  return out;
}

// ───────────────────────── transition framework ─────────────────────────

/** The eight transition modes. Phase 1 implements only #0 (Cross-Dissolve)
 *  as the live composite; the others fall through to dissolve until Phase 2.
 *  Indices are the source-of-truth `transition` param values (0..7). */
export const TRANSITIONS = [
  'DISSOLVE',   // 0 — weighted cross-dissolve out = Σ wi·ci  [PHASE 1, live]
  'ADD',        // 1 — additive / screen                       [phase 2]
  'MULTIPLY',   // 2 — weighted multiply / darken              [phase 2]
  'WIPE',       // 3 — positional wipe (angle/feather)         [phase 2]
  'CHROMA',     // 4 — HSV hue-distance key (fg over bg)       [phase 2]
  'LUMA',       // 5 — Rec.601 luma key (fg over bg)           [phase 2]
  'DIFF',       // 6 — difference / subtract                   [phase 2]
  'IRIS',       // 7 — radial / iris wipe                      [phase 2]
] as const;

/** Per-transition dynamic-control-area descriptors. The card reads
 *  EFFECT_PARAMS[mode] and renders that mode's faders. Phase 1's only LIVE
 *  mode (DISSOLVE) needs no extra controls (pure joystick); the rest declare
 *  their Phase-2 param sets so the card UI + the uniforms are wired ahead of
 *  the GLSL branches. */
export const EFFECT_PARAMS: Record<number, Array<{ id: string; label: string }>> = {
  0: [], // DISSOLVE — pure joystick
  1: [{ id: 'amount', label: 'Amount' }],
  2: [{ id: 'amount', label: 'Amount' }],
  3: [
    { id: 'wipe_angle', label: 'Angle' },
    { id: 'feather', label: 'Feather' },
  ],
  4: [
    { id: 'threshold', label: 'Thr' },
    { id: 'softness', label: 'Soft' },
  ],
  5: [
    { id: 'threshold', label: 'Thr' },
    { id: 'softness', label: 'Soft' },
    { id: 'invert', label: 'Inv' },
  ],
  6: [{ id: 'amount', label: 'Amount' }],
  7: [
    { id: 'radius', label: 'Radius' },
    { id: 'feather', label: 'Feather' },
  ],
};

// ───────────────────────── shaders ─────────────────────────

// MIX shader. Binds the four (normalled) input textures, computes the four
// joystick weights via the EXACT quadWeights math, then composites through the
// ACTIVE transition. Phase 1: only uTransition == 0 (DISSOLVE) is a distinct
// branch; everything else falls through to the same weighted dissolve. The
// Phase-2 uniforms (uAmount/uThreshold/...) are declared so the card can drive
// them now and the GLSL branches drop in later without an engine change.
const MIX_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform sampler2D uTex3;
uniform float uHas0;
uniform float uHas1;
uniform float uHas2;
uniform float uHas3;

uniform float uPosX;
uniform float uPosY;
uniform float uMargin;   // diamond_margin
uniform float uSharp;    // blend_sharp (K)

// Transition framework uniforms (Phase-1 present; Phase-2 consumes).
uniform int   uTransition;
uniform int   uFgIndex;
uniform int   uBgIndex;
uniform float uAmount;
uniform float uThreshold;
uniform float uSoftness;
uniform float uWipeAngle;
uniform float uFeather;
uniform float uRadius;
uniform float uInvert;

vec3 sampleOrZero(sampler2D s, float has, vec2 uv) {
  return has > 0.5 ? texture(s, uv).rgb : vec3(0.0);
}

// EXACT match of the TS quadWeights() helper.
void quadWeights(float x, float y, float margin, float K, out float w[4]) {
  float u = (x + 1.0) * 0.5;
  float v = (y + 1.0) * 0.5;
  float b1 = (1.0 - u) * v;
  float b2 = u * v;
  float b3 = (1.0 - u) * (1.0 - v);
  float b4 = u * (1.0 - v);
  float m = abs(x) + abs(y);
  float t = smoothstep(margin, 1.0, m);
  float p = 1.0 + K * t;
  float s1 = pow(b1, p);
  float s2 = pow(b2, p);
  float s3 = pow(b3, p);
  float s4 = pow(b4, p);
  float S = s1 + s2 + s3 + s4 + 1e-6;
  w[0] = s1 / S;
  w[1] = s2 / S;
  w[2] = s3 / S;
  w[3] = s4 / S;
}

void main() {
  vec3 c0 = sampleOrZero(uTex0, uHas0, vUv);
  vec3 c1 = sampleOrZero(uTex1, uHas1, vUv);
  vec3 c2 = sampleOrZero(uTex2, uHas2, vUv);
  vec3 c3 = sampleOrZero(uTex3, uHas3, vUv);

  float w[4];
  quadWeights(uPosX, uPosY, uMargin, uSharp, w);

  // PHASE 1: every transition currently resolves to the weighted
  // cross-dissolve out = Σ wi·ci. The framework branch is here so Phase 2
  // can fork on uTransition (ADD/MULTIPLY/WIPE/CHROMA/LUMA/DIFF/IRIS) using
  // the already-bound uniforms above — no engine/plumbing change needed.
  vec3 outRgb = w[0] * c0 + w[1] * c1 + w[2] * c2 + w[3] * c3;

  outColor = vec4(clamp(outRgb, 0.0, 1.0), 1.0);
}`;

// PREVIEW shader. A 2×2 tile of the four RAW inputs. Quadrant → input map
// mirrors the corner → input map (in1 TL, in2 TR, in3 BL, in4 BR). vUv has
// origin bottom-left (the engine's FBO convention), so v > 0.5 = top row.
const PREVIEW_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform sampler2D uTex3;
uniform float uHas0;
uniform float uHas1;
uniform float uHas2;
uniform float uHas3;

void main() {
  bool left = vUv.x < 0.5;
  bool top  = vUv.y >= 0.5;            // bottom-left origin: v>=0.5 = top row
  // Local 0..1 uv within the chosen quadrant.
  vec2 local = vec2(
    left ? vUv.x * 2.0 : (vUv.x - 0.5) * 2.0,
    top  ? (vUv.y - 0.5) * 2.0 : vUv.y * 2.0
  );

  vec3 col;
  if (top && left)        col = uHas0 > 0.5 ? texture(uTex0, local).rgb : vec3(0.0); // in1 TL
  else if (top && !left)  col = uHas1 > 0.5 ? texture(uTex1, local).rgb : vec3(0.0); // in2 TR
  else if (!top && left)  col = uHas2 > 0.5 ? texture(uTex2, local).rgb : vec3(0.0); // in3 BL
  else                    col = uHas3 > 0.5 ? texture(uTex3, local).rgb : vec3(0.0); // in4 BR

  // Thin separator cross so the four tiles read as distinct cells.
  vec2 d = abs(vUv - 0.5);
  float line = (min(d.x, d.y) < 0.004) ? 1.0 : 0.0;
  col = mix(col, vec3(0.12), line);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ───────────────────────── params / defaults ─────────────────────────

export const QUADRALOGICAL_DEFAULT_MARGIN = 0.5;
export const QUADRALOGICAL_DEFAULT_SHARP = 3;

interface QuadParams {
  pos_x: number;
  pos_y: number;
  transition: number;
  diamond_margin: number;
  blend_sharp: number;
  amount: number;
  threshold: number;
  softness: number;
  wipe_angle: number;
  feather: number;
  radius: number;
  fg_index: number;
  bg_index: number;
  invert: number;
  freeze: number;
}

const DEFAULTS: QuadParams = {
  pos_x: 0,
  pos_y: 0,
  transition: 0,
  diamond_margin: QUADRALOGICAL_DEFAULT_MARGIN,
  blend_sharp: QUADRALOGICAL_DEFAULT_SHARP,
  amount: 1,
  threshold: 0.5,
  softness: 0.1,
  wipe_angle: 0,
  feather: 0.1,
  radius: 0.5,
  fg_index: 0,
  bg_index: 1,
  invert: 0,
  freeze: 0,
};

const INPUT_IDS = ['in1', 'in2', 'in3', 'in4'] as const;

export const quadralogicalDef: VideoModuleDef = {
  type: 'quadralogical',
  palette: { top: 'Video modules', sub: 'Utilities' },
  domain: 'video',
  label: 'QUADRALOGICAL',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [
    { id: 'in1', type: 'video' },
    { id: 'in2', type: 'video' },
    { id: 'in3', type: 'video' },
    { id: 'in4', type: 'video' },
    // Per the PR #264 convention every CV input declares paramTarget == its
    // own id, so the cross-domain bridge + docs manifest stay in sync and the
    // cv-paramtarget-invariant unit gate passes.
    { id: 'pos_x',          type: 'cv', paramTarget: 'pos_x',          cvScale: { mode: 'linear' } },
    { id: 'pos_y',          type: 'cv', paramTarget: 'pos_y',          cvScale: { mode: 'linear' } },
    { id: 'diamond_margin', type: 'cv', paramTarget: 'diamond_margin', cvScale: { mode: 'linear' } },
    { id: 'blend_sharp',    type: 'cv', paramTarget: 'blend_sharp',    cvScale: { mode: 'linear' } },
    { id: 'amount',         type: 'cv', paramTarget: 'amount',         cvScale: { mode: 'linear' } },
    { id: 'threshold',      type: 'cv', paramTarget: 'threshold',      cvScale: { mode: 'linear' } },
    { id: 'softness',       type: 'cv', paramTarget: 'softness',       cvScale: { mode: 'linear' } },
    { id: 'wipe_angle',     type: 'cv', paramTarget: 'wipe_angle',     cvScale: { mode: 'linear' } },
    { id: 'feather',        type: 'cv', paramTarget: 'feather',        cvScale: { mode: 'linear' } },
    { id: 'radius',         type: 'cv', paramTarget: 'radius',         cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },      // canonical = MIX (surface.texture)
    { id: 'preview', type: 'video' },  // 2×2 raw-input monitor tile
  ],
  params: [
    { id: 'pos_x',          label: 'X',       defaultValue: DEFAULTS.pos_x,          min: -1, max: 1, curve: 'linear' },
    { id: 'pos_y',          label: 'Y',       defaultValue: DEFAULTS.pos_y,          min: -1, max: 1, curve: 'linear' },
    { id: 'transition',     label: 'Mode',    defaultValue: DEFAULTS.transition,     min: 0,  max: 7, curve: 'discrete' },
    { id: 'diamond_margin', label: 'Diamond', defaultValue: DEFAULTS.diamond_margin, min: 0,  max: 1, curve: 'linear' },
    { id: 'blend_sharp',    label: 'Sharp',   defaultValue: DEFAULTS.blend_sharp,    min: 0,  max: 8, curve: 'linear' },
    { id: 'amount',         label: 'Amount',  defaultValue: DEFAULTS.amount,         min: 0,  max: 1, curve: 'linear' },
    { id: 'threshold',      label: 'Thr',     defaultValue: DEFAULTS.threshold,      min: 0,  max: 1, curve: 'linear' },
    { id: 'softness',       label: 'Soft',    defaultValue: DEFAULTS.softness,       min: 0,  max: 0.5, curve: 'linear' },
    { id: 'wipe_angle',     label: 'Angle',   defaultValue: DEFAULTS.wipe_angle,     min: 0,  max: 360, curve: 'linear' },
    { id: 'feather',        label: 'Feather', defaultValue: DEFAULTS.feather,        min: 0,  max: 1, curve: 'linear' },
    { id: 'radius',         label: 'Radius',  defaultValue: DEFAULTS.radius,         min: 0,  max: 1, curve: 'linear' },
    { id: 'fg_index',       label: 'FG',      defaultValue: DEFAULTS.fg_index,       min: 0,  max: 3, curve: 'discrete' },
    { id: 'bg_index',       label: 'BG',      defaultValue: DEFAULTS.bg_index,       min: 0,  max: 3, curve: 'discrete' },
    { id: 'invert',         label: 'Inv',     defaultValue: DEFAULTS.invert,         min: 0,  max: 1, curve: 'linear' },
    // freeze is a hidden VRT/determinism toggle — no card control.
    { id: 'freeze',         label: 'Freeze',  defaultValue: DEFAULTS.freeze,         min: 0,  max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const mixProgram = ctx.compileFragment(MIX_FRAG_SRC);
    const previewProgram = ctx.compileFragment(PREVIEW_FRAG_SRC);

    // ---- MIX program uniform locations ----
    const mixU = {
      tex: [
        gl.getUniformLocation(mixProgram, 'uTex0'),
        gl.getUniformLocation(mixProgram, 'uTex1'),
        gl.getUniformLocation(mixProgram, 'uTex2'),
        gl.getUniformLocation(mixProgram, 'uTex3'),
      ],
      has: [
        gl.getUniformLocation(mixProgram, 'uHas0'),
        gl.getUniformLocation(mixProgram, 'uHas1'),
        gl.getUniformLocation(mixProgram, 'uHas2'),
        gl.getUniformLocation(mixProgram, 'uHas3'),
      ],
      posX: gl.getUniformLocation(mixProgram, 'uPosX'),
      posY: gl.getUniformLocation(mixProgram, 'uPosY'),
      margin: gl.getUniformLocation(mixProgram, 'uMargin'),
      sharp: gl.getUniformLocation(mixProgram, 'uSharp'),
      transition: gl.getUniformLocation(mixProgram, 'uTransition'),
      fgIndex: gl.getUniformLocation(mixProgram, 'uFgIndex'),
      bgIndex: gl.getUniformLocation(mixProgram, 'uBgIndex'),
      amount: gl.getUniformLocation(mixProgram, 'uAmount'),
      threshold: gl.getUniformLocation(mixProgram, 'uThreshold'),
      softness: gl.getUniformLocation(mixProgram, 'uSoftness'),
      wipeAngle: gl.getUniformLocation(mixProgram, 'uWipeAngle'),
      feather: gl.getUniformLocation(mixProgram, 'uFeather'),
      radius: gl.getUniformLocation(mixProgram, 'uRadius'),
      invert: gl.getUniformLocation(mixProgram, 'uInvert'),
    };

    // ---- PREVIEW program uniform locations ----
    const prevU = {
      tex: [
        gl.getUniformLocation(previewProgram, 'uTex0'),
        gl.getUniformLocation(previewProgram, 'uTex1'),
        gl.getUniformLocation(previewProgram, 'uTex2'),
        gl.getUniformLocation(previewProgram, 'uTex3'),
      ],
      has: [
        gl.getUniformLocation(previewProgram, 'uHas0'),
        gl.getUniformLocation(previewProgram, 'uHas1'),
        gl.getUniformLocation(previewProgram, 'uHas2'),
        gl.getUniformLocation(previewProgram, 'uHas3'),
      ],
    };

    // mixFbo is the CANONICAL surface (out port + on-card preview + VRT);
    // previewFbo is exposed only via read('outputTexture:preview').
    const mixFbo = ctx.createFbo();
    const previewFbo = ctx.createFbo();

    // Sentinel 1×1 black texture for the all-unpatched case. NEVER bind our
    // OWN FBO texture as a placeholder — that's a GL feedback loop (read+write
    // the same texture) which silently produces garbage on Chrome (see
    // mixer.ts / 4plexvid.ts). Normalling falls through to a patched UPSTREAM
    // input or to this standalone sentinel — never own output.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('QUADRALOGICAL: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: QuadParams = { ...DEFAULTS, ...(node.params as Partial<QuadParams>) };

    /** Resolve the four normalled input textures for this frame. Returns the
     *  WebGLTexture (or null) each channel should bind, applying the Eurorack
     *  forward-fill (in4→in3→in2→in1). null means "nothing upstream" → the
     *  caller binds emptyTex + sets uHas = 0. */
    function resolveTextures(frame: Parameters<VideoNodeSurface['draw']>[0]): Array<WebGLTexture | null> {
      const raw: Array<WebGLTexture | null> = INPUT_IDS.map((id) =>
        frame.getInputTexture(node.id, id),
      );
      const present = raw.map((t) => t !== null);
      const srcIdx = normalizeInputs(present);
      return srcIdx.map((idx) => (idx >= 0 ? raw[idx]! : null));
    }

    const surface: VideoNodeSurface = {
      fbo: mixFbo.fbo,
      texture: mixFbo.texture,
      draw(frame) {
        // freeze (VRT determinism): hold the last rendered frame in BOTH FBOs.
        if (params.freeze >= 0.5) return;

        const g = frame.gl;
        const resolved = resolveTextures(frame);

        // ---- Pass 1: MIX → mixFbo (the canonical surface) ----
        g.bindFramebuffer(g.FRAMEBUFFER, mixFbo.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(mixProgram);
        for (let i = 0; i < 4; i++) {
          const tex = resolved[i]!;
          g.activeTexture(g.TEXTURE0 + i);
          g.bindTexture(g.TEXTURE_2D, tex ?? emptyTex);
          g.uniform1i(mixU.tex[i]!, i);
          g.uniform1f(mixU.has[i]!, tex ? 1.0 : 0.0);
        }
        g.uniform1f(mixU.posX, clampJoy(params.pos_x));
        g.uniform1f(mixU.posY, clampJoy(params.pos_y));
        g.uniform1f(mixU.margin, params.diamond_margin);
        g.uniform1f(mixU.sharp, params.blend_sharp);
        g.uniform1i(mixU.transition, Math.round(params.transition));
        g.uniform1i(mixU.fgIndex, Math.round(params.fg_index));
        g.uniform1i(mixU.bgIndex, Math.round(params.bg_index));
        g.uniform1f(mixU.amount, params.amount);
        g.uniform1f(mixU.threshold, params.threshold);
        g.uniform1f(mixU.softness, params.softness);
        g.uniform1f(mixU.wipeAngle, params.wipe_angle);
        g.uniform1f(mixU.feather, params.feather);
        g.uniform1f(mixU.radius, params.radius);
        g.uniform1f(mixU.invert, params.invert);
        ctx.drawFullscreenQuad();

        // ---- Pass 2: PREVIEW → previewFbo (raw 2×2 tile) ----
        g.bindFramebuffer(g.FRAMEBUFFER, previewFbo.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(previewProgram);
        for (let i = 0; i < 4; i++) {
          const tex = resolved[i]!;
          g.activeTexture(g.TEXTURE0 + i);
          g.bindTexture(g.TEXTURE_2D, tex ?? emptyTex);
          g.uniform1i(prevU.tex[i]!, i);
          g.uniform1f(prevU.has[i]!, tex ? 1.0 : 0.0);
        }
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(mixFbo.fbo);
        gl.deleteTexture(mixFbo.texture);
        gl.deleteFramebuffer(previewFbo.fbo);
        gl.deleteTexture(previewFbo.texture);
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(mixProgram);
        gl.deleteProgram(previewProgram);
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
        // Per-output texture escape hatch — engine.lookupInput checks this
        // BEFORE surface.texture, so `preview` resolves to previewFbo while
        // `out` falls through to surface.texture (MIX).
        if (key === 'outputTexture:preview') return previewFbo.texture;
        if (key === 'outputTexture:out') return mixFbo.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
