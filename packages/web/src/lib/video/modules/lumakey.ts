// packages/web/src/lib/video/modules/lumakey.ts
//
// LUMAKEY — proper 2-input luminance-key compositor.
//
// Inputs: `fg` (foreground), `bg` (background). Output: composited video.
// Replaces the old LUMA module's confused "mask-only" semantics.
//
// Per-pixel algorithm:
//   1. Compute fg luminance (Rec. 601).
//   2. alpha = smoothstep(threshold - softness, threshold + softness, luma).
//      Bright fg luma -> alpha = 1 -> FG only; dark fg luma -> alpha = 0
//      -> BG bleeds through.
//   3. invert flag flips: dark = opaque instead of bright = opaque.
//   4. Composite: mix(BG, FG, alpha).
//
// This is the standard "matte the dark out / matte the bright out" knob
// used for letterbox text overlays, bright-source compositing, and white-
// or-black-background image plates.
//
// Inputs:
//   fg (video): foreground.
//   bg (video): background.
//   threshold / softness / invert (cv, paramTarget=…): per-param CV.
//
// Outputs:
//   out (video): composited RGB.
//
// Params:
//   threshold (linear 0..1): luma threshold above which FG becomes opaque.
//   softness (linear 0..0.5): smoothstep edge softness.
//   invert (discrete 0..1): 0 = bright = opaque, 1 = dark = opaque.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uFg;
uniform sampler2D uBg;
uniform float uHasFg;
uniform float uHasBg;
uniform float uThreshold; // 0..1
uniform float uSoftness;  // 0..0.5
uniform float uInvert;    // 0 or 1

void main() {
  vec3 fg = uHasFg > 0.5 ? texture(uFg, vUv).rgb : vec3(0.0);
  vec3 bg = uHasBg > 0.5 ? texture(uBg, vUv).rgb : vec3(0.0);

  // Without a foreground there's no luma to test against — show BG so
  // a half-patched chain isn't a black hole.
  if (uHasFg < 0.5) {
    outColor = vec4(bg, 1.0);
    return;
  }

  float luma = dot(fg, vec3(0.299, 0.587, 0.114));
  float tol  = clamp(uThreshold, 0.0, 1.0);
  float soft = max(clamp(uSoftness, 0.0, 0.5), 0.001);
  float alpha = smoothstep(tol - soft, tol + soft, luma);
  if (uInvert > 0.5) alpha = 1.0 - alpha;

  vec3 out_rgb = mix(bg, fg, alpha);
  outColor = vec4(out_rgb, 1.0);
}`;

interface LumakeyParams {
  threshold: number;
  softness: number;
  invert: number;
}

const DEFAULTS: LumakeyParams = {
  threshold: 0.5,
  softness: 0.1,
  invert: 0,
};

export const lumakeyDef: VideoModuleDef = {
  type: 'lumakey',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'lumakey',
  category: 'effects',
  inputs: [
    { id: 'fg',        type: 'video' },
    { id: 'bg',        type: 'video' },
    { id: 'threshold', type: 'cv', paramTarget: 'threshold', cvScale: { mode: 'linear' } },
    { id: 'softness',  type: 'cv', paramTarget: 'softness', cvScale: { mode: 'linear' } },
    { id: 'invert',    type: 'cv', paramTarget: 'invert', cvScale: { mode: 'discrete' } },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'threshold', label: 'Thr',  defaultValue: DEFAULTS.threshold, min: 0, max: 1,   curve: 'linear' },
    { id: 'softness',  label: 'Soft', defaultValue: DEFAULTS.softness,  min: 0, max: 0.5, curve: 'linear' },
    { id: 'invert',    label: 'Inv',  defaultValue: DEFAULTS.invert,    min: 0, max: 1,   curve: 'discrete' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "lumakey is a two-input luminance-key compositor: it lays a foreground frame over a background frame and decides, pixel by pixel, which one shows through based on how bright the foreground is. It computes Rec. 601 luma of the foreground, then builds an alpha mask with smoothstep(threshold - softness, threshold + softness, luma) so bright foreground pixels become opaque (alpha 1, foreground shows) and dark ones drop out (alpha 0, background bleeds through), finally mixing background toward foreground by that alpha. Use it to matte out a black or white plate behind a source, drop text/letterbox overlays onto a scene, or composite a bright source over another video; flip invert to key on the dark areas instead. With no foreground patched it passes the background straight through so a half-wired chain is never a black hole.",
    inputs: {
      fg: "Foreground video frame. Its luma drives the key: bright pixels stay opaque, dark pixels are matted out (or the reverse when invert is on). With nothing patched here the module passes the background through unchanged.",
      bg: "Background video frame that shows through wherever the foreground is keyed out. If unbound it is treated as solid black behind the keyed foreground.",
      threshold: "CV input that modulates the Thr control, sliding the luma cut point where the foreground becomes opaque (linear scaling into Thr's 0..1 range).",
      softness: "CV input that modulates the Soft control, widening or tightening the edge feather around the key threshold (linear scaling into Soft's 0..0.5 range).",
      invert: "CV input that modulates the INV control; a high value flips the key so dark foreground becomes opaque instead of bright (discrete scaling).",
    },
    outputs: {
      out: "The composited RGB video frame: foreground over background blended per pixel by the luma-derived alpha mask (alpha is fully opaque).",
    },
    controls: {
      threshold: "Thr fader sets the foreground luma level at which it becomes opaque. Lower values key in more of the foreground (only the darkest pixels drop out); higher values matte out more of it, letting the background through (0..1, default 0.5).",
      softness: "Soft fader sets the smoothstep feather around the threshold: 0 (clamped to a tiny minimum) gives a hard, crisp key edge, while higher values blend foreground and background over a wider luma band for a soft matte (0..0.5, default 0.1).",
      invert: "INV button flips the key direction: off (0) keeps bright foreground opaque and mattes the dark out; on (1) keeps dark foreground opaque and mattes the bright out (discrete 0/1, default 0/off).",
    },
  },
  // docs-hash-ignore:end
  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uFg        = gl.getUniformLocation(program, 'uFg');
    const uBg        = gl.getUniformLocation(program, 'uBg');
    const uHasFg     = gl.getUniformLocation(program, 'uHasFg');
    const uHasBg     = gl.getUniformLocation(program, 'uHasBg');
    const uThreshold = gl.getUniformLocation(program, 'uThreshold');
    const uSoftness  = gl.getUniformLocation(program, 'uSoftness');
    const uInvert    = gl.getUniformLocation(program, 'uInvert');

    const { fbo, texture } = ctx.createFbo();

    // Sentinel 1x1 black texture for unbound inputs — same pattern as
    // V-MIXER + CHROMAKEY.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('LUMAKEY: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: LumakeyParams = { ...DEFAULTS, ...(node.params as Partial<LumakeyParams>) };

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);

        const fgTex = frame.getInputTexture(node.id, 'fg');
        const bgTex = frame.getInputTexture(node.id, 'bg');
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, fgTex ?? emptyTex);
        g.uniform1i(uFg, 0);
        g.uniform1f(uHasFg, fgTex ? 1.0 : 0.0);
        g.activeTexture(g.TEXTURE1);
        g.bindTexture(g.TEXTURE_2D, bgTex ?? emptyTex);
        g.uniform1i(uBg, 1);
        g.uniform1f(uHasBg, bgTex ? 1.0 : 0.0);

        g.uniform1f(uThreshold, params.threshold);
        g.uniform1f(uSoftness,  params.softness);
        g.uniform1f(uInvert,    params.invert);

        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(emptyTex);
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
