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
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog907aCard',
  domain: 'audio',
  label: '907a fixed filter bank',
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
      "A recreation of the Moog 907A Fixed Filter Bank — the System 35's smaller fixed filter bank, a kind of fixed graphic EQ for spectral and formant shaping. The signal fans into ten parallel filter sections whose centre frequencies DO NOT move: a fixed low-pass shelf at the bottom, eight fixed band-pass sections marching up the spectrum (250 Hz, 350, 500, 700, 1 kHz, 1.4 k, 2 k, 2.8 k), and a fixed high-pass shelf at the top. Each section has its own LEVEL knob, and all of them sum to one output, so you sculpt a sound by boosting and cutting fixed regions — emphasise a formant, notch out a harsh band, or carve a vocal/telephone tone. Unlike a voltage-controlled filter the bands never move and there is no CV: it is a pure Web Audio biquad + gain graph (the larger 914 is the same module with twelve bands). At the default 0.5 every band passes at half level, a neutral middle you can boost or cut from.",
    inputs: {
      audio: "The signal to filter — fanned in parallel into every fixed filter section.",
    },
    outputs: {
      audio: "The summed multi-band output — every section's contribution added together, the shaped spectrum.",
    },
    controls: {
      hp: "Level of the fixed HIGH-PASS section at the top of the bank (corner ~6.6 kHz) — raise to add air and let the highs through, cut to tame them. Defaults to 0.5.",
      band1: "Level of the fixed 250 Hz band-pass section (low mids / body). Defaults to 0.5.",
      band2: "Level of the fixed 350 Hz band-pass section (lower mids). Defaults to 0.5.",
      band3: "Level of the fixed 500 Hz band-pass section (mids). Defaults to 0.5.",
      band4: "Level of the fixed 700 Hz band-pass section (mids). Defaults to 0.5.",
      band5: "Level of the fixed 1 kHz band-pass section (presence). Defaults to 0.5.",
      band6: "Level of the fixed 1.4 kHz band-pass section (presence / nasal). Defaults to 0.5.",
      band7: "Level of the fixed 2 kHz band-pass section (upper mids / bite). Defaults to 0.5.",
      band8: "Level of the fixed 2.8 kHz band-pass section (high presence). Defaults to 0.5.",
      lp: "Level of the fixed LOW-PASS section at the bottom of the bank (corner ~175 Hz) — raise to add weight and lows, cut to thin the bottom. Defaults to 0.5.",
    },
  },

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
