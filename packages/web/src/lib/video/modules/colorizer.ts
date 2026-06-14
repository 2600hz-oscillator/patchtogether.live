// packages/web/src/lib/video/modules/colorizer.ts
//
// COLORIZER — maps a mono-video signal to a solid color.
//
// Per spec §3.8 + agent kickoff: takes a `mono-video` (or video — implicit
// upcast) input, plus a CV color triplet, and outputs a video stream where
// the mono channel modulates the chosen color. R = mono * tintR, etc.
//
// Phase-1 simplification: the spec calls for HSV/contrast adjustments;
// this module ships the simpler "tint a mono signal" interpretation.
// HSV-rotation, contrast, brightness adjustments belong to a future
// COLORIZE-FX module — see PR notes.
//
// Inputs:
//   in (mono-video): single-channel signal modulating the tint colour.
//   tintR / tintG / tintB (cv, paramTarget=…): tint colour CV.
//
// Outputs:
//   out (video): RGB output (R = mono * tintR, G = mono * tintG, B = mono * tintB).
//
// Params:
//   tintR / tintG / tintB (linear 0..1): tint colour components.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uTintR;
uniform float uTintG;
uniform float uTintB;

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Treat the input as mono — sample R only. Multi-channel inputs
  // (video / image) get implicit-luma via the average; this gives
  // sensible behavior whether the upstream is mono or RGB.
  vec3 src = texture(uTex, vUv).rgb;
  float mono = (src.r + src.g + src.b) / 3.0;
  outColor = vec4(mono * uTintR, mono * uTintG, mono * uTintB, 1.0);
}`;

interface ColorizerParams {
  tintR: number;
  tintG: number;
  tintB: number;
}

const DEFAULTS: ColorizerParams = {
  tintR: 1.0,
  tintG: 0.4,
  tintB: 0.7, // pleasant magenta default
};

export const colorizerDef: VideoModuleDef = {
  type: 'colorizer',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'colorizer',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in',    type: 'mono-video' },
    // Per-channel CV inputs — the cross-domain bridge writes these
    // values into the corresponding params each frame. CV→param is
    // the canonical pattern; see ChromaCard for the same shape with
    // more channels. paramTarget == port.id is required for the docs
    // manifest (module-manifest.ts) to render the correct "CV -> X
    // param." description; the runtime bridge looks up via port id
    // directly so it works without paramTarget — see issue #G.1 in
    // .myrobots/plans/test-coverage-audit.md.
    { id: 'tintR', type: 'cv', paramTarget: 'tintR', cvScale: { mode: 'linear' } },
    { id: 'tintG', type: 'cv', paramTarget: 'tintG', cvScale: { mode: 'linear' } },
    { id: 'tintB', type: 'cv', paramTarget: 'tintB', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'tintR', label: 'R', defaultValue: DEFAULTS.tintR, min: 0, max: 1, curve: 'linear' },
    { id: 'tintG', label: 'G', defaultValue: DEFAULTS.tintG, min: 0, max: 1, curve: 'linear' },
    { id: 'tintB', label: 'B', defaultValue: DEFAULTS.tintB, min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex      = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');
    const uTintR    = gl.getUniformLocation(program, 'uTintR');
    const uTintG    = gl.getUniformLocation(program, 'uTintG');
    const uTintB    = gl.getUniformLocation(program, 'uTintB');

    const { fbo, texture } = ctx.createFbo();

    const params: ColorizerParams = { ...DEFAULTS, ...(node.params as Partial<ColorizerParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        const inputTex = frame.getInputTexture(node.id, 'in');
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        if (inputTex) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex);
          g.uniform1i(uTex, 0);
        }

        g.uniform1f(uTintR, params.tintR);
        g.uniform1f(uTintG, params.tintG);
        g.uniform1f(uTintB, params.tintB);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteProgram(program);
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
      dispose() { surface.dispose(); },
    };
  },
};
