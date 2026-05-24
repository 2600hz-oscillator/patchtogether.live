// packages/web/src/lib/video/modules/chromakey.test.ts
//
// CHROMAKEY module-def tests. Pure (no GL).
//
// CHROMAKEY is the proper 2-input chroma-key compositor — it takes
// FG + BG and a key color and composites with hue-distance keying,
// soft-edge ramp, and spill suppression (per
// p10entrancer/Shaders/Keyer.metal).

import { describe, it, expect } from 'vitest';
import { chromakeyDef } from './chromakey';

describe('chromakeyDef shape', () => {
  it('declares exactly 2 video inputs (fg + bg)', () => {
    const videoInputs = chromakeyDef.inputs.filter((p) => p.type === 'video');
    expect(videoInputs.map((p) => p.id).sort()).toEqual(['bg', 'fg']);
  });

  it('declares key R/G/B + threshold + softness + spillSuppress params', () => {
    const ids = chromakeyDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['keyB', 'keyG', 'keyR', 'softness', 'spillSuppress', 'threshold']);
  });

  it('declares CV inputs that mirror every modulatable param', () => {
    const inputIds = chromakeyDef.inputs.map((p) => p.id);
    for (const p of ['keyR', 'keyG', 'keyB', 'threshold', 'softness', 'spillSuppress'] as const) {
      expect(inputIds, `missing cv input for ${p}`).toContain(p);
    }
  });

  it('every CV input declares paramTarget == its own id', () => {
    for (const port of chromakeyDef.inputs.filter((i) => i.type === 'cv')) {
      expect(port.paramTarget, `cv input ${port.id} paramTarget`).toBe(port.id);
    }
  });

  it('default key color is green-screen (R=0, G=1, B=0)', () => {
    const r = chromakeyDef.params.find((p) => p.id === 'keyR')?.defaultValue;
    const g = chromakeyDef.params.find((p) => p.id === 'keyG')?.defaultValue;
    const b = chromakeyDef.params.find((p) => p.id === 'keyB')?.defaultValue;
    expect(r).toBe(0);
    expect(g).toBe(1);
    expect(b).toBe(0);
  });

  it('softness spans 0..0.5 (per kickoff spec)', () => {
    const s = chromakeyDef.params.find((p) => p.id === 'softness');
    expect(s?.min).toBe(0);
    expect(s?.max).toBe(0.5);
  });

  it('spillSuppress spans 0..1 (per kickoff spec)', () => {
    const s = chromakeyDef.params.find((p) => p.id === 'spillSuppress');
    expect(s?.min).toBe(0);
    expect(s?.max).toBe(1);
  });

  it('output is a single full video stream', () => {
    expect(chromakeyDef.outputs.map((o) => o.id)).toEqual(['out']);
    expect(chromakeyDef.outputs[0]!.type).toBe('video');
  });

  it('declares type "chromakey" + video domain', () => {
    expect(chromakeyDef.type).toBe('chromakey');
    expect(chromakeyDef.domain).toBe('video');
    expect(chromakeyDef.category).toBe('effects');
  });
});
