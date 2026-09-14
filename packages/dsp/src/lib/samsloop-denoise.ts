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
//   1. Refuse if any sample is non-finite.
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
//      a pad). The guard is the judge's reinstated SPREAD test: the projected
//      reduction (Σ G²P / Σ P, spectral domain, so nothing is synthesised
//      first) over the QUIETEST DENOISE_QUIET_FRACTION of population frames
//      minus the same over the LOUDEST fraction. A real floor is removed from
//      the gaps (≈ 12 dB, the floor depth) and left alone under the signal
//      (≈ 0 dB); a pad, a drone, pure hiss, a clean sample and a vowel with no
//      pauses all reduce every frame by the same amount. Refuse below
//      DENOISE_MIN_SPREAD_DB (the measurement is at the constant). A
//      "floor within N dB of the signal's band energy" statistic was measured
//      first and does NOT separate: a line spectrum's smoothed profile sits
//      UNDER its own partials, so the pad scores above pure hiss on it.
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
/** Fraction of population frames (quietest / loudest) the spread guard and the readout use. */
export const DENOISE_QUIET_FRACTION = 0.2;
/**
 * Pad / drone refusal line: the quietest fifth of the sample must lose at
 * least this much more than the loudest fifth — half the gate depth —
 * otherwise the press is a level change, not a denoise.
 * MEASURED (samsloop-denoise.test.ts fixtures, 24 kHz, projected spread in dB):
 * steady 5-partial pad −0.05, the same pad with ±2 % vibrato 0.00, pad + white
 * hiss −40 dBFS −0.05, pure white hiss 0.12, pure pink hiss 2.73, clean vocal
 * (no hiss) 0.84, a continuous vowel + hiss with no pauses 0.13 — all refused;
 * vocal phrase + white hiss at −30/−40/−50 dBFS 11.57/11.86/11.84, + pink
 * −40 dBFS 11.81, a 38 %-duty phrase 11.85, a 13 %-duty phrase 11.84 — all
 * allowed. 6 dB sits 3.3 dB above the worst refusal and 5.6 dB below the worst
 * allowed case.
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

function runDenoise(x: Float32Array, sampleRate: number, floor: number, guard: boolean): DenoiseResult {
  const len = x.length;
  for (let i = 0; i < len; i++) if (!Number.isFinite(x[i]!)) return { ok: false, reason: 'not-finite' };

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
      const v = i >= 0 && i < len ? x[i]! : 0;
      acc += v * v;
      frame[j] = v * w[j]!;
    }
    return Math.sqrt(acc / n);
  };

  // ── Pass 1: periodogram + population ────────────────────────────────────
  const P = new Float32Array(frames * bins);
  const frameRms = new Float32Array(frames);
  const inside = new Uint8Array(frames);
  let population = 0;
  for (let f = 0; f < frames; f++) {
    const rms = loadFrame(f);
    frameRms[f] = rms;
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

  // ── Spread guard: quietest fifth vs loudest fifth (projected, spectral) ──
  const order: number[] = [];
  for (let f = 0; f < frames; f++) if (inside[f]) order.push(f);
  order.sort((a, b) => frameRms[a]! - frameRms[b]!);
  const fifth = Math.max(1, Math.ceil(DENOISE_QUIET_FRACTION * population));
  const projectedReductionDb = (from: number, to: number): number => {
    let inPow = 0;
    let outPow = 0;
    for (let q = from; q < to; q++) {
      const base = order[q]! * bins;
      for (let k = 0; k < bins; k++) {
        const wgt = k === 0 || k === m ? 1 : 2; // Hermitian half: interior bins count twice
        const p = wgt * P[base + k]!;
        const g = G[base + k]!;
        inPow += p;
        outPow += g * g * p;
      }
    }
    return 10 * Math.log10(inPow / outPow);
  };
  const reductionDb = projectedReductionDb(0, fifth);
  const loudReductionDb = projectedReductionDb(order.length - fifth, order.length);
  if (guard && !(reductionDb - loudReductionDb >= DENOISE_MIN_SPREAD_DB)) {
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
  x.set(y);
  return { ok: true, noiseFloorDb, reductionDb };
}
