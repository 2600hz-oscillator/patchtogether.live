// packages/web/src/lib/video/vfpga/cells/diff.ts
//
// CLB cell `diff(a, b, gain)` — the absolute-difference ALU cell: per-channel
// |a - b|, scaled by `gain` and clamped. The keying / motion-detect / edge
// primitive (difference of two frames or two sources highlights what changed).
// Two inputs (a, b), one knob (gain, default 1).

import { type VfpgaCell } from './types';

export const diffCell: VfpgaCell = {
  type: 'clb',
  op: 'diff',
  inputs: ['a', 'b'],
  knobs: [
    {
      name: 'gain',
      uniform: 'uDiffGain',
      defaultValue: 1,
      label: 'GAIN',
      doc: 'Scales the absolute difference before the [0,1] clamp.',
    },
  ],
  doc: 'Absolute-difference CLB: clamp(|a - b| * gain) — a key / motion / edge cell.',
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
  vec4 d = abs(ca - cb) * ${gain};
  outColor = vec4(clamp(d.rgb, 0.0, 1.0), 1.0);
}`;
  },
};
