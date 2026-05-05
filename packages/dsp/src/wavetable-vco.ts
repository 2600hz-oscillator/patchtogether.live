// packages/dsp/src/wavetable-vco.ts
//
// Wavetable VCO worklet processor. Custom JS (table lookup is data-driven, not
// a great fit for Faust). The factory generates a synthetic table at runtime
// and posts it via port.postMessage. This processor handles:
//   - frame interpolation (between adjacent frames)
//   - sample interpolation (between adjacent samples within a frame)
//   - pitch from 1V/oct CV input + tune + fine + audio-rate FM
//
// v1: no mip-mapping (some aliasing above ~8 kHz fundamental). Real wavetable
// file loading + per-octave mip-maps are a follow-on.

// ---- AudioWorkletGlobalScope ambient declarations (erased at compile time) ----
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

interface LoadMessage {
  type: 'load';
  table: ArrayBuffer;
  frameSize: number;
  frameCount: number;
}

class WavetableVcoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'tune',     defaultValue: 0,   minValue: -36,  maxValue: 36,  automationRate: 'k-rate' as const },
      { name: 'fine',     defaultValue: 0,   minValue: -100, maxValue: 100, automationRate: 'k-rate' as const },
      { name: 'wavePos',  defaultValue: 0,   minValue: 0,    maxValue: 1,   automationRate: 'a-rate' as const },
      { name: 'fmAmount', defaultValue: 0,   minValue: 0,    maxValue: 1,   automationRate: 'a-rate' as const },
    ];
  }

  private table: Float32Array | null = null;
  private frameSize = 2048;
  private frameCount = 0;
  private phase = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as LoadMessage;
      if (m?.type === 'load') {
        this.table = new Float32Array(m.table);
        this.frameSize = m.frameSize;
        this.frameCount = m.frameCount;
      }
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;

    if (!this.table || this.frameCount === 0) {
      out.fill(0);
      return true;
    }

    const pitchIn = inputs[0]?.[0];
    const fmIn = inputs[1]?.[0];
    const wavePosCv = inputs[2]?.[0];

    const tune = parameters.tune[0] ?? 0;
    const fine = parameters.fine[0] ?? 0;
    const wavePosArr = parameters.wavePos;
    const fmAmountArr = parameters.fmAmount;

    const FS = this.frameSize;
    const FC = this.frameCount;
    const sr = sampleRate;
    const tbl = this.table;

    for (let i = 0; i < out.length; i++) {
      const pitch = pitchIn ? pitchIn[i] : 0;
      const fm = fmIn ? fmIn[i] : 0;
      const wpCv = wavePosCv ? wavePosCv[i] : 0;
      const fma = fmAmountArr.length > 1 ? fmAmountArr[i] : fmAmountArr[0];
      const wpKnob = wavePosArr.length > 1 ? wavePosArr[i] : wavePosArr[0];

      let wp = wpKnob + wpCv;
      if (wp < 0) wp = 0;
      else if (wp > 1) wp = 1;

      const semitones = pitch * 12 + tune + fine / 100 + fma * fm * 12;
      let freq = 261.626 * Math.pow(2, semitones / 12);
      if (freq < 1) freq = 1;
      else if (freq > 20000) freq = 20000;

      this.phase += freq / sr;
      while (this.phase >= 1) this.phase -= 1;

      // Frame interpolation
      const frameFloat = wp * (FC - 1);
      const f1 = Math.floor(frameFloat);
      const f2 = f1 + 1 < FC ? f1 + 1 : f1;
      const frameFrac = frameFloat - f1;

      // Sample interpolation within a frame
      const sampleFloat = this.phase * FS;
      const sFloor = Math.floor(sampleFloat);
      const s1 = sFloor % FS;
      const s2 = (sFloor + 1) % FS;
      const sampleFrac = sampleFloat - sFloor;

      const f1base = f1 * FS;
      const f2base = f2 * FS;

      const a = tbl[f1base + s1] + (tbl[f1base + s2] - tbl[f1base + s1]) * sampleFrac;
      const b = tbl[f2base + s1] + (tbl[f2base + s2] - tbl[f2base + s1]) * sampleFrac;
      out[i] = a + (b - a) * frameFrac;
    }

    return true;
  }
}

registerProcessor('wavetable-vco', WavetableVcoProcessor);
