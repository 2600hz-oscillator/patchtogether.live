// packages/dsp/src/slewswitch.ts
//
// SLEWSWITCH — quad slew limiter + 4→1 sequential CV switch worklet.
//
// Per-channel one-pole lowpass smooths each cv input; outputs are the
// four slewed signals (always live) plus a `switched` channel that
// crossfades through the four slewed lines on each `step_clock` rising
// edge. step_clock is read from input channel 0 of input 0 (gates use the
// same audio-rate convention as the rest of the codebase).
//
// Inputs (0..5):
//   0  cv1  (1 channel)
//   1  cv2  (1 channel)
//   2  cv3  (1 channel)
//   3  cv4  (1 channel)
//   4  step_clock (1 channel, gate)
//   5  reset (1 channel, gate)
//
// Outputs (0..6):
//   0  out1       (slewed cv1)
//   1  out2       (slewed cv2)
//   2  out3       (slewed cv3)
//   3  out4       (slewed cv4)
//   4  switched   (currently-selected slewed channel, equal-power xfade)
//   5  step_idx   (-1..+1 quantized to 4 levels — for downstream display)
//   6  eoc        (gate pulse on wrap step3 → step0)
//
// Mode: 0=forward (0→1→2→3→0…), 1=pendulum (0→1→2→3→2→1→0…), 2=random
// (uniform pick over 0..length-1, excluding the current index).

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

const EOC_PULSE_S = 0.005; // 5 ms gate pulse on wrap

class SlewSwitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Per-channel slew time constants (seconds — tau of the one-pole).
      { name: 'slew1',     defaultValue: 0.5,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'slew2',     defaultValue: 0.5,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'slew3',     defaultValue: 0.5,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'slew4',     defaultValue: 0.5,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      // 0 forward, 1 pendulum, 2 random
      { name: 'mode',      defaultValue: 0,     minValue: 0,     maxValue: 2, automationRate: 'k-rate' as const },
      { name: 'length',    defaultValue: 4,     minValue: 1,     maxValue: 4, automationRate: 'k-rate' as const },
      { name: 'xfadeTime', defaultValue: 0.05,  minValue: 0.001, maxValue: 2, automationRate: 'k-rate' as const },
    ];
  }

  // Per-channel smoothed state.
  private y = [0, 0, 0, 0];
  // Current + previous selection (drives the equal-power crossfade).
  private curIdx = 0;
  private prevIdx = 0;
  // 0..1 fade progress from prevIdx → curIdx (1 = settled on curIdx).
  private xfade = 1;
  // Pendulum direction.
  private dir: 1 | -1 = 1;
  // Rising-edge detectors.
  private prevClock = 0;
  private prevReset = 0;
  // EOC pulse countdown (in samples).
  private eocRemaining = 0;
  // PRNG state for random mode — splitmix32 seeded from construction.
  private prng: number;

  constructor(options?: { processorOptions?: { seed?: number } }) {
    super(options);
    this.prng = Math.floor((options?.processorOptions?.seed ?? Math.random() * 0xffffffff) >>> 0) || 1;
  }

  private rand(): number {
    // Mulberry32 — fine enough for a step-selection PRNG.
    this.prng = (this.prng + 0x6d2b79f5) >>> 0;
    let t = this.prng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private advance(length: number, mode: number): void {
    if (length <= 1) { this.curIdx = 0; return; }
    const prev = this.curIdx;
    if (mode < 0.5) {
      // forward
      this.curIdx = (prev + 1) % length;
      if (this.curIdx === 0) this.eocRemaining = Math.round(EOC_PULSE_S * sampleRate);
    } else if (mode < 1.5) {
      // pendulum
      let next = prev + this.dir;
      if (next >= length) { this.dir = -1; next = prev - 1; }
      else if (next < 0)  { this.dir =  1; next = prev + 1; }
      this.curIdx = next;
      if (next === 0) this.eocRemaining = Math.round(EOC_PULSE_S * sampleRate);
    } else {
      // random — pick any of 0..length-1 except prev (so the switch
      // audibly does something each tick).
      let pick = Math.floor(this.rand() * length);
      if (pick === prev) pick = (pick + 1) % length;
      this.curIdx = pick;
      // No structural EOC in random mode; pulse on every step instead.
      this.eocRemaining = Math.round(EOC_PULSE_S * sampleRate);
    }
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
    const clk = inputs[4]?.[0];
    const rst = inputs[5]?.[0];

    const out1     = outputs[0]?.[0];
    const out2     = outputs[1]?.[0];
    const out3     = outputs[2]?.[0];
    const out4     = outputs[3]?.[0];
    const swOut    = outputs[4]?.[0];
    const idxOut   = outputs[5]?.[0];
    const eocOut   = outputs[6]?.[0];
    if (!out1 || !out2 || !out3 || !out4 || !swOut || !idxOut || !eocOut) return true;

    const N = out1.length;
    const sr = sampleRate;
    const tau = [
      parameters.slew1[0]!,
      parameters.slew2[0]!,
      parameters.slew3[0]!,
      parameters.slew4[0]!,
    ];
    // alpha = 1 - exp(-dt/τ), per-sample.
    const alpha = tau.map((t) => 1 - Math.exp(-(1 / sr) / t));
    const mode = parameters.mode[0]!;
    const len = Math.max(1, Math.min(4, Math.round(parameters.length[0]!)));
    const xfadeT = Math.max(0.001, parameters.xfadeTime[0]!);
    const xfadeStep = (1 / sr) / xfadeT;

    for (let i = 0; i < N; i++) {
      const x1 = in1 ? in1[i]! : 0;
      const x2 = in2 ? in2[i]! : 0;
      const x3 = in3 ? in3[i]! : 0;
      const x4 = in4 ? in4[i]! : 0;
      const ck = clk ? clk[i]! : 0;
      const rs = rst ? rst[i]! : 0;

      this.y[0]! += alpha[0]! * (x1 - this.y[0]!);
      this.y[1]! += alpha[1]! * (x2 - this.y[1]!);
      this.y[2]! += alpha[2]! * (x3 - this.y[2]!);
      this.y[3]! += alpha[3]! * (x4 - this.y[3]!);

      out1[i] = this.y[0]!;
      out2[i] = this.y[1]!;
      out3[i] = this.y[2]!;
      out4[i] = this.y[3]!;

      // Reset edge — back to step 0 + cancel any pending crossfade.
      if (rs > 0.5 && this.prevReset <= 0.5) {
        this.prevIdx = this.curIdx;
        this.curIdx = 0;
        this.xfade = 1;
        this.dir = 1;
      }
      this.prevReset = rs;

      // Clock edge — advance + start a new crossfade.
      if (ck > 0.5 && this.prevClock <= 0.5) {
        this.prevIdx = this.curIdx;
        this.advance(len, mode);
        this.xfade = 0;
      }
      this.prevClock = ck;

      // Progress the crossfade.
      if (this.xfade < 1) {
        this.xfade = Math.min(1, this.xfade + xfadeStep);
      }

      // Equal-power crossfade (cos/sin pair, sums to 1.0 power-wise).
      const a = Math.cos(this.xfade * 0.5 * Math.PI);
      const b = Math.sin(this.xfade * 0.5 * Math.PI);
      swOut[i] = a * this.y[this.prevIdx]! + b * this.y[this.curIdx]!;

      // Step index as -1..+1 (4 quantized levels at 0/-0.333/+0.333/+1
      // ... using a simple `(idx / (len-1)) * 2 - 1` mapping).
      idxOut[i] = len > 1 ? (this.curIdx / (len - 1)) * 2 - 1 : 0;

      // EOC pulse output (5 ms).
      if (this.eocRemaining > 0) {
        eocOut[i] = 1;
        this.eocRemaining--;
      } else {
        eocOut[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('slewswitch', SlewSwitchProcessor);
