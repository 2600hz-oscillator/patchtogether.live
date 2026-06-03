// packages/web/src/lib/audio/modules/moog907a.ts
//
// MOOG 907A FIXED FILTER BANK — a slice of the Moog System 55/35 clone
// initiative (.myrobots/MOOG/). The 907A is the Moog System 35's smaller
// FIXED filter bank: a fan of fixed-frequency bandpass sections, each with
// its own level knob, plus a fixed low-pass section and a fixed high-pass
// section at the band-edges, all summed to one output. Unlike a voltage-
// controlled filter the band centers DO NOT MOVE — you sculpt a spectrum by
// setting each band's level (a graphic-EQ-like / formant-shaping tool).
//
// PURE Web Audio — NO AudioWorklet, NO Faust DSP. The whole module is a
// BiquadFilterNode + GainNode graph:
//
//   audio_in ─▶ fan (GainNode, unity)
//                 ├─▶ HP biquad('highpass') ─▶ hpGain ─┐
//                 ├─▶ BP biquad(band1)      ─▶ g1      │
//                 ├─▶ BP biquad(band2)      ─▶ g2      ├─▶ summer (GainNode) ─▶ audio_out
//                 │           …                        │
//                 └─▶ LP biquad('lowpass')  ─▶ lpGain ─┘
//
// (Web Audio fan-in is additive, so every band gain connected to the one
// summer produces the summed spectrum.) Each band's level knob is that
// band's GainNode.gain; at the default 0.5 the band passes at half level
// ("unity-ish" — a neutral middle so the user can boost or cut each band).
//
// NO CV: a FIXED filter bank — the band centers are constants from the shared
// moog-filterbank-dsp lib (907A = the standard-range 8-band subset; the 914
// uses the full 12-band series). 907A and 914 share this factory verbatim and
// differ ONLY in which center array they import. Categorized under Moog →
// SYS35; category 'filters'.
//
// Inputs:
//   audio (audio): the signal to filter.
//
// Outputs:
//   audio (audio): the summed multi-band-shaped signal.
//
// Params:
//   hp (linear 0..1, default 0.5): level of the fixed HIGH-PASS section.
//   band1..bandN (linear 0..1, default 0.5): level of each fixed BANDPASS
//     section (N = FILTERBANK_907A_CENTERS.length = 8).
//   lp (linear 0..1, default 0.5): level of the fixed LOW-PASS section.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  FILTERBANK_907A_CENTERS,
  FILTERBANK_907A_LP_HZ,
  FILTERBANK_907A_HP_HZ,
  FILTERBANK_Q,
  bandParamId,
} from '../../../../../dsp/src/lib/moog-filterbank-dsp';
import { buildFilterBank } from './moog-filterbank-factory';

const CENTERS = FILTERBANK_907A_CENTERS;

export const moog907aDef: AudioModuleDef = {
  type: 'moog907a',
  palette: { top: 'Clones', sub: 'moogafakkin' },
  card: 'Moog907aCard',
  domain: 'audio',
  label: '907A Fixed Filter Bank',
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
      moog907aDef,
      CENTERS,
      FILTERBANK_Q,
      FILTERBANK_907A_LP_HZ,
      FILTERBANK_907A_HP_HZ,
    );
  },
};
