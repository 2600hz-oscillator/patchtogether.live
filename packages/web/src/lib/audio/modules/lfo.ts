// packages/web/src/lib/audio/modules/lfo.ts
//
// Module def for the clockable LFO. DSP is a custom JS AudioWorklet
// (packages/dsp/src/lfo.ts). Four outputs at 0°/90°/180°/270° let one LFO
// drive multiple voices in stereo / quadrature without needing to re-tune.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/lfo.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const lfoDef: AudioModuleDef = {
  type: 'lfo',
  domain: 'audio',
  label: 'LFO',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    { id: 'clock', type: 'gate' },
    // CV → AudioParam routing: patching here sums into the param's intrinsic
    // value at audio rate, and the corresponding fader's motorized poll
    // visibly tracks the modulation.
    { id: 'rate',  type: 'cv', paramTarget: 'rate'  },
    { id: 'shape', type: 'cv', paramTarget: 'shape' },
  ],
  outputs: [
    { id: 'phase0',   type: 'cv' },
    { id: 'phase90',  type: 'cv' },
    { id: 'phase180', type: 'cv' },
    { id: 'phase270', type: 'cv' },
  ],
  params: [
    { id: 'rate',  label: 'Rate',  defaultValue: 1, min: 0.01, max: 100, curve: 'log', units: 'Hz' },
    { id: 'shape', label: 'Shape', defaultValue: 0, min: 0,    max: 2,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'lfo', {
      numberOfInputs: 1,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of lfoDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const rateParam = params.get('rate');
    const shapeParam = params.get('shape');

    return {
      domain: 'audio',
      inputs: new Map([
        ['clock', { node: workletNode, input: 0 }],
        ['rate',  { node: workletNode, input: 0, param: rateParam! }],
        ['shape', { node: workletNode, input: 0, param: shapeParam! }],
      ]),
      outputs: new Map([
        ['phase0',   { node: workletNode, output: 0 }],
        ['phase90',  { node: workletNode, output: 1 }],
        ['phase180', { node: workletNode, output: 2 }],
        ['phase270', { node: workletNode, output: 3 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        workletNode.disconnect();
      },
    };
  },
};
