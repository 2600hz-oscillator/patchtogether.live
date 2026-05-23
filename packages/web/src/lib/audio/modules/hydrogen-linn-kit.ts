// packages/web/src/lib/audio/modules/hydrogen-linn-kit.ts
//
// LINN-STYLE synthesized drumkit. 16 voices. Inspired by the Linn
// LM-1 / LinnDrum sample-based machine that defined 80s pop — bright
// crisp snare, fat punchy kick, electronic toms, hand claps with
// long-tail reverb feel. The originals were 8-bit samples; here we
// synthesise the same vibe with sine sweeps, FM, and noise.

import { type KitDef, type KitInstrument } from './hydrogen-kit-types';
import {
  sineSweepVoice,
  snareVoice,
  noiseBurstVoice,
  clapVoice,
  fmVoice,
  cowbellVoice,
} from './hydrogen-kit-synth-utils';

const HAT_GROUP = 1;

const INSTRUMENTS: readonly KitInstrument[] = [
  // 0 — fat punchy kick (LinnDrum kick is shorter+ snappier than 808)
  {
    kind: 'synth', id: 0, label: 'KICK', name: 'Linn Kick',
    defaultGain: 1.1, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 120, endHz: 45, sweepS: 0.04, tailS: 0.32 }),
  },
  // 1 — pitched kick
  {
    kind: 'synth', id: 1, label: 'KIK2', name: 'Pitched Kick',
    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 160, endHz: 60, sweepS: 0.03, tailS: 0.28 }),
  },
  // 2 — bright snare (the classic Linn snare has a sharp transient + medium tail)
  {
    kind: 'synth', id: 2, label: 'SNAR', name: 'Linn Snare',
    defaultGain: 0.95, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      snareVoice(ctx, dest, atTime, opts, { bodyHz: 230, bodyS: 0.04, noiseHighHz: 2800, noiseS: 0.22, noiseGain: 0.75 }),
  },
  // 3 — sidestick
  {
    kind: 'synth', id: 3, label: 'STIK', name: 'Sidestick',
    defaultGain: 0.75, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 1300, modRatio: 1.7, modIndex: 800, tailS: 0.06 }),
  },
  // 4 — clap (a Linn signature — multiple bursts with long tail)
  {
    kind: 'synth', id: 4, label: 'CLAP', name: 'Linn Clap',
    defaultGain: 0.85, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      clapVoice(ctx, dest, atTime, opts, { burstHz: 1200, burstS: 0.014, tailS: 0.28 }),
  },
  // 5 — closed hat (Linn hats are airy + crisp)
  {
    kind: 'synth', id: 5, label: 'HHc', name: 'Hat Closed',
    defaultGain: 0.65, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 7500, tailS: 0.045, q: 0.4, gain: 0.5 }),
  },
  // 6 — open hat (longer, splashier)
  {
    kind: 'synth', id: 6, label: 'HHo', name: 'Hat Open',
    defaultGain: 0.7, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 6500, tailS: 0.5, q: 0.35, gain: 0.5 }),
  },
  // 7 — pedal hat (short pedal-foot close)
  {
    kind: 'synth', id: 7, label: 'HHp', name: 'Hat Pedal',
    defaultGain: 0.55, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 5500, tailS: 0.065, q: 0.5, gain: 0.4 }),
  },
  // 8 — tom hi (Linn toms are pitched + tight)
  {
    kind: 'synth', id: 8, label: 'TomH', name: 'Tom Hi',
    defaultGain: 0.85, defaultPan: 0.4, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 280, endHz: 180, sweepS: 0.06, tailS: 0.32 }),
  },
  // 9 — tom mid
  {
    kind: 'synth', id: 9, label: 'TomM', name: 'Tom Mid',
    defaultGain: 0.85, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 200, endHz: 130, sweepS: 0.08, tailS: 0.4 }),
  },
  // 10 — tom low
  {
    kind: 'synth', id: 10, label: 'TomL', name: 'Tom Low',
    defaultGain: 0.9, defaultPan: -0.4, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 130, endHz: 75, sweepS: 0.1, tailS: 0.45 }),
  },
  // 11 — conga hi
  {
    kind: 'synth', id: 11, label: 'CONG', name: 'Conga Hi',
    defaultGain: 0.75, defaultPan: 0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 240, endHz: 160, sweepS: 0.07, tailS: 0.28 }),
  },
  // 12 — conga low
  {
    kind: 'synth', id: 12, label: 'CONG2', name: 'Conga Lo',
    defaultGain: 0.8, defaultPan: -0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 170, endHz: 115, sweepS: 0.09, tailS: 0.32 }),
  },
  // 13 — cabasa (signature Linn perc)
  {
    kind: 'synth', id: 13, label: 'CBSA', name: 'Cabasa',
    defaultGain: 0.55, defaultPan: 0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 6800, tailS: 0.06, q: 0.6, gain: 0.45 }),
  },
  // 14 — tambourine
  {
    kind: 'synth', id: 14, label: 'TAMB', name: 'Tambourine',
    defaultGain: 0.65, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 5800, tailS: 0.2, q: 0.6, gain: 0.4 }),
  },
  // 15 — cowbell (Linn's cowbell is bright)
  {
    kind: 'synth', id: 15, label: 'CWBL', name: 'Cowbell',
    defaultGain: 0.7, defaultPan: 0.25, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      cowbellVoice(ctx, dest, atTime, opts, { topHz: 920, bottomHz: 620, tailS: 0.32 }),
  },
];

export const LINN_KIT: KitDef = {
  id: 'linn',
  name: 'LINN',
  attribution: 'Synthesized LinnDrum-style drums — original-design, no samples',
  instruments: INSTRUMENTS,
};
