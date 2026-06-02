// packages/web/src/lib/video/modules/chroma.ts
//
// CHROMA — single-input HUE-SHIFTER / COLORIZER.
//
// History: prior versions of this module conflated "key-mask extraction"
// with the user-facing concept of a "chroma keyer." A real keyer takes
// foreground + background and composites — see CHROMAKEY for that. CHROMA
// is now what its name actually suggests: a single-input color processor
// that shifts hue, scales saturation, and lerps toward a tint color.
//
// Schema v3 migration: prior v1/v2 stored key-mask params (keyR/keyG/keyB,
// threshold, softness, invert). Those were never correct for this module's
// real job, so on load we drop them and reset to the new processor
// defaults. Existing rackspaces using the old CHROMA as a mask source
// silently render the input colorized; users who actually wanted a key
// should swap in CHROMAKEY.
//
// GLSL pipeline (per pixel):
//   RGB -> HSV -> shift hue by `hue` (degrees), scale saturation by
//   `saturation` -> HSV -> RGB -> lerp toward (tintR, tintG, tintB) by
//   `tintMix`.
//
// CV inputs are linear-scaled per param and use the project convention of
// `paramTarget == port.id` so the cross-domain CV bridge can target them
// directly (see PR #264).
//
// Inputs:
//   in (video): RGB video to colorize.
//   hue / saturation / tintR / tintG / tintB / tintMix (cv, paramTarget=…): per-param CV.
//
// Outputs:
//   out (video): hue-shifted / tinted RGB output.
//
// Params:
//   hue (linear -180..180): hue rotation in degrees.
//   saturation (linear 0..2): saturation scale (0 = grayscale, 1 = pristine, 2 = vivid).
//   tintR / tintG / tintB (linear 0..1): tint colour.
//   tintMix (linear 0..1): tint blend amount (0 = bypass tint, 1 = pure tint).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

// Shared HSV helpers — lifted from the p10entrancer reference shader and
// transliterated to GLSL. Hue is [0, 1) (0 = red, 1/3 = green, 2/3 = blue).
const HSV_GLSL = `
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
`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;
uniform float uHue;        // -180..+180 degrees
uniform float uSaturation; // 0..2 multiplier
uniform float uTintR;
uniform float uTintG;
uniform float uTintB;
uniform float uTintMix;    // 0..1

${HSV_GLSL}

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 src = texture(uTex, vUv).rgb;
  vec3 hsv = rgbToHsv(src);
  // Hue in HSV space is [0, 1); convert the degree offset to a fraction
  // and wrap with fract() so negative wraps cleanly.
  hsv.x = fract(hsv.x + uHue / 360.0 + 1.0);
  hsv.y = clamp(hsv.y * uSaturation, 0.0, 1.0);
  vec3 shifted = hsvToRgb(hsv);
  vec3 tint = vec3(uTintR, uTintG, uTintB);
  vec3 out_rgb = mix(shifted, tint, clamp(uTintMix, 0.0, 1.0));
  outColor = vec4(out_rgb, 1.0);
}`;

interface ChromaParams {
  hue: number;
  saturation: number;
  tintR: number;
  tintG: number;
  tintB: number;
  tintMix: number;
}

const DEFAULTS: ChromaParams = {
  hue: 0,
  saturation: 1,
  tintR: 1,
  tintG: 1,
  tintB: 1,
  tintMix: 0,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(DEFAULTS));
const LEGACY_PARAM_IDS = new Set([
  'keyR', 'keyG', 'keyB', 'threshold', 'softness', 'invert', 'tolerance',
]);

/**
 * Migrate older CHROMA params. v1/v2 stored key-mask shape; v3 stores
 * hue-shift / colorize shape. Since the OLD semantics were broken (a
 * single-input "keyer" makes no sense — there's no background to
 * composite into), we accept a behavior reset on load: drop the legacy
 * key-mask params, keep the empty object so DEFAULTS spread fills in. Any
 * already-present v3 param values are preserved.
 *
 * Pure helper so unit tests can pin behavior without instantiating GL.
 */
export function migrateChroma(data: unknown, fromVersion: number): unknown {
  if (!data || typeof data !== 'object') return data;
  if (fromVersion >= 3) return data;
  const obj = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Keep any keys that aren't legacy mask params and aren't recognized
  // (forward-compat for unknown extras). Strip legacy mask params; the
  // factory's DEFAULTS spread fills in v3 defaults for anything missing.
  for (const [k, v] of Object.entries(obj)) {
    if (LEGACY_PARAM_IDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export const chromaDef: VideoModuleDef = {
  type: 'chroma',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'CHROMA',
  category: 'effects',
  schemaVersion: 3,
  migrate: migrateChroma,
  inputs: [
    { id: 'in',         type: 'video' },
    { id: 'hue',        type: 'cv', paramTarget: 'hue' },
    { id: 'saturation', type: 'cv', paramTarget: 'saturation' },
    { id: 'tintR',      type: 'cv', paramTarget: 'tintR' },
    { id: 'tintG',      type: 'cv', paramTarget: 'tintG' },
    { id: 'tintB',      type: 'cv', paramTarget: 'tintB' },
    { id: 'tintMix',    type: 'cv', paramTarget: 'tintMix' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'hue',        label: 'Hue',  defaultValue: DEFAULTS.hue,        min: -180, max: 180, curve: 'linear' },
    { id: 'saturation', label: 'Sat',  defaultValue: DEFAULTS.saturation, min: 0,    max: 2,   curve: 'linear' },
    { id: 'tintR',      label: 'R',    defaultValue: DEFAULTS.tintR,      min: 0,    max: 1,   curve: 'linear' },
    { id: 'tintG',      label: 'G',    defaultValue: DEFAULTS.tintG,      min: 0,    max: 1,   curve: 'linear' },
    { id: 'tintB',      label: 'B',    defaultValue: DEFAULTS.tintB,      min: 0,    max: 1,   curve: 'linear' },
    { id: 'tintMix',    label: 'Mix',  defaultValue: DEFAULTS.tintMix,    min: 0,    max: 1,   curve: 'linear' },
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);

    const uTex        = gl.getUniformLocation(program, 'uTex');
    const uHasInput   = gl.getUniformLocation(program, 'uHasInput');
    const uHue        = gl.getUniformLocation(program, 'uHue');
    const uSaturation = gl.getUniformLocation(program, 'uSaturation');
    const uTintR      = gl.getUniformLocation(program, 'uTintR');
    const uTintG      = gl.getUniformLocation(program, 'uTintG');
    const uTintB      = gl.getUniformLocation(program, 'uTintB');
    const uTintMix    = gl.getUniformLocation(program, 'uTintMix');

    const { fbo, texture } = ctx.createFbo();

    // Strip any stray legacy keys (e.g. saved v1/v2 node that bypassed
    // migration somehow) so they can't bleed into the params object.
    const rawParams = node.params as Record<string, unknown>;
    const filteredParams: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filteredParams[k] = v;
    }
    const params: ChromaParams = { ...DEFAULTS, ...filteredParams as Partial<ChromaParams> };

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

        g.uniform1f(uHue,        params.hue);
        g.uniform1f(uSaturation, params.saturation);
        g.uniform1f(uTintR,      params.tintR);
        g.uniform1f(uTintG,      params.tintG);
        g.uniform1f(uTintB,      params.tintB);
        g.uniform1f(uTintMix,    params.tintMix);

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
