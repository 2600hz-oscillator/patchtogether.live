// packages/web/src/lib/audio/modules/charlottes-echos.ts
//
// CHARLOTTE'S ECHOS — destructive multi-head stereo delay. TS AudioWorklet.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/charlottes-echos.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const charlottesEchosDef: AudioModuleDef = {
  type: 'charlottesEchos',
  domain: 'audio',
  label: "CHARLOTTE'S ECHOS",
  category: 'effects',
  schemaVersion: 1,
  stereoPairs: [['L', 'R']],

  inputs: [
    { id: 'L',     type: 'audio' },
    { id: 'R',     type: 'audio' },
    { id: 'delay', type: 'cv', paramTarget: 'delay' },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  params: [
    { id: 'delay',    label: 'Delay',  defaultValue: 0.4, min: 0.001, max: 1.5, curve: 'log',    units: 's' },
    { id: 'feedback', label: 'Fbk',    defaultValue: 0.5, min: 0,     max: 1,   curve: 'linear' },
    { id: 'decay',    label: 'Decay',  defaultValue: 0.2, min: 0,     max: 1,   curve: 'linear' },
    { id: 'pitchUp',  label: 'Ptch',   defaultValue: 0,   min: 0,     max: 0.2, curve: 'linear' },
    { id: 'mix',      label: 'Mix',    defaultValue: 0.5, min: 0,     max: 1,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'charlottes-echos', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Silence keeps the node active even when nothing is patched in.
    const silenceL = ctx.createConstantSource();
    const silenceR = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceR.offset.value = 0;
    silenceL.start();
    silenceR.start();
    silenceL.connect(workletNode, 0, 0);
    silenceR.connect(workletNode, 0, 1);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of charlottesEchosDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    const pDelay = params.get('delay');
    const pFb = params.get('feedback');
    const pDecay = params.get('decay');
    const pPitch = params.get('pitchUp');
    const pMix = params.get('mix');

    return {
      domain: 'audio',
      inputs: new Map([
        ['L',     { node: workletNode, input: 0 }],
        ['R',     { node: workletNode, input: 1 }],
        ['delay', { node: workletNode, input: 0, param: pDelay! }],
      ]),
      outputs: new Map([
        ['L', { node: workletNode, output: 0 }],
        ['R', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
