// packages/web/src/lib/audio/modules/hydrogen-cr78-kit.ts
//
// CR-78-STYLE synthesized drumkit. 16 voices, fully synthesized.
// Inspired by the Roland CR-78 "Compu-Rhythm" — light, bossa-nova /
// jazz-flavoured presets with brushy hats, soft kicks, and bongo /
// guiro / cabasa percussion. Notably gentler than the TR-808/909
// catalogue: smaller transients, softer noise, more harmonic
// content from sine sweeps + filtered noise.

import { type KitDef, type KitInstrument } from './hydrogen-kit-types';
import {
  sineSweepVoice,
  snareVoice,
  noiseBurstVoice,
  clapVoice,
  cowbellVoice,
} from './hydrogen-kit-synth-utils';

const HAT_GROUP = 1;

const INSTRUMENTS: readonly KitInstrument[] = [
  // 0 — soft bossa kick (longer, lower fundamental than 808)
  {
    kind: 'synth', id: 0, label: 'KICK', name: 'Bossa Kick',
    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 90, endHz: 40, sweepS: 0.09, tailS: 0.6 }),
  },
  // 1 — softer kick variant
  {
    kind: 'synth', id: 1, label: 'KIK2', name: 'Soft Kick',
    defaultGain: 0.85, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 75, endHz: 35, sweepS: 0.12, tailS: 0.55 }),
  },
  // 2 — rim-snare (CR-78 snare is closer to a rimshot than a drum)
  {
    kind: 'synth', id: 2, label: 'SNAR', name: 'Snare',
    defaultGain: 0.85, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      snareVoice(ctx, dest, atTime, opts, { bodyHz: 180, bodyS: 0.05, noiseHighHz: 1400, noiseS: 0.12, noiseGain: 0.4 }),
  },
  // 3 — rimshot proper (very short woodblock-like click)
  {
    kind: 'synth', id: 3, label: 'RIM', name: 'Rimshot',
    defaultGain: 0.8, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 1500, endHz: 800, sweepS: 0.008, tailS: 0.05 }),
  },
  // 4 — clap (lighter than 808/909)
  {
    kind: 'synth', id: 4, label: 'CLAP', name: 'Hand Clap',
    defaultGain: 0.7, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      clapVoice(ctx, dest, atTime, opts, { burstHz: 1000, burstS: 0.012, tailS: 0.14 }),
  },
  // 5 — closed brushed hat
  {
    kind: 'synth', id: 5, label: 'HHc', name: 'Hat Closed',
    defaultGain: 0.55, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 5500, tailS: 0.05, q: 0.3, gain: 0.35 }),
  },
  // 6 — open brushed hat
  {
    kind: 'synth', id: 6, label: 'HHo', name: 'Hat Open',
    defaultGain: 0.6, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 4500, tailS: 0.6, q: 0.25, gain: 0.3 }),
  },
  // 7 — cabasa (high-freq noise, very short)
  {
    kind: 'synth', id: 7, label: 'CBSA', name: 'Cabasa',
    defaultGain: 0.55, defaultPan: 0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 7000, tailS: 0.04, q: 0.7, gain: 0.4 }),
  },
  // 8 — bongo high
  {
    kind: 'synth', id: 8, label: 'BNGH', name: 'Bongo Hi',
    defaultGain: 0.8, defaultPan: 0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 320, endHz: 220, sweepS: 0.05, tailS: 0.2 }),
  },
  // 9 — bongo low
  {
    kind: 'synth', id: 9, label: 'BNGL', name: 'Bongo Lo',
    defaultGain: 0.8, defaultPan: -0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 220, endHz: 150, sweepS: 0.06, tailS: 0.22 }),
  },
  // 10 — conga (medium-low resonant body)
  {
    kind: 'synth', id: 10, label: 'CONG', name: 'Conga',
    defaultGain: 0.85, defaultPan: 0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 180, endHz: 110, sweepS: 0.08, tailS: 0.3 }),
  },
  // 11 — guiro (rasp-style scratch; noise burst with pitched sweep)
  {
    kind: 'synth', id: 11, label: 'GURO', name: 'Guiro',
    defaultGain: 0.7, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 2200, tailS: 0.18, q: 1.5, gain: 0.45 }),
  },
  // 12 — tambourine (medium-high filtered noise)
  {
    kind: 'synth', id: 12, label: 'TAMB', name: 'Tambourine',
    defaultGain: 0.65, defaultPan: 0.1, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 6000, tailS: 0.18, q: 0.6, gain: 0.4 }),
  },
  // 13 — maraca (similar but shorter + slightly higher)
  {
    kind: 'synth', id: 13, label: 'MARA', name: 'Maraca',
    defaultGain: 0.5, defaultPan: -0.15, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 6500, tailS: 0.08, q: 0.5, gain: 0.4 }),
  },
  // 14 — metallic cymbal (filtered noise; brassy)
  {
    kind: 'synth', id: 14, label: 'CYMB', name: 'Cymbal',
    defaultGain: 0.6, defaultPan: 0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 3500, tailS: 1.0, q: 0.3, gain: 0.35 }),
  },
  // 15 — cowbell (CR-78 cowbell is mellower than 808 — single square)
  {
    kind: 'synth', id: 15, label: 'CWBL', name: 'Cowbell',
    defaultGain: 0.7, defaultPan: 0.25, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      cowbellVoice(ctx, dest, atTime, opts, { topHz: 750, bottomHz: 500, tailS: 0.3 }),
  },
];

export const CR78_KIT: KitDef = {
  id: 'cr78',
  name: 'CR-78',
  attribution: 'Synthesized CR-78-style drums — original-design, no samples',
  instruments: INSTRUMENTS,
};
