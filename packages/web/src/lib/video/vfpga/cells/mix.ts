// packages/web/src/lib/video/vfpga/cells/mix.ts
//
// CLB cell `mix(a, b, t)` — linear blend of two inputs by a scalar `t` (the
// generic 2-input ALU cell). `t` is a config knob: a static const, OR bound to
// a host param/CV/gate. Two inputs (a, b), one knob (t, default 0.5).

import { type VfpgaCell } from './types';

export const mixCell: VfpgaCell = {
  type: 'clb',
  op: 'mix',
  inputs: ['a', 'b'],
  knobs: [
    {
      name: 't',
      uniform: 'uMixT',
      defaultValue: 0.5,
      label: 'BLEND',
      doc: '0 = input a, 1 = input b, 0.5 = even mix.',
    },
  ],
  doc: 'Linear blend mix(a, b, t) of two inputs by scalar t.',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const b = uTexFor('b');
    const t = uniformFor('t');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform sampler2D ${b};
uniform float ${t};
void main() {
  vec4 ca = texture(${a}, vUv);
  vec4 cb = texture(${b}, vUv);
  outColor = mix(ca, cb, clamp(${t}, 0.0, 1.0));
}`;
  },
};
