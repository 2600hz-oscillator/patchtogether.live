// packages/web/src/lib/video/vfpga/specs/chroma-rot.ts
//
// chroma-rot — COMPOSITE/ANALOG-era bent VFPGA (design §3.2). Corrupts the
// composite COLOUR subsystem: the chroma demodulator / colour-burst phase —
// rainbowing, hue rotation, oversaturation bleed, and dot-crawl amplification.
// One video in → one video out; a single `clb:chromaRot` tile does the YIQ
// round-trip + chroma mis-phasing.
//
// FABRIC: IIN1 → chromaRot → OUT1. p1..p4 drive burst-phase / chroma-gain /
// I-Q-mix / dot-crawl; CIN1 adds a continuous hue spin onto the burst phase;
// GIN1 is a HELD gate that toggles the I/Q swap (declared edge:'gate' — it acts
// while held, reacting to both edges, NOT a one-shot trigger).

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
    'shimmers chroma per scanline (comb-filter defeat). CIN1 adds a continuous hue ' +
    'spin onto the burst phase; GIN1 is a HELD gate that toggles the I/Q swap.',
  docSlug: 'chroma-rot',
  videoIn: 1,
  videoOut: 1,
  cvRoles: [
    { slot: 1, label: 'SPIN', uniform: 'uBurstPhase', doc: 'Adds a continuous hue spin onto the burst phase (patch an LFO/ramp).' },
  ],
  gateRoles: [
    { slot: 1, label: 'I/Q', heldUniform: 'uIqMix', doc: 'A HELD gate: while high, the I/Q chroma axes are swapped.' },
  ],
  params: [
    { slot: 1, label: 'phase', uniform: 'uBurstPhase', min: 0, max: 1, defaultValue: 0.15, curve: 'linear', doc: 'Burst-phase offset → rotates chroma (global hue spin, 0..1 wheel).' },
    { slot: 2, label: 'gain', uniform: 'uChromaGain', min: 0, max: 3, defaultValue: 1.6, curve: 'linear', doc: 'Chroma amplitude (>1 = oversaturation bleed overdrive).' },
    { slot: 3, label: 'i/q-mix', uniform: 'uIqMix', min: 0, max: 1, defaultValue: 0, curve: 'linear', doc: 'Static I/Q swap amount (the GIN1 gate adds a held swap on top).' },
    { slot: 4, label: 'dot-crawl', uniform: 'uDotCrawl', min: 0, max: 1, defaultValue: 0.4, curve: 'linear', doc: 'Per-line/time chroma shimmer (comb-filter defeat).' },
  ],
  fabric: {
    grid: { rows: 1, cols: 1 },
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
          ],
        },
        pos: { row: 0, col: 0 },
        inputs: ['a'],
      },
      { id: 'o1', type: 'iob_out', config: { op: 'OUT1' } },
    ],
    nets: [
      { from: 'IIN1', to: 'chroma:a' },
      { from: 'chroma', to: 'OUT1' },
    ],
    outputs: { vout1: 'o1' },
    budget: { passes: 1 },
  },
};
