// packages/web/src/lib/video/vfpga/cells/mosh.ts
//
// CLB cell `mosh(a, mvect, block, quant, iframe, seed)` — MPEG/H.264-style
// DATAMOSH (the macroblock-mosh bend, design §3.5). Models a bent block codec:
// it MIS-APPLIES motion-compensated block prediction to a reference frame so the
// picture melts/smears (the classic I-frame-removal datamosh look). Wired so its
// input `a` is a register's `:prev` (last-frame) frame-store, it warps the
// recirculated REFERENCE by pseudo motion-vectors carried block-by-block, quantizes
// the macroblocks (the DCT-block look), and a held gate FORCES an I-frame (a clean
// reload — output black so the downstream mix falls back to the live picture).
//
// The block grid is the macroblock unit; per-block a seeded pseudo motion-vector
// (deterministic frame+block+seed hash, VRT-safe) displaces the sampled UV — the
// "P-frame applied to the wrong reference" flow/bloom. Higher `mvect` = a P-frame
// storm runaway; bigger `block` = chunkier macroblocks; `quant` posterizes per
// block (the DCT quantize). ONE input (a), four knobs + the shared seed.
//
//   mvect   motion-vector gain (block UV displacement) — the mosh smear amount.
//   block   macroblock size in pixels (the block-grid quantum).
//   quant   per-block colour quantize (the DCT-block posterize look).
//   iframe  a HELD gate: while high, force a clean I-frame (this tile outputs
//           black → the downstream mix reads 100% live = a clean reset pulse).
//   seed    re-rollable mosh seed (a reseed/I-frame gate advances it).
//
// CV binds onto mvect (motion drift); the I-frame gate binds onto iframe.

import { type VfpgaCell } from './types';
import { BEND_SEED_GLSL, BEND_SEED_UNIFORM } from './bend-seed';

export const moshCell: VfpgaCell = {
  type: 'clb',
  op: 'mosh',
  inputs: ['a'],
  knobs: [
    { name: 'mvect', uniform: 'uMoshMvect', defaultValue: 0.05, label: 'MVECT', doc: 'Motion-vector gain — the block UV displacement (mosh smear / P-frame storm).' },
    { name: 'block', uniform: 'uMoshBlock', defaultValue: 16, label: 'BLOCK', doc: 'Macroblock size in pixels (the block-grid quantum).' },
    { name: 'quant', uniform: 'uMoshQuant', defaultValue: 0.0, label: 'QUANT', doc: 'Per-block colour quantize (the DCT-block posterize look).' },
    { name: 'iframe', uniform: 'uMoshIframe', defaultValue: 0.0, label: 'I-FRM', doc: 'A held gate: while high, force a clean I-frame (output black → mix reads live).' },
    { name: 'seed', uniform: BEND_SEED_UNIFORM, defaultValue: 0, label: 'SEED', doc: 'Re-rollable mosh seed (a reseed / I-frame gate advances it).' },
  ],
  doc: 'MPEG/H.264 datamosh: block motion-vector smear + macroblock quantize, with a forced I-frame gate (macroblock-mosh).',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const mvect = uniformFor('mvect');
    const block = uniformFor('block');
    const quant = uniformFor('quant');
    const iframe = uniformFor('iframe');
    const seed = uniformFor('seed');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform vec2 uResolution;
uniform float uTime;
uniform float ${mvect};
uniform float ${block};
uniform float ${quant};
uniform float ${iframe};
uniform float ${seed};
${BEND_SEED_GLSL}
void main() {
  float seedOff = ${seed} * 0.011;
  // MACROBLOCK grid: snap UV to a block, the codec's prediction unit.
  vec2 res = max(uResolution, vec2(1.0));
  float blk = max(${block}, 1.0);
  vec2 blockId = floor(vUv * res / blk);
  // pseudo MOTION-VECTOR per block (seeded, time-drifting) — "P-frame applied to
  // the wrong reference": each block samples the reference at a displaced UV.
  float mvx = (bendHash(blockId + vec2(seedOff, uTime * 0.07)) - 0.5) * 2.0;
  float mvy = (bendHash(blockId + vec2(seedOff + 7.3, uTime * 0.05 + 2.1)) - 0.5) * 2.0;
  vec2 mv = vec2(mvx, mvy) * ${mvect};
  vec2 uv = clamp(vUv + mv, 0.0, 1.0);
  vec3 col = texture(${a}, uv).rgb;
  // per-block DCT-ish QUANTIZE: posterize the block colour (the macroblock look).
  float q = clamp(${quant}, 0.0, 1.0);
  if (q > 0.0) {
    float levels = mix(64.0, 3.0, q);
    col = floor(col * levels + 0.5) / levels;
  }
  // forced I-FRAME (held gate): output black so the downstream mix reads 100%
  // live = a clean reload (the I-frame reset pulse).
  col *= (1.0 - clamp(${iframe}, 0.0, 1.0));
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
  },
};
