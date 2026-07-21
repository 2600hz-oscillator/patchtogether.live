// packages/web/src/lib/video/modules/videocube.ts
//
// VIDEOCUBE — a VIDEO version of the audio CUBE oscillator, REBUILT as a GENUINE
// volumetric 3D render (the flat-blend v1 was owner-rejected).
//
// VIDEOCUBE ingests THREE 60-frame video rings (A/B/C = FLOOR/WALL/CEILING), each
// either GENERATED LIVE from a connected video input OR LOADED from a
// .frametable.png atlas. The reader selects ONE frame from each ring per output
// frame → three video-luma SURFACES S_A/S_B/S_C(x,y). Those three surfaces are
// STACKED into a GENUINE 3D scalar field over (x,y,z) ∈ [0,1]³ — the SAME field
// the audio CUBE builds from three wavetables:
//
//     F(x,y,z) = cube-dsp.fieldFromHeights(z; S_A, S_B, S_C, morph, connect, …)
//
// where `z` is a REAL connecting depth axis: occ() fills solid density BETWEEN
// the three video surfaces, so the videos CONNECT THROUGH SPACE exactly as three
// wavetables do in audio CUBE. (v1's bug: it collapsed z = (lumaA+lumaB+lumaC)/3
// at ONE point per pixel → occ() evaluated once → a flat 2D blend. Deleted.)
//
//   video_out : a VOLUMETRIC RAY-MARCH of that solid, textured by the 3 videos,
//               under an orbitable camera (view_zoom / view_rot_x/y/z) — you look
//               THROUGH the three videos joined across depth. Plus the CUTTING
//               SLICE PLANE (the exact plane the audio reads) + a 12-edge
//               wireframe for orientation.
//   audio_out : the audio-CUBE surface-height SCAN of the SAME field along the
//               SAME slice plane (cube-dsp.sampleSlice), played as a mono
//               wavetable oscillator (the MANDELBULB video→audio seam).
//
// THE ISOMORPHISM. The picture ray-march (COMBINE_FRAG) is a 1:1 GLSL
// transliteration of the pure CPU mirror in $lib/video/videocube-core (voxelSample
// + warpCoord + the field), which itself REUSES the audio-CUBE field math
// wholesale (packages/dsp/src/lib/cube-dsp: occ / fieldFromHeights / crushCoord /
// spaceCrushCoord / diffusePull / wrapFold / lowestInfoFace / rotate). The AUDIO
// derivation reduces each ring's SELECTED FRAME to a rows×256 luma heightfield and
// runs the SAME cube-dsp.sampleSlice the audio CUBE worklet runs — so MORPH FC /
// CONNECT / CONNECT STRENGTH / CRUSH / SPACE CRUSH / SPACE DIFFUSE / WRAP /
// MATERIAL / slice Y·ROT all move the picture and the sound through ONE shared 3D
// field (the tightest "works like Cube" isomorphism the owner locked).
//
// PERF (the spec's flagged risk). 3 rings ≈135 MiB at half-res (the memory
// ceiling — no 4th full-res buffer added). The ray-march runs at QUARTER res into
// a tiny intermediate target, then LINEAR-upscales to the half-res video_out, and
// its STEP COUNT is RENDERER-GATED (32 soft / 64 GPU) — a flat step count that is
// affordable on a real GPU is far too slow on the CI SwiftShader renderer
// (recorderbox/edges class). The audio luma readback is GPU-reduced to a 256×64
// strip per ring and gated on a recompute throttle, never per audio sample.
//
// NOTE (owner / attest): this def lives in the WebGL attest basis
// (resolveWebglBasis sweeps lib/video/). Its real shaders + params flip
// computeWebglHash → a ONE-TIME re-attest on a trusted GPU is REQUIRED; the
// co-located docs below are wrapped in docs-hash-ignore markers so DOC edits stay
// hash-transparent. A brand new visual — do NOT auto-merge (held for owner
// visual preview).
//
// Redesign spec: .myrobots/plans/videocube-redesign-2026-07-20.md

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
} from '$lib/video/frametable-core';
import {
  VIDEOCUBE_RING_FRAMES,
  VIDEOCUBE_RENDER_SCALE,
  VIDEOCUBE_MARCH_SCALE,
  VIDEOCUBE_MARCH_SOFT,
  VIDEOCUBE_MARCH_GPU,
  VIDEOCUBE_MARCH_MAX,
  VIDEOCUBE_SMOOTH_TAPS_SOFT,
  VIDEOCUBE_SMOOTH_TAPS_GPU,
  VIDEOCUBE_SMOOTH_TAPS_MAX,
  VIDEOCUBE_ABSORB,
  VIDEOCUBE_READER_LAG,
  VIDEOCUBE_FIELD_ROWS,
  VIDEOCUBE_MODE_SMOOTH,
  VIDEOCUBE_MODE_MORPH,
  VIDEOCUBE_MODE_CHAOS,
  VIDEOCUBE_WRAP_TILES,
  VIDEOCUBE_DIFFUSE_DEFAULT,
  diffuseTargetFor,
  readerCentreLayer,
  stripToHeightfieldInto,
  type DiffuseTarget,
} from '$lib/video/videocube-core';
// The audio derivation reuses the AUDIO-CUBE field/slice DSP wholesale — imported
// via a RELATIVE path (not the `@patchtogether.live/dsp/src/...` alias) for the
// same reason cube.ts / mandelbulb.ts do: worktrees may not symlink the workspace
// package under node_modules, and the TS path-alias rules don't reliably resolve
// TS source out of node_modules/@patchtogether.live/dsp/src.
import {
  sampleSlice,
  applyFold,
  isSilentWave,
  rotate,
  type SliceParams,
  type Material,
} from '../../../../../dsp/src/lib/cube-dsp';
// The derived audio plays through the SAME mono wavetable oscillator MANDELBULB
// uses (phase-accumulate a posted 256-sample slice at tune/fine/level) — no new
// worklet. Its dist is already built + attested (MANDELBULB ships it).
import mandelbulbOscWorkletUrl from '@patchtogether.live/dsp/dist/mandelbulb-osc.js?url';

const N = VIDEOCUBE_RING_FRAMES; // 60
const LUMA_COLS = 256; // audio heightfield phase resolution (matches CUBE_SLICE_SIZE)
const FIELD_ROWS = VIDEOCUBE_FIELD_ROWS; // 64 (audio field image-row resolution)
/** Recompute the audio slice at most every this-many video frames (~2.5×/sec at
 *  60 fps) so the drone tracks the evolving video without a per-frame readback.
 *  This is the SINGLE throttle for BOTH evolving ring content AND a modulating CV
 *  (B2 — a live CV must not force a synchronous readback + alloc every frame). */
export const AUDIO_RECOMPUTE_EVERY = 24;
/** Camera field-of-view (radians), matching CubeCard's viz so the two cube views
 *  frame the volume identically. */
const CAM_FOV = 1.0;

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
  spread: number; // FrameTable-style TEMPORAL WINDOW width (0=single frame; opens → oozes)
  scan: number;   // FrameTable MORPH: scans the reading CENTRE through the ring (0=today's centre; wraps)
  // ── derived-audio pitch / gain ──
  tune: number;
  fine: number;
  level: number;
  // ── orbit CAMERA (picture only — shapes the volumetric OUTPUT) ──
  view_zoom: number;
  view_rot_x: number;
  view_rot_y: number;
  view_rot_z: number;
  // ── discrete toggles ──
  wrap: number;        // 0 = clamp edges, 1 = mirror-fold
  material: number;    // 0 = SMOOTH translucent, 1 = HARD binary/one-surface-wins
  screen_on: number;   // 0 = skip the ray-march when video_out is unpatched
  reader_mode: number; // 0 = SMOOTH (default), 1 = MORPH, 2 = CHAOS (global, all 3 rings)
  freeze: number;      // 0/1 — hold all live rings (stop capturing)
  live: number;        // 0/1 — force the real-time (no-lag) ring read in any mode
  slice_view: number;  // slice-viz FLAVOUR: 0 = TEXTURED, 1 = XRAY, 2 = WEIGHTS (viz ports only)
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
  scan: 0,
  tune: 0,
  fine: 0,
  level: 1,
  view_zoom: 1,
  view_rot_x: 0.6,
  view_rot_y: 0.7,
  view_rot_z: 0,
  wrap: 0,
  material: 0,
  screen_on: 1,
  reader_mode: VIDEOCUBE_MODE_SMOOTH,
  freeze: 0,
  live: 0,
  slice_view: 0, // TEXTURED (occupancy-weighted source RGB)
};

// slice_view flavours (the shared colorize mode for slice_out + the triptych).
const SLICE_VIEW_TEXTURED = 0; // occupancy-weighted source RGB (the videos on the plane)
const SLICE_VIEW_XRAY = 1;     // grayscale occupancy density
const SLICE_VIEW_WEIGHTS = 2;  // false-colour R=floor / G=ceil / B=wall occ weights

// Renderer-gated DEPTH heightmap march (depth_out): a per-pixel z-march of the
// solid along the slice normal (the 2-D extension of the audio's 1-D surface-
// height scan). Bounded far below the combine's step count (the picture is a
// secondary readout) and renderer-gated like the combine — a flat count that is
// fine on a GPU is far too slow on SwiftShader (recorderbox/edges class).
const DEPTH_MARCH_SOFT = 20;
const DEPTH_MARCH_GPU = 40;
const DEPTH_MARCH_MAX = DEPTH_MARCH_GPU; // compile-time loop cap (uDepthMarch ≤ this)

export const VIDEOCUBE_DEFAULTS: Readonly<VideocubeParams> = DEFAULTS;
const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(DEFAULTS));

// Params that reshape the AUDIO slice (a change ⇒ recompute the derived wave).
// The VIEW/CAMERA controls are NOT here — they only reproject the PICTURE.
const AUDIO_PARAMS: ReadonlySet<string> = new Set([
  'morph_fc', 'connect', 'connect_strength', 'crush', 'space_crush',
  'space_diffuse', 'slice_y', 'slice_rx', 'slice_ry', 'slice_rz', 'fold', 'spread',
  // scan MOVES the reader centre through the ring (the SAME frame the audio
  // reduces, via the shared readerCentreLayer) → a change re-derives the wave
  // from a different frame, so it reshapes the audio too.
  'scan',
  // material + wrap ALSO reshape the derived wave (they pass into SliceParams),
  // so a change must mark audio dirty — else the picture updates same-frame while
  // the audio lags to the next throttle tick (breaks the WRAP/MATERIAL isomorphism).
  'material', 'wrap',
  // reader_mode + live pick WHICH temporal ring frame the audio reduces (via the
  // shared readerLagFor — the SAME frame the picture surfaces, B3), so a change
  // re-derives the wave from a different frame → they reshape the audio too.
  'reader_mode', 'live',
]);
// Params pushed straight to the oscillator worklet's AudioParams (pitch + gain).
const OSC_PARAMS: ReadonlySet<string> = new Set(['tune', 'fine', 'level']);

// ----------------------------------------------------------------------
// GLSL — REDUCE (audio luma strip) + COMBINE (the volumetric ray-march). Both
// transliterate the pure CPU mirror in videocube-core.ts / cube-dsp.ts 1:1.
// ----------------------------------------------------------------------

// Audio REDUCE pass: render ONE reader-selected ring frame's image into a
// 256×FIELD_ROWS luma strip (x = image-x/phase, y = image-row), read back once
// per recompute and fed to cube-dsp.sampleSlice via stripToHeightfield. This is
// the SPATIAL frame the ray-march also reads → the audio slices the SAME field.
const REDUCE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;
uniform sampler2DArray uRing;
uniform float uLayer;      // reader-selected CENTRE layer (window centre, SCAN-shifted on the CPU)
uniform float uSpread;     // SPREAD 0..1 → temporal window half-width (frames)
uniform int   uWindowTaps; // renderer-gated Hann tap count (≤1 ⇒ single frame)
const float N = ${N}.0;
const int WINDOW_TAPS_MAX = ${VIDEOCUBE_SMOOTH_TAPS_MAX};
float wrapLayer(float x){ float m = mod(x, N); if (m < 0.0) m += N; return m; }
vec3 sampleLayer(vec2 uv, float layer){
  float l0 = floor(layer);
  float f = layer - l0;
  vec3 c0 = texture(uRing, vec3(uv, wrapLayer(l0))).rgb;
  vec3 c1 = texture(uRing, vec3(uv, wrapLayer(l0 + 1.0))).rgb;
  return mix(c0, c1, f);
}
void main(){
  // SPREAD = FrameTable-style temporal window: Hann-average the ring across a
  // ±h window centred on the reader frame, so the reduced heightfield (and thus
  // audio_out) OOZES through time exactly as the picture does. SPREAD=0 ⇒ the
  // exact single-frame read (byte-identical to the pre-window reduce).
  float h = 0.5 * clamp(uSpread, 0.0, 1.0) * (N - 1.0);
  vec3 c;
  if (uWindowTaps <= 1 || h < 1e-3){
    c = texture(uRing, vec3(vUv.x, vUv.y, uLayer)).rgb;
  } else {
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int k = 0; k < WINDOW_TAPS_MAX; k++){
      if (k >= uWindowTaps) break;
      float off = -h + 2.0*h*(float(k) + 0.5)/float(uWindowTaps);
      float w = 0.5*(1.0 + cos(3.14159265358979 * off / h));
      acc += w * sampleLayer(vUv, uLayer + off);
      wsum += w;
    }
    c = acc / max(wsum, 1e-6);
  }
  float lm = clamp(0.299*c.r + 0.587*c.g + 0.114*c.b, 0.0, 1.0);
  outColor = vec4(vec3(lm), 1.0);
}`;

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
uniform float uLive;          // 1 => newest frame (no trailing lag)
uniform float uReaderLag;     // SMOOTH trailing-frame lag (frames)
uniform float uHasContent;    // 0 until at least one ring has captured a frame
uniform int   uMarch;         // renderer-gated ray-march step count
uniform float uSpread;        // SPREAD 0..1 → temporal window half-width (frames)
uniform int   uWindowTaps;    // renderer-gated Hann tap count (≤1 ⇒ single frame)
uniform float uScan;          // SCAN 0..1 → reader-centre offset scan*(N-1) frames (wraps)

// Orbit camera (centered on the cube centre = origin).
uniform vec3  uEye;
uniform vec3  uRight;
uniform vec3  uUp;
uniform vec3  uFwd;
uniform float uTanHalf;
uniform float uAspect;

// Field (cube-dsp isomorph).
uniform float uMorphFC;       // MORPH FC 0..1
uniform float uConnect;       // CONNECT 0..1
uniform float uConnectStr;    // CONNECT STRENGTH 0..1
uniform float uCrush;         // CRUSH 0..1 (posterize colour + amplitude-crush density)
uniform float uSpaceCrush;    // SPACE CRUSH 0..1 (voxelize the field lookup)
uniform float uSpaceDiffuse;  // SPACE DIFFUSE 0..1 (pull toward the low-info face)
uniform int   uDiffuseAxis;   // lowestInfoFace axis (0=x 1=y 2=z)
uniform float uDiffuseDir;    // lowestInfoFace dir (-1 / +1)
uniform float uWrap;          // 0 clamp edges / 1 mirror-fold
uniform float uMaterial;      // 0 SMOOTH translucent / 1 HARD binary

// Cutting slice plane (centered coords) — the exact plane the audio reads.
uniform vec3 uSliceCenter;
uniform vec3 uSliceN;
uniform vec3 uSliceA;
uniform vec3 uSliceB;

// 12-edge wireframe: the 8 cube corners projected to screen-UV + a validity flag.
uniform vec2  uCorners[8];
uniform float uCornerOK[8];

const float N = ${N}.0;
const int   MODE_MORPH = ${VIDEOCUBE_MODE_MORPH};
const int   MODE_CHAOS = ${VIDEOCUBE_MODE_CHAOS};
const int   WINDOW_TAPS_MAX = ${VIDEOCUBE_SMOOTH_TAPS_MAX};
const float ABSORB = ${VIDEOCUBE_ABSORB.toFixed(2)};
const float WIRE_W = 0.012;   // wireframe line half-width (aspect-corrected UV)
const float WRAP_TILES = ${VIDEOCUBE_WRAP_TILES.toFixed(1)}; // WRAP surface mirror-tiling

float lumaOf(vec3 c){ return clamp(0.299*c.r + 0.587*c.g + 0.114*c.b, 0.0, 1.0); }

// Dave-Hoskins hash21 → [0,1) (CHAOS static per-pixel frame pick).
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ── cube-dsp transliterations (occ / crush / spaceCrush / diffuse / wrap) ──
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
float spaceCrushCoord(float coord, float k){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return coord;
  float n = max(2.0, floor(256.0 + (6.0 - 256.0)*kk + 0.5));
  if (n >= 256.0) return coord;
  float cc = clamp(coord, 0.0, 1.0);
  float cell = min(n - 1.0, floor(cc * n));
  return (cell + 0.5) / n;
}
float crushCoord(float coord, float k){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return coord;
  float n = max(1.0, floor(256.0 + (4.0 - 256.0)*kk + 0.5));
  if (n >= 256.0) return coord;
  float cc = clamp(coord, 0.0, 1.0);
  float cell = min(n - 1.0, floor(cc * n));
  return (cell + 0.5) / n;
}
float crushAmp(float v, float k){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return v;
  float levels = max(2.0, floor(256.0 + (2.0 - 256.0)*kk + 0.5));
  if (levels >= 256.0) return v;
  float vv = clamp(v, 0.0, 1.0);
  return floor(vv*(levels-1.0) + 0.5)/(levels-1.0);
}
float diffusePull(float c, float k, float dir){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return c;
  float target = dir > 0.0 ? 1.0 : 0.0;
  return c + (target - c)*(kk*kk);
}
float wrapFold(float coord){
  float m = mod(coord, 2.0);
  if (m < 0.0) m += 2.0;
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

// cube-dsp.fieldFromHeights: solid density at depth z between the 3 surfaces.
float fieldDensity(float z, float fh, float wh, float ch, float m, float connect, float cs, float hard){
  float dF = occ(z, fh, wh, connect, cs);
  float dC = occ(z, ch, wh, connect, cs);
  float f3 = (1.0 - m)*dF + m*dC;
  if (hard > 0.5) return f3 >= 0.5 ? 1.0 : 0.0;
  return clamp(f3, 0.0, 1.0);
}

float wrapLayer(float x){ float m = mod(x, N); if (m < 0.0) m += N; return m; }
// One SURFACE colour at (uv) from a ring, sub-frame lerped between adjacent layers.
vec3 surfAt(sampler2DArray ring, vec2 uv, float baseLayer){
  float l0 = floor(baseLayer);
  float f = baseLayer - l0;
  vec3 c0 = texture(ring, vec3(uv, wrapLayer(l0))).rgb;
  vec3 c1 = texture(ring, vec3(uv, wrapLayer(l0 + 1.0))).rgb;
  return mix(c0, c1, f);
}

// SPREAD temporal window: Hann-average the ring across a +/-h window centred on
// the reader frame (h = 0.5*spread*(N-1)), so a widening SPREAD OOZES a frozen
// ring through time (FrameTable's SMOOTH). taps <= 1, CHAOS (per-pixel 1 frame),
// or a near-zero window collapse to the single-frame surfAt → SPREAD=0 is
// byte-identical. CPU mirror: videocube-core.temporalWindow.
vec3 surfWindow(sampler2DArray ring, vec2 uv, float center, float spreadNorm, int taps, int mode){
  float h = 0.5 * clamp(spreadNorm, 0.0, 1.0) * (N - 1.0);
  if (taps <= 1 || mode == MODE_CHAOS || h < 1e-3){
    return surfAt(ring, uv, center);
  }
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int k = 0; k < WINDOW_TAPS_MAX; k++){
    if (k >= taps) break;
    float off = -h + 2.0*h*(float(k) + 0.5)/float(taps);
    float w = 0.5*(1.0 + cos(3.14159265358979 * off / h));
    acc += w * surfAt(ring, uv, center + off);
    wsum += w;
  }
  return acc / max(wsum, 1e-6);
}

// distance from p to segment a→b in aspect-corrected UV (for the wireframe).
float segDist(vec2 p, vec2 a, vec2 b){
  vec2 pa = (p - a) * vec2(uAspect, 1.0);
  vec2 ba = (b - a) * vec2(uAspect, 1.0);
  float tt = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba*tt);
}

void main(){
  if (uHasContent < 0.5){ outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Camera ray for this output pixel.
  float px = (vUv.x - 0.5) * 2.0 * uAspect * uTanHalf;
  float py = (vUv.y - 0.5) * 2.0 * uTanHalf;
  vec3 rd = normalize(uFwd + px*uRight + py*uUp);
  vec3 ro = uEye;

  // Reader frame per ring (constant across the march).
  float lag = (uLive > 0.5) ? 0.0 : uReaderLag;
  if (uMode == MODE_CHAOS){
    vec2 bn = mod(gl_FragCoord.xy, 128.0);
    lag = hash21(floor(bn)) * (N - 1.0);
  } else if (uMode == MODE_MORPH){
    lag = 0.0; // crisp newest frame
  }
  // SCAN moves the reading CENTRE through the ring (FrameTable's MORPH): shift the
  // per-mode lag a further scan*(N-1) frames back (wraps via surfWindow/wrapLayer).
  // For CHAOS this shifts the per-pixel dither base; scan=0 leaves lag untouched
  // → byte-identical to the pre-scan read.
  lag += uScan * (N - 1.0);
  float layerA = float(uHeadA) - lag;
  float layerB = float(uHeadB) - lag;
  float layerC = float(uHeadC) - lag;

  // Intersect the camera ray with the unit cube [-0.5, 0.5]^3.
  vec3 inv = 1.0 / rd;
  vec3 ta = (vec3(-0.5) - ro) * inv;
  vec3 tb = (vec3( 0.5) - ro) * inv;
  vec3 tmn = min(ta, tb);
  vec3 tmx = max(ta, tb);
  float tn = max(max(tmn.x, tmn.y), tmn.z);
  float tf = min(min(tmx.x, tmx.y), tmx.z);
  tn = max(tn, 0.0);

  float m  = clamp(uMorphFC, 0.0, 1.0);
  float cs = clamp(uConnectStr, 0.0, 1.0);

  vec3 accum = vec3(0.0);
  float alpha = 0.0;

  if (tf > tn){
    float dt = (tf - tn) / float(uMarch);
    for (int i = 0; i < ${VIDEOCUBE_MARCH_MAX}; i++){
      if (i >= uMarch) break;
      float t = tn + (float(i) + 0.5) * dt;
      vec3 pc = ro + rd * t;      // centered [-0.5, 0.5]
      vec3 fc = pc + 0.5;         // field coords [0,1]
      float x = fc.x, y = fc.y, z = fc.z;
      // SPACE DIFFUSE toward the field's lowest-info face (per axis).
      if (uSpaceDiffuse > 0.0){
        if (uDiffuseAxis == 0) x = diffusePull(x, uSpaceDiffuse, uDiffuseDir);
        else if (uDiffuseAxis == 1) y = diffusePull(y, uSpaceDiffuse, uDiffuseDir);
        else z = diffusePull(z, uSpaceDiffuse, uDiffuseDir);
      }
      // SPACE CRUSH voxelize, then CRUSH spatial snap (compose, cube-dsp order).
      x = crushCoord(spaceCrushCoord(x, uSpaceCrush), uCrush);
      y = crushCoord(spaceCrushCoord(y, uSpaceCrush), uCrush);
      z = crushCoord(spaceCrushCoord(z, uSpaceCrush), uCrush);
      // z is the DEPTH axis — a ray∩cube sample always lands in [0,1], so clamp is
      // the identity here and WRAP is a no-op on it (matches the pre-WRAP look).
      z = clamp(z, 0.0, 1.0);
      // SURFACE uv (B1 — make WRAP visibly change the PICTURE). The marched (x,y)
      // are ALWAYS in [0,1] (interior cube samples), so a plain wrapFold vs clamp
      // is byte-identical → WRAP was DEAD. WRAP ON now EXTENDS the sampling domain
      // (VIDEOCUBE_WRAP_TILES) and mirror-folds it, so the source videos MIRROR-
      // TILE across the cube (a kaleidoscopic fold at the faces / mid-planes) — the
      // visible video analog of the audio slice's out-of-range mirror-fold. OFF =
      // the single clamped read (byte-identical to the pre-WRAP render).
      vec2 uv;
      if (uWrap > 0.5){
        uv = vec2(wrapFold(x * WRAP_TILES), wrapFold(y * WRAP_TILES));
      } else {
        uv = vec2(clamp(x, 0.0, 1.0), clamp(y, 0.0, 1.0));
      }

      vec3 cA = surfWindow(uRingA, uv, layerA, uSpread, uWindowTaps, uMode);
      vec3 cB = surfWindow(uRingB, uv, layerB, uSpread, uWindowTaps, uMode);
      vec3 cC = surfWindow(uRingC, uv, layerC, uSpread, uWindowTaps, uMode);
      float lA = lumaOf(cA), lB = lumaOf(cB), lC = lumaOf(cC);

      // Field occupancy density (→ alpha) — genuine z axis, cube-dsp's field.
      float F = crushAmp(fieldDensity(z, lA, lB, lC, m, uConnect, cs, uMaterial), uCrush);

      // Occupancy-weighted source colour (→ the solid's texture).
      float dF = occ(z, lA, lB, uConnect, cs);
      float dC = occ(z, lC, lB, uConnect, cs);
      float wf = dF * (1.0 - m);
      float wc = dC * m;
      float wWall = clamp(1.0 - (dF + dC), 0.0, 1.0);
      vec3 vox;
      if (uMaterial > 0.5){
        if (wWall >= wf && wWall >= wc) vox = cB;
        else if (wf >= wc) vox = cA; else vox = cC;
      } else {
        float denom = max(wf + wc + wWall, 1e-3);
        vox = (wf*cA + wc*cC + wWall*cB) / denom;
      }
      vox = posterize(vox, uCrush);

      // Beer-Lambert front-to-back composite (occupancy-weighted alpha).
      float a = (1.0 - exp(-F * ABSORB * dt)) * (1.0 - alpha);
      accum += a * vox;
      alpha += a;

      // Cutting slice plane injected AT ITS TRUE DEPTH (proper occlusion) — the
      // exact plane the audio reads, tinted by the density it cuts. The draw band
      // scales by |rd·N| so the plane keeps a CONSTANT apparent thickness (~1.5
      // samples) at every view angle: sdst changes by |rd·N|·dt per step, so a
      // plain dt·0.75 band smears wide when the ray grazes the plane (small |rd·N|)
      // — view-dependent. The |rd·N| factor (floored so an edge-on plane stays a
      // faint sliver, not a hard vanish) makes the thickness view-independent.
      float sdst = dot(pc - uSliceCenter, uSliceN);
      float su   = dot(pc - uSliceCenter, uSliceA);
      float sv   = dot(pc - uSliceCenter, uSliceB);
      float sBand = max(abs(dot(rd, uSliceN)), 0.15) * dt * 0.75;
      if (abs(sdst) < sBand && abs(su) <= 0.5 && abs(sv) <= 0.5){
        vec3 hot = mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.95, 0.5), F);
        float pa = (0.35 + 0.5*F) * (1.0 - alpha);
        accum += pa * hot;
        alpha += pa;
      }
      if (alpha > 0.985) break;
    }
  }

  vec3 bg = vec3(0.02, 0.025, 0.045);
  vec3 col = accum + (1.0 - alpha) * bg;

  // 12-edge wireframe overlay (screen-space) for orientation.
  const int EA[12] = int[12](0,1,2,3,4,5,6,7,0,1,2,3);
  const int EB[12] = int[12](1,2,3,0,5,6,7,4,4,5,6,7);
  float wire = 0.0;
  for (int e = 0; e < 12; e++){
    int a = EA[e]; int b = EB[e];
    if (uCornerOK[a] < 0.5 || uCornerOK[b] < 0.5) continue;
    float d = segDist(vUv, uCorners[a], uCorners[b]);
    wire = max(wire, 1.0 - smoothstep(0.0, WIRE_W, d));
  }
  col = mix(col, vec3(0.55, 0.72, 0.85), wire * 0.55);

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ----------------------------------------------------------------------
// SLICE-VIZ shaders (the 6 dedicated readout ports). These do NOT touch the
// COMBINE ray-march / camera / field core (confirmed correct) — they READ the
// SAME rings / SAME slice plane / SAME cube-dsp field the module already
// computes, echoing FrameTable's reader modes. The field helpers below are the
// SAME 1:1 cube-dsp transliterations COMBINE_FRAG uses inline (kept a shared
// string here so SLICE_FRAG + DEPTH_FRAG don't each re-duplicate them); COMBINE
// keeps its own untouched copy.
// ----------------------------------------------------------------------

const VIZ_FIELD_HELPERS = `
const float N = ${N}.0;
const int   MODE_MORPH = ${VIDEOCUBE_MODE_MORPH};
const int   MODE_CHAOS = ${VIDEOCUBE_MODE_CHAOS};
const int   WINDOW_TAPS_MAX = ${VIDEOCUBE_SMOOTH_TAPS_MAX};
const float WRAP_TILES = ${VIDEOCUBE_WRAP_TILES.toFixed(1)};

float lumaOf(vec3 c){ return clamp(0.299*c.r + 0.587*c.g + 0.114*c.b, 0.0, 1.0); }
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
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
float spaceCrushCoord(float coord, float k){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return coord;
  float n = max(2.0, floor(256.0 + (6.0 - 256.0)*kk + 0.5));
  if (n >= 256.0) return coord;
  float cc = clamp(coord, 0.0, 1.0);
  float cell = min(n - 1.0, floor(cc * n));
  return (cell + 0.5) / n;
}
float crushCoord(float coord, float k){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return coord;
  float n = max(1.0, floor(256.0 + (4.0 - 256.0)*kk + 0.5));
  if (n >= 256.0) return coord;
  float cc = clamp(coord, 0.0, 1.0);
  float cell = min(n - 1.0, floor(cc * n));
  return (cell + 0.5) / n;
}
float crushAmp(float v, float k){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return v;
  float levels = max(2.0, floor(256.0 + (2.0 - 256.0)*kk + 0.5));
  if (levels >= 256.0) return v;
  float vv = clamp(v, 0.0, 1.0);
  return floor(vv*(levels-1.0) + 0.5)/(levels-1.0);
}
float diffusePull(float c, float k, float dir){
  float kk = clamp(k, 0.0, 1.0);
  if (kk <= 0.0) return c;
  float target = dir > 0.0 ? 1.0 : 0.0;
  return c + (target - c)*(kk*kk);
}
float wrapFold(float coord){
  float m = mod(coord, 2.0);
  if (m < 0.0) m += 2.0;
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
float fieldDensity(float z, float fh, float wh, float ch, float m, float connect, float cs, float hard){
  float dF = occ(z, fh, wh, connect, cs);
  float dC = occ(z, ch, wh, connect, cs);
  float f3 = (1.0 - m)*dF + m*dC;
  if (hard > 0.5) return f3 >= 0.5 ? 1.0 : 0.0;
  return clamp(f3, 0.0, 1.0);
}
float wrapLayer(float x){ float m = mod(x, N); if (m < 0.0) m += N; return m; }
vec3 surfAt(sampler2DArray ring, vec2 uv, float baseLayer){
  float l0 = floor(baseLayer);
  float f = baseLayer - l0;
  vec3 c0 = texture(ring, vec3(uv, wrapLayer(l0))).rgb;
  vec3 c1 = texture(ring, vec3(uv, wrapLayer(l0 + 1.0))).rgb;
  return mix(c0, c1, f);
}
// SPREAD temporal window (shared by slice_out / depth_out / the triptych) — the
// SAME Hann-weighted ±h average COMBINE_FRAG uses, so every readout oozes in
// lockstep. taps ≤ 1 / CHAOS / near-zero window ⇒ single-frame surfAt (SPREAD=0
// byte-identical). CPU mirror: videocube-core.temporalWindow.
vec3 surfWindow(sampler2DArray ring, vec2 uv, float center, float spreadNorm, int taps, int mode){
  float h = 0.5 * clamp(spreadNorm, 0.0, 1.0) * (N - 1.0);
  if (taps <= 1 || mode == MODE_CHAOS || h < 1e-3){
    return surfAt(ring, uv, center);
  }
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int k = 0; k < WINDOW_TAPS_MAX; k++){
    if (k >= taps) break;
    float off = -h + 2.0*h*(float(k) + 0.5)/float(taps);
    float w = 0.5*(1.0 + cos(3.14159265358979 * off / h));
    acc += w * surfAt(ring, uv, center + off);
    wsum += w;
  }
  return acc / max(wsum, 1e-6);
}
// Reader trailing-frame lag — the SAME per-mode branch COMBINE_FRAG uses inline
// (SMOOTH trailing / MORPH newest / CHAOS per-pixel hash) PLUS the SCAN offset
// (scan*(N-1) frames), so slice_out + the triptych read the SAME SCAN-shifted
// temporal frame the ray-march + audio do. scan=0 leaves the lag untouched.
float readerLag(int mode, float live, float readerLag, float scan, vec2 fragCoord){
  float lag = (live > 0.5) ? 0.0 : readerLag;
  if (mode == MODE_CHAOS){
    vec2 bn = mod(fragCoord, 128.0);
    lag = hash21(floor(bn)) * (N - 1.0);
  } else if (mode == MODE_MORPH){
    lag = 0.0;
  }
  lag += scan * (N - 1.0);
  return lag;
}
`;

// scope_out — draw the already-computed 256-sample surface-height wave (the
// wave audio_out plays) as a green scope trace. Near-free (one texel fetch).
const SCOPE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uWave;   // 256×1: R = (sample*0.5 + 0.5)
uniform float uHasWave;    // 0 until a non-silent wave has been posted
void main(){
  vec3 bg = vec3(0.02, 0.03, 0.05);
  float w = texture(uWave, vec2(vUv.x, 0.5)).r;         // [0,1], 0.5 = zero-crossing
  float d = abs(vUv.y - w);
  float line = 1.0 - smoothstep(0.0, 0.022, d);
  float mid  = 1.0 - smoothstep(0.0, 0.006, abs(vUv.y - 0.5));
  vec3 col = bg;
  col = mix(col, vec3(0.10, 0.20, 0.12), mid * 0.6);    // faint zero baseline
  col = mix(col, vec3(0.45, 1.0, 0.55), clamp(line, 0.0, 1.0) * uHasWave);
  outColor = vec4(col, 1.0);
}`;

// slice_out + smooth/morph/chaos — the 2-D cross-section where the cutting plane
// meets the solid. One field sample per pixel (NO march) at the plane point,
// coloured by uSliceView. Positions the plane point with the SAME slice basis
// (uSliceCenter/A/B) setViewUniforms/sliceRay use, so Y/ROT slide the cut.
const SLICE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;
uniform sampler2DArray uRingA;
uniform sampler2DArray uRingB;
uniform sampler2DArray uRingC;
uniform int   uHeadA; uniform int uHeadB; uniform int uHeadC;
uniform int   uMode; uniform float uLive; uniform float uReaderLag; uniform float uHasContent;
uniform float uSpread; uniform int uWindowTaps; // SPREAD temporal window (Hann ±h)
uniform float uScan; // SCAN reader-centre offset scan*(N-1) frames (wraps)
uniform float uMorphFC; uniform float uConnect; uniform float uConnectStr;
uniform float uCrush; uniform float uSpaceCrush; uniform float uSpaceDiffuse;
uniform int   uDiffuseAxis; uniform float uDiffuseDir; uniform float uWrap; uniform float uMaterial;
uniform vec3  uSliceCenter; uniform vec3 uSliceA; uniform vec3 uSliceB;
uniform int   uSliceView;   // 0 TEXTURED / 1 XRAY / 2 WEIGHTS
${VIZ_FIELD_HELPERS}
void main(){
  vec3 bg = vec3(0.02, 0.03, 0.05);
  if (uHasContent < 0.5){ outColor = vec4(bg, 1.0); return; }
  float lag = readerLag(uMode, uLive, uReaderLag, uScan, gl_FragCoord.xy);
  float layerA = float(uHeadA) - lag;
  float layerB = float(uHeadB) - lag;
  float layerC = float(uHeadC) - lag;

  float su = vUv.x - 0.5, sv = vUv.y - 0.5;      // plane square [-0.5,0.5]^2
  vec3 pc = uSliceCenter + su*uSliceA + sv*uSliceB; // centered coords
  vec3 fc = pc + 0.5;                               // field coords [0,1]
  bool inside = fc.x>=0.0&&fc.x<=1.0&&fc.y>=0.0&&fc.y<=1.0&&fc.z>=0.0&&fc.z<=1.0;
  if (!inside && uWrap < 0.5){ outColor = vec4(bg, 1.0); return; }

  float x = fc.x, y = fc.y, z = fc.z;
  if (uSpaceDiffuse > 0.0){
    if (uDiffuseAxis == 0) x = diffusePull(x, uSpaceDiffuse, uDiffuseDir);
    else if (uDiffuseAxis == 1) y = diffusePull(y, uSpaceDiffuse, uDiffuseDir);
    else z = diffusePull(z, uSpaceDiffuse, uDiffuseDir);
  }
  x = crushCoord(spaceCrushCoord(x, uSpaceCrush), uCrush);
  y = crushCoord(spaceCrushCoord(y, uSpaceCrush), uCrush);
  z = crushCoord(spaceCrushCoord(z, uSpaceCrush), uCrush);
  z = (uWrap > 0.5) ? wrapFold(z) : clamp(z, 0.0, 1.0);
  vec2 uv = (uWrap > 0.5)
    ? vec2(wrapFold(x * WRAP_TILES), wrapFold(y * WRAP_TILES))
    : vec2(clamp(x, 0.0, 1.0), clamp(y, 0.0, 1.0));

  vec3 cA = surfWindow(uRingA, uv, layerA, uSpread, uWindowTaps, uMode);
  vec3 cB = surfWindow(uRingB, uv, layerB, uSpread, uWindowTaps, uMode);
  vec3 cC = surfWindow(uRingC, uv, layerC, uSpread, uWindowTaps, uMode);
  float lA = lumaOf(cA), lB = lumaOf(cB), lC = lumaOf(cC);
  float m  = clamp(uMorphFC, 0.0, 1.0);
  float cs = clamp(uConnectStr, 0.0, 1.0);
  float F  = crushAmp(fieldDensity(z, lA, lB, lC, m, uConnect, cs, uMaterial), uCrush);
  float dF = occ(z, lA, lB, uConnect, cs);
  float dC = occ(z, lC, lB, uConnect, cs);
  float wf = dF * (1.0 - m);
  float wc = dC * m;
  float wWall = clamp(1.0 - (dF + dC), 0.0, 1.0);
  vec3 vox;
  if (uMaterial > 0.5){
    if (wWall >= wf && wWall >= wc) vox = cB;
    else if (wf >= wc) vox = cA; else vox = cC;
  } else {
    float denom = max(wf + wc + wWall, 1e-3);
    vox = (wf*cA + wc*cC + wWall*cB) / denom;
  }
  vox = posterize(vox, uCrush);

  vec3 col;
  if (uSliceView == ${SLICE_VIEW_XRAY}){
    col = vec3(F);                                  // grayscale occupancy density
  } else if (uSliceView == ${SLICE_VIEW_WEIGHTS}){
    col = vec3(wf, wc, wWall);                       // false-colour occ weights
  } else {
    col = mix(bg, vox, clamp(F * 1.5, 0.0, 1.0));    // TEXTURED — source RGB revealed by density
  }
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// depth_out — the intersection-depth HEIGHTMAP: per plane point, march the solid
// along the plane normal (cube-dsp.rayDepth's 1-D scan, extended to 2-D) and
// colour-map the accumulated solid (bright = deep = loud). Renderer-gated march.
const DEPTH_FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;
uniform sampler2DArray uRingA;
uniform sampler2DArray uRingB;
uniform sampler2DArray uRingC;
uniform int   uHeadA; uniform int uHeadB; uniform int uHeadC;
uniform int   uMode; uniform float uLive; uniform float uReaderLag; uniform float uHasContent;
uniform float uSpread; uniform int uWindowTaps; // SPREAD temporal window (Hann ±h)
uniform float uScan; // SCAN reader-centre offset scan*(N-1) frames (wraps)
uniform float uMorphFC; uniform float uConnect; uniform float uConnectStr;
uniform float uCrush; uniform float uSpaceCrush; uniform float uSpaceDiffuse;
uniform int   uDiffuseAxis; uniform float uDiffuseDir; uniform float uWrap; uniform float uMaterial;
uniform vec3  uSliceCenter; uniform vec3 uSliceA; uniform vec3 uSliceB; uniform vec3 uSliceN;
uniform int   uDepthMarch;
${VIZ_FIELD_HELPERS}
const float HALF = 0.8660254; // sqrt(3)/2 — the cube half-diagonal march extent
vec3 depthColormap(float t){
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.0, 0.0, 0.06);   // void
  vec3 c1 = vec3(0.25, 0.0, 0.45);  // indigo
  vec3 c2 = vec3(0.85, 0.15, 0.35); // magenta
  vec3 c3 = vec3(1.0, 0.9, 0.4);    // amber (deep/loud)
  if (t < 0.34) return mix(c0, c1, t / 0.34);
  if (t < 0.67) return mix(c1, c2, (t - 0.34) / 0.33);
  return mix(c2, c3, (t - 0.67) / 0.33);
}
void main(){
  if (uHasContent < 0.5){ outColor = vec4(0.0, 0.0, 0.06, 1.0); return; }
  float lag = readerLag(uMode, uLive, uReaderLag, uScan, gl_FragCoord.xy);
  float layerA = float(uHeadA) - lag;
  float layerB = float(uHeadB) - lag;
  float layerC = float(uHeadC) - lag;

  float su = vUv.x - 0.5, sv = vUv.y - 0.5;
  vec3 ro = uSliceCenter + su*uSliceA + sv*uSliceB; // ray origin on the plane (centered)
  vec3 rd = uSliceN;                                 // march along the plane normal
  float m  = clamp(uMorphFC, 0.0, 1.0);
  float cs = clamp(uConnectStr, 0.0, 1.0);

  float acc = 0.0;
  for (int i = 0; i < ${DEPTH_MARCH_MAX}; i++){
    if (i >= uDepthMarch) break;
    float t = (float(i) / (float(uDepthMarch) - 1.0)) * 2.0 * HALF - HALF; // [-HALF, +HALF]
    vec3 fc = ro + rd * t + 0.5;                     // field coords
    float x = fc.x, y = fc.y, z = fc.z;
    if (uSpaceDiffuse > 0.0){
      if (uDiffuseAxis == 0) x = diffusePull(x, uSpaceDiffuse, uDiffuseDir);
      else if (uDiffuseAxis == 1) y = diffusePull(y, uSpaceDiffuse, uDiffuseDir);
      else z = diffusePull(z, uSpaceDiffuse, uDiffuseDir);
    }
    bool inside = x>=0.0&&x<=1.0&&y>=0.0&&y<=1.0&&z>=0.0&&z<=1.0;
    if (!inside && uWrap < 0.5) continue;            // out-of-cube reads silent (cube-dsp rule)
    // Audio-path coord warp (spaceCrush → crush → wrap/clamp) — NO surface tiling
    // (depth mirrors the audio's rayDepth, not the picture's surface look).
    x = crushCoord(spaceCrushCoord(x, uSpaceCrush), uCrush);
    y = crushCoord(spaceCrushCoord(y, uSpaceCrush), uCrush);
    z = crushCoord(spaceCrushCoord(z, uSpaceCrush), uCrush);
    if (uWrap > 0.5){ x = wrapFold(x); y = wrapFold(y); z = wrapFold(z); }
    else { x = clamp(x, 0.0, 1.0); y = clamp(y, 0.0, 1.0); z = clamp(z, 0.0, 1.0); }
    vec2 uv = vec2(x, y);
    float lA = lumaOf(surfWindow(uRingA, uv, layerA, uSpread, uWindowTaps, uMode));
    float lB = lumaOf(surfWindow(uRingB, uv, layerB, uSpread, uWindowTaps, uMode));
    float lC = lumaOf(surfWindow(uRingC, uv, layerC, uSpread, uWindowTaps, uMode));
    acc += fieldDensity(z, lA, lB, lC, m, uConnect, cs, uMaterial);
  }
  float depth = crushAmp(acc / float(uDepthMarch), uCrush); // normalize like rayDepth (/steps)
  outColor = vec4(depthColormap(clamp(depth * 2.5, 0.0, 1.0)), 1.0);
}`;

/**
 * Renderer-gated ray-march step count (§4 perf). 32 steps on the SwiftShader
 * software renderer (CI), 64 on a real GPU — a flat step count that is affordable
 * on a GPU goes red (timeout) on the CI software renderer (recorderbox/edges
 * class), so bound the software cost from a renderer probe. Renderer masked/absent
 * ⇒ the GPU count (correct for real users; CI reliably reports SwiftShader).
 */
function detectMarchSteps(gl: WebGL2RenderingContext): number {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
    );
    if (/swiftshader|software|llvmpipe/i.test(renderer)) return VIDEOCUBE_MARCH_SOFT;
  } catch {
    /* extension/param unavailable — fall through to the GPU default */
  }
  return VIDEOCUBE_MARCH_GPU;
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
  // The 3 rings must keep FILLING even when unobserved: a scan back through a gap
  // would show a seam, and the audio drone reads the live rings. pullExempt (like
  // FRAMETABLE) keeps all three coherent.
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
    { id: 'scan_cv',             type: 'cv', paramTarget: 'scan',             cvScale: { mode: 'linear' } },
    { id: 'tune_cv',             type: 'cv', paramTarget: 'tune',             cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'video_out', type: 'video' }, // primary — the volumetric ray-march
    { id: 'audio_out', type: 'audio' }, // derived oscillator (MANDELBULB seam)
    // ── SLICE-VIZ dedicated readouts of the SAME field/slice (PER-PORT gated:
    //    an UNPATCHED port renders NOTHING → zero GPU cost, like COLOUR OF MAGIC).
    { id: 'scope_out', type: 'video' },  // the 256-sample surface-height wave (= audio_out) as a scope trace
    { id: 'slice_out', type: 'video' },  // the 2-D cutting-plane cross-section (slice_view flavour)
    { id: 'depth_out', type: 'video' },  // intersection-depth HEIGHTMAP of the plane (bright = deep/loud)
    { id: 'smooth_out', type: 'video' }, // slice cross-section forced through the SMOOTH reader treatment
    { id: 'morph_out', type: 'video' },  // slice cross-section forced through the MORPH reader treatment
    { id: 'chaos_out', type: 'video' },  // slice cross-section forced through the CHAOS reader treatment
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
    { id: 'scan',             label: 'scan',         defaultValue: DEFAULTS.scan,             min: 0, max: 1,      curve: 'linear' },
    { id: 'slice_y',          label: 'y',            defaultValue: DEFAULTS.slice_y,          min: 0, max: 1,      curve: 'linear' },
    { id: 'slice_rx',         label: 'rot x',        defaultValue: DEFAULTS.slice_rx,         min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'slice_ry',         label: 'rot y',        defaultValue: DEFAULTS.slice_ry,         min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'slice_rz',         label: 'rot z',        defaultValue: DEFAULTS.slice_rz,         min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'level',            label: 'level',        defaultValue: DEFAULTS.level,            min: 0, max: 2,      curve: 'linear' },
    // ── orbit CAMERA (picture only) ──
    { id: 'view_zoom',        label: 'view zoom',    defaultValue: DEFAULTS.view_zoom,        min: 0.3, max: 3,   curve: 'linear' },
    { id: 'view_rot_x',       label: 'view x',       defaultValue: DEFAULTS.view_rot_x,       min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'view_rot_y',       label: 'view y',       defaultValue: DEFAULTS.view_rot_y,       min: -3.1416, max: 3.1416, curve: 'linear' },
    { id: 'view_rot_z',       label: 'view z',       defaultValue: DEFAULTS.view_rot_z,       min: -3.1416, max: 3.1416, curve: 'linear' },
    // ── discrete toggles ──
    { id: 'wrap',        label: 'wrap',     defaultValue: DEFAULTS.wrap,        min: 0, max: 1, curve: 'discrete' },
    { id: 'material',    label: 'material', defaultValue: DEFAULTS.material,    min: 0, max: 1, curve: 'discrete' },
    { id: 'screen_on',   label: 'screen',   defaultValue: DEFAULTS.screen_on,   min: 0, max: 1, curve: 'discrete' },
    { id: 'reader_mode', label: 'reader',   defaultValue: DEFAULTS.reader_mode, min: 0, max: 2, curve: 'discrete' },
    { id: 'freeze',      label: 'freeze',   defaultValue: DEFAULTS.freeze,      min: 0, max: 1, curve: 'linear' },
    { id: 'live',        label: 'live',     defaultValue: DEFAULTS.live,        min: 0, max: 1, curve: 'linear' },
    // slice-viz colorize flavour (0 TEXTURED / 1 XRAY / 2 WEIGHTS) — drives
    // slice_out + the smooth/morph/chaos triptych; NOT an audio param.
    { id: 'slice_view',  label: 'slice view', defaultValue: DEFAULTS.slice_view, min: 0, max: 2, curve: 'discrete' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation:
      "VIDEOCUBE is the VIDEO version of the audio CUBE oscillator, and it works the SAME way: it stacks three video sources into a GENUINE volumetric 3D solid and lets you fly a cutting plane through it. It ingests THREE 60-frame video rings — A (FLOOR), B (WALL / connector) and C (CEILING) — each either GENERATED LIVE from a connected video input (video_a/b/c) or LOADED from a .frametable.png atlas file. Each frame the reader picks ONE frame from each ring as a SURFACE, and those three video-luma surfaces are stacked into a real 3D scalar field over (x, y, z): the depth axis z is a genuine connecting dimension, and the occupancy curve (the SAME cube-dsp occ math the audio CUBE uses) fills SOLID DENSITY between the three surfaces — so the three videos join THROUGH SPACE, exactly as three wavetables join in the audio cube. video_out is a VOLUMETRIC RAY-MARCH of that solid: every output pixel casts a camera ray and marches through the cube, compositing the occupancy-weighted colour of the three source videos (SMOOTH = a soft blend, HARD = one surface wins per voxel) with opacity set by the field density, and it draws the CUTTING SLICE PLANE (the exact plane the audio reads, tinted by the density it cuts) and a 12-edge wireframe for orientation. An orbit CAMERA (VIEW ZOOM / VIEW X / VIEW Y / VIEW Z) flies around the solid so you can look THROUGH the three videos from any angle. MORPH cross-fades the FLOOR fill toward the CEILING fill through B, CONNECT reshapes how B binds them (rounded ↔ hard ramp), CONNECT STRENGTH swells B's mid-band, CRUSH posterizes the colour and amplitude-crushes the density, SPACE CRUSH voxelizes the field lookup, SPACE DIFFUSE pulls the sampling toward the field's lowest-information face, MATERIAL switches SMOOTH↔HARD, WRAP mirror-folds out-of-range coordinates, and Y / ROT X / ROT Y / ROT Z position the cutting plane. Crucially it ALSO emits AUDIO from the SAME field: the reader-selected frame of each ring is reduced to a luma heightfield and the IDENTICAL cube-dsp surface-height slice is flown through the stack along the SAME plane (Y / ROT), so audio_out carries a mono wavetable-oscillator drone whose timbre is driven by the SAME field knobs ('isomorphic in all cases'). Pitch is set by TUNE/FINE (and the tune CV), level by LEVEL, and FOLD is a west-coast wavefolder on the derived audio (audio-only — it has no image analog); SPREAD is a FRAMETABLE-style TEMPORAL WINDOW — the sampling size, in time, of the reader: at 0 each ring surfaces a single frame (crisp), and as you open it a Hann-weighted window blends a wider span of the ring into every surface, so a FROZEN table OOZES through its captured frames (the picture AND the drone flow in lockstep — the same window feeds the audio reduce). SCAN is the FRAMETABLE MORPH partner to SPREAD: where SPREAD sets the WIDTH of the reader window, SCAN sets its POSITION — it moves the reading CENTRE through the whole 60-frame (~2-second) ring, wrapping at the seam, so on a FROZEN table you can scrub the crisp read (or the widened window) THROUGH the captured content and it oozes through the ~2 seconds exactly as FrameTable's MORPH + SPREAD do (SPREAD alone can only widen the blend at the fixed centre; SCAN is what walks it through the ring). SCAN feeds BOTH the picture surfaces and the audio reduce (image + drone in lockstep, the same as SPREAD), and at 0 it is byte-identical to the pre-scan read — the default look/sound is unchanged. A global READER selector (SMOOTH default / MORPH / CHAOS) sets which frame each ring contributes as its surface (SMOOTH = a trailing frame, MORPH = the newest frame, CHAOS = a per-pixel dithered frame), FREEZE holds all live rings so you can scrub a held window, and LIVE forces the real-time (no-lag) read. The ray-march runs at quarter engine resolution and LINEAR-upscales to the half-res video_out, with a renderer-gated step count; the audio slice is recomputed off the audio thread on a throttle, never per sample. VIDEOCUBE v1 ships MONO-DRONE-first (no poly / ADSR yet — a follow-up). All ports live on the yellow drill-down PATCH PANEL (no raw side jacks). The field, the per-voxel colour blend and the luma reduction are a 1:1 CPU mirror unit-tested in $lib/video/videocube-core, reusing the audio-CUBE field math (cube-dsp) wholesale. Look-affecting new WebGL shader — held for owner visual preview.",
    inputs: {
      video_a: 'The LIVE source recorded, frame by frame, into ring A (FLOOR — one of the two morph ends / the bottom surface of the 3D solid). Ignored when slot A is loaded from a file. Unpatched (and no file) leaves ring A black.',
      video_b: 'The LIVE source recorded into ring B (WALL / connector — the surface that binds A and C through the middle of the solid). Ignored when slot B is loaded from a file.',
      video_c: 'The LIVE source recorded into ring C (CEILING — the other morph end / the top surface of the solid). Ignored when slot C is loaded from a file.',
      morph_cv: 'CV that modulates MORPH (the FLOOR↔CEILING cross-fade of the 3D fill, A ↔ C through B), swept linearly over 0..1. Drives both the volume and the audio field.',
      connect_cv: 'CV that modulates CONNECT (how the WALL binds A and C — rounded soft connector ↔ hard linear ramp), swept linearly over 0..1.',
      connect_strength_cv: 'CV that modulates CONNECT STRENGTH (over-emphasises B in the mid-band, swelling the connector through the solid / bulging the audio field), swept linearly over 0..1.',
      crush_cv: 'CV that modulates CRUSH (posterize the colour + amplitude-crush the field density AND the derived audio — the same crush levels), swept linearly over 0..1.',
      space_crush_cv: 'CV that modulates SPACE CRUSH (voxelize the field lookup — a chunky 3D mosaic in the picture and the identical voxelization of the audio field lookup), swept linearly over 0..1.',
      space_diffuse_cv: 'CV that modulates SPACE DIFFUSE (pull the sampling toward the field’s lowest-information face — a smear in the volume and the same coord warp in the audio scan), swept linearly over 0..1.',
      slice_y_cv: 'CV that modulates Y (the cutting slice plane height through the solid — the same plane the audio surface-height scan reads), swept linearly over 0..1.',
      slice_rx_cv: 'CV that modulates ROT X (Euler tilt of the cutting plane about X — the same plane the audio reads), swept linearly over -pi..pi.',
      slice_ry_cv: 'CV that modulates ROT Y (Euler tilt of the cutting plane about Y), swept linearly over -pi..pi.',
      slice_rz_cv: 'CV that modulates ROT Z (Euler tilt of the cutting plane about Z), swept linearly over -pi..pi.',
      fold_cv: 'CV that modulates FOLD (the west-coast wavefolder on the derived audio — audio-only, no image effect), swept linearly over 0..1.',
      spread_cv: 'CV that modulates SPREAD (the temporal reader window width — how far a frozen table oozes through time), swept linearly over 0..1.',
      scan_cv: 'CV that modulates SCAN (the reader-centre POSITION — moves the reading centre through the 60-frame ring / scrubs a frozen table through its ~2 seconds), swept linearly over 0..1 (wraps at the ring seam). Drives both the picture surfaces and the audio reduce.',
      tune_cv: 'CV that modulates TUNE (the derived oscillator pitch in semitones), swept linearly over -36..36. Affects the audio only, not the picture.',
    },
    outputs: {
      video_out: 'The PRIMARY output: a VOLUMETRIC RAY-MARCH of the 3D occupancy solid, textured by the three source videos joined across a real depth axis, under an orbit camera — you look THROUGH the three videos. Includes the cutting slice plane (the plane the audio reads) and a cube wireframe. The card preview shows this output; rendered at quarter engine resolution and LINEAR-upscaled to half res.',
      audio_out: "The derived audio: the reader-selected frame of each ring reduced to a luma heightfield and scanned by the audio-CUBE surface-height slice (the SAME field, the SAME plane as the picture), played as a mono wavetable oscillator at TUNE/FINE pitch and LEVEL gain. A continuous drone whose timbre is shaped by every field knob; silent until the audio worklet stands up (a moment after spawn).",
      scope_out: "A SCOPE TRACE of the exact 256-sample surface-height wave audio_out plays (cube-dsp.sampleSlice of the cutting plane, after FOLD) — the literal picture of the sound. A dedicated small video readout; PER-PORT gated (renders nothing until patched). Because it visualises the audio-derived wave, it is flat until the audio worklet stands up and the rings fill (the same warm-up as audio_out). Route it into a video mixer/monitor to SEE the drone move as you fly the slice.",
      slice_out: "The 2-D CROSS-SECTION where the cutting plane cuts the 3-D solid: for each pixel a point (a,b) on the tilted plane (positioned by Y / ROT exactly as the audio's slice ray) reads the three ring surfaces + the cube-dsp occupancy, coloured by the SLICE VIEW flavour — TEXTURED (the occupancy-weighted source videos on the plane), XRAY (grayscale occupancy density) or WEIGHTS (false-colour R=floor / G=ceiling / B=wall occupancy shares). Y and the rotations slide/tilt the cut through the solid; it honours the card's READER mode. PER-PORT gated.",
      depth_out: "The intersection-depth HEIGHTMAP: for every plane point (a,b) a ray marches the solid along the plane normal and accumulates how much material it crosses (the 2-D extension of the audio's 1-D surface-height scan), colour-mapped so BRIGHT = DEEP = LOUD. The picture of the audio's loudness field across the whole plane. The z-march step count is renderer-gated (SwiftShader-safe). PER-PORT gated.",
      smooth_out: "The slice cross-section (as slice_out, honouring SLICE VIEW) forced through the SMOOTH reader treatment — a trailing frame of each ring — regardless of the card's READER selector. Routed alongside morph_out + chaos_out it lets all three temporal treatments be compared/mixed at once. PER-PORT gated.",
      morph_out: "The slice cross-section forced through the MORPH reader treatment — the newest (crisp) frame of each ring — regardless of the card's READER selector. Differs from smooth_out (which trails) under motion. Honours SLICE VIEW. PER-PORT gated.",
      chaos_out: "The slice cross-section forced through the CHAOS reader treatment — a per-pixel dithered frame across each ring's 60-frame window — regardless of the card's READER selector. The noisiest of the triptych; differs from smooth_out/morph_out under motion. Honours SLICE VIEW. PER-PORT gated.",
    },
    controls: {
      tune: 'TUNE (-36..36 st, default 0): coarse pitch of the derived audio oscillator in semitones. CV via the tune input. Audio-only.',
      fine: 'FINE (-100..100 cents, default 0): fine pitch trim of the derived audio between the semitone steps of TUNE. Audio-only.',
      morph_fc: 'MORPH (0..1, default 0): cross-fades the FLOOR fill (surface A) toward the CEILING fill (surface C) of the 3D solid through the WALL (surface B) — 0 biases toward the floor, 1 toward the ceiling. Drives both the volume and the audio field. CV via the morph input.',
      connect: 'CONNECT (0..1, default 0): reshapes how the WALL (B) binds A and C through the solid interior — 0 = a rounded/soft connector (circle occupancy), 1 = a hard linear ramp toward B (sawtooth-V). Same occ profile drives the picture and the audio. CV via the connect input.',
      connect_strength: "CONNECT STRENGTH (0..1, default 0): over-emphasises B's connector in the mid-band of the solid (B swells through the volume / bulges the audio field). 0 = the exact CONNECT shape. CV via the connect strength input.",
      crush: 'CRUSH (0..1, default 0): posterize the ray-march colour (RGB quantized) AND amplitude-crush the field density (opacity) and the derived audio (the same crush levels). 0 = clean. CV via the crush input.',
      space_crush: 'SPACE CRUSH (0..1, default 0): voxelize the field lookup — snaps the (x,y,z) sampling coordinates to a chunky 3D voxel grid (a blocky solid) and the identical voxelization of the audio field lookup. 0 = transparent. CV via the space crush input.',
      space_diffuse: 'SPACE DIFFUSE (0..1, default 0): pulls the field sampling toward the cube’s lowest-information face (computed from the field, latched on the field, matching the audio scan) — a smear/gravity in the volume and the same coord warp in the audio. 0 = off. CV via the space diffuse input.',
      fold: 'FOLD (0..1, default 0): a west-coast wavefolder applied to the derived audio waveform (adds harmonics). Audio-only — it has no image analog. CV via the fold input.',
      spread: 'SPREAD (0..1, default 0): the TEMPORAL sampling window WIDTH of the reader (FrameTable-style). At 0 each ring surfaces one crisp frame (byte-identical to the pre-window read); opening it Hann-averages a ±window of ring frames into every surface — a wider window blends more of the ring, so a FROZEN table oozes through time. The reader mode (SMOOTH lag / MORPH newest) + SCAN pick the window CENTRE; SPREAD sets its WIDTH. Feeds BOTH the picture surfaces and the audio reduce, so image and drone flow together. CHAOS keeps its per-pixel single frame. CV via the spread input.',
      scan: 'SCAN (0..1, default 0): the reader-centre POSITION — the FrameTable MORPH partner to SPREAD. It moves the reading CENTRE through the whole 60-frame (~2-second) ring: 0 = today’s per-mode centre (byte-identical to the pre-scan read), and turning it up shifts the centre scan·(N−1) frames back, wrapping at the ring seam. Where SPREAD widens the blend at a fixed centre, SCAN walks that centre (crisp or widened) THROUGH the ring — so a FROZEN table can be SCRUBBED through its captured frames and oozes through the ~2 seconds exactly like FrameTable’s MORPH. Drives BOTH the picture surfaces and the audio reduce (image + drone in lockstep). For CHAOS it shifts the per-pixel dither base. CV via the scan input.',
      slice_y: 'Y (0..1, default 0.5): the height of the CUTTING SLICE PLANE through the solid. It is the exact plane the audio surface-height scan reads AND the plane drawn (tinted) in the volumetric render. CV via the y input.',
      slice_rx: 'ROT X (-pi..pi, default 0): Euler tilt of the cutting plane about X — the same plane the audio reads and the render draws. CV via the rot x input.',
      slice_ry: 'ROT Y (-pi..pi, default 0): Euler tilt of the cutting plane about Y. CV via the rot y input.',
      slice_rz: 'ROT Z (-pi..pi, default 0): Euler tilt of the cutting plane about Z. CV via the rot z input.',
      level: 'LEVEL (0..2, default 1): output gain on the derived audio (applied after FOLD). 1 = unity. Audio-only.',
      view_zoom: 'VIEW ZOOM (0.3..3, default 1): the orbit camera distance (camera dist = 2.6 / zoom). Picture only — a deliberate divergence from audio CUBE’s viz-only view: here it shapes the OUTPUT frame.',
      view_rot_x: 'VIEW X (-pi..pi, default 0.6): orbit camera ELEVATION. Picture only — rotates the volumetric view up/down without touching the sound or the cutting plane.',
      view_rot_y: 'VIEW Y (-pi..pi, default 0.7): orbit camera AZIMUTH. Picture only — rotates the volumetric view left/right.',
      view_rot_z: 'VIEW Z (-pi..pi, default 0): orbit camera ROLL (a genuine roll of the view). Picture only.',
      wrap: 'WRAP (0/1, default 0): OFF reads each source video with a single clamped sample (the plain look). ON extends the sampling domain and mirror-folds it, so the videos MIRROR-TILE across the cube — a kaleidoscopic fold at the faces/mid-planes in the volume, and the matching mirror-fold of the audio slice samples that reach beyond the cube. Governs BOTH the picture and the derived audio.',
      material: 'MATERIAL (0/1, default 0 = SMOOTH): SMOOTH renders the solid translucent, blending the three videos by their occupancy weights; HARD renders a binary solid where one surface wins per voxel (a hard-cut mosaic), and the same in the audio field.',
      screen_on: 'SCREEN (0/1, default 1 = on): perf gate for the ray-march. When off AND video_out is unpatched the render is skipped (the rings keep capturing and the audio drone keeps running).',
      reader_mode: 'READER (0..2, default 0 = SMOOTH): which frame each ring contributes as its surface (global — all three rings), in BOTH the picture AND the derived audio — they read the SAME temporal frame (the unified-field promise). 0 = SMOOTH (a trailing frame, sub-frame smoothed), 1 = MORPH (the newest frame, crisp), 2 = CHAOS (a per-pixel dithered frame across the ring window). Because CHAOS is per-pixel in the picture, the 1-D audio scan reads its window-MEAN representative frame.',
      freeze: 'FREEZE (0/1, default 0): stops all LIVE rings from advancing so the held surfaces can be scrubbed with the slice/view controls. File-loaded rings are always frozen. Picture + (via the ring content) audio.',
      live: 'LIVE (0/1, default 0): forces the real-time / no-lag ring read (the newest frame) for the SMOOTH reader (MORPH is already newest; CHAOS keeps its per-pixel dither). Applies to BOTH the picture and the audio surface selection.',
      slice_view: 'SLICE VIEW (0..2, default 0 = TEXTURED): the colorize flavour for slice_out AND the smooth/morph/chaos triptych (it does NOT change video_out, the audio, or the field). 0 = TEXTURED (the occupancy-weighted source videos where the plane cuts solid), 1 = XRAY (grayscale occupancy density), 2 = WEIGHTS (false-colour occupancy shares — R = floor-fill, G = ceiling-fill, B = wall/connector). Picture-only; no CV.',
    },
  },
  controlFamilies: [],
  // docs-hash-ignore:end

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    // Rings + video_out at half res (the 135 MiB budget); the ray-march renders
    // at quarter res into `marchTarget`, then upscales to `outTarget`.
    let rw = Math.max(1, Math.round(ctx.res.width * VIDEOCUBE_RENDER_SCALE));
    let rh = Math.max(1, Math.round(ctx.res.height * VIDEOCUBE_RENDER_SCALE));
    let mw = Math.max(1, Math.round(ctx.res.width * VIDEOCUBE_MARCH_SCALE));
    let mh = Math.max(1, Math.round(ctx.res.height * VIDEOCUBE_MARCH_SCALE));

    // 3 rings + 3 heads + per-slot capture/file flags.
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
    const ringFbo = gl.createFramebuffer();
    if (!ringFbo) throw new Error('videocube: createFramebuffer (ring) failed');
    let outTarget = createRingTarget(gl, rw, rh);              // video_out (half res)
    let marchTarget = createRingTarget(gl, mw, mh);            // ray-march (quarter res)
    let reduceTarget = createRingTarget(gl, LUMA_COLS, FIELD_ROWS); // audio luma strip (256×64)
    // ── SLICE-VIZ output targets (quarter res = the march scale — cheap; only the
    //    PATCHED ones ever render, so an unpatched viz port costs ZERO). Small
    //    render targets, NOT new full ring buffers → the 3-ring memory ceiling is
    //    untouched (6 × ~0.2 MiB vs the rings' ~135 MiB). ──
    let scopeTarget = createRingTarget(gl, mw, mh);   // scope_out (wave trace)
    let sliceTarget = createRingTarget(gl, mw, mh);   // slice_out (cross-section)
    let depthTarget = createRingTarget(gl, mw, mh);   // depth_out (heightmap)
    let smoothTarget = createRingTarget(gl, mw, mh);  // smooth_out (SMOOTH treatment)
    let morphTarget = createRingTarget(gl, mw, mh);   // morph_out  (MORPH treatment)
    let chaosTarget = createRingTarget(gl, mw, mh);   // chaos_out  (CHAOS treatment)
    for (const s of SLOTS) clearRingLayers(gl, ringFbo, ringTex[s], N, rw, rh);

    // 256×1 wave texture for scope_out — the already-computed derived wave uploaded
    // as R8, LINEAR-filtered across x. Written only when scope_out renders.
    const waveTex = gl.createTexture();
    if (!waveTex) throw new Error('videocube: createTexture (wave) failed');
    gl.bindTexture(gl.TEXTURE_2D, waveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUMA_COLS, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const waveScratch = new Uint8Array(LUMA_COLS * 4);

    // 1×1 black sentinel for an unpatched input (never bind a null sampler).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('videocube: createTexture (sentinel) failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const marchSteps = detectMarchSteps(gl);
    // depth_out march is renderer-gated the same way: SOFT on SwiftShader (CI),
    // GPU on real hardware. marchSteps === VIDEOCUBE_MARCH_SOFT ⇒ software renderer.
    const depthSteps = marchSteps <= VIDEOCUBE_MARCH_SOFT ? DEPTH_MARCH_SOFT : DEPTH_MARCH_GPU;
    // SPREAD temporal-window tap count — renderer-gated identically (fewer Hann
    // taps on SwiftShader/CI, more on a real GPU). SPREAD=0 short-circuits to a
    // single frame in-shader regardless, so this only costs when SPREAD is opened.
    const smoothTaps = marchSteps <= VIDEOCUBE_MARCH_SOFT ? VIDEOCUBE_SMOOTH_TAPS_SOFT : VIDEOCUBE_SMOOTH_TAPS_GPU;

    // Merge stored params over defaults (strip stray keys).
    const raw = node.params as Record<string, unknown>;
    const params: VideocubeParams = { ...DEFAULTS };
    for (const [k, v] of Object.entries(raw)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') (params as unknown as Record<string, number>)[k] = v;
    }

    // ── Deferred program compile (mandelbulb/mirrorpool CI discipline). ──
    let progs: {
      copy: WebGLProgram; combine: WebGLProgram; reduce: WebGLProgram;
      scope: WebGLProgram; slice: WebGLProgram; depth: WebGLProgram;
    } | null = null;
    let glFailed = false;
    let uC: Record<string, WebGLUniformLocation | null> = {};
    let uCopy: Record<string, WebGLUniformLocation | null> = {};
    let uReduce: Record<string, WebGLUniformLocation | null> = {};
    let uScope: Record<string, WebGLUniformLocation | null> = {};
    let uSlice: Record<string, WebGLUniformLocation | null> = {};
    let uDepth: Record<string, WebGLUniformLocation | null> = {};
    function ensurePrograms(): boolean {
      if (progs) return true;
      if (glFailed) return false;
      try {
        const copy = ctx.compileFragment(RING_COPY_FRAG);
        const combine = ctx.compileFragment(COMBINE_FRAG);
        const reduce = ctx.compileFragment(REDUCE_FRAG);
        const scope = ctx.compileFragment(SCOPE_FRAG);
        const slice = ctx.compileFragment(SLICE_FRAG);
        const depth = ctx.compileFragment(DEPTH_FRAG);
        progs = { copy, combine, reduce, scope, slice, depth };
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
          mode: cu('uMode'), live: cu('uLive'), readerLag: cu('uReaderLag'),
          hasContent: cu('uHasContent'), march: cu('uMarch'),
          spread: cu('uSpread'), windowTaps: cu('uWindowTaps'), scan: cu('uScan'),
          eye: cu('uEye'), right: cu('uRight'), up: cu('uUp'), fwd: cu('uFwd'),
          tanHalf: cu('uTanHalf'), aspect: cu('uAspect'),
          morphFC: cu('uMorphFC'), connect: cu('uConnect'), connectStr: cu('uConnectStr'),
          crush: cu('uCrush'), spaceCrush: cu('uSpaceCrush'), spaceDiffuse: cu('uSpaceDiffuse'),
          diffuseAxis: cu('uDiffuseAxis'), diffuseDir: cu('uDiffuseDir'),
          wrap: cu('uWrap'), material: cu('uMaterial'),
          sliceCenter: cu('uSliceCenter'), sliceN: cu('uSliceN'), sliceA: cu('uSliceA'), sliceB: cu('uSliceB'),
          corners: cu('uCorners[0]'), cornerOK: cu('uCornerOK[0]'),
        };
        uReduce = {
          ring: gl.getUniformLocation(reduce, 'uRing'),
          layer: gl.getUniformLocation(reduce, 'uLayer'),
          spread: gl.getUniformLocation(reduce, 'uSpread'),
          windowTaps: gl.getUniformLocation(reduce, 'uWindowTaps'),
        };
        uScope = {
          wave: gl.getUniformLocation(scope, 'uWave'),
          hasWave: gl.getUniformLocation(scope, 'uHasWave'),
        };
        // slice + depth share almost the same field/ring/slice uniform set; a
        // helper resolves the common names off either program.
        const commonViz = (prog: WebGLProgram): Record<string, WebGLUniformLocation | null> => {
          const g2 = (n: string) => gl.getUniformLocation(prog, n);
          return {
            ringA: g2('uRingA'), ringB: g2('uRingB'), ringC: g2('uRingC'),
            headA: g2('uHeadA'), headB: g2('uHeadB'), headC: g2('uHeadC'),
            mode: g2('uMode'), live: g2('uLive'), readerLag: g2('uReaderLag'), hasContent: g2('uHasContent'),
            spread: g2('uSpread'), windowTaps: g2('uWindowTaps'), scan: g2('uScan'),
            morphFC: g2('uMorphFC'), connect: g2('uConnect'), connectStr: g2('uConnectStr'),
            crush: g2('uCrush'), spaceCrush: g2('uSpaceCrush'), spaceDiffuse: g2('uSpaceDiffuse'),
            diffuseAxis: g2('uDiffuseAxis'), diffuseDir: g2('uDiffuseDir'), wrap: g2('uWrap'), material: g2('uMaterial'),
            sliceCenter: g2('uSliceCenter'), sliceA: g2('uSliceA'), sliceB: g2('uSliceB'),
          };
        };
        uSlice = { ...commonViz(slice), sliceView: gl.getUniformLocation(slice, 'uSliceView') };
        uDepth = { ...commonViz(depth), sliceN: gl.getUniformLocation(depth, 'uSliceN'), depthMarch: gl.getUniformLocation(depth, 'uDepthMarch') };
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
    // Frames since the last audio-slice recompute. Seeded at the throttle so the
    // FIRST dirty frame recomputes immediately; while IDLE it keeps growing (a
    // later single tweak fires next frame); under continuous modulation it is
    // reset on each recompute → capped at one readback per throttle window (B2).
    let sinceRecompute = AUDIO_RECOMPUTE_EVERY;
    let audioDirty = true;
    let lastWave: Float32Array | null = null;
    let lastSliceSig = '';
    // SPACE DIFFUSE gravity face — computed from the reduced field in
    // recomputeSlice (so it matches the audio), cached for the render. Default
    // (top / z-high) until the first reduce with diffuse > 0.
    let lastDiffuseTarget: DiffuseTarget = VIDEOCUBE_DIFFUSE_DEFAULT;

    function pushOscParams(): void {
      const ac = ctx.audioCtx;
      if (!oscNode || !ac) return;
      const pmap = oscNode.parameters as unknown as Map<string, AudioParam>;
      pmap.get('tune')?.setValueAtTime(clamp(params.tune, -36, 36), ac.currentTime);
      pmap.get('fine')?.setValueAtTime(clamp(params.fine, -100, 100), ac.currentTime);
      pmap.get('level')?.setValueAtTime(clamp(params.level, 0, 2), ac.currentTime);
    }

    // Persistent audio-slice readback scratch (B2 — no per-call allocation on the
    // hot path): one Uint8Array strip reused by every reduceRing readback, and one
    // Float32Array[64] heightfield per slot reused across recomputes.
    const readbackScratch = new Uint8Array(LUMA_COLS * FIELD_ROWS * 4);
    const fieldScratch: Record<Slot, Float32Array[]> = {
      a: Array.from({ length: FIELD_ROWS }, () => new Float32Array(LUMA_COLS)),
      b: Array.from({ length: FIELD_ROWS }, () => new Float32Array(LUMA_COLS)),
      c: Array.from({ length: FIELD_ROWS }, () => new Float32Array(LUMA_COLS)),
    };

    /** GPU-reduce one ring's reader-selected WINDOW to a 256×64 luma strip, read it
     *  back (into the persistent scratch), and fill the slot's persistent
     *  Float32Array[64] heightfield cube-dsp scans. Cheap (small target, gated).
     *  The window CENTRE is picked by the SHARED `readerCentreLayer` (per-mode
     *  lag/live/MODE + the SCAN offset), and SPREAD (uSpread/uWindowTaps) Hann-
     *  widens it — so the audio reduces the SAME SCAN-shifted temporal window the
     *  picture march surfaces (B3), and the drone oozes/scrubs with the image.
     *  SPREAD=0 + scan=0 ⇒ the single centre frame (identical to the pre-scan read). */
    function reduceRing(slot: Slot): Float32Array[] {
      if (!progs || !uReduce) return [];
      const mode = Math.round(clamp(params.reader_mode, 0, 2));
      const newest = (head[slot] - 1 + N) % N;
      // Window CENTRE = per-mode trailing lag + SCAN offset, wrapped (the SAME
      // readerCentreLayer the picture uses inline), so the audio reduces the SAME
      // SCAN-shifted frame the ray-march surfaces. scan=0 ⇒ the pre-scan centre.
      const layer = readerCentreLayer(newest, mode, params.live >= 0.5, clamp(params.scan, 0, 1));
      gl.useProgram(progs.reduce);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, ringTex[slot]);
      gl.uniform1i(uReduce.ring ?? null, 0);
      gl.uniform1f(uReduce.layer ?? null, layer);
      gl.uniform1f(uReduce.spread ?? null, clamp(params.spread, 0, 1));
      gl.uniform1i(uReduce.windowTaps ?? null, smoothTaps);
      gl.bindFramebuffer(gl.FRAMEBUFFER, reduceTarget.fbo);
      gl.viewport(0, 0, LUMA_COLS, FIELD_ROWS);
      ctx.drawFullscreenQuad();
      readbackScratch.fill(0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        gl.readPixels(0, 0, LUMA_COLS, FIELD_ROWS, gl.RGBA, gl.UNSIGNED_BYTE, readbackScratch);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return stripToHeightfieldInto(readbackScratch, LUMA_COLS, FIELD_ROWS, fieldScratch[slot]);
    }

    /** Quantized signature over every param that reshapes the derived wave (the
     *  AUDIO_PARAMS set). Mirrors MANDELBULB's `lastSliceSig` — a param-change
     *  recompute early-returns when the audio-affecting params are unchanged, so
     *  a live CV writing the same value every frame does NOT storm the readback +
     *  slice scan. `force` (the throttle path, for EVOLVING ring content) bypasses
     *  it since the heightfields change even when the params don't. */
    function sliceSig(): string {
      const q = (v: number) => Math.round(v * 1000);
      return [
        q(params.slice_y), q(params.slice_rx), q(params.slice_ry), q(params.slice_rz),
        q(params.morph_fc), q(params.connect), q(params.connect_strength), q(params.crush),
        q(params.space_crush), q(params.space_diffuse), q(params.fold), q(params.spread), q(params.scan),
        params.material >= 0.5 ? 1 : 0, params.wrap >= 0.5 ? 1 : 0,
        // reader_mode + live change the reduced frame (B3) → part of the signature.
        Math.round(clamp(params.reader_mode, 0, 2)), params.live >= 0.5 ? 1 : 0,
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
      const material = (params.material >= 0.5 ? 'hard' : 'smooth') as Material;
      // SPACE DIFFUSE gravity face — from the SAME reduced field, so the picture's
      // diffuse and the sound's agree (latched on the field, default when off).
      lastDiffuseTarget = params.space_diffuse > 0
        ? diffuseTargetFor(floorH, wallH, ceilH, {
            morphFC: clamp(params.morph_fc, 0, 1),
            connect: clamp(params.connect, 0, 1),
            connectStrength: clamp(params.connect_strength, 0, 1),
            material,
          })
        : VIDEOCUBE_DIFFUSE_DEFAULT;
      const sp: SliceParams = {
        sliceY: clamp(params.slice_y, 0, 1),
        rx: params.slice_rx, ry: params.slice_ry, rz: params.slice_rz,
        morphFC: clamp(params.morph_fc, 0, 1),
        connect: clamp(params.connect, 0, 1),
        connectStrength: clamp(params.connect_strength, 0, 1),
        crush: clamp(params.crush, 0, 1),
        spaceCrush: clamp(params.space_crush, 0, 1),
        spaceDiffuse: clamp(params.space_diffuse, 0, 1),
        material,
        wrap: params.wrap >= 0.5,
      };
      // SPREAD is no longer a slice-depth offset (the audio-CUBE heritage); it now
      // widens the TEMPORAL reduce window (reduceRing → REDUCE_FRAG Hann-averages
      // the ring), so floorH/wallH/ceilH already carry the oozed frame. The plane
      // reads at its true depth (offset 0) — the window lives upstream.
      const wave = sampleSlice(floorH, wallH, ceilH, sp, 0);
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

    // ── ORBIT CAMERA + SLICE PLANE + WIREFRAME uniforms (picture only). Computed
    //    on the CPU each frame (cheap) and pushed to the ray-march program, which
    //    must already be current (gl.useProgram(progs.combine)). ──
    const cornerBuf = new Float32Array(16);
    const cornerOKBuf = new Float32Array(8);
    // Cube corners in centered coords: bottom square 0..3 (z=-0.5), top 4..7.
    const CUBE_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
      [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
      [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
    ];
    function setViewUniforms(): void {
      const zoom = clamp(params.view_zoom, 0.3, 3);
      const dist = 2.6 / zoom;
      const elev = params.view_rot_x, azim = params.view_rot_y, roll = params.view_rot_z;
      const ce = Math.cos(elev), se = Math.sin(elev);
      const ca = Math.cos(azim), sa = Math.sin(azim);
      const ex = dist * ce * sa, ey = dist * se, ez = dist * ce * ca;
      // forward = toward origin
      let fx = -ex, fy = -ey, fz = -ez;
      const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      // right = normalize(cross(forward, worldUp)), worldUp = (0,1,0) → (-fz, 0, fx)
      let rx = -fz, ry = 0, rz = fx;
      const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
      // up = cross(right, forward)
      const ux = ry * fz - rz * fy;
      const uy = rz * fx - rx * fz;
      const uz = rx * fy - ry * fx;
      // roll about forward
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const r2x = rx * cr + ux * sr, r2y = ry * cr + uy * sr, r2z = rz * cr + uz * sr;
      const u2x = -rx * sr + ux * cr, u2y = -ry * sr + uy * cr, u2z = -rz * sr + uz * cr;
      const tanHalf = Math.tan(CAM_FOV / 2);
      const aspect = mw / mh;
      gl.uniform3f(uC.eye ?? null, ex, ey, ez);
      gl.uniform3f(uC.right ?? null, r2x, r2y, r2z);
      gl.uniform3f(uC.up ?? null, u2x, u2y, u2z);
      gl.uniform3f(uC.fwd ?? null, fx, fy, fz);
      gl.uniform1f(uC.tanHalf ?? null, tanHalf);
      gl.uniform1f(uC.aspect ?? null, aspect);
      // Project the 8 cube corners → screen-UV for the wireframe.
      for (let i = 0; i < 8; i++) {
        const c = CUBE_CORNERS[i]!;
        const relx = c[0] - ex, rely = c[1] - ey, relz = c[2] - ez;
        const camx = relx * r2x + rely * r2y + relz * r2z;
        const camy = relx * u2x + rely * u2y + relz * u2z;
        const camz = relx * fx + rely * fy + relz * fz;
        if (camz > 0.01) {
          cornerBuf[i * 2] = (camx / (camz * tanHalf * aspect)) * 0.5 + 0.5;
          cornerBuf[i * 2 + 1] = (camy / (camz * tanHalf)) * 0.5 + 0.5;
          cornerOKBuf[i] = 1;
        } else {
          cornerBuf[i * 2] = -10; cornerBuf[i * 2 + 1] = -10; cornerOKBuf[i] = 0;
        }
      }
      gl.uniform2fv(uC.corners ?? null, cornerBuf);
      gl.uniform1fv(uC.cornerOK ?? null, cornerOKBuf);
      // Cutting slice plane basis (centered coords) — the exact plane the audio reads.
      const sliceY = clamp(params.slice_y, 0, 1);
      const nrm = rotate(0, 0, 1, params.slice_rx, params.slice_ry, params.slice_rz);
      const axU = rotate(1, 0, 0, params.slice_rx, params.slice_ry, params.slice_rz);
      const axV = rotate(0, 1, 0, params.slice_rx, params.slice_ry, params.slice_rz);
      gl.uniform3f(uC.sliceCenter ?? null, 0, 0, sliceY - 0.5);
      gl.uniform3f(uC.sliceN ?? null, nrm[0], nrm[1], nrm[2]);
      gl.uniform3f(uC.sliceA ?? null, axU[0], axU[1], axU[2]);
      gl.uniform3f(uC.sliceB ?? null, axV[0], axV[1], axV[2]);
    }

    // ── SLICE-VIZ rendering (the 6 dedicated readout ports). Each is PER-PORT
    //    gated in draw() (only the PATCHED ports call these), reads the SAME
    //    rings / SAME slice plane / SAME field the module already computes, and
    //    renders at the march (quarter) resolution. NONE touch the combine core. ──

    // The cutting slice plane basis (centered coords) — the EXACT plane the audio
    // reads + setViewUniforms draws (recomputed here so the viz ports work even
    // when the combine block is skipped, e.g. screen off + video_out unpatched).
    interface SliceBasis { center: [number, number, number]; n: [number, number, number]; a: [number, number, number]; b: [number, number, number]; }
    function computeSliceBasis(): SliceBasis {
      const sliceY = clamp(params.slice_y, 0, 1);
      return {
        center: [0, 0, sliceY - 0.5],
        n: rotate(0, 0, 1, params.slice_rx, params.slice_ry, params.slice_rz),
        a: rotate(1, 0, 0, params.slice_rx, params.slice_ry, params.slice_rz),
        b: rotate(0, 1, 0, params.slice_rx, params.slice_ry, params.slice_rz),
      };
    }

    // Bind the 3 rings (units 0/1/2) + set the field/reader/slice uniforms shared
    // by SLICE_FRAG + DEPTH_FRAG on the given uniform-location record.
    function setVizCommon(
      g: WebGL2RenderingContext,
      u: Record<string, WebGLUniformLocation | null>,
      modeVal: number,
      liveVal: number,
      sb: SliceBasis,
      anyContent: boolean,
    ): void {
      g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex.a); g.uniform1i(u.ringA ?? null, 0);
      g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex.b); g.uniform1i(u.ringB ?? null, 1);
      g.activeTexture(g.TEXTURE2); g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex.c); g.uniform1i(u.ringC ?? null, 2);
      g.uniform1i(u.headA ?? null, (head.a - 1 + N) % N);
      g.uniform1i(u.headB ?? null, (head.b - 1 + N) % N);
      g.uniform1i(u.headC ?? null, (head.c - 1 + N) % N);
      g.uniform1i(u.mode ?? null, modeVal);
      g.uniform1f(u.live ?? null, liveVal);
      g.uniform1f(u.readerLag ?? null, VIDEOCUBE_READER_LAG);
      g.uniform1f(u.hasContent ?? null, anyContent ? 1 : 0);
      g.uniform1f(u.spread ?? null, clamp(params.spread, 0, 1));
      g.uniform1i(u.windowTaps ?? null, smoothTaps);
      g.uniform1f(u.scan ?? null, clamp(params.scan, 0, 1));
      g.uniform1f(u.morphFC ?? null, clamp(params.morph_fc, 0, 1));
      g.uniform1f(u.connect ?? null, clamp(params.connect, 0, 1));
      g.uniform1f(u.connectStr ?? null, clamp(params.connect_strength, 0, 1));
      g.uniform1f(u.crush ?? null, clamp(params.crush, 0, 1));
      g.uniform1f(u.spaceCrush ?? null, clamp(params.space_crush, 0, 1));
      g.uniform1f(u.spaceDiffuse ?? null, clamp(params.space_diffuse, 0, 1));
      g.uniform1i(u.diffuseAxis ?? null, lastDiffuseTarget.axis);
      g.uniform1f(u.diffuseDir ?? null, lastDiffuseTarget.dir);
      g.uniform1f(u.wrap ?? null, params.wrap >= 0.5 ? 1 : 0);
      g.uniform1f(u.material ?? null, params.material >= 0.5 ? 1 : 0);
      g.uniform3f(u.sliceCenter ?? null, sb.center[0], sb.center[1], sb.center[2]);
      g.uniform3f(u.sliceA ?? null, sb.a[0], sb.a[1], sb.a[2]);
      g.uniform3f(u.sliceB ?? null, sb.b[0], sb.b[1], sb.b[2]);
    }

    /** slice_out + smooth/morph/chaos — the 2-D cross-section, reader mode forced
     *  to `modeVal` (slice_out passes the card's mode + live; the triptych forces
     *  its treatment with live=0 so SMOOTH's trailing lag stays distinct). */
    function renderSlicePort(
      g: WebGL2RenderingContext,
      target: { fbo: WebGLFramebuffer; texture: WebGLTexture },
      modeVal: number,
      liveVal: number,
      sb: SliceBasis,
      anyContent: boolean,
    ): void {
      if (!progs) return;
      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      g.viewport(0, 0, mw, mh);
      g.useProgram(progs.slice);
      setVizCommon(g, uSlice, modeVal, liveVal, sb, anyContent);
      g.uniform1i(uSlice.sliceView ?? null, Math.round(clamp(params.slice_view, 0, 2)));
      ctx.drawFullscreenQuad();
      g.bindFramebuffer(g.FRAMEBUFFER, null);
    }

    /** depth_out — the intersection-depth heightmap (uses the card's reader mode +
     *  live, echoing the audio's rayDepth). */
    function renderDepthPort(
      g: WebGL2RenderingContext,
      target: { fbo: WebGLFramebuffer; texture: WebGLTexture },
      modeVal: number,
      liveVal: number,
      sb: SliceBasis,
      anyContent: boolean,
    ): void {
      if (!progs) return;
      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      g.viewport(0, 0, mw, mh);
      g.useProgram(progs.depth);
      setVizCommon(g, uDepth, modeVal, liveVal, sb, anyContent);
      g.uniform3f(uDepth.sliceN ?? null, sb.n[0], sb.n[1], sb.n[2]);
      g.uniform1i(uDepth.depthMarch ?? null, depthSteps);
      ctx.drawFullscreenQuad();
      g.bindFramebuffer(g.FRAMEBUFFER, null);
    }

    /** scope_out — the 256-sample surface-height wave (what audio_out plays)
     *  drawn as a trace. Reads the ALREADY-COMPUTED `lastWave` (no extra scan). */
    function renderScopePort(
      g: WebGL2RenderingContext,
      target: { fbo: WebGLFramebuffer; texture: WebGLTexture },
    ): void {
      if (!progs) return;
      const wave = lastWave;
      if (wave) {
        for (let i = 0; i < LUMA_COLS; i++) {
          const v = Math.max(0, Math.min(255, Math.round((clamp(wave[i] ?? 0, -1, 1) * 0.5 + 0.5) * 255)));
          const j = i * 4;
          waveScratch[j] = v; waveScratch[j + 1] = v; waveScratch[j + 2] = v; waveScratch[j + 3] = 255;
        }
        g.bindTexture(g.TEXTURE_2D, waveTex);
        g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, LUMA_COLS, 1, g.RGBA, g.UNSIGNED_BYTE, waveScratch);
      }
      g.bindFramebuffer(g.FRAMEBUFFER, target.fbo);
      g.viewport(0, 0, mw, mh);
      g.useProgram(progs.scope);
      g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, waveTex);
      g.uniform1i(uScope.wave ?? null, 0);
      g.uniform1f(uScope.hasWave ?? null, wave ? 1 : 0);
      ctx.drawFullscreenQuad();
      g.bindFramebuffer(g.FRAMEBUFFER, null);
    }

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
        const anyContent = captured.a || captured.b || captured.c;

        // PER-PORT gate (COLOUR OF MAGIC pattern): render ONLY the output ports
        // that drive a downstream consumer. `connected` undefined (older engine /
        // test mock) ⇒ render everything so no consumer ever goes dark; when the
        // engine reports connectivity, an UNPATCHED viz port renders NOTHING (its
        // pass is skipped entirely → zero GPU cost). The engine-owned set is
        // read-only; a fresh set is returned each call.
        const connected = frame.connectedOutputPorts?.(node.id);
        const wants = (portId: string): boolean => (connected ? connected.has(portId) : true);
        const outConnected = wants('video_out');

        // ── VOLUMETRIC RAY-MARCH → marchTarget (quarter res), upscale → outTarget
        //    (perf-gated on screen/patch). ──
        if (screenOn || outConnected) {
          g.bindFramebuffer(g.FRAMEBUFFER, marchTarget.fbo);
          g.viewport(0, 0, mw, mh);
          g.useProgram(progs.combine);
          g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex.a); g.uniform1i(uC.ringA ?? null, 0);
          g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex.b); g.uniform1i(uC.ringB ?? null, 1);
          g.activeTexture(g.TEXTURE2); g.bindTexture(g.TEXTURE_2D_ARRAY, ringTex.c); g.uniform1i(uC.ringC ?? null, 2);
          // newest fully-written layer = (head-1) mod N (avoid same-frame RAW hazard).
          g.uniform1i(uC.headA ?? null, (head.a - 1 + N) % N);
          g.uniform1i(uC.headB ?? null, (head.b - 1 + N) % N);
          g.uniform1i(uC.headC ?? null, (head.c - 1 + N) % N);
          g.uniform1i(uC.mode ?? null, mode);
          g.uniform1f(uC.live ?? null, live ? 1 : 0);
          g.uniform1f(uC.readerLag ?? null, VIDEOCUBE_READER_LAG);
          g.uniform1f(uC.hasContent ?? null, anyContent ? 1 : 0);
          g.uniform1i(uC.march ?? null, marchSteps);
          g.uniform1f(uC.spread ?? null, clamp(params.spread, 0, 1));
          g.uniform1i(uC.windowTaps ?? null, smoothTaps);
          g.uniform1f(uC.scan ?? null, clamp(params.scan, 0, 1));
          g.uniform1f(uC.morphFC ?? null, clamp(params.morph_fc, 0, 1));
          g.uniform1f(uC.connect ?? null, clamp(params.connect, 0, 1));
          g.uniform1f(uC.connectStr ?? null, clamp(params.connect_strength, 0, 1));
          g.uniform1f(uC.crush ?? null, clamp(params.crush, 0, 1));
          g.uniform1f(uC.spaceCrush ?? null, clamp(params.space_crush, 0, 1));
          g.uniform1f(uC.spaceDiffuse ?? null, clamp(params.space_diffuse, 0, 1));
          g.uniform1i(uC.diffuseAxis ?? null, lastDiffuseTarget.axis);
          g.uniform1f(uC.diffuseDir ?? null, lastDiffuseTarget.dir);
          g.uniform1f(uC.wrap ?? null, params.wrap >= 0.5 ? 1 : 0);
          g.uniform1f(uC.material ?? null, params.material >= 0.5 ? 1 : 0);
          setViewUniforms();
          ctx.drawFullscreenQuad();

          // LINEAR-upscale the quarter-res march into the half-res video_out.
          g.bindFramebuffer(g.FRAMEBUFFER, outTarget.fbo);
          g.viewport(0, 0, rw, rh);
          g.useProgram(progs.copy);
          g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, marchTarget.texture);
          g.uniform1i(uCopy.tex ?? null, 0);
          g.uniform1f(uCopy.has ?? null, 1);
          g.uniform2f(uCopy.tileScale ?? null, 1, 1);
          g.uniform2f(uCopy.tileOffset ?? null, 0, 0);
          ctx.drawFullscreenQuad();
          g.bindFramebuffer(g.FRAMEBUFFER, null);
        }

        // ── SLICE-VIZ ports (per-port gated). Each reads the SAME rings / plane /
        //    field as the combine above (heads not yet advanced this frame, so the
        //    viz surfaces the SAME temporal frame the ray-march did). An unpatched
        //    port is skipped ENTIRELY → zero GPU. slice_out honours the card's
        //    reader mode + live; the triptych forces its treatment (live off so
        //    SMOOTH's trailing lag stays visibly distinct from MORPH's newest). ──
        const vizWanted =
          wants('scope_out') || wants('slice_out') || wants('depth_out') ||
          wants('smooth_out') || wants('morph_out') || wants('chaos_out');
        if (vizWanted) {
          const sb = computeSliceBasis();
          if (wants('scope_out')) renderScopePort(g, scopeTarget);
          if (wants('slice_out')) renderSlicePort(g, sliceTarget, mode, live ? 1 : 0, sb, anyContent);
          if (wants('smooth_out')) renderSlicePort(g, smoothTarget, VIDEOCUBE_MODE_SMOOTH, 0, sb, anyContent);
          if (wants('morph_out')) renderSlicePort(g, morphTarget, VIDEOCUBE_MODE_MORPH, 0, sb, anyContent);
          if (wants('chaos_out')) renderSlicePort(g, chaosTarget, VIDEOCUBE_MODE_CHAOS, 0, sb, anyContent);
          if (wants('depth_out')) renderDepthPort(g, depthTarget, mode, live ? 1 : 0, sb, anyContent);
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

        // ── Derived AUDIO recompute (MANDELBULB seam) — the GPU readback + slice
        //    scan is THROTTLED to the ring-advance cadence, NEVER per frame (B2).
        //    A MODULATING CV writes a NEW value every frame (→ audioDirty every
        //    frame, → a fresh signature every frame), so the earlier sig-gate alone
        //    did NOT stop a per-frame readback+alloc storm under the headline use
        //    case. Coalesce here: recompute at most once per AUDIO_RECOMPUTE_EVERY
        //    frames. `sinceRecompute` is only reset when we actually recompute, so
        //    an IDLE module (nothing dirty, no ring advancing) lets it grow past
        //    the throttle → a later single knob tweak still fires next frame.
        if (oscNode) {
          sinceRecompute++;
          if (sinceRecompute >= AUDIO_RECOMPUTE_EVERY) {
            if (audioDirty) {
              // A slice/field/reader param moved (value-gated in setParam);
              // sig-gated inside recomputeSlice so a same-value CV is still a no-op.
              audioDirty = false;
              sinceRecompute = 0;
              recomputeSlice(false);
            } else if (ringsAdvanced) {
              // EVOLVING ring content — force a rescan (the heightfields changed
              // even though the params didn't), but only while a live ring advances.
              sinceRecompute = 0;
              recomputeSlice(true);
            }
          }
        }
      },
      resize(w, h) {
        for (const s of SLOTS) gl.deleteTexture(ringTex[s]);
        gl.deleteFramebuffer(outTarget.fbo); gl.deleteTexture(outTarget.texture);
        gl.deleteFramebuffer(marchTarget.fbo); gl.deleteTexture(marchTarget.texture);
        gl.deleteFramebuffer(reduceTarget.fbo); gl.deleteTexture(reduceTarget.texture);
        for (const t of [scopeTarget, sliceTarget, depthTarget, smoothTarget, morphTarget, chaosTarget]) {
          gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.texture);
        }
        rw = Math.max(1, Math.round(w * VIDEOCUBE_RENDER_SCALE));
        rh = Math.max(1, Math.round(h * VIDEOCUBE_RENDER_SCALE));
        mw = Math.max(1, Math.round(w * VIDEOCUBE_MARCH_SCALE));
        mh = Math.max(1, Math.round(h * VIDEOCUBE_MARCH_SCALE));
        for (const s of SLOTS) { ringTex[s] = createRingArray(gl, rw, rh, N); head[s] = 0; captured[s] = false; fileSlot[s] = false; }
        outTarget = createRingTarget(gl, rw, rh);
        marchTarget = createRingTarget(gl, mw, mh);
        reduceTarget = createRingTarget(gl, LUMA_COLS, FIELD_ROWS);
        scopeTarget = createRingTarget(gl, mw, mh);
        sliceTarget = createRingTarget(gl, mw, mh);
        depthTarget = createRingTarget(gl, mw, mh);
        smoothTarget = createRingTarget(gl, mw, mh);
        morphTarget = createRingTarget(gl, mw, mh);
        chaosTarget = createRingTarget(gl, mw, mh);
        for (const s of SLOTS) clearRingLayers(gl, ringFbo, ringTex[s], N, rw, rh);
        surface.fbo = outTarget.fbo;
        surface.texture = outTarget.texture;
        audioDirty = true;
      },
      dispose() {
        for (const s of SLOTS) gl.deleteTexture(ringTex[s]);
        gl.deleteFramebuffer(ringFbo);
        gl.deleteFramebuffer(outTarget.fbo); gl.deleteTexture(outTarget.texture);
        gl.deleteFramebuffer(marchTarget.fbo); gl.deleteTexture(marchTarget.texture);
        gl.deleteFramebuffer(reduceTarget.fbo); gl.deleteTexture(reduceTarget.texture);
        for (const t of [scopeTarget, sliceTarget, depthTarget, smoothTarget, morphTarget, chaosTarget]) {
          gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.texture);
        }
        gl.deleteTexture(emptyTex);
        gl.deleteTexture(waveTex);
        if (atlasScratch) { gl.deleteTexture(atlasScratch); atlasScratch = null; }
        if (progs) {
          gl.deleteProgram(progs.copy); gl.deleteProgram(progs.combine); gl.deleteProgram(progs.reduce);
          gl.deleteProgram(progs.scope); gl.deleteProgram(progs.slice); gl.deleteProgram(progs.depth);
        }
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
        // Per-port SLICE-VIZ textures — engine.lookupInput checks this BEFORE
        // surface.texture, so each viz output port resolves to its own FBO.
        if (key === 'outputTexture:scope_out') return scopeTarget.texture;
        if (key === 'outputTexture:slice_out') return sliceTarget.texture;
        if (key === 'outputTexture:depth_out') return depthTarget.texture;
        if (key === 'outputTexture:smooth_out') return smoothTarget.texture;
        if (key === 'outputTexture:morph_out') return morphTarget.texture;
        if (key === 'outputTexture:chaos_out') return chaosTarget.texture;
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
