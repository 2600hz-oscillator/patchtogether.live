// packages/dsp/src/lib/karplus-dsp.test.ts
//
// Pure-core tests for the KARPLUS extended Karplus-Strong voice.
//
// THE tuning gate: 1 V/oct tracking must stay under 3 CENTS of error across
// ≥ 5 octaves (C2 → C7). Pitch is measured with a Hann-windowed Goertzel
// scan (±60 cents in 1-cent steps around the expected fundamental, parabolic
// vertex refine) — precise to well under a cent on a clean decaying tone.
//
// Also gated here: frequency-compensated decay (the knob reads in seconds at
// any pitch — the Jaffe–Smith ρ law), trigger edge semantics (a held-high
// trigger fires exactly once), DAMP palm-mute gating, pick-position comb
// physics (β = 0.5 cancels even harmonics), brightness spectral behavior,
// loop stability at the knob extremes, determinism, and sample-rate
// independence (44.1 kHz vs 48 kHz — no baked-in 48000).

import { describe, expect, it } from 'vitest';
import {
  KARPLUS_DEFAULTS,
  karplusAllpassPhaseDelay,
  karplusDampingCoeff,
  karplusDampingMag,
  karplusDelayTarget,
  karplusLoopRho,
  karplusStep,
  makeKarplusState,
  type KarplusParams,
} from './karplus-dsp';

const SR = 48000;
const C4 = 261.6256;

// ─────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────

interface RenderOpts {
  sr?: number;
  durS?: number;
  /** Strike times in seconds (5 ms flat-top trigger pulses). */
  strikes?: number[];
  /** Per-sample DAMP gate level (default 0). */
  damp?: (i: number, sr: number) => number;
  /** Per-sample accent level (default 0). */
  accent?: (i: number, sr: number) => number;
}

function render(opts: Partial<KarplusParams>, r: RenderOpts = {}): Float32Array {
  const sr = r.sr ?? SR;
  const durS = r.durS ?? 1.0;
  const strikes = r.strikes ?? [0];
  const p: KarplusParams = { ...KARPLUS_DEFAULTS, ...opts };
  const s = makeKarplusState(sr);
  const n = Math.round(sr * durS);
  const trig = new Float32Array(n);
  const pulse = Math.max(1, Math.round(0.005 * sr));
  for (const t of strikes) {
    const at = Math.round(t * sr);
    trig.fill(1, at, Math.min(n, at + pulse));
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = karplusStep(
      trig[i]!,
      r.accent ? r.accent(i, sr) : 0,
      r.damp ? r.damp(i, sr) : 0,
      p,
      sr,
      s,
    );
  }
  return out;
}

function rms(b: Float32Array, sS: number, eS: number, sr = SR): number {
  const s = Math.round(sS * sr);
  const e = Math.round(eS * sr);
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

function peakOf(b: Float32Array): number {
  let p = 0;
  for (const v of b) p = Math.max(p, Math.abs(v));
  return p;
}

/** Hann-windowed Goertzel magnitude of `buf[from..to)` at `freq`. */
function goertzelMag(buf: Float32Array, from: number, to: number, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
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

/** Peak magnitude near `fCenter` (±spanCents scan). */
function partialMag(
  buf: Float32Array,
  fromS: number,
  toS: number,
  fCenter: number,
  sr: number,
  spanCents = 40,
): number {
  const from = Math.round(fromS * sr);
  const to = Math.round(toS * sr);
  let best = 0;
  for (let c = -spanCents; c <= spanCents; c += 2) {
    const f = fCenter * Math.pow(2, c / 1200);
    best = Math.max(best, goertzelMag(buf, from, to, f, sr));
  }
  return best;
}

/** Measure the fundamental near fExpect: ±60-cent 1-cent Goertzel scan with
 *  parabolic vertex refinement. Returns the error in cents. */
function centsError(buf: Float32Array, fExpect: number, sr: number, fromS = 0.3, toS = 0.9): number {
  const from = Math.round(fromS * sr);
  const to = Math.round(toS * sr);
  const mags: number[] = [];
  let bestIdx = 0;
  for (let c = -60; c <= 60; c += 1) {
    const m = goertzelMag(buf, from, to, fExpect * Math.pow(2, c / 1200), sr);
    mags.push(m);
    if (m > mags[bestIdx]!) bestIdx = mags.length - 1;
  }
  let cents = bestIdx - 60;
  if (bestIdx > 0 && bestIdx < mags.length - 1) {
    const y0 = mags[bestIdx - 1]!;
    const y1 = mags[bestIdx]!;
    const y2 = mags[bestIdx + 1]!;
    const den = y0 - 2 * y1 + y2;
    if (den !== 0) cents += (0.5 * (y0 - y2)) / den;
  }
  return cents;
}

/** Fit t60 from the RMS decay slope between two windows. */
function measureT60(buf: Float32Array, w1: [number, number], w2: [number, number], sr = SR): number {
  const r1 = rms(buf, w1[0], w1[1], sr);
  const r2 = rms(buf, w2[0], w2[1], sr);
  const dt = (w2[0] + w2[1]) / 2 - (w1[0] + w1[1]) / 2;
  const dB = 20 * Math.log10(r1 / Math.max(1e-12, r2));
  return (60 * dt) / Math.max(1e-6, dB);
}

// ─────────────────────────────────────────────────────────────────────────
// 1 V/oct tuning — THE gate
// ─────────────────────────────────────────────────────────────────────────

describe('karplus-dsp / 1V/oct tuning', () => {
  it('tracks under 3 cents across 5 octaves (C2 → C7) at default knobs', () => {
    for (const cv of [-2, -1, 0, 1, 2, 3]) {
      const fExpect = C4 * Math.pow(2, cv);
      const out = render({ tune: C4, pitchCv: cv });
      const err = centsError(out, fExpect, SR);
      expect(Math.abs(err), `cv=${cv} (${fExpect.toFixed(2)} Hz): ${err.toFixed(3)} cents`).toBeLessThan(3);
    }
  });

  it('stays under 3 cents with brightness/stiffness/position off default (compensation holds)', () => {
    for (const cv of [-2, 0, 3]) {
      const fExpect = C4 * Math.pow(2, cv);
      const out = render({
        tune: C4,
        pitchCv: cv,
        brightness: 0.35,
        stiffness: 0.5,
        position: 0.35,
        color: 0.8,
      });
      const err = centsError(out, fExpect, SR);
      expect(Math.abs(err), `cv=${cv} variant: ${err.toFixed(3)} cents`).toBeLessThan(3);
    }
  });

  it('is sample-rate independent: under 3 cents at 44.1 kHz too', () => {
    for (const cv of [-1, 2]) {
      const fExpect = C4 * Math.pow(2, cv);
      const out = render({ tune: C4, pitchCv: cv }, { sr: 44100 });
      const err = centsError(out, fExpect, 44100);
      expect(Math.abs(err), `44.1k cv=${cv}: ${err.toFixed(3)} cents`).toBeLessThan(3);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Frequency-compensated decay
// ─────────────────────────────────────────────────────────────────────────

describe('karplus-dsp / decay calibration', () => {
  it('t60 ≈ the DECAY knob in seconds, at both A2 and A5 (no pitch coupling)', () => {
    const t110 = measureT60(render({ tune: 110, decay: 1 }, { durS: 1.6 }), [0.4, 0.5], [1.2, 1.3]);
    const t880 = measureT60(render({ tune: 880, decay: 1 }, { durS: 1.6 }), [0.4, 0.5], [1.2, 1.3]);
    expect(t110, `t60@110Hz=${t110.toFixed(3)}`).toBeGreaterThan(0.7);
    expect(t110).toBeLessThan(1.35);
    expect(t880, `t60@880Hz=${t880.toFixed(3)}`).toBeGreaterThan(0.7);
    expect(t880).toBeLessThan(1.35);
    // The classic K-S sin this fixes: low notes must NOT ring ~8× longer.
    const ratio = t110 / t880;
    expect(ratio, `t60 ratio A2/A5 = ${ratio.toFixed(3)}`).toBeGreaterThan(0.72);
    expect(ratio).toBeLessThan(1.4);
  });

  it('rho law: ρ^(f0·t60) is exactly −60 dB', () => {
    const rho = karplusLoopRho(220, 2);
    expect(Math.pow(rho, 220 * 2)).toBeCloseTo(0.001, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Trigger / accent / damp semantics
// ─────────────────────────────────────────────────────────────────────────

describe('karplus-dsp / strike + damp semantics', () => {
  it('a held-high trigger fires EXACTLY once (bit-identical to a 5 ms pulse)', () => {
    const pulse = render({}, { durS: 0.8 });
    const p: KarplusParams = { ...KARPLUS_DEFAULTS };
    const s = makeKarplusState(SR);
    const n = Math.round(SR * 0.8);
    const held = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // High for a full 0.4 s — a gate mis-read as repeated triggers would
      // re-excite continuously.
      held[i] = karplusStep(i < Math.round(0.4 * SR) ? 1 : 0, 0, 0, p, SR, s);
    }
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(pulse[i]! - held[i]!));
    expect(maxDiff).toBe(0);
  });

  it('a second rising edge re-excites the (still ringing) string', () => {
    const out = render({}, { durS: 1.0, strikes: [0, 0.5] });
    const before = rms(out, 0.44, 0.5);
    const after = rms(out, 0.5, 0.56);
    expect(after).toBeGreaterThan(before * 1.5);
  });

  it('accent latched at the edge makes the hit louder', () => {
    const soft = render({}, { durS: 0.5 });
    const hard = render({}, { durS: 0.5, accent: () => 1 });
    expect(rms(hard, 0.02, 0.3)).toBeGreaterThan(rms(soft, 0.02, 0.3) * 1.2);
  });

  it('DAMP palm-mutes WHILE high and releases for the next strike', () => {
    const free = render({}, { durS: 1.0 });
    const muted = render({}, {
      durS: 1.0,
      strikes: [0, 0.6],
      damp: (i, sr) => (i >= 0.3 * sr && i < 0.55 * sr ? 1 : 0),
    });
    // While held: the tail collapses far below the free ring.
    expect(rms(muted, 0.45, 0.55)).toBeLessThan(rms(free, 0.45, 0.55) * 0.05);
    // After release: the re-strike rings normally again.
    expect(rms(muted, 0.62, 0.72)).toBeGreaterThan(rms(free, 0.02, 0.12) * 0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The EKS timbre controls do their physics
// ─────────────────────────────────────────────────────────────────────────

describe('karplus-dsp / timbre controls', () => {
  it('position β = 0.5 cancels even harmonics (vs β = 0.12)', () => {
    const mid = render({ position: 0.5 });
    const edge = render({ position: 0.12 });
    const h2overH1mid =
      partialMag(mid, 0.05, 0.4, 440, SR) / partialMag(mid, 0.05, 0.4, 220, SR);
    const h2overH1edge =
      partialMag(edge, 0.05, 0.4, 440, SR) / partialMag(edge, 0.05, 0.4, 220, SR);
    expect(h2overH1mid).toBeLessThan(h2overH1edge * 0.15);
  });

  it('darker brightness kills upper partials harder (5th partial vs fundamental)', () => {
    const dark = render({ brightness: 0.2, color: 0.8 });
    const bright = render({ brightness: 0.95, color: 0.8 });
    const ratioDark =
      partialMag(dark, 0.25, 0.55, 5 * 220, SR) / partialMag(dark, 0.25, 0.55, 220, SR);
    const ratioBright =
      partialMag(bright, 0.25, 0.55, 5 * 220, SR) / partialMag(bright, 0.25, 0.55, 220, SR);
    expect(ratioDark).toBeLessThan(ratioBright * 0.5);
  });

  it('stiffness stretches partial 2 SHARP at A5 (monotone into the bell zone)', () => {
    // POST-RETAPE (2026-07-11 sonic audit): karplusStiffA maps the knob to
    // the allpass DC phase delay, so the stretch is far deeper than the
    // original a = −0.55·knob law (which moved partials ~2 c at low pitch —
    // a dead knob below ~500 Hz; see karplus-dsp.sonic-range.test.ts for
    // the full 5-point sweep at the default tune). Here: track the partial-2
    // PEAK at A5 — its slot has ±700 c of clearance, so identification is
    // unambiguous even at bell-depth stretches. Audited walk: −10 c at
    // knob 0, +36 c at 0.25, +184 c at 0.5.
    const peakCents = (stiffness: number): number => {
      const b = render({ tune: 880, stiffness, color: 0.9, brightness: 0.9 });
      const from = Math.round(0.05 * SR);
      const to = Math.round(0.35 * SR);
      let best = 0;
      let bestC = -60;
      for (let c = -60; c <= 400; c += 2) {
        const m = goertzelMag(b, from, to, 2 * 880 * Math.pow(2, c / 1200), SR);
        if (m > best) {
          best = m;
          bestC = c;
        }
      }
      return bestC;
    };
    const p0 = peakCents(0);
    const p25 = peakCents(0.25);
    const p50 = peakCents(0.5);
    expect(Math.abs(p0)).toBeLessThanOrEqual(14); // harmonic string at knob 0
    expect(p25).toBeGreaterThanOrEqual(25); // audibly sharp by 25% travel
    expect(p50).toBeGreaterThanOrEqual(100); // bell territory by mid-travel
    expect(p50).toBeGreaterThan(p25);
  });

  it('exciter range stays audible and bounded (mallet ↔ scrape extremes)', () => {
    const mallet = render({ color: 0, burst: 0.1 }, { durS: 0.6 });
    const scrape = render({ color: 1, burst: 4 }, { durS: 0.6 });
    for (const b of [mallet, scrape]) {
      expect(rms(b, 0.02, 0.4)).toBeGreaterThan(0.01);
      expect(peakOf(b)).toBeLessThan(1.6);
      expect(b.every(Number.isFinite)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Stability + determinism
// ─────────────────────────────────────────────────────────────────────────

describe('karplus-dsp / stability + determinism', () => {
  it('never grows at the hostile extremes (max decay/brightness/stiffness, hi + lo pitch)', () => {
    for (const opts of [
      { tune: 1760, pitchCv: 1, decay: 10, brightness: 1, stiffness: 1, color: 1, burst: 4 },
      { tune: 55, pitchCv: -0.8, decay: 10, brightness: 1, stiffness: 1, color: 1, burst: 4 },
      // Max-dark: the largest gain compensation the loop ever applies.
      { tune: 880, decay: 10, brightness: 0, stiffness: 1, color: 0.5, burst: 1 },
    ]) {
      const out = render(opts, { durS: 3.0 });
      expect(out.every(Number.isFinite)).toBe(true);
      expect(peakOf(out)).toBeLessThan(3);
      expect(rms(out, 2.5, 2.9)).toBeLessThanOrEqual(rms(out, 0.3, 0.7) * 1.05);
    }
  });

  it('renders are bit-identical (seeded burst, no wall-clock randomness)', () => {
    const a = render({}, { durS: 0.7, strikes: [0, 0.35] });
    const b = render({}, { durS: 0.7, strikes: [0, 0.35] });
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBe(0);
  });

  it('output is DC-free (in-loop blocker + comb zero at DC)', () => {
    const out = render({}, { durS: 1.0 });
    let sum = 0;
    for (const v of out) sum += v;
    expect(Math.abs(sum / out.length)).toBeLessThan(0.01);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Pure laws
// ─────────────────────────────────────────────────────────────────────────

describe('karplus-dsp / pure laws', () => {
  it('allpass phase delay is exactly 1 sample at a = 0 (continuous topology)', () => {
    for (const w of [0.01, 0.1, 0.5, 1.0]) {
      expect(karplusAllpassPhaseDelay(0, w)).toBeCloseTo(1, 9);
    }
  });

  it('damping magnitude: unity at DC, monotone non-increasing in frequency', () => {
    for (const b of [0, 0.3, 0.7, 1]) {
      const a = karplusDampingCoeff(220, b, SR);
      expect(karplusDampingMag(a, 1e-9)).toBeCloseTo(1, 5);
      let prev = 1;
      for (const w of [0.05, 0.2, 0.5, 1, 2, 3]) {
        const m = karplusDampingMag(a, w);
        expect(m).toBeLessThanOrEqual(prev + 1e-12);
        prev = m;
      }
    }
  });

  it('delay target: shorter than sr/f0 by the loop stages; darker/stiffer → shorter', () => {
    const dBright = karplusDelayTarget(220, 1, 0, SR);
    // Bright + no stiffness: ~2 samples of allpass + a small LP delay,
    // minus the tracked DC blocker's ~1.7-sample lead at 220 Hz.
    expect(dBright).toBeGreaterThan(SR / 220 - 4);
    expect(dBright).toBeLessThan(SR / 220 + 0.5);
    // A darker loop filter delays more at f0 → the line must shorten.
    expect(karplusDelayTarget(220, 0.2, 0, SR)).toBeLessThan(dBright);
    // Stiffness allpasses delay more → shorter again.
    expect(karplusDelayTarget(220, 1, 1, SR)).toBeLessThan(dBright);
  });
});
