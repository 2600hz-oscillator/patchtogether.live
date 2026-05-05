import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@inet.modular/dsp/dist/reverb.wasm?url';
import metaUrl from '@inet.modular/dsp/dist/reverb.json?url';

const PARAM_PREFIX = '/Reverb';

export const reverbDef: AudioModuleDef = {
  type: 'reverb',
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
    const f = await instantiateFaustModule(ctx, { name: 'reverb', wasmUrl, metaUrl });
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
