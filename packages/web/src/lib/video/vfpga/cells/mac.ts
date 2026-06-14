// packages/web/src/lib/video/vfpga/cells/mac.ts
//
// DSP cell `mac(a, b, scale, offset)` — the multiply-accumulate primitive (the
// fundamental DSP MAC, design §1.3): per-channel `a * b * scale + offset`,
// clamped. The building block of every filter/mixer (a scaled product summed onto
// an offset). Two inputs (a, b), two knobs (scale default 1, offset default 0).
//
// Distinct from the CLB `multiply`: `mac` is the SIGNED accumulate form (the
// scale+offset are the DSP slice's coefficient + accumulator seed), and it lives
// on the `dsp` tile type so it counts against the DSP budget — modelling the
// dedicated MAC slice an FPGA's DSP block provides.

import { type VfpgaCell } from './types';

export const macCell: VfpgaCell = {
  type: 'dsp',
  op: 'mac',
  inputs: ['a', 'b'],
  knobs: [
    {
      name: 'scale',
      uniform: 'uMacScale',
      defaultValue: 1,
      label: 'SCALE',
      doc: 'Coefficient the product a*b is multiplied by.',
    },
    {
      name: 'offset',
      uniform: 'uMacOffset',
      defaultValue: 0,
      label: 'OFFSET',
      doc: 'Accumulator seed added after the scaled product.',
    },
  ],
  doc: 'Multiply-accumulate DSP slice: clamp(a * b * scale + offset).',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const b = uTexFor('b');
    const scale = uniformFor('scale');
    const offset = uniformFor('offset');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform sampler2D ${b};
uniform float ${scale};
uniform float ${offset};
void main() {
  vec4 ca = texture(${a}, vUv);
  vec4 cb = texture(${b}, vUv);
  vec3 acc = ca.rgb * cb.rgb * ${scale} + ${offset};
  outColor = vec4(clamp(acc, 0.0, 1.0), ca.a);
}`;
  },
};
