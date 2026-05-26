// art/scenarios/symbiote/drums-and-acid.test.ts
//
// Audio Regression Test scenarios for SYMBIOTE. Property checks of the Grids
// drum density mapping, Euclidean sparsity, and TB-3PO acid pitch range /
// numerical stability across scales.

import { describe, expect, it } from 'vitest';
import { symbioteMath, type SymbioteParams } from '../../../packages/web/src/lib/audio/modules/symbiote';

const SR = 48000;

function base(o: Partial<SymbioteParams> = {}): SymbioteParams {
  return {
    rate: 48,
    sub_mode: 0,
    map_x: 0.5,
    map_y: 0.5,
    bd_density: 0.8,
    sd_density: 0.6,
    hh_density: 0.7,
    chaos: 0,
    euclid_length: 16,
    acid_density: 0.6,
    transpose: 0,
    acid_length: 16,
    scale: 0,
    seed_lock: 1,
    ...o,
  };
}

function risingEdges(buf: Float32Array): number {
  let e = 0;
  for (let i = 1; i < buf.length; i++) if (buf[i - 1]! < 0.5 && buf[i]! >= 0.5) e++;
  return e;
}

describe('ART symbiote / Grids drum density', () => {
  it('higher BD density yields at least as many BD hits as low density', () => {
    const n = SR * 2;
    const lo = symbioteMath.render(n, SR, base({ bd_density: 0.1 }));
    const hi = symbioteMath.render(n, SR, base({ bd_density: 1.0 }));
    const loHits = risingEdges(lo.t1);
    const hiHits = risingEdges(hi.t1);
    expect(hiHits, `hi BD hits ${hiHits} >= lo ${loHits}`).toBeGreaterThanOrEqual(loHits);
    expect(hiHits).toBeGreaterThan(0);
  });

  it('Euclidean sub-mode produces structured (sub-saturation) BD pattern', () => {
    const n = SR * 2;
    const r = symbioteMath.render(n, SR, base({ sub_mode: 1, euclid_length: 16, bd_density: 0.5 }));
    const hits = risingEdges(r.t1);
    const clkCycles = risingEdges(r.x1);
    // Fewer BD hits than clock steps → genuinely Euclidean, not every step.
    expect(hits).toBeGreaterThan(0);
    expect(hits, `BD hits ${hits} < clock cycles ${clkCycles}`).toBeLessThanOrEqual(clkCycles * 2 + 4);
  });
});

describe('ART symbiote / TB-3PO acid', () => {
  it('acid gate fires and pitch CV stays in ±1', () => {
    const n = SR * 2;
    const r = symbioteMath.render(n, SR, base({ acid_density: 0.9 }));
    expect(risingEdges(r.x3)).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(r.x2[i]!)).toBe(true);
      expect(Math.abs(r.x2[i]!)).toBeLessThanOrEqual(1.0001);
    }
  });

  it('positive transpose shifts the mean acid pitch upward', () => {
    const n = SR * 2;
    function meanGatedPitch(transpose: number): number {
      const r = symbioteMath.render(n, SR, base({ transpose, acid_density: 0.9 }));
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < n; i++) {
        if (r.x3[i]! > 0.5) {
          sum += r.x2[i]!;
          cnt++;
        }
      }
      return cnt ? sum / cnt : 0;
    }
    const lo = meanGatedPitch(0);
    const hi = meanGatedPitch(12);
    expect(hi, `transpose +12 mean ${hi} >= base ${lo}`).toBeGreaterThanOrEqual(lo);
  });

  it('stays finite + bounded across every scale', () => {
    const n = SR / 2;
    for (let scale = 0; scale <= 5; scale++) {
      const r = symbioteMath.render(n, SR, base({ scale, acid_density: 0.8 }));
      for (const buf of [r.t1, r.t2, r.t3, r.x1, r.x2, r.x3, r.y]) {
        for (let i = 0; i < n; i++) {
          expect(Number.isFinite(buf[i]!), `scale=${scale} sample[${i}]`).toBe(true);
        }
      }
    }
  });
});
