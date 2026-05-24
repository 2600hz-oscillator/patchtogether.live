// packages/web/src/lib/audio/modules/hydrogen-hardcore-kit.ts
//
// HARDCORE — pushed / distorted / loud synthesized drumkit. 16 voices.
// Influenced by hardstyle / gabber / hardcore-techno percussion: kicks
// with overdriven body + click, snares with extra noise tail, hats
// trimmed harsher than TR-909. Default gains are pushed; the per-
// instrument knobs let you back off if you want.

import { type KitDef, type KitInstrument } from './hydrogen-kit-types';
import {
  sineSweepVoice,
  snareVoice,
  noiseBurstVoice,
  clapVoice,
  pulseSweepVoice,
  fmVoice,
} from './hydrogen-kit-synth-utils';

const HAT_GROUP = 1;

const INSTRUMENTS: readonly KitInstrument[] = [
  // 0 — distorted hardstyle kick (low pitch sweep + bright click)
  {
    kind: 'synth', id: 0, label: 'KICK', name: 'Hardstyle Kick',
    defaultGain: 1.25, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 55, modRatio: 1.5, modIndex: 380, tailS: 0.6, sweepEndHz: 32 }),
  },
  // 1 — gabber kick (super short + super pushed)
  {
    kind: 'synth', id: 1, label: 'GABB', name: 'Gabber Kick',
    defaultGain: 1.2, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'sawtooth', startHz: 140, endHz: 50, sweepS: 0.025, tailS: 0.18 }),
  },
  // 2 — punchy snare with extra noise tail
  {
    kind: 'synth', id: 2, label: 'SNAR', name: 'Snare',
    defaultGain: 1.05, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      snareVoice(ctx, dest, atTime, opts, { bodyHz: 220, bodyS: 0.06, noiseHighHz: 2200, noiseS: 0.32, noiseGain: 0.9 }),
  },
  // 3 — clap (multi-burst, loud + long)
  {
    kind: 'synth', id: 3, label: 'CLAP', name: 'Hardcore Clap',
    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      clapVoice(ctx, dest, atTime, opts, { burstHz: 1300, burstS: 0.015, tailS: 0.32 }),
  },
  // 4 — rim/stick (sharp click)
  {
    kind: 'synth', id: 4, label: 'RIM', name: 'Rim',
    defaultGain: 0.95, defaultPan: 0.1, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'square', startHz: 1800, endHz: 1000, sweepS: 0.006, tailS: 0.04 }),
  },
  // 5 — closed hat (trimmed sharper than 909)
  {
    kind: 'synth', id: 5, label: 'HHc', name: 'Hat Closed',
    defaultGain: 0.85, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 8000, tailS: 0.035, q: 0.5, gain: 0.6 }),
  },
  // 6 — open hat (long+harsh)
  {
    kind: 'synth', id: 6, label: 'HHo', name: 'Hat Open',
    defaultGain: 0.85, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 6500, tailS: 0.45, q: 0.4, gain: 0.55 }),
  },
  // 7 — pedal hat
  {
    kind: 'synth', id: 7, label: 'HHp', name: 'Hat Pedal',
    defaultGain: 0.75, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 7000, tailS: 0.05, q: 0.5, gain: 0.5 }),
  },
  // 8 — tom hi (distorted)
  {
    kind: 'synth', id: 8, label: 'TomH', name: 'Tom Hi',
    defaultGain: 1.0, defaultPan: 0.35, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 230, modRatio: 1.3, modIndex: 350, tailS: 0.4, sweepEndHz: 150 }),
  },
  // 9 — tom mid
  {
    kind: 'synth', id: 9, label: 'TomM', name: 'Tom Mid',
    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 165, modRatio: 1.3, modIndex: 320, tailS: 0.45, sweepEndHz: 100 }),
  },
  // 10 — tom low
  {
    kind: 'synth', id: 10, label: 'TomL', name: 'Tom Low',
    defaultGain: 1.0, defaultPan: -0.35, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 110, modRatio: 1.3, modIndex: 300, tailS: 0.5, sweepEndHz: 60 }),
  },
  // 11 — shaker (medium-pitch noise + faster decay than soft kits)
  {
    kind: 'synth', id: 11, label: 'SHKR', name: 'Shaker',
    defaultGain: 0.6, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 5800, tailS: 0.1, q: 0.6, gain: 0.5 }),
  },
  // 12 — crash (loud + long)
  {
    kind: 'synth', id: 12, label: 'CRSH', name: 'Crash',
    defaultGain: 0.75, defaultPan: 0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 3500, tailS: 1.6, q: 0.3, gain: 0.55 }),
  },
  // 13 — ride
  {
    kind: 'synth', id: 13, label: 'RIDE', name: 'Ride',
    defaultGain: 0.7, defaultPan: 0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 4500, tailS: 0.95, q: 0.4, gain: 0.5 }),
  },
  // 14 — siren (signature hardcore "tease" sample analog)
  {
    kind: 'synth', id: 14, label: 'SIRN', name: 'Siren',
    defaultGain: 0.7, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'sawtooth', startHz: 400, endHz: 1200, sweepS: 0.25, tailS: 0.35 }),
  },
  // 15 — hoover (TR-909-meets-303 style)
  {
    kind: 'synth', id: 15, label: 'HOOV', name: 'Hoover',
    defaultGain: 0.75, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 130, modRatio: 0.7, modIndex: 800, tailS: 0.55 }),
  },
];

export const HARDCORE_KIT: KitDef = {
  id: 'hardcore',
  name: 'HARDCORE',
  attribution: 'Synthesized hardcore / gabber drums — original-design, no samples',
  instruments: INSTRUMENTS,
};
