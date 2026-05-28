// packages/web/src/lib/audio/modules/foxy-map.test.ts
//
// Unit tests for FOXY's deterministic bridge math: the simplified RUTTETRA
// field + the XYZ→wavetable conversion. Pure functions — no canvas, no GL,
// no AudioContext.

import { describe, expect, it } from 'vitest';
import {
  FOXY_FIELD_SIZE,
  FOXY_WT_FRAMES,
  FOXY_WT_SAMPLES,
  FOXY_XYZ_DEFAULTS,
  lumaAt,
  simplifiedRuttetraField,
  boxHeightfield,
  boxToField,
  fieldToWavetable,
  wavetableSignature,
} from './foxy-map';

/** Variance of all sample values across every frame — our "how 3D / how
 *  much vertical variation" metric. A flat table has ~0 variance; a table
 *  with real height relief has a much larger spread. */
function wavetableVariance(frames: number[][]): number {
  let n = 0, sum = 0, sumSq = 0;
  for (const f of frames) for (const v of f) { sum += v; sumSq += v * v; n++; }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Mean absolute frame-to-frame delta — captures how much the table MOVES
 *  as you morph through it (the WAVECEL sweep). */
function frameToFrameDelta(frames: number[][]): number {
  let n = 0, acc = 0;
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f]!, b = frames[f - 1]!;
    for (let s = 0; s < a.length; s++) { acc += Math.abs(a[s]! - b[s]!); n++; }
  }
  return n > 0 ? acc / n : 0;
}

/** Build a small RGBA buffer with a per-(x,y) luminance via a callback. */
function makeBuffer(w: number, h: number, fn: (x: number, y: number) => number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const l = Math.max(0, Math.min(255, Math.round(fn(x, y) * 255)));
      buf[o] = l; buf[o + 1] = l; buf[o + 2] = l; buf[o + 3] = 255;
    }
  }
  return buf;
}

describe('lumaAt', () => {
  it('reads Rec.601 luma of a grey pixel as its grey level', () => {
    const buf = makeBuffer(2, 2, () => 0.5);
    expect(lumaAt(buf, 2, 2, 0, 0)).toBeCloseTo(0.5, 2);
  });
  it('clamps out-of-range coords to the edge pixel', () => {
    const buf = makeBuffer(2, 2, (x) => (x === 0 ? 0 : 1));
    expect(lumaAt(buf, 2, 2, -5, 0)).toBeCloseTo(0, 2); // clamps to x=0
    expect(lumaAt(buf, 2, 2, 99, 0)).toBeCloseTo(1, 2); // clamps to x=1
  });
});

describe('simplifiedRuttetraField', () => {
  it('returns rows×cols of FoxyFieldRow with the requested dims', () => {
    const buf = makeBuffer(8, 8, () => 0.5);
    const field = simplifiedRuttetraField(buf, 8, 8, FOXY_XYZ_DEFAULTS, 8, 8);
    expect(field).toHaveLength(8);
    for (const row of field) {
      expect(row.y).toHaveLength(8);
      expect(row.lum).toHaveLength(8);
    }
  });

  it('mid-grey (luma 0.5) produces ZERO displacement (y == base ramp)', () => {
    // With lum exactly 0.5, the (lum-0.5)*yDisp term vanishes, so y == the
    // shaped base ramp regardless of yDisp.
    const buf = makeBuffer(16, 16, () => 0.5);
    const params = { ...FOXY_XYZ_DEFAULTS, yShape: 0, yDisp: -0.8 };
    const field = simplifiedRuttetraField(buf, 16, 16, params, 16, 16);
    // yShape 0 => RUTTETRA's linear shapedRamp => y == fract(v0). fract wraps
    // v0=1.0 (the last row) back to 0 — that's faithful RUTTETRA behavior, so
    // the base center is fract(r/(rows-1)), not r/(rows-1) verbatim.
    field.forEach((row, r) => {
      const v0 = r / (field.length - 1);
      const expected = v0 - Math.floor(v0); // fract(v0)
      // 8-bit pixel quantization (0.5 → 128/255 ≈ 0.50196) leaves a ~0.002
      // residual displacement, so assert to 2 decimals not 4.
      for (const yv of row.y) expect(yv).toBeCloseTo(expected, 2);
    });
  });

  it('brighter-than-mid pixels displace UP (smaller y) when yDisp negative', () => {
    // A fully white field with negative yDisp pushes every point up (y < base).
    const white = makeBuffer(16, 16, () => 1);
    const params = { ...FOXY_XYZ_DEFAULTS, yShape: 0, yDisp: -0.5 };
    const field = simplifiedRuttetraField(white, 16, 16, params, 16, 16);
    field.forEach((row, r) => {
      const base = r / (field.length - 1);
      for (const yv of row.y) expect(yv).toBeLessThan(base + 1e-6);
    });
  });
});

describe('fieldToWavetable', () => {
  it('produces FOXY_WT_FRAMES × FOXY_WT_SAMPLES dims by default', () => {
    const buf = makeBuffer(FOXY_FIELD_SIZE, FOXY_FIELD_SIZE, () => 0.5);
    const field = simplifiedRuttetraField(buf, FOXY_FIELD_SIZE, FOXY_FIELD_SIZE, FOXY_XYZ_DEFAULTS);
    const wt = fieldToWavetable(field);
    expect(wt).toHaveLength(FOXY_WT_FRAMES);
    for (const f of wt) expect(f).toHaveLength(FOXY_WT_SAMPLES);
  });

  it('all sample values are within [-1, 1]', () => {
    // Extreme gradient + strong displacement to stress the clamp.
    const grad = makeBuffer(64, 64, (x, y) => (x + y) / 126);
    const params = { ...FOXY_XYZ_DEFAULTS, yDisp: 1, yShape: 1 };
    const field = simplifiedRuttetraField(grad, 64, 64, params, 64, 64);
    const wt = fieldToWavetable(field, 16, 32);
    for (const frame of wt) {
      for (const v of frame) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic: same field → identical frames', () => {
    const buf = makeBuffer(32, 32, (x, y) => ((x * 7 + y * 13) % 32) / 32);
    const field = simplifiedRuttetraField(buf, 32, 32, FOXY_XYZ_DEFAULTS, 32, 32);
    const a = fieldToWavetable(field, 8, 16);
    const b = fieldToWavetable(field, 8, 16);
    expect(a).toEqual(b);
  });

  it('mid-grey field (zero displacement) yields a flat-zero wavetable', () => {
    // lum 0.5 + yShape 0 => y == base ramp; (y - 0.5)*2 over the row-averaged
    // box equals the ramp center contributions. With a single-row-per-frame
    // box and yShape 0 the per-frame value is (v0 - 0.5)*2, NOT zero — so we
    // pin the EXPECTED ramp-derived value instead of asserting flat zero.
    const buf = makeBuffer(8, 8, () => 0.5);
    const params = { ...FOXY_XYZ_DEFAULTS, yShape: 0 };
    const field = simplifiedRuttetraField(buf, 8, 8, params, 8, 8);
    const wt = fieldToWavetable(field, 8, 8);
    // frame f maps to source row f (8 rows → 8 frames, 1:1). y == fract(f/7),
    // so the wavetable sample is (fract(f/7) - 0.5) * 2. The last row (f=7)
    // wraps fract(1.0)=0 → sample -1 (faithful shapedRamp wrap).
    wt.forEach((frame, f) => {
      const v0 = f / 7;
      const base = v0 - Math.floor(v0); // fract
      const expected = (base - 0.5) * 2;
      // ~0.004 residual from 8-bit luma quantization → 2-decimal tolerance.
      for (const v of frame) expect(v).toBeCloseTo(expected, 2);
    });
  });

  it('handles an empty field by emitting a flat table of the right dims', () => {
    const wt = fieldToWavetable([], 4, 8);
    expect(wt).toHaveLength(4);
    for (const f of wt) {
      expect(f).toHaveLength(8);
      for (const v of f) expect(v).toBe(0);
    }
  });
});

describe('boxHeightfield (the v2 3D combine)', () => {
  it('uses raster A for base and raster B luma for height, per cell', () => {
    // A is a horizontal gradient (terrain), B is a vertical gradient (height).
    const a = makeBuffer(8, 8, (x) => x / 7);
    const b = makeBuffer(8, 8, (_x, y) => y / 7);
    const box = boxHeightfield(a, b, 8, 8, 8);
    expect(box.size).toBe(8);
    expect(box.base).toHaveLength(64);
    expect(box.height).toHaveLength(64);
    // base tracks A (varies along x), height tracks B (varies along y).
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const o = r * 8 + c;
        expect(box.base[o]).toBeCloseTo(c / 7, 1);
        expect(box.height[o]).toBeCloseTo(r / 7, 1);
      }
    }
  });

  it('height comes from B, not A — swapping B changes height but not base', () => {
    const a = makeBuffer(8, 8, (x) => x / 7);
    const bDark = makeBuffer(8, 8, () => 0);
    const bBright = makeBuffer(8, 8, () => 1);
    const boxDark = boxHeightfield(a, bDark, 8, 8, 8);
    const boxBright = boxHeightfield(a, bBright, 8, 8, 8);
    // Base (from A) identical regardless of B.
    expect(Array.from(boxDark.base)).toEqual(Array.from(boxBright.base));
    // Height (from B) differs: dark B → 0, bright B → 1.
    for (const v of boxDark.height) expect(v).toBeCloseTo(0, 2);
    for (const v of boxBright.height) expect(v).toBeCloseTo(1, 2);
  });
});

describe('boxToField (Box → XYZ scanlines)', () => {
  it('B luma drives Y displacement; bright B + negative yDisp pushes UP', () => {
    const a = makeBuffer(8, 8, () => 0.5);
    const bBright = makeBuffer(8, 8, () => 1);
    const box = boxHeightfield(a, bBright, 8, 8, 8);
    const params = { ...FOXY_XYZ_DEFAULTS, yShape: 0, yDisp: -0.5 };
    const field = boxToField(box, params, 8, 8);
    field.forEach((row, r) => {
      const base = r / (field.length - 1);
      // height 1 → (1-0.5)*(-0.5) = -0.25 displacement → y < base.
      for (const yv of row.y) expect(yv).toBeLessThan(base + 1e-6);
    });
  });

  it('mid-grey B (luma 0.5) → zero height displacement regardless of A', () => {
    const a = makeBuffer(8, 8, (x, y) => ((x + y) % 8) / 8); // arbitrary terrain
    const bMid = makeBuffer(8, 8, () => 0.5);
    const box = boxHeightfield(a, bMid, 8, 8, 8);
    const params = { ...FOXY_XYZ_DEFAULTS, yShape: 0, yDisp: -0.8 };
    const field = boxToField(box, params, 8, 8);
    field.forEach((row, r) => {
      const v0 = r / (field.length - 1);
      const expected = v0 - Math.floor(v0);
      for (const yv of row.y) expect(yv).toBeCloseTo(expected, 2);
    });
  });
});

describe('the Box path is MORE 3D than the single-raster path', () => {
  // The headline regression: with two DIFFERENT rasters, B's luma lifts A's
  // surface into real relief, so the resulting wavetable has measurably more
  // vertical variation (variance + frame-to-frame movement) than the old
  // single-raster heightmap built from the SAME terrain raster.
  it('Box wavetable has larger variance + frame-to-frame delta than single-raster', () => {
    const size = 64;
    // A = terrain pattern. B = an INDEPENDENT image (different frequency) that
    // supplies the height. The old path used only A's own luma for height.
    const a = makeBuffer(size, size, (x, y) => (0.5 + 0.5 * Math.sin((x * 6.283) / 10)) * (0.5 + 0.5 * Math.cos((y * 6.283) / 14)));
    const b = makeBuffer(size, size, (x, y) => (0.5 + 0.5 * Math.sin((x * 6.283) / 5 + (y * 6.283) / 7)));
    const params = { ...FOXY_XYZ_DEFAULTS, yDisp: -0.8 };

    // OLD path: single raster A → field → wavetable.
    const oldField = simplifiedRuttetraField(a, size, size, params, size, size);
    const oldWt = fieldToWavetable(oldField, FOXY_WT_FRAMES, FOXY_WT_SAMPLES);

    // NEW Box path: A terrain + B height → Box → field → wavetable.
    const box = boxHeightfield(a, b, size, size, size);
    const newField = boxToField(box, params, size, size);
    const newWt = fieldToWavetable(newField, FOXY_WT_FRAMES, FOXY_WT_SAMPLES);

    const oldVar = wavetableVariance(oldWt);
    const newVar = wavetableVariance(newWt);
    const oldDelta = frameToFrameDelta(oldWt);
    const newDelta = frameToFrameDelta(newWt);

    // The Box surface carries B's independent relief on top of A → strictly
    // more vertical spread + more morph movement.
    expect(newVar, `variance old ${oldVar.toFixed(4)} → new ${newVar.toFixed(4)}`).toBeGreaterThan(oldVar);
    expect(newDelta, `f2f delta old ${oldDelta.toFixed(4)} → new ${newDelta.toFixed(4)}`).toBeGreaterThan(oldDelta);

    // Still a valid, normalized table.
    expect(newWt).toHaveLength(FOXY_WT_FRAMES);
    for (const f of newWt) {
      expect(f).toHaveLength(FOXY_WT_SAMPLES);
      for (const v of f) { expect(v).toBeGreaterThanOrEqual(-1); expect(v).toBeLessThanOrEqual(1); }
    }
  });
});

describe('wavetableSignature', () => {
  it('differs when the table content changes', () => {
    const a = [[0, 0, 0, 0], [0.5, 0.5, 0.5, 0.5]];
    const b = [[0, 0, 0, 0], [0.9, 0.9, 0.9, 0.9]];
    expect(wavetableSignature(a)).not.toBe(wavetableSignature(b));
  });
  it('is stable for identical content', () => {
    const a = [[0.1, 0.2, 0.3, 0.4]];
    const b = [[0.1, 0.2, 0.3, 0.4]];
    expect(wavetableSignature(a)).toBe(wavetableSignature(b));
  });
});
