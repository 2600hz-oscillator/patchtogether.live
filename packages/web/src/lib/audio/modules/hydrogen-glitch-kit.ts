// packages/web/src/lib/audio/modules/hydrogen-glitch-kit.ts
//
// GLITCH — IDM / broken-beat synthesized drumkit. 16 voices. Short,
// pitched, jittery percussion designed for fragmented programming.
// Heavy on FM clicks, pitched noise bursts, granular-feeling pings.
// Pair with HYDROGEN's swing knob + low BPM for classic IDM stutter.

import { type KitDef, type KitInstrument } from './hydrogen-kit-types';
import {
  sineSweepVoice,
  noiseBurstVoice,
  fmVoice,
  pulseSweepVoice,
} from './hydrogen-kit-synth-utils';

const HAT_GROUP = 1;

const INSTRUMENTS: readonly KitInstrument[] = [
  // 0 — clicky FM kick
  {
    kind: 'synth', id: 0, label: 'KICK', name: 'Glitch Kick',
    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 75, modRatio: 4.2, modIndex: 1800, tailS: 0.22, sweepEndHz: 35 }),
  },
  // 1 — sub thump
  {
    kind: 'synth', id: 1, label: 'SUB', name: 'Sub Thump',
    defaultGain: 0.95, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 65, endHz: 30, sweepS: 0.05, tailS: 0.42 }),
  },
  // 2 — broken snare (very short with metallic noise)
  {
    kind: 'synth', id: 2, label: 'SNAR', name: 'Broken Snare',
    defaultGain: 0.85, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 350, modRatio: 3.7, modIndex: 1200, tailS: 0.09 }),
  },
  // 3 — snap (super short bright FM click)
  {
    kind: 'synth', id: 3, label: 'SNAP', name: 'Snap',
    defaultGain: 0.9, defaultPan: 0.15, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 1200, modRatio: 2.3, modIndex: 2000, tailS: 0.04 }),
  },
  // 4 — granular noise burst (clap-substitute)
  {
    kind: 'synth', id: 4, label: 'GRAN', name: 'Granular',
    defaultGain: 0.7, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 1800, tailS: 0.08, q: 2, gain: 0.6 }),
  },
  // 5 — tick (very short closed-hat alternative)
  {
    kind: 'synth', id: 5, label: 'TICK', name: 'Tick',
    defaultGain: 0.5, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 9000, tailS: 0.012, q: 0.6, gain: 0.4 }),
  },
  // 6 — pitched noise hat (open-ish)
  {
    kind: 'synth', id: 6, label: 'PNH', name: 'Pitched Noise',
    defaultGain: 0.5, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 5500, tailS: 0.25, q: 1.8, gain: 0.4 }),
  },
  // 7 — choke (super short tail to choke the hat group)
  {
    kind: 'synth', id: 7, label: 'CHOK', name: 'Choke',
    defaultGain: 0.45, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 6500, tailS: 0.02, q: 0.5, gain: 0.4 }),
  },
  // 8 — pitched ping (high-pitched melody pad)
  {
    kind: 'synth', id: 8, label: 'PING', name: 'Ping Hi',
    defaultGain: 0.7, defaultPan: 0.25, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 1800, modRatio: 1.41, modIndex: 1200, tailS: 0.18 }),
  },
  // 9 — mid ping
  {
    kind: 'synth', id: 9, label: 'PNG2', name: 'Ping Mid',
    defaultGain: 0.7, defaultPan: -0.25, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 920, modRatio: 1.51, modIndex: 700, tailS: 0.22 }),
  },
  // 10 — zap (descending sweep)
  {
    kind: 'synth', id: 10, label: 'ZAP', name: 'Zap',
    defaultGain: 0.85, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'sawtooth', startHz: 800, endHz: 100, sweepS: 0.08, tailS: 0.12 }),
  },
  // 11 — zing (ascending sweep)
  {
    kind: 'synth', id: 11, label: 'ZING', name: 'Zing',
    defaultGain: 0.8, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 400, endHz: 4000, sweepS: 0.1, tailS: 0.16 }),
  },
  // 12 — buzz (resonant noise)
  {
    kind: 'synth', id: 12, label: 'BUZZ', name: 'Buzz',
    defaultGain: 0.65, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 1500, tailS: 0.3, q: 3, gain: 0.55 }),
  },
  // 13 — glitch click (FM at extreme ratio)
  {
    kind: 'synth', id: 13, label: 'GLCH', name: 'Glitch',
    defaultGain: 0.75, defaultPan: 0.1, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 600, modRatio: 11.3, modIndex: 4000, tailS: 0.08 }),
  },
  // 14 — wood click (drier than rim)
  {
    kind: 'synth', id: 14, label: 'WOOD', name: 'Wood Click',
    defaultGain: 0.7, defaultPan: -0.15, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 650, modRatio: 2.1, modIndex: 250, tailS: 0.05 }),
  },
  // 15 — ride-cymbal-substitute (long shimmering FM)
  {
    kind: 'synth', id: 15, label: 'SHMR', name: 'Shimmer',
    defaultGain: 0.55, defaultPan: 0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 4000, modRatio: 6.7, modIndex: 4500, tailS: 0.75 }),
  },
];

export const GLITCH_KIT: KitDef = {
  id: 'glitch',
  name: 'GLITCH',
  attribution: 'Synthesized IDM-style percussion — original-design, no samples',
  instruments: INSTRUMENTS,
};
