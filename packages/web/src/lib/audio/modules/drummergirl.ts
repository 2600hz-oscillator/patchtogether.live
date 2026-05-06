import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@inet.modular/dsp/dist/drummergirl.wasm?url';
import metaUrl from '@inet.modular/dsp/dist/drummergirl.json?url';
import workletUrl from '@inet.modular/dsp/dist/drummergirl.worklet.js?url';

const PARAM_PREFIX = '/DRUMMERGIRL';

export const drummergirlDef: AudioModuleDef = {
  type: 'drummergirl',
  domain: 'audio',
  label: 'DRUMMERGIRL',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'gate',  type: 'gate' },
    { id: 'pitch', type: 'cv', paramTarget: 'pitch' },
    { id: 'tone',  type: 'cv', paramTarget: 'tone' },
    { id: 'shape', type: 'cv', paramTarget: 'shape' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'pitch', label: 'Pitch', defaultValue: 0,   min: -36, max: 36, curve: 'linear', units: 'semi' },
    { id: 'tone',  label: 'Tone',  defaultValue: 0.3, min: 0,   max: 1,  curve: 'linear' },
    { id: 'shape', label: 'Shape', defaultValue: 0.3, min: 0,   max: 1,  curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'drummergirl', wasmUrl, metaUrl, workletUrl });
    // Single audio-rate input (gate). Use a 1-channel merger with silence so
    // the worklet stays active even with nothing patched in.
    const merger = ctx.createChannelMerger(1);
    merger.connect(f);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of drummergirlDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pPitch = params.get(`${PARAM_PREFIX}/pitch`);
    const pTone  = params.get(`${PARAM_PREFIX}/tone`);
    const pShape = params.get(`${PARAM_PREFIX}/shape`);

    return {
      domain: 'audio',
      inputs: new Map([
        ['gate',  { node: merger, input: 0 }],
        ['pitch', { node: f, input: 0, param: pPitch! }],
        ['tone',  { node: f, input: 0, param: pTone! }],
        ['shape', { node: f, input: 0, param: pShape! }],
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
