// packages/web/src/lib/video/vfpga/cells/gain.ts
//
// CLB cell `gain(a, gain, bias)` — the scale+offset ALU cell (the per-pixel VCA /
// brightness-contrast cell): c * gain + bias, clamped. One input (a), two knobs
// (gain default 1, bias default 0). The simplest amplitude-modulation primitive a
// CV-bound knob drives. Alpha preserved.

import { type VfpgaCell } from './types';

export const gainCell: VfpgaCell = {
  type: 'clb',
  op: 'gain',
  inputs: ['a'],
  knobs: [
    {
      name: 'gain',
      uniform: 'uGain',
      defaultValue: 1,
      label: 'GAIN',
      doc: 'Multiplies each RGB channel (a per-pixel VCA).',
    },
    {
      name: 'bias',
      uniform: 'uBias',
      defaultValue: 0,
      label: 'BIAS',
      doc: 'Added to each channel after the gain (brightness offset).',
    },
  ],
  doc: 'Scale+offset CLB: clamp(a * gain + bias) — a per-pixel VCA / brightness.',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const gain = uniformFor('gain');
    const bias = uniformFor('bias');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform float ${gain};
uniform float ${bias};
void main() {
  vec4 c = texture(${a}, vUv);
  outColor = vec4(clamp(c.rgb * ${gain} + ${bias}, 0.0, 1.0), c.a);
}`;
  },
};
