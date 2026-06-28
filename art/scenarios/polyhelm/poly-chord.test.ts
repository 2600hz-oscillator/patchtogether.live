// art/scenarios/polyhelm/poly-chord.test.ts
//
// Audio Regression Test for POLYHELM's polyphonic poly-bus path. Drives the
// SHARED HELM engine (packages/dsp/src/lib/helm-engine.ts — the same code the
// polyhelm worklet runs) directly, because the ART render() harness can't load
// an AudioWorklet under vitest (it returns a synthetic stub). This is the real
// signal-coverage gate for the poly→voices behavior, the same approach the
// helm + dx7 ART scenarios take (host-side render mirror, property assertions —
// no .f32/.sha pin). (The former sha-pin.test.ts next door was DELETED in the
// test-honesty quick-win: its `render()`-stub baseline was a 440 Hz sine shared
// byte-for-byte with ~10 other stubs — a gate comparing a stub against itself.
// POLYHELM's poly path stays covered by THIS engine-driven scenario; the worklet
// build-SHA is still pinned by the dsp-build job. A real per-module ART render
// for polyhelm can be re-added once render.ts renders actual worklets.)
//
// Property assertions:
//   - A 3-note chord has Goertzel energy at all 3 fundamentals.
//   - The chord's RMS clearly exceeds a single voice (voices sum).
//   - A released voice's ADSR tail rings at the PLAYED pitch, not C4 (the
//     held-pitch-through-release guarantee).

import { describe, it, expect } from 'vitest';
import { HelmEngine, C4_HZ, EnvState, type HelmParams } from '../../../packages/dsp/src/lib/helm-engine';

const SR = 48000;

function params(over: Partial<HelmParams> = {}): HelmParams {
  return {
    voiceCount: 8, volume: 0.7,
    osc1Wave: 0, osc1Trans: 0, osc1Tune: 0, osc1Unison: 1, osc1Detune: 10, osc1Vol: 0.8,
    osc2Wave: 1, osc2Trans: 0, osc2Tune: 0, osc2Unison: 1, osc2Detune: 10, osc2Vol: 0.0,
    subWave: 3, subVol: 0.0, noiseVol: 0.0,
    filterCutoff: 18000, filterRes: 0.7, filterBlend: 0, filterStyle: 0, filterDrive: 1, filterKeyTrack: 0,
    ampAttack: 0.002, ampDecay: 0.05, ampSustain: 1.0, ampRelease: 1.0,
    filAttack: 0.002, filDecay: 0.05, filSustain: 1.0, filRelease: 0.3, filEnvDepth: 0,
    modAttack: 0.002, modDecay: 0.05, modSustain: 0, modRelease: 0.3, modEnvDepth: 0,
    lfo1Wave: 3, lfo1Freq: 1, lfo1Amp: 0,
    lfo2Wave: 3, lfo2Freq: 4, lfo2Amp: 0,
    stepNumSteps: 8, stepSmooth: 0, stepDepth: 0, spread: 0,
    ...over,
  };
}

function midiToVOct(m: number): number { return (m - 60) / 12; }
function midiToHz(m: number): number { return C4_HZ * Math.pow(2, (m - 60) / 12); }

function goertzel(buf: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i]! + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / buf.length;
}
function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

/** Drive the poly bus (mirrors the worklet's per-lane edge logic) for a single
 *  gate profile, with persistent edge state, and return the mono-summed audio. */
function renderGated(
  p: HelmParams,
  lanesGated: Array<{ midi: number }>,
  holdS: number,
  tailS: number,
): Float32Array {
  const engine = new HelmEngine();
  const blockLen = 128;
  const prev = new Float32Array(5);
  const holdBlocks = Math.floor((SR * holdS) / blockLen);
  const tailBlocks = Math.floor((SR * tailS) / blockLen);
  const out = new Float32Array((holdBlocks + tailBlocks) * blockLen);

  function block(gateHigh: boolean, idx: number): void {
    for (let lane = 0; lane < 5; lane++) {
      const g = lane < lanesGated.length && gateHigh ? 1 : 0;
      const was = prev[lane]! > 0.5;
      const is = g > 0.5;
      const m = lanesGated[lane]?.midi ?? 60;
      if (is && !was) engine.noteOnLane(lane, m, 1.0);
      else if (!is && was) engine.noteOffLane(lane);
      else if (is) engine.updateLanePitch(lane, m);
      prev[lane] = g;
    }
    engine.tickSequencerEdges(false, false, p.stepNumSteps);
    const outL = new Float32Array(blockLen);
    engine.renderBlock(outL, new Float32Array(blockLen), p, SR);
    out.set(outL, idx * blockLen);
  }

  let i = 0;
  for (let h = 0; h < holdBlocks; h++) block(true, i++);
  for (let t = 0; t < tailBlocks; t++) block(false, i++);
  return out;
}

describe('ART polyhelm / poly-bus chord playback', () => {
  it('a C-major triad on the poly bus has energy at all 3 fundamentals', () => {
    const audio = renderGated(params(), [{ midi: 60 }, { midi: 64 }, { midi: 67 }], 0.4, 0);
    for (const m of [60, 64, 67]) {
      const f = midiToHz(m);
      const peak = goertzel(audio, f, SR);
      const noise = Math.max(goertzel(audio, f + 90, SR), goertzel(audio, Math.max(20, f - 90), SR), 1e-9);
      expect(peak / noise, `triad peak at ${f.toFixed(1)}Hz`).toBeGreaterThan(3);
    }
  });

  it('a 5-voice chord RMS clearly exceeds a single voice', () => {
    const single = renderGated(params(), [{ midi: 60 }], 0.3, 0);
    const five = renderGated(
      params(),
      [{ midi: 55 }, { midi: 59 }, { midi: 62 }, { midi: 67 }, { midi: 71 }],
      0.3, 0,
    );
    expect(rms(five)).toBeGreaterThan(rms(single) * 1.5);
  });

  it('release tail rings at the PLAYED pitch, not C4 (held-pitch-through-release)', () => {
    // Play C5 (72), hold 0.12s, then render 0.25s of the release tail (release=2s).
    const tail = renderGated(
      params({ ampAttack: 0.001, ampDecay: 0.01, ampSustain: 1.0, ampRelease: 2.0 }),
      [{ midi: 72 }],
      0.12, 0.25,
    );
    // Use only the tail window (last 0.25s) for the spectral probe.
    const tailWin = tail.subarray(tail.length - Math.floor(SR * 0.25));
    const playedHz = midiToHz(72); // ~523 Hz
    const peakPlayed = goertzel(tailWin, playedHz, SR);
    const peakC4 = goertzel(tailWin, C4_HZ, SR);
    expect(peakPlayed, 'tail has energy at the played pitch').toBeGreaterThan(1e-4);
    expect(peakPlayed / Math.max(peakC4, 1e-9), 'played-pitch ≫ C4 (bug pitch)').toBeGreaterThan(8);
  });

  it('EnvState export is consistent (engine wiring sanity)', () => {
    // Trivial guard that the shared engine module loaded cleanly under ART's
    // vitest config (it imports nothing from packages/web).
    expect(EnvState.Release).toBe(4);
  });
});
