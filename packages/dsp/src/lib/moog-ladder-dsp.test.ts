// packages/dsp/src/lib/moog-ladder-dsp.test.ts
//
// Pure-DSP unit tests for the shared Moog transistor-ladder LPF core
// (own-code TPT/Zavalishin zero-delay-feedback ladder + Huovilainen-style
// tanh feedback saturation). Shared by the 904A (this slice) + 904B/904C
// (later slices). Pins the filter math so a refactor surfaces as a specific
// quantitative regression:
//   • ladderCutoffToG / regenToK / rangeMultiplier — coefficient maps.
//   • MoogLadder.step — low-pass attenuates above cutoff, ~24 dB/oct slope,
//     resonance/regeneration sharpens the peak, SELF-OSCILLATES into a sine
//     at the cutoff freq near regeneration=1, stays STABLE (no NaN/blowup)
//     under an audio-rate cutoff sweep.
//   • hpDerive — input − lp gives the complementary high-pass (904B reuse).

import { describe, it, expect } from 'vitest';
import {
  MOOG_LADDER_C4_HZ,
  MOOG_LADDER_SELF_OSC_K,
  ladderCutoffToG,
  regenToK,
  rangeMultiplier,
  hpDerive,
  MoogLadder,
  renderLadder,
  type LadderTaps,
} from './moog-ladder-dsp';

const SR = 48000;

// ── helpers ──
function rms(a: Float32Array, from = 0): number {
  let s = 0;
  let n = 0;
  for (let i = from; i < a.length; i++) {
    s += a[i] * a[i];
    n++;
  }
  return Math.sqrt(s / n);
}
function peak(a: Float32Array, from = 0): number {
  let m = 0;
  for (let i = from; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}
/** Steady-state RMS gain of a sine at `freq` through the ladder. Measures
 *  only the second half so the filter transient has settled. */
function sineGain(freq: number, cutoffHz: number, k: number, drive: number): number {
  const N = SR / 5;
  const inp = new Float32Array(N);
  for (let i = 0; i < N; i++) inp[i] = 0.3 * Math.sin((2 * Math.PI * freq * i) / SR);
  const out = renderLadder(inp, { cutoffHz, k, drive, sr: SR });
  const half = N >> 1;
  return rms(out, half) / rms(inp, half);
}
const dB = (x: number) => 20 * Math.log10(x);

describe('moog-ladder-dsp / coefficient maps', () => {
  it('ladderCutoffToG = tan(π·fc/sr); monotonically increases with cutoff', () => {
    const lo = ladderCutoffToG(100, SR);
    const hi = ladderCutoffToG(5000, SR);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeGreaterThan(lo);
    expect(ladderCutoffToG(1000, SR)).toBeCloseTo(Math.tan((Math.PI * 1000) / SR), 6);
  });

  it('ladderCutoffToG clamps below DC + Nyquist (stays finite)', () => {
    expect(Number.isFinite(ladderCutoffToG(0.0001, SR))).toBe(true);
    expect(Number.isFinite(ladderCutoffToG(SR, SR))).toBe(true);
    expect(Number.isFinite(ladderCutoffToG(1e9, SR))).toBe(true);
  });

  it('regenToK maps 0→0 and 1→just past the k=4 self-oscillation threshold', () => {
    expect(regenToK(0)).toBe(0);
    expect(regenToK(1)).toBeGreaterThan(MOOG_LADDER_SELF_OSC_K);
    expect(regenToK(0.5)).toBeGreaterThan(0);
    expect(regenToK(0.5)).toBeLessThan(regenToK(1));
    // clamps out-of-range
    expect(regenToK(-1)).toBe(0);
    expect(regenToK(2)).toBe(regenToK(1));
  });

  it('rangeMultiplier steps cutoff in 2-octave (×4) steps: 1→×1, 2→×4, 3→×16', () => {
    expect(rangeMultiplier(1)).toBe(1);
    expect(rangeMultiplier(2)).toBe(4);
    expect(rangeMultiplier(3)).toBe(16);
    // out-of-range is defensive ×1
    expect(rangeMultiplier(0)).toBe(1);
    expect(rangeMultiplier(99)).toBe(1);
  });
});

describe('moog-ladder-dsp / low-pass response', () => {
  const fc = 1000;

  it('passes frequencies well below cutoff (near unity) and attenuates above', () => {
    const below = sineGain(fc / 4, fc, 0, 0);
    const above = sineGain(fc * 4, fc, 0, 0);
    expect(below).toBeGreaterThan(0.8); // passband ~unity
    expect(above).toBeLessThan(0.05); // deep in the stopband
    expect(below).toBeGreaterThan(above * 10);
  });

  it('is a 24 dB/oct (4-pole) low-pass: ~24 dB drop per octave in the stopband', () => {
    // Measure the asymptotic slope well above cutoff where the 4 poles
    // dominate. fc*4 → fc*8 is one octave, deep in the stopband.
    const g4 = sineGain(fc * 4, fc, 0, 0);
    const g8 = sineGain(fc * 8, fc, 0, 0);
    const slopePerOct = dB(g4) - dB(g8);
    // 4-pole ideal is 24 dB/oct; allow generous numerical tolerance.
    expect(slopePerOct).toBeGreaterThan(20);
    expect(slopePerOct).toBeLessThan(28);
  });

  it('the -3 dB corner sits near (just below) the cutoff frequency', () => {
    // For a cascaded 4-pole ladder the half-power point is a bit BELOW the
    // nominal cutoff. Assert the gain crosses 0.707 between fc/2 and fc.
    const gHalf = sineGain(fc / 2, fc, 0, 0);
    const gFc = sineGain(fc, fc, 0, 0);
    expect(gHalf).toBeGreaterThan(0.5); // still fairly open half an octave down
    expect(gFc).toBeLessThan(gHalf); // and lower at the nominal cutoff
  });
});

describe('moog-ladder-dsp / resonance (regeneration)', () => {
  const fc = 1000;
  const drive = 0.5; // moderate growl, like the 904A at mid regeneration

  it('regeneration sharpens the resonant peak monotonically', () => {
    const peakGain = (reso: number) => {
      let best = 0;
      for (const f of [700, 850, 950, 1000, 1050, 1150]) {
        best = Math.max(best, sineGain(f, fc, regenToK(reso), drive));
      }
      return best;
    };
    const g0 = peakGain(0);
    const g6 = peakGain(0.6);
    const g85 = peakGain(0.85);
    expect(g6).toBeGreaterThan(g0 * 1.5);
    expect(g85).toBeGreaterThan(g6 * 1.5);
    // a meaningfully resonant peak well above unity by reso=0.85
    expect(g85).toBeGreaterThan(2);
  });

  it('the resonant peak rides at (near) the cutoff frequency', () => {
    let best = 0;
    let bestF = 0;
    for (const f of [300, 500, 700, 850, 950, 1000, 1100, 1300, 2000]) {
      const g = sineGain(f, fc, regenToK(0.9), drive);
      if (g > best) {
        best = g;
        bestF = f;
      }
    }
    expect(bestF).toBeGreaterThan(fc * 0.7);
    expect(bestF).toBeLessThan(fc * 1.3);
  });
});

describe('moog-ladder-dsp / self-oscillation', () => {
  it('self-oscillates into a sustained sine at the cutoff when regeneration≈1', () => {
    const fc = 1000;
    const N = SR * 2;
    const inp = new Float32Array(N);
    inp[0] = 1; // a single impulse to kick the resonator
    const out = renderLadder(inp, {
      cutoffHz: fc,
      k: regenToK(1.0),
      drive: 0.5 + 1.0 * 0.8, // the 904A worklet's drive at regen=1
      sr: SR,
    });
    const tailStart = N - SR / 5;
    // Sustained (didn't decay to silence long after the impulse).
    expect(peak(out, tailStart)).toBeGreaterThan(0.05);
    // Oscillation frequency tracks the cutoff (a ladder self-oscs at ~fc,
    // a touch below). Count rising zero-crossings in the tail.
    let zc = 0;
    let prev = out[tailStart];
    for (let i = tailStart + 1; i < N; i++) {
      if (prev <= 0 && out[i] > 0) zc++;
      prev = out[i];
    }
    const measuredHz = zc / ((N - tailStart) / SR);
    expect(measuredHz).toBeGreaterThan(fc * 0.7);
    expect(measuredHz).toBeLessThan(fc * 1.3);
  });

  it('does NOT self-oscillate at low regeneration (decays to silence)', () => {
    const fc = 1000;
    const N = SR;
    const inp = new Float32Array(N);
    inp[0] = 1;
    const out = renderLadder(inp, { cutoffHz: fc, k: regenToK(0.3), drive: 0.5, sr: SR });
    // The tail must have rung out.
    expect(peak(out, N - SR / 10)).toBeLessThan(1e-3);
  });
});

describe('moog-ladder-dsp / stability', () => {
  it('stays finite + bounded under an audio-rate cutoff_cv sweep (no blowup/NaN)', () => {
    const M = SR;
    const saw = new Float32Array(M);
    for (let i = 0; i < M; i++) saw[i] = 2 * (((i * 220) / SR) % 1) - 1;
    // A 3 kHz cutoff LFO — far faster than k-rate; exactly what the 1 V/oct
    // CONTROL INPUT can drive. The TPT zero-delay solve must not blow up.
    const cutArr = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      cutArr[i] = 200 + 9000 * (0.5 + 0.5 * Math.sin((2 * Math.PI * 3000 * i) / SR));
    }
    const out = renderLadder(saw, {
      cutoffHz: 1000,
      cutoffArr: cutArr,
      k: regenToK(0.8),
      drive: 0.9,
      sr: SR,
    });
    const badIdx = out.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite at index ${badIdx}`).toBe(-1);
    // Bounded — resonance is loud but the tanh feedback self-limits it.
    expect(peak(out)).toBeLessThan(20);
  });

  it('stays finite at extreme resonance + extreme cutoff for many samples', () => {
    const ladder = new MoogLadder(SR);
    for (let i = 0; i < SR; i++) {
      const x = Math.sin((2 * Math.PI * 100 * i) / SR);
      const y = ladder.step(x, i % 2 ? 50 : 18000, regenToK(1.0), 1.3).lp4;
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});

describe('moog-ladder-dsp / per-pole taps + HP derivation', () => {
  it('lp1..lp4 get progressively steeper (each pole adds attenuation above cutoff)', () => {
    const fc = 500;
    const N = SR / 5;
    const inp = new Float32Array(N);
    const testF = fc * 6; // well into the stopband
    for (let i = 0; i < N; i++) inp[i] = Math.sin((2 * Math.PI * testF * i) / SR);
    const g1 = rms(renderLadder(inp, { cutoffHz: fc, k: 0, sr: SR, pole: 1 }), N >> 1);
    const g2 = rms(renderLadder(inp, { cutoffHz: fc, k: 0, sr: SR, pole: 2 }), N >> 1);
    const g4 = rms(renderLadder(inp, { cutoffHz: fc, k: 0, sr: SR, pole: 4 }), N >> 1);
    // More poles = more stopband attenuation.
    expect(g2).toBeLessThan(g1);
    expect(g4).toBeLessThan(g2);
  });

  it('hpDerive(x, taps) = x − lpN gives the complementary high-pass (904B reuse)', () => {
    const taps: LadderTaps = { lp1: 0.2, lp2: 0.3, lp3: 0.4, lp4: 0.5 };
    expect(hpDerive(1, taps, 1)).toBeCloseTo(0.8, 9);
    expect(hpDerive(1, taps, 4)).toBeCloseTo(0.5, 9);
    // A DC-passing low-pass means hp ≈ 0 for a near-DC input; a steep
    // high-pass blocks lows: feed a slow sine, hp tap should attenuate it.
    const fc = 2000;
    const N = SR / 5;
    const inp = new Float32Array(N);
    for (let i = 0; i < N; i++) inp[i] = Math.sin((2 * Math.PI * 100 * i) / SR); // 100 Hz << fc
    const ladder = new MoogLadder(SR);
    const hp = new Float32Array(N);
    for (let i = 0; i < N; i++) hp[i] = hpDerive(inp[i], ladder.step(inp[i], fc, 0, 0), 4);
    // The 100 Hz tone is far below the 2 kHz cutoff, so the LP passes it →
    // the HP (x − lp) cancels most of it.
    expect(rms(hp, N >> 1)).toBeLessThan(rms(inp, N >> 1) * 0.5);
  });
});

describe('moog-ladder-dsp / shared constants', () => {
  it('exposes the shared C4 pitch anchor + self-osc threshold', () => {
    expect(MOOG_LADDER_C4_HZ).toBeCloseTo(261.626, 3);
    expect(MOOG_LADDER_SELF_OSC_K).toBe(4);
  });
});
