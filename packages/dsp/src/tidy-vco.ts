// packages/dsp/src/tidy-vco.ts
//
// TIDY VCO — virtual-analog subtractive synth voice AudioWorkletProcessor.
//
// The per-sample DSP lives in ./lib/tidy-vco-dsp.ts (2× polyBLEP morph
// oscillators + sub → nonlinear ZDF DIODE LADDER @2× oversampling → dual
// RC-punch ADSR → OTA-flavored VCA → equal-power stereo bus → DC block →
// dB level → true-peak tanh bound). This file is the worklet wrapper that
// owns the frozen I/O surface: 23 params + 27 audio-rate inputs (poly + mono
// pitch/gate + a per-knob CV for EVERY continuous control) + the stereo
// out_l/out_r pair.
//
// The osc bus passes through a STEREO WAVEFOLDER (ADAA triangle folder,
// FOLD + SYMMETRY, per-channel decorrelated) BEFORE the diode ladder — the
// classic West-Coast timbre-into-filter voice. FOLD 0 is a bit-exact bypass.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect. Tests capture the class through a
// registerProcessor shim before importing this module. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = poly       (polyPitchGate: 10 channels, (p0,g0,…,p4,g4);
//                           lane i → voice i, block-rate lane snapshot)
//   inputs[1] = pitch      (mono V/oct, 0 V = C4 — drives the 2-voice
//                           unison when no poly lane is gated)
//   inputs[2] = gate       (mono gate, edge:'gate' — level-sensitive,
//                           note-off → release; poly lanes take precedence)
//   inputs[3] = cutoff_cv  (4 oct/V on the filter cutoff — full-swing)
//   inputs[4] = res_cv     (±1 V = the whole RES range)
//   inputs[5] = pwm_cv     (±0.45 duty/V on the shared pulse width)
//   inputs[6] = drive_cv   (±1 V = the whole DRIVE range)
//   inputs[7] = fold_cv    (±1 V = the whole FOLD range — full-swing)
//   inputs[8] = sym_cv     (±1 V = the whole SYMMETRY range each way)
//   inputs[9..26] = one GLOBAL per-knob CV for the remaining controls, in
//                   order: shape1, shape2, detune, oct2, mix, sub, env, track,
//                   fatk, fdec, fsus, frel, atk, dec, sus, rel, width, level.
//                   Block-rate scalars (applied to all 5 voices in the core);
//                   each scaling law lives in lib/tidy-vco-dsp.ts and is a
//                   perfect no-op at cv = 0, so an unpatched input (fed the
//                   0-offset silence source by the factory) leaves the render
//                   byte-identical.
//
// cutoff_cv + pwm_cv + fold_cv + sym_cv are fed to the core PER SAMPLE
// (audio-rate filter FM / PWM / wavefold); res_cv + drive_cv + the 18 new
// per-knob CVs are block-rate (they re-derive per-block coefficients). Knob
// params are read once per 128-sample block through an
// 80 Hz one-pole smoother stepped at block rate (the poly gates themselves
// are block-rate — the house pente/cube pattern). The HOLD param is the
// card's manual gate pad: OR-ed with the mono gate input, so the pad
// drones the voice while an external gate cable keeps working.
//
// Every time constant derives from the LIVE sampleRate (no 48 000 literals).

import {
  TIDY_VCO_DEFAULTS,
  TIDY_VOICES,
  makeTidyVcoState,
  renderTidyVco,
  type TidyVcoBus,
  type TidyVcoParams,
  type TidyVcoState,
} from './lib/tidy-vco-dsp';

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

// The frozen 23-param contract: [name, default, min, max]. Single source
// for parameterDescriptors + the block-rate smoother priming below.
// `oct2` is a discrete octave switch and `hold` is the card's manual gate
// pad — both k-rate + unsmoothed (smoothing a switch glides it through
// non-values; the pad's LEVEL is the event).
const PARAM_TABLE: ReadonlyArray<readonly [string, number, number, number]> = [
  ['shape1', TIDY_VCO_DEFAULTS.shape1, 0, 1],
  ['shape2', TIDY_VCO_DEFAULTS.shape2, 0, 1],
  ['pw',     TIDY_VCO_DEFAULTS.pw,     0.05, 0.5],
  ['detune', TIDY_VCO_DEFAULTS.detune, -50, 50],
  ['oct2',   TIDY_VCO_DEFAULTS.oct2,   -1, 1],
  ['mix',    TIDY_VCO_DEFAULTS.mix,    0, 1],
  ['sub',    TIDY_VCO_DEFAULTS.sub,    0, 1],
  ['fold',   TIDY_VCO_DEFAULTS.fold,   0, 1],
  ['sym',    TIDY_VCO_DEFAULTS.sym,    -1, 1],
  ['cutoff', TIDY_VCO_DEFAULTS.cutoff, 40, 14000],
  ['res',    TIDY_VCO_DEFAULTS.res,    0, 1],
  ['drive',  TIDY_VCO_DEFAULTS.drive,  0, 1],
  ['env',    TIDY_VCO_DEFAULTS.env,    -1, 1],
  ['track',  TIDY_VCO_DEFAULTS.track,  0, 1],
  ['fatk',   TIDY_VCO_DEFAULTS.fatk,   0.0005, 5],
  ['fdec',   TIDY_VCO_DEFAULTS.fdec,   0.001, 5],
  ['fsus',   TIDY_VCO_DEFAULTS.fsus,   0, 1],
  ['frel',   TIDY_VCO_DEFAULTS.frel,   0.001, 5],
  ['atk',    TIDY_VCO_DEFAULTS.atk,    0.0005, 5],
  ['dec',    TIDY_VCO_DEFAULTS.dec,    0.001, 5],
  ['sus',    TIDY_VCO_DEFAULTS.sus,    0, 1],
  ['rel',    TIDY_VCO_DEFAULTS.rel,    0.001, 5],
  ['width',  TIDY_VCO_DEFAULTS.width,  0, 1],
  ['level',  TIDY_VCO_DEFAULTS.level,  -24, 12],
  ['hold',   0,                        0, 1],
];

/** Params read k-rate + UNSMOOTHED: discrete switches / pads. */
const UNSMOOTHED = new Set(['oct2', 'hold']);

/** Block-rate one-pole knob smoother (80 Hz corner at the BLOCK rate —
 *  the render consumes knobs per 128-sample block, so the smoother steps
 *  once per block with a correctly scaled coefficient). */
class BlockSmoother {
  private v: number;
  private alpha: number;
  constructor(sr: number, blockLen: number, cornerHz = 80, prime = 0) {
    this.v = prime;
    this.alpha = 1 - Math.exp((-2 * Math.PI * cornerHz * blockLen) / sr);
  }
  step(target: number): number {
    this.v += this.alpha * (target - this.v);
    return this.v;
  }
}

// Not `export`ed at the top level by design — see the file-header note.
class TidyVcoProcessor extends AudioWorkletProcessor {
  private sr: number;
  private st: TidyVcoState;
  private p: TidyVcoParams;
  private bus: TidyVcoBus & { poly: Float32Array };
  private sm: Record<string, BlockSmoother> = {};
  private smReady = false;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.st = makeTidyVcoState();
    this.p = { ...TIDY_VCO_DEFAULTS };
    this.bus = {
      poly: new Float32Array(TIDY_VOICES * 2),
      monoPitch: 0,
      monoGate: 0,
      cutoffCv: 0,
      pwmCv: 0,
      foldCv: 0,
      symCv: 0,
      resCv: 0,
      driveCv: 0,
      // Per-knob CV for EVERY remaining control (GLOBAL block-rate scalars).
      shape1Cv: 0,
      shape2Cv: 0,
      detuneCv: 0,
      oct2Cv: 0,
      mixCv: 0,
      subCv: 0,
      envCv: 0,
      trackCv: 0,
      fatkCv: 0,
      fdecCv: 0,
      fsusCv: 0,
      frelCv: 0,
      atkCv: 0,
      decCv: 0,
      susCv: 0,
      relCv: 0,
      widthCv: 0,
      levelCv: 0,
    };
  }

  static get parameterDescriptors() {
    return PARAM_TABLE.map(([name, def, min, max]) => ({
      name,
      defaultValue: def,
      minValue: min,
      maxValue: max,
      // Discrete switch/pad → k-rate; everything else a-rate so future
      // per-sample automation reaches the DSP.
      automationRate: (UNSMOOTHED.has(name) ? 'k-rate' : 'a-rate') as 'a-rate' | 'k-rate',
    }));
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return arr[0] as number;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;
    const n = outL.length;

    // Lazily build the block smoothers on the first block (needs n).
    if (!this.smReady) {
      for (const [name, def] of PARAM_TABLE) {
        if (UNSMOOTHED.has(name)) continue;
        this.sm[name] = new BlockSmoother(this.sr, n, 80, def);
      }
      this.smReady = true;
    }

    // ── Poly bus: input 0 carries up to 10 channels (5 pitch/gate pairs);
    // block-rate lane snapshot (first sample of each channel). ──
    const poly = inputs[0];
    for (let v = 0; v < TIDY_VOICES; v++) {
      this.bus.poly[v * 2] = poly?.[v * 2]?.[0] ?? 0;
      this.bus.poly[v * 2 + 1] = poly?.[v * 2 + 1]?.[0] ?? 0;
    }

    // Mono pitch/gate (block-rate; HOLD pad OR-ed into the gate).
    const hold = this.kval(parameters, 'hold', 0) >= 0.5 ? 1 : 0;
    this.bus.monoPitch = inputs[1]?.[0]?.[0] ?? 0;
    this.bus.monoGate = Math.max(inputs[2]?.[0]?.[0] ?? 0, hold);

    // CV inputs: cutoff/pwm/fold/sym per sample (audio-rate), res/drive
    // block-rate (they re-derive solver coefficients).
    this.bus.cutoffCv = inputs[3]?.[0] ?? 0;
    this.bus.pwmCv = inputs[5]?.[0] ?? 0;
    this.bus.resCv = inputs[4]?.[0]?.[0] ?? 0;
    this.bus.driveCv = inputs[6]?.[0]?.[0] ?? 0;
    this.bus.foldCv = inputs[7]?.[0] ?? 0;
    this.bus.symCv = inputs[8]?.[0] ?? 0;
    // Per-knob CV for EVERY remaining control — GLOBAL block-rate scalars
    // (first sample of each input block; cv = 0 is a byte-exact no-op).
    this.bus.shape1Cv = inputs[9]?.[0]?.[0] ?? 0;
    this.bus.shape2Cv = inputs[10]?.[0]?.[0] ?? 0;
    this.bus.detuneCv = inputs[11]?.[0]?.[0] ?? 0;
    this.bus.oct2Cv = inputs[12]?.[0]?.[0] ?? 0;
    this.bus.mixCv = inputs[13]?.[0]?.[0] ?? 0;
    this.bus.subCv = inputs[14]?.[0]?.[0] ?? 0;
    this.bus.envCv = inputs[15]?.[0]?.[0] ?? 0;
    this.bus.trackCv = inputs[16]?.[0]?.[0] ?? 0;
    this.bus.fatkCv = inputs[17]?.[0]?.[0] ?? 0;
    this.bus.fdecCv = inputs[18]?.[0]?.[0] ?? 0;
    this.bus.fsusCv = inputs[19]?.[0]?.[0] ?? 0;
    this.bus.frelCv = inputs[20]?.[0]?.[0] ?? 0;
    this.bus.atkCv = inputs[21]?.[0]?.[0] ?? 0;
    this.bus.decCv = inputs[22]?.[0]?.[0] ?? 0;
    this.bus.susCv = inputs[23]?.[0]?.[0] ?? 0;
    this.bus.relCv = inputs[24]?.[0]?.[0] ?? 0;
    this.bus.widthCv = inputs[25]?.[0]?.[0] ?? 0;
    this.bus.levelCv = inputs[26]?.[0]?.[0] ?? 0;

    // Knobs: block-rate smoothed reads off the frozen param table.
    const p = this.p;
    const rd = (name: string, fb: number) =>
      this.sm[name]!.step(this.kval(parameters, name, fb));
    p.shape1 = rd('shape1', TIDY_VCO_DEFAULTS.shape1);
    p.shape2 = rd('shape2', TIDY_VCO_DEFAULTS.shape2);
    p.pw = rd('pw', TIDY_VCO_DEFAULTS.pw);
    p.detune = rd('detune', TIDY_VCO_DEFAULTS.detune);
    p.oct2 = this.kval(parameters, 'oct2', 0);
    p.mix = rd('mix', TIDY_VCO_DEFAULTS.mix);
    p.sub = rd('sub', TIDY_VCO_DEFAULTS.sub);
    p.fold = rd('fold', TIDY_VCO_DEFAULTS.fold);
    p.sym = rd('sym', TIDY_VCO_DEFAULTS.sym);
    p.cutoff = rd('cutoff', TIDY_VCO_DEFAULTS.cutoff);
    p.res = rd('res', TIDY_VCO_DEFAULTS.res);
    p.drive = rd('drive', TIDY_VCO_DEFAULTS.drive);
    p.env = rd('env', TIDY_VCO_DEFAULTS.env);
    p.track = rd('track', TIDY_VCO_DEFAULTS.track);
    p.fatk = rd('fatk', TIDY_VCO_DEFAULTS.fatk);
    p.fdec = rd('fdec', TIDY_VCO_DEFAULTS.fdec);
    p.fsus = rd('fsus', TIDY_VCO_DEFAULTS.fsus);
    p.frel = rd('frel', TIDY_VCO_DEFAULTS.frel);
    p.atk = rd('atk', TIDY_VCO_DEFAULTS.atk);
    p.dec = rd('dec', TIDY_VCO_DEFAULTS.dec);
    p.sus = rd('sus', TIDY_VCO_DEFAULTS.sus);
    p.rel = rd('rel', TIDY_VCO_DEFAULTS.rel);
    p.width = rd('width', TIDY_VCO_DEFAULTS.width);
    p.level = rd('level', TIDY_VCO_DEFAULTS.level);

    renderTidyVco(p, this.bus, outL, outR, 0, n, this.sr, this.st);
    return true;
  }
}

registerProcessor('tidy-vco', TidyVcoProcessor);
