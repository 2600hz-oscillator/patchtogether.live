// packages/dsp/src/lib/pentemelodica-dsp.test.ts
//
// Pure-DSP unit tests for the PENTEMELODICA core (5-voice poly synth math).
// Pins the building blocks the worklet + render mirror share:
//   • voiceFreqHz   — V/oct + coarse + fine + exp-FM → Hz, C4 anchor, clamps.
//   • waveMorph     — tri→saw→square endpoints match the band-limited taps.
//   • modeMorph     — LP→BP→HP→Notch corners pick the right tap.
//   • Envelope      — ADSR attack reaches 1, sustain holds, release → 0.
//   • renderPentemelodica — poly→5 voices (5 gated lanes → 5 nonzero taps),
//     a chord differs from a single note, a mono fallback (lane 0 only) is
//     byte-identical whether or not the other lanes carry pitch but no gate,
//     wet/dry=0 is exactly the dry mix, and the pan law is equal-power.

import { describe, it, expect } from 'vitest';
import { moogWaves, MOOG_C4_HZ } from './moog-vco-dsp';
import { makeSvfState, svfStep, cutoffToG, resToK } from './resofilter-dsp';
import {
  PENTE_VOICES,
  Envelope,
  EnvState,
  voiceFreqHz,
  waveMorph,
  modeMorph,
  makePenteState,
  makeRenderOut,
  renderPentemelodica,
  PENTE_MASTER_GAIN,
  type PenteVoiceParams,
  type PenteFilterParams,
  type PenteParams,
} from './pentemelodica-dsp';

const SR = 48000;

function defVoice(over: Partial<PenteVoiceParams> = {}): PenteVoiceParams {
  return {
    tune: 0, fine: 0, fm: 0, pm: 0, pw: 0.5, wave: 0,
    attack: 0.005, decay: 0.1, sustain: 0.7, release: 0.2, level: 0.8, pan: 0,
    ...over,
  };
}
function defFilter(over: Partial<PenteFilterParams> = {}): PenteFilterParams {
  return { cutoff: 1000, resonance: 0.2, mode: 0, wetdry: 1, ...over };
}
function defParams(over: Partial<PenteVoiceParams>[] = []): PenteParams {
  return {
    voices: Array.from({ length: PENTE_VOICES }, (_, i) => defVoice(over[i] ?? {})),
    filter: defFilter(),
  };
}

describe('pentemelodica-dsp / voiceFreqHz', () => {
  it('0 V/oct, no tune/fine/fm = C4', () => {
    expect(voiceFreqHz(0, 0, 0, 0, SR)).toBeCloseTo(MOOG_C4_HZ, 3);
  });
  it('+1 V/oct doubles the frequency', () => {
    expect(voiceFreqHz(1, 0, 0, 0, SR)).toBeCloseTo(MOOG_C4_HZ * 2, 2);
  });
  it('+12 semitones coarse tune = one octave up', () => {
    expect(voiceFreqHz(0, 12, 0, 0, SR)).toBeCloseTo(MOOG_C4_HZ * 2, 2);
  });
  it('+1200 cents fine = one octave up', () => {
    expect(voiceFreqHz(0, 0, 1200, 0, SR)).toBeCloseTo(MOOG_C4_HZ * 2, 2);
  });
  it('exp-FM term shifts the exponent in octaves', () => {
    // fmExp = +1 → one octave up.
    expect(voiceFreqHz(0, 0, 0, 1, SR)).toBeCloseTo(MOOG_C4_HZ * 2, 2);
  });
  it('clamps to a safe sub-Nyquist span', () => {
    expect(voiceFreqHz(20, 0, 0, 0, SR)).toBeLessThanOrEqual(SR * 0.49);
    expect(voiceFreqHz(-50, 0, 0, 0, SR)).toBeGreaterThanOrEqual(0.01);
  });
});

describe('pentemelodica-dsp / waveMorph', () => {
  const dt = 1 / 4096; // tiny dt → negligible band-limiting residual
  const phase = 0.123;
  const pw = 0.5;
  const w = moogWaves(phase, dt, pw);

  it('wave=0 is the triangle tap', () => {
    expect(waveMorph(w, 0)).toBeCloseTo(w.triangle, 6);
  });
  it('wave=0.5 is the sawtooth tap', () => {
    expect(waveMorph(w, 0.5)).toBeCloseTo(w.sawtooth, 6);
  });
  it('wave=1.0 is the rectangular tap (at pw)', () => {
    expect(waveMorph(w, 1)).toBeCloseTo(w.rectangular, 6);
  });
  it('clamps out-of-range wave to [0,1]', () => {
    expect(waveMorph(w, -2)).toBeCloseTo(w.triangle, 6);
    expect(waveMorph(w, 5)).toBeCloseTo(w.rectangular, 6);
  });
});

describe('pentemelodica-dsp / modeMorph', () => {
  // Use a real SVF tick so lp/bp/hp are self-consistent.
  const st = makeSvfState();
  const g = cutoffToG(1000, SR);
  const k = resToK(0.2);
  const x = 0.7;
  const taps = svfStep(x, g, k, st);
  const notch = x - taps.bp;

  it('mode=0 → LP tap', () => {
    expect(modeMorph(taps, x, 0)).toBeCloseTo(taps.lp, 6);
  });
  it('mode=1/3 → BP tap', () => {
    expect(modeMorph(taps, x, 1 / 3)).toBeCloseTo(taps.bp, 6);
  });
  it('mode=2/3 → HP tap', () => {
    expect(modeMorph(taps, x, 2 / 3)).toBeCloseTo(taps.hp, 6);
  });
  it('mode=1.0 → Notch (x - bp)', () => {
    expect(modeMorph(taps, x, 1)).toBeCloseTo(notch, 6);
  });
});

describe('pentemelodica-dsp / Envelope', () => {
  it('attack reaches 1, sustain holds, release → 0', () => {
    const e = new Envelope();
    e.trigger(true);
    // Attack 5 ms then 100 ms decay toward sustain 0.7.
    let v = 0;
    for (let i = 0; i < SR; i++) v = e.tick(0.005, 0.1, 0.7, 0.2, SR);
    // Held at sustain.
    expect(e.state).toBe(EnvState.Sustain);
    expect(v).toBeCloseTo(0.7, 2);
    // Peak was reached during attack.
    const e2 = new Envelope();
    e2.trigger(true);
    let peak = 0;
    for (let i = 0; i < SR * 0.02; i++) peak = Math.max(peak, e2.tick(0.005, 0.1, 0.7, 0.2, SR));
    expect(peak).toBeCloseTo(1, 2);
    // Release decays to 0 (run well past the 0.2 s time-constant — the
    // envelope latches to exactly 0 / Idle once it drops below 1e-5).
    e.trigger(false);
    for (let i = 0; i < SR * 3; i++) v = e.tick(0.005, 0.1, 0.7, 0.2, SR);
    expect(v).toBe(0);
    expect(e.state).toBe(EnvState.Idle);
  });
  it('idle envelope ignores a release with no prior attack', () => {
    const e = new Envelope();
    e.trigger(false);
    expect(e.state).toBe(EnvState.Idle);
    expect(e.tick(0.005, 0.1, 0.7, 0.2, SR)).toBe(0);
  });
});

// Build a poly bus [pitch0,gate0,…] from per-lane (voct, gated) tuples.
function polyBus(lanes: Array<{ voct: number; gate: boolean }>): number[] {
  const bus = new Array(PENTE_VOICES * 2).fill(0);
  for (let i = 0; i < Math.min(lanes.length, PENTE_VOICES); i++) {
    bus[i * 2] = lanes[i]!.voct;
    bus[i * 2 + 1] = lanes[i]!.gate ? 1 : 0;
  }
  return bus;
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / a.length);
}

describe('pentemelodica-dsp / renderPentemelodica', () => {
  const N = 4096;

  it('5 gated lanes → 5 nonzero pre-mixer voice taps', () => {
    const params = defParams();
    // Detune each voice so they are distinct.
    params.voices.forEach((v, i) => { v.tune = i * 3; });
    const bus = polyBus([
      { voct: 0, gate: true },
      { voct: 0, gate: true },
      { voct: 0, gate: true },
      { voct: 0, gate: true },
      { voct: 0, gate: true },
    ]);
    const st = makePenteState();
    const out = makeRenderOut(N);
    renderPentemelodica(params, bus, new Array(PENTE_VOICES).fill(0), N, SR, st, out);
    for (let v = 0; v < PENTE_VOICES; v++) {
      expect(rms(out.voices[v]!), `voice ${v} should be audible`).toBeGreaterThan(1e-3);
    }
    expect(rms(out.outL)).toBeGreaterThan(1e-3);
    expect(rms(out.outR)).toBeGreaterThan(1e-3);
  });

  it('a chord differs from a single note', () => {
    const single = polyBus([{ voct: 0, gate: true }]);
    const chord = polyBus([
      { voct: 0, gate: true },        // C4
      { voct: 4 / 12, gate: true },   // E4
      { voct: 7 / 12, gate: true },   // G4
    ]);
    const outSingle = makeRenderOut(N);
    const outChord = makeRenderOut(N);
    renderPentemelodica(defParams(), single, new Array(PENTE_VOICES).fill(0), N, SR, makePenteState(), outSingle);
    renderPentemelodica(defParams(), chord, new Array(PENTE_VOICES).fill(0), N, SR, makePenteState(), outChord);
    // The summed output must differ; a chord has higher energy + a different
    // waveform than a single note.
    let maxDiff = 0;
    for (let i = 0; i < N; i++) maxDiff = Math.max(maxDiff, Math.abs(outChord.outL[i]! - outSingle.outL[i]!));
    expect(maxDiff).toBeGreaterThan(1e-3);
    expect(rms(outChord.outL)).toBeGreaterThan(rms(outSingle.outL));
  });

  it('mono fallback: an ungated lane carrying pitch is byte-identical to a zero lane', () => {
    // Only lane 0 gated. Lanes 1..4 ungated — whether they carry pitch or 0,
    // the output must be identical (gate, not pitch, decides whether a voice
    // sounds).
    const busZeroPitch = polyBus([{ voct: 0, gate: true }]);
    const busJunkPitch = polyBus([
      { voct: 0, gate: true },
      { voct: 1, gate: false },
      { voct: -2, gate: false },
      { voct: 0.5, gate: false },
      { voct: 2, gate: false },
    ]);
    const outA = makeRenderOut(N);
    const outB = makeRenderOut(N);
    renderPentemelodica(defParams(), busZeroPitch, new Array(PENTE_VOICES).fill(0), N, SR, makePenteState(), outA);
    renderPentemelodica(defParams(), busJunkPitch, new Array(PENTE_VOICES).fill(0), N, SR, makePenteState(), outB);
    for (let i = 0; i < N; i++) {
      expect(outB.outL[i]).toBe(outA.outL[i]);
      expect(outB.outR[i]).toBe(outA.outR[i]);
    }
  });

  it('wet/dry=0 is exactly the dry mix (filter fully bypassed)', () => {
    const bus = polyBus([{ voct: 0, gate: true }, { voct: 7 / 12, gate: true }]);
    // wetdry=1 (full filter) vs wetdry=0 (bypass), same gate.
    const dryParams = defParams();
    dryParams.filter.wetdry = 0;
    dryParams.filter.cutoff = 300; // a cutoff that visibly filters → proves bypass
    const outDry = makeRenderOut(N);
    renderPentemelodica(dryParams, bus, new Array(PENTE_VOICES).fill(0), N, SR, makePenteState(), outDry);

    // Reconstruct the expected dry mix independently: render with wetdry=0 is
    // the pre-filter sum × master gain. We verify by summing the per-voice
    // taps with the pan/level law.
    for (let i = 0; i < N; i++) {
      let sumL = 0, sumR = 0;
      for (let v = 0; v < PENTE_VOICES; v++) {
        const vp = dryParams.voices[v]!;
        const theta = (vp.pan + 1) * (Math.PI / 4);
        const g = outDry.voices[v]![i]! * vp.level;
        sumL += g * Math.cos(theta);
        sumR += g * Math.sin(theta);
      }
      sumL *= PENTE_MASTER_GAIN;
      sumR *= PENTE_MASTER_GAIN;
      expect(outDry.outL[i]).toBeCloseTo(sumL, 5);
      expect(outDry.outR[i]).toBeCloseTo(sumR, 5);
    }
  });

  it('pan law is equal-power: pan=-1 → all L, pan=+1 → all R, pan=0 → equal', () => {
    const N2 = 2048;
    function panOut(pan: number): { l: number; r: number } {
      const params = defParams([{ pan }]);
      // Only voice 0 gated.
      const bus = polyBus([{ voct: 0, gate: true }]);
      const out = makeRenderOut(N2);
      renderPentemelodica(params, bus, new Array(PENTE_VOICES).fill(0), N2, SR, makePenteState(), out);
      return { l: rms(out.outL), r: rms(out.outR) };
    }
    const left = panOut(-1);
    expect(left.r).toBeLessThan(1e-5);
    expect(left.l).toBeGreaterThan(1e-3);

    const right = panOut(1);
    expect(right.l).toBeLessThan(1e-5);
    expect(right.r).toBeGreaterThan(1e-3);

    const center = panOut(0);
    expect(center.l).toBeCloseTo(center.r, 4);
  });
});
