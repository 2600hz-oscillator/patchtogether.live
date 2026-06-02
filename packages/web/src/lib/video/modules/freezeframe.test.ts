// packages/web/src/lib/video/modules/freezeframe.test.ts
//
// FREEZEFRAME unit tests — pure (no GL):
//   1. def shape (5 video outs, video_in + gate_in, 4 QUANT knobs).
//   2. QUANT posterize mapping: 7:00→256, mid→32, max→2; monotonic.
//   3. posterizeChannel math (identity at 256, threshold at 2).
//   4. channel split / luma extraction (Rec.601 weights).

import { describe, it, expect } from 'vitest';
import {
  freezeframeDef,
  quantLevels,
  posterizeChannel,
  lumaOf,
  LUMA_WEIGHTS,
  QUANT_MAX_LEVELS,
  QUANT_MID_LEVELS,
  QUANT_MIN_LEVELS,
} from './freezeframe';

describe('freezeframeDef shape', () => {
  it('declares video_in (video) + gate_in (gate) inputs', () => {
    const byId = Object.fromEntries(freezeframeDef.inputs.map((p) => [p.id, p.type]));
    expect(byId.video_in).toBe('video');
    expect(byId.gate_in).toBe('gate');
  });

  it('gate_in routes to the gateLevel param (CV bridge target)', () => {
    const gate = freezeframeDef.inputs.find((p) => p.id === 'gate_in');
    expect(gate?.paramTarget).toBe('gateLevel');
  });

  it('declares exactly five video outputs: video_out, r/g/b/luma_out', () => {
    expect(freezeframeDef.outputs.map((o) => o.id)).toEqual([
      'video_out', 'r_out', 'g_out', 'b_out', 'luma_out',
    ]);
    for (const o of freezeframeDef.outputs) expect(o.type).toBe('video');
  });

  it('declares the four QUANT knobs over 0..1 linear, default 0', () => {
    for (const id of ['quant_r', 'quant_g', 'quant_b', 'quant_luma'] as const) {
      const p = freezeframeDef.params.find((x) => x.id === id);
      expect(p, `missing ${id}`).toBeTruthy();
      expect(p!.min).toBe(0);
      expect(p!.max).toBe(1);
      expect(p!.defaultValue).toBe(0);
      expect(p!.curve).toBe('linear');
    }
  });

  it('exposes a hidden gateLevel param for the CV bridge', () => {
    const g = freezeframeDef.params.find((p) => p.id === 'gateLevel');
    expect(g).toBeTruthy();
  });

  it('is a video module in the effects category', () => {
    expect(freezeframeDef.domain).toBe('video');
    expect(freezeframeDef.category).toBe('effects');
    expect(freezeframeDef.type).toBe('freezeframe');
  });
});

describe('quantLevels mapping (256 -> 32 -> 2)', () => {
  it('7:00 / min knob = 0 → 256 levels (full depth)', () => {
    expect(quantLevels(0)).toBeCloseTo(QUANT_MAX_LEVELS, 6);
    expect(quantLevels(0)).toBeCloseTo(256, 6);
  });

  it('midway knob = 0.5 → 32 levels', () => {
    expect(quantLevels(0.5)).toBeCloseTo(QUANT_MID_LEVELS, 6);
    expect(quantLevels(0.5)).toBeCloseTo(32, 6);
  });

  it('max knob = 1 → 2 levels (on/off)', () => {
    expect(quantLevels(1)).toBeCloseTo(QUANT_MIN_LEVELS, 6);
    expect(quantLevels(1)).toBeCloseTo(2, 6);
  });

  it('step count is STRICTLY monotonic-decreasing across the sweep', () => {
    let prev = Infinity;
    for (let k = 0; k <= 1.00001; k += 0.05) {
      const lv = quantLevels(k);
      expect(lv, `levels at knob=${k.toFixed(2)} (${lv}) < prev (${prev})`).toBeLessThan(prev);
      prev = lv;
    }
  });

  it('clamps out-of-range knob values', () => {
    expect(quantLevels(-1)).toBeCloseTo(256, 6);
    expect(quantLevels(2)).toBeCloseTo(2, 6);
  });
});

describe('posterizeChannel', () => {
  it('256 levels is effectively identity for representable 8-bit grid values', () => {
    // Values on the 256-step grid round-trip to themselves.
    for (const n of [0, 64, 128, 200, 255]) {
      const v = n / 255;
      // posterize to 256 buckets, then it sits on the 256-grid (idx/255).
      const out = posterizeChannel(v, 256);
      expect(out).toBeCloseTo(n / 255, 5);
    }
  });

  it('2 levels is a hard threshold to {0, 1}', () => {
    expect(posterizeChannel(0.0, 2)).toBe(0);
    expect(posterizeChannel(0.4, 2)).toBe(0);
    expect(posterizeChannel(0.49, 2)).toBe(0);
    expect(posterizeChannel(0.5, 2)).toBe(1);
    expect(posterizeChannel(0.9, 2)).toBe(1);
    expect(posterizeChannel(1.0, 2)).toBe(1);
  });

  it('reduces the number of DISTINCT output values as levels drop', () => {
    const distinct = (levels: number) => {
      const s = new Set<number>();
      for (let i = 0; i <= 255; i++) s.add(posterizeChannel(i / 255, levels));
      return s.size;
    };
    const at256 = distinct(256);
    const at32 = distinct(32);
    const at2 = distinct(2);
    expect(at32).toBeLessThan(at256);
    expect(at2).toBeLessThan(at32);
    expect(at2).toBe(2);          // exactly {0, 1}
    expect(at32).toBe(32);        // 32 buckets reachable from 256 inputs
  });

  it('clamps + never divides by zero (levels < 2 floored to 2)', () => {
    expect(posterizeChannel(0.7, 1)).toBe(1);   // treated as 2 levels
    expect(posterizeChannel(0.7, 0)).toBe(1);
    expect(Number.isFinite(posterizeChannel(0.3, 2))).toBe(true);
  });

  it('spans the full 0..1 output range (white in → white out)', () => {
    expect(posterizeChannel(1, 32)).toBeCloseTo(1, 6);
    expect(posterizeChannel(1, 256)).toBeCloseTo(1, 6);
    expect(posterizeChannel(0, 32)).toBe(0);
  });
});

describe('lumaOf — Rec.601 channel extraction', () => {
  it('uses the 0.299 / 0.587 / 0.114 weights', () => {
    expect(LUMA_WEIGHTS).toEqual({ r: 0.299, g: 0.587, b: 0.114 });
  });

  it('pure red → 0.299, pure green → 0.587, pure blue → 0.114', () => {
    expect(lumaOf(1, 0, 0)).toBeCloseTo(0.299, 6);
    expect(lumaOf(0, 1, 0)).toBeCloseTo(0.587, 6);
    expect(lumaOf(0, 0, 1)).toBeCloseTo(0.114, 6);
  });

  it('white → 1, black → 0', () => {
    expect(lumaOf(1, 1, 1)).toBeCloseTo(1, 6);
    expect(lumaOf(0, 0, 0)).toBe(0);
  });

  it('green contributes more than red, red more than blue (perceptual order)', () => {
    expect(lumaOf(0, 1, 0)).toBeGreaterThan(lumaOf(1, 0, 0));
    expect(lumaOf(1, 0, 0)).toBeGreaterThan(lumaOf(0, 0, 1));
  });
});
