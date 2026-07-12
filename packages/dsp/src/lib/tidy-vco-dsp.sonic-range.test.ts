// packages/dsp/src/lib/tidy-vco-dsp.sonic-range.test.ts
//
// TIDY VCO sonic-range proofs — the drum-wave bar: EVERY control is
// sonically dynamic across its whole travel, gated as 5-point (3-point for
// the discrete OCT switch) STRICT-MONOTONE metrics on rendered audio. No
// dead zones: each proof asserts a measured, musically meaningful metric
// (spectral centroid, harmonic ratios, beat rate, envelope timing, stereo
// correlation) strictly ordered across the control's range.

import { describe, expect, it } from 'vitest';

import {
  TIDY_C4_HZ,
  TIDY_VCO_DEFAULTS,
  diodeLadderStep,
  foldAdaaStep,
  makeDiodeLadderState,
  makeFoldState,
  makeTidyVcoState,
  renderTidyVco,
  tidyCutoffToG,
  tidyDriveGains,
  tidyFoldBias,
  tidyFoldGain,
  type TidyVcoBus,
  type TidyVcoParams,
} from './tidy-vco-dsp';
import { createOversampler } from './oversample';

const SR = 48000;

// ── local spectral helpers (house pattern: hand-rolled per test file) ────

function goertzel(buf: Float32Array, rate: number, hz: number, s0: number, s1: number): number {
  const n = s1 - s0;
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = s0; i < s1; i++) {
    const wnd = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - s0)) / n);
    const q0 = c * q1 - q2 + (buf[i] ?? 0) * wnd;
    q2 = q1;
    q1 = q0;
  }
  return Math.sqrt(Math.max(0, q1 * q1 + q2 * q2 - c * q1 * q2)) / n;
}

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

function rms(buf: Float32Array, s0: number, s1: number): number {
  let s = 0;
  for (let i = s0; i < s1; i++) s += (buf[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, s1 - s0));
}

/** Diff-based spectral centroid (Hz) — exact for a sine, robust for ratios. */
function centroidHz(buf: Float32Array, s0: number, s1: number): number {
  let num = 0;
  let den = 0;
  for (let i = s0 + 1; i < s1; i++) {
    const d = (buf[i] ?? 0) - (buf[i - 1] ?? 0);
    num += d * d;
    den += (buf[i] ?? 0) ** 2;
  }
  return (SR / (2 * Math.PI)) * Math.sqrt(num / Math.max(den, 1e-20));
}

function assertStrictlyIncreasing(values: number[], label: string, minGap = 0): void {
  for (let i = 1; i < values.length; i++) {
    expect(
      values[i]! - values[i - 1]!,
      `${label}: step ${i - 1}→${i} of [${values.map((v) => v.toFixed(2)).join(', ')}]`,
    ).toBeGreaterThan(minGap);
  }
}

// ── render helpers ────────────────────────────────────────────────────────

function lane0Bus(voct: number, gate = 1): TidyVcoBus {
  const poly = new Float32Array(10);
  poly[0] = voct;
  poly[1] = gate;
  return { poly, monoPitch: 0, monoGate: 0, resCv: 0, driveCv: 0 };
}

function probePatch(over: Partial<TidyVcoParams> = {}): TidyVcoParams {
  return {
    ...TIDY_VCO_DEFAULTS,
    shape1: 0,
    shape2: 0,
    detune: 0,
    oct2: 0,
    mix: 0,
    sub: 0,
    drive: 0,
    res: 0.2,
    env: 0,
    track: 0,
    cutoff: 8000,
    width: 0,
    sus: 1,
    atk: 0.002,
    ...over,
  };
}

function renderL(p: TidyVcoParams, bus: TidyVcoBus, seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  renderTidyVco(p, bus, l, r, 0, n, SR, makeTidyVcoState());
  return l;
}

/** Render with a gate-off point: [0, holdS) gated, [holdS, seconds) off. */
function renderGateOff(p: TidyVcoParams, voct: number, holdS: number, seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const hold = Math.round(holdS * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const st = makeTidyVcoState();
  renderTidyVco(p, lane0Bus(voct), l, r, 0, hold, SR, st);
  renderTidyVco(p, lane0Bus(voct, 0), l, r, hold, n, SR, st);
  return l;
}

// ─────────────────────────────────────────────────────────────────────────
// FILTER section
// ─────────────────────────────────────────────────────────────────────────

describe('sonic range — filter', () => {
  it('CUTOFF sweeps the centroid across its whole 40 Hz–14 kHz travel (5-point)', () => {
    const values = [60, 240, 900, 3500, 14000].map((cutoff) => {
      const l = renderL(probePatch({ cutoff }), lane0Bus(-1), 0.8); // C3 saw
      expect(rms(l, SR / 2, l.length), `audible at cutoff ${cutoff}`).toBeGreaterThan(1e-4);
      return centroidHz(l, SR / 2, l.length);
    });
    assertStrictlyIncreasing(values, 'centroid vs cutoff');
    expect(values[4]! / values[0]!).toBeGreaterThan(4); // a real full-range sweep
  });

  it('RES adds resonant energy monotonically from clean to the whistle (5-point)', () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map((res) => {
      const l = renderL(probePatch({ cutoff: 900, res }), lane0Bus(0.5), 1);
      return rms(l, SR / 2, l.length);
    });
    assertStrictlyIncreasing(values, 'RMS vs res');
    expect(values[4]! / values[0]!).toBeGreaterThan(2.5);
  });

  it('DRIVE grows odd harmonics > 20 dB across its travel (5-point, sine → drive → ladder)', () => {
    const os = 2 * SR;
    const g = tidyCutoffToG(8000, os);
    const values = [0, 0.25, 0.5, 0.75, 1].map((drive) => {
      const { preGain, makeup } = tidyDriveGains(drive);
      const st = makeDiodeLadderState();
      const n = os;
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = 0.35 * Math.sin((2 * Math.PI * 220 * i) / os);
        buf[i] = diodeLadderStep(st, Math.tanh(preGain * x) * makeup, g, 0);
      }
      return db(goertzel(buf, os, 660, n / 2, n) / goertzel(buf, os, 220, n / 2, n));
    });
    assertStrictlyIncreasing(values, 'H3/H1 vs drive', 0.5);
    expect(values[4]! - values[0]!).toBeGreaterThan(20);
  });

  it('ENV sweeps the attack brightness bipolar, dark→bright through zero (5-point)', () => {
    const values = [-1, -0.5, 0, 0.5, 1].map((env) => {
      const p = probePatch({ cutoff: 900, env, fatk: 0.001, fdec: 0.15, fsus: 0 });
      const l = renderL(p, lane0Bus(0), 0.8);
      const early = centroidHz(l, Math.round(0.005 * SR), Math.round(0.1 * SR));
      const late = centroidHz(l, Math.round(0.55 * SR), Math.round(0.75 * SR));
      return early - late; // signed excursion of the filter EG sweep
    });
    assertStrictlyIncreasing(values, 'centroid excursion vs env');
    expect(values[0]!).toBeLessThan(0); // negative EG pulls the attack dark
    expect(values[4]!).toBeGreaterThan(0); // positive EG opens the attack
  });

  it('TRACK carries brightness up the keyboard monotonically (5-point, H4/H1 at C6)', () => {
    const f0 = 1046.5;
    const values = [0, 0.25, 0.5, 0.75, 1].map((track) => {
      const l = renderL(probePatch({ cutoff: 1200, track }), lane0Bus(2), 1);
      return db(goertzel(l, SR, 4 * f0, SR / 2, l.length) / goertzel(l, SR, f0, SR / 2, l.length));
    });
    assertStrictlyIncreasing(values, 'H4/H1 vs track', 1);
    expect(values[4]! - values[0]!).toBeGreaterThan(18);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// OSCILLATOR section
// ─────────────────────────────────────────────────────────────────────────

describe('sonic range — oscillators', () => {
  it('SHAPE1 morphs saw→pulse: even harmonics drain monotonically (5-point)', () => {
    const f0 = TIDY_C4_HZ;
    const values = [0, 0.25, 0.5, 0.75, 1].map((shape1) => {
      const l = renderL(probePatch({ shape1, pw: 0.5 }), lane0Bus(0), 1);
      return db(goertzel(l, SR, 2 * f0, SR / 2, l.length) / goertzel(l, SR, f0, SR / 2, l.length));
    });
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!, `H2/H1 falls: ${values.map((v) => v.toFixed(1)).join(', ')}`).toBeLessThan(
        values[i - 1]! - 1,
      );
    }
    expect(values[4]!, 'square end: even harmonics gone').toBeLessThan(-30);
  });

  it('SHAPE2 morphs OSC2 the same way (5-point, mix = 1)', () => {
    const f0 = TIDY_C4_HZ;
    const values = [0, 0.25, 0.5, 0.75, 1].map((shape2) => {
      const l = renderL(probePatch({ shape2, mix: 1, pw: 0.5 }), lane0Bus(0), 1);
      return db(goertzel(l, SR, 2 * f0, SR / 2, l.length) / goertzel(l, SR, f0, SR / 2, l.length));
    });
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThan(values[i - 1]! - 1);
    }
    expect(values[4]!).toBeLessThan(-30);
  });

  it('PW thins the pulse: H2/H1 rises as duty leaves square (5-point)', () => {
    const f0 = TIDY_C4_HZ;
    const values = [0.5, 0.4, 0.3, 0.2, 0.1].map((pw) => {
      const l = renderL(probePatch({ shape1: 1, pw }), lane0Bus(0), 1);
      return db(goertzel(l, SR, 2 * f0, SR / 2, l.length) / goertzel(l, SR, f0, SR / 2, l.length));
    });
    assertStrictlyIncreasing(values, 'H2/H1 vs thinning pw', 1);
    expect(values[0]!, 'square: even null').toBeLessThan(-30);
  });

  it('DETUNE sets the two-osc beat rate (predicted ±30 %, plus a no-beat control)', () => {
    const f1 = 220; // A3 (voct −0.25... use exact voct)
    const voct = Math.log2(f1 / TIDY_C4_HZ);
    const beatOf = (cents: number): number => {
      const p = probePatch({ mix: 0.5, detune: cents, cutoff: 4000 });
      const l = renderL(p, lane0Bus(voct), 2.2);
      // Short-window RMS envelope → autocorrelation → beat period.
      const win = Math.round(0.01 * SR);
      const hop = Math.round(0.0025 * SR);
      const env: number[] = [];
      for (let s = Math.round(0.2 * SR); s + win < l.length; s += hop) env.push(rms(l, s, s + win));
      const mean = env.reduce((a, b) => a + b, 0) / env.length;
      const e = env.map((v) => v - mean);
      const hopS = hop / SR;
      const maxLag = Math.min(e.length - 1, Math.round(1.6 / hopS));
      const minLag = Math.round(0.06 / hopS);
      const ac: number[] = new Array(maxLag + 1).fill(0);
      let best = -Infinity;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let acc = 0;
        for (let i = 0; i + lag < e.length; i++) acc += e[i]! * e[i + lag]!;
        acc /= e.length - lag;
        ac[lag] = acc;
        if (acc > best) best = acc;
      }
      // FIRST peak at ≥ 90 % of the global max — the fundamental beat
      // period (the global argmax can land on a 2×/3× multiple, all
      // near-equal for a periodic envelope).
      let bestLag = maxLag;
      for (let lag = minLag + 1; lag < maxLag; lag++) {
        if (ac[lag]! >= 0.9 * best && ac[lag]! >= ac[lag - 1]! && ac[lag]! >= ac[lag + 1]!) {
          bestLag = lag;
          break;
        }
      }
      // Depth guard: a real two-osc beat swings the envelope near-fully;
      // window/period micro-ripple stays far below this.
      const depth = (Math.max(...env) - Math.min(...env)) / Math.max(...env);
      return depth < 0.15 ? 0 : 1 / (bestLag * hopS);
    };
    expect(beatOf(0), 'no detune → no beat').toBe(0);
    for (const cents of [15, 30, 50]) {
      const predicted = f1 * (Math.pow(2, cents / 1200) - 1);
      const measured = beatOf(cents);
      expect(measured, `beat at ${cents}¢`).toBeGreaterThan(predicted * 0.7);
      expect(measured).toBeLessThan(predicted * 1.3);
    }
  });

  it('OCT2 moves the OSC2 fundamental by exact octaves (3-point = full discrete travel)', () => {
    const f0 = TIDY_C4_HZ;
    const fundAt = (oct2: number): Record<string, number> => {
      const l = renderL(probePatch({ mix: 1, oct2 }), lane0Bus(0), 1);
      return {
        half: db(goertzel(l, SR, f0 / 2, SR / 2, l.length)),
        unison: db(goertzel(l, SR, f0, SR / 2, l.length)),
        up: db(goertzel(l, SR, 2 * f0, SR / 2, l.length)),
      };
    };
    const dn = fundAt(-1);
    const md = fundAt(0);
    const up = fundAt(1);
    expect(dn.half! - md.half!).toBeGreaterThan(20); // f/2 only present at −1
    expect(md.unison! - dn.half! + 60).toBeGreaterThan(0); // sanity: all audible
    expect(up.up! - md.up!).toBeGreaterThan(6); // 2f dominates at +1 (md has saw H2)
    expect(dn.half!).toBeGreaterThan(-40);
    expect(up.up!).toBeGreaterThan(-40);
  });

  it('MIX crossfades OSC1→OSC2 monotonically (5-point, osc2 an octave up)', () => {
    const f0 = TIDY_C4_HZ;
    const values = [0, 0.25, 0.5, 0.75, 1].map((mix) => {
      const l = renderL(probePatch({ mix, oct2: 1, shape2: 1, pw: 0.5 }), lane0Bus(0), 1);
      return db(goertzel(l, SR, 2 * f0, SR / 2, l.length) / goertzel(l, SR, f0, SR / 2, l.length));
    });
    assertStrictlyIncreasing(values, 'osc2/osc1 vs mix', 2);
    expect(values[4]! - values[0]!).toBeGreaterThan(30);
  });

  it('SUB raises the −1-octave square under OSC1 monotonically (5-point)', () => {
    const f1 = 220;
    const voct = Math.log2(f1 / TIDY_C4_HZ);
    const values = [0, 0.25, 0.5, 0.75, 1].map((sub) => {
      const l = renderL(probePatch({ sub, cutoff: 4000 }), lane0Bus(voct), 1);
      return db(goertzel(l, SR, f1 / 2, SR / 2, l.length) / goertzel(l, SR, f1, SR / 2, l.length));
    });
    assertStrictlyIncreasing(values.slice(1), 'sub/fund vs sub level', 1);
    expect(values[1]! - values[0]!).toBeGreaterThan(10); // off → first step is a cliff
    expect(values[4]! - values[1]!).toBeGreaterThan(9);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// WAVEFOLDER
// ─────────────────────────────────────────────────────────────────────────

/** Fold a pure sine through the ADAA folder INSIDE the 2× oversampler — the
 *  exact signal path the voice uses. A clean tone (vs a harmonically-dense
 *  saw) is what makes the folder's own harmonic generation legible. */
function foldedSine(fold: number, sym: number, srcHz: number, amp = 0.5): Float32Array {
  const os = createOversampler(2);
  const st = makeFoldState();
  const gain = tidyFoldGain(fold);
  const bias = tidyFoldBias(sym, fold);
  const n = SR;
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = amp * Math.sin((2 * Math.PI * srcHz * i) / SR);
    buf[i] = os.process(x, (u) => foldAdaaStep(st, u, gain, bias, fold));
  }
  return buf;
}

describe('sonic range — wavefolder', () => {
  it('FOLD grows brightness across its whole travel (5-point centroid, folded sine)', () => {
    // fold=0 is a bypass → the pure 220 Hz sine (centroid = the fundamental);
    // each fold step reflects the sine more times, climbing the centroid.
    const values = [0, 0.25, 0.5, 0.75, 1].map((fold) => centroidHz(foldedSine(fold, 0, 220), SR / 2, SR));
    assertStrictlyIncreasing(values, 'centroid vs fold');
    expect(values[0]!, 'fold 0 = clean sine (centroid ≈ fundamental)').toBeLessThan(260);
    expect(values[4]! / values[0]!, 'a real full-range brightness sweep').toBeGreaterThan(3);
  });

  it('FOLD symmetric fold generates ODD harmonics, no even (folded sine, sym=0)', () => {
    const buf = foldedSine(1, 0, 220);
    const h1 = goertzel(buf, SR, 220, SR / 2, SR);
    const h2 = goertzel(buf, SR, 440, SR / 2, SR);
    const h3 = goertzel(buf, SR, 660, SR / 2, SR);
    expect(db(h3 / h1), 'strong 3rd (odd) harmonic').toBeGreaterThan(-10);
    expect(db(h2 / h1), 'even harmonic nulled by odd symmetry').toBeLessThan(-60);
  });

  it('SYMMETRY blooms EVEN harmonics as it leaves center (5-point |sym|, fold=0.7)', () => {
    // At sym=0 the fold is symmetric → H2 nulled; |sym| off-center makes the
    // fold asymmetric → the 2nd harmonic climbs monotonically.
    const values = [0, 0.25, 0.5, 0.75, 1].map((sym) => {
      const buf = foldedSine(0.7, sym, 220);
      return db(goertzel(buf, SR, 440, SR / 2, SR) / goertzel(buf, SR, 220, SR / 2, SR));
    });
    assertStrictlyIncreasing(values, 'H2/H1 vs |sym|', 1);
    expect(values[0]!, 'centered fold = no even harmonics').toBeLessThan(-60);
    expect(values[4]! - values[0]!, 'a large even-harmonic swing').toBeGreaterThan(40);
  });

  it('SYMMETRY is bipolar-symmetric (±sym raise even harmonics equally)', () => {
    const h2at = (sym: number) => {
      const buf = foldedSine(0.7, sym, 220);
      return db(goertzel(buf, SR, 440, SR / 2, SR) / goertzel(buf, SR, 220, SR / 2, SR));
    };
    expect(h2at(0.5)).toBeCloseTo(h2at(-0.5), 1);
    expect(h2at(1)).toBeCloseTo(h2at(-1), 1);
  });

  it('the STEREO folder decorrelates L/R monotonically with FOLD (5-point, single voice)', () => {
    // A single centered poly voice (width fans nothing here) is perfectly
    // mono at fold 0; the folder's antiphase per-channel bias decorrelates it,
    // deeper as FOLD climbs — the folder itself widening the image.
    const stats = [0, 0.25, 0.5, 0.75, 1].map((fold) => {
      const n = Math.round(1.5 * SR);
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      const poly = new Float32Array(10);
      poly[0] = 0;
      poly[1] = 1;
      renderTidyVco(
        { ...TIDY_VCO_DEFAULTS, width: 0.6, fold, sus: 1, detune: 0, cutoff: 9000, res: 0.2, shape1: 0, sub: 0, mix: 0 },
        { poly, monoPitch: 0, monoGate: 0, resCv: 0, driveCv: 0 },
        l,
        r,
        0,
        n,
        SR,
        makeTidyVcoState(),
      );
      let lr = 0;
      let ll = 0;
      let rr = 0;
      for (let i = Math.round(0.3 * SR); i < n; i++) {
        lr += l[i]! * r[i]!;
        ll += l[i]! ** 2;
        rr += r[i]! ** 2;
      }
      return lr / Math.sqrt(ll * rr);
    });
    // corr DEcreases → assert the negated series strictly increases.
    assertStrictlyIncreasing(
      stats.map((c) => -c),
      'decorrelation (−corr) vs fold',
      0.02,
    );
    expect(stats[0]!, 'fold 0 = perfectly mono single voice').toBeGreaterThan(0.999);
    expect(stats[4]!, 'true stereo at full fold').toBeLessThan(0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ENVELOPES
// ─────────────────────────────────────────────────────────────────────────

describe('sonic range — envelopes', () => {
  it('ATK sets the audible rise time across its travel (5-point)', () => {
    const values = [0.001, 0.008, 0.04, 0.2, 0.8].map((atk) => {
      const p = probePatch({ atk, dec: 1, sus: 1 });
      const l = renderL(p, lane0Bus(0), atk * 1.5 + 0.35);
      const block = Math.round(0.004 * SR);
      let peak = 0;
      for (let s = 0; s + block < l.length; s += block) peak = Math.max(peak, rms(l, s, s + block));
      for (let s = 0; s + block < l.length; s += block) {
        if (rms(l, s, s + block) >= 0.9 * peak) return s / SR;
      }
      return Infinity;
    });
    assertStrictlyIncreasing(values, 'rise time vs atk');
    expect(values[4]!).toBeGreaterThan(0.4);
    expect(values[0]!).toBeLessThan(0.02);
  });

  it('DEC sets how fast the note falls to a zero sustain while held (5-point)', () => {
    const values = [0.02, 0.08, 0.3, 1, 3].map((dec) => {
      const p = probePatch({ dec, sus: 0 });
      const l = renderL(p, lane0Bus(0), Math.min(0.9 * dec + 0.3, 3.2));
      const block = Math.round(0.004 * SR);
      const held = rms(l, Math.round(0.01 * SR), Math.round(0.03 * SR));
      for (let s = Math.round(0.03 * SR); s + block < l.length; s += block) {
        if (rms(l, s, s + block) <= 0.1 * held) return s / SR;
      }
      return l.length / SR; // still ringing at the end (longest settings)
    });
    assertStrictlyIncreasing(values, 'fall time vs dec');
    expect(values[0]!).toBeLessThan(0.06);
  });

  it('SUS holds the sustained level in strict order (5-point)', () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map((sus) => {
      const l = renderL(probePatch({ dec: 0.08, sus }), lane0Bus(0), 0.8);
      return rms(l, Math.round(0.5 * SR), Math.round(0.75 * SR));
    });
    assertStrictlyIncreasing(values, 'late RMS vs sustain');
    expect(values[0]!).toBeLessThan(0.005);
  });

  it('REL sets the release-tail length across its travel (5-point)', () => {
    const values = [0.02, 0.08, 0.3, 1, 3].map((rel) => {
      const p = probePatch({ rel });
      const l = renderGateOff(p, 0, 0.25, 0.25 + Math.min(0.7 * rel + 0.25, 2.4));
      const held = rms(l, Math.round(0.15 * SR), Math.round(0.24 * SR));
      const block = Math.round(0.004 * SR);
      for (let s = Math.round(0.26 * SR); s + block < l.length; s += block) {
        if (rms(l, s, s + block) <= 0.05 * held) return s / SR - 0.25;
      }
      return l.length / SR - 0.25;
    });
    assertStrictlyIncreasing(values, 'tail vs rel');
    expect(values[0]!).toBeLessThan(0.05);
    expect(values[4]!).toBeGreaterThan(1);
  });

  it('FATK delays the brightness rise across its travel (5-point, first 90 %-of-peak crossing)', () => {
    const values = [0.002, 0.02, 0.1, 0.4, 1.5].map((fatk) => {
      const p = probePatch({ cutoff: 300, env: 1, fatk, fdec: 3, fsus: 1 });
      const l = renderL(p, lane0Bus(0), fatk * 1.4 + 0.4);
      const block = Math.round(0.02 * SR);
      const cs: number[] = [];
      for (let s = 0; s + block < l.length; s += block) cs.push(centroidHz(l, s, s + block));
      const peak = Math.max(...cs);
      const idx = cs.findIndex((c) => c >= 0.9 * peak);
      return (idx * block) / SR;
    });
    assertStrictlyIncreasing(values, 'brightness rise time vs fatk');
    expect(values[4]!).toBeGreaterThan(0.8);
  });

  it('FDEC holds the brightness longer across its travel (5-point, centroid fall time)', () => {
    const values = [0.05, 0.2, 0.6, 1.8, 4].map((fdec) => {
      const p = probePatch({ cutoff: 300, env: 1, fatk: 0.001, fdec, fsus: 0 });
      const seconds = Math.min(0.9 * fdec + 0.3, 2.7);
      const l = renderL(p, lane0Bus(0), seconds);
      const block = Math.round(0.005 * SR);
      // Fall time: first block (past the attack) whose centroid is back
      // within 30 % of the closed-filter floor (~264 Hz for this patch).
      const floor = 264;
      for (let s = Math.round(0.02 * SR); s + block < l.length; s += block) {
        if (centroidHz(l, s, s + block) < floor * 1.3) return s / SR;
      }
      return seconds; // still bright at the end (slowest settings)
    });
    assertStrictlyIncreasing(values, 'centroid fall time vs fdec');
    expect(values[0]!).toBeLessThan(0.06);
    expect(values[4]!).toBeGreaterThan(0.3);
  });

  it('FSUS sets the settled brightness in strict order (5-point)', () => {
    const values = [0, 0.25, 0.5, 0.75, 1].map((fsus) => {
      const p = probePatch({ cutoff: 300, env: 1, fatk: 0.001, fdec: 0.12, fsus });
      const l = renderL(p, lane0Bus(0), 0.9);
      return centroidHz(l, Math.round(0.6 * SR), Math.round(0.85 * SR));
    });
    assertStrictlyIncreasing(values, 'late centroid vs fsus');
    expect(values[4]! / values[0]!).toBeGreaterThan(2);
  });

  it('FREL lets the filter fall at its own rate after note-off (5-point, fall time)', () => {
    const values = [0.03, 0.15, 0.5, 1.5, 3].map((frel) => {
      const p = probePatch({ cutoff: 300, env: 1, fatk: 0.001, fdec: 3, fsus: 1, frel, rel: 2.5 });
      const post = Math.min(0.8 * frel + 0.25, 2.1);
      const l = renderGateOff(p, 0, 0.3, 0.3 + post);
      const block = Math.round(0.005 * SR);
      const floor = 264;
      for (let s = Math.round(0.305 * SR); s + block < l.length; s += block) {
        if (centroidHz(l, s, s + block) < floor * 1.3) return s / SR - 0.3;
      }
      return post; // still bright at the end (slowest settings)
    });
    assertStrictlyIncreasing(values, 'post-off brightness fall time vs frel');
    expect(values[0]!).toBeLessThan(0.05);
    expect(values[4]!).toBeGreaterThan(0.25);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GLOBAL
// ─────────────────────────────────────────────────────────────────────────

describe('sonic range — global', () => {
  it('WIDTH opens the mono-unison stereo field monotonically (5-point)', () => {
    // Metric: peak |L−R| over a 2 s window (≥ one full unison-beat cycle at
    // every width — instantaneous L/R correlation swings WITH the beat
    // phase, so the beat-cycle max is the stable order statistic), plus
    // corr endpoints: width 0 = exactly dual-identical, width 1 = truly
    // decorrelated.
    const stats = [0, 0.25, 0.5, 0.75, 1].map((width) => {
      const n = Math.round(2.2 * SR);
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      renderTidyVco(
        { ...TIDY_VCO_DEFAULTS, width, sus: 1, detune: 0 },
        { poly: new Float32Array(10), monoPitch: 0, monoGate: 1, resCv: 0, driveCv: 0 },
        l,
        r,
        0,
        n,
        SR,
        makeTidyVcoState(),
      );
      let lr = 0;
      let ll = 0;
      let rr = 0;
      let maxd = 0;
      let maxl = 0;
      for (let i = Math.round(0.2 * SR); i < n; i++) {
        lr += l[i]! * r[i]!;
        ll += l[i]! ** 2;
        rr += r[i]! ** 2;
        maxd = Math.max(maxd, Math.abs(l[i]! - r[i]!));
        maxl = Math.max(maxl, Math.abs(l[i]!));
      }
      return { corr: lr / Math.sqrt(ll * rr), spread: maxd / maxl };
    });
    assertStrictlyIncreasing(
      stats.map((s) => s.spread),
      'peak |L−R| vs width',
      0.05,
    );
    expect(stats[0]!.corr).toBeGreaterThan(0.9999);
    expect(stats[4]!.corr, 'true stereo at full width').toBeLessThan(0.5);
  });

  it('LEVEL tracks its dB law across the travel (5-point, monotone with honest steps)', () => {
    const values = [-24, -12, 0, 6, 12].map((level) => {
      const l = renderL(probePatch({ cutoff: 400, level }), lane0Bus(0), 0.6);
      return db(rms(l, Math.round(0.3 * SR), l.length));
    });
    assertStrictlyIncreasing(values, 'RMS dB vs level', 2);
    // The −24→−12→0 steps are clean 12 dB moves (±1.5); the top steps may
    // lean on the true-peak tanh bound (documented compression).
    expect(values[1]! - values[0]!).toBeGreaterThan(10.5);
    expect(values[1]! - values[0]!).toBeLessThan(13.5);
    expect(values[2]! - values[1]!).toBeGreaterThan(10.5);
    expect(values[2]! - values[1]!).toBeLessThan(13.5);
  });
});
