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
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  card: 'Moog911aCard',
  domain: 'audio',
  label: '911a trig delay',
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

  docs: {
    explanation:
      "A clean-room recreation of the Moog 911A Dual Trigger Delay — two independent timers that each take an incoming trigger and re-emit it a programmed time later. A rising edge on a TRIG input starts that channel's countdown; when the DELAY time elapses the matching OUT emits a short (~1 ms) trigger pulse. The MODE switch couples the two channels: OFF runs them as two separate delays (each its own trigger in/out), PARALLEL fans one trigger into BOTH delays at once (one input fires two outputs, useful for staggered double-hits), and SERIES chains them so OUT 1 re-triggers delay 2 (the total delay before OUT 2 fires is delay1 + delay2). Mental model: a pair of 'echo' timers for gates/triggers — patch a clock or strike in, get a time-shifted copy out, to offset a second voice or build rhythmic delays of events (not audio).",
    inputs: {
      trig1:
        "Trigger input for delay 1, and the master trigger in PARALLEL and SERIES modes. A rising edge here starts delay 1's countdown (and, in PARALLEL, delay 2's too); it fires once per edge, not while held.",
      trig2:
        "Trigger input for delay 2 — used only in OFF mode (where the two delays are independent). In PARALLEL and SERIES this input is ignored because delay 2 is driven from TRIG 1 / OUT 1 instead.",
    },
    outputs: {
      out1:
        "Delay 1's output: a short (~1 ms) trigger pulse emitted once, DELAY 1 seconds after its trigger arrived. In SERIES mode this pulse also re-triggers delay 2.",
      out2:
        "Delay 2's output: a short trigger pulse, DELAY 2 seconds after delay 2 was triggered (from TRIG 2 in OFF, from TRIG 1 in PARALLEL, or from OUT 1 in SERIES — giving a total delay1 + delay2 from the original trigger).",
    },
    controls: {
      delay1: "Delay time for channel 1: how long after its trigger before OUT 1 fires, from 2 ms up to 10 s (log taper).",
      delay2: "Delay time for channel 2: how long before OUT 2 fires, from 2 ms up to 10 s (log taper). In SERIES this stacks on top of delay 1.",
      mode: "Coupling between the two delays: OFF = independent (each its own trigger in/out), PARALLEL = TRIG 1 fires both delays at once (one in, two staggered outs), SERIES = OUT 1 re-triggers delay 2 so the two times add up (delay1 then delay2).",
    },
  },

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
