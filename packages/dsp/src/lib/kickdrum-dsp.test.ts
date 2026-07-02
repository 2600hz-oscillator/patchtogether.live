// packages/dsp/src/lib/kickdrum-dsp.test.ts
//
// Phase-1 proving tests for the KICK DRUM core (plan §5 Phase 1): strike
// determinism, the frequency laws, sr-CALIBRATED decay (identical at 44 100
// and 48 000 — audit A2), DC cleanliness, accent latching, and the Phase-1
// headroom invariant (peak ≤ 1 pre-drive).

import { describe, it, expect } from 'vitest';
import {
  KICKDRUM_P1_DEFAULTS,
  kickBodyFreqHz,
  kickSubFreqHz,
  kickdrumP1Step,
  makeKickdrumState,
  decayCoeff,
  type KickdrumP1Params,
} from './kickdrum-dsp';

const P = (over: Partial<KickdrumP1Params> = {}): KickdrumP1Params => ({
  ...KICKDRUM_P1_DEFAULTS,
  ...over,
});

/** Render n samples; trigger fires high for the first 10 samples. */
function render(
  n: number,
  p: KickdrumP1Params,
  sr: number,
  opts: { accent?: number; state?: ReturnType<typeof makeKickdrumState> } = {},
): Float32Array {
  const s = opts.state ?? makeKickdrumState();
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    out[t] = kickdrumP1Step(t < 10 ? 1 : 0, opts.accent ?? 0, p, sr, s);
  }
  return out;
}

describe('kickdrum P1: strike determinism', () => {
  it('phase-resets on the strike: every hit renders IDENTICAL samples', () => {
    const p = P({ tension: 0.3 });
    const s = makeKickdrumState();
    const sr = 48000;
    const hit = (warm: number) => {
      // idle gap, then strike, then capture
      for (let t = 0; t < warm; t++) kickdrumP1Step(0, 0, p, sr, s);
      const buf = new Float32Array(2048);
      for (let t = 0; t < 2048; t++) {
        buf[t] = kickdrumP1Step(t < 10 ? 1 : 0, 0, p, sr, s);
      }
      return buf;
    };
    const first = hit(0);
    // Let the voice ring out well past every envelope (subDecay 450 ms).
    const second = hit(48000);
    for (let i = 0; i < 2048; i++) {
      expect(second[i]).toBeCloseTo(first[i], 6);
    }
  });

  it('two independent states render bit-identical output (pure core)', () => {
    const a = render(4096, P(), 48000);
    const b = render(4096, P(), 48000);
    expect(a).toEqual(b);
  });
});

describe('kickdrum P1: frequency laws', () => {
  it('body starts pitchAmt semitones above settled (24 st = the canonical 4×)', () => {
    const p = P({ pitchAmt: 24, tune: 50 });
    const settled = kickBodyFreqHz(p, 0, 0, 0);
    const atStrike = kickBodyFreqHz(p, 1, 0, 0);
    expect(settled).toBeCloseTo(100, 6); // one octave above the 50 Hz sub
    expect(atStrike / settled).toBeCloseTo(4, 5); // 24 st = 2 octaves = 4×
  });

  it('sub settles to tune and starts gently (≤1.5×)', () => {
    const p = P({ tune: 50, pitchAmt: 24 });
    expect(kickSubFreqHz(p, 0)).toBeCloseTo(50, 6);
    expect(kickSubFreqHz(p, 1)).toBeCloseTo(75, 6); // 1.5× cap at full depth
  });

  it('pitch_cv is 1 V/oct across BOTH layers', () => {
    const p = P({ pitchCv: 1 });
    expect(kickSubFreqHz(p, 0)).toBeCloseTo(100, 6);
    expect(kickBodyFreqHz(p, 0, 0, 0)).toBeCloseTo(200, 6);
  });

  it('tension raises the body frequency by (1 + term)', () => {
    const p = P();
    const base = kickBodyFreqHz(p, 0, 0, 0);
    expect(kickBodyFreqHz(p, 0, 0.6, 0) / base).toBeCloseTo(1.6, 6);
  });

  it('accent deepens the body sweep by up to 50%', () => {
    const p = P({ pitchAmt: 24 });
    const plain = kickBodyFreqHz(p, 1, 0, 0);
    const accented = kickBodyFreqHz(p, 1, 0, 1);
    // 24 st → 36 st at full accent: ratio 2^(36/12) / 2^(24/12) = 2.
    expect(accented / plain).toBeCloseTo(2, 5);
  });
});

describe('kickdrum P1: sr-calibrated decay (audit A2)', () => {
  /** Samples until the sub amp envelope crosses −60 dB, via the state. */
  function subDecaySamples(sr: number, subDecayMs: number): number {
    const s = makeKickdrumState();
    const p = P({ subDecay: subDecayMs });
    kickdrumP1Step(1, 0, p, sr, s); // strike
    let t = 1;
    while (s.subAmp > 1e-3 && t < sr * 5) {
      kickdrumP1Step(0, 0, p, sr, s);
      t++;
    }
    return t;
  }

  it.each([44100, 48000] as const)('subDecay=450 ms decays to −60 dB in ~450 ms at %i Hz', (sr) => {
    const ms = (subDecaySamples(sr, 450) / sr) * 1000;
    expect(ms).toBeGreaterThan(440);
    expect(ms).toBeLessThan(460);
  });

  it('decayCoeff hits −60 dB at exactly the knob time (both rates)', () => {
    for (const sr of [44100, 48000]) {
      const a = decayCoeff(200, sr);
      const env = Math.pow(a, (200 / 1000) * sr);
      expect(env).toBeCloseTo(1e-3, 5);
    }
  });
});

describe('kickdrum P1: output invariants', () => {
  it('output DC ≈ 0 after the dc-block (full ring-out)', () => {
    const buf = render(48000, P({ bodyShape: 1 }), 48000); // rect = worst DC case
    let mean = 0;
    for (let i = 0; i < buf.length; i++) mean += buf[i];
    mean /= buf.length;
    expect(Math.abs(mean)).toBeLessThan(1e-3);
  });

  it('peak ≤ 1 pre-drive even with both layers maxed (headroom invariant)', () => {
    const buf = render(24000, P({ subLevel: 1, bodyLevel: 1, bodyShape: 1 }), 48000);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    expect(peak).toBeLessThanOrEqual(1.0);
    expect(peak).toBeGreaterThan(0.3); // and it's actually loud, not vacuous
  });

  it('accent is LATCHED at the strike edge — mid-note accent changes are ignored', () => {
    const p = P({ pitchAmt: 24 });
    const sr = 48000;
    const a = makeKickdrumState();
    const b = makeKickdrumState();
    const bufA = new Float32Array(2048);
    const bufB = new Float32Array(2048);
    for (let t = 0; t < 2048; t++) {
      const trig = t < 10 ? 1 : 0;
      // A: accent 0 the whole time. B: accent 0 at the strike, slams to 1 after.
      bufA[t] = kickdrumP1Step(trig, 0, p, sr, a);
      bufB[t] = kickdrumP1Step(trig, t > 100 ? 1 : 0, p, sr, b);
    }
    expect(bufB).toEqual(bufA);
  });

  it('a second strike retriggers a silent voice (no one-shot latch bug)', () => {
    const p = P();
    const s = makeKickdrumState();
    const sr = 48000;
    // First hit, ring fully out.
    for (let t = 0; t < 48000; t++) kickdrumP1Step(t < 10 ? 1 : 0, 0, p, sr, s);
    // Second hit must produce energy again.
    let peak = 0;
    for (let t = 0; t < 4800; t++) {
      const y = kickdrumP1Step(t < 10 ? 1 : 0, 0, p, sr, s);
      peak = Math.max(peak, Math.abs(y));
    }
    expect(peak).toBeGreaterThan(0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 2 — click layer + oversampled drive (`hard` switch)
// ─────────────────────────────────────────────────────────────────────────

/** Exact single-bin magnitude (rectangular window). */
function goertzelMag(buf: Float32Array, bin: number): number {
  const w = (2 * Math.PI * bin) / buf.length;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
}

describe('kickdrum P2: click layer', () => {
  it('click is band-limited to click_tone and gone within click_len', () => {
    // Click ONLY (sub/body muted, drive off): energy concentrates near the
    // BPF center; the burst dies at the knob time.
    const p = P({
      subLevel: 0,
      bodyLevel: 0,
      clickLevel: 1,
      drive: 0,
      clickTone: 2000,
      clickLen: 12,
    });
    const buf = render(4800, p, 48000); // 100 ms, 2000 Hz → bin 200
    const atTone = goertzelMag(buf, 200);
    expect(atTone / (goertzelMag(buf, 20) + 1e-12)).toBeGreaterThan(3); // vs 200 Hz
    expect(atTone / (goertzelMag(buf, 800) + 1e-12)).toBeGreaterThan(3); // vs 8 kHz
    const rms = (a: number, b: number) => {
      let acc = 0;
      for (let i = a; i < b; i++) acc += buf[i] * buf[i];
      return Math.sqrt(acc / (b - a));
    };
    // 30–100 ms is ≪ the first 12 ms burst (−60 dB decay at click_len).
    expect(rms(1440, 4800) / (rms(0, 576) + 1e-12)).toBeLessThan(0.02);
  });

  it('click is deterministic per strike (seeded noise, filter re-zeroed)', () => {
    const p = P({ subLevel: 0, bodyLevel: 0, clickLevel: 1 });
    expect(render(1024, p, 48000)).toEqual(render(1024, p, 48000));
  });
});

describe('kickdrum P2: oversampled drive + the `hard` switch', () => {
  // Static 100 Hz sine body (pitchAmt 0, shape 0, sub/click muted) so the
  // 3rd harmonic sits exactly on bin 30 of a 4800-sample window.
  const driveBase: Partial<KickdrumP1Params> = {
    subLevel: 0,
    clickLevel: 0,
    bodyLevel: 1,
    bodyShape: 0,
    pitchAmt: 0,
    bodyDecay: 400,
    tension: 0,
    hard: 0,
  };

  function h3Ratio(drive: number): number {
    const buf = render(4800, P({ ...driveBase, drive }), 48000);
    return goertzelMag(buf, 30) / (goertzelMag(buf, 10) + 1e-12);
  }

  it('clean mode: drive adds odd harmonics; drive=0 is transparent', () => {
    expect(h3Ratio(0)).toBeLessThan(0.02); // bypass — no saturation products
    expect(h3Ratio(0.9)).toBeGreaterThan(0.05); // tanh 3rd harmonic present
  });

  it('HARD mode: more bite than clean at the same drive, bounded, DC-clean', () => {
    const base: Partial<KickdrumP1Params> = { drive: 0.8, bodyDecay: 300, clickLevel: 0 };
    const clean = render(24000, P({ ...base, hard: 0 }), 48000);
    const hard = render(24000, P({ ...base, hard: 1 }), 48000);
    // First-difference energy = a crude high-band proxy: the fold/asym
    // character must measurably out-bite the tanh at equal drive.
    const hf = (buf: Float32Array) => {
      let acc = 0;
      for (let i = 1; i < buf.length; i++) {
        const d = buf[i] - buf[i - 1];
        acc += d * d;
      }
      return acc;
    };
    expect(hf(hard)).toBeGreaterThan(hf(clean) * 1.2);
    let peak = 0;
    let mean = 0;
    for (let i = 0; i < hard.length; i++) {
      peak = Math.max(peak, Math.abs(hard[i]));
      mean += hard[i];
    }
    // The nonlinearity is bounded ≤ ~0.9, but the decimation FIR reconstructs
    // intersample (Gibbs) peaks past a hard fold — a few % overshoot is
    // physics, not a bug (measured ≈1.065). Phase 4's `ceiling` soft-clip is
    // the TRUE-PEAK bound; pre-ceiling the honest invariant is ≤ 1.1.
    expect(peak).toBeLessThanOrEqual(1.1);
    expect(Math.abs(mean / hard.length)).toBeLessThan(1e-3); // asym DC stripped
  });

  it('full voice with drive + click stays strike-deterministic', () => {
    const p = P({ drive: 0.7, hard: 1 });
    expect(render(4096, p, 48000)).toEqual(render(4096, p, 48000));
  });
});
