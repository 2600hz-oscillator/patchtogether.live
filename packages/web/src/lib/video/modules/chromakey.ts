// packages/web/src/lib/video/modules/chromakey.ts
//
// CHROMAKEY — proper 2-input chroma-key compositor (green-screen style).
//
// Inputs: `fg` (foreground), `bg` (background). Output: composited video.
// Replaces the old CHROMA module's confused "mask-only" semantics.
//
// Per-pixel algorithm (matches p10entrancer/Shaders/Keyer.metal where the
// math is well-defined):
//   1. Compute foreground hue and the key-color's hue.
//   2. hueDistance(fg, key) in [0, 0.5] (0 = identical hue, 0.5 = exactly
//      complementary).
//   3. alpha = smoothstep(threshold/2, (threshold+softness)/2, hd). Map
//      slider 0..1 onto the hue-distance range 0..0.5 so the slider feels
//      like a "how close to the key counts as keyed" knob.
//   4. Saturation gate: gray-ish foreground pixels are not "this color"
//      regardless of where their hue noisily computes, so we bias them
//      toward keep (alpha -> 1).
//   5. Spill suppression: in pixels where alpha < 1 (foreground edges),
//      desaturate the foreground proportional to (1 - alpha) * spill to
//      kill the key-color halo that bleeds onto the subject.
//   6. Composite: mix(BG, FG, alpha) — alpha=0 -> BG only, alpha=1 -> FG.
//
// CV inputs declare paramTarget == port id (PR #264 convention) so the
// cross-domain bridge writes them correctly.

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
uniform float uKeyR;
uniform float uKeyG;
uniform float uKeyB;
uniform float uThreshold;
uniform float uSoftness;
uniform float uSpillSuppress;

vec3 rgbToHsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float v = mx;
  float d = mx - mn;
  float s = (mx > 0.0001) ? d / mx : 0.0;
  float h = 0.0;
  if (d > 0.0001) {
    if (mx == c.r) {
      h = (c.g - c.b) / d;
      if (h < 0.0) h += 6.0;
    } else if (mx == c.g) {
      h = (c.b - c.r) / d + 2.0;
    } else {
      h = (c.r - c.g) / d + 4.0;
    }
    h /= 6.0;
  }
  return vec3(h, s, v);
}

vec3 hsvToRgb(vec3 hsv) {
  float h = hsv.x;
  float s = clamp(hsv.y, 0.0, 1.0);
  float v = clamp(hsv.z, 0.0, 1.0);
  float h6 = h * 6.0;
  float c = v * s;
  float x = c * (1.0 - abs(mod(h6, 2.0) - 1.0));
  vec3 rgb;
  if      (h6 < 1.0) rgb = vec3(c, x, 0.0);
  else if (h6 < 2.0) rgb = vec3(x, c, 0.0);
  else if (h6 < 3.0) rgb = vec3(0.0, c, x);
  else if (h6 < 4.0) rgb = vec3(0.0, x, c);
  else if (h6 < 5.0) rgb = vec3(x, 0.0, c);
  else               rgb = vec3(c, 0.0, x);
  float m = v - c;
  return rgb + m;
}

float hueDistance(float a, float b) {
  float d = abs(a - b);
  return min(d, 1.0 - d);
}

void main() {
  vec3 fg = uHasFg > 0.5 ? texture(uFg, vUv).rgb : vec3(0.0);
  vec3 bg = uHasBg > 0.5 ? texture(uBg, vUv).rgb : vec3(0.0);

  // Without a foreground, there's nothing to key — show the background
  // directly (so a half-patched chain isn't a black hole).
  if (uHasFg < 0.5) {
    outColor = vec4(bg, 1.0);
    return;
  }

  vec3 fgHSV  = rgbToHsv(fg);
  vec3 keyHSV = rgbToHsv(vec3(uKeyR, uKeyG, uKeyB));
  float hd = hueDistance(fgHSV.x, keyHSV.x);
  float satGate = smoothstep(0.04, 0.18, fgHSV.y);

  float tol  = clamp(uThreshold, 0.0, 1.0);
  float soft = max(clamp(uSoftness, 0.0, 0.5), 0.001);
  float tolH  = tol  * 0.5;
  float softH = soft * 0.5;
  float hueAlpha = smoothstep(tolH, tolH + softH, hd);
  // Pull unsaturated pixels toward keep (alpha = 1) since their hue is
  // unstable and we don't want shadows / highlights keyed out.
  float alpha = mix(1.0, hueAlpha, satGate);

  // Spill suppression — desaturate FG proportional to (1 - alpha) * spill
  // so the key color halo doesn't tint the kept subject.
  if (uSpillSuppress > 0.001) {
    float pull = (1.0 - alpha) * clamp(uSpillSuppress, 0.0, 1.0);
    vec3 desaturated = hsvToRgb(vec3(fgHSV.x, fgHSV.y * (1.0 - pull), fgHSV.z));
    fg = desaturated;
  }

  // alpha = 0 -> BG only, alpha = 1 -> FG only.
  vec3 out_rgb = mix(bg, fg, alpha);
  outColor = vec4(out_rgb, 1.0);
}`;

interface ChromakeyParams {
  keyR: number;
  keyG: number;
  keyB: number;
  threshold: number;
  softness: number;
  spillSuppress: number;
}

const DEFAULTS: ChromakeyParams = {
  keyR: 0.0,
  keyG: 1.0,  // green-screen default
  keyB: 0.0,
  threshold: 0.15,
  softness: 0.08,
  spillSuppress: 0.5,
};

export const chromakeyDef: VideoModuleDef = {
  type: 'chromakey',
  domain: 'video',
  label: 'CHROMAKEY',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'fg',            type: 'video' },
    { id: 'bg',            type: 'video' },
    { id: 'keyR',          type: 'cv', paramTarget: 'keyR' },
    { id: 'keyG',          type: 'cv', paramTarget: 'keyG' },
    { id: 'keyB',          type: 'cv', paramTarget: 'keyB' },
    { id: 'threshold',     type: 'cv', paramTarget: 'threshold' },
    { id: 'softness',      type: 'cv', paramTarget: 'softness' },
    { id: 'spillSuppress', type: 'cv', paramTarget: 'spillSuppress' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'keyR',          label: 'R',    defaultValue: DEFAULTS.keyR,          min: 0, max: 1,   curve: 'linear' },
    { id: 'keyG',          label: 'G',    defaultValue: DEFAULTS.keyG,          min: 0, max: 1,   curve: 'linear' },
    { id: 'keyB',          label: 'B',    defaultValue: DEFAULTS.keyB,          min: 0, max: 1,   curve: 'linear' },
    { id: 'threshold',     label: 'Thr',  defaultValue: DEFAULTS.threshold,     min: 0, max: 1,   curve: 'linear' },
    { id: 'softness',      label: 'Soft', defaultValue: DEFAULTS.softness,      min: 0, max: 0.5, curve: 'linear' },
    { id: 'spillSuppress', label: 'Spill',defaultValue: DEFAULTS.spillSuppress, min: 0, max: 1,   curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uFg            = gl.getUniformLocation(program, 'uFg');
    const uBg            = gl.getUniformLocation(program, 'uBg');
    const uHasFg         = gl.getUniformLocation(program, 'uHasFg');
    const uHasBg         = gl.getUniformLocation(program, 'uHasBg');
    const uKeyR          = gl.getUniformLocation(program, 'uKeyR');
    const uKeyG          = gl.getUniformLocation(program, 'uKeyG');
    const uKeyB          = gl.getUniformLocation(program, 'uKeyB');
    const uThreshold     = gl.getUniformLocation(program, 'uThreshold');
    const uSoftness      = gl.getUniformLocation(program, 'uSoftness');
    const uSpillSuppress = gl.getUniformLocation(program, 'uSpillSuppress');

    const { fbo, texture } = ctx.createFbo();

    // Sentinel 1x1 black texture for unbound inputs — same pattern as MIXER.
    // We can't re-bind our own FBO texture as a "spare" sampler input
    // because that creates a feedback loop GL silently fills with garbage.
    const emptyTex = gl.createTexture();
    if (!emptyTex) throw new Error('CHROMAKEY: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const params: ChromakeyParams = { ...DEFAULTS, ...(node.params as Partial<ChromakeyParams>) };

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

        g.uniform1f(uKeyR,          params.keyR);
        g.uniform1f(uKeyG,          params.keyG);
        g.uniform1f(uKeyB,          params.keyB);
        g.uniform1f(uThreshold,     params.threshold);
        g.uniform1f(uSoftness,      params.softness);
        g.uniform1f(uSpillSuppress, params.spillSuppress);

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
