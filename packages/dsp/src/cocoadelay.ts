// packages/dsp/src/cocoadelay.ts
//
// COCOA DELAY — AudioWorklet wrapper around the shared CocoaDelayCore (see
// cocoadelay-core.ts for the full per-sample DSP and the port rationale).
//
// Tempo sync: the original read the host transport. We have three sources,
// resolved per-sample in CocoaDelayCore.baseDelayTime (highest precedence
// first):
//   1. a PATCHED `clock` gate input (input[2]) whose pulse period is measured;
//   2. else the WEB-layer-supplied beat period via the `syncPeriod` AudioParam
//      — the main thread reads the chosen `clockSource` (System=TIMELORDE /
//      MIDI=MIDICLOCK) BPM and bridges seconds-per-beat here, because the
//      worklet can't reach those singletons from AudioWorkletGlobalScope;
//   3. else the free-running TIME knob.
// `tempoSync` selects Off (free ms) or a musical division of the beat.
//
// Original is GPL-3.0 (see ../cocoa-delay/license.md). This port keeps that.

import { CocoaDelayCore, SYNC_BEATS } from './cocoadelay-core';

const PI = Math.PI;

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

// Shim the worklet globals when running outside AudioWorkletGlobalScope
// (vitest). Guarded so the real runtime is untouched.
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

// Not `export`ed — see the note in charlottes-echos.ts: a top-level export
// pollutes the bundled dist/<name>.js worklet and breaks the ART harness's
// classic-script eval. Reached via its registerProcessor side-effect.
class CocoaDelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // a-rate params receive CV — read per-sample for smooth modulation.
      { name: 'delayTime', defaultValue: 0.2, minValue: 0.001, maxValue: 2.0, automationRate: 'a-rate' as const },
      { name: 'lfoAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 0.5, automationRate: 'a-rate' as const },
      { name: 'lfoFrequency', defaultValue: 2.0, minValue: 0.1, maxValue: 10.0, automationRate: 'k-rate' as const },
      { name: 'driftAmount', defaultValue: 0.001, minValue: 0.0, maxValue: 0.05, automationRate: 'a-rate' as const },
      { name: 'driftSpeed', defaultValue: 1.0, minValue: 0.1, maxValue: 10.0, automationRate: 'k-rate' as const },
      { name: 'tempoSync', defaultValue: 0, minValue: 0, maxValue: 19, automationRate: 'k-rate' as const },
      { name: 'clockSource', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      // Seconds-per-beat bridged from the WEB layer (System=TIMELORDE /
      // MIDI=MIDICLOCK) — the worklet can't read those singletons directly.
      // 0 = none available; a patched `clock` gate still overrides it.
      { name: 'syncPeriod', defaultValue: 0, minValue: 0, maxValue: 30, automationRate: 'k-rate' as const },
      { name: 'feedback', defaultValue: 0.5, minValue: -1.0, maxValue: 1.0, automationRate: 'a-rate' as const },
      { name: 'stereoOffset', defaultValue: 0.0, minValue: -0.5, maxValue: 0.5, automationRate: 'k-rate' as const },
      { name: 'panMode', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' as const },
      { name: 'pan', defaultValue: 0.0, minValue: -PI * 0.5, maxValue: PI * 0.5, automationRate: 'a-rate' as const },
      { name: 'duckAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 10.0, automationRate: 'a-rate' as const },
      { name: 'duckAttack', defaultValue: 10.0, minValue: 0.1, maxValue: 100.0, automationRate: 'k-rate' as const },
      { name: 'duckRelease', defaultValue: 10.0, minValue: 0.1, maxValue: 100.0, automationRate: 'k-rate' as const },
      { name: 'filterMode', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' as const },
      { name: 'lowCut', defaultValue: 0.75, minValue: 0.01, maxValue: 1.0, automationRate: 'k-rate' as const },
      { name: 'highCut', defaultValue: 0.001, minValue: 0.001, maxValue: 0.99, automationRate: 'k-rate' as const },
      { name: 'driveGain', defaultValue: 0.1, minValue: 0.0, maxValue: 10.0, automationRate: 'a-rate' as const },
      { name: 'driveMix', defaultValue: 1.0, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' as const },
      { name: 'driveCutoff', defaultValue: 1.0, minValue: 0.01, maxValue: 1.0, automationRate: 'k-rate' as const },
      { name: 'driveIterations', defaultValue: 1, minValue: 1, maxValue: 16, automationRate: 'k-rate' as const },
      { name: 'dryVolume', defaultValue: 1.0, minValue: 0.0, maxValue: 2.0, automationRate: 'k-rate' as const },
      { name: 'wetVolume', defaultValue: 0.5, minValue: 0.0, maxValue: 2.0, automationRate: 'a-rate' as const },
    ];
  }

  // Re-export so the unit test (and CHARLOTTE) can reference division count.
  static readonly SYNC_BEATS = SYNC_BEATS;

  private core: CocoaDelayCore;
  private clockPrev = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.core = new CocoaDelayCore(sampleRate);
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }
  private aval(p: Record<string, Float32Array>, name: string, s: number, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return (arr.length > 1 ? arr[s] : arr[0]) as number;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const inL = inputs[0]?.[0] ?? null;
    const inR = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null;
    const clk = inputs[2]?.[0] ?? null;
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;
    const n = outL.length;

    // k-rate block constants.
    const tempoSync = this.kval(parameters, 'tempoSync', 0);
    const syncPeriod = this.kval(parameters, 'syncPeriod', 0);
    const lfoFrequency = this.kval(parameters, 'lfoFrequency', 2.0);
    const driftSpeed = this.kval(parameters, 'driftSpeed', 1.0);
    const stereoOffset = this.kval(parameters, 'stereoOffset', 0.0);
    const panMode = this.kval(parameters, 'panMode', 0);
    const duckAttack = this.kval(parameters, 'duckAttack', 10.0);
    const duckRelease = this.kval(parameters, 'duckRelease', 10.0);
    const filterMode = this.kval(parameters, 'filterMode', 0);
    const lowCut = this.kval(parameters, 'lowCut', 0.75);
    const highCut = this.kval(parameters, 'highCut', 0.001);
    const driveMix = this.kval(parameters, 'driveMix', 1.0);
    const driveCutoff = this.kval(parameters, 'driveCutoff', 1.0);
    const driveIterations = this.kval(parameters, 'driveIterations', 1);
    const dryVolume = this.kval(parameters, 'dryVolume', 1.0);

    for (let s = 0; s < n; s++) {
      if (clk) {
        const v = clk[s] ?? 0;
        this.core.feedClock(v, this.clockPrev);
        this.clockPrev = v;
      }
      this.core.processSample(
        {
          delayTime: this.aval(parameters, 'delayTime', s, 0.2),
          tempoSync,
          syncPeriod,
          lfoAmount: this.aval(parameters, 'lfoAmount', s, 0),
          lfoFrequency,
          driftAmount: this.aval(parameters, 'driftAmount', s, 0),
          driftSpeed,
          feedback: this.aval(parameters, 'feedback', s, 0.5),
          stereoOffset,
          panMode,
          pan: this.aval(parameters, 'pan', s, 0),
          duckAmount: this.aval(parameters, 'duckAmount', s, 0),
          duckAttack,
          duckRelease,
          filterMode,
          lowCut,
          highCut,
          driveGain: this.aval(parameters, 'driveGain', s, 0.1),
          driveMix,
          driveCutoff,
          driveIterations,
          dryVolume,
          wetVolume: this.aval(parameters, 'wetVolume', s, 0.5),
        },
        inL?.[s] ?? 0,
        inR?.[s] ?? 0,
        sampleRate,
      );
      outL[s] = this.core.outL;
      outR[s] = this.core.outR;
    }

    return true;
  }
}

registerProcessor('cocoadelay', CocoaDelayProcessor);
