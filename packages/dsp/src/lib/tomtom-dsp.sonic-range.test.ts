// packages/dsp/src/lib/tomtom-dsp.sonic-range.test.ts
//
// SONIC-RANGE GUARD for TOM DRUM — the permanent form of the 2026-07-11
// adversarial dynamism audit ("all controls are sonically dynamic").
//
// Every voice control is swept at FIVE FADER POSITIONS (min / 25% / 50% /
// 75% / max, through the card's UI curve — log knobs sweep geometrically),
// all else at defaults, and its PRIMARY OBJECTIVE METRIC must move at every
// step. The core is bit-deterministic (seeded per-strike noise), so these
// are exact-render assertions — zero flake by construction; margins sit
// well inside the audited values so only a REAL sonic regression trips.
//
// Audited metric values (2026-07-11, sr 48 kHz — the source of the margins):
//   tune       f0 exact at all 5 points (60 → 400 Hz), RMS flat within
//              ~0.6 dB (the frequency-compensated decay at work)
//   bend_amt   attack/settled pitch ratio 1.02 / 1.17 / 1.31 / 1.43 / 1.87
//   bend_time  attack-window centroid 123 / 127 / 160 / 185 / 197 Hz
//              (+ zero-crossing pitch at 8 ms: settled / ×1.05 / ×1.27 /
//              ×1.59 / ×1.75 — the "piuuu" lengthens every quartile)
//   decay      ring 50 / 100 / 250 / 610 / 1490 ms (knob 40 → 1500)
//   tone       overtone/fundamental 0.001 / 0.09 / 0.22 / 0.41 / 0.75
//   noise      attack centroid 136 / 489 / 1017 / 1460 / 1709 Hz
//   drive      h3/h1 ×21 min → max, RMS +7.6 dB; the 0 → ε bypass seam is
//              the kickdrum-family pattern and measures −0.3 dB RMS (guarded
//              below as a BOUND so it can never silently grow)
//   level      exact dB staging up to the documented true-peak tanh lean
//   CVs        pitch ±1 V exact octaves; bend/decay/tone/noise CV laws all
//              move their metric ≥1.9×; accent = hotter + brighter.

import { describe, expect, it } from 'vitest';
import {
  OVERTONE_RATIO,
  TOMTOM_DEFAULTS,
  makeTomtomState,
  tomtomStep,
  type TomtomParams,
} from './tomtom-dsp';

const SR = 48000;

/** Fader position → value through the CARD's UI curve (TomtomCard.svelte):
 *  log knobs (tune / bend_time / decay) sweep geometrically. */
function faderVal(f: number, min: number, max: number, curve: 'log' | 'linear'): number {
  return curve === 'log' ? min * Math.pow(max / min, f) : min + f * (max - min);
}
const POS = [0, 0.25, 0.5, 0.75, 1] as const;

function render(
  opts: Partial<TomtomParams>,
  o: { durS?: number; accent?: number } = {},
): Float32Array {
  const durS = o.durS ?? 0.8;
  const p: TomtomParams = { ...TOMTOM_DEFAULTS, ...opts };
  const s = makeTomtomState();
  const n = Math.round(SR * durS);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = tomtomStep(i < 10 ? 1 : 0, o.accent ?? 0, p, SR, s);
  return out;
}

// ── metrics ──

function rmsW(b: Float32Array, sS: number, eS: number): number {
  const s = Math.round(sS * SR);
  const e = Math.min(b.length, Math.round(eS * SR));
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}
const dB = (x: number) => 20 * Math.log10(Math.max(1e-12, x));

function peakOf(b: Float32Array, s = 0, e = b.length): number {
  let p = 0;
  for (let i = s; i < e; i++) p = Math.max(p, Math.abs(b[i]!));
  return p;
}

function goertzelMag(buf: Float32Array, from: number, to: number, freq: number): number {
  const w = (2 * Math.PI * freq) / SR;
  const coeff = 2 * Math.cos(w);
  const n = to - from;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = buf[from + i]! * win + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
}

function measuredF0(buf: Float32Array, fExpect: number, fromS: number, toS: number): number {
  const from = Math.round(fromS * SR);
  const to = Math.min(buf.length, Math.round(toS * SR));
  let best = 0;
  let bestF = fExpect;
  for (let c = -100; c <= 100; c += 1) {
    const f = fExpect * Math.pow(2, c / 1200);
    const m = goertzelMag(buf, from, to, f);
    if (m > best) {
      best = m;
      bestF = f;
    }
  }
  return bestF;
}

/** Peak Goertzel magnitude near fCenter (±60 c). */
function partialMag(buf: Float32Array, fromS: number, toS: number, fC: number): number {
  const from = Math.round(fromS * SR);
  const to = Math.min(buf.length, Math.round(toS * SR));
  let best = 0;
  for (let c = -60; c <= 60; c += 2) {
    best = Math.max(best, goertzelMag(buf, from, to, fC * Math.pow(2, c / 1200)));
  }
  return best;
}

function centroidHz(buf: Float32Array, sS: number, eS: number): number {
  const s = Math.round(sS * SR);
  const e = Math.min(buf.length, Math.round(eS * SR));
  let dd = 0;
  let xx = 0;
  for (let i = s + 1; i < e; i++) {
    const d = buf[i]! - buf[i - 1]!;
    dd += d * d;
    xx += buf[i]! * buf[i]!;
  }
  if (xx <= 0) return 0;
  return (SR / (2 * Math.PI)) * 2 * Math.asin(Math.min(1, 0.5 * Math.sqrt(dd / xx)));
}

/** Ring duration (ms): last 10 ms window whose peak clears globalPeak/1000. */
function ringMs(buf: Float32Array): number {
  const peak = peakOf(buf);
  const th = Math.max(peak / 1000, 1e-6);
  const w = Math.max(1, Math.round((SR * 10) / 1000));
  let lastEnd = 0;
  for (let start = 0; start < buf.length; start += w) {
    const end = Math.min(buf.length, start + w);
    if (peakOf(buf, start, end) > th) lastEnd = end;
  }
  return (lastEnd / SR) * 1000;
}

/** Interpolated rising-zero-crossing pitch over [sS, eS). */
function zcPitch(buf: Float32Array, sS: number, eS: number): number {
  const s = Math.round(sS * SR);
  const e = Math.min(buf.length, Math.round(eS * SR));
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
  return ((count - 1) * SR) / (last - first);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-control 5-point sweeps
// ─────────────────────────────────────────────────────────────────────────

describe('tomtom sonic range / per-control 5-point sweeps', () => {
  it('TUNE: f0 lands on the knob at every quartile; loudness stays compensated-flat', () => {
    const levels: number[] = [];
    for (const f of POS) {
      const v = faderVal(f, 60, 400, 'log');
      const b = render({ tune: v });
      expect(Math.abs(measuredF0(b, v, 0.25, 0.6) / v - 1), `tune ${v.toFixed(1)}`).toBeLessThan(0.01);
      levels.push(dB(rmsW(b, 0, 0.4)));
    }
    // Frequency-compensated: a floor tom and a timbale land within 2 dB.
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(2);
  });

  it('BEND: attack/settled pitch ratio rises ≥6% per quartile (0 → 24 st)', () => {
    const ratios = POS.map((f) => {
      const v = faderVal(f, 0, 24, 'linear');
      const b = render({ bendAmt: v, noise: 0, drive: 0, tone: 0 });
      return centroidHz(b, 0.002, 0.02) / centroidHz(b, 0.3, 0.5);
    });
    expect(ratios[0]!).toBeLessThan(1.06); // bend 0 = stable pitch
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]! / ratios[i - 1]!, `quartile ${i}`).toBeGreaterThan(1.06);
    }
    expect(ratios[4]!).toBeGreaterThan(1.75); // the Simmons-class dive
  });

  it('B TIME: the sweep audibly lengthens at every quartile (10 → 300 ms)', () => {
    // Two probes: pitch at 8 ms (separates the fast half) and at 40 ms
    // (separates the slow half); the attack-window centroid must also rise
    // strictly through all five (the audible "piuuu" duration).
    const rows = POS.map((f) => {
      const v = faderVal(f, 10, 300, 'log');
      const b = render({ bendTime: v, bendAmt: 12, noise: 0, drive: 0, tone: 0 });
      const fSet = zcPitch(b, 0.4, 0.6);
      return {
        r8: zcPitch(b, 0.004, 0.016) / fSet, // 0 crossings → 0 (settled fast)
        r40: zcPitch(b, 0.032, 0.052) / fSet,
        cAtk: centroidHz(b, 0.002, 0.014),
      };
    });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.cAtk, `centroid quartile ${i}`).toBeGreaterThan(rows[i - 1]!.cAtk * 1.02);
    }
    // Fast half: at 8 ms the 55 ms knob is still ≥25% sharp, the 10 ms knob settled.
    expect(rows[2]!.r8).toBeGreaterThan(1.25);
    expect(rows[4]!.r8).toBeGreaterThan(1.6);
    // Slow half: at 40 ms only the long sweeps are still audibly sharp.
    expect(rows[4]!.r40).toBeGreaterThan(1.25);
    expect(rows[0]!.r40).toBeLessThan(1.05);
  });

  it('DECAY: ring duration tracks the knob within 30% at every quartile', () => {
    let prev = 0;
    for (const f of POS) {
      const v = faderVal(f, 40, 1500, 'log');
      const b = render({ decay: v }, { durS: Math.max(1, (v / 1000) * 1.6 + 0.4) });
      const ring = ringMs(b);
      expect(Math.abs(ring / v - 1), `decay ${v.toFixed(0)} ms`).toBeLessThan(0.3);
      expect(ring).toBeGreaterThan(prev);
      prev = ring;
    }
  });

  it('TONE: overtone/fundamental ratio rises ≥1.8× per quartile (woody → struck)', () => {
    const ratios = POS.map((f) => {
      const b = render({ tone: f, noise: 0, drive: 0 }, { durS: 0.6 });
      return (
        partialMag(b, 0.03, 0.2, 110 * OVERTONE_RATIO) / partialMag(b, 0.03, 0.2, 110)
      );
    });
    expect(ratios[0]!).toBeLessThan(0.01); // pure fundamental at 0
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]! / ratios[i - 1]!, `quartile ${i}`).toBeGreaterThan(1.8);
    }
    expect(ratios[4]!).toBeGreaterThan(0.5); // audibly "struck" at max
  });

  it('NOISE: attack centroid rises ≥15% per quartile (membrane → breath)', () => {
    const cents = POS.map((f) => centroidHz(render({ noise: f, drive: 0 }, { durS: 0.6 }), 0, 0.1));
    for (let i = 1; i < cents.length; i++) {
      expect(cents[i]! / cents[i - 1]!, `quartile ${i}`).toBeGreaterThan(1.15);
    }
    expect(cents[4]! / cents[0]!).toBeGreaterThan(8);
  });

  it('DRIVE: 3rd harmonic + loudness grow every quartile; the 0 → ε seam stays bounded', () => {
    const probe = (drive: number) => {
      const b = render({ drive, noise: 0, tone: 0, bendAmt: 0 }, { durS: 0.6 });
      return {
        h3: partialMag(b, 0.03, 0.25, 330) / partialMag(b, 0.03, 0.25, 110),
        rms: dB(rmsW(b, 0, 0.3)),
      };
    };
    const rows = POS.map((f) => probe(f));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.h3, `h3 quartile ${i}`).toBeGreaterThan(rows[i - 1]!.h3 * 1.25);
      expect(rows[i]!.rms, `rms quartile ${i}`).toBeGreaterThan(rows[i - 1]!.rms + 0.5);
    }
    expect(rows[4]!.h3 / Math.max(1e-6, rows[0]!.h3)).toBeGreaterThan(10);
    expect(rows[4]!.rms - rows[0]!.rms).toBeGreaterThan(6);
    // The drive ≤ 0.001 bypass is the kickdrum-family pattern; the level
    // step it creates at the bottom of the knob must stay under 1 dB so it
    // can never silently grow into an audible pop zone.
    expect(Math.abs(probe(0.01).rms - rows[0]!.rms)).toBeLessThan(1);
  });

  it('LEVEL: dB staging exact through 3 o\'clock; the top leans on the true-peak bound', () => {
    const at = (v: number) => dB(rmsW(render({ level: v }, { durS: 0.5 }), 0, 0.4));
    const ref = at(0);
    for (const f of [0, 0.25, 0.5] as const) {
      const v = faderVal(f, -24, 12, 'linear');
      expect(Math.abs(at(v) - ref - v), `level ${v} dB`).toBeLessThan(1);
    }
    // Above 0 dB the tanh true-peak bound compresses — still strictly louder.
    const hi = at(12);
    const mid = at(3);
    expect(mid).toBeGreaterThan(ref + 1.5);
    expect(hi).toBeGreaterThan(mid + 3);
    expect(peakOf(render({ level: 12 }, { durS: 0.5 }))).toBeLessThan(1); // bound holds
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CV inputs actually modulate
// ─────────────────────────────────────────────────────────────────────────

describe('tomtom sonic range / CV inputs', () => {
  it('pitch_cv: exact octaves at ±1 V', () => {
    for (const cv of [-1, 1]) {
      const fExp = 110 * Math.pow(2, cv);
      const b = render({ pitchCv: cv, noise: 0, drive: 0, tone: 0, bendAmt: 0 }, { durS: 0.6 });
      expect(Math.abs(measuredF0(b, fExp, 0.2, 0.5) / fExp - 1)).toBeLessThan(0.01);
    }
  });

  it('bend_cv: ±0.5 V swings the attack ratio through the knob range', () => {
    const ratio = (cv: number) => {
      const b = render({ bendCv: cv, noise: 0, drive: 0, tone: 0 }, { durS: 0.6 });
      return centroidHz(b, 0.002, 0.02) / centroidHz(b, 0.3, 0.5);
    };
    const lo = ratio(-0.5); // 7 st − 12 st → clamped 0: stable pitch
    const mid = ratio(0);
    const hi = ratio(0.5); // 7 + 12 = 19 st
    expect(lo).toBeLessThan(1.06);
    expect(mid).toBeGreaterThan(lo * 1.15);
    expect(hi).toBeGreaterThan(mid * 1.15);
  });

  it('decay_cv: 2 oct of TIME per volt (×2 per +0.5 V, within 25%)', () => {
    const ring = (cv: number) => ringMs(render({ decayCv: cv }, { durS: 2.0 }));
    const lo = ring(-0.5);
    const mid = ring(0);
    const hi = ring(0.5);
    expect(Math.abs(mid / lo - 2)).toBeLessThan(0.5);
    expect(Math.abs(hi / mid - 2)).toBeLessThan(0.5);
    expect(hi / lo).toBeGreaterThan(3);
  });

  it('tone_cv and noise_cv sum into their balances', () => {
    const ot = (cv: number) => {
      const b = render({ toneCv: cv, noise: 0, drive: 0 }, { durS: 0.5 });
      return partialMag(b, 0.03, 0.2, 110 * OVERTONE_RATIO) / partialMag(b, 0.03, 0.2, 110);
    };
    expect(ot(0.5) / ot(0)).toBeGreaterThan(3);
    const cent = (cv: number) => centroidHz(render({ noiseCv: cv, drive: 0 }, { durS: 0.5 }), 0, 0.1);
    expect(cent(0.5) / cent(0)).toBeGreaterThan(2.5);
  });

  it('accent: a full-accent hit is hotter AND brighter (impact nonlinearity)', () => {
    const soft = render({}, { durS: 0.6, accent: 0 });
    const hard = render({}, { durS: 0.6, accent: 1 });
    expect(peakOf(hard) / peakOf(soft)).toBeGreaterThan(1.1);
    expect(centroidHz(hard, 0, 0.06) / centroidHz(soft, 0, 0.06)).toBeGreaterThan(1.5);
  });
});
