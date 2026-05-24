// packages/dsp/src/aquatank.ts
//
// AQUATANK — 4-channel Hadamard feedback delay network (FDN).
//
// Architecture per the Atlantis-patch plan: 4 audio inputs each feed a
// short modulated delay line (8..80 ms range). The four delay-line tap
// outputs are mixed back into the inputs via a Hadamard matrix scaled by
// per-channel feedback knobs, low-passed (`damp`) to prevent runaway
// resonance, and tanh-soft-limited so peak excursions stay bounded even
// at fb=0.95 and tilt=1.
//
// `tilt` perturbs the Hadamard matrix toward sign-flips (introduces small
// off-diagonal asymmetries). At tilt=0 the FDN behaves as a clean
// energy-preserving reverberator; at tilt=1 it drifts toward chaotic
// modal density.
//
// Outputs:
//   0..3  out1..out4    — post-matrix per-channel taps
//   4     mix_l          — equal-power stereo left  (channels 1+3 hard L, 2+4 mid)
//   5     mix_r          — equal-power stereo right (channels 2+4 hard R, 1+3 mid)
//
// Inputs:
//   0..3  in1..in4       — audio
//   No gate inputs — the `freeze` UX is at the host-level (clearing
//   feedback updates) since the worklet has no port-message latch
//   beyond `freeze` AudioParam (k-rate, 0=normal, 1=hold matrix).

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

const N = 4;
const MAX_DELAY_S = 0.12; // 120 ms — overkill room for the modulated 8..80 ms range
const MIN_DELAY_S = 0.005;

// Base Hadamard 4x4 (orthogonal, sums-of-squares preserve energy). We
// scale rows by 0.5 (= 1/sqrt(N)) elsewhere when applying.
const HADAMARD: ReadonlyArray<ReadonlyArray<number>> = [
  [ 1,  1,  1,  1],
  [ 1, -1,  1, -1],
  [ 1,  1, -1, -1],
  [ 1, -1, -1,  1],
];

class AquaTankProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Per-channel feedback (0..0.95 — capped under unity for stability).
      { name: 'fb1', defaultValue: 0.4, minValue: 0, maxValue: 0.95, automationRate: 'a-rate' as const },
      { name: 'fb2', defaultValue: 0.4, minValue: 0, maxValue: 0.95, automationRate: 'a-rate' as const },
      { name: 'fb3', defaultValue: 0.4, minValue: 0, maxValue: 0.95, automationRate: 'a-rate' as const },
      { name: 'fb4', defaultValue: 0.4, minValue: 0, maxValue: 0.95, automationRate: 'a-rate' as const },
      // Global controls.
      { name: 'tilt',     defaultValue: 0,    minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'damp',     defaultValue: 0.4,  minValue: 0,  maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'crossMix', defaultValue: 0.5,  minValue: 0,  maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'spread',   defaultValue: 0.7,  minValue: 0,  maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'outLevel', defaultValue: 0.6,  minValue: 0,  maxValue: 1, automationRate: 'a-rate' as const },
    ];
  }

  // Four per-channel delay lines.
  private delayBuf: Float32Array[] = [];
  private writeIdx: number[] = [0, 0, 0, 0];
  private delaySamples: number[] = [];
  // Damping one-pole state per channel (between feedback and write-back).
  private dampY: number[] = [0, 0, 0, 0];
  // LFO state for delay-line modulation (small chorus offset per channel).
  private lfoPhase: number[] = [0, 0.25, 0.5, 0.75];

  constructor(options?: { processorOptions?: { seed?: number } }) {
    super(options);
    const maxLen = Math.ceil(MAX_DELAY_S * sampleRate);
    // Four different base delay lengths spanning ~12..80 ms; modulated
    // per-sample by a small LFO so the timbre isn't strictly periodic.
    const baseS = [0.012, 0.027, 0.051, 0.083];
    for (let i = 0; i < N; i++) {
      this.delayBuf.push(new Float32Array(maxLen));
      this.delaySamples.push(Math.round(baseS[i]! * sampleRate));
    }
    // Touch options so TS doesn't whine about unused destructured fields.
    void options?.processorOptions?.seed;
  }

  /** Read sample from delay line `i` `delaySamples` ago, with linear
   *  interpolation if needed. */
  private readDelay(i: number, dSamples: number): number {
    const buf = this.delayBuf[i]!;
    const w = this.writeIdx[i]!;
    const L = buf.length;
    const di = Math.floor(dSamples);
    const frac = dSamples - di;
    const r0 = (w - di + L) % L;
    const r1 = (w - di - 1 + L) % L;
    return buf[r0]! * (1 - frac) + buf[r1]! * frac;
  }

  private writeDelay(i: number, sample: number): void {
    const buf = this.delayBuf[i]!;
    const w = this.writeIdx[i]!;
    buf[w] = sample;
    this.writeIdx[i] = (w + 1) % buf.length;
  }

  /** Apply tilt to the Hadamard matrix in-place per sample. tilt ∈ [-1, +1]
   *  scales the off-diagonal terms; >0 amplifies cross-coupling, <0 attenuates. */
  private mixWithTilt(taps: number[], tilt: number): number[] {
    const out = [0, 0, 0, 0];
    const norm = 0.5; // 1/sqrt(N) for energy-preserving Hadamard mixing.
    for (let row = 0; row < N; row++) {
      let s = 0;
      for (let col = 0; col < N; col++) {
        const base = HADAMARD[row]![col]!;
        // Off-diagonal elements get a (1 + tilt) gain; diagonal stays.
        const coeff = row === col ? base : base * (1 + tilt * 0.5);
        s += coeff * taps[col]!;
      }
      out[row] = norm * s;
    }
    return out;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const in1 = inputs[0]?.[0];
    const in2 = inputs[1]?.[0];
    const in3 = inputs[2]?.[0];
    const in4 = inputs[3]?.[0];
    const o1  = outputs[0]?.[0];
    const o2  = outputs[1]?.[0];
    const o3  = outputs[2]?.[0];
    const o4  = outputs[3]?.[0];
    const ml  = outputs[4]?.[0];
    const mr  = outputs[5]?.[0];
    if (!o1 || !o2 || !o3 || !o4 || !ml || !mr) return true;

    const L = o1.length;
    const sr = sampleRate;
    const fb = [parameters.fb1, parameters.fb2, parameters.fb3, parameters.fb4];
    const tiltP = parameters.tilt;
    const dampP = parameters.damp;
    const crossP = parameters.crossMix;
    const spreadP = parameters.spread;
    const outLevelP = parameters.outLevel;

    for (let i = 0; i < L; i++) {
      const x1 = in1 ? in1[i]! : 0;
      const x2 = in2 ? in2[i]! : 0;
      const x3 = in3 ? in3[i]! : 0;
      const x4 = in4 ? in4[i]! : 0;
      const tilt = tiltP.length > 1 ? tiltP[i]! : tiltP[0]!;
      const damp = dampP.length > 1 ? dampP[i]! : dampP[0]!;
      const cross = crossP.length > 1 ? crossP[i]! : crossP[0]!;
      const spread = spreadP.length > 1 ? spreadP[i]! : spreadP[0]!;
      const olv = outLevelP.length > 1 ? outLevelP[i]! : outLevelP[0]!;

      // Read taps (current delay-line outputs) — slightly modulated per
      // channel for the FDN chorus shimmer.
      const taps = [0, 0, 0, 0];
      for (let c = 0; c < N; c++) {
        // LFO at ~0.3-0.7 Hz per channel; +/- 4ms swing of delay.
        const phaseInc = (0.3 + c * 0.15) / sr;
        this.lfoPhase[c] = (this.lfoPhase[c]! + phaseInc) % 1;
        const lfo = Math.sin(2 * Math.PI * this.lfoPhase[c]!);
        const ds = Math.max(
          MIN_DELAY_S * sr,
          this.delaySamples[c]! + lfo * 0.004 * sr,
        );
        taps[c] = this.readDelay(c, ds);
      }

      // Mix taps through Hadamard + tilt.
      const mixed = this.mixWithTilt(taps, tilt);

      // Per-channel: feedback into the delay line (input + scaled
      // mixed-tap), passed through a one-pole LP (damping) + tanh limiter.
      const fbVals = [fb[0]![i] ?? fb[0]![0]!, fb[1]![i] ?? fb[1]![0]!, fb[2]![i] ?? fb[2]![0]!, fb[3]![i] ?? fb[3]![0]!];
      const ins = [x1, x2, x3, x4];
      for (let c = 0; c < N; c++) {
        // Direct + cross-mix blend so the matrix routing is audible even
        // at low feedback.
        const direct = ins[c]!;
        const matrix = mixed[c]!;
        const blended = (1 - cross) * direct + cross * (direct + matrix);
        const fbAmount = Math.max(0, Math.min(0.95, fbVals[c]!));
        const raw = blended + fbAmount * matrix;
        // Soft saturate + damp.
        const sat = Math.tanh(raw);
        // alpha = 1 - exp(-dt/τ); τ scales with damp (damp=0 → tight LP, 1 → wide-open).
        const tau = 0.001 + (1 - damp) * 0.01;
        const alpha = 1 - Math.exp(-(1 / sr) / tau);
        this.dampY[c]! += alpha * (sat - this.dampY[c]!);
        this.writeDelay(c, this.dampY[c]!);
      }

      // Per-channel outs.
      o1[i] = mixed[0]! * olv;
      o2[i] = mixed[1]! * olv;
      o3[i] = mixed[2]! * olv;
      o4[i] = mixed[3]! * olv;

      // Stereo mix: channels 1+3 lean left, 2+4 lean right; `spread`
      // controls how hard-panned vs centered. spread=0 → all mono;
      // spread=1 → fully hard-panned per channel.
      const leftHard  = mixed[0]! + mixed[2]!;
      const rightHard = mixed[1]! + mixed[3]!;
      const mono = (leftHard + rightHard) * 0.5;
      ml[i] = ((1 - spread) * mono + spread * leftHard)  * olv * 0.5;
      mr[i] = ((1 - spread) * mono + spread * rightHard) * olv * 0.5;
    }
    return true;
  }
}

registerProcessor('aquatank', AquaTankProcessor);
