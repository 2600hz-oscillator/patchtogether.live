// packages/web/src/lib/audio/modules/filter.ts
//
// FILTER — multi-mode resonant state-variable filter (LP / BP / HP).
//
// The bread-and-butter subtractive-synthesis filter. Faust-compiled DSP
// (packages/dsp/src/filter.dsp): the Faust core implements LP/BP/HP
// modes selectable via the `mode` param; cutoff and resonance are
// continuously modulatable. CV inputs are routed through a ChannelMerger
// onto the Faust node's per-sample CV channels (rather than via the
// AudioParam fast path), so cutoff CV is audio-rate clean and the Faust
// source's own ±5-octave-from-knob mapping is what defines the sweep
// shape. Patch this after a VCO and before a VCA to get the textbook
// "filter sweep" voice; modulate cutoff from an envelope or LFO.
//
// Inputs:
//   audio (audio): signal to be filtered.
//   cutoff (cv, paramTarget=cutoff): audio-rate cutoff CV. Maps -1..+1 to ±5 octaves
//     around the cutoff knob (Faust-side mapping; engine-side cvScale is omitted on purpose).
//   res (cv): resonance CV; sums into the resonance param at audio rate.
//
// Outputs:
//   audio (audio): filtered output.
//
// Params:
//   cutoff (log 20..20000 Hz, default 1000): center / corner frequency.
//   resonance (linear 0..0.99, default 0.1): filter Q / emphasis.
//   mode (discrete 0..2, default 0): 0=LP, 1=BP, 2=HP.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/filter.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/filter.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/filter.worklet.js?url';

const PARAM_PREFIX = '/Filter';

export const filterDef: AudioModuleDef = {
  type: 'filter',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'filter',
  category: 'filters',
  inputs: [
    { id: 'audio',  type: 'audio' },
    // CV inputs are routed through the channel merger (channels 1, 2)
    // so they sum into the Faust DSP's per-sample CV input — they are
    // NOT AudioParam-routed. paramTarget is declared so the docs
    // manifest renders "CV -> cutoff param." consistently with every
    // other CV input in the codebase. The runtime ignores paramTarget
    // on this module (the engine looks at the factory's inputs map,
    // where these ports are wired to merger channels).
    //
    // We intentionally do NOT request cvScale here because:
    //   1. These ports route through the merger as audio-rate signals,
    //      not via the CV→AudioParam fast path. The cv-scale registry
    //      treats this as PASSTHROUGH_BY_DESIGN.
    //   2. The Faust source already maps -1..+1 onto the param's full
    //      musical range (cutoff: ±5 octaves around knob; res additive),
    //      which is exactly the standard's intent.
    //
    // NOTE: port id 'res' intentionally short for the panel; the
    // matching param is 'resonance'. paramTarget is omitted on `res`
    // because it would falsely advertise a `res` param that doesn't
    // exist; CV routing still works via the merger (DSP channel 2).
    { id: 'cutoff', type: 'cv', paramTarget: 'cutoff' },
    { id: 'res',    type: 'cv' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'cutoff',    label: 'Cutoff', defaultValue: 1000, min: 20,   max: 20000, curve: 'log',      units: 'Hz' },
    { id: 'resonance', label: 'Res',    defaultValue: 0.1,  min: 0,    max: 0.99,  curve: 'linear' },
    { id: 'mode',      label: 'Mode',   defaultValue: 0,    min: 0,    max: 2,     curve: 'discrete' },
  ],

  docs: {
    explanation:
      "A multi-mode state-variable filter applying subtractive synthesis' bread-and-butter filtering to an audio signal. Three continuously-selectable modes (lowpass/bandpass/highpass) shape the spectral response; cutoff frequency and resonance (Q/emphasis) are both continuously modulatable via CV inputs for dynamic sweep effects. The cutoff CV input maps -1..+1 to ±5 octaves around the knob position via the Faust DSP itself, enabling smooth audio-rate modulation without requiring a separate CV scale stage. Typical voice structure: VCO → Filter → VCA, with an envelope or LFO patched into the cutoff and resonance CV inputs for expressive timbral shaping.",
    inputs: {
      audio:
        "The signal to be filtered — typically an oscillator output or other harmonically-rich source. The filter operates on this audio-rate signal.",
      cutoff:
        "CV input that modulates the cutoff frequency parameter at audio rate. A -1..+1 signal sweeps the frequency symmetrically around your fader setting by ±5 octaves (20 Hz to 20 kHz musical range), mapped internally by the Faust DSP source — no external scaling needed. Typical patch: envelope or LFO output → here, for dynamic sweep effects.",
      res: "CV input that sums into the resonance (Q) parameter at audio rate, emphasizing energy near the cutoff frequency. Linear scaling over the 0..0.99 range — patch a slow LFO or envelope here to add vocal-like formant sweeps or self-oscillation dynamics.",
    },
    outputs: {
      audio:
        "The filtered output signal, shaped by the selected mode, cutoff frequency, and resonance amount. Patch into a VCA, VCF, or the next stage of your voice chain.",
    },
    controls: {
      cutoff:
        "The corner / center frequency of the filter, ranging 20 Hz (sub-bass territory) to 20 kHz (silence / presence peak). Log fader so the travel lives where your ear cares most — most musical action clusters in the mid-range knob positions.",
      resonance:
        "Filter Q / peak emphasis, 0..0.99 — 0 is flat (no resonance, just frequency rolloff), raising it peaks the response near the cutoff (boosts that region, adds character), and at high values it can self-oscillate (the filter rings at cutoff indefinitely with no input signal). Resonance interacts with mode: highpass resonance can sculpt upper-midrange sheen, lowpass resonance can warm up oscillators by emphasizing fundamentals.",
      // The MODE param is a 3-position discrete selector (0=LP, 1=BP, 2=HP),
      // shown as three buttons on the card. Documented under the param id `mode`
      // (its three positions described together) — there is no per-position
      // param/control-family in the def to key separate entries off of.
      mode:
        "Discrete 3-position filter type selector (0 = LP, 1 = BP, 2 = HP). Lowpass (LP) lets low frequencies pass and rolls off above the cutoff — the textbook subtractive-synthesis filter, sculpting bright oscillators into warm, mellow tones by removing highs. Bandpass (BP) lets frequencies near the cutoff pass through and attenuates both below and above — useful for isolating a narrow spectral slice or creating resonant peaks for plucks and bells. Highpass (HP) lets high frequencies pass and attenuates below the cutoff — removes bass / rumble and brings out brightness, useful for thinning out sources or creating thin, nasal tones.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'filter', wasmUrl, metaUrl, workletUrl });
    const merger = ctx.createChannelMerger(3);
    merger.connect(f);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);
    silence.connect(merger, 0, 2);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of filterDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    return {
      domain: 'audio',
      inputs: new Map([
        ['audio',  { node: merger, input: 0 }],
        ['cutoff', { node: merger, input: 1 }],
        ['res',    { node: merger, input: 2 }],
      ]),
      outputs: new Map([['audio', { node: f, output: 0 }]]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        merger.disconnect();
        f.disconnect();
      },
    };
  },
};
