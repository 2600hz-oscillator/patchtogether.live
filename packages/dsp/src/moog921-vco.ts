// packages/dsp/src/moog921-vco.ts
//
// MOOG 921 VCO — voltage-controlled oscillator AudioWorkletProcessor.
//
// First module of the Moog System 55 / 35 clone initiative
// (.myrobots/MOOG/). The 921 is shared by both systems (listed under
// SYS55). DSP is OWN CODE — a clean-room polyBLEP oscillator core in
// ./lib/moog-vco-dsp.ts, not a port of any Moog schematic / copyleft
// source (.myrobots/MOOG/LICENSING.md: permissive / own-code only).
//
// The real 921 presents four simultaneous waveform jacks off one common
// oscillator core (sine / triangle / sawtooth / rectangular w/ variable
// pulse width), plus 1V/oct + linear frequency-control inputs and a
// hard/soft/off sync switch. We mirror that surface 1:1.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = pitch     (1V/oct; 0 V = C4)
//   inputs[1] = lin_fm    (linear FM, scaled by the linFmAmount param)
//   inputs[2] = sync      (external sync source; rising edges reset phase)
//   inputs[3] = width_cv  (audio-rate pulse-width CV, summed onto width)
//
// AudioParams (CV is summed in by the web factory as a-rate signals):
//   octave (coarse RANGE, in octaves), tune (fine, semitones),
//   width (rectangular pulse width 0..1), linFmAmount, sync (-1/0/+1),
//   level (output gain).
//
// Outputs (each mono):
//   outputs[0] = sine
//   outputs[1] = triangle
//   outputs[2] = sawtooth
//   outputs[3] = rectangular

import { MoogVco, moogFreqHz, syncModeFromParam } from './lib/moog-vco-dsp';
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
// captures the class via this shim — see moog921-vco DSP test loader).
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
class Moog921VcoProcessor extends AudioWorkletProcessor {
  private sr: number;
  private vco: MoogVco;

  // 80 Hz one-pole smoothers on the slowly-changing knobs (octave / tune /
  // width / level) keep CV zipper out of the audio path on knob drags. The
  // pitch + sync paths stay UNSMOOTHED so V/oct tracking + sync timing are
  // sample-accurate.
  private smOctave: WtParamSmoother;
  private smTune: WtParamSmoother;
  private smWidth: WtParamSmoother;
  private smLevel: WtParamSmoother;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.vco = new MoogVco(this.sr);
    this.smOctave = new WtParamSmoother(this.sr);
    this.smTune = new WtParamSmoother(this.sr);
    this.smWidth = new WtParamSmoother(this.sr);
    this.smLevel = new WtParamSmoother(this.sr);
    this.smOctave.prime(0);
    this.smTune.prime(0);
    this.smWidth.prime(0.5);
    this.smLevel.prime(1);
  }

  static get parameterDescriptors() {
    return [
      // RANGE / octave coarse — ±5 octaves, integer steps on the knob but
      // a-rate so external CV can sweep it continuously.
      { name: 'octave', defaultValue: 0, minValue: -5, maxValue: 5, automationRate: 'a-rate' as const },
      // FREQUENCY fine — ±12 semitones around the octave.
      { name: 'tune', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'a-rate' as const },
      // WIDTH — rectangular pulse width (duty cycle). 0.5 = square.
      { name: 'width', defaultValue: 0.5, minValue: 0.02, maxValue: 0.98, automationRate: 'a-rate' as const },
      // Linear-FM depth (the 921's linear frequency-control input). Scales
      // the lin_fm input into a ±Hz frequency offset; bipolar so a negative
      // value inverts the modulator.
      { name: 'linFmAmount', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
      // SYNC mode — -1 soft / 0 off / +1 hard (centre-off three-way switch).
      { name: 'sync', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' as const },
      // Output level.
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'a-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outSine = outputs[0]?.[0];
    const outTri = outputs[1]?.[0];
    const outSaw = outputs[2]?.[0];
    const outRect = outputs[3]?.[0];
    // No output buffers wired this block — nothing to do, but keep alive.
    if (!outSine && !outTri && !outSaw && !outRect) return true;

    const pitchIn = inputs[0]?.[0];
    const linFmIn = inputs[1]?.[0];
    const syncIn = inputs[2]?.[0];
    const widthCvIn = inputs[3]?.[0];

    const octaveArr = parameters.octave;
    const tuneArr = parameters.tune;
    const widthArr = parameters.width;
    const linFmAmtArr = parameters.linFmAmount;
    const syncArr = parameters.sync;
    const levelArr = parameters.level;

    const syncMode = syncModeFromParam(syncArr.length > 0 ? syncArr[0] : 0);

    // Use the first wired output to size the block (all share length 128).
    const blockLen = (outSine ?? outTri ?? outSaw ?? outRect)!.length;

    for (let i = 0; i < blockLen; i++) {
      const pitch = pitchIn ? pitchIn[i] : 0;
      const linFm = linFmIn ? linFmIn[i] : 0;
      const sync = syncIn ? syncIn[i] : 0;
      const widthCv = widthCvIn ? widthCvIn[i] : 0;

      const octaveRaw = octaveArr.length > 1 ? octaveArr[i] : octaveArr[0];
      const tuneRaw = tuneArr.length > 1 ? tuneArr[i] : tuneArr[0];
      const widthRaw = widthArr.length > 1 ? widthArr[i] : widthArr[0];
      const linFmAmt = linFmAmtArr.length > 1 ? linFmAmtArr[i] : linFmAmtArr[0];
      const levelRaw = levelArr.length > 1 ? levelArr[i] : levelArr[0];

      const octave = this.smOctave.step(octaveRaw);
      const tune = this.smTune.step(tuneRaw);
      let width = this.smWidth.step(widthRaw) + widthCv;
      if (width < 0.02) width = 0.02;
      else if (width > 0.98) width = 0.98;
      const level = this.smLevel.step(levelRaw);

      // Linear FM: input × depth, scaled to a musically useful ±Hz span.
      // 1.0 depth = ±2000 Hz at full-scale input (matches the analog
      // linear-FM feel; pitch tracking is exponential via the pitch input).
      const linFmHz = linFmAmt * linFm * 2000;

      const freq = moogFreqHz(pitch, octave, tune, linFmHz, this.sr);
      const w = this.vco.step(freq, width, sync, syncMode);

      if (outSine) outSine[i] = w.sine * level;
      if (outTri) outTri[i] = w.triangle * level;
      if (outSaw) outSaw[i] = w.sawtooth * level;
      if (outRect) outRect[i] = w.rectangular * level;
    }

    return true;
  }
}

registerProcessor('moog921-vco', Moog921VcoProcessor);
