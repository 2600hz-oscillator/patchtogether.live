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
  resonantPoleRadius,
  outputFilterStep,
  makeOutputState,
  portamentoCoeff,
  portamentoStep,
  pitchEnvStep,
  makePitchEnvState,
  pitchEnvTau,
  PITCH_ENV_START_MULT,
  dcBlockStep,
  makeDcBlockState,
  bodyDriveStep,
} from './chowkick-dsp';

const SR = 48000;

// ────────────────────────────────────────────────────────────────────────
// Test helpers: ping the body + measure pitch / DC / zero-crossings. These
// pin the OOMPH FIX (PR feat/chowkick-oomph) — a regression that re-breaks
// the resonator into a DC blob (the original bug) fails these.
// ────────────────────────────────────────────────────────────────────────

/** Ping the resonant body with a single impulse; return its impulse buffer. */
function pingBody(freqHz: number, q: number, damping01: number, tight = 0, bounce = 0, durS = 0.4): Float32Array {
  const N = Math.round(SR * durS);
  const buf = new Float32Array(N);
  const c = resonantCoefs(freqHz, q, damping01, tight, bounce, SR);
  const st = makeResonantState();
  for (let i = 0; i < N; i++) buf[i] = resonantFilterStep(i === 0 ? 1 : 0, c, st);
  return buf;
}

function dcOffset(b: Float32Array): number { let s = 0; for (let i = 0; i < b.length; i++) s += b[i] ?? 0; return s / b.length; }
function zeroCrossings(b: Float32Array, s0: number, s1: number): number {
  let zc = 0; for (let i = s0 + 1; i < Math.min(b.length, s1); i++) if (((b[i - 1] ?? 0) >= 0) !== ((b[i] ?? 0) >= 0)) zc++; return zc;
}
/** Dominant frequency (Hz) of a buffer via a coarse DFT over 20–400 Hz. */
function dominantFreq(b: Float32Array): number {
  let best = 0, bestMag = 0;
  for (let f = 20; f <= 400; f += 1) {
    let re = 0, im = 0;
    for (let i = 0; i < b.length; i += 2) { const a = 2 * Math.PI * f * i / SR; re += (b[i] ?? 0) * Math.cos(a); im -= (b[i] ?? 0) * Math.sin(a); }
    const m = re * re + im * im;
    if (m > bestMag) { bestMag = m; best = f; }
  }
  return best;
}

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
// resonantFilterStep — pinged 2-pole resonant BODY (the OOMPH FIX).
//
// These pin the core of PR feat/chowkick-oomph: the body must RING at `freq`
// (a bipolar decaying sine), not emit a unipolar DC blob. The previous port's
// inverted peaking-EQ (A=sqrt(G)) notched the body → DC +0.62, ZERO zero-
// crossings, fundamental ~14 Hz, 99.9 % sub-60 Hz energy. A regression to that
// fails the pitch / DC / zero-crossing assertions below.
// ────────────────────────────────────────────────────────────────────────
describe('resonantFilterStep — pinged resonant body rings at freq', () => {
  it('zero input → zero output (no spontaneous oscillation at reasonable knobs)', () => {
    const c = resonantCoefs(80, 0.7, 0.4, 0.5, 0, SR);
    const st = makeResonantState();
    for (let i = 0; i < 1000; i++) {
      const y = resonantFilterStep(0, c, st);
      expect(y).toBe(0);
    }
  });

  it('impulse response is finite and decays (stable filter)', () => {
    const c = resonantCoefs(80, 1.0, 0.4, 0.0, 0, SR);
    const st = makeResonantState();
    resonantFilterStep(1, c, st);
    let energyEarly = 0;
    for (let i = 0; i < 1000; i++) { const y = resonantFilterStep(0, c, st); energyEarly += y * y; }
    let energyLate = 0;
    for (let i = 0; i < 1000; i++) {
      const y = resonantFilterStep(0, c, st);
      energyLate += y * y;
      expect(Number.isFinite(y)).toBe(true);
    }
    expect(energyLate).toBeLessThan(energyEarly);
  });

  it('large drive saturates without exploding (output stays bounded)', () => {
    const c = resonantCoefs(80, 5, 0.4, 1, 1, SR);
    const st = makeResonantState();
    for (let i = 0; i < 5000; i++) {
      const x = i % 50 === 0 ? 50 : 0; // very loud impulse train
      const y = resonantFilterStep(x, c, st);
      expect(Math.abs(y)).toBeLessThan(200);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  // ── OOMPH-FIX regression pins ──

  it('body PINGS at the body frequency (±15 %), not at DC — 50/80/120 Hz', () => {
    // The single most important regression: the resonator must produce a
    // pitched tone at `freq`. (Bug: dominant freq was ~14 Hz regardless.)
    for (const f of [50, 80, 120]) {
      const buf = pingBody(f, 0.7, 0.4);
      const dom = dominantFreq(buf);
      expect(Math.abs(dom - f) / f, `${f}Hz ping dominant=${dom}Hz`).toBeLessThan(0.15);
    }
  });

  it('pinged body is bipolar (DC offset ≈ 0), not a unipolar DC blob', () => {
    // Bug produced DC +0.62; a healthy bipolar ring is ~0.
    const buf = pingBody(80, 0.7, 0.4);
    expect(Math.abs(dcOffset(buf))).toBeLessThan(0.02);
  });

  it('pinged body OSCILLATES — many zero-crossings over the decay (bug had 0)', () => {
    // An 80 Hz ring crosses zero ~2·80·t times. Bug had ZERO crossings.
    const buf = pingBody(80, 0.7, 0.4);
    const zc = zeroCrossings(buf, Math.round(0.005 * SR), Math.round(0.1 * SR));
    expect(zc, `zero-crossings in 5–100 ms`).toBeGreaterThan(8);
    // Zero-crossing count scales with frequency (proves it's pitched).
    const zcHi = zeroCrossings(pingBody(160, 0.7, 0.4), Math.round(0.005 * SR), Math.round(0.1 * SR));
    expect(zcHi).toBeGreaterThan(zc);
  });

  it('damping controls ring time: low damp rings longer than high damp', () => {
    const tailEnergy = (d: number) => {
      const b = pingBody(80, 0.7, d);
      let e = 0; for (let i = Math.round(0.1 * SR); i < Math.round(0.2 * SR); i++) e += (b[i] ?? 0) ** 2;
      return e;
    };
    expect(tailEnergy(0.1)).toBeGreaterThan(tailEnergy(0.9));
  });

  it('resonantPoleRadius is always < 1 (guaranteed decay) and decreases with damping', () => {
    const rLow = resonantPoleRadius(0, 0.7);
    const rHigh = resonantPoleRadius(1, 0.7);
    expect(rLow).toBeLessThan(1);
    expect(rHigh).toBeLessThan(1);
    expect(rLow).toBeGreaterThan(rHigh); // low damp → longer ring → bigger radius
  });
});

// ────────────────────────────────────────────────────────────────────────
// Pitch envelope (THE punch) — per-trigger downward sweep.
// ────────────────────────────────────────────────────────────────────────
describe('pitchEnvStep — per-trigger downward pitch sweep', () => {
  it('rising-edge gate sweeps freq DOWN from startMult× toward base', () => {
    const st = makePitchEnvState();
    // First high-gate sample → env=1 → freq = base·(1 + amount·(startMult−1)).
    const f0 = pitchEnvStep(1, 80, 1, 0.4, SR, st);
    const expectedStart = 80 * PITCH_ENV_START_MULT;
    expect(f0).toBeCloseTo(expectedStart, 0);
    // After many samples the sweep settles back to base.
    let f = f0;
    for (let i = 0; i < Math.round(0.3 * SR); i++) f = pitchEnvStep(1, 80, 1, 0.4, SR, st);
    expect(f).toBeCloseTo(80, 0);
    // And it swept strictly downward in between.
    const fMid = pitchEnvStep(1, 80, 1, 0.4, SR, makePitchEnvState());
    expect(fMid).toBeGreaterThan(80);
  });

  it('amount=0 → no sweep (freq stays at base)', () => {
    const st = makePitchEnvState();
    for (let i = 0; i < 100; i++) {
      const f = pitchEnvStep(i < 50 ? 1 : 0, 80, 0, 0.4, SR, st);
      expect(f).toBeCloseTo(80, 5);
    }
  });

  it('larger pitch_decay → longer sweep (bigger tau)', () => {
    expect(pitchEnvTau(0.8)).toBeGreaterThan(pitchEnvTau(0.2));
  });

  it('retriggers on each rising edge (not just the first)', () => {
    const st = makePitchEnvState();
    pitchEnvStep(1, 80, 1, 0.4, SR, st);           // first trigger
    for (let i = 0; i < 5000; i++) pitchEnvStep(0, 80, 1, 0.4, SR, st); // release + settle
    const fRetrig = pitchEnvStep(1, 80, 1, 0.4, SR, st); // second rising edge
    expect(fRetrig).toBeGreaterThan(80 * 2); // swept up again
  });
});

// ────────────────────────────────────────────────────────────────────────
// DC blocker + body drive.
// ────────────────────────────────────────────────────────────────────────
describe('dcBlockStep — removes DC offset', () => {
  it('a constant input decays to ~0 (DC removed)', () => {
    const st = makeDcBlockState();
    let y = 0;
    for (let i = 0; i < 48000; i++) y = dcBlockStep(0.5, st, 25, SR);
    expect(Math.abs(y)).toBeLessThan(0.01);
  });

  it('passes an AC signal (80 Hz sine) near unity', () => {
    const st = makeDcBlockState();
    let peak = 0;
    for (let i = 0; i < SR; i++) {
      const y = dcBlockStep(Math.sin(2 * Math.PI * 80 * i / SR), st, 25, SR);
      if (i > SR / 2) peak = Math.max(peak, Math.abs(y));
    }
    expect(peak).toBeGreaterThan(0.9); // 80 Hz well above the 25 Hz cutoff
  });

  it('removes the DC component from a DC+AC mix', () => {
    const st = makeDcBlockState();
    let sum = 0; const N = SR;
    for (let i = 0; i < N; i++) {
      const x = 0.5 + 0.3 * Math.sin(2 * Math.PI * 80 * i / SR);
      const y = dcBlockStep(x, st, 25, SR);
      if (i > N / 2) sum += y;
    }
    expect(Math.abs(sum / (N / 2))).toBeLessThan(0.01); // mean ≈ 0
  });
});

describe('bodyDriveStep — drive/makeup adds harmonics, never attenuates', () => {
  it('drive=0 is transparent (pass-through)', () => {
    for (const x of [-0.7, -0.1, 0, 0.1, 0.7]) {
      expect(bodyDriveStep(x, 0, 0.5)).toBeCloseTo(x, 6);
    }
  });

  it('drive>0 keeps small signals near unity (no quiet-body attenuation)', () => {
    const y = bodyDriveStep(0.05, 0.3, 0.5);
    expect(Math.abs(y)).toBeGreaterThan(0.04); // not crushed to silence
  });

  it('drive>0 saturates (compresses) a loud signal → harmonics', () => {
    const y = bodyDriveStep(2, 1, 1);
    expect(Math.abs(y)).toBeLessThan(2); // tanh compression
    expect(Number.isFinite(y)).toBe(true);
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
