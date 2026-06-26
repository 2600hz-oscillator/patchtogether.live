// packages/web/src/lib/audio/modules/moog921a.ts
//
// MOOG 921A OSCILLATOR DRIVER — Moog System 55/35 clone (batch 1, shipped
// with the 921B oscillator). A CV PROCESSOR, not a sound source: it
// generates the two CONTROL VOLTAGES on a bus that drive N slaved 921B's.
// Shared by SYS55 + SYS35 → categorized under Ports → moogafakkin (the shared
// bucket, mirroring the 921 VCO + 904A).
//
// CV-ONLY: NO audio inputs, NO audio outputs. The two outputs (freq_bus,
// width_bus) are CV cables that feed a 921B's freq_bus / width_bus inputs.
//
// DSP: own-code pure CV math (packages/dsp/src/moog921a.ts) —
// exponential frequency mapping (the freq_bus CV encodes pitch in V/oct;
// the freqRange switch sets the FREQUENCY pot's compass) + width
// passthrough. Permissive, not a port of any Moog schematic / copyleft
// source (.myrobots/MOOG/LICENSING.md).
//
// Inputs:
//   freq_cv (pitch, paramTarget=frequency): summing frequency CONTROL INPUT
//     — V/oct, audio-rate, summed onto the freq bus in the worklet
//     (PASSTHROUGH — the worklet sums knob + CV per-sample).
//   width_cv (cv, paramTarget=width): summing width CONTROL INPUT — audio-
//     rate, summed onto the width bus per-sample in the worklet
//     (PASSTHROUGH).
//
// Outputs:
//   freq_bus (cv): V/oct frequency control voltage → 921B.freq_bus.
//   width_bus (cv): 0..1 pulse-width control voltage → 921B.width_bus.
//
// Params:
//   frequency (linear -1..1, default 0): FREQUENCY pot (normalized; the
//     freqRange switch maps it onto V/oct).
//   freqRange (discrete 1..2, default 1): RANGE switch — 1 = SEMITONE
//     (2-oct compass) / 2 = OCTAVE (12-oct compass).
//   width (linear 0..1, default 0.5): pulse width passed onto width_bus.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog921a.js?url';

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog921aDef: AudioModuleDef = {
  type: 'moog921a',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '921a driver',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // freq_cv + width_cv are audio-rate summing CONTROL INPUTS (the worklet
    // sums knob + CV per-sample), so they don't go through the CV→AudioParam
    // fast path. paramTarget keeps docs labelling correct; no cvScale
    // (PASSTHROUGH_BY_DESIGN, like the 921 VCO's width_cv / the 904A's
    // cutoff_cv). freq_cv is a pitch cable (V/oct).
    { id: 'freq_cv',  type: 'pitch', paramTarget: 'frequency' },
    { id: 'width_cv', type: 'cv',    paramTarget: 'width' },
  ],
  outputs: [
    // CV bus outputs — NO audio. These feed N 921B oscillators.
    { id: 'freq_bus',  type: 'cv' },
    { id: 'width_bus', type: 'cv' },
  ],
  params: [
    { id: 'frequency', label: 'Freq',  defaultValue: 0,   min: -1, max: 1, curve: 'linear' },
    { id: 'freqRange', label: 'Range', defaultValue: 1,   min: 1,  max: 2, curve: 'discrete' },
    { id: 'width',     label: 'Width', defaultValue: 0.5, min: 0,  max: 1, curve: 'linear' },
  ],

  docs: {
    explanation:
      "A clean-room recreation of the Moog 921A Oscillator Driver — the master half of the System 55/35 two-part oscillator. It is NOT a sound source: it makes no audio of its own. Instead it generates the two CONTROL VOLTAGES — a 1V/oct pitch bus and a pulse-width bus — that drive one or more slaved 921B oscillators, so a whole bank of 921Bs tracks one set of FREQUENCY/RANGE/WIDTH knobs (and one pitch CV) in perfect unison. Mental model: it is the pitch+width 'brain' you patch into every 921B's FREQ BUS and WIDTH BUS so they play together; tune here, hear it on the 921Bs.",
    inputs: {
      freq_cv:
        "1V/oct pitch CV summed onto the FREQ knob (and the RANGE compass) per sample, then sent out on the freq bus — patch a keyboard or sequencer here to play every slaved 921B at once.",
      width_cv:
        "Pulse-width CV summed onto the WIDTH knob per sample and passed through to the width bus, so an LFO here animates the pulse width of every 921B driven by this module simultaneously (ganged PWM).",
    },
    outputs: {
      freq_bus:
        "The 1V/oct frequency control voltage. Patch it into each 921B's FREQ BUS input so they all follow this module's pitch (knob + freq_cv).",
      width_bus:
        "The 0..1 pulse-width control voltage. Patch it into each 921B's WIDTH BUS input so their rectangular outputs share one width (knob + width_cv).",
    },
    controls: {
      frequency: "The FREQUENCY pot, a normalized -1..1 that the RANGE switch maps onto the pitch bus — the coarse tuning for every 921B this driver feeds.",
      freqRange:
        "RANGE switch: 1 = SEMITONE (the FREQUENCY pot spans a narrow ~2-octave window for fine tuning) / 2 = OCTAVE (the pot spans a wide ~12-octave compass for big sweeps).",
      width: "Pulse width sent on the width bus, 0 to 1 (0.5 = a 50% square), driving the rectangular output of every 921B that reads this bus.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'moog921a', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 VCO / 904A / analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog921aDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['freq_cv',  { node: workletNode, input: 0 }],
        ['width_cv', { node: workletNode, input: 1 }],
      ]),
      outputs: new Map([
        ['freq_bus',  { node: workletNode, output: 0 }],
        ['width_bus', { node: workletNode, output: 1 }],
      ]),
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
