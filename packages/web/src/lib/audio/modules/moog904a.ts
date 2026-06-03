// packages/web/src/lib/audio/modules/moog904a.ts
//
// MOOG 904A — Voltage Controlled Low Pass Filter (slice 2 of the Moog
// System 55 / 35 clone initiative, .myrobots/MOOG/). The classic Moog
// transistor-ladder LPF: 24 dB/oct, with a FIXED CONTROL VOLTAGE (cutoff)
// pot, a RANGE switch (shifts cutoff in 2-octave steps), summed 1 V/oct
// CONTROL INPUTS, and a REGENERATION pot (variable Q / internal feedback)
// that self-oscillates into a clean sine VC generator near max.
//
// The 904A appears in BOTH systems (S35×1, S55×2) → shared → categorized
// under Clones → moogafakkin (the shared bucket, mirroring the 921 VCO).
//
// DSP: own-code, CLEAN-ROOM transistor-ladder core
// (packages/dsp/src/moog904a.ts + lib/moog-ladder-dsp.ts) — re-derived from
// the unpatented textbook TPT/Zavalishin zero-delay-feedback algorithm plus
// the Huovilainen tanh-per-loop TECHNIQUE. NOT a port of the LGPLv3
// Huovilainen code, the CC-BY-SA musicdsp model, or any Moog schematic
// (.myrobots/MOOG/LICENSING.md: permissive / own-code only). The same lib
// is reused by 904B (HPF) + 904C (coupler) in later slices.
//
// Inputs:
//   audio (audio): signal to be filtered.
//   cutoff_cv (cv, paramTarget=cutoff): summing 1 V/oct CONTROL INPUT —
//     audio-rate, summed (exponentially) onto the cutoff in the worklet
//     (PASSTHROUGH — the worklet applies the 1 V/oct map per-sample).
//   reso_cv (cv, paramTarget=regeneration): REGENERATION CV — audio-rate,
//     summed onto the regeneration knob per-sample in the worklet
//     (PASSTHROUGH).
//
// Outputs:
//   audio (audio): 24 dB/oct low-pass output (self-oscillating sine near
//     regeneration=1).
//
// Params:
//   cutoff (log 20..20000 Hz, default 1000): FIXED CONTROL VOLTAGE pot.
//   range (discrete 1..3, default 2): RANGE switch — 2-octave steps.
//   regeneration (linear 0..1, default 0): variable Q / internal feedback.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog904a.js?url';

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog904aDef: AudioModuleDef = {
  type: 'moog904a',
  palette: { top: 'Clones', sub: 'moogafakkin' },
  card: 'Moog904aVcfCard',
  domain: 'audio',
  label: 'moogafakkin 904A VCF',
  category: 'filters',
  schemaVersion: 1,

  inputs: [
    { id: 'audio', type: 'audio' },
    // cutoff_cv + reso_cv are audio-rate CONTROL INPUTS (the worklet sums
    // knob + CV per-sample with the 1 V/oct map), so they don't go through
    // the CV→AudioParam fast path. paramTarget keeps docs labelling correct;
    // no cvScale (PASSTHROUGH_BY_DESIGN, like the 921's width_cv).
    { id: 'cutoff_cv', type: 'cv', paramTarget: 'cutoff' },
    { id: 'reso_cv', type: 'cv', paramTarget: 'regeneration' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'cutoff', label: 'Cutoff', defaultValue: 1000, min: 20, max: 20000, curve: 'log', units: 'Hz' },
    { id: 'range', label: 'Range', defaultValue: 2, min: 1, max: 3, curve: 'discrete' },
    { id: 'regeneration', label: 'Regen', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'moog904a', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 VCO + analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);
    silence.connect(workletNode, 0, 2);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog904aDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio', { node: workletNode, input: 0 }],
        ['cutoff_cv', { node: workletNode, input: 1 }],
        ['reso_cv', { node: workletNode, input: 2 }],
      ]),
      outputs: new Map([['audio', { node: workletNode, output: 0 }]]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
