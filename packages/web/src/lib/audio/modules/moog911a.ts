// packages/web/src/lib/audio/modules/moog911a.ts
//
// MOOG 911A DUAL TRIGGER DELAY — Moog System 55/35 clone (batch 5 utility
// cluster). Two independent trigger delays with a coupling MODE. A gate on an
// input is detected on its RISING edge; after a programmed delay the matching
// output emits a short (~1 ms) gate pulse. Categorized under Ports → moogafakkin.
//
// DSP: own-code pure timing (packages/dsp/src/lib/trigger-delay-dsp.ts —
// DualTriggerDelay) wrapped by the worklet packages/dsp/src/moog911a.ts.
// Permissive, not a port of any Moog schematic / copyleft source
// (.myrobots/MOOG/LICENSING.md).
//
// Inputs (gates):
//   trig1 (gate): trigger input for delay 1 (and the master trigger in
//     PARALLEL / SERIES modes).
//   trig2 (gate): trigger input for delay 2 (used only in OFF mode).
// Outputs (gates):
//   out1 (gate): delayed pulse from channel 1.
//   out2 (gate): delayed pulse from channel 2.
//
// Params:
//   delay1 (log seconds, 0.002..10, default 0.1): channel-1 delay time.
//   delay2 (log seconds, 0.002..10, default 0.1): channel-2 delay time.
//   mode   (discrete 0..2, default 0): coupling —
//     0 = OFF (independent), 1 = PARALLEL (trig1 fires both),
//     2 = SERIES (out1 re-triggers delay2).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog911a.js?url';

// Human-readable MODE names, indexed by the `mode` param value 0..2. The card
// renders MODE_NAMES[mode] next to the MODE knob.
export const MOOG911A_MODE_NAMES = ['OFF', 'PARALLEL', 'SERIES'] as const;
export const MOOG911A_MODE_COUNT = MOOG911A_MODE_NAMES.length;
export const MOOG911A_MAX_MODE = MOOG911A_MODE_COUNT - 1;

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog911aDef: AudioModuleDef = {
  type: 'moog911a',
  palette: { top: 'Ports', sub: 'moogafakkin' },
  card: 'Moog911aCard',
  domain: 'audio',
  label: '911A Trig Delay',
  category: 'modulation',
  schemaVersion: 1,

  inputs: [
    // Gate triggers — rising-edge detected in the worklet (PASSTHROUGH, not a
    // knob modulator → no cvScale / paramTarget).
    { id: 'trig1', type: 'gate' },
    { id: 'trig2', type: 'gate' },
  ],
  outputs: [
    // Delayed gate pulses — NOT audio.
    { id: 'out1', type: 'gate' },
    { id: 'out2', type: 'gate' },
  ],
  params: [
    // Delay times — log fader, 2 ms .. 10 s, default 100 ms.
    { id: 'delay1', label: 'Delay 1', defaultValue: 0.1, min: 0.002, max: 10, curve: 'log', units: 's' },
    { id: 'delay2', label: 'Delay 2', defaultValue: 0.1, min: 0.002, max: 10, curve: 'log', units: 's' },
    // Coupling mode — discrete picker; MOOG911A_MODE_NAMES[mode] on the card.
    { id: 'mode',   label: 'Mode',    defaultValue: 0,   min: 0,     max: MOOG911A_MAX_MODE, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'moog911a', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 VCO / CP3 silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog911aDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['trig1', { node: workletNode, input: 0 }],
        ['trig2', { node: workletNode, input: 1 }],
      ]),
      outputs: new Map([
        ['out1', { node: workletNode, output: 0 }],
        ['out2', { node: workletNode, output: 1 }],
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
