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

  docs: {
    explanation:
      "The convenience converter between the two interpretations of the unified gate cable: a TRIGGER (a brief blip that fires once on each rising edge — a clock tick, a strike) and a GATE (a held level that stays high while something is on — a note being held, an envelope's sustain). One generic input feeds BOTH outputs simultaneously, with no mode switch: GATE reads the input's level (and a passing trigger is widened into a minimum-width gate set by LEN), while TRIG fires one short pulse on every rising edge of the input (so a held gate becomes a single trigger at its start). Use it to make an external clock open an ADSR's sustain, or to turn a long held gate back into a one-shot strike, or just to fan one signal out as both shapes at once.",
    inputs: {
      in: "The signal to convert (accepts a gate, a trigger, or any CV/pitch). Its level drives the GATE output while its rising edges drive the TRIG output. A trigger arriving here is stretched up to LEN on GATE; a held gate here passes through on GATE and emits one trigger on TRIG when it goes high.",
    },
    outputs: {
      gate: "A held gate that stays high while the input is high, but never shorter than the LEN time — so even a momentary trigger on the input produces a usably-wide held gate here. Patch it into anything level-sensitive (an ADSR sustain, a VCA hold).",
      trig: "A short fixed-width pulse that fires once on each rising edge of the input — the trigger form. A long held gate on the input yields a single trigger here at its start, not a continuous level.",
    },
    controls: {
      gateLen: "The minimum width of the GATE output (5 ms to 2 s, log), used when the input is a short trigger: the gate is held at least this long after the strike. With a genuinely held input gate this just sets the floor; the gate otherwise follows the input level.",
      trigShape: "The waveform of the TRIG output pulse — toggles between a short triangle (TRI, the gentle default) and a hard square (SQR). Display/feel only; both fire once per rising edge with the same canonical pulse width.",
    },
  },

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
