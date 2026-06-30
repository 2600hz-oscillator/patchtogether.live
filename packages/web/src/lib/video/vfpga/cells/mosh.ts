// packages/web/src/lib/video/vfpga/cells/mosh.ts
//
// CLB cell `mosh(a, b, bprev, mvect, mvectB, block, quant, iframe, seed)` —
// MPEG/H.264-style DATAMOSH (the macroblock-mosh bend, design §3.5). Models a bent
// block codec: it MIS-APPLIES motion-compensated block prediction to a reference
// frame so the picture melts/smears (the classic I-frame-removal datamosh look).
// Wired so its input `a` is a register's `:prev` (last-frame) frame-store, it warps
// the recirculated REFERENCE by motion-vectors carried block-by-block, quantizes
// the macroblocks (the DCT-block look), and a held gate FORCES an I-frame (a clean
// reload — output black so the downstream mix falls back to the live picture).
//
// MOTION HAS TWO SOURCES (the multi-input upgrade, design research 2026-06-30 §2):
//   1. SYNTHETIC per-block motion — a seeded pseudo motion-vector (deterministic
//      frame+block+seed hash, VRT-safe) scaled by `mvect`. This is the single-source
//      "P-frame applied to the wrong reference" storm, unchanged from the original.
//   2. TRANSFERRED motion from a SECOND clip (`b`/`bprev`) scaled by `mvectB` — the
//      canonical TWO-CLIP datamosh: estimate clip B's per-block motion (normal flow
//      from B's temporal+spatial luma gradient) and carry it onto image A. `b` is
//      clip B now, `bprev` is clip B one frame ago (a register :prev). When the 2nd
//      video input is UNPATCHED both read the 1×1 transparent-black fallback, so the
//      gradients (hence the flow) are exactly zero and the cell is byte-for-byte the
//      original single-source mosh — patch a motion source to upgrade it in place.
//
// The block grid is the macroblock unit; per-block the combined motion-vector
// displaces the sampled UV of `a` — the flow/bloom. Higher `mvect`/`mvectB` = a
// P-frame storm runaway; bigger `block` = chunkier macroblocks; `quant` posterizes
// per block (the DCT quantize). Three inputs (a, b, bprev), six knobs + the seed.
//
//   mvect   synthetic motion-vector gain (seeded per-block storm) — mosh smear amount.
//   mvectB  TRANSFERRED motion gain — carry clip B's (b vs bprev) motion onto A.
//   block   macroblock size in pixels (the block-grid quantum).
//   quant   per-block colour quantize (the DCT-block posterize look).
//   iframe  a HELD gate: while high, force a clean I-frame (this tile outputs
//           black → the downstream mix reads 100% live = a clean reset pulse).
//   seed    re-rollable mosh seed (a reseed/I-frame gate advances it).
//
// CV binds onto mvect / mvectB (motion drift); the I-frame gate binds onto iframe.

import { type VfpgaCell } from './types';
import { BEND_SEED_GLSL, BEND_SEED_UNIFORM } from './bend-seed';

export const moshCell: VfpgaCell = {
  type: 'clb',
  op: 'mosh',
  inputs: ['a', 'b', 'bprev'],
  knobs: [
    { name: 'mvect', uniform: 'uMoshMvect', defaultValue: 0.05, label: 'MVECT', doc: 'Synthetic motion-vector gain — the seeded per-block displacement (mosh smear / P-frame storm).' },
    { name: 'mvectB', uniform: 'uMoshMvectB', defaultValue: 0.0, label: 'MXFER', doc: 'Transferred-motion gain — carry the SECOND clip’s (motion-source) per-block motion onto the picture (two-clip datamosh). 0 = synthetic only.' },
    { name: 'block', uniform: 'uMoshBlock', defaultValue: 16, label: 'BLOCK', doc: 'Macroblock size in pixels (the block-grid quantum).' },
    { name: 'quant', uniform: 'uMoshQuant', defaultValue: 0.0, label: 'QUANT', doc: 'Per-block colour quantize (the DCT-block posterize look).' },
    { name: 'iframe', uniform: 'uMoshIframe', defaultValue: 0.0, label: 'I-FRM', doc: 'A held gate: while high, force a clean I-frame (output black → mix reads live).' },
    { name: 'seed', uniform: BEND_SEED_UNIFORM, defaultValue: 0, label: 'SEED', doc: 'Re-rollable mosh seed (a reseed / I-frame gate advances it).' },
  ],
  doc: 'MPEG/H.264 datamosh: synthetic + transferred (two-clip) block motion-vector smear + macroblock quantize, with a forced I-frame gate (macroblock-mosh).',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const b = uTexFor('b');
    const bprev = uTexFor('bprev');
    const mvect = uniformFor('mvect');
    const mvectB = uniformFor('mvectB');
    const block = uniformFor('block');
    const quant = uniformFor('quant');
    const iframe = uniformFor('iframe');
    const seed = uniformFor('seed');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform sampler2D ${b};
uniform sampler2D ${bprev};
uniform vec2 uResolution;
uniform float uTime;
uniform float ${mvect};
uniform float ${mvectB};
uniform float ${block};
uniform float ${quant};
uniform float ${iframe};
uniform float ${seed};
${BEND_SEED_GLSL}
float moshLuma(sampler2D s, vec2 uv) {
  return dot(texture(s, clamp(uv, 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
}
void main() {
  float seedOff = ${seed} * 0.011;
  // MACROBLOCK grid: snap UV to a block, the codec's prediction unit.
  vec2 res = max(uResolution, vec2(1.0));
  float blk = max(${block}, 1.0);
  vec2 blockId = floor(vUv * res / blk);
  // (1) SYNTHETIC pseudo MOTION-VECTOR per block (seeded, time-drifting) — "P-frame
  // applied to the wrong reference": each block samples the reference at a displaced UV.
  float mvx = (bendHash(blockId + vec2(seedOff, uTime * 0.07)) - 0.5) * 2.0;
  float mvy = (bendHash(blockId + vec2(seedOff + 7.3, uTime * 0.05 + 2.1)) - 0.5) * 2.0;
  vec2 mv = vec2(mvx, mvy) * ${mvect};
  // (2) TRANSFERRED MOTION from clip B: estimate B's per-block normal flow (the
  // motion that explains B's frame-to-frame luma change) at the block CENTRE and
  // carry it onto A. Block-centred so the transferred vector is per-macroblock
  // constant (a real codec MV), not per-pixel. When the 2nd input is unpatched the
  // 1x1 black fallback makes every gradient 0 → flow 0 → no contribution.
  vec2 bcUv = (blockId + 0.5) * blk / res;
  float lumaB  = moshLuma(${b}, bcUv);
  float lumaBp = moshLuma(${bprev}, bcUv);
  float It = lumaB - lumaBp; // temporal gradient (B now vs B last frame)
  vec2 d = 2.0 / res; // ~2-texel central-difference step for the spatial gradient
  float Ix = moshLuma(${b}, bcUv + vec2(d.x, 0.0)) - moshLuma(${b}, bcUv - vec2(d.x, 0.0));
  float Iy = moshLuma(${b}, bcUv + vec2(0.0, d.y)) - moshLuma(${b}, bcUv - vec2(0.0, d.y));
  float g2 = Ix * Ix + Iy * Iy + 1e-4;
  vec2 flow = clamp(-It * vec2(Ix, Iy) / g2, -1.0, 1.0); // normal flow toward B's motion
  mv += flow * ${mvectB};
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
