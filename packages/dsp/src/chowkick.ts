// packages/dsp/src/chowkick.ts
//
// CHOWKICK — synth-kick AudioWorkletProcessor.
//
// Hand-port of ChowKick (https://github.com/Chowdhury-DSP/ChowKick,
// BSD-3-Clause) by Jatin Chowdhury / chowdsp. Per-sample DSP math lives
// in ./lib/chowkick-dsp.ts; this file is the worklet wrapper that owns the
// I/O surface and parameter-smoother lifecycle.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect. Tests capture the class through a
// registerProcessor shim before importing this module. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = gate_in (rising edge fires a kick)
//   inputs[1] = pitch_cv (1V/oct; freq target *= 2^pitch_cv)
//
// AudioParams (CV is summed in by the web factory as a-rate signals):
//   width, amplitude, decay, sustain, noise_amount, noise_decay,
//   noise_cutoff, noise_type, freq, q, damping, tight, bounce, tone,
//   portamento, level, link
//
// Output: outputs[0] = audio_out (mono).

import {
  type NoiseType,
  type PulseState,
  type NoiseState,
  type ResonantState,
  type OutputState,
  makePulseState,
  makeNoiseState,
  makeResonantState,
  makeOutputState,
  pulseShaperStep,
  noiseBurstStep,
  resonantCoefs,
  resonantFilterStep,
  outputFilterStep,
  portamentoCoeff,
  portamentoStep,
  clamp,
} from './lib/chowkick-dsp';

// WtParamSmoother lives in wavetable-osc.ts as a small reusable 80-Hz
// one-pole knob smoother. Lifted here per PR #435's wavecel pattern so
// per-sample param sums (CV) reach the DSP without zipper noise when the
// user drags a knob.
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
// captures the class via this shim — see chowkick.test.ts loader pattern,
// matching sidecar.test.ts).
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
class ChowkickProcessor extends AudioWorkletProcessor {
  private sr: number;

  // Per-voice DSP state — single mono voice (gate-triggered).
  private pulseSt: PulseState;
  private noiseSt: NoiseState;
  private resSt: ResonantState;
  private outSt: OutputState;

  // Persistent gate edge-detect for the noise burst (mirrors the pulse
  // shaper's own edge detect — both look at the same gate input but the
  // noise envelope retriggers on its own).
  private noiseGatePrev = { v: false };

  // Portamento smoother state (last-sample target freq in Hz).
  private freqSmoothed = 80;

  // Knob smoothers — 80 Hz one-pole on the slowly-changing params keeps
  // CV-zipper out of the audio path on knob drags. Per PR #435, the gate
  // + pitch path stays *unsmoothed* so trigger timing is sample-accurate.
  private smWidth: WtParamSmoother;
  private smAmp: WtParamSmoother;
  private smDecay: WtParamSmoother;
  private smSustain: WtParamSmoother;
  private smNoiseAmt: WtParamSmoother;
  private smNoiseDec: WtParamSmoother;
  private smNoiseCut: WtParamSmoother;
  private smFreq: WtParamSmoother;
  private smQ: WtParamSmoother;
  private smDamping: WtParamSmoother;
  private smTight: WtParamSmoother;
  private smBounce: WtParamSmoother;
  private smTone: WtParamSmoother;
  private smLevel: WtParamSmoother;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.pulseSt = makePulseState();
    this.noiseSt = makeNoiseState();
    this.resSt = makeResonantState();
    this.outSt = makeOutputState();
    this.smWidth = new WtParamSmoother(this.sr);
    this.smAmp = new WtParamSmoother(this.sr);
    this.smDecay = new WtParamSmoother(this.sr);
    this.smSustain = new WtParamSmoother(this.sr);
    this.smNoiseAmt = new WtParamSmoother(this.sr);
    this.smNoiseDec = new WtParamSmoother(this.sr);
    this.smNoiseCut = new WtParamSmoother(this.sr);
    this.smFreq = new WtParamSmoother(this.sr);
    this.smQ = new WtParamSmoother(this.sr);
    this.smDamping = new WtParamSmoother(this.sr);
    this.smTight = new WtParamSmoother(this.sr);
    this.smBounce = new WtParamSmoother(this.sr);
    this.smTone = new WtParamSmoother(this.sr);
    this.smLevel = new WtParamSmoother(this.sr);
    // Prime smoothers to the defaults so first-sample reads aren't a ramp.
    this.smWidth.prime(1);
    this.smAmp.prime(1);
    this.smDecay.prime(1);
    this.smSustain.prime(0.5);
    this.smNoiseAmt.prime(0);
    this.smNoiseDec.prime(0.5);
    this.smNoiseCut.prime(500);
    this.smFreq.prime(80);
    this.smQ.prime(0.5);
    this.smDamping.prime(0.5);
    this.smTight.prime(0.5);
    this.smBounce.prime(0);
    this.smTone.prime(800);
    this.smLevel.prime(0);
    this.freqSmoothed = 80;
  }

  static get parameterDescriptors() {
    return [
      // a-rate so CV reaches the DSP per-sample.
      { name: 'width',         defaultValue: 1,    minValue: 0.1, maxValue: 50,   automationRate: 'a-rate' as const },
      { name: 'amplitude',     defaultValue: 1,    minValue: 0,   maxValue: 2,    automationRate: 'a-rate' as const },
      { name: 'decay',         defaultValue: 1,    minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'sustain',       defaultValue: 0.5,  minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'noise_amount',  defaultValue: 0,    minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'noise_decay',   defaultValue: 0.5,  minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'noise_cutoff',  defaultValue: 500,  minValue: 20,  maxValue: 5000, automationRate: 'a-rate' as const },
      // discrete; 0..3 = Uniform/Gaussian/Pink/Velvet. k-rate (won't smooth).
      { name: 'noise_type',    defaultValue: 0,    minValue: 0,   maxValue: 3,    automationRate: 'k-rate' as const },
      { name: 'freq',          defaultValue: 80,   minValue: 20,  maxValue: 500,  automationRate: 'a-rate' as const },
      { name: 'q',             defaultValue: 0.5,  minValue: 0.1, maxValue: 10,   automationRate: 'a-rate' as const },
      { name: 'damping',       defaultValue: 0.5,  minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'tight',         defaultValue: 0.5,  minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'bounce',        defaultValue: 0,    minValue: 0,   maxValue: 1,    automationRate: 'a-rate' as const },
      { name: 'tone',          defaultValue: 800,  minValue: 50,  maxValue: 2000, automationRate: 'a-rate' as const },
      { name: 'portamento',    defaultValue: 0.5,  minValue: 0,   maxValue: 100,  automationRate: 'k-rate' as const },
      { name: 'level',         defaultValue: 0,    minValue: -60, maxValue: 0,    automationRate: 'a-rate' as const },
      // 0 = off, 1 = on. LINK couples Q + Damping (per upstream: when LINK
      // is on, dragging Q also nudges damping so the body+ring stay glued).
      // Currently k-rate; we apply the coupling per-block in process().
      { name: 'link',          defaultValue: 0,    minValue: 0,   maxValue: 1,    automationRate: 'k-rate' as const },
    ];
  }

  private aval(p: Record<string, Float32Array>, name: string, s: number, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return (arr.length > 1 ? arr[s] : arr[0]) as number;
  }
  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const inGate = inputs[0]?.[0];
    const inPitch = inputs[1]?.[0];
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;

    // Block-constant knobs (k-rate or smoothed-per-sample).
    const noiseType = (clamp(Math.round(this.kval(parameters, 'noise_type', 0)), 0, 3)) as NoiseType;
    const portamento_ms = this.kval(parameters, 'portamento', 0.5);
    const portAlpha = portamentoCoeff(portamento_ms, this.sr);
    const linkOn = this.kval(parameters, 'link', 0) >= 0.5;

    for (let s = 0; s < n; s++) {
      // Per-sample params (CV-summed + smoothed at 80 Hz).
      const widthRaw   = this.aval(parameters, 'width', s, 1);
      const ampRaw     = this.aval(parameters, 'amplitude', s, 1);
      const decayRaw   = clamp(this.aval(parameters, 'decay', s, 1), 0, 1);
      const sustainRaw = clamp(this.aval(parameters, 'sustain', s, 0.5), 0, 1);
      const nAmtRaw    = clamp(this.aval(parameters, 'noise_amount', s, 0), 0, 1);
      const nDecRaw    = clamp(this.aval(parameters, 'noise_decay', s, 0.5), 0, 1);
      const nCutRaw    = clamp(this.aval(parameters, 'noise_cutoff', s, 500), 20, 5000);
      const freqRaw    = clamp(this.aval(parameters, 'freq', s, 80), 20, 500);
      const qRaw       = clamp(this.aval(parameters, 'q', s, 0.5), 0.1, 10);
      const dampRaw    = clamp(this.aval(parameters, 'damping', s, 0.5), 0, 1);
      const tightRaw   = clamp(this.aval(parameters, 'tight', s, 0.5), 0, 1);
      const bounceRaw  = clamp(this.aval(parameters, 'bounce', s, 0), 0, 1);
      const toneRaw    = clamp(this.aval(parameters, 'tone', s, 800), 50, 2000);
      const levelRaw   = clamp(this.aval(parameters, 'level', s, 0), -60, 0);

      const width   = this.smWidth.step(widthRaw);
      const amp     = this.smAmp.step(ampRaw);
      const decay   = this.smDecay.step(decayRaw);
      const sustain = this.smSustain.step(sustainRaw);
      const nAmt    = this.smNoiseAmt.step(nAmtRaw);
      const nDec    = this.smNoiseDec.step(nDecRaw);
      const nCut    = this.smNoiseCut.step(nCutRaw);
      const freqK   = this.smFreq.step(freqRaw);
      let q         = this.smQ.step(qRaw);
      let damping   = this.smDamping.step(dampRaw);
      const tight   = this.smTight.step(tightRaw);
      const bounce  = this.smBounce.step(bounceRaw);
      const tone    = this.smTone.step(toneRaw);
      const level   = this.smLevel.step(levelRaw);

      // LINK: couple Q ↔ damping per upstream. We use a midpoint blend so
      // either knob effectively drives both — keeps the "tightness" feel.
      if (linkOn) {
        const m = 0.5 * (q / 10 + damping); // normalize q to 0..1 then mean.
        q = clamp(m * 10, 0.1, 10);
        damping = clamp(m, 0, 1);
      }

      // Pitch CV (1V/oct).
      const pitchCv = inPitch ? (inPitch[s] ?? 0) : 0;
      const freqTarget = clamp(freqK * Math.pow(2, pitchCv), 20, 0.45 * this.sr);
      this.freqSmoothed = portAlpha >= 1
        ? freqTarget
        : portamentoStep(freqTarget, this.freqSmoothed, portAlpha);

      const gate = inGate ? (inGate[s] ?? 0) : 0;

      // Pulse shaper → noise burst → sum → resonant filter → output filter.
      const pulse = pulseShaperStep(gate, width, amp, decay, sustain, this.sr, this.pulseSt);
      const noise = noiseBurstStep(gate, nAmt, nDec, nCut, noiseType, this.sr, this.noiseSt, this.noiseGatePrev);
      const drive = pulse + noise;

      const coefs = resonantCoefs(this.freqSmoothed, q, damping, tight, bounce, this.sr);
      const body = resonantFilterStep(drive, coefs, this.resSt);

      out[s] = outputFilterStep(body, tone, level, this.sr, this.outSt);
    }

    return true;
  }
}

registerProcessor('chowkick', ChowkickProcessor);
