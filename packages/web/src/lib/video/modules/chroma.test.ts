// packages/web/src/lib/video/modules/chroma.test.ts
//
// CHROMA module-def tests. Pure (no GL).
//
// CHROMA was historically a confused single-input "key-mask" module
// (CHROMAKEY now owns that role properly with FG + BG). It is now a 1-input
// hue-shifter / colorizer with saturation + RGB tint mix.

import { describe, it, expect } from 'vitest';
import { chromaDef } from './chroma';

describe('chromaDef shape', () => {
  it('declares the processor param set (hue/saturation/tintR/G/B/tintMix)', () => {
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

  it('output is a single full video stream (not a mask)', () => {
    expect(chromaDef.outputs.map((o) => o.id)).toEqual(['out']);
    expect(chromaDef.outputs[0]!.type).toBe('video');
  });
});
