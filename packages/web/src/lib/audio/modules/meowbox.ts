// packages/web/src/lib/audio/modules/meowbox.ts
//
// MEOWBOX — gate-triggered cat-vocal synth voice. Faust DSP — formant bank +
// harmonic+noise excitation + stereo decorrelation tail. See drummergirl.ts
// for the closest reference (similar gate-triggered all-in-one voice shape).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/meowbox.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/meowbox.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/meowbox.worklet.js?url';

const PARAM_PREFIX = '/MEOWBOX';

export const meowboxDef: AudioModuleDef = {
  type: 'meowbox',
  domain: 'audio',
  label: 'MEOWBOX',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'gate',  type: 'gate' },
    { id: 'pitch', type: 'cv',   paramTarget: 'pitch' },
    { id: 'morph', type: 'cv',   paramTarget: 'morph' },
    { id: 'decay', type: 'cv',   paramTarget: 'decay' },
    { id: 'level', type: 'cv',   paramTarget: 'level' },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  params: [
    { id: 'pitch', label: 'Ptch',  defaultValue: 0,    min: -36,   max: 36,  curve: 'linear', units: 'semi' },
    { id: 'morph', label: 'Morph', defaultValue: 0.25, min: 0,     max: 1,   curve: 'linear' },
    { id: 'decay', label: 'Dcy',   defaultValue: 0.4,  min: 0.05,  max: 2,   curve: 'log',    units: 's' },
    { id: 'level', label: 'Lvl',   defaultValue: 1,    min: 0,     max: 2,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'meowbox', wasmUrl, metaUrl, workletUrl });
    // Single audio-rate input (gate). Splitter pulls L/R out of the stereo
    // Faust output.
    const merger = ctx.createChannelMerger(1);
    merger.connect(f);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);

    const splitter = ctx.createChannelSplitter(2);
    f.connect(splitter);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of meowboxDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pPitch = params.get(`${PARAM_PREFIX}/pitch`);
    const pMorph = params.get(`${PARAM_PREFIX}/morph`);
    const pDecay = params.get(`${PARAM_PREFIX}/decay`);
    const pLevel = params.get(`${PARAM_PREFIX}/level`);

    return {
      domain: 'audio',
      inputs: new Map([
        ['gate',  { node: merger, input: 0 }],
        ['pitch', { node: f, input: 0, param: pPitch! }],
        ['morph', { node: f, input: 0, param: pMorph! }],
        ['decay', { node: f, input: 0, param: pDecay! }],
        ['level', { node: f, input: 0, param: pLevel! }],
      ]),
      outputs: new Map([
        ['L', { node: splitter, output: 0 }],
        ['R', { node: splitter, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* */ }
        silence.disconnect();
        merger.disconnect();
        splitter.disconnect();
        f.disconnect();
      },
    };
  },
};
