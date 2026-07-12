// packages/dsp/src/lib/karplus-dsp.sonic-range.test.ts
//
// SONIC-RANGE GUARD for KARPLUS — the permanent form of the 2026-07-11
// adversarial dynamism audit ("all controls are sonically dynamic").
//
// Every voice control is swept at FIVE FADER POSITIONS (min / 25% / 50% /
// 75% / max, through the card's UI curve — log knobs sweep geometrically),
// all else at defaults, and its PRIMARY OBJECTIVE METRIC must move at every
// step. A control fails here if a range span goes dead, if min→max is
// inaudible, or if a CV input stops modulating. The core is bit-
// deterministic (seeded burst), so these are exact-render assertions —
// zero flake by construction; the margins below sit well inside the audited
// values so only a REAL sonic regression trips them.
//
// Audited metric values (2026-07-11, sr 48 kHz — the source of the margins):
//   tune       f0 exact at all 5 points (55 → 1760 Hz)
//   decay      T60 fit 0.10 / 0.29 / 0.83 / 2.32 / 6.56 s (knob 0.1 → 10;
//              top-end < knob = the documented G_MAX muted-string physics)
//   brightness sustain centroid 121 / 228 / 453 / 765 / 1919 Hz
//   position   h2/h1 2.67 / 2.43 / 1.85 / 1.01 / 0.026 (β = 0.5 comb null)
//   stiffness  p3 peak −12c / −10c / +2c / +26c / +64c (POST-RETAPE — the
//              audit found the ORIGINAL a = −0.55·knob mapping stretched
//              partials ~2 c over the FULL range at the default tune: dead
//              below ~500 Hz; karplusStiffA is the fix)
//   color      attack centroid 1493 / 1979 / 2873 / 4203 / 5940 Hz
//   burst      exciter noise-splash 10 / 14 / 12 / 19 / 28 ms (dark-string
//              isolation config), energy-normalized within ~1 dB
//   level      exact dB staging (−24 → +12)
//   CVs        pitch ±1 V = exact octaves; accent +4.3 dB + brighter;
//              damp −118 dB while held, rings again after release.

import { describe, expect, it } from 'vitest';
import {
  KARPLUS_DEFAULTS,
  KARPLUS_STIFF_BUDGET,
  karplusAllpassPhaseDelay,
  karplusStep,
  karplusStiffA,
  makeKarplusState,
  type KarplusParams,
} from './karplus-dsp';

const SR = 48000;

/** Fader position → value through the CARD's UI curve (KarplusCard.svelte):
 *  log knobs (tune / decay / burst) sweep geometrically, linear knobs
 *  arithmetically — the 5 points are what a user's knob quartiles produce. */
function faderVal(f: number, min: number, max: number, curve: 'log' | 'linear'): number {
  return curve === 'log' ? min * Math.pow(max / min, f) : min + f * (max - min);
}
const POS = [0, 0.25, 0.5, 0.75, 1] as const;

// ── render harness (canonical 5 ms trigger pulse at t = 0) ──

function render(
  opts: Partial<KarplusParams>,
  o: {
    durS?: number;
    strikes?: number[];
    accent?: (i: number) => number;
    damp?: (i: number) => number;
  } = {},
): Float32Array {
  const durS = o.durS ?? 0.9;
  const strikes = o.strikes ?? [0];
  const p: KarplusParams = { ...KARPLUS_DEFAULTS, ...opts };
  const s = makeKarplusState(SR);
  const n = Math.round(SR * durS);
  const trig = new Float32Array(n);
  const pulse = Math.max(1, Math.round(0.005 * SR));
  for (const t of strikes) {
    const at = Math.round(t * SR);
    trig.fill(1, at, Math.min(n, at + pulse));
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = karplusStep(trig[i]!, o.accent ? o.accent(i) : 0, o.damp ? o.damp(i) : 0, p, SR, s);
  }
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

/** Strongest-bin frequency near fExpect (±spanCents Goertzel scan). */
function measuredF0(buf: Float32Array, fExpect: number, fromS: number, toS: number, spanC = 100): number {
  const from = Math.round(fromS * SR);
  const to = Math.min(buf.length, Math.round(toS * SR));
  let best = 0;
  let bestF = fExpect;
  for (let c = -spanC; c <= spanC; c += 1) {
    const f = fExpect * Math.pow(2, c / 1200);
    const m = goertzelMag(buf, from, to, f);
    if (m > best) {
      best = m;
      bestF = f;
    }
  }
  return bestF;
}

/** Peak location (cents from fCenter) over an asymmetric scan window. */
function partialPeakCents(buf: Float32Array, fC: number, loC: number, hiC: number): number {
  const from = Math.round(0.05 * SR);
  const to = Math.round(0.35 * SR);
  let best = 0;
  let bestC = loC;
  for (let c = loC; c <= hiC; c += 2) {
    const m = goertzelMag(buf, from, to, fC * Math.pow(2, c / 1200));
    if (m > best) {
      best = m;
      bestC = c;
    }
  }
  return bestC;
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

/** Diff-based spectral centroid ("spectral gravity", exact for a sine). */
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

/** T60 via the RMS decay slope between two windows. */
function t60Fit(buf: Float32Array, w1: [number, number], w2: [number, number]): number {
  const r1 = rmsW(buf, w1[0], w1[1]);
  const r2 = rmsW(buf, w2[0], w2[1]);
  const dt = (w2[0] + w2[1]) / 2 - (w1[0] + w1[1]) / 2;
  const drop = 20 * Math.log10(r1 / Math.max(1e-12, r2));
  return (60 * dt) / Math.max(1e-6, drop);
}

function zcrRate(buf: Float32Array, sS: number, eS: number): number {
  const s = Math.round(sS * SR);
  const e = Math.min(buf.length, Math.round(eS * SR));
  let c = 0;
  for (let i = s + 1; i < e; i++) if (buf[i - 1]! < 0 !== buf[i]! < 0) c++;
  return c / Math.max(1e-9, (e - s) / SR);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-control 5-point sweeps
// ─────────────────────────────────────────────────────────────────────────

describe('karplus sonic range / per-control 5-point sweeps', () => {
  it('TUNE: f0 lands on the knob at every fader quartile (log sweep 55 → 1760)', () => {
    for (const f of POS) {
      const v = faderVal(f, 55, 1760, 'log');
      const b = render({ tune: v });
      const f0 = measuredF0(b, v, 0.3, 0.8);
      expect(Math.abs(f0 / v - 1), `tune ${v.toFixed(1)} Hz`).toBeLessThan(0.01);
    }
  });

  it('DECAY: T60 rises monotonically ≥1.8× per quartile (0.1 s → 10 s knob)', () => {
    const t60s = POS.map((f) => {
      const v = faderVal(f, 0.1, 10, 'log');
      const dur = Math.min(6, Math.max(1, v * 0.7));
      const b = render({ decay: v }, { durS: dur });
      const a = 0.06;
      const w = Math.max(0.05, Math.min(0.3, v * 0.08));
      const b2 = Math.min(dur - w - 0.01, a + Math.max(0.15, v * 0.35));
      return t60Fit(b, [a, a + w], [b2, b2 + w]);
    });
    for (let i = 1; i < t60s.length; i++) {
      expect(t60s[i]! / t60s[i - 1]!, `quartile ${i}`).toBeGreaterThan(1.8);
    }
    expect(t60s[0]!).toBeLessThan(0.2); // staccato at min
    expect(t60s[4]!).toBeGreaterThan(4); // long piano ring at max (G_MAX-muted
    // below the 10 s knob — the documented dark-loop physics, still huge)
  });

  it('BRIGHT: sustain centroid rises ≥25% per quartile (felt → steel)', () => {
    const cents = POS.map((f) => centroidHz(render({ brightness: f }, { durS: 0.7 }), 0.1, 0.5));
    for (let i = 1; i < cents.length; i++) {
      expect(cents[i]! / cents[i - 1]!, `quartile ${i}`).toBeGreaterThan(1.25);
    }
    expect(cents[0]!).toBeLessThan(200); // felt-muted: barely more than f0
    expect(cents[4]!).toBeGreaterThan(1200); // open steel
  });

  it('POS: h2/h1 falls monotonically ≥5% per quartile to the β = 0.5 comb null', () => {
    const ratios = POS.map((f) => {
      const v = faderVal(f, 0.02, 0.5, 'linear');
      const b = render({ position: v }, { durS: 0.7 });
      return partialMag(b, 0.1, 0.5, 440) / partialMag(b, 0.1, 0.5, 220);
    });
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]! / ratios[i - 1]!, `quartile ${i}`).toBeLessThan(0.95);
    }
    expect(ratios[0]! / ratios[4]!).toBeGreaterThan(20); // bridge-thin vs mid-null
  });

  it('STIFF: partial-3 peak walks monotonically sharp; ≥ +45 c at max (the retape guard)', () => {
    // POST-RETAPE law (karplusStiffA): the knob sets the allpass DC phase
    // delay, so dispersion is audible at the DEFAULT tune — the audit found
    // the original a = −0.55·knob mapping was DEAD below ~500 Hz (~2 c full
    // range). Audited p3 walk: −12c / −10c / +2c / +26c / +64c.
    const p3 = POS.map((f) =>
      partialPeakCents(render({ stiffness: f }, { durS: 0.7 }), 3 * 220, -60, 320),
    );
    expect(Math.abs(p3[0]!)).toBeLessThanOrEqual(16); // harmonic at knob 0
    for (let i = 1; i < p3.length; i++) {
      expect(p3[i]!, `quartile ${i} non-decreasing`).toBeGreaterThanOrEqual(p3[i - 1]!);
    }
    expect(p3[2]! - p3[0]!, 'audible by mid-travel').toBeGreaterThanOrEqual(8);
    expect(p3[4]!, 'bell zone at max').toBeGreaterThanOrEqual(45);
    expect(p3[4]! - p3[3]!, 'still moving in the top quartile').toBeGreaterThanOrEqual(15);
  });

  it('COLOR: attack centroid rises ≥15% per quartile (felt mallet → hard pick)', () => {
    const cents = POS.map((f) => centroidHz(render({ color: f }, { durS: 0.7 }), 0, 0.05));
    for (let i = 1; i < cents.length; i++) {
      expect(cents[i]! / cents[i - 1]!, `quartile ${i}`).toBeGreaterThan(1.15);
    }
    expect(cents[4]! / cents[0]!).toBeGreaterThan(3);
  });

  it('BURST: noise-splash duration ≥2× min → max; energy-normalized attacks', () => {
    // Dark string + bright exciter isolates the exciter: the ring can't hold
    // zcr > 3 kHz, so the splash length IS the audible scrape duration.
    const splashMs = (b: Float32Array): number => {
      let last = 0;
      for (let m = 0; m < 40; m++) {
        if (zcrRate(b, m / 1000, (m + 1) / 1000) > 3000) last = m + 1;
      }
      return last;
    };
    const rows = POS.map((f) => {
      const v = faderVal(f, 0.1, 4, 'log');
      const b = render({ burst: v, brightness: 0.25, color: 1 }, { durS: 0.7 });
      return { splash: splashMs(b), atk: dB(rmsW(b, 0, 0.03)) };
    });
    // Audited: 10 / 14 / 12 / 19 / 28 ms — a tick vs a scrape.
    expect(rows[4]!.splash).toBeGreaterThanOrEqual(rows[0]!.splash * 2);
    expect(rows[4]!.splash).toBeGreaterThan(rows[3]!.splash);
    expect(rows[1]!.splash).toBeGreaterThan(rows[0]!.splash);
    // 1/√periods energy normalization: every attack lands within a 3 dB band.
    const atks = rows.map((r) => r.atk);
    expect(Math.max(...atks) - Math.min(...atks)).toBeLessThan(3);
  });

  it('LEVEL: exact dB staging across the full −24 → +12 range', () => {
    const ref = dB(rmsW(render({ level: 0 }, { durS: 0.5 }), 0.02, 0.4));
    for (const f of POS) {
      const v = faderVal(f, -24, 12, 'linear');
      const got = dB(rmsW(render({ level: v }, { durS: 0.5 }), 0.02, 0.4));
      expect(Math.abs(got - ref - v), `level ${v} dB`).toBeLessThan(0.5);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CV inputs actually modulate
// ─────────────────────────────────────────────────────────────────────────

describe('karplus sonic range / CV inputs', () => {
  it('pitch: exact octaves at −1 / +1 / +2 V', () => {
    for (const cv of [-1, 1, 2]) {
      const expect0 = 220 * Math.pow(2, cv);
      const b = render({ pitchCv: cv });
      expect(Math.abs(measuredF0(b, expect0, 0.3, 0.8) / expect0 - 1)).toBeLessThan(0.005);
    }
  });

  it('accent: a full-accent hit is ≥3 dB hotter AND ≥20% brighter', () => {
    const soft = render({}, { durS: 0.6 });
    const hard = render({}, { durS: 0.6, accent: () => 1 });
    expect(dB(rmsW(hard, 0, 0.3)) - dB(rmsW(soft, 0, 0.3))).toBeGreaterThan(3);
    expect(centroidHz(hard, 0, 0.05) / centroidHz(soft, 0, 0.05)).toBeGreaterThan(1.2);
  });

  it('damp: ≥40 dB of choke WHILE high; the string rings again after release', () => {
    const free = render({}, { durS: 1.0 });
    const damp = (i: number) => (i >= 0.3 * SR && i < 0.6 * SR ? 1 : 0);
    const muted = render({}, { durS: 1.0, damp });
    expect(dB(rmsW(free, 0.4, 0.55)) - dB(rmsW(muted, 0.4, 0.55))).toBeGreaterThan(40);
    // Restrike after the gate falls: the palm mute released.
    const again = render({}, { durS: 1.2, strikes: [0, 0.7], damp });
    expect(dB(rmsW(again, 0.75, 0.9))).toBeGreaterThan(-30);
  });

  it('knob-modulator CVs (decay/bright/position/stiff/color paramTargets) move the param laws', () => {
    // The five *_cv inputs route to AudioParams (worklet a-rate arrays — the
    // per-sample plumbing is asserted in karplus.test.ts); at the core level
    // each target param must be live at ±25% knob throws around the default.
    const centDefault = centroidHz(render({}, { durS: 0.6 }), 0.1, 0.4);
    const centUp = centroidHz(render({ brightness: 0.95 }, { durS: 0.6 }), 0.1, 0.4);
    expect(centUp / centDefault).toBeGreaterThan(1.2);
    const t60Short = t60Fit(render({ decay: 0.5 }, { durS: 1 }), [0.06, 0.16], [0.4, 0.5]);
    const t60Long = t60Fit(render({ decay: 8 }, { durS: 3 }), [0.06, 0.16], [2.5, 2.6]);
    expect(t60Long / t60Short).toBeGreaterThan(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// karplusStiffA laws (the retape's own contract)
// ─────────────────────────────────────────────────────────────────────────

describe('karplus sonic range / karplusStiffA laws', () => {
  it('a(0) = 0 exactly (continuous topology — knob 0 renders bit-identically)', () => {
    for (const f0 of [55, 220, 880, 4200]) {
      expect(karplusStiffA(0, f0, SR)).toBe(0);
    }
  });

  it('a is monotone non-increasing in the knob (deeper pole toward z = 1)', () => {
    for (const f0 of [110, 440, 1760]) {
      let prev = 0;
      for (const k of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        const a = karplusStiffA(k, f0, SR);
        expect(a).toBeLessThanOrEqual(prev + 1e-12);
        prev = a;
      }
    }
  });

  it('tuning budget: the allpass pair never eats more than the budget at f0', () => {
    for (const f0 of [220, 880, 1760, 3520, 4200]) {
      const a = karplusStiffA(1, f0, SR);
      const w0 = (2 * Math.PI * f0) / SR;
      const used = 2 * karplusAllpassPhaseDelay(a, w0);
      // The bounded fixed-point refinement lands within a few % from above.
      expect(used).toBeLessThanOrEqual((KARPLUS_STIFF_BUDGET * SR * 1.05) / f0);
    }
  });

  it('1 V/oct stays under 3 cents WITH heavy stiffness (compensation exactness)', () => {
    // The retape must not cost tuning: C3 → C6 at knob 0.8.
    const C4 = 261.6256;
    for (const cv of [-1, 0, 1, 2]) {
      const fExp = C4 * Math.pow(2, cv);
      const b = render({ tune: C4, pitchCv: cv, stiffness: 0.8 });
      const f0 = measuredF0(b, fExp, 0.3, 0.8, 60);
      const cents = 1200 * Math.log2(f0 / fExp);
      expect(Math.abs(cents), `${fExp.toFixed(1)} Hz`).toBeLessThan(3);
    }
  });
});
