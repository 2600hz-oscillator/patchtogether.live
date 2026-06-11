// packages/web/src/lib/video/vfpga/cells/threshold.ts
//
// CLB cell `threshold` — per-channel hard threshold (the comparator/key cell):
// each RGB channel of input `a` becomes 0 or 1 depending on whether it exceeds
// the `level` knob. One input (a), one knob (level, default 0.5). Alpha kept.

import { type VfpgaCell } from './types';

export const thresholdCell: VfpgaCell = {
  type: 'clb',
  op: 'threshold',
  inputs: ['a'],
  knobs: [
    {
      name: 'level',
      uniform: 'uThreshold',
      defaultValue: 0.5,
      label: 'LEVEL',
      doc: 'Per-channel cutoff: channel ≥ level → 1, else 0.',
    },
  ],
  doc: 'Per-channel hard threshold of input a at level.',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const level = uniformFor('level');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform float ${level};
void main() {
  vec4 c = texture(${a}, vUv);
  outColor = vec4(step(${level}, c.rgb), c.a);
}`;
  },
};
