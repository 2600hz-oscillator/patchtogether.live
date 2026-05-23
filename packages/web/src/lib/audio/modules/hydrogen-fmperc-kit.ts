// packages/web/src/lib/audio/modules/hydrogen-fmperc-kit.ts
//
// FM-PERC — synthesized FM-percussion kit. 16 voices built around the
// 2-op FM primitive in hydrogen-kit-synth-utils.ts. Inharmonic
// modulator ratios + short envelopes give the metallic / glassy /
// bell / tubular palette FM is famous for (DX7, TX81Z, FS1R lineage).
//
// All voices respect the per-instrument Vol/Pan/Pitch/Cutoff/Q/A/D/S/R
// knobs via VoiceOpts.

import {
  type KitDef,
  type KitInstrument,
} from './hydrogen-kit-types';
import {
  fmVoice,
  sineSweepVoice,
  noiseBurstVoice,
} from './hydrogen-kit-synth-utils';

const HAT_GROUP = 1;

const INSTRUMENTS: readonly KitInstrument[] = [
  // 0 — FM kick (low carrier, big modulator sweep for the click)
  {
    kind: 'synth', id: 0, label: 'KICK', name: 'FM Kick',
    defaultGain: 1.1, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 60, modRatio: 1.2, modIndex: 220, tailS: 0.4, sweepEndHz: 40 }),
  },
  // 1 — sharp pitched kick (rises off the sub)
  {
    kind: 'synth', id: 1, label: 'KIK2', name: 'Sub Kick',
    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 90, endHz: 35, sweepS: 0.04, tailS: 0.45 }),
  },
  // 2 — metallic snare (FM with bright modulator)
  {
    kind: 'synth', id: 2, label: 'SNAR', name: 'FM Snare',
    defaultGain: 0.9, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 220, modRatio: 2.3, modIndex: 380, tailS: 0.22 }),
  },
  // 3 — snap (very short bright FM)
  {
    kind: 'synth', id: 3, label: 'SNAP', name: 'Snap',
    defaultGain: 0.85, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 800, modRatio: 1.7, modIndex: 1200, tailS: 0.08 }),
  },
  // 4 — clap-ish noise burst (FM doesn't do claps well — use noise)
  {
    kind: 'synth', id: 4, label: 'CLAP', name: 'Clap',
    defaultGain: 0.8, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      noiseBurstVoice(ctx, dest, atTime, opts, { highHz: 1500, tailS: 0.18, q: 1.0, gain: 0.6 }),
  },
  // 5 — bright closed hat (FM high-ratio metallic)
  {
    kind: 'synth', id: 5, label: 'HHc', name: 'FM Hat Closed',
    defaultGain: 0.55, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 3500, modRatio: 7.3, modIndex: 5000, tailS: 0.05 }),
  },
  // 6 — open FM hat
  {
    kind: 'synth', id: 6, label: 'HHo', name: 'FM Hat Open',
    defaultGain: 0.55, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 3000, modRatio: 6.7, modIndex: 4400, tailS: 0.45 }),
  },
  // 7 — pedal-style FM tick
  {
    kind: 'synth', id: 7, label: 'HHp', name: 'FM Hat Pedal',
    defaultGain: 0.5, defaultPan: 0.05, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: HAT_GROUP,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 4200, modRatio: 5.1, modIndex: 3600, tailS: 0.07 }),
  },
  // 8 — bell (high-ratio FM tone, the iconic 80s DX7 bell)
  {
    kind: 'synth', id: 8, label: 'BELL', name: 'FM Bell',
    defaultGain: 0.7, defaultPan: 0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 880, modRatio: 3.5, modIndex: 700, tailS: 0.9 }),
  },
  // 9 — tubular bell
  {
    kind: 'synth', id: 9, label: 'TUBE', name: 'Tubular',
    defaultGain: 0.65, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 440, modRatio: 1.41, modIndex: 600, tailS: 1.2 }),
  },
  // 10 — wood block (short, harmonic-pure FM)
  {
    kind: 'synth', id: 10, label: 'WOOD', name: 'Wood',
    defaultGain: 0.85, defaultPan: -0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 750, modRatio: 2.0, modIndex: 200, tailS: 0.12 }),
  },
  // 11 — metal (inharmonic ratio, narrow tail)
  {
    kind: 'synth', id: 11, label: 'METL', name: 'Metal',
    defaultGain: 0.75, defaultPan: 0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 520, modRatio: 5.7, modIndex: 1800, tailS: 0.6 }),
  },
  // 12 — tink (very high pitched FM)
  {
    kind: 'synth', id: 12, label: 'TINK', name: 'Tink',
    defaultGain: 0.7, defaultPan: 0.35, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 1500, modRatio: 6.9, modIndex: 2500, tailS: 0.4 }),
  },
  // 13 — zap (descending FM sweep)
  {
    kind: 'synth', id: 13, label: 'ZAP', name: 'Zap',
    defaultGain: 0.8, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 1200, modRatio: 1.5, modIndex: 800, tailS: 0.18, sweepEndHz: 200 }),
  },
  // 14 — zing (ascending sine sweep)
  {
    kind: 'synth', id: 14, label: 'ZING', name: 'Zing',
    defaultGain: 0.75, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      sineSweepVoice(ctx, dest, atTime, opts, { startHz: 600, endHz: 4500, sweepS: 0.12, tailS: 0.2 }),
  },
  // 15 — klang (FM with feedback-ish high modIndex)
  {
    kind: 'synth', id: 15, label: 'KLNG', name: 'Klang',
    defaultGain: 0.65, defaultPan: 0.15, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1, muteGroup: 0,
    synth: (ctx, dest, atTime, opts) =>
      fmVoice(ctx, dest, atTime, opts, { carrierHz: 380, modRatio: 4.3, modIndex: 2200, tailS: 0.5 }),
  },
];

export const FMPERC_KIT: KitDef = {
  id: 'fmperc',
  name: 'FM-PERC',
  attribution: 'Synthesized FM percussion — original-design, no samples',
  instruments: INSTRUMENTS,
};
