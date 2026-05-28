// packages/dsp/src/charlottes-echos.ts
//
// CHARLOTTE'S ECHOS — now built from FOUR Cocoa Delay engines chained in
// series (out of stage N → in of stage N+1). Each stage IS a COCOA DELAY
// core (see cocoadelay-core.ts), so CHARLOTTE inherits Cocoa's tape read,
// feedback, filter and stateful-drive character; the four-stage cascade is
// what gives it the dense, compounding "destructive multi-head" sound the
// original single-worklet version approximated with stacked read heads.
//
// Backward compatibility: the module id (`charlottesEchos`), the L/R audio
// ports + `delay` CV input, and the FIVE params (delay / feedback / decay /
// pitchUp / mix) are all UNCHANGED, so existing patches load with no
// migration. The params now drive the 4-stage engine:
//
//   delay    — base per-stage delay time. Stage k delays by `delay` so the
//              cascade's first full-wet echo lands at ≈ 4 × delay (the SUM of
//              the four stage delays), with intermediate taps at 1–3 × delay.
//   feedback — feedback amount fed to EVERY stage (compounds across the chain).
//   decay    — progressively tapers each stage's wet level + adds in-loop
//              drive, so later stages are darker/quieter (tape-tail feel).
//   pitchUp  — mapped to a subtle LFO time-wobble on each stage (the Cocoa
//              engine has no pitch shifter; this preserves a "moving tape"
//              character in the same knob range). NOTE: this is a CHARACTER
//              change vs the old pitch-rising heads — flagged in the PR.
//   mix      — final global dry/wet.

import { CocoaDelayCore, type CocoaSettings } from './cocoadelay-core';

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

export class CharlottesEchosProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'delay', defaultValue: 0.4, minValue: 0.001, maxValue: 1.5, automationRate: 'a-rate' as const },
      { name: 'feedback', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'decay', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'pitchUp', defaultValue: 0, minValue: 0, maxValue: 0.2, automationRate: 'k-rate' as const },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  // Four Cocoa Delay engines in series. Each tape is sized for the max delay
  // (1.5 s) plus headroom — 2 s is plenty.
  private stages: CocoaDelayCore[] = [];

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    for (let i = 0; i < NUM_STAGES; i++) {
      // Per-stage seed diverges the DRIFT noise so the four tapes don't move
      // in lockstep (decorrelated, denser wash).
      this.stages.push(new CocoaDelayCore(sampleRate, 2.0, i + 1));
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

    // pitchUp → LFO time-wobble amount. Scaled into the Cocoa LFO's 0..0.5
    // range (pitchUp maxes at 0.2, so ×1.5 ≈ 0.3 max — a gentle wobble).
    const lfoAmount = pitchUp * 1.5;

    for (let s = 0; s < n; s++) {
      const delay = Math.max(MIN_DELAY_S, this.aval(parameters, 'delay', s, 0.4));

      // Cascade: stage 0 takes the dry input; each subsequent stage takes the
      // previous stage's WET-only output. Final stage output is the chain's
      // wet; we mix it against the original dry at the end.
      let sigL = inL?.[s] ?? 0;
      let sigR = inR?.[s] ?? 0;

      for (let k = 0; k < NUM_STAGES; k++) {
        // Per-stage wet taper from decay: stage 0 = 1.0, later stages quieter.
        const stageWet = Math.pow(1 - decay * 0.6, k);
        // Drive ramps up with decay + stage index for the destructive tail.
        const stageDrive = decay * (1 + k) * 0.8;

        const settings: CocoaSettings = {
          delayTime: delay,
          tempoSync: 0,
          lfoAmount,
          // Spread LFO rates per stage so the four wobbles decorrelate.
          lfoFrequency: 0.7 + k * 0.37,
          driftAmount: 0,
          driftSpeed: 1,
          feedback,
          stereoOffset: 0,
          panMode: 0,
          pan: 0,
          duckAmount: 0,
          duckAttack: 10,
          duckRelease: 10,
          filterMode: 0,
          // Progressive darkening of the tail with decay (lower lowCut later).
          lowCut: Math.max(0.05, 0.9 - decay * 0.18 * k),
          highCut: 0.001,
          driveGain: stageDrive,
          driveMix: 1,
          driveCutoff: 1,
          driveIterations: 1,
          // Each stage is internally WET-ONLY so the cascade sums the taps:
          // dry passes straight through to the NEXT stage's input via sigL/R,
          // but the per-stage dry is suppressed so we don't quadruple the
          // unprocessed signal. We add the dry back globally at the end.
          dryVolume: 0,
          wetVolume: stageWet,
        };

        const stage = this.stages[k]!;
        stage.processSample(settings, sigL, sigR, sampleRate);
        sigL = stage.outL;
        sigR = stage.outR;
      }

      const dryL = inL?.[s] ?? 0;
      const dryR = inR?.[s] ?? 0;
      // Hard clamp guards against runaway with feedback=1 + heavy drive.
      const wetL = Math.max(-2, Math.min(2, sigL));
      const wetR = Math.max(-2, Math.min(2, sigR));
      outL[s] = dryL * (1 - mix) + wetL * mix;
      outR[s] = dryR * (1 - mix) + wetR * mix;
    }

    return true;
  }
}

registerProcessor('charlottes-echos', CharlottesEchosProcessor);
