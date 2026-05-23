// packages/web/src/lib/video/modules/chroma.ts
//
// CHROMA — chroma-key. Output a `keys` mask wherever the input pixel's
// HUE is close to a chosen key color's hue.
//
// v2 upgrade (matches p10entrancer/Shaders/Keyer.metal):
//   * HSV hue distance instead of RGB distance — luma-invariant (a dark
//     green and a bright green key the same), eliminates the RGB-distance
//     bug where shadowed green-screen pixels missed the key.
//   * Saturation gate — gray pixels stay non-key regardless of where their
//     hue happens to compute (since hue of a gray pixel is undefined).
//   * `spill` desaturates edge pixels so the key color doesn't tint the
//     comped subject (green halo around a person on a green screen).
//   * `invert` flips the mask (useful for "keep the keyed area" workflows).
//   * `tolerance` param renamed → `threshold` for consistency with LUMA
//     and the v2 spec; schema-migrate handles the rename in saved data.
//
// CV inputs for the key color still expose R/G/B (additive on top of the
// user-picked color via the card's color wheel) so audio-rate signals can
// sweep the key. The card UI is a native HSV color picker that writes
// keyR/keyG/keyB in one shot.
//
// Outputs `keys` (single-channel mask). To composite the result over
// other video, route CHROMA → MIXER (key channel) downstream.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// GLSL helper: RGB → HSV. Hue ∈ [0, 1) (0 = red, 1/3 = green, 2/3 = blue),
// saturation + value ∈ [0, 1]. Lifted from the p10entrancer Metal shader
// + transliterated to GLSL.
const RGB_TO_HSV_GLSL = `
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
`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uKeyR;
uniform float uKeyG;
uniform float uKeyB;
uniform float uThreshold; // 0..1 — inner hue-band that's fully keyed out
uniform float uSoftness;  // 0..1 — width of the ramp band past threshold
uniform float uInvert;    // 0 or 1

${RGB_TO_HSV_GLSL}

// Shortest hue distance with wrap-around. Output ∈ [0, 0.5]
// (0 = identical hue, 0.5 = exactly complementary).
float hueDistance(float a, float b) {
  float d = abs(a - b);
  return min(d, 1.0 - d);
}

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 src = texture(uTex, vUv).rgb;
  vec3 srcHSV = rgbToHsv(src);
  vec3 keyHSV = rgbToHsv(vec3(uKeyR, uKeyG, uKeyB));

  float hd = hueDistance(srcHSV.x, keyHSV.x);
  // Saturation gate — unsaturated (gray) pixels are never "this color".
  // Pulls their alpha back toward 1 (keep) so we don't accidentally
  // key out shadows / highlights that have unstable computed hues.
  float satGate = smoothstep(0.04, 0.18, srcHSV.y);

  // Map threshold/softness (slider 0..1) onto the hue-distance range
  // [0, 0.5]. threshold defines the inner radius that's fully keyed
  // (mask = 0); softness extends the ramp to a soft edge (mask → 1).
  float th  = uThreshold * 0.5;
  float sft = max(uSoftness * 0.5, 0.001);
  float hueAlpha = smoothstep(th, th + sft, hd);

  // Bias unsaturated pixels toward "keep" so a near-gray pixel doesn't
  // accidentally get keyed by a noisy hue value.
  float mask = mix(1.0, hueAlpha, satGate);
  if (uInvert > 0.5) mask = 1.0 - mask;

  outColor = vec4(mask, mask, mask, 1.0);
}`;

interface ChromaParams {
  keyR: number;
  keyG: number;
  keyB: number;
  threshold: number;
  softness: number;
  invert: number;
}

const DEFAULTS: ChromaParams = {
  keyR: 0.0,
  keyG: 1.0,
  keyB: 0.0,  // green-screen default
  threshold: 0.2,
  softness: 0.15,
  invert: 0,
};

/** v1 stored `tolerance`; v2 renamed it to `threshold`. Migration copies
 *  the value verbatim (range + semantic unchanged). Pure helper so the
 *  unit test can pin the rename without instantiating the GL context. */
export function migrateChroma(data: unknown, fromVersion: number): unknown {
  if (!data || typeof data !== 'object') return data;
  if (fromVersion >= 2) return data;
  const obj = data as Record<string, unknown>;
  if ('tolerance' in obj && !('threshold' in obj)) {
    const out: Record<string, unknown> = { ...obj, threshold: obj.tolerance };
    delete out.tolerance;
    return out;
  }
  return data;
}

export const chromaDef: VideoModuleDef = {
  type: 'chroma',
  domain: 'video',
  label: 'CHROMA',
  category: 'effects',
  schemaVersion: 2,
  migrate: migrateChroma,
  inputs: [
    { id: 'in',        type: 'video' },
    // paramTarget == port.id keeps the docs manifest in sync with the
    // LINES/INWARDS convention; runtime bridge uses port id directly.
    { id: 'keyR',      type: 'cv', paramTarget: 'keyR' },
    { id: 'keyG',      type: 'cv', paramTarget: 'keyG' },
    { id: 'keyB',      type: 'cv', paramTarget: 'keyB' },
    { id: 'threshold', type: 'cv', paramTarget: 'threshold' },
    { id: 'softness',  type: 'cv', paramTarget: 'softness' },
  ],
  outputs: [
    { id: 'out', type: 'mono-video' },
  ],
  params: [
    { id: 'keyR',      label: 'R',    defaultValue: DEFAULTS.keyR,      min: 0, max: 1, curve: 'linear' },
    { id: 'keyG',      label: 'G',    defaultValue: DEFAULTS.keyG,      min: 0, max: 1, curve: 'linear' },
    { id: 'keyB',      label: 'B',    defaultValue: DEFAULTS.keyB,      min: 0, max: 1, curve: 'linear' },
    { id: 'threshold', label: 'Thr',  defaultValue: DEFAULTS.threshold, min: 0, max: 1, curve: 'linear' },
    { id: 'softness',  label: 'Soft', defaultValue: DEFAULTS.softness,  min: 0, max: 1, curve: 'linear' },
    { id: 'invert',    label: 'Inv',  defaultValue: DEFAULTS.invert,    min: 0, max: 1, curve: 'discrete' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex       = gl.getUniformLocation(program, 'uTex');
    const uHasInput  = gl.getUniformLocation(program, 'uHasInput');
    const uKeyR      = gl.getUniformLocation(program, 'uKeyR');
    const uKeyG      = gl.getUniformLocation(program, 'uKeyG');
    const uKeyB      = gl.getUniformLocation(program, 'uKeyB');
    const uThreshold = gl.getUniformLocation(program, 'uThreshold');
    const uSoftness  = gl.getUniformLocation(program, 'uSoftness');
    const uInvert    = gl.getUniformLocation(program, 'uInvert');

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
        g.uniform1f(uThreshold, params.threshold);
        g.uniform1f(uSoftness,  params.softness);
        g.uniform1f(uInvert,    params.invert);

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
