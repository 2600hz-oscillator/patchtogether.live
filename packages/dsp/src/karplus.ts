// packages/dsp/src/karplus.ts
//
// KARPLUS — extended Karplus-Strong string/harp voice AudioWorkletProcessor.
//
// The per-sample DSP lives in ./lib/karplus-dsp.ts (the EKS chain built on
// cofefve's DelayChannel: seeded burst → color LP → pick-position comb →
// fractional string loop with f0-tracked brightness damping, dispersion
// allpasses, tracked DC blocker and the Jaffe–Smith frequency-compensated
// decay). This file is the worklet wrapper that owns the frozen I/O
// surface: 8 params + 4 inputs + one mono output.
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
//   inputs[1] = pitch      (1V/oct; f0 = tune × 2^V, C4-referenced knob)
//   inputs[2] = accent_in  (cv 0..1, LATCHED at the strike edge by the core)
//   inputs[3] = damp_in    (edge:'gate' — palm-mutes WHILE high, releases on
//               the falling edge; level-sensitive by construction)
//
// AudioParams: the 8-param frozen contract (see the def). All continuous —
// smoothed with WtParamSmoother (80 Hz one-pole pattern).
//
// Every time constant derives from the LIVE sampleRate (no 48 000 literals).

import {
  KARPLUS_DEFAULTS,
  karplusStep,
  makeKarplusState,
  type KarplusParams,
  type KarplusState,
} from './lib/karplus-dsp';
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

// The frozen 8-param contract: [name, default, min, max]. Single source for
// parameterDescriptors + the smoother priming below.
const PARAM_TABLE: ReadonlyArray<readonly [string, number, number, number]> = [
  ['tune',       220,  55,   1760],
  ['decay',      2,    0.1,  10],
  ['brightness', 0.7,  0,    1],
  ['position',   0.2,  0.02, 0.5],
  ['stiffness',  0,    0,    1],
  ['color',      0.6,  0,    1],
  ['burst',      1,    0.1,  4],
  ['level',      0,    -24,  12],
];

// Not `export`ed at the top level by design — see the file-header note.
class KarplusProcessor extends AudioWorkletProcessor {
  private sr: number;
  private st: KarplusState;

  // Reused per-sample param object for the core (no per-sample GC).
  private p: KarplusParams;

  // One smoother per param (the 80 Hz one-pole pattern).
  private sm: Record<string, WtParamSmoother> = {};

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.st = makeKarplusState(this.sr);
    this.p = { ...KARPLUS_DEFAULTS };
    for (const [name, def] of PARAM_TABLE) {
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
      // a-rate so per-sample CV modulation reaches the DSP.
      automationRate: 'a-rate' as const,
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
    const inTrig = inputs[0]?.[0];
    const inPitch = inputs[1]?.[0];
    const inAccent = inputs[2]?.[0];
    const inDamp = inputs[3]?.[0];
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;

    const p = this.p;
    for (let s = 0; s < n; s++) {
      const sm = this.sm;
      const rd = (name: string, fb: number) =>
        sm[name]!.step(this.aval(parameters, name, s, fb));

      p.tune       = rd('tune', 220);
      p.decay      = rd('decay', 2);
      p.brightness = rd('brightness', 0.7);
      p.position   = rd('position', 0.2);
      p.stiffness  = rd('stiffness', 0);
      p.color      = rd('color', 0.6);
      p.burst      = rd('burst', 1);
      p.level      = rd('level', 0);
      p.pitchCv    = inPitch ? (inPitch[s] ?? 0) : 0;

      const trig = inTrig ? (inTrig[s] ?? 0) : 0;
      const accent = inAccent ? (inAccent[s] ?? 0) : 0;
      const damp = inDamp ? (inDamp[s] ?? 0) : 0;
      out[s] = karplusStep(trig, accent, damp, p, this.sr, this.st);
    }

    return true;
  }
}

registerProcessor('karplus', KarplusProcessor);
