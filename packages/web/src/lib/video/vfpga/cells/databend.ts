// packages/web/src/lib/video/vfpga/cells/databend.ts
//
// CLB cell `databend(a, shift, dropout, wrap, seed)` — composite-as-DATA bending
// (the databend-cvbs bend, design §3.4). Models corrupting the per-column
// composite samples the way databending mangles a file: a horizontal byte-shift
// (sample-offset), seeded sample-hold DROPOUTS (a column freezes on a held value),
// and a level WRAP-AROUND (overflow glitch — luma past 1.0 wraps to 0). The bit-
// plane XOR half of the bend lives in the LUT16 tile UPSTREAM (databend-cvbs wires
// lut16 → databend); this cell is the shift/dropout/wrap datapath corruption.
//
//   shift   horizontal sample offset (signed) — "byte-shift" smear.
//   dropout per-column probability the column sample-holds (freezes) → vertical
//           streaks of stuck samples.
//   wrap    level wrap-around amount: scaled luma past 1.0 wraps mod 1 (overflow).
//   seed    re-rollable dropout/shift seed (a reseed gate advances it).
//
// One input (a), four knobs + the shared seed. CV binds onto shift; a re-roll gate
// binds onto seed.

import { type VfpgaCell } from './types';
import { BEND_SEED_GLSL, BEND_SEED_UNIFORM } from './bend-seed';

export const databendCell: VfpgaCell = {
  type: 'clb',
  op: 'databend',
  inputs: ['a'],
  knobs: [
    { name: 'shift', uniform: 'uByteShift', defaultValue: 0.0, label: 'SHIFT', doc: 'Horizontal sample (byte) shift — a signed smear offset.' },
    { name: 'dropout', uniform: 'uDropout', defaultValue: 0.0, label: 'DROP', doc: 'Per-column probability of a sample-hold dropout (frozen streaks).' },
    { name: 'wrap', uniform: 'uWrapLevel', defaultValue: 0.0, label: 'WRAP', doc: 'Level wrap-around: scaled luma past 1.0 wraps mod 1 (overflow glitch).' },
    { name: 'seed', uniform: BEND_SEED_UNIFORM, defaultValue: 0, label: 'SEED', doc: 'Re-rollable corruption seed (a reseed gate advances it).' },
  ],
  doc: 'Composite databend: byte-shift / sample-hold dropout / level wrap (databend-cvbs datapath).',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const shift = uniformFor('shift');
    const dropout = uniformFor('dropout');
    const wrap = uniformFor('wrap');
    const seed = uniformFor('seed');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform vec2 uResolution;
uniform float ${shift};
uniform float ${dropout};
uniform float ${wrap};
uniform float ${seed};
${BEND_SEED_GLSL}
void main() {
  float seedOff = ${seed} * 0.017;
  float cols = max(uResolution.x, 1.0);
  float col = floor(vUv.x * cols);
  // SAMPLE-HOLD DROPOUT: unlucky columns freeze on a hash-chosen sample x (a
  // stuck vertical streak), lucky columns read their own x.
  float roll = bendHash(vec2(col, seedOff + 3.3));
  float dropX = bendHash(vec2(col, seedOff + 5.9));
  float x = roll < ${dropout} ? dropX : vUv.x;
  // BYTE-SHIFT: a signed horizontal sample offset (wrapped).
  x = fract(x + ${shift});
  vec4 c = texture(${a}, vec2(x, vUv.y));
  // LEVEL WRAP-AROUND: scale luma up so it overflows past 1.0 and wraps mod 1
  // for overflow banding. Blended by the wrap amount so wrap=0 is an exact
  // passthrough (no fract(1.0)=0 black-speckle on full-white pixels).
  float w = clamp(${wrap}, 0.0, 1.0);
  vec3 wrapped = fract(c.rgb * (1.0 + w * 3.0) + 1.0e-4);
  vec3 rgb = mix(c.rgb, wrapped, w);
  outColor = vec4(rgb, c.a);
}`;
  },
};
