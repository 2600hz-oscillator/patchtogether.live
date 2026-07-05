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
// Plus two onboard 2-channel mixers (mix1 / mix2):
//   mix1_a, mix1_b → mix1_out      out = (1 - mix1) * A + mix1 * B
//   mix2_a, mix2_b → mix2_out      out = (1 - mix2) * A + mix2 * B
//   mix1_cv / mix2_cv modulate the per-mixer amount (linear).
//   The mixers exist so users can blend ramp shapes without inserting an
//   external V-MIXER (e.g. crossfade h_lin ↔ h_out into RUTTETRA.x), but
//   they accept ANY mono-video signal — they're general-purpose.
//
// Architecture:
//   - The two stable linear outputs share a single trivial fragment shader
//     that simply writes the screen-space u or v into the red channel.
//     Two FBOs, one program, deterministic.
//   - The two shaped outputs share a more elaborate shader that handles
//     freq + phase + four-way shape morph + radial. An axis uniform
//     selects whether we're rendering the H ramp or the V ramp.
//   - The two onboard mixers share a third (crossfade) program that
//     samples two input textures + a mix amount and writes the linear
//     blend. Each mixer gets its own FBO.
//   - All four ramps + both mixers render once per frame regardless of
//     patch state, so downstream consumers can always sample fresh
//     textures.
//
// Inputs:
//   h_shape / v_shape / h_phase / v_phase / h_freq / v_freq (cv, linear, paramTarget=…):
//     per-axis ramp-shape / phase / frequency CV.
//   mix1_a / mix1_b / mix2_a / mix2_b (mono-video): A/B inputs for the two internal mixers.
//   mix1_cv / mix2_cv (cv, linear, paramTarget=mix{N}): per-mixer crossfade CV.
//
// Outputs:
//   h_lin / v_lin (mono-video): stable linear identity ramps (clean raster passthrough).
//   h_out / v_out (mono-video): shaped ramps (morphable per the shape params).
//   mix1_out / mix2_out (mono-video): per-mixer crossfade outputs.
//
// Params:
//   h_shape / v_shape (linear 0..1): per-axis shape morph (linear / triangle / soft-fold / radial).
//   h_phase / v_phase (linear 0..1): per-axis phase offset.
//   h_freq / v_freq (linear 0.5..8): per-axis ramp frequency multiplier.
//   mix1 / mix2 (linear 0..1): per-mixer crossfade amount.

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

// 2-channel linear crossfade. out = (1 - amount) * A + amount * B.
// uHasA / uHasB are 1.0 when the corresponding input is patched (so the
// mixer outputs A alone if B is unpatched, B alone if A is unpatched,
// black if neither).
const MIX_FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uHasA;
uniform float uHasB;
uniform float uAmount;

void main() {
  vec3 a = uHasA > 0.5 ? texture(uTexA, vUv).rgb : vec3(0.0);
  vec3 b = uHasB > 0.5 ? texture(uTexB, vUv).rgb : vec3(0.0);
  float t = clamp(uAmount, 0.0, 1.0);
  vec3 c = (1.0 - t) * a + t * b;
  outColor = vec4(c, 1.0);
}`;

/** Pure mix math used by the MIX shader: out = (1 - amount) * A + amount * B,
 *  with `amount` clamped to [0, 1]. Exported so the unit test can verify the
 *  shader implementation against a deterministic JS reference. */
export function shapedrampsMix(a: number, b: number, amount: number): number {
  const t = Math.min(1, Math.max(0, amount));
  return (1 - t) * a + t * b;
}

interface ShapedrampsParams {
  h_shape: number;
  v_shape: number;
  h_phase: number;
  v_phase: number;
  h_freq: number;
  v_freq: number;
  mix1: number;
  mix2: number;
}

const DEFAULTS: ShapedrampsParams = {
  h_shape: 0,
  v_shape: 0,
  h_phase: 0,
  v_phase: 0,
  h_freq: 1,
  v_freq: 1,
  mix1: 0.5,
  mix2: 0.5,
};

export const shapedrampsDef: VideoModuleDef = {
  type: 'shapedramps',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'shapedramps',
  category: 'sources',
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
    // Onboard mixer signal inputs (mono-video). Mix1: A + B → mix1_out.
    // Mix2: A + B → mix2_out. The mix amount comes from mix{N}_cv (CV) or
    // the mix{N} knob.
    { id: 'mix1_a', type: 'mono-video' },
    { id: 'mix1_b', type: 'mono-video' },
    { id: 'mix2_a', type: 'mono-video' },
    { id: 'mix2_b', type: 'mono-video' },
    { id: 'mix1_cv', type: 'cv', paramTarget: 'mix1', cvScale: { mode: 'linear' } },
    { id: 'mix2_cv', type: 'cv', paramTarget: 'mix2', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'h_lin', type: 'mono-video' },
    { id: 'v_lin', type: 'mono-video' },
    { id: 'h_out', type: 'mono-video' },
    { id: 'v_out', type: 'mono-video' },
    { id: 'mix1_out', type: 'mono-video' },
    { id: 'mix2_out', type: 'mono-video' },
  ],
  params: [
    { id: 'h_shape', label: 'H Shape', defaultValue: DEFAULTS.h_shape, min: 0,   max: 1, curve: 'linear' },
    { id: 'v_shape', label: 'V Shape', defaultValue: DEFAULTS.v_shape, min: 0,   max: 1, curve: 'linear' },
    { id: 'h_phase', label: 'H Phase', defaultValue: DEFAULTS.h_phase, min: 0,   max: 1, curve: 'linear' },
    { id: 'v_phase', label: 'V Phase', defaultValue: DEFAULTS.v_phase, min: 0,   max: 1, curve: 'linear' },
    { id: 'h_freq',  label: 'H Freq',  defaultValue: DEFAULTS.h_freq,  min: 0.5, max: 8, curve: 'linear' },
    { id: 'v_freq',  label: 'V Freq',  defaultValue: DEFAULTS.v_freq,  min: 0.5, max: 8, curve: 'linear' },
    { id: 'mix1',    label: 'Mix 1',   defaultValue: DEFAULTS.mix1,    min: 0,   max: 1, curve: 'linear' },
    { id: 'mix2',    label: 'Mix 2',   defaultValue: DEFAULTS.mix2,    min: 0,   max: 1, curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "SHAPEDRAMPS is a sync-locked parametric ramp generator for video coordinate synthesis — it draws gradients across the raster rather than processing an incoming picture. It emits four mono-video ramps: h_lin/v_lin are stable identity ramps (red channel = screen u or v, untouched by any knob or CV) for clean raster passthrough into geometry modules like RUTTETRA; h_out/v_out are shaped ramps that morph through four canonical shapes via H Shape / V Shape (0..1): linear (t), triangle (abs(2t-1)), soft-fold (0.5 - 0.5*cos(2pi*t)), and radial (H = distance from center scaled so corners read 1, V = angle around center), blending linearly between adjacent shapes. H/V Phase shift the ramp before shaping; H/V Freq scale the axis variable and fract-wrap it, so freq=2 repeats the shape twice across the canvas (a triangle becomes a two-peak zigzag). It also packs two general-purpose 2-channel video crossfade mixers (out = (1-amount)*A + amount*B) so you can blend ramp shapes without an external V-MIXER, though they accept any mono-video signal. Typical use: feed h_lin/v_lin into a coordinate consumer for an identity raster, then crossfade toward h_out/v_out to warp the geometry; all four ramps and both mixers render every frame so downstream consumers always read fresh textures.",
    inputs: {
      h_shape: "CV (linear) — modulates H Shape, morphing the h_out ramp through linear / triangle / soft-fold / radial as it sweeps 0..1.",
      v_shape: "CV (linear) — modulates V Shape, morphing the v_out ramp through linear / triangle / soft-fold / radial as it sweeps 0..1.",
      h_phase: "CV (linear) — modulates H Phase, shifting the h_out ramp along the horizontal axis before shaping (0..1).",
      v_phase: "CV (linear) — modulates V Phase, shifting the v_out ramp along the vertical axis before shaping (0..1).",
      h_freq: "CV (linear) — modulates H Freq, scaling the horizontal ramp's repeat count (0.5..8); higher values tile the shape more times across the canvas.",
      v_freq: "CV (linear) — modulates V Freq, scaling the vertical ramp's repeat count (0.5..8); higher values tile the shape more times across the canvas.",
      mix1_a: "Mono-video — the A input of onboard mixer 1; crossfaded toward mix1_b by Mix 1. If unpatched, mixer 1 outputs B alone (black if both A and B are unpatched).",
      mix1_b: "Mono-video — the B input of onboard mixer 1; mix1_a is crossfaded toward it by Mix 1. If unpatched, mixer 1 outputs A alone.",
      mix2_a: "Mono-video — the A input of onboard mixer 2; crossfaded toward mix2_b by Mix 2. If unpatched, mixer 2 outputs B alone (black if both A and B are unpatched).",
      mix2_b: "Mono-video — the B input of onboard mixer 2; mix2_a is crossfaded toward it by Mix 2. If unpatched, mixer 2 outputs A alone.",
      mix1_cv: "CV (linear) — modulates the Mix 1 crossfade amount (0 = all A, 1 = all B).",
      mix2_cv: "CV (linear) — modulates the Mix 2 crossfade amount (0 = all A, 1 = all B).",
    },
    outputs: {
      h_lin: "Mono-video — stable horizontal identity ramp (red channel = screen u, left=0 to right=1). Ignores every knob and CV; ideal as a clean raster passthrough.",
      v_lin: "Mono-video — stable vertical identity ramp (red channel = screen v, top=0 to bottom=1). Ignores every knob and CV; ideal as a clean raster passthrough.",
      h_out: "Mono-video — shaped horizontal ramp, morphed by H Shape and offset/scaled by H Phase and H Freq.",
      v_out: "Mono-video — shaped vertical ramp, morphed by V Shape and offset/scaled by V Phase and V Freq.",
      mix1_out: "Mono-video — onboard mixer 1 output: (1-amount)*mix1_a + amount*mix1_b, amount set by Mix 1 / mix1_cv.",
      mix2_out: "Mono-video — onboard mixer 2 output: (1-amount)*mix2_a + amount*mix2_b, amount set by Mix 2 / mix2_cv.",
    },
    controls: {
      h_shape: "H Shape (fader HS, 0..1) — morphs the h_out ramp through linear, triangle, soft-fold, then radial; adjacent shapes blend linearly.",
      v_shape: "V Shape (fader VS, 0..1) — morphs the v_out ramp through linear, triangle, soft-fold, then radial; adjacent shapes blend linearly.",
      h_phase: "H Phase (fader HP, 0..1) — shifts the h_out ramp along the horizontal axis before shaping.",
      v_phase: "V Phase (fader VP, 0..1) — shifts the v_out ramp along the vertical axis before shaping.",
      h_freq: "H Freq (fader HF, 0.5..8, default 1) — scales the horizontal ramp's repeat count so the chosen shape tiles periodically across the canvas.",
      v_freq: "V Freq (fader VF, 0.5..8, default 1) — scales the vertical ramp's repeat count so the chosen shape tiles periodically across the canvas.",
      mix1: "Mix 1 (fader M1, 0..1, default 0.5) — crossfade amount for onboard mixer 1 (0 = all mix1_a, 1 = all mix1_b).",
      mix2: "Mix 2 (fader M2, 0..1, default 0.5) — crossfade amount for onboard mixer 2 (0 = all mix2_a, 1 = all mix2_b).",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const linProgram = ctx.compileFragment(LIN_FRAG_SRC);
    const shapedProgram = ctx.compileFragment(SHAPED_FRAG_SRC);
    const mixProgram = ctx.compileFragment(MIX_FRAG_SRC);

    const linUAxis  = gl.getUniformLocation(linProgram, 'uAxis');

    const shUAxis   = gl.getUniformLocation(shapedProgram, 'uAxis');
    const shUShape  = gl.getUniformLocation(shapedProgram, 'uShape');
    const shUPhase  = gl.getUniformLocation(shapedProgram, 'uPhase');
    const shUFreq   = gl.getUniformLocation(shapedProgram, 'uFreq');

    const mxUTexA   = gl.getUniformLocation(mixProgram, 'uTexA');
    const mxUTexB   = gl.getUniformLocation(mixProgram, 'uTexB');
    const mxUHasA   = gl.getUniformLocation(mixProgram, 'uHasA');
    const mxUHasB   = gl.getUniformLocation(mixProgram, 'uHasB');
    const mxUAmount = gl.getUniformLocation(mixProgram, 'uAmount');

    // FBOs — one per output port. Indexed in declaration order so the
    // dispatch table below maps port id → texture by name.
    const fboH_lin    = ctx.createFbo();
    const fboV_lin    = ctx.createFbo();
    const fboH_out    = ctx.createFbo();
    const fboV_out    = ctx.createFbo();
    const fboMix1_out = ctx.createFbo();
    const fboMix2_out = ctx.createFbo();

    // Sentinel 1×1 black texture for unbound mixer inputs. Same rationale
    // as V-MIXER: we can't bind our own output as a sampler placeholder
    // (GL feedback loop → silent garbage on Chrome).
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('SHAPEDRAMPS: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: ShapedrampsParams = { ...DEFAULTS, ...(node.params as Partial<ShapedrampsParams>) };

    // The engine's lookupInput follows surface.texture for a single output,
    // but SHAPEDRAMPS has six outputs. We expose the canonical "main"
    // texture as h_out (for legacy single-texture consumers) and rely on
    // a per-output texture lookup hook below.
    const surface: VideoNodeSurface = {
      fbo: fboH_out.fbo,
      texture: fboH_out.texture,
      draw(frame) {
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

        // Mixers — share the MIX program; bind per-mixer A + B textures
        // (or the empty sentinel if unpatched), set has-flags + amount.
        g.useProgram(mixProgram);

        const m1a = frame.getInputTexture(node.id, 'mix1_a');
        const m1b = frame.getInputTexture(node.id, 'mix1_b');
        g.bindFramebuffer(g.FRAMEBUFFER, fboMix1_out.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, m1a ?? emptyTex);
        g.uniform1i(mxUTexA, 0);
        g.uniform1f(mxUHasA, m1a ? 1.0 : 0.0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, m1b ?? emptyTex);
        g.uniform1i(mxUTexB, 1);
        g.uniform1f(mxUHasB, m1b ? 1.0 : 0.0);
        g.uniform1f(mxUAmount, params.mix1);
        ctx.drawFullscreenQuad();

        const m2a = frame.getInputTexture(node.id, 'mix2_a');
        const m2b = frame.getInputTexture(node.id, 'mix2_b');
        g.bindFramebuffer(g.FRAMEBUFFER, fboMix2_out.fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, m2a ?? emptyTex);
        g.uniform1i(mxUTexA, 0);
        g.uniform1f(mxUHasA, m2a ? 1.0 : 0.0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, m2b ?? emptyTex);
        g.uniform1i(mxUTexB, 1);
        g.uniform1f(mxUHasB, m2b ? 1.0 : 0.0);
        g.uniform1f(mxUAmount, params.mix2);
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
        gl.deleteFramebuffer(fboMix1_out.fbo);
        gl.deleteTexture(fboMix1_out.texture);
        gl.deleteFramebuffer(fboMix2_out.fbo);
        gl.deleteTexture(fboMix2_out.texture);
        gl.deleteTexture(emptyTex);
        gl.deleteProgram(linProgram);
        gl.deleteProgram(shapedProgram);
        gl.deleteProgram(mixProgram);
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
        if (key === 'outputTexture:h_lin')    return fboH_lin.texture;
        if (key === 'outputTexture:v_lin')    return fboV_lin.texture;
        if (key === 'outputTexture:h_out')    return fboH_out.texture;
        if (key === 'outputTexture:v_out')    return fboV_out.texture;
        if (key === 'outputTexture:mix1_out') return fboMix1_out.texture;
        if (key === 'outputTexture:mix2_out') return fboMix2_out.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
