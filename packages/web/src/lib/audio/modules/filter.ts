import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/filter.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/filter.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/filter.worklet.js?url';

const PARAM_PREFIX = '/Filter';

export const filterDef: AudioModuleDef = {
  type: 'filter',
  domain: 'audio',
  label: 'Filter',
  category: 'filters',
  schemaVersion: 1,
  inputs: [
    { id: 'audio',  type: 'audio' },
    { id: 'cutoff', type: 'cv' },
    { id: 'res',    type: 'cv' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'cutoff',    label: 'Cutoff', defaultValue: 1000, min: 20,   max: 20000, curve: 'log',      units: 'Hz' },
    { id: 'resonance', label: 'Res',    defaultValue: 0.1,  min: 0,    max: 0.99,  curve: 'linear' },
    { id: 'mode',      label: 'Mode',   defaultValue: 0,    min: 0,    max: 2,     curve: 'discrete' },
  ],

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
