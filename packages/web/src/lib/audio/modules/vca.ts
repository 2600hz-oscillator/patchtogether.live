// packages/web/src/lib/audio/modules/vca.ts
//
// VCA — voltage-controlled amplifier (mono).
//
// The standard Eurorack utility module: a single audio input multiplied by
// `base + cvAmount * cv`. With nothing patched into CV and base=0 the VCA
// is silent; with CV held at +1 and cvAmount=1 it passes the audio through
// at unity. Faust-compiled DSP (packages/dsp/src/vca.dsp). A parallel
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
//   base (linear 0..1, default 0): static DC offset added to CV (unity gain when 1).
//   cvAmount (linear -1..1, default 1): scale + sign of the CV input; negative inverts the CV.

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
  schemaVersion: 1,
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
    { id: 'base',     label: 'Base', defaultValue: 0,   min:  0, max: 1, curve: 'linear' },
    { id: 'cvAmount', label: 'CV',   defaultValue: 1.0, min: -1, max: 1, curve: 'linear' },
  ],

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
