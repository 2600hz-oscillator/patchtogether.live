// packages/web/src/lib/video/modules/lumakey.test.ts
//
// LUMAKEY module-def tests. Pure (no GL).
//
// LUMAKEY is the proper 2-input luma-key compositor — it takes FG + BG
// and a luma threshold and composites by smoothstepping the FG luma
// across the threshold band.

import { describe, it, expect } from 'vitest';
import { lumakeyDef } from './lumakey';

describe('lumakeyDef shape', () => {
  it('declares exactly 2 video inputs (fg + bg)', () => {
    const videoInputs = lumakeyDef.inputs.filter((p) => p.type === 'video');
    expect(videoInputs.map((p) => p.id).sort()).toEqual(['bg', 'fg']);
  });

  it('declares threshold / softness / invert params', () => {
    const ids = lumakeyDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['invert', 'softness', 'threshold']);
  });

  it('declares CV inputs for threshold, softness, invert', () => {
    const inputIds = lumakeyDef.inputs.map((p) => p.id);
    expect(inputIds).toContain('threshold');
    expect(inputIds).toContain('softness');
    expect(inputIds).toContain('invert');
  });

  it('every CV input declares paramTarget == its own id', () => {
    for (const port of lumakeyDef.inputs.filter((i) => i.type === 'cv')) {
      expect(port.paramTarget, `cv input ${port.id} paramTarget`).toBe(port.id);
    }
  });

  it('invert is a discrete 0/1 toggle', () => {
    const inv = lumakeyDef.params.find((p) => p.id === 'invert');
    expect(inv?.min).toBe(0);
    expect(inv?.max).toBe(1);
    expect(inv?.curve).toBe('discrete');
  });

  it('softness spans 0..0.5 (per kickoff spec)', () => {
    const s = lumakeyDef.params.find((p) => p.id === 'softness');
    expect(s?.min).toBe(0);
    expect(s?.max).toBe(0.5);
  });

  it('threshold defaults to 0.5 (midpoint)', () => {
    const t = lumakeyDef.params.find((p) => p.id === 'threshold');
    expect(t?.defaultValue).toBe(0.5);
  });

  it('output is a single full video stream', () => {
    expect(lumakeyDef.outputs.map((o) => o.id)).toEqual(['out']);
    expect(lumakeyDef.outputs[0]!.type).toBe('video');
  });

  it('declares type "lumakey" + video domain', () => {
    expect(lumakeyDef.type).toBe('lumakey');
    expect(lumakeyDef.domain).toBe('video');
    expect(lumakeyDef.category).toBe('effects');
  });
});
