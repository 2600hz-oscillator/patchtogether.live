// packages/web/src/lib/video/modules/cellshade.test.ts
//
// CELLSHADE module-def shape + the pure cel-shade pipeline (no GL):
//   - BITS knob snaps to the 5 colour-depth steps (1/2/4/8/16 bit →
//     2/4/16/256/65536 colours);
//   - a synthetic gradient quantizes to the expected # of distinct
//     bands/colours at each bit setting;
//   - edges appear as DARK (black-ink) lines where contrast is high;
//   - THRESHOLD / THICKNESS behave like EDGES (shared mirror).
//
// The pure functions (cellshadeQuantize / cellshadePixel / the bit helpers)
// are the EXACT CPU mirror of the GLSL shader's math — the same source-of-
// truth pattern EDGES / FREEZEFRAME use for their shader logic.

import { describe, it, expect } from 'vitest';
import {
  cellshadeDef,
  cellshadeBitsIndex,
  cellshadeBitDepth,
  cellshadeColorCount,
  cellshadeQuantize,
  cellshadePixel,
  cellshadeLuma,
  rgbToHsv,
  hsvToRgb,
  quantizeUnit,
  CELLSHADE_BIT_STEPS,
  CELLSHADE_DEFAULTS,
  CELLSHADE_DEFAULT_BITS_INDEX,
} from './cellshade';
import { EDGES_MAX_THICKNESS } from './edges';

// ---------------------------------------------------------------------------
// Def shape
// ---------------------------------------------------------------------------
describe('cellshadeDef shape', () => {
  it('is a video PROCESSOR: exactly one video input (in) → one video out', () => {
    const videoInputs = cellshadeDef.inputs.filter((p) => p.type === 'video');
    expect(videoInputs.map((p) => p.id)).toEqual(['in']);
    expect(cellshadeDef.outputs.map((o) => o.id)).toEqual(['out']);
    expect(cellshadeDef.outputs[0]!.type).toBe('video');
  });

  it('lowercase label, video domain, effects category', () => {
    expect(cellshadeDef.label).toBe('cellshade');
    expect(cellshadeDef.domain).toBe('video');
    expect(cellshadeDef.category).toBe('effects');
  });

  it('declares threshold + thickness + bits params', () => {
    const ids = cellshadeDef.params.map((p) => p.id).sort();
    expect(ids).toEqual(['bits', 'thickness', 'threshold']);
  });

  it('declares a CV input mirroring every modulatable param (paramTarget == id)', () => {
    const inputIds = cellshadeDef.inputs.map((p) => p.id);
    expect(inputIds).toContain('in');
    for (const p of ['threshold', 'thickness', 'bits'] as const) {
      expect(inputIds, `missing cv input for ${p}`).toContain(p);
    }
    for (const port of cellshadeDef.inputs.filter((i) => i.type === 'cv')) {
      expect(port.paramTarget, `cv input ${port.id} paramTarget`).toBe(port.id);
    }
  });

  it('bits CV input uses a DISCRETE cvScale (snaps to the 5 steps)', () => {
    const bitsIn = cellshadeDef.inputs.find((i) => i.id === 'bits');
    expect(bitsIn?.cvScale?.mode).toBe('discrete');
  });

  it('threshold spans 0..1 (default 0.2), matching EDGES', () => {
    const t = cellshadeDef.params.find((p) => p.id === 'threshold');
    expect([t?.min, t?.max, t?.defaultValue]).toEqual([0, 1, 0.2]);
    expect(t?.defaultValue).toBe(CELLSHADE_DEFAULTS.threshold);
  });

  it('thickness spans 1..EDGES_MAX_THICKNESS px (default 2), matching EDGES', () => {
    const w = cellshadeDef.params.find((p) => p.id === 'thickness');
    expect([w?.min, w?.max, w?.defaultValue]).toEqual([1, EDGES_MAX_THICKNESS, 2]);
    expect(w?.curve).toBe('linear');
  });

  it('bits is a DISCRETE 0..4 step index (default = 4-bit / 16 colours)', () => {
    const b = cellshadeDef.params.find((p) => p.id === 'bits');
    expect(b?.curve).toBe('discrete');
    expect(b?.min).toBe(0);
    expect(b?.max).toBe(CELLSHADE_BIT_STEPS.length - 1);
    expect(b?.max).toBe(4);
    expect(b?.defaultValue).toBe(CELLSHADE_DEFAULT_BITS_INDEX);
    expect(cellshadeBitDepth(b!.defaultValue)).toBe(4);
    expect(cellshadeColorCount(b!.defaultValue)).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// BITS knob: snaps to 1 / 2 / 4 / 8 / 16-bit colour depth.
// ---------------------------------------------------------------------------
describe('BITS knob snaps to the 5 colour-depth steps', () => {
  it('the 5 steps are exactly 1/2/4/8/16 bit → 2/4/16/256/65536 colours', () => {
    expect(CELLSHADE_BIT_STEPS.map((s) => s.bits)).toEqual([1, 2, 4, 8, 16]);
    expect(CELLSHADE_BIT_STEPS.map((s) => s.colors)).toEqual([2, 4, 16, 256, 65536]);
  });

  it('index → bit value (each step index maps to its bit depth)', () => {
    expect(cellshadeBitDepth(0)).toBe(1);
    expect(cellshadeBitDepth(1)).toBe(2);
    expect(cellshadeBitDepth(2)).toBe(4);
    expect(cellshadeBitDepth(3)).toBe(8);
    expect(cellshadeBitDepth(4)).toBe(16);
  });

  it('index → total colour count', () => {
    expect(CELLSHADE_BIT_STEPS.map((_, i) => cellshadeColorCount(i)))
      .toEqual([2, 4, 16, 256, 65536]);
  });

  it('a FRACTIONAL bits value (e.g. from a CV write) snaps to the nearest step', () => {
    // 1.4 → round → idx 1 (2-bit); 1.6 → idx 2 (4-bit); 2.5 → idx 3 (8-bit).
    expect(cellshadeBitsIndex(1.4)).toBe(1);
    expect(cellshadeBitsIndex(1.6)).toBe(2);
    expect(cellshadeBitsIndex(2.5)).toBe(3);
    // and out-of-range clamps to the valid 0..4 step index.
    expect(cellshadeBitsIndex(-3)).toBe(0);
    expect(cellshadeBitsIndex(99)).toBe(4);
    // non-finite falls back to the default index.
    expect(cellshadeBitsIndex(NaN)).toBe(CELLSHADE_DEFAULT_BITS_INDEX);
  });
});

// ---------------------------------------------------------------------------
// Colour-space round-trip (the HSV helpers the luma-band path relies on).
// ---------------------------------------------------------------------------
describe('rgbToHsv / hsvToRgb round-trip', () => {
  const samples: [number, number, number][] = [
    [0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [0.5, 0.25, 0.75], [0.2, 0.8, 0.4], [0.9, 0.9, 0.1],
  ];
  for (const [r, g, b] of samples) {
    it(`(${r},${g},${b}) survives RGB→HSV→RGB`, () => {
      const [h, s, v] = rgbToHsv(r, g, b);
      const [r2, g2, b2] = hsvToRgb(h, s, v);
      expect(r2).toBeCloseTo(r, 5);
      expect(g2).toBeCloseTo(g, 5);
      expect(b2).toBeCloseTo(b, 5);
    });
  }

  it('quantizeUnit posterizes 0..1 to N evenly-spaced steps', () => {
    // 2 levels → {0, 1}; 4 levels → {0, 1/3, 2/3, 1}.
    expect(quantizeUnit(0.1, 2)).toBe(0);
    expect(quantizeUnit(0.9, 2)).toBe(1);
    expect(quantizeUnit(0.0, 4)).toBe(0);
    expect(quantizeUnit(0.99, 4)).toBeCloseTo(1, 5);
    // distinct outputs over a ramp == the level count.
    const distinct = new Set(
      Array.from({ length: 50 }, (_, i) => quantizeUnit(i / 49, 4)),
    );
    expect(distinct.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Quantization: a synthetic gradient → the expected # of bands/colours.
// ---------------------------------------------------------------------------
describe('cellshadeQuantize — gradient yields the expected distinct bands', () => {
  // A GREYSCALE luminance ramp: the cleanest probe for the luma-band path
  // (hue/sat are undefined for grey, so V is the only varying dimension →
  // distinct outputs == the V-band count for the low depths).
  function greyRampDistinct(bitsIndex: number, n = 256): number {
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const [r, g, b] = cellshadeQuantize(t, t, t, bitsIndex);
      seen.add(`${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)}`);
    }
    return seen.size;
  }

  it('1-bit (idx 0): a grey ramp collapses to 2 tonal bands', () => {
    expect(greyRampDistinct(0)).toBe(2);
  });

  it('2-bit (idx 1): a grey ramp collapses to 4 tonal bands', () => {
    expect(greyRampDistinct(1)).toBe(4);
  });

  it('4-bit (idx 2): a grey ramp collapses to 6 luma bands (the 16-colour budget)', () => {
    // The 16-colour budget spends most of its budget on luminance bands
    // (6 V bands); on a pure grey ramp hue/sat don't vary so we see 6.
    expect(greyRampDistinct(2)).toBe(6);
  });

  it('lower BITS yields FEWER distinct tones than higher BITS (monotonic)', () => {
    const oneBit = greyRampDistinct(0);
    const twoBit = greyRampDistinct(1);
    const fourBit = greyRampDistinct(2);
    const eightBit = greyRampDistinct(3);
    expect(oneBit).toBeLessThan(twoBit);
    expect(twoBit).toBeLessThan(fourBit);
    expect(fourBit).toBeLessThan(eightBit);
  });

  it('8-bit (idx 3) uses RGB 3-3-2: 8 R, 8 G, 4 B levels on a per-channel ramp', () => {
    const distinctOnChannel = (channel: 0 | 1 | 2): number => {
      const seen = new Set<number>();
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        const rgb: [number, number, number] = [0, 0, 0];
        rgb[channel] = t;
        const out = cellshadeQuantize(rgb[0], rgb[1], rgb[2], 3);
        seen.add(Math.round(out[channel] * 10000));
      }
      return seen.size;
    };
    expect(distinctOnChannel(0)).toBe(8); // R: 3 bits → 8 levels
    expect(distinctOnChannel(1)).toBe(8); // G: 3 bits → 8 levels
    expect(distinctOnChannel(2)).toBe(4); // B: 2 bits → 4 levels
  });

  it('16-bit (idx 4) uses RGB 5-6-5: 32 R, 64 G, 32 B levels per-channel', () => {
    const distinctOnChannel = (channel: 0 | 1 | 2): number => {
      const seen = new Set<number>();
      for (let i = 0; i < 512; i++) {
        const t = i / 511;
        const rgb: [number, number, number] = [0, 0, 0];
        rgb[channel] = t;
        const out = cellshadeQuantize(rgb[0], rgb[1], rgb[2], 4);
        seen.add(Math.round(out[channel] * 100000));
      }
      return seen.size;
    };
    expect(distinctOnChannel(0)).toBe(32); // R: 5 bits → 32 levels
    expect(distinctOnChannel(1)).toBe(64); // G: 6 bits → 64 levels
    expect(distinctOnChannel(2)).toBe(32); // B: 5 bits → 32 levels
  });

  it('luma-band path PRESERVES hue (a red stays red-ish, not channel-clipped)', () => {
    // A mid-bright saturated red. Naive per-channel floor at 2 levels would
    // crush it to (1,0,0) or (0,0,0); the luma-band path keeps the hue and
    // just snaps the brightness band, so the OUTPUT hue ≈ the input hue.
    const [hIn] = rgbToHsv(0.7, 0.1, 0.1);
    const [or, og, ob] = cellshadeQuantize(0.7, 0.1, 0.1, 0); // 1-bit
    // not black (it's a visible band), and red is the dominant channel.
    expect(or + og + ob).toBeGreaterThan(0);
    expect(or).toBeGreaterThan(og);
    expect(or).toBeGreaterThan(ob);
    const [hOut] = rgbToHsv(or, og, ob);
    // hue preserved within a small tolerance (1-bit keeps H/S exactly).
    expect(Math.abs(hOut - hIn)).toBeLessThan(0.02);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: edges appear as DARK ink lines where contrast is high.
// ---------------------------------------------------------------------------
describe('cellshadePixel — black-ink edges over quantized colour', () => {
  // Build a small RGB grid: left half mid-grey, right half white. The
  // vertical boundary down the middle is a high-contrast edge.
  const W = 16, H = 8;
  function splitGrid(): Float32Array {
    const g = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = x < W / 2 ? 0.3 : 1.0;
        const i = (y * W + x) * 3;
        g[i] = v; g[i + 1] = v; g[i + 2] = v;
      }
    }
    return g;
  }
  const grid = splitGrid();

  it('a pixel ON the high-contrast boundary is inked BLACK', () => {
    // x = W/2 - 1 and W/2 straddle the boundary → an edge.
    const onEdge = cellshadePixel(W, H, grid, W / 2 - 1, H / 2, 0.2, 2, 3);
    expect(onEdge).toEqual([0, 0, 0]);
  });

  it('a pixel in the FLAT interior is NOT inked (keeps its quantized colour)', () => {
    const flat = cellshadePixel(W, H, grid, 1, H / 2, 0.2, 2, 3);
    // 8-bit quantize of (0.3,0.3,0.3) is non-black grey, and not inked.
    expect(flat[0] + flat[1] + flat[2]).toBeGreaterThan(0);
  });

  it('the interior colour equals the pure quantization (no ink applied)', () => {
    const flat = cellshadePixel(W, H, grid, 1, H / 2, 0.2, 2, 3);
    const quant = cellshadeQuantize(0.3, 0.3, 0.3, 3);
    expect(flat[0]).toBeCloseTo(quant[0], 6);
    expect(flat[1]).toBeCloseTo(quant[1], 6);
    expect(flat[2]).toBeCloseTo(quant[2], 6);
  });

  // Count inked (black) pixels across the whole grid for given EDGES params.
  function inkedCount(threshold: number, thickness: number): number {
    let n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = cellshadePixel(W, H, grid, x, y, threshold, thickness, 3);
        if (r === 0 && g === 0 && b === 0) n++;
      }
    }
    return n;
  }

  it('THRESHOLD behaves like EDGES: raising it inks FEWER (or equal) pixels', () => {
    const low = inkedCount(0.1, 2);
    const high = inkedCount(0.9, 2);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThanOrEqual(low);
  });

  it('THICKNESS behaves like EDGES: raising it inks MORE (wider) pixels', () => {
    const thin = inkedCount(0.2, 1);
    const thick = inkedCount(0.2, 4);
    expect(thin).toBeGreaterThan(0);
    expect(thick).toBeGreaterThan(thin);
  });

  it('a FLAT (no-contrast) grid inks NOTHING at any threshold', () => {
    const flatGrid = new Float32Array(W * H * 3).fill(0.5);
    let inked = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = cellshadePixel(W, H, flatGrid, x, y, 0.05, 4, 3);
        if (r === 0 && g === 0 && b === 0) inked++;
      }
    }
    expect(inked).toBe(0);
  });

  it('lowering BITS on the flat region reduces the distinct interior colours', () => {
    // Sample a horizontal ramp interior (no edges) at 8-bit vs 1-bit and
    // confirm fewer distinct colours at the lower depth.
    const ramp = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = x / (W - 1);
        const i = (y * W + x) * 3;
        ramp[i] = v; ramp[i + 1] = v; ramp[i + 2] = v;
      }
    }
    const distinctAt = (bitsIdx: number): number => {
      const seen = new Set<string>();
      // sample the middle row interior only, away from the left/right walls
      // where the ramp slope could read as an edge.
      for (let x = 2; x < W - 2; x++) {
        const [r, g, b] = cellshadePixel(W, H, ramp, x, H / 2, 0.95, 1, bitsIdx);
        seen.add(`${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)}`);
      }
      return seen.size;
    };
    expect(distinctAt(0)).toBeLessThanOrEqual(distinctAt(3));
  });
});

// ---------------------------------------------------------------------------
// luma consistency with EDGES.
// ---------------------------------------------------------------------------
describe('cellshadeLuma matches the EDGES Rec.601 weights', () => {
  it('white → 1, black → 0, and a known triple', () => {
    expect(cellshadeLuma(1, 1, 1)).toBeCloseTo(1, 6);
    expect(cellshadeLuma(0, 0, 0)).toBe(0);
    expect(cellshadeLuma(1, 0, 0)).toBeCloseTo(0.299, 6);
    expect(cellshadeLuma(0, 1, 0)).toBeCloseTo(0.587, 6);
    expect(cellshadeLuma(0, 0, 1)).toBeCloseTo(0.114, 6);
  });
});
