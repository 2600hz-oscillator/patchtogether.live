// packages/dsp/src/wavecel.ts
//
// WAVECEL — stereo wavetable VCO with morph + spread + wavefolder.
//
// Per-sample DSP (sample/frame interpolation, fold, spread-mix) now lives
// in packages/dsp/src/lib/wavetable-osc.ts so WAVESCULPT can reuse the same
// math without forking. This file owns:
//   * AudioWorklet plumbing (port message handling, parameterDescriptors)
//   * Per-sample input-vs-AudioParam read + pitch summation
//   * The stateful WavetableOsc instance
//
// Wire format unchanged: host posts { type: 'loadWavetable', frames:
// number[][] } via port.postMessage; plain arrays (no Yjs proxies — recall
// the DX7 SYX bug from PR-94 where structuredClone choked on proxies).

import { WavetableOsc, WAVETABLE_FRAME_SIZE } from './lib/wavetable-osc';

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
  type: 'loadWavetable';
  frames: number[][];
}

class WavecelProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'tune',   defaultValue: 0,   minValue: -36, maxValue: 36, automationRate: 'k-rate' as const },
      { name: 'fine',   defaultValue: 0,   minValue: -100, maxValue: 100, automationRate: 'k-rate' as const },
      { name: 'morph',  defaultValue: 0,   minValue: 0,   maxValue: 1,  automationRate: 'a-rate' as const },
      { name: 'spread', defaultValue: 1,   minValue: 1,   maxValue: 5,  automationRate: 'a-rate' as const },
      { name: 'fold',   defaultValue: 0,   minValue: 0,   maxValue: 1,  automationRate: 'a-rate' as const },
    ];
  }

  private osc: WavetableOsc;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.osc = new WavetableOsc(sampleRate);
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as LoadMessage;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'loadWavetable') {
        if (!Array.isArray(m.frames) || m.frames.length === 0) {
          console.error('[wavecel] invalid loadWavetable: empty frames');
          return;
        }
        const next: Float32Array[] = [];
        for (let i = 0; i < m.frames.length; i++) {
          const src = m.frames[i];
          if (!src || src.length !== WAVETABLE_FRAME_SIZE) {
            console.error(`[wavecel] frame ${i} length ${src?.length} != ${WAVETABLE_FRAME_SIZE}`);
            return;
          }
          next.push(Float32Array.from(src));
        }
        this.osc.setFrames(next);
      }
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;

    if (!this.osc.framesLoaded()) {
      outL.fill(0);
      outR.fill(0);
      return true;
    }

    const pitchIn = inputs[0]?.[0];
    const fmIn = inputs[1]?.[0];
    const morphCv = inputs[2]?.[0];
    const spreadCv = inputs[3]?.[0];
    const foldCv = inputs[4]?.[0];

    const tune = parameters.tune[0] ?? 0;
    const fine = parameters.fine[0] ?? 0;
    const morphArr = parameters.morph;
    const spreadArr = parameters.spread;
    const foldArr = parameters.fold;

    for (let i = 0; i < outL.length; i++) {
      const pitch = pitchIn ? pitchIn[i] : 0;
      const fm = fmIn ? fmIn[i] : 0;

      const morphKnob = morphArr.length > 1 ? morphArr[i] : morphArr[0];
      const spreadKnob = spreadArr.length > 1 ? spreadArr[i] : spreadArr[0];
      const foldKnob = foldArr.length > 1 ? foldArr[i] : foldArr[0];
      const mCv = morphCv ? morphCv[i] : 0;
      const sCv = spreadCv ? spreadCv[i] : 0;
      const fCv = foldCv ? foldCv[i] : 0;

      const morph = morphKnob + mCv;
      // spread: linear CV blends across the 1..5 range (±1 = ±2 frames).
      const spread = spreadKnob + sCv * 2;
      const foldAmt = foldKnob + fCv;

      // Convert pitch + tune + fine + FM → V/oct for the shared engine.
      const voct = pitch + tune / 12 + fine / 1200 + fm;
      const { l, r } = this.osc.step(voct, morph, spread, foldAmt);
      outL[i] = l;
      outR[i] = r;
    }

    return true;
  }
}

registerProcessor('wavecel', WavecelProcessor);
