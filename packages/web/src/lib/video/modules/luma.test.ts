// packages/web/src/lib/video/modules/luma.test.ts
//
// LUMA module-def tests. Pure (no GL).
//
// LUMA was historically a confused single-input "luma-key mask" module
// (LUMAKEY now owns that role properly with FG + BG). It is now a 1-input
// luminance-domain processor: gamma / contrast / posterize / bias.

import { describe, it, expect } from 'vitest';
import { lumaDef } from './luma';

describe('lumaDef shape', () => {
  it('declares gamma / contrast / posterizeLevels / bias params', () => {
    const ids = lumaDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['bias', 'contrast', 'gamma', 'posterizeLevels']);
  });

  it('has exactly one video input (single-input processor)', () => {
    const videoInputs = lumaDef.inputs.filter((p) => p.type === 'video');
    expect(videoInputs.map((p) => p.id)).toEqual(['in']);
  });

  it('declares CV inputs that mirror every modulatable param', () => {
    const inputIds = lumaDef.inputs.map((p) => p.id);
    expect(inputIds).toContain('in');
    for (const p of ['gamma', 'contrast', 'posterizeLevels', 'bias'] as const) {
      expect(inputIds, `missing cv input for ${p}`).toContain(p);
    }
  });

  it('every CV input declares paramTarget == its own id', () => {
    for (const port of lumaDef.inputs.filter((i) => i.type === 'cv')) {
      expect(port.paramTarget, `cv input ${port.id} paramTarget`).toBe(port.id);
    }
  });

  it('gamma spans 0.1..3.0 (default 1 = identity)', () => {
    const g = lumaDef.params.find((p) => p.id === 'gamma');
    expect(g?.min).toBe(0.1);
    expect(g?.max).toBe(3.0);
    expect(g?.defaultValue).toBe(1);
  });

  it('contrast spans 0..2 (default 1 = identity)', () => {
    const c = lumaDef.params.find((p) => p.id === 'contrast');
    expect(c?.min).toBe(0);
    expect(c?.max).toBe(2);
    expect(c?.defaultValue).toBe(1);
  });

  it('posterizeLevels spans 2..16 with discrete curve', () => {
    const p = lumaDef.params.find((p) => p.id === 'posterizeLevels');
    expect(p?.min).toBe(2);
    expect(p?.max).toBe(16);
    expect(p?.curve).toBe('discrete');
  });

  it('bias spans -0.5..+0.5 (default 0 = no offset)', () => {
    const b = lumaDef.params.find((p) => p.id === 'bias');
    expect(b?.min).toBe(-0.5);
    expect(b?.max).toBe(0.5);
    expect(b?.defaultValue).toBe(0);
  });

  it('output is a single full video stream (not a mask)', () => {
    expect(lumaDef.outputs.map((o) => o.id)).toEqual(['out']);
    expect(lumaDef.outputs[0]!.type).toBe('video');
  });
});
