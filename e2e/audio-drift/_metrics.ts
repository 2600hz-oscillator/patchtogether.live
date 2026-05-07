// e2e/audio-drift/_metrics.ts
//
// Comparison metrics for two PCM audio buffers captured from two browser
// contexts running the same Yjs-synced patch. Implementations are kept
// dependency-free (no FFT lib) — for STFT we use a simple radix-2 FFT
// inlined here, which is sufficient for 1024-bin frame sizes.

export interface CompareMetrics {
  /** Pearson correlation in time domain. 1.0 = identical waveforms. */
  pearson: number;
  /** RMS(A - B) / RMS(A). Lower = more similar. */
  rmsDiff: number;
  /** Pearson correlation per STFT frame, averaged. More phase-tolerant. */
  spectralPearsonAvg: number;
  /** Worst-case (minimum) per-frame spectral pearson. */
  spectralPearsonWorst: number;
  /** Estimated phase drift in microseconds per second.
   *  Computed as the slope of cross-correlation peak position vs frame time. */
  phaseDriftUsPerSec: number;
  /** RMS of A (loudness reference). */
  rmsA: number;
  /** RMS of B. */
  rmsB: number;
}

export function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

export function pearson(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den === 0) return 0;
  return num / den;
}

export function rmsDiff(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  const rmsA = rms(a);
  if (rmsA === 0) return 0;
  return Math.sqrt(sum / n) / rmsA;
}

// ---------- Tiny radix-2 FFT (in-place). N must be a power of 2. ----------
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error('fft: N must be power of 2');
  // Bit-reverse permutation.
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wre = Math.cos(ang);
    const wim = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cre = 1;
      let cim = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const tre = cre * re[i + k + half] - cim * im[i + k + half];
        const tim = cre * im[i + k + half] + cim * re[i + k + half];
        re[i + k + half] = re[i + k] - tre;
        im[i + k + half] = im[i + k] - tim;
        re[i + k] = re[i + k] + tre;
        im[i + k] = im[i + k] + tim;
        const nre = cre * wre - cim * wim;
        cim = cre * wim + cim * wre;
        cre = nre;
      }
    }
  }
}

function magnitudeSpectrum(buf: Float32Array, fftSize: number): Float32Array {
  // Hann window.
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
    re[i] = (buf[i] ?? 0) * w;
  }
  fft(re, im);
  const halfBins = fftSize >> 1;
  const mag = new Float32Array(halfBins);
  for (let k = 0; k < halfBins; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

/**
 * Spectral correlation per STFT frame. Hop = fftSize/2 (50% overlap).
 * Returns { avg, worst } across all frames where both A and B have non-trivial energy.
 */
export function spectralCorrelation(
  a: Float32Array,
  b: Float32Array,
  fftSize = 1024,
): { avg: number; worst: number; frames: number } {
  const hop = fftSize >> 1;
  const n = Math.min(a.length, b.length);
  if (n < fftSize) return { avg: 0, worst: 0, frames: 0 };
  const corrs: number[] = [];
  // Energy threshold to skip silent frames (which produce undefined correlation).
  const silenceThreshold = 1e-5;
  for (let off = 0; off + fftSize <= n; off += hop) {
    const aSlice = a.subarray(off, off + fftSize);
    const bSlice = b.subarray(off, off + fftSize);
    if (rms(aSlice) < silenceThreshold && rms(bSlice) < silenceThreshold) continue;
    const magA = magnitudeSpectrum(aSlice, fftSize);
    const magB = magnitudeSpectrum(bSlice, fftSize);
    corrs.push(pearson(magA, magB));
  }
  if (corrs.length === 0) return { avg: 0, worst: 0, frames: 0 };
  const sum = corrs.reduce((s, c) => s + c, 0);
  const worst = corrs.reduce((m, c) => Math.min(m, c), 1);
  return { avg: sum / corrs.length, worst, frames: corrs.length };
}

/**
 * Estimate phase drift between A and B over time. Splits both into windows,
 * cross-correlates each pair, finds the lag (in samples) that maximizes
 * correlation, and fits a line to (windowStartTime, lag). Slope = drift rate
 * in samples/sec → convert to microseconds per second.
 */
export function phaseDrift(
  a: Float32Array,
  b: Float32Array,
  sampleRate: number,
  windowSize = 8192,
  maxLagSamples = 256,
): number {
  const n = Math.min(a.length, b.length);
  if (n < windowSize * 2) return 0;
  const numWindows = Math.floor(n / windowSize);
  if (numWindows < 3) return 0;
  const lags: number[] = [];
  const times: number[] = [];
  for (let w = 0; w < numWindows; w++) {
    const off = w * windowSize;
    if (off + windowSize > n) break;
    const aw = a.subarray(off, off + windowSize);
    const bw = b.subarray(off, off + windowSize);
    if (rms(aw) < 1e-4 || rms(bw) < 1e-4) continue;
    let bestLag = 0;
    let bestCorr = -Infinity;
    for (let lag = -maxLagSamples; lag <= maxLagSamples; lag++) {
      let corr = 0;
      let count = 0;
      for (let i = 0; i < windowSize; i++) {
        const j = i + lag;
        if (j < 0 || j >= windowSize) continue;
        corr += aw[i] * bw[j];
        count++;
      }
      const norm = count > 0 ? corr / count : 0;
      if (norm > bestCorr) {
        bestCorr = norm;
        bestLag = lag;
      }
    }
    lags.push(bestLag);
    times.push(off / sampleRate);
  }
  if (lags.length < 2) return 0;
  // Linear regression: lag(samples) = slope * time(s) + intercept.
  // slope is samples/sec drift; convert to μs/sec via /sampleRate * 1e6.
  let meanT = 0;
  let meanL = 0;
  for (let i = 0; i < lags.length; i++) {
    meanT += times[i];
    meanL += lags[i];
  }
  meanT /= lags.length;
  meanL /= lags.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < lags.length; i++) {
    num += (times[i] - meanT) * (lags[i] - meanL);
    den += (times[i] - meanT) ** 2;
  }
  const slopeSamplesPerSec = den === 0 ? 0 : num / den;
  return (slopeSamplesPerSec / sampleRate) * 1e6;
}

export function compare(
  a: Float32Array,
  b: Float32Array,
  sampleRate: number,
): CompareMetrics {
  const sc = spectralCorrelation(a, b);
  return {
    pearson: pearson(a, b),
    rmsDiff: rmsDiff(a, b),
    spectralPearsonAvg: sc.avg,
    spectralPearsonWorst: sc.worst,
    phaseDriftUsPerSec: phaseDrift(a, b, sampleRate),
    rmsA: rms(a),
    rmsB: rms(b),
  };
}

/** Verbal verdict per the brief's decision framework.
 *
 * Spectral correlation is the *primary* judge of "are these the same musical
 * content?" — a 90° phase shift drops time-domain pearson to ~0 but leaves
 * spectral correlation at 1.0 (same harmonics, just shifted in time). For
 * humans listening to two systems play the same patch, that's "identical".
 *
 * Time-domain pearson + RMS difference are the *secondary* "are these
 * sample-identical?" check — passing both means the two systems are
 * byte-deterministic (a stronger property than "musically equivalent").
 */
export function verdict(m: CompareMetrics): string {
  if (m.rmsA < 1e-5 && m.rmsB < 1e-5) return 'silent (no audio)';
  if (m.rmsA < 1e-5 || m.rmsB < 1e-5) return 'drastically different';

  // Sample-identical: rare but worth flagging.
  if (m.pearson >= 0.99 && m.rmsDiff <= 0.01) return 'sample-identical';

  // Spectrally identical = same musical content. Tier by worst-frame to
  // catch transient divergence (e.g. one drum hit lands a frame later).
  if (m.spectralPearsonAvg >= 0.98 && m.spectralPearsonWorst >= 0.9)
    return 'musically equivalent';
  if (m.spectralPearsonAvg >= 0.95) return 'musically similar (minor transient mismatch)';
  if (m.spectralPearsonAvg >= 0.85) return 'audibly similar (same patch, different timing)';
  if (m.spectralPearsonAvg >= 0.7) return 'audibly different';
  return 'drastically different';
}
