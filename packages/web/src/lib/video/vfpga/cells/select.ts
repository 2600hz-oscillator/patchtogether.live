// packages/web/src/lib/video/vfpga/cells/select.ts
//
// CLB cell `select(a, b, sel)` — the 2:1 routing MUX (the switch-matrix's
// data-path mux as a CLB cell): `sel` < 0.5 → a, else b. A hard, per-pixel
// router (the combinational counterpart to a CV-/gate-driven A/B switch). Two
// inputs (a, b), one knob (sel, default 0 → a).

import { type VfpgaCell } from './types';

export const selectCell: VfpgaCell = {
  type: 'clb',
  op: 'select',
  inputs: ['a', 'b'],
  knobs: [
    {
      name: 'sel',
      uniform: 'uSelect',
      defaultValue: 0,
      label: 'SEL',
      doc: 'sel < 0.5 → input a, sel ≥ 0.5 → input b (a 2:1 mux).',
    },
  ],
  doc: '2:1 routing MUX: sel chooses input a (sel<0.5) or input b (sel≥0.5).',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const b = uTexFor('b');
    const sel = uniformFor('sel');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform sampler2D ${b};
uniform float ${sel};
void main() {
  vec4 ca = texture(${a}, vUv);
  vec4 cb = texture(${b}, vUv);
  outColor = ${sel} < 0.5 ? ca : cb;
}`;
  },
};
