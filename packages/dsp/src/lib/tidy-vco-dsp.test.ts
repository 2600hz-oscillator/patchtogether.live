// packages/dsp/src/lib/tidy-vco-dsp.test.ts
//
// TIDY VCO core correctness gates:
//   • diode-ladder math: small-signal linearity (DC gain 1), −24 dB/oct
//     asymptote, THE TUNING GATE (self-osc pitch < 3 cents across 5+
//     octaves at 48 kHz AND 44.1 kHz — the resonance-prewarp calibration
//     pin), bounded CLEAN self-oscillation (near-pure sine), resonance
//     onset placement, passband-compensation window (the documented
//     "how much do the lows thin at high res" decision), alias floor.
//   • THE OSCILLATOR MORPH (sine → triangle → square): the three anchors
//     land on the REAL waveform, the crossfades are continuous in both
//     level and harmonic content, the anchors are RMS-matched, and the
//     result is BAND-LIMITED at the top of the keyboard — proved against a
//     naive (correction-free) negative control, which is the only way to
//     know the alias metric can move at all.
//   • RC-punch ADSR: attack terminates at the knob time, CONVEX punch
//     (the CEM3310 overshoot-target curve), −60 dB decay/release
//     convention, live sustain tracking, analog attack-from-current
//     retrigger.
//   • OTA VCA: exact silence at zero, small-signal gain law, the
//     level-dependent even-harmonic bloom.
//   • voice render: silence without gate, gated RMS + release tail,
//     poly chord partials, release-tail pitch hold (#669 rule), poly-
//     over-mono precedence, WIDTH stereo laws, keytracked whistle,
//     hostile extremes bounded, bit-identical determinism.

import { describe, expect, it } from 'vitest';

import {
  ADSR_ATTACK_TARGET,
  DIODE_SELF_OSC_K,
  RC_DECAY,
  RC_IDLE,
  TIDY_C4_HZ,
  TIDY_VCO_DEFAULTS,
  TIDY_VOICES,
  diodeLadderStep,
  foldAdaaStep,
  makeDiodeLadderState,
  makeFoldState,
  makeRcAdsrState,
  makeTidyVcoState,
  rcAdsrGate,
  rcAdsrTick,
  renderTidyVco,
  tidyCompGain,
  tidyCutoffHz,
  tidyCutoffToG,
  tidyDriveGains,
  tidyFoldBias,
  tidyFoldGain,
  tidyFoldSpread,
  tidyFreqHz,
  tidyMixGains,
  tidyOscSample,
  tidyOtaVca,
  tidyPolyBlamp,
  tidyPolyBlep,
  tidyPulse,
  tidyPwEff,
  tidyResToK,
  tidyTriangle,
  tidyTriangleNaive,
  triFold,
  triFoldInt,
  OSC_SINE_GAIN,
  OSC_SQUARE_GAIN,
  OSC_TRI_GAIN,
  type TidyVcoBus,
  type TidyVcoParams,
} from './tidy-vco-dsp';

const SR = 48000;

// ─────────────────────────────────────────────────────────────────────────
// Local spectral helpers (the house pattern — each DSP test hand-rolls its
// Goertzel; there is no shared spectral module).
// ─────────────────────────────────────────────────────────────────────────

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

/** FNV-1a over the raw Float32 bytes — a bit-exact fingerprint. */
function fnv1a(buf: Float32Array): string {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ─────────────────────────────────────────────────────────────────────────
// Render helpers
// ─────────────────────────────────────────────────────────────────────────

function silentBus(): TidyVcoBus {
  return { poly: new Float32Array(10), monoPitch: 0, monoGate: 0, resCv: 0, driveCv: 0 };
}

/** Poly single-lane bus: ONE voice (lane 0) at `voct`, gate high — the
 *  cleanest single-voice probe (no mono-unison doubling). */
function lane0Bus(voct: number, gate = 1): TidyVcoBus {
  const poly = new Float32Array(10);
  poly[0] = voct;
  poly[1] = gate;
  return { poly, monoPitch: 0, monoGate: 0, resCv: 0, driveCv: 0 };
}

function renderVoice(
  p: TidyVcoParams,
  bus: TidyVcoBus,
  seconds: number,
  sr = SR,
): { l: Float32Array; r: Float32Array } {
  const n = Math.round(seconds * sr);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  renderTidyVco(p, bus, l, r, 0, n, sr, makeTidyVcoState());
  return { l, r };
}

/** A neutral single-osc probe patch: SHAPE 0 (sine), no detune/sub, filter
 *  open-ish. */
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

/** Drive the raw ladder into its self-osc limit cycle and measure the
 *  whistle: 4-period ±2 square kick → 1.5 s settle → 1 s measure. Returns
 *  frequency (interp zero crossings) + peak amplitude. */
function measureSelfOsc(fcKnob: number, sr: number): { freq: number; peak: number } {
  const os = 2 * sr;
  const st = makeDiodeLadderState();
  const g = tidyCutoffToG(fcKnob, os);
  const k = tidyResToK(1);
  const period = os / fcKnob;
  for (let i = 0; i < 4 * period; i++) {
    diodeLadderStep(st, Math.sin((2 * Math.PI * i) / period) > 0 ? 2 : -2, g, k);
  }
  for (let i = 0; i < 1.5 * os; i++) diodeLadderStep(st, 0, g, k);
  const meas = os;
  const buf = new Float32Array(meas);
  for (let i = 0; i < meas; i++) buf[i] = diodeLadderStep(st, 0, g, k);
  let cross = 0;
  let first = -1;
  let last = -1;
  for (let i = 1; i < meas; i++) {
    const a = buf[i - 1]!;
    const b = buf[i]!;
    if (a <= 0 && b > 0) {
      const pos = i - 1 + -a / (b - a);
      cross++;
      if (first < 0) first = pos;
      last = pos;
    }
  }
  const freq = cross > 1 ? ((cross - 1) * os) / (last - first) : 0;
  let peak = 0;
  for (let i = 0; i < meas; i++) peak = Math.max(peak, Math.abs(buf[i]!));
  return { freq, peak };
}

// ─────────────────────────────────────────────────────────────────────────
// THE OSCILLATOR — the SINE → TRIANGLE → SQUARE morph
//
// ⚠ VALIDATE THE INSTRUMENT. The alias gates below run the SAME oscillator
// with dt = 0, which switches every polyBLEP/polyBLAMP correction off and
// leaves the naive waveform. That is the NEGATIVE CONTROL: it proves the
// alias metric can move at all before we believe the number it prints for
// the real path. (dt = 0 is also literally what the card + shell wave
// displays draw, so this doubles as the display's ground truth.)
// ─────────────────────────────────────────────────────────────────────────

/** Free-run the bare oscillator at f0. `bandLimited = false` passes dt = 0,
 *  i.e. the correction-free (naive) waveform — the negative control. */
function renderOsc(f0: number, n: number, shape: number, pw = 0.5, bandLimited = true): Float32Array {
  const dt = f0 / SR;
  let t = 0;
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    buf[i] = tidyOscSample(t, bandLimited ? dt : 0, shape, pw);
    t += dt;
    if (t >= 1) t -= 1;
  }
  return buf;
}

/** Every alias image that folds BELOW the fundamental, at least `guardHz`
 *  clear of DC and of f0 itself. The guard matters: an image a few Hz from
 *  f0 reads as the FUNDAMENTAL's window leakage, not as aliasing — the
 *  un-guarded version of this probe reported a clean −76 dBc for a signal
 *  with a −27 dBc alias in it. */
function belowF0Aliases(f0: number, guardHz = 60, kMax = 600): number[] {
  const out: number[] = [];
  for (let k = 2; k <= kMax; k++) {
    const f = k * f0;
    if (f <= SR / 2) continue;
    let g = f % SR;
    if (g > SR / 2) g = SR - g;
    if (g > guardHz && g < f0 - guardHz) out.push(g);
  }
  return out;
}

/** Worst below-f0 alias image, in dB relative to the fundamental. */
function worstAliasDbc(buf: Float32Array, f0: number): number {
  const h1 = goertzel(buf, SR, f0, 0, buf.length);
  let worst = -300;
  for (const f of belowF0Aliases(f0)) {
    const v = db(goertzel(buf, SR, f, 0, buf.length) / h1);
    if (v > worst) worst = v;
  }
  return worst;
}

/** Amplitudes of the first `k` harmonics — the morph's spectral signature. */
function harmonicVector(buf: Float32Array, f0: number, k = 24): number[] {
  const out: number[] = [];
  for (let h = 1; h <= k; h++) out.push(goertzel(buf, SR, h * f0, 0, buf.length));
  return out;
}

function rmsAll(buf: Float32Array): number {
  return rms(buf, 0, buf.length);
}

describe('oscillator morph — the three anchors are the REAL waveform', () => {
  const F0 = 55; // A1: dt = 0.00115, so the correction windows are hairline
  const DT = F0 / SR;

  it('SHAPE 0 is EXACTLY a sine (alias-free by construction — zero correction)', () => {
    for (let i = 0; i < 997; i++) {
      const t = i / 997;
      expect(tidyOscSample(t, DT, 0, 0.5)).toBeCloseTo(OSC_SINE_GAIN * Math.sin(2 * Math.PI * t), 12);
      // …at ANY pitch: a sine needs no band-limiting, so dt cannot matter.
      expect(tidyOscSample(t, 0.2, 0, 0.5)).toBeCloseTo(OSC_SINE_GAIN * Math.sin(2 * Math.PI * t), 12);
    }
  });

  it('SHAPE 0.5 is EXACTLY a triangle away from its two corners', () => {
    let checked = 0;
    for (let i = 0; i < 997; i++) {
      const t = i / 997;
      const nearCorner = Math.min(Math.abs(t - 0.25), Math.abs(t - 0.75)) < 2 * DT;
      if (nearCorner) continue;
      expect(tidyOscSample(t, DT, 0.5, 0.5)).toBeCloseTo(OSC_TRI_GAIN * tidyTriangleNaive(t), 12);
      checked++;
    }
    expect(checked).toBeGreaterThan(900);
    // The corners are ROUNDED, not moved: the peak still lands at ±1 (times
    // the anchor gain) and the wave still crosses zero at 0 and ½.
    expect(tidyOscSample(0.25, DT, 0.5, 0.5)).toBeCloseTo(OSC_TRI_GAIN, 2);
    expect(tidyOscSample(0.75, DT, 0.5, 0.5)).toBeCloseTo(-OSC_TRI_GAIN, 2);
    expect(tidyOscSample(0, DT, 0.5, 0.5)).toBeCloseTo(0, 6);
    expect(tidyOscSample(0.5, DT, 0.5, 0.5)).toBeCloseTo(0, 6);
  });

  it('SHAPE 1 is EXACTLY a square at the default PW, and a real pulse below it', () => {
    let checked = 0;
    for (let i = 0; i < 997; i++) {
      const t = i / 997;
      if (Math.min(t, Math.abs(t - 0.5), 1 - t) < 2 * DT) continue; // the two edges
      expect(tidyOscSample(t, DT, 1, 0.5)).toBeCloseTo(OSC_SQUARE_GAIN * (t < 0.5 ? 1 : -1), 12);
      checked++;
    }
    expect(checked).toBeGreaterThan(900);
    // PW is the SQUARE LEG's duty: 0.2 keeps the wave high for exactly 20 %.
    let high = 0;
    for (let i = 0; i < 10000; i++) if (tidyOscSample(i / 10000, DT, 1, 0.2) > 0) high++;
    expect(high / 10000).toBeCloseTo(0.2, 2);
  });

  it('all three anchors put their FUNDAMENTAL in phase (no crossfade cancellation)', () => {
    // Each anchor's fundamental must be +sin(2π t): correlate one cycle
    // against sin and against cos. A negative (or quadrature) fundamental is
    // what makes a morph notch out mid-sweep.
    for (const shape of [0, 0.5, 1]) {
      let cs = 0;
      let cc = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const v = tidyOscSample(t, 1 / n, shape, 0.5);
        cs += v * Math.sin(2 * Math.PI * t);
        cc += v * Math.cos(2 * Math.PI * t);
      }
      expect(cs / n, `shape ${shape} fundamental is +sin`).toBeGreaterThan(0.2);
      expect(Math.abs(cc / n), `shape ${shape} fundamental has no cos part`).toBeLessThan(1e-3);
    }
  });

  it('polyBLAMP is the exact INTEGRAL of the polyBLEP (the corner-vs-step derivation)', () => {
    // d/dt blamp(t, dt) · dt  ==  blep(t, dt) / 2  (the unit-STEP residual).
    // If this drifts, the triangle's corners are being corrected by the
    // wrong kernel and the band-limiting silently degrades to naive.
    const dt = 0.01;
    const h = 1e-6;
    for (const t of [0.0005, 0.002, 0.005, 0.009, 0.9915, 0.995, 0.998, 0.9995]) {
      const d = (tidyPolyBlamp(t + h, dt) - tidyPolyBlamp(t - h, dt)) / (2 * h);
      expect(d * dt, `blamp' at ${t}`).toBeCloseTo(tidyPolyBlep(t, dt) / 2, 6);
    }
    // …and it is 0 outside the 2-sample window (both kernels are local).
    expect(tidyPolyBlamp(0.5, dt)).toBe(0);
    expect(tidyPolyBlamp(0.3, 0)).toBe(0);
  });

  it('tidyMixGains is the equal-power OSC1↔OSC2 law the render loop uses', () => {
    expect(tidyMixGains(0)).toEqual({ g1: 1, g2: 0 });
    const half = tidyMixGains(0.5);
    expect(half.g1).toBeCloseTo(Math.SQRT1_2, 12);
    expect(half.g2).toBeCloseTo(Math.SQRT1_2, 12);
    for (const m of [0, 0.2, 0.5, 0.8, 1]) {
      const { g1, g2 } = tidyMixGains(m);
      expect(g1 * g1 + g2 * g2, `equal power at mix ${m}`).toBeCloseTo(1, 12);
    }
  });
});

describe('oscillator morph — BAND-LIMITING (proved against a naive control)', () => {
  const C7 = 2093.005;
  const N = 2 * SR;

  it('a naive oscillator DOES alias at C7 — the metric can move (negative control)', () => {
    // Without this, a band-limited reading of "−100 dBc" proves nothing: a
    // probe that looks in the wrong place returns a clean number for a filthy
    // signal. A naive square's 23rd harmonic folds to 139 Hz at −27 dBc.
    expect(worstAliasDbc(renderOsc(C7, N, 1, 0.5, false), C7)).toBeGreaterThan(-32);
    expect(worstAliasDbc(renderOsc(C7, N, 0.5, 0.5, false), C7)).toBeGreaterThan(-60);
  });

  it('every morph position is band-limited at C7 (worst below-f0 image < −85 dBc)', () => {
    for (const shape of [0, 0.25, 0.5, 0.75, 1]) {
      const bl = worstAliasDbc(renderOsc(C7, N, shape, 0.5, true), C7);
      expect(bl, `shape ${shape} worst below-f0 alias`).toBeLessThan(-85);
    }
  });

  it('the corrections buy ≥ 45 dB over naive wherever there is anything to fix', () => {
    for (const shape of [0.25, 0.5, 0.75, 1]) {
      const bl = worstAliasDbc(renderOsc(C7, N, shape, 0.5, true), C7);
      const naive = worstAliasDbc(renderOsc(C7, N, shape, 0.5, false), C7);
      expect(naive - bl, `shape ${shape}: naive ${naive.toFixed(1)} vs BL ${bl.toFixed(1)} dBc`).toBeGreaterThan(45);
    }
    // SHAPE 0 is the exception BY CONSTRUCTION: a sine has nothing to correct,
    // so band-limited and naive are the same buffer and both are clean.
    const sineBl = worstAliasDbc(renderOsc(C7, N, 0, 0.5, true), C7);
    const sineNaive = worstAliasDbc(renderOsc(C7, N, 0, 0.5, false), C7);
    expect(sineBl).toBeCloseTo(sineNaive, 6);
    expect(sineBl).toBeLessThan(-120);
  });

  it('a thin PULSE at C7 stays band-limited too (PW is not a hole in the gate)', () => {
    // NARROW DUTY IS THE WEAKEST CASE, and it is pre-existing polyBLEP
    // behaviour, not new: at C7 a 10 % duty is ~2.3 samples wide, so the two
    // 2-sample BLEP windows nearly touch and the correction has less room.
    // Measured worst below-f0 image: −101.7 dBc at duty 0.5, −80.3 at 0.3,
    // −76.1 at 0.1, −75.8 at 0.05 (naive: −27.2 / −25.4 / −18.9 / −18.0).
    for (const pw of [0.3, 0.2, 0.1, 0.05]) {
      const bl = worstAliasDbc(renderOsc(C7, N, 1, pw, true), C7);
      const naive = worstAliasDbc(renderOsc(C7, N, 1, pw, false), C7);
      expect(bl, `duty ${pw} worst below-f0 alias`).toBeLessThan(-70);
      expect(naive - bl, `duty ${pw} improvement over naive`).toBeGreaterThan(45);
    }
  });
});

describe('oscillator morph — LEVEL + CONTINUITY across the sweep', () => {
  const F0 = 220;
  const N = SR;

  it('the three anchors are RMS-MATCHED (SHAPE is a timbre knob, not a volume knob)', () => {
    const target = 1 / Math.sqrt(3); // a unit-peak triangle's RMS — the reference
    for (const shape of [0, 0.5, 1]) {
      // In dB, because loudness is what this calibration is ABOUT. (The
      // square lands 0.037 dB under the ideal at A3: band-limiting really
      // does remove its above-Nyquist harmonics — correct physics, and the
      // deficit grows with pitch as fewer harmonics fit.)
      const err = db(rmsAll(renderOsc(F0, N, shape))) - db(target);
      expect(Math.abs(err), `shape ${shape} level error ${err.toFixed(3)} dB`).toBeLessThan(0.1);
    }
    // A peak-matched morph would swing 4.8 dB here; that is the defect this
    // calibration exists to remove.
    expect(db(1) - db(1 / Math.sqrt(3))).toBeCloseTo(4.77, 1);
  });

  it('level is continuous and near-flat across the WHOLE sweep (≤ 0.5 dB)', () => {
    const levels: number[] = [];
    for (let i = 0; i <= 40; i++) levels.push(db(rmsAll(renderOsc(F0, N, i / 40))));
    const spread = Math.max(...levels) - Math.min(...levels);
    expect(spread, `RMS spread across the morph: ${spread.toFixed(3)} dB`).toBeLessThan(0.5);
    // No STEP anywhere (a discontinuous knob would click): the biggest
    // adjacent move is a small multiple of the average one.
    const steps = levels.slice(1).map((v, i) => Math.abs(v - levels[i]!));
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    expect(Math.max(...steps)).toBeLessThan(Math.max(4 * mean, 0.05));
  });

  it('harmonic content moves CONTINUOUSLY — no jump at either crossfade seam', () => {
    // Spectral distance between ADJACENT morph positions (Δ = 0.01). A seam
    // discontinuity (e.g. anchors whose fundamentals disagree in phase, or a
    // branch that skips a leg) shows up as one step towering over the rest.
    const step = 0.01;
    const dists: number[] = [];
    let prev = harmonicVector(renderOsc(F0, N, 0), F0);
    for (let i = 1; i <= 100; i++) {
      const cur = harmonicVector(renderOsc(F0, N, i * step), F0);
      let d = 0;
      for (let k = 0; k < cur.length; k++) d += (cur[k]! - prev[k]!) ** 2;
      dists.push(Math.sqrt(d));
      prev = cur;
    }
    const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
    const worst = Math.max(...dists);
    expect(worst / mean, `worst/mean adjacent spectral step = ${(worst / mean).toFixed(2)}`).toBeLessThan(4);
    // …and the sweep really does traverse a lot of ground (a flat/dead knob
    // would also have a tiny worst/mean ratio — the negative control for THIS
    // metric).
    let total = 0;
    const ends = harmonicVector(renderOsc(F0, N, 1), F0);
    const start = harmonicVector(renderOsc(F0, N, 0), F0);
    for (let k = 0; k < ends.length; k++) total += (ends[k]! - start[k]!) ** 2;
    expect(Math.sqrt(total) / mean).toBeGreaterThan(20);
  });

  it('the morph passes exactly THROUGH the triangle at 0.5 (both branches agree)', () => {
    for (let i = 0; i < 200; i++) {
      const t = i / 200;
      const lo = tidyOscSample(t, 0.001, 0.5, 0.5);
      const hi = tidyOscSample(t, 0.001, 0.5 + 1e-9, 0.5);
      expect(hi).toBeCloseTo(lo, 8);
      expect(lo).toBeCloseTo(OSC_TRI_GAIN * tidyTriangle(t, 0.001), 12);
    }
  });

  it('SHAPE is clamped, and out-of-range values pin to the end waveforms', () => {
    for (let i = 0; i < 64; i++) {
      const t = i / 64;
      expect(tidyOscSample(t, 0.001, -3, 0.5)).toBe(tidyOscSample(t, 0.001, 0, 0.5));
      expect(tidyOscSample(t, 0.001, 4, 0.5)).toBe(tidyOscSample(t, 0.001, 1, 0.5));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Diode ladder
// ─────────────────────────────────────────────────────────────────────────

describe('diode ladder — linear behavior', () => {
  it('has unity small-signal DC gain at k = 0 (exact ZDF solve, no leakage)', () => {
    const os = 2 * SR;
    const st = makeDiodeLadderState();
    const g = tidyCutoffToG(1000, os);
    let y = 0;
    for (let i = 0; i < os; i++) y = diodeLadderStep(st, 0.05, g, 0);
    expect(y / 0.05).toBeGreaterThan(0.995);
    expect(y / 0.05).toBeLessThan(1.005);
  });

  it('rolls off at ~24 dB/oct well above the pole cluster', () => {
    const os = 2 * SR;
    const g = tidyCutoffToG(500, os);
    const probe = (hz: number): number => {
      const st = makeDiodeLadderState();
      const n = os; // 1 s at the OS rate
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        buf[i] = diodeLadderStep(st, Math.sin((2 * Math.PI * hz * i) / os), g, 0);
      }
      return goertzel(buf, os, hz, n / 2, n);
    };
    const slopeDb = db(probe(8000)) - db(probe(4000));
    expect(slopeDb, '4→8 kHz octave step').toBeLessThan(-19);
    expect(slopeDb).toBeGreaterThan(-28);
  });

  it('exposes the analyzed self-osc constants (k=17, matching Pirkle AN-6)', () => {
    expect(DIODE_SELF_OSC_K).toBe(17);
    expect(tidyResToK(1)).toBeGreaterThan(DIODE_SELF_OSC_K); // assured whistle at res=1
    expect(tidyResToK(0)).toBe(0);
  });
});

describe('diode ladder — THE TUNING GATE (self-osc pitch = the cutoff knob)', () => {
  // The resonance prewarp (g = √2·tan(π·fc/fs), describing-function
  // calibrated) makes the whistle land on the knob at ANY sample rate.
  for (const sr of [48000, 44100]) {
    for (const fc of [55, 110, 440, 1760, 5000]) {
      it(`${fc} Hz @ ${sr / 1000} kHz within 3 cents`, () => {
        const { freq } = measureSelfOsc(fc, sr);
        const cents = 1200 * Math.log2(freq / fc);
        expect(Math.abs(cents), `${freq.toFixed(2)} Hz measured`).toBeLessThan(3);
      });
    }
  }

  it('self-oscillates as a BOUNDED, CLEAN sine (limiter-stabilized)', () => {
    const os = 2 * SR;
    const st = makeDiodeLadderState();
    const g = tidyCutoffToG(440, os);
    const k = tidyResToK(1);
    const period = os / 440;
    for (let i = 0; i < 4 * period; i++) {
      diodeLadderStep(st, Math.sin((2 * Math.PI * i) / period) > 0 ? 2 : -2, g, k);
    }
    for (let i = 0; i < 1.5 * os; i++) diodeLadderStep(st, 0, g, k);
    const buf = new Float32Array(os);
    for (let i = 0; i < os; i++) buf[i] = diodeLadderStep(st, 0, g, k);
    const h1 = goertzel(buf, os, 440, 0, os);
    const h2 = goertzel(buf, os, 880, 0, os);
    const h3 = goertzel(buf, os, 1320, 0, os);
    // Amplitude: the FB_LIM equilibrium, not a runaway.
    const { peak } = { peak: Math.max(...Array.from(buf, Math.abs)) };
    expect(peak).toBeGreaterThan(0.04);
    expect(peak).toBeLessThan(0.3);
    // Purity: odd symmetry kills H2; the soft limiter keeps H3 far down.
    expect(db(h2 / h1), 'H2 (dBc)').toBeLessThan(-60);
    expect(db(h3 / h1), 'H3 (dBc)').toBeLessThan(-35);
  });

  it('does NOT self-oscillate below the onset (res 0.7 decays to silence)', () => {
    const os = 2 * SR;
    const st = makeDiodeLadderState();
    const g = tidyCutoffToG(1000, os);
    const k = tidyResToK(0.7);
    for (let i = 0; i < 200; i++) diodeLadderStep(st, i % 2 === 0 ? 1 : -1, g, k);
    let y = 0;
    let peakLate = 0;
    for (let i = 0; i < 2 * os; i++) {
      y = diodeLadderStep(st, 0, g, k);
      if (i > 1.9 * os) peakLate = Math.max(peakLate, Math.abs(y));
    }
    expect(peakLate).toBeLessThan(1e-4);
  });

  it('passband compensation: 100 Hz body loses ≤ 14 dB at res 0.8 (raw model loses ~24 dB)', () => {
    const os = 2 * SR;
    const g = tidyCutoffToG(2000, os);
    const probe = (res: number): number => {
      const k = tidyResToK(res);
      const comp = tidyCompGain(k);
      const st = makeDiodeLadderState();
      const n = os;
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        buf[i] = diodeLadderStep(st, comp * 0.2 * Math.sin((2 * Math.PI * 100 * i) / os), g, k);
      }
      return goertzel(buf, os, 100, n / 2, n);
    };
    const lossDb = db(probe(0.8)) - db(probe(0));
    // Documented choice: (1+k)^0.6 comp leaves a musical squelch dip.
    expect(lossDb).toBeLessThan(-4);
    expect(lossDb).toBeGreaterThan(-14);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// RC-punch ADSR
// ─────────────────────────────────────────────────────────────────────────

describe('RC-punch ADSR (CEM3310 lineage)', () => {
  it('attack terminates at the knob time (±5 %) and is CONVEX (the 1.08-target punch)', () => {
    const s = makeRcAdsrState();
    rcAdsrGate(s, true);
    const a = 0.1;
    let atHalf = 0;
    let done = -1;
    for (let i = 0; i < SR; i++) {
      const v = rcAdsrTick(s, a, 1, 1, 1, SR);
      if (i === Math.round((a / 2) * SR)) atHalf = v;
      if (done < 0 && s.stage === RC_DECAY) done = i;
    }
    expect(done / SR, 'time to top').toBeGreaterThan(a * 0.95);
    expect(done / SR).toBeLessThan(a * 1.05);
    // v(a/2) = 1.08·(1−e^(−ln(13.5)/2)) ≈ 0.786 — far above a linear ramp's 0.5.
    expect(atHalf).toBeGreaterThan(0.72);
    expect(atHalf).toBeLessThan(0.84);
    expect(ADSR_ATTACK_TARGET).toBeCloseTo(1.08, 10);
  });

  it('decay reaches sustain by the −60 dB convention', () => {
    const s = makeRcAdsrState();
    rcAdsrGate(s, true);
    const d = 0.2;
    const sus = 0.3;
    let v = 0;
    for (let i = 0; i < Math.round((0.002 + d) * SR); i++) v = rcAdsrTick(s, 0.001, d, sus, 1, SR);
    expect(Math.abs(v - sus)).toBeLessThan(0.003);
  });

  it('release reaches silence by the −60 dB convention and flushes to exact 0 / idle', () => {
    const s = makeRcAdsrState();
    rcAdsrGate(s, true);
    for (let i = 0; i < SR / 10; i++) rcAdsrTick(s, 0.001, 1, 1, 1, SR);
    rcAdsrGate(s, false);
    const r = 0.15;
    let v = 1;
    for (let i = 0; i < Math.round(r * SR); i++) v = rcAdsrTick(s, 0.001, 1, 1, r, SR);
    expect(v).toBeLessThan(0.002);
    for (let i = 0; i < SR / 4; i++) rcAdsrTick(s, 0.001, 1, 1, r, SR);
    expect(s.v).toBe(0);
    expect(s.stage).toBe(RC_IDLE);
  });

  it('sustain is read LIVE (sweeping it during a held note tracks)', () => {
    const s = makeRcAdsrState();
    rcAdsrGate(s, true);
    for (let i = 0; i < SR / 2; i++) rcAdsrTick(s, 0.001, 0.02, 0.2, 1, SR);
    expect(s.v).toBeLessThan(0.25);
    for (let i = 0; i < SR / 2; i++) rcAdsrTick(s, 0.001, 0.02, 0.8, 1, SR);
    expect(s.v).toBeGreaterThan(0.75);
  });

  it('retrigger is ANALOG: attack resumes from the current level, never dips, tops out sooner', () => {
    const s = makeRcAdsrState();
    rcAdsrGate(s, true);
    for (let i = 0; i < SR / 10; i++) rcAdsrTick(s, 0.001, 1, 1, 1, SR);
    rcAdsrGate(s, false);
    while (s.v > 0.4) rcAdsrTick(s, 0.05, 1, 1, 0.3, SR);
    const resumeFrom = s.v;
    rcAdsrGate(s, true);
    let minV = 1;
    let retrigTop = 0;
    for (let i = 0; i < SR; i++) {
      const v = rcAdsrTick(s, 0.05, 1, 1, 0.3, SR);
      minV = Math.min(minV, v);
      if (s.stage === RC_DECAY) {
        retrigTop = i;
        break;
      }
    }
    expect(minV, 'no dip below the resume level').toBeGreaterThanOrEqual(resumeFrom - 1e-9);
    // From 0 the same attack takes the full 0.05 s; from ~0.4 it must be faster.
    expect(retrigTop / SR).toBeLessThan(0.05 * 0.85);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// OTA VCA
// ─────────────────────────────────────────────────────────────────────────

describe('OTA-flavored VCA', () => {
  it('is exactly silent at zero envelope and zero-in/zero-out at any level', () => {
    expect(tidyOtaVca(0.7, 0)).toBe(0);
    expect(tidyOtaVca(-0.7, 0)).toBe(0);
    for (const g of [0.1, 0.5, 1]) expect(tidyOtaVca(0, g)).toBeCloseTo(0, 12);
  });

  it('small-signal gain tracks the envelope', () => {
    for (const g of [0.25, 0.5, 1]) {
      const gain = tidyOtaVca(0.001, g) / 0.001;
      expect(gain).toBeGreaterThan(g * 0.9);
      expect(gain).toBeLessThanOrEqual(g * 1.001);
    }
  });

  it('blooms even harmonics WITH the envelope (the OTA bias signature)', () => {
    const h2At = (g: number): number => {
      const n = SR;
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        buf[i] = tidyOtaVca(0.5 * Math.sin((2 * Math.PI * 440 * i) / SR), g);
      }
      return db(goertzel(buf, SR, 880, 0, n) / goertzel(buf, SR, 440, 0, n));
    };
    const a = h2At(0.25);
    const b = h2At(0.5);
    const c = h2At(1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    // Calibrated window: ≈ −50 / −38 / −27 dBc.
    expect(c).toBeGreaterThan(-32);
    expect(c).toBeLessThan(-20);
    expect(a).toBeLessThan(-42);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Stereo wavefolder — the triangle folder, its ADAA, and the control laws
// ─────────────────────────────────────────────────────────────────────────

describe('triangle wavefolder core', () => {
  it('triFold is the IDENTITY on [−1, 1] and reflects off the ±1 rails beyond', () => {
    for (const u of [-1, -0.6, 0, 0.3, 1]) expect(triFold(u)).toBeCloseTo(u, 12);
    // Reflections: 1.5→0.5, 2→0, 3→−1, and it is period-4.
    expect(triFold(1.5)).toBeCloseTo(0.5, 12);
    expect(triFold(2)).toBeCloseTo(0, 12);
    expect(triFold(3)).toBeCloseTo(-1, 12);
    expect(triFold(4.2)).toBeCloseTo(triFold(0.2), 12);
    // Bounded in [−1, 1] for any input (a folder never overshoots the rails).
    for (let u = -20; u <= 20; u += 0.013) expect(Math.abs(triFold(u))).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('triFoldInt is a CONTINUOUS antiderivative of triFold (finite-difference check)', () => {
    const h = 1e-6;
    for (const u of [-2.3, -0.5, 0.2, 1.4, 2.7, 3.9]) {
      const num = (triFoldInt(u + h) - triFoldInt(u - h)) / (2 * h);
      expect(num, `d/du triFoldInt(${u}) = triFold(${u})`).toBeCloseTo(triFold(u), 4);
    }
    // Continuity across the corner + the period wrap.
    expect(triFoldInt(1 - 1e-7)).toBeCloseTo(triFoldInt(1 + 1e-7), 6);
    expect(triFoldInt(-1 + 1e-7)).toBeCloseTo(triFoldInt(4 - 1 + 1e-7 - 4) + 0, 6); // handled by wrap
  });

  it('foldAdaaStep is an EXACT bypass at amt = 0 (returns x for any input)', () => {
    const st = makeFoldState();
    for (const x of [-1.7, -0.4, 0, 0.55, 2.3]) {
      expect(foldAdaaStep(st, x, tidyFoldGain(0), tidyFoldBias(0, 0), 0)).toBe(x);
    }
  });

  it('foldAdaaStep ADAA output stays bounded in [−1, 1] and matches triFold on a slow ramp', () => {
    const st = makeFoldState();
    // A slowly varying input: ADAA ≈ the instantaneous fold (its Δu→0 limit).
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const x = 1.2 * Math.sin((2 * Math.PI * i) / 4000);
      const u = 5 * x; // gain 5, no bias
      const y = foldAdaaStep(st, x, 5, 0, 0.7);
      expect(Math.abs(y)).toBeLessThanOrEqual(1 + 1e-9);
      worst = Math.max(worst, Math.abs(y - triFold(u)));
    }
    // Over a slow ramp the ADAA average tracks the pointwise fold closely.
    expect(worst).toBeLessThan(0.05);
  });

  it('control laws: FOLD gain, SYMMETRY bias (fold-scaled), stereo spread', () => {
    // FOLD gain: 1 at 0 (bypass), 1+MAX at 1.
    expect(tidyFoldGain(0)).toBe(1);
    expect(tidyFoldGain(1)).toBeGreaterThan(4);
    // SYMMETRY bias is SCALED BY FOLD (0 when there is no fold), bipolar.
    expect(tidyFoldBias(1, 0)).toBe(0);
    expect(tidyFoldBias(0, 1)).toBe(0);
    expect(tidyFoldBias(1, 1)).toBeGreaterThan(0);
    expect(tidyFoldBias(-1, 1)).toBeCloseTo(-tidyFoldBias(1, 1), 12);
    // Stereo spread: 0 at fold 0 OR width 0 (WIDTH 0 stays mono), grows with both.
    expect(tidyFoldSpread(0, 1)).toBe(0);
    expect(tidyFoldSpread(1, 0)).toBe(0);
    expect(tidyFoldSpread(1, 1)).toBeGreaterThan(tidyFoldSpread(0.5, 1));
    expect(tidyFoldSpread(1, 1)).toBeGreaterThan(tidyFoldSpread(1, 0.5));
  });

  it('the folded voice keeps the 2×/ADAA path alias-free (worst inharmonic < −60 dBc)', () => {
    // Fold a bright 3100 Hz saw hard (fold 1 + drive) — the harshest alias
    // case — and confirm the ADAA + 2× oversampling hold the alias floor.
    const voct = Math.log2(3100 / TIDY_C4_HZ);
    const p = probePatch({ fold: 1, drive: 0.5, res: 0, cutoff: 14000 });
    const { l } = renderVoice(p, lane0Bus(voct), 1);
    const h1 = goertzel(l, SR, 3100, SR / 2, SR);
    let worst = 0;
    for (const f of [4000, 5150, 7300, 8250, 10850, 13950, 17050, 20150, 23250]) {
      worst = Math.max(worst, goertzel(l, SR, f, SR / 2, SR) / h1);
    }
    expect(db(worst)).toBeLessThan(-60);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Control laws (pure)
// ─────────────────────────────────────────────────────────────────────────

describe('control laws', () => {
  it('V/oct: 0 V = C4, +1 V doubles', () => {
    expect(tidyFreqHz(0)).toBeCloseTo(TIDY_C4_HZ, 6);
    expect(tidyFreqHz(1) / tidyFreqHz(0)).toBeCloseTo(2, 9);
    expect(tidyFreqHz(-2) / tidyFreqHz(0)).toBeCloseTo(0.25, 9);
  });

  it('cutoff law: keytrack, EG octaves and 4 oct/V CV compose exponentially', () => {
    const os = 2 * SR;
    const base = tidyCutoffHz(1000, 0, 0, 0, 0, 0, os);
    expect(base).toBeCloseTo(1000, 6);
    expect(tidyCutoffHz(1000, 1, 1, 0, 0, 0, os) / base).toBeCloseTo(2, 6);
    expect(tidyCutoffHz(1000, 0, 0, 1, 1, 0, os) / base).toBeCloseTo(16, 5); // +4 oct at full EG
    expect(tidyCutoffHz(1000, 0, 0, 0, 0, 0.5, os) / base).toBeCloseTo(4, 5); // 4 oct/V
    expect(tidyCutoffHz(14000, 0, 0, 1, 1, 2, os)).toBeLessThanOrEqual(0.24 * os); // clamp
  });

  it('pw law: full-swing PWM CV, clamped to 0.05..0.95', () => {
    expect(tidyPwEff(0.5, 0)).toBeCloseTo(0.5, 9);
    expect(tidyPwEff(0.5, 1)).toBeCloseTo(0.95, 9);
    expect(tidyPwEff(0.5, -1)).toBeCloseTo(0.05, 6);
    expect(tidyPwEff(0.05, -2)).toBeCloseTo(0.05, 9);
  });

  it('drive law: pre-gain grows, makeup shrinks (a timbre, not volume, knob)', () => {
    const d0 = tidyDriveGains(0);
    const d1 = tidyDriveGains(1);
    expect(d0.preGain).toBe(1);
    expect(d0.makeup).toBeCloseTo(1, 9);
    expect(d1.preGain).toBe(8);
    expect(d1.makeup).toBeLessThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Voice render
// ─────────────────────────────────────────────────────────────────────────

describe('voice render', () => {
  it('is exactly silent with no gate anywhere', () => {
    const { l, r } = renderVoice(TIDY_VCO_DEFAULTS, silentBus(), 0.5);
    expect(rms(l, 0, l.length)).toBe(0);
    expect(rms(r, 0, r.length)).toBe(0);
  });

  it('a mono gate produces audible RMS and the release tail dies out', () => {
    const n = SR * 2;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    const st = makeTidyVcoState();
    const p = { ...TIDY_VCO_DEFAULTS, rel: 0.15 };
    const on: TidyVcoBus = { ...silentBus(), monoGate: 1 };
    renderTidyVco(p, on, l, r, 0, SR, SR, st);
    renderTidyVco(p, silentBus(), l, r, SR, n, SR, st);
    expect(rms(l, SR / 4, SR)).toBeGreaterThan(0.05);
    expect(rms(r, SR / 4, SR)).toBeGreaterThan(0.05);
    expect(rms(l, n - SR / 4, n), 'tail fully released').toBeLessThan(1e-3);
  });

  it('renders a poly chord with all three partials at matched level', () => {
    const poly = new Float32Array(10);
    poly[0] = 0;
    poly[1] = 1; // C4
    poly[2] = 4 / 12;
    poly[3] = 1; // E4
    poly[4] = 7 / 12;
    poly[5] = 1; // G4
    const p = probePatch({ cutoff: 6000, res: 0.15 });
    const { l } = renderVoice(p, { ...silentBus(), poly }, 1);
    const c4 = db(goertzel(l, SR, 261.63, SR / 4, SR));
    const e4 = db(goertzel(l, SR, 329.63, SR / 4, SR));
    const g4 = db(goertzel(l, SR, 392.0, SR / 4, SR));
    for (const v of [c4, e4, g4]) expect(v).toBeGreaterThan(-35);
    expect(Math.max(c4, e4, g4) - Math.min(c4, e4, g4)).toBeLessThan(4);
  });

  it('a releasing poly voice HOLDS its pitch (no C4 snap — the #669 rule)', () => {
    const n = SR * 2;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    const st = makeTidyVcoState();
    const p = probePatch({ cutoff: 6000, rel: 0.8 });
    renderTidyVco(p, lane0Bus(4 / 12), l, r, 0, SR, SR, st); // E4 held
    renderTidyVco(p, lane0Bus(4 / 12, 0), l, r, SR, n, SR, st); // release (lane pitch stays)
    // …and with the lane pitch zeroed during release (the real bus behavior).
    const l2 = new Float32Array(n);
    const r2 = new Float32Array(n);
    const st2 = makeTidyVcoState();
    renderTidyVco(p, lane0Bus(4 / 12), l2, r2, 0, SR, SR, st2);
    renderTidyVco(p, silentBus(), l2, r2, SR, n, SR, st2); // lanes all 0 V now
    const relE4 = db(goertzel(l2, SR, 329.63, SR + 2400, SR + SR / 2));
    const relF4 = db(goertzel(l2, SR, 349.23, SR + 2400, SR + SR / 2));
    const relC4 = db(goertzel(l2, SR, 261.63, SR + 2400, SR + SR / 2));
    expect(relE4 - relF4, 'held E4 vs off-note').toBeGreaterThan(12);
    expect(relE4 - relC4, 'held E4 vs the C4 snap-bug pitch').toBeGreaterThan(10);
  });

  it('poly lanes take precedence over the mono pair', () => {
    const bus = lane0Bus(7 / 12); // G4 on the poly bus…
    bus.monoPitch = 0; // …while the mono pair asks for C4
    bus.monoGate = 1;
    const { l } = renderVoice(probePatch({ cutoff: 6000 }), bus, 1);
    const g4 = db(goertzel(l, SR, 392.0, SR / 4, SR));
    const c4 = db(goertzel(l, SR, 261.63, SR / 4, SR));
    expect(g4 - c4).toBeGreaterThan(12);
  });

  it('WIDTH 0 collapses to identical L/R; WIDTH 1 decorrelates the mono unison', () => {
    const at = (width: number) => {
      const { l, r } = renderVoice(
        { ...TIDY_VCO_DEFAULTS, width, sus: 1 },
        { ...silentBus(), monoGate: 1 },
        1,
      );
      let lr = 0;
      let ll = 0;
      let rr = 0;
      let maxd = 0;
      for (let i = SR / 2; i < SR; i++) {
        lr += l[i]! * r[i]!;
        ll += l[i]! ** 2;
        rr += r[i]! ** 2;
        maxd = Math.max(maxd, Math.abs(l[i]! - r[i]!));
      }
      return { corr: lr / Math.sqrt(ll * rr), maxd };
    };
    const w0 = at(0);
    const w1 = at(1);
    expect(w0.maxd).toBeLessThan(1e-7);
    expect(w1.corr, 'true stereo, not dual-mono').toBeLessThan(0.5);
  });

  it('keytrack: TRACK carries the brightness up the keyboard (H3/H1 at C6)', () => {
    // (The whistle-position half of keytracking is proven by composition:
    // the ladder tuning gate pins whistle = fc, and the cutoff-law test
    // pins fc = knob·2^(track·voct). At the VOICE level a hot osc bus
    // chokes the whistle through the feedback limiter — authentic diode
    // behavior — so here we gate the audible half: harmonic rolloff.)
    const f0 = 1046.5; // C6 (voct = 2)
    // A SQUARE probe + H3: probePatch's default SHAPE 0 is a bare sine, so an
    // H4/H1 reading there would be measuring the ladder's own nonlinearity
    // rather than keytracked brightness — and H4 is EVEN, which a square nulls.
    const at = (track: number): number => {
      const { l } = renderVoice(probePatch({ cutoff: 1200, track, shape1: 1 }), lane0Bus(2), 1);
      return db(goertzel(l, SR, 3 * f0, SR / 2, SR) / goertzel(l, SR, f0, SR / 2, SR));
    };
    const dark = at(0); // fc stays 1200 Hz → H3 (3140 Hz) buried
    const bright = at(1); // fc rides to 4800 Hz → H3 opens up
    expect(bright - dark, 'H3/H1 keytrack swing').toBeGreaterThan(15);
    expect(dark, 'untracked: H3 stays buried under the 1200 Hz knee').toBeLessThan(-32); // measured −34.5
  });

  it('keeps the 2×-oversampled drive alias-free (worst inharmonic probe < −60 dBc)', () => {
    const voct = Math.log2(3100 / TIDY_C4_HZ);
    const p = probePatch({ drive: 1, res: 0, cutoff: 14000 });
    const { l } = renderVoice(p, lane0Bus(voct), 1);
    const h1 = goertzel(l, SR, 3100, SR / 2, SR);
    let worst = 0;
    for (const f of [4000, 5150, 7300, 8250, 10850, 13950, 17050, 20150, 23250]) {
      worst = Math.max(worst, goertzel(l, SR, f, SR / 2, SR) / h1);
    }
    expect(db(worst)).toBeLessThan(-60);
  });

  it('survives hostile extremes bounded and NaN-free (|out| < 1 by construction)', () => {
    const corners: Partial<TidyVcoParams>[] = [
      { cutoff: 14000, res: 1, drive: 1, oct2: 1, pw: 0.05, level: 12, env: 1, track: 1 },
      { cutoff: 40, res: 1, drive: 1, oct2: -1, level: 12, env: -1 },
      { cutoff: 14000, res: 0, drive: 1, detune: 50, sub: 1, level: 12 },
      { cutoff: 40, res: 1, drive: 0, atk: 0.0005, rel: 0.001, level: 12 },
      // Wavefolder pinned hard: max fold + full asymmetry + hot drive/res.
      { cutoff: 14000, res: 1, drive: 1, fold: 1, sym: 1, sub: 1, level: 12, env: 1, track: 1 },
      { cutoff: 40, res: 0.9, fold: 1, sym: -1, drive: 0.7, level: 12 },
    ];
    const poly = new Float32Array(10);
    for (let v = 0; v < TIDY_VOICES; v++) {
      poly[v * 2] = v - 2; // -2..+2 V spread
      poly[v * 2 + 1] = 1;
    }
    for (const over of corners) {
      const { l, r } = renderVoice(
        { ...TIDY_VCO_DEFAULTS, ...over, width: 1, sus: 1 },
        { ...silentBus(), poly },
        1,
      );
      // Scan into accumulators + assert ONCE per buffer, not per sample: the
      // old per-sample expect() (≈384k calls across the 4 corners) was pure
      // matcher overhead that blew vitest's 5s default on a loaded CI runner
      // while passing on a quiet local box — a slow test, not a hang.
      for (const buf of [l, r]) {
        let allFinite = true;
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const s = buf[i]!;
          if (!Number.isFinite(s)) allFinite = false;
          const a = Math.abs(s);
          if (a > peak) peak = a;
        }
        expect(allFinite, 'every sample finite (NaN/Inf-free)').toBe(true);
        expect(peak, '|out| < 1 by construction').toBeLessThan(1);
      }
    }
    // 6 corners × 5 gated voices × 1 s through the 2×-oversampled diode ladder
    // + ADAA wavefolder is ~4.5–5 s of pure render — right at vitest's 5 s
    // default. Give it explicit headroom so a LOADED runner (the failure mode
    // this test's own comment above documents) can't flake it (no-flake-
    // tolerance; the assertions are unchanged, a real hang still fails fast).
  }, 15000);

  it('is bit-identical run to run (deterministic by construction)', () => {
    const p = { ...TIDY_VCO_DEFAULTS };
    const a = renderVoice(p, { ...silentBus(), monoGate: 1 }, 0.5);
    const b = renderVoice(p, { ...silentBus(), monoGate: 1 }, 0.5);
    expect(Buffer.from(a.l.buffer).equals(Buffer.from(b.l.buffer))).toBe(true);
    expect(Buffer.from(a.r.buffer).equals(Buffer.from(b.r.buffer))).toBe(true);
  });

  it('FOLD = 0 is a BIT-EXACT bypass of the pre-wavefolder voice (regression anchor)', () => {
    // The wavefolder must be inaudible at FOLD 0 so every existing TIDY VCO
    // patch sounds UNCHANGED: the folder gates to identity, both channels
    // stay identical, and EVERY per-knob CV law is an exact no-op at cv = 0
    // (silentBus omits the optional fields). If this flips with no OTHER
    // intentional core change in the diff, the wavefolder (or a CV law)
    // leaked into the default sound — a bug, not an accepted change.
    // (128-block driven to mirror the worklet granularity.)
    //
    // RE-PINNED once, at the SINE→TRIANGLE→SQUARE oscillator morph: the
    // fingerprints cover the whole voice, so replacing the saw↔pulse osc law
    // necessarily moved them. That change is what `art:update` re-pinned the
    // tidy-vco ART baselines for; nothing about the folder's bypass moved.
    const render = (p: TidyVcoParams, bus: TidyVcoBus): { l: Float32Array; r: Float32Array } => {
      const n = Math.round(0.5 * SR);
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      const st = makeTidyVcoState();
      for (let i = 0; i < n; i += 128) renderTidyVco(p, bus, l, r, i, Math.min(i + 128, n), SR, st);
      return { l, r };
    };
    // Buffer A — mono gate, shipping defaults.
    const A = render({ ...TIDY_VCO_DEFAULTS }, { ...silentBus(), monoGate: 1 });
    expect(fnv1a(A.l), 'mono L bit-identical to pre-wavefolder core').toBe('666dd1f1');
    expect(fnv1a(A.r), 'mono R bit-identical to pre-wavefolder core').toBe('ee1974e0');
    // Buffer B — poly C4/E4/G4 chord, res + drive + width engaged.
    const polyB = new Float32Array(10);
    polyB[0] = 0; polyB[1] = 1;
    polyB[2] = 4 / 12; polyB[3] = 1;
    polyB[4] = 7 / 12; polyB[5] = 1;
    const B = render(
      { ...TIDY_VCO_DEFAULTS, res: 0.6, drive: 0.5, cutoff: 1200, width: 0.7, env: 0.5 },
      { ...silentBus(), poly: polyB },
    );
    expect(fnv1a(B.l), 'poly L bit-identical to pre-wavefolder core').toBe('9020f9a3');
    expect(fnv1a(B.r), 'poly R bit-identical to pre-wavefolder core').toBe('1509e2a2');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// New per-knob CVs — GLOBAL block-rate scalars, consumed by the core. The
// byte-exact NO-OP at cv = 0 is ALSO pinned by the FNV bit-identity test
// above (silentBus / lane0Bus omit the new optional fields → they default to
// 0, so the committed hashes only pass if every new law is an identity at 0).
// ─────────────────────────────────────────────────────────────────────────

describe('tidy-vco: new per-knob CVs are consumed', () => {
  it('levelCv (dB): −1 V pulls the whole voice down ~18 dB; cv = 0 is a no-op', () => {
    const p = probePatch();
    const rmsAt = (levelCv: number) => {
      const { l } = renderVoice(p, { ...lane0Bus(0), levelCv }, 0.4);
      return rms(l, Math.round(0.05 * SR), Math.round(0.35 * SR));
    };
    const loud = rmsAt(0);
    const quiet = rmsAt(-1); // −18 dB ≈ ×0.126
    expect(quiet).toBeLessThan(loud * 0.3);
    // cv = 0 is byte-identical to omitting the field entirely.
    const a = renderVoice(p, { ...lane0Bus(0), levelCv: 0 }, 0.1);
    const b = renderVoice(p, lane0Bus(0), 0.1);
    expect(fnv1a(a.l)).toBe(fnv1a(b.l));
  });

  it('shape1Cv sweeps OSC1 sine→square: +1 V fills in the odd-harmonic series', () => {
    // ⚠ The OLD form of this gate measured the EVEN (2nd) harmonic across the
    // saw→pulse morph. Under the sine→square law BOTH endpoints are odd-only,
    // so that metric compares two noise floors and passes no matter what the
    // CV does — a gate that cannot fail. The honest metric for THIS morph is
    // the ODD content above the fundamental: a sine has none, a square has
    // the full 1/n series.
    const p = probePatch({ shape1: 0, cutoff: 12000, res: 0.1 });
    const s = Math.round(0.1 * SR);
    const e = Math.round(0.35 * SR);
    const oddRatio = (buf: Float32Array): number => {
      const h1 = goertzel(buf, SR, TIDY_C4_HZ, s, e);
      let up = 0;
      for (const k of [3, 5, 7, 9]) up += goertzel(buf, SR, k * TIDY_C4_HZ, s, e) ** 2;
      return db(Math.sqrt(up) / h1);
    };
    const sine = oddRatio(renderVoice(p, lane0Bus(0), 0.4).l); // C4 sine
    const square = oddRatio(renderVoice(p, { ...lane0Bus(0), shape1Cv: 1 }, 0.4).l); // → square
    // ~24 dB measured: the sine end is not a true floor (the ladder's stage
    // saturator + the OTA VCA's own knee put a little odd content there).
    expect(square - sine, 'odd harmonics above the fundamental').toBeGreaterThan(20);
    // …and the CV really is a full-swing sweep, not an on/off: half a volt
    // lands strictly between the two ends.
    const mid = oddRatio(renderVoice(p, { ...lane0Bus(0), shape1Cv: 0.5 }, 0.4).l);
    expect(mid).toBeGreaterThan(sine + 5);
    expect(mid).toBeLessThan(square - 2);
  });
});
