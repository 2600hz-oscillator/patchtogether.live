// Real-input FFT for offline sample transforms (SAMSLOOP denoise).
//
// OWN CODE — CLEAN-ROOM (the provenance posture of docs/adr/018). Written
// from the textbook radix-2 Cooley–Tukey decimation-in-time recurrence plus
// the standard "pack a real N-point signal into an N/2-point complex FFT and
// split the result" identity. It is NOT a port of any FFT library (NOT FFTW,
// NOT KissFFT, NOT SoX's, NOT Audacity's). The tree's other FFTs are not
// reusable here: `warrensspectrum-dsp.ts` keeps a private, forward-only,
// fixed-2048 transform and `warrensvisions-core.ts` is a video file inside the
// WebGL attest basis.
//
// Contract:
//   • `n` is a power of two ≥ 4. `forward` fills bins k = 0..n/2 (n/2 + 1
//     bins, DC and Nyquist included) with the UNNORMALISED DFT
//     X[k] = Σ x[j]·e^{−2πi jk/n}. `inverse` divides by n, so
//     inverse(forward(x)) == x.
//   • Twiddles and the split-stage phasors are Float64 (precision), the work
//     buffers are Float64 (no float32 rounding across log2(n) stages); the
//     caller's spectrum arrays are Float32, the STFT's storage type.
//   • Pure: no allocation after construction; one instance serves any number
//     of frames of the same size.

export class RealFft {
  readonly n: number;
  /** Complex transform length (n/2). */
  private readonly m: number;
  private readonly rev: Uint32Array;
  // m-point complex twiddles e^{−2πi k/m}, k = 0..m/2−1.
  private readonly cosM: Float64Array;
  private readonly sinM: Float64Array;
  // Split-stage phasors e^{−2πi k/n}, k = 0..m.
  private readonly cosN: Float64Array;
  private readonly sinN: Float64Array;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;

  constructor(n: number) {
    if (n < 4 || (n & (n - 1)) !== 0) throw new Error(`RealFft: n must be a power of two ≥ 4 (got ${n})`);
    this.n = n;
    const m = n >> 1;
    this.m = m;
    const bits = Math.log2(m);
    this.rev = new Uint32Array(m);
    for (let i = 0; i < m; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cosM = new Float64Array(m >> 1);
    this.sinM = new Float64Array(m >> 1);
    for (let k = 0; k < m >> 1; k++) {
      this.cosM[k] = Math.cos((2 * Math.PI * k) / m);
      this.sinM[k] = Math.sin((2 * Math.PI * k) / m);
    }
    this.cosN = new Float64Array(m + 1);
    this.sinN = new Float64Array(m + 1);
    for (let k = 0; k <= m; k++) {
      this.cosN[k] = Math.cos((2 * Math.PI * k) / n);
      this.sinN[k] = Math.sin((2 * Math.PI * k) / n);
    }
    this.zr = new Float64Array(m);
    this.zi = new Float64Array(m);
  }

  /** In-place m-point complex FFT of (zr, zi); `inverse` conjugates the twiddles (no scaling). */
  private fftM(inverse: boolean): void {
    const { m, zr, zi, rev, cosM, sinM } = this;
    for (let i = 0; i < m; i++) {
      const j = rev[i]!;
      if (j > i) {
        const tr = zr[i]!;
        zr[i] = zr[j]!;
        zr[j] = tr;
        const ti = zi[i]!;
        zi[i] = zi[j]!;
        zi[j] = ti;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let len = 2; len <= m; len <<= 1) {
      const half = len >> 1;
      const step = m / len; // twiddle stride into the m-point table
      for (let start = 0; start < m; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = cosM[k * step]!;
          const wi = sgn * sinM[k * step]!;
          const a = start + k;
          const b = a + half;
          const br = zr[b]! * wr - zi[b]! * wi;
          const bi = zr[b]! * wi + zi[b]! * wr;
          zr[b] = zr[a]! - br;
          zi[b] = zi[a]! - bi;
          zr[a] = zr[a]! + br;
          zi[a] = zi[a]! + bi;
        }
      }
    }
  }

  /**
   * Forward transform of `n` real samples read from `x[offset .. offset+n)`
   * into bins `re[0..m]`, `im[0..m]` (m = n/2). Unnormalised.
   */
  forward(x: ArrayLike<number>, re: Float32Array, im: Float32Array, offset = 0): void {
    const { m, zr, zi, cosN, sinN } = this;
    for (let k = 0; k < m; k++) {
      zr[k] = x[offset + 2 * k]!;
      zi[k] = x[offset + 2 * k + 1]!;
    }
    this.fftM(false);
    // Z[k] = E[k] + i·O[k]; E[k] = (Z[k] + conj Z[m−k])/2, O[k] = (Z[k] − conj Z[m−k])/(2i);
    // X[k] = E[k] + e^{−2πik/n}·O[k], with Z[m] ≡ Z[0].
    for (let k = 0; k <= m; k++) {
      const a = zr[k === m ? 0 : k]!;
      const b = zi[k === m ? 0 : k]!;
      const j = (m - k) % m;
      const c = zr[j]!;
      const d = zi[j]!;
      const er = 0.5 * (a + c);
      const ei = 0.5 * (b - d);
      const or = 0.5 * (b + d);
      const oi = -0.5 * (a - c);
      const cw = cosN[k]!;
      const sw = sinN[k]!;
      re[k] = er + (or * cw + oi * sw);
      im[k] = ei + (oi * cw - or * sw);
    }
  }

  /**
   * Inverse transform of bins `re[0..m]`, `im[0..m]` (Hermitian half of a real
   * signal's spectrum) into `n` real samples written to `x[offset .. offset+n)`.
   * Scaled by 1/n, so `inverse(forward(x)) == x`.
   */
  inverse(re: Float32Array, im: Float32Array, x: Float32Array, offset = 0): void {
    const { m, zr, zi, cosN, sinN } = this;
    // E[k] = (X[k] + conj X[m−k])/2; O[k] = (X[k] − conj X[m−k])/2 · e^{+2πik/n}; Z[k] = E[k] + i·O[k].
    for (let k = 0; k < m; k++) {
      const xr = re[k]!;
      const xi = im[k]!;
      const yr = re[m - k]!;
      const yi = im[m - k]!;
      const er = 0.5 * (xr + yr);
      const ei = 0.5 * (xi - yi);
      const dr = 0.5 * (xr - yr);
      const di = 0.5 * (xi + yi);
      const cw = cosN[k]!;
      const sw = sinN[k]!;
      const or = dr * cw - di * sw;
      const oi = dr * sw + di * cw;
      zr[k] = er - oi;
      zi[k] = ei + or;
    }
    this.fftM(true);
    const scale = 1 / m;
    for (let k = 0; k < m; k++) {
      x[offset + 2 * k] = zr[k]! * scale;
      x[offset + 2 * k + 1] = zi[k]! * scale;
    }
  }
}

/**
 * Periodic Hann window w[j] = 0.5 − 0.5·cos(2πj/n). The PERIODIC form (divide
 * by n, not n−1) is what makes w² sum to exactly 3n/8 · (4/n) = 1.5 across four
 * hop-n/4 shifts — the WOLA constant `HANN_HOP4_WOLA_GAIN`. Σw = n/2, Σw² = 3n/8.
 */
export function hannPeriodic(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let j = 0; j < n; j++) w[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / n);
  return w;
}

/**
 * Σ_{s=0..3} w²[j + s·n/4] for the periodic Hann window: w² = 3/8 − ½cos θ +
 * ⅛cos 2θ, and both cosine terms cancel over four quarter-period shifts, so
 * the sum is 4 · 3/8 = 1.5 at EVERY sample. Hann analysis × Hann synthesis at
 * 75 % overlap therefore reconstructs exactly after dividing by this constant.
 */
export const HANN_HOP4_WOLA_GAIN = 1.5;
