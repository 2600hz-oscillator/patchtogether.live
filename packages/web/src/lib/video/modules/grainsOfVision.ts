// packages/web/src/lib/video/modules/grainsOfVision.ts
//
// GRAINS OF VISION — a granular VIDEO synthesizer.
//
// A 1-or-2 video-in, 1-or-2 video-out granular engine on ONE fixed linear
// signal chain (NOT a node graph), with an opt-out feedback block and an opt-out
// reverb block:
//
//     A (primary) ─┐
//                   ├─► GRANULAR ENGINE ─► FEEDBACK ─► REVERB ─► out
//     B (modulator)┘         │ (grains tap out)
//         (B modulates A's grains — COMPOSITE modes; OFF when B unpatched)
//
// Design + rationale: .myrobots/plans/grains-of-vision-2026-07-18.md
//
// ── What a video "grain" is ───────────────────────────────────────────────
// A grain is a small WINDOWED PATCH sampled from source A at a jittered
// position AND a jittered moment in time (from a short frame-history ring),
// scattered into the output frame. Many overlapping grains composite per output
// frame (density). We map the audio-granular vocabulary onto the image:
//   grain size  → window radius (grain_size)   density → cells across (density)
//   spray       → grain-centre + read jitter    window → hard box ↔ soft gaussian
//   pitch→rate  → history read depth (rate)      temporal spray → time_spray
//   orientation → per-grain patch rotation (orient)
//
// GPU formulation — O(1) per pixel regardless of density: the frame is a
// jittered grid of `cells` cells (density = cells across); each cell hosts one
// grain (params HASHED from the cell id, so a frozen frame is reproducible).
// Every output pixel gathers its 3×3 cell neighbourhood (constant work — density
// changes cell SIZE, not neighbour count), evaluates each neighbour grain's
// window weight, samples A through that grain's transform, and accumulates the
// window-weighted colours normalised by total weight. A short ring of recent A
// frames gives grains a real TEMPORAL axis (rate/time_spray → the granular
// time-smear). Coordinates are aspect-corrected so grains stay round.
//
// ── FEEDBACK block ────────────────────────────────────────────────────────
// The previous OUTPUT frame, geometrically transformed a little each pass so
// the transform COMPOUNDS (tunnels/spirals), colour-decayed, mixed back over the
// grains:  feedbackImg = grains + feedback·decay·transform(prevOut).
// `feedback == 0` (or `fb_dry`) ⇒ transparent DRY passthrough. 1-frame lag via
// an outA/outB ping-pong (we never sample the texture we write) — the standard
// BACKDRAFT/FEEDBACK cycle.
//
// ── REVERB block (a VIDEO reverb) ─────────────────────────────────────────
// The image analogue of an FDN/Schroeder tail: a decaying, spatially-diffused
// TEMPORAL ACCUMULATOR.  rev = blur(feedbackImg + rev_decay·rev_prev);
// out = mix(feedbackImg, rev, rev_mix). Spatial blur = the many reverb "taps"
// spread over SPACE; the decay·rev_prev accumulator = the exponentially-decaying
// tail over FRAMES. Each bright grain blooms into a soft glowing cloud that
// lingers and fades — a reverb tail in the image domain. `rev_mix == 0` (or
// `rev_dry`) ⇒ transparent DRY passthrough (the blur passes are SKIPPED).
//
// ── COMPOSITE modes (B modulates A's grains) ──────────────────────────────
// Off when B unpatched. When B is patched, B is sampled at each grain's cell
// and (scaled by comp_amount) drives grain data:
//   1 density-map — B luma scales grain coverage/weight (dark B ⇒ sparse)
//   2 displace    — B chroma displaces the grain's SOURCE-read position
//   3 size-map    — B luma scales grain SIZE
//   4 rate-map    — B luma scales the grain's temporal read depth (per-region scrub)
//
// Every pure helper below is the CPU MIRROR of the GLSL — the EDGES/CELLSHADE/
// BACKDRAFT source-of-truth pattern (unit-tested; the shaders transliterate it).
//
// NOTE (owner): this def lives in the WebGL attest basis (resolveWebglBasis
// sweeps lib/video/). Its real shader/def flips computeWebglHash → a ONE-TIME
// re-attest on a trusted GPU is REQUIRED; the co-located docs below are wrapped
// in docs-hash-ignore markers so DOC edits stay hash-transparent. Maximally
// look-affecting — do NOT auto-merge (held for owner visual preview).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// ----------------------------------------------------------------------
// Constants (shared by the CPU mirror + the GLSL via interpolation).
// ----------------------------------------------------------------------

/** Reduced render resolution — SwiftShader/CI feasibility (mirrorpool pattern). */
export const GOV_RENDER_SCALE = 0.5;
/** Depth of the source-A frame-history ring (temporal grains + rate/time_spray). */
export const GOV_HISTORY_FRAMES = 8;
/** Grain cell-neighbourhood radius (1 ⇒ a 3×3 = 9-cell gather per pixel). */
export const GOV_GRAIN_RADIUS = 1;
/** Reverb separable-blur radius per axis (4 ⇒ 9 taps). */
export const GOV_REVERB_RADIUS = 4;
/** Max reverb blur tap spacing (texels) at rev_size = 1. */
export const GOV_MAX_BLUR_SPREAD = 8.0;
/** Max grain-centre jitter, in CELL units, at spray = 1. */
export const GOV_SPRAY_SCALE = 0.5;
/** Max source-read scatter, in UV units, at spray = 1. */
export const GOV_SRC_SPRAY_SCALE = 0.32;
/** Max B-driven source displacement (displace mode), UV units, at comp_amount 1. */
export const GOV_DISPLACE_SCALE = 0.25;

/** Feedback per-pass affine ranges. */
export const GOV_FB_ZOOM_MIN = 0.8;
export const GOV_FB_ZOOM_MAX = 1.2;
export const GOV_FB_ROTATE_MIN = -20;
export const GOV_FB_ROTATE_MAX = 20;

/** COMPOSITE modes, in selector order (index == `composite` value). */
export const GOV_COMPOSITE_MODES = ['off', 'density', 'displace', 'size', 'rate'] as const;
export type GovCompositeMode = (typeof GOV_COMPOSITE_MODES)[number];
export const GOV_COMPOSITE_MODE_COUNT = GOV_COMPOSITE_MODES.length; // 5

// ----------------------------------------------------------------------
// Pure scalar helpers — transliterated 1:1 into the GLSL below.
// ----------------------------------------------------------------------

function clamp01(v: number): number { return Math.min(1, Math.max(0, v)); }
function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }
function fract(v: number): number { return v - Math.floor(v); }

/** GLSL mix(). */
export function govMix(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Rec.601 luma of a normalised RGB triple. */
export function govLuma(r: number, g: number, b: number): number {
  return r * 0.299 + g * 0.587 + b * 0.114;
}

/** Dave-Hoskins hash11→[0,1). Portable (no sin); mirrors the GLSL exactly in
 *  formula (float64 vs float32 low bits differ — the value is only ever used as
 *  a random-ish per-cell number, never bit-compared to the shader). */
export function govHash21(x: number, y: number): number {
  let p3x = fract(x * 0.1031);
  let p3y = fract(y * 0.1031);
  let p3z = fract(x * 0.1031);
  const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x = fract(p3x + d);
  p3y = fract(p3y + d);
  p3z = fract(p3z + d);
  return fract((p3x + p3y) * p3z);
}

/** Dave-Hoskins hash22→[0,1)². Two decorrelated randoms per cell. */
export function govHash22(x: number, y: number): [number, number] {
  let p3x = fract(x * 0.1031);
  let p3y = fract(y * 0.1030);
  let p3z = fract(x * 0.0973);
  const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x = fract(p3x + d);
  p3y = fract(p3y + d);
  p3z = fract(p3z + d);
  return [fract((p3x + p3x) * p3z), fract((p3y + p3z) * p3y)];
}

/** DENSITY knob → integer CELL count across the (aspect-normalised) frame.
 *  Clamped to [2, 48] and rounded so the grid is well-formed. */
export function govDensityToCells(density: number): number {
  if (!Number.isFinite(density)) return 14;
  return clamp(Math.round(density), 2, 48);
}

/** RATE knob → integer history TAP DEPTH (frames back), 0..ring-1. rate 0 ⇒ 0
 *  (the past tap coincides with `now`: no temporal effect). */
export function govDelayFrames(rate: number, ring: number = GOV_HISTORY_FRAMES): number {
  return clamp(Math.round(clamp01(rate) * (ring - 1)), 0, ring - 1);
}

/** Grain WINDOW weight at normalised centre-distance `d` (0 = grain centre,
 *  1 = grain edge). `window` morphs the falloff from a near-hard box (0) to a
 *  soft gaussian-ish shoulder (1). 0 outside the grain (d ≥ 1). */
export function govGrainWindow(d: number, window: number): number {
  if (d >= 1) return 0;
  const edge = govMix(0.06, 1.0, clamp01(window)); // soft-band width
  // 1 inside, ramping to 0 across [1-edge, 1].
  const t = clamp((1 - d) / Math.max(edge, 1e-4), 0, 1);
  return t * t * (3 - 2 * t); // smoothstep
}

/** Per-grain TEMPORAL blend fraction (0 = now, 1 = the rate-deep past tap).
 *  `rMiscY` is the grain's hashed [0,1) temporal random; time_spray scatters
 *  grains from live toward the past. 0 when the past tap is disabled (rate 0). */
export function govTemporalFrac(rMiscY: number, timeSpray: number, pastEnabled: boolean): number {
  if (!pastEnabled) return 0;
  return clamp01(rMiscY * clamp01(timeSpray));
}

/** BACKDRAFT-style feedback-tap UV: invert "zoom about centre → rotate about
 *  centre" so the VISIBLE transform of the fed-back frame is the forward one
 *  (zoom>1 magnifies the echo, +rotate spins it). Identity at zoom 1 / rot 0. */
export function govFeedbackUv(u: number, v: number, zoom: number, rotateDeg: number): { u: number; v: number } {
  const th = (rotateDeg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  let px = u - 0.5;
  let py = v - 0.5;
  const rx = px * c + py * s;
  const ry = -px * s + py * c;
  const z = Math.max(Math.abs(zoom) < 1e-4 ? 1e-4 : zoom, 1e-4);
  px = rx / z;
  py = ry / z;
  return { u: px + 0.5, v: py + 0.5 };
}

/** FEEDBACK composite (per channel): grains + feedback·decay·prev, clamped to
 *  [0,1] each frame (stable trails; feedback 0 ⇒ dry = grains). */
export function govFeedbackComposite(grains: number, prev: number, feedback: number, decay: number): number {
  return clamp01(grains + clamp(feedback, 0, 0.98) * clamp01(decay) * prev);
}

/** REVERB accumulator injection (per channel): feedbackImg + decay·prevRev
 *  (the energy inject + the decaying tail), before the spatial blur. */
export function govReverbAcc(feedbackC: number, prevRev: number, decay: number): number {
  return feedbackC + clamp(decay, 0, 0.99) * prevRev;
}

/** REVERB dry/wet blend (per channel): mix(dry, wet, rev_mix). mix 0 ⇒ dry. */
export function govReverbBlend(dry: number, wet: number, mix: number): number {
  return clamp01(govMix(dry, wet, clamp01(mix)));
}

/** Is the reverb block a DRY passthrough this frame? (mix 0 or dry toggle). */
export function govReverbIsDry(revMix: number, revDry: number): boolean {
  return clamp01(revMix) <= 0 || revDry >= 0.5;
}

/** Is the feedback block a DRY passthrough this frame? (amount 0 or dry toggle). */
export function govFeedbackIsDry(feedback: number, fbDry: number): boolean {
  return clamp(feedback, 0, 0.98) <= 0 || fbDry >= 0.5;
}

/** COMPOSITE grain-WEIGHT multiplier (density-map): dark B thins grains out,
 *  bright B keeps/boosts them. Neutral (1) when amount 0 or mode ≠ density. */
export function govCompositeWeightMul(mode: number, bLuma: number, amount: number): number {
  if (Math.round(mode) !== 1) return 1;
  return govMix(1, clamp(bLuma * 1.6, 0, 1.6), clamp01(amount));
}

/** COMPOSITE grain-SIZE multiplier (size-map): bright B ⇒ big grains, dark B ⇒
 *  tight specks. Neutral (1) when amount 0 or mode ≠ size. */
export function govCompositeSizeMul(mode: number, bLuma: number, amount: number): number {
  if (Math.round(mode) !== 3) return 1;
  return govMix(1, 0.3 + bLuma * 1.7, clamp01(amount));
}

/** COMPOSITE temporal-frac offset (rate-map): B luma scrubs the grain's read
 *  depth (+/-) per region. 0 when amount 0 or mode ≠ rate. */
export function govCompositeRateOffset(mode: number, bLuma: number, amount: number): number {
  if (Math.round(mode) !== 4) return 0;
  return (bLuma - 0.5) * clamp01(amount);
}

// ----------------------------------------------------------------------
// Param model.
// ----------------------------------------------------------------------

export interface GrainsOfVisionParams {
  // GRAIN engine
  density: number;    // 2..48 cells across
  grain_size: number; // 0.2..2.5 window radius (cell units)
  spray: number;      // 0..1 position spray (centre + read jitter)
  time_spray: number; // 0..1 temporal spray
  rate: number;       // 0..1 history read depth (pitch→rate)
  orient: number;     // 0..1 per-grain orientation randomisation
  window: number;     // 0..1 window falloff (hard box → soft)
  // FEEDBACK block
  feedback: number;   // 0..0.98 amount (0 = dry passthrough)
  fb_decay: number;   // 0..1 per-pass colour persistence
  fb_zoom: number;    // 0.8..1.2 per-pass zoom (1 = identity)
  fb_rotate: number;  // -20..20 per-pass rotation (deg)
  fb_dry: number;     // 0/1 hard bypass
  // REVERB block
  rev_mix: number;    // 0..1 dry/wet (0 = dry passthrough)
  rev_size: number;   // 0..1 blur radius (room size)
  rev_decay: number;  // 0..0.99 tail persistence
  rev_diffuse: number;// 0..1 tap spread/scatter
  rev_dry: number;    // 0/1 hard bypass
  // COMPOSITE (B modulates A)
  composite: number;  // discrete 0..4 (off/density/displace/size/rate)
  comp_amount: number;// 0..1 modulation depth
  // hidden
  freeze: number;     // 0/1 VRT determinism (draw no-op holds last frame)
}

export const GRAINS_OF_VISION_DEFAULTS: GrainsOfVisionParams = {
  density: 14,
  grain_size: 1.1,
  spray: 0.35,
  time_spray: 0.2,
  rate: 0.15,
  orient: 0.25,
  window: 0.6,
  feedback: 0.4,
  fb_decay: 0.9,
  fb_zoom: 1.0,
  fb_rotate: 0,
  fb_dry: 0,
  rev_mix: 0.25,
  rev_size: 0.5,
  rev_decay: 0.85,
  rev_diffuse: 0.5,
  rev_dry: 0,
  composite: 1,
  comp_amount: 0.7,
  freeze: 0,
};

// ----------------------------------------------------------------------
// GLSL — the passes. Each fragment transliterates the CPU mirror above.
// ----------------------------------------------------------------------

const GLSL_HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
`;

// P0 — copy the live source into the history ring slot.
const COPY_FRAG = `${GLSL_HEADER}
uniform sampler2D uTex;
uniform float uHas;
void main(){ outColor = vec4(uHas > 0.5 ? texture(uTex, vUv).rgb : vec3(0.0), 1.0); }`;

// P1 — the granular scatter. 3×3 cell gather, window-weighted, aspect-corrected.
const GRAIN_FRAG = `${GLSL_HEADER}
uniform sampler2D uNow;    // live source A
uniform sampler2D uPast;   // rate-deep history tap (== uNow when rate 0)
uniform sampler2D uB;      // modulator (composite)
uniform float uHasA, uHasPast, uHasB;
uniform float uAspect;
uniform float uCells;      // density (cells across, aspect-normalised)
uniform float uGrainSize;  // window radius (cell units)
uniform float uSpray;      // position spray
uniform float uTimeSpray;  // temporal spray
uniform float uOrient;     // orientation randomisation
uniform float uWindow;     // window falloff
uniform float uCompMode;   // 0..4
uniform float uCompAmount; // 0..1

const float SPRAY_SCALE = ${GOV_SPRAY_SCALE.toFixed(3)};
const float SRC_SPRAY   = ${GOV_SRC_SPRAY_SCALE.toFixed(3)};
const float DISPLACE    = ${GOV_DISPLACE_SCALE.toFixed(3)};
const float PI = 3.14159265359;

float win(float d){
  if (d >= 1.0) return 0.0;
  float edge = mix(0.06, 1.0, clamp(uWindow, 0.0, 1.0));
  float t = clamp((1.0 - d) / max(edge, 1e-4), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main(){
  if (uHasA < 0.5){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // aspect-corrected working coordinate so cells + grains stay square/round.
  vec2 q = vUv * vec2(uAspect, 1.0);
  float cellSize = 1.0 / uCells;
  vec2 cell = floor(q / cellSize);
  bool pastEnabled = uHasPast > 0.5;

  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int dy = -${GOV_GRAIN_RADIUS}; dy <= ${GOV_GRAIN_RADIUS}; dy++){
    for (int dx = -${GOV_GRAIN_RADIUS}; dx <= ${GOV_GRAIN_RADIUS}; dx++){
      vec2 cid = cell + vec2(float(dx), float(dy));
      vec2 rCenter = hash22(cid + 0.0);
      vec2 rSrc    = hash22(cid + 17.0);
      vec2 rMisc   = hash22(cid + 41.0);   // x = orient rand, y = temporal rand
      float rSize  = hash21(cid + 91.0);

      // grain centre (aspect-corrected q-space) = cell centre + spray jitter.
      vec2 gc = (cid + 0.5) * cellSize + (rCenter * 2.0 - 1.0) * uSpray * SPRAY_SCALE * cellSize;

      // per-grain size (+ composite size-map when B drives it).
      float sizeMul = 1.0;
      float bLuma = 0.5; vec3 bcol = vec3(0.5);
      if (uHasB > 0.5 && uCompMode > 0.5){
        vec2 buv = vec2(gc.x / uAspect, gc.y);
        bcol = texture(uB, clamp(buv, 0.0, 1.0)).rgb;
        bLuma = luma(bcol);
        if (abs(uCompMode - 3.0) < 0.5) sizeMul = mix(1.0, 0.3 + bLuma * 1.7, clamp(uCompAmount, 0.0, 1.0));
      }
      float radius = uGrainSize * cellSize * mix(0.6, 1.4, rSize) * sizeMul;
      float d = length(q - gc) / max(radius, 1e-4);
      float w = win(d);
      if (w <= 0.0) continue;

      // composite density-map: scale the grain weight by B luma.
      if (uHasB > 0.5 && abs(uCompMode - 1.0) < 0.5)
        w *= mix(1.0, clamp(bLuma * 1.6, 0.0, 1.6), clamp(uCompAmount, 0.0, 1.0));

      // source READ centre = grain screen position + spray scatter (+ B displace).
      vec2 gcUv = vec2(gc.x / uAspect, gc.y);
      vec2 readUv = gcUv + (rSrc * 2.0 - 1.0) * uSpray * SRC_SPRAY;
      if (uHasB > 0.5 && abs(uCompMode - 2.0) < 0.5)
        readUv += (bcol.rg * 2.0 - 1.0) * clamp(uCompAmount, 0.0, 1.0) * DISPLACE;

      // local patch offset (this pixel relative to the grain), rotated by orient.
      float ang = (rMisc.x * 2.0 - 1.0) * PI * clamp(uOrient, 0.0, 1.0);
      float ca = cos(ang), sa = sin(ang);
      vec2 loc = (q - gc);
      vec2 locR = vec2(loc.x * ca - loc.y * sa, loc.x * sa + loc.y * ca);
      vec2 srcUv = readUv + vec2(locR.x / uAspect, locR.y);

      // temporal blend (+ composite rate-map when B drives it).
      float tfrac = pastEnabled ? clamp(rMisc.y * clamp(uTimeSpray, 0.0, 1.0), 0.0, 1.0) : 0.0;
      if (uHasB > 0.5 && abs(uCompMode - 4.0) < 0.5)
        tfrac = clamp(tfrac + (bLuma - 0.5) * clamp(uCompAmount, 0.0, 1.0), 0.0, 1.0);

      vec3 col = texture(uNow, clamp(srcUv, 0.0, 1.0)).rgb;
      if (pastEnabled && tfrac > 0.0)
        col = mix(col, texture(uPast, clamp(srcUv, 0.0, 1.0)).rgb, tfrac);

      acc += col * w;
      wsum += w;
    }
  }
  vec3 outc = wsum > 1e-4 ? acc / wsum : texture(uNow, vUv).rgb * 0.15;
  outColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

// P2 — feedback: grains + feedback·decay·transform(prevOut).
const FEEDBACK_FRAG = `${GLSL_HEADER}
uniform sampler2D uGrains;
uniform sampler2D uPrev;   // previous OUTPUT (clamp-to-edge)
uniform float uHasPrev;
uniform float uFeedback, uDecay, uZoom, uCos, uSin;
void main(){
  vec3 grains = texture(uGrains, vUv).rgb;
  vec2 p = vUv - 0.5;
  vec2 r = vec2(p.x * uCos + p.y * uSin, -p.x * uSin + p.y * uCos);
  r /= max(uZoom, 1e-4);
  vec2 fbUv = r + 0.5;
  vec3 prev = uHasPrev > 0.5 ? texture(uPrev, clamp(fbUv, 0.0, 1.0)).rgb : vec3(0.0);
  vec3 outc = grains + clamp(uFeedback, 0.0, 0.98) * clamp(uDecay, 0.0, 1.0) * prev;
  outColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

// P3a — reverb H blur of the accumulator (feedbackImg + decay·prevRev).
const REVERB_H_FRAG = `${GLSL_HEADER}
uniform sampler2D uFeedback;
uniform sampler2D uPrevRev;
uniform float uHasPrevRev;
uniform vec2  uTexel;
uniform float uSpread;   // tap spacing (texels)
uniform float uDecay;    // tail persistence
uniform float uDiffuse;  // tap jitter/scatter
const int R = ${GOV_REVERB_RADIUS};
void main(){
  float sigma = max(float(R) * 0.5, 0.5);
  float jitter = 1.0 + (hash21(vUv * 731.0) - 0.5) * clamp(uDiffuse, 0.0, 1.0) * 0.8;
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = -R; i <= R; i++){
    float fi = float(i);
    float perp = (hash21(vUv * 53.0 + fi) - 0.5) * clamp(uDiffuse, 0.0, 1.0) * uSpread * 0.5;
    vec2 off = vec2(fi * uSpread * jitter * uTexel.x, perp * uTexel.y);
    float w = exp(-(fi * fi) / (2.0 * sigma * sigma));
    vec3 fb = texture(uFeedback, clamp(vUv + off, 0.0, 1.0)).rgb;
    vec3 pr = uHasPrevRev > 0.5 ? texture(uPrevRev, clamp(vUv + off, 0.0, 1.0)).rgb : vec3(0.0);
    acc += w * (fb + clamp(uDecay, 0.0, 0.99) * pr);
    wsum += w;
  }
  outColor = vec4(acc / max(wsum, 1e-4), 1.0);
}`;

// P3b — reverb V blur of the horizontal result → the new tail (revNew).
const REVERB_V_FRAG = `${GLSL_HEADER}
uniform sampler2D uTmp;
uniform vec2  uTexel;
uniform float uSpread;
uniform float uDiffuse;
const int R = ${GOV_REVERB_RADIUS};
void main(){
  float sigma = max(float(R) * 0.5, 0.5);
  float jitter = 1.0 + (hash21(vUv * 917.0) - 0.5) * clamp(uDiffuse, 0.0, 1.0) * 0.8;
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = -R; i <= R; i++){
    float fi = float(i);
    float perp = (hash21(vUv * 37.0 + fi) - 0.5) * clamp(uDiffuse, 0.0, 1.0) * uSpread * 0.5;
    vec2 off = vec2(perp * uTexel.x, fi * uSpread * jitter * uTexel.y);
    float w = exp(-(fi * fi) / (2.0 * sigma * sigma));
    acc += w * texture(uTmp, clamp(vUv + off, 0.0, 1.0)).rgb;
    wsum += w;
  }
  outColor = vec4(clamp(acc / max(wsum, 1e-4), 0.0, 1.0), 1.0);
}`;

// P3c — reverb dry/wet composite → the OUTPUT.
const REVERB_MIX_FRAG = `${GLSL_HEADER}
uniform sampler2D uDry;   // feedbackImg
uniform sampler2D uWet;   // revNew
uniform float uMix;
void main(){
  vec3 dry = texture(uDry, vUv).rgb;
  vec3 wet = texture(uWet, vUv).rgb;
  outColor = vec4(clamp(mix(dry, wet, clamp(uMix, 0.0, 1.0)), 0.0, 1.0), 1.0);
}`;

// A straight copy (feedbackImg → out when reverb is dry).
const BLIT_FRAG = `${GLSL_HEADER}
uniform sampler2D uTex;
void main(){ outColor = vec4(texture(uTex, vUv).rgb, 1.0); }`;

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(GRAINS_OF_VISION_DEFAULTS));

// ----------------------------------------------------------------------
// A managed RGBA8 render target at an arbitrary size (reduced-res render).
// ----------------------------------------------------------------------
function createTarget(gl: WebGL2RenderingContext, w: number, h: number): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
  const tex = gl.createTexture();
  if (!tex) throw new Error('grainsOfVision: createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  if (!fbo) { gl.deleteTexture(tex); throw new Error('grainsOfVision: createFramebuffer failed'); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture: tex };
}

export const grainsOfVisionDef: VideoModuleDef = {
  type: 'grainsOfVision',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'grains of vision',
  category: 'effects',
  // Texture-only (no audio surface): NOT pullExempt. Like BACKDRAFT/FEEDBACK, the
  // feedback/reverb/history state simply pauses when nothing observes the output
  // — freezing it while unobserved is, by definition, unobservable, and the
  // engine re-renders the instant a watched sink (an OUTPUT/preview) reads it.
  inputs: [
    // TWO video inputs — A primary, B modulator (optional).
    { id: 'in_a', type: 'video' },
    { id: 'in_b', type: 'video' },
    // Per-param CV (port id == param id). `composite` snaps via a discrete
    // cvScale. No CV for the two dry toggles or freeze (hidden), like BACKDRAFT.
    { id: 'density',     type: 'cv', paramTarget: 'density',     cvScale: { mode: 'linear' } },
    { id: 'grain_size',  type: 'cv', paramTarget: 'grain_size',  cvScale: { mode: 'linear' } },
    { id: 'spray',       type: 'cv', paramTarget: 'spray',       cvScale: { mode: 'linear' } },
    { id: 'time_spray',  type: 'cv', paramTarget: 'time_spray',  cvScale: { mode: 'linear' } },
    { id: 'rate',        type: 'cv', paramTarget: 'rate',        cvScale: { mode: 'linear' } },
    { id: 'orient',      type: 'cv', paramTarget: 'orient',      cvScale: { mode: 'linear' } },
    { id: 'window',      type: 'cv', paramTarget: 'window',      cvScale: { mode: 'linear' } },
    { id: 'feedback',    type: 'cv', paramTarget: 'feedback',    cvScale: { mode: 'linear' } },
    { id: 'fb_decay',    type: 'cv', paramTarget: 'fb_decay',    cvScale: { mode: 'linear' } },
    { id: 'fb_zoom',     type: 'cv', paramTarget: 'fb_zoom',     cvScale: { mode: 'linear' } },
    { id: 'fb_rotate',   type: 'cv', paramTarget: 'fb_rotate',   cvScale: { mode: 'linear' } },
    { id: 'rev_mix',     type: 'cv', paramTarget: 'rev_mix',     cvScale: { mode: 'linear' } },
    { id: 'rev_size',    type: 'cv', paramTarget: 'rev_size',    cvScale: { mode: 'linear' } },
    { id: 'rev_decay',   type: 'cv', paramTarget: 'rev_decay',   cvScale: { mode: 'linear' } },
    { id: 'rev_diffuse', type: 'cv', paramTarget: 'rev_diffuse', cvScale: { mode: 'linear' } },
    { id: 'composite',   type: 'cv', paramTarget: 'composite',   cvScale: { mode: 'discrete' } },
    { id: 'comp_amount', type: 'cv', paramTarget: 'comp_amount', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out',    type: 'video' }, // full chain (grains → feedback → reverb)
    { id: 'grains', type: 'video' }, // raw granular scatter tap (pre-feedback/reverb)
  ],
  params: [
    { id: 'density',     label: 'Density', defaultValue: GRAINS_OF_VISION_DEFAULTS.density,     min: 2,   max: 48,   curve: 'linear' },
    { id: 'grain_size',  label: 'Size',    defaultValue: GRAINS_OF_VISION_DEFAULTS.grain_size,  min: 0.2, max: 2.5,  curve: 'linear' },
    { id: 'spray',       label: 'Spray',   defaultValue: GRAINS_OF_VISION_DEFAULTS.spray,       min: 0,   max: 1,    curve: 'linear' },
    { id: 'time_spray',  label: 'T-Spray', defaultValue: GRAINS_OF_VISION_DEFAULTS.time_spray,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'rate',        label: 'Rate',    defaultValue: GRAINS_OF_VISION_DEFAULTS.rate,        min: 0,   max: 1,    curve: 'linear' },
    { id: 'orient',      label: 'Orient',  defaultValue: GRAINS_OF_VISION_DEFAULTS.orient,      min: 0,   max: 1,    curve: 'linear' },
    { id: 'window',      label: 'Window',  defaultValue: GRAINS_OF_VISION_DEFAULTS.window,      min: 0,   max: 1,    curve: 'linear' },
    { id: 'feedback',    label: 'FB',      defaultValue: GRAINS_OF_VISION_DEFAULTS.feedback,    min: 0,   max: 0.98, curve: 'linear' },
    { id: 'fb_decay',    label: 'FB Dec',  defaultValue: GRAINS_OF_VISION_DEFAULTS.fb_decay,    min: 0,   max: 1,    curve: 'linear' },
    { id: 'fb_zoom',     label: 'FB Zoom', defaultValue: GRAINS_OF_VISION_DEFAULTS.fb_zoom,     min: GOV_FB_ZOOM_MIN,   max: GOV_FB_ZOOM_MAX,   curve: 'linear' },
    { id: 'fb_rotate',   label: 'FB Rot',  defaultValue: GRAINS_OF_VISION_DEFAULTS.fb_rotate,   min: GOV_FB_ROTATE_MIN, max: GOV_FB_ROTATE_MAX, curve: 'linear' },
    { id: 'fb_dry',      label: 'FB Dry',  defaultValue: GRAINS_OF_VISION_DEFAULTS.fb_dry,      min: 0,   max: 1,    curve: 'linear' },
    { id: 'rev_mix',     label: 'Rev Mix', defaultValue: GRAINS_OF_VISION_DEFAULTS.rev_mix,     min: 0,   max: 1,    curve: 'linear' },
    { id: 'rev_size',    label: 'Rev Sz',  defaultValue: GRAINS_OF_VISION_DEFAULTS.rev_size,    min: 0,   max: 1,    curve: 'linear' },
    { id: 'rev_decay',   label: 'Rev Dec', defaultValue: GRAINS_OF_VISION_DEFAULTS.rev_decay,   min: 0,   max: 0.99, curve: 'linear' },
    { id: 'rev_diffuse', label: 'Rev Dif', defaultValue: GRAINS_OF_VISION_DEFAULTS.rev_diffuse, min: 0,   max: 1,    curve: 'linear' },
    { id: 'rev_dry',     label: 'Rev Dry', defaultValue: GRAINS_OF_VISION_DEFAULTS.rev_dry,     min: 0,   max: 1,    curve: 'linear' },
    { id: 'composite',   label: 'Comp',    defaultValue: GRAINS_OF_VISION_DEFAULTS.composite,   min: 0,   max: GOV_COMPOSITE_MODE_COUNT - 1, curve: 'discrete' },
    { id: 'comp_amount', label: 'Cmp Amt', defaultValue: GRAINS_OF_VISION_DEFAULTS.comp_amount, min: 0,   max: 1,    curve: 'linear' },
    // freeze — hidden VRT/determinism toggle (no card control).
    { id: 'freeze',      label: 'Freeze',  defaultValue: GRAINS_OF_VISION_DEFAULTS.freeze,      min: 0,   max: 1,    curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "grains of vision is a granular VIDEO synthesizer: it shatters the incoming picture into a swarm of tiny windowed patches (grains) and re-scatters them into a new frame, then runs that through a feedback block and a video-reverb block on ONE fixed linear chain (video -> granular engine -> feedback -> reverb -> out) — not a node graph. A grain is a small windowed patch of source A sampled at a jittered position AND a jittered moment in time (from a short history of recent frames), so grains have a real temporal axis — the novel part of GRANULAR video. Density sets how many grains pack the frame; Size sets each grain's radius (>=1 cell = overlapping, blended); Window morphs the grain edge from a hard chip to a soft gaussian bloom; Spray scatters where each grain sits and where in the source it grabs from (at 0 it reconstructs the picture faithfully, rising it clouds into abstraction); Rate sets how far back in the frame-history grains reach and T-Spray scatters them across time for a shimmering time-smear; Orient tumbles each patch. The FEEDBACK block mixes the previous OUTPUT back in, zoomed/rotated a touch each pass so it compounds into tunnels and trails (FB amount 0 = a transparent dry passthrough). The REVERB block is a true video reverb — a decaying, spatially-diffused accumulator (the image analogue of a reverb tail): each bright grain blooms outward (Rev Size = room size, Rev Diffuse = how it scatters) and lingers, fading over frames (Rev Decay = tail length), mixed dry/wet by Rev Mix (0 = a transparent dry passthrough). Patch a second source into B and pick a COMPOSITE mode to have B modulate A's grains region-by-region: density-map (B brightness thins/thickens grains), displace (B warps where grains grab from), size-map (B scales grain size), rate-map (B scrubs the per-region time). With only A patched it runs mono-source (composite off). Like every video processor an unpatched input renders black; the defaults are tuned so any patched source is immediately alive — a mid-density overlapping grain field with a little temporal smear, gentle feedback trails and a soft reverb bloom.",
    inputs: {
      in_a: "PRIMARY video source — the material that is shattered into grains. Unpatched, the output is black.",
      in_b: "MODULATOR video source (optional). When patched AND a COMPOSITE mode is selected, B modulates A's grain data region-by-region (Comp mode picks how). Unpatched, the module runs mono-source (composite off).",
      density: "CV that modulates Density (grid cells across → grain count), swept linearly over its 2..48 range.",
      grain_size: "CV that modulates Size (grain window radius in cell units), swept linearly over 0.2..2.5.",
      spray: "CV that modulates Spray (position scatter of the grain centre + source-read), swept linearly over 0..1.",
      time_spray: "CV that modulates T-Spray (temporal scatter of the grains across the frame history), swept linearly over 0..1.",
      rate: "CV that modulates Rate (how far back in the frame history grains read — the pitch/rate analog), swept linearly over 0..1.",
      orient: "CV that modulates Orient (per-grain patch rotation), swept linearly over 0..1.",
      window: "CV that modulates Window (grain edge falloff, hard chip → soft gaussian), swept linearly over 0..1.",
      feedback: "CV that modulates FB (feedback amount, 0 = dry passthrough), swept linearly over 0..0.98.",
      fb_decay: "CV that modulates FB Dec (feedback colour persistence per pass), swept linearly over 0..1.",
      fb_zoom: "CV that modulates FB Zoom (per-pass zoom of the feedback tap — the tunnel maker), swept linearly over 0.8..1.2.",
      fb_rotate: "CV that modulates FB Rot (per-pass rotation of the feedback tap — the spiral maker), swept linearly over -20..20 degrees.",
      rev_mix: "CV that modulates Rev Mix (reverb dry/wet, 0 = dry passthrough), swept linearly over 0..1.",
      rev_size: "CV that modulates Rev Sz (reverb spatial spread / room size), swept linearly over 0..1.",
      rev_decay: "CV that modulates Rev Dec (reverb tail length / temporal persistence), swept linearly over 0..0.99.",
      rev_diffuse: "CV that modulates Rev Dif (reverb tap scatter — how isotropic the smear is), swept linearly over 0..1.",
      composite: "CV that modulates Comp (the composite mode) using a discrete cvScale, snapping to the 5 modes (off / density / displace / size / rate). Inert while B is unpatched.",
      comp_amount: "CV that modulates Cmp Amt (composite modulation depth), swept linearly over 0..1.",
    },
    outputs: {
      out: "The full chain output: the granular scatter after the feedback block and the reverb block.",
      grains: "The RAW granular scatter tap — the grain field BEFORE feedback and reverb (a clean grains-only output to key, mix, or feed elsewhere). Optional; leave it unpatched to ignore.",
    },
    controls: {
      density: "Density (2..48, default 14): grains across the frame. Higher packs more, smaller grains; lower gives fewer, larger chunks. (Per-pixel cost is constant — density changes grain SIZE, not the work.)",
      grain_size: "Size (0.2..2.5, default 1.1): each grain's window radius in cell units. >=1 makes grains overlap and blend smoothly; small values leave gaps of the dim fallback.",
      spray: "Spray (0..1, default 0.35): position scatter. At 0 grains sit on a tidy grid and read the source at their own location, faithfully reconstructing the picture; rising it jitters both the grain positions and where in the source they grab from, dissolving the image into a granular cloud.",
      time_spray: "T-Spray (0..1, default 0.2): temporal scatter. Spreads the grains across the frame-history from live toward the Rate depth, so different grains show slightly different moments — a shimmering time-smear. 0 = all grains live.",
      rate: "Rate (0..1, default 0.15): the pitch/rate analog — how many frames back the grains' history tap reaches. 0 = live (no temporal effect); higher pulls the smear deeper into the past.",
      orient: "Orient (0..1, default 0.25): per-grain rotation of the sampled patch. 0 = every grain upright; higher tumbles each grain to a random angle.",
      window: "Window (0..1, default 0.6): the grain window falloff. 0 = a near-hard chip (crisp mosaic); 1 = a soft gaussian shoulder (grains bloom and cross-fade).",
      feedback: "FB (0..0.98, default 0.4): feedback amount — how much of the transformed previous OUTPUT is mixed back over the grains. 0 = a transparent dry passthrough (feedback block off); higher builds trails/tunnels (clamped each frame so it never blows out).",
      fb_decay: "FB Dec (0..1, default 0.9): the per-pass colour persistence of the fed-back frame. Lower fades trails faster; near 1 they linger.",
      fb_zoom: "FB Zoom (0.8..1.2, default 1.0 = identity): per-pass zoom of the feedback tap about centre. Off 1.0 the echo re-zooms every pass, compounding into a tunnel (>1 zoom-in, <1 expanding).",
      fb_rotate: "FB Rot (-20..20 deg, default 0): per-pass rotation of the feedback tap about centre. Combined with FB Zoom off 1.0 the echoes twist into a spiral.",
      fb_dry: "FB Dry (0/1, default 0): hard bypass of the feedback block. At 1 the block is a transparent passthrough regardless of the FB amount.",
      rev_mix: "Rev Mix (0..1, default 0.25): reverb dry/wet. 0 = a transparent dry passthrough (reverb block off, its blur passes skipped); higher blends in the diffuse glowing tail.",
      rev_size: "Rev Sz (0..1, default 0.5): reverb room size — the spatial extent of the blur, i.e. how far each grain blooms outward.",
      rev_decay: "Rev Dec (0..0.99, default 0.85): reverb tail length — how long the diffuse smear persists and accumulates frame to frame before fading.",
      rev_diffuse: "Rev Dif (0..1, default 0.5): reverb tap scatter — jitters and rotates the blur taps so the smear is a soft isotropic cloud rather than a boxy axis-aligned blur.",
      rev_dry: "Rev Dry (0/1, default 0): hard bypass of the reverb block. At 1 the block is a transparent passthrough regardless of Rev Mix.",
      composite: "Comp (discrete 0..4, default 1 = density): how a patched B modulates A's grains — off, density (B brightness thins/thickens grains), displace (B warps where grains read from), size (B scales grain size), rate (B scrubs the per-region history time). Inert while B is unpatched.",
      comp_amount: "Cmp Amt (0..1, default 0.7): the depth of the COMPOSITE modulation. 0 leaves B inert even when a mode is selected; higher pushes B's influence toward extreme.",
      freeze: "Freeze (0/1, default 0): hidden determinism toggle. At >=0.5 draw() is a no-op so the ring + output hold their last frame for deterministic VRT capture. No card control.",
    },
  },
  // docs-hash-ignore:end

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    // Reduced-res render targets (module owns its own resize).
    let rw = Math.max(1, Math.round(ctx.res.width * GOV_RENDER_SCALE));
    let rh = Math.max(1, Math.round(ctx.res.height * GOV_RENDER_SCALE));

    // Frame-history ring (source A), + pipeline targets, + ping-pongs.
    let srcRing = Array.from({ length: GOV_HISTORY_FRAMES }, () => createTarget(gl, rw, rh));
    let fboGrains = createTarget(gl, rw, rh);
    let fboFeedback = createTarget(gl, rw, rh);
    let revTmp = createTarget(gl, rw, rh);
    let revPing = [createTarget(gl, rw, rh), createTarget(gl, rw, rh)]; // reverb tail ping-pong
    let outPing = [createTarget(gl, rw, rh), createTarget(gl, rw, rh)]; // output ping-pong

    // Deferred program compile (mandelbulb/mirrorpool CI discipline).
    let progs: {
      copy: WebGLProgram; grain: WebGLProgram; feedback: WebGLProgram;
      revH: WebGLProgram; revV: WebGLProgram; revMix: WebGLProgram; blit: WebGLProgram;
    } | null = null;
    let glFailed = false;
    function ensurePrograms(): boolean {
      if (progs) return true;
      if (glFailed) return false;
      try {
        progs = {
          copy: ctx.compileFragment(COPY_FRAG),
          grain: ctx.compileFragment(GRAIN_FRAG),
          feedback: ctx.compileFragment(FEEDBACK_FRAG),
          revH: ctx.compileFragment(REVERB_H_FRAG),
          revV: ctx.compileFragment(REVERB_V_FRAG),
          revMix: ctx.compileFragment(REVERB_MIX_FRAG),
          blit: ctx.compileFragment(BLIT_FRAG),
        };
      } catch { glFailed = true; return false; }
      return true;
    }
    const uloc = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);

    // 1×1 black sentinel for unbound inputs — NEVER bind a destination FBO's own
    // texture as a sampler (a GL feedback loop → INVALID_OPERATION on some
    // drivers). Same pattern as BACKDRAFT / MIRRORPOOL.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('grainsOfVision: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Strip stray keys, merge defaults.
    const raw = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    const params: GrainsOfVisionParams = { ...GRAINS_OF_VISION_DEFAULTS, ...(filtered as Partial<GrainsOfVisionParams>) };

    let head = 0;
    let framesElapsed = 0;
    let outFront = 0; // index into outPing holding the CURRENT output
    let revFront = 0; // index into revPing holding the CURRENT tail

    const surface: VideoNodeSurface = {
      fbo: outPing[0]!.fbo,
      texture: outPing[0]!.texture,
      draw(frame) {
        // FREEZE: hold last output (rings + surface unchanged) for VRT.
        if (params.freeze >= 0.5) return;
        if (!ensurePrograms() || !progs) return;
        const g = frame.gl;
        const inA = frame.getInputTexture(node.id, 'in_a');
        const inB = frame.getInputTexture(node.id, 'in_b');

        // ── P0: copy live A into ring[head] (available as a past tap later). ──
        {
          const dst = srcRing[head]!;
          g.bindFramebuffer(g.FRAMEBUFFER, dst.fbo);
          g.viewport(0, 0, rw, rh);
          g.useProgram(progs.copy);
          g.activeTexture(g.TEXTURE0);
          // NEVER bind the destination (srcRing[head]) as the source — bind the
          // 1×1 sentinel when unpatched (uHas=0 blacks it anyway).
          g.bindTexture(g.TEXTURE_2D, inA ?? emptyTex);
          g.uniform1i(uloc(progs.copy, 'uTex'), 0);
          g.uniform1f(uloc(progs.copy, 'uHas'), inA ? 1 : 0);
          ctx.drawFullscreenQuad();
        }

        const cells = govDensityToCells(params.density);
        const delayFrames = govDelayFrames(params.rate);
        const pastEnabled = delayFrames > 0 && framesElapsed >= delayFrames;
        const pastTex = pastEnabled
          ? srcRing[((head - delayFrames) % GOV_HISTORY_FRAMES + GOV_HISTORY_FRAMES) % GOV_HISTORY_FRAMES]!.texture
          : (inA ?? emptyTex);
        const aspect = ctx.res.height > 0 ? ctx.res.width / ctx.res.height : 1;
        const compActive = inB ? Math.round(clamp(params.composite, 0, GOV_COMPOSITE_MODE_COUNT - 1)) : 0;

        // ── P1: grain scatter → fboGrains (the `grains` output). ──
        {
          const p = progs.grain;
          g.bindFramebuffer(g.FRAMEBUFFER, fboGrains.fbo);
          g.viewport(0, 0, rw, rh);
          g.useProgram(p);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inA ?? emptyTex);
          g.uniform1i(uloc(p, 'uNow'), 0);
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, pastTex);
          g.uniform1i(uloc(p, 'uPast'), 1);
          g.activeTexture(g.TEXTURE2);
          g.bindTexture(g.TEXTURE_2D, inB ?? emptyTex);
          g.uniform1i(uloc(p, 'uB'), 2);
          g.uniform1f(uloc(p, 'uHasA'), inA ? 1 : 0);
          g.uniform1f(uloc(p, 'uHasPast'), pastEnabled ? 1 : 0);
          g.uniform1f(uloc(p, 'uHasB'), inB ? 1 : 0);
          g.uniform1f(uloc(p, 'uAspect'), aspect);
          g.uniform1f(uloc(p, 'uCells'), cells);
          g.uniform1f(uloc(p, 'uGrainSize'), clamp(params.grain_size, 0.2, 2.5));
          g.uniform1f(uloc(p, 'uSpray'), clamp01(params.spray));
          g.uniform1f(uloc(p, 'uTimeSpray'), clamp01(params.time_spray));
          g.uniform1f(uloc(p, 'uOrient'), clamp01(params.orient));
          g.uniform1f(uloc(p, 'uWindow'), clamp01(params.window));
          g.uniform1f(uloc(p, 'uCompMode'), compActive);
          g.uniform1f(uloc(p, 'uCompAmount'), clamp01(params.comp_amount));
          ctx.drawFullscreenQuad();
        }

        // ── P2: feedback → fboFeedback (grains + fb·decay·transform(prevOut)). ──
        {
          const p = progs.feedback;
          const fbDry = govFeedbackIsDry(params.feedback, params.fb_dry);
          const prevOut = outPing[outFront]!;
          const zoom = clamp(params.fb_zoom, GOV_FB_ZOOM_MIN, GOV_FB_ZOOM_MAX);
          const rot = clamp(params.fb_rotate, GOV_FB_ROTATE_MIN, GOV_FB_ROTATE_MAX);
          const th = (rot * Math.PI) / 180;
          g.bindFramebuffer(g.FRAMEBUFFER, fboFeedback.fbo);
          g.viewport(0, 0, rw, rh);
          g.useProgram(p);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, fboGrains.texture);
          g.uniform1i(uloc(p, 'uGrains'), 0);
          g.activeTexture(g.TEXTURE1);
          g.bindTexture(g.TEXTURE_2D, prevOut.texture);
          g.uniform1i(uloc(p, 'uPrev'), 1);
          // dry ⇒ zero feedback (identity), else the amount; framesElapsed guard
          // avoids feeding an uninitialised prev on the very first frame.
          g.uniform1f(uloc(p, 'uHasPrev'), (!fbDry && framesElapsed > 0) ? 1 : 0);
          g.uniform1f(uloc(p, 'uFeedback'), fbDry ? 0 : clamp(params.feedback, 0, 0.98));
          g.uniform1f(uloc(p, 'uDecay'), clamp01(params.fb_decay));
          g.uniform1f(uloc(p, 'uZoom'), zoom);
          g.uniform1f(uloc(p, 'uCos'), Math.cos(th));
          g.uniform1f(uloc(p, 'uSin'), Math.sin(th));
          ctx.drawFullscreenQuad();
        }

        // ── P3: reverb (skipped when dry) → outPing[outNext]. ──
        const outNext = outFront ^ 1;
        const outDst = outPing[outNext]!;
        if (govReverbIsDry(params.rev_mix, params.rev_dry)) {
          // Dry passthrough: feedbackImg → out.
          g.bindFramebuffer(g.FRAMEBUFFER, outDst.fbo);
          g.viewport(0, 0, rw, rh);
          g.useProgram(progs.blit);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, fboFeedback.texture);
          g.uniform1i(uloc(progs.blit, 'uTex'), 0);
          ctx.drawFullscreenQuad();
        } else {
          const spread = govMix(0.5, GOV_MAX_BLUR_SPREAD, clamp01(params.rev_size));
          const revNext = revFront ^ 1;
          // P3a: H blur of (feedbackImg + decay·prevRev) → revTmp.
          {
            const p = progs.revH;
            g.bindFramebuffer(g.FRAMEBUFFER, revTmp.fbo);
            g.viewport(0, 0, rw, rh);
            g.useProgram(p);
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, fboFeedback.texture);
            g.uniform1i(uloc(p, 'uFeedback'), 0);
            g.activeTexture(g.TEXTURE1);
            g.bindTexture(g.TEXTURE_2D, revPing[revFront]!.texture);
            g.uniform1i(uloc(p, 'uPrevRev'), 1);
            g.uniform1f(uloc(p, 'uHasPrevRev'), framesElapsed > 0 ? 1 : 0);
            g.uniform2f(uloc(p, 'uTexel'), 1 / rw, 1 / rh);
            g.uniform1f(uloc(p, 'uSpread'), spread);
            g.uniform1f(uloc(p, 'uDecay'), clamp(params.rev_decay, 0, 0.99));
            g.uniform1f(uloc(p, 'uDiffuse'), clamp01(params.rev_diffuse));
            ctx.drawFullscreenQuad();
          }
          // P3b: V blur → revPing[revNext] (the new tail).
          {
            const p = progs.revV;
            g.bindFramebuffer(g.FRAMEBUFFER, revPing[revNext]!.fbo);
            g.viewport(0, 0, rw, rh);
            g.useProgram(p);
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, revTmp.texture);
            g.uniform1i(uloc(p, 'uTmp'), 0);
            g.uniform2f(uloc(p, 'uTexel'), 1 / rw, 1 / rh);
            g.uniform1f(uloc(p, 'uSpread'), spread);
            g.uniform1f(uloc(p, 'uDiffuse'), clamp01(params.rev_diffuse));
            ctx.drawFullscreenQuad();
          }
          // P3c: dry/wet composite → out.
          {
            const p = progs.revMix;
            g.bindFramebuffer(g.FRAMEBUFFER, outDst.fbo);
            g.viewport(0, 0, rw, rh);
            g.useProgram(p);
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, fboFeedback.texture);
            g.uniform1i(uloc(p, 'uDry'), 0);
            g.activeTexture(g.TEXTURE1);
            g.bindTexture(g.TEXTURE_2D, revPing[revNext]!.texture);
            g.uniform1i(uloc(p, 'uWet'), 1);
            g.uniform1f(uloc(p, 'uMix'), clamp01(params.rev_mix));
            ctx.drawFullscreenQuad();
          }
          revFront = revNext;
        }

        g.bindFramebuffer(g.FRAMEBUFFER, null);

        // Publish the just-written output, advance the rings.
        surface.texture = outDst.texture;
        surface.fbo = outDst.fbo;
        outFront = outNext;
        head = (head + 1) % GOV_HISTORY_FRAMES;
        framesElapsed++;
      },
      resize(w, h) {
        const all = [...srcRing, fboGrains, fboFeedback, revTmp, ...revPing, ...outPing];
        for (const t of all) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.texture); }
        rw = Math.max(1, Math.round(w * GOV_RENDER_SCALE));
        rh = Math.max(1, Math.round(h * GOV_RENDER_SCALE));
        srcRing = Array.from({ length: GOV_HISTORY_FRAMES }, () => createTarget(gl, rw, rh));
        fboGrains = createTarget(gl, rw, rh);
        fboFeedback = createTarget(gl, rw, rh);
        revTmp = createTarget(gl, rw, rh);
        revPing = [createTarget(gl, rw, rh), createTarget(gl, rw, rh)];
        outPing = [createTarget(gl, rw, rh), createTarget(gl, rw, rh)];
        head = 0; framesElapsed = 0; outFront = 0; revFront = 0;
        surface.fbo = outPing[0]!.fbo;
        surface.texture = outPing[0]!.texture;
      },
      dispose() {
        const all = [...srcRing, fboGrains, fboFeedback, revTmp, ...revPing, ...outPing];
        for (const t of all) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.texture); }
        gl.deleteTexture(emptyTex);
        if (progs) for (const p of Object.values(progs)) gl.deleteProgram(p);
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
        // Multi-output: the `grains` tap resolves via this hook (out is surface.texture).
        if (key === 'outputTexture:out') return surface.texture;
        if (key === 'outputTexture:grains') return fboGrains.texture;
        if (key === 'fboTexture') return surface.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
