// packages/web/src/lib/video/modules/shapedramps.ts
//
// SHAPEDRAMPS — sync-locked ramp generator.
//
// Emits four mono-video outputs:
//   h_lin / v_lin   stable identity ramps (R = u for h_lin, R = v for v_lin).
//                   Independent of every CV input and knob — patching them
//                   into RUTTETRA.x / RUTTETRA.y guarantees a clean
//                   raster passthrough (RUTTETRA = identity coordinate
//                   system → output equals input).
//   h_out / v_out   shaped ramps. Morph between four canonical shapes via
//                   h_shape / v_shape (0..1):
//                       0.00  linear     shape(t) = t
//                       0.33  triangle   shape(t) = abs(2t-1)
//                       0.66  soft-fold  shape(t) = 0.5 - 0.5*cos(2*PI*t)
//                       1.00  radial     H out = length(uv-0.5)*sqrt(2)
//                                        V out = (atan2(v-0.5, u-0.5)/TAU) + 0.5
//                   Adjacent shape pairs blend linearly. h_phase / v_phase
//                   shift the ramp before shaping; h_freq / v_freq scale
//                   the input variable (so frequency=2 doubles the ramp
//                   so triangle becomes a 2-period zigzag).
//
// Architecture:
//   - The two stable linear outputs share a single trivial fragment shader
//     that simply writes the screen-space u or v into the red channel.
//     Two FBOs, one program, deterministic.
//   - The two shaped outputs share a more elaborate shader that handles
//     freq + phase + four-way shape morph + radial. An axis uniform
//     selects whether we're rendering the H ramp or the V ramp.
//   - All four ramps render once per frame regardless of patch state, so
//     downstream consumers can always sample fresh textures.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const LIN_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float uAxis; // 0 = horizontal (R = u), 1 = vertical (R = v)

void main() {
  float r = uAxis < 0.5 ? vUv.x : vUv.y;
  outColor = vec4(r, r, r, 1.0);
}`;

const SHAPED_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform float uAxis;   // 0 = horizontal, 1 = vertical
uniform float uShape;  // 0..1 — morph parameter
uniform float uPhase;  // 0..1 — phase offset
uniform float uFreq;   // 0.5..8 — frequency multiplier

const float TAU = 6.2831853;

// Four canonical shapes evaluated at scalar input t in [0, 1) (after
// fract). Linearly interpolated four-way morph. Radial is treated
// separately because it reads 2D coords (the centered uv vec2), not the
// pre-shaped scalar.
float shapeLinear(float t)   { return t; }
float shapeTriangle(float t) { return abs(2.0 * t - 1.0); }
float shapeFold(float t)     { return 0.5 - 0.5 * cos(TAU * t); }

// Radial: distance from canvas center (H axis) or angle around center
// (V axis). For a clean pair-of-radial readout, H = radius (0..1 within
// the inscribed disc, naturally extending past 1 in the corners — we
// clamp), V = angle / TAU + 0.5.
float shapeRadialH(vec2 uv) {
  // length(vec(0.5, 0.5)) = sqrt(0.5) ≈ 0.707; multiplying by sqrt(2)
  // makes the corner pixels read 1.0, so the radial ramp spans the
  // full 0..1 range across the canvas.
  return clamp(length(uv - 0.5) * 1.4142136, 0.0, 1.0);
}
float shapeRadialV(vec2 uv) {
  vec2 d = uv - 0.5;
  return atan(d.y, d.x) / TAU + 0.5;
}

void main() {
  // Phase + freq applied to the axis variable BEFORE shaping. Wrap with
  // fract so freq>1 simply repeats the chosen shape periodically across
  // the canvas (e.g. triangle freq=2 → zigzag with two peaks).
  float axisVar = uAxis < 0.5 ? vUv.x : vUv.y;
  float t = fract(axisVar * uFreq + uPhase);

  // Four canonical shape values at this t.
  float vLin = shapeLinear(t);
  float vTri = shapeTriangle(t);
  float vFold = shapeFold(t);
  float vRad = uAxis < 0.5 ? shapeRadialH(vUv) : shapeRadialV(vUv);

  // Map uShape in [0, 1] across four shapes spaced at 0, 1/3, 2/3, 1.
  // Compute segment index + sub-fraction so we can lerp between adjacent
  // shapes. Three segments (linear→triangle, triangle→fold, fold→radial)
  // covering s ∈ [0, 1], [1, 2], [2, 3]. We clamp seg to [0, 2] so
  // uShape=1 (s=3) lands as seg=2, frac=1, giving us vRad exactly.
  float s = clamp(uShape, 0.0, 1.0) * 3.0; // 0..3
  float seg = clamp(floor(s), 0.0, 2.0);
  float frac = clamp(s - seg, 0.0, 1.0);
  float r;
  if (seg < 0.5) {           // 0..1: linear → triangle
    r = mix(vLin, vTri, frac);
  } else if (seg < 1.5) {    // 1..2: triangle → fold
    r = mix(vTri, vFold, frac);
  } else {                   // 2..3: fold → radial
    r = mix(vFold, vRad, frac);
  }

  outColor = vec4(r, r, r, 1.0);
}`;

interface ShapedrampsParams {
  h_shape: number;
  v_shape: number;
  h_phase: number;
  v_phase: number;
  h_freq: number;
  v_freq: number;
}

const DEFAULTS: ShapedrampsParams = {
  h_shape: 0,
  v_shape: 0,
  h_phase: 0,
  v_phase: 0,
  h_freq: 1,
  v_freq: 1,
};

export const shapedrampsDef: VideoModuleDef = {
  type: 'shapedramps',
  domain: 'video',
  label: 'SHAPEDRAMPS',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    // CV inputs — port id == param id so the cross-domain CV bridge in
    // PatchEngine routes audio cv signals into VideoEngine.setParam.
    // cvScale 'linear' for continuous morph parameters.
    { id: 'h_shape', type: 'cv', paramTarget: 'h_shape', cvScale: { mode: 'linear' } },
    { id: 'v_shape', type: 'cv', paramTarget: 'v_shape', cvScale: { mode: 'linear' } },
    { id: 'h_phase', type: 'cv', paramTarget: 'h_phase', cvScale: { mode: 'linear' } },
    { id: 'v_phase', type: 'cv', paramTarget: 'v_phase', cvScale: { mode: 'linear' } },
    { id: 'h_freq',  type: 'cv', paramTarget: 'h_freq',  cvScale: { mode: 'linear' } },
    { id: 'v_freq',  type: 'cv', paramTarget: 'v_freq',  cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'h_lin', type: 'mono-video' },
    { id: 'v_lin', type: 'mono-video' },
    { id: 'h_out', type: 'mono-video' },
    { id: 'v_out', type: 'mono-video' },
  ],
  params: [
    { id: 'h_shape', label: 'H Shape', defaultValue: DEFAULTS.h_shape, min: 0,   max: 1, curve: 'linear' },
    { id: 'v_shape', label: 'V Shape', defaultValue: DEFAULTS.v_shape, min: 0,   max: 1, curve: 'linear' },
    { id: 'h_phase', label: 'H Phase', defaultValue: DEFAULTS.h_phase, min: 0,   max: 1, curve: 'linear' },
    { id: 'v_phase', label: 'V Phase', defaultValue: DEFAULTS.v_phase, min: 0,   max: 1, curve: 'linear' },
    { id: 'h_freq',  label: 'H Freq',  defaultValue: DEFAULTS.h_freq,  min: 0.5, max: 8, curve: 'linear' },
    { id: 'v_freq',  label: 'V Freq',  defaultValue: DEFAULTS.v_freq,  min: 0.5, max: 8, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const linProgram = ctx.compileFragment(LIN_FRAG_SRC);
    const shapedProgram = ctx.compileFragment(SHAPED_FRAG_SRC);

    const linUAxis  = gl.getUniformLocation(linProgram, 'uAxis');

    const shUAxis   = gl.getUniformLocation(shapedProgram, 'uAxis');
    const shUShape  = gl.getUniformLocation(shapedProgram, 'uShape');
    const shUPhase  = gl.getUniformLocation(shapedProgram, 'uPhase');
    const shUFreq   = gl.getUniformLocation(shapedProgram, 'uFreq');

    // Four FBOs — one per output port. Indexed in declaration order so
    // the dispatch table below maps port id → texture by name.
    const fboH_lin = ctx.createFbo();
    const fboV_lin = ctx.createFbo();
    const fboH_out = ctx.createFbo();
    const fboV_out = ctx.createFbo();

    const params: ShapedrampsParams = { ...DEFAULTS, ...(node.params as Partial<ShapedrampsParams>) };

    // The engine's lookupInput follows surface.texture for a single output,
    // but SHAPEDRAMPS has four outputs. We expose the canonical "main"
    // texture as h_out (for legacy single-texture consumers) and rely on
    // a per-output texture lookup hook below.
    const surface: VideoNodeSurface = {
      fbo: fboH_out.fbo,
      texture: fboH_out.texture,
      draw(_frame) {
        const g = ctx.gl;

        // Linear ramps — share the LIN program, axis selects which.
        g.useProgram(linProgram);

        g.bindFramebuffer(g.FRAMEBUFFER, fboH_lin.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.uniform1f(linUAxis, 0.0);
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, fboV_lin.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.uniform1f(linUAxis, 1.0);
        ctx.drawFullscreenQuad();

        // Shaped ramps — share the SHAPED program, axis + per-axis params
        // select which.
        g.useProgram(shapedProgram);

        g.bindFramebuffer(g.FRAMEBUFFER, fboH_out.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.uniform1f(shUAxis,  0.0);
        g.uniform1f(shUShape, params.h_shape);
        g.uniform1f(shUPhase, params.h_phase);
        g.uniform1f(shUFreq,  params.h_freq);
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, fboV_out.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.uniform1f(shUAxis,  1.0);
        g.uniform1f(shUShape, params.v_shape);
        g.uniform1f(shUPhase, params.v_phase);
        g.uniform1f(shUFreq,  params.v_freq);
        ctx.drawFullscreenQuad();

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fboH_lin.fbo);
        gl.deleteTexture(fboH_lin.texture);
        gl.deleteFramebuffer(fboV_lin.fbo);
        gl.deleteTexture(fboV_lin.texture);
        gl.deleteFramebuffer(fboH_out.fbo);
        gl.deleteTexture(fboH_out.texture);
        gl.deleteFramebuffer(fboV_out.fbo);
        gl.deleteTexture(fboV_out.texture);
        gl.deleteProgram(linProgram);
        gl.deleteProgram(shapedProgram);
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
        // Per-output texture lookup. Engine doesn't currently route
        // multi-output textures via ModuleDef.outputs; this `read` hook
        // is the documented escape hatch (see VideoNodeHandle.read).
        // The custom texture-router patch in the engine reads
        // 'outputTexture:<portId>' so multi-output sources can expose
        // their per-port textures without changing every consumer.
        if (key === 'outputTexture:h_lin') return fboH_lin.texture;
        if (key === 'outputTexture:v_lin') return fboV_lin.texture;
        if (key === 'outputTexture:h_out') return fboH_out.texture;
        if (key === 'outputTexture:v_out') return fboV_out.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
