// packages/web/src/lib/audio/modules/marbles.test.ts
//
// Unit tests for the MARBLES DSP core (host mirror). Table-driven where it
// helps: gate-generation determinism, déjà-vu loop locking, and the
// weighted-scale quantizer snapping.

import { describe, it, expect } from 'vitest';
import { marblesDef, marblesMath, MARBLES_T_MODEL_NAMES, type MarblesParams } from './marbles';
import { Quantizer, PRESET_SCALES, RandomStream, RandomSequence } from './marbles-engine';

const SR = 32000;

function baseParams(overrides: Partial<MarblesParams> = {}): MarblesParams {
  return {
    rate: 24, // fast clock so gates fire within the render window
    t_model: 0,
    t_bias: 0.5,
    t_jitter: 0,
    deja_vu: 0,
    length: 8,
    pw_mean: 0.5,
    spread: 0.5,
    x_bias: 0.5,
    steps: 1, // full quantization (no portamento)
    x_deja_vu: 0,
    x_length: 8,
    scale: 0,
    ...overrides,
  };
}

describe('marblesDef registry shape', () => {
  it('declares the t1/t2 gate + x1/x2/x3 cv + clk outputs', () => {
    const ids = marblesDef.outputs.map((o) => o.id);
    expect(ids).toEqual(['t1', 't2', 'x1', 'x2', 'x3', 'clk']);
    expect(marblesDef.ossAttribution?.author).toBe('Émilie Gillet');
  });
  it('every CV input carries a cvScale hint', () => {
    for (const i of marblesDef.inputs) {
      expect(i.cvScale, `${i.id} cvScale`).toBeTruthy();
    }
  });
  it('exposes 6 T-model names', () => {
    expect(MARBLES_T_MODEL_NAMES.length).toBe(6);
  });
});

describe('gate generation determinism', () => {
  it('identical params produce identical gate streams (seeded RNG)', () => {
    const a = marblesMath.render(2000, SR, baseParams());
    const b = marblesMath.render(2000, SR, baseParams());
    expect(Array.from(a.t1)).toEqual(Array.from(b.t1));
    expect(Array.from(a.t2)).toEqual(Array.from(b.t2));
    expect(Array.from(a.x1)).toEqual(Array.from(b.x1));
  });

  it('produces at least one gate-high sample on both T channels', () => {
    const r = marblesMath.render(8000, SR, baseParams({ rate: 36 }));
    expect(r.t1.some((v) => v > 0.5)).toBe(true);
    expect(r.t2.some((v) => v > 0.5)).toBe(true);
  });

  it('emits a master clock that toggles (clk goes both high and low)', () => {
    const r = marblesMath.render(4000, SR, baseParams({ rate: 24 }));
    expect(r.clk.some((v) => v > 0.5)).toBe(true);
    expect(r.clk.some((v) => v < 0.5)).toBe(true);
  });

  it.each(MARBLES_T_MODEL_NAMES.map((name, i) => [name, i] as const))(
    'T model %s renders without NaN',
    (_name, idx) => {
      const r = marblesMath.render(2000, SR, baseParams({ t_model: idx, rate: 36 }));
      expect(r.t1.every((v) => Number.isFinite(v))).toBe(true);
      expect(r.x1.every((v) => Number.isFinite(v))).toBe(true);
    },
  );
});

describe('déjà-vu loop locking (RandomSequence)', () => {
  it('deja_vu = 1 (fully locked) draws only from the existing loop buffer', () => {
    // At deja_vu = 1, p = (2*1-1)^2 = 1 so mutate is always true; since
    // deja_vu > 0.5 the firmware jumps to a *random step within the loop*
    // rather than writing new values — so every draw is one of the loop's
    // pre-seeded values (no fresh RNG voltages enter the stream).
    const stream = new RandomStream(0xabcdef);
    const seq = new RandomSequence(stream);
    seq.setLength(16);
    // Snapshot the loop buffer by reading the free-running stream first would
    // disturb state; instead, lock and collect — all draws must repeat from a
    // small finite set (the 16-slot loop), never an ever-growing distinct set.
    seq.setDejaVu(1.0);
    const vals: number[] = [];
    for (let i = 0; i < 200; i++) vals.push(seq.nextValue(false, 0));
    const distinct = new Set(vals.map((v) => v.toFixed(6)));
    // A locked loop can yield at most `length` distinct values.
    expect(distinct.size).toBeLessThanOrEqual(16);
  });

  it('deja_vu = 0 (free) tends to produce a non-constant stream', () => {
    const stream = new RandomStream(0x13572468);
    const seq = new RandomSequence(stream);
    seq.setLength(8);
    seq.setDejaVu(0);
    const vals: number[] = [];
    for (let i = 0; i < 32; i++) vals.push(seq.nextValue(false, 0));
    const distinct = new Set(vals.map((v) => v.toFixed(4)));
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe('quantizer / scale snapping', () => {
  it('snaps an arbitrary voltage onto a C-major degree (amount = 1)', () => {
    const q = new Quantizer();
    q.init(PRESET_SCALES[0]!); // C major
    // 0.20 V is between D (0.1667) and D# (0.25); D# has low weight so at high
    // resolution it still snaps to a degree present in the scale's top levels.
    const out = q.process(0.2, 1.0, false);
    // Result must be one of the scale's degree voltages (mod octave).
    const degrees = PRESET_SCALES[0]!.degree.map((d) => d.voltage);
    const frac = out - Math.floor(out);
    const matches = degrees.some((d) => Math.abs(frac - d) < 1e-3 || Math.abs(frac - d) > 0.999);
    expect(matches).toBe(true);
  });

  it('amount = 0 passes the voltage through unquantized', () => {
    const q = new Quantizer();
    q.init(PRESET_SCALES[0]!);
    expect(q.process(0.37, 0, false)).toBeCloseTo(0.37, 6);
  });

  it('snaps near-zero to the root (C = 0V) on every preset scale', () => {
    for (const scale of PRESET_SCALES) {
      const q = new Quantizer();
      q.init(scale);
      const out = q.process(0.02, 1.0, false);
      expect(Math.abs(out)).toBeLessThan(0.1);
    }
  });
});

describe('SPREAD shapes the X output distribution', () => {
  it('spread = 0 yields a near-constant (degenerate) X1 voltage', () => {
    const r = marblesMath.render(4000, SR, baseParams({ spread: 0, steps: 0, x_bias: 0.5, rate: 24 }));
    // Degenerate distribution → all draws collapse to bias → low variance.
    const vals = Array.from(r.x1);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    expect(variance).toBeLessThan(0.05);
  });
});
