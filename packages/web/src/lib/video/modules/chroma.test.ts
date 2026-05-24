// packages/web/src/lib/video/modules/chroma.test.ts
//
// CHROMA module-def + v1→v2 migration tests. Pure (no GL).

import { describe, it, expect } from 'vitest';
import { chromaDef, migrateChroma } from './chroma';

describe('chromaDef shape', () => {
  it('declares the v2 param set (key R/G/B + threshold + softness + invert)', () => {
    const ids = chromaDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['invert', 'keyB', 'keyG', 'keyR', 'softness', 'threshold']);
  });

  it('declares CV inputs that mirror every modulatable param', () => {
    const inputIds = chromaDef.inputs.map((p) => p.id);
    expect(inputIds).toContain('in');
    for (const p of ['keyR', 'keyG', 'keyB', 'threshold', 'softness'] as const) {
      expect(inputIds, `missing cv input for ${p}`).toContain(p);
    }
  });

  it('invert is a discrete 0/1 toggle', () => {
    const invert = chromaDef.params.find((p) => p.id === 'invert');
    expect(invert).toBeDefined();
    expect(invert?.min).toBe(0);
    expect(invert?.max).toBe(1);
    expect(invert?.curve).toBe('discrete');
  });

  it('default key color is green-screen (R=0, G=1, B=0)', () => {
    const r = chromaDef.params.find((p) => p.id === 'keyR')?.defaultValue;
    const g = chromaDef.params.find((p) => p.id === 'keyG')?.defaultValue;
    const b = chromaDef.params.find((p) => p.id === 'keyB')?.defaultValue;
    expect(r).toBe(0);
    expect(g).toBe(1);
    expect(b).toBe(0);
  });

  it('schemaVersion is 2 (post-rename)', () => {
    expect(chromaDef.schemaVersion).toBe(2);
  });

  it('output is a single mono-video keys mask', () => {
    expect(chromaDef.outputs.map((o) => o.id)).toEqual(['out']);
    expect(chromaDef.outputs[0]!.type).toBe('mono-video');
  });
});

describe('migrateChroma (v1 → v2 rename tolerance → threshold)', () => {
  it('renames tolerance to threshold when missing', () => {
    const v1 = { keyR: 0, keyG: 1, keyB: 0, tolerance: 0.4, softness: 0.15 };
    const v2 = migrateChroma(v1, 1) as Record<string, unknown>;
    expect(v2.threshold).toBe(0.4);
    expect('tolerance' in v2).toBe(false);
  });

  it('preserves threshold when both fields exist (defensive)', () => {
    const v1 = { tolerance: 0.4, threshold: 0.6 };
    const v2 = migrateChroma(v1, 1) as Record<string, unknown>;
    // Both keys present means already-migrated data leaked in; don't
    // overwrite the explicit threshold.
    expect(v2.threshold).toBe(0.6);
  });

  it('no-op when fromVersion >= 2', () => {
    const data = { threshold: 0.5 };
    const out = migrateChroma(data, 2);
    expect(out).toBe(data);
  });

  it('no-op when data has neither field', () => {
    const data = { unrelated: 7 };
    expect(migrateChroma(data, 1)).toBe(data);
  });

  it('returns input unchanged for null / non-object', () => {
    expect(migrateChroma(null, 1)).toBe(null);
    expect(migrateChroma(undefined, 1)).toBe(undefined);
    expect(migrateChroma(42, 1)).toBe(42);
  });
});
