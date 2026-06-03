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
  label: 'Reverb',
  category: 'effects',
  schemaVersion: 1,
  inputs: [{ id: 'audio', type: 'audio' }],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'size', label: 'Size', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'damp', label: 'Damp', defaultValue: 0.3, min: 0, max: 1, curve: 'linear' },
    { id: 'mix',  label: 'Mix',  defaultValue: 0.3, min: 0, max: 1, curve: 'linear' },
  ],

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
