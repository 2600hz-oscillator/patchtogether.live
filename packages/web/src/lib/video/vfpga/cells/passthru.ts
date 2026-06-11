// packages/web/src/lib/video/vfpga/cells/passthru.ts
//
// CLB cell `passthru` — the identity ALU: samples its single input `a` and
// writes it unchanged. The trivial routing cell (and the simplest way to wire a
// 1-tile fabric end-to-end through P&R). One input, no knobs.

import { type VfpgaCell } from './types';

export const passthruCell: VfpgaCell = {
  type: 'clb',
  op: 'passthru',
  inputs: ['a'],
  knobs: [],
  doc: 'Identity CLB: samples input a and writes it unchanged.',
  kernel({ uTexFor }) {
    const a = uTexFor('a');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
void main() {
  outColor = texture(${a}, vUv);
}`;
  },
};
