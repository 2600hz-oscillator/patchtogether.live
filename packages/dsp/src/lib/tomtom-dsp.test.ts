// packages/dsp/src/lib/tomtom-dsp.test.ts
//
// Proving tests for the TOM DRUM core: strike determinism, the frequency /
// bend laws (bend 0 = stable pitch, full bend = octave-class sweep),
// FREQUENCY-COMPENSATED decay (same −60 dB time at 60 Hz and 400 Hz, and
// identical in ms at 44 100 vs 48 000), the SONIC-RANGE proof (low-tune
// long-decay vs high-tune short-decay produce measurably different spectral
// centroids AND ring durations — the 808-woody → Simmons-zap spectrum), the
// TONE / NOISE / DRIVE layer behaviors, DC cleanliness, and the true-peak
// bound.

import { describe, it, expect } from 'vitest';
import {
  OVERTONE_RATIO,
  TOMTOM_DEFAULTS,
  makeTomtomState,
  tomBendDepthSt,
  tomBendTimeMs,
  tomDecayMs,
  tomFreqHz,
  tomTuneHz,
  tomtomStep,
  decayCoeff,
  type TomtomParams,
} from './tomtom-dsp';

const P = (over: Partial<TomtomParams> = {}): TomtomParams => ({
  ...TOMTOM_DEFAULTS,
  ...over,
});

/** Render n samples; the trigger fires high for the first 10 samples. */
function render(
  n: number,
  p: TomtomParams,
  sr: number,
  opts: { accent?: number; state?: ReturnType<typeof makeTomtomState> } = {},
): Float32Array {
  const s = opts.state ?? makeTomtomState();
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    out[t] = tomtomStep(t < 10 ? 1 : 0, opts.accent ?? 0, p, sr, s);
  }
  return out;
}

function peakOf(b: Float32Array, s = 0, e = b.length): number {
  let p = 0;
  for (let i = s; i < e; i++) p = Math.max(p, Math.abs(b[i]!));
  return p;
}

/** Hann-windowed Goertzel power at `hz` over [s, e). */
function goertzel(buf: Float32Array, sr: number, hz: number, s = 0, e = buf.length): number {
  const n = e - s;
  const omega = (2 * Math.PI * hz) / sr;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    const q0 = coeff * q1 - q2 + buf[s + i]! * win;
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

/** Fundamental estimate via interpolated rising zero-crossings over [s, e). */
function estimateFreq(buf: Float32Array, sr: number, s: number, e: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = s + 1; i < e; i++) {
    if (buf[i - 1]! < 0 && buf[i]! >= 0) {
      const frac = buf[i - 1]! / (buf[i - 1]! - buf[i]!);
      const t = i - 1 + frac;
      if (first < 0) first = t;
      last = t;
      count++;
    }
  }
  if (count < 2) return 0;
  return ((count - 1) * sr) / (last - first);
}

/** Ring duration (ms): last 10 ms window whose peak clears globalPeak/1000. */
function ringMs(buf: Float32Array, sr: number): number {
  const peak = peakOf(buf);
  const th = Math.max(peak / 1000, 1e-6);
  const w = Math.max(1, Math.round((sr * 10) / 1000));
  let lastEnd = 0;
  for (let start = 0; start < buf.length; start += w) {
    const end = Math.min(buf.length, start + w);
    if (peakOf(buf, start, end) > th) lastEnd = end;
  }
  return (lastEnd / sr) * 1000;
}

/** Spectral centroid (Hz) as the RMS frequency ("spectral gravity"):
 *  f = (sr/2π)·√(Σ(Δx)²/Σx²). Exact for a sine, bin-free and robust for
 *  the mixed tone+noise voice (no Goertzel probe-bin quantization). */
function centroidHz(buf: Float32Array, sr: number, s: number, e: number): number {
  let dd = 0;
  let xx = 0;
  for (let i = s + 1; i < e; i++) {
    const d = buf[i]! - buf[i - 1]!;
    dd += d * d;
    xx += buf[i]! * buf[i]!;
  }
  if (xx <= 0) return 0;
  return (sr / (2 * Math.PI)) * 2 * Math.asin(0.5 * Math.sqrt(dd / xx));
}

const SR = 48000;

// ─────────────────────────────────────────────────────────────────────────
// Frequency / bend / decay LAWS (pure functions)
// ─────────────────────────────────────────────────────────────────────────

describe('tomtom: frequency + bend laws', () => {
  it('settles to tune; full 24 st bend starts exactly 4× above (octave-class)', () => {
    expect(tomFreqHz(100, 0, 0, 24, 0)).toBeCloseTo(100, 6);
    expect(tomFreqHz(100, 0, 1, 24, 0)).toBeCloseTo(400, 6);
  });

  it('bend depth 0 = stable pitch at every envelope phase', () => {
    for (const env of [0, 0.3, 0.7, 1]) {
      expect(tomFreqHz(150, 0, env, 0, 0)).toBeCloseTo(150, 6);
    }
  });

  it('pitch_cv is 1 V/oct on the whole voice', () => {
    expect(tomFreqHz(110, 1, 0, 0, 0)).toBeCloseTo(220, 6);
    expect(tomFreqHz(110, -1, 0, 0, 0)).toBeCloseTo(55, 6);
  });

  it('accent deepens the bend by up to 50 % (24 st → 36 st = 8×)', () => {
    expect(tomFreqHz(100, 0, 1, 24, 1)).toBeCloseTo(800, 5);
  });

  it('bend_cv adds ±24 st per volt (full-swing), clamped to [0, 36]', () => {
    expect(tomBendDepthSt(7, 0.5)).toBeCloseTo(19, 6);
    expect(tomBendDepthSt(7, -1)).toBeCloseTo(0, 6);
    expect(tomBendDepthSt(24, 2)).toBeCloseTo(36, 6);
  });

  it('decay_cv is 2 oct of decay time per volt, clamped', () => {
    expect(tomDecayMs(350, 1)).toBeCloseTo(1400, 6);
    expect(tomDecayMs(350, -1)).toBeCloseTo(87.5, 6);
    expect(tomDecayMs(1500, 2)).toBeCloseTo(3000, 6);
  });

  it('tune_cv is 2 oct/V on the TUNE knob (clamped 60..400), no-op at 0', () => {
    expect(tomTuneHz(110, 0)).toBeCloseTo(110, 6); // cv = 0 is a perfect no-op
    expect(tomTuneHz(100, 0.5)).toBeCloseTo(200, 6); // +0.5 V = ×2
    expect(tomTuneHz(100, 1)).toBeCloseTo(400, 6); // +1 V = ×4 → clamped at 400
    expect(tomTuneHz(100, -1)).toBeCloseTo(60, 6); // −1 V = ×¼ = 25 → clamped at 60
  });

  it('bend_time_cv is 2 oct of bend TIME per volt (clamped 5..600), no-op at 0', () => {
    expect(tomBendTimeMs(60, 0)).toBeCloseTo(60, 6); // no-op
    expect(tomBendTimeMs(60, 1)).toBeCloseTo(240, 6); // ×4
    expect(tomBendTimeMs(60, -1)).toBeCloseTo(15, 6); // ×¼
    expect(tomBendTimeMs(300, 2)).toBeCloseTo(600, 6); // 300×16 → clamp 600
  });
});

// ─────────────────────────────────────────────────────────────────────────
// New per-knob CVs (drive_cv / level_cv are consumed; every law no-op at 0)
// ─────────────────────────────────────────────────────────────────────────

describe('tomtom: drive_cv / level_cv consumption', () => {
  it('drive_cv sums into DRIVE — a +1 V CV grows the 3rd-harmonic saturation', () => {
    const base = { tune: 200, bendAmt: 0, tone: 0, noise: 0, decay: 600 };
    const clean = render(SR, P({ ...base, drive: 0, driveCv: 0 }), SR);
    const hot = render(SR, P({ ...base, drive: 0, driveCv: 1 }), SR);
    const w = Math.round(0.12 * SR);
    const pClean = goertzel(clean, SR, 600, 0, w);
    const pHot = goertzel(hot, SR, 600, 0, w);
    expect(pHot).toBeGreaterThan(5 * Math.max(pClean, 1e-12));
  });

  it('level_cv (dB) — a −1 V CV pulls the hit down ~18 dB; cv = 0 is a no-op', () => {
    // cv = 0 is byte-identical to the default render (no new-CV perturbation).
    expect(render(2048, P({ levelCv: 0 }), SR)).toEqual(render(2048, P(), SR));
    const loud = peakOf(render(SR, P({ levelCv: 0 }), SR));
    const quiet = peakOf(render(SR, P({ levelCv: -1 }), SR)); // −18 dB ≈ ×0.126
    expect(quiet).toBeLessThan(loud * 0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Rendered bend behavior (the sonic heart)
// ─────────────────────────────────────────────────────────────────────────

describe('tomtom: rendered pitch bend', () => {
  const CLEAN = { tone: 0, noise: 0, drive: 0, bendTime: 300, decay: 1500 };

  it('bend 0: measured pitch is stable start → tail (within 3 %)', () => {
    const buf = render(SR, P({ ...CLEAN, tune: 200, bendAmt: 0 }), SR);
    const early = estimateFreq(buf, SR, 0, Math.round(0.05 * SR));
    const late = estimateFreq(buf, SR, Math.round(0.4 * SR), Math.round(0.45 * SR));
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
    expect(Math.abs(early - late) / late).toBeLessThan(0.03);
    expect(Math.abs(late - 200) / 200).toBeLessThan(0.03);
  });

  it('full bend (24 st): octave-class sweep — attack ≥2× the settled pitch, monotonic down', () => {
    const buf = render(SR, P({ ...CLEAN, tune: 150, bendAmt: 24 }), SR);
    const attack = estimateFreq(buf, SR, 0, Math.round(0.008 * SR));
    const mid = estimateFreq(buf, SR, Math.round(0.03 * SR), Math.round(0.06 * SR));
    const settled = estimateFreq(buf, SR, Math.round(0.8 * SR), Math.round(0.9 * SR));
    // Attack window sits near the 4× (600 Hz) start of the dive.
    expect(attack / settled).toBeGreaterThan(2); // octave-class
    expect(attack).toBeGreaterThan(mid); // the dive is monotonic
    expect(mid).toBeGreaterThan(settled);
    expect(Math.abs(settled - 150) / 150).toBeLessThan(0.03);
  });

  it('accent deepens the attack sweep AND lands a hotter hit', () => {
    const plain = render(SR, P({ ...CLEAN, tune: 150, bendAmt: 12 }), SR, { accent: 0 });
    const hot = render(SR, P({ ...CLEAN, tune: 150, bendAmt: 12 }), SR, { accent: 1 });
    const fPlain = estimateFreq(plain, SR, 0, Math.round(0.008 * SR));
    const fHot = estimateFreq(hot, SR, 0, Math.round(0.008 * SR));
    expect(fHot).toBeGreaterThan(fPlain * 1.1);
    expect(peakOf(hot)).toBeGreaterThan(peakOf(plain) * 1.05);
  });

  it('accent BRIGHTENS the hit (impact nonlinearity: overtone + breath start hotter)', () => {
    const p = P({ tune: 150, bendAmt: 0, tone: 0.3, noise: 0.3, drive: 0, decay: 600 });
    const plain = render(SR, p, SR, { accent: 0 });
    const hot = render(SR, p, SR, { accent: 1 });
    const w = Math.round(0.1 * SR);
    // Spectral gravity of the attack window rises on the accented hit —
    // brighter, not merely louder (velocity alone would leave it unchanged).
    expect(centroidHz(hot, SR, 0, w)).toBeGreaterThan(centroidHz(plain, SR, 0, w) * 1.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Frequency-compensated + sr-calibrated decay
// ─────────────────────────────────────────────────────────────────────────

describe('tomtom: decay compensation + sr calibration', () => {
  /** −60 dB envelope time via the state (samples until ampEnv ≤ 1e-3). */
  function t60Samples(sr: number, tune: number, decay: number): number {
    const s = makeTomtomState();
    const p = P({ tune, decay, tone: 0, noise: 0, drive: 0 });
    tomtomStep(1, 0, p, sr, s);
    let t = 1;
    while (s.ampEnv > 1e-3 && t < sr * 5) {
      tomtomStep(0, 0, p, sr, s);
      t++;
    }
    return t;
  }

  it('FREQUENCY-COMPENSATED: 60 Hz and 400 Hz ring the same length at the same knob', () => {
    const lo = t60Samples(SR, 60, 300);
    const hi = t60Samples(SR, 400, 300);
    expect(Math.abs(lo - hi)).toBeLessThanOrEqual(1); // env law is tune-independent
    // …and the audible ring-out on the OUTPUT agrees within 10 %.
    const bufLo = render(SR, P({ tune: 60, decay: 300, tone: 0, noise: 0, drive: 0 }), SR);
    const bufHi = render(SR, P({ tune: 400, decay: 300, tone: 0, noise: 0, drive: 0 }), SR);
    const rLo = ringMs(bufLo, SR);
    const rHi = ringMs(bufHi, SR);
    expect(Math.abs(rLo - rHi) / Math.max(rLo, rHi)).toBeLessThan(0.1);
  });

  it('sr-CALIBRATED: −60 dB time in ms matches at 44 100 and 48 000 (±2 %)', () => {
    const ms44 = (t60Samples(44100, 110, 350) / 44100) * 1000;
    const ms48 = (t60Samples(48000, 110, 350) / 48000) * 1000;
    expect(Math.abs(ms44 - ms48) / ms48).toBeLessThan(0.02);
    expect(Math.abs(ms48 - 350) / 350).toBeLessThan(0.02);
  });

  it('decayCoeff hits −60 dB at the stated ms', () => {
    const c = decayCoeff(100, SR);
    let env = 1;
    const n = Math.round((100 / 1000) * SR);
    for (let i = 0; i < n; i++) env *= c;
    expect(env).toBeCloseTo(1e-3, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SONIC RANGE — the spectrum claim (808-woody ↔ Simmons/timbale-tight)
// ─────────────────────────────────────────────────────────────────────────

describe('tomtom: sonic range proof', () => {
  it('low-tune long-decay vs high-tune short-decay: >2× centroid spread + >4× duration spread', () => {
    // A: floor-tom-deep (808-woody corner of the range).
    const a = render(2 * SR, P({
      tune: 65, decay: 1200, tone: 0.15, noise: 0.1, bendAmt: 4, bendTime: 40, drive: 0.2,
    }), SR);
    // B: tight high rack tom / timbale (909-punchy → Simmons corner).
    const b = render(2 * SR, P({
      tune: 350, decay: 90, tone: 0.9, noise: 0.7, bendAmt: 10, bendTime: 30, drive: 0.5,
    }), SR);
    const win = Math.round(0.25 * SR);
    const ca = centroidHz(a, SR, 0, win);
    const cb = centroidHz(b, SR, 0, win);
    expect(cb).toBeGreaterThan(2 * ca); // measurably different spectral centroids
    const ra = ringMs(a, SR);
    const rb = ringMs(b, SR);
    expect(ra).toBeGreaterThan(4 * rb); // measurably different durations
    // Sanity anchors: the deep tom rings ~1.2 s, the tight one well under 300 ms.
    expect(ra).toBeGreaterThan(800);
    expect(rb).toBeLessThan(300);
  });

  it('TONE mixes the 1.593× second membrane mode in', () => {
    const base = { tune: 200, bendAmt: 0, noise: 0, drive: 0, decay: 600 };
    const off = render(SR, P({ ...base, tone: 0 }), SR);
    const on = render(SR, P({ ...base, tone: 1 }), SR);
    const hz = 200 * OVERTONE_RATIO;
    const w = Math.round(0.12 * SR);
    const pOff = goertzel(off, SR, hz, 0, w);
    const pOn = goertzel(on, SR, hz, 0, w);
    expect(pOn).toBeGreaterThan(10 * Math.max(pOff, 1e-12));
  });

  it('NOISE adds the band-passed breath around 2.5× the settled pitch', () => {
    const base = { tune: 200, bendAmt: 0, tone: 0, drive: 0, decay: 600 };
    const off = render(SR, P({ ...base, noise: 0 }), SR);
    const on = render(SR, P({ ...base, noise: 1 }), SR);
    const w = Math.round(0.08 * SR);
    const probes = [420, 500, 560, 640]; // around the 500 Hz breath center
    let eOff = 0;
    let eOn = 0;
    for (const hz of probes) {
      eOff += goertzel(off, SR, hz, 0, w);
      eOn += goertzel(on, SR, hz, 0, w);
    }
    expect(eOn).toBeGreaterThan(5 * Math.max(eOff, 1e-12));
  });

  it('DRIVE adds odd-harmonic saturation (3rd harmonic grows >5×)', () => {
    const base = { tune: 200, bendAmt: 0, tone: 0, noise: 0, decay: 600 };
    const clean = render(SR, P({ ...base, drive: 0 }), SR);
    const hot = render(SR, P({ ...base, drive: 1 }), SR);
    const w = Math.round(0.12 * SR);
    const third = 600;
    const pClean = goertzel(clean, SR, third, 0, w);
    const pHot = goertzel(hot, SR, third, 0, w);
    expect(pHot).toBeGreaterThan(5 * Math.max(pClean, 1e-12));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Determinism + hygiene
// ─────────────────────────────────────────────────────────────────────────

describe('tomtom: determinism + hygiene', () => {
  it('two independent states render bit-identical output (pure core)', () => {
    const a = render(4096, P(), SR);
    const b = render(4096, P(), SR);
    expect(a).toEqual(b);
  });

  it('re-striking the same state after ring-out reproduces the hit (≈1e-5)', () => {
    const p = P();
    const s = makeTomtomState();
    const hit = (warm: number) => {
      for (let t = 0; t < warm; t++) tomtomStep(0, 0, p, SR, s);
      const buf = new Float32Array(2048);
      for (let t = 0; t < 2048; t++) buf[t] = tomtomStep(t < 10 ? 1 : 0, 0, p, SR, s);
      return buf;
    };
    const first = hit(0);
    const second = hit(3 * SR); // 3 s ring-out past every envelope
    for (let i = 0; i < 2048; i++) {
      // Phases/envelopes/noise reset EXACTLY at the strike; only the DC
      // block + oversampler legitimately carry a ~1e-9 residue.
      expect(second[i]!).toBeCloseTo(first[i]!, 5);
    }
  });

  it('held-high trigger fires ONCE (edge, not level)', () => {
    const p = P({ decay: 100, tone: 0, noise: 0, drive: 0 });
    const s = makeTomtomState();
    // Hold the trigger high for 400 ms — decay is 100 ms, so a re-fire
    // would show fresh attack energy late in the hold.
    const n = Math.round(0.4 * SR);
    const buf = new Float32Array(n);
    for (let t = 0; t < n; t++) buf[t] = tomtomStep(1, 0, p, SR, s);
    const early = peakOf(buf, 0, Math.round(0.05 * SR));
    const late = peakOf(buf, Math.round(0.3 * SR), n);
    expect(late).toBeLessThan(early / 100); // no re-strike while held
  });

  it('default hit: audible, true-peak bounded, DC-clean, silent before the strike', () => {
    const s = makeTomtomState();
    // 100 ms of silence before any trigger.
    for (let t = 0; t < Math.round(0.1 * SR); t++) {
      expect(Math.abs(tomtomStep(0, 0, TOMTOM_DEFAULTS, SR, s))).toBeLessThan(1e-6);
    }
    const buf = render(SR, P(), SR);
    const peak = peakOf(buf);
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(1); // the chain ends in tanh
    let sum = 0;
    for (const v of buf) sum += v;
    expect(Math.abs(sum / buf.length)).toBeLessThan(0.01);
    expect(buf.every(Number.isFinite)).toBe(true);
  });
});
