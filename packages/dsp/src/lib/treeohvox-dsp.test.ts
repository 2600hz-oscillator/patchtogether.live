// packages/dsp/src/lib/treeohvox-dsp.test.ts
//
// Pure-DSP unit tests for the TREE.oh.VOX TB-303 voice core (Open303 port:
// diode-feedback ladder + decay/amp envelopes + saw↔square polyBLEP osc +
// env-mod scaler). Extracted but untested — the file even exports test helpers
// (crossCorrelation/rmsWindow/renderVoiceSequence) that were never exercised.
// Deterministic → pins the math a stub ART baseline never touched:
//   • resonanceSkew + tb303Coeffs (verbatim-ported constants; res=0 ⇒ k=0,g=1).
//   • TbVoxFilter = a real resonant low-pass (attenuates highs; reset; no-NaN).
//   • TbVoxDecayEnv (×c → 1/e) + TbVoxAmpEnv (attack/decay, accent louder).
//   • PolyBlepBlendOsc blend=0 is BIT-IDENTICAL to PolyBlepSaw (the invariant
//     the saw ART baselines rely on); blend=1 is square-shaped.
//   • envModScalerOffset clamps + pinned values; pitchCvToFreq V/oct.
//   • TreeohvoxVoice renders an audible, decaying note; accent is louder.
//   • crossCorrelation / rmsWindow helper correctness.

import { describe, it, expect } from 'vitest';
import {
  resonanceSkew,
  tb303Coeffs,
  TbVoxFilter,
  TbVoxDecayEnv,
  TbVoxAmpEnv,
  PolyBlepSaw,
  PolyBlepBlendOsc,
  envModScalerOffset,
  pitchCvToFreq,
  C4_HZ,
  TreeohvoxVoice,
  renderVoiceSequence,
  crossCorrelation,
  rmsWindow,
  type VoiceParams,
} from './treeohvox-dsp';

const SR = 48000;

function sine(freqHz: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freqHz * i) / SR);
  return out;
}
function rms(buf: Float32Array, skip = 2000): number {
  let s = 0,
    c = 0;
  for (let i = skip; i < buf.length; i++) {
    s += buf[i]! * buf[i]!;
    c++;
  }
  return Math.sqrt(s / Math.max(1, c));
}
function filterRender(f: TbVoxFilter, input: Float32Array): Float32Array {
  const o = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) o[i] = f.step(input[i]!);
  return o;
}

describe('resonanceSkew', () => {
  it('clamps to [0,1] and maps 0→0, 1→1, monotonic in between', () => {
    expect(resonanceSkew(0)).toBeCloseTo(0, 9);
    expect(resonanceSkew(1)).toBeCloseTo(1, 9);
    expect(resonanceSkew(-5)).toBe(resonanceSkew(0));
    expect(resonanceSkew(9)).toBe(resonanceSkew(1));
    expect(resonanceSkew(0.3)).toBeGreaterThan(resonanceSkew(0.2));
    expect(resonanceSkew(0.5)).toBeGreaterThan(0);
    expect(resonanceSkew(0.5)).toBeLessThan(1);
  });
});

describe('tb303Coeffs', () => {
  it('res=0 ⇒ k=0 and g=1 (no feedback, unity)', () => {
    const c = tb303Coeffs(1000, 0, SR);
    expect(c.k).toBeCloseTo(0, 12);
    expect(c.g).toBeCloseTo(1, 12);
    expect(c.b0).toBeGreaterThan(0);
  });
  it('clamps cutoff to [200, 20000]', () => {
    expect(tb303Coeffs(50, 0.5, SR)).toEqual(tb303Coeffs(200, 0.5, SR));
    expect(tb303Coeffs(99999, 0.5, SR)).toEqual(tb303Coeffs(20000, 0.5, SR));
  });
  it('k grows with resonance', () => {
    expect(tb303Coeffs(1000, 0.8, SR).k).toBeGreaterThan(tb303Coeffs(1000, 0.2, SR).k);
  });
});

describe('TbVoxFilter (303 diode ladder)', () => {
  it('low-passes — attenuates a high tone far more than a low one', () => {
    const fl = new TbVoxFilter(SR);
    fl.setCutoffRes(1000, 0.1);
    const lowOut = filterRender(fl, sine(200, 9600));
    const fh = new TbVoxFilter(SR);
    fh.setCutoffRes(1000, 0.1);
    const highOut = filterRender(fh, sine(8000, 9600));
    expect(rms(highOut)).toBeLessThan(0.3 * rms(lowOut));
  });
  it('resonance lifts the output level at the cutoff', () => {
    const lo = new TbVoxFilter(SR);
    lo.setCutoffRes(1000, 0.1);
    const hi = new TbVoxFilter(SR);
    hi.setCutoffRes(1000, 0.9);
    const x = sine(1000, 9600);
    expect(rms(filterRender(hi, x))).toBeGreaterThan(rms(filterRender(lo, x)));
  });
  it('reset clears state (silent in → silent out)', () => {
    const f = new TbVoxFilter(SR);
    f.setCutoffRes(800, 0.7);
    filterRender(f, sine(440, 4800));
    f.reset();
    const out = filterRender(f, new Float32Array(2000));
    expect(rms(out, 0)).toBeCloseTo(0, 9);
  });
  it('stays finite at max resonance', () => {
    const f = new TbVoxFilter(SR);
    f.setCutoffRes(1200, 1);
    const out = filterRender(f, sine(1200, 9600));
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true);
  });
});

describe('TbVoxDecayEnv', () => {
  it('decays ×c per sample to 1/e after the decay time', () => {
    const decayMs = 600;
    const env = new TbVoxDecayEnv(SR, decayMs);
    env.trigger();
    const first = env.step(); // returns the value BEFORE decaying → 1.0
    expect(first).toBe(1);
    const tau = Math.round(decayMs * 1e-3 * SR);
    for (let i = 1; i < tau; i++) env.step();
    expect(env.peek()).toBeCloseTo(Math.exp(-1), 2);
  });
  it('peek does not advance the envelope', () => {
    const env = new TbVoxDecayEnv(SR, 600);
    env.trigger();
    env.step();
    const a = env.peek();
    const b = env.peek();
    expect(a).toBe(b);
  });
});

describe('TbVoxAmpEnv', () => {
  it('rises then decays to ~0 and goes inactive', () => {
    const env = new TbVoxAmpEnv(SR, 3, 30); // short decay so 1 s fully settles
    env.trigger(1);
    let maxV = 0;
    let last = 0;
    for (let i = 0; i < SR; i++) {
      last = env.step();
      maxV = Math.max(maxV, last);
    }
    expect(maxV).toBeGreaterThan(0.3); // genuinely opened
    expect(last).toBeLessThan(1e-3); // decayed to silence
    expect(env.isActive()).toBe(false);
  });
  it('accent makes the note louder', () => {
    const peakOf = (lvl: number) => {
      const env = new TbVoxAmpEnv(SR, 3, 400);
      env.trigger(lvl);
      let m = 0;
      for (let i = 0; i < 4000; i++) m = Math.max(m, env.step());
      return m;
    };
    expect(peakOf(1.5)).toBeGreaterThan(peakOf(1));
  });
  it('retrigger glides from the current level (no reset-to-0 click)', () => {
    const env = new TbVoxAmpEnv(SR, 3, 400);
    env.trigger(1);
    for (let i = 0; i < 500; i++) env.step();
    const before = env.step();
    expect(before).toBeGreaterThan(0);
    env.trigger(1); // retrigger
    expect(env.step()).toBeGreaterThan(0); // didn't snap to 0
  });
});

describe('polyBLEP oscillators', () => {
  it('PolyBlepBlendOsc at blend=0 is BIT-IDENTICAL to PolyBlepSaw', () => {
    const saw = new PolyBlepSaw(SR);
    const blend = new PolyBlepBlendOsc(SR);
    for (let i = 0; i < 4000; i++) {
      expect(blend.step(220, 0)).toBe(saw.step(220));
    }
  });
  it('saw output is bounded + roughly zero-mean over a period', () => {
    const saw = new PolyBlepSaw(SR);
    let sum = 0;
    const n = Math.round(SR / 220); // one period of 220 Hz
    for (let i = 0; i < n * 4; i++) {
      const v = saw.step(220);
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(1.6);
      sum += v;
    }
    expect(Math.abs(sum / (n * 4))).toBeLessThan(0.1);
  });
  it('blend=1 is a (mostly ±1) square shape, distinct from the saw', () => {
    const sq = new PolyBlepBlendOsc(SR);
    const sw = new PolyBlepBlendOsc(SR);
    let nearRail = 0;
    let differ = false;
    for (let i = 0; i < 4000; i++) {
      const s = sq.step(110, 1);
      const a = sw.step(110, 0);
      if (Math.abs(Math.abs(s) - 1) < 0.1) nearRail++;
      if (Math.abs(s - a) > 0.2) differ = true;
    }
    expect(nearRail).toBeGreaterThan(2000); // square sits near ±1 most of the time
    expect(differ).toBe(true); // genuinely different from the saw
  });
});

describe('envModScalerOffset', () => {
  it('clamps cutoff: low → offset≈OC, high → offset≈OF+OC', () => {
    expect(envModScalerOffset(1, 0).offset).toBeCloseTo(0.294391201, 6);
    expect(envModScalerOffset(1e6, 0).offset).toBeCloseTo(0.048292931 + 0.294391201, 6);
  });
  it('envMod=0 sets scaler to the SLOC/SHIC baselines at the cutoff extremes', () => {
    expect(envModScalerOffset(1, 0).scaler).toBeCloseTo(0.736965594, 6);
    expect(envModScalerOffset(1e6, 0).scaler).toBeCloseTo(0.864344901, 6);
  });
  it('is finite for a normal cutoff + envMod', () => {
    const m = envModScalerOffset(800, 50);
    expect(Number.isFinite(m.scaler)).toBe(true);
    expect(Number.isFinite(m.offset)).toBe(true);
  });
});

describe('pitchCvToFreq', () => {
  it('0 V (no tune) = C4', () => {
    expect(pitchCvToFreq(0, 0)).toBeCloseTo(C4_HZ, 9);
  });
  it('+1 V = one octave up; +12 semitones tune = one octave up; -1 V = down', () => {
    expect(pitchCvToFreq(1, 0)).toBeCloseTo(2 * C4_HZ, 6);
    expect(pitchCvToFreq(0, 12)).toBeCloseTo(2 * C4_HZ, 6);
    expect(pitchCvToFreq(-1, 0)).toBeCloseTo(C4_HZ / 2, 6);
  });
});

describe('TreeohvoxVoice / renderVoiceSequence', () => {
  const params: VoiceParams = {
    tuneSemitones: 0,
    cutoffHz: 1200,
    resonance: 0.5,
    envAmount01: 0.6,
    decayMs: 400,
    accentAmount01: 0,
  };

  it('renders an audible note that decays after the onset', () => {
    const buf = renderVoiceSequence(params, SR, SR, [
      { atSample: 0, pitchCv: 0, accented: false, gateDurationSamples: SR },
    ]);
    const onset = rms(buf.subarray(0, 4800), 0); // first 100 ms
    const tail = rms(buf.subarray(SR - 4800), 0); // last 100 ms
    expect(onset).toBeGreaterThan(1e-3); // made sound
    expect(tail).toBeLessThan(onset); // and decayed
  });

  it('an accented note is louder than a plain one', () => {
    const plain = renderVoiceSequence({ ...params, accentAmount01: 0.8 }, SR, 8000, [
      { atSample: 0, pitchCv: 0, accented: false, gateDurationSamples: 8000 },
    ]);
    const accented = renderVoiceSequence({ ...params, accentAmount01: 0.8 }, SR, 8000, [
      { atSample: 0, pitchCv: 0, accented: true, gateDurationSamples: 8000 },
    ]);
    const peak = (b: Float32Array) => Math.max(...Array.from(b).map(Math.abs));
    expect(peak(accented)).toBeGreaterThan(peak(plain));
  });

  it('reports active right after a trigger and its output decays over time', () => {
    const v = new TreeohvoxVoice(SR, { ...params, decayMs: 200 });
    v.trigger({ pitchCv: 0, accented: false });
    const early = new Float32Array(4800);
    for (let i = 0; i < 4800; i++) early[i] = v.step(); // first 100 ms
    expect(v.isActive()).toBe(true); // still ringing right after the note
    for (let i = 0; i < SR * 3; i++) v.step(); // advance ~3 s
    const late = new Float32Array(4800);
    for (let i = 0; i < 4800; i++) late[i] = v.step();
    expect(rms(late, 0)).toBeLessThan(rms(early, 0)); // amp env (1230 ms) decayed it
  });
});

describe('crossCorrelation', () => {
  it('identical signals → 1, negated → -1', () => {
    const a = sine(440, 2048);
    const neg = a.map((v) => -v) as Float32Array;
    expect(crossCorrelation(a, a)).toBeCloseTo(1, 6);
    expect(crossCorrelation(a, neg)).toBeCloseTo(-1, 6);
  });
  it('quadrature (sine vs cosine) → ~0', () => {
    const n = 4800; // whole number of 100 Hz periods at 48k
    const s = new Float32Array(n);
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      s[i] = Math.sin((2 * Math.PI * 100 * i) / SR);
      c[i] = Math.cos((2 * Math.PI * 100 * i) / SR);
    }
    expect(Math.abs(crossCorrelation(s, c))).toBeLessThan(0.05);
  });
  it('zero-variance → 0; length mismatch throws', () => {
    expect(crossCorrelation(new Float32Array(8), new Float32Array(8))).toBe(0);
    expect(() => crossCorrelation(new Float32Array(4), new Float32Array(5))).toThrow();
  });
});

describe('rmsWindow', () => {
  it('a constant signal has RMS = |value| once the window fills', () => {
    const buf = new Float32Array(1000).fill(0.5);
    const out = rmsWindow(buf, 100);
    expect(out[out.length - 1]).toBeCloseTo(0.5, 6);
  });
  it('tracks an amplitude step', () => {
    const buf = new Float32Array(2000);
    for (let i = 1000; i < 2000; i++) buf[i] = 1;
    const out = rmsWindow(buf, 200);
    expect(out[500]!).toBeLessThan(0.1); // quiet first half
    expect(out[1999]!).toBeCloseTo(1, 2); // loud tail
  });
});
