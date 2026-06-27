// packages/web/src/lib/video/vfpga/census.test.ts
//
// Pure unit tests for the fabric resource census + fit advisory (A2).

import { describe, expect, it } from 'vitest';
import { censusFabric, fabricAdvisories } from './census';
import { listVfpgaSpecs } from './registry';
import type { VfpgaFabric, VfpgaTile } from './types';

const tile = (id: string, type: VfpgaTile['type'], extra?: Partial<VfpgaTile>): VfpgaTile => ({
  id,
  type,
  config: {},
  ...extra,
});

/** A fabric with a mix of tile types + a fan-out-3 source. */
function mixedFabric(): VfpgaFabric {
  return {
    grid: { rows: 2, cols: 4 },
    tiles: [
      tile('c1', 'clb'),
      tile('c2', 'clb'),
      tile('l1', 'lut16'),
      tile('r1', 'reg'),
      tile('d1', 'dsp'),
      tile('b1', 'bram', { config: { rows: 8 } }),
      tile('o1', 'iob_out', { config: { op: 'OUT1' } }),
    ],
    nets: [
      { from: 'c1', to: 'c2:a' },
      { from: 'c1', to: 'l1:a' }, // c1 fan-out = 3
      { from: 'c1', to: 'd1:a' },
      { from: 'l1', to: 'o1:a' },
    ],
    outputs: { vout1: 'o1' },
  };
}

describe('censusFabric', () => {
  it('maps tile types onto LUT / FF / DSP / BRAM / IOB primitives', () => {
    const c = censusFabric(mixedFabric());
    expect(c.luts).toBe(3); // 2 clb + 1 lut16
    expect(c.ffs).toBe(1); // 1 reg
    expect(c.dsp).toBe(1); // 1 dsp
    expect(c.bramRows).toBe(8); // bram rows summed
    expect(c.iobs).toBe(1); // iob_out
    expect(c.computeTiles).toBe(6); // all non-IOB tiles
  });

  it('reports the worst per-source fan-out + its source', () => {
    const c = censusFabric(mixedFabric());
    expect(c.maxFanout).toBe(3);
    expect(c.maxFanoutSource).toBe('c1');
  });

  it('handles a fabric with no nets (zero fan-out, null source)', () => {
    const f: VfpgaFabric = { grid: { rows: 1, cols: 1 }, tiles: [tile('p', 'clb')], nets: [], outputs: { vout1: 'p' } };
    const c = censusFabric(f);
    expect(c.maxFanout).toBe(0);
    expect(c.maxFanoutSource).toBeNull();
  });

  it('counts every shipped fabric without throwing', () => {
    for (const spec of listVfpgaSpecs()) {
      if (!spec.fabric) continue;
      const c = censusFabric(spec.fabric);
      expect(c.luts + c.ffs + c.dsp + c.iobs, `${spec.id} has counted tiles`).toBeGreaterThan(0);
    }
  });
});

describe('fabricAdvisories', () => {
  it('returns nothing when no device is set (advisory is opt-in)', () => {
    expect(fabricAdvisories(mixedFabric())).toEqual([]);
  });

  it('returns nothing when the design fits the device', () => {
    const f = { ...mixedFabric(), device: { luts: 8, ffs: 4, dsp: 4, maxFanout: 8 } };
    expect(fabricAdvisories(f)).toEqual([]);
  });

  it('flags LUT / FF / DSP overflow against a too-small device', () => {
    const f = { ...mixedFabric(), device: { luts: 2, ffs: 0, dsp: 0 } };
    const a = fabricAdvisories(f);
    expect(a.find((s) => /LUTs over device: uses 3 > 2/.test(s))).toBeTruthy();
    expect(a.find((s) => /flip-flops over device: uses 1 > 0/.test(s))).toBeTruthy();
    expect(a.find((s) => /DSP slices over device: uses 1 > 0/.test(s))).toBeTruthy();
  });

  it('flags excessive fan-out', () => {
    const f = { ...mixedFabric(), device: { maxFanout: 2 } };
    const a = fabricAdvisories(f);
    expect(a.find((s) => /fan-out over device: source "c1" drives 3 sinks > 2 max/.test(s))).toBeTruthy();
  });

  it('every shipped fabric (no device declared) is advisory-clean', () => {
    for (const spec of listVfpgaSpecs()) {
      if (!spec.fabric) continue;
      expect(fabricAdvisories(spec.fabric), `${spec.id}`).toEqual([]);
    }
  });
});
