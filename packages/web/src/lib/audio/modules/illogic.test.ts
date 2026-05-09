// packages/web/src/lib/audio/modules/illogic.test.ts
//
// Unit tests for ILLOGIC's pure-data math + module-def shape.
// Web Audio wiring is exercised by the ART scenarios (offline render).

import { describe, expect, it } from 'vitest';
import { illogicDef, illogicMath } from './illogic';

describe('illogicMath: per-channel attenuverter', () => {
  it('att=+1 is identity', () => {
    expect(illogicMath.atten(0.7, 1)).toBeCloseTo(0.7, 12);
    expect(illogicMath.atten(-0.3, 1)).toBeCloseTo(-0.3, 12);
  });

  it('att=0 mutes any input', () => {
    // Multiplying by 0 can produce -0 for negative inputs (IEEE 754); treat
    // ±0 as equivalent for the muting assertion.
    expect(Math.abs(illogicMath.atten(0.7, 0))).toBe(0);
    expect(Math.abs(illogicMath.atten(-0.3, 0))).toBe(0);
    expect(Math.abs(illogicMath.atten(1e9, 0))).toBe(0);
  });

  it('att=-1 sign-inverts the input', () => {
    expect(illogicMath.atten(0.7, -1)).toBeCloseTo(-0.7, 12);
    expect(illogicMath.atten(-0.3, -1)).toBeCloseTo(0.3, 12);
  });

  it('att=0.5 halves the input', () => {
    expect(illogicMath.atten(1.0, 0.5)).toBeCloseTo(0.5, 12);
    expect(illogicMath.atten(-0.4, 0.5)).toBeCloseTo(-0.2, 12);
  });
});

describe('illogicMath: math sums', () => {
  it('sum = post-attenuverter sum of all 4 channels', () => {
    // Caller computes attN = inN * gainN first, then sums.
    const a1 = illogicMath.atten(0.5, 1.0);   // 0.5
    const a2 = illogicMath.atten(0.5, -1.0);  // -0.5
    const a3 = illogicMath.atten(1.0, 0.5);   // 0.5
    const a4 = illogicMath.atten(0.0, 1.0);   // 0
    expect(a1 + a2 + a3 + a4).toBeCloseTo(0.5, 12);
  });

  it('diff = (att1 + att2) - (att3 + att4)', () => {
    const a1 = 0.4, a2 = 0.6, a3 = 0.3, a4 = 0.2;
    const diff = (a1 + a2) - (a3 + a4);
    expect(diff).toBeCloseTo(0.5, 12);
  });
});

describe('illogicMath: logic truth tables', () => {
  // Gate threshold = 0.5. We test inputs at "low" (0.0) and "high" (1.0)
  // for the four AND/NAND/OR truth-table cells, plus a couple of edge
  // values right around 0.5.

  it('AND(0,0)=0, AND(0,1)=0, AND(1,0)=0, AND(1,1)=1', () => {
    expect(illogicMath.and(0, 0)).toBe(0);
    expect(illogicMath.and(0, 1)).toBe(0);
    expect(illogicMath.and(1, 0)).toBe(0);
    expect(illogicMath.and(1, 1)).toBe(1);
  });

  it('NAND(0,0)=1, NAND(0,1)=1, NAND(1,0)=1, NAND(1,1)=0', () => {
    expect(illogicMath.nand(0, 0)).toBe(1);
    expect(illogicMath.nand(0, 1)).toBe(1);
    expect(illogicMath.nand(1, 0)).toBe(1);
    expect(illogicMath.nand(1, 1)).toBe(0);
  });

  it('OR(0,0)=0, OR(0,1)=1, OR(1,0)=1, OR(1,1)=1', () => {
    expect(illogicMath.or(0, 0)).toBe(0);
    expect(illogicMath.or(0, 1)).toBe(1);
    expect(illogicMath.or(1, 0)).toBe(1);
    expect(illogicMath.or(1, 1)).toBe(1);
  });

  it('NOT(0)=1, NOT(1)=0 (single-input NOT of in1)', () => {
    expect(illogicMath.not(0)).toBe(1);
    expect(illogicMath.not(1)).toBe(0);
  });

  it('threshold sits at 0.5 (inputs >= 0.5 register as high)', () => {
    expect(illogicMath.gate(0.4999)).toBe(0);
    expect(illogicMath.gate(0.5)).toBe(1);
    expect(illogicMath.gate(0.5001)).toBe(1);
    expect(illogicMath.and(0.5, 0.5)).toBe(1);
    expect(illogicMath.and(0.49, 0.51)).toBe(0);
    expect(illogicMath.or(0.49, 0.51)).toBe(1);
    expect(illogicMath.not(0.49)).toBe(1);
    expect(illogicMath.not(0.51)).toBe(0);
  });

  it('treats audio-style ±1 swings as gates after threshold', () => {
    // A square wave at +1 / -1 — the +1 crests register as gates, -1 troughs do not.
    expect(illogicMath.gate(+1)).toBe(1);
    expect(illogicMath.gate(-1)).toBe(0);
    expect(illogicMath.and(+1, +1)).toBe(1);
    expect(illogicMath.and(+1, -1)).toBe(0);
    expect(illogicMath.or(-1, -1)).toBe(0);
  });
});

describe('illogicDef: module-def shape', () => {
  it('declares type=illogic, label=ILLOGIC, category=utilities', () => {
    expect(illogicDef.type).toBe('illogic');
    expect(illogicDef.label).toBe('ILLOGIC');
    expect(illogicDef.category).toBe('utilities');
    expect(illogicDef.domain).toBe('audio');
  });

  it('exposes 4 cv inputs (in1..in4)', () => {
    const ids = illogicDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual(['in1', 'in2', 'in3', 'in4']);
    for (const p of illogicDef.inputs) {
      expect(p.type).toBe('cv');
    }
  });

  it('exposes 10 outputs: per-channel atts + sum/diff + and/nand/or/not', () => {
    const ids = illogicDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'and', 'att1', 'att2', 'att3', 'att4',
      'diff', 'nand', 'not', 'or', 'sum',
    ]);
    // The four logic outputs carry the 'gate' cable color so the patch panel
    // highlights them visually distinct from the cv math outs.
    const gateOuts = illogicDef.outputs.filter((p) => p.type === 'gate').map((p) => p.id).sort();
    expect(gateOuts).toEqual(['and', 'nand', 'not', 'or']);
  });

  it('exposes 4 attenuverter params, all bipolar (-1..+1) defaulting to +1', () => {
    const ids = illogicDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['att1_amount', 'att2_amount', 'att3_amount', 'att4_amount']);
    for (const p of illogicDef.params) {
      expect(p.min).toBe(-1);
      expect(p.max).toBe(1);
      expect(p.defaultValue).toBe(1);
      expect(p.curve).toBe('linear');
    }
  });
});
