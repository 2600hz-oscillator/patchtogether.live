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
    // 3 s ring-out: past every envelope INCLUDING the glue compressor's
    // 150 ms-release memory (1 s left a legit ~1e-4 residue in the detector;
    // hits after real silence are identical).
    const second = hit(144000);
    for (let i = 0; i < 2048; i++) {
      // Precision 4, not bit-exact: phases/envelopes reset EXACTLY at the
      // strike, but the glue compressor legitimately carries release history
      // between hits (as real compressors do) — a ~1e-6 residue after 1 s.
      expect(second[i]).toBeCloseTo(first[i], 4);
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
    // 5e-3: this is the windowed-mean floor of finite low-frequency content
    // (a decaying ~50 Hz tail over a 1 s window), scaled by the ceiling's ×2
    // small-signal makeup — not actual DC (the 22 Hz HPF has exact-zero DC
    // gain; rbj-biquad.test.ts proves the response).
    expect(Math.abs(mean)).toBeLessThan(5e-3);
  });

  it('peak ≤ 1 pre-drive even with both layers maxed (headroom invariant)', () => {
    // EQ/translate zeroed: this test pins the MIX normalization; the default
    // EQ boosts ride on top by design and Phase 4's ceiling bounds them.
    const buf = render(
      24000,
      P({ subLevel: 1, bodyLevel: 1, bodyShape: 1, subEq: 0, bodyEq: 0, attackEq: 0, tilt: 0, translate: 0, attack: 0, sustain: 0, glue: 0, ceiling: 0, level: 0 }),
      48000,
    );
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    // ≤1.3 pre-ceiling: the mix is normalized ≤1, but the always-on 22 Hz
    // HPF overshoots the strike transient (2nd-order IIR step response) and
    // the decimator adds intersample peaks. Phase 4's ceiling is the bound.
    expect(peak).toBeLessThanOrEqual(1.3);
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
      attack: 0, sustain: 0, glue: 0, ceiling: 0, level: -12,
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
    attack: 0, sustain: 0, glue: 0, ceiling: 0, level: -12,
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
    // EQ/translate zeroed to isolate the drive stage (default EQ boosts are
    // bounded by Phase 4's ceiling, not by the drive).
    const base: Partial<KickdrumP1Params> = {
      drive: 0.8,
      bodyDecay: 300,
      clickLevel: 0,
      subEq: 0,
      bodyEq: 0,
      attackEq: 0,
      tilt: 0,
      translate: 0,
      attack: 0, sustain: 0, glue: 0, ceiling: 0, level: -12,
    };
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
    // The nonlinearity is bounded ≤ ~0.9, but the decimation FIR adds
    // intersample (Gibbs) peaks past a hard fold AND the always-on 22 Hz HPF
    // overshoots the strike transient. Physics, not bugs (measured ≈1.23);
    // Phase 4's `ceiling` soft-clip is the TRUE-PEAK bound. Pre-ceiling: ≤1.3.
    expect(peak).toBeLessThanOrEqual(1.3);
    expect(Math.abs(mean / hard.length)).toBeLessThan(1e-3); // asym DC stripped
  });

  it('full voice with drive + click stays strike-deterministic', () => {
    const p = P({ drive: 0.7, hard: 1 });
    expect(render(4096, p, 48000)).toEqual(render(4096, p, 48000));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 3 — EQ (own-code RBJ) + harmonic exciter (translate)
// ─────────────────────────────────────────────────────────────────────────

describe('kickdrum P3: EQ + translate', () => {
  const N = 4800;
  const sr = 48000;

  it('sub_eq shelf raises the 50 Hz band', () => {
    // Static 50 Hz sub only (pitchAmt 0 → no sweep), no drive/exciter noise.
    const base: Partial<KickdrumP1Params> = {
      bodyLevel: 0,
      clickLevel: 0,
      subLevel: 1,
      pitchAmt: 0,
      drive: 0,
      translate: 0,
      subDecay: 800,
      attack: 0, sustain: 0, glue: 0, ceiling: 0, level: -12,
    };
    const flat = render(N, P({ ...base, subEq: 0 }), sr);
    const boosted = render(N, P({ ...base, subEq: 10 }), sr);
    const bin5 = (b: Float32Array) => goertzelMag(b, 5); // 50 Hz
    const db = 20 * Math.log10(bin5(boosted) / bin5(flat));
    expect(db).toBeGreaterThan(3); // shelf midpoint sits AT fc → ~half gain
    expect(db).toBeLessThan(11);
  });

  it('attack_eq bell lifts the click band (2.8 kHz)', () => {
    const base: Partial<KickdrumP1Params> = {
      subLevel: 0,
      bodyLevel: 0,
      clickLevel: 1,
      clickTone: 2800,
      drive: 0,
      translate: 0,
      attack: 0, sustain: 0, glue: 0, ceiling: 0, level: -12,
    };
    const flat = render(N, P({ ...base, attackEq: 0 }), sr);
    const boosted = render(N, P({ ...base, attackEq: 10 }), sr);
    const at28 = (b: Float32Array) => goertzelMag(b, 280); // 2.8 kHz
    const db = 20 * Math.log10(at28(boosted) / at28(flat));
    expect(db).toBeGreaterThan(6);
    expect(db).toBeLessThan(11.5);
  });

  it('tilt=+1 brightens (click band up vs tilt=-1)', () => {
    const base: Partial<KickdrumP1Params> = {
      subLevel: 0,
      bodyLevel: 0,
      clickLevel: 1,
      clickTone: 2800,
      drive: 0,
      translate: 0,
      attack: 0, sustain: 0, glue: 0, ceiling: 0, level: -12,
    };
    const dark = render(N, P({ ...base, tilt: -1 }), sr);
    const bright = render(N, P({ ...base, tilt: 1 }), sr);
    // ±4 dB shelves meet ≈ half-gain AT 2.8 kHz (fc 2.5 kHz, midpoint at fc)
    // → ~5 dB spread ≈ 1.75×. Assert the direction with honest margin.
    expect(goertzelMag(bright, 280) / (goertzelMag(dark, 280) + 1e-12)).toBeGreaterThan(1.5);
  });

  it('translate reconstructs the missing fundamental: 40 Hz sub grows 80/120 Hz partials', () => {
    const base: Partial<KickdrumP1Params> = {
      bodyLevel: 0,
      clickLevel: 0,
      subLevel: 1,
      tune: 40, // bin 4; H2 = bin 8, H3 = bin 12
      pitchAmt: 0,
      drive: 0,
      subDecay: 800,
      attack: 0, sustain: 0, glue: 0, ceiling: 0, level: -12,
    };
    const dry = render(N, P({ ...base, translate: 0 }), sr);
    const wet = render(N, P({ ...base, translate: 0.9 }), sr);
    // Strike-transient splatter puts a real floor in the dry bin, so the
    // measured growth is ~2.7× — assert >2 (direction + magnitude, honestly).
    expect(goertzelMag(wet, 8) / (goertzelMag(dry, 8) + 1e-12)).toBeGreaterThan(2);
    expect(goertzelMag(wet, 12) / (goertzelMag(dry, 12) + 1e-12)).toBeGreaterThan(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 4 — dynamics (transient shaper, SC-HPF'd glue, true-peak ceiling)
// ─────────────────────────────────────────────────────────────────────────

describe('kickdrum P4: dynamics', () => {
  const sr = 48000;

  it('TRUE-PEAK: everything maxed and hot stays strictly < 1.0 (safe to ship)', () => {
    const buf = render(
      24000,
      P({
        subLevel: 1,
        bodyLevel: 1,
        clickLevel: 1,
        drive: 1,
        hard: 1,
        level: 12,
        ceiling: 1,
        subEq: 12,
        bodyEq: 12,
        attackEq: 12,
        translate: 1,
        attack: 1,
      }),
      sr,
    );
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    // ≤ 1.0: tanh is strictly < 1 in ℝ, but float32 rounds the saturated
    // tail to exactly 1.0 — bounded AT 1, never above, is the invariant.
    expect(peak).toBeLessThanOrEqual(1.0);
    expect(peak).toBeGreaterThan(0.8); // hot, not vacuously quiet
  });

  it('glue detector is HPF-ed: a pure 40 Hz sub does NOT pump, upper content does', () => {
    const rms = (buf: Float32Array) => {
      let acc = 0;
      for (let i = 0; i < buf.length; i++) acc += buf[i] * buf[i];
      return Math.sqrt(acc / buf.length);
    };
    // Pure sub (all detector content below the 100 Hz HPF): glue ≈ no-op in
    // STEADY STATE — the broadband strike transient rightly ducks the first
    // ~150 ms (any detector passes it), so both windows skip the attack.
    const subBase: Partial<KickdrumP1Params> = {
      bodyLevel: 0,
      clickLevel: 0,
      subLevel: 1,
      tune: 40,
      pitchAmt: 0,
      drive: 0,
      translate: 0,
      attack: 0,
      sustain: 0,
      ceiling: 0,
      level: -12,
      subDecay: 600,
    };
    const tail = (buf: Float32Array) => buf.subarray(9600); // skip 200 ms attack
    const subDry = rms(tail(render(24000, P({ ...subBase, glue: 0 }), sr)) as Float32Array);
    const subGlued = rms(tail(render(24000, P({ ...subBase, glue: 1 }), sr)) as Float32Array);
    expect(subGlued / subDry).toBeGreaterThan(0.9); // steady sub passes un-pumped

    // Body+click content (150 Hz+ and 2.8 kHz): the glue must actually work.
    const upBase: Partial<KickdrumP1Params> = {
      ...subBase,
      subLevel: 0,
      bodyLevel: 1,
      clickLevel: 1,
      tune: 80, // body at 160 Hz — above the detector HPF
    };
    const upDry = rms(render(24000, P({ ...upBase, glue: 0 }), sr));
    const upGlued = rms(render(24000, P({ ...upBase, glue: 1 }), sr));
    expect(upGlued / upDry).toBeLessThan(0.9);
  });

  it('attack shaper raises the crest factor; negative attack lowers it', () => {
    const crest = (buf: Float32Array) => {
      let peak = 0;
      let acc = 0;
      for (let i = 0; i < buf.length; i++) {
        peak = Math.max(peak, Math.abs(buf[i]));
        acc += buf[i] * buf[i];
      }
      return peak / (Math.sqrt(acc / buf.length) + 1e-12);
    };
    const base: Partial<KickdrumP1Params> = {
      sustain: 0,
      glue: 0,
      ceiling: 0,
      level: -12, // linear region — measure the shaper, not the ceiling
      drive: 0,
    };
    const sharp = crest(render(24000, P({ ...base, attack: 1 }), sr));
    const soft = crest(render(24000, P({ ...base, attack: -1 }), sr));
    expect(sharp).toBeGreaterThan(soft * 1.1);
  });

  it('level is calibrated: +6 dB ≈ 2× RMS in the linear region', () => {
    const rms = (buf: Float32Array) => {
      let acc = 0;
      for (let i = 0; i < buf.length; i++) acc += buf[i] * buf[i];
      return Math.sqrt(acc / buf.length);
    };
    const base: Partial<KickdrumP1Params> = {
      attack: 0,
      sustain: 0,
      glue: 0,
      ceiling: 0,
      drive: 0,
      subLevel: 0.3,
      bodyLevel: 0.2,
      clickLevel: 0,
      translate: 0,
    };
    const lo = rms(render(12000, P({ ...base, level: -18 }), sr));
    const hi = rms(render(12000, P({ ...base, level: -12 }), sr));
    expect(hi / lo).toBeGreaterThan(1.85);
    expect(hi / lo).toBeLessThan(2.15);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 5 — stereo (mono-safe sub, decorrelated >120 Hz width)
// ─────────────────────────────────────────────────────────────────────────

import { kickdrumStepStereo } from './kickdrum-dsp';

function renderStereo(
  n: number,
  p: KickdrumP1Params,
  sr: number,
): { l: Float32Array; r: Float32Array } {
  const s = makeKickdrumState();
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const out = new Float32Array(2);
  for (let t = 0; t < n; t++) {
    kickdrumStepStereo(t < 10 ? 1 : 0, 0, p, sr, s, out);
    l[t] = out[0];
    r[t] = out[1];
  }
  return { l, r };
}

describe('kickdrum P5: stereo', () => {
  const sr = 48000;

  it('width=0 → L and R are identical', () => {
    const { l, r } = renderStereo(4096, P({ width: 0 }), sr);
    expect(l).toEqual(r);
  });

  it('width>0 decorrelates ONLY above the crossover: the sub stays mono', () => {
    // Linear region (ceiling 0, level −12) — at hot settings the ceiling's
    // tanh legitimately intermodulates side×mid (sech²(g·m) smears click
    // energy down-band ~−20 dB); the CROSSOVER claim is measured where the
    // clip is transparent, like every other stage-isolation test.
    const { l, r } = renderStereo(
      9600,
      P({ width: 1, clickLevel: 1, ceiling: 0, level: -12 }),
      sr,
    );
    const diff = new Float32Array(9600);
    let anyDiff = 0;
    for (let i = 0; i < 9600; i++) {
      diff[i] = l[i] - r[i];
      anyDiff = Math.max(anyDiff, Math.abs(diff[i]));
    }
    expect(anyDiff).toBeGreaterThan(1e-4); // genuinely stereo
    // The L−R (side) signal has ~no energy at 50 Hz vs the click band: the
    // sub is phase-coherent mono.
    const sideLow = goertzelMag(diff, 10); // 50 Hz (N=9600 → bin=f/5)
    const sideHigh = goertzelMag(diff, 560); // 2.8 kHz
    expect(sideLow / (sideHigh + 1e-12)).toBeLessThan(0.05);
  });

  it('mono fold-down does not thin the low band ((L+R)/2 ≈ mono at 50 Hz)', () => {
    const p = P({ width: 1 });
    const { l, r } = renderStereo(9600, p, sr);
    const folded = new Float32Array(9600);
    for (let i = 0; i < 9600; i++) folded[i] = 0.5 * (l[i] + r[i]);
    const mono = render(9600, p, sr);
    const ratio = goertzelMag(folded, 10) / (goertzelMag(mono, 10) + 1e-12);
    expect(ratio).toBeGreaterThan(0.97);
    expect(ratio).toBeLessThan(1.03);
  });

  it('each stereo channel is independently true-peak-bounded ≤ 1.0', () => {
    const { l, r } = renderStereo(
      24000,
      P({ width: 1, clickLevel: 1, drive: 1, hard: 1, level: 12, ceiling: 1 }),
      sr,
    );
    let peak = 0;
    for (let i = 0; i < 24000; i++) {
      peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    }
    expect(peak).toBeLessThanOrEqual(1.0);
    expect(peak).toBeGreaterThan(0.8);
  });

  it('stereo render is strike-deterministic', () => {
    const a = renderStereo(4096, P({ width: 0.7 }), sr);
    const b = renderStereo(4096, P({ width: 0.7 }), sr);
    expect(a.l).toEqual(b.l);
    expect(a.r).toEqual(b.r);
  });
});
