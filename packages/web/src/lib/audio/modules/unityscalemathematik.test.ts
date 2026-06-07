// packages/web/src/lib/audio/modules/unityscalemathematik.test.ts
//
// Unit tests for UNITYSCALEMATHEMATIK's pure math + module-def shape.
// Worklet rendering is exercised by the ART harness.

import { describe, expect, it } from 'vitest';
import { unityscalemathematikDef, unityScaleMath } from './unityscalemathematik';

describe('unityScaleMath: unity attenuvert', () => {
  it('atten=+1 passes input through unchanged', () => {
    for (const x of [-0.9, -0.3, 0, 0.25, 0.5, 1.0]) {
      expect(unityScaleMath.unity(x, 1)).toBeCloseTo(x, 12);
    }
  });

  it('atten=-1 inverts the input', () => {
    expect(unityScaleMath.unity(0.7, -1)).toBeCloseTo(-0.7, 12);
    expect(unityScaleMath.unity(-0.3, -1)).toBeCloseTo(0.3, 12);
  });

  it('atten=0 mutes any input', () => {
    expect(Math.abs(unityScaleMath.unity(0.7, 0))).toBe(0);
    expect(Math.abs(unityScaleMath.unity(-0.3, 0))).toBe(0);
  });

  it('atten=0.5 halves the input', () => {
    expect(unityScaleMath.unity(1.0, 0.5)).toBeCloseTo(0.5, 12);
    expect(unityScaleMath.unity(-0.4, 0.5)).toBeCloseTo(-0.2, 12);
  });
});

describe('unityScaleMath: curveToK', () => {
  it('curve=0 -> k=1 (linear)', () => {
    expect(unityScaleMath.curveToK(0)).toBe(1);
  });

  it('curve=1 -> k=3 (steep expo)', () => {
    expect(unityScaleMath.curveToK(1)).toBe(3);
  });

  it('curve=0.5 -> k=2 (square)', () => {
    expect(unityScaleMath.curveToK(0.5)).toBe(2);
  });

  it('clamps out-of-range curve values', () => {
    expect(unityScaleMath.curveToK(-1)).toBe(1);
    expect(unityScaleMath.curveToK(2)).toBe(3);
  });
});

describe('unityScaleMath: shape (linear curve)', () => {
  it('linear (curve=0) at atten=1 is identity for several samples', () => {
    for (const x of [-0.9, -0.5, -0.1, 0, 0.1, 0.5, 0.9]) {
      expect(unityScaleMath.shape(x, 1, 0)).toBeCloseTo(x, 12);
    }
  });

  it('linear (curve=0) with atten=-0.5 halves and inverts', () => {
    expect(unityScaleMath.shape(1.0, -0.5, 0)).toBeCloseTo(-0.5, 12);
    expect(unityScaleMath.shape(-0.4, -0.5, 0)).toBeCloseTo(0.2, 12);
  });
});

describe('unityScaleMath: shape (expo curve)', () => {
  it('curve=1 (k=3) at atten=1 matches |x|^3 with sign preserved', () => {
    expect(unityScaleMath.shape(0.5, 1, 1)).toBeCloseTo(0.125, 12);
    expect(unityScaleMath.shape(0.8, 1, 1)).toBeCloseTo(0.512, 12);
    expect(unityScaleMath.shape(1.0, 1, 1)).toBeCloseTo(1.0, 12);
    expect(unityScaleMath.shape(0, 1, 1)).toBe(0);
  });

  it('curve=0.5 (k=2) at atten=1 squares magnitude with sign preserved', () => {
    expect(unityScaleMath.shape(0.5,  1, 0.5)).toBeCloseTo(0.25, 12);
    expect(unityScaleMath.shape(-0.5, 1, 0.5)).toBeCloseTo(-0.25, 12);
    expect(unityScaleMath.shape(0.3,  1, 0.5)).toBeCloseTo(0.09, 12);
  });
});

describe('unityScaleMath: bipolar sign preservation', () => {
  it('negative input gives negative output through any (curve, atten>0) pair', () => {
    for (const curve of [0, 0.25, 0.5, 0.75, 1]) {
      for (const x of [-0.9, -0.5, -0.1, -0.01]) {
        const y = unityScaleMath.shape(x, 1, curve);
        expect(y).toBeLessThan(0);
      }
    }
  });

  it('a -0.5 input on curve=1.0 stays negative (smaller magnitude, not flipped)', () => {
    const y = unityScaleMath.shape(-0.5, 1, 1);
    expect(y).toBeLessThan(0);
    expect(y).toBeCloseTo(-0.125, 12);
    expect(Math.abs(y)).toBeLessThan(Math.abs(-0.5));
  });

  it('atten=-1 with curve=1 inverts the sign of the shaped magnitude', () => {
    expect(unityScaleMath.shape(0.5, -1, 1)).toBeCloseTo(-0.125, 12);
    expect(unityScaleMath.shape(-0.5, -1, 1)).toBeCloseTo(0.125, 12);
  });
});

describe('unityscalemathematikDef: module-def shape', () => {
  it('declares type=unityscalemathematik, label=UNITYSCALEMATHEMATIK, category=utilities', () => {
    expect(unityscalemathematikDef.type).toBe('unityscalemathematik');
    expect(unityscalemathematikDef.label).toBe('unityscalemathematik');
    expect(unityscalemathematikDef.category).toBe('utilities');
    expect(unityscalemathematikDef.domain).toBe('audio');
  });

  it('exposes 8 cv inputs', () => {
    const ids = unityscalemathematikDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'a_atten_cv', 'a_curve_cv', 'a_in',
      'b_atten_cv', 'b_curve_cv', 'b_in',
      'u_atten_cv', 'u_in',
    ]);
    for (const p of unityscalemathematikDef.inputs) {
      expect(p.type).toBe('cv');
    }
  });

  it('exposes 3 cv outputs (u_out, a_out, b_out)', () => {
    const ids = unityscalemathematikDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['a_out', 'b_out', 'u_out']);
    for (const p of unityscalemathematikDef.outputs) {
      expect(p.type).toBe('cv');
    }
  });

  it('cv-on-param inputs declare paramTarget + linear cvScale', () => {
    const cvParams = ['u_atten_cv', 'a_atten_cv', 'a_curve_cv', 'b_atten_cv', 'b_curve_cv'];
    for (const id of cvParams) {
      const port = unityscalemathematikDef.inputs.find((p) => p.id === id);
      expect(port, id).toBeDefined();
      expect(port?.paramTarget, `${id} paramTarget`).toBeDefined();
      expect(port?.cvScale?.mode, `${id} cvScale.mode`).toBe('linear');
    }
  });

  it('signal inputs (u_in, a_in, b_in) carry no paramTarget', () => {
    for (const id of ['u_in', 'a_in', 'b_in']) {
      const port = unityscalemathematikDef.inputs.find((p) => p.id === id);
      expect(port?.paramTarget, `${id} paramTarget`).toBeUndefined();
      expect(port?.cvScale, `${id} cvScale`).toBeUndefined();
    }
  });

  it('exposes 5 params with bipolar attenuverters and unipolar curves', () => {
    const ids = unityscalemathematikDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['aAtten', 'aCurve', 'bAtten', 'bCurve', 'unityAtten']);

    for (const id of ['unityAtten', 'aAtten', 'bAtten']) {
      const p = unityscalemathematikDef.params.find((q) => q.id === id);
      expect(p?.min, `${id} min`).toBe(-1);
      expect(p?.max, `${id} max`).toBe(1);
      expect(p?.defaultValue, `${id} default`).toBe(1);
    }
    for (const id of ['aCurve', 'bCurve']) {
      const p = unityscalemathematikDef.params.find((q) => q.id === id);
      expect(p?.min, `${id} min`).toBe(0);
      expect(p?.max, `${id} max`).toBe(1);
      expect(p?.defaultValue, `${id} default`).toBe(0);
    }
  });
});
