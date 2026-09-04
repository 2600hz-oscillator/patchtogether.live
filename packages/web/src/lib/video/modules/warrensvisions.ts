// packages/web/src/lib/video/modules/warrensvisions.ts
//
// WARREN'S VISIONS — a 2D SPECTRAL VIDEO RESYNTHESIZER.
//
// The visual analogue of WARREN'S SPECTRUM (`packages/web/src/lib/audio/
// modules/warrensspectrum.ts`). The algorithm lives in the pure, unit-tested
// core (`$lib/video/warrensvisions-core`); this file is the WebGL wiring.
//
// ── EXECUTION MODEL — the SOURCERY pattern ────────────────────────────────
//   GPU   a 9-tap box downsample of the input to WV_GRID×WV_GRID luma
//   CPU   ONE readPixels off that small FBO, every SLICE frames, then the
//         pure core: 2D FFT → peaks → salience → lattice lock → track match
//         → COHERENCE servo → residual rings
//   CPU   EVERY frame: advance envelopes and phase, rebuild the sparse
//         spectrum (components + SHAPE harmonics + ring-weighted residual),
//         ONE inverse 2D FFT into a WV_GRID² float plane
//   GPU   EVERY frame: upload that plane, upsample it, undo the analysis
//         window, recombine with the source's chroma, MIX against the source
//
// The reconstruction is band-limited to the analysis grid BY CONSTRUCTION, so
// every cost above is independent of the output resolution. That is the
// property that makes the module affordable on a software renderer, and it is
// why the design is not the one it looks like it should be — see below.
//
// ── WHAT WAS MEASURED, AND WHAT IT CHANGED ────────────────────────────────
//
// All four figures below are browser measurements taken before this file was
// written, on an M5 (ANGLE Metal) and under `--use-angle=swiftshader` (what
// CI runs), at 1280×720. The GPU legs are timed by running N draws and then
// reading one pixel back FROM THE DRAWN FBO: `gl.finish()` does not
// synchronise under ANGLE/Metal here (a 400-iteration texture loop timed
// 0.0000 ms/call with it), and a sync on the DEFAULT framebuffer does not
// either. A deliberately heavy shader is kept as the control — it reads 8.6 ms
// against a 0.047 ms passthrough on the GPU and 674 ms against 1.80 ms on
// SwiftShader, which is what makes the rest of the numbers believable.
//
//   leg                                    real GPU      SwiftShader
//   ────────────────────────────────────  ──────────    ────────────
//   CPU analyse (FFT+peaks+match, 256)      0.75 ms        0.70 ms
//   CPU synthesise (sparse + inverse FFT)   0.40 ms        0.38 ms
//   CPU whole frame, SLICE 1                1.20 ms        1.11 ms
//   readPixels 128² RGBA8 (alone)           0.38 ms        0.05 ms
//   downsample + readPixels                 1.13 ms        0.14 ms
//   full-res passthrough (the floor)        0.047 ms       1.80 ms
//   composite, bicubic                      ~1.3 ms       ~11.6 ms
//   composite, bilinear                     ~0.9 ms        ~4.2 ms
//
// THREE THINGS THAT CHANGED THE DESIGN:
//
// 1. THE RESIDUAL IS NOT A SHADER. The obvious implementation — 16 rings of
//    screen-space value noise — measured 12.4 ms per frame on SwiftShader ON
//    TOP OF everything else, more than the whole rest of the module. Moving
//    it into the spectral domain (ring-weighted random phase added to the
//    sparse spectrum before the inverse FFT we are already doing) costs
//    ~0.05 ms of CPU and nothing at all on the GPU, and it is the more
//    faithful port besides: the audio engine band-passes noise at 16 log
//    bands, which IS a spectral operation. The honest cost is that the
//    residual cannot carry detail finer than the grid — it does foliage,
//    smoke and boil, and it does not do fine film grain.
//
// 2. THERE IS NO GPU INVERSE FFT. A 14-pass ping-pong at 128² measured
//    0.6–0.95 ms on the GPU and 1.92 ms on SwiftShader — both perfectly
//    affordable, and both SLOWER than the 0.40 ms the CPU takes to do the
//    whole synthesis including the sparse build. It would also have pulled
//    float FBOs into the critical path for no gain. The pass count was never
//    the problem; it was just the wrong place to do the work.
//
// 3. INTERPOLATION IS RENDERER-GATED. Bicubic costs ~1.3 ms on a real GPU and
//    ~11.6 ms on SwiftShader — 6.5× the passthrough floor, on its own. The
//    repo already has this exact pattern (videocube's `detectMarchSteps`,
//    frametable's `detectSmoothTaps`), so software renderers get hardware
//    bilinear at ~2.3× the floor and real GPUs get the sharp path.
//
// ⚠ readPixels is CHEAPER on SwiftShader (0.05 ms) than on a real GPU
//   (0.38 ms), because there is no GPU/CPU boundary to synchronise across.
//   The readback stall this design was warned about is a real-GPU concern and
//   not a CI one, and at SLICE ≥ 2 it is paid every other frame at worst. No
//   PBO fence pipeline was built: there is no measured stall to justify one.
//
// ── HONEST v1 LIMITATIONS ─────────────────────────────────────────────────
//   * ONE INSTANCE (`maxInstances: 1`). The palette hides the module once one
//     exists, so the cap is visible rather than a silent failure. Two
//     instances would be ~2.4 ms of extra CPU per frame and have not been
//     measured together.
//   * LUMA ONLY. The resynthesis reconstructs luminance and recombines the
//     SOURCE's chroma. Full per-channel spectral tracking is a later step, so
//     colour follows the source even when the geometry does not.
//   * The analysis grid is SQUARE while the frame is not, so a wavevector's
//     orientation is in grid space, not screen space; a 45° pattern on a 16:9
//     frame analyses as a non-45° wavevector. Self-consistent, since synthesis
//     maps back through the same grid.
//   * The outer ~12 % of each axis is under-compensated for the analysis
//     window and fades toward flat (see `WV_TAPER_FLOOR`).
//   * MASSPASS, the editable post-filterbank, independent RGB tracking and a
//     256² grid are all deliberately out of scope for v1.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  WarrensVisionsEngine,
  WV_GRID,
  WV_MAX_COMPONENTS,
  WV_COMPONENTS_MIN,
  WV_FLOOR_MIN_DB,
  WV_FLOOR_MAX_DB,
  WV_STABILITY_MIN,
  WV_STABILITY_MAX,
  WV_SLEW_MIN_S,
  WV_SLEW_MAX_S,
  WV_SLICE_MIN_FRAMES,
  WV_SLICE_MAX_FRAMES,
  WV_CENTER_MIN_CENTS,
  WV_CENTER_MAX_CENTS,
  WV_TUKEY_TAPER,
  WV_TAPER_FLOOR,
} from '$lib/video/warrensvisions-core';

// ─────────────────────────── params ───────────────────────────

/**
 * Declared ranges live HERE and nowhere else — the card imports them rather
 * than re-typing the numbers (CLAUDE.md: "a control's range must come from
 * ONE place"). Every bound is re-exported from the core, so the engine's
 * clamp and the knob's travel cannot disagree.
 */
export const WARRENSVISIONS_RANGES = {
  visionsComponents: { min: WV_COMPONENTS_MIN, max: WV_MAX_COMPONENTS, defaultValue: 64 },
  visionsCoherence: { min: 0, max: 1, defaultValue: 1 },
  visionsFloor: { min: WV_FLOOR_MIN_DB, max: WV_FLOOR_MAX_DB, defaultValue: -42 },
  visionsStability: { min: WV_STABILITY_MIN, max: WV_STABILITY_MAX, defaultValue: 3 },
  visionsSlew: { min: WV_SLEW_MIN_S, max: WV_SLEW_MAX_S, defaultValue: 0.25 },
  visionsSlice: { min: WV_SLICE_MIN_FRAMES, max: WV_SLICE_MAX_FRAMES, defaultValue: 2 },
  visionsResidual: { min: 0, max: 2, defaultValue: 0.5 },
  visionsShape: { min: 0, max: 1, defaultValue: 0 },
  visionsCenter: { min: WV_CENTER_MIN_CENTS, max: WV_CENTER_MAX_CENTS, defaultValue: 0 },
  visionsDrift: { min: 0, max: 1, defaultValue: 0 },
  visionsMix: { min: 0, max: 1, defaultValue: 1 },
  engineFreeze: { min: 0, max: 1, defaultValue: 0 },
} as const satisfies Record<string, { min: number; max: number; defaultValue: number }>;

type WvParamId = keyof typeof WARRENSVISIONS_RANGES;

const DEFAULTS = Object.fromEntries(
  Object.entries(WARRENSVISIONS_RANGES).map(([k, v]) => [k, v.defaultValue]),
) as Record<WvParamId, number>;

const PARAM_IDS = new Set(Object.keys(WARRENSVISIONS_RANGES));

/** `read()` keys the e2e and the card poll. */
export const WARRENSVISIONS_READ_KEYS = {
  committedFrames: 'committedFrames',
  framesElapsed: 'framesElapsed',
  liveComponents: 'liveComponents',
  hasInput: 'hasInput',
  smoothPath: 'smoothPath',
  fieldRange: 'fieldRange',
} as const;

// ─────────────────────────── shaders ───────────────────────────

/**
 * Downsample to the analysis grid. A single bilinear tap at 10× reduction
 * aliases badly enough to invent wavevectors that are not in the source, so
 * this is a 3×3 box over the source's own texel spacing.
 */
const LUMA_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform float uHasSrc;
out vec4 outColor;
void main() {
  if (uHasSrc < 0.5) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 acc = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      acc += texture(uSrc, vUv + vec2(float(i), float(j)) * uSrcTexel * 3.0).rgb;
    }
  }
  float y = dot(acc / 9.0, vec3(0.2126, 0.7152, 0.0722));
  outColor = vec4(y, y, y, 1.0);
}`;

/**
 * Composite. `SMOOTH` is substituted with 1 (bicubic) or 0 (hardware
 * bilinear) at compile time from the renderer probe, so the software path
 * carries no dead branch.
 */
const compositeFrag = (smooth: boolean): string => `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uField;
uniform vec2 uGrid;
uniform float uMix;
uniform float uHasSrc;
uniform float uDc;
out vec4 outColor;

const float TAPER = float(${WV_TUKEY_TAPER});
const float TAPER_FLOOR = float(${WV_TAPER_FLOOR});

${
  smooth
    ? `
vec4 cubicW(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  float w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}
float sampleField(vec2 uv) {
  vec2 c = uv * uGrid - 0.5;
  vec2 f = fract(c);
  c -= f;
  vec4 xw = cubicW(f.x);
  vec4 yw = cubicW(f.y);
  vec4 pos = c.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xw.xz + xw.yw, yw.xz + yw.yw);
  vec4 off = (pos + vec4(xw.yw, yw.yw) / s) / uGrid.xxyy;
  float a = texture(uField, off.xz).r;
  float b = texture(uField, off.yz).r;
  float cc = texture(uField, off.xw).r;
  float d = texture(uField, off.yw).r;
  float sx = s.x / (s.x + s.y);
  float sy = s.z / (s.z + s.w);
  return mix(mix(d, cc, sx), mix(b, a, sx), sy);
}`
    : `
float sampleField(vec2 uv) { return texture(uField, uv).r; }`
}

// The separable Tukey the analysis applied, evaluated analytically so the
// reconstruction can be divided back out. Floored so the corners, where the
// window reaches zero, do not explode.
float taper1(float t) {
  if (t < TAPER) return 0.5 * (1.0 - cos(3.14159265 * t / TAPER));
  if (t > 1.0 - TAPER) return 0.5 * (1.0 - cos(3.14159265 * (1.0 - t) / TAPER));
  return 1.0;
}

void main() {
  vec3 src = uHasSrc > 0.5 ? texture(uSrc, vUv).rgb : vec3(0.0);
  float field = sampleField(vUv);
  float w = max(TAPER_FLOOR, taper1(vUv.x) * taper1(vUv.y));
  float y = uDc + (field - uDc) / w;
  float srcY = dot(src, vec3(0.2126, 0.7152, 0.0722));
  vec3 resynth = clamp(vec3(y) + (src - vec3(srcY)), 0.0, 1.0);
  outColor = vec4(mix(src, resynth, clamp(uMix, 0.0, 1.0)), 1.0);
}`;

/**
 * Is this a software rasterizer? The established repo probe (videocube
 * `detectMarchSteps`, frametable `detectSmoothTaps`). A MASKED renderer
 * string is treated as hardware — the same default those two take, on the
 * grounds that a masked string is far more often a privacy setting on a real
 * GPU than SwiftShader in disguise.
 */
function isSoftwareRenderer(gl: WebGL2RenderingContext): boolean {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (!dbg) return false;
    const name = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '');
    return /swiftshader|software|llvmpipe|basic render/i.test(name);
  } catch {
    return false;
  }
}

/** Can a float texture be sampled with LINEAR? The toybox pattern. */
function floatLinearOk(gl: WebGL2RenderingContext): boolean {
  try {
    return gl.getExtension('OES_texture_float_linear') != null;
  } catch {
    return false;
  }
}

// ─────────────────────────── def ───────────────────────────

export const warrensvisionsDef: VideoModuleDef = {
  type: 'warrensvisions',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: "warren's visions",
  category: 'video-effects',
  // ⚠ ONE at a time, deliberately, and enforced where the user can SEE it:
  // ModulePalette drops any def at its cap, so the module disappears from the
  // palette rather than spawning a second instance that quietly halves the
  // frame rate. Raise it when two instances have been measured together.
  maxInstances: 1,

  inputs: [
    { id: 'video_in', type: 'video' },
    // FREEZE while HIGH — level-sensitive by design, exactly as the audio
    // module's FREEZE gate is, so it is declared `edge: 'gate'` and read as a
    // level rather than edge-detected.
    { id: 'gate', type: 'gate', edge: 'gate', label: 'FREEZE', paramTarget: 'engineFreeze' },
    { id: 'components_cv', type: 'cv', paramTarget: 'visionsComponents', cvScale: { mode: 'linear' } },
    { id: 'coherence_cv', type: 'cv', paramTarget: 'visionsCoherence', cvScale: { mode: 'linear' } },
    { id: 'residual_cv', type: 'cv', paramTarget: 'visionsResidual', cvScale: { mode: 'linear' } },
    { id: 'shape_cv', type: 'cv', paramTarget: 'visionsShape', cvScale: { mode: 'linear' } },
    { id: 'center_cv', type: 'cv', paramTarget: 'visionsCenter', cvScale: { mode: 'linear' } },
    { id: 'drift_cv', type: 'cv', paramTarget: 'visionsDrift', cvScale: { mode: 'linear' } },
    { id: 'mix_cv', type: 'cv', paramTarget: 'visionsMix', cvScale: { mode: 'linear' } },
  ],
  outputs: [{ id: 'out', type: 'video' }],

  params: [
    // COHERENCE first: it is the control that changes the module's identity,
    // and no other control on it moves more.
    {
      id: 'visionsCoherence',
      label: 'Coherence',
      ...WARRENSVISIONS_RANGES.visionsCoherence,
      curve: 'linear',
    },
    {
      id: 'visionsComponents',
      label: 'Components',
      ...WARRENSVISIONS_RANGES.visionsComponents,
      curve: 'discrete',
    },
    { id: 'visionsFloor', label: 'Floor', ...WARRENSVISIONS_RANGES.visionsFloor, curve: 'linear', units: 'dB' },
    {
      id: 'visionsStability',
      label: 'Stability',
      ...WARRENSVISIONS_RANGES.visionsStability,
      curve: 'discrete',
      units: 'fr',
    },
    { id: 'visionsSlew', label: 'Slew', ...WARRENSVISIONS_RANGES.visionsSlew, curve: 'log', units: 's' },
    { id: 'visionsSlice', label: 'Slice', ...WARRENSVISIONS_RANGES.visionsSlice, curve: 'discrete', units: 'fr' },
    { id: 'visionsResidual', label: 'Residual', ...WARRENSVISIONS_RANGES.visionsResidual, curve: 'linear' },
    {
      id: 'visionsShape',
      label: 'Shape',
      ...WARRENSVISIONS_RANGES.visionsShape,
      curve: 'linear',
      landmarks: [
        { value: 0, label: 'SINE' },
        { value: 0.5, label: 'SAW' },
        { value: 1, label: 'SQUARE' },
      ],
    },
    { id: 'visionsCenter', label: 'Center', ...WARRENSVISIONS_RANGES.visionsCenter, curve: 'linear', units: 'ct' },
    { id: 'visionsDrift', label: 'Drift', ...WARRENSVISIONS_RANGES.visionsDrift, curve: 'linear' },
    { id: 'visionsMix', label: 'Mix', ...WARRENSVISIONS_RANGES.visionsMix, curve: 'linear' },
    {
      id: 'engineFreeze',
      label: 'Freeze',
      ...WARRENSVISIONS_RANGES.engineFreeze,
      curve: 'discrete',
      options: [
        { value: 0, label: 'LIVE', title: 'Keep analysing the incoming frame' },
        { value: 1, label: 'FREEZE', title: 'Hold the current components — the picture drones on them' },
      ],
    },
  ],

  docs: {
    explanation:
      "warren's visions is the visual analogue of warren's spectrum: a spectral resynthesizer that takes a picture apart into a bank of 2D sine gratings and rebuilds it out of them. Every SLICE frames it downsamples whatever is patched into VIDEO IN to a 128x128 luma plane, runs a 2D FFT over it, and picks the strongest peaks in the wavevector plane. A peak is a grating: its distance from the origin is how FINE the pattern is, its angle is the pattern's ORIENTATION, its magnitude is CONTRAST, and its phase is WHERE the pattern sits. Peaks are ranked by SALIENCE, matched frame to frame as tracks (so a slowly-changing pattern is one component that moves rather than a new one every frame), and everything the tracker does NOT claim is measured as energy in 16 log-spaced rings and replayed as procedural texture — the residual that puts the grain, foliage and smoke back. The whole bank is then summed back into a picture and composited against the source. COHERENCE is the control the module exists for: at 1 every component's phase is re-seated on the phase measured in the incoming frame, so the sum is a genuine sparse reconstruction and you see a recognisable, band-limited version of the source; at 0 phase is seated once when a component is born and then free-runs, which is exactly what the audio module\'s oscillators do and which drifts the picture off into a moving interference painting with the source's spectrum and none of its geometry; in between the picture assembles and melts. COMPONENTS sets how many gratings the bank has (1-256) and therefore how much of the picture survives; FLOOR and STABILITY gate which peaks earn a slot; SLEW smears contrast in time; DRIFT gives each component its own phase velocity so the reconstruction boils; SHAPE morphs every grating sine->saw->square by injecting its harmonics; CENTER transposes every wavevector, zooming the whole reconstruction in or out; FREEZE (control or GATE input) holds the current components as a still. It resynthesizes LUMA and keeps the source's colour, so chroma follows the input even when the geometry does not. It is an EFFECT: with nothing patched into VIDEO IN the output is black. One instance at a time. Usage: patch a camera or clip in, leave COHERENCE at 1 and pull COMPONENTS down until the picture is as abstracted as you want it, then bring COHERENCE down to let it come apart.",
    inputs: {
      video_in:
        'The frame under analysis. Downsampled to a 128x128 luma plane every SLICE frames; its chroma is kept and recombined with the resynthesized luminance. With nothing patched here the output is black — this is an effect, not a source.',
      gate: 'FREEZE while HIGH. Holds the current component bank so the picture drones on the last analysed frame; the bank keeps slewing, drifting and rendering, only the analysis stops. Level-sensitive, not edge-triggered, so a held gate holds the freeze and releasing it resumes from the live frame.',
      components_cv:
        'CV input that modulates Components — how many gratings the bank rebuilds the picture from. Linear-scaled across 1..256 centred on the knob.',
      coherence_cv:
        'CV input that modulates Coherence — how hard each component is pulled back onto the phase measured in the incoming frame. Linear-scaled into 0..1; sweeping it is the module\'s main gesture, from resynthesized camera to free-running interference.',
      residual_cv:
        'CV input that modulates Residual — the level of the procedural texture rebuilt from the energy the component bank did not claim. Linear-scaled into 0..2.',
      shape_cv:
        'CV input that modulates Shape — the sine/saw/square morph applied to every grating by harmonic injection. Linear-scaled into 0..1.',
      center_cv:
        'CV input that modulates Center — the transposition applied to every wavevector, in cents, zooming the reconstruction. Linear-scaled across -3600..3600.',
      drift_cv:
        'CV input that modulates Drift — each component\'s own phase velocity. Linear-scaled into 0..1.',
      mix_cv: 'CV input that modulates Mix — the crossfade between the source and the resynthesis. Linear-scaled into 0..1.',
    },
    outputs: {
      out: 'The composited frame: resynthesized luminance recombined with the source chroma, crossfaded against the source by MIX. A normal downstream video texture.',
    },
    controls: {
      visionsCoherence:
        "Coherence (0..1, default 1): how much of the incoming frame's PHASE each component adopts on every analysis commit. 1 re-seats phase exactly, so the bank is a sparse reconstruction and the picture is recognisable and correctly positioned. 0 never touches phase after a component is born, so the bank keeps the source's spatial frequencies and loses its geometry — the free-running behaviour the audio oscillator bank has. Values between pull part of the way each commit, so structure forms over several frames and decays between them. This is the control that decides whether the module is a camera or an instrument.",
      visionsComponents:
        'Components (1..256, default 64): how many tracked gratings the bank holds. Low counts collapse the picture toward its coarsest structure (image spectra fall off with spatial frequency, so the survivors are the large shapes); high counts approach a band-limited copy of the source. Also the module\'s main CPU control — a full 256-component bank costs about 1.2 ms of CPU per analysed frame.',
      visionsFloor:
        'Floor (-90..-20 dB, default -42): the peak-detection threshold, RELATIVE to the strongest component in the frame. Lower admits faint structure and fills the bank from a flat image; higher keeps only the boldest gratings. Everything it rejects becomes residual rather than disappearing.',
      visionsStability:
        'Stability (1..16 frames, default 3): how many consecutive commits a component must be matched on before it reaches full contrast, ramping in over that span. 1 lets every flicker through; high values hold the picture to the structure that persists, which is what stops a noisy source from boiling.',
      visionsSlew:
        'Slew (0.02..4 s, default 0.25): the time constant on every component\'s CONTRAST and on the residual ring envelopes. Short tracks the source tightly; long smears the picture in time so it dissolves between states rather than cutting. Wavevectors themselves are not slewed — a grating that slid across the frame would tear the geometry.',
      visionsSlice:
        'Slice (1..16 frames, default 2): the analysis period, in RENDERED FRAMES rather than milliseconds. The source only changes when a frame is drawn, and frames are the unit the CPU budget is spent in, so a wall-clock period would mean different behaviour on every renderer. 1 analyses every frame and costs the most; higher values hold each analysis longer, which is both cheaper and a usable stutter.',
      visionsResidual:
        'Residual (0..2, default 0.5): the level of the texture rebuilt from unclaimed energy — the 16 log-spaced rings of the spectrum the component bank did not take. This is the difference between a reconstruction and a wireframe: it puts back grain, foliage, smoke and compression fizz. Scaled by the cube root of the component count, so thinning the bank also cleans up the texture. At 0 it is silent. It is band-limited to the analysis grid like everything else, so it renders coarse and mid texture and cannot render fine film grain.',
      visionsShape:
        "Shape (0..1, default 0 = SINE): morphs every grating from a sine (0) through a saw (0.5) to a square (1) by injecting the component's harmonics into the spectrum. Harmonics past the grid limit are simply not written, so it band-limits exactly rather than aliasing. The fundamental is never rescaled, so the morph does not change contrast.",
      visionsCenter:
        'Center (-3600..3600 cents, default 0): transposes every wavevector by one ratio, zooming the whole reconstruction. Positive makes every pattern finer (the picture appears to shrink into itself); negative makes it coarser. Components pushed past the grid limit fade out on a ramp rather than folding back as low-frequency ghosts.',
      visionsDrift:
        "Drift (0..1, default 0): gives each component a phase velocity proportional to its own spatial frequency, so fine detail boils fast and coarse structure moves slowly — the literal analogue of an audio oscillator running at its own pitch. The residual rings churn at the same rate. At 0 phase only moves when COHERENCE moves it, so the picture is still.",
      visionsMix:
        'Mix (0..1, default 1): crossfades the composited resynthesis against the untouched source. At 0 the module is a passthrough.',
      engineFreeze:
        'Freeze (LIVE / FREEZE, default LIVE): FREEZE stops the analysis, so the component bank holds whatever it last measured and the picture drones on it. Slew, drift and rendering all keep running, and releasing it resumes from the live frame rather than a stale one. The GATE input does the same thing while held HIGH.',
    },
  },

  // ─────────────────────────── face ───────────────────────────
  //
  // THE FACEPLATE. Hash-transparent by construction — `scripts/attest-code-
  // basis.ts` strips a def's own top-level `face` before hashing, so this block
  // costs no WebGL re-attest. (Verified on this branch, not assumed: the
  // content hash is 7df4a85a… before and after.)
  //
  // ⚠ WHAT PROMOTION FIXES, AND IT IS NOT A LOOK. `WarrensvisionsCard.svelte`
  // passes NO `readLive` on any of its eleven knobs, so every dial on the card
  // is DEAD TO CV — against SEVEN cv inputs, each with a declared `paramTarget`
  // and a working `cvScale`. Patch a modulator into `coherence_cv` and the card
  // shows the stored value while the engine renders a different one. The face
  // is live by construction: `ModuleShell.svelte` passes `readLive={params.
  // live(pd.id)}` on every param cell it renders, at every one of its six call
  // sites. The knobs are not re-styled — they start telling the truth.
  //
  // ⚠ AND THE MODULE'S DECLARED VOCABULARY REACHES A SURFACE FOR THE FIRST
  // TIME. This def is the only one in the unfaced pool that declares BOTH
  // `options[]` (engineFreeze: LIVE / FREEZE, each with a `title`) AND
  // `landmarks` (visionsShape: SINE / SAW / SQUARE). The card consumed
  // NEITHER — it re-typed the two freeze words as string literals in its own
  // button (`{frozen ? 'FREEZE' : 'LIVE'}`) and never passed the landmarks to
  // its `<Knob>` at all. A face reads both off the def: `engineFreeze`
  // resolves to a SEGMENTED cell at the dock (its `options` roster is what
  // `paramCellKind` keys on), and `visionsShape` paints its nearest landmark
  // NAME. That is the one text a resting faceplate is still allowed to paint —
  // an option/landmark name disambiguates a control's own position, where a
  // decimal would merely restate the dial.
  //
  // ⚠ ONE CAVEAT ON THAT READOUT, so nobody reads it as a claim about the
  // harmonic series: `knobNameReadout` is documented NEAREST-MATCH, so `SAW`
  // prints across the whole (0.25, 0.75] half of the SHAPE dial (ties resolve
  // to the earlier entry — exactly 0.25 prints `SINE`). The morph really is an
  // exact ideal saw at exactly 0.5 — `max |w(n, shape) − 1/n|` over n = 2…8 is
  // 0.000000 there and 0.249900 at 0.2501, measured through this module's own
  // `wvHarmonicWeight` — but the label is a name for a REGION, not a
  // measurement of one point. Platform behaviour, not a defect.
  //
  // NO READOUTS, NO SIDEBAR, NO HERO. The 2026-08-19 rulings deleted both
  // fields (`face-readout-values.ts` no longer exists), and there is nothing
  // here that wants them back: every derived quantity this module has is
  // already the subject of a control, and the values live in `aria-valuetext`.
  //
  // ── THE RANKING, AND THE DEF MADE THIS ARGUMENT BEFORE THE FACE DID ───────
  //
  // `order` opens COHERENCE / COMPONENTS / MIX. COHERENCE is first on the
  // authority of the comment above `params` — "it is the control that changes
  // the module's identity, and no other control on it moves more" — and the
  // docs say the same thing twice ("This is the control that decides whether
  // the module is a camera or an instrument"). A rank that contradicted the
  // def's own stated priority would need an argument; this one does not
  // deviate, so it does not need one. COMPONENTS is second because it is the
  // other control that changes WHAT YOU SEE rather than how it moves (and it
  // is the module's CPU dial besides); MIX is third because it is the only
  // control that can take the module out of the picture entirely. Everything
  // after those three follows DECLARATION order, which is already grouped.
  //
  // `glyph: 'none'` is MANDATORY and it is counter-intuitive:
  // `primaryAudioOutPortId` matches `type === 'audio'` and a video def has
  // none, so every other value resolves `{kind:'static'}` and reddens the
  // dead-glyph clause.
  //
  // ⚠ BUT DO NOT DERIVE THE TIER CAPS FROM THAT DECLARATION — MEASURE THEM.
  // This is #1785's trap ("never a hand-rolled glyph predicate"), and the
  // spec this face was built from fell into it: it reasoned "no glyph binds ⇒
  // compact cap 3 ⇒ plate and dock carry all twelve". Run through the real
  // resolvers instead — `laneGlyphFor(def)` answers **`'picture'`**, not
  // `'none'`, because `hasVideoSurface` mounts a live thumbnail of this
  // module's own output and that thumbnail SPENDS A LANE CELL. So the
  // declared glyph and the lane budget are two different questions with two
  // different answers, which is exactly why `faceTierCap` takes
  // `laneGlyphFor(def)` rather than `face.glyph`.
  //
  // Tier ladder as a sentence, MEASURED through `curatedFace`:
  //
  //   mini    cap 1  → COHERENCE
  //   compact cap 2  → COHERENCE, COMPONENTS      (LANE_ROW_MAX_CELLS_WITH_GLYPH)
  //   plate   cap 3  → + MIX
  //   dock    all 12
  //
  // So the picture costs one control at every lane tier, and MIX — the only
  // control that can take this module out of the shot — arrives at the PLATE
  // rather than at compact. That is the def's own priority order paying off
  // under a tighter budget than the spec predicted, and it is pinned in
  // `warrensvisions-face-model.test.ts` so a later platform change to the
  // video-thumbnail budget cannot move it silently.
  //
  // ⚠ `order` AND `pages` DISAGREE ON PURPOSE. `order` ranks by PRIORITY, for
  // the tiers that show a subset; `pages` groups by KIND, for the tier that
  // shows everything. COHERENCE is rank 1 and sits in the THIRD band, because
  // the thing it belongs WITH (drift, slew — how the bank behaves over time)
  // is not the thing it is more important THAN.
  //
  // NOT CONTROL-HEAVY, and the count is not the argument: four honest pages
  // against `DOCK_TAB_MIN_BANDS = 7`, so no tab rail. Per the 2026-08-18
  // ruling, pages are NOT padded to reach it — there is no fifth idea here,
  // and unlike `ruttetra` this module was never named as the tabbed
  // application.
  //
  // `bareCells`: NO. Twelve differently-named controls across four sections;
  // every caption disambiguates its neighbours.
  face: {
    // The SCREEN ON/OFF body (owner ruling, 2026-08-18). See
    // $lib/ui/modules/warrensvisions/shell-extension.ts — promotion is what
    // stops `WarrensvisionsCard.svelte` rendering, and that card owns the only
    // live picture this module has ever had.
    extension: 'warrensvisions',
    glyph: 'none',
    order: [
      'visionsCoherence',
      'visionsComponents',
      'visionsMix',
      'visionsFloor',
      'visionsStability',
      'visionsSlew',
      'visionsSlice',
      'visionsResidual',
      'visionsShape',
      'visionsCenter',
      'visionsDrift',
      'engineFreeze',
    ],
    pages: [
      {
        id: 'analysis',
        label: 'ANALYSIS',
        hint: 'which gratings earn a slot in the bank, and how often the picture is re-read',
        controls: ['visionsSlice', 'visionsFloor', 'visionsStability', 'visionsComponents'],
      },
      {
        id: 'motion',
        label: 'MOTION',
        hint: 'how the bank behaves over time — assembling, boiling, or melting',
        controls: ['visionsCoherence', 'visionsDrift', 'visionsSlew'],
      },
      {
        id: 'grating',
        label: 'GRATING',
        hint: 'what one individual grating looks like, and where the whole lattice sits',
        controls: ['visionsShape', 'visionsCenter'],
      },
      {
        id: 'output',
        label: 'OUTPUT',
        hint: 'what actually reaches the screen',
        controls: ['visionsResidual', 'visionsMix', 'engineFreeze'],
      },
    ],
  },

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const N = WV_GRID;

    const smooth = !isSoftwareRenderer(gl);
    const lumaProgram = ctx.compileFragment(LUMA_FRAG);
    const compProgram = ctx.compileFragment(compositeFrag(smooth));

    const uLumaSrc = gl.getUniformLocation(lumaProgram, 'uSrc');
    const uLumaTexel = gl.getUniformLocation(lumaProgram, 'uSrcTexel');
    const uLumaHas = gl.getUniformLocation(lumaProgram, 'uHasSrc');
    const uCompSrc = gl.getUniformLocation(compProgram, 'uSrc');
    const uCompField = gl.getUniformLocation(compProgram, 'uField');
    const uCompGrid = gl.getUniformLocation(compProgram, 'uGrid');
    const uCompMix = gl.getUniformLocation(compProgram, 'uMix');
    const uCompHas = gl.getUniformLocation(compProgram, 'uHasSrc');
    const uCompDc = gl.getUniformLocation(compProgram, 'uDc');

    const { fbo, texture } = ctx.createFbo();

    const raw = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    }
    const params: Record<WvParamId, number> = { ...DEFAULTS, ...(filtered as Partial<Record<WvParamId, number>>) };

    // 1×1 black sentinel for an unbound input — never bind null.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('WARRENSVISIONS: createTexture failed (emptyTex)');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    for (const [p, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
      [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ] as const) {
      gl.texParameteri(gl.TEXTURE_2D, p, v);
    }

    // Analysis FBO at the grid size — RGBA8, so readPixels stays on the one
    // format/type pair that is guaranteed readable.
    const lumaTex = gl.createTexture();
    const lumaFbo = gl.createFramebuffer();
    if (!lumaTex || !lumaFbo) throw new Error('WARRENSVISIONS: createTexture/Framebuffer failed (luma)');
    gl.bindTexture(gl.TEXTURE_2D, lumaTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [p, v] of [
      [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
      [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ] as const) {
      gl.texParameteri(gl.TEXTURE_2D, p, v);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, lumaFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lumaTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // The reconstructed plane. R32F is SAMPLED, never rendered to, so this
    // needs no EXT_color_buffer_float; LINEAR on it needs
    // OES_texture_float_linear, which the bilinear path depends on.
    const linearOk = floatLinearOk(gl);
    const fieldFilter = linearOk ? gl.LINEAR : gl.NEAREST;
    const fieldTex = gl.createTexture();
    if (!fieldTex) throw new Error('WARRENSVISIONS: createTexture failed (field)');
    gl.bindTexture(gl.TEXTURE_2D, fieldTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, N, N, 0, gl.RED, gl.FLOAT, null);
    for (const [p, v] of [
      [gl.TEXTURE_MIN_FILTER, fieldFilter],
      [gl.TEXTURE_MAG_FILTER, fieldFilter],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ] as const) {
      gl.texParameteri(gl.TEXTURE_2D, p, v);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Preallocated — no per-frame allocation.
    const readback = new Uint8Array(N * N * 4);
    const luma = new Float32Array(N * N);
    const field = new Float32Array(N * N);

    const engine = new WarrensVisionsEngine(N);
    let sliceCounter = 0;
    let lastTime: number | null = null;
    let framesElapsed = 0;
    let hasInput = false;
    let liveComponents = 0;
    let fieldMin = 0;
    let fieldMax = 0;

    function applyParams(): void {
      engine.setComponents(params.visionsComponents);
      engine.setCoherence(params.visionsCoherence);
      engine.setFloorDb(params.visionsFloor);
      engine.setStabilityFrames(params.visionsStability);
      engine.setSlewSeconds(params.visionsSlew);
      engine.setResidual(params.visionsResidual);
      engine.setShape(params.visionsShape);
      engine.setCenterCents(params.visionsCenter);
      engine.setDrift(params.visionsDrift);
      engine.setFrozen(params.engineFreeze >= 0.5);
    }
    applyParams();

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        const srcTex = frame.getInputTexture(node.id, 'video_in');
        hasInput = !!srcTex;
        applyParams();

        // ── COMMIT: downsample → readPixels → analyse. Every SLICE frames,
        //    and never while frozen (which also skips the readback, so FREEZE
        //    is genuinely cheaper and not merely visually still).
        const slice = Math.max(
          WV_SLICE_MIN_FRAMES,
          Math.min(WV_SLICE_MAX_FRAMES, Math.round(params.visionsSlice)),
        );
        const frozen = params.engineFreeze >= 0.5;
        if (sliceCounter <= 0) {
          sliceCounter = slice;
          if (!frozen && srcTex) {
            g.bindFramebuffer(g.FRAMEBUFFER, lumaFbo);
            g.viewport(0, 0, N, N);
            g.useProgram(lumaProgram);
            g.activeTexture(g.TEXTURE0);
            g.bindTexture(g.TEXTURE_2D, srcTex);
            g.uniform1i(uLumaSrc, 0);
            g.uniform2f(uLumaTexel, 1 / Math.max(1, ctx.res.width), 1 / Math.max(1, ctx.res.height));
            g.uniform1f(uLumaHas, 1);
            ctx.drawFullscreenQuad();
            g.readPixels(0, 0, N, N, g.RGBA, g.UNSIGNED_BYTE, readback);
            g.bindFramebuffer(g.FRAMEBUFFER, null);
            for (let i = 0; i < luma.length; i++) luma[i] = readback[i * 4]! / 255;
            engine.analyze(luma);
          }
        }
        sliceCounter--;

        // ── EVERY FRAME: advance and resynthesize.
        //
        // ⚠ dt comes from `frame.time` — the engine's SIMULATION clock, which
        // `__videoEngineFreezeTime` pins — and NOT from `frame.timeDelta`,
        // which the engine derives from `performance.now()` (engine.ts:1370).
        // Those are different clocks, and the difference is the whole
        // frame-counting discipline: under the deterministic render-smoke
        // harness the rAF loop is paused and `step()` is driven in a tight
        // loop, so wall-clock dt collapses to ~0 and SLEW and DRIFT would
        // never advance at all — the spec would be asserting against a module
        // that had not run. Reading the pinned clock makes every envelope a
        // function of the frame count the test drove, on any renderer.
        // Clamped both ways so a rewound clock is a no-op frame rather than a
        // negative-time step.
        const now = frame.time;
        const dt = lastTime === null ? 1 / 60 : Math.max(0, Math.min(0.1, now - lastTime));
        lastTime = now;
        engine.advance(dt);
        const stats = engine.synthesize(field);
        liveComponents = stats.live;
        fieldMin = stats.min;
        fieldMax = stats.max;

        g.bindTexture(g.TEXTURE_2D, fieldTex);
        g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, N, N, g.RED, g.FLOAT, field);

        // ── COMPOSITE at engine resolution.
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(compProgram);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, srcTex ?? emptyTex);
        g.uniform1i(uCompSrc, 0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, fieldTex);
        g.uniform1i(uCompField, 1);
        g.uniform2f(uCompGrid, N, N);
        g.uniform1f(uCompMix, Math.max(0, Math.min(1, params.visionsMix)));
        g.uniform1f(uCompHas, srcTex ? 1 : 0);
        g.uniform1f(uCompDc, engine.getDc());
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);

        framesElapsed++;
      },
      dispose() {
        gl.deleteProgram(lumaProgram);
        gl.deleteProgram(compProgram);
        gl.deleteTexture(emptyTex);
        gl.deleteTexture(lumaTex);
        gl.deleteTexture(fieldTex);
        gl.deleteFramebuffer(lumaFbo);
        gl.deleteTexture(texture);
        gl.deleteFramebuffer(fbo);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (PARAM_IDS.has(paramId)) params[paramId as WvParamId] = value;
      },
      readParam(paramId) {
        return PARAM_IDS.has(paramId) ? params[paramId as WvParamId] : undefined;
      },
      read(key) {
        switch (key) {
          case WARRENSVISIONS_READ_KEYS.committedFrames:
            return engine.getCommittedFrames();
          case WARRENSVISIONS_READ_KEYS.framesElapsed:
            return framesElapsed;
          case WARRENSVISIONS_READ_KEYS.liveComponents:
            return liveComponents;
          case WARRENSVISIONS_READ_KEYS.hasInput:
            return hasInput;
          case WARRENSVISIONS_READ_KEYS.smoothPath:
            return smooth;
          case WARRENSVISIONS_READ_KEYS.fieldRange:
            return [fieldMin, fieldMax];
          default:
            return undefined;
        }
      },
      dispose() {
        surface.dispose();
      },
    };
  },
};
