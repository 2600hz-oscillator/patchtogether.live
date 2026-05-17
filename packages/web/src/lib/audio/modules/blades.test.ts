// packages/web/src/lib/audio/modules/blades.test.ts
//
// Unit tests for BLADES — dual SVF + COLOR overdrive + mix bus.
// Pin per-mode response shape, cutoff/resonance mappings, mix-mode
// toggle behaviour, and self-oscillation onset. Worklet-level
// integration (sample-accurate over thousands of frames, real audio)
// is covered by the ART scenario.

import { describe, expect, it } from 'vitest';
import {
  bladesDef,
  bladesMath,
  BLADES_MODE_NAMES,
  BLADES_MAX_MODE,
  BLADES_MIX_MODE_NAMES,
} from './blades';

const SR = 48000;

function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0; let n = 0;
  for (let i = from; i < to; i++) { s += buf[i]! * buf[i]!; n++; }
  return Math.sqrt(s / Math.max(1, n));
}

function sineBuf(freqHz: number, frames: number, sr: number, amp = 0.5): Float32Array {
  const b = new Float32Array(frames);
  for (let i = 0; i < frames; i++) b[i] = amp * Math.sin(2 * Math.PI * freqHz * i / sr);
  return b;
}

// Cheap single-bin Goertzel-style amplitude estimator at the given freq.
function bandAmp(buf: Float32Array, freqHz: number, sr: number): number {
  const w = 2 * Math.PI * freqHz / sr;
  let re = 0; let im = 0;
  for (let i = 0; i < buf.length; i++) {
    re += buf[i]! * Math.cos(w * i);
    im += buf[i]! * Math.sin(w * i);
  }
  return 2 * Math.sqrt(re * re + im * im) / buf.length;
}

describe('bladesDef shape', () => {
  it('declares type=blades, label=BLADES, category=filters', () => {
    expect(bladesDef.type).toBe('blades');
    expect(bladesDef.label).toBe('BLADES');
    expect(bladesDef.category).toBe('filters');
    expect(bladesDef.domain).toBe('audio');
  });

  it('exposes per-filter audio in/out + voct + cutoff CV + the mix port', () => {
    const ins = bladesDef.inputs.map((p) => p.id);
    const outs = bladesDef.outputs.map((p) => p.id);
    expect(ins).toEqual(expect.arrayContaining([
      'in1', 'in2', 'voct1', 'voct2',
      'cutoff1_cv', 'cutoff2_cv',
      'res1_cv', 'res2_cv',
      'color_cv', 'mix_mode_cv',
    ]));
    expect(outs).toEqual(['out1', 'out2', 'mix']);
  });

  it('exposes the canonical 8 params with sensible defaults', () => {
    const byId: Record<string, number> = {};
    for (const p of bladesDef.params) byId[p.id] = p.defaultValue;
    expect(byId.cutoff1).toBe(1000);
    expect(byId.cutoff2).toBe(1000);
    expect(byId.res1).toBe(0.1);
    expect(byId.res2).toBe(0.1);
    expect(byId.mode1).toBe(0);
    expect(byId.mode2).toBe(0);
    expect(byId.color).toBe(0);
    expect(byId.mixMode).toBe(0);
  });

  it('mode name table matches LP / BP / HP and BLADES_MAX_MODE = 2', () => {
    expect([...BLADES_MODE_NAMES]).toEqual(['LP', 'BP', 'HP']);
    expect(BLADES_MAX_MODE).toBe(2);
    expect([...BLADES_MIX_MODE_NAMES]).toEqual(['PARALLEL', 'SERIAL']);
  });

  it('res / color / mix-mode CV inputs declare cvScale (route via AudioParam)', () => {
    const ins = bladesDef.inputs;
    const expectScale = (id: string, mode: string) => {
      const p = ins.find((x) => x.id === id);
      expect(p?.cvScale?.mode, `${id} cvScale.mode`).toBe(mode);
      expect(p?.paramTarget, `${id} paramTarget`).toBeTruthy();
    };
    expectScale('res1_cv', 'linear');
    expectScale('res2_cv', 'linear');
    expectScale('color_cv', 'linear');
    expectScale('mix_mode_cv', 'discrete');
  });
});

describe('bladesMath math helpers', () => {
  it('cutoffHz: knob alone → knob (no voct / cv)', () => {
    expect(bladesMath.cutoffHz(1000, 0, 0, SR)).toBeCloseTo(1000, 6);
    expect(bladesMath.cutoffHz(440,  0, 0, SR)).toBeCloseTo(440,  6);
  });

  it('cutoffHz: voct=+1 doubles the cutoff (1 V/oct)', () => {
    expect(bladesMath.cutoffHz(440, 1, 0, SR)).toBeCloseTo(880, 6);
    expect(bladesMath.cutoffHz(440, -1, 0, SR)).toBeCloseTo(220, 6);
  });

  it('cutoffHz: cv*5 octave scaling (cv=+0.2 → +1 octave)', () => {
    expect(bladesMath.cutoffHz(440, 0, 0.2, SR)).toBeCloseTo(880, 4);
    expect(bladesMath.cutoffHz(440, 0, -0.2, SR)).toBeCloseTo(220, 4);
  });

  it('cutoffHz: clamps to (10, 0.49*sr) for safety', () => {
    expect(bladesMath.cutoffHz(50000, 10, 10, SR)).toBeLessThanOrEqual(SR * 0.49);
    expect(bladesMath.cutoffHz(0.001, -10, -10, SR)).toBeGreaterThanOrEqual(10);
  });

  it('resToK: res=0 → k=2 (zero feedback), res=1 → k=0.003 (near self-osc)', () => {
    expect(bladesMath.resToK(0)).toBeCloseTo(2, 6);
    expect(bladesMath.resToK(1)).toBeCloseTo(0.003, 6);
    expect(bladesMath.resToK(0.5)).toBeCloseTo(1, 6);
  });

  it('colorDrive: 0 → 1, 1 → 10, linear', () => {
    expect(bladesMath.colorDrive(0)).toBe(1);
    expect(bladesMath.colorDrive(0.5)).toBeCloseTo(5.5, 6);
    expect(bladesMath.colorDrive(1)).toBe(10);
  });

  it('applyColor: color=0 is the identity', () => {
    for (const x of [-1, -0.4, 0, 0.4, 1]) {
      expect(bladesMath.applyColor(x, 0)).toBe(x);
    }
  });

  it('applyColor: color>0 saturates — |output| < |drive*input| past the knee', () => {
    // x*drive = 5; tanh(5) ≈ 0.999. Without tanh you'd get 5.
    const y = bladesMath.applyColor(0.5, 1);  // drive=10
    expect(Math.abs(y)).toBeLessThan(1);
    expect(Math.abs(y)).toBeGreaterThan(0.9);
  });
});

describe('bladesMath.render — per-mode frequency response shape', () => {
  // Drive a sweep of sine inputs through each mode and confirm the
  // selected band has higher amplitude than the rejected bands.
  const FRAMES = SR / 2;  // 0.5 s — long enough to settle the SVF.

  function probeMode(mode: 0 | 1 | 2, sigHz: number, fcHz: number): number {
    const in1 = sineBuf(sigHz, FRAMES, SR);
    const { out1 } = bladesMath.render(in1, null, FRAMES, {
      cutoff1: fcHz, cutoff2: fcHz, res1: 0.3, res2: 0.3,
      mode1: mode, mode2: mode, color: 0, mixMode: 0, sr: SR,
    });
    // RMS over the settled tail (skip first 5 ms of impulse-ish startup).
    return rms(out1, Math.floor(SR * 0.05));
  }

  it('LP @ fc=1 kHz: passes 200 Hz, attenuates 8 kHz (~12 dB/oct slope)', () => {
    const fc = 1000;
    const pass = probeMode(0, 200, fc);
    const stop = probeMode(0, 8000, fc);
    expect(pass, `LP pass(200)=${pass} vs stop(8k)=${stop}`).toBeGreaterThan(stop * 4);
  });

  it('HP @ fc=1 kHz: passes 8 kHz, attenuates 200 Hz', () => {
    const fc = 1000;
    const pass = probeMode(2, 8000, fc);
    const stop = probeMode(2, 200,  fc);
    expect(pass, `HP pass(8k)=${pass} vs stop(200)=${stop}`).toBeGreaterThan(stop * 4);
  });

  it('BP @ fc=1 kHz: passes 1 kHz more than 100 Hz or 10 kHz', () => {
    const fc = 1000;
    const center = probeMode(1, 1000,  fc);
    const lowSide = probeMode(1, 100,   fc);
    const hiSide  = probeMode(1, 10000, fc);
    expect(center, `BP center=${center} vs low=${lowSide}`).toBeGreaterThan(lowSide * 1.5);
    expect(center, `BP center=${center} vs hi=${hiSide}`).toBeGreaterThan(hiSide * 1.5);
  });
});

describe('bladesMath.render — cutoff knob actually controls cutoff', () => {
  it('LP at fc=200 Hz attenuates a 2 kHz sine more than LP at fc=5 kHz', () => {
    const FRAMES = SR / 2;
    const sig = sineBuf(2000, FRAMES, SR);
    const lowFc = bladesMath.render(sig, null, FRAMES, {
      cutoff1: 200, cutoff2: 200, res1: 0.3, res2: 0.3,
      mode1: 0, mode2: 0, color: 0, mixMode: 0, sr: SR,
    });
    const hiFc = bladesMath.render(sig, null, FRAMES, {
      cutoff1: 5000, cutoff2: 200, res1: 0.3, res2: 0.3,
      mode1: 0, mode2: 0, color: 0, mixMode: 0, sr: SR,
    });
    const rmsLow = rms(lowFc.out1, Math.floor(SR * 0.05));
    const rmsHi  = rms(hiFc.out1,  Math.floor(SR * 0.05));
    expect(rmsHi, `fc=5k passes 2k freely (${rmsHi}); fc=200 attenuates (${rmsLow})`)
      .toBeGreaterThan(rmsLow * 5);
  });
});

describe('bladesMath.render — resonance produces a peak at fc', () => {
  it('high resonance (0.95) lifts the BP @ fc=1 kHz vs low res (0.1)', () => {
    const FRAMES = SR / 2;
    const fc = 1000;
    const sig = sineBuf(fc, FRAMES, SR, 0.2);
    const low = bladesMath.render(sig, null, FRAMES, {
      cutoff1: fc, cutoff2: fc, res1: 0.1, res2: 0.1,
      mode1: 1, mode2: 1, color: 0, mixMode: 0, sr: SR,
    });
    const hi = bladesMath.render(sig, null, FRAMES, {
      cutoff1: fc, cutoff2: fc, res1: 0.95, res2: 0.95,
      mode1: 1, mode2: 1, color: 0, mixMode: 0, sr: SR,
    });
    const rmsLow = rms(low.out1, Math.floor(SR * 0.1));
    const rmsHi  = rms(hi.out1,  Math.floor(SR * 0.1));
    expect(rmsHi, `hi-res RMS=${rmsHi} should clearly exceed low-res RMS=${rmsLow}`)
      .toBeGreaterThan(rmsLow * 2);
  });
});

describe('bladesMath.render — self-oscillation at top of resonance', () => {
  it('res=1 with silent input still produces a tone (self-osc onset)', () => {
    // An impulse on the silent input is enough to kick the SVF; we need
    // *some* nudge to get it going, since starting from all-zero state
    // gives all-zero output forever.
    const FRAMES = SR / 2;
    const sig = new Float32Array(FRAMES);
    sig[0] = 1;  // single-sample impulse
    const { out1 } = bladesMath.render(sig, null, FRAMES, {
      cutoff1: 440, cutoff2: 440, res1: 1.0, res2: 1.0,
      mode1: 1, mode2: 1, color: 0, mixMode: 0, sr: SR,
    });
    // Energy at the tail (after the impulse has decayed in a non-osc
    // filter) should still be substantial because the SVF is ringing.
    // With k=0.003 the ring decays slowly but audibly — orders of
    // magnitude above the res=0.1 reference.
    const tailRms = rms(out1, Math.floor(SR * 0.3), Math.floor(SR * 0.4));
    expect(tailRms, `self-osc tail RMS=${tailRms} should sustain`).toBeGreaterThan(0.005);
  });

  it('res=0.1 with the same impulse decays to silence', () => {
    const FRAMES = SR / 2;
    const sig = new Float32Array(FRAMES);
    sig[0] = 1;
    const { out1 } = bladesMath.render(sig, null, FRAMES, {
      cutoff1: 440, cutoff2: 440, res1: 0.1, res2: 0.1,
      mode1: 1, mode2: 1, color: 0, mixMode: 0, sr: SR,
    });
    const tailRms = rms(out1, Math.floor(SR * 0.3), Math.floor(SR * 0.4));
    expect(tailRms, `non-resonant tail should be near silent: ${tailRms}`)
      .toBeLessThan(0.001);
  });

  it('res=1 self-osc tail energy is ≥ 100× that of res=0.1 (clear resonance pole)', () => {
    const FRAMES = SR / 2;
    const sig = new Float32Array(FRAMES);
    sig[0] = 1;
    const hiRes = bladesMath.render(sig, null, FRAMES, {
      cutoff1: 440, cutoff2: 440, res1: 1.0, res2: 1.0,
      mode1: 1, mode2: 1, color: 0, mixMode: 0, sr: SR,
    });
    const loRes = bladesMath.render(sig, null, FRAMES, {
      cutoff1: 440, cutoff2: 440, res1: 0.1, res2: 0.1,
      mode1: 1, mode2: 1, color: 0, mixMode: 0, sr: SR,
    });
    const hi = rms(hiRes.out1, Math.floor(SR * 0.3), Math.floor(SR * 0.4));
    const lo = rms(loRes.out1, Math.floor(SR * 0.3), Math.floor(SR * 0.4));
    expect(hi, `hi-res RMS ${hi} should be ≥100× lo-res RMS ${lo}`).toBeGreaterThan(lo * 100);
  });
});

describe('bladesMath.render — mix bus mode toggle', () => {
  it('PARALLEL mix differs from SERIAL mix when both filters are active', () => {
    const FRAMES = SR / 2;
    const sig1 = sineBuf(440, FRAMES, SR);
    const sig2 = sineBuf(880, FRAMES, SR);
    const par = bladesMath.render(sig1, sig2, FRAMES, {
      cutoff1: 1000, cutoff2: 1000, res1: 0.3, res2: 0.3,
      mode1: 0, mode2: 0, color: 0, mixMode: 0, sr: SR,
    });
    const ser = bladesMath.render(sig1, sig2, FRAMES, {
      cutoff1: 1000, cutoff2: 1000, res1: 0.3, res2: 0.3,
      mode1: 0, mode2: 0, color: 0, mixMode: 1, sr: SR,
    });
    // SERIAL ignores in2 on the mix bus; PARALLEL sums both. So an
    // 880 Hz signal should be visible in PARALLEL mix and not in SERIAL.
    const ampPar = bandAmp(par.mix, 880, SR);
    const ampSer = bandAmp(ser.mix, 880, SR);
    expect(ampPar, `parallel mix has 880 Hz energy: ${ampPar}`).toBeGreaterThan(0.05);
    expect(ampSer, `serial mix lacks 880 Hz (in2 ignored): ${ampSer}`).toBeLessThan(ampPar * 0.5);
  });

  it('out1 and out2 are independent of mix-mode (direct outs unchanged)', () => {
    const FRAMES = SR / 2;
    const sig1 = sineBuf(440, FRAMES, SR);
    const sig2 = sineBuf(880, FRAMES, SR);
    const par = bladesMath.render(sig1, sig2, FRAMES, {
      cutoff1: 1000, cutoff2: 1000, res1: 0.3, res2: 0.3,
      mode1: 0, mode2: 0, color: 0, mixMode: 0, sr: SR,
    });
    const ser = bladesMath.render(sig1, sig2, FRAMES, {
      cutoff1: 1000, cutoff2: 1000, res1: 0.3, res2: 0.3,
      mode1: 0, mode2: 0, color: 0, mixMode: 1, sr: SR,
    });
    // out1 / out2 should be bit-identical regardless of mixMode.
    for (let i = SR / 10; i < FRAMES; i += 1000) {
      expect(par.out1[i]).toBeCloseTo(ser.out1[i]!, 10);
      expect(par.out2[i]).toBeCloseTo(ser.out2[i]!, 10);
    }
  });
});

describe('bladesMath.render — COLOR overdrive enriches the signal', () => {
  it('COLOR=0 on a sine produces only the fundamental (no harmonics)', () => {
    // Pure-sine in → linear filter → pure-sine out. The 2nd harmonic
    // should be near zero if there's no distortion path active.
    const FRAMES = SR / 2;
    const sig = sineBuf(440, FRAMES, SR, 0.5);
    const { out1 } = bladesMath.render(sig, null, FRAMES, {
      cutoff1: 5000, cutoff2: 5000, res1: 0.1, res2: 0.1,
      mode1: 0, mode2: 0, color: 0, mixMode: 0, sr: SR,
    });
    const tail = out1.slice(Math.floor(SR * 0.1));
    const a1 = bandAmp(tail, 440, SR);
    const a2 = bandAmp(tail, 880, SR);
    expect(a1, `fund @ 440: ${a1}`).toBeGreaterThan(0.1);
    expect(a2, `2nd harm @ 880: ${a2}`).toBeLessThan(a1 * 0.05);
  });

  it('COLOR=1 on a sine adds harmonic content (tanh distortion)', () => {
    const FRAMES = SR / 2;
    const sig = sineBuf(440, FRAMES, SR, 0.8);
    const { out1 } = bladesMath.render(sig, null, FRAMES, {
      cutoff1: 8000, cutoff2: 8000, res1: 0.1, res2: 0.1,
      mode1: 0, mode2: 0, color: 1, mixMode: 0, sr: SR,
    });
    const tail = out1.slice(Math.floor(SR * 0.1));
    const a3 = bandAmp(tail, 1320, SR);  // 3rd harmonic
    // tanh of a hot signal is odd-symmetric; odd harmonics rise sharply.
    // Filter is at 8k so 1.3k passes unattenuated. Expect a clear 3rd.
    expect(a3, `3rd harm @ 1320 (COLOR=1): ${a3}`).toBeGreaterThan(0.02);
  });
});
