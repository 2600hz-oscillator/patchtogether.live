// packages/web/src/lib/audio/dx7-banks.test.ts
//
// Sanity checks on the bundled bank: every patch is valid (6 ops, algorithm
// in 1..32, ratios > 0, etc.) and the documented "famous" patches all exist.

import { describe, it, expect } from 'vitest';
import { DX7_BUILTIN_BANK, findBuiltinPatch } from './dx7-banks';
import { dx7FixedHz, dx7Ratio } from './dx7-syx';

describe('DX7_BUILTIN_BANK', () => {
  it('ships at least the 9 documented patches', () => {
    expect(DX7_BUILTIN_BANK.length).toBeGreaterThanOrEqual(9);
  });

  it('every patch has a unique name', () => {
    const names = new Set<string>();
    for (const p of DX7_BUILTIN_BANK) {
      expect(names.has(p.name), `duplicate patch name: ${p.name}`).toBe(false);
      names.add(p.name);
    }
  });

  it('every patch has 6 operators', () => {
    for (const p of DX7_BUILTIN_BANK) {
      expect(p.operators, `${p.name}.operators`).toHaveLength(6);
    }
  });

  it('every patch has algorithm in 1..32', () => {
    for (const p of DX7_BUILTIN_BANK) {
      expect(p.algorithm, `${p.name}.algorithm`).toBeGreaterThanOrEqual(1);
      expect(p.algorithm, `${p.name}.algorithm`).toBeLessThanOrEqual(32);
    }
  });

  it('every patch has feedback in 0..7', () => {
    for (const p of DX7_BUILTIN_BANK) {
      expect(p.feedback, `${p.name}.feedback`).toBeGreaterThanOrEqual(0);
      expect(p.feedback, `${p.name}.feedback`).toBeLessThanOrEqual(7);
    }
  });

  it('every operator has 4 envelope rates and 4 levels', () => {
    for (const p of DX7_BUILTIN_BANK) {
      for (let i = 0; i < 6; i++) {
        const op = p.operators[i]!;
        expect(op.r, `${p.name}.op${i + 1}.r`).toHaveLength(4);
        expect(op.l, `${p.name}.op${i + 1}.l`).toHaveLength(4);
        for (let k = 0; k < 4; k++) {
          expect(op.r[k]).toBeGreaterThanOrEqual(0);
          expect(op.r[k]).toBeLessThanOrEqual(99);
          expect(op.l[k]).toBeGreaterThanOrEqual(0);
          expect(op.l[k]).toBeLessThanOrEqual(99);
        }
      }
    }
  });

  it('every operator has positive ratio + valid output level', () => {
    for (const p of DX7_BUILTIN_BANK) {
      for (let i = 0; i < 6; i++) {
        const op = p.operators[i]!;
        expect(op.ratio, `${p.name}.op${i + 1}.ratio`).toBeGreaterThan(0);
        expect(op.level, `${p.name}.op${i + 1}.level`).toBeGreaterThanOrEqual(0);
        expect(op.level, `${p.name}.op${i + 1}.level`).toBeLessThanOrEqual(99);
      }
    }
  });

  it('every operator carries the RAW coarse/fine bytes, consistent with its ratio', () => {
    // The built-ins are the reference voices the operator panel's PITCH row
    // opens on. Before these bytes existed the helper computed the ratio and
    // discarded them, so the row had nothing to edit. Assert they are present
    // AND that they agree with the derived values — a coarse byte that
    // disagreed with the ratio would be a control lying about its own value.
    for (const p of DX7_BUILTIN_BANK) {
      for (let i = 0; i < 6; i++) {
        const op = p.operators[i]!;
        const where = `${p.name}.op${i + 1}`;
        expect(typeof op.coarse, `${where}.coarse`).toBe('number');
        expect(typeof op.fine, `${where}.fine`).toBe('number');
        expect(op.coarse, `${where}.coarse`).toBeGreaterThanOrEqual(0);
        expect(op.coarse, `${where}.coarse`).toBeLessThanOrEqual(31);
        expect(op.fine, `${where}.fine`).toBeGreaterThanOrEqual(0);
        expect(op.fine, `${where}.fine`).toBeLessThanOrEqual(99);
        expect(dx7Ratio(op.coarse!, op.fine!), `${where} ratio`).toBeCloseTo(op.ratio, 12);
        expect(dx7FixedHz(op.coarse!, op.fine!), `${where} fixedHz`).toBeCloseTo(op.fixedHz!, 12);
      }
    }
  });

  it('the famous-named patches are present', () => {
    const famous = ['E.PIANO 1', 'BASS 1', 'HARMONICA', 'STRINGS 1', 'MARIMBA'];
    for (const name of famous) {
      expect(findBuiltinPatch(name), `missing patch: ${name}`).toBeDefined();
    }
  });

  it('case-insensitive lookup works', () => {
    expect(findBuiltinPatch('e.piano 1')?.name).toBe('E.PIANO 1');
    expect(findBuiltinPatch('  bass 1  ')?.name).toBe('BASS 1');
  });

  it('E.PIANO 1 uses algorithm 5 (canonical FM Rhodes)', () => {
    const p = findBuiltinPatch('E.PIANO 1');
    expect(p?.algorithm).toBe(5);
  });
});
