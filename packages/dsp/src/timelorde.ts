// packages/dsp/src/timelorde.ts
//
// TIMELORDE — central time source. One AudioWorklet, thirteen gate outputs:
//   1x, 8x, 4x, 2x, 1/2, 1/3, 1/4, 1/8, 1/12, 1/16, 1/32, 1/64, swing
//
// The sample-accurate clock engine lives in ./lib/timelorde-clock-core.ts
// (TimelordeClockCore) — a pure class so vitest can pin exact divide/multiply
// pulse counts without an AudioWorkletGlobalScope. This file is the worklet
// wrapper: it owns the frozen parameterDescriptors + the MessagePort and
// forwards each block to the core, injecting the `sampleRate` global and the
// port's postMessage. The engine logic is BYTE-IDENTICAL to the previous
// in-worklet implementation (proven by the per-port + behavioral e2e rows).
//
// External clock is auto-detected: if a rising edge arrives on input 0
// within ~2 master periods, we follow it; otherwise the internal BPM
// generator drives 1x. Multiplier outputs (8x, 4x, 2x) lag by exactly one
// master period due to a predictor-style scheduler. Divider outputs are exact.
//
// IMPORTANT: this file does NOT `export` anything at the top level — a
// top-level export leaks into the bundled dist/timelorde.js + breaks the ART
// classic-script eval. The core is reached via a normal import (that's fine);
// the Processor class is registered via the registerProcessor side-effect.

import { TimelordeClockCore } from './lib/timelorde-clock-core';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

class TimelordeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bpm',          defaultValue: 120, minValue: 10,  maxValue: 300, automationRate: 'k-rate' as const },
      { name: 'swingAmount',  defaultValue: 0,   minValue: 0,   maxValue: 90,  automationRate: 'k-rate' as const },
      { name: 'swingSource',  defaultValue: 0,   minValue: 0,   maxValue: 10,  automationRate: 'k-rate' as const },
      // muteOutputs (v2; was isPlaying in v1): 0 = unmuted/audible,
      // 1 = muted. The internal clock generation ALWAYS runs
      // regardless — LIVECODE's clocked() callbacks + any other
      // tick consumers need the clock alive even when gates are off.
      // This is the card's MUTE button (not the external stop gate).
      { name: 'muteOutputs',  defaultValue: 0,   minValue: 0,   maxValue: 1,   automationRate: 'k-rate' as const },
      // running: 1 = clock advances, 0 = clock HALTED (phase
      // accumulator + sample-counter + pending pulses all freeze).
      // Driven by start_in / stop_in transport gates (mirrors a DAW's
      // transport start/stop button). Distinct from muteOutputs:
      // - muteOutputs zeroes the audible gate level but the internal
      //   clock keeps running so LIVECODE's clocked() callbacks fire.
      // - running=0 actually PAUSES the clock; on resume, the
      //   internal phase / counters pick up from where they stopped
      //   (musical position preserved across a stop, matching DAW
      //   transport semantics).
      { name: 'running',      defaultValue: 1,   minValue: 0,   maxValue: 1,   automationRate: 'k-rate' as const },
      // hasExternalClock is set to 1 by the engine factory whenever an edge
      // is patched into input 0 (declarative, not measured). Drives whether
      // the play button is honored or always-on.
      { name: 'hasExternalClock', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  private core = new TimelordeClockCore();
  // Injected into the core so the engine can surface measuredBpm to the WEB
  // layer without knowing about the MessagePort.
  private post = (message: unknown) => this.port.postMessage(message);

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    return this.core.process(inputs, outputs, parameters, sampleRate, this.post);
  }
}

registerProcessor('timelorde', TimelordeProcessor);
