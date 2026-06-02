// packages/dsp/src/moog904a.ts
//
// MOOG 904A — Voltage Controlled Low Pass Filter AudioWorkletProcessor.
//
// Slice 2 of the Moog System 55 / 35 clone initiative (.myrobots/MOOG/).
// The 904A is the classic transistor-ladder LPF: 24 dB/oct, with a
// FIXED CONTROL VOLTAGE (cutoff) pot, a RANGE switch (shifts cutoff in
// 2-octave steps), summed 1 V/oct CONTROL INPUTS, and a REGENERATION pot
// (variable Q / internal feedback) that self-oscillates into a clean sine
// VC generator near max. The 904A appears in BOTH systems (S35×1, S55×2) →
// shared → categorized under Moog → SYS55.
//
// DSP is OWN CODE / CLEAN-ROOM — the shared transistor-ladder core in
// ./lib/moog-ladder-dsp.ts (TPT/Zavalishin zero-delay feedback + the
// Huovilainen tanh-per-stage TECHNIQUE). NOT a port of the LGPLv3
// Huovilainen reference code / CSound opcodes, NOT the CC-BY-SA musicdsp
// model, NOT any Moog schematic. (.myrobots/MOOG/LICENSING.md: permissive
// / own-code only.) The same lib is reused by 904B (HPF) + 904C (coupler)
// in later slices.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = audio       (signal to be filtered)
//   inputs[1] = cutoff_cv   (1 V/oct CONTROL INPUT, summed onto cutoff)
//   inputs[2] = reso_cv     (REGENERATION CV, summed onto regeneration)
//
// AudioParams (the web factory ALSO sums CV into cutoff/regeneration via
// the AudioParam fast-path; the audio-rate inputs above are the summing
// CONTROL INPUTS):
//   cutoff (FIXED CONTROL VOLTAGE, Hz), range (RANGE switch 1/2/3),
//   regeneration (0..1, self-osc near 1).
//
// Outputs (mono):
//   outputs[0] = audio (24 dB/oct low-pass)

import { MoogLadder, regenToK, rangeMultiplier } from './lib/moog-ladder-dsp';
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
// captures the class via this shim — see moog904a DSP test loader).
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
class Moog904aProcessor extends AudioWorkletProcessor {
  private sr: number;
  private ladder: MoogLadder;

  // 80 Hz one-pole smoothers on the knobs keep CV zipper out of the audio
  // path on knob drags. cutoff is smoothed in Hz; regeneration in its 0..1
  // domain. The audio-rate CONTROL INPUTS (cutoff_cv / reso_cv) are summed
  // UNSMOOTHED so modulation stays sample-accurate.
  private smCutoff: WtParamSmoother;
  private smRegen: WtParamSmoother;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.ladder = new MoogLadder(this.sr);
    this.smCutoff = new WtParamSmoother(this.sr);
    this.smRegen = new WtParamSmoother(this.sr);
    this.smCutoff.prime(1000);
    this.smRegen.prime(0);
  }

  static get parameterDescriptors() {
    return [
      // FIXED CONTROL VOLTAGE — the cutoff pot, in Hz (log knob on the UI
      // side). a-rate so external CV can sweep it continuously.
      { name: 'cutoff', defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'a-rate' as const },
      // RANGE switch — 1/2/3, each ~2 octaves apart (×1 / ×4 / ×16).
      { name: 'range', defaultValue: 2, minValue: 1, maxValue: 3, automationRate: 'k-rate' as const },
      // REGENERATION — variable Q / internal feedback. Self-oscillates near 1.
      { name: 'regeneration', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    // No output buffer wired this block — nothing to do, but keep alive.
    if (!out) return true;

    const audioIn = inputs[0]?.[0];
    const cutoffCvIn = inputs[1]?.[0];
    const resoCvIn = inputs[2]?.[0];

    const cutoffArr = parameters.cutoff;
    const rangeArr = parameters.range;
    const regenArr = parameters.regeneration;

    // RANGE is k-rate (a switch, not a swept value) — read once.
    const range = rangeArr.length > 0 ? rangeArr[0] : 2;
    const rangeMul = rangeMultiplier(range);

    const blockLen = out.length;
    for (let i = 0; i < blockLen; i++) {
      const x = audioIn ? audioIn[i] : 0;
      const cutoffCv = cutoffCvIn ? cutoffCvIn[i] : 0;
      const resoCv = resoCvIn ? resoCvIn[i] : 0;

      const cutoffRaw = cutoffArr.length > 1 ? cutoffArr[i] : cutoffArr[0];
      const regenRaw = regenArr.length > 1 ? regenArr[i] : regenArr[0];

      // Smooth the knobs, then apply RANGE (×4 per position) + the 1 V/oct
      // CONTROL INPUT (exponential: each volt = one octave). The AudioParam
      // fast-path already summed any cv→cutoff routing into cutoffRaw; the
      // dedicated audio-rate cutoff_cv input is the 904A's summing 1 V/oct
      // jack, applied multiplicatively here.
      const cutoffKnob = this.smCutoff.step(cutoffRaw);
      let cutoffHz = cutoffKnob * rangeMul * Math.pow(2, cutoffCv);
      if (cutoffHz < 20) cutoffHz = 20;
      else if (cutoffHz > 20000) cutoffHz = 20000;

      let regen = this.smRegen.step(regenRaw) + resoCv;
      if (regen < 0) regen = 0;
      else if (regen > 1) regen = 1;
      const k = regenToK(regen);

      // tanh drive scales with regeneration so the growl + self-oscillation
      // come up as REGENERATION is turned toward max (clean at low Q,
      // saturating/self-oscillating near 1). Floor keeps a touch of analog
      // warmth even at low resonance.
      const drive = 0.5 + regen * 0.8;

      // Thermal-noise floor. A real transistor ladder self-oscillates
      // because circuit noise bootstraps the resonance once the loop gain
      // passes unity; a perfectly-zero digital input sits at a stable
      // equilibrium and never starts. We inject a tiny noise floor, scaled
      // by regeneration^4 so it's utterly inaudible during normal filtering
      // (regen low → ~0) yet enough to seed the sine when REGENERATION is
      // near max. Amplitude ~3e-6 at full regen — ~110 dB below the signal.
      const dither = (Math.random() - 0.5) * 6e-6 * regen * regen * regen * regen;

      out[i] = this.ladder.step(x + dither, cutoffHz, k, drive).lp4;
    }

    return true;
  }
}

registerProcessor('moog904a', Moog904aProcessor);
