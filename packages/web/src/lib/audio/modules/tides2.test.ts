// packages/web/src/lib/audio/modules/tides2.test.ts
//
// Unit tests for TIDES2 — tidal modulator / poly-slope generator.
// Table-driven coverage of: slope / shape morphing, the 4 OUTPUT-MODE
// relationships, V/oct frequency tracking, and AD / AR / LOOPING envelope
// shapes. Worklet-level integration is left to the ART layer.

import { describe, expect, it } from 'vitest';
import {
  tides2Def,
  tides2Math,
  shapeMorph,
  fold,
  freqKnobToIncrement,
  PolySlopeGenerator,
  RampExtractor,
  TIDES2_NUM_CHANNELS,
  RAMP_MODE_AD,
  RAMP_MODE_LOOPING,
  RAMP_MODE_AR,
  OUTPUT_MODE_GATES,
  OUTPUT_MODE_AMPLITUDE,
  OUTPUT_MODE_SLOPE_PHASE,
  OUTPUT_MODE_FREQUENCY,
  RANGE_CONTROL,
  RANGE_AUDIO,
  type Tides2Params,
} from './tides2';

const SR = 48000;

function baseParams(overrides: Partial<Tides2Params> = {}): Tides2Params {
  return {
    frequency: 0.5,
    voct: 0,
    shape: 0.5,
    slope: 0.5,
    smoothness: 0.5,
    shift: 0.5,
    rampMode: RAMP_MODE_AD,
    outputMode: OUTPUT_MODE_SLOPE_PHASE,
    range: RANGE_CONTROL,
    ...overrides,
  };
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / Math.max(1, buf.length));
}

// Count phase wraps (rising-edge zero-crossings of a unipolar-ish ramp) to
// estimate cycle frequency.
function countCycles(buf: Float32Array): number {
  let cycles = 0;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i]! < buf[i - 1]! - 0.3) cycles++; // a downward jump = wrap
  }
  return cycles;
}

describe('tides2Def shape', () => {
  it('declares type/label/category/attribution', () => {
    expect(tides2Def.type).toBe('tides2');
    expect(tides2Def.label).toBe('TIDES2');
    expect(tides2Def.category).toBe('modulation');
    expect(tides2Def.ossAttribution?.author).toBe('Émilie Gillet');
  });

  it('exposes 4 outputs (the four related slopes)', () => {
    expect(tides2Def.outputs.map((o) => o.id)).toEqual(['out0', 'out1', 'out2', 'out3']);
  });

  it('exposes V/oct + trig + clock inputs and the 5 CV fast-paths', () => {
    const ids = tides2Def.inputs.map((i) => i.id);
    expect(ids).toContain('voct');
    expect(ids).toContain('trig');
    expect(ids).toContain('clock');
    for (const cv of ['freq_cv', 'shape_cv', 'slope_cv', 'smooth_cv', 'shift_cv']) {
      expect(ids).toContain(cv);
    }
  });

  it('every CV fast-path carries a linear cvScale + valid paramTarget', () => {
    for (const id of ['freq_cv', 'shape_cv', 'slope_cv', 'smooth_cv', 'shift_cv']) {
      const port = tides2Def.inputs.find((i) => i.id === id)!;
      expect(port.cvScale?.mode).toBe('linear');
      expect(tides2Def.params.find((p) => p.id === port.paramTarget)).toBeDefined();
    }
  });

  it('ships FREQ/SHAPE/SLOPE/SMOOTH/SHIFT knobs + 3 discrete mode params', () => {
    const ids = tides2Def.params.map((p) => p.id);
    expect(ids).toEqual([
      'frequency', 'shape', 'slope', 'smoothness', 'shift',
      'rampMode', 'outputMode', 'range',
    ]);
    for (const m of ['rampMode', 'outputMode', 'range']) {
      expect(tides2Def.params.find((p) => p.id === m)!.curve).toBe('discrete');
    }
  });
});

describe('shapeMorph', () => {
  it('starts at 0 for every integer shape', () => {
    for (let s = 0; s <= 5; s++) {
      expect(shapeMorph(0, s)).toBeCloseTo(0, 5);
    }
  });

  it('non-triangle shapes end at 1; the triangle (2) returns to 0', () => {
    for (const s of [0, 1, 3, 4, 5]) {
      expect(shapeMorph(1, s)).toBeCloseTo(1, 5);
    }
    expect(shapeMorph(1, 2)).toBeCloseTo(0, 5); // triangle folds back to 0
  });

  it('shape 0 is the identity ramp', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(shapeMorph(p, 0)).toBeCloseTo(p, 6);
    }
  });

  it('triangle shape (index 2) peaks at the midpoint', () => {
    expect(shapeMorph(0.5, 2)).toBeCloseTo(1, 5);
    expect(shapeMorph(0.25, 2)).toBeCloseTo(0.5, 5);
    expect(shapeMorph(0.75, 2)).toBeCloseTo(0.5, 5);
  });

  it('crossfades smoothly between adjacent shapes', () => {
    // Between linear (0) and S-curve (1) at p=0.25 the value is between the two.
    const lin = shapeMorph(0.25, 0);
    const scurve = shapeMorph(0.25, 1);
    const mid = shapeMorph(0.25, 0.5);
    expect(mid).toBeGreaterThan(Math.min(lin, scurve) - 1e-6);
    expect(mid).toBeLessThan(Math.max(lin, scurve) + 1e-6);
  });
});

describe('fold (wavefolder)', () => {
  it('fold=0 is the identity (unipolar)', () => {
    for (const u of [0, 0.3, 0.7, 1]) {
      expect(fold(u, 0, false)).toBeCloseTo(u, 6);
    }
  });

  it('fold=0 in loop mode maps unipolar→bipolar identity', () => {
    expect(fold(0, 0, true)).toBeCloseTo(-1, 6);
    expect(fold(0.5, 0, true)).toBeCloseTo(0, 6);
    expect(fold(1, 0, true)).toBeCloseTo(1, 6);
  });

  it('positive fold amount changes the output (adds harmonics)', () => {
    const plain = fold(0.8, 0, false);
    const folded = fold(0.8, 1, false);
    expect(folded).not.toBeCloseTo(plain, 3);
  });
});

describe('freqKnobToIncrement — V/oct tracking', () => {
  it('+1 octave doubles the frequency increment', () => {
    const f0 = freqKnobToIncrement(0.5, 0, RANGE_CONTROL, SR);
    const f1 = freqKnobToIncrement(0.5, 1, RANGE_CONTROL, SR);
    expect(f1 / f0).toBeCloseTo(2, 2);
  });

  it('-1 octave halves the frequency increment', () => {
    const f0 = freqKnobToIncrement(0.5, 0, RANGE_CONTROL, SR);
    const fm1 = freqKnobToIncrement(0.5, -1, RANGE_CONTROL, SR);
    expect(fm1 / f0).toBeCloseTo(0.5, 2);
  });

  it('AUDIO range sits well above the LFO/CONTROL range', () => {
    const lfo = freqKnobToIncrement(0.5, 0, RANGE_CONTROL, SR);
    const audio = freqKnobToIncrement(0.5, 0, RANGE_AUDIO, SR);
    expect(audio).toBeGreaterThan(lfo * 50);
  });

  it('never exceeds the 0.25 Nyquist-headroom clamp', () => {
    expect(freqKnobToIncrement(1, 5, RANGE_AUDIO, SR)).toBeLessThanOrEqual(0.25);
  });
});

describe('OUTPUT MODE relationships (the four related slopes)', () => {
  const N = 4000;

  it('PHASE: the four outs are progressively phase-shifted copies', () => {
    // LOOP + AUDIO range so all four channels cycle within the window; SHIFT
    // spreads the phase.
    const outs = tides2Math.render(N, SR, {
      params: baseParams({
        rampMode: RAMP_MODE_LOOPING,
        outputMode: OUTPUT_MODE_SLOPE_PHASE,
        range: RANGE_AUDIO,
        frequency: 0.4,
        shift: 0.9,
        smoothness: 0.7,
        shape: 0,
      }),
    });
    expect(outs.length).toBe(TIDES2_NUM_CHANNELS);
    // All four channels carry signal.
    for (let c = 0; c < 4; c++) expect(rms(outs[c]!)).toBeGreaterThan(0.01);
    // Channels 0 and 1 are not identical (phase offset present).
    let diff = 0;
    for (let i = 2000; i < 2100; i++) diff += Math.abs(outs[0]![i]! - outs[1]![i]!);
    expect(diff).toBeGreaterThan(0.1);
  });

  it('FREQUENCY: higher channels run at different cycle rates than ch0', () => {
    // SHIFT high → channels span a harmonic series, so ch3 cycles more often.
    const outs = tides2Math.render(N, SR, {
      params: baseParams({
        rampMode: RAMP_MODE_LOOPING,
        outputMode: OUTPUT_MODE_FREQUENCY,
        range: RANGE_AUDIO,
        frequency: 0.25,
        shift: 0.95, // toward the high-harmonic end
        smoothness: 0.7,
        shape: 0,
      }),
    });
    const c0 = countCycles(outs[0]!);
    const c3 = countCycles(outs[3]!);
    expect(c3).toBeGreaterThan(c0);
  });

  it('AMPLITUDE: SHIFT pans the gain window across the four channels', () => {
    // The pan window position is |shift_bipolar| * 5.1, so SHIFT=0.5 (center,
    // bipolar 0) sits OFF the channel grid (index 0, no channel) and SHIFT
    // near the extreme lands the window on channel 4. Compare a mid-ish
    // SHIFT against the extreme: the per-channel energy profile differs.
    const midShift = tides2Math.render(N, SR, {
      params: baseParams({
        rampMode: RAMP_MODE_LOOPING,
        outputMode: OUTPUT_MODE_AMPLITUDE,
        range: RANGE_AUDIO,
        frequency: 0.4,
        shift: 0.7,
        smoothness: 0.7,
      }),
    });
    const edgeShift = tides2Math.render(N, SR, {
      params: baseParams({
        rampMode: RAMP_MODE_LOOPING,
        outputMode: OUTPUT_MODE_AMPLITUDE,
        range: RANGE_AUDIO,
        frequency: 0.4,
        shift: 0.98,
        smoothness: 0.7,
      }),
    });
    const midProfile = midShift.map((b) => rms(b));
    const edgeProfile = edgeShift.map((b) => rms(b));
    // At least one channel must carry energy in each case (the window is on
    // the grid) and the distribution differs between the two SHIFT settings.
    expect(Math.max(...midProfile)).toBeGreaterThan(0.01);
    expect(Math.max(...edgeProfile)).toBeGreaterThan(0.01);
    let profileDiff = 0;
    for (let c = 0; c < 4; c++) profileDiff += Math.abs(midProfile[c]! - edgeProfile[c]!);
    expect(profileDiff).toBeGreaterThan(0.02);
  });

  it('GATES: out2 (EOA) and out3 (EOR) are pulse-shaped (bounded 0..8)', () => {
    const outs = tides2Math.render(N, SR, {
      params: baseParams({
        rampMode: RAMP_MODE_LOOPING,
        outputMode: OUTPUT_MODE_GATES,
        range: RANGE_AUDIO,
        frequency: 0.3,
        shift: 0.6,
        smoothness: 0.7, // >0.5 so no smoothing softens the gate edges
      }),
    });
    // EOA / EOR are scaled ×8 in the engine; they should reach toward 8 (high)
    // and return to 0 (low) — i.e. carry real pulse energy.
    expect(Math.max(...outs[2]!)).toBeGreaterThan(1);
    expect(Math.min(...outs[2]!)).toBeLessThanOrEqual(0.001);
    expect(Math.max(...outs[3]!)).toBeGreaterThan(1);
  });
});

describe('RAMP MODE envelope shapes', () => {
  it('AD: a trigger restarts the one-shot ramp and it does NOT free-run', () => {
    const N = 6000;
    // No trigger: AD is one-shot — once it reaches the top it holds, never
    // wrapping/cycling.
    const noTrig = tides2Math.render(N, SR, {
      params: baseParams({
        rampMode: RAMP_MODE_AD,
        outputMode: OUTPUT_MODE_SLOPE_PHASE,
        range: RANGE_AUDIO,
        frequency: 0.5,
        slope: 0.5,
        smoothness: 0.7,
        shape: 0,
      }),
    });
    expect(countCycles(noTrig[0]!)).toBe(0); // one-shot: no repeats

    // A trigger mid-buffer restarts the ramp and it rises to a high peak.
    const withTrig = tides2Math.render(N, SR, {
      params: baseParams({
        rampMode: RAMP_MODE_AD,
        outputMode: OUTPUT_MODE_SLOPE_PHASE,
        range: RANGE_AUDIO,
        frequency: 0.5,
        slope: 0.5,
        smoothness: 0.7,
        shape: 0,
      }),
      trigHigh: [3000],
    });
    const peakAfterTrig = Math.max(...withTrig[0]!.slice(3000));
    expect(peakAfterTrig).toBeGreaterThan(0.7);
    expect(countCycles(withTrig[0]!)).toBe(0); // still one-shot
  });

  it('AR: the held-gate region differs from the released region', () => {
    const N = 8000;
    const outs = tides2Math.render(N, SR, {
      params: baseParams({
        rampMode: RAMP_MODE_AR,
        outputMode: OUTPUT_MODE_SLOPE_PHASE,
        range: RANGE_AUDIO,
        frequency: 0.5,
        slope: 0.5,
        smoothness: 0.7,
        shape: 0,
      }),
      gateRanges: [[1000, 4000]],
    });
    const env = outs[0]!;
    const mean = (b: Float32Array, from: number, to: number) => {
      let s = 0; for (let i = from; i < to; i++) s += b[i]!; return s / (to - from);
    };
    const gatedMean = mean(env, 1500, 3500);
    const releasedMean = mean(env, 5000, 7000);
    // The gate state clearly changes the output level (AR responds to the gate).
    expect(Math.abs(gatedMean - releasedMean)).toBeGreaterThan(0.05);
  });

  it('LOOP: free-running, produces a sustained periodic signal', () => {
    const N = 8000;
    const outs = tides2Math.render(N, SR, {
      params: baseParams({
        rampMode: RAMP_MODE_LOOPING,
        outputMode: OUTPUT_MODE_SLOPE_PHASE,
        range: RANGE_AUDIO,
        frequency: 0.4,
        smoothness: 0.7,
        shape: 0,
      }),
    });
    // No trigger needed — it runs on its own. Energy in both halves.
    const first = rms(outs[0]!.slice(0, N / 2));
    const second = rms(outs[0]!.slice(N / 2));
    expect(first).toBeGreaterThan(0.05);
    expect(second).toBeGreaterThan(0.05);
    // It actually cycles (multiple wraps over the window).
    expect(countCycles(outs[0]!)).toBeGreaterThan(1);
  });

  it('LOOP frequency scales with the FREQ knob', () => {
    const N = 8000;
    const slow = tides2Math.render(N, SR, {
      params: baseParams({ rampMode: RAMP_MODE_LOOPING, range: RANGE_AUDIO, frequency: 0.3, smoothness: 0.7, shape: 0 }),
    });
    const fast = tides2Math.render(N, SR, {
      params: baseParams({ rampMode: RAMP_MODE_LOOPING, range: RANGE_AUDIO, frequency: 0.5, smoothness: 0.7, shape: 0 }),
    });
    expect(countCycles(fast[0]!)).toBeGreaterThan(countCycles(slow[0]!));
  });
});

describe('RampExtractor — external clock PLL', () => {
  it('locks onto a steady clock period and predicts its frequency', () => {
    const ext = new RampExtractor();
    ext.init(SR);
    const period = 480; // samples between edges → 100 Hz at 48k
    // Feed several periods of clock edges.
    for (let i = 0; i < period * 12; i++) {
      ext.process(i % period === 0 && i > 0);
    }
    const predicted = ext.predictedFrequency();
    // Predicted normalized frequency should be ≈ 1/period.
    expect(predicted).toBeCloseTo(1 / period, 3);
  });

  it('produces a phase ramp that wraps once per clock period', () => {
    const ext = new RampExtractor();
    ext.init(SR);
    const period = 240;
    // Warm up the predictor.
    for (let i = 0; i < period * 8; i++) ext.process(i % period === 0 && i > 0);
    // Now count wraps over a known span.
    let wraps = 0;
    let prev = ext.process(false);
    const span = period * 4;
    for (let i = 1; i < span; i++) {
      const rising = i % period === 0;
      const cur = ext.process(rising);
      if (cur < prev - 0.5) wraps++;
      prev = cur;
    }
    // Roughly 4 wraps over 4 periods (allow ±1 for edge alignment).
    expect(wraps).toBeGreaterThanOrEqual(3);
    expect(wraps).toBeLessThanOrEqual(5);
  });
});

describe('SMOOTHNESS', () => {
  it('low smoothness low-passes the output (less high-frequency energy)', () => {
    const N = 6000;
    const sharp = tides2Math.render(N, SR, {
      params: baseParams({ rampMode: RAMP_MODE_LOOPING, frequency: 0.6, smoothness: 0.5, shape: 0 }),
    });
    const smooth = tides2Math.render(N, SR, {
      params: baseParams({ rampMode: RAMP_MODE_LOOPING, frequency: 0.6, smoothness: 0.05, shape: 0 }),
    });
    // Sum of absolute sample-to-sample deltas = a crude "high-frequency
    // content" proxy. Smoothed output should be markedly lower.
    const tv = (b: Float32Array) => {
      let s = 0; for (let i = 1; i < b.length; i++) s += Math.abs(b[i]! - b[i - 1]!); return s;
    };
    expect(tv(smooth[0]!)).toBeLessThan(tv(sharp[0]!));
  });
});

describe('engine determinism', () => {
  it('two runs with identical params produce identical output', () => {
    const mk = () => tides2Math.render(2000, SR, {
      params: baseParams({ rampMode: RAMP_MODE_LOOPING, outputMode: OUTPUT_MODE_FREQUENCY, shift: 0.8 }),
    });
    const a = mk();
    const b = mk();
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < 2000; i++) expect(a[c]![i]).toBe(b[c]![i]);
    }
  });

  it('PolySlopeGenerator.render writes all four channels each call', () => {
    const eng = new PolySlopeGenerator(SR);
    const out = eng.render(baseParams({ rampMode: RAMP_MODE_LOOPING }), 0, 0, false);
    expect(out.length).toBe(TIDES2_NUM_CHANNELS);
    for (let c = 0; c < 4; c++) expect(Number.isFinite(out[c]!)).toBe(true);
  });
});
