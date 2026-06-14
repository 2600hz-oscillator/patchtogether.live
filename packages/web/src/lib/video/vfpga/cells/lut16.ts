// packages/web/src/lib/video/vfpga/cells/lut16.ts
//
// LUT16 cell `lut(a, b, c, d, init, level)` — a literal 4-input bitwise truth
// table (the FPGA LUT4, design §1.3 + the ratified OWNER DECISION "LUT16 tile
// yes"). Each of the four inputs is thresholded at `level` into a bit; the four
// bits form a 0..15 index; the output is bit `index` of the 16-bit `init` truth
// table (0 → black, 1 → white). The pure combinational logic primitive (AND / OR
// / XOR / any boolean function of 4 keyed inputs by choosing `init`).
//
// `init` is the truth-table as a KNOB (float uniform) — a cell kernel is config-
// parameterised only through knobs, so the 16-bit table rides the same uniform-
// binding channel every other cell uses (the `config.lutInit` bitstream field is
// the authoring sugar a later phase will lower onto this knob). GLSL ES 3.00
// integer + bit ops decode it per pixel. Four inputs (a,b,c,d), two knobs
// (init default 0x8888 = "(a AND c) — a sample boolean", level default 0.5).

import { type VfpgaCell } from './types';

export const lut16Cell: VfpgaCell = {
  type: 'lut16',
  op: 'lut',
  inputs: ['a', 'b', 'c', 'd'],
  knobs: [
    {
      name: 'init',
      uniform: 'uLutInit',
      // 0x8888 = bits set at index 3,7,11,15 (a&&c, ignoring b/d) — a non-trivial
      // default so an unconfigured LUT does something visible rather than all-0.
      defaultValue: 0x8888,
      label: 'INIT',
      doc: '16-bit truth table: output = bit[(d<<3)|(c<<2)|(b<<1)|a] of this value.',
    },
    {
      name: 'level',
      uniform: 'uLutLevel',
      defaultValue: 0.5,
      label: 'LEVEL',
      doc: 'Per-input luma threshold turning each input into its truth-table bit.',
    },
  ],
  doc: '4-input bitwise truth table (LUT4): boolean function of four keyed inputs.',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const b = uTexFor('b');
    const c = uTexFor('c');
    const d = uTexFor('d');
    const init = uniformFor('init');
    const level = uniformFor('level');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform sampler2D ${b};
uniform sampler2D ${c};
uniform sampler2D ${d};
uniform float ${init};
uniform float ${level};
int bitOf(sampler2D t) {
  float y = dot(texture(t, vUv).rgb, vec3(0.299, 0.587, 0.114));
  return y >= ${level} ? 1 : 0;
}
void main() {
  int idx = bitOf(${a}) | (bitOf(${b}) << 1) | (bitOf(${c}) << 2) | (bitOf(${d}) << 3);
  uint table = uint(clamp(${init}, 0.0, 65535.0) + 0.5);
  float bit = ((table >> uint(idx)) & 1u) == 1u ? 1.0 : 0.0;
  outColor = vec4(vec3(bit), 1.0);
}`;
  },
};
