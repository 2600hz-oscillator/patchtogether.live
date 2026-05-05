import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@inet.modular/dsp/dist/vca.wasm?url';
import metaUrl from '@inet.modular/dsp/dist/vca.json?url';

const PARAM_PREFIX = '/VCA';

export const vcaDef: AudioModuleDef = {
  type: 'vca',
  domain: 'audio',
  label: 'VCA',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [
    { id: 'audio', type: 'audio' },
    { id: 'cv', type: 'cv' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'base',     label: 'Base', defaultValue: 0,   min:  0, max: 1, curve: 'linear' },
    { id: 'cvAmount', label: 'CV',   defaultValue: 1.0, min: -1, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'vca', wasmUrl, metaUrl });
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
    return {
      domain: 'audio',
      inputs: new Map([
        ['audio', { node: merger, input: 0 }],
        ['cv',    { node: merger, input: 1 }],
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
