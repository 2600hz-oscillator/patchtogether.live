// packages/web/src/lib/video/vfpga/specs/tmds-sparkle.ts
//
// tmds-sparkle — EARLY-HD-era bent VFPGA (design §3.6). Bends the HDMI/DVI TMDS
// 8b/10b serial link: the shimmering "sparkle" / bit-error look of a marginal HDMI
// cable. THE SECOND LITERAL LUT16 SHOWCASE — a real 4-input bitwise truth table
// (the ratified authenticity anchor) wired over the picture's bit-planes IS the
// per-pixel TMDS bit-flip field; that bit-error field is XOR-combined (absolute
// difference, the combinational XOR analogue) onto a `tmdsbend` datapath that adds
// the link's spatial artifacts (DC-balance banding, char-boundary slip shear, and
// control-period sparkle leak).
//
// FABRIC:
//   IIN1 → lut16(a=b=c=d=IIN1, init=bit-flip mask) ─┐
//   IIN1 → tmdsbend(disparity/slip/leak) ───────────┤ diff(tmds, biterror) → OUT1
// this-frame deps: lut16(IIN1) ; tmdsbend(IIN1) ; diff(tmdsbend, lut16). Acyclic.
//
// CONTROLS: p1 bit-error rate (the control-period leak sparkle density), p2 the LUT
// truth table (the bit-flip mask), p3 disparity drift (banding), p4 char-slip shear.
// CIN1 adds onto the error rate; GIN1 is a TRIGGER that re-rolls the error seed
// (the cable-wiggle burst). Every "random" error is deterministic (frame + pixel +
// seed hashed), VRT-safe, and CI-SwiftShader tolerant (logic/integer domain).

import type { VfpgaSpec } from '$lib/video/vfpga/types';

export const tmdsSparkleSpec: VfpgaSpec = {
  id: 'tmds-sparkle',
  name: 'tmds-sparkle',
  doc:
    'An early-HD circuit-bent VFPGA that corrupts the HDMI/DVI TMDS digital link — ' +
    'the shimmering sparkle / bit-error look of a marginal HDMI cable. A real ' +
    '4-input bitwise LUT (the literal FPGA LUT16 truth table) wired over the ' +
    "picture's bit-planes is the per-pixel TMDS bit-flip field; that bit-error " +
    'field is XOR-combined onto a datapath that adds the rest of the bent-link ' +
    'artifacts — a DC-balance break drifts the running disparity into horizontal ' +
    'banding, a character-boundary slip shears each scanline sideways, and a ' +
    'control-period leak bleeds saturated sync-character speckle into the active ' +
    'video. p1 sets the bit-error rate (the sparkle density), p2 the LUT truth ' +
    'table (the flip mask), p3 the disparity drift, p4 the char-slip. CIN1 adds ' +
    'onto the error rate; GIN1 re-rolls the error seed (a cable-wiggle burst). ' +
    'Every "random" error is deterministic (frame + pixel + seed hashed) so the ' +
    'bend is reproducible.',
  docSlug: 'tmds-sparkle',
  videoIn: 1,
  videoOut: 1,
  cvRoles: [
    { slot: 1, label: 'RATE', uniform: 'uTmdsLeak', doc: 'Adds onto the bit-error rate (patch an LFO/envelope to pulse the sparkle).' },
  ],
  gateRoles: [
    { slot: 1, label: 'WIGGLE', countUniform: 'uSeed', doc: 'A TRIGGER: each rising edge re-rolls the error seed → a fresh cable-wiggle burst.' },
  ],
  params: [
    { slot: 1, label: 'rate', uniform: 'uTmdsLeak', min: 0, max: 1, defaultValue: 0.12, curve: 'linear', doc: 'Bit-error rate — the control-period sparkle density.' },
    { slot: 2, label: 'flip-mask', uniform: 'uLutInit', min: 0, max: 65535, defaultValue: 0x6996, curve: 'linear', doc: 'The 16-bit LUT truth table (the per-channel bit-flip mask; 0x6996 = 4-input parity).' },
    { slot: 3, label: 'disparity', uniform: 'uTmdsDisparity', min: 0, max: 1, defaultValue: 0.25, curve: 'linear', doc: 'DC-balance break → running-disparity drift → horizontal banding.' },
    { slot: 4, label: 'slip', uniform: 'uTmdsSlip', min: 0, max: 0.5, defaultValue: 0.06, curve: 'linear', doc: 'Char-boundary slip → per-line horizontal pixel shear.' },
  ],
  fabric: {
    grid: { rows: 1, cols: 3 },
    tiles: [
      // LUT16: a literal 4-input truth table over the picture luma bit (all four
      // inputs are IIN1) → the per-pixel TMDS bit-flip field. p2 sweeps the 16-bit
      // INIT (the flip mask); a fixed mid-level threshold keys the input bit.
      {
        id: 'lut',
        type: 'lut16',
        config: {
          op: 'lut',
          consts: { level: 0.5 },
          bind: [{ knob: 'init', to: 'p', slot: 2, uniform: 'uLutInit' }],
        },
        pos: { row: 0, col: 0 },
        inputs: ['a', 'b', 'c', 'd'],
      },
      // TMDS datapath bends: disparity banding / char-slip shear / control-period
      // leak (the sparkle). p1/CIN1 drive the leak rate; p3/p4 the banding/slip;
      // GIN1's edge count re-rolls the seed.
      {
        id: 'tmds',
        type: 'clb',
        config: {
          op: 'tmdsbend',
          bind: [
            { knob: 'leak', to: 'p', slot: 1, uniform: 'uTmdsLeak' },
            { knob: 'disparity', to: 'p', slot: 3, uniform: 'uTmdsDisparity' },
            { knob: 'slip', to: 'p', slot: 4, uniform: 'uTmdsSlip' },
            { knob: 'seed', to: 'gate', slot: 1, uniform: 'uSeed' },
          ],
        },
        pos: { row: 0, col: 1 },
        inputs: ['a'],
      },
      // XOR-combine the TMDS-bent picture with the LUT16 bit-error field (absolute
      // diff = the combinational XOR analogue — the bit-flips toggle the picture).
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
      { from: 'IIN1', to: 'tmds:a' },
      { from: 'tmds', to: 'xor:a' },
      { from: 'lut', to: 'xor:b' },
      { from: 'xor', to: 'OUT1' },
    ],
    outputs: { vout1: 'o1' },
    budget: { passes: 3 },
  },
};
