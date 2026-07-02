// packages/dsp/src/lib/oversample.test.ts
//
// Proving tests for the shared 2×/4× oversampler (DSP-audit A4; the kick-drum
// drive stage consumes it first). The load-bearing bar, per the kick plan's
// adversarial review (Finding 2): ≥60 dB image rejection for EVERY nonlinearity
// the drive stage will feed it — tanh, cubic clip, asym-even, AND the harsh
// wavefolder — at that mode's SHIPPED oversampling factor, not just tanh.
//
// Measurement: drive a bin-aligned sine (bin 1500 of an 8192 window @48k ≈
// 8.79 kHz — aggressive: the 3rd harmonic is already supra-Nyquist) through the
// nonlinearity, then probe EXACT alias bins with Goertzel (no FFT dep, no
// leakage). Alias bins = fold-backs of harmonics k≥3; legit bins (fundamental,
// 2nd harmonic, DC) are excluded. Rejection = worst alias magnitude relative to
// the fundamental (dBc). A 1× "teeth" reference asserts the same measurement
// DOES see loud aliasing when unprotected — so a broken filter can't pass
// vacuously.

import { describe, it, expect } from 'vitest';
import { createOversampler, kaiserSincLowpass, type Nonlinearity } from './oversample';

const N = 8192; // analysis window (samples @ 48k)
const B0 = 1500; // torture fundamental: bin 1500 → f0 ≈ 8.79 kHz
const B0_LOW = 43; // realistic kick-range fundamental: ≈ 252 Hz (fold rating)
const WARMUP = 2048; // > filter transient at the input rate
const AMP = 0.9;
// Protected band: aliases landing at ≤ 0.8·Nyquist must meet the −60 dBc bar.
// Above that is the decimator's transition zone — partially attenuated by
// construction in every finite oversampler (see oversample.ts contract notes).
const PROTECTED_MAX_BIN = Math.floor(0.8 * (N / 2)); // ≈ 19.2 kHz

/** Exact single-bin magnitude (rectangular window; exact for bin-aligned f0). */
function goertzelMag(buf: Float32Array, bin: number): number {
  const w = (2 * Math.PI * bin) / buf.length;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
}

/** Bins where fold-backs of supra-Nyquist harmonics of `b0` land. Legit
 *  content = harmonics with k·b0 < N/2 (plus DC — asym-even nonlinearities
 *  produce DC by design; the kick DC-blocks after). Everything else that a
 *  harmonic can fold onto is an alias bin. `maxBin` bounds the probed band
 *  (PROTECTED_MAX_BIN for the hard bar; N/2 for whole-band probes). */
function aliasBins(b0: number, maxBin: number): number[] {
  const legit = new Set<number>([0]);
  for (let k = 1; k * b0 < N / 2; k++) legit.add(k * b0);
  const out = new Set<number>();
  const kMax = Math.ceil((N * 8) / b0); // fold-backs across several wraps
  for (let k = 1; k <= kMax; k++) {
    if (k * b0 < N / 2) continue; // legit harmonic, not an alias
    let a = (k * b0) % N;
    if (a > N / 2) a = N - a;
    if (a < 4 || a > maxBin) continue;
    let nearLegit = false;
    for (const l of legit) {
      if (Math.abs(a - l) < 4) {
        nearLegit = true;
        break;
      }
    }
    if (!nearLegit) out.add(a);
  }
  return [...out];
}

/** Steady-state N-sample output window of `fn` under a ×factor oversampler,
 *  driven by a bin-aligned sine at bin `b0`. */
function renderOS(factor: 1 | 2 | 4, fn: Nonlinearity, b0: number): Float32Array {
  const os = createOversampler(factor);
  const out = new Float32Array(N);
  const total = WARMUP + N;
  for (let t = 0; t < total; t++) {
    const y = os.process(AMP * Math.sin((2 * Math.PI * b0 * t) / N), fn);
    if (t >= WARMUP) out[t - WARMUP] = y;
  }
  return out;
}

/** Worst alias level in dB relative to the fundamental (dBc). */
function worstAliasDbc(buf: Float32Array, b0: number, maxBin: number): number {
  const fund = goertzelMag(buf, b0);
  let worst = -Infinity;
  for (const b of aliasBins(b0, maxBin)) {
    const db = 20 * Math.log10(goertzelMag(buf, b) / fund + 1e-30);
    if (db > worst) worst = db;
  }
  return worst;
}

// ── The drive-stage nonlinearity set (matches the kick's drive_mode enum) ──
const tanhDrive: Nonlinearity = (x) => Math.tanh(2.5 * x);
const cubicClip: Nonlinearity = (x) => {
  const y = 2 * x;
  return y <= -1 ? -2 / 3 : y >= 1 ? 2 / 3 : y - (y * y * y) / 3;
};
const asymEven: Nonlinearity = (x) => Math.tanh(2 * x + 0.4 * x * x);
/** Reflect-fold into [-1,1] at the kick's max shipped fold gain (~2.8). */
const wavefold: Nonlinearity = (x) => {
  let y = (2.8 * x + 1) % 4;
  if (y < 0) y += 4;
  return y < 2 ? y - 1 : 3 - y;
};
const identity: Nonlinearity = (x) => x;

describe('oversample: image rejection (the A4 bar — every drive mode)', () => {
  it('the measurement has TEETH: unprotected 1× aliases loudly', () => {
    // If these ever pass quietly the probe is broken, not the DSP good.
    // tanh's 5th harmonic folds INTO the protected band at 1× (bin 692).
    expect(worstAliasDbc(renderOS(1, tanhDrive, B0), B0, PROTECTED_MAX_BIN)).toBeGreaterThan(-45);
    // The folder at 1× is a wall of aliases across the whole band.
    expect(worstAliasDbc(renderOS(1, wavefold, B0), B0, N / 2)).toBeGreaterThan(-35);
  });

  // ── Torture source (~8.8 kHz, 3rd harmonic already supra-Nyquist) at 4× ──
  // At 2× this is PHYSICALLY unmeetable for a strong drive: the 9th harmonic
  // (79 kHz) folds AT THE 96 kHz OVERSAMPLED RATE into 16.9 kHz — passband,
  // filter-independent (measured -48.8 dBc; polyphase == brute-force reference
  // within 1 dB). At 4× the first unprotected fold is ~the 21st harmonic
  // (measured -117 dBc for tanh). Hence the shipped policy: 4× whenever the
  // driven material can reach up the spectrum; 2× is rated for kick-range
  // sources (asserted separately below).
  it('tanh drive @4× (torture source): protected-band aliases ≤ -60 dBc', () => {
    expect(worstAliasDbc(renderOS(4, tanhDrive, B0), B0, PROTECTED_MAX_BIN)).toBeLessThanOrEqual(-60);
  });

  it('cubic clip @4× (torture source): protected-band aliases ≤ -60 dBc', () => {
    expect(worstAliasDbc(renderOS(4, cubicClip, B0), B0, PROTECTED_MAX_BIN)).toBeLessThanOrEqual(-60);
  });

  it('asym-even @4× (torture source): protected-band aliases ≤ -60 dBc', () => {
    expect(worstAliasDbc(renderOS(4, asymEven, B0), B0, PROTECTED_MAX_BIN)).toBeLessThanOrEqual(-60);
  });

  // ── Rated kick-range source (~252 Hz): 2× suffices for the smooth modes ──
  it.each([
    ['tanh', tanhDrive],
    ['cubic', cubicClip],
    ['asym-even', asymEven],
  ] as const)('%s @2× at the rated kick-range source: protected-band aliases ≤ -60 dBc', (_name, fn) => {
    expect(worstAliasDbc(renderOS(2, fn, B0_LOW), B0_LOW, PROTECTED_MAX_BIN)).toBeLessThanOrEqual(-60);
  });

  it('wavefold @4× at its RATED source (kick range, ~252 Hz): protected-band aliases ≤ -60 dBc', () => {
    // The folder is rated for low-frequency sources (the kick folds sub/body
    // ≤ ~250 Hz) — see the contract notes in oversample.ts. 252 Hz at max
    // shipped fold gain is the shipped worst case.
    expect(worstAliasDbc(renderOS(4, wavefold, B0_LOW), B0_LOW, PROTECTED_MAX_BIN)).toBeLessThanOrEqual(-60);
  });

  it('wavefold @4× rated source: WHOLE-band aliases still ≤ -50 dBc', () => {
    // Even including the transition zone, a kick-range folded source stays
    // far below audibility — a looser whole-band backstop.
    expect(worstAliasDbc(renderOS(4, wavefold, B0_LOW), B0_LOW, N / 2)).toBeLessThanOrEqual(-50);
  });
});

describe('oversample: linearity + unity (identity fn)', () => {
  it.each([2, 4] as const)('×%i passes a low sine at unity gain (±0.15 dB)', (factor) => {
    const os = createOversampler(factor);
    const b = 32; // ≈187 Hz — deep passband
    const raw = new Float32Array(N);
    const out = new Float32Array(N);
    const total = WARMUP + N;
    for (let t = 0; t < total; t++) {
      const x = 0.5 * Math.sin((2 * Math.PI * b * t) / N);
      const y = os.process(x, identity);
      if (t >= WARMUP) {
        raw[t - WARMUP] = x;
        out[t - WARMUP] = y;
      }
    }
    const ratio = goertzelMag(out, b) / goertzelMag(raw, b);
    expect(ratio).toBeGreaterThan(0.983); // -0.15 dB
    expect(ratio).toBeLessThan(1.018); // +0.15 dB
  });

  it.each([2, 4] as const)('×%i passes DC at unity with no offset', (factor) => {
    const os = createOversampler(factor);
    let y = 0;
    for (let t = 0; t < 2048; t++) y = os.process(0.5, identity);
    expect(Math.abs(y - 0.5)).toBeLessThan(2e-3);
  });

  it('group delay is the declared integer: 31 samples @2×/63t, 32 @4×/129t', () => {
    for (const [factor, expected] of [
      [2, 31],
      [4, 32],
    ] as const) {
      const os = createOversampler(factor);
      let peakIdx = -1;
      let peak = 0;
      for (let t = 0; t < 200; t++) {
        const y = os.process(t === 0 ? 1 : 0, identity);
        if (Math.abs(y) > peak) {
          peak = Math.abs(y);
          peakIdx = t;
        }
      }
      expect(peakIdx).toBe(expected);
    }
  });
});

describe('oversample: contract details', () => {
  it('factor=1 is an exact passthrough of fn', () => {
    const os = createOversampler(1);
    for (const v of [-1, -0.3, 0, 0.7, 1]) {
      expect(os.process(v, tanhDrive)).toBe(tanhDrive(v));
    }
    expect(os.taps).toBe(0);
  });

  it('reset() fully clears state', () => {
    const os = createOversampler(2);
    for (let t = 0; t < 100; t++) os.process(Math.sin(t * 1.7), identity);
    os.reset();
    // All-zero state + zero input ⇒ exactly zero out, immediately.
    expect(os.process(0, identity)).toBe(0);
    expect(os.process(0, identity)).toBe(0);
  });

  it('kaiserSincLowpass is unity-DC-normalized and symmetric', () => {
    const h = kaiserSincLowpass(63, 0.45, 9);
    let sum = 0;
    for (let i = 0; i < h.length; i++) sum += h[i];
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    for (let i = 0; i < 31; i++) {
      expect(h[i]).toBeCloseTo(h[62 - i], 10);
    }
  });
});
