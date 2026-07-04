// packages/dsp/src/charlottes-echos.ts
//
// CHARLOTTE'S ECHOS — FOUR clean-room ANALOG DELAY engines chained in series
// (out of stage N → in of stage N+1). Each stage IS an AnalogDelayCore (the
// GPL-free own-code core from ./lib/analog-delay-core.ts that also powers
// COFEFVE DELAY), so CHARLOTTE inherits the analog tape read (fractional
// Catmull-Rom line + eased read pointer), the in-loop multi-mode tone filter
// and the stateful tanh drive; the four-stage cascade is what gives it the
// dense, compounding "destructive multi-head" sound.
//
// This replaces the previous build on the GPL-lineage cocoadelay-core (Tilde
// Murray's Cocoa Delay translation), which is now DELETED. The DSP is entirely
// own code: the four AnalogDelayCore stages + a from-scratch VarispeedShifter
// (./lib/varispeed-shifter.ts) that supplies the per-stage ascending pitch —
// AnalogDelayCore has no varispeed read, so the shimmer is a separate own-code
// grain shifter on the forward cascade path. NONE of the deleted cocoa math is
// reused. Sound DIFFERS from the old GPL-core build (different core, not
// bit-exact) — that change is intentional and owner-reviewed.
//
// Backward compatibility: the module id (`charlottesEchos`), the L/R audio
// ports + `delay` CV input, and the FIVE params (delay / feedback / decay /
// pitchUp / mix) are all UNCHANGED, so existing patches load with no
// migration. The params drive the 4-stage engine:
//
//   delay    — base per-stage delay time. Every stage delays by `delay`, so the
//              cascade's first full-wet echo lands at ≈ 4 × delay (the SUM of
//              the four stage delays), with intermediate taps at 1–3 × delay.
//   feedback — feedback amount fed to EVERY stage (compounds across the chain).
//   decay    — progressively tapers each stage's wet level + adds in-loop tanh
//              drive + darkens the in-loop low-pass, so later stages are
//              darker/quieter (tape-tail feel).
//   pitchUp  — REAL per-stage upward pitch shift (the classic ascending
//              shimmer echo). Stage k's wet output is transposed up by
//              (1 + pitchUp)^k via the VarispeedShifter before it feeds stage
//              k+1, so content that traverses stages 1–3 climbs by
//              (1+pitchUp)^(1+2+3) and later repeats stay pitched up. pitchUp
//              = 0 ⇒ every stage's shifter is an EXACT bypass ⇒ no pitch change.
//   mix      — final global dry/wet.

import { AnalogDelayCore, type AnalogDelaySettings } from './lib/analog-delay-core';
import { VarispeedShifter } from './lib/varispeed-shifter';

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

const NUM_STAGES = 4;
const MIN_DELAY_S = 0.001;

// NOTE: not `export`ed — worklet entry files are bundled (esbuild format:esm)
// and a top-level export survives into dist/<name>.js, which the ART harness
// evals as a CLASSIC script (`new Function(src)`) → "Unexpected token 'export'".
// The processor is reached via its registerProcessor side-effect (see the
// test loaders), exactly like every other worklet (e.g. cofefve).
class CharlottesEchosProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'delay', defaultValue: 0.4, minValue: 0.001, maxValue: 1.5, automationRate: 'a-rate' as const },
      { name: 'feedback', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'decay', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'pitchUp', defaultValue: 0, minValue: 0, maxValue: 0.2, automationRate: 'k-rate' as const },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  // Four analog-delay engines in series. Each tape is sized for the max delay
  // (1.5 s) plus headroom — 2 s is plenty.
  private stages: AnalogDelayCore[] = [];
  // Per-stage, per-channel varispeed shifters supplying the ascending pitch on
  // the forward cascade path (stage 0's are never engaged: rate = 1).
  private shiftL: VarispeedShifter[] = [];
  private shiftR: VarispeedShifter[] = [];

  // One reused settings object mutated per stage per sample (no per-sample
  // allocation). Fields not exercised by CHARLOTTE stay at neutral defaults.
  private s: AnalogDelaySettings = {
    delayTime: 0.4, tempoSync: 0, beatPeriodS: 0,
    lfoAmount: 0, lfoFrequency: 1, driftAmount: 0, driftSpeed: 1,
    feedback: 0.5, stereoOffset: 0, pan: 0, panMode: 0,
    duckAmount: 0, duckAttack: 10, duckRelease: 10,
    filterMode: 0, lowCut: 0.9, highCut: 0.001,
    driveGain: 0, driveMix: 1, driveCutoff: 1, driveIterations: 1,
    dryVolume: 0, wetVolume: 1,
  };

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    for (let i = 0; i < NUM_STAGES; i++) {
      // Per-stage seed diverges each core's (unused-here) drift PRNG so the
      // tapes never share state; 2 s tape covers the 1.5 s max delay.
      this.stages.push(new AnalogDelayCore(sampleRate, 2.0, 0x1a2b3c4d + (i + 1) * 0x9e3779b1));
      this.shiftL.push(new VarispeedShifter(sampleRate));
      this.shiftR.push(new VarispeedShifter(sampleRate));
    }
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
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
    const inL = inputs[0]?.[0] ?? null;
    const inR = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null;
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;
    const n = outL.length;

    const feedback = Math.max(0, Math.min(1, this.kval(parameters, 'feedback', 0.5)));
    const decay = Math.max(0, Math.min(1, this.kval(parameters, 'decay', 0.2)));
    const pitchUp = Math.max(0, Math.min(0.2, this.kval(parameters, 'pitchUp', 0)));
    const mix = Math.max(0, Math.min(1, this.kval(parameters, 'mix', 0.5)));

    const s = this.s;
    // Constant across stages/samples this block.
    s.tempoSync = 0;
    s.beatPeriodS = 0;
    s.lfoAmount = 0;
    s.driftAmount = 0;
    s.feedback = feedback;
    s.stereoOffset = 0;
    s.pan = 0;
    s.panMode = 0;
    s.duckAmount = 0;
    s.filterMode = 0;
    s.highCut = 0.001;
    s.driveMix = 1;
    s.driveCutoff = 1;
    s.driveIterations = 1;
    s.dryVolume = 0; // each stage is WET-ONLY; the global dry is added at the end.

    for (let i = 0; i < n; i++) {
      const delay = Math.max(MIN_DELAY_S, this.aval(parameters, 'delay', i, 0.4));
      s.delayTime = delay;

      // Cascade: stage 0 takes the dry input; each subsequent stage takes the
      // previous stage's pitch-shifted WET output. Final stage output is the
      // chain's wet; mixed against the original dry at the end.
      let sigL = inL?.[i] ?? 0;
      let sigR = inR?.[i] ?? 0;

      for (let k = 0; k < NUM_STAGES; k++) {
        // Per-stage wet taper from decay: stage 0 = 1.0, later stages quieter.
        s.wetVolume = Math.pow(1 - decay * 0.6, k);
        // In-loop tanh drive ramps up with decay + stage index (destructive tail).
        s.driveGain = decay * (1 + k) * 0.8;
        // Progressive darkening of the tail (lower low-pass cutoff later).
        s.lowCut = Math.max(0.05, 0.9 - decay * 0.18 * k);

        const stage = this.stages[k]!;
        stage.processSample(s, sigL, sigR);
        let wl = stage.outL;
        let wr = stage.outR;

        // Per-stage upward transpose: (1 + pitchUp)^k. Stage 0 is unity ⇒ the
        // shifter is an exact bypass; each later stage climbs further, so the
        // cascade's echoes ascend in pitch (pitchUp = 0 ⇒ all bypass).
        if (pitchUp > 0 && k > 0) {
          const rate = Math.pow(1 + pitchUp, k);
          wl = this.shiftL[k]!.step(wl, rate);
          wr = this.shiftR[k]!.step(wr, rate);
        }

        sigL = wl;
        sigR = wr;
      }

      const dryL = inL?.[i] ?? 0;
      const dryR = inR?.[i] ?? 0;
      // Hard clamp guards against runaway with feedback=1 + heavy drive.
      const wetL = Math.max(-2, Math.min(2, sigL));
      const wetR = Math.max(-2, Math.min(2, sigR));
      outL[i] = dryL * (1 - mix) + wetL * mix;
      outR[i] = dryR * (1 - mix) + wetR * mix;
    }

    return true;
  }
}

registerProcessor('charlottes-echos', CharlottesEchosProcessor);
