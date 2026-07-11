// packages/dsp/src/tomtom.ts
//
// TOM DRUM — analog-modeled tom-tom voice AudioWorkletProcessor.
//
// The per-sample DSP lives in ./lib/tomtom-dsp.ts (MEMBRANE fundamental +
// 1.593× second mode on one exponential pitch-BEND law, band-passed BREATH
// noise, 2×-oversampled warm-tanh DRIVE, DC block, dB level, true-peak
// tanh bound). This file is the worklet wrapper that owns the frozen I/O
// surface: 9 params + 7 audio-rate inputs + the mono output.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect. Tests capture the class through a
// registerProcessor shim before importing this module. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = trigger_in (edge:'trigger' — the STRIKE; per-sample rising
//               edge prev<0.5 && cur>=0.5 detected inside the core step)
//   inputs[1] = accent_in  (cv 0..1, LATCHED at the strike edge by the core)
//   inputs[2] = pitch_cv   (1 V/oct multiplier on TUNE)
//   inputs[3] = bend_cv    (±1 V adds ±24 st of bend depth — full-swing)
//   inputs[4] = decay_cv   (2 oct of decay TIME per volt — +1 V = ×4)
//   inputs[5] = tone_cv    (sums into TONE, clamped 0..1)
//   inputs[6] = noise_cv   (sums into NOISE, clamped 0..1)
//
// The `strike` param is the card's manual STRIKE pad (the bluebox
// press-param pattern): it is OR-ed with trigger_in before the core's edge
// detector, so a pad press fires exactly one hit and an external trigger
// cable keeps working while the pad is held.
//
// Every time constant derives from the LIVE sampleRate (no 48 000 literals).

import { TOMTOM_DEFAULTS, tomtomStep, makeTomtomState, type TomtomParams, type TomtomState } from './lib/tomtom-dsp';
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
// captures the class via this shim — the registerProcessor-shim loader pattern).
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

// The frozen 9-param contract: [name, default, min, max]. Single source for
// parameterDescriptors + the smoother priming below. `strike` is the card's
// manual pad (0/1, never smoothed — its EDGE is the event).
const PARAM_TABLE: ReadonlyArray<readonly [string, number, number, number]> = [
  ['tune',      110, 60,  400],
  ['bend_amt',  7,   0,   24],
  ['bend_time', 60,  10,  300],
  ['decay',     350, 40,  1500],
  ['tone',      0.35, 0,  1],
  ['noise',     0.25, 0,  1],
  ['drive',     0.25, 0,  1],
  ['level',     0,   -24, 12],
  ['strike',    0,   0,   1],
];

// Not `export`ed at the top level by design — see the file-header note.
class TomtomProcessor extends AudioWorkletProcessor {
  private sr: number;
  private st: TomtomState;

  // Reused per-sample param object for the core (no per-sample GC).
  private p: TomtomParams;

  // One smoother per continuous param (the 80 Hz one-pole pattern);
  // `strike` (a pad edge) is read k-rate + unsmoothed.
  private sm: Record<string, WtParamSmoother> = {};

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.st = makeTomtomState();
    this.p = { ...TOMTOM_DEFAULTS };
    for (const [name, def] of PARAM_TABLE) {
      if (name === 'strike') continue; // pad edge — never smoothed
      const s = new WtParamSmoother(this.sr);
      // Prime to the default so first-sample reads aren't a ramp from 0.
      s.prime(def);
      this.sm[name] = s;
    }
  }

  static get parameterDescriptors() {
    return PARAM_TABLE.map(([name, def, min, max]) => ({
      name,
      defaultValue: def,
      minValue: min,
      maxValue: max,
      // `strike` is a discrete pad → k-rate; everything else a-rate so
      // future per-sample automation reaches the DSP.
      automationRate: (name === 'strike' ? 'k-rate' : 'a-rate') as 'a-rate' | 'k-rate',
    }));
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
    const inTrig   = inputs[0]?.[0];
    const inAccent = inputs[1]?.[0];
    const inPitch  = inputs[2]?.[0];
    const inBend   = inputs[3]?.[0];
    const inDecay  = inputs[4]?.[0];
    const inTone   = inputs[5]?.[0];
    const inNoise  = inputs[6]?.[0];
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;

    // The manual STRIKE pad (k-rate): OR-ed with trigger_in below so the
    // core's per-sample edge detector fires exactly once per press.
    const strike = this.aval(parameters, 'strike', 0, 0) >= 0.5 ? 1 : 0;

    const p = this.p;
    for (let s = 0; s < n; s++) {
      const sm = this.sm;
      const rd = (name: string, fb: number) =>
        sm[name]!.step(this.aval(parameters, name, s, fb));

      p.tune     = rd('tune', 110);
      p.bendAmt  = rd('bend_amt', 7);
      p.bendTime = rd('bend_time', 60);
      p.decay    = rd('decay', 350);
      p.tone     = rd('tone', 0.35);
      p.noise    = rd('noise', 0.25);
      p.drive    = rd('drive', 0.25);
      p.level    = rd('level', 0);
      p.pitchCv  = inPitch ? (inPitch[s] ?? 0) : 0;
      p.bendCv   = inBend ? (inBend[s] ?? 0) : 0;
      p.decayCv  = inDecay ? (inDecay[s] ?? 0) : 0;
      p.toneCv   = inTone ? (inTone[s] ?? 0) : 0;
      p.noiseCv  = inNoise ? (inNoise[s] ?? 0) : 0;

      const trig = Math.max(inTrig ? (inTrig[s] ?? 0) : 0, strike);
      const accent = inAccent ? (inAccent[s] ?? 0) : 0;
      out[s] = tomtomStep(trig, accent, p, this.sr, this.st);
    }

    return true;
  }
}

registerProcessor('tomtom', TomtomProcessor);
