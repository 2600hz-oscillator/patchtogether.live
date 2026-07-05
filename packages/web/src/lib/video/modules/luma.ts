// packages/web/src/lib/video/modules/luma.ts
//
// LUMA — single-input POSTERIZE / CONTRAST / GAMMA / BIAS processor.
//
// History: prior versions of this module conflated "luma-mask extraction"
// with the user-facing concept of a "luma keyer." A real keyer takes
// foreground + background and composites — see LUMAKEY for that. LUMA is
// now a luminance-domain color processor: gamma, contrast, posterize,
// bias. The math preserves chroma by computing a single luma factor and
// applying the same ratio to all three channels.
//
// Schema v2 migration: prior v1 stored mask-extraction params (threshold,
// softness, invert). Those were never the right shape for this module's
// real job; on load we drop them and reset to processor defaults. Users
// who actually wanted a luma key should swap in LUMAKEY.
//
// Inputs:
//   in (video): RGB input.
//   gamma / contrast / posterizeLevels / bias (cv, paramTarget=…): per-param CV.
//
// Outputs:
//   out (video): luma-processed RGB.
//
// Params:
//   gamma (linear 0.1..3.0): gamma correction (1.0 = linear).
//   contrast (linear 0..2): contrast scale (1.0 = pristine).
//   posterizeLevels (discrete 2..16): luma quantization steps.
//   bias (linear -0.5..0.5): luma additive bias (lifts/depresses midtones).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uGamma;            // 0.1..3.0
uniform float uContrast;         // 0..2
uniform float uPosterizeLevels;  // 2..16
uniform float uBias;             // -0.5..+0.5

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 src = texture(uTex, vUv).rgb;
  // Rec. 601 luma — same weights as the prior LUMA module.
  float luma = dot(src, vec3(0.299, 0.587, 0.114));
  // Avoid division-by-zero / NaN propagation when the source is fully
  // black. Pick an epsilon small enough that the resulting hue is the
  // same in practice (still black post-process).
  float lumaSafe = max(luma, 1e-5);

  // Gamma: pow(luma, 1/gamma). Clamp gamma to its declared range so a
  // CV signal can't push us into pow(x, 0) territory.
  float g = clamp(uGamma, 0.1, 3.0);
  float gammaLuma = pow(clamp(luma, 0.0, 1.0), 1.0 / g);

  // Contrast around 0.5.
  float contrastLuma = (gammaLuma - 0.5) * uContrast + 0.5;

  // Posterize: quantize to N levels. Clamp + round so a sub-2 CV value
  // doesn't divide by < 1.
  float levels = max(2.0, floor(uPosterizeLevels + 0.5));
  float posterLuma = floor(contrastLuma * levels) / max(levels - 1.0, 1.0);

  // Bias is a final additive brightness offset.
  float finalLuma = clamp(posterLuma + uBias, 0.0, 1.0);

  // Apply the same luma ratio to all three channels so we preserve hue.
  float ratio = finalLuma / lumaSafe;
  vec3 out_rgb = clamp(src * ratio, 0.0, 1.0);
  outColor = vec4(out_rgb, 1.0);
}`;

interface LumaParams {
  gamma: number;
  contrast: number;
  posterizeLevels: number;
  bias: number;
}

const DEFAULTS: LumaParams = {
  gamma: 1.0,
  contrast: 1.0,
  posterizeLevels: 16, // max = effectively off (no visible banding)
  bias: 0.0,
};

// Legacy mask param ids are ignored by construction: the factory rebuilds params
// from DEFAULTS filtered through PARAM_IDS (below), so any stray old key never
// reaches the shader. No load-time migration is needed.
const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(DEFAULTS));

export const lumaDef: VideoModuleDef = {
  type: 'luma',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'luma',
  category: 'effects',
  inputs: [
    { id: 'in',              type: 'video' },
    { id: 'gamma',           type: 'cv', paramTarget: 'gamma', cvScale: { mode: 'linear' } },
    { id: 'contrast',        type: 'cv', paramTarget: 'contrast', cvScale: { mode: 'linear' } },
    { id: 'posterizeLevels', type: 'cv', paramTarget: 'posterizeLevels', cvScale: { mode: 'discrete' } },
    { id: 'bias',            type: 'cv', paramTarget: 'bias', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'gamma',           label: 'Gamma',  defaultValue: DEFAULTS.gamma,           min: 0.1,  max: 3.0,  curve: 'linear' },
    { id: 'contrast',        label: 'Cntr',   defaultValue: DEFAULTS.contrast,        min: 0,    max: 2,    curve: 'linear' },
    { id: 'posterizeLevels', label: 'Post',   defaultValue: DEFAULTS.posterizeLevels, min: 2,    max: 16,   curve: 'discrete' },
    { id: 'bias',            label: 'Bias',   defaultValue: DEFAULTS.bias,            min: -0.5, max: 0.5,  curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "luma is a luminance-domain color processor for a single video stream. It reads the Rec. 601 brightness (0.299/0.587/0.114) of every pixel, runs that luma through a chain of gamma, contrast (scaled around the 0.5 midpoint), posterize (quantize to N steps), then an additive bias, and finally re-applies the new-luma/old-luma ratio to all three RGB channels so chroma (hue and saturation) is preserved while only tonality changes. Patch a video source into in and use it to crush blacks, lift gamma, flatten the image into hard tonal bands, or shift overall brightness; with the defaults (gamma 1, cntr 1, post 16, bias 0) the picture passes through essentially untouched. Note this is NOT a keyer — for foreground/background luma compositing use lumakey instead.",
    inputs: {
      in: "The video frame to process. With nothing patched here the output is solid black; otherwise the luma chain runs on this RGB image.",
      gamma: "CV input that modulates Gamma; a linear-scaled control voltage drives the gamma-correction exponent applied to the luma.",
      contrast: "CV input that modulates Cntr; linear-scaled voltage sets how hard the luma is scaled around the 0.5 midpoint.",
      posterizeLevels: "CV input that modulates Post; discrete-scaled voltage chooses the number of luma quantization steps (banding amount).",
      bias: "CV input that modulates Bias; linear-scaled voltage adds a final brightness offset to the processed luma.",
    },
    outputs: {
      out: "The luma-processed video frame: the same RGB image with gamma, contrast, posterize and bias applied to its brightness while chroma (hue and saturation) is preserved (opaque alpha).",
    },
    controls: {
      gamma: "Gamma fader — gamma correction of the luma via pow(luma, 1/gamma), range 0.1 to 3.0; 1.0 is linear/untouched, below 1 darkens midtones, above 1 brightens them.",
      contrast: "Cntr fader — contrast scaling of the luma around 0.5, range 0 to 2; 1.0 is pristine, 0 flattens everything to mid-grey, values above 1 push tones apart for harder contrast.",
      posterizeLevels: "Post fader — number of luma quantization steps, range 2 to 16; 16 is effectively off (no visible banding) and 2 crushes the image to two hard tonal bands.",
      bias: "Bias fader — a final additive luma offset, range -0.5 to 0.5; negative depresses overall brightness, positive lifts it, 0 leaves it unchanged.",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex             = gl.getUniformLocation(program, 'uTex');
    const uHasInput        = gl.getUniformLocation(program, 'uHasInput');
    const uGamma           = gl.getUniformLocation(program, 'uGamma');
    const uContrast        = gl.getUniformLocation(program, 'uContrast');
    const uPosterizeLevels = gl.getUniformLocation(program, 'uPosterizeLevels');
    const uBias            = gl.getUniformLocation(program, 'uBias');

    const { fbo, texture } = ctx.createFbo();

    // Strip any stray legacy keys so they can't bleed into the params object.
    const rawParams = node.params as Record<string, unknown>;
    const filteredParams: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filteredParams[k] = v;
    }
    const params: LumaParams = { ...DEFAULTS, ...filteredParams as Partial<LumaParams> };

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

        g.uniform1f(uGamma,           params.gamma);
        g.uniform1f(uContrast,        params.contrast);
        g.uniform1f(uPosterizeLevels, params.posterizeLevels);
        g.uniform1f(uBias,            params.bias);

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
