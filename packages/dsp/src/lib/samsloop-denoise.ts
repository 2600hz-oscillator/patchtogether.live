// SAMSLOOP "denoise" core — offline STFT spectral gating with a
// decision-directed Wiener gain, profiled from the sample itself.
//
// OWN CODE — CLEAN-ROOM (docs/adr/018 provenance posture). Implemented from
// the published algorithms only: spectral subtraction's shape (Boll 1979,
// IEEE TASSP 27(2)), the decision-directed a-priori SNR recursion (Ephraim &
// Malah 1984, IEEE TASSP 32(6)), the Wiener gain rule, and the "the sample is
// its own noise clip" per-bin quantile profile (the noisereduce / Audacity
// Noise Reduction shape; WebRTC's QuantileNoiseEstimator online). NOT a port
// of SoX `noisered` (GPL), Audacity's `NoiseReduction.cpp` (GPL), noisereduce
// (MIT — technique only, no code read into this file), or WebRTC.
//
// Pipeline (one press, no parameters, no region selector):
//   1. Refuse if any sample is non-finite. Then take the buffer MEAN out of
//      every frame and put it back on the output: a DC offset is not hiss
//      (NORMALIZE removes it, and reports it), but left in the frames it
//      leaks through the Hann window into bins 0–3, the ±2-bin profile
//      smoothing lifts the "floor" there 7–14 dB above the real hiss, the
//      gains read the offset as signal, and the gap frames' power is then the
//      OFFSET's — an offset within ~6 dB of the hiss RMS refused a hissy vocal
//      as a pad (found by the reviewer on this PR's own e2e fixture; the
//      face runs DENOISE before NORMALIZE, so the offset is still there).
//   2. STFT: periodic Hann analysis, hop n/4 (75 % overlap), n derived from
//      the rate as the power of two nearest DENOISE_WINDOW_S (1024 @ 24 kHz,
//      2048 @ 44.1/48 kHz). 3·hop zeros are padded at both ends so EVERY
//      output sample is covered by four frames; Hann synthesis then
//      reconstructs exactly after dividing by HANN_HOP4_WOLA_GAIN = 1.5.
//   3. Noise profile λ[k]: per-bin histogram (0.5 dB cells) of the frame
//      periodogram over the POPULATION (frames fully inside the sample whose
//      RMS ≥ DENOISE_SILENCE_RMS — DAW-rendered digital silence must not drag
//      the quantile to zero; the padded edge frames are excluded for the same
//      reason). λ[k] = (DENOISE_QUANTILE quantile) × DENOISE_QUANTILE_BIAS,
//      then the log profile is smoothed ±DENOISE_PROFILE_SMOOTH_BINS bins.
//      FFT SCALING, stated: the periodogram is |X[k]|² / Σw² (Σw² = 3n/8 for
//      the periodic Hann), so a white noise of variance σ² reads E[P] = σ² in
//      every bin — the profile's mean across bins IS the hiss RMS in dBFS
//      (`noiseFloorDb`) — and a full-scale sine reads A²·n/6 (+25.3 dB @2048).
//      The histogram spans [−150, +30] dB, which covers both extremes.
//      BIAS: each bin of a Gaussian-noise periodogram is exponential with mean
//      λ, whose Q-quantile is −λ·ln(1−Q); the raw quantile therefore sits
//      6.5 dB UNDER the true floor at Q = 0.2 and 1/(−ln 0.8) = 4.48 corrects
//      it (WebRTC ships the raw log-quantile; this correction is derived here).
//   4. Gain: γ = P/λ; decision-directed ξ̂ = α·(G_prev²·γ_prev) +
//      (1−α)·max(γ−1, 0); G = clamp(ξ̂/(OVER + ξ̂), FLOOR, 1) with α = 0.98,
//      OVER = 1 (no over-subtraction), FLOOR = 0.25 (−12 dB). Run FORWARD and
//      BACKWARD in time and take max(G_f, G_b): the forward recursion lags one
//      hop at every onset (the "softened consonant" of online suppressors) and
//      the offline backward pass removes the smear with no lookahead machinery.
//      Cappé 1994 is the finding that the DD recursion — not the gain rule —
//      is what suppresses musical noise: in a noise-only bin ξ̂ ≈
//      0.98·FLOOR² + 0.02·max(γ−1, 0) never lifts G off the floor for the χ²
//      excursions of a noise periodogram (γ up to ~4.6 at the 99th percentile).
//      No cross-bin gain smoothing (WebRTC ships none; the dossier's judge
//      measured no benefit).
//   5. PAD / DRONE REFUSAL (owner ruling 2026-09-15 Q4) — decided on the
//      gains BEFORE anything is written. A sustained pad has no frames
//      where the noise stands alone, so the quantile lands on the
//      pad's own partials, the "noise" IS the signal, and the transform is a
//      uniform level drop (every design in the dossier measured −2…−12 dB on
//      a pad). The guard is the judge's reinstated SPREAD test, on the
//      PER-FRAME projected reduction r[f] = 10·log10(Σ_k P / Σ_k G²P) of every
//      population frame (spectral domain, so nothing is synthesised first),
//      EQUAL-WEIGHTED: the spread is the 90th percentile of r minus the 5th
//      (DENOISE_SPREAD_PERCENTILES). A real floor is removed from the gaps
//      (≈ 12 dB, the floor depth) and left alone under the signal (≈ 0 dB);
//      a pad, a drone, pure hiss, a clean sample and a vowel with no pauses
//      all reduce every frame by the same amount. Refuse below
//      DENOISE_MIN_SPREAD_DB (the measurement is at the constant). Two
//      statistics were measured first and rejected: a "floor within N dB of
//      the signal's band energy" does NOT separate (a line spectrum's
//      smoothed profile sits UNDER its own partials, so the pad scores above
//      pure hiss on it); and a POWER-weighted reduction over the quietest
//      fifth of frames minus the loudest fifth refused a correct denoise as
//      soon as the gaps were ≤ 20 % of the take — one voiced frame in the
//      "quiet" fifth outweighs every gap frame in a power sum (the reviewer's
//      finding). The pair is ASYMMETRIC on purpose: the top is p90, not p95,
//      because a CLEAN take's syllable edges (the frames straddling a release
//      into digital silence) are a thin tail of deeply gated frames — p95 of
//      a clean ten-syllable phrase reads 8.4 dB, p90 3.7 — while a real floor
//      is a CLUSTER of frames at the gate depth; the bottom is p5 so a sparse
//      take (one word in a long tail) needs only a twentieth of its frames
//      to be signal. `reductionDb` in the result is the p90: the gaps.
//   6. Synthesis into a separate buffer, then copied into `x` — a refusal or
//      a throw never leaves a half-written sample.
//
// Scratch memory: P and G, each frames × (n/2 + 1) Float32, plus the output
// copy: ~60 MB at the 2.88 M-frame 48 kHz record cap, ~37 MB at the 1.5 M
// upload cap — freed on return. Every gain ≤ 1 (never adds energy) and ≥
// FLOOR (never zeroes a bin); no RNG, byte-identical across runs; length
// preserved.

import { HANN_HOP4_WOLA_GAIN, RealFft, hannPeriodic } from './real-fft';

/** STFT window length in seconds; n = the power of two nearest rate·WINDOW_S (1024 @ 24 kHz). */
export const DENOISE_WINDOW_S = 1024 / 24_000;
/** Ephraim–Malah decision-directed smoothing (WebRTC, logmmse: 0.98). */
export const DENOISE_ALPHA = 0.98;
/** Minimum gain, −12.04 dB (WebRTC 12 dB level; FFmpeg afftdn nr=12). */
export const DENOISE_FLOOR = 0.25;
/** Over-subtraction factor in the Wiener rule (WebRTC 12 dB level: 1.0). */
export const DENOISE_OVERSUB = 1.0;
/** Per-bin quantile of the periodogram taken as the noise level (WebRTC: 0.25; 0.20 favours trimmed one-shots). */
export const DENOISE_QUANTILE = 0.2;
/** Exponential-distribution correction: mean = quantile / (−ln(1 − Q)). */
export const DENOISE_QUANTILE_BIAS = 1 / -Math.log(1 - DENOISE_QUANTILE);
/** ± bins of log-profile smoothing (a jagged profile is a jagged gain). */
export const DENOISE_PROFILE_SMOOTH_BINS = 2;
/** Frames below this RMS are digital silence and leave the profile population. */
export const DENOISE_SILENCE_RMS = 10 ** (-90 / 20);
/** Minimum population frames: 24 × hop (≈ 0.29 s at every rate, since n/rate ≈ 43 ms). */
export const DENOISE_MIN_FRAMES = 24;
/** The percentile pair of the per-frame reduction the spread guard reads: the
 *  frames that lose the MOST (the gaps — at least a TENTH of the population
 *  must sit at the floor, so a clean take's thin tail of gated syllable edges
 *  does not count as one) against the frames that lose the LEAST (the signal,
 *  bottom 5 %); `reductionDb` in the result is the top. */
export const DENOISE_SPREAD_PERCENTILES = [0.05, 0.9] as const;
/**
 * Pad / drone refusal line: the frames that lose the most must lose at least
 * this much more than the frames that lose the least — half the gate depth —
 * otherwise the press is a level change, not a denoise.
 * MEASURED (samsloop-denoise.test.ts fixtures, 24 kHz, p90 − p5 of the
 * per-frame reduction in dB — `denoiseSpreadDb` is the instrument, and the
 * suite pins every row and prints it): REFUSED — steady 5-partial pad 0.05,
 * the same pad with ±2 % vibrato 0.3, pad + white hiss −40 dBFS 0.1, pure
 * white hiss 0.3, pure pink hiss 3.5, a clean vocal (5 syllables, no hiss)
 * 2.0, a clean ten-syllable phrase 3.7, a continuous vowel + hiss with no
 * pauses 0.5; ALLOWED — vocal phrase (37 % gaps) + white hiss at −30/−40/−50
 * dBFS 11.6/11.9/12.0, + pink −40 dBFS 11.9, the same phrase with a +0.01 /
 * +0.02 / +0.05 DC offset (≥ the hiss RMS) 11.9, a 38 %-duty phrase 11.9, a
 * 13 %-duty phrase 11.9. GAP-FRACTION BOUNDARY (vocal + white −40 dBFS, gaps
 * = the stated fraction of the take): with 5 syllables 40 / 30 / 25 / 20 /
 * 15 % allowed (spread 11.9…10.6, SNR gain 6.5…2.9 dB, formants within 0.3
 * dB), 12 / 10 / 5 % refused (4.3 / 1.8 / 0.9 — and there the SNR gain is
 * 1.1 / 0.1 / −3.6 dB with the formants moving 0.6 / 0.8 / 1.7 dB: the Q =
 * 0.2 quantile no longer lands on the hiss, the profile is the voice's own
 * quiet bins, and the refusal is CORRECT); with 10 syllables 20 % allowed,
 * 15 % is the line (6.0), 12 % refused. In words: the pauses must be about a
 * sixth of the take or more.
 */
export const DENOISE_MIN_SPREAD_DB = 6;

const HIST_MIN_DB = -150;
const HIST_MAX_DB = 30;
const HIST_CELL_DB = 0.5;
const HIST_CELLS = Math.round((HIST_MAX_DB - HIST_MIN_DB) / HIST_CELL_DB);

export type DenoiseResult =
  | { ok: true; noiseFloorDb: number; reductionDb: number }
  | { ok: false; reason: 'no-steady-noise-floor' | 'too-short' | 'not-finite' };

/** STFT size for a sample rate: the power of two nearest rate·DENOISE_WINDOW_S, clamped [256, 8192]. */
export function denoiseStftSize(sampleRate: number): number {
  const raw = 2 ** Math.round(Math.log2(sampleRate * DENOISE_WINDOW_S));
  return Math.min(8192, Math.max(256, raw));
}

/** In place. On `ok: false` the buffer is byte-identical to the input. */
export function denoiseSample(x: Float32Array, sampleRate: number): DenoiseResult {
  return runDenoise(x, sampleRate, DENOISE_FLOOR, true);
}

/**
 * TEST INSTRUMENT: the same pipeline with an explicit gain floor and the pad
 * guard OFF (a floor of 1 makes every gain exactly 1, which the guard would
 * refuse as a level change). `floor = 1` ⇒ the output must equal the input —
 * that pins the STFT/WOLA reconstruction through the real framing code, not a
 * model of it. Production callers use `denoiseSample`.
 */
export function denoiseSampleWithFloor(x: Float32Array, sampleRate: number, floor: number): DenoiseResult {
  return runDenoise(x, sampleRate, floor, false);
}

/**
 * TEST INSTRUMENT: the per-frame projected reductions (dB, ASCENDING) the pad
 * guard decides on, with the gains of `denoiseSample` and NOTHING written —
 * `x` is read only. Empty when the take is too short or non-finite. The
 * boundary table at DENOISE_MIN_SPREAD_DB is measured on it.
 */
export function denoiseFrameReductionsDb(x: Float32Array, sampleRate: number): number[] {
  const out: { value: number[] } = { value: [] };
  runDenoise(x.slice(), sampleRate, DENOISE_FLOOR, true, out);
  return out.value;
}

/** `sorted[q · (N − 1)]` — the percentile the guard reads, on an ascending array. */
export function denoisePercentile(sorted: ArrayLike<number>, q: number): number {
  return sorted[Math.floor(q * (sorted.length - 1))]!;
}

/** The guard's spread: p90 − p5 of the per-frame reduction. */
export function denoiseSpreadDb(x: Float32Array, sampleRate: number): number {
  const r = denoiseFrameReductionsDb(x, sampleRate);
  if (r.length === 0) return NaN;
  return denoisePercentile(r, DENOISE_SPREAD_PERCENTILES[1]) - denoisePercentile(r, DENOISE_SPREAD_PERCENTILES[0]);
}

function runDenoise(
  x: Float32Array,
  sampleRate: number,
  floor: number,
  guard: boolean,
  reductionsOut?: { value: number[] },
): DenoiseResult {
  const len = x.length;
  let mean = 0;
  for (let i = 0; i < len; i++) {
    const v = x[i]!;
    if (!Number.isFinite(v)) return { ok: false, reason: 'not-finite' };
    mean += v;
  }
  mean = len > 0 ? mean / len : 0;

  const n = denoiseStftSize(sampleRate);
  const m = n >> 1;
  const bins = m + 1;
  const hop = n >> 2;
  const pad = n - hop; // 3·hop
  const frames = Math.ceil(len / hop) + 3;
  const fft = new RealFft(n);
  const w = hannPeriodic(n);
  const sumW2 = (3 * n) / 8;
  const sumW2Db = 10 * Math.log10(sumW2);
  const frame = new Float32Array(n);
  const re = new Float32Array(bins);
  const im = new Float32Array(bins);

  const loadFrame = (f: number): number => {
    const s = f * hop - pad;
    let acc = 0;
    for (let j = 0; j < n; j++) {
      const i = s + j;
      const v = i >= 0 && i < len ? x[i]! - mean : 0;
      acc += v * v;
      frame[j] = v * w[j]!;
    }
    return Math.sqrt(acc / n);
  };

  // ── Pass 1: periodogram + population ────────────────────────────────────
  const P = new Float32Array(frames * bins);
  const inside = new Uint8Array(frames);
  let population = 0;
  for (let f = 0; f < frames; f++) {
    const rms = loadFrame(f);
    const s = f * hop - pad;
    if (s >= 0 && s + n <= len && rms >= DENOISE_SILENCE_RMS) {
      inside[f] = 1;
      population++;
    }
    fft.forward(frame, re, im);
    const base = f * bins;
    for (let k = 0; k < bins; k++) P[base + k] = re[k]! * re[k]! + im[k]! * im[k]!;
  }
  if (population < DENOISE_MIN_FRAMES) return { ok: false, reason: 'too-short' };

  // ── Noise profile: per-bin histogram quantiles ──────────────────────────
  const hist = new Uint32Array(bins * HIST_CELLS);
  for (let f = 0; f < frames; f++) {
    if (!inside[f]) continue;
    const base = f * bins;
    for (let k = 0; k < bins; k++) {
      const db = 10 * Math.log10(P[base + k]! + 1e-30) - sumW2Db;
      let c = Math.floor((db - HIST_MIN_DB) / HIST_CELL_DB);
      if (c < 0) c = 0;
      else if (c >= HIST_CELLS) c = HIST_CELLS - 1;
      hist[k * HIST_CELLS + c]++;
    }
  }
  const qNoise = Math.ceil(DENOISE_QUANTILE * population);
  const profileDb = new Float64Array(bins); // normalised units, bias-corrected, unsmoothed
  const biasDb = 10 * Math.log10(DENOISE_QUANTILE_BIAS);
  for (let k = 0; k < bins; k++) {
    let cum = 0;
    let cNoise = 0;
    for (let c = 0; c < HIST_CELLS; c++) {
      cum += hist[k * HIST_CELLS + c]!;
      if (cum >= qNoise) {
        cNoise = c;
        break;
      }
    }
    profileDb[k] = HIST_MIN_DB + (cNoise + 0.5) * HIST_CELL_DB + biasDb;
  }
  const smoothDb = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let acc = 0;
    let cnt = 0;
    for (let d = -DENOISE_PROFILE_SMOOTH_BINS; d <= DENOISE_PROFILE_SMOOTH_BINS; d++) {
      const j = k + d;
      if (j < 0 || j >= bins) continue;
      acc += profileDb[j]!;
      cnt++;
    }
    smoothDb[k] = acc / cnt;
  }

  // ── Floor readout: mean profile across bins = the hiss RMS in dBFS ──────
  let floorLin = 0;
  for (let k = 0; k < bins; k++) floorLin += 10 ** (smoothDb[k]! / 10);
  const noiseFloorDb = 10 * Math.log10(floorLin / bins);

  // Profile back in raw periodogram units, floored so γ is always finite.
  const lambda = new Float64Array(bins);
  for (let k = 0; k < bins; k++) lambda[k] = Math.max(1e-20, 10 ** ((smoothDb[k]! + sumW2Db) / 10));

  // ── Decision-directed Wiener gains, backward then forward, max ──────────
  const G = new Float32Array(frames * bins);
  const prevClean = new Float64Array(bins);
  const oneMinusAlpha = 1 - DENOISE_ALPHA;
  const ddGain = (base: number, k: number): number => {
    const gamma = P[base + k]! / lambda[k]!;
    let xi = DENOISE_ALPHA * prevClean[k]! + oneMinusAlpha * Math.max(gamma - 1, 0);
    let g = xi / (DENOISE_OVERSUB + xi);
    if (g < floor) g = floor;
    else if (g > 1) g = 1;
    prevClean[k] = g * g * gamma;
    return g;
  };
  prevClean.fill(floor * floor);
  for (let f = frames - 1; f >= 0; f--) {
    const base = f * bins;
    for (let k = 0; k < bins; k++) G[base + k] = ddGain(base, k);
  }
  prevClean.fill(floor * floor);
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let k = 0; k < bins; k++) {
      const gf = ddGain(base, k);
      if (gf > G[base + k]!) G[base + k] = gf;
    }
  }

  // ── Spread guard: per-frame projected reduction, p95 − p5, equal weight ──
  const reduction: number[] = [];
  for (let f = 0; f < frames; f++) {
    if (!inside[f]) continue;
    const base = f * bins;
    let inPow = 0;
    let outPow = 0;
    for (let k = 0; k < bins; k++) {
      const wgt = k === 0 || k === m ? 1 : 2; // Hermitian half: interior bins count twice
      const p = wgt * P[base + k]!;
      const g = G[base + k]!;
      inPow += p;
      outPow += g * g * p;
    }
    reduction.push(10 * Math.log10(inPow / outPow));
  }
  reduction.sort((a, b) => a - b);
  const lowReductionDb = denoisePercentile(reduction, DENOISE_SPREAD_PERCENTILES[0]);
  const reductionDb = denoisePercentile(reduction, DENOISE_SPREAD_PERCENTILES[1]);
  const spreadDb = reductionDb - lowReductionDb;
  if (reductionsOut) {
    reductionsOut.value = reduction;
    return { ok: true, noiseFloorDb, reductionDb };
  }
  if (guard && !(spreadDb >= DENOISE_MIN_SPREAD_DB)) {
    return { ok: false, reason: 'no-steady-noise-floor' };
  }

  // ── Synthesis (Hann WOLA) into a fresh buffer, then commit ──────────────
  const y = new Float32Array(len);
  const invGain = 1 / HANN_HOP4_WOLA_GAIN;
  for (let f = 0; f < frames; f++) {
    loadFrame(f);
    fft.forward(frame, re, im);
    const base = f * bins;
    for (let k = 0; k < bins; k++) {
      const g = G[base + k]!;
      re[k] = re[k]! * g;
      im[k] = im[k]! * g;
    }
    fft.inverse(re, im, frame);
    const s = f * hop - pad;
    const j0 = Math.max(0, -s);
    const j1 = Math.min(n, len - s);
    for (let j = j0; j < j1; j++) y[s + j] = y[s + j]! + frame[j]! * w[j]! * invGain;
  }
  // The offset goes back on: DENOISE removes hiss, NORMALIZE removes DC.
  if (mean !== 0) for (let i = 0; i < len; i++) y[i] = y[i]! + mean;
  x.set(y);
  return { ok: true, noiseFloorDb, reductionDb };
}
