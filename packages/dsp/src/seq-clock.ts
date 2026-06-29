// packages/dsp/src/seq-clock.ts
//
// SEQ-CLOCK — AudioWorklet wrapper around SeqClockCore (see lib/seq-clock-core.ts
// for the full step engine + its derivation from the sequencer's internal clock).
//
// Runs the sequencer's INTERNAL-clock step advance + gate/pitch emission on the
// AUDIO thread, so a canvas-drag main-thread stall can never drop a step (the
// clock-drop-on-drag bug — .myrobots/plans/clock-drag-jank-analysis-2026-06-29.md).
// AudioParam scheduling is main-thread-only, which is why the engine must live in
// the worklet rather than being driven by a main-thread lookahead loop.
//
// I/O:
//   • output[0] = 2 channels: ch0 = pitch CV (V/oct), ch1 = gate (0|1).
//   • config (bpm / length / steps / gateLength / swing / octave / snh / running)
//     arrives via port messages on EDIT — never per audio block — so a config
//     update dropped during a main-thread drag just applies a frame late and
//     never affects tempo.
//
// IMPORTANT: this file does NOT export the Processor class at the top level — a
// top-level export pollutes the bundled dist/seq-clock.js and breaks the ART
// harness's classic-script eval (see ringback.ts / twotracks.ts). The class is
// reached via its registerProcessor side-effect only.

import { SeqClockCore } from './lib/seq-clock-core';
import type { SeqClockConfig } from './lib/seq-clock-core';

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
// `sampleRate` is a global in AudioWorkletGlobalScope.
declare const sampleRate: number;

// Shim the worklet globals when running outside AudioWorkletGlobalScope (vitest).
// Guarded so the real runtime is untouched.
const G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
  sampleRate?: number;
};
if (typeof G.AudioWorkletProcessor === 'undefined') {
  G.AudioWorkletProcessor = class {
    port = { onmessage: null, postMessage() {} } as unknown as MessagePort;
  };
}
if (typeof G.registerProcessor === 'undefined') {
  G.registerProcessor = () => {};
}

class SeqClockProcessor extends AudioWorkletProcessor {
  private core = new SeqClockCore(
    typeof sampleRate === 'number' ? sampleRate : 48000,
  );

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; config?: Partial<SeqClockConfig> } | undefined;
      if (data?.type === 'config' && data.config) {
        this.core.setConfig(data.config);
      }
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0];
    const pitchOut = out?.[0];
    const gateOut = out?.[1];
    if (!pitchOut || !gateOut) return true;
    this.core.process(pitchOut, gateOut, pitchOut.length);
    return true;
  }
}

registerProcessor('seq-clock', SeqClockProcessor);
