// packages/web/src/lib/video/vfpga/cells/hsvshift.ts
//
// CLB cell `hsvShift(a, hue, sat, val)` — the colour-space CLB op (the analogue
// colouriser / hue-rotate cell): converts input `a` to HSV, adds `hue` (wrapped),
// scales saturation by `sat` and value by `val`, converts back to RGB. One input,
// three knobs (hue default 0, sat default 1, val default 1). Alpha preserved.

import { type VfpgaCell } from './types';

export const hsvShiftCell: VfpgaCell = {
  type: 'clb',
  op: 'hsvShift',
  inputs: ['a'],
  knobs: [
    {
      name: 'hue',
      uniform: 'uHueShift',
      defaultValue: 0,
      label: 'HUE',
      doc: 'Added to the hue (0..1 wraps a full colour wheel).',
    },
    {
      name: 'sat',
      uniform: 'uSatScale',
      defaultValue: 1,
      label: 'SAT',
      doc: 'Multiplies saturation (0 = greyscale, 1 = unchanged).',
    },
    {
      name: 'val',
      uniform: 'uValScale',
      defaultValue: 1,
      label: 'VAL',
      doc: 'Multiplies value/brightness.',
    },
  ],
  doc: 'HSV colourise CLB: hue-rotate + scale saturation/value of input a.',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const hue = uniformFor('hue');
    const sat = uniformFor('sat');
    const val = uniformFor('val');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform float ${hue};
uniform float ${sat};
uniform float ${val};
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
void main() {
  vec4 c = texture(${a}, vUv);
  vec3 hsv = rgb2hsv(c.rgb);
  hsv.x = fract(hsv.x + ${hue});
  hsv.y = clamp(hsv.y * ${sat}, 0.0, 1.0);
  hsv.z = clamp(hsv.z * ${val}, 0.0, 1.0);
  outColor = vec4(hsv2rgb(hsv), c.a);
}`;
  },
};
