// packages/web/src/lib/video/vfpga/cells/luma.ts
//
// CLB cell `luma(a)` — the RGB→luma reducer (the comparator/key FEEDER): collapses
// input `a` to its Rec.601 luma replicated across RGB (a greyscale key signal the
// threshold/select cells then act on). One input (a), no knobs. Alpha preserved.

import { type VfpgaCell } from './types';

export const lumaCell: VfpgaCell = {
  type: 'clb',
  op: 'luma',
  inputs: ['a'],
  knobs: [],
  doc: 'RGB→luma CLB: dot(a.rgb, Rec.601) replicated to greyscale (a key feeder).',
  kernel({ uTexFor }) {
    const a = uTexFor('a');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
void main() {
  vec4 c = texture(${a}, vUv);
  float y = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  outColor = vec4(vec3(y), c.a);
}`;
  },
};
