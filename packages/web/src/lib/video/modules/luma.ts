// packages/web/src/lib/video/modules/luma.ts
//
// LUMA — luminance key. Outputs a `keys` mask derived from a single video
// (or image) input by thresholding luminance.
//
// Phase-1 reading of §3.5: this is the simpler, single-knob luma-key
// (mask = smoothstep(threshold-softness, threshold+softness, luma)).
// The 5-blend-mode mixer interpretation in the spec is deferred to
// MIXER's blend modes — keeping LUMA narrow to "make a key from a
// video" matches how it's used downstream by CHROMA / MIXER.
//
// Output type is `keys` (mono no-time-axis is overstated for an
// animated input — but we follow the spec's mask-output convention;
// downstream that wants animated-mono can treat keys as mono-video).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uThreshold; // 0..1
uniform float uSoftness;  // 0..1

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 src = texture(uTex, vUv).rgb;
  // Rec. 601 luma — cheap and visually correct enough for keying.
  float luma = dot(src, vec3(0.299, 0.587, 0.114));

  float lo = max(0.0, uThreshold - uSoftness);
  float hi = min(1.0, uThreshold + uSoftness);
  float mask = smoothstep(lo, hi, luma);

  outColor = vec4(mask, mask, mask, 1.0);
}`;

interface LumaParams {
  threshold: number;
  softness: number;
}

const DEFAULTS: LumaParams = {
  threshold: 0.5,
  softness: 0.1,
};

export const lumaDef: VideoModuleDef = {
  type: 'luma',
  domain: 'video',
  label: 'LUMA',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in',        type: 'video' },
    { id: 'threshold', type: 'cv' },
  ],
  outputs: [
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    { id: 'threshold', label: 'Thresh',   defaultValue: DEFAULTS.threshold, min: 0, max: 1, curve: 'linear' },
    { id: 'softness',  label: 'Softness', defaultValue: DEFAULTS.softness,  min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex       = gl.getUniformLocation(program, 'uTex');
    const uHasInput  = gl.getUniformLocation(program, 'uHasInput');
    const uThreshold = gl.getUniformLocation(program, 'uThreshold');
    const uSoftness  = gl.getUniformLocation(program, 'uSoftness');

    const { fbo, texture } = ctx.createFbo();

    const params: LumaParams = { ...DEFAULTS, ...(node.params as Partial<LumaParams>) };

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

        g.uniform1f(uThreshold, params.threshold);
        g.uniform1f(uSoftness,  params.softness);

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
