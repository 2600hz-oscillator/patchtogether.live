// packages/web/src/lib/video/modules/chroma.test.ts
//
// CHROMA module-def + migration tests. Pure (no GL).
//
// CHROMA was historically a confused single-input "key-mask" module
// (CHROMAKEY now owns that role properly with FG + BG). v3 restores
// CHROMA to its name's actual meaning: a 1-input hue-shifter / colorizer
// with saturation + RGB tint mix.

import { describe, it, expect } from 'vitest';
import { chromaDef, migrateChroma } from './chroma';

describe('chromaDef shape', () => {
  it('declares the v3 processor param set (hue/saturation/tintR/G/B/tintMix)', () => {
    const ids = chromaDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['hue', 'saturation', 'tintB', 'tintG', 'tintMix', 'tintR']);
  });

  it('has exactly one video input (single-input processor)', () => {
    const videoInputs = chromaDef.inputs.filter((p) => p.type === 'video');
    expect(videoInputs.map((p) => p.id)).toEqual(['in']);
  });

  it('declares CV inputs that mirror every modulatable param', () => {
    const inputIds = chromaDef.inputs.map((p) => p.id);
    expect(inputIds).toContain('in');
    for (const p of ['hue', 'saturation', 'tintR', 'tintG', 'tintB', 'tintMix'] as const) {
      expect(inputIds, `missing cv input for ${p}`).toContain(p);
    }
  });

  it('every CV input declares paramTarget == its own id', () => {
    for (const port of chromaDef.inputs.filter((i) => i.type === 'cv')) {
      expect(port.paramTarget, `cv input ${port.id} paramTarget`).toBe(port.id);
    }
  });

  it('hue spans -180..+180 degrees', () => {
    const hue = chromaDef.params.find((p) => p.id === 'hue');
    expect(hue?.min).toBe(-180);
    expect(hue?.max).toBe(180);
    expect(hue?.defaultValue).toBe(0);
  });

  it('saturation spans 0..2 (default 1 = unchanged)', () => {
    const sat = chromaDef.params.find((p) => p.id === 'saturation');
    expect(sat?.min).toBe(0);
    expect(sat?.max).toBe(2);
    expect(sat?.defaultValue).toBe(1);
  });

  it('tintMix defaults to 0 (no tint applied unless asked)', () => {
    const mix = chromaDef.params.find((p) => p.id === 'tintMix');
    expect(mix?.defaultValue).toBe(0);
  });

  it('schemaVersion is 3 (post-rework)', () => {
    expect(chromaDef.schemaVersion).toBe(3);
  });

  it('output is a single full video stream (not a mask)', () => {
    expect(chromaDef.outputs.map((o) => o.id)).toEqual(['out']);
    expect(chromaDef.outputs[0]!.type).toBe('video');
  });
});

describe('migrateChroma (v1/v2 mask -> v3 processor reset)', () => {
  it('drops legacy keyR/keyG/keyB/threshold/softness/invert from v1', () => {
    const v1 = { keyR: 0, keyG: 1, keyB: 0, tolerance: 0.4, softness: 0.15, invert: 1 };
    const out = migrateChroma(v1, 1) as Record<string, unknown>;
    for (const legacy of ['keyR', 'keyG', 'keyB', 'tolerance', 'softness', 'invert']) {
      expect(legacy in out, `legacy ${legacy} dropped`).toBe(false);
    }
  });

  it('drops legacy threshold from v2', () => {
    const v2 = { keyR: 0, keyG: 1, keyB: 0, threshold: 0.4, softness: 0.15, invert: 0 };
    const out = migrateChroma(v2, 2) as Record<string, unknown>;
    expect('threshold' in out).toBe(false);
    expect('keyR' in out).toBe(false);
  });

  it('preserves unrelated forward-compat keys', () => {
    const v1 = { keyR: 0, future_field: 'preserved' };
    const out = migrateChroma(v1, 1) as Record<string, unknown>;
    expect(out.future_field).toBe('preserved');
    expect('keyR' in out).toBe(false);
  });

  it('passes through v3 data unchanged (idempotent)', () => {
    const v3 = { hue: 90, saturation: 1.2, tintR: 0.3, tintG: 0.7, tintB: 0.1, tintMix: 0.4 };
    const out = migrateChroma(v3, 3);
    expect(out).toBe(v3);
  });

  it('returns input unchanged for null / non-object', () => {
    expect(migrateChroma(null, 1)).toBe(null);
    expect(migrateChroma(undefined, 1)).toBe(undefined);
    expect(migrateChroma(42, 1)).toBe(42);
  });
});
