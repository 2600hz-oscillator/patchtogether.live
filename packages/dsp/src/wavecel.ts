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

import { WavetableOsc, WAVETABLE_FRAME_SIZE, WtParamSmoother } from './lib/wavetable-osc';

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
  // De-zipper smoothers for the three perceptually-sensitive shape params.
  // morph + spread + fold all change WHICH-or-HOW frame samples are
  // combined — a hard step on any of them at a non-zero-crossing phase
  // produces an audible click even with a frozen wavetable (the bug this
  // PR fixes; see WtParamSmoother docstring). Pitch deliberately stays
  // un-smoothed so sequencer step transitions remain sample-instant.
  private smMorph: WtParamSmoother;
  private smSpread: WtParamSmoother;
  private smFold: WtParamSmoother;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.osc = new WavetableOsc(sampleRate);
    this.smMorph = new WtParamSmoother(sampleRate);
    this.smSpread = new WtParamSmoother(sampleRate);
    this.smFold = new WtParamSmoother(sampleRate);
    // Prime each smoother at the param's documented default so the very
    // first sample doesn't ramp from 0 (which would itself be a swept
    // morph / spread / fold across the first ~10 ms after node creation).
    this.smMorph.prime(0);
    this.smSpread.prime(1);
    this.smFold.prime(0);
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

      const morphRaw = morphKnob + mCv;
      // spread: linear CV blends across the 1..5 range (±1 = ±2 frames).
      const spreadRaw = spreadKnob + sCv * 2;
      const foldRaw = foldKnob + fCv;

      // ── Per-sample 1-pole LP de-zipper on morph / spread / fold ──
      // AudioParam values are constant within a 128-sample block, so an
      // unsmoothed setValueAtTime jump translates into a hard step at
      // the next block boundary — that's the click the user reported on
      // FOXY's out_l / out_r even with FREEZE TABLE on. Smoothing here
      // (~2 ms time constant at 48 kHz) masks both knob-drag step trains
      // AND any audio-rate jump on the morph_cv / spread_cv / fold_cv
      // inputs (LFO step, sequencer transitions, etc.). Pitch / tune /
      // fine intentionally bypass smoothing — see WtParamSmoother
      // docstring + the regression notes in fix/foxy-click-pop PR body.
      const morph = this.smMorph.step(morphRaw);
      const spread = this.smSpread.step(spreadRaw);
      const foldAmt = this.smFold.step(foldRaw);

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
