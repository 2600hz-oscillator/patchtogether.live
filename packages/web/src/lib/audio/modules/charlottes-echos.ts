// packages/web/src/lib/audio/modules/charlottes-echos.ts
//
// CHARLOTTE'S ECHOS — destructive multi-head stereo delay.
//
// A stereo delay with a thicker, more abused character than the basic
// DELAY: per-tap pitch-up grain, gradual feedback-loop decay, and high
// feedback ratios that smear into endless tails. The "destructive" name
// captures the intent — this is the delay you reach for when you want
// the wet path to colour and degrade the source, not stay clean. DSP is
// a TS AudioWorklet (packages/dsp/src/charlottes-echos.ts). Internally
// this is the audio sibling of VDELAY in the video domain and is the
// effect 4× COCOA DELAYs would approximate if stacked in serial.
//
// Inputs:
//   L (audio): left-channel signal.
//   R (audio): right-channel signal.
//   delay (cv, log, paramTarget=delay): scales the delay-time knob (log).
//
// Outputs:
//   L (audio): left-channel wet+dry mix.
//   R (audio): right-channel wet+dry mix.
//
// Params:
//   delay (log 0.001..1.5 s, default 0.4): tap time.
//   feedback (linear 0..1, default 0.5): feedback ratio (high ≈ infinite tails).
//   decay (linear 0..1, default 0.2): per-tap colour-decay (HF loss in the loop).
//   pitchUp (linear 0..0.2, default 0): per-tap pitch-shift on the feedback path.
//   mix (linear 0..1, default 0.5): dry/wet balance.

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
    // CV scaling per .myrobots/plans/cv-range-standard.md.
    // delay: log (0.001..1.5s).
    { id: 'delay', type: 'cv', paramTarget: 'delay', cvScale: { mode: 'log' } },
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
