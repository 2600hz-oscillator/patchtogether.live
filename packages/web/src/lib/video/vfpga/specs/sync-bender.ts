// packages/web/src/lib/video/vfpga/specs/sync-bender.ts
//
// sync-bender — COMPOSITE/ANALOG-era bent VFPGA (design §3.1). Corrupts the
// NTSC/PAL composite (CVBS) HORIZONTAL + VERTICAL SYNC separator: the classic
// rolling / tearing / torn-frame / line-slip TV bend. One video in → one video
// out; the bend is injected at the sync-recovery stage by a single `clb:syncBend`
// tile whose four knobs are the four bends (all DETERMINISTIC, frame+uv+seed
// hashed → VRT-safe; a reseed gate re-rolls the tear pattern).
//
// FABRIC: IIN1 → syncBend → OUT1. Minimal one-compute-tile fabric (the bend is a
// pure per-pixel UV remap, so it needs no register/feedback). p1..p4 drive the
// four bend amounts; CIN1 adds onto the V-roll rate (LFO/CV roll speed); GIN1 is a
// TRIGGER that re-rolls the seed (a one-shot tear burst — declared edge:'trigger'
// upstream via the host's gate edge-detect; here it advances uSeed's count).

import type { VfpgaSpec } from '$lib/video/vfpga/types';

export const syncBenderSpec: VfpgaSpec = {
  id: 'sync-bender',
  name: 'sync-bender',
  doc:
    'A composite-era circuit-bent VFPGA that corrupts the NTSC/PAL CVBS ' +
    'horizontal + vertical sync separator — the classic rolling, tearing, ' +
    'torn-frame and line-slip TV bend. H-phase jitter slips each scanline ' +
    'sideways, V-roll scrolls the picture (lost vertical lock), sync-crush shears ' +
    'the frame above a moving break line, and a tear-probability rips unlucky ' +
    'lines. Every "random" bend is deterministic (frame + pixel + seed hashed) so ' +
    'it is reproducible; a reseed gate (GIN1) advances the seed for a one-shot ' +
    'tear burst, and a CV (CIN1) adds onto the roll speed.',
  docSlug: 'sync-bender',
  videoIn: 1,
  videoOut: 1,
  cvRoles: [
    { slot: 1, label: 'ROLL', uniform: 'uVRoll', doc: 'Adds onto the V-roll rate — patch an LFO to scroll the picture (roll speed CV).' },
  ],
  gateRoles: [
    { slot: 1, label: 'TEAR', countUniform: 'uSeed', doc: 'A TRIGGER: each rising edge re-rolls the seed → a one-shot tear burst.' },
  ],
  params: [
    { slot: 1, label: 'h-jit', uniform: 'uHJitter', min: 0, max: 0.2, defaultValue: 0.03, curve: 'linear', doc: 'Per-line horizontal phase jitter (line slip).' },
    { slot: 2, label: 'v-roll', uniform: 'uVRoll', min: 0, max: 1, defaultValue: 0.05, curve: 'linear', doc: 'Vertical roll rate (lost V-sync → the picture scrolls).' },
    { slot: 3, label: 'crush', uniform: 'uSyncCrush', min: 0, max: 1, defaultValue: 0.2, curve: 'linear', doc: 'Sync-tip crush → torn-frame shear above a moving break line.' },
    { slot: 4, label: 'tear', uniform: 'uTearProb', min: 0, max: 1, defaultValue: 0.1, curve: 'linear', doc: 'Per-line probability of a hard horizontal rip.' },
  ],
  fabric: {
    grid: { rows: 1, cols: 1 },
    tiles: [
      {
        id: 'sync',
        type: 'clb',
        config: {
          op: 'syncBend',
          bind: [
            { knob: 'hjit', to: 'p', slot: 1, uniform: 'uHJitter' },
            { knob: 'vroll', to: 'p', slot: 2, uniform: 'uVRoll' },
            { knob: 'crush', to: 'p', slot: 3, uniform: 'uSyncCrush' },
            { knob: 'tear', to: 'p', slot: 4, uniform: 'uTearProb' },
            { knob: 'seed', to: 'gate', slot: 1, uniform: 'uSeed' },
          ],
        },
        pos: { row: 0, col: 0 },
        inputs: ['a'],
      },
      { id: 'o1', type: 'iob_out', config: { op: 'OUT1' } },
    ],
    nets: [
      { from: 'IIN1', to: 'sync:a' },
      { from: 'sync', to: 'OUT1' },
    ],
    outputs: { vout1: 'o1' },
    budget: { passes: 1 },
  },
};
