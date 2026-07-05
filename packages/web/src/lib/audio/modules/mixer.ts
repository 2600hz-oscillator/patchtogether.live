// packages/web/src/lib/audio/modules/mixer.ts
//
// MIXER — 4-channel mono summing mixer with master gain.
//
// Four audio inputs, per-channel level knob, and a master gain on the sum.
// No EQ, no panning, no aux sends — the simple "stack four signals into
// one bus" utility. For stereo/EQ/sends use MIXMSTRS; for unity-attenuator
// summing with direct outs use ATTENUMIX or VEILS. The DSP is Faust-
// compiled (packages/dsp/src/mixer.dsp) and the four inputs are routed
// onto distinct channels of the Faust node via a ChannelMerger.
//
// Inputs:
//   in1..in4 (audio): the four channels to sum.
//
// Outputs:
//   audio (audio): the summed bus (in1*ch1 + in2*ch2 + in3*ch3 + in4*ch4) * master.
//
// Params:
//   ch1..ch4 (linear 0..1, default 1): per-channel level.
//   master (linear 0..1, default 1): bus output gain.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/mixer.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/mixer.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/mixer.worklet.js?url';

const PARAM_PREFIX = '/Mixer';

export const mixerDef: AudioModuleDef = {
  type: 'mixer',
  palette: { top: 'Audio modules', sub: 'Mixing' },
  domain: 'audio',
  label: 'mixer',
  category: 'utilities',
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

  docs: {
    explanation:
      "A simple 4-channel summing mixer: patches four independent audio inputs to a bus where each channel has its own level control, then a master gain shapes the final mixed output. Mental model: stack four signals on top of each other, set each one's volume independently, then turn the master knob to set how loud the whole mix is.",
    inputs: {
      in1: "Audio input for channel 1; its level is set by the Ch1 fader.",
      in2: "Audio input for channel 2; its level is set by the Ch2 fader.",
      in3: "Audio input for channel 3; its level is set by the Ch3 fader.",
      in4: "Audio input for channel 4; its level is set by the Ch4 fader.",
    },
    outputs: {
      audio:
        "The mixed bus: the sum of all four channels (each scaled by its level fader) attenuated by the master gain. Goes silent when all four channels are at 0 or master is at 0.",
    },
    controls: {
      ch1: "Channel 1 level — how loud or quiet channel 1 is in the mix, from mute (0) to full (1).",
      ch2: "Channel 2 level — how loud or quiet channel 2 is in the mix, from mute (0) to full (1).",
      ch3: "Channel 3 level — how loud or quiet channel 3 is in the mix, from mute (0) to full (1).",
      ch4: "Channel 4 level — how loud or quiet channel 4 is in the mix, from mute (0) to full (1).",
      master:
        "Master gain on the mixed bus — scales the whole summed signal from silence (0) to unity (1). Turning it down fades all four channels together without changing their relative balance.",
    },
  },

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
