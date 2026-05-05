// packages/dsp/src/lfo.ts
//
// Clockable LFO. Outputs four phases (0°, 90°, 180°, 270°) of a single
// underlying oscillator. Shape morphs continuously sine → saw → square via
// the `shape` AudioParam (0=sine, 1=saw, 2=square). External clock pulses on
// input 0 reset the phase to zero on each rising edge — patch a Sequencer's
// clock_out into here for tempo-synced modulation.

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

const TWO_PI = Math.PI * 2;
const CLOCK_THRESHOLD = 0.5;

class LfoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // 0.01 Hz (one cycle per ~100s) up to 100 Hz (audio-rate-ish for FM uses).
      { name: 'rate',  defaultValue: 1, minValue: 0.01, maxValue: 100, automationRate: 'a-rate' as const },
      // 0=pure sine, 1=pure saw, 2=pure square. Linear interpolation between
      // the adjacent shapes for in-between values (e.g. 0.5 = sine ⇄ saw mix).
      { name: 'shape', defaultValue: 0, minValue: 0,    maxValue: 2,   automationRate: 'a-rate' as const },
    ];
  }

  private phase = 0;
  private lastClockSample = 0;

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out0 = outputs[0]?.[0];
    const out90 = outputs[1]?.[0];
    const out180 = outputs[2]?.[0];
    const out270 = outputs[3]?.[0];
    if (!out0 || !out90 || !out180 || !out270) return true;

    const clockIn = inputs[0]?.[0];
    const rateArr = parameters.rate;
    const shapeArr = parameters.shape;

    const blockLen = out0.length;
    const sr = sampleRate;

    for (let i = 0; i < blockLen; i++) {
      const rate = rateArr.length > 1 ? (rateArr[i] ?? 0) : (rateArr[0] ?? 0);
      const shape = shapeArr.length > 1 ? (shapeArr[i] ?? 0) : (shapeArr[0] ?? 0);

      // External clock: rising edge resets phase to 0 (sync).
      if (clockIn) {
        const c = clockIn[i] ?? 0;
        if (this.lastClockSample < CLOCK_THRESHOLD && c >= CLOCK_THRESHOLD) {
          this.phase = 0;
        }
        this.lastClockSample = c;
      }

      // Advance phase. Wrap to [0, 1).
      this.phase += Math.max(0, rate) / sr;
      while (this.phase >= 1) this.phase -= 1;
      if (this.phase < 0) this.phase = 0;

      // Compute the four phase-shifted outputs at this sample.
      const p0 = this.phase;
      const p90 = (this.phase + 0.25) % 1;
      const p180 = (this.phase + 0.5) % 1;
      const p270 = (this.phase + 0.75) % 1;

      out0[i] = morph(p0, shape);
      out90[i] = morph(p90, shape);
      out180[i] = morph(p180, shape);
      out270[i] = morph(p270, shape);
    }
    return true;
  }
}

/** Morph between sine, saw, and square for the given normalized phase [0,1). */
function morph(phase: number, shape: number): number {
  const s = Math.max(0, Math.min(2, shape));
  const sine = Math.sin(TWO_PI * phase);
  const saw = phase * 2 - 1;
  const sq = phase < 0.5 ? 1 : -1;
  if (s < 1) {
    const m = s;
    return sine * (1 - m) + saw * m;
  }
  const m = s - 1;
  return saw * (1 - m) + sq * m;
}

registerProcessor('lfo', LfoProcessor);
