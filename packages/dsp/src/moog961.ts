// packages/dsp/src/moog961.ts
//
// MOOG 961 INTERFACE — trigger/gate format converter (Moog System 55 clone,
// batch 5). The conversion logic (audio→trigger threshold, S/V passthroughs,
// column-A width-match, column-B fixed-width one-shot) is pure + unit-tested in
// ./lib/trigger-convert-dsp.ts; this entry just wraps it in an
// AudioWorkletProcessor. See that file's header for the per-circuit rationale.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/moog961.js + break the ART classic-script
// eval. The Processor is registered via the `registerProcessor` side-effect;
// the tests capture the class through a registerProcessor shim.
//
// Inputs (4 node connections, channel 0 read for each):
//   inputs[0] = audio_in  — signal whose level drives the audio→trigger detector
//   inputs[1] = s_in      — external S-trigger gate (passthrough → V outs)
//   inputs[2] = v_in_a    — column-A V input (width-matched → s_out_a)
//   inputs[3] = v_in_b    — column-B V input (fixed one-shot → s_out_b)
//
// Outputs (4 gate outs, 1 channel each):
//   outputs[0] = v_out1
//   outputs[1] = v_out2
//   outputs[2] = s_out_a
//   outputs[3] = s_out_b

import {
  TriggerConvertState,
  SENSITIVITY_DEFAULT,
  SWITCH_ON_TIME_DEFAULT,
  SWITCH_ON_TIME_MIN,
  SWITCH_ON_TIME_MAX,
  SENSITIVITY_MIN,
  SENSITIVITY_MAX,
} from './lib/trigger-convert-dsp';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor,
): void;

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest
// captures the class via this shim — see the moog961.test.ts loader).
const G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
};
if (typeof G.AudioWorkletProcessor === 'undefined') {
  G.AudioWorkletProcessor = class {};
}
if (typeof G.registerProcessor === 'undefined') {
  G.registerProcessor = () => {};
}

// Not `export`ed at the top level by design — see the file-header note.
class Moog961Processor extends AudioWorkletProcessor {
  private st: TriggerConvertState;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.st = new TriggerConvertState(sampleRate);
  }

  static get parameterDescriptors() {
    return [
      // sensitivity — k-rate; audio→trigger threshold (linear 0..1).
      {
        name: 'sensitivity',
        defaultValue: SENSITIVITY_DEFAULT,
        minValue: SENSITIVITY_MIN,
        maxValue: SENSITIVITY_MAX,
        automationRate: 'k-rate' as const,
      },
      // switchOnTime — k-rate; column-B fixed pulse width in seconds.
      {
        name: 'switchOnTime',
        defaultValue: SWITCH_ON_TIME_DEFAULT,
        minValue: SWITCH_ON_TIME_MIN,
        maxValue: SWITCH_ON_TIME_MAX,
        automationRate: 'k-rate' as const,
      },
    ];
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const audioIn = inputs[0]?.[0] ?? null;
    const sIn = inputs[1]?.[0] ?? null;
    const vInA = inputs[2]?.[0] ?? null;
    const vInB = inputs[3]?.[0] ?? null;

    const vOut1 = outputs[0]?.[0];
    const vOut2 = outputs[1]?.[0];
    const sOutA = outputs[2]?.[0];
    const sOutB = outputs[3]?.[0];
    if (!vOut1 || !vOut2 || !sOutA || !sOutB) return true;
    const n = vOut1.length;

    const sensitivity = this.kval(parameters, 'sensitivity', SENSITIVITY_DEFAULT);
    const switchOnTime = this.kval(parameters, 'switchOnTime', SWITCH_ON_TIME_DEFAULT);

    for (let s = 0; s < n; s++) {
      const out = this.st.step(
        audioIn ? audioIn[s]! : 0,
        sIn ? sIn[s]! : 0,
        vInA ? vInA[s]! : 0,
        vInB ? vInB[s]! : 0,
        sensitivity,
        switchOnTime,
      );
      vOut1[s] = out.vOut1;
      vOut2[s] = out.vOut2;
      sOutA[s] = out.sOutA;
      sOutB[s] = out.sOutB;
    }

    return true;
  }
}

registerProcessor('moog961', Moog961Processor);
