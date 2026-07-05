// packages/web/src/lib/audio/modules/ninelives.ts
//
// NINE LIVES — a low-frequency oscillator fanned out to NINE CV outputs on a
// geometric ⅓ rate ladder, all sharing one waveform, with a RESET trigger.
// DSP is a custom JS AudioWorklet (packages/dsp/src/ninelives.ts → the pure
// core packages/dsp/src/lib/ninelives-dsp.ts).
//
//   out1 runs at the `rate` knob — IDENTICAL to a normal LFO (same range + log
//   mapping + waveform). Each subsequent output runs at ⅓ the rate of the one
//   before it:  out_n = rate × (1/3)^(n-1).  So:
//     out2 = rate/3,  out3 = rate/9,  …  out9 = (1/3)^8 = rate/6561 (≈ 0.0001524×).
//   Nine slowly-detuning modulation taps off a single knob, from the set rate
//   down to a ~once-every-many-minutes drift.
//
// Inputs:
//   reset (gate, edge:'trigger'): rising edge re-zeroes every phase so all nine
//     outputs snap back to phase 0 together (a hard re-sync of the whole ladder).
//
// Outputs:
//   out1 … out9 (cv): the nine bipolar LFO taps on the ⅓ ladder (out1 fastest).
//
// Params:
//   rate (log 0.01..100 Hz, default 1): out1 frequency — reuses the LFO's rate
//     range + log curve so out1 behaves exactly like a normal LFO.
//   shape (linear 0..2, default 0): the SHARED waveform morph (sine→saw→square)
//     applied to all nine outputs.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/ninelives.js?url';

const PROCESSOR_NAME = 'ninelives';
const OUT_COUNT = 9;
const loadedContexts = new WeakSet<BaseAudioContext>();

export const ninelivesDef: AudioModuleDef = {
  type: 'ninelives',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'nine lives',
  category: 'modulation',

  inputs: [
    // RESET is a TRIGGER (fires once per rising edge): re-syncs the whole
    // ladder. Flows through the unified `gate` cable (cross-patchable with cv).
    { id: 'reset', type: 'gate', edge: 'trigger' },
  ],
  outputs: [
    { id: 'out1', type: 'cv' },
    { id: 'out2', type: 'cv' },
    { id: 'out3', type: 'cv' },
    { id: 'out4', type: 'cv' },
    { id: 'out5', type: 'cv' },
    { id: 'out6', type: 'cv' },
    { id: 'out7', type: 'cv' },
    { id: 'out8', type: 'cv' },
    { id: 'out9', type: 'cv' },
  ],
  params: [
    // rate: log (0.01..100Hz), the SAME definition the LFO uses for its rate —
    // out1 is identical to a normal LFO.
    { id: 'rate',  label: 'Rate',     defaultValue: 1, min: 0.01, max: 100, curve: 'log', units: 'Hz' },
    // shape: linear (0..2 morph axis), the shared waveform for all nine taps.
    { id: 'shape', label: 'Waveform', defaultValue: 0, min: 0,    max: 2,   curve: 'linear' },
  ],

  docs: {
    explanation:
      "Nine LFOs in one — a single oscillator fanned out to NINE bipolar CV outputs whose rates form a geometric ⅓ ladder. OUT 1 runs at the Rate knob, exactly like a normal LFO (same 0.01–100 Hz log range and the same sine→saw→square waveform). Each output below it runs at one-THIRD the rate of the one above, so OUT 2 = Rate/3, OUT 3 = Rate/9, and the slowest, OUT 9 = (1/3)^8 = Rate/6561 (about 0.0001524× — a single slow drift over many minutes when Rate is near 1 Hz). All nine taps share ONE Waveform shape. It's a quick way to get a spread of slowly-detuning modulators — clock-like at the top, glacial at the bottom — from one knob. RESET re-syncs the whole stack: each rising edge snaps all nine phases back to 0 at once so they restart together.",
    inputs: {
      reset:
        "A trigger input: each rising edge (crossing above 0.5) re-zeroes all nine phase accumulators at once, so every output restarts from phase 0 together (a hard re-sync of the whole ladder). Edge-triggered — it fires once per rising edge and ignores how long the level stays high, so holding it high does not freeze the outputs. Patch a clock or gate here to lock the stack's restart to a tempo.",
    },
    outputs: {
      out1: "The fastest tap: a bipolar LFO at the full Rate knob frequency — identical to a normal LFO at the same Rate and Waveform. The reference rate the rest of the ladder divides down from.",
      out2: "Rate ÷ 3 — one third the speed of OUT 1, same shared waveform.",
      out3: "Rate ÷ 9 — (1/3)^2 of OUT 1.",
      out4: "Rate ÷ 27 — (1/3)^3 of OUT 1.",
      out5: "Rate ÷ 81 — (1/3)^4 of OUT 1.",
      out6: "Rate ÷ 243 — (1/3)^5 of OUT 1.",
      out7: "Rate ÷ 729 — (1/3)^6 of OUT 1.",
      out8: "Rate ÷ 2187 — (1/3)^7 of OUT 1.",
      out9: "The slowest tap: Rate ÷ 6561 — (1/3)^8 of OUT 1 (≈ 0.0001524×). At Rate ≈ 1 Hz this is one slow sweep every ~109 minutes — a glacial drift source.",
    },
    controls: {
      rate: "Sets OUT 1's frequency from 0.01 Hz (one sweep per ~100 s) to 100 Hz, on a log fader — the same range and curve as the LFO. Every other output tracks it on the fixed ⅓ ladder (OUT n = Rate × (1/3)^(n-1)), so this one knob speeds up or slows down the entire stack together.",
      shape: "The shared waveform for all nine outputs: morphs continuously across 0–2 (0 = sine, 1 = saw, 2 = square), with smooth crossfades in between (e.g. 0.5 = halfway sine↔saw). The fader's glyphs mark sine / saw / square.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: OUT_COUNT,
      outputChannelCount: Array.from({ length: OUT_COUNT }, () => 1),
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of ninelivesDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const outputs = new Map<string, { node: AudioNode; output: number }>();
    for (let n = 0; n < OUT_COUNT; n++) {
      outputs.set(`out${n + 1}`, { node: workletNode, output: n });
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['reset', { node: workletNode, input: 0 }],
      ]),
      outputs,
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try {
          workletNode.disconnect();
        } catch {
          /* already disconnected */
        }
        try {
          workletNode.port.close();
        } catch {
          /* port may already be closed */
        }
      },
    };
  },
};
