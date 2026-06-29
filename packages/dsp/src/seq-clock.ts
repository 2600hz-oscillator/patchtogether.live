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
// I/O (matches the sequencer's three internal-clock outputs):
//   • output[0] = 10 channels = the POLY pitch/gate bus (POLYHELM-compatible):
//     interleaved [lane0 pitch, lane0 gate, … lane4 pitch, lane4 gate]. Lane 0
//     IS the mono pitch (mono = root in lane 0, the rest silent), so a mono
//     patch just reads ch0/ch1.
//   • output[1] = 1 channel = the mono GATE (high while ANY lane is gated).
//   • output[2] = 1 channel = the CLOCK pulse (short high at each step boundary).
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
      } else if (data?.type === 'reset') {
        // Transport reset / pattern restart from the host: restart phase at step 0
        // so the worklet stays in lockstep with the main-thread shadow.
        this.core.reset();
      }
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    // output[0] = 10ch poly bus (lane pitch/gate interleaved), [1] = mono gate,
    // [2] = clock. The host (sequencer.ts) creates the node with
    // outputChannelCount [10, 1, 1]; a single channel on output[0] still works
    // (mono-only host) because lane 0 carries the mono voice.
    const poly = outputs[0];
    const gateOut = outputs[1]?.[0];
    const clockOut = outputs[2]?.[0];
    if (!poly || poly.length < 2 || !gateOut || !clockOut) return true;

    // Map the (possibly <10) poly channels onto the core's per-lane buffers.
    // A scratch zero buffer backs any lane the host didn't allocate so the core
    // can always write SEQ_POLY_LANES lanes without bounds checks.
    const frames = poly[0].length;
    const scratch = this.laneScratch(frames);
    const lanePitch: Float32Array[] = [];
    const laneGate: Float32Array[] = [];
    for (let l = 0; l < 5; l++) {
      lanePitch.push(poly[2 * l] ?? scratch);
      laneGate.push(poly[2 * l + 1] ?? scratch);
    }
    this.core.process({ lanePitch, laneGate, gate: gateOut, clock: clockOut }, frames);
    return true;
  }

  // A reusable throwaway buffer for poly lanes the host didn't wire (keeps the
  // core's fixed 5-lane write branchless without allocating per block).
  private scratch = new Float32Array(128);
  private laneScratch(frames: number): Float32Array {
    if (this.scratch.length < frames) this.scratch = new Float32Array(frames);
    return this.scratch;
  }
}

registerProcessor('seq-clock', SeqClockProcessor);
