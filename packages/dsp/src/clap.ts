// packages/dsp/src/clap.ts
//
// CLAP — analog-modeled handclap voice AudioWorkletProcessor.
//
// The per-sample DSP lives in ./lib/clap-dsp.ts (seeded noise → COLOR
// pole → Chamberlin band-pass at TONE/WIDTH → the 808 twin-VCA topology:
// a PULSES×SPREAD retrigger burst + the reverb TAIL fired at the last
// pulse, SNAP equal-power balance, 2×-oversampled warm-tanh DRIVE, DC
// block, dB level, true-peak tanh bound). This file is the worklet
// wrapper that owns the frozen I/O surface: 10 params + 5 audio-rate
// inputs + the mono output.
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
//   inputs[2] = tone_cv    (±1.5 oct/V on the band center — full-swing)
//   inputs[3] = tail_cv    (2 oct of tail TIME per volt — +1 V = ×4)
//   inputs[4] = spread_cv  (±1.3 oct/V on the burst spacing, latched per hit)
//
// The `strike` param is the card's manual CLAP pad (the bluebox
// press-param pattern): it is OR-ed with trigger_in before the core's edge
// detector, so a pad press fires exactly one clap and an external trigger
// cable keeps working while the pad is held.
//
// Every time constant derives from the LIVE sampleRate (no 48 000 literals).

import { CLAP_DEFAULTS, clapStep, makeClapState, type ClapParams, type ClapState } from './lib/clap-dsp';
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

// The frozen 10-param contract: [name, default, min, max]. Single source for
// parameterDescriptors + the smoother priming below. `strike` is the card's
// manual pad (0/1, never smoothed — its EDGE is the event); `pulses` is a
// discrete count (latched at the strike edge — smoothing an integer would
// glide it through non-values).
const PARAM_TABLE: ReadonlyArray<readonly [string, number, number, number]> = [
  ['pulses', 3,    2,   5],
  ['spread', 10,   4,   25],
  ['tone',   1000, 400, 3000],
  ['width',  0.5,  0,   1],
  ['tail',   150,  30,  800],
  ['color',  0.15, 0,   1],
  ['snap',   0.5,  0,   1],
  ['drive',  0.2,  0,   1],
  ['level',  0,    -24, 12],
  ['strike', 0,    0,   1],
];

/** Params read k-rate + UNSMOOTHED: discrete events / counts. */
const UNSMOOTHED = new Set(['strike', 'pulses']);

// Not `export`ed at the top level by design — see the file-header note.
class ClapProcessor extends AudioWorkletProcessor {
  private sr: number;
  private st: ClapState;

  // Reused per-sample param object for the core (no per-sample GC).
  private p: ClapParams;

  // One smoother per continuous param (the 80 Hz one-pole pattern).
  private sm: Record<string, WtParamSmoother> = {};

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.st = makeClapState();
    this.p = { ...CLAP_DEFAULTS };
    for (const [name, def] of PARAM_TABLE) {
      if (UNSMOOTHED.has(name)) continue;
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
      // `strike` (a pad) + `pulses` (a latched count) are discrete →
      // k-rate; everything else a-rate so future per-sample automation
      // reaches the DSP.
      automationRate: (UNSMOOTHED.has(name) ? 'k-rate' : 'a-rate') as 'a-rate' | 'k-rate',
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
    const inTone   = inputs[2]?.[0];
    const inTail   = inputs[3]?.[0];
    const inSpread = inputs[4]?.[0];
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;

    // The manual CLAP pad (k-rate): OR-ed with trigger_in below so the
    // core's per-sample edge detector fires exactly once per press.
    const strike = this.aval(parameters, 'strike', 0, 0) >= 0.5 ? 1 : 0;
    // Discrete pulse count (k-rate, unsmoothed — the core latches it at
    // the strike edge).
    const pulses = this.aval(parameters, 'pulses', 0, 3);

    const p = this.p;
    for (let s = 0; s < n; s++) {
      const sm = this.sm;
      const rd = (name: string, fb: number) =>
        sm[name]!.step(this.aval(parameters, name, s, fb));

      p.pulses   = pulses;
      p.spread   = rd('spread', 10);
      p.tone     = rd('tone', 1000);
      p.width    = rd('width', 0.5);
      p.tail     = rd('tail', 150);
      p.color    = rd('color', 0.15);
      p.snap     = rd('snap', 0.5);
      p.drive    = rd('drive', 0.2);
      p.level    = rd('level', 0);
      p.toneCv   = inTone ? (inTone[s] ?? 0) : 0;
      p.tailCv   = inTail ? (inTail[s] ?? 0) : 0;
      p.spreadCv = inSpread ? (inSpread[s] ?? 0) : 0;

      const trig = Math.max(inTrig ? (inTrig[s] ?? 0) : 0, strike);
      const accent = inAccent ? (inAccent[s] ?? 0) : 0;
      out[s] = clapStep(trig, accent, p, this.sr, this.st);
    }

    return true;
  }
}

registerProcessor('clap', ClapProcessor);
