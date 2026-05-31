// packages/dsp/src/lib/chowkick-dsp.test.ts
//
// Pure-helper unit tests for the CHOWKICK DSP pipeline. We pin behavior
// of each helper (pulseShaperStep, noiseBurstStep, resonantFilterStep,
// outputFilterStep, portamento, etc.) with 4+ cases each so a refactor
// surfaces with a specific quantitative regression.

import { describe, it, expect } from 'vitest';
import {
  pulseShaperStep,
  makePulseState,
  decayKnobToTau,
  noiseBurstStep,
  makeNoiseState,
  noiseDecayCoeff,
  xorshift32Bipolar,
  pinkStep,
  velvetStep,
  resonantCoefs,
  resonantFilterStep,
  makeResonantState,
  outputFilterStep,
  makeOutputState,
  portamentoCoeff,
  portamentoStep,
} from './chowkick-dsp';

const SR = 48000;

// ────────────────────────────────────────────────────────────────────────
// pulseShaperStep — 4 pinned cases.
// ────────────────────────────────────────────────────────────────────────
describe('pulseShaperStep — width/amp/decay/sustain envelope', () => {
  it('rising-edge gate jumps to amp; holds for width_ms; then decays', () => {
    const st = makePulseState();
    const width_ms = 2; // 96 samples at 48k
    const amp = 1.0;
    // Gate low for 5 samples (no output).
    for (let i = 0; i < 5; i++) expect(pulseShaperStep(0, width_ms, amp, 0.5, 0.0, SR, st)).toBe(0);
    // Rising edge: first high-gate sample → output = amp immediately.
    const peak = pulseShaperStep(1, width_ms, amp, 0.5, 0.0, SR, st);
    expect(peak).toBe(amp);
    // Continue the hold window. width=2ms @ 48k → 96 samples in the hold,
    // including the rising-edge sample. Run 200 more samples to comfortably
    // exit the hold + enter the decay phase.
    for (let i = 0; i < 200; i++) pulseShaperStep(1, width_ms, amp, 0.5, 0.0, SR, st);
    // We're now well into decay (sustain=0 → floor=0); the output should
    // be < amp and > 0.
    const afterHold = pulseShaperStep(1, width_ms, amp, 0.5, 0.0, SR, st);
    expect(afterHold).toBeLessThan(amp);
    expect(afterHold).toBeGreaterThan(0);
  });

  it('sustain=1 holds the pulse at amp while gate is high (after the width window)', () => {
    const st = makePulseState();
    const width_ms = 1; // 48 samples
    // Trigger.
    pulseShaperStep(1, width_ms, 1, 0.5, 1.0, SR, st);
    // Hold past the width window.
    for (let i = 0; i < 200; i++) pulseShaperStep(1, width_ms, 1, 0.5, 1.0, SR, st);
    // With sustain=1, the decay floor IS amp, so steady state ≈ 1.
    const y = pulseShaperStep(1, width_ms, 1, 0.5, 1.0, SR, st);
    expect(y).toBeCloseTo(1, 3);
  });

  it('gate release → decays to ~0 within tau*5', () => {
    const st = makePulseState();
    // Trigger + hold to settle to sustain floor.
    for (let i = 0; i < 500; i++) pulseShaperStep(1, 1, 1, 0.5, 0.5, SR, st);
    // Release the gate.
    pulseShaperStep(0, 1, 1, 0.5, 0.5, SR, st);
    // After 5 time-constants the output should be very small (< 1% of floor).
    const tau = decayKnobToTau(0.5);
    const samples = Math.round(5 * tau * SR);
    let y = 0.5;
    for (let i = 0; i < samples; i++) {
      y = pulseShaperStep(0, 1, 1, 0.5, 0.5, SR, st);
    }
    expect(Math.abs(y)).toBeLessThan(0.01);
  });

  it('width=0.1 ms hold duration ≈ 4-5 samples at 48k', () => {
    const st = makePulseState();
    const width_ms = 0.1;
    pulseShaperStep(1, width_ms, 1, 0, 0, SR, st); // trigger sample (already counted as 1 hold-decrement-or-not).
    // After the trigger sample, the worklet decrements holdRemain on each
    // subsequent gated step until it hits 0; at 0.1ms = ~5 samples, ≤ 5
    // continued high-gate samples should still output amp.
    let hold = 0;
    for (let i = 0; i < 20; i++) {
      const y = pulseShaperStep(1, width_ms, 1, 0.1, 0.0, SR, st);
      if (y === 1) hold++;
      else break;
    }
    // 0.1 ms at 48k = round(4.8) = 5 samples; the rising-edge sample is
    // also at amp, so we should see ~5 amp samples in total (already
    // counted 1 outside the loop → 4 more inside).
    expect(hold).toBeGreaterThanOrEqual(3);
    expect(hold).toBeLessThanOrEqual(6);
  });
});

// ────────────────────────────────────────────────────────────────────────
// noiseBurstStep — 4 pinned cases.
// ────────────────────────────────────────────────────────────────────────
describe('noiseBurstStep — gated envelope + LPF', () => {
  it('rising-edge gate snaps the noise envelope to 1', () => {
    const st = makeNoiseState(1);
    const prev = { v: false };
    // No gate → noise is 0 (env=0).
    let y = noiseBurstStep(0, 1.0, 0.5, 1000, 0, SR, st, prev);
    expect(y).toBe(0);
    // Rising edge → env=1 → first sample is non-zero (xorshift output × amount × env).
    y = noiseBurstStep(1, 1.0, 0.5, 1000, 0, SR, st, prev);
    expect(Math.abs(y)).toBeGreaterThan(0);
  });

  it('amount=0 produces silence regardless of gate', () => {
    const st = makeNoiseState(1);
    const prev = { v: false };
    for (let i = 0; i < 100; i++) {
      const y = noiseBurstStep(1, 0, 0.5, 1000, 0, SR, st, prev);
      expect(y).toBe(0);
    }
  });

  it('noiseDecayCoeff decays env to ~0 within tau*5 (decay knob = 0)', () => {
    // decay=0 → tau=1ms → 5*tau = 5ms = 240 samples at 48k.
    const st = makeNoiseState(1);
    const prev = { v: false };
    noiseBurstStep(1, 1, 0, 5000, 0, SR, st, prev); // trigger
    let lastEnv = st.env;
    for (let i = 0; i < 250; i++) noiseBurstStep(1, 1, 0, 5000, 0, SR, st, prev);
    lastEnv = st.env;
    // Env should now be very near 0 (well below noise floor).
    expect(lastEnv).toBeLessThan(0.01);
  });

  it('changing noise type still produces non-degenerate output for all 4 types', () => {
    for (let type = 0; type < 4; type++) {
      const st = makeNoiseState(1234 + type);
      const prev = { v: false };
      let sumAbs = 0;
      noiseBurstStep(1, 1, 1.0, 5000, type as 0 | 1 | 2 | 3, SR, st, prev);
      for (let i = 0; i < 200; i++) {
        sumAbs += Math.abs(noiseBurstStep(1, 1, 1.0, 5000, type as 0 | 1 | 2 | 3, SR, st, prev));
      }
      // Each noise type should produce some non-zero energy in 200 samples.
      expect(sumAbs).toBeGreaterThan(0);
      // Finite, no NaN/Inf leaking through the SVF.
      expect(Number.isFinite(sumAbs)).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// resonantFilterStep — 4 pinned cases.
// ────────────────────────────────────────────────────────────────────────
describe('resonantFilterStep — peaking IIR with tanh saturation', () => {
  it('zero input → zero output (no spontaneous oscillation at reasonable knobs)', () => {
    const c = resonantCoefs(80, 0.5, 0.5, 0.5, 0, SR);
    const st = makeResonantState();
    for (let i = 0; i < 1000; i++) {
      const y = resonantFilterStep(0, c, st);
      expect(y).toBe(0);
    }
  });

  it('impulse response is finite and decays (stable filter)', () => {
    const c = resonantCoefs(80, 1.0, 0.5, 0.0, 0, SR);
    const st = makeResonantState();
    // Impulse at sample 0.
    resonantFilterStep(1, c, st);
    let energyEarly = 0;
    for (let i = 0; i < 200; i++) {
      const y = resonantFilterStep(0, c, st);
      energyEarly += y * y;
    }
    let energyLate = 0;
    for (let i = 0; i < 200; i++) {
      const y = resonantFilterStep(0, c, st);
      energyLate += y * y;
      expect(Number.isFinite(y)).toBe(true);
    }
    // Late energy should be smaller than early energy → it's decaying.
    expect(energyLate).toBeLessThan(energyEarly);
  });

  it('large drive saturates without exploding (tanh keeps output bounded)', () => {
    const c = resonantCoefs(80, 5, 0.5, 1, 1, SR);
    const st = makeResonantState();
    for (let i = 0; i < 5000; i++) {
      // Very loud impulse train.
      const x = i % 50 === 0 ? 50 : 0;
      const y = resonantFilterStep(x, c, st);
      // tanh maps any real → (-1/d, +1/d) where d is the drive — for d≥1 → output well-bounded.
      expect(Math.abs(y)).toBeLessThan(200);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('higher Q produces narrower-but-louder peak at the cutoff', () => {
    // Render a sine at fc; with higher Q the steady-state amplitude grows.
    const fc = 80;
    function steadyStateAmpAtFc(qVal: number): number {
      const c = resonantCoefs(fc, qVal, 0.5, 0, 0, SR);
      const st = makeResonantState();
      let peak = 0;
      for (let i = 0; i < 4 * SR / fc; i++) { // ~4 cycles to settle
        const x = Math.sin(2 * Math.PI * fc * i / SR);
        const y = resonantFilterStep(x, c, st);
        if (i > 2 * SR / fc && Math.abs(y) > peak) peak = Math.abs(y);
      }
      return peak;
    }
    const lowQ = steadyStateAmpAtFc(0.5);
    const highQ = steadyStateAmpAtFc(5);
    // The high-Q peak amp should be strictly larger.
    expect(highQ).toBeGreaterThan(lowQ);
  });
});

// ────────────────────────────────────────────────────────────────────────
// outputFilterStep — 4 pinned cases.
// ────────────────────────────────────────────────────────────────────────
describe('outputFilterStep — LPF × level', () => {
  it('level=-60 dB silences the output', () => {
    const st = makeOutputState();
    for (let i = 0; i < 100; i++) {
      const y = outputFilterStep(1, 800, -60, SR, st);
      expect(y).toBe(0);
    }
  });

  it('level=0 dB + tone>>fc keeps DC unity over many samples', () => {
    const st = makeOutputState();
    let y = 0;
    for (let i = 0; i < 4800; i++) y = outputFilterStep(1, 2000, 0, SR, st);
    // DC steady-state of one-pole LPF is unity.
    expect(y).toBeCloseTo(1, 3);
  });

  it('low tone attenuates a 1 kHz sine vs a high tone', () => {
    // Run both LPFs on a 1 kHz sine; compare peak amplitudes.
    function peakAt1kHz(toneHz: number): number {
      const st = makeOutputState();
      let peak = 0;
      for (let i = 0; i < SR; i++) {
        const x = Math.sin(2 * Math.PI * 1000 * i / SR);
        const y = outputFilterStep(x, toneHz, 0, SR, st);
        if (i > SR / 2 && Math.abs(y) > peak) peak = Math.abs(y);
      }
      return peak;
    }
    const lowTone = peakAt1kHz(100);   // way below 1 kHz → strong attenuation
    const highTone = peakAt1kHz(2000); // above 1 kHz → near pass-through
    expect(highTone).toBeGreaterThan(lowTone * 2);
  });

  it('level=-6 dB scales output by ~0.501 (10^(-6/20))', () => {
    const st = makeOutputState();
    let y = 0;
    for (let i = 0; i < 4800; i++) y = outputFilterStep(1, 2000, -6, SR, st);
    expect(y).toBeCloseTo(Math.pow(10, -6 / 20), 2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Portamento — small sanity checks.
// ────────────────────────────────────────────────────────────────────────
describe('portamentoCoeff + portamentoStep', () => {
  it('portamento=0 → coeff=1 → instant snap to target', () => {
    const a = portamentoCoeff(0, SR);
    expect(a).toBe(1);
    expect(portamentoStep(440, 100, a)).toBe(440);
  });

  it('larger portamento_ms → smaller coeff (slower glide)', () => {
    const a1 = portamentoCoeff(1, SR);
    const a100 = portamentoCoeff(100, SR);
    expect(a1).toBeGreaterThan(a100);
  });

  it('glide from 80 → 160 Hz over portamento=100 ms reaches ~half-way in ~70 ms', () => {
    const a = portamentoCoeff(100, SR);
    let y = 80;
    const samples = Math.round(0.07 * SR);
    for (let i = 0; i < samples; i++) y = portamentoStep(160, y, a);
    // After ~tau samples (70 ms ≈ 0.7 × tau-time-constant) we should be > halfway.
    expect(y).toBeGreaterThan(100);
    expect(y).toBeLessThan(160);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Bonus: xorshift32 sanity + pink/velvet output range.
// ────────────────────────────────────────────────────────────────────────
describe('noise generators — output range sanity', () => {
  it('xorshift32 stays in [-1, +1) over 10k samples', () => {
    const st = makeNoiseState(7);
    for (let i = 0; i < 10000; i++) {
      const v = xorshift32Bipolar(st);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
    }
  });

  it('pink noise stays bounded ≲ 1', () => {
    const st = makeNoiseState(11);
    let maxAbs = 0;
    for (let i = 0; i < 10000; i++) {
      const v = pinkStep(st);
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
    expect(maxAbs).toBeLessThanOrEqual(1.0);
  });

  it('velvet noise is ±1 sparse impulses, zero otherwise', () => {
    const st = makeNoiseState(13);
    let nonZero = 0, totalNonZeroMagSum = 0;
    for (let i = 0; i < 10000; i++) {
      const v = velvetStep(st);
      if (v !== 0) { nonZero++; totalNonZeroMagSum += Math.abs(v); }
    }
    // Most samples should be zero.
    expect(nonZero).toBeLessThan(2000); // well under 20% density
    // Every non-zero sample is exactly ±1.
    expect(totalNonZeroMagSum).toBe(nonZero);
  });
});
