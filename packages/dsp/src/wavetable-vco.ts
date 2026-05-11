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
      // tune/fine bumped to a-rate so external CV (LFO summed into AudioParam)
      // is sampled per-frame rather than per-block; matches AnalogVCO behavior.
      { name: 'tune',     defaultValue: 0,   minValue: -36,  maxValue: 36,  automationRate: 'a-rate' as const },
      { name: 'fine',     defaultValue: 0,   minValue: -100, maxValue: 100, automationRate: 'a-rate' as const },
      { name: 'wavePos',  defaultValue: 0,   minValue: 0,    maxValue: 1,   automationRate: 'a-rate' as const },
      { name: 'fmAmount', defaultValue: 0,   minValue: 0,    maxValue: 1,   automationRate: 'a-rate' as const },
      { name: 'pmAmount', defaultValue: 0,   minValue: 0,    maxValue: 1,   automationRate: 'a-rate' as const },
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
      if (m?.type !== 'load') return;
      // Validate before accepting: an undersized or mis-shaped table would
      // cause out-of-bounds reads in process() (table[f1base + s1] etc).
      if (
        !m.table ||
        !Number.isFinite(m.frameSize) ||
        !Number.isFinite(m.frameCount) ||
        m.frameSize <= 0 ||
        m.frameCount <= 0 ||
        !Number.isInteger(m.frameSize) ||
        !Number.isInteger(m.frameCount)
      ) {
        console.error('[wavetable-vco] invalid LoadMessage shape', m);
        return;
      }
      const expectedSamples = m.frameSize * m.frameCount;
      const tbl = new Float32Array(m.table);
      if (tbl.length !== expectedSamples) {
        console.error(
          `[wavetable-vco] table length ${tbl.length} != frameSize*frameCount (${expectedSamples})`,
        );
        return;
      }
      this.table = tbl;
      this.frameSize = m.frameSize;
      this.frameCount = m.frameCount;
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
    const pmIn = inputs[3]?.[0];

    const tuneArr = parameters.tune;
    const fineArr = parameters.fine;
    const wavePosArr = parameters.wavePos;
    const fmAmountArr = parameters.fmAmount;
    const pmAmountArr = parameters.pmAmount;

    const FS = this.frameSize;
    const FC = this.frameCount;
    const sr = sampleRate;
    const tbl = this.table;

    for (let i = 0; i < out.length; i++) {
      const pitch = pitchIn ? pitchIn[i] : 0;
      const fm = fmIn ? fmIn[i] : 0;
      const pm = pmIn ? pmIn[i] : 0;
      const wpCv = wavePosCv ? wavePosCv[i] : 0;
      const tune = tuneArr.length > 1 ? tuneArr[i] : tuneArr[0];
      const fine = fineArr.length > 1 ? fineArr[i] : fineArr[0];
      const fma = fmAmountArr.length > 1 ? fmAmountArr[i] : fmAmountArr[0];
      const pma = pmAmountArr.length > 1 ? pmAmountArr[i] : pmAmountArr[0];
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
      while (this.phase < 0) this.phase += 1;

      // PM: external pm signal × pmAmount adds a phase offset (cycles). The
      // accumulator stays unchanged so its frequency tracking is still correct;
      // only the readout phase is shifted. ±1 pm × pmAmount=1 → ±1 cycle shift.
      let p = this.phase + pma * pm;
      p = p - Math.floor(p);

      // Frame interpolation
      const frameFloat = wp * (FC - 1);
      const f1 = Math.floor(frameFloat);
      const f2 = f1 + 1 < FC ? f1 + 1 : f1;
      const frameFrac = frameFloat - f1;

      // Sample interpolation within a frame
      const sampleFloat = p * FS;
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
