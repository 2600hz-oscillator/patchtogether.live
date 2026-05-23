// packages/web/src/lib/audio/modules/hydrogen-tr909-kit.ts
//
// TR-909-STYLE synthesized drumkit. 16 voices, fully synthesized via
// Web Audio (no samples, no LFS bloat). Inspired by the analog/digital
// hybrid topology of the original Roland TR-909: kicks + toms + cowbell
// are analog-style oscillator + envelope; snare + claps are noise +
// short pitched body; hats + ride + crash are filtered noise with
// long/short tails; rim/clap accent fill out the perc slots.
//
// All voices respect the per-instrument Vol/Pan/Pitch/Cutoff/Q/A/D/S/R
// knobs in HydrogenCard via the shared VoiceOpts contract.

import {
  type KitDef,
  type KitInstrument,
} from './hydrogen-kit-types';
import {
  sineSweepVoice,
  snareVoice,
  noiseBurstVoice,
  clapVoice,
  cowbellVoice,
  pulseSweepVoice,
} from './hydrogen-kit-synth-utils';

const HAT_GROUP = 1;

const INSTRUMENTS: readonly KitInstrument[] = [
  // 0 — long boomy kick
  {
    kind: 'synth', id: 0, label: 'KICK1', name: 'Kick Long',
    defaultGain: 1.1, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 110, endHz: 38, sweepS: 0.06, tailS: 0.55 }),
  },
  // 1 — tight punchy kick
  {
    kind: 'synth', id: 1, label: 'KICK2', name: 'Kick Tight',
    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 140, endHz: 50, sweepS: 0.03, tailS: 0.25 }),
  },
  // 2 — snare 1 (body + medium noise)
  {
    kind: 'synth', id: 2, label: 'SNR1', name: 'Snare 1',
    defaultGain: 0.95, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      snareVoice(ctx, dest, atTime, opts, { bodyHz: 200, bodyS: 0.08, noiseHighHz: 1800, noiseS: 0.18 }),
  },
  // 3 — snare 2 (bright, longer)
  {
    kind: 'synth', id: 3, label: 'SNR2', name: 'Snare 2',
    defaultGain: 0.9, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      snareVoice(ctx, dest, atTime, opts, { bodyHz: 240, bodyS: 0.05, noiseHighHz: 2500, noiseS: 0.28, noiseGain: 0.7 }),
  },
  // 4 — clap
  {
    kind: 'synth', id: 4, label: 'CLAP', name: 'Clap',
    defaultGain: 0.85, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      clapVoice(ctx, dest, atTime, opts, { burstHz: 1100, burstS: 0.012, tailS: 0.18 }),
  },
  // 5 — closed hat (mute-group)
  {
    kind: 'synth', id: 5, label: 'HHc', name: 'Hat Closed',
    defaultGain: 0.7, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 7000, tailS: 0.04, q: 0.5, gain: 0.5 }),
  },
  // 6 — open hat (mute-group)
  {
    kind: 'synth', id: 6, label: 'HHo', name: 'Hat Open',
    defaultGain: 0.75, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 6000, tailS: 0.4, q: 0.4, gain: 0.45 }),
  },
  // 7 — pedal hat (mute-group)
  {
    kind: 'synth', id: 7, label: 'HHp', name: 'Hat Pedal',
    defaultGain: 0.7, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 5500, tailS: 0.06, q: 0.5, gain: 0.4 }),
  },
  // 8 — tom hi
  {
    kind: 'synth', id: 8, label: 'TomH', name: 'Tom Hi',
    defaultGain: 0.9, defaultPan: 0.4, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 220, endHz: 140, sweepS: 0.08, tailS: 0.35 }),
  },
  // 9 — tom mid
  {
    kind: 'synth', id: 9, label: 'TomM', name: 'Tom Mid',
    defaultGain: 0.9, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 160, endHz: 95, sweepS: 0.1, tailS: 0.4 }),
  },
  // 10 — tom low
  {
    kind: 'synth', id: 10, label: 'TomL', name: 'Tom Low',
    defaultGain: 0.95, defaultPan: -0.4, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 100, endHz: 55, sweepS: 0.12, tailS: 0.45 }),
  },
  // 11 — rimshot (short FM-ish click via square sweep)
  {
    kind: 'synth', id: 11, label: 'RIM', name: 'Rimshot',
    defaultGain: 0.85, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'square', startHz: 1800, endHz: 900, sweepS: 0.01, tailS: 0.06 }),
  },
  // 12 — ride (longer filtered noise + body)
  {
    kind: 'synth', id: 12, label: 'RIDE', name: 'Ride',
    defaultGain: 0.7, defaultPan: 0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 4000, tailS: 0.8, q: 0.4, gain: 0.35 }),
  },
  // 13 — crash (very long filtered noise)
  {
    kind: 'synth', id: 13, label: 'CRSH', name: 'Crash',
    defaultGain: 0.6, defaultPan: 0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 3500, tailS: 1.4, q: 0.3, gain: 0.4 }),
  },
  // 14 — shaker
  {
    kind: 'synth', id: 14, label: 'SHKR', name: 'Shaker',
    defaultGain: 0.55, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 5500, tailS: 0.12, q: 0.6, gain: 0.5 }),
  },
  // 15 — cowbell (the 909 cowbell is brighter + shorter than the 808's)
  {
    kind: 'synth', id: 15, label: 'CWBL', name: 'Cowbell',
    defaultGain: 0.75, defaultPan: 0.25, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      cowbellVoice(ctx, dest, atTime, opts, { topHz: 870, bottomHz: 590, tailS: 0.35 }),
  },
];

export const TR909_KIT: KitDef = {
  id: 'tr909',
  name: 'TR-909',
  attribution: 'Synthesized (analog-style) — original-design, no samples',
  instruments: INSTRUMENTS,
};
