// packages/web/src/lib/audio/modules/moog995.ts
//
// MOOG 995 ATTENUATORS — a slice of the Moog System 55 / 35 clone initiative
// (.myrobots/MOOG/). The 995 is a PASSIVE utility panel: three INDEPENDENT
// variable attenuators. Each channel is just a level pot that scales its input
// from full mute (0) up to unity (1) — never boosting. No mixing, no summing,
// no CV: three parallel "turn it down" knobs. Shared by SYS55 + SYS35
// (categorized under Ports → moogafakkin, the shared bucket, mirroring the CP3).
//
// DSP: NONE. This is a pure Web Audio graph — three GainNodes — so there's no
// worklet and no Faust .dsp. Passive attenuation maps exactly onto a GainNode
// whose gain ∈ [0, 1] (the gain knob never exceeds unity, faithful to the
// passive panel which can only attenuate). Mirrors the pure-gain factory
// pattern used by ATTENUMIX / MIXER's GainNode/merger graphs.
//
// Inputs:
//   in1 / in2 / in3 (audio): the three independent channel inputs. Each is the
//     SIGNAL being attenuated; it feeds its channel's GainNode directly.
//
// Outputs:
//   out1 / out2 / out3 (audio): the three post-attenuator outputs, one per
//     channel (out_N = in_N × atten_N). Fully independent — no cross-talk.
//
// Params:
//   atten1 / atten2 / atten3 (linear 0..1, default 1): per-channel attenuator
//     level. 1.0 = unity (direct patch passes unaltered), 0 = full mute.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

export const moog995Def: AudioModuleDef = {
  type: 'moog995',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '995 atten',
  category: 'utilities',
  schemaVersion: 1,

  inputs: [
    { id: 'in1', type: 'audio' },
    { id: 'in2', type: 'audio' },
    { id: 'in3', type: 'audio' },
  ],
  outputs: [
    { id: 'out1', type: 'audio' },
    { id: 'out2', type: 'audio' },
    { id: 'out3', type: 'audio' },
  ],
  params: [
    // Each attenuator caps at unity — passive panels only attenuate, never
    // boost. Default 1.0 so a freshly spawned 995 passes a direct patch
    // through unaltered until the user dials a channel down.
    { id: 'atten1', label: 'Att 1', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'atten2', label: 'Att 2', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
    { id: 'atten3', label: 'Att 3', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Three independent passive attenuator channels: in_N → GainNode → out_N.
    const gain1 = ctx.createGain();
    const gain2 = ctx.createGain();
    const gain3 = ctx.createGain();
    const gains: Record<string, GainNode> = {
      atten1: gain1,
      atten2: gain2,
      atten3: gain3,
    };

    // Apply initial param values (saved patch overrides, else def defaults).
    const initial = node.params ?? {};
    for (const def of moog995Def.params) {
      const v = initial[def.id] ?? def.defaultValue;
      gains[def.id]!.gain.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in1', { node: gain1, input: 0 }],
        ['in2', { node: gain2, input: 0 }],
        ['in3', { node: gain3, input: 0 }],
      ]),
      outputs: new Map([
        ['out1', { node: gain1, output: 0 }],
        ['out2', { node: gain2, output: 0 }],
        ['out3', { node: gain3, output: 0 }],
      ]),
      setParam(paramId, value) {
        gains[paramId]?.gain.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return gains[paramId]?.gain.value;
      },
      dispose() {
        try { gain1.disconnect(); } catch { /* */ }
        try { gain2.disconnect(); } catch { /* */ }
        try { gain3.disconnect(); } catch { /* */ }
      },
    };
  },
};
