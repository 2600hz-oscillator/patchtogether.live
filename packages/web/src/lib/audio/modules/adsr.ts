import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@inet.modular/dsp/dist/adsr.wasm?url';
import metaUrl from '@inet.modular/dsp/dist/adsr.json?url';

const PARAM_PREFIX = '/ADSR';

export const adsrDef: AudioModuleDef = {
  type: 'adsr',
  domain: 'audio',
  label: 'ADSR',
  category: 'modulation',
  schemaVersion: 1,
  inputs: [{ id: 'gate', type: 'gate' }],
  outputs: [{ id: 'env', type: 'cv' }],
  params: [
    { id: 'attack',  label: 'A', defaultValue: 0.005, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'decay',   label: 'D', defaultValue: 0.1,   min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'sustain', label: 'S', defaultValue: 0.7,   min: 0,     max: 1,  curve: 'linear' },
    { id: 'release', label: 'R', defaultValue: 0.3,   min: 0.001, max: 10, curve: 'log', units: 's' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'adsr', wasmUrl, metaUrl });
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(f);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of adsrDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    return {
      domain: 'audio',
      inputs: new Map([['gate', { node: f, input: 0 }]]),
      outputs: new Map([['env', { node: f, output: 0 }]]),
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
