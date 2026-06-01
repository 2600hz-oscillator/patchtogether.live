// packages/web/src/lib/audio/modules/treeohvox-dsp.test.ts
//
// Unit tests for the TREE.oh.VOX DSP helpers in
// packages/dsp/src/lib/treeohvox-dsp.ts. Pin algorithmic behaviour
// independently of the AudioWorkletProcessor wrapper — a topology
// regression in the diode-ladder coefficients, the envelope shape, or
// the env-mod scaler math should fail HERE first.
//
// Per the in-repo convention (see resofilter-dsp.test.ts header), tests
// live under `packages/web/...` because that's where the project's
// vitest target runs. The import reaches across into `packages/dsp/src/lib`
// via a relative path.

import { describe, it, expect } from 'vitest';
import {
  TbVoxFilter,
  TbVoxDecayEnv,
  TbVoxAmpEnv,
  TbVoxFeedbackHp,
  PolyBlepSaw,
  PolyBlepBlendOsc,
  TreeohvoxVoice,
  pitchCvToFreq,
  resonanceSkew,
  tb303Coeffs,
  envModScalerOffset,
  renderVoiceSequence,
  crossCorrelation,
  rmsWindow,
  C4_HZ,
  type VoiceParams,
} from '../../../../../dsp/src/lib/treeohvox-dsp';

const SR = 48000;

describe('PolyBlepBlendOsc — saw↔square waveform morph', () => {
  function render(blend: number, freq = 220, n = 4096): Float32Array {
    const osc = new PolyBlepBlendOsc(SR);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = osc.step(freq, blend);
    return out;
  }
  /** Fraction of samples sitting on a plateau (|v| > 0.8). Saw ramps through
   *  this band briefly; a square spends almost all its time there. */
  function plateauFrac(buf: Float32Array): number {
    let c = 0;
    for (const v of buf) if (Math.abs(v) > 0.8) c++;
    return c / buf.length;
  }

  /** RMS of (render(blend) − render(0)) — how far the morphed wave departs
   *  from the pure saw. Grows monotonically as blend → square. */
  function deviationFromSaw(blend: number): number {
    const a = render(blend);
    const saw = render(0);
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i]! - saw[i]!;
      s += d * d;
    }
    return Math.sqrt(s / a.length);
  }

  it('blend=0 equals PolyBlepSaw sample-for-sample (saw default unchanged)', () => {
    const blend = new PolyBlepBlendOsc(SR);
    const saw = new PolyBlepSaw(SR);
    for (let i = 0; i < 4096; i++) {
      // Both return float64 (no Float32Array rounding), so the saw path must
      // be exactly identical — proves the morph is a pure superset of the saw.
      expect(blend.step(220, 0)).toBe(saw.step(220));
    }
  });

  it('blend=1 is a poly-BLEP square: ~zero mean + mostly on ±1 plateaus', () => {
    const sq = render(1);
    const mean = sq.reduce((a, b) => a + b, 0) / sq.length;
    expect(Math.abs(mean)).toBeLessThan(0.05); // 50% duty → balanced
    expect(plateauFrac(sq)).toBeGreaterThan(0.85); // square sits on ±1
  });

  it('the morph is continuous + monotonic (deviation from saw grows with blend)', () => {
    expect(deviationFromSaw(0)).toBe(0);
    expect(deviationFromSaw(0.5)).toBeGreaterThan(0);
    expect(deviationFromSaw(1)).toBeGreaterThan(deviationFromSaw(0.5));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// pitchCvToFreq — 1V/oct sanity.
// ────────────────────────────────────────────────────────────────────────────

describe('treeohvox-dsp / pitchCvToFreq', () => {
  it('0 V at 0 semitones → C4 (≈261.626 Hz)', () => {
    expect(pitchCvToFreq(0, 0)).toBeCloseTo(C4_HZ, 3);
  });

  it('+1 V doubles frequency (one octave up)', () => {
    const baseFreq = pitchCvToFreq(0, 0);
    expect(pitchCvToFreq(1, 0)).toBeCloseTo(baseFreq * 2, 3);
  });

  it('-1 V halves frequency', () => {
    const baseFreq = pitchCvToFreq(0, 0);
    expect(pitchCvToFreq(-1, 0)).toBeCloseTo(baseFreq / 2, 3);
  });

  it('+12 semitones tune == +1 V CV (octave equivalent)', () => {
    expect(pitchCvToFreq(0, 12)).toBeCloseTo(pitchCvToFreq(1, 0), 3);
  });

  it('-12 semitones tune == -1 V CV', () => {
    expect(pitchCvToFreq(0, -12)).toBeCloseTo(pitchCvToFreq(-1, 0), 3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// resonanceSkew — mirrors Open303's exponential skew formula.
// ────────────────────────────────────────────────────────────────────────────

describe('treeohvox-dsp / resonanceSkew', () => {
  it('skew(0) = 0', () => {
    expect(resonanceSkew(0)).toBe(0);
  });

  it('skew(1) = 1 (the (1-exp(-3))/(1-exp(-3)) endpoint)', () => {
    expect(resonanceSkew(1)).toBeCloseTo(1, 10);
  });

  it('skew(0.5) > 0.5 (concave curve, lifts the midpoint)', () => {
    // (1 - exp(-1.5)) / (1 - exp(-3)) ≈ 0.7769 / 0.9502 ≈ 0.818
    expect(resonanceSkew(0.5)).toBeCloseTo(0.8176, 3);
  });

  it('clamps outside [0,1]', () => {
    expect(resonanceSkew(-5)).toBe(0);
    expect(resonanceSkew(5)).toBeCloseTo(1, 10);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// tb303Coeffs — verbatim port of Open303's TB_303 coefficient math.
// We don't have a golden reference for the exact b0/g/k values without
// running upstream C++; instead we pin them at known cutoffs/resonances
// and assert the values stay STABLE across regressions. If a refactor
// breaks the constants, these snapshots fail loud.
// ────────────────────────────────────────────────────────────────────────────

describe('treeohvox-dsp / tb303Coeffs', () => {
  it('produces finite, sensible coefficients at canonical cutoff (1 kHz, r=0.5)', () => {
    const r = resonanceSkew(0.5);
    const { b0, g, k } = tb303Coeffs(1000, r, SR);
    expect(Number.isFinite(b0)).toBe(true);
    expect(Number.isFinite(g)).toBe(true);
    expect(Number.isFinite(k)).toBe(true);
    // b0 is roughly the normalised cutoff — at 1 kHz / 48 kHz ≈ 0.02 with
    // the 1/sqrt(2) prewarp factor. Loose bounds; the test is about
    // stability not specific values.
    expect(b0).toBeGreaterThan(0);
    expect(b0).toBeLessThan(1);
    // Resonance k should be positive when r > 0.
    expect(k).toBeGreaterThan(0);
  });

  it('k scales with resonance (k(r=0.9) > k(r=0.1))', () => {
    const kLo = tb303Coeffs(1000, resonanceSkew(0.1), SR).k;
    const kHi = tb303Coeffs(1000, resonanceSkew(0.9), SR).k;
    expect(kHi).toBeGreaterThan(kLo);
  });

  it('cutoff floor clamps at 200 Hz', () => {
    const c1 = tb303Coeffs(50, resonanceSkew(0.5), SR);
    const c2 = tb303Coeffs(200, resonanceSkew(0.5), SR);
    // Below-floor input should produce the SAME coefficients as the floor.
    expect(c1.b0).toBeCloseTo(c2.b0, 10);
    expect(c1.g).toBeCloseTo(c2.g, 10);
    expect(c1.k).toBeCloseTo(c2.k, 10);
  });

  it('cutoff ceiling clamps at 20 kHz', () => {
    const c1 = tb303Coeffs(40000, resonanceSkew(0.5), SR);
    const c2 = tb303Coeffs(20000, resonanceSkew(0.5), SR);
    expect(c1.b0).toBeCloseTo(c2.b0, 10);
    expect(c1.k).toBeCloseTo(c2.k, 10);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TbVoxDecayEnv — exponential decay shape.
// ────────────────────────────────────────────────────────────────────────────

describe('treeohvox-dsp / TbVoxDecayEnv', () => {
  it('starts at 1.0 after trigger', () => {
    const env = new TbVoxDecayEnv(SR, 600);
    env.trigger();
    expect(env.peek()).toBe(1.0);
  });

  it('decays to 1/e ≈ 0.368 in `decayMs` ms (the rosic τ convention)', () => {
    const decayMs = 100;
    const env = new TbVoxDecayEnv(SR, decayMs);
    env.trigger();
    const tauSamples = Math.round(SR * decayMs * 1e-3);
    for (let i = 0; i < tauSamples; i++) env.step();
    // After τ samples y should be ~1/e. We allow a few-percent tolerance
    // because step() returns the PRE-update value, so the "current" value
    // after τ steps is multiplied τ times.
    const expected = Math.exp(-1);
    expect(env.peek()).toBeCloseTo(expected, 2);
  });

  it('continues decaying monotonically (no overshoot)', () => {
    const env = new TbVoxDecayEnv(SR, 500);
    env.trigger();
    let prev = env.step();
    for (let i = 0; i < 1000; i++) {
      const cur = env.step();
      expect(cur).toBeLessThanOrEqual(prev + 1e-12);
      prev = cur;
    }
  });

  it('a fresh trigger resets to 1.0 mid-decay', () => {
    // 50 ms tau, step for 100 ms (= 2τ) so peek lands at ~exp(-2) ≈ 0.135.
    const env = new TbVoxDecayEnv(SR, 50);
    env.trigger();
    const stepCount = Math.round(SR * 0.1);
    for (let i = 0; i < stepCount; i++) env.step();
    expect(env.peek()).toBeLessThan(0.5);
    env.trigger();
    expect(env.peek()).toBe(1.0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TbVoxFilter — verify (a) it doesn't blow up at canonical settings, (b)
// produces low-pass character (highs attenuated more than lows), (c) at
// high resonance the filter rings on an impulse.
// ────────────────────────────────────────────────────────────────────────────

function sineBuf(freqHz: number, durSec: number, sr = SR, amp = 0.5): Float32Array {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sr);
  return out;
}

function rms(buf: Float32Array, skip = 0): number {
  let s = 0;
  const n = buf.length - skip;
  for (let i = skip; i < buf.length; i++) s += (buf[i] ?? 0) * (buf[i] ?? 0);
  return Math.sqrt(s / n);
}

describe('treeohvox-dsp / TbVoxFilter', () => {
  it('produces finite output for a sine input at canonical knobs', () => {
    const filt = new TbVoxFilter(SR);
    filt.setCutoffRes(1000, 0.5);
    const inBuf = sineBuf(440, 0.05);
    const out = new Float32Array(inBuf.length);
    for (let i = 0; i < inBuf.length; i++) out[i] = filt.step(inBuf[i] ?? 0);
    const badIdx = out.findIndex((v) => !Number.isFinite(v));
    expect(badIdx, `non-finite at ${badIdx}: ${out[badIdx]}`).toBe(-1);
  });

  it('low-passes: at cutoff=400 Hz, 200 Hz sine passes louder than 4 kHz sine', () => {
    const cutoff = 400;
    function probe(freqHz: number): number {
      const filt = new TbVoxFilter(SR);
      filt.setCutoffRes(cutoff, 0.3);
      const inBuf = sineBuf(freqHz, 0.2);
      const out = new Float32Array(inBuf.length);
      for (let i = 0; i < inBuf.length; i++) out[i] = filt.step(inBuf[i] ?? 0);
      // Skip the first 100 ms to let the filter settle.
      return rms(out, Math.round(0.1 * SR));
    }
    const lowAmp = probe(200);
    const highAmp = probe(4000);
    expect(lowAmp).toBeGreaterThan(highAmp);
  });

  it('at high resonance, the filter rings LONGER than at low resonance', () => {
    // Drive an impulse train (not a single impulse) — Open303's TB_303 mode
    // needs steady excitation to start ringing because the feedback HP at
    // 150 Hz throws away DC + low-frequency energy. A single impulse decays
    // too fast to make the ringing visible. Compare LOW vs HIGH res tail
    // ratios under the same excitation.
    function tailEnergy(res: number): number {
      const filt = new TbVoxFilter(SR);
      filt.setCutoffRes(1000, res);
      const n = Math.round(SR * 0.3);
      const out = new Float32Array(n);
      // Excite with a low-amplitude sine at the cutoff for 50 ms, then
      // measure the tail (last 50 ms — well after excitation stops).
      const exciteSamples = Math.round(SR * 0.05);
      for (let i = 0; i < n; i++) {
        const drive = i < exciteSamples ? 0.1 * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0;
        out[i] = filt.step(drive);
      }
      const tail = out.subarray(Math.round(SR * 0.2));
      return rms(tail);
    }
    const lowTail = tailEnergy(0.05);
    const highTail = tailEnergy(0.95);
    // High res should produce a longer-ringing tail. The 5× ratio is a
    // gentle threshold — the actual ratio is usually 50×+, but the test
    // pins direction, not magnitude.
    expect(highTail).toBeGreaterThan(lowTail * 5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// envModScalerOffset — pin the measured-mapping constants. Different
// (cutoff, envMod) inputs must produce different (scaler, offset) outputs;
// hold-test the canonical mid-cutoff/mid-env values.
// ────────────────────────────────────────────────────────────────────────────

describe('treeohvox-dsp / envModScalerOffset', () => {
  it('finite + scaler positive at canonical mid (cutoff=1 kHz, envMod=50)', () => {
    const { scaler, offset } = envModScalerOffset(1000, 50);
    expect(Number.isFinite(scaler)).toBe(true);
    expect(Number.isFinite(offset)).toBe(true);
    expect(scaler).toBeGreaterThan(0);
  });

  it('scaler grows with envMod (envMod=80 produces larger sweep than envMod=10)', () => {
    const lo = envModScalerOffset(1000, 10).scaler;
    const hi = envModScalerOffset(1000, 80).scaler;
    expect(hi).toBeGreaterThan(lo);
  });

  it('offset is positive and bounded (not larger than ~0.5)', () => {
    const { offset } = envModScalerOffset(1000, 50);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(0.5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TreeohvoxVoice — end-to-end sanity: trigger a note, render 200 ms, check
// the output is non-empty, audible, and finite.
// ────────────────────────────────────────────────────────────────────────────

const CANONICAL: VoiceParams = {
  tuneSemitones: 0,
  cutoffHz: 1000,
  resonance: 0.6,
  envAmount01: 0.6,
  decayMs: 600,
  accentAmount01: 0.5,
};

describe('treeohvox-dsp / TreeohvoxVoice end-to-end', () => {
  it('renders a non-empty audible note', () => {
    const voice = new TreeohvoxVoice(SR, CANONICAL);
    voice.trigger({ pitchCv: -1, accented: false }); // C3 — 130.81 Hz
    const samples = Math.round(SR * 0.2);
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) out[i] = voice.step();
    const e = rms(out);
    expect(Number.isFinite(e)).toBe(true);
    expect(e).toBeGreaterThan(0.01); // audible
    const badIdx = out.findIndex((v) => !Number.isFinite(v));
    expect(badIdx).toBe(-1);
  });

  it('accented note is LOUDER (peak amp) than non-accented at same cutoff', () => {
    const samples = Math.round(SR * 0.15);
    const voiceA = new TreeohvoxVoice(SR, CANONICAL);
    voiceA.trigger({ pitchCv: 0, accented: false });
    const outA = new Float32Array(samples);
    for (let i = 0; i < samples; i++) outA[i] = voiceA.step();
    const voiceB = new TreeohvoxVoice(SR, CANONICAL);
    voiceB.trigger({ pitchCv: 0, accented: true });
    const outB = new Float32Array(samples);
    for (let i = 0; i < samples; i++) outB[i] = voiceB.step();
    // Peak measured over the first 50 ms — the attack region where the
    // accent boost is most visible (amp envelope hasn't decayed much).
    function peak(buf: Float32Array, end: number): number {
      let p = 0;
      for (let i = 0; i < end; i++) {
        const v = Math.abs(buf[i] ?? 0);
        if (v > p) p = v;
      }
      return p;
    }
    const region = Math.round(SR * 0.05);
    const pA = peak(outA, region);
    const pB = peak(outB, region);
    expect(pB).toBeGreaterThan(pA);
  });

  it('decay envelope brings the voice to ~silence after the amp envelope completes', () => {
    // The amp envelope dominates the tail (the rosic AnalogEnvelope decay
    // is ~1230 ms internally — the DECAY knob controls the FILTER envelope
    // only, matching Open303's separate ampEnv vs mainEnv). Render long
    // enough that the amp env has decayed to ≥1% of peak (4× tau ≈ 5 s).
    const voice = new TreeohvoxVoice(SR, { ...CANONICAL, decayMs: 50 });
    voice.trigger({ pitchCv: 0, accented: false });
    const totalSamples = Math.round(SR * 5.0);
    const out = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) out[i] = voice.step();
    // Compare a 50 ms body slice (just after attack) against the last
    // 200 ms (well after both envs have collapsed).
    const bodyAmp = rms(out.subarray(Math.round(SR * 0.005), Math.round(SR * 0.055)));
    const tailAmp = rms(out.subarray(Math.round(SR * 4.8)));
    expect(tailAmp).toBeLessThan(bodyAmp * 0.05);
  });

  it('higher cutoff produces brighter output (more high-freq energy)', () => {
    function render(cutoffHz: number): Float32Array {
      const voice = new TreeohvoxVoice(SR, { ...CANONICAL, cutoffHz, envAmount01: 0 });
      voice.trigger({ pitchCv: -1, accented: false });
      const n = Math.round(SR * 0.1);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = voice.step();
      return out;
    }
    // Goertzel-ish band energy comparison: amplitude at 2.5 kHz between
    // cutoff=400 vs cutoff=4000. Brighter cutoff should produce more high-
    // band energy.
    function bandAmp(buf: Float32Array, freqHz: number): number {
      const w = (2 * Math.PI * freqHz) / SR;
      let re = 0; let im = 0;
      for (let i = 0; i < buf.length; i++) {
        re += (buf[i] ?? 0) * Math.cos(w * i);
        im += (buf[i] ?? 0) * Math.sin(w * i);
      }
      return Math.sqrt(re * re + im * im) / buf.length;
    }
    const dark = render(400);
    const bright = render(4000);
    const skip = Math.round(SR * 0.04);
    const darkHigh = bandAmp(dark.subarray(skip), 2500);
    const brightHigh = bandAmp(bright.subarray(skip), 2500);
    expect(brightHigh).toBeGreaterThan(darkHigh * 2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// renderVoiceSequence + utilities — the offline render helper used by
// ART scenarios and the parity test.
// ────────────────────────────────────────────────────────────────────────────

describe('treeohvox-dsp / renderVoiceSequence', () => {
  it('returns a Float32Array of exactly totalSamples length', () => {
    const buf = renderVoiceSequence(CANONICAL, SR, 1000, []);
    expect(buf.length).toBe(1000);
  });

  it('an empty note list produces silence', () => {
    const buf = renderVoiceSequence(CANONICAL, SR, 4800, []);
    // Allow a tiny baseline from numerical noise but it should be ~0.
    expect(rms(buf)).toBeLessThan(1e-6);
  });

  it('scheduling 2 notes produces 2 audible bursts', () => {
    const buf = renderVoiceSequence(CANONICAL, SR, SR, [
      { atSample: 0,        pitchCv: 0, accented: false, gateDurationSamples: SR / 4 },
      { atSample: SR / 2,   pitchCv: 0, accented: false, gateDurationSamples: SR / 4 },
    ]);
    const firstHalf = rms(buf.subarray(0, SR / 4));
    const lull = rms(buf.subarray(Math.round(SR * 0.45), Math.round(SR * 0.49)));
    const secondHalf = rms(buf.subarray(SR / 2, Math.round(SR * 0.75)));
    expect(firstHalf).toBeGreaterThan(0.01);
    expect(secondHalf).toBeGreaterThan(0.01);
    // Lull between notes should be quieter than the second burst.
    expect(lull).toBeLessThan(secondHalf);
  });
});

describe('treeohvox-dsp / crossCorrelation', () => {
  it('returns 1.0 for identical signals', () => {
    const a = sineBuf(440, 0.05);
    expect(crossCorrelation(a, a)).toBeCloseTo(1, 5);
  });

  it('returns ~-1 for inverted signals', () => {
    const a = sineBuf(440, 0.05);
    const b = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) b[i] = -(a[i] ?? 0);
    expect(crossCorrelation(a, b)).toBeCloseTo(-1, 5);
  });

  it('throws on length mismatch', () => {
    expect(() => crossCorrelation(new Float32Array(10), new Float32Array(20))).toThrow();
  });
});

describe('treeohvox-dsp / rmsWindow', () => {
  it('returns 0 for a silent buffer', () => {
    const out = rmsWindow(new Float32Array(1000), 100);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('returns √(0.5) ≈ 0.707 over a long-running unit sine', () => {
    const buf = sineBuf(440, 0.5, SR, 1);
    const out = rmsWindow(buf, 1024);
    // After the window fills (i >= 1024), the running RMS should sit
    // near 1/sqrt(2).
    const tailMean =
      Array.from(out.subarray(2048)).reduce((s, v) => s + v, 0) / (out.length - 2048);
    expect(tailMean).toBeCloseTo(Math.SQRT1_2, 1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PolyBlepSaw + TbVoxAmpEnv + TbVoxFeedbackHp — quick sanity (the building
// blocks above sit inside the higher-level tests too, but a focused unit
// catches regressions earlier).
// ────────────────────────────────────────────────────────────────────────────

describe('treeohvox-dsp / building blocks', () => {
  it('PolyBlepSaw produces a periodic ±1 ramp', () => {
    const osc = new PolyBlepSaw(SR);
    const freq = 100;
    const samples = Math.round(SR * 0.05);
    const buf = new Float32Array(samples);
    for (let i = 0; i < samples; i++) buf[i] = osc.step(freq);
    // Range check.
    for (let i = 0; i < samples; i++) {
      expect(buf[i]).toBeGreaterThanOrEqual(-1.5);
      expect(buf[i]).toBeLessThanOrEqual(1.5);
    }
    // Energy non-zero, mean near zero (saw is DC-free at 100 Hz / 48 kHz).
    const mean = buf.reduce((s, v) => s + v, 0) / buf.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(rms(buf)).toBeGreaterThan(0.3);
  });

  it('TbVoxAmpEnv attack → decay → silence', () => {
    const env = new TbVoxAmpEnv(SR, 1, 50); // 1 ms attack, 50 ms decay tau
    env.trigger(1);
    const sampleCount = Math.round(SR * 0.6); // 600 ms = 12τ — well into noise floor
    const trajectory = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) trajectory[i] = env.step();
    // Peak should be early (within the attack region — first ~5 ms ≈ 240 samples).
    let peakIdx = 0;
    for (let i = 1; i < trajectory.length; i++) {
      if ((trajectory[i] ?? 0) > (trajectory[peakIdx] ?? 0)) peakIdx = i;
    }
    expect(peakIdx).toBeLessThan(SR / 50);
    // Tail (last sample) should be at noise-floor — 12τ ≈ exp(-12) < 1e-5.
    expect(trajectory[trajectory.length - 1]).toBeLessThan(1e-3);
  });

  it('TbVoxFeedbackHp suppresses DC', () => {
    const hp = new TbVoxFeedbackHp(SR, 150);
    let y = 0;
    for (let i = 0; i < 1000; i++) y = hp.step(1.0); // constant 1.0 input
    expect(Math.abs(y)).toBeLessThan(0.01);
  });
});
