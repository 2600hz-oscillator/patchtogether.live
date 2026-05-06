import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@inet.modular/dsp/dist/destroy.wasm?url';
import metaUrl from '@inet.modular/dsp/dist/destroy.json?url';
import workletUrl from '@inet.modular/dsp/dist/destroy.worklet.js?url';

const PARAM_PREFIX = '/DESTROY';

export const destroyDef: AudioModuleDef = {
  type: 'destroy',
  domain: 'audio',
  label: 'DESTROY',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'audio',    type: 'audio' },
    { id: 'decimate', type: 'cv', paramTarget: 'decimate' },
    { id: 'bits',     type: 'cv', paramTarget: 'bits' },
    { id: 'wet',      type: 'cv', paramTarget: 'wet' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'decimate', label: 'Dec',  defaultValue: 1,  min: 1, max: 64, curve: 'linear' },
    { id: 'bits',     label: 'Bits', defaultValue: 16, min: 1, max: 16, curve: 'linear' },
    { id: 'wet',      label: 'Wet',  defaultValue: 1,  min: 0, max: 1,  curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'destroy', wasmUrl, metaUrl, workletUrl });
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(f);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of destroyDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pDecimate = params.get(`${PARAM_PREFIX}/decimate`);
    const pBits     = params.get(`${PARAM_PREFIX}/bits`);
    const pWet      = params.get(`${PARAM_PREFIX}/wet`);
    return {
      domain: 'audio',
      inputs: new Map([
        ['audio',    { node: f, input: 0 }],
        ['decimate', { node: f, input: 0, param: pDecimate! }],
        ['bits',     { node: f, input: 0, param: pBits! }],
        ['wet',      { node: f, input: 0, param: pWet! }],
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
        f.disconnect();
      },
    };
  },
};
