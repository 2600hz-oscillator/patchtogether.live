// packages/web/src/lib/audio/modules/gatemaiden.ts
//
// GATEMAIDEN — single-input gate↔trigger converter. ONE generic CV input → a
// GATE output AND a TRIGGER output, derived from the input's level + rising
// edges (no mode switch). The convenience utility for the trigger/gate model:
//
//   - trigger in  → `trig` passes through (one pulse per input pulse); `gate`
//                   emits a short gate (>= gateLen) starting at the strike.
//   - gate in     → `gate` passes through (held while high); `trig` fires once
//                   per gate START (rising edge → one trigger).
//
// DSP lives in packages/dsp/src/gatemaiden.ts (custom JS AudioWorklet); the
// per-sample logic is pure + unit-tested in dsp/src/lib/gatemaiden-dsp.ts.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/gatemaiden.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const gatemaidenDef: AudioModuleDef = {
  type: 'gatemaiden',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'gatemaiden',
  category: 'utility',
  schemaVersion: 1,
  inputs: [
    // Generic CV input: accepts a gate OR a trigger and derives both outputs.
    // Declared `edge: 'gate'` because it READS the input level (for the gate
    // passthrough) while internally also edge-detecting for the trigger — the
    // one principled converter exception to "one input = one semantic".
    { id: 'in', type: 'gate', edge: 'gate', accepts: ['cv', 'pitch'] },
  ],
  outputs: [
    { id: 'gate', type: 'gate', edge: 'gate' },     // held square, min width gateLen
    { id: 'trig', type: 'gate', edge: 'trigger' },  // short pulse per rising edge
  ],
  params: [
    { id: 'gateLen',   label: 'Len',   defaultValue: 0.05, min: 0.005, max: 2, curve: 'log', units: 's' },
    { id: 'trigShape', label: 'Shape', defaultValue: 0,    min: 0,     max: 1, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'gatemaiden', {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of gatemaidenDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['in', { node: workletNode, input: 0 }],
      ]),
      outputs: new Map([
        ['gate', { node: workletNode, output: 0 }],
        ['trig', { node: workletNode, output: 1 }],
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
