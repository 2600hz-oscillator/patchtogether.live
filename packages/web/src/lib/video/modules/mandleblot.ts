// packages/web/src/lib/video/modules/mandleblot.ts
//
// MANDLEBLOT — Mandelbrot fractal generator with zoom + rotation +
// RGB-cycling iteration shading. Two video outputs (mono + color).
//
// Inspired by https://github.com/rafgraph/fractal — borrowed the standard
// smooth-coloring fractional iteration trick (mu = i + 1 - log(log|z|)/log2)
// so the colour bands don't stairstep.
//
// Render pipeline:
//   - WebGL2 fragment shader, single full-screen quad, escape-time loop in
//     GLSL with `highp float` (mediump would die past ~10² zoom). The
//     practical single-precision ceiling is ~1e6×; past that the pixel
//     coords go subgrid and the iteration loop pixelates into giant blocks.
//   - The shader supports both MONO (greyscale escape-time) and COLOR
//     (HSV→RGB hue derived from mu + time + log(zoom)) modes via a uniform
//     toggle. We render the same program twice per frame — once into
//     `mono_out`'s FBO with uMono=1, once into `color_out`'s FBO with
//     uMono=0. Cheap (the heavy work is the iteration loop, which both
//     passes pay for anyway; the colour math is a handful of ops).
//
// Why hue includes a `log(uZoom)` term:
//   The user explicitly wants the colours to SHIFT as you zoom. Different
//   zoom levels expose different iteration-count distributions in the
//   visible region; coupling hue to log(uZoom) makes each zoom step feel
//   like its own palette, not just "deeper into the same colours". Time
//   adds a continuous secondary cycle (uColorCycle scales both).
//
// Zoom mapping:
//   Param `zoom` is presented to the user as 0..1 with curve='log' (the
//   knob's log curve gives smooth feel near the low end), then mapped
//   INSIDE the factory to a real zoom factor on a log scale:
//     0.0 → 1×, 0.5 → ~1000×, 0.8 → ~1e5×, 1.0 → 1e6×.
//   `jsZoomFromKnob` is the pure helper that performs this mapping; the
//   shader receives the post-mapping factor in uZoom.
//
// Single-precision ceiling: even with highp float (32-bit), past ~1e6×
// pixel deltas drop below float resolution and the image goes block-y.
// Double-precision emulation in WebGL is a v2+ concern.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

/**
 * Map the user-facing zoom knob (0..1, curve='log' in the UI) to the real
 * zoom factor the shader uses.
 *
 *   knob 0.0 → 1×           (full Mandelbrot set in view)
 *   knob 0.5 → ~1000×       (mid-zoom, classic seahorse-valley territory)
 *   knob 0.8 → ~100,000×    (deep zoom, banding starts to show)
 *   knob 1.0 → 1e6×         (practical highp-float ceiling)
 *
 * The mapping is `10 ^ (6 * knob)` — exponential in knob position so the
 * full 0..1 range covers the useful 1×..1e6× span on a perceptually
 * even scale.
 */
export function jsZoomFromKnob(knob: number): number {
  const k = Math.max(0, Math.min(1, knob));
  return Math.pow(10, 6 * k);
}

/**
 * Pure-TS reference for the escape-time iteration the shader runs. Loops
 * z = z² + c until |z|² > 4 (escape radius 2) or iterations exhausted.
 * Returns the iteration count when escape occurred, or `maxIter` if the
 * point is (probably) in the set.
 *
 * Also returns the final |z|² so callers can apply the smooth-coloring
 * formula without re-running the loop.
 */
export function escapeTime(
  cx: number,
  cy: number,
  maxIter: number,
): { i: number; dotZ: number } {
  let zx = 0;
  let zy = 0;
  let i = 0;
  for (; i < maxIter; i++) {
    const zx2 = zx * zx;
    const zy2 = zy * zy;
    if (zx2 + zy2 > 256.0) {
      // Bailout radius 16 (256 = 16²) — large bailout matters for the
      // smooth-coloring formula's accuracy. Smaller bailouts (4 = 2²) work
      // but band the colour shift visibly.
      return { i, dotZ: zx2 + zy2 };
    }
    const newZx = zx2 - zy2 + cx;
    zy = 2 * zx * zy + cy;
    zx = newZx;
  }
  // Didn't escape — assumed in-set. dotZ at this point is whatever the
  // last iteration computed; for in-set points we never use it (the
  // smooth-coloring formula branches on i<maxIter).
  return { i: maxIter, dotZ: zx * zx + zy * zy };
}

/**
 * Standard smooth-coloring fractional iteration count:
 *   mu = i + 1 - log( log(|z|) ) / log(2)
 * (equivalent: i + 1 - log2( 0.5 * log(|z|²) )).
 *
 * For points that DIDN'T escape (i == maxIter), returns maxIter so the
 * caller can produce a stable "in-set" colour. For escaped points,
 * returns a continuous value in roughly [i, i+1] that removes the
 * stairstep colour banding the integer count would otherwise produce.
 */
export function smoothMu(i: number, dotZ: number, maxIter: number): number {
  if (i >= maxIter) return maxIter;
  // log( log(|z|) ) / log(2) == log2( 0.5 * log(|z|²) )
  return i + 1 - Math.log(0.5 * Math.log(dotZ)) / Math.log(2);
}

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float uZoom;        // real zoom factor (post-jsZoomFromKnob)
uniform vec2  uCenter;      // (center_x, center_y)
uniform float uRotation;    // radians (0..2π)
uniform float uIterations;  // 50..500
uniform float uColorCycle;  // 0..4
uniform float uTime;        // seconds — drives the continuous hue cycle
uniform vec2  uResolution;  // engine framebuffer res
uniform float uMono;        // 1.0 = mono mode, 0.0 = colour mode

vec2 cMul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

void main() {
  // Centre at origin, square aspect (divide by Y so X stretches with the
  // aspect ratio + the frame stays uncropped).
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

  // Rotate uv about the origin so the rotation is centred on the current
  // view centre (not the corner).
  float c = cos(uRotation), s = sin(uRotation);
  uv = mat2(c, -s, s, c) * uv;

  // Zoom + translate into complex-plane coords.
  vec2 c0 = uv / uZoom + uCenter;

  // Escape-time iteration loop. Unrolled to a fixed upper bound (500)
  // with an early-out break — the shader-compiler-friendly form.
  vec2 z = vec2(0.0);
  float iter = 0.0;
  // dot(z, z) at the moment of escape — used for smooth coloring below.
  float dotZ = 0.0;
  for (float i = 0.0; i < 500.0; i += 1.0) {
    if (i >= uIterations) break;
    z = cMul(z, z) + c0;
    dotZ = dot(z, z);
    if (dotZ > 256.0) { iter = i; break; }
    iter = i + 1.0;
  }

  // Smooth-coloring: fractional iteration count via the standard trick.
  // For points that didn't escape (iter == uIterations), keep mu pinned
  // to uIterations so the in-set region renders as a stable dark colour.
  float mu = iter;
  if (iter < uIterations) {
    mu = iter + 1.0 - log(log(dotZ) * 0.5) / log(2.0);
  }

  if (uMono > 0.5) {
    // MONO: brightness scales with normalised mu. In-set points → 0
    // (black); escaped points fan from black-ish at low mu to white at
    // high mu (~uIterations).
    float v = clamp(mu / uIterations, 0.0, 1.0);
    outColor = vec4(v, v, v, 1.0);
  } else {
    // COLOUR: hue cycles with mu (so each iteration band gets its own
    // colour), time (continuous palette shift), and log(uZoom) (the
    // user's "colours shift as you zoom" intent). uColorCycle scales
    // both time + zoom contributions; mu's contribution is left at a
    // fixed rate so the banding remains visible at every zoom depth.
    float hue = mod(
      mu * 0.05
      + uTime * 0.1 * uColorCycle
      + log(uZoom) * 0.1 * uColorCycle,
      1.0
    );
    // hue → RGB (compact HSV→RGB with full saturation + value 1).
    vec3 col = clamp(
      abs(mod(hue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
      0.0, 1.0
    );
    // In-set points → black so the set's silhouette is preserved.
    if (iter >= uIterations) col = vec3(0.0);
    outColor = vec4(col, 1.0);
  }
}`;

interface MandleblotParams {
  zoom: number;          // 0..1 — knob position, mapped via jsZoomFromKnob
  rotation: number;      // 0..1 — knob position, mapped to 0..2π radians
  iterations: number;    // 50..500 — max escape iterations (discrete)
  color_cycle: number;   // 0..4 — hue cycling speed
  center_x: number;      // -2..2 — real part of view centre
  center_y: number;      // -2..2 — imag part of view centre
}

const DEFAULTS: MandleblotParams = {
  zoom: 0.2,         // ~10× — past the "whole-set" view, into the bulb edge
  rotation: 0,
  iterations: 150,
  color_cycle: 1,
  center_x: -0.7,    // classic Mandelbrot framing — main cardioid centred-ish
  center_y: 0,
};

export const MANDLEBLOT_DEFAULTS: Readonly<MandleblotParams> = DEFAULTS;

export const mandleblotDef: VideoModuleDef = {
  type: 'mandleblot',
  domain: 'video',
  label: 'MANDLEBLOT',
  category: 'video-effects',
  schemaVersion: 1,
  inputs: [
    // zoom_cv: user explicitly asked for a CV input on zoom. Rotation
    // is knob-only by user direction (no rotation_cv).
    { id: 'zoom_cv', type: 'cv', paramTarget: 'zoom', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    // Two outputs. mono_out is the greyscale escape-time field; color_out
    // is the RGB-cycling palette. Both come from the same iteration loop
    // (we re-render the shader with the uMono toggle flipped).
    { id: 'mono_out',  type: 'mono-video' },
    { id: 'color_out', type: 'video' },
  ],
  params: [
    // zoom: knob position 0..1 with curve='log' (the UI fader interprets
    // this; the factory maps the post-curve value through jsZoomFromKnob
    // to get the real zoom factor handed to the shader).
    { id: 'zoom',        label: 'Zoom',  defaultValue: DEFAULTS.zoom,        min: 0,    max: 1,    curve: 'log' },
    { id: 'rotation',    label: 'Rot',   defaultValue: DEFAULTS.rotation,    min: 0,    max: 1,    curve: 'linear' },
    { id: 'iterations',  label: 'Iter',  defaultValue: DEFAULTS.iterations,  min: 50,   max: 500,  curve: 'discrete' },
    { id: 'color_cycle', label: 'Color', defaultValue: DEFAULTS.color_cycle, min: 0,    max: 4,    curve: 'linear' },
    { id: 'center_x',    label: 'X',     defaultValue: DEFAULTS.center_x,    min: -2,   max: 2,    curve: 'linear' },
    { id: 'center_y',    label: 'Y',     defaultValue: DEFAULTS.center_y,    min: -2,   max: 2,    curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uZoom        = gl.getUniformLocation(program, 'uZoom');
    const uCenter      = gl.getUniformLocation(program, 'uCenter');
    const uRotation    = gl.getUniformLocation(program, 'uRotation');
    const uIterations  = gl.getUniformLocation(program, 'uIterations');
    const uColorCycle  = gl.getUniformLocation(program, 'uColorCycle');
    const uTime        = gl.getUniformLocation(program, 'uTime');
    const uResolution  = gl.getUniformLocation(program, 'uResolution');
    const uMono        = gl.getUniformLocation(program, 'uMono');

    // Two FBOs — one per output. We render the same program twice per
    // frame (once into each FBO) with uMono flipped. The mono pass + the
    // colour pass share the iteration loop's cost (each pass runs the
    // loop independently), but the colour-mapping math is cheap so the
    // doubling is workable for the targeted 60 fps.
    const monoFbo  = ctx.createFbo();
    const colorFbo = ctx.createFbo();

    const params: MandleblotParams = { ...DEFAULTS, ...(node.params as Partial<MandleblotParams>) };

    // Expose the canonical surface as the COLOUR output. Downstream
    // consumers that wire the canonical handle (legacy single-output
    // consumers) get the colour pass by default; mono_out is reachable
    // via the read('outputTexture:<portId>') escape hatch.
    const surface: VideoNodeSurface = {
      fbo: colorFbo.fbo,
      texture: colorFbo.texture,
      draw(frame) {
        const g = frame.gl;

        // Resolve uniforms shared between the two passes.
        const zoomKnob = params.zoom;
        const zoomFactor = jsZoomFromKnob(zoomKnob);
        const rotRad = (Math.max(0, Math.min(1, params.rotation))) * 2 * Math.PI;
        // iterations: clamp to schema range + integer (the shader's loop
        // upper bound is 500; iter param has a discrete curve so it
        // should already be integer-valued, but defend against persisted
        // out-of-range values).
        const iterCount = Math.max(50, Math.min(500, Math.round(params.iterations)));

        g.useProgram(program);
        g.uniform1f(uZoom,       zoomFactor);
        g.uniform2f(uCenter,     params.center_x, params.center_y);
        g.uniform1f(uRotation,   rotRad);
        g.uniform1f(uIterations, iterCount);
        g.uniform1f(uColorCycle, params.color_cycle);
        g.uniform1f(uTime,       frame.time);
        g.uniform2f(uResolution, ctx.res.width, ctx.res.height);

        // MONO pass.
        g.bindFramebuffer(g.FRAMEBUFFER, monoFbo.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.uniform1f(uMono, 1.0);
        ctx.drawFullscreenQuad();

        // COLOUR pass.
        g.bindFramebuffer(g.FRAMEBUFFER, colorFbo.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.uniform1f(uMono, 0.0);
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(monoFbo.fbo);
        gl.deleteTexture(monoFbo.texture);
        gl.deleteFramebuffer(colorFbo.fbo);
        gl.deleteTexture(colorFbo.texture);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) {
          (params as unknown as Record<string, number>)[paramId] = value;
        }
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // Multi-output texture lookup. The engine's lookupInput calls
        // this for any edge whose source port id != the canonical 'out';
        // see fourPlexVidDef for the same pattern + engine.ts line 905.
        if (key === 'outputTexture:mono_out')  return monoFbo.texture;
        if (key === 'outputTexture:color_out') return colorFbo.texture;
        // Expose the live zoom factor (post-mapping) for the card readout.
        if (key === 'zoomFactor') return jsZoomFromKnob(params.zoom);
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
