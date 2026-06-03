// packages/web/src/lib/audio/modules/moog921b.ts
//
// MOOG 921B OSCILLATOR — Moog System 55/35 clone (batch 1, shipped with the
// 921A driver). The slaved VCO: driven by a 921A's freq_bus / width_bus
// CONTROL INPUTS (it has no 1V/oct jack of its own — the 921A is the master
// driver). Presents FOUR fixed-level simultaneous waveform outs off one
// common core, 1 Hz–40 kHz. Shared by SYS55 + SYS35 → categorized under
// Moog → SYS55 (the shared bucket, mirroring the 921 VCO + 904A).
//
// DSP forks the shared own-code Moog VCO core (the same clean-room
// polyBLEP/polyBLAMP band-limited oscillator + hard/soft sync the 921 VCO
// uses; packages/dsp/src/moog921b.ts + lib/moog-vco-dsp.ts), slaved to the
// bus. AC MODULATE is cap-coupled (a DC-blocking high-pass on the mod input
// before linear FM); DC MODULATE is straight linear FM; SYNC drives a
// hard/soft/off phase reset. Permissive, not a port of any Moog schematic /
// copyleft source (.myrobots/MOOG/LICENSING.md).
//
// Inputs:
//   freq_bus (cv): V/oct pitch CV from a 921A's freq_bus (0 = C4).
//   width_bus (cv): 0..1 pulse-width CV from a 921A's width_bus (normals to
//     0.5 / square when unpatched).
//   dc_mod (audio): LINEAR FM, DC-coupled (non-1V/oct). Scaled by modAmount.
//   ac_mod (audio): LINEAR FM, AC-coupled — a DC-blocking HP runs first so a
//     DC offset on the modulator doesn't bend the pitch. Scaled by modAmount.
//   sync (audio): external sync source; rising edges reset/nudge the phase
//     per the SYNC switch.
//
// Outputs (all audio, fixed level):
//   sine, triangle, saw, rect.
//
// Params:
//   fine (linear -12..12, default 0): FREQUENCY pot — 2-octave fine trim.
//   range (discrete -5..5, default 0): RANGE switch — octave footage.
//   modAmount (linear -1..1, default 0): linear-FM depth (DC + AC inputs).
//   syncMode (linear -1..1, default 0): SYNC switch. -1 soft / 0 off / +1 hard.
//   level (linear 0..2, default 1): output gain.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog921b.js?url';

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog921bDef: AudioModuleDef = {
  type: 'moog921b',
  palette: { top: 'Moog', sub: 'SYS55' },
  domain: 'audio',
  label: 'Moog 921B Osc',
  category: 'sources',
  schemaVersion: 1,

  inputs: [
    // freq_bus + width_bus are audio-rate CONTROL INPUTS from the 921A (the
    // worklet reads them per-sample), not CV→AudioParam routings — no cvScale
    // (PASSTHROUGH_BY_DESIGN). They have no paramTarget (no matching knob —
    // they ARE the slave pitch/width, supplied by the master driver).
    { id: 'freq_bus',  type: 'cv' },
    { id: 'width_bus', type: 'cv' },
    // DC + AC MODULATE — audio-rate linear-FM inputs.
    { id: 'dc_mod', type: 'audio' },
    { id: 'ac_mod', type: 'audio' },
    { id: 'sync',   type: 'audio' },
  ],
  outputs: [
    { id: 'sine',     type: 'audio' },
    { id: 'triangle', type: 'audio' },
    { id: 'saw',      type: 'audio' },
    { id: 'rect',     type: 'audio' },
  ],
  params: [
    { id: 'fine',      label: 'Freq',  defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'st' },
    { id: 'range',     label: 'Range', defaultValue: 0, min: -5,  max: 5,  curve: 'discrete', units: 'oct' },
    { id: 'modAmount', label: 'FM',    defaultValue: 0, min: -1,  max: 1,  curve: 'linear' },
    { id: 'syncMode',  label: 'Sync',  defaultValue: 0, min: -1,  max: 1,  curve: 'linear' },
    { id: 'level',     label: 'Level', defaultValue: 1, min: 0,   max: 2,  curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'moog921b', {
      numberOfInputs: 5,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 VCO / 904A / analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);
    silence.connect(workletNode, 0, 2);
    silence.connect(workletNode, 0, 3);
    silence.connect(workletNode, 0, 4);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog921bDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['freq_bus',  { node: workletNode, input: 0 }],
        ['width_bus', { node: workletNode, input: 1 }],
        ['dc_mod',    { node: workletNode, input: 2 }],
        ['ac_mod',    { node: workletNode, input: 3 }],
        ['sync',      { node: workletNode, input: 4 }],
      ]),
      outputs: new Map([
        ['sine',     { node: workletNode, output: 0 }],
        ['triangle', { node: workletNode, output: 1 }],
        ['saw',      { node: workletNode, output: 2 }],
        ['rect',     { node: workletNode, output: 3 }],
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
