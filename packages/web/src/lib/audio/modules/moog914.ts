// packages/web/src/lib/audio/modules/moog914.ts
//
// MOOG 914 EXTENDED FIXED FILTER BANK — a slice of the Moog System 55/35
// clone initiative (.myrobots/MOOG/). The 914 is the Moog System 55's full
// FIXED filter bank: a fan of TWELVE fixed-frequency bandpass sections (the
// classic 1/3-octave series), each with its own level knob, plus a fixed
// low-pass and a fixed high-pass section at the band-edges, all summed to one
// output. The band centers DO NOT MOVE — you sculpt a spectrum by setting each
// band's level (a graphic-EQ-like / formant-shaping tool). The 914 is the
// "extended" bank versus the System 35's smaller 907A.
//
// PURE Web Audio — NO AudioWorklet, NO Faust DSP. Identical wiring to the
// 907A (see moog-filterbank-factory.ts): a fan GainNode feeding one HP biquad,
// twelve BP biquads, and one LP biquad, each through its own level GainNode
// into a summing GainNode. 907A and 914 share that factory VERBATIM and differ
// ONLY in which center array they import — 914 uses the full 12-band series.
//
// NO CV: a FIXED filter bank — the band centers are constants from the shared
// moog-filterbank-dsp lib. Categorized under Ports → moogafakkin; category 'filters'.
//
// Inputs:
//   audio (audio): the signal to filter.
//
// Outputs:
//   audio (audio): the summed multi-band-shaped signal.
//
// Params:
//   hp (linear 0..1, default 0.5): level of the fixed HIGH-PASS section.
//   band1..band12 (linear 0..1, default 0.5): level of each fixed BANDPASS
//     section (N = FILTERBANK_914_CENTERS.length = 12).
//   lp (linear 0..1, default 0.5): level of the fixed LOW-PASS section.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  FILTERBANK_914_CENTERS,
  FILTERBANK_914_LP_HZ,
  FILTERBANK_914_HP_HZ,
  FILTERBANK_Q,
  bandParamId,
} from '../../../../../dsp/src/lib/moog-filterbank-dsp';
import { buildFilterBank } from './moog-filterbank-factory';

const CENTERS = FILTERBANK_914_CENTERS;

export const moog914Def: AudioModuleDef = {
  type: 'moog914',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog914Card',
  domain: 'audio',
  label: '914 extended fixed filter bank',
  category: 'filters',
  schemaVersion: 1,

  inputs: [
    // The signal to shape. Plain audio passthrough into the fan node.
    { id: 'audio', type: 'audio' },
  ],
  outputs: [
    // The summed multi-band-shaped signal.
    { id: 'audio', type: 'audio' },
  ],
  params: [
    // HP section first, then the bandpass bands low→high, then LP — the same
    // top-to-bottom order the card lays the knobs out in.
    { id: 'hp', label: 'HP', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    ...CENTERS.map((freq, i) => ({
      id: bandParamId(i + 1),
      label: `${freq >= 1000 ? `${freq / 1000}k` : freq}`,
      defaultValue: 0.5,
      min: 0,
      max: 1,
      curve: 'linear' as const,
    })),
    { id: 'lp', label: 'LP', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
  ],

  docs: {
    explanation:
      "A recreation of the Moog 914 Extended Fixed Filter Bank — the System 55's full fixed filter bank, the bigger sibling of the 907A and a kind of fixed graphic EQ for spectral and formant shaping. The signal fans into fourteen parallel filter sections whose centre frequencies DO NOT move: a fixed low-pass shelf at the bottom, TWELVE fixed band-pass sections in the classic 1/3-octave series (125 Hz, 175, 250, 350, 500, 700, 1 kHz, 1.4 k, 2 k, 2.8 k, 4 k, 5.6 k), and a fixed high-pass shelf at the top. Each section has its own LEVEL knob and all sum to one output, so you sculpt a sound by boosting and cutting fixed regions — emphasise formants, notch harsh bands, or carve detailed vocal/telephone tones with finer resolution than the 907A. The bands never move and there is no CV: a pure Web Audio biquad + gain graph, identical wiring to the 907A with twelve bands instead of eight. At the default 0.5 every band passes at half level, a neutral middle to boost or cut from.",
    inputs: {
      audio: "The signal to filter — fanned in parallel into every fixed filter section.",
    },
    outputs: {
      audio: "The summed multi-band output — every section's contribution added together, the shaped spectrum.",
    },
    controls: {
      hp: "Level of the fixed HIGH-PASS section at the top of the bank (corner ~7.5 kHz) — raise to add air and brightness, cut to soften the top. Defaults to 0.5.",
      band1: "Level of the fixed 125 Hz band-pass section (bass / fundamental). Defaults to 0.5.",
      band2: "Level of the fixed 175 Hz band-pass section (low end / warmth). Defaults to 0.5.",
      band3: "Level of the fixed 250 Hz band-pass section (low mids / body). Defaults to 0.5.",
      band4: "Level of the fixed 350 Hz band-pass section (lower mids). Defaults to 0.5.",
      band5: "Level of the fixed 500 Hz band-pass section (mids). Defaults to 0.5.",
      band6: "Level of the fixed 700 Hz band-pass section (mids). Defaults to 0.5.",
      band7: "Level of the fixed 1 kHz band-pass section (presence). Defaults to 0.5.",
      band8: "Level of the fixed 1.4 kHz band-pass section (presence / nasal). Defaults to 0.5.",
      band9: "Level of the fixed 2 kHz band-pass section (upper mids / bite). Defaults to 0.5.",
      band10: "Level of the fixed 2.8 kHz band-pass section (high presence). Defaults to 0.5.",
      band11: "Level of the fixed 4 kHz band-pass section (clarity / edge). Defaults to 0.5.",
      band12: "Level of the fixed 5.6 kHz band-pass section (brilliance / sizzle). Defaults to 0.5.",
      lp: "Level of the fixed LOW-PASS section at the bottom of the bank (corner ~100 Hz) — raise to add sub weight, cut to thin the bottom. Defaults to 0.5.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    return buildFilterBank(
      ctx,
      node,
      moog914Def,
      CENTERS,
      FILTERBANK_Q,
      FILTERBANK_914_LP_HZ,
      FILTERBANK_914_HP_HZ,
    );
  },
};
