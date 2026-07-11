// packages/dsp/src/lib/tidy-vco-dsp.test.ts
//
// TIDY VCO core correctness gates:
//   • diode-ladder math: small-signal linearity (DC gain 1), −24 dB/oct
//     asymptote, THE TUNING GATE (self-osc pitch < 3 cents across 5+
//     octaves at 48 kHz AND 44.1 kHz — the resonance-prewarp calibration
//     pin), bounded CLEAN self-oscillation (near-pure sine), resonance
//     onset placement, passband-compensation window (the documented
//     "how much do the lows thin at high res" decision), alias floor.
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
  makeDiodeLadderState,
  makeRcAdsrState,
  makeTidyVcoState,
  rcAdsrGate,
  rcAdsrTick,
  renderTidyVco,
  tidyCompGain,
  tidyCutoffHz,
  tidyCutoffToG,
  tidyDriveGains,
  tidyFreqHz,
  tidyOtaVca,
  tidyPwEff,
  tidyResToK,
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

/** A neutral single-osc probe patch: saw, no detune/sub, filter open-ish. */
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

  it('keytrack: TRACK carries the brightness up the keyboard (H4/H1 at C6)', () => {
    // (The whistle-position half of keytracking is proven by composition:
    // the ladder tuning gate pins whistle = fc, and the cutoff-law test
    // pins fc = knob·2^(track·voct). At the VOICE level a hot osc bus
    // chokes the whistle through the feedback limiter — authentic diode
    // behavior — so here we gate the audible half: harmonic rolloff.)
    const f0 = 1046.5; // C6 (voct = 2)
    const at = (track: number): number => {
      const { l } = renderVoice(probePatch({ cutoff: 1200, track }), lane0Bus(2), 1);
      return db(goertzel(l, SR, 4 * f0, SR / 2, SR) / goertzel(l, SR, f0, SR / 2, SR));
    };
    const dark = at(0); // fc stays 1200 Hz → H4 (4186 Hz) buried
    const bright = at(1); // fc rides to 4800 Hz → H4 opens up
    expect(bright - dark, 'H4/H1 keytrack swing').toBeGreaterThan(15);
    expect(dark).toBeLessThan(-38);
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
      for (const buf of [l, r]) {
        for (let i = 0; i < buf.length; i++) {
          expect(Number.isFinite(buf[i]!)).toBe(true);
          expect(Math.abs(buf[i]!)).toBeLessThan(1);
        }
      }
    }
  });

  it('is bit-identical run to run (deterministic by construction)', () => {
    const p = { ...TIDY_VCO_DEFAULTS };
    const a = renderVoice(p, { ...silentBus(), monoGate: 1 }, 0.5);
    const b = renderVoice(p, { ...silentBus(), monoGate: 1 }, 0.5);
    expect(Buffer.from(a.l.buffer).equals(Buffer.from(b.l.buffer))).toBe(true);
    expect(Buffer.from(a.r.buffer).equals(Buffer.from(b.r.buffer))).toBe(true);
  });
});
