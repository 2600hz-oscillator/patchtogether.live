// packages/web/src/lib/audio/dx7-banks.test.ts
//
// Sanity checks on the bundled bank: every patch is valid (6 ops, algorithm
// in 1..32, ratios > 0, etc.) and the documented "famous" patches all exist.

import { describe, it, expect } from 'vitest';
import { DX7_BUILTIN_BANK, findBuiltinPatch } from './dx7-banks';

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
