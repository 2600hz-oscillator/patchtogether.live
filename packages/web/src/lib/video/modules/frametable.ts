// packages/web/src/lib/video/modules/frametable.ts
//
// FRAMETABLE — a video WAVETABLE oscillator.
//
// FrameTable continuously records the last 60 rendered input frames into a GPU
// frame ring (a TEXTURE_2D_ARRAY, one layer per frame). A MORPH knob scans a
// centre point through that 60-frame history and a SPREAD knob sets how wide a
// window around that centre each pixel may draw from. For EVERY output pixel the
// shader draws exactly ONE source frame, chosen probabilistically from a bell
// distribution over the window (centre frame most likely, periphery least). The
// per-pixel choice is fixed in SCREEN space by a static per-pixel threshold, so a
// still input yields a stable image (no TV-static shimmer) while moving content
// becomes a coherent, morph-scannable time-smear mosaic. FREEZE stops the ring
// from advancing so you can scrub a held 60-frame window; SAVE snapshots the
// current 60-frame ring into an in-GPU slot for later recall (VideoCube-ready).
//
// ── Owner's HARD REQUIREMENTS (met — see frametable-core.ts for the CPU mirror) ─
//   1. WHOLE-PIXEL SELECTION, not a blend. Each fragment outputs exactly ONE
//      source frame's pixel (a dither/mosaic), never an alpha-average.
//   2. O(1) PER FRAGMENT. The per-pixel frame index comes from the analytic
//      triangular inverse-CDF (one sqrt + one branch + one array fetch), never a
//      60-frame loop/accumulation.
//   3. STILL-IMAGE CONSISTENCY. The per-pixel threshold is STATIC in screen space
//      (gl_FragCoord, no time/frame/head term) → a still input yields a stable
//      output even while unfrozen; moving content becomes a coherent morph-
//      scannable time-smear, NOT per-frame random static.
//
// ── Storage: one TEXTURE_2D_ARRAY, 60 layers, RGBA8, half-res (512×384 ≈ 45 MiB) ─
// GLSL ES 3.00 forbids dynamically indexing a sampler ARRAY, but a sampler2DArray
// with a per-pixel-computed float layer is exactly the primitive FrameTable needs
// (a per-PIXEL dynamic lag). WebGL2 is unconditional here (the shared engine
// context is webgl2), so TEXTURE_2D_ARRAY / texImage3D / framebufferTextureLayer /
// copyTexSubImage3D are all core. MAX_ARRAY_TEXTURE_LAYERS is spec-guaranteed ≥
// 256, so 60 layers is always safe (a full-res 8×8 atlas would be 8192×6144 — at/
// above MAX_TEXTURE_SIZE on many GPUs + the SwiftShader CI renderer).
//
// NOTE (owner): this def lives in the WebGL attest basis (resolveWebglBasis sweeps
// lib/video/). Its real shader/def flips computeWebglHash → a ONE-TIME re-attest on
// a trusted GPU is REQUIRED; the co-located docs below are wrapped in
// docs-hash-ignore markers so DOC edits stay hash-transparent. Look-affecting new
// shader — do NOT auto-merge (held for owner visual preview).
//
// Design + research: .myrobots/plans/frametable-2026-07-19.md

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';
import {
  FRAMETABLE_RING_FRAMES,
  FRAMETABLE_RENDER_SCALE,
  FRAMETABLE_BLUE_NOISE_SIZE,
  FRAMETABLE_MODE_SMOOTH,
  FRAMETABLE_MODE_MORPH,
  FRAMETABLE_MODE_CHAOS,
  FRAMETABLE_SMOOTH_TAPS_GPU,
  FRAMETABLE_SMOOTH_TAPS_SOFT,
  FRAMETABLE_MORPH_TAP_CAP,
  morphKernel,
} from '$lib/video/frametable-core';

// ----------------------------------------------------------------------
// Param model.
// ----------------------------------------------------------------------

interface FrametableParams {
  // ── mode / lag dispatch ──
  mode: number;        // 0=SMOOTH (default), 1=MORPH, 2=CHAOS (curve 'discrete')
  live: number;        // 0/1 — LIVE switch (button-latched); forces REAL-TIME in any mode (OR'd with liveGate)
  liveGate: number;    // hidden synthetic — raw live_gate LEVEL; forces real-time WHILE high (OR'd with `live`)
  chaos: number;       // 0/1 — momentary CHAOS switch; overrides the selector → CHAOS while held (OR'd with chaosGate)
  chaosGate: number;   // hidden synthetic — raw chaos_gate LEVEL; overrides to CHAOS WHILE high (OR'd with `chaos`)
  // ── shared (all modes) ──
  morph: number;       // 0..1 — centre scanned through the 60-frame ring (wraps)
  spread: number;      // 1..60 — window width (frames): avg window / dissolve width / bell
  shimmer: number;     // 0..1 — flow speed (SMOOTH) / auto-scan drift (MORPH) / threshold dither (CHAOS)
  weightShape: number; // 0 = triangular (default), 1 = gaussian (CHAOS bell; idle in SMOOTH/MORPH)
  freeze: number;      // 0/1 — user-facing FREEZE toggle (button-latched; OR'd with the freeze-gate LEVEL)
  // ── SMOOTH-mode morphable-waveform field (independent X/Y shape) ──
  waveFreqX: number;   // 0..8  — cycles of the X-axis waveform across the screen
  waveAmtX: number;    // 0..1  — X-axis temporal displacement amount (→ frames = amt·N/2)
  waveShapeX: number;  // 0..1  — X waveform morph: sine → tri → saw → square
  waveFreqY: number;   // 0..8  — cycles of the Y-axis waveform
  waveAmtY: number;    // 0..1  — Y-axis displacement amount
  waveShapeY: number;  // 0..1  — Y waveform morph
  // Hidden synthetic gate-state params (no card fader):
  freezeGate: number;  // raw freeze_gate LEVEL; ring is frozen WHILE this is high (OR'd with `freeze`)
  saveTrig: number;    // raw save_trig sample / momentary button; RISING edge → snapshot
}

const FRAMETABLE_DEFAULTS: FrametableParams = {
  mode: FRAMETABLE_MODE_SMOOTH,
  live: 0,
  liveGate: 0,
  chaos: 0,
  chaosGate: 0,
  morph: 0,
  spread: 12,
  shimmer: 0,
  weightShape: 0,
  freeze: 0,
  waveFreqX: 1,
  waveAmtX: 0.35,
  waveShapeX: 0,
  waveFreqY: 1,
  waveAmtY: 0.35,
  waveShapeY: 0,
  freezeGate: 0,
  saveTrig: 0,
};

/** Cross-term coupling (§3.3 / §10.1): couples the two axis waveforms into
 *  flowing diagonal whorls. Fixed (not exposed) to save a control. */
const FRAMETABLE_CROSS = 0.4;
/** FLOW rate (§3.6): cycles/second the SMOOTH field drifts at shimmer=1. The Y
 *  axis uses an incommensurate ratio so the coupled field never loops. */
const FRAMETABLE_FLOW_RATE = 0.15;
const FRAMETABLE_FLOW_RATIO_Y = 0.73;
/** MORPH auto-scan drift rate (§4.3): morph-centre cycles/second at shimmer=1. */
const FRAMETABLE_MORPH_DRIFT_RATE = 0.05;

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(FRAMETABLE_DEFAULTS));

const N = FRAMETABLE_RING_FRAMES;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ----------------------------------------------------------------------
// GLSL — the two passes. Both transliterate the pure core in frametable-core.ts.
// ----------------------------------------------------------------------

// P0 — copy the live source frame into the ring layer at `head`.
const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHas;
void main(){ outColor = vec4(uHas > 0.5 ? texture(uTex, vUv).rgb : vec3(0.0), 1.0); }`;

// P1 — the SELECT pass. ONE program branching on the dynamically-uniform `uMode`
// int (0=SMOOTH, 1=MORPH, 2=CHAOS) — the branch is divergence-free (constant
// across all fragments), so it keeps the single uniform-cache + single deferred
// compile intact (no per-mode program). Each mode transliterates the CPU mirror
// in frametable-core.ts:
//   • CHAOS  — today's per-pixel stochastic inverse-CDF single-frame PICK.
//   • SMOOTH — 2 morphable waveforms → a 2D temporal field → a capped weighted
//              temporal AVERAGE with manual sub-frame inter-layer interpolation.
//   • MORPH  — a spatially-uniform, CPU-precomputed periodic Hann cross-dissolve.
const MAX_TAPS = 16; // SMOOTH compile-time tap cap (loop unrolls; uTaps ≤ this)
const MAX_TAPS_MORPH = FRAMETABLE_MORPH_TAP_CAP; // MORPH Hann uniform-array size
const SELECT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;

uniform sampler2DArray uRing;   // 60 layers (one per recorded frame)
uniform vec2  uBlueNoiseSize;   // screen-space threshold tile period (CHAOS)
uniform float uMorph;           // 0..1
uniform float uSpread;          // 1..60
uniform float uShimmer;         // 0..1 (0 = static)
uniform float uWeightShape;     // 0 = triangular, 1 = gaussian (CHAOS bell)
uniform int   uHead;            // ring write head this frame (newest layer)
uniform int   uFrameIndex;      // only used when uShimmer > 0 (CHAOS)
uniform float uHasContent;      // 0 until the ring has captured a real frame
uniform int   uMode;            // 0=SMOOTH, 1=MORPH, 2=CHAOS
uniform float uLive;            // 1 => real-time centre (LIVE-forced / real-time modes)
uniform int   uTaps;            // SMOOTH logical tap count (<= MAX_TAPS)
uniform float uFreqX;           // SMOOTH X-axis waveform cycles
uniform float uFreqY;           // SMOOTH Y-axis waveform cycles
uniform float uAmpX;            // SMOOTH X displacement amplitude (FRAMES)
uniform float uAmpY;            // SMOOTH Y displacement amplitude (FRAMES)
uniform float uPhaseX;          // SMOOTH X flow phase (FLOW drift)
uniform float uPhaseY;          // SMOOTH Y flow phase
uniform float uShapeX;          // SMOOTH X waveform morph (sine→tri→saw→square)
uniform float uShapeY;          // SMOOTH Y waveform morph
uniform float uCross;           // SMOOTH axis cross-coupling
uniform int   uTapCount;        // MORPH Hann tap count (<= MAX_TAPS_MORPH)
uniform float uWeights[${MAX_TAPS_MORPH}]; // MORPH per-tap weights (Σ=1, spatially uniform)
uniform float uLayers[${MAX_TAPS_MORPH}];  // MORPH per-tap ring layer (float, already round(head-k) wrapped)
const float N = ${FRAMETABLE_RING_FRAMES}.0;
const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;
const int MODE_SMOOTH = ${FRAMETABLE_MODE_SMOOTH};
const int MODE_MORPH  = ${FRAMETABLE_MODE_MORPH};
const int MODE_CHAOS  = ${FRAMETABLE_MODE_CHAOS};

// Dave-Hoskins hash21 → [0,1). Mirrors frametable-core.hash21 (CHAOS only).
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Winitzki erf^-1 (a = 0.147) — gaussian bell (CHAOS smooth mode + SMOOTH taps).
float erfinv(float x){
  float a = 0.147;
  float ln = log(max(1e-12, 1.0 - x*x)); // ln(1-x^2) < 0
  float t1 = 2.0/(PI*a) + 0.5*ln;
  float t2 = ln/a;                       // negative -> t1*t1 - t2 > t1*t1
  float s = x < 0.0 ? -1.0 : 1.0;
  return s * sqrt(max(0.0, sqrt(t1*t1 - t2) - t1));
}

int wrapRing(float x){ float m = mod(x, N); if (m < 0.0) m += N; return int(m); }

// threshold t ∈ [0,1) → temporal offset d (frames). shp<0.5 triangular, else gaussian.
float selectOffset(float t, float spread, float shp){
  float h = 0.5 * spread;
  if (shp < 0.5) {
    return (t < 0.5) ? h * (sqrt(2.0 * t) - 1.0)
                     : h * (1.0 - sqrt(2.0 * (1.0 - t)));
  }
  float sigma = spread / 6.0;                 // h == 3 sigma
  float A = 0.00135;                          // Phi(-3)
  float p = A + t * (1.0 - 2.0 * A);
  return clamp(sigma * 1.41421356 * erfinv(2.0 * p - 1.0), -h, h);
}

// morphable unit waveform in [-1,1] (sine→tri→saw→square, zero-crossing-aligned).
float wshape(float u, float freq, float phase, float shape){
  float p    = u * freq + phase;
  float sine = sin(TWO_PI * p);
  float tri  = 1.0 - 4.0 * abs(fract(p + 0.25) - 0.5);
  float saw  = 2.0 * fract(p + 0.5) - 1.0;
  float sq   = clamp(4.0 * sine, -1.0, 1.0);
  float S = clamp(shape, 0.0, 1.0) * 3.0;
  float w = sine;
  w = mix(w, tri, smoothstep(0.0, 1.0, clamp(S,       0.0, 1.0)));
  w = mix(w, saw, smoothstep(0.0, 1.0, clamp(S - 1.0, 0.0, 1.0)));
  w = mix(w, sq,  smoothstep(0.0, 1.0, clamp(S - 2.0, 0.0, 1.0)));
  return w;
}

// manual sub-frame inter-layer LINEAR interpolation — sampler2DArray rounds the
// layer coord, so a fractional temporal position needs 2 fetches + mix (§3.5).
vec3 sampleRingLerp(vec2 uv, float lag, float head){
  float layerF = head - lag;
  float l0 = floor(layerF);
  float f  = layerF - l0;
  vec3 c0 = texture(uRing, vec3(uv, float(wrapRing(l0))       )).rgb;
  vec3 c1 = texture(uRing, vec3(uv, float(wrapRing(l0 + 1.0)) )).rgb;
  return mix(c0, c1, f);
}

// MORPH — accumulate the CPU-precomputed periodic Hann kernel (Σw=1). Every
// fragment reads the SAME uLayers in the SAME order → cache-warm on SwiftShader.
vec3 morphColor(vec2 uv){
  vec3 acc = vec3(0.0);
  for (int j = 0; j < ${MAX_TAPS_MORPH}; ++j){
    if (j >= uTapCount) break;             // coherent (uniform) branch
    acc += uWeights[j] * texture(uRing, vec3(uv, uLayers[j])).rgb;
  }
  return acc;
}

void main(){
  if (uHasContent < 0.5){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 uv = vUv;
  float headF = float(uHead);

  // MORPH — spatially-uniform Hann cross-dissolve (centre folded into uLayers).
  if (uMode == MODE_MORPH){
    outColor = vec4(morphColor(uv), 1.0);
    return;
  }

  // centre lag c (frames back from head): trailing-biased when LAGGED, near
  // newest when real-time (CHAOS, or LIVE-forced). See core §2.3(a).
  float h = 0.5 * uSpread;
  bool lagged = (uMode != MODE_CHAOS) && (uLive < 0.5);
  float c = lagged ? (h + uMorph * (N - 2.0 * h)) : (uMorph * N);

  if (uMode == MODE_CHAOS){
    // today's per-pixel PICK — static screen-space threshold → inverse-CDF → one
    // array fetch, no blend. hash21/shimmer live ONLY in this branch.
    vec2 bn = mod(gl_FragCoord.xy, uBlueNoiseSize);
    float t = hash21(floor(bn));
    if (uShimmer > 0.0)
      t = fract(t + uShimmer * fract(float(uFrameIndex) * 0.61803399));
    float d = selectOffset(t, uSpread, uWeightShape);
    float lag   = mod(c + d + N, N);
    float layer = mod(headF - lag, N);
    int   k     = wrapRing(layer + 0.5);
    outColor = vec4(texture(uRing, vec3(uv, float(k))).rgb, 1.0);
    return;
  }

  // MODE_SMOOTH — 2D temporal field → capped weighted temporal AVERAGE (a BLEND).
  float a = wshape(uv.x, uFreqX, uPhaseX, uShapeX);
  float b = wshape(uv.y, uFreqY, uPhaseY, uShapeY);
  float field = uAmpX * a + uAmpY * b + uCross * 0.5 * (uAmpX + uAmpY) * a * b;
  float lagCentre = c + field;               // per-pixel temporal centre (FRAMES)

  vec3  acc  = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${MAX_TAPS}; i++){
    if (i >= uTaps) break;                   // coherent (uniform) branch
    float t = (float(i) + 0.5) / float(uTaps);
    float d = selectOffset(t, uSpread, 1.0); // fixed GAUSSIAN placement (§3.4)
    acc  += sampleRingLerp(uv, lagCentre + d, headF);
    wsum += 1.0;
  }
  outColor = vec4(acc / max(wsum, 1.0), 1.0);
}`;

// ----------------------------------------------------------------------
// GL resource helpers (module-owned — the array + output are NOT engine-managed
// FBOs; ctx.createFbo() only mints auto-resizing TEXTURE_2D).
// ----------------------------------------------------------------------

/** A 60-layer RGBA8 TEXTURE_2D_ARRAY at (w×h). LINEAR, CLAMP on S/T/R. */
function createRingArray(gl: WebGL2RenderingContext, w: number, h: number, layers: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('frametable: createTexture (ring array) failed');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, w, h, layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  return tex;
}

/** A plain RGBA8 TEXTURE_2D render target (the SELECT output = surface.texture). */
function createTarget(gl: WebGL2RenderingContext, w: number, h: number): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
  const tex = gl.createTexture();
  if (!tex) throw new Error('frametable: createTexture (output) failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  if (!fbo) { gl.deleteTexture(tex); throw new Error('frametable: createFramebuffer failed'); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture: tex };
}

/** An in-GPU SAVE snapshot: a full copy of the 60-layer ring at the moment of
 *  save (VideoCube-ready — the Cube reads it through the handle's read() hook). */
interface RingSnapshot {
  tex: WebGLTexture; // TEXTURE_2D_ARRAY, `layers` deep
  layers: number;
  w: number;
  h: number;
  head: number;      // write head at save time = NEXT slot to write (oldest layer)
  newest: number;    // newest COMPLETED layer = (head-1+N)%N — matches the shader's uHead
}

/**
 * Renderer-gated SMOOTH tap count (§3.7 / §4.4). T=4 (8 array fetches) on the
 * SwiftShader software renderer (CI), T=8 (16 fetches) on a real GPU. This is
 * the recorderbox/edges CI failure class — a flat perf assert that passes on a
 * GPU goes red on CI — so bound the software-renderer cost from a renderer probe.
 * When the renderer string is masked/absent, default to the GPU count (the
 * correct default for real users); CI reliably reports "SwiftShader".
 */
function detectSmoothTaps(gl: WebGL2RenderingContext): number {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
    );
    if (/swiftshader|software|llvmpipe/i.test(renderer)) return FRAMETABLE_SMOOTH_TAPS_SOFT;
  } catch {
    /* extension/param unavailable — fall through to the GPU default */
  }
  return FRAMETABLE_SMOOTH_TAPS_GPU;
}

export const frametableDef: VideoModuleDef = {
  type: 'frametable',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'frametable',
  category: 'effects',
  // The ring must keep FILLING even when unobserved: the 60-frame history reaches
  // BACK in time, so a gap from a paused-while-unwatched period would be a visible
  // seam the instant you MORPH back through it. pullExempt keeps the ring coherent.
  pullExempt: true,
  inputs: [
    { id: 'video_in', type: 'video' },
    // Continuous knobs → matching CV inputs (cvScale REQUIRED on type:'cv').
    { id: 'morph_cv',       type: 'cv', paramTarget: 'morph',       cvScale: { mode: 'linear' } },
    { id: 'spread_cv',      type: 'cv', paramTarget: 'spread',      cvScale: { mode: 'linear' } },
    { id: 'shimmer_cv',     type: 'cv', paramTarget: 'shimmer',     cvScale: { mode: 'linear' } },
    { id: 'weightShape_cv', type: 'cv', paramTarget: 'weightShape', cvScale: { mode: 'linear' } },
    // SMOOTH-mode morphable-waveform CVs (continuous → cvScale REQUIRED).
    { id: 'waveFreqX_cv',  type: 'cv', paramTarget: 'waveFreqX',  cvScale: { mode: 'linear' } },
    { id: 'waveAmtX_cv',   type: 'cv', paramTarget: 'waveAmtX',   cvScale: { mode: 'linear' } },
    { id: 'waveShapeX_cv', type: 'cv', paramTarget: 'waveShapeX', cvScale: { mode: 'linear' } },
    { id: 'waveFreqY_cv',  type: 'cv', paramTarget: 'waveFreqY',  cvScale: { mode: 'linear' } },
    { id: 'waveAmtY_cv',   type: 'cv', paramTarget: 'waveAmtY',   cvScale: { mode: 'linear' } },
    { id: 'waveShapeY_cv', type: 'cv', paramTarget: 'waveShapeY', cvScale: { mode: 'linear' } },
    // FREEZE gate — a MOMENTARY level hold (edge:'gate'): the ring is frozen WHILE
    // the gate is held HIGH, OR'd with the persistent button toggle. Routed to a
    // synthetic `freezeGate` param so the per-frame gate LEVEL never stomps the
    // button's latched `freeze`. SAVE trigger fires a one-shot snapshot on the
    // rising edge. CHAOS gate momentarily forces the CHAOS render; LIVE gate
    // momentarily forces real-time (no-lag) in any mode — both FREEZE-pattern
    // (synthetic-param OR'd with the faceplate switch). Gate-typed → no cvScale.
    { id: 'freeze_gate', type: 'gate', edge: 'gate',    paramTarget: 'freezeGate' },
    { id: 'save_trig',   type: 'gate', edge: 'trigger', paramTarget: 'saveTrig'   },
    { id: 'chaos_gate',  type: 'gate', edge: 'gate',    paramTarget: 'chaosGate'  },
    { id: 'live_gate',   type: 'gate', edge: 'gate',    paramTarget: 'liveGate'   },
  ],
  outputs: [{ id: 'video_out', type: 'video' }],
  params: [
    // mode selector: 0=SMOOTH (default), 1=MORPH, 2=CHAOS. Discrete (faceplate-only, no CV).
    { id: 'mode',        label: 'mode',      defaultValue: FRAMETABLE_DEFAULTS.mode,       min: 0, max: 2,  curve: 'discrete' },
    // LIVE switch (button-latched; OR'd with the live_gate LEVEL) → forces real-time.
    { id: 'live',        label: 'live',      defaultValue: FRAMETABLE_DEFAULTS.live,       min: 0, max: 1,  curve: 'linear' },
    // momentary CHAOS switch (button-latched; OR'd with the chaos_gate LEVEL) → overrides to CHAOS.
    { id: 'chaos',       label: 'chaos',     defaultValue: FRAMETABLE_DEFAULTS.chaos,      min: 0, max: 1,  curve: 'linear' },
    { id: 'morph',       label: 'morph',     defaultValue: FRAMETABLE_DEFAULTS.morph,      min: 0, max: 1,  curve: 'linear' },
    { id: 'spread',      label: 'spread',    defaultValue: FRAMETABLE_DEFAULTS.spread,     min: 1, max: 60, curve: 'linear' },
    { id: 'shimmer',     label: 'shimmer',   defaultValue: FRAMETABLE_DEFAULTS.shimmer,    min: 0, max: 1,  curve: 'linear' },
    // weight-shape: 0 = triangular (default), 1 = gaussian ("smooth"). CHAOS bell only.
    { id: 'weightShape', label: 'shape',     defaultValue: FRAMETABLE_DEFAULTS.weightShape, min: 0, max: 1, curve: 'linear' },
    // user-facing FREEZE toggle (button-latched; OR'd with the freeze_gate LEVEL to freeze).
    { id: 'freeze',      label: 'freeze',    defaultValue: FRAMETABLE_DEFAULTS.freeze,     min: 0, max: 1,  curve: 'linear' },
    // SMOOTH-mode morphable-waveform field (independent X/Y).
    { id: 'waveFreqX',   label: 'x freq',    defaultValue: FRAMETABLE_DEFAULTS.waveFreqX,  min: 0, max: 8,  curve: 'linear' },
    { id: 'waveAmtX',    label: 'x amt',     defaultValue: FRAMETABLE_DEFAULTS.waveAmtX,   min: 0, max: 1,  curve: 'linear' },
    { id: 'waveShapeX',  label: 'x shape',   defaultValue: FRAMETABLE_DEFAULTS.waveShapeX, min: 0, max: 1,  curve: 'linear' },
    { id: 'waveFreqY',   label: 'y freq',    defaultValue: FRAMETABLE_DEFAULTS.waveFreqY,  min: 0, max: 8,  curve: 'linear' },
    { id: 'waveAmtY',    label: 'y amt',     defaultValue: FRAMETABLE_DEFAULTS.waveAmtY,   min: 0, max: 1,  curve: 'linear' },
    { id: 'waveShapeY',  label: 'y shape',   defaultValue: FRAMETABLE_DEFAULTS.waveShapeY, min: 0, max: 1,  curve: 'linear' },
    // hidden synthetic gate-state params (no card fader).
    { id: 'liveGate',    label: 'live gate', defaultValue: FRAMETABLE_DEFAULTS.liveGate,   min: 0, max: 1,  curve: 'linear' },
    { id: 'chaosGate',   label: 'chaos gate',defaultValue: FRAMETABLE_DEFAULTS.chaosGate,  min: 0, max: 1,  curve: 'linear' },
    { id: 'freezeGate',  label: 'frz gate',  defaultValue: FRAMETABLE_DEFAULTS.freezeGate, min: 0, max: 1,  curve: 'linear' },
    { id: 'saveTrig',    label: 'save',      defaultValue: FRAMETABLE_DEFAULTS.saveTrig,   min: 0, max: 1,  curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation:
      'FRAMETABLE is a video WAVETABLE oscillator. It continuously records the last 60 rendered input frames into a GPU frame ring (a TEXTURE_2D_ARRAY, one layer per frame) and treats that 60-frame history like the single-cycle waves of a wavetable synth: MORPH scans a centre point through the table and SPREAD sets how wide a window around it each output draws from. A faceplate MODE selector picks one of THREE render engines. SMOOTH (the default) paints a smooth 2D field of temporal sample-centres from two morphable waveforms (one per screen axis) and outputs a CAPPED WEIGHTED TEMPORAL AVERAGE — a blend favouring the peak frame, not a single-frame pick — so the result is a flowing, liquid, recognizable-waveform distortion (sub-frame temporal positions are interpolated manually for a buttery result). MORPH is the smoothest possible cross-dissolve: a spatially-uniform, pop-free scan between temporal positions using a periodic raised-cosine (Hann) reconstruction kernel that is C¹ at its window edges AND N-periodic across the 59→0 wrap seam, so scanning MORPH loops seamlessly. CHAOS is the original per-pixel stochastic look — for every pixel the shader draws exactly ONE source frame (a whole-pixel dither/mosaic) chosen in O(1) by an analytic inverse-CDF from a static screen-space threshold, so a still input yields a stable image while moving content becomes a coherent morph-scannable time-smear. LAG MODEL: lag = (mode ≠ CHAOS) && !LIVE. CHAOS is always real-time (no lag). SMOOTH and MORPH auto-engage a ~2-second lag (they read a trailing window of the buffer) unless the LIVE control forces real-time. On the first real input frame the whole 60-layer ring is filled with that frame (buffer instantly full = a still image), then real frames wash in over ~2s — so there is no black warmup and a lagged read always hits a full buffer. LIVE (a faceplate switch OR its gate) forces real-time / no-lag in any mode; CHAOS (a momentary switch OR its gate) overrides the selector to the real-time CHAOS render while held. SPREAD is the temporal-average window (SMOOTH) / cross-dissolve width (MORPH) / bell window (CHAOS). SHIMMER is flow speed (SMOOTH field drift) / auto-scan drift (MORPH) / threshold dither (CHAOS). SHAPE morphs the CHAOS bell triangular↔gaussian (idle in SMOOTH/MORPH, which use a fixed gaussian/Hann). The X/Y waveform controls (freq, amt, shape per axis) sculpt SMOOTH\'s field. FREEZE (a toggle button, plus a freeze gate that holds the ring frozen while high) stops the ring from advancing so you can scrub a held 60-frame window; SAVE (a momentary button, also a rising edge on the save trigger) snapshots the ring into an in-GPU slot for later recall (and to feed a future video Cube). Rendered at half engine resolution (SwiftShader/CI budget); an unpatched input renders black. The mode/lag dispatch, morphable-waveform field, weighted-average blend, Hann kernel, inverse-CDF and freeze/save/first-fill reducers are a 1:1 CPU mirror unit-tested in $lib/video/frametable-core. All ports live on the yellow drill-down PATCH PANEL (no raw side jacks).',
    inputs: {
      video_in: 'The source video recorded, frame by frame, into the 60-frame ring. Unpatched, the output is black.',
      morph_cv: 'CV that modulates MORPH (the centre point scanned through the 60-frame history), swept linearly over 0..1 (wraps at the ring seam).',
      spread_cv: 'CV that modulates SPREAD (the window width in frames — temporal-average width / dissolve width / bell window depending on mode), swept linearly over 1..60.',
      shimmer_cv: 'CV that modulates SHIMMER (flow speed in SMOOTH / auto-scan drift in MORPH / threshold dither in CHAOS), swept linearly over 0..1.',
      weightShape_cv: 'CV that modulates SHAPE (the CHAOS selection bell, triangular↔gaussian), swept linearly over 0..1.',
      waveFreqX_cv: 'CV that modulates X FREQ (cycles of the SMOOTH X-axis waveform across the screen), swept linearly over 0..8.',
      waveAmtX_cv: 'CV that modulates X AMT (the SMOOTH X-axis temporal-displacement amount), swept linearly over 0..1.',
      waveShapeX_cv: 'CV that modulates X SHAPE (the SMOOTH X-axis waveform morph, sine→tri→saw→square), swept linearly over 0..1.',
      waveFreqY_cv: 'CV that modulates Y FREQ (cycles of the SMOOTH Y-axis waveform), swept linearly over 0..8.',
      waveAmtY_cv: 'CV that modulates Y AMT (the SMOOTH Y-axis temporal-displacement amount), swept linearly over 0..1.',
      waveShapeY_cv: 'CV that modulates Y SHAPE (the SMOOTH Y-axis waveform morph), swept linearly over 0..1.',
      freeze_gate: 'FREEZE gate. WHILE the gate is HELD HIGH (level >= 0.5) the ring is frozen — a momentary hold, with the output staying live over the held 60 frames — and it resumes the instant the gate drops low. OR-combined with the FREEZE toggle button, so either can freeze the ring independently.',
      save_trig: 'SAVE trigger. A RISING edge fires ONCE, snapshotting the current 60-frame ring into an in-GPU slot (idempotent per edge — held high does not re-snapshot).',
      chaos_gate: 'CHAOS gate. WHILE held HIGH (level >= 0.5) it momentarily forces the real-time per-pixel CHAOS render, overriding the MODE selector; it drops back to the selected mode the instant the gate goes low. OR-combined with the momentary CHAOS switch.',
      live_gate: 'LIVE gate. WHILE held HIGH (level >= 0.5) it forces the real-time / no-lag read in ANY mode (SMOOTH and MORPH stop lagging and track the live input); it re-engages the ~2-second lag the instant the gate goes low. OR-combined with the LIVE switch.',
    },
    outputs: {
      video_out: 'The rendered frame: the SMOOTH weighted-average field, the MORPH cross-dissolve, or the CHAOS selected-frame mosaic, depending on the active mode. The card preview shows this output.',
    },
    controls: {
      mode: 'MODE (0..2, default 0 = SMOOTH): the render engine. 0 = SMOOTH (flowing 2D temporal-average field from two morphable waveforms, auto-lagged), 1 = MORPH (smoothest cross-dissolve scan of the table, auto-lagged), 2 = CHAOS (the original per-pixel inverse-CDF single-frame pick, always real-time). A faceplate selector; no CV (discrete).',
      live: 'LIVE (0/1, default 0): forces the REAL-TIME / no-lag read in any mode. Off (default) leaves SMOOTH and MORPH auto-lagged by ~2 seconds so they read a full trailing buffer; on makes every mode track the live input. Latched by the switch; the live gate additionally forces it while that gate is high.',
      chaos: 'CHAOS (0/1, default 0): momentarily overrides the MODE selector to the real-time CHAOS render while engaged, then reverts to the selected mode. Latched by the switch; the chaos gate additionally forces it while that gate is high.',
      morph: 'MORPH (0..1, default 0): scans the centre point through the 60-frame ring (wraps at the seam). SMOOTH → the field DC / scan depth; MORPH → the temporal position being dissolved to; CHAOS → the centre lag of the bell.',
      spread: 'SPREAD (1..60, default 12): the window width in frames. SMOOTH → the temporal-average window; MORPH → the cross-dissolve blend width (1 ≈ a crisp single moment, wider = a longer buttery dissolve); CHAOS → the bell window (1 = a single-frame delta).',
      shimmer: 'SHIMMER (0..1, default 0): SMOOTH → flow SPEED (the field drifts, incommensurate X/Y rates so it never loops = liquid); MORPH → a gentle auto-scan drift of the dissolve centre; CHAOS → temporal dither of the static per-pixel threshold. 0 = fully static.',
      weightShape: 'SHAPE (0..1, default 0): morphs the CHAOS selection bell from triangular (0, compact) to gaussian (1, smooth). Idle in SMOOTH/MORPH (which use a fixed gaussian / Hann kernel).',
      freeze: 'FREEZE (0/1, default 0): stops the ring from advancing so the held 60-frame window can be scrubbed with MORPH/SPREAD (the render pass keeps running, so the controls stay live over the frozen frames). The toggle button latches it; the freeze gate additionally holds it frozen while that gate is high.',
      waveFreqX: 'X FREQ (0..8, default 1): cycles of the SMOOTH X-axis morphable waveform across the screen. More cycles = finer horizontal temporal ripples in the field. SMOOTH mode only.',
      waveAmtX: 'X AMT (0..1, default 0.35): how far the SMOOTH X-axis waveform displaces the per-pixel temporal centre (mapped to frames = amt·N/2). 0 = flat; higher = more of the history spread across the X axis. SMOOTH mode only.',
      waveShapeX: 'X SHAPE (0..1, default 0): morphs the SMOOTH X-axis waveform sine→triangle→saw→square (zero-crossing-aligned so blending never phase-cancels). SMOOTH mode only.',
      waveFreqY: 'Y FREQ (0..8, default 1): cycles of the SMOOTH Y-axis morphable waveform across the screen. SMOOTH mode only.',
      waveAmtY: 'Y AMT (0..1, default 0.35): the SMOOTH Y-axis temporal-displacement amount (mapped to frames = amt·N/2). SMOOTH mode only.',
      waveShapeY: 'Y SHAPE (0..1, default 0): morphs the SMOOTH Y-axis waveform sine→triangle→saw→square. SMOOTH mode only.',
      liveGate: 'Hidden synthetic param the live-gate CV bridge writes each frame with the live gate LEVEL; while it is HIGH (>= 0.5) the real-time / no-lag read is forced in any mode (OR-combined with the LIVE switch, so the per-frame level never stomps the button\'s latched state). Exposed only as the live gate jack, not as a knob.',
      chaosGate: 'Hidden synthetic param the chaos-gate CV bridge writes each frame with the chaos gate LEVEL; while it is HIGH (>= 0.5) the CHAOS render is forced, overriding the MODE selector (OR-combined with the momentary CHAOS switch). Exposed only as the chaos gate jack, not as a knob.',
      freezeGate: 'Hidden synthetic param the freeze-gate CV bridge writes each frame with the live gate LEVEL; while it is HIGH (>= 0.5) the ring is held frozen (OR-combined with the FREEZE toggle, so the per-frame level never stomps the button\'s latched state). Exposed only as the freeze gate jack, not as a knob.',
      saveTrig: 'Hidden synthetic param the SAVE momentary button sets and the save-trigger CV bridge writes; a RISING edge on it snapshots the current 60-frame ring into an in-GPU slot (idempotent per edge). Exposed only as the SAVE button + save trigger jack, not as a knob.',
    },
  },
  controlFamilies: [],
  // docs-hash-ignore:end

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    // Module-owned reduced-res resources (the module owns its own resize).
    let rw = Math.max(1, Math.round(ctx.res.width * FRAMETABLE_RENDER_SCALE));
    let rh = Math.max(1, Math.round(ctx.res.height * FRAMETABLE_RENDER_SCALE));

    let ringTex = createRingArray(gl, rw, rh, N);
    // One reusable framebuffer, retargeted per ring layer with framebufferTextureLayer.
    let ringFbo = gl.createFramebuffer();
    if (!ringFbo) throw new Error('frametable: createFramebuffer (ring) failed');
    let outTarget = createTarget(gl, rw, rh);

    // Clear every ring layer to black so an unwritten layer never samples garbage.
    function clearRing(): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, ringFbo);
      gl.viewport(0, 0, rw, rh);
      gl.clearColor(0, 0, 0, 1);
      for (let i = 0; i < N; i++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, ringTex, 0, i);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    clearRing();

    // 1×1 black sentinel for the unpatched-input case (never bind a null sampler).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('frametable: createTexture (sentinel) failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Renderer-gated SMOOTH tap count (T=4 SwiftShader / T=8 GPU). Probed once.
    const smoothTaps = detectSmoothTaps(gl);

    // Deferred program compile (mandelbulb/mirrorpool CI discipline) + cached uniforms.
    let progs: { copy: WebGLProgram; select: WebGLProgram } | null = null;
    let u: {
      copyTex: WebGLUniformLocation | null; copyHas: WebGLUniformLocation | null;
      ring: WebGLUniformLocation | null; bnSize: WebGLUniformLocation | null;
      morph: WebGLUniformLocation | null; spread: WebGLUniformLocation | null;
      shimmer: WebGLUniformLocation | null; shape: WebGLUniformLocation | null;
      head: WebGLUniformLocation | null; frameIndex: WebGLUniformLocation | null;
      hasContent: WebGLUniformLocation | null;
      mode: WebGLUniformLocation | null; live: WebGLUniformLocation | null;
      taps: WebGLUniformLocation | null; cross: WebGLUniformLocation | null;
      freqX: WebGLUniformLocation | null; freqY: WebGLUniformLocation | null;
      ampX: WebGLUniformLocation | null; ampY: WebGLUniformLocation | null;
      phaseX: WebGLUniformLocation | null; phaseY: WebGLUniformLocation | null;
      shapeX: WebGLUniformLocation | null; shapeY: WebGLUniformLocation | null;
      tapCount: WebGLUniformLocation | null; weights: WebGLUniformLocation | null;
      layers: WebGLUniformLocation | null;
    } | null = null;
    let glFailed = false;
    function ensurePrograms(): boolean {
      if (progs) return true;
      if (glFailed) return false;
      try {
        const copy = ctx.compileFragment(COPY_FRAG);
        const select = ctx.compileFragment(SELECT_FRAG);
        progs = { copy, select };
        u = {
          copyTex: gl.getUniformLocation(copy, 'uTex'),
          copyHas: gl.getUniformLocation(copy, 'uHas'),
          ring: gl.getUniformLocation(select, 'uRing'),
          bnSize: gl.getUniformLocation(select, 'uBlueNoiseSize'),
          morph: gl.getUniformLocation(select, 'uMorph'),
          spread: gl.getUniformLocation(select, 'uSpread'),
          shimmer: gl.getUniformLocation(select, 'uShimmer'),
          shape: gl.getUniformLocation(select, 'uWeightShape'),
          head: gl.getUniformLocation(select, 'uHead'),
          frameIndex: gl.getUniformLocation(select, 'uFrameIndex'),
          hasContent: gl.getUniformLocation(select, 'uHasContent'),
          mode: gl.getUniformLocation(select, 'uMode'),
          live: gl.getUniformLocation(select, 'uLive'),
          taps: gl.getUniformLocation(select, 'uTaps'),
          cross: gl.getUniformLocation(select, 'uCross'),
          freqX: gl.getUniformLocation(select, 'uFreqX'),
          freqY: gl.getUniformLocation(select, 'uFreqY'),
          ampX: gl.getUniformLocation(select, 'uAmpX'),
          ampY: gl.getUniformLocation(select, 'uAmpY'),
          phaseX: gl.getUniformLocation(select, 'uPhaseX'),
          phaseY: gl.getUniformLocation(select, 'uPhaseY'),
          shapeX: gl.getUniformLocation(select, 'uShapeX'),
          shapeY: gl.getUniformLocation(select, 'uShapeY'),
          tapCount: gl.getUniformLocation(select, 'uTapCount'),
          weights: gl.getUniformLocation(select, 'uWeights'),
          layers: gl.getUniformLocation(select, 'uLayers'),
        };
      } catch { glFailed = true; return false; }
      return true;
    }

    // CPU-side SHIMMER→FLOW phase integrators (§3.6): the SMOOTH field drifts at
    // incommensurate X/Y rates so the coupled field wanders without looping
    // (liquid). Kept out of the shader (which stays a pure function of uniforms).
    let phaseX = 0;
    let phaseY = 0;
    // MORPH auto-scan drift (§4.3): a slow drift added to the morph centre.
    let morphDrift = 0;
    // Reusable MORPH kernel upload buffers (avoid per-frame allocation).
    const morphW = new Float32Array(MAX_TAPS_MORPH);
    const morphL = new Float32Array(MAX_TAPS_MORPH);

    // Merge stored params over defaults (strip stray keys).
    const raw = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    const params: FrametableParams = { ...FRAMETABLE_DEFAULTS, ...(filtered as Partial<FrametableParams>) };

    let head = 0;
    let framesElapsed = 0;
    let capturedAny = false;

    // Edge state: save-trig rising edge SNAPSHOTS (cv-gate-edge hysteresis
    // detector). FREEZE is a level-read (frozen while the gate is high), no edge.
    const saveEdge: EdgeState = makeEdgeState();

    // In-GPU SAVE-slot registry (VideoCube-ready). v1: a single default slot,
    // overwritten each save (the old texture is freed). The named-slot picker is
    // a documented follow-up.
    const snapshots = new Map<string, RingSnapshot>();
    const DEFAULT_SLOT = 'default';

    /** Snapshot the live 60-layer ring into a fresh array (copyTexSubImage3D per
     *  layer). Idempotent per SAVE rising edge (the edge detector gates the call). */
    function snapshotRing(slot: string = DEFAULT_SLOT): void {
      const snapTex = createRingArray(gl, rw, rh, N);
      const readFbo = gl.createFramebuffer();
      if (!readFbo) { gl.deleteTexture(snapTex); return; }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFbo);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, snapTex);
      for (let i = 0; i < N; i++) {
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, ringTex, 0, i);
        gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, 0, 0, rw, rh);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.deleteFramebuffer(readFbo);
      const prev = snapshots.get(slot);
      if (prev) gl.deleteTexture(prev.tex);
      snapshots.set(slot, { tex: snapTex, layers: N, w: rw, h: rh, head, newest: (head - 1 + N) % N });
    }

    const surface: VideoNodeSurface = {
      fbo: outTarget.fbo,
      texture: outTarget.texture,
      draw(frame) {
        if (!ensurePrograms() || !progs || !u) return;
        const g = frame.gl;

        // SAVE: fire ONCE per rising edge of saveTrig (idempotent per edge).
        if (detectEdge(saveEdge, params.saveTrig)?.pressed === true) snapshotRing();

        // ── Effective-state resolution (§2.2) — FREEZE-pattern OR (button ‖ gate). ──
        const chaosActive = params.chaos >= 0.5 || params.chaosGate >= 0.5; // momentary CHAOS
        const liveActive = params.live >= 0.5 || params.liveGate >= 0.5;    // LIVE switch
        const frozen = params.freeze >= 0.5 || params.freezeGate >= 0.5;    // unchanged
        const selMode = Math.round(clamp(params.mode, 0, 2));
        const effMode = chaosActive ? FRAMETABLE_MODE_CHAOS : selMode; // momentary chaos overrides
        const lagged = effMode !== FRAMETABLE_MODE_CHAOS && !liveActive;

        const inputTex = frame.getInputTexture(node.id, 'video_in');

        // ── SHIMMER → FLOW (§3.6/§4.3), integrated CPU-side (shader stays a pure
        //    function of uniforms). SMOOTH: incommensurate X/Y phase drift (liquid);
        //    MORPH: a gentle auto-scan drift of the dissolve centre. CHAOS uses
        //    shimmer as a per-fragment threshold dither in-shader (uShimmer). ──
        const dt = Math.min(0.1, Math.max(0, frame.timeDelta ?? 1 / 60));
        const shim = clamp01(params.shimmer);
        phaseX = (phaseX + shim * FRAMETABLE_FLOW_RATE * dt) % 1;
        phaseY = (phaseY + shim * FRAMETABLE_FLOW_RATE * FRAMETABLE_FLOW_RATIO_Y * dt) % 1;
        morphDrift = (morphDrift + shim * FRAMETABLE_MORPH_DRIFT_RATE * dt) % 1;

        const morphBase = clamp01(params.morph);
        const spread = clamp(params.spread, 1, N - 1); // ≤ N-1 so the lagged [h,N-h] window is non-empty
        // MORPH auto-scan: a small oscillating drift around the knob position.
        const morphEff =
          effMode === FRAMETABLE_MODE_MORPH
            ? clamp01(morphBase + 0.12 * Math.sin(6.28318530718 * morphDrift))
            : morphBase;

        // ── SELECT — mode-branched (§2.5): sample the ring as written by PRIOR
        //    frames (newest FULLY-WRITTEN layer = (head-1) mod N). Selecting BEFORE
        //    the capture avoids the same-frame read-after-write hazard (ANGLE
        //    returns undefined/black), at one imperceptible frame of latency. ──
        const newestHead = (head - 1 + N) % N;
        g.bindFramebuffer(g.FRAMEBUFFER, outTarget.fbo);
        g.viewport(0, 0, rw, rh);
        g.useProgram(progs.select);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex);
        g.uniform1i(u.ring, 0);
        g.uniform2f(u.bnSize, FRAMETABLE_BLUE_NOISE_SIZE, FRAMETABLE_BLUE_NOISE_SIZE);
        g.uniform1f(u.morph, morphBase);
        g.uniform1f(u.spread, spread);
        g.uniform1f(u.shimmer, shim);
        g.uniform1f(u.shape, clamp01(params.weightShape));
        g.uniform1i(u.head, newestHead);
        g.uniform1i(u.frameIndex, frame.frame | 0);
        g.uniform1f(u.hasContent, capturedAny ? 1 : 0);
        g.uniform1i(u.mode, effMode);
        g.uniform1f(u.live, liveActive ? 1 : 0);
        g.uniform1i(u.taps, smoothTaps);
        g.uniform1f(u.cross, FRAMETABLE_CROSS);
        // SMOOTH morphable-waveform field uniforms.
        g.uniform1f(u.freqX, clamp(params.waveFreqX, 0, 8));
        g.uniform1f(u.freqY, clamp(params.waveFreqY, 0, 8));
        g.uniform1f(u.ampX, clamp01(params.waveAmtX) * (N / 2));
        g.uniform1f(u.ampY, clamp01(params.waveAmtY) * (N / 2));
        g.uniform1f(u.phaseX, phaseX);
        g.uniform1f(u.phaseY, phaseY);
        g.uniform1f(u.shapeX, clamp01(params.waveShapeX));
        g.uniform1f(u.shapeY, clamp01(params.waveShapeY));
        // MORPH — precompute the periodic Hann kernel CPU-side (spatially uniform)
        // and upload as uniform arrays. Only when MORPH is active (cache-warm reads).
        if (effMode === FRAMETABLE_MODE_MORPH) {
          const kernel = morphKernel(morphEff, spread, newestHead, lagged, MAX_TAPS_MORPH, N);
          for (let j = 0; j < kernel.count; j++) {
            morphW[j] = kernel.weights[j]!;
            morphL[j] = kernel.layers[j]!;
          }
          g.uniform1i(u.tapCount, kernel.count);
          g.uniform1fv(u.weights, morphW);
          g.uniform1fv(u.layers, morphL);
        }
        ctx.drawFullscreenQuad();

        // ── CAPTURE live input → ring (unless FROZEN), then advance. Capture always
        //    records at full rate in EVERY mode (LIVE/mode only change the READ). On
        //    the FIRST real input frame, fill ALL N layers with it (buffer instantly
        //    FULL = a still image); real frames then wash in over ~2s. The fill/
        //    capture bind inputTex (or the black sentinel) as sampler and a ring
        //    LAYER as target — NEVER the reverse (GL feedback guard). ──
        if (!frozen) {
          const firstReal = !capturedAny && inputTex != null;
          g.useProgram(progs.copy);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex ?? emptyTex);
          g.uniform1i(u.copyTex, 0);
          g.uniform1f(u.copyHas, inputTex ? 1 : 0);
          g.bindFramebuffer(g.FRAMEBUFFER, ringFbo);
          g.viewport(0, 0, rw, rh);
          if (firstReal) {
            for (let i = 0; i < N; i++) {
              g.framebufferTextureLayer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, ringTex, 0, i);
              ctx.drawFullscreenQuad();
            }
          } else {
            g.framebufferTextureLayer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, ringTex, 0, head);
            ctx.drawFullscreenQuad();
          }
          if (inputTex) capturedAny = true;
          head = (head + 1) % N;
          framesElapsed++;
        }

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      resize(w, h) {
        gl.deleteTexture(ringTex);
        gl.deleteFramebuffer(outTarget.fbo);
        gl.deleteTexture(outTarget.texture);
        rw = Math.max(1, Math.round(w * FRAMETABLE_RENDER_SCALE));
        rh = Math.max(1, Math.round(h * FRAMETABLE_RENDER_SCALE));
        ringTex = createRingArray(gl, rw, rh, N);
        outTarget = createTarget(gl, rw, rh);
        clearRing();
        head = 0; framesElapsed = 0; capturedAny = false;
        surface.fbo = outTarget.fbo;
        surface.texture = outTarget.texture;
      },
      dispose() {
        gl.deleteTexture(ringTex);
        gl.deleteFramebuffer(ringFbo);
        gl.deleteFramebuffer(outTarget.fbo);
        gl.deleteTexture(outTarget.texture);
        gl.deleteTexture(emptyTex);
        for (const snap of snapshots.values()) gl.deleteTexture(snap.tex);
        snapshots.clear();
        if (progs) { gl.deleteProgram(progs.copy); gl.deleteProgram(progs.select); }
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        // freezeGate is the live gate LEVEL (read as-is in draw); no edge here.
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Canonical output (also surface.texture for single-texture consumers).
        if (key === 'outputTexture:video_out' || key === 'fboTexture') return surface.texture;
        // VideoCube readiness: the live ring + a saved snapshot slot, readable
        // through the shared GL context so a Cube face can page through the table.
        // `newest` is the newest COMPLETED layer (matches the shader's uHead); `head`
        // is the raw write head (the NEXT slot to write = OLDEST layer), so a consumer
        // that wants "the latest frame" must use `newest`, not `head`.
        if (key === 'ringLive') return { tex: ringTex, layers: N, w: rw, h: rh, head, newest: (head - 1 + N) % N };
        if (typeof key === 'string' && key.startsWith('ringSnapshot:')) {
          return snapshots.get(key.slice('ringSnapshot:'.length));
        }
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
