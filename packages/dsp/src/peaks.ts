// packages/dsp/src/peaks.ts
//
// PEAKS — dual-channel multi-mode utility (Mutable Instruments Peaks
// archetype, Émilie Gillet, 2013, MIT-licensed). Each channel selects
// one mode from {kick, snare, hihat, env, lfo}; gate input retriggers
// the channel's engine on rising edges.
//
// v1 modes (subset of hardware Peaks' 8):
//   0  KICK    — sine carrier + exponential pitch envelope + amp envelope.
//                knob1 = base pitch (Hz mapping below), knob2 = decay (s).
//   1  SNARE   — body sine + filtered noise + envelope mix.
//                knob1 = noise/tone balance (0=body, 1=noise), knob2 = decay.
//   2  HIHAT   — 6-square metallic cluster + bandpass + decay.
//                knob1 = brightness (BPF cutoff up), knob2 = decay.
//   3  ENV     — attack-decay envelope (CV output 0..1).
//                knob1 = attack (s, log-mapped at host), knob2 = decay (s).
//   4  LFO     — free-running LFO (CV output -1..+1).
//                knob1 = rate (Hz, log at host), knob2 = wave (0=sine, 0.5=tri, 1=square).
//                Gate rising edge resets phase to 0.
//
// I/O surface (per channel — duplicated for ch0/ch1):
//   inputs:
//     gate[ch]       audio-rate trigger (rising edge ≥ 0.5 → retrigger)
//     k1_cv[ch]      CV → knob1 AudioParam (engine-side cvScale: linear)
//     k2_cv[ch]      CV → knob2 AudioParam (engine-side cvScale: linear)
//   outputs:
//     out[ch]        mono — audio for drum modes, CV for env/lfo
//
// Stretch (deferred): multistage envelope, tap-LFO, BPF mode. PR body
// flags this; the worklet leaves headroom for a `mode` value of ≥5 to be
// mapped to those in a follow-up.
//
// Algorithm references — replicated rather than imported because the
// shared-DSP factor with macrooscillator's KICK/SNARE/HIHAT would force a
// build-time refactor of macroscillator's worklet bundle (currently
// self-contained). The math here is a simplified standalone version of
// the same archetype; tracks the original Peaks hardware's less-complex
// drum DSP rather than Plaits' more elaborate models.

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

const TRIG_THRESHOLD = 0.5;

// Number of modes implemented. Keep in sync with the module def + card.
const PEAKS_NUM_MODES = 5;

// ---------------- Per-mode engines ----------------

class KickEngine {
  phase = 0;
  pitchEnv = 0;
  ampEnv = 0;

  trigger(): void {
    this.phase = 0;
    this.pitchEnv = 1;
    this.ampEnv = 1;
  }

  /** knob1 = base pitch Hz (already in Hz at the worklet boundary;
   *  the host maps the slider 30..200 Hz). knob2 = decay seconds. */
  tick(baseHz: number, decaySec: number, sr: number): number {
    const pitchDecaySec = 0.03;
    const pitchDecayCoef = Math.exp(-1 / (pitchDecaySec * sr));
    this.pitchEnv *= pitchDecayCoef;
    // Sweep up to 3 octaves above base.
    const sweepMul = Math.pow(2, 3 * this.pitchEnv);
    const f = Math.min(20000, baseHz * sweepMul);

    const ampDecayCoef = Math.exp(-1 / (Math.max(0.01, decaySec) * sr));
    this.ampEnv *= ampDecayCoef;

    this.phase += f / sr;
    if (this.phase >= 1) this.phase -= 1;
    return Math.sin(2 * Math.PI * this.phase) * this.ampEnv;
  }
}

class SnareEngine {
  phase = 0;
  env = 0;
  rngState = 0xfacefeed | 0;

  trigger(): void {
    this.phase = 0;
    this.env = 1;
  }

  noise(): number {
    this.rngState = Math.imul(this.rngState, 16807) | 0;
    return ((this.rngState & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  }

  /** knob1 = noise/body mix (0=body, 1=noise). knob2 = decay. */
  tick(mix: number, decaySec: number, sr: number): number {
    const decayCoef = Math.exp(-1 / (Math.max(0.01, decaySec) * sr));
    this.env *= decayCoef;
    const bodyHz = 180;
    this.phase += bodyHz / sr;
    if (this.phase >= 1) this.phase -= 1;
    const body = Math.sin(2 * Math.PI * this.phase);
    const n = this.noise();
    const m = Math.max(0, Math.min(1, mix));
    return (body * (1 - m) + n * m) * this.env;
  }
}

const HIHAT_RATIOS = [2.0, 3.0, 4.16, 5.43, 6.79, 8.21];
class HihatEngine {
  phases = new Float32Array(HIHAT_RATIOS.length);
  env = 0;
  bpX1 = 0; bpX2 = 0; bpY1 = 0; bpY2 = 0;

  trigger(): void {
    for (let i = 0; i < HIHAT_RATIOS.length; i++) {
      // pseudorandom but deterministic-per-trigger to avoid xrun pops:
      this.phases[i] = ((i * 0.27 + 0.13) % 1);
    }
    this.env = 1;
    this.bpX1 = 0; this.bpX2 = 0; this.bpY1 = 0; this.bpY2 = 0;
  }

  /** knob1 = brightness (BPF center 2 kHz → 10 kHz). knob2 = decay. */
  tick(brightness: number, decaySec: number, sr: number): number {
    const decayCoef = Math.exp(-1 / (Math.max(0.01, decaySec) * sr));
    this.env *= decayCoef;

    const baseHz = 320;
    let cluster = 0;
    for (let i = 0; i < HIHAT_RATIOS.length; i++) {
      const ratio = HIHAT_RATIOS[i]!;
      this.phases[i]! += (baseHz * ratio) / sr;
      if (this.phases[i]! >= 1) this.phases[i]! -= 1;
      cluster += this.phases[i]! < 0.5 ? 1 : -1;
    }
    cluster /= HIHAT_RATIOS.length;

    const bpFreq = 2000 + Math.max(0, Math.min(1, brightness)) * 8000;
    const Q = 0.7;
    const w0 = 2 * Math.PI * bpFreq / sr;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2 * Q);
    const b0 = alpha;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * cosW0;
    const a2 = 1 - alpha;
    const y = (b0 * cluster + 0 * this.bpX1 + b2 * this.bpX2 - a1 * this.bpY1 - a2 * this.bpY2) / a0;
    this.bpX2 = this.bpX1; this.bpX1 = cluster;
    this.bpY2 = this.bpY1; this.bpY1 = y;

    return y * this.env;
  }
}

/** Attack-decay envelope. CV-style output 0..1. Linear ramps. */
class EnvEngine {
  // 0 = idle, 1 = attack, 2 = decay
  stage = 0;
  value = 0;

  trigger(): void {
    this.stage = 1;
    // Don't reset value — re-triggering during decay re-attacks from
    // current value, matching most analog AD envelopes.
  }

  /** knob1 = attack seconds, knob2 = decay seconds. */
  tick(attackSec: number, decaySec: number, sr: number): number {
    const aRate = 1 / Math.max(0.001, attackSec * sr);
    const dRate = 1 / Math.max(0.001, decaySec * sr);
    if (this.stage === 1) {
      this.value += aRate;
      if (this.value >= 1) { this.value = 1; this.stage = 2; }
    } else if (this.stage === 2) {
      this.value -= dRate;
      if (this.value <= 0) { this.value = 0; this.stage = 0; }
    }
    return this.value;
  }
}

/** Simple LFO — sine, triangle, or square. Output -1..+1.
 *  Gate rising edge resets the phase to 0. */
class LfoEngine {
  phase = 0;

  trigger(): void {
    this.phase = 0;
  }

  /** knob1 = rateHz, knob2 = wave (0=sine, 0.5=triangle, 1=square). */
  tick(rateHz: number, wave: number, sr: number): number {
    const rate = Math.max(0.001, rateHz);
    this.phase += rate / sr;
    if (this.phase >= 1) this.phase -= 1;
    const w = Math.max(0, Math.min(1, wave));
    if (w < 0.25) {
      return Math.sin(2 * Math.PI * this.phase);
    } else if (w < 0.75) {
      // Triangle: 0→1→0→-1→0 across [0,1]
      const p = this.phase;
      if (p < 0.25) return 4 * p;
      if (p < 0.75) return 2 - 4 * p;
      return -4 + 4 * p;
    } else {
      return this.phase < 0.5 ? 1 : -1;
    }
  }
}

class PeaksChannel {
  kick = new KickEngine();
  snare = new SnareEngine();
  hihat = new HihatEngine();
  env = new EnvEngine();
  lfo = new LfoEngine();
  lastTrig = 0;

  trigger(mode: number): void {
    if (mode === 0) this.kick.trigger();
    else if (mode === 1) this.snare.trigger();
    else if (mode === 2) this.hihat.trigger();
    else if (mode === 3) this.env.trigger();
    else if (mode === 4) this.lfo.trigger();
  }

  tick(mode: number, k1: number, k2: number, sr: number): number {
    if (mode === 0) return this.kick.tick(k1, k2, sr);
    if (mode === 1) return this.snare.tick(k1, k2, sr);
    if (mode === 2) return this.hihat.tick(k1, k2, sr);
    if (mode === 3) return this.env.tick(k1, k2, sr);
    if (mode === 4) return this.lfo.tick(k1, k2, sr);
    return 0;
  }
}

class PeaksProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Mode is k-rate; round to int inside.
      { name: 'mode0', defaultValue: 4, minValue: 0, maxValue: PEAKS_NUM_MODES - 1, automationRate: 'k-rate' as const },
      { name: 'mode1', defaultValue: 4, minValue: 0, maxValue: PEAKS_NUM_MODES - 1, automationRate: 'k-rate' as const },
      // Knob1/2 are a-rate so CV reads sample-accurate.
      // Wide bounds — the host clamps to a sensible per-mode range via the
      // card's labels; the worklet just runs the math.
      { name: 'k1_0', defaultValue: 1, minValue: 0.001, maxValue: 20000, automationRate: 'a-rate' as const },
      { name: 'k2_0', defaultValue: 0.3, minValue: 0.001, maxValue: 20000, automationRate: 'a-rate' as const },
      { name: 'k1_1', defaultValue: 1, minValue: 0.001, maxValue: 20000, automationRate: 'a-rate' as const },
      { name: 'k2_1', defaultValue: 0.3, minValue: 0.001, maxValue: 20000, automationRate: 'a-rate' as const },
    ];
  }

  private ch = [new PeaksChannel(), new PeaksChannel()];

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out0 = outputs[0]?.[0];
    const out1 = outputs[1]?.[0];
    if (!out0 || !out1) return true;

    const mode0Raw = parameters.mode0?.[0] ?? 4;
    const mode1Raw = parameters.mode1?.[0] ?? 4;
    const mode0 = Math.max(0, Math.min(PEAKS_NUM_MODES - 1, Math.round(mode0Raw)));
    const mode1 = Math.max(0, Math.min(PEAKS_NUM_MODES - 1, Math.round(mode1Raw)));

    const k1_0Arr = parameters.k1_0!;
    const k2_0Arr = parameters.k2_0!;
    const k1_1Arr = parameters.k1_1!;
    const k2_1Arr = parameters.k2_1!;

    const trig0 = inputs[0]?.[0];
    const trig1 = inputs[1]?.[0];

    const sr = sampleRate;
    const n = out0.length;

    for (let i = 0; i < n; i++) {
      // Channel 0 gate edge.
      if (trig0) {
        const t = trig0[i] ?? 0;
        if (this.ch[0]!.lastTrig < TRIG_THRESHOLD && t >= TRIG_THRESHOLD) {
          this.ch[0]!.trigger(mode0);
        }
        this.ch[0]!.lastTrig = t;
      }
      // Channel 1 gate edge.
      if (trig1) {
        const t = trig1[i] ?? 0;
        if (this.ch[1]!.lastTrig < TRIG_THRESHOLD && t >= TRIG_THRESHOLD) {
          this.ch[1]!.trigger(mode1);
        }
        this.ch[1]!.lastTrig = t;
      }
      const k1_0 = k1_0Arr.length > 1 ? (k1_0Arr[i] ?? 1) : (k1_0Arr[0] ?? 1);
      const k2_0 = k2_0Arr.length > 1 ? (k2_0Arr[i] ?? 0.3) : (k2_0Arr[0] ?? 0.3);
      const k1_1 = k1_1Arr.length > 1 ? (k1_1Arr[i] ?? 1) : (k1_1Arr[0] ?? 1);
      const k2_1 = k2_1Arr.length > 1 ? (k2_1Arr[i] ?? 0.3) : (k2_1Arr[0] ?? 0.3);
      out0[i] = this.ch[0]!.tick(mode0, k1_0, k2_0, sr);
      out1[i] = this.ch[1]!.tick(mode1, k1_1, k2_1, sr);
    }
    return true;
  }
}

registerProcessor('peaks', PeaksProcessor);
