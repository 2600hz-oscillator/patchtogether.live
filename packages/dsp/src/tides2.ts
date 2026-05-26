// packages/dsp/src/tides2.ts
//
// TIDES2 — tidal modulator / poly-slope generator (Mutable Instruments Tides
// 2018 archetype, Émilie Gillet, MIT-licensed). AudioWorklet wrapper around
// PolySlopeGenerator — the engine itself lives in packages/dsp/src/
// tides2-engine.ts so the host-side module def + vitest pass can reuse it
// without duplication.
//
// I/O surface:
//   inputs:
//     voct        V/oct pitch CV (audio-rate node input; octave offset)
//     trig        gate / trigger (AD/AR ramp modes; rising edge attacks)
//     clock       external clock (drives the ramp extractor in tempo-sync)
//     (k-rate AudioParam fast-path CV ports route onto frequency/shape/
//      slope/smoothness/shift params)
//   outputs:
//     out0..out3  the four related slope outputs (independent / phase-
//                 shifted / amplitude-stepped / frequency-divided per
//                 OUTPUT MODE)

import {
  PolySlopeGenerator,
  TIDES2_NUM_CHANNELS,
  RAMP_MODE_AD,
  OUTPUT_MODE_SLOPE_PHASE,
  RANGE_CONTROL,
} from './tides2-engine';

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
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

class Tides2Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'shape', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'slope', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'smoothness', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'shift', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'rampMode', defaultValue: RAMP_MODE_AD, minValue: 0, maxValue: 2, automationRate: 'k-rate' as const },
      { name: 'outputMode', defaultValue: OUTPUT_MODE_SLOPE_PHASE, minValue: 0, maxValue: 3, automationRate: 'k-rate' as const },
      { name: 'range', defaultValue: RANGE_CONTROL, minValue: 0, maxValue: 2, automationRate: 'k-rate' as const },
      { name: 'useClock', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  private engine = new PolySlopeGenerator(sampleRate);

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out0 = outputs[0]?.[0];
    if (!out0) return true;
    const n = out0.length;

    const voctArr = inputs[0]?.[0];
    const trigArr = inputs[1]?.[0];
    const clockArr = inputs[2]?.[0];

    const rampMode = Math.round(parameters.rampMode?.[0] ?? RAMP_MODE_AD);
    const outputMode = Math.round(parameters.outputMode?.[0] ?? OUTPUT_MODE_SLOPE_PHASE);
    // RANGE: 0=LFO(CONTROL), 1=AUDIO, 2=TEMPO. TEMPO maps to CONTROL band
    // + external-clock locking (handled by useClock).
    const rangeRaw = Math.round(parameters.range?.[0] ?? RANGE_CONTROL);
    const range = rangeRaw === 1 ? 1 : 0; // RANGE_AUDIO else RANGE_CONTROL
    const tempoSync = rangeRaw === 2;
    const useClock = tempoSync || (parameters.useClock?.[0] ?? 0) >= 0.5;

    const freqArr = parameters.frequency;
    const shapeArr = parameters.shape;
    const slopeArr = parameters.slope;
    const smoothArr = parameters.smoothness;
    const shiftArr = parameters.shift;

    const outChans: Array<Float32Array | undefined> = [];
    for (let c = 0; c < TIDES2_NUM_CHANNELS; c++) outChans.push(outputs[c]?.[0]);

    for (let i = 0; i < n; i++) {
      const voct = voctArr ? (voctArr[i] ?? 0) * 5 : 0; // ±1 carrier → ±5 oct
      const trig = trigArr ? (trigArr[i] ?? 0) : 0;
      const clock = clockArr ? (clockArr[i] ?? 0) : 0;

      const params = {
        frequency: freqArr ? (freqArr.length > 1 ? (freqArr[i] ?? 0.5) : freqArr[0] ?? 0.5) : 0.5,
        voct,
        shape: shapeArr ? (shapeArr.length > 1 ? (shapeArr[i] ?? 0.5) : shapeArr[0] ?? 0.5) : 0.5,
        slope: slopeArr ? (slopeArr.length > 1 ? (slopeArr[i] ?? 0.5) : slopeArr[0] ?? 0.5) : 0.5,
        smoothness: smoothArr ? (smoothArr.length > 1 ? (smoothArr[i] ?? 0.5) : smoothArr[0] ?? 0.5) : 0.5,
        shift: shiftArr ? (shiftArr.length > 1 ? (shiftArr[i] ?? 0.5) : shiftArr[0] ?? 0.5) : 0.5,
        rampMode,
        outputMode,
        range,
      };

      const vals = this.engine.render(params, trig, clock, useClock);
      for (let c = 0; c < TIDES2_NUM_CHANNELS; c++) {
        const o = outChans[c];
        if (o) o[i] = vals[c] ?? 0;
      }
    }
    return true;
  }
}

registerProcessor('tides2', Tides2Processor);
