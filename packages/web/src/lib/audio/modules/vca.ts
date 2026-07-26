// packages/web/src/lib/audio/modules/vca.ts
//
// VCA — voltage-controlled amplifier (mono).
//
// The standard Eurorack utility module: a single audio input multiplied by
// `base + cvAmount * cv`. With nothing patched into CV and base=0 the VCA
// is silent; with CV held at +1 and cvAmount=1 it passes the audio through
// at unity. Faust-compiled DSP (packages/dsp/src/vca.dsp): the summed gain
// runs through `si.smoo` (one-pole smoothing) before the multiply, so knob
// moves and stepped CV are de-clicked — the CV path responds at envelope/
// LFO rate, not audio rate. The gain total is NOT clamped: sums above 1
// boost past unity; sums below 0 pass the signal phase-inverted. A parallel
// phase-inverted output (`audio_inv`) is a GainNode(-1) tap of the same
// signal — useful for stereo widening, sidechain ducking, or mid/side
// processing without needing an extra inverter module.
//
// Inputs:
//   audio (audio): signal to be amplified / gated.
//   cv (cv): control voltage; combined with the base knob and scaled by cvAmount.
//
// Outputs:
//   audio (audio): the amplified output (audio * (base + cv * cvAmount)).
//   audio_inv (audio): sign-inverted copy of the output (phase-flipped).
//
// Params:
//   base (linear 0..1, default 0): static gain floor added to the scaled CV
//     (silent-when-unpatched at 0; unity gain at 1).
//   cvAmount (linear -1..1, default 1): depth + sign of the CV input; negative
//     subtracts the CV from base (ducking / inverted modulation).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/vca.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/vca.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/vca.worklet.js?url';

const PARAM_PREFIX = '/VCA';

export const vcaDef: AudioModuleDef = {
  type: 'vca',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'vca',
  category: 'utilities',
  inputs: [
    { id: 'audio', type: 'audio' },
    { id: 'cv', type: 'cv' },
  ],
  outputs: [
    { id: 'audio',     type: 'audio' },
    // Sign-inverted (phase-flipped) audio. Standard "phase invert" semantic
    // for stereo widening, side-chain feedback prevention, mid/side
    // processing. Implemented as a parallel GainNode(-1) tap.
    { id: 'audio_inv', type: 'audio' },
  ],
  params: [
    { id: 'base',     label: 'Base',   defaultValue: 0,   min:  0, max: 1, curve: 'linear' },
    { id: 'cvAmount', label: 'CV amt', defaultValue: 1.0, min: -1, max: 1, curve: 'linear' },
  ],

  // RACKLINE curation (P1 total-rework; gallery mock: fullcard-mocks/vca.html).
  // The minimal-module face: `base` leads — the hand-on-the-gain knob (0 closes
  // the VCA, 1 passes unity), the one control you reach for at mini tier.
  // `cvAmount` ranks second: modulation depth + sign, the other half of the
  // gain equation. The 'meter' glyph fills the tile's visual slot with live
  // output level (the mock's third bench element), so the two-knob face reads
  // as a balanced gain stage rather than an empty tile. The dock is a single
  // 'gain stage' page mirroring the mock's hero bench; the mock's second band
  // ("signal": gain-math readout + phase-tap comparison) is visualization-only
  // — it has no control keys, so it is not a face page.
  face: {
    order: ['base', 'cvAmount'],
    pages: [{ id: 'gain', label: 'gain stage', controls: ['base', 'cvAmount'] }],
    glyph: 'meter',
    // REAR CARD curation: neither input is a per-param CV (the worklet owns
    // the gain law), so derivation would fold both into one 'signal' band —
    // the spec's vca table reads better as signal → gain stage.
    rear: {
      groups: [
        { id: 'signal', label: 'signal', ports: ['audio'] },
        { id: 'gain', label: 'gain stage', ports: ['cv'] },
      ],
    },
  },

  docs: {
    explanation:
      "A voltage-controlled amplifier — the elementary 'how loud right now' utility. It multiplies the audio input by a gain of base + cv × cvAmount: patch an envelope or LFO into cv and shape the response with the two knobs. The summed gain is smoothed by a one-pole filter (Faust si.smoo) before the multiply, so knob moves and stepped CV open the VCA click-free — which also means the cv path tracks at envelope/LFO rate, not audio rate (a clean utility VCA, not a ring modulator). The gain total is not clamped: sums above 1 boost past unity, and sums below 0 pass the signal phase-inverted. A sign-flipped copy of the output is always available on the audio_inv port for stereo widening, sidechain tricks, or mid/side processing without a separate inverter module.",
    inputs: {
      audio:
        "The signal to be amplified or gated — an oscillator voice, sampler, or any audio source. It is multiplied sample-by-sample by the smoothed gain (base + cv × cvAmount).",
      cv: "Control voltage for the gain: scaled by cvAmount, added to base, then smoothed. Typical sources are an ADSR for note shaping, an LFO for tremolo, or a sequencer CV lane for per-step level. The smoothing de-zips abrupt gate-shaped CV so it opens the VCA click-free; audio-rate signals patched here are largely filtered out rather than ring-modulated.",
    },
    outputs: {
      audio:
        "The amplified signal: audio × (base + cv × cvAmount), with the summed gain smoothed. Silent when base is 0 and nothing drives cv; unity passthrough at base 1 with no CV. The gain is unclamped — sums above 1 amplify beyond unity, and sums below 0 emerge phase-inverted.",
      audio_inv:
        "A sample-accurate phase-inverted (×−1) copy of the audio output, implemented as a parallel inverting gain tap. Always live — patch it for stereo width, mid/side processing, or cancellation/sidechain tricks without adding an inverter module.",
    },
    controls: {
      base: "The static gain floor (linear 0 to 1, default 0), added to the scaled CV. At 0 the VCA is fully closed — silent until CV opens it; at 1 it passes unity with no CV. Raise it to leave some dry signal under modulation, or use it alone as a plain volume knob.",
      cvAmount:
        "Depth and sign of the cv input (linear −1 to +1, default +1). At +1 the full CV adds to base; smaller values shallow the modulation. Negative values subtract the CV from base — with base raised, rising CV ducks the output (sidechain-style); and because the gain is unclamped, a sum below 0 passes the signal phase-inverted rather than muting.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'vca', wasmUrl, metaUrl, workletUrl });
    const merger = ctx.createChannelMerger(2);
    merger.connect(f);
    // Keep the merger in the active graph (see analog-vco for why).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of vcaDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }

    // ----- audio_inv: -audio -----
    // Parallel tap of the VCA's main output through a GainNode(-1). The
    // inverted output is sample-accurate sign-flipped relative to `audio`.
    const inverter = ctx.createGain();
    inverter.gain.value = -1;
    f.connect(inverter);

    return {
      domain: 'audio',
      inputs: new Map([
        ['audio', { node: merger, input: 0 }],
        ['cv',    { node: merger, input: 1 }],
      ]),
      outputs: new Map([
        ['audio',     { node: f,        output: 0 }],
        ['audio_inv', { node: inverter, output: 0 }],
      ]),
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
        inverter.disconnect();
        f.disconnect();
      },
    };
  },
};
