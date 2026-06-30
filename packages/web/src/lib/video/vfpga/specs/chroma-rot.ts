// packages/web/src/lib/video/vfpga/specs/chroma-rot.ts
//
// chroma-rot — COMPOSITE/ANALOG-era bent VFPGA (design §3.2), the Y/C TRANSPLANT
// flagship (design research 2026-06-30 §4). Corrupts the composite COLOUR
// subsystem: the chroma demodulator / colour-burst phase — rainbowing, hue
// rotation, oversaturation bleed, and dot-crawl amplification.
//
// MULTI-IO (vfpga two-input + two-output): composite separates luma (Y) from chroma
// (C), so this bend is the catalog's S-VIDEO Y/C splitter:
//   - IIN1 = the LUMA source (the picture's brightness — and its own chroma by
//     default). IIN2 = the CHROMA source (`srcB`). The `chromaRot` cell takes Y from
//     IIN1 and blends IIN2's chroma onto it (p5 `cxfer`) — a colour transplant
//     impossible single-source (clip A's shapes wearing clip B's colours). cxfer=0
//     (or IIN2 unpatched) = the original single-source bend, byte-for-byte.
//   - vout1 = the chroma-corrupted composite. vout2 = the separated LUMA (Y) plane
//     (the brightness the chroma rides on) — an S-video Y tap to scope, key, or
//     recombine downstream.
//
// FABRIC: IIN1 → chromaRot(+IIN2 chroma) → OUT1 ; IIN1 → luma → OUT2. p1..p4 drive
// burst-phase / chroma-gain / I-Q-mix / dot-crawl; p5 the Y/C transplant; CIN1 adds
// a continuous hue spin onto the burst phase; CIN2 adds onto the transplant; GIN1 is
// a HELD gate that toggles the I/Q swap (edge:'gate' — acts while held).

import type { VfpgaSpec } from '$lib/video/vfpga/types';

export const chromaRotSpec: VfpgaSpec = {
  id: 'chroma-rot',
  name: 'chroma-rot',
  doc:
    'A composite-era circuit-bent VFPGA that corrupts the colour subsystem — the ' +
    'chroma demodulator and colour-burst phase. It separates the picture into ' +
    'luma + a YIQ chroma vector then mis-phases the chroma: a burst-phase offset ' +
    'spins the hue globally (rainbowing), a chroma-gain overdrive bleeds ' +
    'oversaturation, an I/Q swap mangles the colour axes, and a dot-crawl term ' +
    'shimmers chroma per scanline (comb-filter defeat). Because composite splits Y ' +
    'from C, it doubles as an S-video Y/C tool: patch a CHROMA SOURCE to IIN2 and ' +
    'p5 (cxfer) transplants that clip’s colours onto IIN1’s luma (clip A’s shapes ' +
    'in clip B’s colours) — cxfer=0 or an unpatched IIN2 leaves the original ' +
    'single-source bend untouched. vout2 outputs the separated luma (Y) plane. CIN1 ' +
    'adds a continuous hue spin onto the burst phase; CIN2 adds onto the transplant; ' +
    'GIN1 is a HELD gate that toggles the I/Q swap.',
  docSlug: 'chroma-rot',
  videoIn: 2,
  videoOut: 2,
  cvRoles: [
    { slot: 1, label: 'SPIN', uniform: 'uBurstPhase', doc: 'Adds a continuous hue spin onto the burst phase (patch an LFO/ramp).' },
    { slot: 2, label: 'CXFER', uniform: 'uCRotXfer', doc: 'Adds onto the Y/C transplant amount (modulate how much of IIN2’s chroma lands on the luma).' },
  ],
  gateRoles: [
    { slot: 1, label: 'I/Q', heldUniform: 'uIqMix', doc: 'A HELD gate: while high, the I/Q chroma axes are swapped.' },
  ],
  params: [
    { slot: 1, label: 'phase', uniform: 'uBurstPhase', min: 0, max: 1, defaultValue: 0.15, curve: 'linear', doc: 'Burst-phase offset → rotates chroma (global hue spin, 0..1 wheel).' },
    { slot: 2, label: 'gain', uniform: 'uChromaGain', min: 0, max: 3, defaultValue: 1.6, curve: 'linear', doc: 'Chroma amplitude (>1 = oversaturation bleed overdrive).' },
    { slot: 3, label: 'i/q-mix', uniform: 'uIqMix', min: 0, max: 1, defaultValue: 0, curve: 'linear', doc: 'Static I/Q swap amount (the GIN1 gate adds a held swap on top).' },
    { slot: 4, label: 'dot-crawl', uniform: 'uDotCrawl', min: 0, max: 1, defaultValue: 0.4, curve: 'linear', doc: 'Per-line/time chroma shimmer (comb-filter defeat).' },
    { slot: 5, label: 'cxfer', uniform: 'uCRotXfer', min: 0, max: 1, defaultValue: 0, curve: 'linear', doc: 'Y/C transplant — blend IIN2’s chroma onto IIN1’s luma (0 = own chroma).' },
  ],
  fabric: {
    // chroma@0 (the bend, vout1) + yluma@1 (the Y-plane tap, vout2). cols:2.
    grid: { rows: 1, cols: 2 },
    tiles: [
      {
        id: 'chroma',
        type: 'clb',
        config: {
          op: 'chromaRot',
          bind: [
            { knob: 'phase', to: 'p', slot: 1, uniform: 'uBurstPhase' },
            { knob: 'gain', to: 'p', slot: 2, uniform: 'uChromaGain' },
            { knob: 'iqmix', to: 'p', slot: 3, uniform: 'uIqMix' },
            { knob: 'crawl', to: 'p', slot: 4, uniform: 'uDotCrawl' },
            { knob: 'cxfer', to: 'p', slot: 5, uniform: 'uCRotXfer' },
          ],
        },
        pos: { row: 0, col: 0 },
        inputs: ['a', 'b'],
      },
      // The Y (luma) plane of IIN1 — the S-video Y tap driving vout2. Its only
      // consumer is OUT2, so P&R gives it the vout2 FBO directly (no passthru).
      { id: 'yluma', type: 'clb', config: { op: 'luma' }, pos: { row: 0, col: 1 }, inputs: ['a'] },
      { id: 'o1', type: 'iob_out', config: { op: 'OUT1' } },
      { id: 'o2', type: 'iob_out', config: { op: 'OUT2' } },
    ],
    nets: [
      { from: 'IIN1', to: 'chroma:a' }, // luma + default chroma
      { from: 'IIN2', to: 'chroma:b' }, // transplant chroma source
      { from: 'chroma', to: 'OUT1' }, // the chroma-corrupted composite (vout1)
      { from: 'IIN1', to: 'yluma:a' }, // the luma plane
      { from: 'yluma', to: 'OUT2' }, // the separated Y plane (vout2)
    ],
    outputs: { vout1: 'o1', vout2: 'o2' },
    budget: { passes: 2 },
  },
};
