// packages/dsp/src/lib/oversample.ts
//
// Shared 2×/4× oversampler for per-sample NONLINEARITIES (drive, wavefold,
// exciter saturation) — the DSP-audit A4 primitive; the kick voice consumes it
// first, and it's reusable by every future nonlinear stage.
//
// Pipeline, streaming one input sample at a time:
//   zero-stuff ×factor → anti-IMAGING FIR → apply fn() per subsample →
//   anti-ALIASING FIR → decimate ÷factor → one output sample.
//
// A single Kaiser-windowed-sinc lowpass (cutoff at the ORIGINAL Nyquist, i.e.
// 1/factor of the oversampled Nyquist) is reused for both the interpolation and
// decimation stages. The up-stage runs in POLYPHASE form (each output subsample
// touches only its phase's taps); the down-stage is a full FIR evaluated once
// per output. Net linear DC gain = 1 (the up-stage's ×factor compensates the
// zero-stuffing energy loss).
//
// State-only-via-explicit-object so the per-sample math is unit-testable without
// the worklet (DSP-core discipline). No top-level worklet
// export concerns — this is a `lib/` helper, inlined at build time.
//
// Correctness bar (oversample.test.ts): for EVERY nonlinearity the drive stage
// feeds it (tanh / cubic clip / asym-even / wavefold), alias products landing in
// the PROTECTED BAND [0, 0.8·Nyquist] stay ≤ −60 dBc; plus unity low-frequency
// passthrough, exact-integer group delay, and no DC offset from identity.
//
// Contract notes (why "protected band", and the wavefold rating):
// - The 0.8–1.0·Nyquist zone is the decimator's TRANSITION BAND. Content just
//   above the original Nyquist (e.g. the 3rd harmonic of an ~9 kHz fundamental)
//   folds back into 19–24 kHz with only partial attenuation — true of every
//   finite-length oversampler (JUCE/chowdsp spec theirs the same way). Raising
//   taps narrows the zone but can never close it; the audible band is protected.
// - Harmonics that exceed the OVERSAMPLED Nyquist fold at the OS rate into the
//   passband itself — filter-independent; only the FACTOR bounds which harmonic
//   order goes unprotected (2×: the 9th of an ~9 kHz source lands at 16.9 kHz,
//   measured −48.8 dBc for tanh(2.5x); 4×: the first unprotected fold is ~the
//   21st harmonic, −117 dBc). Shipped policy: 4× for strong drives on material
//   that reaches up the spectrum; 2× is rated for kick-range (≤ ~250 Hz)
//   sources, where the folding order is ~k>380 and negligible.
// - Wavefold-class nonlinearities are the extreme case (slow harmonic decay):
//   rated for LOW-FREQUENCY sources only (the kick folds sub/body ≤ ~250 Hz),
//   pinned @4× at a 252 Hz source — its real use.

export type Nonlinearity = (x: number) => number;

export interface Oversampler {
  /** Process ONE input sample: upsample ×factor, apply `fn` to each of the
   *  `factor` subsamples, decimate back to one output sample. */
  process(x: number, fn: Nonlinearity): number;
  /** Clear all filter state (call on a voice re-trigger / transport reset). */
  reset(): void;
  readonly factor: number;
  readonly taps: number;
}

// Modified Bessel function of the first kind, order 0 — for the Kaiser window.
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const halfX = x / 2;
  for (let k = 1; k < 40; k++) {
    term *= (halfX / k) * (halfX / k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * A linear-phase Kaiser-windowed-sinc lowpass of length `n` (odd → symmetric,
 * integer group delay). `cutoff` is the -6 dB point as a fraction of Nyquist
 * (0..1) at the filter's own (oversampled) rate. Normalized to unity DC gain.
 */
export function kaiserSincLowpass(n: number, cutoff: number, beta: number): Float32Array {
  const h = new Float32Array(n);
  const mid = (n - 1) / 2;
  const denom = besselI0(beta);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const m = i - mid;
    // Ideal sinc at the cutoff (cutoff is fraction of Nyquist → ω = π·cutoff).
    const sinc = m === 0 ? cutoff : Math.sin(Math.PI * cutoff * m) / (Math.PI * m);
    // Kaiser window.
    const r = m / mid;
    const win = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom;
    h[i] = sinc * win;
    sum += h[i];
  }
  // Normalize to unity DC gain.
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

const PASSTHROUGH: Oversampler = {
  factor: 1,
  taps: 0,
  process(x, fn) {
    return fn(x);
  },
  reset() {},
};

export interface OversamplerOptions {
  /** FIR length (odd). Default 63 for 2×, 129 for 4× — both chosen so the
   *  cascade's total group delay, (taps−1)/factor input samples, is an
   *  INTEGER (31 and 32 respectively): a pure sample delay, no fractional
   *  inter-sample shift. */
  taps?: number;
  /** Kaiser β (higher = deeper stopband). Default 9 ≈ −85 dB. */
  beta?: number;
  /** Cutoff as a fraction of the ORIGINAL Nyquist (0..1). Default 0.90 leaves a
   *  transition band so the stopband reaches the target before the first image. */
  cutoffFrac?: number;
}

/**
 * Create a streaming ×`factor` oversampler (factor ∈ {1, 2, 4}). factor === 1
 * is a zero-cost passthrough (`process` just calls `fn`).
 */
export function createOversampler(factor: 1 | 2 | 4, opts: OversamplerOptions = {}): Oversampler {
  if (factor === 1) return PASSTHROUGH;

  let n = opts.taps ?? (factor === 2 ? 63 : 129);
  if (n % 2 === 0) n += 1; // force odd for a symmetric, integer-delay FIR
  const beta = opts.beta ?? 9;
  const cutoffFrac = opts.cutoffFrac ?? 0.9;
  // Cutoff at the ORIGINAL Nyquist = 1/factor of the oversampled Nyquist, pulled
  // in by cutoffFrac so the Kaiser stopband is reached before the first image.
  const h = kaiserSincLowpass(n, (1 / factor) * cutoffFrac, beta);

  // Polyphase decomposition of h for the interpolation stage: phase k gets taps
  // h[k], h[k+factor], h[k+2·factor], … applied to the input history.
  const phaseLen = Math.ceil(n / factor);
  const up: Float32Array[] = [];
  for (let k = 0; k < factor; k++) {
    const sub = new Float32Array(phaseLen);
    for (let p = 0; p < phaseLen; p++) {
      const idx = k + p * factor;
      sub[p] = idx < n ? h[idx] : 0;
    }
    up.push(sub);
  }

  const xhist = new Float32Array(phaseLen); // input history, newest at [0]
  const zbuf = new Float32Array(n); // oversampled post-fn ring
  let zpos = 0; // index where the NEXT oversampled sample is written

  return {
    factor,
    taps: n,
    process(x: number, fn: Nonlinearity): number {
      // Advance the input history (newest at index 0).
      for (let p = phaseLen - 1; p > 0; p--) xhist[p] = xhist[p - 1];
      xhist[0] = x;

      // Interpolate → apply fn → push each of the `factor` oversampled samples.
      for (let k = 0; k < factor; k++) {
        const sub = up[k];
        let acc = 0;
        for (let p = 0; p < phaseLen; p++) acc += sub[p] * xhist[p];
        // ×factor restores the energy lost to zero-stuffing (unity DC).
        zbuf[zpos] = fn(factor * acc);
        zpos = (zpos + 1) % n;
      }

      // Decimate: full anti-aliasing FIR, evaluated once per input tick at
      // PHASE 0 of the tick (the first of the `factor` subsamples just pushed,
      // i.e. `factor-1` back from the newest). Phase-0 sampling makes the
      // cascade's total delay the exact integer (taps-1)/factor input samples;
      // sampling the newest subsample instead lands mid-way between the
      // linear-phase peak's neighbors (a fractional delay). The newest
      // subsamples still enter the window on later ticks.
      let out = 0;
      let idx = zpos - 1 - (factor - 1);
      for (let j = 0; j < n; j++) {
        if (idx < 0) idx += n;
        out += h[j] * zbuf[idx];
        idx--;
      }
      return out;
    },
    reset() {
      xhist.fill(0);
      zbuf.fill(0);
      zpos = 0;
    },
  };
}
