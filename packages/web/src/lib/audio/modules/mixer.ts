import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/mixer.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/mixer.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/mixer.worklet.js?url';

const PARAM_PREFIX = '/Mixer';

export const mixerDef: AudioModuleDef = {
  type: 'mixer',
  domain: 'audio',
  label: 'Mixer',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [
    { id: 'in1', type: 'audio' },
    { id: 'in2', type: 'audio' },
    { id: 'in3', type: 'audio' },
    { id: 'in4', type: 'audio' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'ch1',    label: 'Ch1',    defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'ch2',    label: 'Ch2',    defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'ch3',    label: 'Ch3',    defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'ch4',    label: 'Ch4',    defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'master', label: 'Master', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'mixer', wasmUrl, metaUrl, workletUrl });
    const merger = ctx.createChannelMerger(4);
    merger.connect(f);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of mixerDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    return {
      domain: 'audio',
      inputs: new Map([
        ['in1', { node: merger, input: 0 }],
        ['in2', { node: merger, input: 1 }],
        ['in3', { node: merger, input: 2 }],
        ['in4', { node: merger, input: 3 }],
      ]),
      outputs: new Map([['audio', { node: f, output: 0 }]]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        merger.disconnect();
        f.disconnect();
      },
    };
  },
};
