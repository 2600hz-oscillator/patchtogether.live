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
// under Ports → moogafakkin (the shared bucket, mirroring the 921 VCO).
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
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog904aVcfCard',
  domain: 'audio',
  label: '904a vcf',
  category: 'filters',

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

  docs: {
    explanation:
      "A clean-room recreation of the Moog 904A Voltage Controlled Low Pass Filter — the iconic 24 dB/octave transistor-ladder LPF at the heart of the Moog sound. It rolls off everything above the cutoff at a steep four-pole slope, warming and darkening the signal. The CUTOFF knob sets the corner, the RANGE switch shifts that corner in two-octave steps, and REGENERATION is the resonance (internal feedback): turn it up to emphasise the band right at the cutoff, and near maximum the filter self-oscillates into a clean sine — a playable voltage-controlled oscillator in its own right. A summing 1 V/octave control input sweeps the cutoff (patch an envelope or LFO here for the classic filter sweep) and a second CV input modulates the regeneration. The ladder core is the textbook zero-delay-feedback algorithm with a tanh per loop for the analog drive, not a port of any Moog schematic.",
    inputs: {
      audio: "The signal to be filtered — the audio fed into the ladder.",
      cutoff_cv: "Summing 1 V/octave CONTROL INPUT to the cutoff (audio-rate). It adds exponentially onto the CUTOFF knob inside the worklet, so this is the jack for the classic filter sweep — an envelope opens/closes the corner, an LFO wobbles it, a pitch CV makes the cutoff track played notes.",
      reso_cv: "CONTROL INPUT to REGENERATION (audio-rate, summed per-sample). Modulate the resonance — e.g. an envelope that pushes the filter toward self-oscillation on each note for a chirp or zap.",
    },
    outputs: {
      audio: "The 24 dB/octave low-passed output. With REGENERATION near maximum and nothing patched in, it emits a clean self-oscillating sine at the cutoff frequency.",
    },
    controls: {
      cutoff: "The FIXED CONTROL VOLTAGE pot — the filter's corner frequency, 20 Hz to 20 kHz on a log taper. Everything above it is attenuated at the four-pole slope; lower it to darken, raise it to open up. CV adds on top of this setting. Defaults to 1 kHz.",
      range: "RANGE switch (1 / 2 / 3) — shifts the whole cutoff sweep in two-octave steps, so you can place the CUTOFF pot's travel in the bass, mids, or highs. Defaults to position 2 (the middle range).",
      regeneration: "REGENERATION — the resonance / internal feedback (variable Q). At 0 the filter is flat; turning it up emphasises a peak at the cutoff; near 1 the filter self-oscillates and rings as a sine VCO. Defaults to 0 (no resonance).",
    },
  },

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
