// packages/dsp/src/moog921b.ts
//
// MOOG 921B OSCILLATOR — slave VCO driven by a 921A bus
// AudioWorkletProcessor.
//
// Batch-1 module of the Moog System 55 / 35 clone initiative
// (.myrobots/MOOG/), shipped together with the 921A driver (the 921B is
// meaningless without a 921A bus — though it can also self-stand if you
// patch a pitch source straight into freq_bus). The hardware 921B is the
// slaved oscillator: it presents FOUR fixed-level simultaneous waveform
// outs (Sine / Triangle / Saw / Rectangular) off ONE common core,
// 1 Hz–40 kHz. A FREQUENCY pot gives 2-octave fine; a RANGE switch sets the
// octave "footage"; a DC MODULATE input does LINEAR FM (non-1V/oct); an AC
// MODULATE input does cap-coupled (DC-blocked) linear FM; a SYNC input +
// 3-position sync switch (off/lo=soft/hi=hard) drives oscillator sync.
//
// DSP forks the shared own-code Moog VCO core (./lib/moog-vco-dsp.ts) — the
// same clean-room polyBLEP/polyBLAMP band-limited oscillator + hard/soft
// sync the 921 VCO uses — but is SLAVED to the freq_bus / width_bus CONTROL
// INPUTS (from the 921A) rather than carrying its own 1V/oct pitch jack.
// Permissive, not a port of any Moog schematic / copyleft source
// (.myrobots/MOOG/LICENSING.md: permissive / own-code only).
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = freq_bus   (V/oct pitch CV from the 921A; 0 = C4)
//   inputs[1] = width_bus  (0..1 pulse-width CV from the 921A)
//   inputs[2] = dc_mod     (LINEAR FM, DC-coupled — non-1V/oct, ±Hz)
//   inputs[3] = ac_mod     (LINEAR FM, AC-coupled — DC-blocking HP first)
//   inputs[4] = sync       (external sync source; rising edges reset phase)
//
// AudioParams (CV is summed in by the web factory as a-rate signals):
//   fine (FREQUENCY pot — ±1 octave of 2-octave fine, semitone-ish trim),
//   range (RANGE switch footage, in octaves), modAmount (FM depth),
//   syncMode (-1 soft / 0 off / +1 hard), level (output gain).
//
// Outputs (each mono):
//   outputs[0] = sine
//   outputs[1] = triangle
//   outputs[2] = saw
//   outputs[3] = rect

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
// captures the class via this shim — see moog921b DSP test loader).
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

// Full-scale linear-FM depth in Hz at modAmount = 1, full-scale (±1) input.
// Matches the 921 VCO's linear-FM feel (±2 kHz at unity).
const LIN_FM_FULL_HZ = 2000;

/** Simple one-pole DC blocker (cap-coupling emulation) for the AC MODULATE
 *  input. y[n] = x[n] - x[n-1] + R·y[n-1]; R near 1 = low corner. This is
 *  the textbook leaky differentiator that passes audio-rate FM but removes
 *  the DC term (so an offset on ac_mod doesn't shift the pitch). */
class DcBlocker {
  private x1 = 0;
  private y1 = 0;
  private readonly r: number;

  constructor(sampleRate: number) {
    // ~20 Hz corner: R = 1 - 2π·fc/sr.
    const fc = 20;
    this.r = 1 - (2 * Math.PI * fc) / sampleRate;
  }

  step(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

// Not `export`ed at the top level by design — see the file-header note.
class Moog921bProcessor extends AudioWorkletProcessor {
  private sr: number;
  private vco: MoogVco;
  private dcBlock: DcBlocker;

  // 80 Hz one-pole smoothers on the slowly-changing knobs (fine / range /
  // level). The freq_bus / sync / mod paths stay UNSMOOTHED so bus tracking
  // + sync timing + FM are sample-accurate.
  private smFine: WtParamSmoother;
  private smRange: WtParamSmoother;
  private smLevel: WtParamSmoother;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.vco = new MoogVco(this.sr);
    this.dcBlock = new DcBlocker(this.sr);
    this.smFine = new WtParamSmoother(this.sr);
    this.smRange = new WtParamSmoother(this.sr);
    this.smLevel = new WtParamSmoother(this.sr);
    this.smFine.prime(0);
    this.smRange.prime(0);
    this.smLevel.prime(1);
  }

  static get parameterDescriptors() {
    return [
      // FREQUENCY pot — ±1 octave of 2-octave fine trim (in semitones).
      { name: 'fine', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'a-rate' as const },
      // RANGE switch — octave footage, ±5 octaves.
      { name: 'range', defaultValue: 0, minValue: -5, maxValue: 5, automationRate: 'a-rate' as const },
      // Linear-FM depth (drives both DC + AC MODULATE inputs into ±Hz).
      { name: 'modAmount', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
      // SYNC mode — -1 soft / 0 off / +1 hard (centre-off 3-way switch).
      { name: 'syncMode', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' as const },
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

    const freqBusIn = inputs[0]?.[0];
    const widthBusIn = inputs[1]?.[0];
    const dcModIn = inputs[2]?.[0];
    const acModIn = inputs[3]?.[0];
    const syncIn = inputs[4]?.[0];

    const fineArr = parameters.fine;
    const rangeArr = parameters.range;
    const modAmtArr = parameters.modAmount;
    const syncArr = parameters.syncMode;
    const levelArr = parameters.level;

    const syncMode = syncModeFromParam(syncArr.length > 0 ? syncArr[0] : 0);

    const blockLen = (outSine ?? outTri ?? outSaw ?? outRect)!.length;

    for (let i = 0; i < blockLen; i++) {
      // SLAVED to the 921A bus: freq_bus is the V/oct pitch; width_bus is the
      // pulse width. With nothing patched the bus reads silence (0) → C4, and
      // width_bus NORMALS to 0.5 (square) so the 921B still sounds standalone.
      // A patched 921A drives width_bus at 0.5+ (its own primed default), so
      // any value at/above the pulse-clamp floor is taken as a real width.
      const voct = freqBusIn ? freqBusIn[i] : 0;
      const widthBus = widthBusIn ? widthBusIn[i] : 0;
      // < 0.02 (incl. unpatched silence) → normal to 0.5 square; else use it.
      let width = widthBus < 0.02 ? 0.5 : widthBus;

      const dcMod = dcModIn ? dcModIn[i] : 0;
      const acModRaw = acModIn ? acModIn[i] : 0;
      const sync = syncIn ? syncIn[i] : 0;

      const fineRaw = fineArr.length > 1 ? fineArr[i] : fineArr[0];
      const rangeRaw = rangeArr.length > 1 ? rangeArr[i] : rangeArr[0];
      const modAmt = modAmtArr.length > 1 ? modAmtArr[i] : modAmtArr[0];
      const levelRaw = levelArr.length > 1 ? levelArr[i] : levelArr[0];

      const fine = this.smFine.step(fineRaw);
      const range = this.smRange.step(rangeRaw);
      const level = this.smLevel.step(levelRaw);

      // AC MODULATE = cap-coupled: DC-block first so an offset doesn't bend
      // the pitch; DC MODULATE feeds straight through. Both are LINEAR FM
      // (non-1V/oct): input × depth → ±Hz.
      const acMod = this.dcBlock.step(acModRaw);
      const linFmHz = modAmt * (dcMod + acMod) * LIN_FM_FULL_HZ;

      // freq_bus is V/oct (slave pitch); range = octave footage; fine =
      // semitone trim. No separate octave term — RANGE carries it.
      const freq = moogFreqHz(voct, range, fine, linFmHz, this.sr);
      let pw = width;
      if (pw < 0.02) pw = 0.02;
      else if (pw > 0.98) pw = 0.98;

      const w = this.vco.step(freq, pw, sync, syncMode);

      if (outSine) outSine[i] = w.sine * level;
      if (outTri) outTri[i] = w.triangle * level;
      if (outSaw) outSaw[i] = w.sawtooth * level;
      if (outRect) outRect[i] = w.rectangular * level;
    }

    return true;
  }
}

registerProcessor('moog921b', Moog921bProcessor);
