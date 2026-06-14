// packages/web/src/lib/video/vfpga/cells/invert.ts
//
// CLB cell `invert(a, amount)` — the negate ALU cell: per-channel 1 - a, mixed
// toward the original by `amount` (0 = passthru, 1 = full negative). The classic
// video "negative" / colour-invert primitive. One input (a), one knob (amount,
// default 1 = full invert). Alpha is preserved.

import { type VfpgaCell } from './types';

export const invertCell: VfpgaCell = {
  type: 'clb',
  op: 'invert',
  inputs: ['a'],
  knobs: [
    {
      name: 'amount',
      uniform: 'uInvertAmount',
      defaultValue: 1,
      label: 'AMOUNT',
      doc: '0 = passthru, 1 = full per-channel negative (1 - a).',
    },
  ],
  doc: 'Colour-invert CLB: mix(a, 1 - a, amount) per RGB channel.',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const amount = uniformFor('amount');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform float ${amount};
void main() {
  vec4 c = texture(${a}, vUv);
  vec3 inv = mix(c.rgb, 1.0 - c.rgb, clamp(${amount}, 0.0, 1.0));
  outColor = vec4(inv, c.a);
}`;
  },
};
