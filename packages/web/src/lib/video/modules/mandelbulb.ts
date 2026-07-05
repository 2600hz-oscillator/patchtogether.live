// packages/web/src/lib/video/modules/mandelbulb.ts
//
// MANDELBULB — WebGL2 GLSL ray-marched 3D Mandelbulb fractal VIDEO source.
//
// A procedural video-engine module (sibling of MANDLEBLOT / ACIDWARP): a
// single full-screen-quad fragment shader ray-marches the Mandelbulb
// distance estimate, shades it with finite-difference normals + diffuse +
// Phong specular + soft shadows, and emits a `video_out` mono-video cross-
// domain port. EVERY spatial control is exposed BOTH as a card KNOB AND a
// CV input port (the user's explicit requirement: "zoom and spatial
// controls under cv and knobs").
//
// Algorithm references (translated to OUR raw WebGL2 — no Three.js dep):
//   - github.com/royvanrijn/mandelbulb.js (CPU raymarcher; POWER 8, ~20
//     fractal iterations, bailout 2.5, DE = 0.5*log(r)*r/dr come from it)
//   - sbcode.net/tsl/mandelbulb (Three.js TSL GPU version, for look/controls)
//
// The standard Mandelbulb DE (per-pixel, in the fragment shader):
//   for ~POWER-8, ~ITER fractal iterations:
//     r = length(z); if (r > BAILOUT) break;
//     theta = acos(z.z / r); phi = atan(z.y, z.x);
//     dr = pow(r, power-1) * power * dr + 1;
//     zr = pow(r, power);
//     theta *= power; phi *= power;
//     z = zr * vec3(sin(theta)cos(phi), sin(theta)sin(phi), cos(theta)) + pos;
//   distance = 0.5 * log(r) * r / dr;
// (jsDistanceEstimate below is the pure-TS port the unit suite exercises so
//  the algebra is verified outside GL, which jsdom can't render.)
//
// PERF (mirrors the CUBE v4 screen-off gate, adapted to a video-engine
// module): the heavy raymarch runs inside the module's draw(). When the
// SCRN toggle is OFF (`screen_on` param = 0) AND `video_out` is unpatched,
// draw() skips the raymarch entirely — the biggest perf win — while still
// keeping a valid (last-rendered or cleared) frame in the FBO. The engine
// passes `frame.isOutputConnected(nodeId)` so the module can detect a
// downstream consumer; absent (older test mocks) is treated as "connected"
// so the module never wrongly goes dark. A scene-dirty throttle skips the
// re-render when neither the params nor (for auto-spin) the clock moved.
//
// Output:
//   video_out (mono-video): the shaded Mandelbulb render (4:3, 640×480).
//
// Controls — EACH is a KNOB + a CV input port (zoom + spatial):
//   zoom      (zoom_cv)      camera dolly  0.3..3
//   rotate_x  (rotate_x_cv)  orbit pitch   -π..π
//   rotate_y  (rotate_y_cv)  orbit yaw     -π..π
//   power     (power_cv)     fractal power  1..12   (default 8)
//   detail    (detail_cv)    fractal iters  4..30   (default 20, discrete)
//   hue       (hue_cv)       palette shift  0..1
// View-only (no CV): autospin (toggle), screen_on (SCRN perf toggle).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { VIDEO_RES } from '$lib/video/engine';
// SINGLE SOURCE OF TRUTH for the Mandelbulb DE. The iteration math + bailout
// were moved to the DSP lib (packages/dsp/src/lib/mandelbulb-de.ts) so the
// bulb-slice readout + the mandelbulb-osc worklet share the EXACT same function
// the GLSL shader below mirrors. Imported via a RELATIVE path (not the
// `@patchtogether.live/dsp/src/...` alias) for the same reason cube.ts /
// bluebox.ts do: worktrees may not symlink the workspace package under
// node_modules, and the TS path-alias rules don't reliably resolve TS source
// out of node_modules/@patchtogether.live/dsp/src. RE-EXPORTED below so
// mandelbulb-math.test.ts's `./mandelbulb` import path still resolves them.
import {
  jsDistanceEstimate,
  MANDELBULB_BAILOUT,
} from '../../../../../dsp/src/lib/mandelbulb-de';
// Audio (slice → waveform) lib + worklet — used only when the `slice` toggle is
// ON. The DE move above keeps these and the GLSL shader algebra in lock-step.
import {
  mbSampleSlice,
  type MbSliceParams,
} from '../../../../../dsp/src/lib/mandelbulb-slice';
import mandelbulbOscWorkletUrl from '@patchtogether.live/dsp/dist/mandelbulb-osc.js?url';

// Re-export the DE reference + bailout so existing import paths
// (mandelbulb-math.test.ts → './mandelbulb') keep resolving them — the DE is
// now the DSP lib's single definition, just surfaced here for the GLSL-gen,
// the unit suite, and the camera-zoom helper that sit beside it.
export { jsDistanceEstimate, MANDELBULB_BAILOUT };

/**
 * Map the camera-zoom knob (0.3..3) to the eye distance from the bulb.
 * Larger zoom ⇒ closer eye ⇒ smaller distance. Base eye distance ~2.2
 * (per the references); zoom=1 reproduces it.
 */
export function jsEyeDistanceFromZoom(zoom: number): number {
  const z = Math.max(0.3, Math.min(3, zoom));
  return 2.2 / z;
}

// ----------------------------------------------------------------------
// Adaptive-quality render budget (CI software-GL feasibility, PR #561).
//
// The raymarch is the dominant per-frame cost AND its shader-link cost on
// software GL (Mesa/SwiftShader, e.g. CI runners with no GPU) is what was
// blocking the registry sweeps. Two levers keep both feasible:
//
//   1. RENDER_SCALE — render the bulb into a REDUCED-resolution FBO
//      (RENDER_W×RENDER_H) instead of the full 640×480; the engine's copy
//      shader (and the card preview's drawImage) upscale it with LINEAR
//      filtering. Fragment count scales with the square of the linear scale,
//      so 0.5 quarters the per-frame fragment-shader work — the biggest win.
//   2. Smaller step / shadow / iteration budgets in the shader below, so each
//      surviving fragment is cheaper too.
//
// The look stays acceptable (a 320×240 raymarch upscaled to a 200×150 card
// preview is visually indistinguishable; downstream video_out consumers get a
// LINEAR-upscaled 640×480 frame).
const RENDER_SCALE = 0.5;
const RENDER_W = Math.max(1, Math.round(VIDEO_RES.width * RENDER_SCALE));   // 320
const RENDER_H = Math.max(1, Math.round(VIDEO_RES.height * RENDER_SCALE));  // 240

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform vec2  uResolution;   // raymarch framebuffer res (reduced)
uniform float uEyeDist;      // camera distance from the bulb (post-zoom map)
uniform float uRotX;         // orbit pitch (radians)
uniform float uRotY;         // orbit yaw (radians)
uniform float uPower;        // fractal power (1..12, 8 = classic)
uniform float uIterations;   // fractal iteration budget (4..30)
uniform float uHue;          // palette shift 0..1

const float BAILOUT  = ${MANDELBULB_BAILOUT.toFixed(1)};
// Budgets trimmed for software-GL feasibility (PR #561). MAX_ITER caps the
// fractal loop (uIterations still gates it per-frame); MAX_STEP/shadow steps
// bound the raymarch. The look holds at the reduced render resolution.
const int   MAX_ITER = 16;     // upper bound for the fractal loop (uIterations gates it)
const int   MAX_STEP = 96;     // raymarch step budget
const float MAX_DIST  = 6.0;   // far plane
const float SURF_EPS  = 0.0016; // hit epsilon (~half-pixel at the reduced res)

// Mandelbulb distance estimate (mirrors jsDistanceEstimate in TS).
float mandelbulbDE(vec3 pos) {
  vec3 z = pos;
  float dr = 1.0;
  float r = 0.0;
  for (int i = 0; i < MAX_ITER; i++) {
    if (float(i) >= uIterations) break;
    r = length(z);
    if (r > BAILOUT) break;
    float theta = acos(z.z / r);
    float phi   = atan(z.y, z.x);
    dr = pow(r, uPower - 1.0) * uPower * dr + 1.0;
    float zr = pow(r, uPower);
    theta *= uPower;
    phi   *= uPower;
    float sinTheta = sin(theta);
    z = zr * vec3(sinTheta * cos(phi), sinTheta * sin(phi), cos(theta)) + pos;
  }
  return 0.5 * log(max(r, 1e-12)) * max(r, 1e-12) / dr;
}

// Finite-difference surface normal.
vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.0015, 0.0);
  return normalize(vec3(
    mandelbulbDE(p + e.xyy) - mandelbulbDE(p - e.xyy),
    mandelbulbDE(p + e.yxy) - mandelbulbDE(p - e.yxy),
    mandelbulbDE(p + e.yyx) - mandelbulbDE(p - e.yyx)
  ));
}

// Soft shadow march toward the light. Step budget trimmed (PR #561) — the
// shadow is a soft attenuation term, so a shorter march reads the same.
float softShadow(vec3 ro, vec3 rd) {
  float res = 1.0;
  float t = 0.02;
  for (int i = 0; i < 24; i++) {
    if (t > 3.0) break;
    float h = mandelbulbDE(ro + rd * t);
    if (h < 0.0016) return 0.0;
    res = min(res, 8.0 * h / t);
    t += clamp(h, 0.02, 0.2);
  }
  return clamp(res, 0.0, 1.0);
}

// hue (0..1) → RGB (compact HSV→RGB, full saturation + value).
vec3 hue2rgb(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  // Square-aspect uv centred at origin (divide by Y so X stretches with
  // the aspect ratio + the frame stays uncropped).
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

  // Orbit camera: spherical eye position around the bulb at uEyeDist.
  float cx = cos(uRotX), sx = sin(uRotX);
  float cy = cos(uRotY), sy = sin(uRotY);
  vec3 eye = uEyeDist * vec3(cy * cx, sx, sy * cx);
  // Build a look-at basis (target = origin).
  vec3 fwd = normalize(-eye);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);
  vec3 rd = normalize(uv.x * right + uv.y * up + 1.4 * fwd);
  vec3 ro = eye;

  // Raymarch.
  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < MAX_STEP; i++) {
    vec3 p = ro + rd * t;
    float d = mandelbulbDE(p);
    if (d < SURF_EPS) { hit = true; break; }
    t += d;
    if (t > MAX_DIST) break;
  }

  vec3 col;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 lightDir = normalize(vec3(0.6, 0.7, -0.4));
    float diff = max(dot(lightDir, n), 0.0);
    // Phong specular (exp ~35).
    vec3 viewDir = normalize(-rd);
    vec3 refl = reflect(-lightDir, n);
    float spec = pow(max(dot(viewDir, refl), 0.0), 35.0);
    float sh = softShadow(p + n * 0.002, lightDir);
    diff *= sh;
    // Brightness term b drives both shading + the iteration-count colour.
    float b = clamp(0.15 + diff, 0.0, 1.0);
    // Reference colour ramp from royvanrijn/mandelbulb.js:
    //   r = 10 + 380*b, g = 10 + 280*b, b = 180*b  (then normalize to 0..1)
    vec3 base = vec3(10.0 + 380.0 * b, 10.0 + 280.0 * b, 180.0 * b) / 255.0;
    // Fold in the HUE control as a tint rotation so the palette can shift.
    vec3 tint = hue2rgb(uHue);
    col = mix(base, base * (0.4 + 0.6 * tint) + tint * 0.15, 0.5);
    col += spec * sh * vec3(1.0);
  } else {
    // Sky / background from the ray direction — a subtle vertical gradient
    // tinted by the hue control (so the bg also responds to HUE).
    float sky = 0.5 + 0.5 * rd.y;
    vec3 skyTint = mix(vec3(0.02, 0.03, 0.06), 0.18 * hue2rgb(uHue) + 0.04, sky);
    col = skyTint;
  }

  // Gamma.
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  outColor = vec4(col, 1.0);
}`;

interface MandelbulbParams {
  zoom: number;       // 0.3..3   — camera dolly (mapped via jsEyeDistanceFromZoom)
  rotate_x: number;   // -π..π    — orbit pitch
  rotate_y: number;   // -π..π    — orbit yaw
  power: number;      // 1..12    — fractal power (8 = classic)
  detail: number;     // 4..30    — fractal iteration budget (discrete)
  hue: number;        // 0..1     — palette shift
  autospin: number;   // 0/1      — auto-rotate the yaw (view-only, discrete)
  screen_on: number;  // 0/1      — SCRN perf gate (view-only, discrete)
  // ── slice → waveform → audio (default OFF = byte-identical-to-today video) ──
  slice: number;      // 0/1      — SLICE toggle: OFF = video-only (no audio node);
                      //            ON = overlay the fixed-size slice + emit audio_out
  slice_y: number;    // fractal-space plane offset along its rotated normal
  slice_rx: number;   // -π..π    — slice plane Euler pitch
  slice_ry: number;   // -π..π    — slice plane Euler yaw
  slice_rz: number;   // -π..π    — slice plane Euler roll
}

const DEFAULTS: MandelbulbParams = {
  zoom: 1,
  rotate_x: 0.5,
  rotate_y: 0.6,
  power: 8,
  detail: 20,
  hue: 0.55,
  autospin: 1,
  screen_on: 1,
  // SLICE defaults OFF so spawning a MANDELBULB is byte-identical to today:
  // video-only, NO audio node created (see the factory's slice gate).
  slice: 0,
  slice_y: 0,
  slice_rx: 0,
  slice_ry: 0,
  slice_rz: 0,
};

/** Fractal-space half-extent of the slice_y knob's travel. The slice plane
 *  offset along its normal sweeps [-MB_SLICE_Y_RANGE, +MB_SLICE_Y_RANGE] so the
 *  plane can scan all the way through the bulb (which lives in |p| < ~1.2). */
export const MB_SLICE_Y_RANGE = 1.2;

export const MANDELBULB_DEFAULTS: Readonly<MandelbulbParams> = DEFAULTS;

/** Auto-spin yaw rate, radians/sec (the reference auto-rotates). */
export const AUTOSPIN_RATE = 0.25;

/**
 * Allocate an RGBA8 FBO + texture at an ARBITRARY size (the engine's
 * `ctx.createFbo()` is fixed at full engine res; MANDELBULB renders at a
 * REDUCED resolution for software-GL feasibility — see RENDER_SCALE). LINEAR
 * filtering so the engine's copy shader / the card's drawImage upscale the
 * reduced render smoothly. Throws on alloc failure (caller never catches —
 * a GL that can't make a 320×240 RGBA8 FBO can't run any video module).
 */
function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
  const tex = gl.createTexture();
  if (!tex) throw new Error('mandelbulb: createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  if (!fbo) {
    gl.deleteTexture(tex);
    throw new Error('mandelbulb: createFramebuffer failed');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
    throw new Error(`mandelbulb: framebuffer incomplete: 0x${status.toString(16)}`);
  }
  // Clear to opaque black so the very first frame (before the deferred shader
  // compile lands) reads as a clean black panel rather than garbage.
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texture: tex };
}

export const mandelbulbDef: VideoModuleDef = {
  type: 'mandelbulb',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'mandelbulb',
  category: 'sources',
  inputs: [
    // EVERY spatial / zoom control gets a CV input (user requirement).
    // Continuous targets carry a cvScale hint so a ±1 source sweeps the
    // full param range (see cv-bridge-map.ts).
    { id: 'zoom_cv',     type: 'cv', paramTarget: 'zoom',     cvScale: { mode: 'linear' } },
    { id: 'rotate_x_cv', type: 'cv', paramTarget: 'rotate_x', cvScale: { mode: 'linear' } },
    { id: 'rotate_y_cv', type: 'cv', paramTarget: 'rotate_y', cvScale: { mode: 'linear' } },
    { id: 'power_cv',    type: 'cv', paramTarget: 'power',    cvScale: { mode: 'linear' } },
    { id: 'detail_cv',   type: 'cv', paramTarget: 'detail',   cvScale: { mode: 'linear' } },
    { id: 'hue_cv',      type: 'cv', paramTarget: 'hue',      cvScale: { mode: 'linear' } },
    // SLICE spatial controls — knob + CV each (same convention as the camera
    // controls above). These drive the bulb-slice readout, NOT the camera, so a
    // ±1 CV sweeps the full plane offset / rotation range.
    { id: 'slice_y_cv',  type: 'cv', paramTarget: 'slice_y',  cvScale: { mode: 'linear' } },
    { id: 'slice_rx_cv', type: 'cv', paramTarget: 'slice_rx', cvScale: { mode: 'linear' } },
    { id: 'slice_ry_cv', type: 'cv', paramTarget: 'slice_ry', cvScale: { mode: 'linear' } },
    { id: 'slice_rz_cv', type: 'cv', paramTarget: 'slice_rz', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    // Mono-video cross-domain out (like CUBE.video_out / ACIDWARP.out).
    { id: 'video_out', type: 'mono-video' },
    // Mono AUDIO cross-domain out — the bulb-slice readout played as a wavetable
    // oscillator. The PORT is ALWAYS declared (so the handle-presence sweep pins
    // it), but it only carries SOUND when the `slice` toggle is ON: with slice
    // OFF the factory never creates the audio node, so audioSources has no entry
    // for this port and it stays silent (video output is byte-identical to
    // today). Cross-domain via VideoNodeHandle.audioSources (the DOOM pattern).
    { id: 'audio_out', type: 'audio' },
  ],
  params: [
    { id: 'zoom',      label: 'Zoom',  defaultValue: DEFAULTS.zoom,      min: 0.3,            max: 3,             curve: 'log' },
    { id: 'rotate_x',  label: 'Rot X', defaultValue: DEFAULTS.rotate_x,  min: -Math.PI,       max: Math.PI,       curve: 'linear' },
    { id: 'rotate_y',  label: 'Rot Y', defaultValue: DEFAULTS.rotate_y,  min: -Math.PI,       max: Math.PI,       curve: 'linear' },
    { id: 'power',     label: 'Power', defaultValue: DEFAULTS.power,     min: 1,              max: 12,            curve: 'linear' },
    { id: 'detail',    label: 'Detail',defaultValue: DEFAULTS.detail,    min: 4,              max: 30,            curve: 'discrete' },
    { id: 'hue',       label: 'Hue',   defaultValue: DEFAULTS.hue,       min: 0,              max: 1,             curve: 'linear' },
    { id: 'autospin',  label: 'Spin',  defaultValue: DEFAULTS.autospin,  min: 0,              max: 1,             curve: 'discrete' },
    { id: 'screen_on', label: 'Screen',defaultValue: DEFAULTS.screen_on, min: 0,              max: 1,             curve: 'discrete' },
    // SLICE toggle (discrete, default OFF) + the four slice-plane controls
    // (knob + CV each). slice_y travels ±MB_SLICE_Y_RANGE in FRACTAL units so
    // the plane scans through the whole bulb; rotations are the standard ±π.
    { id: 'slice',     label: 'Slice', defaultValue: DEFAULTS.slice,     min: 0,              max: 1,             curve: 'discrete' },
    { id: 'slice_y',   label: 'Y',     defaultValue: DEFAULTS.slice_y,   min: -MB_SLICE_Y_RANGE, max: MB_SLICE_Y_RANGE, curve: 'linear' },
    { id: 'slice_rx',  label: 'S Rot X',defaultValue: DEFAULTS.slice_rx, min: -Math.PI,       max: Math.PI,       curve: 'linear' },
    { id: 'slice_ry',  label: 'S Rot Y',defaultValue: DEFAULTS.slice_ry, min: -Math.PI,       max: Math.PI,       curve: 'linear' },
    { id: 'slice_rz',  label: 'S Rot Z',defaultValue: DEFAULTS.slice_rz, min: -Math.PI,       max: Math.PI,       curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "A WebGL2 ray-marched 3D Mandelbulb fractal source that doubles as an audio oscillator. A single full-screen-quad fragment shader marches the power-8 Mandelbulb distance estimate, shades the hit surface with finite-difference normals, diffuse + Phong specular and a soft shadow, tints it with the Hue palette, and emits the render on video_out (4:3, ray-marched internally at half engine resolution — 512x384 at the 1024x768 default — and LINEAR-upscaled). An orbit camera (Zoom dolly + Rot X pitch / Rot Y yaw) frames the bulb; Power morphs the fractal shape and Detail sets the iteration budget (higher = crisper, costlier). Turn SLICE on to bridge into audio: a fixed-size plane (camera-independent) is marched through the bulb's distance field to read its cross-section as a 256-sample wavetable, played as an oscillator on audio_out and shown as a second on-card readout with a draggable yellow select box. Usage: patch a slow LFO into rotate_y_cv (or just leave SPIN on) for a tumbling fractal, modulate power_cv for shape-morphing, and enable SLICE to play the bulb's geometry as an evolving waveform.",
    inputs: {
      zoom_cv: "Modulates Zoom: a linear-scaled CV dollies the orbit camera toward (higher) or away from the bulb over its 0.3..3 range; affects framing only, not the audio slice.",
      rotate_x_cv: "Modulates Rot X: linear CV sweeps the orbit camera's pitch over -pi..pi. Camera-only, so it never changes the slice waveform on audio_out.",
      rotate_y_cv: "Modulates Rot Y: linear CV sweeps the orbit camera's yaw over -pi..pi (added on top of any auto-spin). Camera-only; does not affect the audio slice.",
      power_cv: "Modulates Power: linear CV sweeps the fractal exponent over 1..12 (8 = classic bulb), morphing the whole shape. Power is shared by the picture AND the slice, so this also reshapes audio_out when SLICE is on.",
      detail_cv: "Modulates Detail: linear CV sweeps the fractal iteration budget over 4..30 (discrete). Higher = sharper surface detail at more cost; shared with the slice, so it also affects audio_out when SLICE is on.",
      hue_cv: "Modulates Hue: linear CV rotates the palette over 0..1, tinting both the lit surface and the sky background. Color only; no effect on geometry or the audio slice.",
      slice_y_cv: "Modulates the slice plane offset (Y): linear CV slides the readout plane along its rotated normal over +/-1.2 fractal units, scanning it through the whole bulb. Drives the audio_out waveform; no effect on the camera view.",
      slice_rx_cv: "Modulates the slice plane pitch (S Rot X): linear CV rotates the readout plane over -pi..pi about X, re-orienting which cross-section is scanned. Shapes audio_out; camera unaffected.",
      slice_ry_cv: "Modulates the slice plane yaw (S Rot Y): linear CV rotates the readout plane over -pi..pi about Y (this is also the horizontal axis of the on-card yellow select box). Shapes audio_out; camera unaffected.",
      slice_rz_cv: "Modulates the slice plane roll (S Rot Z): linear CV rotates the readout plane over -pi..pi about Z, spinning the scanned cross-section in its own plane. Shapes audio_out; camera unaffected.",
    },
    outputs: {
      video_out: "Mono-video out: the shaded Mandelbulb render (4:3, ray-marched at half engine resolution — 512x384 at the 1024x768 default — and LINEAR-upscaled to the engine output res). Always live; when SCRN is off AND this port is unpatched the raymarch is skipped to save performance.",
      audio_out: "Mono audio out: the bulb's slice cross-section played as a 256-sample wavetable oscillator. Silent unless the SLICE toggle is on (with SLICE off, no audio node exists); driven by the slice_y / slice_rx / slice_ry / slice_rz / Power / Detail controls.",
    },
    controls: {
      zoom: "Zoom (ZOOM knob): camera dolly, 0.3..3, log curve, default 1. Larger values map to a closer eye distance, framing the bulb tighter. Camera-only; does not change the audio slice.",
      rotate_x: "Rot X (ROT X knob): orbit camera pitch in radians, -pi..pi, default 0.5. Tilts the view up/down around the bulb. Camera-only.",
      rotate_y: "Rot Y (ROT Y knob): orbit camera yaw in radians, -pi..pi, default 0.6. Spins the view left/right; auto-spin adds to this value when SPIN is on. Camera-only.",
      power: "Power (POWER knob): fractal exponent, 1..12, default 8 (the classic Mandelbulb). Morphs the overall shape and lobe count; shared by both the render and the audio slice.",
      detail: "Detail (DETAIL knob): fractal iteration budget, 4..30, discrete, default 20. Higher resolves more surface detail at greater cost; shared by both the render and the audio slice (shader caps the loop at 16).",
      hue: "Hue (HUE knob): palette shift, 0..1, default 0.55. Rotates the HSV tint applied to the lit surface and the sky background. Color only.",
      autospin: "Spin (SPIN toggle): 0/1 discrete, default 1 (on). When on, continuously rotates the yaw at ~0.25 rad/sec, keeping the bulb tumbling (and the scene perpetually re-rendering). View-only, no CV.",
      screen_on: "Screen (SCRN toggle): 0/1 discrete, default 1 (on). Perf gate for the preview; when off AND video_out is unpatched the raymarch is skipped entirely and a flat 'SCREEN OFF' panel is shown. View-only, no CV.",
      slice: "Slice (SLICE toggle): 0/1 discrete, default 0 (off). Off = video-only with no audio node. On = reveals the slice-plane UI (yellow select box + 2D readout + slice knobs) and stands up the oscillator so audio_out carries the bulb's cross-section waveform.",
      slice_y: "Y (slice knob): slice plane offset along its rotated normal, +/-1.2 fractal units, linear, default 0 (centered on the bulb). Scans the readout plane through the whole bulb; drives the audio waveform. Also set by dragging the yellow box vertically.",
      slice_rx: "S Rot X (slice knob): slice plane pitch in radians, -pi..pi, linear, default 0. Re-orients which cross-section of the bulb is read out as audio. Slice-only; does not move the camera.",
      slice_ry: "S Rot Y (slice knob): slice plane yaw in radians, -pi..pi, linear, default 0. Re-orients the readout cross-section; also the horizontal axis of the on-card yellow select box. Slice-only.",
      slice_rz: "S Rot Z (slice knob): slice plane roll in radians, -pi..pi, linear, default 0. Spins the scanned cross-section within its own plane, reshaping the audio waveform. Slice-only.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    // ──────────────────────────────────────────────────────────────────
    // DEFERRED SHADER COMPILE (PR #561 — CI software-GL fix).
    //
    // Linking the heavy raymarch fragment shader is slow on software GL
    // (Mesa / SwiftShader — CI runners have no GPU): getProgramParameter(
    // LINK_STATUS) forces a synchronous compile that can take many seconds.
    // Doing it inside this factory blocked the SYNCHRONOUS reconcile path
    // (PatchEngine → VideoEngine.addNode → factory()), which in turn blocked
    // the main thread and starved Svelte's render — so the card's handles
    // never painted and the registry sweeps (io-spec-consistency,
    // per-module-per-port) timed out spawning the card.
    //
    // Fix: the factory does ONLY cheap work synchronously — allocate the
    // (reduced-res) FBO + texture so `surface.texture` is valid immediately
    // and the handle/card render right away. The expensive compileFragment +
    // uniform lookups are deferred to the FIRST draw(), which runs off rAF
    // and therefore never blocks the reconcile/render of the card's handles.
    // ──────────────────────────────────────────────────────────────────

    // Reduced-resolution render target (adaptive quality). Allocated eagerly
    // (cheap: a texImage2D + framebuffer alloc — no shader link), so the
    // engine's lookupInput / blitOutputToDrawingBuffer have a valid texture
    // from frame 0. The engine's copy shader + the card's drawImage upscale it.
    const { fbo, texture } = createRenderTarget(gl, RENDER_W, RENDER_H);

    let program: WebGLProgram | null = null;
    let glFailed = false;
    let uResolution: WebGLUniformLocation | null = null;
    let uEyeDist: WebGLUniformLocation | null = null;
    let uRotX: WebGLUniformLocation | null = null;
    let uRotY: WebGLUniformLocation | null = null;
    let uPower: WebGLUniformLocation | null = null;
    let uIterations: WebGLUniformLocation | null = null;
    let uHue: WebGLUniformLocation | null = null;

    /** Lazily compile+link the raymarch program on the first draw. Returns
     *  false if compile is unavailable/failed (engine then leaves the FBO at
     *  its cleared init — a black frame — instead of crashing the loop). */
    function ensureProgram(): boolean {
      if (program) return true;
      if (glFailed) return false;
      try {
        program = ctx.compileFragment(FRAG_SRC);
      } catch {
        glFailed = true;
        return false;
      }
      uResolution = gl.getUniformLocation(program, 'uResolution');
      uEyeDist    = gl.getUniformLocation(program, 'uEyeDist');
      uRotX       = gl.getUniformLocation(program, 'uRotX');
      uRotY       = gl.getUniformLocation(program, 'uRotY');
      uPower      = gl.getUniformLocation(program, 'uPower');
      uIterations = gl.getUniformLocation(program, 'uIterations');
      uHue        = gl.getUniformLocation(program, 'uHue');
      return true;
    }

    const params: MandelbulbParams = { ...DEFAULTS, ...(node.params as Partial<MandelbulbParams>) };

    // Auto-spin accumulator + scene-dirty throttle state.
    let spinPhase = 0;
    let lastTime = -1;
    let lastSceneSig = '';
    let renderedOnce = false;

    // ──────────────────────────────────────────────────────────────────
    // SLICE → WAVEFORM → AUDIO (default OFF; the DOOM audioSources bridge).
    //
    // When the `slice` toggle is ON we run the bulb-slice readout
    // (mbSampleSlice — fixed-size, camera-independent) on the MAIN thread
    // whenever a slice-shaping param changes (recompute-on-change, NOT per
    // audio sample — the bulb DE is expensive), post the 256-sample waveform to
    // the mandelbulb-osc worklet, and expose that worklet as the `audio_out`
    // audio source. When slice is OFF we never create the audio node at all, so
    // the video render path is byte-identical to today (the backwards-compat
    // guarantee). The chain is set up LAZILY the first time slice goes ON.
    //
    // audioSources is published only AFTER the (async) worklet module loads;
    // notifyAudioSourcesChanged re-resolves any audio bridge that was wired
    // before the node existed (the same swap-and-notify dance VIDEOBOX uses).
    // ──────────────────────────────────────────────────────────────────
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let oscNode: AudioWorkletNode | null = null;
    let oscGain: GainNode | null = null;          // published in audioSources (stable identity)
    let oscSilence: ConstantSourceNode | null = null; // keeps the worklet's process() alive
    let oscLoadStarted = false;
    let lastSliceSig = '';

    /** Read the live slice-shaping params (knob value here; CV is summed into the
     *  AudioParam in CUBE, but MANDELBULB's slice math runs on the main thread,
     *  so we read the engine-resolved param via setParam-tracked `params`). */
    function recomputeSlice(force = false): void {
      if (!oscNode) return;
      const sp: MbSliceParams = {
        sliceY: params.slice_y,
        rx: params.slice_rx,
        ry: params.slice_ry,
        rz: params.slice_rz,
        power: Math.max(1, Math.min(12, params.power)),
        iters: Math.max(4, Math.min(30, Math.round(params.detail))),
      };
      // Quantize so float jitter doesn't churn the (expensive) scan every call.
      const q = (v: number) => Math.round(v * 1000);
      const sig = `${q(sp.sliceY)}|${q(sp.rx)}|${q(sp.ry)}|${q(sp.rz)}|${q(sp.power)}|${sp.iters}`;
      if (!force && sig === lastSliceSig) return;
      lastSliceSig = sig;
      const wave = mbSampleSlice(sp);
      try {
        oscNode.port.postMessage({ type: 'setWave', wave }, [wave.buffer]);
      } catch {
        // Transfer can fail in some shims — fall back to a structured-clone post.
        try { oscNode.port.postMessage({ type: 'setWave', wave: mbSampleSlice(sp) }); } catch { /* */ }
      }
    }

    /** Lazily stand up the audio chain the first time slice is ON. No-op if
     *  there's no AudioContext (jsdom / video engine running standalone) or if
     *  it has already been set up. */
    function ensureAudio(): void {
      const ac = ctx.audioCtx;
      if (!ac || oscLoadStarted) return;
      oscLoadStarted = true;
      // Persistent GainNode published up front (stable identity so a bridge
      // wired before the worklet loads captures THIS node and lights up
      // retroactively once we connect the worklet into it).
      oscGain = ac.createGain();
      oscGain.gain.value = 1;
      audioSources.set('audio_out', { node: oscGain, output: 0 });
      void (async () => {
        try {
          await ac.audioWorklet.addModule(mandelbulbOscWorkletUrl);
          const n = new AudioWorkletNode(ac, 'mandelbulb-osc', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          });
          oscNode = n;
          if (oscGain) n.connect(oscGain);
          // Keep the worklet's process() running even with nothing patched into
          // a (future) pitch input — Chromium prunes an orphan worklet. A
          // gain(0) → destination keep-alive (the DOOM/videobox pattern).
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
          // Push the initial slice immediately + re-resolve any pre-wired bridge.
          recomputeSlice(true);
          ctx.notifyAudioSourcesChanged?.(node.id);
        } catch {
          // Worklet load failed (CSP / missing dist) — audio_out stays silent;
          // the placeholder gain remains so the bridge contract holds.
        }
      })();
    }

    // Set up audio at construction ONLY if slice is already ON (e.g. a reloaded
    // patch). Slice OFF on spawn ⇒ no audio node is ever created → video
    // identity. A later toggle ON (setParam) calls ensureAudio().
    if (params.slice >= 0.5) ensureAudio();

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;

        // --- tick auto-spin ---
        const tNow = frame.time;
        const dt = lastTime < 0 ? 0 : Math.max(0, tNow - lastTime);
        lastTime = tNow;
        const spinning = params.autospin >= 0.5;
        if (spinning) spinPhase += dt * AUTOSPIN_RATE;

        // --- PERF gate (mirrors CUBE v4 screen-off gate) ---
        // Skip the raymarch when SCRN is OFF *and* video_out is unpatched.
        // isOutputConnected is optional (older engine/test mocks omit it);
        // when absent, assume connected so the module never wrongly blanks.
        const screenOn = params.screen_on >= 0.5;
        const outConnected = frame.isOutputConnected
          ? frame.isOutputConnected(node.id)
          : true;
        if (!screenOn && !outConnected) {
          // Render nothing this frame — leave the FBO holding whatever it
          // last had (or its cleared init). Biggest perf win at idle, AND it
          // keeps the (slow) shader compile deferred for as long as the bulb
          // is never actually displayed.
          return;
        }

        // Lazily compile the raymarch program on the first frame we actually
        // need to draw (NOT in the synchronous factory — see the block above).
        if (!ensureProgram() || !program) return;

        // Resolve shader inputs from the live params.
        const eyeDist = jsEyeDistanceFromZoom(params.zoom);
        const rotX = params.rotate_x;
        const rotY = params.rotate_y + (spinning ? spinPhase : 0);
        const power = Math.max(1, Math.min(12, params.power));
        const iter = Math.max(4, Math.min(30, Math.round(params.detail)));
        const hue = ((params.hue % 1) + 1) % 1;

        // --- scene-dirty throttle: skip the re-render when nothing the
        //     picture depends on changed since the last rendered frame.
        //     Auto-spin keeps the scene perpetually dirty (rotY moves), so
        //     a spinning bulb always re-renders; a parked bulb idles. ---
        const q = (v: number) => Math.round(v * 1000);
        const sceneSig =
          `${q(eyeDist)}|${q(rotX)}|${q(rotY)}|${q(power)}|${iter}|${q(hue)}`;
        if (renderedOnce && sceneSig === lastSceneSig) return;
        lastSceneSig = sceneSig;

        g.useProgram(program);
        // uResolution drives the per-pixel aspect; it must match the REDUCED
        // render size (RENDER_W×RENDER_H), not the engine's full res.
        g.uniform2f(uResolution, RENDER_W, RENDER_H);
        g.uniform1f(uEyeDist, eyeDist);
        g.uniform1f(uRotX, rotX);
        g.uniform1f(uRotY, rotY);
        g.uniform1f(uPower, power);
        g.uniform1f(uIterations, iter);
        g.uniform1f(uHue, hue);

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, RENDER_W, RENDER_H);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        renderedOnce = true;
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        if (program) gl.deleteProgram(program);
      },
    };

    // Params that change the bulb-slice waveform (so a fresh scan must run).
    // The camera params (zoom / rotate_x / rotate_y / hue) are deliberately
    // ABSENT — the slice is camera-independent, so orbiting/zooming the view
    // never re-renders the audio (the fixed-size-under-zoom guarantee).
    const SLICE_PARAMS = new Set([
      'slice_y', 'slice_rx', 'slice_ry', 'slice_rz', 'power', 'detail',
    ]);

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
          // Any param change re-dirties the scene so the throttle re-renders.
          lastSceneSig = '';
          // SLICE toggle ON ⇒ lazily stand up the audio chain (no-op if already
          // up, or if there's no AudioContext). It is never torn down on OFF —
          // the worklet just keeps playing the last wave at gain through the
          // bridge; with no bridge wired it is inaudible. The "no audio node on
          // a slice-OFF spawn" guarantee is about CONSTRUCTION, which the
          // `params.slice >= 0.5` gate above honours.
          if (paramId === 'slice' && value >= 0.5) ensureAudio();
          // A slice-shaping param moved ⇒ recompute + repost the waveform (only
          // matters once the audio chain exists; recomputeSlice no-ops if not).
          if (SLICE_PARAMS.has(paramId)) recomputeSlice();
        }
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'eyeDist') return jsEyeDistanceFromZoom(params.zoom);
        if (key === 'screenOn') return params.screen_on >= 0.5;
        if (key === 'autospin') return params.autospin >= 0.5;
        if (key === 'slice') return params.slice >= 0.5;
        return undefined;
      },
      dispose() {
        surface.dispose();
        // Tear down the audio chain (if it was ever created).
        if (oscSilence) { try { oscSilence.stop(); } catch { /* */ } try { oscSilence.disconnect(); } catch { /* */ } }
        if (oscNode) { try { oscNode.disconnect(); } catch { /* */ } }
        if (oscGain) { try { oscGain.disconnect(); } catch { /* */ } }
        oscSilence = null; oscNode = null; oscGain = null;
      },
    };
  },
};
