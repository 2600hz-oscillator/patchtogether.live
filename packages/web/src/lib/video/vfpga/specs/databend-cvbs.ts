// packages/web/src/lib/video/vfpga/specs/databend-cvbs.ts
//
// databend-cvbs — COMPOSITE-as-DATA bent VFPGA (design §3.4). Bends the composite
// signal the way databending corrupts a FILE: a real 4-input bitwise LUT (the
// literal FPGA LUT16 — the ratified authenticity anchor) mangles the picture's
// bit-planes into a bit-error field, then a datapath bend byte-shifts / sample-
// drops / level-wraps the picture, and the two are XOR-combined (an absolute-
// difference, the combinational XOR analogue). THE LITERAL LUT16 TILE EARNS ITS
// KEEP HERE — a genuine truth table wired into the video.
//
// FABRIC:
//   IIN1 → lut16(a=b=c=d=IIN1, init=XOR mask) ─┐
//   IIN1 → databend(shift/dropout/wrap) ───────┤ diff(databent, biterror) → OUT1
// this-frame deps: lut16(IIN1) ; databend(IIN1) ; diff(databend, lut16). Acyclic.
// p1 sweeps the LUT INIT truth table (the XOR mask); p2/p3/p4 drive the byte-
// shift / dropout / wrap; CIN1 adds onto the shift; GIN1 is a TRIGGER that re-rolls
// the corruption seed.

import type { VfpgaSpec } from '$lib/video/vfpga/types';

export const databendCvbsSpec: VfpgaSpec = {
  id: 'databend-cvbs',
  name: 'databend-cvbs',
  doc:
    'A composite-as-data circuit-bent VFPGA that databends the picture. A real ' +
    '4-input bitwise LUT (the literal FPGA LUT16 truth table) mangles the ' +
    "picture's luma bit-planes into a bit-error field, a datapath bend byte-shifts " +
    '/ sample-drops / level-wraps the picture, and the two are XOR-combined (an ' +
    'absolute difference). p1 sweeps the LUT truth table (the XOR mask), p2 the ' +
    'byte-shift, p3 the sample-hold dropout density, p4 the level wrap-around. ' +
    'CIN1 adds onto the shift; GIN1 re-rolls the corruption seed. Every "random" ' +
    'bend is deterministic (frame + pixel + seed hashed) so it is reproducible.',
  docSlug: 'databend-cvbs',
  videoIn: 1,
  videoOut: 1,
  cvRoles: [
    { slot: 1, label: 'SHIFT', uniform: 'uByteShift', doc: 'Adds onto the byte-shift offset (patch an LFO/ramp to scan the smear).' },
  ],
  gateRoles: [
    { slot: 1, label: 'RE-ROLL', countUniform: 'uSeed', doc: 'A TRIGGER: each rising edge re-rolls the corruption seed → a fresh databend.' },
  ],
  params: [
    { slot: 1, label: 'xor-mask', uniform: 'uLutInit', min: 0, max: 65535, defaultValue: 0x6996, curve: 'linear', doc: 'The 16-bit LUT truth table (the XOR mask 0x6996 = 4-input parity by default).' },
    { slot: 2, label: 'byte-shift', uniform: 'uByteShift', min: 0, max: 0.5, defaultValue: 0.04, curve: 'linear', doc: 'Horizontal sample (byte) shift — a smear offset.' },
    { slot: 3, label: 'dropout', uniform: 'uDropout', min: 0, max: 1, defaultValue: 0.15, curve: 'linear', doc: 'Per-column probability of a sample-hold dropout (frozen streaks).' },
    { slot: 4, label: 'wrap', uniform: 'uWrapLevel', min: 0, max: 1, defaultValue: 0.2, curve: 'linear', doc: 'Level wrap-around: scaled luma past 1.0 wraps mod 1 (overflow glitch).' },
  ],
  fabric: {
    grid: { rows: 1, cols: 3 },
    tiles: [
      // LUT16: a literal 4-input truth table over the picture luma bit (all four
      // inputs are IIN1) → a bit-error field. p1 sweeps the 16-bit INIT (the XOR
      // mask); a fixed mid-level threshold keys the input bit.
      {
        id: 'lut',
        type: 'lut16',
        config: {
          op: 'lut',
          consts: { level: 0.5 },
          bind: [{ knob: 'init', to: 'p', slot: 1, uniform: 'uLutInit' }],
        },
        pos: { row: 0, col: 0 },
        inputs: ['a', 'b', 'c', 'd'],
      },
      // DATABEND the picture (byte-shift / dropout / wrap). CIN1 adds onto shift;
      // GIN1's edge count re-rolls the seed.
      {
        id: 'bend',
        type: 'clb',
        config: {
          op: 'databend',
          bind: [
            { knob: 'shift', to: 'p', slot: 2, uniform: 'uByteShift' },
            { knob: 'dropout', to: 'p', slot: 3, uniform: 'uDropout' },
            { knob: 'wrap', to: 'p', slot: 4, uniform: 'uWrapLevel' },
            { knob: 'seed', to: 'gate', slot: 1, uniform: 'uSeed' },
          ],
        },
        pos: { row: 0, col: 1 },
        inputs: ['a'],
      },
      // XOR-combine the databent picture with the bit-error field (absolute diff =
      // the combinational XOR analogue).
      {
        id: 'xor',
        type: 'clb',
        config: { op: 'diff', consts: { gain: 1 } },
        pos: { row: 0, col: 2 },
        inputs: ['a', 'b'],
      },
      { id: 'o1', type: 'iob_out', config: { op: 'OUT1' } },
    ],
    nets: [
      { from: 'IIN1', to: 'lut:a' },
      { from: 'IIN1', to: 'lut:b' },
      { from: 'IIN1', to: 'lut:c' },
      { from: 'IIN1', to: 'lut:d' },
      { from: 'IIN1', to: 'bend:a' },
      { from: 'bend', to: 'xor:a' },
      { from: 'lut', to: 'xor:b' },
      { from: 'xor', to: 'OUT1' },
    ],
    outputs: { vout1: 'o1' },
    budget: { passes: 3 },
  },
};
