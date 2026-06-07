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
import { Envelope } from './lib/adsr-env';
import {
  polyEnvSum,
  monoEnvSample,
  updateHeldPitch,
  laneRenderVOct,
  type AdsrParams,
} from './lib/poly-osc-sum';

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
      // Per-voice amplitude ADSR (per-voice-ADSR feature). A single shared
      // A/D/S/R set feeds all 5 lane envelopes (poly) + lane-0 (mono TRIGGER).
      // Defaults ~pass-through so an untouched ADSR + an ungated/unpatched
      // TRIGGER keeps the legacy mono drone byte-identical. k-rate.
      { name: 'attack',  defaultValue: 0.001, minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'decay',   defaultValue: 0.1,   minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      { name: 'sustain', defaultValue: 1,     minValue: 0,     maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'release', defaultValue: 0.005, minValue: 0.001, maxValue: 5, automationRate: 'k-rate' as const },
      // Per-voice VCA FLOOR the envelope rides on top of: gain = base+(1-base)*env
      // per ACTIVE voice. base=1 (default) → gain=1, the env does nothing → the
      // raw-VCO drone is byte-identical (back-compat). base=0 → pure ADSR. k-rate.
      { name: 'base_vol', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      // CONNECTEDNESS flags (k-rate, 0/1) pushed by the web factory from the live
      // patch edges — NOT bus presence, which the trigger keep-alive ConstantSource
      // masks. When poly OR trigger is connected the module is GATED (a voice sounds
      // only while gated-or-releasing); neither connected → a continuous raw VCO.
      // The no-stray-drone fix: a patched-but-ungated poly/trigger no longer falls
      // through to the mono drone.
      { name: 'poly_connected',    defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'trigger_connected', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
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

  // ── Per-voice amplitude ADSR (per-voice-ADSR feature) ──
  // One Envelope per lane; poly lane edges drive env[lane], the mono TRIGGER
  // drives env[0]. The GATING MODE is decided by connectedness (poly_connected /
  // trigger_connected params), NOT a first-edge latch: when poly OR trigger is
  // connected the module is GATED (a voice sounds only while gated-or-releasing);
  // neither connected → a continuous raw VCO. Scratch arrays feed the per-lane
  // (L,R) reads to polyEnvSum.
  private env: Envelope[] = Array.from({ length: POLY_VOICES }, () => new Envelope());
  private prevGate: Uint8Array = new Uint8Array(POLY_VOICES);
  private prevTrigGate = 0;
  private laneScratchL = new Float64Array(POLY_VOICES);
  private laneScratchR = new Float64Array(POLY_VOICES);
  // PERSISTENT per-lane held V/oct — UPDATED while a lane is gated, HELD (never
  // reset) when it's not, so a releasing voice (gate low, env>0) keeps advancing
  // at the played pitch instead of snapping to 0 V/oct (C4). See updateHeldPitch
  // / laneRenderVOct in lib/poly-osc-sum.ts (the release-tail pitch fix).
  private heldVOct: Float64Array = new Float64Array(POLY_VOICES);

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
    // (poly unpatched) — the engine connects all 10 channels to ONE input. Poly
    // STAYS at input 5; the new mono TRIGGER is appended at input 6 (do NOT
    // renumber poly or #664 routing breaks).
    const polyIn = inputs[5];
    const trigIn = inputs[6]?.[0];

    const tune = parameters.tune[0] ?? 0;
    const fine = parameters.fine[0] ?? 0;
    const morphArr = parameters.morph;
    const spreadArr = parameters.spread;
    const foldArr = parameters.fold;
    const sr = sampleRate;

    // ── Per-voice ADSR params (k-rate; read once, fed to every lane env) ──
    const adsr: AdsrParams = {
      attack:  parameters.attack ? (parameters.attack[0] ?? 0.001) : 0.001,
      decay:   parameters.decay ? (parameters.decay[0] ?? 0.1) : 0.1,
      sustain: parameters.sustain ? (parameters.sustain[0] ?? 1) : 1,
      release: parameters.release ? (parameters.release[0] ?? 0.005) : 0.005,
    };
    // Per-voice VCA floor (gain = base + (1-base)*env per ACTIVE voice).
    const baseVol = parameters.base_vol ? (parameters.base_vol[0] ?? 1) : 1;
    // CONNECTEDNESS (from the factory via k-rate params, not bus presence).
    const polyConnParam = (parameters.poly_connected ? (parameters.poly_connected[0] ?? 0) : 0) >= 0.5;
    const trigConnParam = (parameters.trigger_connected ? (parameters.trigger_connected[0] ?? 0) : 0) >= 0.5;

    // Decide once per block which poly lanes are GATED. We sample the gate +
    // pitch at the FIRST sample of the block (the sequencer / MIDI LANE write
    // setValueAtTime at block boundaries, so first-sample reads are exact).
    // NOTE on retrigger granularity (CRITIQUE C4): edges are detected once at
    // sample 0, so a sub-block 1→0→1 re-strike (faster than ~one block) is
    // missed. An intra-block scan is a documented follow-up.
    const laneGate: boolean[] = [false, false, false, false, false];
    let anyPolyGate = false;
    if (polyIn) {
      for (let lane = 0; lane < POLY_VOICES; lane++) {
        const gateCh = polyIn[lane * 2 + 1];
        const pitchCh = polyIn[lane * 2];
        const g = gateCh && gateCh.length > 0 ? (gateCh[0] ?? 0) : 0;
        const gated = g > 0.5;
        if (gated) {
          laneGate[lane] = true;
          anyPolyGate = true;
        }
        // Track this lane's pitch while gated; HOLD it through release so a
        // releasing voice (gate low, env still audible) advances at the held
        // (played) pitch, not 0 V/oct = C4 — the release-tail pitch fix.
        const lanePitch = pitchCh && pitchCh.length > 0 ? (pitchCh[0] ?? 0) : 0;
        this.heldVOct[lane] = updateHeldPitch(this.heldVOct[lane]!, gated, lanePitch);
      }
    }

    // Mono TRIGGER edge state.
    const trigGate = trigIn && trigIn.length > 0 ? ((trigIn[0] ?? 0) > 0.5 ? 1 : 0) : 0;

    // Gate-edge detection → soft (click-safe) retrigger.
    for (let lane = 0; lane < POLY_VOICES; lane++) {
      const now = laneGate[lane] ? 1 : 0;
      if (now && !this.prevGate[lane]) this.env[lane]!.triggerSoft(true);
      else if (!now && this.prevGate[lane]) this.env[lane]!.triggerSoft(false);
      this.prevGate[lane] = now as number;
    }
    // Mono TRIGGER edge → lane-0 envelope (only meaningful in the gated-MONO path).
    // Suppressed whenever poly is connected or a poly gate is live — poly owns env[0].
    if (!polyConnParam && !anyPolyGate) {
      if (trigGate && !this.prevTrigGate) this.env[0]!.triggerSoft(true);
      else if (!trigGate && this.prevTrigGate) this.env[0]!.triggerSoft(false);
    }
    this.prevTrigGate = trigGate;

    // ── GATING MODE (no-stray-drone fix) ──
    // CONNECTEDNESS drives the mode, NOT bus presence (the trigger keep-alive
    // ConstantSource always makes its input present, masking it). A live gate also
    // implies connectedness (covers the unit-test path that drives a poly bus
    // directly without the connectedness param).
    const polyConn = polyConnParam || anyPolyGate;
    const trigConn = trigConnParam || trigGate === 1;
    // POLY mode: poly connected → per-lane env sum. A never-gated lane stays silent
    // (polyEnvSum excludes inactive lanes) → patching poly no longer auto-drones.
    const polyActive = polyConn;
    // GATED-MONO mode: trigger connected (poly not) → lane-0 env shapes the mono
    // oscillator; silent until the first hit, base-floored once active.
    const gatedMono = !polyActive && trigConn;
    // Otherwise (NOTHING connected): the continuous raw VCO at baseVol (default 1
    // → byte-identical legacy drone).
    const laneL = this.laneScratchL;
    const laneR = this.laneScratchR;

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
        // Polyphonic: step each lane's voice (its own V/oct + shared trim) then
        // hand the per-lane (L,R) samples to polyEnvSum, which ticks every lane
        // envelope, applies the per-voice VCA gain (base + (1-base)*env) to each
        // ACTIVE (gated-or-releasing) lane, sums them, and returns the active-voice
        // normalization. A NEVER-gated lane stays SILENT regardless of baseVol —
        // patching poly never auto-drones (the no-stray-drone fix). A lane in
        // RELEASE keeps sounding (env>0). The morph / spread / fold timbre is shared
        // across voices. Silent lanes still advance (at lane-0's pitch) so a
        // re-opened lane doesn't pop.
        for (let lane = 0; lane < POLY_VOICES; lane++) {
          const v = this.polyVoices[lane]!;
          // Held pitch: gated OR still releasing (env>0) → the lane's OWN held
          // (played) pitch; silent/never-gated → lane-0's held pitch (no pop).
          const voct = laneRenderVOct(
            this.heldVOct, lane, laneGate[lane]!, this.env[lane]!.value > 0,
          ) + trim;
          const { l, r } = v.step(voct, morph, spread, foldAmt);
          laneL[lane] = l;
          laneR[lane] = r;
        }
        const { sumL, sumR, polyNorm } = polyEnvSum(
          laneL, laneR, this.env, adsr, sr, laneGate, baseVol,
        );
        outL[i] = sumL * polyNorm;
        outR[i] = sumR * polyNorm;
      } else if (gatedMono) {
        // Gated mono (TRIGGER connected; poly unpatched). The mono oscillator is
        // scaled by lane-0's per-voice VCA gain (base + (1-base)*env). The voice
        // is ACTIVE only while gated-or-releasing → silent until the first hit,
        // base-floored once active (a patched-but-never-hit TRIGGER does not drone).
        const voct = pitch + trim;
        const { l, r } = this.osc.step(voct, morph, spread, foldAmt);
        const active = trigGate === 1 || this.env[0]!.value > 0;
        const { l: el, r: er } = monoEnvSample(l, r, this.env[0]!, adsr, sr, baseVol, active);
        outL[i] = el;
        outR[i] = er;
      } else {
        // Raw VCO (NOTHING connected to poly or trigger): the single mono voice is
        // "always active". With no gate the env is idle (0), so its VCA gain is
        // baseVol — baseVol=1 (default) reproduces the legacy continuous drone
        // BYTE-IDENTICALLY (× 1.0 is exact in IEEE-754), baseVol=0 is silent.
        const voct = pitch + trim;
        const { l, r } = this.osc.step(voct, morph, spread, foldAmt);
        outL[i] = l * baseVol;
        outR[i] = r * baseVol;
      }
    }

    return true;
  }
}

registerProcessor('wavecel', WavecelProcessor);
