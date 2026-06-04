// packages/dsp/src/mandelbulb-osc.ts
//
// MANDELBULB-OSC — the SLIM wavetable oscillator that plays the MANDELBULB
// bulb-slice readout as audio. A trimmed-down clone of cube.ts's oscillator
// pipeline: it drops CUBE's three-table / morph / connect / spread / fold / wrap
// machinery and keeps only the cheap hot path — phase-accumulate through ONE
// posted 256-sample slice waveform at the V/oct pitch.
//
// The expensive bulb-slice scan (mandelbulb-slice.mbSampleSlice — 256 rays ×
// MB_RAY_STEPS DE evals, and the DE is far pricier than a cube field read) runs
// OFF the audio thread, in the web factory (mandelbulb.ts), and is pushed in via
// a {type:'setWave', wave} port message whenever a slice-shaping param changes
// (recompute-on-change, NOT per audio sample). The worklet only ever
// phase-walks the posted wave → no dropouts.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/mandelbulb-osc.js + break ART's
// classic-script eval. The Processor class is registered via registerProcessor;
// tests capture it through a registerProcessor shim.
//
// Inputs:
//   inputs[0] = pitch — V/oct pitch CV (0V = C4). The only node input read
//               directly; tune/fine/level are AudioParams summed by the factory.
// Outputs:
//   outputs[0] = [mono] — the slice waveform played at pitch * level.

import {
  sampleSplit,
  clampRange,
  WAVETABLE_FRAME_SIZE,
} from './lib/wavetable-osc';
import { MB_SLICE_SIZE } from './lib/mandelbulb-slice';

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
// captures the class via this shim — see the mandelbulb-osc test loader).
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

const C4_HZ = 261.626;

/** Off-thread slice push: the main thread computed the 256-sample bulb-slice
 *  waveform and hands it over so the audio thread never runs the DE scan. */
interface SetWaveMessage {
  type: 'setWave';
  wave: Float32Array;
}
type IncomingMessage = SetWaveMessage;

/** Read one sample from a 256-sample frame at a fractional phase using the same
 *  (s1,s2,sFrac) split the wavetable engine uses (linear interpolation). */
function readFrame(frame: Float32Array, phase: number): number {
  const { s1, s2, sFrac } = sampleSplit(phase, frame.length || WAVETABLE_FRAME_SIZE);
  const a = frame[s1] ?? 0;
  const b = frame[s2] ?? 0;
  return a + (b - a) * sFrac;
}

// Not `export`ed at the top level by design — see the file-header note.
class MandelbulbOscProcessor extends AudioWorkletProcessor {
  // Phase accumulator (normalized [0,1)).
  private phase = 0;

  // The posted slice waveform. Typed ArrayBufferLike so a posted Float32Array
  // (also Float32Array<ArrayBufferLike> under the strict web tsconfig that
  // compiles this dsp source) assigns cleanly. Silent until the first setWave.
  private wave: Float32Array<ArrayBufferLike> = new Float32Array(MB_SLICE_SIZE);
  private haveWave = false;

  static get parameterDescriptors() {
    return [
      // Pitch trims — k-rate (instant per block, like the wavetable engine; not
      // smoothed so sequencer steps stay sample-tight).
      { name: 'tune', defaultValue: 0, minValue: -36, maxValue: 36, automationRate: 'k-rate' as const },
      { name: 'fine', defaultValue: 0, minValue: -100, maxValue: 100, automationRate: 'k-rate' as const },
      // Output level — a-rate so summed CV can reach it.
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'a-rate' as const },
    ];
  }

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    // The real AudioWorkletGlobalScope gives every processor a MessagePort.
    // The vitest registerProcessor shim does not (base class is `class {}`), so
    // a test may install a stub port; guard the wiring so construction never
    // throws.
    if (!this.port) {
      (this as { port: MessagePort }).port = {
        onmessage: null,
        postMessage: () => {},
      } as unknown as MessagePort;
    }
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as IncomingMessage;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'setWave') {
        const next = m.wave;
        if (next && next.length > 0) {
          this.wave = next as Float32Array<ArrayBufferLike>;
          this.haveWave = true;
        }
      }
    };
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0];
    const outL = out?.[0];
    if (!outL) return true;
    const n = outL.length;

    // Silent until a slice waveform has been posted.
    if (!this.haveWave) {
      outL.fill(0);
      return true;
    }

    const tune = this.kval(parameters, 'tune', 0);
    const fine = this.kval(parameters, 'fine', 0);
    const pIn = inputs[0]?.[0];
    const levelArr = parameters.level;
    const sr = sampleRate;

    for (let i = 0; i < n; i++) {
      const pitch = pIn ? (pIn[i] ?? 0) : 0;
      const voct = pitch + tune / 12 + fine / 1200;
      let freq = C4_HZ * Math.pow(2, voct);
      if (freq < 1) freq = 1;
      else if (freq > sr * 0.5) freq = sr * 0.5;
      this.phase += freq / sr;
      while (this.phase >= 1) this.phase -= 1;
      while (this.phase < 0) this.phase += 1;

      const level = levelArr
        ? (levelArr.length > 1 ? (levelArr[i] as number) : (levelArr[0] as number))
        : 1;
      const s = readFrame(this.wave, this.phase) * level;
      outL[i] = clampRange(s, -4, 4);
    }

    return true;
  }
}

registerProcessor('mandelbulb-osc', MandelbulbOscProcessor);
