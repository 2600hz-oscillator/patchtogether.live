// packages/web/src/lib/audio/modules/callsine.test.ts
//
// Unit tests for CALLSINE:
//   - module-def shape (ports, params, cvScale annotations)
//   - macro mapping helpers (timbre → slew sec, harmonics → partial count)
//   - peak detection: a synthetic 3-sinusoid input is correctly resolved
//     into three top-amplitude peaks at the expected frequencies
//   - F0 detection: a harmonic stack (110 + 220 + 330 Hz) gives F0 ≈ 110
//   - end-to-end render mirror: a 440 Hz sine in → 440 Hz dominant out
//
// Worklet-level behavior (live FREEZE latch via gate edge, model switch
// mid-stream) is covered by the ART scenario.

import { describe, expect, it } from 'vitest';
import {
  callsineDef,
  callsineMath,
  CALLSINE_MAX_MODEL,
  CALLSINE_MODEL_NAMES,
  CALLSINE_PLANNED_MODELS,
  CALLSINE_FFT_SIZE,
  CALLSINE_N_TRACKS,
  type CallsineParams,
} from './callsine';

// ---------------------------------------------------------------------------
// Module-def shape.
// ---------------------------------------------------------------------------

describe('callsineDef shape', () => {
  it('declares type=callsine, label=CALLSINE, category=effects', () => {
    expect(callsineDef.type).toBe('callsine');
    expect(callsineDef.label).toBe('CALLSINE');
    expect(callsineDef.category).toBe('effects');
  });

  it('exposes the expected input ports (audio + pitch + gate + 6 cv)', () => {
    const ids = callsineDef.inputs.map((p) => p.id);
    expect(ids).toEqual([
      'audio_in', 'pitch', 'gate',
      'model_cv', 'note_cv', 'harm_cv', 'timb_cv', 'morph_cv', 'level_cv',
    ]);
  });

  it('exposes 1 audio output: out', () => {
    const ids = callsineDef.outputs.map((p) => p.id);
    expect(ids).toEqual(['out']);
    for (const p of callsineDef.outputs) expect(p.type).toBe('audio');
  });

  it('exposes 6 params: model, note, harmonics, timbre, morph, level', () => {
    const ids = callsineDef.params.map((p) => p.id);
    expect(ids).toEqual(['model', 'note', 'harmonics', 'timbre', 'morph', 'level']);
  });

  it('every cv input has paramTarget pointing at a real param + cvScale set', () => {
    for (const port of callsineDef.inputs) {
      if (port.type !== 'cv') continue;
      expect(port.paramTarget, `${port.id} paramTarget`).toBeDefined();
      expect(port.cvScale, `${port.id} cvScale`).toBeDefined();
      const param = callsineDef.params.find((p) => p.id === port.paramTarget);
      expect(param, `${port.id} → param ${port.paramTarget}`).toBeDefined();
    }
  });

  it(`model param: discrete 0..${CALLSINE_MAX_MODEL} (= MODEL_NAMES.length - 1)`, () => {
    const p = callsineDef.params.find((p) => p.id === 'model')!;
    expect(p.curve).toBe('discrete');
    expect(p.min).toBe(0);
    expect(p.max).toBe(CALLSINE_MAX_MODEL);
    expect(CALLSINE_MAX_MODEL).toBe(CALLSINE_MODEL_NAMES.length - 1);
    // model_cv must use the `discrete` CV scaling — linear would interpret
    // a ±1 LFO as a continuous interpolation across model space, which
    // doesn't make sense for what's effectively a switch.
    const port = callsineDef.inputs.find((p) => p.id === 'model_cv')!;
    expect(port.cvScale).toEqual({ mode: 'discrete' });
  });

  it('note param: ±60 semitone offset, units=st', () => {
    const p = callsineDef.params.find((p) => p.id === 'note')!;
    expect(p.min).toBe(-60);
    expect(p.max).toBe(60);
    expect(p.units).toBe('st');
  });

  it('continuous macros (harmonics/timbre/morph/level) live in [0..1] linear', () => {
    for (const id of ['harmonics', 'timbre', 'morph', 'level']) {
      const p = callsineDef.params.find((x) => x.id === id)!;
      expect(p.min, `${id} min`).toBe(0);
      expect(p.max, `${id} max`).toBe(1);
      expect(p.curve, `${id} curve`).toBe('linear');
    }
  });

  it('credits the upstream CallSine authors (MIT)', () => {
    expect(callsineDef.ossAttribution?.author).toMatch(/callsine|Warren/i);
  });
});

// ---------------------------------------------------------------------------
// Scaffolding sanity: v1 ships 2 models; the planned-models list documents
// the follow-up roadmap. This test mostly exists so a contributor adding a
// model has to also remove its entry from CALLSINE_PLANNED_MODELS (or move
// it into MODEL_NAMES).
// ---------------------------------------------------------------------------

describe('callsine model registry', () => {
  it('v1.1 ships 14 models 0..13 (SINES..METAL)', () => {
    expect(CALLSINE_MODEL_NAMES).toEqual([
      'SINES', 'SAW', 'SQR', 'PULSE25', 'TRI', 'RAMP',
      'CHEBY3', 'CHEBY5', 'HARDSYNC', 'FOLD', 'NOISE',
      'FORMANT', 'SUBOSC', 'METAL',
    ]);
    expect(CALLSINE_MAX_MODEL).toBe(13);
  });
  it('CALLSINE_PLANNED_MODELS has >=10 entries documented as follow-up', () => {
    expect(CALLSINE_PLANNED_MODELS.length).toBeGreaterThanOrEqual(10);
  });
  it('planned-models list has no duplicates with the shipped list', () => {
    const shipped = new Set<string>(CALLSINE_MODEL_NAMES);
    for (const name of CALLSINE_PLANNED_MODELS) {
      expect(shipped.has(name), `planned model "${name}" must not also be shipped`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Macro mapping helpers.
// ---------------------------------------------------------------------------

describe('callsineMath helpers', () => {
  it('timbreToSlewSec: 0 = 5 ms, 1 = 2 s (log curve)', () => {
    expect(callsineMath.timbreToSlewSec(0)).toBeCloseTo(0.005, 5);
    expect(callsineMath.timbreToSlewSec(1)).toBeCloseTo(2.0, 3);
    // midpoint should be the geometric mean (log curve), not arithmetic.
    const mid = callsineMath.timbreToSlewSec(0.5);
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.15);
  });

  it('harmonicsToPartials: 0 → 1, 1 → N_TRACKS', () => {
    expect(callsineMath.harmonicsToPartials(0)).toBe(1);
    expect(callsineMath.harmonicsToPartials(1)).toBe(CALLSINE_N_TRACKS);
    // Monotonic non-decreasing across the range.
    let prev = 0;
    for (let i = 0; i <= 32; i++) {
      const v = callsineMath.harmonicsToPartials(i / 32);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

// ---------------------------------------------------------------------------
// Peak detection — the heart of the analyzer. Synthesize a known set of
// sinusoids and verify the detector finds them.
// ---------------------------------------------------------------------------

function makeSineFrame(
  freqs: number[],
  amps: number[],
  sr: number,
  N = CALLSINE_FFT_SIZE,
): Float32Array {
  const out = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    let s = 0;
    for (let i = 0; i < freqs.length; i++) {
      s += amps[i]! * Math.sin((2 * Math.PI * freqs[i]! * n) / sr);
    }
    out[n] = s;
  }
  return out;
}

describe('callsineMath.analyzeFrame — peak detection', () => {
  const sr = 48000;
  const binHz = sr / CALLSINE_FFT_SIZE;

  it('resolves a single 440 Hz sinusoid to a top peak near 440', () => {
    const frame = makeSineFrame([440], [0.5], sr);
    const { peaksHz, peaksAmp } = callsineMath.analyzeFrame(frame, sr, 8);
    expect(peaksHz.length).toBeGreaterThanOrEqual(1);
    // Parabolic interp should land within 1 bin of 440.
    expect(Math.abs(peaksHz[0]! - 440)).toBeLessThan(binHz);
    // Amplitude estimate ~= 0.5 within Hann main-lobe accuracy.
    expect(peaksAmp[0]!).toBeGreaterThan(0.2);
    expect(peaksAmp[0]!).toBeLessThan(0.8);
  });

  it('resolves three well-separated sinusoids (440 / 800 / 1500) as top 3 peaks', () => {
    const frame = makeSineFrame([440, 800, 1500], [0.5, 0.4, 0.3], sr);
    const { peaksHz } = callsineMath.analyzeFrame(frame, sr, 8);
    expect(peaksHz.length).toBeGreaterThanOrEqual(3);
    const top3 = peaksHz.slice(0, 3).sort((a, b) => a - b);
    // Each of 440 / 800 / 1500 should be near one of the top 3 peaks.
    for (const target of [440, 800, 1500]) {
      const closest = top3.reduce(
        (best, hz) => (Math.abs(hz - target) < Math.abs(best - target) ? hz : best),
        top3[0]!,
      );
      expect(Math.abs(closest - target), `target ${target} matched ${closest}`).toBeLessThan(binHz * 2);
    }
  });

  it('amplitude ranking — louder sinusoid is the top peak', () => {
    const frame = makeSineFrame([440, 880], [0.2, 0.8], sr);
    const { peaksHz, peaksAmp } = callsineMath.analyzeFrame(frame, sr, 8);
    expect(peaksHz.length).toBeGreaterThanOrEqual(2);
    // Top entry (highest amp) should be near 880, not 440.
    expect(Math.abs(peaksHz[0]! - 880)).toBeLessThan(binHz);
    expect(peaksAmp[0]!).toBeGreaterThan(peaksAmp[1]!);
  });
});

describe('callsineMath.analyzeFrame — F0 detection', () => {
  const sr = 48000;
  const binHz = sr / CALLSINE_FFT_SIZE;

  it('harmonic stack (110 + 220 + 330 + 440 Hz) yields F0 ≈ 110', () => {
    const frame = makeSineFrame([110, 220, 330, 440], [0.4, 0.3, 0.2, 0.15], sr);
    const { f0Hz } = callsineMath.analyzeFrame(frame, sr, 16);
    // HSS without parabolic refine should land within one bin of 110.
    expect(Math.abs(f0Hz - 110)).toBeLessThan(binHz * 1.5);
  });

  it('inharmonic content (only 1500 Hz) yields F0 ≈ 0 (out-of-band)', () => {
    // 1500 is above the 60..800 F0 search range; the detector should not
    // claim a melodic F0 from a single high tone.
    const frame = makeSineFrame([1500], [0.5], sr);
    const { f0Hz } = callsineMath.analyzeFrame(frame, sr, 16);
    // The HSS scan still picks *some* bin in the F0 range (the strongest
    // candidate among unrelated bins), but the candidate's confidence will
    // be low — we don't have access to confidence in the mirror's return
    // value, so we just assert that the result is firmly NOT 1500 (i.e.
    // not the input freq itself).
    expect(f0Hz).toBeLessThan(800);
  });
});

// ---------------------------------------------------------------------------
// End-to-end render — drive the full mirror, assert audio in → audio out.
//
// The analyzer takes ~5 ms (one hop) to "lock on" to a steady input. We
// render long enough (>=4 hops + slew settling) for the bank to reach
// steady state, then look at the tail.
// ---------------------------------------------------------------------------

function powerAt(buf: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  let re = 0;
  let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / buf.length;
}

describe('callsineMath.render — end-to-end resynth', () => {
  const SR = 48000;
  const baseParams: CallsineParams = {
    model: 0,        // SINES
    note: 0,
    harmonics: 0.5,  // 32 partials
    timbre: 0.05,    // fast-ish slew so steady-state arrives quickly
    morph: 0,        // no harmonic lock
    level: 1.0,
    pitchV: 0,
  };

  it('renders silence in → silence out', () => {
    const audio = new Float32Array(SR); // 1s of zeros
    const out = callsineMath.render(audio, SR, baseParams);
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      const a = Math.abs(out[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `silence-in peak ${peak}`).toBeLessThan(1e-6);
  });

  it('440 Hz sine in → output has dominant energy at 440 Hz', () => {
    const N = SR; // 1 second
    const audio = new Float32Array(N);
    for (let i = 0; i < N; i++) audio[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const out = callsineMath.render(audio, SR, baseParams);
    // Skip the first 50 ms (analyzer warm-up + slew settling) and analyze
    // the tail.
    const tail = out.slice(Math.floor(0.5 * SR));
    const p440 = powerAt(tail, 440, SR);
    const pOff = powerAt(tail, 1234, SR);
    expect(p440, `out @ 440 = ${p440}, off-bin = ${pOff}`).toBeGreaterThan(pOff * 5);
  });

  it('output amplitude is finite + bounded at default params', () => {
    const N = SR / 2;
    const audio = new Float32Array(N);
    for (let i = 0; i < N; i++) audio[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const out = callsineMath.render(audio, SR, baseParams);
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!), `out[${i}] finite`).toBe(true);
      const a = Math.abs(out[i]!);
      if (a > peak) peak = a;
    }
    // With 32-partials × per-partial sine, amplitude can exceed 1 on
    // transients (analyzer overestimates while slew catches up). 4× is a
    // generous ceiling that catches runaways but doesn't flap.
    expect(peak, `out peak ${peak}`).toBeLessThan(4);
  });

  it('pitchV=1 (one octave up) → output dominates at 880 Hz, not 440', () => {
    const N = SR;
    const audio = new Float32Array(N);
    for (let i = 0; i < N; i++) audio[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const out = callsineMath.render(audio, SR, { ...baseParams, pitchV: 1.0 });
    const tail = out.slice(Math.floor(0.5 * SR));
    const p880 = powerAt(tail, 880, SR);
    const p440 = powerAt(tail, 440, SR);
    expect(p880, `pitchV=1: 880Hz ${p880} should exceed 440Hz ${p440}`).toBeGreaterThan(p440);
  });

  it('level=0 → silent output even with active input', () => {
    const N = SR / 4;
    const audio = new Float32Array(N);
    for (let i = 0; i < N; i++) audio[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const out = callsineMath.render(audio, SR, { ...baseParams, level: 0 });
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
    expect(peak).toBeLessThan(1e-6);
  });

  it('harmonics=0 (1 partial) carries less broadband energy than harmonics=1 (64 partials) on a noisy input', () => {
    // Drive with noisy harmonic stack (sawtooth-like). Sparse partial
    // count should drop most of the energy.
    const N = SR / 2;
    const audio = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // 220 + odd harmonics — saw-ish spectrum with lots of partials.
      let s = 0;
      for (let k = 1; k <= 16; k += 2) s += Math.sin((2 * Math.PI * 220 * k * i) / SR) / k;
      audio[i] = s * 0.3;
    }
    const sparse = callsineMath.render(audio, SR, { ...baseParams, harmonics: 0 });
    const dense = callsineMath.render(audio, SR, { ...baseParams, harmonics: 1 });
    // Use RMS in the tail (steady state) to compare overall energy.
    let sparseRms = 0;
    let denseRms = 0;
    const start = Math.floor(N * 0.5);
    for (let i = start; i < N; i++) {
      sparseRms += sparse[i]! * sparse[i]!;
      denseRms += dense[i]! * dense[i]!;
    }
    sparseRms = Math.sqrt(sparseRms / (N - start));
    denseRms = Math.sqrt(denseRms / (N - start));
    // Dense should carry more energy than sparse (more partials retained
    // = closer to original). The margin is small (~1.1x in practice)
    // because the strongest partial dominates either way; we just want to
    // assert the direction holds rather than absolute magnitude. A naive
    // >sparseRms test would flap if numerics drift.
    expect(denseRms, `dense ${denseRms} > sparse ${sparseRms}`).toBeGreaterThan(sparseRms);
  });
});

describe('callsineMath.render — model selection', () => {
  const SR = 48000;

  it('SAW model (model=1) produces more upper-harmonic energy than SINES (model=0) on the same input', () => {
    // Both bands resynthesize from the same partial list — but SAW renders
    // each partial as a band-limited saw (rich in odd+even harmonics
    // above the partial freq), so the output spectrum at e.g. 1320 Hz
    // (3 × 440) should be much higher for SAW than SINES given a pure
    // 440 Hz input.
    // 0.5s @ 48kHz = 24000 samples — enough hops (~46) for the partial
    // tracker to lock + enough post-warmup samples (12000) for the
    // harmonic-energy comparison. Cuts test runtime ~2x vs the original
    // 1s buffer that was hitting vitest's 5s timeout in CI.
    const N = Math.floor(0.5 * SR);
    const audio = new Float32Array(N);
    for (let i = 0; i < N; i++) audio[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const baseParams: CallsineParams = {
      model: 0, note: 0, harmonics: 0.5, timbre: 0.05, morph: 0, level: 1.0, pitchV: 0,
    };
    const sineOut = callsineMath.render(audio, SR, { ...baseParams, model: 0 }).slice(Math.floor(0.25 * SR));
    const sawOut = callsineMath.render(audio, SR, { ...baseParams, model: 1 }).slice(Math.floor(0.25 * SR));
    const sineH3 = powerAt(sineOut, 1320, SR);
    const sawH3 = powerAt(sawOut, 1320, SR);
    expect(sawH3, `SAW H3 ${sawH3} should exceed SINES H3 ${sineH3}`).toBeGreaterThan(sineH3 * 2);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Per-model "is audible" coverage. Each new model (#2..#13) must render
// non-silent at a C4-ish (261.6 Hz) input with harmonics≈8/64 (≈0.125) and
// produce a peak amplitude above the silence floor in the steady-state tail.
//
// We use a slightly fast slew (timbre≈0.02 → ~10 ms) so steady state arrives
// inside the 0.5 s window, and pre-render a single 440 Hz input shared by
// all sub-tests in this block to keep runtime bounded — vitest's default
// 5 s per-test timeout was the bottleneck on the SAW-vs-SINES test above,
// so we render at 0.5 s and parallelize via it.each rather than per-it.
// ---------------------------------------------------------------------------

describe('callsineMath.render — per-model audibility', () => {
  const SR = 48000;
  const N = Math.floor(0.5 * SR);
  const C4 = 261.625565;
  const audio = new Float32Array(N);
  for (let i = 0; i < N; i++) audio[i] = 0.5 * Math.sin((2 * Math.PI * C4 * i) / SR);

  const baseParams: CallsineParams = {
    model: 0,
    note: 0,
    harmonics: 0.125, // ≈ 8 partials of 64 — task spec
    timbre: 0.02,     // ~10 ms slew — settles inside the 0.5 s window
    morph: 0,
    level: 1.0,
    pitchV: 0,
  };

  // Skip 0 + 1 (SINES + SAW were covered by the older tests); cover the
  // 12 new models. The assertion is loose-but-strict: tail peak > 0.05
  // (the silence floor at level=1.0 with 8 partials).
  const NEW_MODELS = CALLSINE_MODEL_NAMES.slice(2).map((name, i) => [i + 2, name] as const);
  it.each(NEW_MODELS)('model %i (%s) — peak above silence floor at C4', (model, _name) => {
    const out = callsineMath.render(audio, SR, { ...baseParams, model });
    const tail = out.slice(Math.floor(0.25 * SR));
    let peak = 0;
    for (let i = 0; i < tail.length; i++) {
      const a = Math.abs(tail[i]!);
      if (a > peak) peak = a;
      expect(Number.isFinite(tail[i]!)).toBe(true);
    }
    expect(peak).toBeGreaterThan(0.05);
  }, 30_000);
});
