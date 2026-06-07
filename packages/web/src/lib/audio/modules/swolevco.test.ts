// packages/web/src/lib/audio/modules/swolevco.test.ts
//
// Unit tests for SWOLEVCO def shape + the pure helpers (symmetry crossfade,
// V/oct → Hz LUT, tune+fine → Hz). DSP rendering goes through the ART
// harness in art/scenarios/swolevco/.

import { describe, expect, it } from 'vitest';
import {
  swolevcoDef,
  symmetryGains,
  buildVoctCurve,
  tuneFineToHz,
} from './swolevco';

describe('swolevcoDef: module-def shape', () => {
  it('declares type=swolevco, label=SWOLEVCO, category=sources', () => {
    expect(swolevcoDef.type).toBe('swolevco');
    expect(swolevcoDef.label).toBe('swolevco');
    expect(swolevcoDef.category).toBe('sources');
  });

  it('exposes 7 input ports (pitch, mod_pitch, fm + 4 cv)', () => {
    const ids = swolevcoDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(
      ['pitch', 'mod_pitch', 'fm', 'timbre', 'symmetry', 'fold', 'ratio'].sort(),
    );
  });

  it('exposes 4 output ports (out, mod_out, sum_out, scope)', () => {
    const ids = swolevcoDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['mod_out', 'out', 'scope', 'sum_out']);
  });

  it('scope output is mono-video (matches the WAVVIZ pattern)', () => {
    const scope = swolevcoDef.outputs.find((p) => p.id === 'scope');
    expect(scope).toBeDefined();
    expect(scope?.type).toBe('mono-video');
  });

  it('declares 8 params with sensible defaults', () => {
    const ids = swolevcoDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(
      ['fine', 'fold', 'mod_fine', 'mod_tune', 'ratio', 'symmetry', 'timbre', 'tune'].sort(),
    );
    const ratio = swolevcoDef.params.find((p) => p.id === 'ratio');
    expect(ratio?.defaultValue).toBe(1.0); // unison default
    const symmetry = swolevcoDef.params.find((p) => p.id === 'symmetry');
    expect(symmetry?.defaultValue).toBe(0.5); // triangle midpoint
    const fold = swolevcoDef.params.find((p) => p.id === 'fold');
    expect(fold?.defaultValue).toBe(0); // bypass by default
  });

  it('CV inputs declare paramTarget so the engine routes to AudioParam', () => {
    const cvInputs = swolevcoDef.inputs.filter((p) => p.type === 'cv');
    for (const p of cvInputs) {
      expect(p.paramTarget, `${p.id} has paramTarget`).toBeDefined();
      // Convention: the paramTarget id matches the port id.
      expect(p.paramTarget).toBe(p.id);
    }
  });
});

describe('SWOLEVCO helpers: symmetryGains', () => {
  it('symmetry=0 → saw only', () => {
    const g = symmetryGains(0);
    expect(g.saw).toBe(1);
    expect(g.triangle).toBe(0);
    expect(g.square).toBe(0);
  });

  it('symmetry=0.5 → triangle only', () => {
    const g = symmetryGains(0.5);
    expect(g.saw).toBe(0);
    expect(g.triangle).toBe(1);
    expect(g.square).toBe(0);
  });

  it('symmetry=1 → square only', () => {
    const g = symmetryGains(1);
    expect(g.saw).toBe(0);
    expect(g.triangle).toBe(0);
    expect(g.square).toBe(1);
  });

  it('saw + triangle blend at symmetry=0.25 (50/50)', () => {
    const g = symmetryGains(0.25);
    expect(g.saw).toBeCloseTo(0.5, 6);
    expect(g.triangle).toBeCloseTo(0.5, 6);
    expect(g.square).toBe(0);
  });

  it('triangle + square blend at symmetry=0.75 (50/50)', () => {
    const g = symmetryGains(0.75);
    expect(g.saw).toBe(0);
    expect(g.triangle).toBeCloseTo(0.5, 6);
    expect(g.square).toBeCloseTo(0.5, 6);
  });

  it('clamps inputs outside [0, 1] to nearest endpoint', () => {
    expect(symmetryGains(-0.5)).toEqual({ saw: 1, triangle: 0, square: 0 });
    expect(symmetryGains(1.5)).toEqual({ saw: 0, triangle: 0, square: 1 });
  });

  it('gains always sum to 1 across the sweep (energy preservation)', () => {
    for (let i = 0; i <= 20; i++) {
      const s = i / 20;
      const g = symmetryGains(s);
      expect(g.saw + g.triangle + g.square).toBeCloseTo(1, 6);
    }
  });
});

describe('SWOLEVCO helpers: tuneFineToHz', () => {
  it('tune=0, fine=0 → C4 = 261.626 Hz', () => {
    expect(tuneFineToHz(0, 0)).toBeCloseTo(261.626, 3);
  });

  it('tune=12 → C5 = 523.252 Hz (one octave up)', () => {
    expect(tuneFineToHz(12, 0)).toBeCloseTo(523.252, 3);
  });

  it('tune=-12 → C3 = 130.813 Hz (one octave down)', () => {
    expect(tuneFineToHz(-12, 0)).toBeCloseTo(130.813, 3);
  });

  it('fine=100 cents = 1 semitone shift', () => {
    expect(tuneFineToHz(0, 100)).toBeCloseTo(tuneFineToHz(1, 0), 3);
  });
});

describe('SWOLEVCO helpers: buildVoctCurve', () => {
  it('curve is centered at 0V → 0 Hz delta', () => {
    const baseHz = 261.626;
    const curve = buildVoctCurve(baseHz);
    // Center index → V=0 (within rounding for even-length arrays, the
    // exact midpoint maps to v ≈ 0).
    const mid = Math.floor(curve.length / 2);
    // v at mid = (mid/(N-1))*2*5 - 5; for N=4096, mid=2048 → v=0.00122
    // → 261.626 * (2^0.00122 - 1) ≈ 261.626 * 0.000847 ≈ 0.222 Hz.
    // We assert the curve crosses zero AROUND the midpoint.
    expect(Math.abs(curve[mid]!)).toBeLessThan(0.5);
  });

  it('curve at +1V LUT index ≈ +baseHz Hz delta (one octave up)', () => {
    const baseHz = 261.626;
    const curve = buildVoctCurve(baseHz);
    // Find index where v == 1V. v = (i/(N-1))*10 - 5 → i = (N-1) * 0.6.
    const N = curve.length;
    const i = Math.round((N - 1) * 0.6);
    // Sanity: at v=+1V, output = baseHz × (2^1 - 1) = baseHz.
    expect(curve[i]!).toBeCloseTo(baseHz, 0);
  });

  it('curve at -1V LUT index ≈ -baseHz/2 Hz delta (one octave down)', () => {
    const baseHz = 261.626;
    const curve = buildVoctCurve(baseHz);
    const N = curve.length;
    // v = -1 → i = (N-1) × ((−1+5)/10) = (N-1) × 0.4.
    const i = Math.round((N - 1) * 0.4);
    // baseHz × (2^-1 - 1) = baseHz × -0.5.
    expect(curve[i]!).toBeCloseTo(-baseHz / 2, 0);
  });

  it('curve length is the documented LUT size (4096)', () => {
    const curve = buildVoctCurve(261.626);
    expect(curve.length).toBe(4096);
  });
});
