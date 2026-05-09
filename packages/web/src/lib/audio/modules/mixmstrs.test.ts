// packages/web/src/lib/audio/modules/mixmstrs.test.ts
//
// Unit tests for MIXMSTRS — focused on the comp macro mapping (added in
// feat/audio-fidelity-mixmstrs-comp-swolevco). Spectral / RMS behavior of
// the actual Faust DSP is covered under art/scenarios/mixmstrs/.

import { describe, expect, it } from 'vitest';
import { mapCompMacro, mixmstrsDef } from './mixmstrs';

describe('mapCompMacro: per-channel comp knob → (enable, thresh, ratio)', () => {
  it('comp=0 → bypass (enable=0, thresh=0, ratio=1)', () => {
    const m = mapCompMacro(0);
    expect(m.enable).toBe(0);
    expect(m.thresh).toBe(0);
    expect(m.ratio).toBe(1);
  });

  it('comp=1 → max compression (enable=1, thresh=-20, ratio=4)', () => {
    const m = mapCompMacro(1);
    expect(m.enable).toBe(1);
    expect(m.thresh).toBe(-20);
    expect(m.ratio).toBe(4);
  });

  it('comp=0.5 → midpoint (enable=1, thresh=-10, ratio=2.5)', () => {
    const m = mapCompMacro(0.5);
    expect(m.enable).toBe(1);
    expect(m.thresh).toBeCloseTo(-10, 6);
    expect(m.ratio).toBeCloseTo(2.5, 6);
  });

  it('clamps below 0 → bypass', () => {
    const m = mapCompMacro(-0.5);
    expect(m.enable).toBe(0);
  });

  it('clamps above 1 → max compression', () => {
    const m = mapCompMacro(1.5);
    expect(m.enable).toBe(1);
    expect(m.thresh).toBe(-20);
    expect(m.ratio).toBe(4);
  });

  it('any positive comp value enables the compressor (no dead zone above 0)', () => {
    for (const v of [0.001, 0.01, 0.05, 0.25, 0.99]) {
      expect(mapCompMacro(v).enable, `comp=${v}`).toBe(1);
    }
  });
});

describe('mixmstrsDef: shape adds 4 comp macros + 4 cv ports', () => {
  it('exposes comp1..comp4 params', () => {
    const ids = mixmstrsDef.params.map((p) => p.id);
    for (const ch of [1, 2, 3, 4]) {
      expect(ids, `comp${ch} param exists`).toContain(`comp${ch}`);
    }
  });

  it('comp params default to 0 (bypass — preserves existing patches)', () => {
    for (const ch of [1, 2, 3, 4]) {
      const p = mixmstrsDef.params.find((q) => q.id === `comp${ch}`);
      expect(p?.defaultValue, `comp${ch} default`).toBe(0);
    }
  });

  it('exposes comp1..comp4 cv input ports with paramTarget', () => {
    for (const ch of [1, 2, 3, 4]) {
      const port = mixmstrsDef.inputs.find((p) => p.id === `comp${ch}`);
      expect(port, `comp${ch} input port exists`).toBeDefined();
      expect(port?.type).toBe('cv');
      expect(port?.paramTarget).toBe(`comp${ch}`);
    }
  });

  it('preserves the original 37 underlying params (existing patches still work)', () => {
    const ids = mixmstrsDef.params.map((p) => p.id);
    // Spot-check the originals: per-channel thresh/ratio/compEnable,
    // master_volume.
    for (const ch of [1, 2, 3, 4]) {
      expect(ids).toContain(`ch${ch}_thresh`);
      expect(ids).toContain(`ch${ch}_ratio`);
      expect(ids).toContain(`ch${ch}_compEnable`);
    }
    expect(ids).toContain('master_volume');
  });

  it('total param count = 41 (37 originals + 4 comp macros)', () => {
    expect(mixmstrsDef.params.length).toBe(41);
  });
});
