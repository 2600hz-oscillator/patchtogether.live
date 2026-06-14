// packages/web/src/lib/video/vfpga/cells/add.ts
//
// CLB cell `add(a, b, gain)` — the additive ALU cell: sums two inputs and clamps
// to [0,1] (an adder / brightener / keyed-fill compositor). `gain` scales the sum
// (default 1). Two inputs (a, b), one knob (gain). Alpha is summed + clamped too.

import { type VfpgaCell } from './types';

export const addCell: VfpgaCell = {
  type: 'clb',
  op: 'add',
  inputs: ['a', 'b'],
  knobs: [
    {
      name: 'gain',
      uniform: 'uAddGain',
      defaultValue: 1,
      label: 'GAIN',
      doc: 'Scales the summed result before the [0,1] clamp.',
    },
  ],
  doc: 'Additive CLB: clamp((a + b) * gain) — an adder / keyed-fill compositor.',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const b = uTexFor('b');
    const gain = uniformFor('gain');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform sampler2D ${b};
uniform float ${gain};
void main() {
  vec4 ca = texture(${a}, vUv);
  vec4 cb = texture(${b}, vUv);
  outColor = clamp((ca + cb) * ${gain}, 0.0, 1.0);
}`;
  },
};
