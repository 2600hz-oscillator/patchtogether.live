// packages/web/src/lib/audio/modules/moog904b.ts
//
// MOOG 904B — Voltage Controlled High Pass Filter (Moog System 55/35 clone,
// batch 1). The high-pass companion to the 904A LPF: a 24 dB/oct transistor-
// ladder HIGH-pass, built by subtracting the ladder's low-passed signal from
// the input (input − lp4 → the complementary 4-pole high-pass). A CUTOFF
// pot, a two-position RANGE switch (LOW 4 Hz–20 kHz / HIGH = +1.5 oct), a
// summing 1 V/oct CONTROL INPUT, and — unlike the 904A — NO regeneration /
// resonance knob (the hardware 904B has no resonance pot). Shared by SYS55 +
// SYS35 → categorized under Ports → moogafakkin (the shared bucket).
//
// DSP: own-code, CLEAN-ROOM — CONSUMES the same shared transistor-ladder
// core the 904A uses (packages/dsp/src/moog904b.ts via
// lib/moog-ladder-dsp.ts's hpDerive). Permissive, not a port of any Moog
// schematic / copyleft source (.myrobots/MOOG/LICENSING.md).
//
// Inputs:
//   audio (audio): signal to be filtered.
//   cutoff_cv (cv, paramTarget=cutoff): summing 1 V/oct CONTROL INPUT —
//     audio-rate, summed (exponentially) onto the cutoff in the worklet
//     (PASSTHROUGH — the worklet applies the 1 V/oct map per-sample).
//
// Outputs:
//   audio (audio): 24 dB/oct high-pass output.
//
// Params:
//   cutoff (log 4..20000 Hz, default 1000): FIXED CONTROL VOLTAGE pot.
//   range (discrete 1..2, default 1): RANGE switch — 1 = LOW / 2 = HIGH (+1.5 oct).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog904b.js?url';

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog904bDef: AudioModuleDef = {
  type: 'moog904b',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog904bVcfCard',
  domain: 'audio',
  label: '904b vcf',
  category: 'filters',

  inputs: [
    { id: 'audio', type: 'audio' },
    // cutoff_cv is an audio-rate CONTROL INPUT (the worklet sums knob + CV
    // per-sample with the 1 V/oct map), so it doesn't go through the
    // CV→AudioParam fast path. paramTarget keeps docs labelling correct; no
    // cvScale (PASSTHROUGH_BY_DESIGN, like the 904A's cutoff_cv).
    { id: 'cutoff_cv', type: 'cv', paramTarget: 'cutoff' },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'cutoff', label: 'Cutoff', defaultValue: 1000, min: 4, max: 20000, curve: 'log', units: 'Hz' },
    { id: 'range', label: 'Range', defaultValue: 1, min: 1, max: 2, curve: 'discrete' },
  ],

  docs: {
    explanation:
      "A clean-room recreation of the Moog 904B Voltage Controlled High Pass Filter — the high-pass companion to the 904A. It is a 24 dB/octave transistor-ladder HIGH-pass, built by subtracting the ladder's low-passed output from the input (input − four-pole-lowpass = the complementary four-pole highpass), so everything BELOW the cutoff is rolled off at a steep slope and the highs pass through. Use it to thin out a sound, remove rumble, or — paired with a 904A — bracket a band. Unlike the 904A there is NO resonance/regeneration knob (the hardware 904B has none): just a CUTOFF pot, a two-position RANGE switch, and a summing 1 V/octave control input for sweeping the corner with an envelope or LFO. It consumes the same shared ladder core as the 904A.",
    inputs: {
      audio: "The signal to be filtered — the audio fed into the ladder.",
      cutoff_cv: "Summing 1 V/octave CONTROL INPUT to the cutoff (audio-rate). It adds exponentially onto the CUTOFF knob inside the worklet, so an envelope or LFO patched here sweeps the high-pass corner — opening up the lows as it falls, thinning the sound as it rises.",
    },
    outputs: {
      audio: "The 24 dB/octave high-passed output — the input with everything below the cutoff rolled off at the four-pole slope.",
    },
    controls: {
      cutoff: "The FIXED CONTROL VOLTAGE pot — the high-pass corner frequency, 4 Hz to 20 kHz on a log taper. Content below it is attenuated at the four-pole slope; raise it to thin the sound and strip bass, lower it to let more low end through. CV adds on top of this. Defaults to 1 kHz.",
      range: "RANGE switch — LOW (the full 4 Hz–20 kHz span) or HIGH (the same sweep shifted up about 1.5 octaves), so you can place the CUTOFF pot's travel where you need it. Defaults to LOW.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'moog904b', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 904A / 921 VCO / analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog904bDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio', { node: workletNode, input: 0 }],
        ['cutoff_cv', { node: workletNode, input: 1 }],
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
