// packages/web/src/lib/audio/modules/slewswitch.ts
//
// SLEWSWITCH — quad slew limiter + 4→1 sequential CV switch.
// One of the three ATLANTIS-PATCH support modules; useful far beyond
// the Atlantis demo as a general CV smoother + router.
//
// DSP lives in packages/dsp/src/slewswitch.ts (custom JS AudioWorklet).
//
// Inputs:
//   in1..in4 (cv): four CV inputs for the per-channel slew limiter.
//   step_clock (gate): rising edge advances the 4→1 sequential switch index.
//   reset (gate): rising edge resets the switch index to 0.
//   slew1..slew4_cv (cv, log, paramTarget=slew{N}): per-channel slew-time CV.
//
// Outputs:
//   out1..out4 (cv): per-channel slewed direct outputs.
//   switched (cv): the slewed signal at the currently-selected index (4→1 sequential switch).
//   step_idx (cv): the current switch index (-1..+1 scaled to 0..length).
//   eoc (gate): one-pulse end-of-cycle when the switch wraps.
//
// Params:
//   slew1..slew4 (log 0.001..5 s, default 0.5): per-channel slew time.
//   mode (discrete 0..2, default 0): switch mode (forward / reverse / ping-pong).
//   length (discrete 1..4, default 4): active switch length.
//   xfadeTime (log 0.001..2 s, default 0.05): smoothing on the switch index crossfade.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/slewswitch.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const slewSwitchDef: AudioModuleDef = {
  type: 'slewSwitch',
  domain: 'audio',
  label: 'SLEWSWITCH',
  category: 'utility',
  schemaVersion: 1,
  inputs: [
    { id: 'in1',        type: 'cv' },
    { id: 'in2',        type: 'cv' },
    { id: 'in3',        type: 'cv' },
    { id: 'in4',        type: 'cv' },
    { id: 'step_clock', type: 'gate' },
    { id: 'reset',      type: 'gate' },
    // CV → AudioParam routings (engine sums the cv into these AudioParams).
    // slew*: log because time constants span 3 decades (1ms..5s).
    { id: 'slew1_cv',   type: 'cv', paramTarget: 'slew1', cvScale: { mode: 'log' } },
    { id: 'slew2_cv',   type: 'cv', paramTarget: 'slew2', cvScale: { mode: 'log' } },
    { id: 'slew3_cv',   type: 'cv', paramTarget: 'slew3', cvScale: { mode: 'log' } },
    { id: 'slew4_cv',   type: 'cv', paramTarget: 'slew4', cvScale: { mode: 'log' } },
  ],
  outputs: [
    { id: 'out1',     type: 'cv' },
    { id: 'out2',     type: 'cv' },
    { id: 'out3',     type: 'cv' },
    { id: 'out4',     type: 'cv' },
    { id: 'switched', type: 'cv' },
    { id: 'step_idx', type: 'cv' },
    { id: 'eoc',      type: 'gate' },
  ],
  params: [
    { id: 'slew1',     label: 'S1',    defaultValue: 0.5,  min: 0.001, max: 5,   curve: 'log',      units: 's' },
    { id: 'slew2',     label: 'S2',    defaultValue: 0.5,  min: 0.001, max: 5,   curve: 'log',      units: 's' },
    { id: 'slew3',     label: 'S3',    defaultValue: 0.5,  min: 0.001, max: 5,   curve: 'log',      units: 's' },
    { id: 'slew4',     label: 'S4',    defaultValue: 0.5,  min: 0.001, max: 5,   curve: 'log',      units: 's' },
    { id: 'mode',      label: 'Mode',  defaultValue: 0,    min: 0,     max: 2,   curve: 'discrete' },
    { id: 'length',    label: 'Len',   defaultValue: 4,    min: 1,     max: 4,   curve: 'discrete' },
    { id: 'xfadeTime', label: 'Xfd',   defaultValue: 0.05, min: 0.001, max: 2,   curve: 'log',      units: 's' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // Seed each instance's PRNG from a hash of node.id so two SLEWSWITCH
    // instances in the same patch make independent (deterministic) random
    // selections — same precedent BUGGLES uses.
    let seed = 0;
    for (let i = 0; i < node.id.length; i++) {
      seed = ((seed << 5) - seed + node.id.charCodeAt(i)) | 0;
    }
    seed = (seed >>> 0) || 1;

    const workletNode = new AudioWorkletNode(ctx, 'slewswitch', {
      numberOfInputs: 6,
      numberOfOutputs: 7,
      outputChannelCount: [1, 1, 1, 1, 1, 1, 1],
      processorOptions: { seed },
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of slewSwitchDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['in1',        { node: workletNode, input: 0 }],
        ['in2',        { node: workletNode, input: 1 }],
        ['in3',        { node: workletNode, input: 2 }],
        ['in4',        { node: workletNode, input: 3 }],
        ['step_clock', { node: workletNode, input: 4 }],
        ['reset',      { node: workletNode, input: 5 }],
        // CV → AudioParam fast paths.
        ['slew1_cv',   { node: workletNode, input: 0, param: params.get('slew1')! }],
        ['slew2_cv',   { node: workletNode, input: 0, param: params.get('slew2')! }],
        ['slew3_cv',   { node: workletNode, input: 0, param: params.get('slew3')! }],
        ['slew4_cv',   { node: workletNode, input: 0, param: params.get('slew4')! }],
      ]),
      outputs: new Map([
        ['out1',     { node: workletNode, output: 0 }],
        ['out2',     { node: workletNode, output: 1 }],
        ['out3',     { node: workletNode, output: 2 }],
        ['out4',     { node: workletNode, output: 3 }],
        ['switched', { node: workletNode, output: 4 }],
        ['step_idx', { node: workletNode, output: 5 }],
        ['eoc',      { node: workletNode, output: 6 }],
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
