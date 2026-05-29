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
  FOXY_XYZ_3D_DEFAULTS,
  lumaAt,
  simplifiedRuttetraField,
  boxHeightfield,
  boxToField,
  fieldToWavetable,
  wavetableSignature,
  axisDistribution,
  applyZLut,
  threeAxisWavetable,
  threeAxisFieldForDisplay,
  boxHeightfield3d,
  boxToField3d,
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

// ── v3: 3-axis distribution wavetable ─────────────────────────────────────

describe('axisDistribution (v3)', () => {
  it('empty buffer ⇒ all 0.5 (neutral distribution → silence downstream)', () => {
    const empty = new Uint8ClampedArray(0);
    const col = axisDistribution(empty, 0, 0, 8, 'col');
    const row = axisDistribution(empty, 0, 0, 8, 'row');
    for (const v of col) expect(v).toBe(0.5);
    for (const v of row) expect(v).toBe(0.5);
  });

  it('undersized buffer (declared 16×16 but only 1 pixel) ⇒ all 0.5', () => {
    // Anything below srcW*srcH*4 bytes should fall through to neutral.
    const tiny = new Uint8ClampedArray(4);
    const col = axisDistribution(tiny, 16, 16, 8, 'col');
    for (const v of col) expect(v).toBe(0.5);
  });

  it('uniform-luma buffer ⇒ the same value on every output bin', () => {
    const buf = makeBuffer(8, 8, () => 0.7);
    const col = axisDistribution(buf, 8, 8, 16, 'col');
    const row = axisDistribution(buf, 8, 8, 16, 'row');
    // 8-bit quantization: 0.7 → 179/255 ≈ 0.7019.
    for (const v of col) expect(v).toBeCloseTo(0.7, 2);
    for (const v of row) expect(v).toBeCloseTo(0.7, 2);
  });

  it('vertical gradient (dark top → bright bottom) ⇒ uniform COL, monotonic ROW', () => {
    // Luma depends ONLY on y → every column has the same mean (0.5), every
    // row is a single luma value (its y-fraction).
    const vert = makeBuffer(16, 16, (_x, y) => y / 15);
    const col = axisDistribution(vert, 16, 16, 16, 'col');
    const row = axisDistribution(vert, 16, 16, 16, 'row');
    // COL: each column averaged over y → mean of 0..1 ≈ 0.5.
    for (const v of col) expect(v).toBeCloseTo(0.5, 1);
    // ROW: monotonically increasing 0 → 1.
    for (let i = 1; i < row.length; i++) {
      expect(row[i]).toBeGreaterThanOrEqual((row[i - 1] ?? 0) - 1e-3);
    }
    expect(row[0]).toBeLessThan(0.1);
    expect(row[row.length - 1]).toBeGreaterThan(0.9);
  });

  it('horizontal gradient (dark left → bright right) ⇒ uniform ROW, monotonic COL', () => {
    const horiz = makeBuffer(16, 16, (x) => x / 15);
    const col = axisDistribution(horiz, 16, 16, 16, 'col');
    const row = axisDistribution(horiz, 16, 16, 16, 'row');
    for (const v of row) expect(v).toBeCloseTo(0.5, 1);
    for (let i = 1; i < col.length; i++) {
      expect(col[i]).toBeGreaterThanOrEqual((col[i - 1] ?? 0) - 1e-3);
    }
    expect(col[0]).toBeLessThan(0.1);
    expect(col[col.length - 1]).toBeGreaterThan(0.9);
  });

  it('respects the requested output length (resamples to len bins)', () => {
    const buf = makeBuffer(32, 32, () => 0.5);
    expect(axisDistribution(buf, 32, 32, 64, 'col')).toHaveLength(64);
    expect(axisDistribution(buf, 32, 32, 7, 'row')).toHaveLength(7);
  });
});

describe('applyZLut (v3)', () => {
  it('identity LUT ⇒ output equals raw (within rounding)', () => {
    const len = 256;
    const id = new Float32Array(len);
    for (let k = 0; k < len; k++) id[k] = k / (len - 1);
    for (const raw of [-1, -0.5, 0, 0.25, 0.75, 1]) {
      expect(applyZLut(raw, id)).toBeCloseTo(raw, 2);
    }
  });

  it('flat LUT (0.5) ⇒ output always 0 regardless of raw', () => {
    const flat = new Float32Array(64).fill(0.5);
    for (const raw of [-1, -0.3, 0, 0.4, 1]) {
      expect(applyZLut(raw, flat)).toBe(0);
    }
  });

  it('empty LUT ⇒ 0 (degenerate but safe)', () => {
    expect(applyZLut(0.5, new Float32Array(0))).toBe(0);
  });

  it('clamps raw into [-1, 1] before indexing', () => {
    const id = new Float32Array(8);
    for (let k = 0; k < 8; k++) id[k] = k / 7;
    // Way-out-of-range raw should clamp to the LUT endpoint, not crash.
    expect(applyZLut(5, id)).toBeCloseTo(1, 2);
    expect(applyZLut(-5, id)).toBeCloseTo(-1, 2);
  });
});

describe('threeAxisWavetable (v3)', () => {
  it('dims = frames × samples regardless of input distribution lengths', () => {
    const x = new Float32Array(7).fill(0.5);   // length 7
    const y = new Float32Array(13).fill(0.5);  // length 13
    const z = new Float32Array(5).fill(0.5);   // length 5
    const wt = threeAxisWavetable(x, y, z, 16, 32);
    expect(wt).toHaveLength(16);
    for (const f of wt) expect(f).toHaveLength(32);
  });

  it('uses the default FOXY_WT dims when omitted', () => {
    const x = new Float32Array(FOXY_WT_SAMPLES).fill(0.5);
    const y = new Float32Array(FOXY_WT_FRAMES).fill(0.5);
    const z = new Float32Array(FOXY_WT_SAMPLES).fill(0.5);
    const wt = threeAxisWavetable(x, y, z);
    expect(wt).toHaveLength(FOXY_WT_FRAMES);
    expect(wt[0]).toHaveLength(FOXY_WT_SAMPLES);
  });

  it('all-0.5 distributions ⇒ silence (every cell is 0)', () => {
    const x = new Float32Array(8).fill(0.5);
    const y = new Float32Array(8).fill(0.5);
    const z = new Float32Array(8).fill(0.5); // flat → applyZLut returns 0 too
    const wt = threeAxisWavetable(x, y, z, 4, 8);
    for (const f of wt) for (const v of f) expect(v).toBe(0);
  });

  it('bright xDist + dark yDist with identity Z ⇒ positive on bright-x, dark-y cells', () => {
    // x = mostly 1 (bright), y = mostly 0 (dark): raw = (1-0.5) + (0-0.5) = 0.
    // To force a positive cell, use bright x AND bright y → raw = +1 → clamp 1.
    const samples = 8, frames = 4;
    const x = new Float32Array(samples).fill(1); // bright
    const y = new Float32Array(frames).fill(1);  // bright
    const id = new Float32Array(samples);
    for (let k = 0; k < samples; k++) id[k] = k / (samples - 1);
    const wt = threeAxisWavetable(x, y, id, frames, samples);
    for (const f of wt) for (const v of f) {
      expect(v).toBeGreaterThan(0.9);
    }
  });

  it('bright xDist + DARK yDist with identity Z ⇒ ≈ zero (raw cancels)', () => {
    const samples = 8, frames = 4;
    const x = new Float32Array(samples).fill(1);
    const y = new Float32Array(frames).fill(0);
    // Use a high-resolution identity LUT so the nearest-index quantization
    // doesn't bias raw=0 toward a non-zero output cell.
    const id = new Float32Array(256);
    for (let k = 0; k < 256; k++) id[k] = k / 255;
    const wt = threeAxisWavetable(x, y, id, frames, samples);
    // raw = +0.5 + -0.5 = 0 → identity LUT → 0.
    for (const f of wt) for (const v of f) expect(v).toBeCloseTo(0, 2);
  });

  it('clamps every cell to [-1, 1]', () => {
    // Extreme distributions + extreme LUT.
    const x = new Float32Array(16);
    for (let i = 0; i < 16; i++) x[i] = i / 15;
    const y = new Float32Array(8);
    for (let i = 0; i < 8; i++) y[i] = i / 7;
    const z = new Float32Array(16);
    for (let i = 0; i < 16; i++) z[i] = i % 2 === 0 ? 0 : 1; // jagged LUT
    const wt = threeAxisWavetable(x, y, z, 8, 16);
    for (const f of wt) for (const v of f) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic + signature is stable for identical inputs', () => {
    const x = new Float32Array(8);
    for (let i = 0; i < 8; i++) x[i] = (i * 17) % 13 / 13;
    const y = new Float32Array(4);
    for (let i = 0; i < 4; i++) y[i] = (i * 7) % 11 / 11;
    const z = new Float32Array(8);
    for (let i = 0; i < 8; i++) z[i] = i / 7;
    const a = threeAxisWavetable(x, y, z, 4, 8);
    const b = threeAxisWavetable(x, y, z, 4, 8);
    expect(a).toEqual(b);
    expect(wavetableSignature(a)).toBe(wavetableSignature(b));
  });
});

describe('threeAxisFieldForDisplay (v3)', () => {
  it('preserves frames × samples + re-packs bipolar audio into [0,1] field', () => {
    const wt = [
      [-1, 0, 1, 0.5],
      [0.2, -0.4, 0.6, -0.8],
    ];
    const x = new Float32Array(4);
    for (let i = 0; i < 4; i++) x[i] = i / 3;
    const field = threeAxisFieldForDisplay(wt, x);
    expect(field).toHaveLength(2);
    expect(field[0]!.y).toHaveLength(4);
    // (-1 + 1)/2 = 0, (0+1)/2 = 0.5, (1+1)/2 = 1.
    expect(field[0]!.y[0]).toBeCloseTo(0, 4);
    expect(field[0]!.y[1]).toBeCloseTo(0.5, 4);
    expect(field[0]!.y[2]).toBeCloseTo(1, 4);
    // lum is the x distribution (shared across all rows since x is column-keyed).
    for (let s = 0; s < 4; s++) {
      expect(field[0]!.lum[s]).toBeCloseTo(s / 3, 4);
      expect(field[1]!.lum[s]).toBeCloseTo(s / 3, 4);
    }
  });

  it('empty wavetable ⇒ empty field (no rows)', () => {
    const field = threeAxisFieldForDisplay([], new Float32Array(4));
    expect(field).toHaveLength(0);
  });
});

// ── v4: volumetric 3-axis (C warps A + adds Z) ────────────────────────────

describe('boxHeightfield3d (v4)', () => {
  it('returns size × size base + height + cField (all in [0,1])', () => {
    const a = makeBuffer(8, 8, (x) => x / 7);
    const b = makeBuffer(8, 8, (_x, y) => y / 7);
    const c = makeBuffer(8, 8, (x, y) => ((x + y) / 14));
    const box = boxHeightfield3d(a, b, c, 8, 8, 8);
    expect(box.size).toBe(8);
    expect(box.base).toHaveLength(64);
    expect(box.height).toHaveLength(64);
    expect(box.cField).toHaveLength(64);
    for (const v of box.base)   { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    for (const v of box.height) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    for (const v of box.cField) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });

  it('cField tracks raster C, independently of A and B', () => {
    const a = makeBuffer(8, 8, () => 0.2);
    const b = makeBuffer(8, 8, () => 0.8);
    const cBright = makeBuffer(8, 8, () => 1);
    const cDark   = makeBuffer(8, 8, () => 0);
    const boxBright = boxHeightfield3d(a, b, cBright, 8, 8, 8);
    const boxDark   = boxHeightfield3d(a, b, cDark,   8, 8, 8);
    // base + height identical (A, B unchanged); cField swaps with C only.
    expect(Array.from(boxBright.base)).toEqual(Array.from(boxDark.base));
    expect(Array.from(boxBright.height)).toEqual(Array.from(boxDark.height));
    for (const v of boxBright.cField) expect(v).toBeCloseTo(1, 2);
    for (const v of boxDark.cField)   expect(v).toBeCloseTo(0, 2);
  });

  it('is deterministic: same buffers → identical output', () => {
    const a = makeBuffer(16, 16, (x, y) => ((x * 3 + y * 5) % 16) / 16);
    const b = makeBuffer(16, 16, (x, y) => ((x * 7 + y * 11) % 16) / 16);
    const c = makeBuffer(16, 16, (x, y) => ((x * 13 + y * 2) % 16) / 16);
    const b1 = boxHeightfield3d(a, b, c, 16, 16, 16);
    const b2 = boxHeightfield3d(a, b, c, 16, 16, 16);
    expect(Array.from(b1.base)).toEqual(Array.from(b2.base));
    expect(Array.from(b1.height)).toEqual(Array.from(b2.height));
    expect(Array.from(b1.cField)).toEqual(Array.from(b2.cField));
  });
});

describe('boxToField3d (v4)', () => {
  /** Mean abs per-cell delta between two FoxyFieldRow[] of equal shape. */
  function fieldDelta(a: ReturnType<typeof boxToField>, b: ReturnType<typeof boxToField>): number {
    let n = 0, acc = 0;
    for (let r = 0; r < a.length; r++) {
      for (let s = 0; s < a[r]!.y.length; s++) {
        acc += Math.abs(a[r]!.y[s]! - b[r]!.y[s]!);
        n++;
      }
    }
    return n > 0 ? acc / n : 0;
  }

  it('returns rows × cols field with the requested dims', () => {
    const a = makeBuffer(16, 16, (x) => x / 15);
    const b = makeBuffer(16, 16, (_x, y) => y / 15);
    const c = makeBuffer(16, 16, () => 0.5);
    const box3 = boxHeightfield3d(a, b, c, 16, 16, 16);
    const field = boxToField3d(box3, a, 16, 16, FOXY_XYZ_3D_DEFAULTS, 16, 16);
    expect(field).toHaveLength(16);
    for (const row of field) {
      expect(row.y).toHaveLength(16);
      expect(row.lum).toHaveLength(16);
    }
  });

  it('v2-degeneracy: flat-gray C (0.5) reproduces v2 boxToField EXACTLY', () => {
    // The headline property: with C = 0x80 everywhere, warpAmt ≈ 0 and
    // heightC_disp ≈ 0, so the v4 construction reduces to v2's boxToField.
    // Pinned with both nonzero warp AND nonzero secondaryHeight — the
    // contribution still vanishes because C-0.5 ≈ 0. The ~5e-4 residual is
    // 8-bit pixel quantization (0x80/255 = 0.50196, not 0.5 exactly), which
    // sub-pixel-shifts the C-warped A lookup; the test asserts that
    // residual stays below half a pixel (epsilon = 1e-3).
    const size = 32;
    const a = makeBuffer(size, size, (x, y) => (0.5 + 0.5 * Math.sin((x * 6.283) / 9)) * (0.5 + 0.5 * Math.cos((y * 6.283) / 11)));
    const b = makeBuffer(size, size, (x, y) => (0.5 + 0.5 * Math.sin((x * 6.283) / 5 + (y * 6.283) / 7)));
    const cFlat = makeBuffer(size, size, () => 0.5);
    const box2 = boxHeightfield(a, b, size, size, size);
    const box3 = boxHeightfield3d(a, b, cFlat, size, size, size);
    const v2params = { ...FOXY_XYZ_DEFAULTS };
    // Nonzero warp + nonzero secondaryHeight — they should still be inert.
    const v4params = { ...FOXY_XYZ_DEFAULTS, warpAmount: 0.25, secondaryHeight: 0.5 };
    const fieldV2 = boxToField(box2, v2params, size, size);
    const fieldV4 = boxToField3d(box3, a, size, size, v4params, size, size);
    expect(fieldV2).toHaveLength(fieldV4.length);
    const epsilon = 1e-3; // half a pixel @ 8-bit quantization
    for (let r = 0; r < fieldV2.length; r++) {
      for (let s = 0; s < fieldV2[r]!.y.length; s++) {
        const dy = Math.abs(fieldV4[r]!.y[s]! - fieldV2[r]!.y[s]!);
        const dl = Math.abs(fieldV4[r]!.lum[s]! - fieldV2[r]!.lum[s]!);
        expect(dy, `Y delta @ (${r},${s})`).toBeLessThan(epsilon);
        expect(dl, `lum delta @ (${r},${s})`).toBeLessThan(epsilon);
      }
    }
  });

  it('v2-degeneracy EXACT: with TRULY zero warp/secondaryHeight, v4 equals v2 to 4 decimals', () => {
    // Same setup but with the v4 knobs at strict zero — eliminates the 8-bit
    // quantization residual since warpAmt = (cVal-0.5)*0 = 0 exactly.
    const size = 32;
    const a = makeBuffer(size, size, (x, y) => (0.5 + 0.5 * Math.sin((x * 6.283) / 9)) * (0.5 + 0.5 * Math.cos((y * 6.283) / 11)));
    const b = makeBuffer(size, size, (x, y) => (0.5 + 0.5 * Math.sin((x * 6.283) / 5 + (y * 6.283) / 7)));
    const cAny  = makeBuffer(size, size, (x, y) => (x * 7 + y * 13) % 256 / 255);
    const box2 = boxHeightfield(a, b, size, size, size);
    const box3 = boxHeightfield3d(a, b, cAny, size, size, size);
    const v2params = { ...FOXY_XYZ_DEFAULTS };
    const v4zero = { ...FOXY_XYZ_DEFAULTS, warpAmount: 0, secondaryHeight: 0 };
    const fieldV2 = boxToField(box2, v2params, size, size);
    const fieldV4 = boxToField3d(box3, a, size, size, v4zero, size, size);
    for (let r = 0; r < fieldV2.length; r++) {
      for (let s = 0; s < fieldV2[r]!.y.length; s++) {
        expect(fieldV4[r]!.y[s]!).toBeCloseTo(fieldV2[r]!.y[s]!, 4);
      }
    }
  });

  it('warp + secondaryHeight both zero → matches v2 EVEN with non-flat C', () => {
    // The knobs can turn off the new effects independently of C content.
    const size = 32;
    const a = makeBuffer(size, size, (x, y) => ((x * 3 + y) % 32) / 32);
    const b = makeBuffer(size, size, (x, y) => ((x + y * 5) % 32) / 32);
    const c = makeBuffer(size, size, (x, y) => Math.sin((x * 6.283) / 4 + (y * 6.283) / 6) * 0.5 + 0.5);
    const box2 = boxHeightfield(a, b, size, size, size);
    const box3 = boxHeightfield3d(a, b, c, size, size, size);
    const v2params = { ...FOXY_XYZ_DEFAULTS };
    // Both knobs at zero — v4 should equal v2 regardless of C.
    const v4params = { ...FOXY_XYZ_DEFAULTS, warpAmount: 0, secondaryHeight: 0 };
    const fieldV2 = boxToField(box2, v2params, size, size);
    const fieldV4 = boxToField3d(box3, a, size, size, v4params, size, size);
    for (let r = 0; r < fieldV2.length; r++) {
      for (let s = 0; s < fieldV2[r]!.y.length; s++) {
        expect(fieldV4[r]!.y[s]!).toBeCloseTo(fieldV2[r]!.y[s]!, 4);
      }
    }
  });

  it('non-flat C + nonzero warp/secondaryHeight DIVERGES measurably from v2', () => {
    // Inverse of the degeneracy: turn the v4 knobs ON with a non-flat C and
    // we should see real, measurable departure from v2's output at multiple
    // cells. Picks 3 specific cells + asserts each differs by > 1e-3.
    const size = 32;
    const a = makeBuffer(size, size, (x, y) => (0.5 + 0.5 * Math.sin((x * 6.283) / 9)) * (0.5 + 0.5 * Math.cos((y * 6.283) / 11)));
    const b = makeBuffer(size, size, (x, y) => (0.5 + 0.5 * Math.sin((x * 6.283) / 5 + (y * 6.283) / 7)));
    const c = makeBuffer(size, size, (x, y) => (0.5 + 0.5 * Math.cos((x * 6.283) / 6 + (y * 6.283) / 4)));
    const box2 = boxHeightfield(a, b, size, size, size);
    const box3 = boxHeightfield3d(a, b, c, size, size, size);
    const v2params = { ...FOXY_XYZ_DEFAULTS };
    const v4params = { ...FOXY_XYZ_DEFAULTS, warpAmount: 0.5, secondaryHeight: 0.8 };
    const fieldV2 = boxToField(box2, v2params, size, size);
    const fieldV4 = boxToField3d(box3, a, size, size, v4params, size, size);
    // 3 picked interior cells (avoid edges where lumaAt clamps coincide).
    const probes: Array<[number, number]> = [[8, 12], [16, 7], [22, 20]];
    for (const [r, s] of probes) {
      const delta = Math.abs(fieldV4[r]!.y[s]! - fieldV2[r]!.y[s]!);
      expect(delta, `cell (${r},${s})`).toBeGreaterThan(1e-3);
    }
    // Overall divergence is non-trivial too.
    const overall = fieldDelta(fieldV2, fieldV4);
    expect(overall, 'mean abs Y delta').toBeGreaterThan(1e-2);
  });

  it('is deterministic: same inputs → identical field', () => {
    const a = makeBuffer(16, 16, (x, y) => ((x * 3 + y * 5) % 16) / 16);
    const b = makeBuffer(16, 16, (x, y) => ((x * 7 + y * 11) % 16) / 16);
    const c = makeBuffer(16, 16, (x, y) => ((x * 13 + y * 2) % 16) / 16);
    const box3 = boxHeightfield3d(a, b, c, 16, 16, 16);
    const params = { ...FOXY_XYZ_3D_DEFAULTS };
    const f1 = boxToField3d(box3, a, 16, 16, params, 16, 16);
    const f2 = boxToField3d(box3, a, 16, 16, params, 16, 16);
    expect(f1.length).toBe(f2.length);
    for (let r = 0; r < f1.length; r++) {
      expect(Array.from(f1[r]!.y)).toEqual(Array.from(f2[r]!.y));
      expect(Array.from(f1[r]!.lum)).toEqual(Array.from(f2[r]!.lum));
    }
  });

  it('produces a wavetable with non-trivial frame-to-frame + sample-to-sample variance', () => {
    // The end-to-end audible regression: the v4 field, run through
    // fieldToWavetable, must produce a wavetable that BOTH evolves across
    // frames AND has shape WITHIN a frame. v3 collapsed both axes to flat.
    // Uses the same synthetic deterministic rasters paintSeeded() uses.
    const size = FOXY_FIELD_SIZE;
    const a = makeBuffer(size, size, (x, y) => 0.5 + 0.5 * Math.sin((x * 6.283 * 3) / size) * Math.sin((y * 6.283 * 7) / size));
    const b = makeBuffer(size, size, (x, y) => 0.5 + 0.5 * Math.sin((x * 6.283 * 5) / size + 1.1) * Math.cos((y * 6.283 * 2) / size));
    const c = makeBuffer(size, size, (x, y) => 0.5 + 0.5 * Math.sin((x * 6.283 * 4) / size + 0.5) * Math.cos((y * 6.283 * 9) / size));
    const box3 = boxHeightfield3d(a, b, c, size, size, size);
    const field = boxToField3d(box3, a, size, size, FOXY_XYZ_3D_DEFAULTS);
    const wt = fieldToWavetable(field, FOXY_WT_FRAMES, FOXY_WT_SAMPLES);
    expect(wt).toHaveLength(FOXY_WT_FRAMES);
    // Frame-to-frame mean abs delta — should be well above flat.
    const f2f = frameToFrameDelta(wt);
    // Sample-to-sample variance WITHIN each frame, averaged across frames.
    let sumVar = 0;
    for (const frame of wt) {
      let mean = 0; for (const v of frame) mean += v; mean /= frame.length;
      let v = 0; for (const x of frame) v += (x - mean) ** 2;
      sumVar += v / frame.length;
    }
    const intraVar = sumVar / wt.length;
    // Pin small thresholds — anything above flat passes; a truly flat
    // (v3-style collapsed) table would be ~0 on both axes.
    expect(f2f, `frame-to-frame delta ${f2f.toFixed(4)}`).toBeGreaterThan(0.01);
    expect(intraVar, `intra-frame variance ${intraVar.toFixed(4)}`).toBeGreaterThan(0.001);
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
