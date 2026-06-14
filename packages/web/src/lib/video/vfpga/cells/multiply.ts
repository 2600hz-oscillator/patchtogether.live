// packages/web/src/lib/video/vfpga/cells/multiply.ts
//
// CLB cell `multiply(a, b, gain)` — the multiplicative ALU cell: per-channel
// product of two inputs (a ring-modulator / masker / multiplicative keyer). The
// product is scaled by `gain` (default 1) and clamped to [0,1]. Two inputs, one
// knob. The classic "video multiplier" of analogue synthesis.

import { type VfpgaCell } from './types';

export const multiplyCell: VfpgaCell = {
  type: 'clb',
  op: 'multiply',
  inputs: ['a', 'b'],
  knobs: [
    {
      name: 'gain',
      uniform: 'uMulGain',
      defaultValue: 1,
      label: 'GAIN',
      doc: 'Scales the per-channel product before the [0,1] clamp.',
    },
  ],
  doc: 'Multiplicative CLB: clamp(a * b * gain) — a ring-mod / mask / keyer.',
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
  outColor = clamp(ca * cb * ${gain}, 0.0, 1.0);
}`;
  },
};
