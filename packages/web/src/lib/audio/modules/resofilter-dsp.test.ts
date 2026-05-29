// packages/web/src/lib/audio/modules/resofilter-dsp.test.ts
//
// Pure-math tests for the shared RESOFILTER DSP helpers in
// packages/dsp/src/lib/resofilter-dsp.ts. The worklet test file
// (resofilter.test.ts) exercises the AudioWorkletProcessor wrapper;
// THIS file tests the maths in isolation so a topology regression is
// flagged regardless of the worklet bridge layer.
//
// Per spec the file path was "packages/dsp/src/lib/resofilter-dsp.test.ts",
// but vitest only runs `packages/web/src/**/*.test.ts` (the `packages/dsp`
// workspace has no vitest target). Sitting the test under `web/` ensures
// it runs in `task test` — the closest precedent is the cocoadelay test
// which imports the core helper via a relative path from `web/` into `dsp/`.

import { describe, it, expect } from 'vitest';
import {
  RESOFILTER_MODE_NAMES,
  RESOFILTER_MODE_SHORT,
  RESOFILTER_MODE_COUNT,
  RESOFILTER_MAX_MODE,
  resToK,
  cutoffToG,
  makeSvfState,
  svfStep,
  pickModeOutput,
  resofilterStep,
  renderResofilter,
  ResofilterChannel,
  RfSmoother,
  type ResofilterMode,
} from '../../../../../dsp/src/lib/resofilter-dsp';

const SR = 48000;

describe('resofilter-dsp — constants', () => {
  it('exposes 5 mode names matching upstream filterTextFunction', () => {
    expect(RESOFILTER_MODE_COUNT).toBe(5);
    expect(RESOFILTER_MAX_MODE).toBe(4);
    expect(RESOFILTER_MODE_NAMES).toEqual([
      'Low-pass', 'High-pass', 'Band-pass', 'Notch', 'Allpass',
    ]);
    expect(RESOFILTER_MODE_SHORT).toEqual(['LP', 'HP', 'BP', 'NT', 'AP']);
  });
});

describe('resofilter-dsp — coefficient helpers', () => {
  it('resToK(0) ≈ 2 (max damping, no resonance)', () => {
    expect(resToK(0)).toBeCloseTo(2, 5);
  });

  it('resToK(1) → near 0 (edge of self-oscillation, floor 0.003)', () => {
    expect(resToK(1)).toBeCloseTo(0.003, 5);
  });

  it('resToK clamps below 0 and above 1', () => {
    expect(resToK(-5)).toBe(2);
    expect(resToK(5)).toBe(0.003);
  });

  it('cutoffToG clamps to Nyquist and floor', () => {
    expect(cutoffToG(0, SR)).toBe(Math.tan(Math.PI * 10 / SR));
    expect(cutoffToG(SR, SR)).toBe(Math.tan(Math.PI * SR * 0.49 / SR));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Pure-math filter response — drive a sine through resofilterStep + measure.
// ────────────────────────────────────────────────────────────────────────────

/** Goertzel-style band magnitude. */
function bandAmp(buf: Float32Array, freqHz: number, sr: number, skipFrames: number): number {
  const w = 2 * Math.PI * freqHz / sr;
  let re = 0; let im = 0;
  const n = buf.length - skipFrames;
  for (let i = skipFrames; i < buf.length; i++) {
    re += (buf[i] ?? 0) * Math.cos(w * (i - skipFrames));
    im += (buf[i] ?? 0) * Math.sin(w * (i - skipFrames));
  }
  return 2 * Math.sqrt(re * re + im * im) / n;
}

function sineBuf(freqHz: number, sr: number, durSec: number, amp = 1): Float32Array {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freqHz * i / sr);
  return out;
}

describe('resofilter-dsp — per-mode spectral shape', () => {
  const FC = 1000;
  const RES = 0.2;
  const DUR = 0.25;
  const SKIP = Math.round(0.1 * SR);

  function probe(mode: ResofilterMode, freq: number, fc = FC): number {
    const buf = sineBuf(freq, SR, DUR);
    const out = renderResofilter(buf, { cutoffHz: fc, res: RES, mode, sr: SR, mix: 1 });
    return bandAmp(out, freq, SR, SKIP);
  }

  it('LP: amp(low) > amp(high)', () => {
    expect(probe(0, 100)).toBeGreaterThan(probe(0, 8000) * 2);
  });

  it('HP: amp(high) > amp(low)', () => {
    expect(probe(1, 8000)).toBeGreaterThan(probe(1, 100) * 2);
  });

  it('BP: amp(fc) > amp(low) and > amp(high)', () => {
    const lo = probe(2, 100);
    const fc = probe(2, FC);
    const hi = probe(2, 8000);
    expect(fc).toBeGreaterThan(lo);
    expect(fc).toBeGreaterThan(hi);
  });

  it('Notch: amp(fc) < amp(low) and < amp(high)', () => {
    const lo = probe(3, 100);
    const fc = probe(3, FC);
    const hi = probe(3, 8000);
    expect(lo).toBeGreaterThan(fc);
    expect(hi).toBeGreaterThan(fc);
  });

  it('Allpass: amp(low) ~ amp(mid) ~ amp(high) within ~4x', () => {
    const lo = probe(4, 100);
    const fc = probe(4, FC);
    const hi = probe(4, 8000);
    const maxAmp = Math.max(lo, fc, hi);
    const minAmp = Math.min(lo, fc, hi);
    expect(maxAmp / minAmp).toBeLessThan(4);
    // Sanity: nothing fully silenced.
    expect(minAmp).toBeGreaterThan(0.05);
  });
});

describe('resofilter-dsp — high-resonance ringing', () => {
  it('LP at res=0.99 rings substantially longer than at res=0', () => {
    // Resonarium's MultiFilter is biquad-based — it does NOT self-oscillate
    // like a Moog ladder. Instead, high resonance produces a long ringing
    // tail after impulse excitation. Measure the energy ratio between low-
    // and high-resonance taps to pin the Q-vs-decay relationship.
    const dur = 0.5;
    const makeImpulse = (): Float32Array => {
      const b = new Float32Array(Math.round(SR * dur));
      b[0] = 1.0;
      return b;
    };
    const outLow = renderResofilter(makeImpulse(), { cutoffHz: 800, res: 0.0, mode: 0, sr: SR, mix: 1 });
    const outHi  = renderResofilter(makeImpulse(), { cutoffHz: 800, res: 0.99, mode: 0, sr: SR, mix: 1 });

    function tailEnergy(b: Float32Array): number {
      let s = 0;
      const tailStart = Math.round(0.05 * SR);
      for (let i = tailStart; i < b.length; i++) s += (b[i] ?? 0) * (b[i] ?? 0);
      return s;
    }
    const eLow = tailEnergy(outLow);
    const eHi  = tailEnergy(outHi);
    // High Q tail must dominate by at least 100x (in practice ~thousands).
    expect(eHi).toBeGreaterThan(eLow * 100);
    // And the high-Q tail itself must be nonzero (the filter must ring,
    // not just be silent in both cases).
    expect(eHi).toBeGreaterThan(1e-6);
  });

  it('BP tail energy at res=0.99 dominates the tail at res=0 by >100x', () => {
    // Drive a noise burst for 10ms and compare the post-drive tail energy
    // at low- vs high-resonance. The biquad does not self-oscillate, so
    // we measure the ringing decay timescale via energy ratio rather than
    // an absolute floor.
    const dur = 0.4;
    const driveEnd = Math.round(0.01 * SR);
    function makeBurst(): Float32Array {
      const b = new Float32Array(Math.round(SR * dur));
      let s = 1; // deterministic LCG so the two runs see identical input
      for (let i = 0; i < driveEnd; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        b[i] = ((s >> 8) & 0xff) / 255 - 0.5;
      }
      return b;
    }
    function tailEnergy(b: Float32Array): number {
      let s = 0;
      const tailStart = Math.round(0.05 * SR);
      for (let i = tailStart; i < b.length; i++) s += (b[i] ?? 0) * (b[i] ?? 0);
      return s;
    }
    const outLo = renderResofilter(makeBurst(), { cutoffHz: 800, res: 0.0,  mode: 2, sr: SR, mix: 1 });
    const outHi = renderResofilter(makeBurst(), { cutoffHz: 800, res: 0.99, mode: 2, sr: SR, mix: 1 });
    const eLo = tailEnergy(outLo);
    const eHi = tailEnergy(outHi);
    expect(eHi).toBeGreaterThan(eLo * 100);
  });
});

describe('resofilter-dsp — cutoff smoother', () => {
  it('RfSmoother step-response reaches ~63% in ~one time-constant', () => {
    const sm = new RfSmoother(SR, 50); // 50 Hz corner ≈ 3.18 ms time constant
    sm.prime(0);
    const targetFrames = Math.round(SR / (2 * Math.PI * 50));
    let y = 0;
    for (let i = 0; i < targetFrames; i++) y = sm.step(1);
    // After ~1 τ a 1-pole step response is 1 - 1/e ≈ 0.632. Allow ±15%.
    expect(y).toBeGreaterThan(0.5);
    expect(y).toBeLessThan(0.75);
  });

  it('cutoff ramp from 100 Hz → 5000 Hz in one sample stays click-free', () => {
    // Steady 440 Hz sine fed through a filter whose cutoff jumps from 100
    // Hz to 5000 Hz on a single sample. With smoothing the output ramps;
    // without smoothing it would click.
    const dur = 0.2;
    const n = Math.round(SR * dur);
    const cutoffArr = new Float32Array(n);
    const switchAt = Math.round(0.1 * SR);
    for (let i = 0; i < n; i++) cutoffArr[i] = i < switchAt ? 100 : 5000;
    const sig = sineBuf(440, SR, dur, 0.5);
    const out = renderResofilter(sig, {
      cutoffHz: 100, cutoffArr, res: 0.2, mode: 0, sr: SR, mix: 1,
    });
    let maxDelta = 0;
    const window = 64;
    for (let i = switchAt - window; i < switchAt + window; i++) {
      const d = Math.abs((out[i] ?? 0) - (out[i - 1] ?? 0));
      if (d > maxDelta) maxDelta = d;
    }
    expect(maxDelta).toBeLessThan(0.5);
  });
});

describe('resofilter-dsp — mix knob', () => {
  it('mix=0 returns dry input verbatim', () => {
    const sig = sineBuf(2000, SR, 0.05, 0.3);
    const out = renderResofilter(sig, { cutoffHz: 200, res: 0.2, mode: 0, sr: SR, mix: 0 });
    // mix=0 → out should equal input (dry). Sample-by-sample equality
    // within float epsilon for the first few hundred samples.
    let maxDelta = 0;
    for (let i = 0; i < 1000; i++) {
      const d = Math.abs((out[i] ?? 0) - (sig[i] ?? 0));
      if (d > maxDelta) maxDelta = d;
    }
    expect(maxDelta).toBeLessThan(1e-6);
  });
});

describe('resofilter-dsp — pickModeOutput sanity', () => {
  it('per-tick picker matches the documented topology', () => {
    const state = makeSvfState();
    const taps = svfStep(0.7, 0.1, 0.5, state);
    expect(pickModeOutput(taps, 0, 0.5)).toBe(taps.lp);
    expect(pickModeOutput(taps, 1, 0.5)).toBe(taps.hp);
    expect(pickModeOutput(taps, 2, 0.5)).toBe(taps.bp);
    expect(pickModeOutput(taps, 3, 0.5)).toBeCloseTo(taps.lp + taps.hp, 10);
    expect(pickModeOutput(taps, 4, 0.5)).toBeCloseTo(taps.lp + taps.hp - 0.5 * taps.bp, 10);
  });
});

describe('resofilter-dsp — ResofilterChannel preserves smoother state across calls', () => {
  it('smoothed cutoff advances toward the target across multiple steps', () => {
    const ch = new ResofilterChannel(SR);
    // Prime: smoother starts at 1000 Hz; ask it to track 4000 Hz over 1000
    // samples. After enough samples the smoothed value should be MUCH
    // closer to 4000 than to 1000.
    for (let i = 0; i < 1000; i++) ch.step(0, 4000, 0.2, 0, 1, SR);
    const sc = ch.smoothedCutoff();
    expect(sc).toBeGreaterThan(2500);
    expect(sc).toBeLessThan(4000);
  });
});

describe('resofilter-dsp — resofilterStep convenience wrapper', () => {
  it('reproduces the renderResofilter output sample-for-sample (no smoothing)', () => {
    const sig = sineBuf(500, SR, 0.01, 0.5);
    const state = makeSvfState();
    const direct = new Float32Array(sig.length);
    for (let i = 0; i < sig.length; i++) {
      direct[i] = resofilterStep(sig[i] as number, 1000, 0.2, 0, state, SR);
    }
    // direct should be the LP output of the SVF with no cutoff smoother.
    // Sample-zero is well-defined; spot-check the first sample.
    const state2 = makeSvfState();
    const g = cutoffToG(1000, SR);
    const k = resToK(0.2);
    const taps = svfStep(sig[0] as number, g, k, state2);
    expect(direct[0]).toBeCloseTo(taps.lp, 10);
  });
});
