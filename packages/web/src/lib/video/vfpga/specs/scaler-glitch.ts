// packages/web/src/lib/video/vfpga/specs/scaler-glitch.ts
//
// scaler-glitch — EARLY-HD-era bent VFPGA (design §3.7). Bends the early-HD
// upscaler / line-doubler / deinterlacer of a cheap SD→HD set-top box: comb/weave
// deinterlace zipper edges, broken bilinear tap weights (nearest-neighbour
// blockiness), a wrong scale/pixel-aspect ratio, and line-buffer-overrun "stuck
// row" smears. THE BRAM LINE-BUFFER TILE IS THE STAR — the authentic FPGA video
// staple (a scaler reads a window of PRIOR scanlines out of an on-chip line
// buffer), bent by addressing those prior rows WRONG.
//
// FABRIC: IIN1 → linebuf(bram) → OUT1. A single BRAM line-buffer tile whose
// `config.rows` declares the buffer depth (the authentic resource the fabric
// budget counts). p1..p4 drive the four bends; CIN1 adds onto the scale ratio;
// GIN1 is a TRIGGER that flips the field parity (advances the seed → a new field
// mismatch). Every "random" term is deterministic (row + seed hashed), VRT-safe,
// and CI-SwiftShader tolerant (spatial / integer-row domain, no precision asserts).

import type { VfpgaSpec } from '$lib/video/vfpga/types';

export const scalerGlitchSpec: VfpgaSpec = {
  id: 'scaler-glitch',
  name: 'scaler-glitch',
  doc:
    'An early-HD circuit-bent VFPGA that corrupts the upscaler / line-doubler / ' +
    'deinterlacer of a cheap SD→HD set-top box. The star is a BRAM line buffer — ' +
    'the authentic FPGA video staple: a scaler reads a window of prior scanlines ' +
    'out of an on-chip line buffer and resamples them to the output raster. Bending ' +
    'it = addressing those rows wrong: a deinterlace error gives comb/weave zipper ' +
    'edges on alternating lines (field mismatch), corrupt bilinear tap weights snap ' +
    'to nearest-neighbour blockiness, a wrong scale ratio stretches the picture, ' +
    'and a line-buffer overrun re-reads a stale row as a stuck-row horizontal smear. ' +
    'p1 sets the deinterlace error (weave↔bob zipper), p2 the scale ratio, p3 the ' +
    'tap-weight corruption, p4 the stuck-row density. CIN1 adds onto the scale ' +
    'ratio; GIN1 flips the field parity (a fresh field mismatch). Every "random" ' +
    'term is deterministic (row + seed hashed) so the bend is reproducible.',
  docSlug: 'scaler-glitch',
  videoIn: 1,
  videoOut: 1,
  cvRoles: [
    { slot: 1, label: 'SCALE', uniform: 'uScaleRatio', doc: 'Adds onto the scale ratio (patch an LFO to breathe the stretch).' },
  ],
  gateRoles: [
    { slot: 1, label: 'FIELD', countUniform: 'uSeed', doc: 'A TRIGGER: each rising edge flips the field parity → a fresh field mismatch.' },
  ],
  params: [
    { slot: 1, label: 'deint', uniform: 'uScaleDeint', min: 0, max: 1, defaultValue: 0.5, curve: 'linear', doc: 'Deinterlace error: 0 weave (zipper on motion) ↔ 1 bob (line-double a field).' },
    { slot: 2, label: 'scale', uniform: 'uScaleRatio', min: 0.5, max: 2, defaultValue: 1.3, curve: 'linear', doc: 'Vertical scale-ratio error (wrong pixel/aspect-ratio stretch).' },
    { slot: 3, label: 'tap', uniform: 'uScaleTap', min: 0, max: 1, defaultValue: 0.6, curve: 'linear', doc: 'Bilinear tap-weight corruption: 0 correct ↔ 1 nearest/broken weights.' },
    { slot: 4, label: 'stuck', uniform: 'uScaleStuck', min: 0, max: 1, defaultValue: 0.25, curve: 'linear', doc: 'Per-row line-buffer-overrun probability (a stuck-row horizontal smear).' },
  ],
  fabric: {
    grid: { rows: 1, cols: 1 },
    tiles: [
      // The BRAM LINE BUFFER: an 8-deep on-chip line buffer the bent scaler reads
      // prior scanlines out of. rows=8 counts against the bramRows budget. p1..p4
      // drive the deinterlace/scale/tap/stuck bends; CIN1 adds onto scale; GIN1's
      // edge count flips the field parity (the seed).
      {
        id: 'scaler',
        type: 'bram',
        config: {
          op: 'linebuf',
          rows: 8,
          bind: [
            { knob: 'deint', to: 'p', slot: 1, uniform: 'uScaleDeint' },
            { knob: 'scale', to: 'p', slot: 2, uniform: 'uScaleRatio' },
            { knob: 'tap', to: 'p', slot: 3, uniform: 'uScaleTap' },
            { knob: 'stuck', to: 'p', slot: 4, uniform: 'uScaleStuck' },
            { knob: 'seed', to: 'gate', slot: 1, uniform: 'uSeed' },
          ],
        },
        pos: { row: 0, col: 0 },
        inputs: ['a'],
      },
      { id: 'o1', type: 'iob_out', config: { op: 'OUT1' } },
    ],
    nets: [
      { from: 'IIN1', to: 'scaler:a' },
      { from: 'scaler', to: 'OUT1' },
    ],
    outputs: { vout1: 'o1' },
    budget: { passes: 1, bramRows: 8 },
  },
};
