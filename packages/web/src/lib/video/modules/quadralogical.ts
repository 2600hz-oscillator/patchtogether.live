// packages/web/src/lib/video/modules/quadralogical.ts
//
// QUADRALOGICAL — 4-input video MIXER / processor driven by an XY joystick.
//
// ──────────────────────────────────────────────────────────────────────────
// HARD CONSTRAINT: this module is fully self-contained. It MUST NOT import or
// reference any TOYBOX code, nor chromakey.ts / lumakey.ts. Any shared
// algorithm (chroma / luma keying) is RE-IMPLEMENTED as GLSL text inside this
// file's shader source — never imported.
// ──────────────────────────────────────────────────────────────────────────
//
// PHASE 2 — the headline change: there is no longer a single global transition.
// Each of the FOUR edges of the joystick cycle (1↔2, 2↔3, 3↔4, 4↔1) carries its
// OWN independently-selectable effect (DISSOLVE / ADD / MULTIPLY / WIPE / CHROMA
// / LUMA / DIFF / IRIS), with its own per-effect params + its own CV inputs. All
// 8 effects are implemented as real 2-input blends (Phase 1 shipped only the
// weighted cross-dissolve).
//
// WEIGHT MODEL — the joystick (pos_x, pos_y) in [-1, +1] maps to four per-input
// CORNER weights [w1, w2, w3, w4]. Corner → input map:
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
// params, so the drawn diamond geometry is 1:1 with the math. quadWeights() is
// the pure TS reference, mirrored EXACTLY inline in MIX_FRAG_SRC, so the card's
// live dot, the drawn diamond, and the rendered composite agree to the number.
//
// EDGE-COMPOSITE MODEL (Phase 2) — from the four corner weights we derive, for
// each edge a↔b, a (mass, ratio) pair via the pure helper edgeWeights():
//   pair_mass_ab = w_a + w_b               (how "active" the a↔b pair is)
//   ratio_ab     = w_b / (w_a + w_b)       (within-edge mix: 0 = pure a → 1 = b)
// Each edge runs its OWN effect on its two adjacent inputs at that ratio:
//   blend_ab = effect_{edge}(c_a, c_b, ratio_ab, edgeParams)
// and the four edge-blends are LAYERED (composited) weighted by pair_mass:
//   out = Σ pair_mass_ab · blend_ab / Σ pair_mass_ab
// Edge cycle (index order, NOT geometric adjacency — see PR notes): the diamond
// goes 1→2→3→4→1, so the four edges are (1,2) (2,3) (3,4) (4,1). This makes a
// corner resolve to its pure input (the two edges that touch it both collapse
// to that input) and the center a balanced composite of all four edge-blends.
// edgeWeights() is the pure TS reference, mirrored EXACTLY inline in the shader.
//
// NORMALLED INPUTS — an unpatched in{N} falls through to the nearest LOWER-
// indexed PATCHED input (in4→in3→in2→in1), Eurorack-style. So a single patched
// source blends against itself (never a black hole), and patching more inputs
// lights up their quadrants independently. If NOTHING is patched, all four bind
// the standalone emptyTex sentinel (true black). normalizeInputs() is the pure
// helper that resolves present[] → sourceIndex[4] for unit-test parity.
//
// RENDER — two FBOs per frame:
//   * MIX (canonical = surface.texture): the joystick-weighted edge composite.
//     This is what blitOutputToDrawingBuffer + the on-card preview + the default
//     VRT capture show, and what the `out` port emits.
//   * PREVIEW (read('outputTexture:preview')): a 2×2 tile of the four RAW
//     inputs (in1 TL, in2 TR, in3 BL, in4 BR), exposed via the `preview` port.
//     engine.lookupInput checks read('outputTexture:preview') BEFORE
//     surface.texture, so `preview` resolves to previewFbo while `out` falls
//     through to surface.texture (MIX).
//
// Inputs:
//   in1..in4 (video): four channel inputs (normalled down the chain).
//   pos_x / pos_y / diamond_margin / blend_sharp (cv, paramTarget == id).
//   per-edge CV: edge{N}_amount / edge{N}_param (cv) for N in 1..4 — modulate
//     the active effect's primary + secondary control on each edge.
//   keyR / keyG / keyB (cv): shared chroma key colour (used by any CHROMA edge).
//
// Outputs:
//   out (video): the MIX composite (canonical surface).
//   preview (video): the 2×2 raw-input monitor tile.
//
// Params:
//   pos_x / pos_y ([-1,1]): joystick position.
//   edge1_fx .. edge4_fx (discrete 0..7): per-edge effect selection.
//   edge1_amount .. edge4_amount + edge1_param .. edge4_param: per-edge effect
//     controls (semantics depend on that edge's selected effect; see EFFECTS).
//   diamond_margin (default 0.5) / blend_sharp (default 3): weight-model tuning.
//   keyR / keyG / keyB: shared chroma key colour for CHROMA edges.
//   invert (0..1): global luma/chroma key inversion.
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
 * The four EDGE index pairs, in the diamond cycle order 1→2→3→4→1. Each entry
 * is the [a, b] zero-based corner-weight indices the edge blends. NOT geometric
 * adjacency (2↔3 = TR↔BL is a diagonal of the pad) — it's the index cycle the
 * Phase-2 spec defines, so the four per-edge effect slots map 1:1 to
 * (1↔2, 2↔3, 3↔4, 4↔1). See the header EDGE-COMPOSITE MODEL note + the PR body.
 */
export const EDGE_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // edge 1: in1 ↔ in2
  [1, 2], // edge 2: in2 ↔ in3
  [2, 3], // edge 3: in3 ↔ in4
  [3, 0], // edge 4: in4 ↔ in1
] as const;

/** Per-edge composite term: how active the edge is (mass) + where within the
 *  edge the blend sits (ratio: 0 = pure first input, 1 = pure second). */
export interface EdgeTerm {
  /** w_a + w_b — the layering weight for this edge's blend in the composite. */
  mass: number;
  /** w_b / (w_a + w_b) — the 2-input mix ratio fed to the edge's effect. */
  ratio: number;
}

/**
 * Joystick (x, y) → the four EDGE-composite terms, derived from quadWeights().
 * For each edge a↔b: mass = w_a + w_b, ratio = w_b / (w_a + w_b). The pure TS
 * reference of the edge math, mirrored EXACTLY inline in MIX_FRAG_SRC so the
 * card's diamond/dot and the rendered composite stay in lockstep.
 *
 * Properties (unit-tested):
 *   - At a corner, the two edges that touch that corner collapse to its pure
 *     input (ratio → 0 or 1) and the other two edges have mass 0, so the
 *     composite resolves to the pure corner input.
 *   - At the center every mass = 0.5 and every ratio = 0.5 — a balanced blend.
 *   - Continuous everywhere: a vanishing edge (mass → 0) contributes 0 to the
 *     composite, so the guarded ratio's value there is irrelevant (no jump).
 */
export function edgeWeights(
  x: number,
  y: number,
  margin = 0.5,
  K = 3,
): [EdgeTerm, EdgeTerm, EdgeTerm, EdgeTerm] {
  const w = quadWeights(x, y, margin, K);
  const term = ([a, b]: readonly [number, number]): EdgeTerm => {
    const mass = w[a]! + w[b]!;
    // Guard so a dead edge (mass 0) doesn't divide 0/0; its mass is 0 so the
    // ratio never reaches the composite anyway. Default 0.5 = neutral midpoint.
    const ratio = mass > 1e-6 ? w[b]! / mass : 0.5;
    return { mass, ratio };
  };
  return [
    term(EDGE_PAIRS[0]!),
    term(EDGE_PAIRS[1]!),
    term(EDGE_PAIRS[2]!),
    term(EDGE_PAIRS[3]!),
  ];
}

// ───────────────────────── pure 2-input blend reference ─────────────────────
//
// blend2() is the TS reference for the per-edge effect math, mirrored EXACTLY
// by the GLSL `blend()` in MIX_FRAG_SRC. `t` is the within-edge mix ratio
// (0 = pure a, 1 = pure b). The unit suite cross-checks each branch here; the
// shader is the rendered truth. Colours/params are [0,1].

/** RGB → HSV (h,s,v all in [0,1]); matches the GLSL rgbToHsv. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const v = mx;
  const d = mx - mn;
  const s = mx > 1e-4 ? d / mx : 0;
  let h = 0;
  if (d > 1e-4) {
    if (mx === r) { h = (g - b) / d; if (h < 0) h += 6; }
    else if (mx === g) { h = (b - r) / d + 2; }
    else { h = (r - g) / d + 4; }
    h /= 6;
  }
  return [h, s, v];
}

/** Hue-circle distance in [0, 0.5]; matches the GLSL hueDistance. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
}

export type RGB = [number, number, number];

export interface BlendParams {
  /** Primary control (edge{N}_amount): see each effect's semantics. */
  amount: number;
  /** Secondary control (edge{N}_param): wipe softness, key softness, iris
   *  feather, etc. */
  param: number;
  /** Shared chroma key colour. */
  key: RGB;
  /** Global key inversion (0/1). */
  invert: number;
  /** Pixel UV in [0,1] — needed by the spatial effects (WIPE / IRIS). */
  uv: [number, number];
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const mix1 = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix3 = (a: RGB, b: RGB, t: number): RGB =>
  [mix1(a[0], b[0], t), mix1(a[1], b[1], t), mix1(a[2], b[2], t)];

/**
 * Pure 2-input blend reference. `fx` is a TRANSITIONS index. `t` is the
 * within-edge ratio. Returns the blended RGB. The GLSL `blend()` reproduces
 * each branch bit-for-bit (same math, same constants).
 */
export function blend2(fx: number, a: RGB, b: RGB, t: number, p: BlendParams): RGB {
  switch (fx) {
    case 1: { // ADD — screen-ish additive crossfade, scaled by ratio.
      // out = a + b·t·amount (clamped). At t=0 → a; ramps in b additively.
      const k = t * clamp01(p.amount);
      return [clamp01(a[0] + b[0] * k), clamp01(a[1] + b[1] * k), clamp01(a[2] + b[2] * k)];
    }
    case 2: { // MULTIPLY — darken; ratio fades from a → a·b.
      const prod: RGB = [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
      return mix3(a, prod, t * clamp01(p.amount));
    }
    case 3: { // WIPE — directional hard/soft wipe; angle = amount·2π, feather = param.
      const ang = clamp01(p.amount) * Math.PI * 2;
      const dir: [number, number] = [Math.cos(ang), Math.sin(ang)];
      // Signed distance of this pixel along the wipe axis, in [-1,1]-ish.
      const proj = (p.uv[0] - 0.5) * dir[0] + (p.uv[1] - 0.5) * dir[1];
      const soft = Math.max(p.param, 1e-3) * 0.5;
      // Wipe line position tracks the ratio (0 → all a, 1 → all b).
      const edge = (t - 0.5) * (1 + 2 * soft);
      const m = smoothstep(edge - soft, edge + soft, proj);
      return mix3(a, b, m);
    }
    case 4: { // CHROMA — key colour OUT of `a`, reveal `b`. amount=threshold, param=softness.
      const [ah, as] = rgbToHsv(a[0], a[1], a[2]);
      const [kh] = rgbToHsv(p.key[0], p.key[1], p.key[2]);
      const hd = hueDistance(ah, kh);
      const satGate = smoothstep(0.04, 0.18, as);
      const tol = clamp01(p.amount) * 0.5;
      const sft = Math.max(clamp01(p.param), 1e-3) * 0.5;
      let alpha = mix1(1, smoothstep(tol, tol + sft, hd), satGate);
      if (p.invert >= 0.5) alpha = 1 - alpha;
      // alpha=1 → keep a; alpha=0 → reveal b. Cross-fade the whole effect by t.
      return mix3(a, mix3(b, a, alpha), t);
    }
    case 5: { // LUMA — key `a` by its luma; amount=threshold, param=softness.
      const luma = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
      const tol = clamp01(p.amount);
      const sft = Math.max(clamp01(p.param), 1e-3);
      let alpha = smoothstep(tol - sft, tol + sft, luma);
      if (p.invert >= 0.5) alpha = 1 - alpha;
      return mix3(a, mix3(b, a, alpha), t);
    }
    case 6: { // DIFF — absolute difference; ratio fades from a → |a-b|.
      const diff: RGB = [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])];
      return mix3(a, diff, t * clamp01(p.amount));
    }
    case 7: { // IRIS — radial wipe from center; amount=radius bias, param=feather.
      const dx = p.uv[0] - 0.5;
      const dy = p.uv[1] - 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy) / 0.7071; // normalize corner→1.
      const soft = Math.max(p.param, 1e-3) * 0.5;
      // Iris radius opens with the ratio (and an amount bias).
      const radius = clamp01(t * (0.5 + clamp01(p.amount)));
      const m = smoothstep(radius - soft, radius + soft, dist);
      // inside the iris (dist<radius) → b, outside → a.
      return mix3(b, a, m);
    }
    default: // 0 DISSOLVE — plain linear cross-dissolve a → b.
      return mix3(a, b, t);
  }
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

// ───────────────────────── effect framework ─────────────────────────

/** The eight blend effects — ALL implemented as real 2-input blends (Phase 2).
 *  Indices are the source-of-truth per-edge `edge{N}_fx` param values (0..7). */
export const TRANSITIONS = [
  'DISSOLVE',   // 0 — linear cross-dissolve  a → b
  'ADD',        // 1 — additive / screen      a + b·t
  'MULTIPLY',   // 2 — multiply / darken      a → a·b
  'WIPE',       // 3 — directional wipe (angle / softness)
  'CHROMA',     // 4 — HSV hue-distance key (key `a`, reveal `b`)
  'LUMA',       // 5 — Rec.601 luma key (key `a`, reveal `b`)
  'DIFF',       // 6 — absolute difference  a → |a−b|
  'IRIS',       // 7 — radial / iris wipe (radius / feather)
] as const;

/** What each effect's two PER-EDGE controls mean. The card reads EFFECTS[fx]
 *  and labels that edge's `amount` + `param` faders accordingly (a slot with a
 *  `null` label is hidden for that effect — e.g. DISSOLVE is pure ratio). The
 *  ids are always `amount` / `param` (the per-edge param suffixes), so the same
 *  two faders re-label per the selected effect rather than spawning a new set. */
export const EFFECTS: Record<number, { amount: string | null; param: string | null }> = {
  0: { amount: null, param: null },         // DISSOLVE — pure joystick ratio
  1: { amount: 'Amt', param: null },        // ADD
  2: { amount: 'Amt', param: null },        // MULTIPLY
  3: { amount: 'Angle', param: 'Soft' },    // WIPE
  4: { amount: 'Thr', param: 'Soft' },      // CHROMA
  5: { amount: 'Thr', param: 'Soft' },      // LUMA
  6: { amount: 'Amt', param: null },        // DIFF
  7: { amount: 'Radius', param: 'Feather' },// IRIS
};

/** Back-compat alias: the per-edge control descriptors as a fader list (used by
 *  the card to render the dynamic control area for one edge). */
export const EFFECT_PARAMS: Record<number, Array<{ id: 'amount' | 'param'; label: string }>> =
  Object.fromEntries(
    Object.entries(EFFECTS).map(([k, v]) => [
      Number(k),
      ([
        v.amount ? { id: 'amount' as const, label: v.amount } : null,
        v.param ? { id: 'param' as const, label: v.param } : null,
      ].filter(Boolean) as Array<{ id: 'amount' | 'param'; label: string }>),
    ]),
  );

/** The four per-edge effect slots (id prefix + human label). */
export const EDGES = [
  { id: 'edge1', label: '1–2' },
  { id: 'edge2', label: '2–3' },
  { id: 'edge3', label: '3–4' },
  { id: 'edge4', label: '4–1' },
] as const;

// ───────────────────────── shaders ─────────────────────────

// MIX shader (Phase 2). Binds the four (normalled) input textures, computes the
// four joystick CORNER weights via the EXACT quadWeights math, derives the four
// EDGE (mass, ratio) terms, runs EACH edge's selected effect on its two adjacent
// inputs, then layers the four edge-blends weighted by mass. The 8 blend
// branches reproduce the TS blend2() reference bit-for-bit.
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

// Per-edge effect + controls (edge cycle 1↔2, 2↔3, 3↔4, 4↔1).
uniform int   uEdgeFx[4];      // edge{N}_fx  (0..7)
uniform float uEdgeAmount[4];  // edge{N}_amount
uniform float uEdgeParam[4];   // edge{N}_param

// Shared chroma key colour + global key inversion.
uniform float uKeyR;
uniform float uKeyG;
uniform float uKeyB;
uniform float uInvert;

const float PI = 3.14159265359;

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

// ---- HSV helpers (re-implemented; never imported from chromakey.ts) ----
vec3 rgbToHsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float v = mx;
  float d = mx - mn;
  float s = (mx > 0.0001) ? d / mx : 0.0;
  float h = 0.0;
  if (d > 0.0001) {
    if (mx == c.r) { h = (c.g - c.b) / d; if (h < 0.0) h += 6.0; }
    else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
    else { h = (c.r - c.g) / d + 4.0; }
    h /= 6.0;
  }
  return vec3(h, s, v);
}
float hueDistance(float a, float b) {
  float d = abs(a - b);
  return min(d, 1.0 - d);
}

// EXACT match of the TS blend2(): the per-edge 2-input blend. t = within-edge
// ratio (0 = pure a → 1 = pure b). uv = this pixel; key = shared chroma colour.
vec3 blend(int fx, vec3 a, vec3 b, float t, float amount, float param, vec3 key, float invert, vec2 uv) {
  if (fx == 1) {            // ADD
    float k = t * clamp(amount, 0.0, 1.0);
    return clamp(a + b * k, 0.0, 1.0);
  } else if (fx == 2) {     // MULTIPLY
    return mix(a, a * b, t * clamp(amount, 0.0, 1.0));
  } else if (fx == 3) {     // WIPE
    float ang = clamp(amount, 0.0, 1.0) * PI * 2.0;
    vec2 dir = vec2(cos(ang), sin(ang));
    float proj = dot(uv - 0.5, dir);
    float soft = max(param, 1e-3) * 0.5;
    float edge = (t - 0.5) * (1.0 + 2.0 * soft);
    float m = smoothstep(edge - soft, edge + soft, proj);
    return mix(a, b, m);
  } else if (fx == 4) {     // CHROMA — key colour OUT of a, reveal b
    vec3 ah = rgbToHsv(a);
    vec3 kh = rgbToHsv(key);
    float hd = hueDistance(ah.x, kh.x);
    float satGate = smoothstep(0.04, 0.18, ah.y);
    float tol = clamp(amount, 0.0, 1.0) * 0.5;
    float sft = max(clamp(param, 0.0, 1.0), 1e-3) * 0.5;
    float alpha = mix(1.0, smoothstep(tol, tol + sft, hd), satGate);
    if (invert >= 0.5) alpha = 1.0 - alpha;
    return mix(a, mix(b, a, alpha), t);
  } else if (fx == 5) {     // LUMA — key a by its luma, reveal b
    float luma = dot(a, vec3(0.299, 0.587, 0.114));
    float tol = clamp(amount, 0.0, 1.0);
    float sft = max(clamp(param, 0.0, 1.0), 1e-3);
    float alpha = smoothstep(tol - sft, tol + sft, luma);
    if (invert >= 0.5) alpha = 1.0 - alpha;
    return mix(a, mix(b, a, alpha), t);
  } else if (fx == 6) {     // DIFF
    return mix(a, abs(a - b), t * clamp(amount, 0.0, 1.0));
  } else if (fx == 7) {     // IRIS — radial wipe from center
    float dist = length(uv - 0.5) / 0.7071;
    float soft = max(param, 1e-3) * 0.5;
    float radius = clamp(t * (0.5 + clamp(amount, 0.0, 1.0)), 0.0, 1.0);
    float m = smoothstep(radius - soft, radius + soft, dist);
    return mix(b, a, m);
  }
  return mix(a, b, t);      // 0 DISSOLVE
}

void main() {
  vec3 c0 = sampleOrZero(uTex0, uHas0, vUv);
  vec3 c1 = sampleOrZero(uTex1, uHas1, vUv);
  vec3 c2 = sampleOrZero(uTex2, uHas2, vUv);
  vec3 c3 = sampleOrZero(uTex3, uHas3, vUv);
  vec3 c[4];
  c[0] = c0; c[1] = c1; c[2] = c2; c[3] = c3;

  float w[4];
  quadWeights(uPosX, uPosY, uMargin, uSharp, w);

  // Edge cycle 1→2→3→4→1: pairs (0,1) (1,2) (2,3) (3,0). EXACT mirror of the
  // TS EDGE_PAIRS + edgeWeights(). Each edge runs its own effect; the four
  // edge-blends layer weighted by mass = w_a + w_b.
  int ea[4]; int eb[4];
  ea[0] = 0; eb[0] = 1;
  ea[1] = 1; eb[1] = 2;
  ea[2] = 2; eb[2] = 3;
  ea[3] = 3; eb[3] = 0;

  vec3 key = vec3(uKeyR, uKeyG, uKeyB);
  vec3 acc = vec3(0.0);
  float massSum = 0.0;
  for (int e = 0; e < 4; e++) {
    float wa = w[ea[e]];
    float wb = w[eb[e]];
    float mass = wa + wb;
    float ratio = (mass > 1e-6) ? wb / mass : 0.5;
    vec3 blended = blend(uEdgeFx[e], c[ea[e]], c[eb[e]], ratio,
                         uEdgeAmount[e], uEdgeParam[e], key, uInvert, vUv);
    acc += mass * blended;
    massSum += mass;
  }
  vec3 outRgb = acc / max(massSum, 1e-6);

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

type QuadParams = {
  pos_x: number;
  pos_y: number;
  diamond_margin: number;
  blend_sharp: number;
  // Per-edge effect + controls (edge cycle 1↔2, 2↔3, 3↔4, 4↔1).
  edge1_fx: number; edge1_amount: number; edge1_param: number;
  edge2_fx: number; edge2_amount: number; edge2_param: number;
  edge3_fx: number; edge3_amount: number; edge3_param: number;
  edge4_fx: number; edge4_amount: number; edge4_param: number;
  // Shared chroma key colour + global key invert.
  keyR: number;
  keyG: number;
  keyB: number;
  invert: number;
  freeze: number;
};

const DEFAULTS: QuadParams = {
  pos_x: 0,
  pos_y: 0,
  diamond_margin: QUADRALOGICAL_DEFAULT_MARGIN,
  blend_sharp: QUADRALOGICAL_DEFAULT_SHARP,
  // All edges default to DISSOLVE (fx=0) so the out-of-box behaviour is the
  // Phase-1 joystick cross-dissolve. amount default 1, param (softness/feather)
  // default 0.1 — a usable starting point once an edge is switched to a keyed /
  // spatial effect.
  edge1_fx: 0, edge1_amount: 1, edge1_param: 0.1,
  edge2_fx: 0, edge2_amount: 1, edge2_param: 0.1,
  edge3_fx: 0, edge3_amount: 1, edge3_param: 0.1,
  edge4_fx: 0, edge4_amount: 1, edge4_param: 0.1,
  keyR: 0,
  keyG: 1, // green-screen default key colour
  keyB: 0,
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
    // Per-edge effect CV — each edge's primary (amount) + secondary (param)
    // control is independently CV-targetable.
    { id: 'edge1_amount',   type: 'cv', paramTarget: 'edge1_amount',   cvScale: { mode: 'linear' } },
    { id: 'edge1_param',    type: 'cv', paramTarget: 'edge1_param',    cvScale: { mode: 'linear' } },
    { id: 'edge2_amount',   type: 'cv', paramTarget: 'edge2_amount',   cvScale: { mode: 'linear' } },
    { id: 'edge2_param',    type: 'cv', paramTarget: 'edge2_param',    cvScale: { mode: 'linear' } },
    { id: 'edge3_amount',   type: 'cv', paramTarget: 'edge3_amount',   cvScale: { mode: 'linear' } },
    { id: 'edge3_param',    type: 'cv', paramTarget: 'edge3_param',    cvScale: { mode: 'linear' } },
    { id: 'edge4_amount',   type: 'cv', paramTarget: 'edge4_amount',   cvScale: { mode: 'linear' } },
    { id: 'edge4_param',    type: 'cv', paramTarget: 'edge4_param',    cvScale: { mode: 'linear' } },
    // Shared chroma key colour (used by any edge running the CHROMA effect).
    { id: 'keyR',           type: 'cv', paramTarget: 'keyR',           cvScale: { mode: 'linear' } },
    { id: 'keyG',           type: 'cv', paramTarget: 'keyG',           cvScale: { mode: 'linear' } },
    { id: 'keyB',           type: 'cv', paramTarget: 'keyB',           cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },      // canonical = MIX (surface.texture)
    { id: 'preview', type: 'video' },  // 2×2 raw-input monitor tile
  ],
  params: [
    { id: 'pos_x',          label: 'X',       defaultValue: DEFAULTS.pos_x,          min: -1, max: 1, curve: 'linear' },
    { id: 'pos_y',          label: 'Y',       defaultValue: DEFAULTS.pos_y,          min: -1, max: 1, curve: 'linear' },
    { id: 'diamond_margin', label: 'Diamond', defaultValue: DEFAULTS.diamond_margin, min: 0,  max: 1, curve: 'linear' },
    { id: 'blend_sharp',    label: 'Sharp',   defaultValue: DEFAULTS.blend_sharp,    min: 0,  max: 8, curve: 'linear' },
    // Per-edge effect selectors (discrete 0..7) + their two controls.
    { id: 'edge1_fx',     label: '1–2 FX', defaultValue: DEFAULTS.edge1_fx,     min: 0, max: 7, curve: 'discrete' },
    { id: 'edge1_amount', label: '1–2 Amt',defaultValue: DEFAULTS.edge1_amount, min: 0, max: 1, curve: 'linear' },
    { id: 'edge1_param',  label: '1–2 Prm',defaultValue: DEFAULTS.edge1_param,  min: 0, max: 1, curve: 'linear' },
    { id: 'edge2_fx',     label: '2–3 FX', defaultValue: DEFAULTS.edge2_fx,     min: 0, max: 7, curve: 'discrete' },
    { id: 'edge2_amount', label: '2–3 Amt',defaultValue: DEFAULTS.edge2_amount, min: 0, max: 1, curve: 'linear' },
    { id: 'edge2_param',  label: '2–3 Prm',defaultValue: DEFAULTS.edge2_param,  min: 0, max: 1, curve: 'linear' },
    { id: 'edge3_fx',     label: '3–4 FX', defaultValue: DEFAULTS.edge3_fx,     min: 0, max: 7, curve: 'discrete' },
    { id: 'edge3_amount', label: '3–4 Amt',defaultValue: DEFAULTS.edge3_amount, min: 0, max: 1, curve: 'linear' },
    { id: 'edge3_param',  label: '3–4 Prm',defaultValue: DEFAULTS.edge3_param,  min: 0, max: 1, curve: 'linear' },
    { id: 'edge4_fx',     label: '4–1 FX', defaultValue: DEFAULTS.edge4_fx,     min: 0, max: 7, curve: 'discrete' },
    { id: 'edge4_amount', label: '4–1 Amt',defaultValue: DEFAULTS.edge4_amount, min: 0, max: 1, curve: 'linear' },
    { id: 'edge4_param',  label: '4–1 Prm',defaultValue: DEFAULTS.edge4_param,  min: 0, max: 1, curve: 'linear' },
    // Shared chroma key colour + global key inversion.
    { id: 'keyR',           label: 'Key R',   defaultValue: DEFAULTS.keyR,           min: 0, max: 1, curve: 'linear' },
    { id: 'keyG',           label: 'Key G',   defaultValue: DEFAULTS.keyG,           min: 0, max: 1, curve: 'linear' },
    { id: 'keyB',           label: 'Key B',   defaultValue: DEFAULTS.keyB,           min: 0, max: 1, curve: 'linear' },
    { id: 'invert',         label: 'Inv',     defaultValue: DEFAULTS.invert,         min: 0, max: 1, curve: 'linear' },
    // freeze is a hidden VRT/determinism toggle — no card control.
    { id: 'freeze',         label: 'Freeze',  defaultValue: DEFAULTS.freeze,         min: 0, max: 1, curve: 'linear' },
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
      // Per-edge effect arrays (uniform1iv / uniform1fv).
      edgeFx: gl.getUniformLocation(mixProgram, 'uEdgeFx'),
      edgeAmount: gl.getUniformLocation(mixProgram, 'uEdgeAmount'),
      edgeParam: gl.getUniformLocation(mixProgram, 'uEdgeParam'),
      keyR: gl.getUniformLocation(mixProgram, 'uKeyR'),
      keyG: gl.getUniformLocation(mixProgram, 'uKeyG'),
      keyB: gl.getUniformLocation(mixProgram, 'uKeyB'),
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
        // Pack the four per-edge effect + control values into arrays.
        const fxArr = new Int32Array([
          Math.round(params.edge1_fx), Math.round(params.edge2_fx),
          Math.round(params.edge3_fx), Math.round(params.edge4_fx),
        ]);
        const amtArr = new Float32Array([
          params.edge1_amount, params.edge2_amount,
          params.edge3_amount, params.edge4_amount,
        ]);
        const prmArr = new Float32Array([
          params.edge1_param, params.edge2_param,
          params.edge3_param, params.edge4_param,
        ]);
        if (mixU.edgeFx) g.uniform1iv(mixU.edgeFx, fxArr);
        if (mixU.edgeAmount) g.uniform1fv(mixU.edgeAmount, amtArr);
        if (mixU.edgeParam) g.uniform1fv(mixU.edgeParam, prmArr);
        g.uniform1f(mixU.keyR, params.keyR);
        g.uniform1f(mixU.keyG, params.keyG);
        g.uniform1f(mixU.keyB, params.keyB);
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
