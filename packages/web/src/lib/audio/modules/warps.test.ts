// packages/web/src/lib/audio/modules/warps.test.ts
//
// Unit tests for WARPS:
//   - module-def shape (ports, params, cvScale annotations)
//   - per-algorithm one-sample math (XFADE / RING-MOD / XOR / COMPARE)
//   - param ranges
//   - V/oct internal-osc pitch tracking
//
// Worklet-level audio (AudioWorklet message passing, sample-rate transitions)
// is covered by the Playwright E2E + ART scenarios.

import { describe, expect, it } from 'vitest';
import {
  warpsDef,
  warpsMath,
  warpsXfade,
  warpsRingMod,
  warpsXor,
  warpsComparator,
  warpsApplyAlgorithm,
  WARPS_MAX_ALGORITHM,
  WARPS_ALGORITHM_NAMES,
  type WarpsParams,
} from './warps';

const SR = 48000;

function defaults(): WarpsParams {
  return { algorithm: 0, carrier_shape: 0, timbre: 0.5, level_1: 1, level_2: 1, note: 0 };
}

describe('warpsDef shape', () => {
  it('declares type=warps, label=WARPS, category=effects', () => {
    expect(warpsDef.type).toBe('warps');
    expect(warpsDef.label).toBe('WARPS');
    expect(warpsDef.category).toBe('effects');
  });

  it('exposes the expected input ports', () => {
    const ids = warpsDef.inputs.map((p) => p.id);
    expect(ids).toEqual([
      'carrier_in', 'modulator_in', 'pitch',
      'algorithm_cv', 'carrier_shape_cv', 'timbre_cv',
      'level_1_cv', 'level_2_cv',
    ]);
  });

  it('exposes one mono audio output: out', () => {
    expect(warpsDef.outputs).toEqual([{ id: 'out', type: 'audio' }]);
  });

  it('exposes the expected params', () => {
    const ids = warpsDef.params.map((p) => p.id);
    expect(ids).toEqual(['algorithm', 'carrier_shape', 'timbre', 'level_1', 'level_2', 'note']);
  });

  it('algorithm param is discrete 0..WARPS_MAX_ALGORITHM', () => {
    const p = warpsDef.params.find((p) => p.id === 'algorithm')!;
    expect(p.min).toBe(0);
    expect(p.max).toBe(WARPS_MAX_ALGORITHM);
    expect(p.curve).toBe('discrete');
  });

  it('shape / timbre / level_1 / level_2 are linear 0..1', () => {
    for (const k of ['carrier_shape', 'timbre', 'level_1', 'level_2'] as const) {
      const p = warpsDef.params.find((p) => p.id === k)!;
      expect(p.min, `${k} min`).toBe(0);
      expect(p.max, `${k} max`).toBe(1);
      expect(p.curve, `${k} curve`).toBe('linear');
    }
  });

  it('note param spans ±60 semitones', () => {
    const p = warpsDef.params.find((p) => p.id === 'note')!;
    expect(p.min).toBe(-60);
    expect(p.max).toBe(60);
    expect(p.units).toBe('st');
  });

  it('every cv input has cvScale + paramTarget pointing at a real param', () => {
    const paramIds = new Set(warpsDef.params.map((p) => p.id));
    for (const port of warpsDef.inputs) {
      if (port.type !== 'cv') continue;
      expect(port.paramTarget, `${port.id} paramTarget`).toBeDefined();
      expect(paramIds.has(port.paramTarget!), `${port.id} → ${port.paramTarget}`).toBe(true);
      expect(port.cvScale, `${port.id} cvScale`).toBeDefined();
    }
  });

  it('algorithm_cv uses discrete cvScale mode', () => {
    const p = warpsDef.inputs.find((p) => p.id === 'algorithm_cv')!;
    expect(p.cvScale!.mode).toBe('discrete');
  });

  it('WARPS_ALGORITHM_NAMES has exactly WARPS_MAX_ALGORITHM+1 entries', () => {
    expect(WARPS_ALGORITHM_NAMES.length).toBe(WARPS_MAX_ALGORITHM + 1);
    expect(WARPS_ALGORITHM_NAMES).toEqual(['XFADE', 'RING-MOD', 'XOR', 'COMPARE']);
  });
});

describe('warpsXfade — equal-power crossfade', () => {
  it('parameter=0 → pure carrier (modulator silenced)', () => {
    expect(warpsXfade(0.7, -0.3, 0)).toBeCloseTo(0.7, 6);
    expect(warpsXfade(0.5, 0.9, 0)).toBeCloseTo(0.5, 6);
  });

  it('parameter=1 → pure modulator (carrier silenced)', () => {
    expect(warpsXfade(0.7, -0.3, 1)).toBeCloseTo(-0.3, 6);
    expect(warpsXfade(0.5, 0.9, 1)).toBeCloseTo(0.9, 6);
  });

  it('parameter=0.5 → equal-power mid-point: both at cos(π/4)=√½', () => {
    const r = Math.SQRT1_2;
    expect(warpsXfade(1, 1, 0.5)).toBeCloseTo(r + r, 6);
    expect(warpsXfade(1, 0, 0.5)).toBeCloseTo(r, 6);
    expect(warpsXfade(0, 1, 0.5)).toBeCloseTo(r, 6);
  });

  it('clamps out-of-range parameter values', () => {
    expect(warpsXfade(1, 0, -0.5)).toBeCloseTo(1, 6);
    expect(warpsXfade(0, 1, 1.5)).toBeCloseTo(1, 6);
  });
});

describe('warpsRingMod — digital ring modulation', () => {
  it('zero carrier or zero modulator → zero output', () => {
    expect(warpsRingMod(0, 0.5, 0.5)).toBe(0);
    expect(warpsRingMod(0.5, 0, 0.5)).toBe(0);
  });

  it('matches Warps formula 4*x1*x2*(1+8p) / (1+|.|) at parameter=0', () => {
    // At parameter=0 the depth multiplier is 4*1 = 4.
    const x1 = 0.5;
    const x2 = 0.5;
    const ring = 4 * x1 * x2;
    const expected = ring / (1 + Math.abs(ring));
    expect(warpsRingMod(x1, x2, 0)).toBeCloseTo(expected, 8);
  });

  it('parameter increases drive → higher saturated output magnitude', () => {
    const lo = Math.abs(warpsRingMod(0.3, 0.3, 0));
    const hi = Math.abs(warpsRingMod(0.3, 0.3, 1));
    expect(hi).toBeGreaterThan(lo);
  });

  it('output is bounded by ±1 (softclip)', () => {
    for (let i = 0; i < 100; i++) {
      const x1 = Math.random() * 2 - 1;
      const x2 = Math.random() * 2 - 1;
      const p = Math.random();
      const y = warpsRingMod(x1, x2, p);
      expect(Math.abs(y)).toBeLessThan(1);
    }
  });
});

describe('warpsXor — bit-mash crossfaded against sum', () => {
  it('parameter=0 → pure 0.7 * (x1 + x2) sum, no XOR', () => {
    expect(warpsXor(0.5, 0.3, 0)).toBeCloseTo(0.7 * (0.5 + 0.3), 6);
    expect(warpsXor(-0.2, 0.4, 0)).toBeCloseTo(0.7 * (-0.2 + 0.4), 6);
  });

  it('parameter=1 → pure XOR mash (sum is gone)', () => {
    // Hand-roll the same operation to confirm bit-exact result.
    const x1 = 0.25;
    const x2 = 0.5;
    const x1s = Math.round(x1 * 32768) | 0;
    const x2s = Math.round(x2 * 32768) | 0;
    const mod = (x1s ^ x2s) / 32768;
    expect(warpsXor(x1, x2, 1)).toBeCloseTo(mod, 6);
  });

  it('XOR of identical streams equals zero (every bit pair matches → 0)', () => {
    expect(warpsXor(0.5, 0.5, 1)).toBe(0);
    expect(warpsXor(-0.25, -0.25, 1)).toBe(0);
  });
});

describe('warpsComparator — Warps direct/threshold/window suite', () => {
  it('parameter=0 → direct: min(modulator, carrier)', () => {
    // direct = modulator < carrier ? modulator : carrier
    expect(warpsComparator(0.3, 0.5, 0)).toBeCloseTo(0.3, 6);
    expect(warpsComparator(0.7, 0.2, 0)).toBeCloseTo(0.2, 6);
  });

  // The integral index reaches sub-mode `window` (idx=2) at parameter ≈
  // 2/2.995 ≈ 0.6678; pick a value safely past that and below the next bin.
  it('parameter≈0.7 → near `window` sub-mode (max-magnitude path)', () => {
    // window = |mod| > |car| ? mod : car
    const mod = 0.4;
    const car = -0.7;
    const y = warpsComparator(mod, car, 0.7);
    expect(Number.isFinite(y)).toBe(true);
    // Output must be one of the four sub-mode values blended; verify it
    // stays within their convex hull.
    const direct = mod < car ? mod : car;
    const window = Math.abs(mod) > Math.abs(car) ? mod : car;
    const window2 = Math.abs(mod) > Math.abs(car) ? Math.abs(mod) : -Math.abs(car);
    const threshold = car > 0.05 ? car : mod;
    const candidates = [direct, threshold, window, window2];
    const lo = Math.min(...candidates);
    const hi = Math.max(...candidates);
    expect(y).toBeGreaterThanOrEqual(lo - 1e-6);
    expect(y).toBeLessThanOrEqual(hi + 1e-6);
  });

  it('parameter=1 → exactly at threshold (idx=1, frac=0) → threshold value', () => {
    // At p = 1/2.995 ≈ 0.334 we land exactly on threshold; verify
    // an interior parameter still produces sane bounded output.
    expect(warpsComparator(0.3, 0.5, 1.0 / 2.995)).toBeCloseTo(0.5, 6);
  });
});

describe('warpsApplyAlgorithm — algorithm selection routing', () => {
  it('algorithm=0 dispatches to XFADE', () => {
    expect(warpsApplyAlgorithm(0, 0.6, 0.2, 0)).toBeCloseTo(0.6, 6);
    expect(warpsApplyAlgorithm(0, 0.6, 0.2, 1)).toBeCloseTo(0.2, 6);
  });

  it('algorithm=1 dispatches to RING-MOD', () => {
    const expected = warpsRingMod(0.6, 0.2, 0.5);
    expect(warpsApplyAlgorithm(1, 0.6, 0.2, 0.5)).toBeCloseTo(expected, 8);
  });

  it('algorithm=2 dispatches to XOR', () => {
    const expected = warpsXor(0.6, 0.2, 0.5);
    expect(warpsApplyAlgorithm(2, 0.6, 0.2, 0.5)).toBeCloseTo(expected, 8);
  });

  it('algorithm=3 swaps the arg-order for COMPARE (carrier ↔ modulator)', () => {
    // warpsApplyAlgorithm(algo, carrier, modulator, p) → warpsComparator(mod, car, p)
    const carrier = 0.5;
    const modulator = 0.3;
    const p = 0;
    expect(warpsApplyAlgorithm(3, carrier, modulator, p))
      .toBeCloseTo(warpsComparator(modulator, carrier, p), 8);
  });

  it('out-of-range algorithm rounds to nearest legal index and clamps', () => {
    expect(warpsApplyAlgorithm(-5, 0.6, 0.2, 0)).toBeCloseTo(0.6, 6);
    expect(warpsApplyAlgorithm(99, 0.5, 0.5, 0.5)).toBeCloseTo(
      warpsComparator(0.5, 0.5, 0.5), 8,
    );
    expect(warpsApplyAlgorithm(0.4, 0.6, 0.2, 0)).toBeCloseTo(0.6, 6);
    expect(warpsApplyAlgorithm(0.6, 0.6, 0.2, 0)).toBeCloseTo(
      warpsRingMod(0.6, 0.2, 0), 8,
    );
  });
});

describe('warpsMath.render — V/oct + internal carrier tracking', () => {
  it('renders n samples without throwing for every algorithm', () => {
    for (let algo = 0; algo <= WARPS_MAX_ALGORITHM; algo++) {
      const p = { ...defaults(), algorithm: algo };
      const out = warpsMath.render(2048, SR, 0, p, null, null);
      expect(out.length).toBe(2048);
      for (let i = 0; i < out.length; i++) {
        expect(Number.isFinite(out[i]!), `algo=${algo} idx=${i}`).toBe(true);
        expect(Math.abs(out[i]!)).toBeLessThan(1);
      }
    }
  });

  it('XFADE with level_2=0 + carrier_in patched preserves carrier', () => {
    // The XFADE param is parameter=timbre=0 → pure carrier. So whatever
    // we feed into carrier_in should pass straight through unchanged
    // (modulo softLimit, which is identity for inputs well below ±1).
    const n = 256;
    const car = new Float32Array(n);
    for (let i = 0; i < n; i++) car[i] = Math.sin((2 * Math.PI * 110 * i) / SR) * 0.3;
    const p = { ...defaults(), algorithm: 0, timbre: 0, level_1: 1, level_2: 0 };
    const out = warpsMath.render(n, SR, 0, p, car, null);
    for (let i = 0; i < n; i++) {
      const expected = car[i]! / (1 + Math.abs(car[i]!));
      expect(out[i]!).toBeCloseTo(expected, 4);
    }
  });

  it('internal oscillator tracks pitch V/oct (1 oct above doubles frequency)', () => {
    // Render two seconds, count zero crossings to estimate frequency.
    const n = SR;
    const p1V0 = { ...defaults(), algorithm: 0, timbre: 0, carrier_shape: 0 };
    const out0 = warpsMath.render(n, SR, 0, p1V0, null, null);
    const out1 = warpsMath.render(n, SR, 1, p1V0, null, null);

    function zeroCrossings(buf: Float32Array): number {
      let z = 0;
      for (let i = 1; i < buf.length; i++) {
        if ((buf[i - 1]! > 0) !== (buf[i]! > 0)) z++;
      }
      return z;
    }
    const z0 = zeroCrossings(out0);
    const z1 = zeroCrossings(out1);
    // Allow a sloppy ±15% window because the softLimit + algorithm
    // routing can perturb crossings near zero; the dominant signal is
    // still a clean sine.
    expect(z1 / z0).toBeGreaterThan(1.7);
    expect(z1 / z0).toBeLessThan(2.3);
  });

  it('note param offsets pitch in semitones (1 octave = 12 semitones doubles freq)', () => {
    const n = SR;
    const p0 = { ...defaults(), algorithm: 0, timbre: 0, carrier_shape: 0, note: 0 };
    const p12 = { ...p0, note: 12 };
    const out0 = warpsMath.render(n, SR, 0, p0, null, null);
    const out12 = warpsMath.render(n, SR, 0, p12, null, null);
    function zeroCrossings(buf: Float32Array): number {
      let z = 0;
      for (let i = 1; i < buf.length; i++) if ((buf[i - 1]! > 0) !== (buf[i]! > 0)) z++;
      return z;
    }
    const ratio = zeroCrossings(out12) / zeroCrossings(out0);
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(2.3);
  });
});
