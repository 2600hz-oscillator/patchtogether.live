// packages/web/src/lib/video/modules/chroma.ts
//
// CHROMA — chroma-key. Output a `keys` mask wherever the input pixel is
// close (in RGB distance) to a chosen key color.
//
// Phase-1 simplification (§3.4): we expose the keyed-color as 3 individual
// CV-modulatable params (R/G/B) rather than the iro.js color wheel from
// the original spec. The wheel UI is a worthwhile polish for Phase 2;
// CV-driven keying is more useful for a modular synth-style patch
// (audio-rate signals can sweep the key color), so the params land first.
//
// Outputs `keys` (single-channel mask). To composite the result over
// other video, route CHROMA → MIXER (key channel) downstream.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uKeyR;
uniform float uKeyG;
uniform float uKeyB;
uniform float uTolerance;
uniform float uSoftness;

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 src = texture(uTex, vUv).rgb;
  vec3 key = vec3(uKeyR, uKeyG, uKeyB);
  float dist = length(src - key);

  // Pixels INSIDE the tolerance get masked out (mask=0); pixels outside
  // with softness band get a soft transition; far-from-key pixels are
  // 1.0 (kept). Equivalent to a "pull green-screen background" workflow.
  float lo = max(0.0, uTolerance - uSoftness);
  float hi = uTolerance + uSoftness;
  float mask = smoothstep(lo, hi, dist);

  outColor = vec4(mask, mask, mask, 1.0);
}`;

interface ChromaParams {
  keyR: number;
  keyG: number;
  keyB: number;
  tolerance: number;
  softness: number;
}

const DEFAULTS: ChromaParams = {
  keyR: 0.0,
  keyG: 1.0,
  keyB: 0.0,  // green-screen default
  tolerance: 0.4,
  softness: 0.15,
};

export const chromaDef: VideoModuleDef = {
  type: 'chroma',
  domain: 'video',
  label: 'CHROMA',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'in',        type: 'video' },
    { id: 'keyR',      type: 'cv' },
    { id: 'keyG',      type: 'cv' },
    { id: 'keyB',      type: 'cv' },
    { id: 'tolerance', type: 'cv' },
    { id: 'softness',  type: 'cv' },
  ],
  outputs: [
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    { id: 'keyR',      label: 'R',     defaultValue: DEFAULTS.keyR,      min: 0, max: 1, curve: 'linear' },
    { id: 'keyG',      label: 'G',     defaultValue: DEFAULTS.keyG,      min: 0, max: 1, curve: 'linear' },
    { id: 'keyB',      label: 'B',     defaultValue: DEFAULTS.keyB,      min: 0, max: 1, curve: 'linear' },
    { id: 'tolerance', label: 'Tol',   defaultValue: DEFAULTS.tolerance, min: 0, max: 1, curve: 'linear' },
    { id: 'softness',  label: 'Soft',  defaultValue: DEFAULTS.softness,  min: 0, max: 1, curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex       = gl.getUniformLocation(program, 'uTex');
    const uHasInput  = gl.getUniformLocation(program, 'uHasInput');
    const uKeyR      = gl.getUniformLocation(program, 'uKeyR');
    const uKeyG      = gl.getUniformLocation(program, 'uKeyG');
    const uKeyB      = gl.getUniformLocation(program, 'uKeyB');
    const uTolerance = gl.getUniformLocation(program, 'uTolerance');
    const uSoftness  = gl.getUniformLocation(program, 'uSoftness');

    const { fbo, texture } = ctx.createFbo();

    const params: ChromaParams = { ...DEFAULTS, ...(node.params as Partial<ChromaParams>) };

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

        g.uniform1f(uKeyR,      params.keyR);
        g.uniform1f(uKeyG,      params.keyG);
        g.uniform1f(uKeyB,      params.keyB);
        g.uniform1f(uTolerance, params.tolerance);
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
