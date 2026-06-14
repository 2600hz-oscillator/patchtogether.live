// packages/web/src/lib/video/vfpga/cells/linebuf.ts
//
// BRAM cell `linebuf(a, deint, scale, tap, stuck, seed)` — early-HD scaler /
// deinterlacer corruption (the scaler-glitch bend, design §3.7). The BRAM
// LINE-BUFFER tile is the star: a cheap set-top-box scaler chip / deinterlacer
// reads a small window of PRIOR scanlines out of an on-chip line buffer (the FPGA
// video staple) and resamples them to the output raster. Bending it = addressing
// those prior rows WRONG: comb/weave deinterlace zipper edges, broken bilinear tap
// weights, a wrong scale ratio, and line-buffer-overrun "stuck row" smears.
//
// The line buffer's DEPTH is the tile's BRAM `config.rows` (the authentic resource
// the budget counts); the kernel reads up to that many neighbouring scanlines via
// uResolution-derived texel steps. ONE input (a), four knobs + the shared seed.
//
//   deint  deinterlace mode/error: 0 = weave (full-res, zipper on motion),
//          1 = bob (line-double a single field) — between = a broken blend → the
//          field-mismatch zipper artifact on alternating lines.
//   scale  vertical scale-ratio error (the wrong pixel/aspect ratio stretch).
//   tap    bilinear TAP-WEIGHT corruption: 0 = correct bilinear, →1 = nearest-
//          neighbour blockiness vs broken weights (the cheap-scaler look).
//   stuck  per-row probability the line buffer OVERRUNS and re-reads a stale row
//          (a "stuck row" horizontal smear).
//   seed   re-rollable corruption seed; a field-parity-flip gate advances it.
//
// All "random" terms are DETERMINISTIC (row + seed hashed, VRT-safe). Spatial,
// integer-row-domain → CI-SwiftShader tolerant (no float-precision asserts).

import { type VfpgaCell } from './types';
import { BEND_SEED_GLSL, BEND_SEED_UNIFORM } from './bend-seed';

export const linebufCell: VfpgaCell = {
  type: 'bram',
  op: 'linebuf',
  inputs: ['a'],
  knobs: [
    { name: 'deint', uniform: 'uScaleDeint', defaultValue: 0.0, label: 'DEINT', doc: 'Deinterlace mode/error: 0 weave (zipper on motion) ↔ 1 bob (line-double a field).' },
    { name: 'scale', uniform: 'uScaleRatio', defaultValue: 1.0, label: 'SCALE', doc: 'Vertical scale-ratio error (wrong pixel/aspect-ratio stretch).' },
    { name: 'tap', uniform: 'uScaleTap', defaultValue: 0.0, label: 'TAP', doc: 'Bilinear tap-weight corruption: 0 correct ↔ 1 nearest/broken weights.' },
    { name: 'stuck', uniform: 'uScaleStuck', defaultValue: 0.0, label: 'STUCK', doc: 'Per-row line-buffer-overrun probability (a stuck-row horizontal smear).' },
    { name: 'seed', uniform: BEND_SEED_UNIFORM, defaultValue: 0, label: 'SEED', doc: 'Re-rollable corruption seed (a field-parity-flip gate advances it).' },
  ],
  doc: 'Early-HD line-buffer scaler/deinterlacer corruption: weave/bob zipper / broken taps / scale error / stuck rows (scaler-glitch).',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const deint = uniformFor('deint');
    const scale = uniformFor('scale');
    const tap = uniformFor('tap');
    const stuck = uniformFor('stuck');
    const seed = uniformFor('seed');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform vec2 uResolution;
uniform float uTime;
uniform float ${deint};
uniform float ${scale};
uniform float ${tap};
uniform float ${stuck};
uniform float ${seed};
${BEND_SEED_GLSL}
void main() {
  float seedOff = ${seed} * 0.023;
  vec2 res = max(uResolution, vec2(1.0));
  float texel = 1.0 / res.y;
  // SCALE-RATIO error: resample the vertical axis about centre by the wrong ratio.
  float s = abs(${scale}) < 1.0e-4 ? 1.0e-4 : ${scale};
  float ySrc = (vUv.y - 0.5) / s + 0.5;
  // The scaler reads PRIOR scanlines out of the line buffer: the two bracketing
  // rows + a bilinear weight between them (the line-buffer tap).
  float rowF = ySrc * res.y - 0.5;
  float row0 = floor(rowF);
  float frac = rowF - row0;
  // STUCK ROW: a line-buffer overrun re-reads a stale (V-offset) row for the whole
  // scanline AND drifts the H read pointer (the buffer's read address corrupts both
  // axes), so a stuck row visibly TEARS sideways even on vertically-uniform content.
  float outRow = floor(vUv.y * res.y);
  float ro = bendHash(vec2(outRow, seedOff + 4.2));
  float stuck = ro < ${stuck} ? 1.0 : 0.0;
  float stuckOff = stuck * floor(bendHash(vec2(outRow, seedOff + 8.8)) * 12.0);
  float stuckX = stuck * (bendHash(vec2(outRow, seedOff + 12.4)) - 0.5) * 0.25;
  float xr = fract(vUv.x + stuckX);
  float y0 = (row0 + 0.5 + stuckOff) * texel;
  float y1 = (row0 + 1.5 + stuckOff) * texel;
  vec3 c0 = texture(${a}, vec2(xr, clamp(y0, 0.0, 1.0))).rgb;
  vec3 c1 = texture(${a}, vec2(xr, clamp(y1, 0.0, 1.0))).rgb;
  // BILINEAR TAP-WEIGHT corruption: bias the interp weight toward nearest (snap)
  // for the cheap-scaler blockiness.
  float w = mix(frac, step(0.5, frac), clamp(${tap}, 0.0, 1.0));
  vec3 scaled = mix(c0, c1, w);
  // DEINTERLACE: weave (full-res, the just-scaled rows) vs bob (line-double a
  // single field). Between, a broken blend → the field-mismatch ZIPPER on every
  // other line (the comb/weave artifact).
  float field = mod(outRow, 2.0); // 0/1 = the two interlaced fields
  vec3 bob = texture(${a}, vec2(xr, clamp((floor(ySrc * res.y * 0.5) * 2.0 + 0.5) * texel, 0.0, 1.0))).rgb;
  float d = clamp(${deint}, 0.0, 1.0);
  // zipper: on odd lines lean toward bob, on even toward weave (the comb tooth).
  float zip = d * field;
  vec3 col = mix(scaled, bob, max(d * 0.5, zip));
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
  },
};
