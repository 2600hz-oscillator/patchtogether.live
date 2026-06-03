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
// moog-filterbank-dsp lib. Categorized under Clones → moogafakkin; category 'filters'.
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
  palette: { top: 'Clones', sub: 'moogafakkin' },
  card: 'Moog914Card',
  domain: 'audio',
  label: '914 Extended Fixed Filter Bank',
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
