// packages/web/src/lib/audio/modules/reverb.ts
//
// REVERB — simple algorithmic reverb (size / damp / mix).
//
// The minimal-knob reverb the basic palette ships. Faust-compiled DSP
// (packages/dsp/src/reverb.dsp) — a generic small-knob algorithmic tank
// suitable for "spray a little room on the master bus" use. For longer,
// richer, or pitch-shifted tails see SHIMMERSHINE; for serious user-
// tweakable diffusion settings see CLOUDSEED. Mono in / mono out (use
// two instances or a stereo reverb if you need width). No CV inputs in
// v1; the three knobs are the entire user surface.
//
// Inputs:
//   audio (audio): dry signal.
//
// Outputs:
//   audio (audio): dry + wet, ratio set by mix.
//
// Params:
//   size (linear 0..1, default 0.5): tank size / decay-time macro.
//   damp (linear 0..1, default 0.3): high-frequency damping inside the tank.
//   mix (linear 0..1, default 0.3): dry / wet balance (0 = dry, 1 = wet only).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/reverb.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/reverb.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/reverb.worklet.js?url';

const PARAM_PREFIX = '/Reverb';

export const reverbDef: AudioModuleDef = {
  type: 'reverb',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'reverb',
  category: 'effects',
  schemaVersion: 1,
  inputs: [{ id: 'audio', type: 'audio' }],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'size', label: 'Size', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'damp', label: 'Damp', defaultValue: 0.3, min: 0, max: 1, curve: 'linear' },
    { id: 'mix',  label: 'Mix',  defaultValue: 0.3, min: 0, max: 1, curve: 'linear' },
  ],

  docs: {
    explanation:
      "A simple algorithmic reverb — the minimal-knob room you reach for to 'spray a little space' on a sound or a master bus. A Faust-compiled tank diffuses the input into a decaying reflection cloud whose length you set with SIZE and whose tone you tame with DAMP, then blends that wet tail back against the dry signal with MIX. Mono in / mono out, three knobs, no CV: use two instances (or feed it from a stereo split) if you want width. For a long crystalline octave-up tail reach for SHIMMERSHINE; for a deeply tweakable diffusion engine reach for CLOUDSEED.",
    inputs: {
      audio: 'The dry mono signal fed into the reverb tank. Whatever you patch here is diffused into the reflection cloud and also passed straight to the dry side of the MIX blend.',
    },
    outputs: {
      audio: "The mono output: the dry signal and the reverb tail summed in the proportion set by MIX (at MIX=0 you hear only the dry input; at MIX=1 only the wet tank). The tail's length and brightness follow SIZE and DAMP.",
    },
    controls: {
      size: 'Tank size / decay-time macro (0..1). Low values give a short, tight room that dies away fast; high values stretch the tank into a long hall-like tail. This is the single "how big is the space" control.',
      damp: 'High-frequency damping inside the tank (0..1). At 0 the tail stays bright and metallic; turning it up rolls off the highs as the reverb decays, for a warmer, darker, more natural-sounding room that doesn\'t hiss.',
      mix: 'Dry / wet balance (0..1). 0 is the untouched dry signal, 1 is reverb only, and values between crossfade the two — set it low on a master bus for a touch of air, high on a send for a fully wet ambience.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'reverb', wasmUrl, metaUrl, workletUrl });
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(f);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of reverbDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    return {
      domain: 'audio',
      inputs: new Map([['audio', { node: f, input: 0 }]]),
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
        f.disconnect();
      },
    };
  },
};
