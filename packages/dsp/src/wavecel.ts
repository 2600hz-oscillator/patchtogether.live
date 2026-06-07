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
//
// POLYPHONY (poly input — feat/poly-in-wavcel-cube):
//   The LAST worklet input (index 5) is a 10-channel `polyPitchGate` bus (5
//   voice lanes of pitch+gate; ch 2i = lane-i V/oct, ch 2i+1 = lane-i gate).
//   It's the SAME cable MIDI LANE (mode='poly') + POLYSEQZ emit (see
//   packages/web/src/lib/audio/poly.ts). When ANY lane gate is high we render
//   one WavetableOsc per gated lane at that lane's pitch and SUM them — WAVECEL
//   goes polyphonic. The shared morph / spread / fold timbre applies to every
//   voice; voice 0 IS the mono oscillator, so when no poly gate is present (poly
//   unpatched OR all lanes closed) the render is BYTE-IDENTICAL to the original
//   mono path (input[0] pitch). Back-compat + ART/VRT baselines preserved.

import { WavetableOsc, WAVETABLE_FRAME_SIZE, WtParamSmoother } from './lib/wavetable-osc';

/** Poly bus shape (mirrors packages/web/src/lib/audio/poly.ts): 5 voice lanes,
 *  10 channels (ch 2i = lane-i pitch V/oct, ch 2i+1 = lane-i gate). */
const POLY_VOICES = 5;

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

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest
// captures the class via this shim — see wavecel.test.ts loadProcessor()).
// Mirrors the cube.ts worklet. NOT `export`ed (top-level exports leak into the
// esbuild ESM bundle + break ART's classic-script eval — see the
// dsp-worklet-no-top-level-export rule).
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
  // Polyphony: 5 extra WavetableOsc voices (lane 1..4 + lane 0). When the poly
  // input carries any gate we render one voice per gated lane and SUM. Each
  // shares the SAME loaded frames as the mono `osc` (a chord is one timbre, many
  // pitches). voice[0] reuses the mono `osc` so the mono path stays identical;
  // voices[1..4] are dedicated to the upper chord lanes. setFrames() broadcasts
  // to all of them. Created lazily-once in the constructor (cheap: just a phase
  // accumulator + a frames pointer each).
  private polyVoices: WavetableOsc[];
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
    // Lane 0 reuses the mono `osc`; lanes 1..4 get their own accumulators.
    this.polyVoices = [this.osc];
    for (let i = 1; i < POLY_VOICES; i++) this.polyVoices.push(new WavetableOsc(sampleRate));
    this.smMorph = new WtParamSmoother(sampleRate);
    this.smSpread = new WtParamSmoother(sampleRate);
    this.smFold = new WtParamSmoother(sampleRate);
    // Prime each smoother at the param's documented default so the very
    // first sample doesn't ramp from 0 (which would itself be a swept
    // morph / spread / fold across the first ~10 ms after node creation).
    this.smMorph.prime(0);
    this.smSpread.prime(1);
    this.smFold.prime(0);
    // The real AudioWorkletGlobalScope gives every processor a MessagePort.
    // The vitest registerProcessor shim does not (base class is `class {}`),
    // so install a minimal stub so construction never throws (the test
    // delivers loadWavetable by invoking this.port.onmessage directly).
    if (!this.port) {
      (this as { port: MessagePort }).port = {
        onmessage: null,
        postMessage: () => {},
      } as unknown as MessagePort;
    }
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
        // Broadcast to every voice (mono osc = voice 0 + the 4 upper poly
        // lanes) so a chord plays the same wavetable. Each voice owns its own
        // phase + crossfade state; the frames array is shared by value.
        for (const v of this.polyVoices) v.setFrames(next);
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
    // Poly bus (10-channel polyPitchGate, see file header). May be absent
    // (poly unpatched) — the engine connects all 10 channels to ONE input.
    const polyIn = inputs[5];

    const tune = parameters.tune[0] ?? 0;
    const fine = parameters.fine[0] ?? 0;
    const morphArr = parameters.morph;
    const spreadArr = parameters.spread;
    const foldArr = parameters.fold;

    // Decide once per block which poly lanes are GATED. We sample the gate +
    // pitch at the FIRST sample of the block (the sequencer / MIDI LANE write
    // setValueAtTime at block boundaries, so first-sample reads are exact).
    // `polyActive` = at least one lane gated ⇒ render the poly sum; otherwise
    // the render falls through to the existing mono path (byte-identical).
    let polyActive = false;
    const laneGate: boolean[] = [false, false, false, false, false];
    const laneVOct: number[] = [0, 0, 0, 0, 0];
    if (polyIn) {
      for (let lane = 0; lane < POLY_VOICES; lane++) {
        const gateCh = polyIn[lane * 2 + 1];
        const pitchCh = polyIn[lane * 2];
        const g = gateCh && gateCh.length > 0 ? (gateCh[0] ?? 0) : 0;
        if (g > 0.5) {
          laneGate[lane] = true;
          laneVOct[lane] = pitchCh && pitchCh.length > 0 ? (pitchCh[0] ?? 0) : 0;
          polyActive = true;
        }
      }
    }
    // Equal-RMS-ish attenuation so a 4-note chord doesn't clip vs a single
    // note. sqrt(activeCount) keeps a held single poly note at ~mono level.
    let activeCount = 0;
    for (let lane = 0; lane < POLY_VOICES; lane++) if (laneGate[lane]) activeCount++;
    const polyNorm = activeCount > 0 ? 1 / Math.sqrt(activeCount) : 1;

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

      // Shared timbre offsets (tune / fine / FM) apply to every voice.
      const trim = tune / 12 + fine / 1200 + fm;

      if (polyActive) {
        // Polyphonic: SUM the gated lanes. Each lane's voice tracks its own
        // V/oct (+ shared trim). The morph / spread / fold timbre is shared,
        // matching how a single oscillator's controls shape a whole chord.
        let sumL = 0;
        let sumR = 0;
        for (let lane = 0; lane < POLY_VOICES; lane++) {
          const v = this.polyVoices[lane]!;
          if (!laneGate[lane]) {
            // Silent lane: advance its phase at lane-0's pitch so a newly-
            // opened lane doesn't pop in mid-cycle, but contribute nothing.
            v.step(laneVOct[0]! + trim, morph, spread, foldAmt);
            continue;
          }
          const { l, r } = v.step(laneVOct[lane]! + trim, morph, spread, foldAmt);
          sumL += l;
          sumR += r;
        }
        outL[i] = sumL * polyNorm;
        outR[i] = sumR * polyNorm;
      } else {
        // Mono (poly unpatched / all gates closed): the original path,
        // byte-identical. Only voice 0 (the mono `osc`) advances + sounds.
        const voct = pitch + trim;
        const { l, r } = this.osc.step(voct, morph, spread, foldAmt);
        outL[i] = l;
        outR[i] = r;
      }
    }

    return true;
  }
}

registerProcessor('wavecel', WavecelProcessor);
