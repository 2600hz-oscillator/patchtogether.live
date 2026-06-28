// packages/web/src/lib/video/modules/spirographs.ts
//
// SPIROGRAPHS — a classic-spirograph video GENERATOR (a pure synth source: no
// video input). It renders 1–3 INDEPENDENT spirographs — hypotrochoid (rolling
// circle INSIDE the fixed one) or epitrochoid (OUTSIDE) — each with its OWN full
// parameter set + matching CV, each DRIFTING around the screen with its fixed
// circle bouncing off the frame edges like a real spirograph constrained to the
// page.
//
// WHY CANVAS2D, NOT GLSL: a spirograph is a long polyline (a closed trochoid
// sampled over many revolutions) stroked with a genuine, visible LINE WIDTH.
// Canvas2D's stroke pipeline (round joins/caps, real px line width) renders
// that crisply in one pass; doing the same in a fragment shader (distance-to-
// curve over thousands of samples per pixel) is far costlier and the thickness
// control reads worse. So, like SHAPEGEN / TEXTMARQUEE, we paint to an
// OffscreenCanvas and upload it as a GL texture each frame. The curve math + the
// bounce-constraint live in the pure, unit-tested spirographs-math layer.
//
// THE 1–3 INDEPENDENT-SPIRO MODEL:
//   • `count` (discrete 1..3, knob + CV) sets how many spiros render.
//   • Each spiro i∈{1,2,3} has its OWN params (prefix `sI_`): fixedRadius (R),
//     rollingRadius (r), penOffset (p), inside (0=epi/outside, 1=hypo/inside),
//     rotation, scale, xOffset, yOffset, thickness, chroma. EVERY one of these
//     has a knob AND a CV input (port id == param id; the cross-domain CV bridge
//     routes a -1..+1 source into setParam(paramId)).
//   • Each spiro's CENTER drifts independently. Its drift velocity + home
//     position are per-spiro CONSTANTS seeded at construction (so the three
//     never move in lockstep), nudged by that spiro's xOffset/yOffset knobs.
//     The fixed-radius circle (radius R, scaled to screen) is constrained to
//     stay FULLY inside the frame and BOUNCES off the perimeter — closed-form
//     via spirographs-math.advanceCenter. Only the fixed circle's center+R is
//     bound; the drawn CURVE may overflow the viewport and clip (desired).
//
// OUTPUTS (all video, on the yellow drill-down PATCH PANEL — no raw side jacks):
//   • out       (video)      — the full-COLOUR composite (each spiro in its
//                              chroma hue, additively composited on black). This
//                              is the canonical surface.
//   • mono_out  (mono-video) — every spiro stroked WHITE on black (a clean matte
//                              for keying / luma downstream). Reachable via
//                              read('outputTexture:mono_out').
//   • overlap   (video)      — the COLOUR-OVERLAP output: the per-pixel overlap
//                              DENSITY (how many lines stack there — self-cross +
//                              multi-spiro) is colour-mapped into a rainbow that
//                              CASCADES with the count and blooms toward a white
//                              candy core where many lines pile up ("candy gooey"
//                              goodness). Reachable via read('outputTexture:overlap').
//
// INPUTS (PatchPanel, grouped per-spiro): the global `count` CV plus, per spiro,
// the ten per-param CVs. The card groups them into spiro1 / spiro2 / spiro3
// sections in the drill-down.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  advanceCenter,
  type CenterState,
  type SpiroKind,
} from './spirographs-math';
import { drawColorScene, drawMonoScene, drawOverlapScene, type ResolvedSpiro } from './spirographs-draw';

// ── Per-spiro param ids ─────────────────────────────────────────────────────

/** The ten per-spiro param stems. The full param/port id is `s${i}_${stem}`. */
export const SPIRO_PARAM_STEMS = [
  'R',          // fixedRadius
  'r',          // rollingRadius
  'p',          // penOffset
  'inside',     // 0 = epitrochoid (outside), 1 = hypotrochoid (inside)
  'rotation',
  'scale',
  'xOffset',
  'yOffset',
  'thickness',
  'chroma',     // hue 0..1 (colorwheel)
] as const;
export type SpiroParamStem = (typeof SPIRO_PARAM_STEMS)[number];

export const SPIRO_COUNT_MAX = 3;

/** Build the per-spiro param id, e.g. spiroParamId(2, 'R') → 's2_R'. */
export function spiroParamId(i: number, stem: SpiroParamStem): string {
  return `s${i}_${stem}`;
}

// ── Per-spiro defaults (each spiro starts with a distinct look) ──────────────

interface SpiroDefault {
  R: number;
  r: number;
  p: number;
  inside: number;
  rotation: number;
  scale: number;
  xOffset: number;
  yOffset: number;
  thickness: number;
  chroma: number;
}

// Three visually-distinct starting spiros (only `count` of them render).
const SPIRO_DEFAULTS: Record<number, SpiroDefault> = {
  1: { R: 5,   r: 3,   p: 2.2, inside: 1, rotation: 0,    scale: 28, xOffset: 0, yOffset: 0, thickness: 2, chroma: 0.0  },
  2: { R: 7,   r: 3,   p: 3.5, inside: 1, rotation: 0.4,  scale: 22, xOffset: 0, yOffset: 0, thickness: 2, chroma: 0.45 },
  3: { R: 5,   r: 2,   p: 2.0, inside: 0, rotation: 0.9,  scale: 20, xOffset: 0, yOffset: 0, thickness: 2, chroma: 0.72 },
};

/** Per-spiro center-drift constants (home position as a fraction of the frame +
 *  velocity in frame-fractions per second). Distinct per spiro so they never
 *  move in lockstep — this is the "each spiro moves independently" seed. */
const SPIRO_DRIFT: Record<number, { hx: number; hy: number; vx: number; vy: number }> = {
  1: { hx: 0.35, hy: 0.45, vx: 0.055, vy: 0.041 },
  2: { hx: 0.6,  hy: 0.4,  vx: -0.047, vy: 0.063 },
  3: { hx: 0.5,  hy: 0.6,  vx: 0.071, vy: -0.052 },
};

// ── Param value ranges (for clamping + the card faders) ─────────────────────

export const SPIRO_RANGES: Record<SpiroParamStem, { min: number; max: number }> = {
  R:         { min: 1,    max: 12 },
  r:         { min: 0.5,  max: 11 },
  p:         { min: 0,    max: 8 },
  inside:    { min: 0,    max: 1 },
  rotation:  { min: 0,    max: 6.2832 }, // 0..2π
  scale:     { min: 4,    max: 60 },
  xOffset:   { min: -1,   max: 1 },
  yOffset:   { min: -1,   max: 1 },
  thickness: { min: 0.5,  max: 12 },
  chroma:    { min: 0,    max: 1 },
};

function clampStem(stem: SpiroParamStem, v: number): number {
  const rng = SPIRO_RANGES[stem];
  return Math.max(rng.min, Math.min(rng.max, v));
}

// ── The module's flat param map ─────────────────────────────────────────────
//
// `count` (1..3 discrete) + s{i}_{stem} for i in 1..3 × the ten stems.

function buildDefaults(): Record<string, number> {
  const d: Record<string, number> = { count: 1 };
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    const def = SPIRO_DEFAULTS[i]!;
    for (const stem of SPIRO_PARAM_STEMS) {
      d[spiroParamId(i, stem)] = def[stem];
    }
  }
  return d;
}

const DEFAULTS = buildDefaults();

// ── Param defs + CV input ports ─────────────────────────────────────────────

const PARAMS: VideoModuleDef['params'] = (() => {
  const out: Array<{ id: string; label: string; defaultValue: number; min: number; max: number; curve: 'linear' | 'discrete' }> = [
    { id: 'count', label: 'Count', defaultValue: 1, min: 1, max: SPIRO_COUNT_MAX, curve: 'discrete' },
  ];
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    for (const stem of SPIRO_PARAM_STEMS) {
      const rng = SPIRO_RANGES[stem];
      out.push({
        id: spiroParamId(i, stem),
        label: `${i} ${stem}`,
        defaultValue: DEFAULTS[spiroParamId(i, stem)]!,
        min: rng.min,
        max: rng.max,
        curve: stem === 'inside' ? 'discrete' : 'linear',
      });
    }
  }
  return out;
})();

const INPUTS: VideoModuleDef['inputs'] = (() => {
  const out: VideoModuleDef['inputs'] = [
    { id: 'count', type: 'cv', paramTarget: 'count', cvScale: { mode: 'discrete' } },
  ];
  for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
    for (const stem of SPIRO_PARAM_STEMS) {
      const id = spiroParamId(i, stem);
      out.push({
        id,
        type: 'cv',
        paramTarget: id,
        cvScale: { mode: stem === 'inside' ? 'discrete' : 'linear' },
      });
    }
  }
  return out;
})();

// ── Fullscreen-quad shader (samples the painted scene into the FBO) ─────────

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uScene;

void main() {
  // OffscreenCanvas origin is top-left; WebGL UV origin is bottom-left. Flip Y
  // so the painted scene reads upright in the FBO + downstream.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  outColor = texture(uScene, uv);
}`;

// ── Overlap colour-map shader (density accumulation → cascading-rainbow candy) ─
//
// Samples the grayscale overlap-DENSITY buffer (drawOverlapScene: each pixel's
// value ∝ how many lines stack there) and cascades it into a rainbow: the hue
// steps through the spectrum with the count, saturation + brightness rise with
// it, and a very high pile-up melts toward a white candy core ("candy gooey").
const OVERLAP_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uScene;

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  // Accumulated overlap density (grayscale coverage sum), 0..1.
  float a = dot(texture(uScene, uv).rgb, vec3(0.3333));
  if (a <= 0.003) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // CASCADE turns each added overlap into a step through the hue wheel; the
  // 0.58 base seeds the ramp in the cyan/blue range so a single line reads cool
  // and dense pile-ups race through green→yellow→red→magenta.
  const float CASCADE = 2.4;
  float hue = fract(a * CASCADE + 0.58);
  float sat = clamp(0.55 + a * 0.6, 0.0, 1.0);
  float val = clamp(0.18 + a * 1.6, 0.0, 1.0);
  vec3 rgb = hsv2rgb(vec3(hue, sat, val));
  // Very high overlap blooms toward a white candy core (the gooey highlight).
  rgb = mix(rgb, vec3(1.0), smoothstep(0.78, 1.0, a) * 0.7);
  outColor = vec4(rgb, 1.0);
}`;

// ── Module def ──────────────────────────────────────────────────────────────

export const spirographsDef: VideoModuleDef = {
  type: 'spirographs',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'spirographs',
  category: 'sources',
  schemaVersion: 1,
  inputs: INPUTS,
  outputs: [
    { id: 'out', type: 'video' },           // full-colour composite (canonical)
    { id: 'mono_out', type: 'mono-video' }, // white-on-black matte
    { id: 'overlap', type: 'video' },       // overlap-density → cascading-rainbow candy
  ],
  params: PARAMS,

  // docs-hash-ignore:start
  docs: {
    explanation: "A pure video source (no input) that renders 1-3 independent classic spirographs and uploads them to the GPU each frame. Each spiro is a trochoid traced by a pen at offset p inside a rolling circle of radius r that rolls without slipping on a fixed circle of radius R: inside=hypotrochoid (rolling circle inside the fixed one), outside=epitrochoid (rolling circle outside it). The R:r ratio sets how many petals/loops the figure makes and how many revolutions it takes to close (a rational ratio closes; a near-irrational one densely fills the annulus, capped at a sane max). Each spiro has its own full parameter bank (R, r, pen, in/out, rotation, scale, X/Y, thickness, hue) and its own center that drifts independently across the frame, with the fixed-radius circle bouncing elastically off the four edges (only the fixed circle is kept fully in-frame; the drawn curve may overflow and clip, which is intended). The COLOR out composites each curve in its hue additively (lighter blend) on black so crossings glow toward white; switch its output port to get a white-on-black matte or a density-mapped rainbow \"candy\" overlap instead. Usage: pick a count, then use the per-spiro tabs to dial each figure (try a 5:2 inside spiro for a 5-petal star), and feed an LFO into a rotation or scale CV for slow living motion.",
    inputs: {
      count: "modulates Count (discrete CV, 1-3): how many of the three spiros render this frame.",
      s1_R: "modulates spiro 1 Fixed radius (R, 1-12): the fixed outer circle; with r sets the petal ratio.",
      s1_r: "modulates spiro 1 Roll radius (r, 0.5-11): the rolling circle's radius; R:r drives the figure.",
      s1_p: "modulates spiro 1 Pen offset (p, 0-8): pen distance from the rolling circle's center.",
      s1_inside: "modulates spiro 1 In/Out (discrete CV): high = inside (hypotrochoid), low = outside (epitrochoid).",
      s1_rotation: "modulates spiro 1 Rotation (0-2pi radians): spins the whole figure about its center.",
      s1_scale: "modulates spiro 1 Scale (4-60): spiro-space-to-pixels zoom of the figure.",
      s1_xOffset: "modulates spiro 1 X offset (-1..1): nudges its drift home position horizontally.",
      s1_yOffset: "modulates spiro 1 Y offset (-1..1): nudges its drift home position vertically.",
      s1_thickness: "modulates spiro 1 Width (0.5-12 px): stroke line width of the curve.",
      s1_chroma: "modulates spiro 1 Hue (0-1 colorwheel): the curve's color in the COLOR output.",
      s2_R: "modulates spiro 2 Fixed radius (R, 1-12): the fixed outer circle; with r sets the petal ratio.",
      s2_r: "modulates spiro 2 Roll radius (r, 0.5-11): the rolling circle's radius; R:r drives the figure.",
      s2_p: "modulates spiro 2 Pen offset (p, 0-8): pen distance from the rolling circle's center.",
      s2_inside: "modulates spiro 2 In/Out (discrete CV): high = inside (hypotrochoid), low = outside (epitrochoid).",
      s2_rotation: "modulates spiro 2 Rotation (0-2pi radians): spins the whole figure about its center.",
      s2_scale: "modulates spiro 2 Scale (4-60): spiro-space-to-pixels zoom of the figure.",
      s2_xOffset: "modulates spiro 2 X offset (-1..1): nudges its drift home position horizontally.",
      s2_yOffset: "modulates spiro 2 Y offset (-1..1): nudges its drift home position vertically.",
      s2_thickness: "modulates spiro 2 Width (0.5-12 px): stroke line width of the curve.",
      s2_chroma: "modulates spiro 2 Hue (0-1 colorwheel): the curve's color in the COLOR output.",
      s3_R: "modulates spiro 3 Fixed radius (R, 1-12): the fixed outer circle; with r sets the petal ratio.",
      s3_r: "modulates spiro 3 Roll radius (r, 0.5-11): the rolling circle's radius; R:r drives the figure.",
      s3_p: "modulates spiro 3 Pen offset (p, 0-8): pen distance from the rolling circle's center.",
      s3_inside: "modulates spiro 3 In/Out (discrete CV): high = inside (hypotrochoid), low = outside (epitrochoid).",
      s3_rotation: "modulates spiro 3 Rotation (0-2pi radians): spins the whole figure about its center.",
      s3_scale: "modulates spiro 3 Scale (4-60): spiro-space-to-pixels zoom of the figure.",
      s3_xOffset: "modulates spiro 3 X offset (-1..1): nudges its drift home position horizontally.",
      s3_yOffset: "modulates spiro 3 Y offset (-1..1): nudges its drift home position vertically.",
      s3_thickness: "modulates spiro 3 Width (0.5-12 px): stroke line width of the curve.",
      s3_chroma: "modulates spiro 3 Hue (0-1 colorwheel): the curve's color in the COLOR output.",
    },
    outputs: {
      out: "COLOR: the canonical full-color composite, each spiro stroked in its hue and additively blended (lighter) on black so overlaps glow toward white.",
      mono_out: "MONO: every spiro stroked white on black, a clean matte for keying or luma effects downstream.",
      overlap: "CANDY: the per-pixel line-stack density mapped to a cascading rainbow that blooms to a white core where many lines pile up (hue-independent: driven by density, not the chroma controls).",
    },
    controls: {
      count: "Count (1-3, discrete): how many of the three spiros render. Independent of which tab you are editing.",
      s1_R: "Spiro 1 Fixed (R, 1-12): the fixed outer circle radius; with Roll it sets the petal/loop ratio.",
      s1_r: "Spiro 1 Roll (r, 0.5-11): the rolling circle radius; the R:r ratio defines the figure and revolutions to close.",
      s1_p: "Spiro 1 Pen (p, 0-8): pen offset in the rolling circle; 0 traces a plain circle, larger makes deeper loops.",
      s1_inside: "Spiro 1 In/Out toggle: INSIDE = hypotrochoid (rolling circle inside), OUTSIDE = epitrochoid (rolling circle outside).",
      s1_rotation: "Spiro 1 Rot (0-2pi radians): static rotation of the whole figure about its center.",
      s1_scale: "Spiro 1 Scale (4-60): zoom from spiro-space units to pixels; with R it also sets the fixed circle's bounce inset.",
      s1_xOffset: "Spiro 1 X (-1..1): nudges the drift home position horizontally (center still drifts and bounces).",
      s1_yOffset: "Spiro 1 Y (-1..1): nudges the drift home position vertically (center still drifts and bounces).",
      s1_thickness: "Spiro 1 Width (0.5-12 px): stroke line width, drawn with round joins and caps.",
      s1_chroma: "Spiro 1 Hue (0-1 colorwheel): the curve's color in the COLOR output (MONO and CANDY ignore it).",
      s2_R: "Spiro 2 Fixed (R, 1-12): the fixed outer circle radius; with Roll it sets the petal/loop ratio.",
      s2_r: "Spiro 2 Roll (r, 0.5-11): the rolling circle radius; the R:r ratio defines the figure and revolutions to close.",
      s2_p: "Spiro 2 Pen (p, 0-8): pen offset in the rolling circle; 0 traces a plain circle, larger makes deeper loops.",
      s2_inside: "Spiro 2 In/Out toggle: INSIDE = hypotrochoid (rolling circle inside), OUTSIDE = epitrochoid (rolling circle outside).",
      s2_rotation: "Spiro 2 Rot (0-2pi radians): static rotation of the whole figure about its center.",
      s2_scale: "Spiro 2 Scale (4-60): zoom from spiro-space units to pixels; with R it also sets the fixed circle's bounce inset.",
      s2_xOffset: "Spiro 2 X (-1..1): nudges the drift home position horizontally (center still drifts and bounces).",
      s2_yOffset: "Spiro 2 Y (-1..1): nudges the drift home position vertically (center still drifts and bounces).",
      s2_thickness: "Spiro 2 Width (0.5-12 px): stroke line width, drawn with round joins and caps.",
      s2_chroma: "Spiro 2 Hue (0-1 colorwheel): the curve's color in the COLOR output (MONO and CANDY ignore it).",
      s3_R: "Spiro 3 Fixed (R, 1-12): the fixed outer circle radius; with Roll it sets the petal/loop ratio.",
      s3_r: "Spiro 3 Roll (r, 0.5-11): the rolling circle radius; the R:r ratio defines the figure and revolutions to close.",
      s3_p: "Spiro 3 Pen (p, 0-8): pen offset in the rolling circle; 0 traces a plain circle, larger makes deeper loops.",
      s3_inside: "Spiro 3 In/Out toggle: INSIDE = hypotrochoid (rolling circle inside), OUTSIDE = epitrochoid (rolling circle outside).",
      s3_rotation: "Spiro 3 Rot (0-2pi radians): static rotation of the whole figure about its center.",
      s3_scale: "Spiro 3 Scale (4-60): zoom from spiro-space units to pixels; with R it also sets the fixed circle's bounce inset.",
      s3_xOffset: "Spiro 3 X (-1..1): nudges the drift home position horizontally (center still drifts and bounces).",
      s3_yOffset: "Spiro 3 Y (-1..1): nudges the drift home position vertically (center still drifts and bounces).",
      s3_thickness: "Spiro 3 Width (0.5-12 px): stroke line width, drawn with round joins and caps.",
      s3_chroma: "Spiro 3 Hue (0-1 colorwheel): the curve's color in the COLOR output (MONO and CANDY ignore it).",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uScene = gl.getUniformLocation(program, 'uScene');
    // Separate program for the overlap output: same fullscreen quad, but the
    // frag colour-maps the density buffer into the cascading-rainbow candy.
    const overlapProgram = ctx.compileFragment(OVERLAP_FRAG);
    const uOverlapScene = gl.getUniformLocation(overlapProgram, 'uScene');

    const colorFbo = ctx.createFbo();
    const monoFbo = ctx.createFbo();
    const overlapFbo = ctx.createFbo();

    const params: Record<string, number> = { ...DEFAULTS, ...(node.params as Record<string, number>) };

    // ---- Two scene canvases (colour + mono) + their upload textures ----
    // Both may be absent in headless node test envs — fall through to null so
    // the factory still spawns + draw() no-ops the paint/upload.
    function makeCanvas(): OffscreenCanvas | HTMLCanvasElement | null {
      try {
        if (typeof OffscreenCanvas !== 'undefined') {
          return new OffscreenCanvas(ctx.res.width, ctx.res.height);
        }
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          c.width = ctx.res.width;
          c.height = ctx.res.height;
          return c;
        }
      } catch {
        return null;
      }
      return null;
    }
    const colorCanvas = makeCanvas();
    const monoCanvas = makeCanvas();
    const overlapCanvas = makeCanvas();
    const colorCtx = colorCanvas
      ? (colorCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
      : null;
    const monoCtx = monoCanvas
      ? (monoCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
      : null;
    const overlapCtx = overlapCanvas
      ? (overlapCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)
      : null;

    function makeSceneTex(): WebGLTexture {
      const t = gl.createTexture();
      if (!t) throw new Error('SPIROGRAPHS: createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
      return t;
    }
    const colorTex = makeSceneTex();
    const monoTex = makeSceneTex();
    const overlapTex = makeSceneTex();

    let framesElapsed = 0;

    /** Resolve the live per-spiro params + bounce-constrained center into the
     *  renderer's ResolvedSpiro list for the first `count` spiros. */
    function resolveSpiros(timeSec: number): ResolvedSpiro[] {
      const count = Math.max(1, Math.min(SPIRO_COUNT_MAX, Math.round(params.count ?? 1)));
      const W = ctx.res.width;
      const H = ctx.res.height;
      const list: ResolvedSpiro[] = [];
      for (let i = 1; i <= count; i++) {
        const R = clampStem('R', params[spiroParamId(i, 'R')] ?? 5);
        const r = clampStem('r', params[spiroParamId(i, 'r')] ?? 3);
        const p = clampStem('p', params[spiroParamId(i, 'p')] ?? 2);
        const insideV = params[spiroParamId(i, 'inside')] ?? 1;
        const kind: SpiroKind = insideV >= 0.5 ? 'inside' : 'outside';
        const rotation = clampStem('rotation', params[spiroParamId(i, 'rotation')] ?? 0);
        const scale = clampStem('scale', params[spiroParamId(i, 'scale')] ?? 24);
        const xOff = clampStem('xOffset', params[spiroParamId(i, 'xOffset')] ?? 0);
        const yOff = clampStem('yOffset', params[spiroParamId(i, 'yOffset')] ?? 0);
        const thickness = clampStem('thickness', params[spiroParamId(i, 'thickness')] ?? 2);
        const chroma = clampStem('chroma', params[spiroParamId(i, 'chroma')] ?? 0);

        // The screen radius of the FIXED circle (R, scaled). This is what the
        // bounce-constraint insets the center by so the circle never leaves frame.
        const fixedRadiusPx = R * scale;

        // Home position (xOffset/yOffset nudge the drift's home a little) + the
        // per-spiro drift velocity, converted from frame-fractions to pixels.
        const drift = SPIRO_DRIFT[i]!;
        const homeX = (drift.hx + xOff * 0.25) * W;
        const homeY = (drift.hy + yOff * 0.25) * H;
        const base: CenterState = {
          x: homeX,
          y: homeY,
          vx: drift.vx * W,
          vy: drift.vy * H,
        };
        const c = advanceCenter(base, fixedRadiusPx, W, H, timeSec);

        list.push({
          kind, R, r, p, rotation, scale,
          cx: c.x, cy: c.y,
          thickness, hue: chroma,
        });
      }
      return list;
    }

    const surface: VideoNodeSurface = {
      fbo: colorFbo.fbo,
      texture: colorFbo.texture,
      draw(frame) {
        const g = frame.gl;
        const timeSec = frame.time;
        const spiros = resolveSpiros(timeSec);
        const W = ctx.res.width;
        const H = ctx.res.height;

        // 1. Paint all three scenes (colour + mono matte + overlap density) on
        //    their 2D canvases.
        if (colorCtx) drawColorScene(colorCtx, spiros, W, H);
        if (monoCtx) drawMonoScene(monoCtx, spiros, W, H);
        if (overlapCtx) drawOverlapScene(overlapCtx, spiros, W, H);

        // 2. Upload each painted canvas to its texture, then run a fullscreen-
        //    quad shader to write it into the matching FBO. The colour + mono
        //    outputs use the plain copy program; the overlap output uses the
        //    density→rainbow colour-map program.
        const uploadAndBlit = (
          canvas: OffscreenCanvas | HTMLCanvasElement | null,
          tex: WebGLTexture,
          fbo: WebGLFramebuffer | null,
          prog: WebGLProgram,
          uSampler: WebGLUniformLocation | null,
        ) => {
          if (!canvas || !fbo) return;
          g.bindTexture(g.TEXTURE_2D, tex);
          g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
          g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, canvas as unknown as TexImageSource);
          g.bindFramebuffer(g.FRAMEBUFFER, fbo);
          g.viewport(0, 0, W, H);
          g.useProgram(prog);
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, tex);
          g.uniform1i(uSampler, 0);
          ctx.drawFullscreenQuad();
          g.bindFramebuffer(g.FRAMEBUFFER, null);
        };
        uploadAndBlit(colorCanvas, colorTex, colorFbo.fbo, program, uScene);
        uploadAndBlit(monoCanvas, monoTex, monoFbo.fbo, program, uScene);
        uploadAndBlit(overlapCanvas, overlapTex, overlapFbo.fbo, overlapProgram, uOverlapScene);

        framesElapsed++;
      },
      dispose() {
        gl.deleteFramebuffer(colorFbo.fbo);
        gl.deleteTexture(colorFbo.texture);
        gl.deleteFramebuffer(monoFbo.fbo);
        gl.deleteTexture(monoFbo.texture);
        gl.deleteFramebuffer(overlapFbo.fbo);
        gl.deleteTexture(overlapFbo.texture);
        gl.deleteTexture(colorTex);
        gl.deleteTexture(monoTex);
        gl.deleteTexture(overlapTex);
        gl.deleteProgram(program);
        gl.deleteProgram(overlapProgram);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) params[paramId] = value;
      },
      readParam(paramId) {
        return params[paramId];
      },
      read(key) {
        // Multi-output texture lookup (engine's lookupInput calls this for any
        // edge whose source port id != the canonical 'out').
        if (key === 'outputTexture:out') return colorFbo.texture;
        if (key === 'outputTexture:mono_out') return monoFbo.texture;
        if (key === 'outputTexture:overlap') return overlapFbo.texture;
        if (key === 'framesElapsed') return framesElapsed;
        // Card preview snapshot hook (mirrors AcidwarpCard/ShapegenCard).
        if (key === 'sceneCanvas') return colorCanvas;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
