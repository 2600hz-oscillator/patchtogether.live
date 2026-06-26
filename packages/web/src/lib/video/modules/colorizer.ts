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

  // docs-hash-ignore:start
  docs: {
    explanation: "colorizer tints a mono (single-channel) video signal into a solid color. Each incoming pixel is reduced to a single brightness value by averaging its R, G and B channels, and that brightness then scales a tint color you set with the R/G/B faders: the output pixel is (mono x R, mono x G, mono x B). The result reads as a one-color image whose intensity follows the input's luma, so dark areas stay black and bright areas hit the full tint. Feed it a luma key, an oscilloscope-style mono shape or any video, then dial the three faders to recolor it; with no input connected the output is solid black.",
    inputs: {
      in: "The source frame to tint. It is treated as mono: the shader averages the pixel's R, G and B into one brightness value, so plugging in a full RGB video upcasts to its luma before tinting.",
      tintR: "CV input that modulates the R fader (the red component of the tint), 0 to 1. Patch an LFO or sequencer here to animate the red tint over time.",
      tintG: "CV input that modulates the G fader (the green component of the tint), 0 to 1. Patch a modulation source here to animate the green tint.",
      tintB: "CV input that modulates the B fader (the blue component of the tint), 0 to 1. Patch a modulation source here to animate the blue tint.",
    },
    outputs: {
      out: "The tinted RGB video frame: each pixel is the input's mono brightness multiplied by the (R, G, B) tint, fully opaque alpha.",
    },
    controls: {
      tintR: "Red component of the tint color (fader labeled R). 0 removes red entirely; 1 lets the brightest input pixels reach full red. Defaults to 1.",
      tintG: "Green component of the tint color (fader labeled G). 0 = no green; 1 = full green at peak input brightness. Defaults to 0.4.",
      tintB: "Blue component of the tint color (fader labeled B). 0 = no blue; 1 = full blue at peak input brightness. Defaults to 0.7, which together with the R=1 / G=0.4 defaults gives a pinkish-rose default tint.",
    },
  },
  // docs-hash-ignore:end
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
