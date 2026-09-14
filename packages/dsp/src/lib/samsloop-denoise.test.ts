// Pins the denoise core on SYNTHETIC fixtures whose clean part is known, so
// SNR is a real number, not a listening claim:
//   • vocal = a sung phrase of five syllables (3-formant vowel, f0 glide +
//     5.5 Hz vibrato, syllable envelope, 37 % gaps) — enough per-bin movement
//     that the 20 % quantile lands on the hiss, which is what a vocal take
//     has and a pad does not;
//   • hiss = seeded white or pink noise at −30 / −40 / −50 dBFS RMS;
//   • pad = a sustained 5-partial drone with no noise — the owner-ruled
//     refusal case ('no-steady-noise-floor', buffer byte-identical).
// Every assertion states its margin; the floor-1 identity leg is the
// reconstruction instrument (its negative control is floor 0.25 changing
// the output).

import { describe, expect, it } from 'vitest';
import {
  DENOISE_FLOOR,
  DENOISE_MIN_SPREAD_DB,
  denoiseSample,
  denoiseSampleWithFloor,
  denoiseStftSize,
} from './samsloop-denoise';
import { RealFft } from './real-fft';
import { mulberry32 } from './noise-dsp';

export const SR = 24_000;
const SECONDS = 3;
const LEN = SR * SECONDS;

/** Syllable schedule (seconds): [start, end) pairs, gaps between. */
export const SYLLABLES: ReadonlyArray<readonly [number, number]> = [
  [0.1, 0.48],
  [0.7, 1.08],
  [1.3, 1.68],
  [1.9, 2.28],
  [2.5, 2.88],
];
export const FORMANTS: ReadonlyArray<readonly [number, number]> = [
  [700, 80],
  [1200, 100],
  [2600, 150],
];

function formantEnvelope(hz: number): number {
  let a = 0;
  for (const [f, bw] of FORMANTS) a += 1 / (1 + ((hz - f) / bw) ** 2);
  return a;
}

/** Additive 3-formant vowel phrase, peak 0.5, deterministic. */
export function synthVocal(schedule: ReadonlyArray<readonly [number, number]> = SYLLABLES): Float32Array {
  const out = new Float32Array(LEN);
  for (const [t0, t1] of schedule) {
    const i0 = Math.round(t0 * SR);
    const i1 = Math.round(t1 * SR);
    let phase = 0;
    for (let i = i0; i < i1; i++) {
      const t = i / SR;
      const u = (i - i0) / (i1 - i0);
      const f0 = (140 - 20 * u) * (1 + 0.03 * Math.sin(2 * Math.PI * 5.5 * t));
      phase += (2 * Math.PI * f0) / SR;
      const att = Math.min(1, (i - i0) / (0.01 * SR));
      const rel = Math.min(1, (i1 - i) / (0.06 * SR));
      const env = att * rel;
      let v = 0;
      for (let h = 1; h * f0 < 5000; h++) v += (formantEnvelope(h * f0) / Math.sqrt(h)) * Math.sin(h * phase);
      out[i] = v * env;
    }
  }
  let p = 0;
  for (let i = 0; i < LEN; i++) p = Math.max(p, Math.abs(out[i]!));
  for (let i = 0; i < LEN; i++) out[i] = (out[i]! / p) * 0.5;
  return out;
}

/** Sustained 5-partial drone at 110 Hz, peak 0.5, no noise; optional vibrato depth (fraction). */
export function synthPad(vibrato = 0): Float32Array {
  const out = new Float32Array(LEN);
  const amps = [1, 0.6, 0.4, 0.3, 0.2];
  let phase = 0;
  for (let i = 0; i < LEN; i++) {
    const t = i / SR;
    const f0 = 110 * (1 + vibrato * Math.sin(2 * Math.PI * 5 * t));
    phase += (2 * Math.PI * f0) / SR;
    let v = 0;
    for (let h = 0; h < 5; h++) v += amps[h]! * Math.sin((h + 1) * phase);
    out[i] = v;
  }
  let p = 0;
  for (let i = 0; i < LEN; i++) p = Math.max(p, Math.abs(out[i]!));
  for (let i = 0; i < LEN; i++) out[i] = (out[i]! / p) * 0.5;
  return out;
}

export function whiteNoise(len: number, rmsDb: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(len);
  // Sum of 12 uniforms ≈ Gaussian (variance 1); scale to the requested RMS.
  const rms = 10 ** (rmsDb / 20);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let j = 0; j < 12; j++) s += rnd();
    out[i] = (s - 6) * rms;
  }
  return out;
}

const PINK_HPF_HZ = 20;

/** Pink (1/f power) noise by spectral shaping of seeded white noise, scaled to the requested RMS. */
export function pinkNoise(len: number, rmsDb: number, seed: number): Float32Array {
  const n = 2 ** Math.ceil(Math.log2(len));
  const white = new Float32Array(n);
  white.set(whiteNoise(len, 0, seed));
  const fft = new RealFft(n);
  const re = new Float32Array(n / 2 + 1);
  const im = new Float32Array(n / 2 + 1);
  fft.forward(white, re, im);
  // 1/f power below PINK_HPF_HZ is infrasonic wander, not hiss — a recording chain high-passes it.
  const kLo = Math.ceil((PINK_HPF_HZ / SR) * n);
  for (let k = 0; k <= n / 2; k++) {
    const s = k < kLo ? 0 : 1 / Math.sqrt(k);
    re[k] = re[k]! * s;
    im[k] = im[k]! * s;
  }
  fft.inverse(re, im, white);
  const out = white.subarray(0, len).slice();
  const cur = rms(out);
  const want = 10 ** (rmsDb / 20);
  for (let i = 0; i < len; i++) out[i] = (out[i]! / cur) * want;
  return out;
}

export function add(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! + b[i]!;
  return out;
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let acc = 0;
  for (let i = from; i < to; i++) acc += x[i]! * x[i]!;
  return Math.sqrt(acc / Math.max(1, to - from));
}

function db(v: number): number {
  return 20 * Math.log10(v);
}

/** SNR of `y` against the known clean `s`: everything that is not s is error. */
export function snrDb(y: Float32Array, s: Float32Array): number {
  let sig = 0;
  let err = 0;
  for (let i = 0; i < y.length; i++) {
    sig += s[i]! * s[i]!;
    const e = y[i]! - s[i]!;
    err += e * e;
  }
  return 10 * Math.log10(sig / err);
}

/** Energy in [lo, hi) Hz of the whole signal (zero-padded FFT), in dB. */
export function bandDb(x: Float32Array, lo: number, hi: number): number {
  const n = 2 ** Math.ceil(Math.log2(x.length));
  const buf = new Float32Array(n);
  buf.set(x);
  const fft = new RealFft(n);
  const re = new Float32Array(n / 2 + 1);
  const im = new Float32Array(n / 2 + 1);
  fft.forward(buf, re, im);
  const k0 = Math.round((lo / SR) * n);
  const k1 = Math.round((hi / SR) * n);
  let acc = 0;
  for (let k = k0; k < k1; k++) acc += re[k]! * re[k]! + im[k]! * im[k]!;
  return 10 * Math.log10(acc);
}

/** RMS over the gaps between syllables, 50 ms inside each edge. */
export function gapRms(x: Float32Array): number {
  let acc = 0;
  let cnt = 0;
  for (let s = 0; s < SYLLABLES.length - 1; s++) {
    const i0 = Math.round((SYLLABLES[s]![1] + 0.05) * SR);
    const i1 = Math.round((SYLLABLES[s + 1]![0] - 0.05) * SR);
    for (let i = i0; i < i1; i++) {
      acc += x[i]! * x[i]!;
      cnt++;
    }
  }
  return Math.sqrt(acc / cnt);
}

describe('denoiseStftSize', () => {
  it('derives 1024 at 24 kHz and 2048 at 44.1 / 48 kHz from the window length, never hand-typed', () => {
    expect(denoiseStftSize(24_000)).toBe(1024);
    expect(denoiseStftSize(22_050)).toBe(1024);
    expect(denoiseStftSize(44_100)).toBe(2048);
    expect(denoiseStftSize(48_000)).toBe(2048);
    expect(denoiseStftSize(96_000)).toBe(4096);
  });
});

describe('denoiseSample — vocal + hiss', () => {
  const clean = synthVocal();
  const cases: Array<[string, Float32Array, number, number]> = [
    // label, noise, min SNR improvement dB, min gap attenuation dB.
    // MEASURED SNR gains (deterministic fixtures): 7.0 / 6.2 / 5.3 / 4.4 dB —
    // the gain shrinks as the input SNR rises because the residual under the
    // voice (bins the floor keeps at −12 dB, not zero) dominates the error.
    ['white −30 dBFS', whiteNoise(LEN, -30, 1), 6, 9],
    ['white −40 dBFS', whiteNoise(LEN, -40, 2), 5, 9],
    ['white −50 dBFS', whiteNoise(LEN, -50, 3), 4, 9],
    ['pink −40 dBFS', pinkNoise(LEN, -40, 4), 3.5, 9],
  ];

  it.each(cases)('%s: SNR improves, gaps drop 9–12.1 dB, formant bands hold within 1 dB of CLEAN', (_label, noise, minSnrGain, minGap) => {
    const noisy = add(clean, noise);
    const y = noisy.slice();
    const r = denoiseSample(y, SR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Readouts: the floor is the hiss RMS (white: exact; pink: the profile mean lands near it).
    expect(r.reductionDb).toBeGreaterThan(9);
    expect(r.reductionDb).toBeLessThan(12.1);
    const snrIn = snrDb(noisy, clean);
    const snrOut = snrDb(y, clean);
    expect(snrOut - snrIn).toBeGreaterThan(minSnrGain);
    // Gaps: the floor bounds the reduction at −12.04 dB.
    const gapDrop = db(gapRms(noisy) / gapRms(y));
    expect(gapDrop).toBeGreaterThan(minGap);
    expect(gapDrop).toBeLessThan(12.1);
    // Formant bands (±150 Hz around each formant) against the CLEAN reference.
    for (const [f] of FORMANTS) {
      const want = bandDb(clean, f - 150, f + 150);
      const got = bandDb(y, f - 150, f + 150);
      expect(Math.abs(got - want)).toBeLessThan(1);
    }
    // Never adds energy.
    expect(rms(y)).toBeLessThanOrEqual(rms(noisy));
  });

  it('noise-floor readout lands within 3 dB of the injected hiss RMS', () => {
    // Under a 63 %-duty vocal the quantile in voiced bins is the ~56th
    // percentile of the gap frames' noise, +5.6 dB over the mean (the design's
    // stated Q = 0.2 limitation); averaged over all bins the readout lands
    // ~1.7 dB high. Pinned so the number cannot drift silently. (Pure hiss,
    // where the readout would be exact, is refused by the spread guard — no
    // frame is quieter than any other.)
    for (const [level, seed] of [
      [-40, 2],
      [-50, 3],
    ] as const) {
      const y = add(clean, whiteNoise(LEN, level, seed));
      const r = denoiseSample(y, SR);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.noiseFloorDb).toBeGreaterThan(level);
      expect(r.noiseFloorDb).toBeLessThan(level + 3);
    }
  });

  it('is deterministic: two runs on the same input are byte-identical', () => {
    const a = add(clean, whiteNoise(LEN, -40, 2));
    const b = a.slice();
    denoiseSample(a, SR);
    denoiseSample(b, SR);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });

  it('floor = 1 is the identity (STFT/WOLA reconstruction through the real framing), floor 0.25 is not', () => {
    const noisy = add(clean, whiteNoise(LEN, -40, 2));
    const identity = noisy.slice();
    expect(denoiseSampleWithFloor(identity, SR, 1).ok).toBe(true);
    let worst = 0;
    for (let i = 0; i < LEN; i++) worst = Math.max(worst, Math.abs(identity[i]! - noisy[i]!));
    expect(worst).toBeLessThan(1e-6);
    const real = noisy.slice();
    expect(denoiseSampleWithFloor(real, SR, DENOISE_FLOOR).ok).toBe(true);
    let moved = 0;
    for (let i = 0; i < LEN; i++) moved = Math.max(moved, Math.abs(real[i]! - noisy[i]!));
    expect(moved).toBeGreaterThan(1e-3);
  });
});

describe('denoiseSample — refusals leave the buffer byte-identical', () => {
  it('a sustained 5-partial pad (no noise) → no-steady-noise-floor', () => {
    const pad = synthPad();
    const copy = pad.slice();
    expect(denoiseSample(pad, SR)).toEqual({ ok: false, reason: 'no-steady-noise-floor' });
    expect(Buffer.from(pad.buffer).equals(Buffer.from(copy.buffer))).toBe(true);
  });

  it('the same pad with ±2 % vibrato is still refused (the dossier\'s −6 dB pad case)', () => {
    const pad = synthPad(0.02);
    const copy = pad.slice();
    expect(denoiseSample(pad, SR)).toEqual({ ok: false, reason: 'no-steady-noise-floor' });
    expect(Buffer.from(pad.buffer).equals(Buffer.from(copy.buffer))).toBe(true);
  });

  it('a 200 ms buffer → too-short', () => {
    const short = add(synthVocal(), whiteNoise(LEN, -40, 5)).subarray(0, Math.round(0.2 * SR)).slice();
    const copy = short.slice();
    expect(denoiseSample(short, SR)).toEqual({ ok: false, reason: 'too-short' });
    expect(Buffer.from(short.buffer).equals(Buffer.from(copy.buffer))).toBe(true);
  });

  it('digital silence → too-short (no population frames)', () => {
    expect(denoiseSample(new Float32Array(LEN), SR)).toEqual({ ok: false, reason: 'too-short' });
  });

  it('NaN anywhere → not-finite', () => {
    const y = add(synthVocal(), whiteNoise(LEN, -40, 6));
    y[1000] = NaN;
    expect(denoiseSample(y, SR)).toEqual({ ok: false, reason: 'not-finite' });
    expect(y[999]).toBe(add(synthVocal(), whiteNoise(LEN, -40, 6))[999]);
  });

  it('a CLEAN vocal (nothing to remove) → no-steady-noise-floor, byte-identical', () => {
    const v = synthVocal();
    const copy = v.slice();
    expect(denoiseSample(v, SR)).toEqual({ ok: false, reason: 'no-steady-noise-floor' });
    expect(Buffer.from(v.buffer).equals(Buffer.from(copy.buffer))).toBe(true);
  });

  it('DOCUMENTED: a vowel with NO pauses + hiss is refused — no frame shows the floor alone', () => {
    const v = add(synthVocal([[0.05, 2.95]]), whiteNoise(LEN, -40, 23));
    expect(denoiseSample(v, SR)).toEqual({ ok: false, reason: 'no-steady-noise-floor' });
  });

  it('the spread line is 6 dB, half the gate depth (the number the constant documents)', () => {
    expect(DENOISE_MIN_SPREAD_DB).toBe(6);
    expect(DENOISE_MIN_SPREAD_DB).toBeCloseTo(-20 * Math.log10(DENOISE_FLOOR) / 2, 0);
  });
});
