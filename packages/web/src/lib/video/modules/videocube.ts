// packages/web/src/lib/video/modules/videocube.ts
//
// VIDEOCUBE — a VIDEO version of the audio CUBE oscillator.
//
// VIDEOCUBE ingests THREE 60-frame video rings (A/B/C = FLOOR/WALL/CEILING),
// each either GENERATED LIVE from a connected video input OR LOADED from a
// .frametable.png atlas, and combines them the way the audio CUBE combines its
// three wavetables into one output — an OCCUPANCY-WEIGHTED trilinear morph — and
// simultaneously derives an AUDIO drone from the same combine. So every knob
// drives BOTH the picture and the timbre ("isomorphic in all cases").
//
//   video_out : the morphed combine frame (a real video engine surface).
//   audio_out : the audio-CUBE surface-height scan of the 3 rings' luma, played
//               as a mono wavetable oscillator (the MANDELBULB video→audio seam).
//
// THE ISOMORPHISM. The picture combine (COMBINE_FRAG below) is a 1:1 GLSL
// transliteration of the pure CPU mirror in $lib/video/videocube-core (the
// occupancy weights + colour blend), which itself REUSES the audio-CUBE field
// math wholesale (packages/dsp/src/lib/cube-dsp: occ / crushLevels /
// spaceCrushCoord / diffusePull / wrapFold). The AUDIO derivation reduces each
// ring to a luma heightfield and runs the SAME cube-dsp.sampleSlice the audio
// CUBE worklet runs — so MORPH FC / CONNECT / CONNECT STRENGTH / CRUSH / SPACE
// CRUSH / SPACE DIFFUSE / WRAP / MATERIAL / slice Y·ROT all move the picture and
// the sound through one shared field structure.
//
// PERF (the spec's flagged risk). 3 rings ≈ 135 MiB at half-res; the combine is a
// ~24-fetch (SwiftShader) / ~48-fetch (GPU) read at half res — the FrameTable
// budget ×3, within the proven software-renderer envelope. The tap count is
// RENDERER-GATED (T=4 soft / T=8 GPU) — a flat pixel/perf assert that passes on a
// GPU goes red on the CI software renderer (recorderbox/edges class). The audio
// luma readback is GPU-reduced to a 256×60 strip per ring and gated on a recompute
// throttle, never per audio sample.
//
// NOTE (owner / attest): this def lives in the WebGL attest basis
// (resolveWebglBasis sweeps lib/video/). Its real shaders flip computeWebglHash →
// a ONE-TIME re-attest on a trusted GPU is REQUIRED; the co-located docs below are
// wrapped in docs-hash-ignore markers so DOC edits stay hash-transparent. A brand
// new visual — do NOT auto-merge (held for owner visual preview).
//
// Design + research: .myrobots/plans/videocube-2026-07-19.md

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  createRingArray,
  createRingTarget,
  clearRingLayers,
  RING_COPY_FRAG,
} from '$lib/video/frametable-ring';
import {
  fillOnFirstFrame,
  type FrametableFillState,
} from '$lib/video/frametable-core';
import {
  VIDEOCUBE_RING_FRAMES,
  VIDEOCUBE_RENDER_SCALE,
  VIDEOCUBE_TAPS_GPU,
  VIDEOCUBE_TAPS_SOFT,
  VIDEOCUBE_READ_MORPH,
  VIDEOCUBE_READ_SPREAD,
  VIDEOCUBE_MODE_SMOOTH,
  VIDEOCUBE_MODE_MORPH,
  VIDEOCUBE_MODE_CHAOS,
  VIDEOCUBE_FIELD_FRAMES,
  stripToHeightfield,
} from '$lib/video/videocube-core';
// The audio derivation reuses the AUDIO-CUBE field/slice DSP wholesale — imported
// via a RELATIVE path (not the `@patchtogether.live/dsp/src/...` alias) for the
// same reason cube.ts / mandelbulb.ts do: worktrees may not symlink the workspace
// package under node_modules, and the TS path-alias rules don't reliably resolve
// TS source out of node_modules/@patchtogether.live/dsp/src.
import {
  sampleSlice,
  applyFold,
  spreadDepthOffset,
  isSilentWave,
  type SliceParams,
  type Material,
} from '../../../../../dsp/src/lib/cube-dsp';
// The derived audio plays through the SAME mono wavetable oscillator MANDELBULB
// uses (phase-accumulate a posted 256-sample slice at tune/fine/level) — no new
// worklet. Its dist is already built + attested (MANDELBULB ships it).
import mandelbulbOscWorkletUrl from '@patchtogether.live/dsp/dist/mandelbulb-osc.js?url';

const N = VIDEOCUBE_RING_FRAMES; // 60
const LUMA_COLS = 256; // audio heightfield phase resolution (matches CUBE_SLICE_SIZE)
/** Recompute the audio slice at most every this-many video frames (~2.5×/sec at
 *  60 fps) so the drone tracks the evolving video without a per-frame readback. */
const AUDIO_RECOMPUTE_EVERY = 24;

type Slot = 'a' | 'b' | 'c';
const SLOTS: readonly Slot[] = ['a', 'b', 'c'];

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

interface VideocubeParams {
  // ── field / slice (drive BOTH picture + audio) — mirror CUBE's ids ──
  morph_fc: number;
  connect: number;
  connect_strength: number;
  crush: number;
  space_crush: number;
  space_diffuse: number;
  slice_y: number;
  slice_rx: number;
  slice_ry: number;
  slice_rz: number;
  fold: number;   // audio-only wavefolder (no image analog)
  spread: number; // audio slice depth-offset (mono timbre; stereo split = follow-up)
  // ── derived-audio pitch / gain ──
  tune: number;
  fine: number;
  level: number;
  // ── discrete toggles ──
  wrap: number;        // 0 = clamp edges, 1 = mirror-fold
  material: number;    // 0 = SMOOTH soft blend, 1 = HARD one-table-wins mosaic
  screen_on: number;   // 0 = skip the combine render when video_out is unpatched
  reader_mode: number; // 0 = SMOOTH (default), 1 = MORPH, 2 = CHAOS (global, all 3 rings)
  freeze: number;      // 0/1 — hold all live rings (stop capturing)
  live: number;        // 0/1 — force the real-time (no-lag) ring read in any mode
}

const DEFAULTS: VideocubeParams = {
  morph_fc: 0,
  connect: 0,
  connect_strength: 0,
  crush: 0,
  space_crush: 0,
  space_diffuse: 0,
  slice_y: 0.5,
  slice_rx: 0,
  slice_ry: 0,
  slice_rz: 0,
  fold: 0,
  spread: 0,
  tune: 0,
  fine: 0,
  level: 1,
  wrap: 0,
  material: 0,
  screen_on: 1,
  reader_mode: VIDEOCUBE_MODE_SMOOTH,
  freeze: 0,
  live: 0,
};

export const VIDEOCUBE_DEFAULTS: Readonly<VideocubeParams> = DEFAULTS;
const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(DEFAULTS));

// Params that reshape the AUDIO slice (a change ⇒ recompute the derived wave).
// The reader/view controls (reader_mode/freeze/live/screen_on) are NOT here —
// they only affect the PICTURE reader; the audio reduces the raw ring luma and
// tracks the ring content via the periodic recompute.
const AUDIO_PARAMS: ReadonlySet<string> = new Set([
  'morph_fc', 'connect', 'connect_strength', 'crush', 'space_crush',
  'space_diffuse', 'slice_y', 'slice_rx', 'slice_ry', 'slice_rz', 'fold', 'spread',
  // material + wrap ALSO reshape the derived wave (they pass into SliceParams),
  // so a change must mark audio dirty — else the picture updates same-frame while
  // the audio lags to the next throttle tick (breaks the WRAP/MATERIAL isomorphism).
  'material', 'wrap',
]);
// Params pushed straight to the oscillator worklet's AudioParams (pitch + gain).
const OSC_PARAMS: ReadonlySet<string> = new Set(['tune', 'fine', 'level']);

// ----------------------------------------------------------------------
// GLSL — REDUCE (audio luma strip) + COMBINE (the occupancy morph). Both
// transliterate the pure CPU mirror in videocube-core.ts / cube-dsp.ts 1:1.
// ----------------------------------------------------------------------

// Audio REDUCE pass: render a ring's per-frame middle-row luma into a 256×60
// strip (x = phase 0..256, y = chronological frame 0..60), read back once per
// recompute and fed to cube-dsp.sampleSlice via stripToHeightfield.
const REDUCE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;
uniform sampler2DArray uRing;
uniform int uHead;
uniform float uReadRow;
const float N = ${N}.0;
void main(){
  float layerIdx = floor(vUv.y * N);                 // chronological frame index
  float layer = mod(float(uHead) + layerIdx, N);     // → ring layer (head + chrono)
  vec3 c = texture(uRing, vec3(vUv.x, uReadRow, layer)).rgb;
  float lm = clamp(0.299*c.r + 0.587*c.g + 0.114*c.b, 0.0, 1.0);
  outColor = vec4(vec3(lm), 1.0);
}`;

const MAX_TAPS = 8; // combine reader compile-time tap cap (uTaps ≤ this)
const COMBINE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;

uniform sampler2DArray uRingA;
uniform sampler2DArray uRingB;
uniform sampler2DArray uRingC;
uniform int   uHeadA;
uniform int   uHeadB;
uniform int   uHeadC;
uniform int   uMode;          // 0 SMOOTH / 1 MORPH / 2 CHAOS (global reader)
uniform float uLive;          // 1 => real-time read (no lag)
uniform int   uTaps;          // renderer-gated SMOOTH/MORPH tap count
uniform float uHasContent;    // 0 until at least one ring has captured a frame
// SLICE field (per-pixel temporal offset — the video meaning of the slice tilt).
uniform float uSliceY;        // 0..1
uniform float uRx;
uniform float uRy;
uniform float uRz;
uniform float uFieldAmp;      // field displacement amplitude (frames)
// Occupancy combine (cube-dsp isomorph).
uniform float uMorphFC;       // MORPH FC 0..1
uniform float uConnect;       // CONNECT 0..1
uniform float uConnectStr;    // CONNECT STRENGTH 0..1
uniform float uCrush;         // CRUSH 0..1 (posterize)
uniform float uSpaceCrush;    // SPACE CRUSH 0..1 (mosaic)
uniform float uSpaceDiffuse;  // SPACE DIFFUSE 0..1 (warp toward 0)
uniform float uWrap;          // 0 clamp edges / 1 mirror-fold
uniform float uMaterial;      // 0 SMOOTH blend / 1 HARD one-table-wins

const float N = ${N}.0;
const float READ_MORPH  = ${VIDEOCUBE_READ_MORPH.toFixed(1)};
const float READ_SPREAD = ${VIDEOCUBE_READ_SPREAD.toFixed(1)};
const int   MODE_SMOOTH = ${VIDEOCUBE_MODE_SMOOTH};
const int   MODE_MORPH  = ${VIDEOCUBE_MODE_MORPH};
const int   MODE_CHAOS  = ${VIDEOCUBE_MODE_CHAOS};

float lumaOf(vec3 c){ return clamp(0.299*c.r + 0.587*c.g + 0.114*c.b, 0.0, 1.0); }

// Dave-Hoskins hash21 → [0,1) (CHAOS static per-pixel threshold). Mirrors
// frametable-core.hash21 / the FRAMETABLE shader.
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// erf^-1 (Winitzki, a=0.147) — gaussian tap placement (SMOOTH/MORPH average).
float erfinv(float x){
  float a = 0.147;
  float ln = log(max(1e-12, 1.0 - x*x));
  float t1 = 2.0/(3.14159265359*a) + 0.5*ln;
  float t2 = ln/a;
  float s = x < 0.0 ? -1.0 : 1.0;
  return s * sqrt(max(0.0, sqrt(t1*t1 - t2) - t1));
}
int wrapRing(float x){ float m = mod(x, N); if (m < 0.0) m += N; return int(m); }
float selectOffset(float t, float spread, float shp){
  float h = 0.5 * spread;
  if (shp < 0.5) {
    return (t < 0.5) ? h * (sqrt(2.0 * t) - 1.0) : h * (1.0 - sqrt(2.0 * (1.0 - t)));
  }
  float sigma = spread / 6.0;
  float A = 0.00135;
  float p = A + t * (1.0 - 2.0 * A);
  return clamp(sigma * 1.41421356 * erfinv(2.0 * p - 1.0), -h, h);
}
// manual sub-frame inter-layer LINEAR interpolation (sampler2DArray rounds layer).
vec3 sampleRingLerp(sampler2DArray ring, vec2 uv, float lag, float head){
  float layerF = head - lag;
  float l0 = floor(layerF);
  float f  = layerF - l0;
  vec3 c0 = texture(ring, vec3(uv, float(wrapRing(l0))      )).rgb;
  vec3 c1 = texture(ring, vec3(uv, float(wrapRing(l0 + 1.0)))).rgb;
  return mix(c0, c1, f);
}
// One ring's colour: SMOOTH/MORPH = capped weighted temporal average (MORPH
// flattens the per-pixel field), CHAOS = a single static-threshold pick.
vec3 readRing(sampler2DArray ring, vec2 uv, float headF, float field){
  float h = 0.5 * READ_SPREAD;
  bool lagged = (uMode != MODE_CHAOS) && (uLive < 0.5);
  float c = lagged ? (h + READ_MORPH * (N - 2.0*h)) : (READ_MORPH * N);
  if (uMode == MODE_CHAOS){
    vec2 bn = mod(gl_FragCoord.xy, 128.0);
    float t = hash21(floor(bn));
    float d = selectOffset(t, READ_SPREAD, 0.0);
    float lag   = mod(c + d + N, N);
    float layer = mod(headF - lag, N);
    int   k     = wrapRing(layer + 0.5);
    return texture(ring, vec3(uv, float(k))).rgb;
  }
  float lagCentre = c + ((uMode == MODE_MORPH) ? 0.0 : field);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${MAX_TAPS}; i++){
    if (i >= uTaps) break;
    float t = (float(i) + 0.5) / float(uTaps);
    float d = selectOffset(t, READ_SPREAD, 1.0);   // gaussian placement
    acc  += sampleRingLerp(ring, uv, lagCentre + d, headF);
    wsum += 1.0;
  }
  return acc / max(wsum, 1.0);
}
// occ() — EXACT transliteration of cube-dsp.occ (with the CONNECT STRENGTH lift).
float occ(float z, float bottom, float top, float connect, float cs){
  float lo = min(bottom, top);
  float hi = max(bottom, top);
  float zz = clamp(z, 0.0, 1.0);
  if (zz <= lo) return 1.0;
  if (zz >= hi) return 0.0;
  float span = hi - lo;
  if (span <= 1e-9) return zz < hi ? 1.0 : 0.0;
  float t = (zz - lo) / span;
  float c = clamp(connect, 0.0, 1.0);
  float s = clamp(cs, 0.0, 1.0);
  if (s <= 0.0){
    float circle = sqrt(max(0.0, 1.0 - t*t));
    float vee = 1.0 - t;
    return clamp(circle*(1.0-c) + vee*c, 0.0, 1.0);
  }
  float lift = 1.0 + s*2.0;
  float circle = clamp(sqrt(max(0.0, 1.0 - t*t))*lift, 0.0, 1.0);
  float vee = clamp((1.0 - t)*lift, 0.0, 1.0);
  return clamp(circle*(1.0-c) + vee*c, 0.0, 1.0);
}
// SPACE CRUSH voxelize + SPACE DIFFUSE pull-to-0 + WRAP fold — cube-dsp mirror.
float spaceCrushCoord(float coord, float k){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return coord;
  float n = max(2.0, floor(256.0 + (6.0 - 256.0)*kk + 0.5));
  if (n >= 256.0) return coord;
  float cc = clamp(coord, 0.0, 1.0);
  float cell = min(n - 1.0, floor(cc * n));
  return (cell + 0.5) / n;
}
float diffusePull0(float c, float k){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return c;
  return c + (0.0 - c)*(kk*kk);
}
float wrapFold(float coord){
  float m = mod(coord, 2.0);
  return m <= 1.0 ? m : 2.0 - m;
}
vec3 posterize(vec3 col, float k){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return col;
  float levels = max(2.0, floor(256.0 + (2.0 - 256.0)*kk + 0.5));
  if (levels >= 256.0) return col;
  vec3 cc = clamp(col, 0.0, 1.0);
  return floor(cc*(levels-1.0) + 0.5)/(levels-1.0);
}

void main(){
  if (uHasContent < 0.5){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // Per-pixel temporal displacement (SLICE Y / ROT) — 0 at the neutral slice.
  float field = uFieldAmp * ( ((uSliceY - 0.5)*2.0)*(vUv.y - 0.5)
              + sin(uRx)*(vUv.x - 0.5) + sin(uRy)*(vUv.y - 0.5)
              + sin(uRz)*((vUv.x - 0.5)*(vUv.y - 0.5))*2.0 );
  // SPACE CRUSH (mosaic) + SPACE DIFFUSE (warp) on the sampling UV, then WRAP.
  float sx = spaceCrushCoord(vUv.x, uSpaceCrush);
  float sy = spaceCrushCoord(vUv.y, uSpaceCrush);
  sx = diffusePull0(sx, uSpaceDiffuse);
  sy = diffusePull0(sy, uSpaceDiffuse);
  if (uWrap > 0.5){ sx = wrapFold(sx); sy = wrapFold(sy); }
  else { sx = clamp(sx, 0.0, 1.0); sy = clamp(sy, 0.0, 1.0); }
  vec2 suv = vec2(sx, sy);

  vec3 cA = readRing(uRingA, suv, float(uHeadA), field);
  vec3 cB = readRing(uRingB, suv, float(uHeadB), field);
  vec3 cC = readRing(uRingC, suv, float(uHeadC), field);

  // Occupancy combine (cube-dsp isomorph): z = luma of a reference blend (the
  // 3-way average — the connector interior, so CONNECT/CONNECT STRENGTH engage;
  // the wall luma alone would pin z to an endpoint → occ collapses to 0/1).
  float lA = lumaOf(cA), lB = lumaOf(cB), lC = lumaOf(cC);
  float z = (lA + lB + lC)/3.0;
  float m  = clamp(uMorphFC, 0.0, 1.0);
  float cs = clamp(uConnectStr, 0.0, 1.0);
  float wFloor = occ(z, lA, lB, uConnect, cs);
  float wCeil  = occ(z, lC, lB, uConnect, cs);
  float wf = wFloor*(1.0 - m);
  float wc = wCeil*m;
  float wWall = clamp(1.0 - (wFloor + wCeil), 0.0, 1.0);
  vec3 outc;
  if (uMaterial > 0.5){
    if (wWall >= wf && wWall >= wc) outc = cB;
    else if (wf >= wc) outc = cA;
    else outc = cC;
  } else {
    float denom = max(wf + wc + wWall, 1e-3);
    outc = (wf*cA + wc*cC + wWall*cB)/denom;
  }
  outc = posterize(outc, uCrush);
  outColor = vec4(outc, 1.0);
}`;

/**
 * Renderer-gated combine tap count (§4 perf). T=4 (24 array fetches) on the
 * SwiftShader software renderer (CI), T=8 (48 fetches) on a real GPU — a flat
 * perf/pixel assert that passes on a GPU goes red on CI (recorderbox/edges class),
 * so bound the software cost from a renderer probe. Renderer masked/absent ⇒ the
 * GPU count (correct for real users; CI reliably reports SwiftShader).
 */
function detectCombineTaps(gl: WebGL2RenderingContext): number {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
    );
    if (/swiftshader|software|llvmpipe/i.test(renderer)) return VIDEOCUBE_TAPS_SOFT;
  } catch {
    /* extension/param unavailable — fall through to the GPU default */
  }
  return VIDEOCUBE_TAPS_GPU;
}

export const videocubeDef: VideoModuleDef = {
  type: 'videocube',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'videocube',
  category: 'sources',
  // Rack tier is declared in rack-sizes.ts (videocube: 3u/hp4 — the CUBE /
  // HYPERCUBE wide 2-col tier, not the 2u MANDELBULB tier).
  //
  // The 3 rings must keep FILLING even when unobserved: a MORPH scan back through
  // a gap would show a seam, and the audio drone reads the live rings. pullExempt
  // (like FRAMETABLE) keeps all three coherent.
  pullExempt: true,
  inputs: [
    // 3 live video sources (a slot set to FILE ignores its input).
    { id: 'video_a', type: 'video' },
    { id: 'video_b', type: 'video' },
    { id: 'video_c', type: 'video' },
    // Continuous knobs → matching CV inputs (cvScale REQUIRED on type:'cv').
    { id: 'morph_cv',            type: 'cv', paramTarget: 'morph_fc',         cvScale: { mode: 'linear' } },
    { id: 'connect_cv',          type: 'cv', paramTarget: 'connect',          cvScale: { mode: 'linear' } },
    { id: 'connect_strength_cv', type: 'cv', paramTarget: 'connect_strength', cvScale: { mode: 'linear' } },
    { id: 'crush_cv',            type: 'cv', paramTarget: 'crush',            cvScale: { mode: 'linear' } },
    { id: 'space_crush_cv',      type: 'cv', paramTarget: 'space_crush',      cvScale: { mode: 'linear' } },
    { id: 'space_diffuse_cv',    type: 'cv', paramTarget: 'space_diffuse',    cvScale: { mode: 'linear' } },
    { id: 'slice_y_cv',          type: 'cv', paramTarget: 'slice_y',          cvScale: { mode: 'linear' } },
    { id: 'slice_rx_cv',         type: 'cv', paramTarget: 'slice_rx',         cvScale: { mode: 'linear' } },
    { id: 'slice_ry_cv',         type: 'cv', paramTarget: 'slice_ry',         cvScale: { mode: 'linear' } },
    { id: 'slice_rz_cv',         type: 'cv', paramTarget: 'slice_rz',         cvScale: { mode: 'linear' } },
    { id: 'fold_cv',             type: 'cv', paramTarget: 'fold',             cvScale: { mode: 'linear' } },
    { id: 'spread_cv',           type: 'cv', paramTarget: 'spread',           cvScale: { mode: 'linear' } },
    { id: 'tune_cv',             type: 'cv', paramTarget: 'tune',             cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'video_out', type: 'video' }, // primary — the morphed combine frame
    { id: 'audio_out', type: 'audio' }, // derived oscillator (MANDELBULB seam)
  ],
  params: [
    // ── shape/field knobs (drive BOTH picture + audio) — CUBE's KNOBS order ──
    { id: 'tune',             label: 'tune',         defaultValue: DEFAULTS.tune,             min: -36, max: 36,   curve: 'linear', units: 'st' },
    { id: 'fine',             label: 'fine',         defaultValue: DEFAULTS.fine,             min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'morph_fc',         label: 'morph',        defaultValue: DEFAULTS.morph_fc,         min: 0, max: 1,      curve: 'linear' },
    { id: 'connect',          label: 'connect',      defaultValue: DEFAULTS.connect,          min: 0, max: 1,      curve: 'linear' },
    { id: 'connect_strength', label: 'cnct str',     defaultValue: DEFAULTS.connect_strength, min: 0, max: 1,      curve: 'linear' },
    { id: 'crush',            label: 'crush',        defaultValue: DEFAULTS.crush,            min: 0, max: 1,      curve: 'linear' },
    { id: 'space_crush',      label: 'space crush',  defaultValue: DEFAULTS.space_crush,      min: 0, max: 1,      curve: 'linear' },
    { id: 'space_diffuse',    label: 'space diffuse',defaultValue: DEFAULTS.space_diffuse,    min: 0, max: 1,      curve: 'linear' },
    { id: 'fold',             label: 'fold',         defaultValue: DEFAULTS.fold,             min: 0, max: 1,      curve: 'linear' },
    { id: 'spread',           label: 'spread',       defaultValue: DEFAULTS.spread,           min: 0, max: 1,      curve: 'linear' },
    { id: 'slice_y',          label: 'y',            defaultValue: DEFAULTS.slice_y,          min: 0, max: 1,      curve: 'linear' },
    { id: 'slice_rx',         label: 'rot x',        defaultValue: DEFAULTS.slice_rx,         min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'slice_ry',         label: 'rot y',        defaultValue: DEFAULTS.slice_ry,         min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'slice_rz',         label: 'rot z',        defaultValue: DEFAULTS.slice_rz,         min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'level',            label: 'level',        defaultValue: DEFAULTS.level,            min: 0, max: 2,      curve: 'linear' },
    // ── discrete toggles ──
    { id: 'wrap',        label: 'wrap',     defaultValue: DEFAULTS.wrap,        min: 0, max: 1, curve: 'discrete' },
    { id: 'material',    label: 'material', defaultValue: DEFAULTS.material,    min: 0, max: 1, curve: 'discrete' },
    { id: 'screen_on',   label: 'screen',   defaultValue: DEFAULTS.screen_on,   min: 0, max: 1, curve: 'discrete' },
    { id: 'reader_mode', label: 'reader',   defaultValue: DEFAULTS.reader_mode, min: 0, max: 2, curve: 'discrete' },
    { id: 'freeze',      label: 'freeze',   defaultValue: DEFAULTS.freeze,      min: 0, max: 1, curve: 'linear' },
    { id: 'live',        label: 'live',     defaultValue: DEFAULTS.live,        min: 0, max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation:
      "VIDEOCUBE is the VIDEO version of the audio CUBE oscillator. It ingests THREE 60-frame video rings — A (FLOOR), B (WALL / connector) and C (CEILING) — each either GENERATED LIVE from a connected video input (video_a/b/c) or LOADED from a .frametable.png atlas file, and combines them exactly the way audio CUBE combines its three wavetables into one output: an OCCUPANCY-WEIGHTED trilinear morph. For every output pixel it reads a colour from each of the three rings, derives an occupancy position from the WALL ring's luma, and blends the three colours by the SAME occupancy weights the audio CUBE uses (the cube-dsp occ curve) — MORPH cross-fades ring A ↔ ring C through B, CONNECT reshapes how strongly B binds them (rounded ↔ hard ramp), CONNECT STRENGTH swells B's mid-band, CRUSH posterizes the colour depth, SPACE CRUSH mosaics the sampling grid, SPACE DIFFUSE smears the sample coordinates toward the low corner, MATERIAL switches between a soft blend and a HARD one-table-wins mosaic, and WRAP mirror-folds out-of-range coordinates. The result on video_out is a recognizable MORPHED IMAGE of the three sources, not an abstract field. Crucially it ALSO emits AUDIO: the same three rings are reduced to luma heightfields and scanned by the IDENTICAL cube-dsp surface-height slice the audio CUBE plays, so audio_out carries a mono wavetable-oscillator drone whose timbre is driven by the SAME knobs — MORPH, CONNECT, CRUSH, SPACE CRUSH, SPACE DIFFUSE, the slice plane Y and ROT X/Y/Z, WRAP and MATERIAL all move the picture AND the sound through one shared field structure ('isomorphic in all cases'). Pitch is set by TUNE/FINE (and the tune CV), level by LEVEL, and FOLD is a west-coast wavefolder on the derived audio (audio-only — it has no image analog). A global READER selector (SMOOTH default / MORPH / CHAOS) sets how each ring's 60-frame history is read (SMOOTH = a flowing per-pixel temporal average warped by the slice field, MORPH = a spatially-uniform average, CHAOS = a per-pixel single-frame dither), FREEZE holds all live rings so you can scrub a held window, and LIVE forces the real-time (no-lag) read. SPREAD offsets the audio slice read plane's depth (a mono timbre control; a true L/R stereo split is a follow-up). Rendered at half engine resolution (the 3-ring SwiftShader/CI budget), with a renderer-gated tap count; the audio slice is recomputed off the audio thread on a throttle, never per sample. VIDEOCUBE v1 ships MONO-DRONE-first (no poly / ADSR yet — a follow-up). All ports live on the yellow drill-down PATCH PANEL (no raw side jacks). The occupancy combine + colour blend + luma reduction are a 1:1 CPU mirror unit-tested in $lib/video/videocube-core, reusing the audio-CUBE field math (cube-dsp) wholesale. Look-affecting new WebGL shader — held for owner visual preview.",
    inputs: {
      video_a: 'The LIVE source recorded, frame by frame, into ring A (FLOOR — one of the two morph ends). Ignored when slot A is loaded from a file. Unpatched (and no file) leaves ring A black.',
      video_b: 'The LIVE source recorded into ring B (WALL / connector — the table that binds A and C in the blend interior). Ignored when slot B is loaded from a file.',
      video_c: 'The LIVE source recorded into ring C (CEILING — the other morph end). Ignored when slot C is loaded from a file.',
      morph_cv: 'CV that modulates MORPH (the FLOOR↔CEILING cross-fade, ring A ↔ ring C through B), swept linearly over 0..1. Drives both the picture blend and the audio field.',
      connect_cv: 'CV that modulates CONNECT (how the WALL binds A and C — rounded soft cross-mix ↔ hard linear ramp), swept linearly over 0..1.',
      connect_strength_cv: 'CV that modulates CONNECT STRENGTH (over-emphasises B in the mid-band, swelling it through the image / bulging the audio field), swept linearly over 0..1.',
      crush_cv: 'CV that modulates CRUSH (posterize / colour-depth reduction of the frame AND the amplitude crush of the derived audio — the same crush levels), swept linearly over 0..1.',
      space_crush_cv: 'CV that modulates SPACE CRUSH (mosaic / pixelation of the sampling grid, and the identical voxelization of the audio field lookup), swept linearly over 0..1.',
      space_diffuse_cv: 'CV that modulates SPACE DIFFUSE (warps the sampling coordinates toward the low corner — a smear in the picture and the same coord warp in the audio scan), swept linearly over 0..1.',
      slice_y_cv: 'CV that modulates Y (the slice plane height): a vertical temporal-offset gradient across the frame + the audio slice plane height, swept linearly over 0..1.',
      slice_rx_cv: 'CV that modulates ROT X (a directional temporal shear across the frame + the audio slice plane pitch), swept linearly over -pi..pi.',
      slice_ry_cv: 'CV that modulates ROT Y (temporal shear + the audio slice plane yaw), swept linearly over -pi..pi.',
      slice_rz_cv: 'CV that modulates ROT Z (temporal shear + the audio slice plane roll), swept linearly over -pi..pi.',
      fold_cv: 'CV that modulates FOLD (the west-coast wavefolder on the derived audio — audio-only, no image effect), swept linearly over 0..1.',
      spread_cv: 'CV that modulates SPREAD (the audio slice read-plane depth offset — a mono timbre control), swept linearly over 0..1.',
      tune_cv: 'CV that modulates TUNE (the derived oscillator pitch in semitones), swept linearly over -36..36. Affects the audio only, not the picture.',
    },
    outputs: {
      video_out: 'The PRIMARY output: the morphed combine frame — the occupancy-weighted trilinear blend of the three rings (a recognizable morphed image of the sources). The card preview shows this output; rendered at half engine resolution and LINEAR-upscaled.',
      audio_out: "The derived audio: the three rings' luma heightfields scanned by the audio-CUBE surface-height slice and played as a mono wavetable oscillator at TUNE/FINE pitch and LEVEL gain. A continuous drone whose timbre is shaped by every field knob; silent until the audio worklet stands up (a moment after spawn).",
    },
    controls: {
      tune: 'TUNE (-36..36 st, default 0): coarse pitch of the derived audio oscillator in semitones. CV via the tune input. Audio-only.',
      fine: 'FINE (-100..100 cents, default 0): fine pitch trim of the derived audio between the semitone steps of TUNE. Audio-only.',
      morph_fc: 'MORPH (0..1, default 0): cross-fades the FLOOR (ring A) toward the CEILING (ring C) fill of the combine through the WALL (ring B) — 0 biases toward the floor, 1 toward the ceiling. Because the combine reads a single per-pixel occupancy position, the extremes bias the blend rather than strictly isolate one ring (some luma configurations still let the wall show through). Drives both the picture blend and the audio field. CV via the morph input.',
      connect: 'CONNECT (0..1, default 0): reshapes how the WALL (B) binds A and C in the blend interior — 0 = a rounded/soft cross-mix (circle occupancy), 1 = a hard linear ramp toward B (sawtooth-V). Same occ profile drives the image blend weights and the audio. CV via the connect input.',
      connect_strength: "CONNECT STRENGTH (0..1, default 0): over-emphasises B's contribution in the mid-band of the blend (B swells through the image / bulges the audio field). 0 = the exact CONNECT shape. CV via the connect strength input.",
      crush: 'CRUSH (0..1, default 0): posterize / colour-depth reduction of the output frame (RGB quantized) AND the amplitude crush of the derived audio (the same crush levels). 0 = clean. CV via the crush input.',
      space_crush: 'SPACE CRUSH (0..1, default 0): mosaic / pixelation of the output frame — snaps the sampling coordinates to a chunky voxel grid — and the identical voxelization of the audio field lookup. 0 = transparent. CV via the space crush input.',
      space_diffuse: 'SPACE DIFFUSE (0..1, default 0): warps the sampling coordinates toward the low (dark) corner — a smear in the picture and the same coord warp in the audio scan. 0 = off. CV via the space diffuse input.',
      fold: 'FOLD (0..1, default 0): a west-coast wavefolder applied to the derived audio waveform (adds harmonics). Audio-only — it has no image analog. CV via the fold input.',
      spread: 'SPREAD (0..1, default 0): offsets the audio slice read plane along its normal (a mono timbre control that shifts which cross-section is scanned). A true L/R stereo split is a follow-up. CV via the spread input.',
      slice_y: 'Y (0..1, default 0.5): the slice plane height. For the picture it is a vertical temporal-offset gradient across the frame (0.5 = a flat, still read); for the audio it is the height of the slicing plane through the field. CV via the y input.',
      slice_rx: 'ROT X (-pi..pi, default 0): rotates the sampling plane about X — a directional temporal shear across the frame and the audio slice plane pitch. CV via the rot x input.',
      slice_ry: 'ROT Y (-pi..pi, default 0): rotates the sampling plane about Y — temporal shear + the audio slice plane yaw. CV via the rot y input.',
      slice_rz: 'ROT Z (-pi..pi, default 0): rotates the sampling plane about Z — temporal shear + the audio slice plane roll. CV via the rot z input.',
      level: 'LEVEL (0..2, default 1): output gain on the derived audio (applied after FOLD). 1 = unity. Audio-only.',
      wrap: 'WRAP (0/1, default 0): out-of-range sampling coordinates are clamped to the edge (off) or mirror-folded back inside (on) — governs both the image edge behaviour and the audio field.',
      material: 'MATERIAL (0/1, default 0 = SMOOTH): SMOOTH blends the three rings by their occupancy weights (a soft cross-blend); HARD makes one ring win per pixel (a hard-cut mosaic), and the same in the audio field.',
      screen_on: 'SCREEN (0/1, default 1 = on): perf gate for the combine render. When off AND video_out is unpatched the combine render is skipped (the rings keep capturing and the audio drone keeps running).',
      reader_mode: 'READER (0..2, default 0 = SMOOTH): how each ring reads its 60-frame history (global — all three rings). 0 = SMOOTH (a flowing per-pixel temporal average warped by the slice field), 1 = MORPH (a spatially-uniform temporal average), 2 = CHAOS (a per-pixel single-frame dither). Affects the picture only; the audio reads the raw ring luma.',
      freeze: 'FREEZE (0/1, default 0): stops all LIVE rings from advancing so the held windows can be scrubbed with the slice controls. File-loaded rings are always frozen. Picture + (via the ring content) audio.',
      live: 'LIVE (0/1, default 0): forces the real-time / no-lag ring read in any reader mode (the rings track the live input instead of reading a trailing window). Picture only.',
    },
  },
  controlFamilies: [],
  // docs-hash-ignore:end

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    let rw = Math.max(1, Math.round(ctx.res.width * VIDEOCUBE_RENDER_SCALE));
    let rh = Math.max(1, Math.round(ctx.res.height * VIDEOCUBE_RENDER_SCALE));

    // 3 rings + 3 heads + 3 first-fill state machines + per-slot file flag.
    const ringTex: Record<Slot, WebGLTexture> = {
      a: createRingArray(gl, rw, rh, N),
      b: createRingArray(gl, rw, rh, N),
      c: createRingArray(gl, rw, rh, N),
    };
    const head: Record<Slot, number> = { a: 0, b: 0, c: 0 };
    const captured: Record<Slot, boolean> = { a: false, b: false, c: false };
    const fileSlot: Record<Slot, boolean> = { a: false, b: false, c: false };
    const pendingAtlas: Record<Slot, TexImageSource | null> = { a: null, b: null, c: null };

    // One reusable framebuffer, retargeted per ring layer with framebufferTextureLayer.
    let ringFbo = gl.createFramebuffer();
    if (!ringFbo) throw new Error('videocube: createFramebuffer (ring) failed');
    let outTarget = createRingTarget(gl, rw, rh);          // video_out
    let reduceTarget = createRingTarget(gl, LUMA_COLS, N);  // audio luma strip (256×60)
    for (const s of SLOTS) clearRingLayers(gl, ringFbo, ringTex[s], N, rw, rh);

    // 1×1 black sentinel for an unpatched input (never bind a null sampler).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('videocube: createTexture (sentinel) failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const combineTaps = detectCombineTaps(gl);

    // Merge stored params over defaults (strip stray keys).
    const raw = node.params as Record<string, unknown>;
    const params: VideocubeParams = { ...DEFAULTS };
    for (const [k, v] of Object.entries(raw)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') (params as unknown as Record<string, number>)[k] = v;
    }

    // ── Deferred program compile (mandelbulb/mirrorpool CI discipline). ──
    let progs: { copy: WebGLProgram; combine: WebGLProgram; reduce: WebGLProgram } | null = null;
    let glFailed = false;
    let uC: Record<string, WebGLUniformLocation | null> = {};
    let uCopy: Record<string, WebGLUniformLocation | null> = {};
    let uReduce: Record<string, WebGLUniformLocation | null> = {};
    function ensurePrograms(): boolean {
      if (progs) return true;
      if (glFailed) return false;
      try {
        const copy = ctx.compileFragment(RING_COPY_FRAG);
        const combine = ctx.compileFragment(COMBINE_FRAG);
        const reduce = ctx.compileFragment(REDUCE_FRAG);
        progs = { copy, combine, reduce };
        uCopy = {
          tex: gl.getUniformLocation(copy, 'uTex'),
          has: gl.getUniformLocation(copy, 'uHas'),
          tileScale: gl.getUniformLocation(copy, 'uTileScale'),
          tileOffset: gl.getUniformLocation(copy, 'uTileOffset'),
        };
        const cu = (n: string) => gl.getUniformLocation(combine, n);
        uC = {
          ringA: cu('uRingA'), ringB: cu('uRingB'), ringC: cu('uRingC'),
          headA: cu('uHeadA'), headB: cu('uHeadB'), headC: cu('uHeadC'),
          mode: cu('uMode'), live: cu('uLive'), taps: cu('uTaps'), hasContent: cu('uHasContent'),
          sliceY: cu('uSliceY'), rx: cu('uRx'), ry: cu('uRy'), rz: cu('uRz'), fieldAmp: cu('uFieldAmp'),
          morphFC: cu('uMorphFC'), connect: cu('uConnect'), connectStr: cu('uConnectStr'),
          crush: cu('uCrush'), spaceCrush: cu('uSpaceCrush'), spaceDiffuse: cu('uSpaceDiffuse'),
          wrap: cu('uWrap'), material: cu('uMaterial'),
        };
        uReduce = {
          ring: gl.getUniformLocation(reduce, 'uRing'),
          head: gl.getUniformLocation(reduce, 'uHead'),
          readRow: gl.getUniformLocation(reduce, 'uReadRow'),
        };
      } catch { glFailed = true; return false; }
      return true;
    }

    // ── File LOAD: detile a pending atlas into a slot's ring (60 tiles). Uses the
    //    shared COPY/detile shader. head:=0, captured, fileSlot=true (frozen). ──
    let atlasScratch: WebGLTexture | null = null;
    function detilePending(slot: Slot): void {
      const el = pendingAtlas[slot];
      if (!el || !progs || !uCopy) return;
      pendingAtlas[slot] = null;
      if (!atlasScratch) atlasScratch = gl.createTexture();
      if (!atlasScratch) return;
      gl.bindTexture(gl.TEXTURE_2D, atlasScratch);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
      } catch { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); return; }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Fixed 10×6 = 60-tile contact sheet (the FrameTable atlas geometry).
      const COLS = 10, ROWS = 6;
      gl.useProgram(progs.copy);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlasScratch);
      gl.uniform1i(uCopy.tex ?? null, 0);
      gl.uniform1f(uCopy.has ?? null, 1);
      gl.uniform2f(uCopy.tileScale ?? null, 1 / COLS, 1 / ROWS);
      gl.bindFramebuffer(gl.FRAMEBUFFER, ringFbo);
      gl.viewport(0, 0, rw, rh);
      for (let i = 0; i < N; i++) {
        const col = i % COLS, row = Math.floor(i / COLS);
        gl.uniform2f(uCopy.tileOffset ?? null, col / COLS, row / ROWS);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, ringTex[slot], 0, i);
        ctx.drawFullscreenQuad();
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      head[slot] = 0;
      captured[slot] = true;
      fileSlot[slot] = true;
      audioDirty = true;
    }

    // ── Derived AUDIO (MANDELBULB seam) — MONO-DRONE-first, stood up at spawn. ──
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let oscNode: AudioWorkletNode | null = null;
    let oscGain: GainNode | null = null;
    let oscSilence: ConstantSourceNode | null = null;
    let oscLoadStarted = false;
    let sinceRecompute = 0;
    let audioDirty = true;
    let lastWave: Float32Array | null = null;
    let lastSliceSig = '';

    function pushOscParams(): void {
      const ac = ctx.audioCtx;
      if (!oscNode || !ac) return;
      const pmap = oscNode.parameters as unknown as Map<string, AudioParam>;
      pmap.get('tune')?.setValueAtTime(clamp(params.tune, -36, 36), ac.currentTime);
      pmap.get('fine')?.setValueAtTime(clamp(params.fine, -100, 100), ac.currentTime);
      pmap.get('level')?.setValueAtTime(clamp(params.level, 0, 2), ac.currentTime);
    }

    /** GPU-reduce one ring to a 256×60 luma strip, read it back, and build the
     *  Float32Array[60] heightfield cube-dsp scans. Cheap (small target, gated). */
    function reduceRing(slot: Slot): Float32Array[] {
      if (!progs || !uReduce) return [];
      gl.useProgram(progs.reduce);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, ringTex[slot]);
      gl.uniform1i(uReduce.ring ?? null, 0);
      gl.uniform1i(uReduce.head ?? null, head[slot]);
      gl.uniform1f(uReduce.readRow ?? null, 0.5);
      gl.bindFramebuffer(gl.FRAMEBUFFER, reduceTarget.fbo);
      gl.viewport(0, 0, LUMA_COLS, N);
      ctx.drawFullscreenQuad();
      const strip = new Uint8Array(LUMA_COLS * N * 4);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        gl.readPixels(0, 0, LUMA_COLS, N, gl.RGBA, gl.UNSIGNED_BYTE, strip);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return stripToHeightfield(strip, LUMA_COLS, N);
    }

    /** Quantized signature over every param that reshapes the derived wave (the
     *  AUDIO_PARAMS set). Mirrors MANDELBULB's `lastSliceSig` — a param-change
     *  recompute early-returns when the picture-affecting params are unchanged, so
     *  a live CV writing the same value every frame does NOT storm the readback +
     *  slice scan. `force` (the throttle path, for EVOLVING ring content) bypasses
     *  it since the heightfields change even when the params don't. */
    function sliceSig(): string {
      const q = (v: number) => Math.round(v * 1000);
      return [
        q(params.slice_y), q(params.slice_rx), q(params.slice_ry), q(params.slice_rz),
        q(params.morph_fc), q(params.connect), q(params.connect_strength), q(params.crush),
        q(params.space_crush), q(params.space_diffuse), q(params.fold), q(params.spread),
        params.material >= 0.5 ? 1 : 0, params.wrap >= 0.5 ? 1 : 0,
      ].join('|');
    }

    function recomputeSlice(force = false): void {
      if (!oscNode || !progs) return;
      const sig = sliceSig();
      if (!force && sig === lastSliceSig) return; // param-change with nothing new → skip the scan
      lastSliceSig = sig;
      const floorH = reduceRing('a');
      const wallH = reduceRing('b');
      const ceilH = reduceRing('c');
      if (!floorH.length || !wallH.length || !ceilH.length) return;
      const sp: SliceParams = {
        sliceY: clamp(params.slice_y, 0, 1),
        rx: params.slice_rx, ry: params.slice_ry, rz: params.slice_rz,
        morphFC: clamp(params.morph_fc, 0, 1),
        connect: clamp(params.connect, 0, 1),
        connectStrength: clamp(params.connect_strength, 0, 1),
        crush: clamp(params.crush, 0, 1),
        spaceCrush: clamp(params.space_crush, 0, 1),
        spaceDiffuse: clamp(params.space_diffuse, 0, 1),
        material: (params.material >= 0.5 ? 'hard' : 'smooth') as Material,
        wrap: params.wrap >= 0.5,
      };
      const depth = spreadDepthOffset(clamp(params.spread, 0, 1), 1);
      const wave = sampleSlice(floorH, wallH, ceilH, sp, depth);
      applyFold(wave, clamp(params.fold, 0, 1));
      if (!isSilentWave(wave)) lastWave = wave;
      const post = isSilentWave(wave) && lastWave ? lastWave : wave;
      try {
        oscNode.port.postMessage({ type: 'setWave', wave: post });
      } catch { /* structured-clone shims may reject a transfer — ignore */ }
    }

    function ensureAudio(): void {
      const ac = ctx.audioCtx;
      if (!ac || oscLoadStarted) return;
      oscLoadStarted = true;
      // Persistent GainNode published up front (stable identity so a bridge wired
      // before the worklet loads lights up retroactively).
      oscGain = ac.createGain();
      oscGain.gain.value = 1;
      audioSources.set('audio_out', { node: oscGain, output: 0 });
      void (async () => {
        try {
          await ac.audioWorklet.addModule(mandelbulbOscWorkletUrl);
          const n = new AudioWorkletNode(ac, 'mandelbulb-osc', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          });
          oscNode = n;
          if (oscGain) n.connect(oscGain);
          // Keep the worklet's process() alive (Chromium prunes an orphan worklet).
          oscSilence = ac.createConstantSource();
          oscSilence.offset.value = 0;
          oscSilence.start();
          oscSilence.connect(n, 0, 0);
          if ('destination' in ac && ac.destination) {
            const keep = ac.createGain();
            keep.gain.value = 0;
            n.connect(keep);
            keep.connect(ac.destination);
          }
          pushOscParams();
          audioDirty = true;
          recomputeSlice();
          ctx.notifyAudioSourcesChanged?.(node.id);
        } catch {
          // Worklet load failed (CSP / missing dist) — audio_out stays silent.
        }
      })();
    }
    ensureAudio(); // MONO-DRONE-first

    const surface: VideoNodeSurface = {
      fbo: outTarget.fbo,
      texture: outTarget.texture,
      draw(frame) {
        if (!ensurePrograms() || !progs) return;
        const g = frame.gl;

        for (const s of SLOTS) if (pendingAtlas[s]) detilePending(s);

        const frozen = params.freeze >= 0.5;
        const live = params.live >= 0.5;
        const mode = Math.round(clamp(params.reader_mode, 0, 2));
        const screenOn = params.screen_on >= 0.5;
        const outConnected = frame.isOutputConnected ? frame.isOutputConnected(node.id) : true;
        const anyContent = captured.a || captured.b || captured.c;

        // ── COMBINE render → outTarget (perf-gated on screen/patch). ──
        if (screenOn || outConnected) {
          g.bindFramebuffer(g.FRAMEBUFFER, outTarget.fbo);
          g.viewport(0, 0, rw, rh);
          g.useProgram(progs.combine);
          // newest fully-written layer = (head-1) mod N (avoid same-frame RAW hazard).
          g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex.a); g.uniform1i(uC.ringA ?? null, 0);
          g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex.b); g.uniform1i(uC.ringB ?? null, 1);
          g.activeTexture(g.TEXTURE2); g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex.c); g.uniform1i(uC.ringC ?? null, 2);
          g.uniform1i(uC.headA ?? null, (head.a - 1 + N) % N);
          g.uniform1i(uC.headB ?? null, (head.b - 1 + N) % N);
          g.uniform1i(uC.headC ?? null, (head.c - 1 + N) % N);
          g.uniform1i(uC.mode ?? null, mode);
          g.uniform1f(uC.live ?? null, live ? 1 : 0);
          g.uniform1i(uC.taps ?? null, combineTaps);
          g.uniform1f(uC.hasContent ?? null, anyContent ? 1 : 0);
          g.uniform1f(uC.sliceY ?? null, clamp(params.slice_y, 0, 1));
          g.uniform1f(uC.rx ?? null, params.slice_rx);
          g.uniform1f(uC.ry ?? null, params.slice_ry);
          g.uniform1f(uC.rz ?? null, params.slice_rz);
          g.uniform1f(uC.fieldAmp ?? null, VIDEOCUBE_FIELD_FRAMES);
          g.uniform1f(uC.morphFC ?? null, clamp(params.morph_fc, 0, 1));
          g.uniform1f(uC.connect ?? null, clamp(params.connect, 0, 1));
          g.uniform1f(uC.connectStr ?? null, clamp(params.connect_strength, 0, 1));
          g.uniform1f(uC.crush ?? null, clamp(params.crush, 0, 1));
          g.uniform1f(uC.spaceCrush ?? null, clamp(params.space_crush, 0, 1));
          g.uniform1f(uC.spaceDiffuse ?? null, clamp(params.space_diffuse, 0, 1));
          g.uniform1f(uC.wrap ?? null, params.wrap >= 0.5 ? 1 : 0);
          g.uniform1f(uC.material ?? null, params.material >= 0.5 ? 1 : 0);
          ctx.drawFullscreenQuad();
          g.bindFramebuffer(g.FRAMEBUFFER, null);
        }

        // ── CAPTURE each LIVE slot's input → its ring (unless frozen / file). ──
        // ringsAdvanced = did any live slot with real content advance this frame?
        // It gates the audio throttle so the recompute is idle when nothing evolves
        // (all frozen / file / unpatched) yet still refreshes for a live source.
        let ringsAdvanced = false;
        if (!frozen) {
          for (const s of SLOTS) {
            if (fileSlot[s]) continue;
            const inputTex = frame.getInputTexture(node.id, `video_${s}`);
            const first = fillOnFirstFrame(
              { head: head[s], capturedAny: captured[s], framesElapsed: 0 },
              inputTex != null,
            );
            g.useProgram(progs.copy);
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, inputTex ?? emptyTex);
            g.uniform1i(uCopy.tex ?? null, 0);
            g.uniform1f(uCopy.has ?? null, inputTex ? 1 : 0);
            g.uniform2f(uCopy.tileScale ?? null, 1, 1);
            g.uniform2f(uCopy.tileOffset ?? null, 0, 0);
            g.bindFramebuffer(g.FRAMEBUFFER, ringFbo);
            g.viewport(0, 0, rw, rh);
            if (first.filled) {
              for (let i = 0; i < N; i++) {
                g.framebufferTextureLayer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, ringTex[s], 0, i);
                ctx.drawFullscreenQuad();
              }
            } else {
              g.framebufferTextureLayer(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, ringTex[s], 0, head[s]);
              ctx.drawFullscreenQuad();
            }
            if (inputTex) captured[s] = true;
            head[s] = (head[s] + 1) % N;
            if (captured[s]) ringsAdvanced = true; // a live slot with content evolved
          }
          g.bindFramebuffer(g.FRAMEBUFFER, null);
        }

        // ── Derived AUDIO recompute (MANDELBULB seam) ──
        //   • PARAM change (audioDirty, value-gated in setParam): recompute, but
        //     signature-gated inside recomputeSlice so a same-value CV write is a
        //     no-op (B1: no per-frame readback+scan storm under a live CV).
        //   • EVOLVING ring content: force a recompute on the throttle cadence,
        //     but ONLY while a live ring is actually advancing — idle otherwise.
        if (oscNode) {
          if (audioDirty) {
            audioDirty = false;
            sinceRecompute = 0;
            recomputeSlice(false);
          } else if (ringsAdvanced && ++sinceRecompute >= AUDIO_RECOMPUTE_EVERY) {
            sinceRecompute = 0;
            recomputeSlice(true);
          }
        }
      },
      resize(w, h) {
        for (const s of SLOTS) gl.deleteTexture(ringTex[s]);
        gl.deleteFramebuffer(outTarget.fbo); gl.deleteTexture(outTarget.texture);
        gl.deleteFramebuffer(reduceTarget.fbo); gl.deleteTexture(reduceTarget.texture);
        rw = Math.max(1, Math.round(w * VIDEOCUBE_RENDER_SCALE));
        rh = Math.max(1, Math.round(h * VIDEOCUBE_RENDER_SCALE));
        for (const s of SLOTS) { ringTex[s] = createRingArray(gl, rw, rh, N); head[s] = 0; captured[s] = false; fileSlot[s] = false; }
        outTarget = createRingTarget(gl, rw, rh);
        reduceTarget = createRingTarget(gl, LUMA_COLS, N);
        for (const s of SLOTS) clearRingLayers(gl, ringFbo, ringTex[s], N, rw, rh);
        surface.fbo = outTarget.fbo;
        surface.texture = outTarget.texture;
        audioDirty = true;
      },
      dispose() {
        for (const s of SLOTS) gl.deleteTexture(ringTex[s]);
        gl.deleteFramebuffer(ringFbo);
        gl.deleteFramebuffer(outTarget.fbo); gl.deleteTexture(outTarget.texture);
        gl.deleteFramebuffer(reduceTarget.fbo); gl.deleteTexture(reduceTarget.texture);
        gl.deleteTexture(emptyTex);
        if (atlasScratch) { gl.deleteTexture(atlasScratch); atlasScratch = null; }
        if (progs) { gl.deleteProgram(progs.copy); gl.deleteProgram(progs.combine); gl.deleteProgram(progs.reduce); }
      },
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (!(paramId in params)) return;
        const prev = (params as unknown as Record<string, number>)[paramId];
        (params as unknown as Record<string, number>)[paramId] = value;
        if (OSC_PARAMS.has(paramId)) pushOscParams();
        // Gate on an ACTUAL value change: the CV bridge calls setParam every frame
        // for any patched CV (even a constant), so an unconditional dirty flag would
        // storm the readback + slice scan every frame under a live CV.
        if (AUDIO_PARAMS.has(paramId) && value !== prev) audioDirty = true;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      // File LOAD / slot-source channel (reused from the CAMERA/VIDEOBOX external-
      // source plumbing so engine.ts stays UNTOUCHED). The card tags the element
      // with dataset.videocubeSlot ('a'|'b'|'c'); dataset.videocubeClear resets a
      // slot back to LIVE capture.
      attachExternalSource(kind, el) {
        if (kind !== 'image' || !el) return;
        const ds = (el as HTMLElement).dataset ?? {};
        const slot = (ds.videocubeSlot as Slot) ?? 'a';
        if (!SLOTS.includes(slot)) return;
        if (ds.videocubeClear === '1') { fileSlot[slot] = false; return; }
        pendingAtlas[slot] = el as unknown as TexImageSource;
      },
      read(key) {
        if (key === 'outputTexture:video_out' || key === 'fboTexture') return surface.texture;
        if (key === 'fileSlots') return { ...fileSlot };
        if (key === 'audioReady') return oscNode != null;
        if (key === 'lastWave') return lastWave;
        return undefined;
      },
      dispose() {
        surface.dispose();
        if (oscSilence) { try { oscSilence.stop(); } catch { /* */ } try { oscSilence.disconnect(); } catch { /* */ } }
        if (oscNode) { try { oscNode.disconnect(); } catch { /* */ } }
        if (oscGain) { try { oscGain.disconnect(); } catch { /* */ } }
        oscSilence = null; oscNode = null; oscGain = null;
      },
    };
  },
};
