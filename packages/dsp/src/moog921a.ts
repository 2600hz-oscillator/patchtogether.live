// packages/dsp/src/moog921a.ts
//
// MOOG 921A OSCILLATOR DRIVER — control-voltage processor (NOT a sound
// source) AudioWorkletProcessor.
//
// Batch-1 module of the Moog System 55 / 35 clone initiative
// (.myrobots/MOOG/), shipped together with the 921B oscillator (the 921A is
// meaningless without ≥1 slaved 921B). The hardware 921A generates the two
// CONTROL VOLTAGES that drive N 921B oscillators off a common bus: a
// frequency CV (encoding pitch) and a width CV (pulse-width). It has a
// FREQUENCY pot, a two-position frequency-RANGE switch (SEMITONE = 2-oct /
// OCTAVE = 12-oct, scaling how the FREQUENCY pot + freq CONTROL INPUT map
// onto the bus), and summing frequency + width CONTROL INPUTS.
//
// This module is CV-ONLY: NO audio inputs, NO audio outputs. It emits two
// CV signals (freq_bus, width_bus) that the 921B reads. Implemented as a
// small worklet doing pure CV math — exponential frequency mapping (the
// freq_bus CV encodes pitch in V/oct so a 921B tracks it directly) + width
// passthrough.
//
// DSP is OWN CODE — clean-room CV math, not a port of any Moog schematic /
// copyleft source (.myrobots/MOOG/LICENSING.md: permissive / own-code only).
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = freq_cv   (summing frequency CONTROL INPUT, V/oct, 0 = C4)
//   inputs[1] = width_cv  (summing width CONTROL INPUT, 0..1)
//
// AudioParams (the web factory ALSO sums CV into frequency/width via the
// AudioParam fast-path; the audio-rate inputs above are the summing CONTROL
// INPUTS):
//   frequency (FREQUENCY pot, V/oct offset on the bus),
//   freqRange (1 = SEMITONE / 2-oct, 2 = OCTAVE / 12-oct),
//   width (pulse-width 0..1).
//
// Outputs (each mono CV):
//   outputs[0] = freq_bus   (V/oct pitch CV → 921B.freq_bus)
//   outputs[1] = width_bus  (0..1 width CV → 921B.width_bus)

import { WtParamSmoother } from './lib/wavetable-osc';

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
// captures the class via this shim — see moog921a DSP test loader).
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

// FREQUENCY-RANGE switch positions.
//   SEMITONE (1): the FREQUENCY pot + freq CONTROL INPUT span ±1 octave
//                 (a tight 2-octave fine-tune compass for precise pitching).
//   OCTAVE   (2): they span ±6 octaves (a wide 12-octave coarse compass).
// The pot/input run -1..+1 (normalized); the range maps that onto V/oct.
const RANGE_SEMITONE_OCT = 1; // ±1 oct → 2-octave total compass
const RANGE_OCTAVE_OCT = 6; // ±6 oct → 12-octave total compass

/** RANGE switch → the V/oct span of the FREQUENCY pot / freq CONTROL INPUT. */
function rangeOctSpan(range: number): number {
  return Math.round(range) >= 2 ? RANGE_OCTAVE_OCT : RANGE_SEMITONE_OCT;
}

// Not `export`ed at the top level by design — see the file-header note.
class Moog921aProcessor extends AudioWorkletProcessor {
  private sr: number;

  // 80 Hz one-pole smoothers on the knobs keep CV zipper out of the bus on
  // knob drags. The audio-rate summing CONTROL INPUTS (freq_cv / width_cv)
  // are summed UNSMOOTHED so modulation stays sample-accurate.
  private smFreq: WtParamSmoother;
  private smWidth: WtParamSmoother;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.smFreq = new WtParamSmoother(this.sr);
    this.smWidth = new WtParamSmoother(this.sr);
    this.smFreq.prime(0);
    this.smWidth.prime(0.5);
  }

  static get parameterDescriptors() {
    return [
      // FREQUENCY pot — normalized -1..+1, mapped onto V/oct by the RANGE.
      // a-rate so external CV can sweep it continuously.
      { name: 'frequency', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
      // FREQUENCY-RANGE switch — 1 = SEMITONE (2-oct) / 2 = OCTAVE (12-oct).
      { name: 'freqRange', defaultValue: 1, minValue: 1, maxValue: 2, automationRate: 'k-rate' as const },
      // WIDTH — pulse width passed straight through onto width_bus (0..1).
      { name: 'width', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const freqBus = outputs[0]?.[0];
    const widthBus = outputs[1]?.[0];
    // No output buffers wired this block — nothing to do, but keep alive.
    if (!freqBus && !widthBus) return true;

    const freqCvIn = inputs[0]?.[0];
    const widthCvIn = inputs[1]?.[0];

    const freqArr = parameters.frequency;
    const rangeArr = parameters.freqRange;
    const widthArr = parameters.width;

    // RANGE is k-rate (a switch) — read once.
    const octSpan = rangeOctSpan(rangeArr.length > 0 ? rangeArr[0] : 1);

    const blockLen = (freqBus ?? widthBus)!.length;
    for (let i = 0; i < blockLen; i++) {
      const freqCv = freqCvIn ? freqCvIn[i] : 0;
      const widthCv = widthCvIn ? widthCvIn[i] : 0;

      const freqRaw = freqArr.length > 1 ? freqArr[i] : freqArr[0];
      const widthRaw = widthArr.length > 1 ? widthArr[i] : widthArr[0];

      // FREQUENCY bus CV: the smoothed FREQUENCY pot, mapped onto V/oct by
      // the RANGE compass, PLUS the summing freq CONTROL INPUT (which is
      // already in V/oct, so it sums straight through 1:1 — a 921B reads
      // freq_bus as its own V/oct pitch input). The pot is normalized
      // -1..+1; × octSpan gives the actual octave offset.
      const freqVolts = this.smFreq.step(freqRaw) * octSpan + freqCv;
      if (freqBus) freqBus[i] = freqVolts;

      // WIDTH bus CV: knob + summing width CONTROL INPUT, clamped to 0..1
      // (passthrough — the 921B applies the pulse-width directly).
      let width = this.smWidth.step(widthRaw) + widthCv;
      if (width < 0) width = 0;
      else if (width > 1) width = 1;
      if (widthBus) widthBus[i] = width;
    }

    return true;
  }
}

registerProcessor('moog921a', Moog921aProcessor);
