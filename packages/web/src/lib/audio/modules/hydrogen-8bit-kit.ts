// packages/web/src/lib/audio/modules/hydrogen-8bit-kit.ts
//
// 8BIT — chiptune-style drum kit. Square + triangle waves for pitched
// hits, short noise bursts for percussion. The character: every voice
// is tight, harsh, square-edged. Good for Nintendo-style sketches and
// glitchy patterns.
//
// All voices respect the per-instrument Vol/Pan/Pitch/Cutoff/Q/A/D/S/R
// knobs via VoiceOpts.

import {
  type KitDef,
  type KitInstrument,
} from './hydrogen-kit-types';
import {
  pulseSweepVoice,
  noiseBurstVoice,
} from './hydrogen-kit-synth-utils';

const HAT_GROUP = 1;

const INSTRUMENTS: readonly KitInstrument[] = [
  // 0 — square-wave kick (NES-style triangle would also work, but
  // square reads as "8-bit" more obviously on a small monitor speaker)
  {
    kind: 'synth', id: 0, label: 'KICK', name: 'Square Kick',
    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'square', startHz: 90, endHz: 40, sweepS: 0.05, tailS: 0.3 }),
  },
  // 1 — triangle thumper (the NES kick was a short triangle pulse)
  {
    kind: 'synth', id: 1, label: 'KIK2', name: 'Triangle Kick',
    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'triangle', startHz: 80, endHz: 35, sweepS: 0.04, tailS: 0.25 }),
  },
  // 2 — noise snare (NES-channel-4-style)
  {
    kind: 'synth', id: 2, label: 'SNR', name: 'Noise Snare',
    defaultGain: 0.85, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 1800, tailS: 0.16, q: 0.5, gain: 0.7 }),
  },
  // 3 — pitched noise snare
  {
    kind: 'synth', id: 3, label: 'SNR2', name: 'Pitched Snare',
    defaultGain: 0.85, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 2400, tailS: 0.12, q: 1.2, gain: 0.65 }),
  },
  // 4 — clap (square-wave pulse train pretends to be 4 fingers)
  {
    kind: 'synth', id: 4, label: 'CLAP', name: 'Square Clap',
    defaultGain: 0.75, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 1200, tailS: 0.14, q: 0.8, gain: 0.6 }),
  },
  // 5 — closed hat (very short noise)
  {
    kind: 'synth', id: 5, label: 'HHc', name: 'Hat Closed',
    defaultGain: 0.6, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 6000, tailS: 0.03, q: 0.6, gain: 0.45 }),
  },
  // 6 — open hat (medium noise tail)
  {
    kind: 'synth', id: 6, label: 'HHo', name: 'Hat Open',
    defaultGain: 0.65, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 5500, tailS: 0.22, q: 0.5, gain: 0.42 }),
  },
  // 7 — pedal hat
  {
    kind: 'synth', id: 7, label: 'HHp', name: 'Hat Pedal',
    defaultGain: 0.55, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 5000, tailS: 0.05, q: 0.55, gain: 0.4 }),
  },
  // 8 — sweep up (the classic Mario "1up" thrown into a kit slot)
  {
    kind: 'synth', id: 8, label: 'ZAP↑', name: 'Sweep Up',
    defaultGain: 0.75, defaultPan: 0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'square', startHz: 300, endHz: 2200, sweepS: 0.08, tailS: 0.12 }),
  },
  // 9 — sweep down (laser zap)
  {
    kind: 'synth', id: 9, label: 'ZAP↓', name: 'Sweep Down',
    defaultGain: 0.75, defaultPan: -0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'square', startHz: 1800, endHz: 200, sweepS: 0.1, tailS: 0.15 }),
  },
  // 10 — short bright blip
  {
    kind: 'synth', id: 10, label: 'BLIP', name: 'Blip',
    defaultGain: 0.7, defaultPan: 0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'square', startHz: 1320, endHz: 1320, sweepS: 0.01, tailS: 0.06 }),
  },
  // 11 — lower blop
  {
    kind: 'synth', id: 11, label: 'BLOP', name: 'Blop',
    defaultGain: 0.75, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'square', startHz: 660, endHz: 660, sweepS: 0.01, tailS: 0.09 }),
  },
  // 12 — high tick
  {
    kind: 'synth', id: 12, label: 'TICK', name: 'Tick',
    defaultGain: 0.6, defaultPan: 0.4, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 8000, tailS: 0.02, q: 0.8, gain: 0.45 }),
  },
  // 13 — low tock
  {
    kind: 'synth', id: 13, label: 'TOCK', name: 'Tock',
    defaultGain: 0.7, defaultPan: -0.4, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'triangle', startHz: 220, endHz: 220, sweepS: 0.01, tailS: 0.05 }),
  },
  // 14 — bing (longer triangle note — like a coin)
  {
    kind: 'synth', id: 14, label: 'BING', name: 'Bing',
    defaultGain: 0.7, defaultPan: 0.25, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'triangle', startHz: 988, endHz: 988, sweepS: 0.01, tailS: 0.35 }),
  },
  // 15 — bong (lower coin)
  {
    kind: 'synth', id: 15, label: 'BONG', name: 'Bong',
    defaultGain: 0.75, defaultPan: -0.25, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      pulseSweepVoice(ctx, dest, atTime, opts, { wave: 'triangle', startHz: 494, endHz: 494, sweepS: 0.01, tailS: 0.42 }),
  },
];

export const EIGHT_BIT_KIT: KitDef = {
  id: '8bit',
  name: '8BIT',
  attribution: 'Synthesized chiptune drums — original-design, no samples',
  instruments: INSTRUMENTS,
};
