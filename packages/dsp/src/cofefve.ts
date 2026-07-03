// packages/dsp/src/cofefve.ts
//
// COFEFVE DELAY — the AudioWorklet entry that wraps the OWN-CODE
// AnalogDelayCore (./lib/analog-delay-core.ts) into a patchable stereo delay.
// Clean-room replacement for the retired COCOA DELAY; no GPL source was read
// while writing this — the DSP is entirely from ./lib/analog-delay-core.ts.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing this module (see the ART scenario +
// the module-def test's loadProcessor()).
//
// Inputs (3 audio-rate node connections):
//   inputs[0] = audio L
//   inputs[1] = audio R
//   inputs[2] = clock gate — when SYNC is on, the delay locks to the measured
//               pulse period × the chosen division (a patched clock overrides
//               the bridged `syncPeriod`).
// Outputs (2 audio-rate, 1 channel each):
//   outputs[0] = out L
//   outputs[1] = out R
//
// Params mirror the module def 1:1 (so the web factory's CV summing + the
// System/MIDI `syncPeriod` bridge work unchanged); the CV-targeted params are
// a-rate so per-sample CV reaches the core.

import { AnalogDelayCore, type AnalogDelaySettings } from './lib/analog-delay-core';

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

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest +
// the ART harness capture the class via these shims).
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

/** Rising-edge threshold for the clock gate (level crossing up through this). */
const CLOCK_TH = 0.5;

// Not `export`ed at the top level by design — see the file-header note.
class CofefveProcessor extends AudioWorkletProcessor {
  private core: AnalogDelayCore;
  // Reused per-sample settings object (no per-sample allocation).
  private s: AnalogDelaySettings = {
    delayTime: 0.2, tempoSync: 0, beatPeriodS: 0,
    lfoAmount: 0, lfoFrequency: 2, driftAmount: 0.001, driftSpeed: 1,
    feedback: 0.5, stereoOffset: 0, pan: 0, panMode: 0,
    duckAmount: 0, duckAttack: 10, duckRelease: 10,
    filterMode: 0, lowCut: 0.75, highCut: 0.001,
    driveGain: 0.1, driveMix: 1, driveCutoff: 1, driveIterations: 1,
    dryVolume: 1, wetVolume: 0.5,
  };

  // Clock-period measurement (per-sample edge detect is correct by
  // construction — a worklet consumer is exempt from the windowed-counter rule).
  private prevClock = 0;
  private samplesSinceEdge = 0;
  private haveFirstEdge = false;
  private measuredPeriod = 0; // samples; 0 = none measured

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.core = new AnalogDelayCore(sampleRate);
  }

  static get parameterDescriptors() {
    // CV-targeted params (delayTime / feedback / wetVolume / driveGain /
    // lfoAmount / driftAmount / pan / duckAmount) are a-rate so summed CV
    // reaches the core per-sample; the rest are k-rate block constants.
    const a = 'a-rate' as const;
    const k = 'k-rate' as const;
    return [
      { name: 'delayTime', defaultValue: 0.2, minValue: 0.001, maxValue: 2.0, automationRate: a },
      { name: 'tempoSync', defaultValue: 0, minValue: 0, maxValue: 19, automationRate: k },
      { name: 'clockSource', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'syncPeriod', defaultValue: 0, minValue: 0, maxValue: 30, automationRate: k },
      { name: 'lfoAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 0.5, automationRate: a },
      { name: 'lfoFrequency', defaultValue: 2.0, minValue: 0.1, maxValue: 10.0, automationRate: k },
      { name: 'driftAmount', defaultValue: 0.001, minValue: 0.0, maxValue: 0.05, automationRate: a },
      { name: 'driftSpeed', defaultValue: 1.0, minValue: 0.1, maxValue: 10.0, automationRate: k },
      { name: 'feedback', defaultValue: 0.5, minValue: -1.0, maxValue: 1.0, automationRate: a },
      { name: 'stereoOffset', defaultValue: 0.0, minValue: -0.5, maxValue: 0.5, automationRate: k },
      { name: 'pan', defaultValue: 0.0, minValue: -Math.PI, maxValue: Math.PI, automationRate: a },
      { name: 'panMode', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: k },
      { name: 'duckAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 10.0, automationRate: a },
      { name: 'duckAttack', defaultValue: 10.0, minValue: 0.1, maxValue: 100.0, automationRate: k },
      { name: 'duckRelease', defaultValue: 10.0, minValue: 0.1, maxValue: 100.0, automationRate: k },
      { name: 'filterMode', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: k },
      { name: 'lowCut', defaultValue: 0.75, minValue: 0.01, maxValue: 1.0, automationRate: k },
      { name: 'highCut', defaultValue: 0.001, minValue: 0.001, maxValue: 0.99, automationRate: k },
      { name: 'driveGain', defaultValue: 0.1, minValue: 0.0, maxValue: 10.0, automationRate: a },
      { name: 'driveMix', defaultValue: 1.0, minValue: 0.0, maxValue: 1.0, automationRate: k },
      { name: 'driveCutoff', defaultValue: 1.0, minValue: 0.01, maxValue: 1.0, automationRate: k },
      { name: 'driveIterations', defaultValue: 1, minValue: 1, maxValue: 16, automationRate: k },
      { name: 'dryVolume', defaultValue: 1.0, minValue: 0.0, maxValue: 2.0, automationRate: k },
      { name: 'wetVolume', defaultValue: 0.5, minValue: 0.0, maxValue: 2.0, automationRate: k },
    ];
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }
  private aval(p: Record<string, Float32Array>, name: string, i: number, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return (arr.length > 1 ? arr[i] : arr[0]) as number;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const inL = inputs[0]?.[0] ?? null;
    const inR = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null; // R normals to L
    const clk = inputs[2]?.[0] ?? null;
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;
    const n = outL.length;
    const sr = sampleRate;
    const s = this.s;

    // k-rate block constants.
    s.tempoSync = this.kval(parameters, 'tempoSync', 0);
    s.lfoFrequency = this.kval(parameters, 'lfoFrequency', 2);
    s.driftSpeed = this.kval(parameters, 'driftSpeed', 1);
    s.stereoOffset = this.kval(parameters, 'stereoOffset', 0);
    s.panMode = this.kval(parameters, 'panMode', 0);
    s.duckAttack = this.kval(parameters, 'duckAttack', 10);
    s.duckRelease = this.kval(parameters, 'duckRelease', 10);
    s.filterMode = this.kval(parameters, 'filterMode', 0);
    s.lowCut = this.kval(parameters, 'lowCut', 0.75);
    s.highCut = this.kval(parameters, 'highCut', 0.001);
    s.driveMix = this.kval(parameters, 'driveMix', 1);
    s.driveCutoff = this.kval(parameters, 'driveCutoff', 1);
    s.driveIterations = this.kval(parameters, 'driveIterations', 1);
    s.dryVolume = this.kval(parameters, 'dryVolume', 1);
    s.wetVolume = this.kval(parameters, 'wetVolume', 0.5);
    const syncPeriod = this.kval(parameters, 'syncPeriod', 0);

    for (let i = 0; i < n; i++) {
      // ── Clock edge / period measurement ─────────────────────────────────
      this.samplesSinceEdge++;
      const c = clk ? clk[i]! : 0;
      if (this.prevClock < CLOCK_TH && c >= CLOCK_TH) {
        if (this.haveFirstEdge && this.samplesSinceEdge > 1) {
          this.measuredPeriod = this.samplesSinceEdge;
        }
        this.haveFirstEdge = true;
        this.samplesSinceEdge = 0;
      }
      this.prevClock = c;
      // Forget a stale measurement after ~4 s of silence so unpatching the
      // clock reverts to the bridged syncPeriod.
      if (this.samplesSinceEdge > sr * 4) {
        this.measuredPeriod = 0;
        this.haveFirstEdge = false;
      }
      // A patched clock (measured period) overrides the bridged syncPeriod.
      s.beatPeriodS = this.measuredPeriod > 0 ? this.measuredPeriod / sr : syncPeriod;

      // ── a-rate (CV-summed) params, per sample ───────────────────────────
      s.delayTime = this.aval(parameters, 'delayTime', i, 0.2);
      s.lfoAmount = this.aval(parameters, 'lfoAmount', i, 0);
      s.driftAmount = this.aval(parameters, 'driftAmount', i, 0.001);
      s.feedback = this.aval(parameters, 'feedback', i, 0.5);
      s.pan = this.aval(parameters, 'pan', i, 0);
      s.duckAmount = this.aval(parameters, 'duckAmount', i, 0);
      s.driveGain = this.aval(parameters, 'driveGain', i, 0.1);
      // wetVolume is CV-targeted (mix_cv) — read a-rate too.
      s.wetVolume = this.aval(parameters, 'wetVolume', i, 0.5);

      const l = inL ? inL[i]! : 0;
      const r = inR ? inR[i]! : l;
      this.core.processSample(s, l, r);
      outL[i] = this.core.outL;
      outR[i] = this.core.outR;
    }

    return true;
  }
}

registerProcessor('cofefve', CofefveProcessor);
