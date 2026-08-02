// packages/dsp/src/warrensspectrum.ts
//
// WARREN'S SPECTRUM — AudioWorkletProcessor wrapper.
//
// The engine lives in ./lib/warrensspectrum-dsp.ts (ONE implementation,
// shared by the worklet, the unit gates and the ART profile). This file is
// only the AudioWorklet shell: parameter descriptors, the three audio-rate
// inputs, and the per-sample loop.
//
// I/O (must stay in this order — the def's factory maps by input index):
//   input 0  audio_in  mono audio under analysis
//   input 1  pitch     V/oct → multiplicative transposition on the bank
//   input 2  gate      FREEZE while high (level, not edge — see below)
//   output 0 out       mono resynth
//
// FREEZE is LEVEL-SENSITIVE, not an edge toggle. The VST's `engineFreeze` is
// a held boolean (`PluginParams.h:141-142`), and CLAUDE.md's gate/trigger
// rule says a level-sensitive consumer declares `edge: 'gate'` and READS THE
// LEVEL. So the port is a true gate: frozen while high, thawed when it falls.
// The FREEZE control and the gate input OR together.

import { WarrensSpectrumEngine } from './lib/warrensspectrum-dsp';

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

/** GATE_HI mirrors $lib/audio/gate-trigger — a gate is "high" at >= 0.5. */
const GATE_HI = 0.5;

class WarrensSpectrumProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Every descriptor's min/max/default MUST equal the ParamDef in
      // packages/web/src/lib/audio/modules/warrensspectrum.ts — a card or a
      // CV path that writes past an AudioParam's range is silently clamped,
      // which is the "control lies about its own range" failure class.
      { name: 'spectralPartials', defaultValue: 64, minValue: 1, maxValue: 256, automationRate: 'k-rate' as const },
      { name: 'spectralFloor', defaultValue: -42, minValue: -90, maxValue: -20, automationRate: 'k-rate' as const },
      { name: 'spectralStab', defaultValue: 3, minValue: 1, maxValue: 16, automationRate: 'k-rate' as const },
      { name: 'spectralLock', defaultValue: 0.75, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'spectralResidual', defaultValue: 0.5, minValue: 0, maxValue: 2, automationRate: 'k-rate' as const },
      { name: 'spectralShape', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'spectralSlew', defaultValue: 0.6, minValue: 0.02, maxValue: 4, automationRate: 'k-rate' as const },
      { name: 'spectralSlice', defaultValue: 10, minValue: 2, maxValue: 200, automationRate: 'k-rate' as const },
      { name: 'spectralCenter', defaultValue: 0, minValue: -3600, maxValue: 3600, automationRate: 'k-rate' as const },
      { name: 'engineFreeze', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'gain', defaultValue: 0, minValue: -60, maxValue: 12, automationRate: 'k-rate' as const },
    ];
  }

  private engine = new WarrensSpectrumEngine(sampleRate);

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;

    const audioIn = inputs[0]?.[0] ?? null;
    const pitchIn = inputs[1]?.[0] ?? null;
    const gateIn = inputs[2]?.[0] ?? null;

    const e = this.engine;
    // k-rate: one pull per render quantum. The analyser commits at most once
    // every 96 samples (SLICE's 2 ms floor), so a per-quantum parameter pull
    // cannot skip a commit's worth of change.
    e.setPartials(parameters.spectralPartials![0]!);
    e.setFloorDb(parameters.spectralFloor![0]!);
    e.setStabilityFrames(parameters.spectralStab![0]!);
    e.setLock(parameters.spectralLock![0]!);
    e.setResidual(parameters.spectralResidual![0]!);
    e.setShape(parameters.spectralShape![0]!);
    e.setSlewSeconds(parameters.spectralSlew![0]!);
    e.setSliceMs(parameters.spectralSlice![0]!);
    e.setCenterCents(parameters.spectralCenter![0]!);
    e.setGainLinear(Math.pow(10, parameters.gain![0]! / 20));

    const freezeParam = parameters.engineFreeze![0]! >= 0.5;

    for (let i = 0; i < out.length; i++) {
      // FREEZE: the control OR the gate level. Read per sample so a gate
      // that opens mid-quantum freezes on the sample it opened.
      const gateHigh = gateIn ? gateIn[i]! >= GATE_HI : false;
      e.setFrozen(freezeParam || gateHigh);
      // V/oct: 1 volt = 1 octave, applied post-analysis to the whole bank.
      const volts = pitchIn ? pitchIn[i]! : 0;
      const transpose = volts === 0 ? 1 : Math.pow(2, volts);
      out[i] = e.processSample(audioIn ? audioIn[i]! : 0, transpose);
    }

    return true;
  }
}

registerProcessor('warrensspectrum', WarrensSpectrumProcessor);
