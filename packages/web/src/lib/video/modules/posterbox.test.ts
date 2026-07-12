// packages/web/src/lib/video/modules/posterbox.test.ts
//
// POSTERBOX module-def shape + the pure palette-crush pipeline (no GL):
//   - DEPTH knob snaps to the 5 bit-allocation steps (1-1-1 / 2-2-2 /
//     3-3-2 / 4-4-4 / 5-6-5 → 8/64/256/4096/65536 colours);
//   - LEGACY CONTINUITY: at dither 0 the quantizer is BYTE-EXACT the old
//     CELLSHADE retro path (floor(v*n)/(n-1) with 8/8/4 and 32/64/32
//     allocations) — pinned against a verbatim copy of the legacy
//     quantizeUnit + literal 8-bit anchors (gray 0.2 → (36,36,0) etc.);
//   - DITHER: Bayer 4×4 ordered dither — 5-point monotone flip proof,
//     band edges dissolve into alternating checkered pixels at 1.0;
//   - MIX: linear dry/wet — 5-point proof.
//
// The pure functions (posterboxCrush / posterboxPixel / the depth + Bayer
// helpers) are the EXACT CPU mirror of the GLSL shader's math — the same
// source-of-truth pattern EDGES / MAPPER / CELLSHADE use.
//
// NOTE: the legacy reference quantizer below is deliberately a VERBATIM
// COPY of origin/main cellshade.ts quantizeUnit, NOT an import — the
// CELLSHADE rebuild (#1066) deletes the retro per-channel paths from that
// module, and POSTERBOX must not couple to it.

import { describe, it, expect } from 'vitest';
import {
  posterboxDef,
  posterboxDepthIndex,
  posterboxLevels,
  posterboxColorCount,
  posterboxBitDepth,
  posterboxBayerThreshold,
  posterboxQuantizeChannel,
  posterboxCrush,
  posterboxPixel,
  POSTERBOX_DEPTH_STEPS,
  POSTERBOX_BAYER4,
  POSTERBOX_DEFAULTS,
  POSTERBOX_DEFAULT_DEPTH_INDEX,
} from './posterbox';

/** VERBATIM copy of the legacy CELLSHADE quantizeUnit (origin/main) — the
 *  continuity reference the dither-0 path must match bit-for-bit. */
function legacyQuantizeUnit(value: number, levels: number): number {
  const v = Math.min(1, Math.max(0, value));
  const n = Math.max(2, Math.round(levels));
  const idx = Math.min(n - 1, Math.floor(v * n));
  return idx / (n - 1);
}

/** 0..1 → the 8-bit code value a probe would read (round-half-up). */
function toByte(v: number): number {
  return Math.round(v * 255);
}

// ---------------------------------------------------------------------------
// Def shape
// ---------------------------------------------------------------------------
describe('posterboxDef shape', () => {
  it('depth is a DISCRETE 0..4 step index (default = 3-3-2 / 256 colours)', () => {
    const d = posterboxDef.params.find((p) => p.id === 'depth');
    expect(d?.curve).toBe('discrete');
    expect(d?.min).toBe(0);
    expect(d?.max).toBe(POSTERBOX_DEPTH_STEPS.length - 1);
    expect(d?.max).toBe(4);
    expect(d?.defaultValue).toBe(POSTERBOX_DEFAULT_DEPTH_INDEX);
    expect(posterboxColorCount(d!.defaultValue)).toBe(256);
    expect(posterboxBitDepth(d!.defaultValue)).toBe(8);
  });

  it('dither spans 0..1 linear (default 0 = hard bands, the pure legacy crush)', () => {
    const p = posterboxDef.params.find((p) => p.id === 'dither');
    expect([p?.min, p?.max, p?.defaultValue]).toEqual([0, 1, 0]);
    expect(p?.curve).toBe('linear');
  });

  it('mix spans 0..1 linear (default 1 = full crush)', () => {
    const p = posterboxDef.params.find((p) => p.id === 'mix');
    expect([p?.min, p?.max, p?.defaultValue]).toEqual([0, 1, 1]);
    expect(p?.curve).toBe('linear');
  });

  it('label is lowercase and CV ports target their params (depth discrete)', () => {
    expect(posterboxDef.label).toBe('posterbox');
    const depth = posterboxDef.inputs.find((i) => i.id === 'depth');
    const dither = posterboxDef.inputs.find((i) => i.id === 'dither');
    const mix = posterboxDef.inputs.find((i) => i.id === 'mix');
    expect(depth?.paramTarget).toBe('depth');
    expect(depth?.cvScale?.mode).toBe('discrete');
    expect(dither?.paramTarget).toBe('dither');
    expect(dither?.cvScale?.mode).toBe('linear');
    expect(mix?.paramTarget).toBe('mix');
    expect(mix?.cvScale?.mode).toBe('linear');
  });
});

// ---------------------------------------------------------------------------
// DEPTH ladder: 5 discrete steps, each a real per-channel allocation.
// ---------------------------------------------------------------------------
describe('DEPTH knob snaps to the 5 bit-allocation steps', () => {
  it('the 5 steps are exactly 1-1-1 / 2-2-2 / 3-3-2 / 4-4-4 / 5-6-5', () => {
    expect(POSTERBOX_DEPTH_STEPS.map((s) => s.bits)).toEqual([
      [1, 1, 1], [2, 2, 2], [3, 3, 2], [4, 4, 4], [5, 6, 5],
    ]);
    expect(POSTERBOX_DEPTH_STEPS.map((s) => s.colors)).toEqual([8, 64, 256, 4096, 65536]);
  });

  it('levels are 2^bits per channel, and colors is their product', () => {
    for (const step of POSTERBOX_DEPTH_STEPS) {
      expect(step.levels).toEqual(step.bits.map((b) => 2 ** b));
      expect(step.levels[0] * step.levels[1] * step.levels[2]).toBe(step.colors);
    }
  });

  it('index → total bit depth (3/6/8/12/16)', () => {
    expect([0, 1, 2, 3, 4].map(posterboxBitDepth)).toEqual([3, 6, 8, 12, 16]);
  });

  it('a FRACTIONAL depth value (e.g. from a CV write) snaps to the nearest step', () => {
    expect(posterboxDepthIndex(1.4)).toBe(1);
    expect(posterboxDepthIndex(1.6)).toBe(2);
    expect(posterboxDepthIndex(2.5)).toBe(3);
    // out-of-range clamps to the valid 0..4 step index.
    expect(posterboxDepthIndex(-3)).toBe(0);
    expect(posterboxDepthIndex(99)).toBe(4);
    // non-finite falls back to the default index.
    expect(posterboxDepthIndex(NaN)).toBe(POSTERBOX_DEFAULT_DEPTH_INDEX);
  });

  it('per-channel level counts on single-channel ramps match every allocation', () => {
    const distinctOnChannel = (depth: number, channel: 0 | 1 | 2): number => {
      const seen = new Set<number>();
      for (let i = 0; i < 1024; i++) {
        const t = i / 1023;
        const rgb: [number, number, number] = [0, 0, 0];
        rgb[channel] = t;
        const out = posterboxCrush(rgb[0], rgb[1], rgb[2], 0, 0, depth, 0);
        seen.add(Math.round(out[channel] * 100000));
      }
      return seen.size;
    };
    for (let depth = 0; depth < POSTERBOX_DEPTH_STEPS.length; depth++) {
      const { levels } = POSTERBOX_DEPTH_STEPS[depth]!;
      expect(distinctOnChannel(depth, 0), `depth ${depth} R`).toBe(levels[0]);
      expect(distinctOnChannel(depth, 1), `depth ${depth} G`).toBe(levels[1]);
      expect(distinctOnChannel(depth, 2), `depth ${depth} B`).toBe(levels[2]);
    }
  });

  it('5-POINT RANGE PROOF: distinct colours on a gray ramp strictly climb across all 5 steps', () => {
    const grayRampDistinct = (depth: number): number => {
      const seen = new Set<string>();
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        const [r, g, b] = posterboxCrush(t, t, t, 0, 0, depth, 0);
        seen.add(`${r.toFixed(5)},${g.toFixed(5)},${b.toFixed(5)}`);
      }
      return seen.size;
    };
    const counts = [0, 1, 2, 3, 4].map(grayRampDistinct);
    // 2 / 4 / 8 (R-G grid dominates 3-3-2 on gray) / 16 / 64 (G's 6 bits).
    expect(counts).toEqual([2, 4, 8, 16, 64]);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!, `step ${i} adds colours`).toBeGreaterThan(counts[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// LEGACY CONTINUITY: dither 0 == the old CELLSHADE retro quantizer, byte-exact.
// ---------------------------------------------------------------------------
describe('legacy continuity — dither 0 is byte-exact the old CELLSHADE retro path', () => {
  it('posterboxQuantizeChannel(v, n, t, 0) === legacy quantizeUnit(v, n) for every level count, densely', () => {
    for (const n of [2, 4, 8, 16, 32, 64]) {
      for (let i = 0; i <= 1000; i++) {
        const v = i / 1000;
        // bayerT must be irrelevant at dither 0 — check two extremes.
        expect(posterboxQuantizeChannel(v, n, 0.03125, 0)).toBe(legacyQuantizeUnit(v, n));
        expect(posterboxQuantizeChannel(v, n, 0.96875, 0)).toBe(legacyQuantizeUnit(v, n));
      }
    }
  });

  it('depth 2 (3-3-2) crush === legacy per-channel [quant(r,8), quant(g,8), quant(b,4)] on a colour sweep', () => {
    for (let i = 0; i < 17; i++) {
      for (let j = 0; j < 17; j++) {
        const r = i / 16, g = j / 16, b = ((i * 7 + j * 3) % 17) / 16;
        expect(posterboxCrush(r, g, b, 5, 9, 2, 0)).toEqual([
          legacyQuantizeUnit(r, 8), legacyQuantizeUnit(g, 8), legacyQuantizeUnit(b, 4),
        ]);
      }
    }
  });

  it('depth 4 (5-6-5) crush === legacy per-channel [quant(r,32), quant(g,64), quant(b,32)] on a colour sweep', () => {
    for (let i = 0; i < 17; i++) {
      for (let j = 0; j < 17; j++) {
        const r = i / 16, g = j / 16, b = ((i * 5 + j * 11) % 17) / 16;
        expect(posterboxCrush(r, g, b, 2, 14, 4, 0)).toEqual([
          legacyQuantizeUnit(r, 32), legacyQuantizeUnit(g, 64), legacyQuantizeUnit(b, 32),
        ]);
      }
    }
  });

  it('PINNED ANCHOR: gray 0.2 at 3-3-2 → (36,36,0) — the documented neutral-gray tint', () => {
    const [r, g, b] = posterboxCrush(0.2, 0.2, 0.2, 0, 0, 2, 0);
    expect(r).toBeCloseTo(1 / 7, 10);
    expect(g).toBeCloseTo(1 / 7, 10);
    expect(b).toBe(0);
    expect([toByte(r), toByte(g), toByte(b)]).toEqual([36, 36, 0]);
  });

  it('PINNED ANCHOR: gray 0.6 at 3-3-2 → (146,146,170) — the tint swings blue above', () => {
    const [r, g, b] = posterboxCrush(0.6, 0.6, 0.6, 0, 0, 2, 0);
    expect(r).toBeCloseTo(4 / 7, 10);
    expect(b).toBeCloseTo(2 / 3, 10);
    expect([toByte(r), toByte(g), toByte(b)]).toEqual([146, 146, 170]);
  });

  it('PINNED ANCHOR: gray 0.2 at 5-6-5 → (49,49,49) — the 16-bit crush is near-invisible on grays', () => {
    const [r, g, b] = posterboxCrush(0.2, 0.2, 0.2, 0, 0, 4, 0);
    expect(r).toBeCloseTo(6 / 31, 10);
    expect(g).toBeCloseTo(12 / 63, 10);
    expect([toByte(r), toByte(g), toByte(b)]).toEqual([49, 49, 49]);
  });

  it('the Bayer texel position CANNOT leak into the dither-0 path', () => {
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        expect(posterboxCrush(0.37, 0.61, 0.83, x, y, 2, 0))
          .toEqual(posterboxCrush(0.37, 0.61, 0.83, 0, 0, 2, 0));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bayer 4×4 matrix + threshold lookup.
// ---------------------------------------------------------------------------
describe('POSTERBOX_BAYER4 — the standard ordered-dither index matrix', () => {
  it('is exactly the standard Bayer 4×4 matrix', () => {
    expect([...POSTERBOX_BAYER4]).toEqual([
       0,  8,  2, 10,
      12,  4, 14,  6,
       3, 11,  1,  9,
      15,  7, 13,  5,
    ]);
  });

  it('is a permutation of 0..15 (every threshold used exactly once)', () => {
    expect([...POSTERBOX_BAYER4].sort((a, b) => a - b))
      .toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it('every 2×2 quadrant spreads the full range (one value per quartile)', () => {
    for (const [qx, qy] of [[0, 0], [2, 0], [0, 2], [2, 2]] as const) {
      const quartiles = new Set<number>();
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        quartiles.add(Math.floor(POSTERBOX_BAYER4[(qy + dy) * 4 + (qx + dx)]! / 4));
      }
      expect(quartiles.size, `quadrant (${qx},${qy})`).toBe(4);
    }
  });

  it('thresholds are centred: all in (0,1), tile mean exactly 0.5, period 4 in x and y', () => {
    let sum = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const t = posterboxBayerThreshold(x, y);
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThan(1);
        sum += t;
        expect(posterboxBayerThreshold(x + 4, y)).toBe(t);
        expect(posterboxBayerThreshold(x, y + 4)).toBe(t);
      }
    }
    expect(sum / 16).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// DITHER: ordered dither dissolves bands into cross-hatch.
// ---------------------------------------------------------------------------
describe('DITHER — Bayer ordered dither (5-point range proof)', () => {
  /** Fraction of (v, texel) samples whose 1-bit crush flips vs dither 0. */
  function flipFraction(dither: number): number {
    let flips = 0, total = 0;
    for (let i = 0; i < 256; i++) {
      const v = (i + 0.5) / 256;
      const hard = posterboxCrush(v, v, v, 0, 0, 0, 0)[0];
      for (let x = 0; x < 4; x++) {
        for (let y = 0; y < 4; y++) {
          const soft = posterboxCrush(v, v, v, x, y, 0, dither)[0];
          if (soft !== hard) flips++;
          total++;
        }
      }
    }
    return flips / total;
  }

  it('5-POINT RANGE PROOF: flip fraction is 0 at dither 0 and strictly climbs at 0.25/0.5/0.75/1', () => {
    const f = [0, 0.25, 0.5, 0.75, 1].map(flipFraction);
    expect(f[0]).toBe(0);
    for (let i = 1; i < f.length; i++) {
      expect(f[i]!, `dither ${[0, 0.25, 0.5, 0.75, 1][i]}`).toBeGreaterThan(f[i - 1]!);
    }
    // full dither perturbs a substantial share of the frame (~0.11 at 1-bit:
    // only values within one dither step of the SINGLE band boundary can
    // flip — the clamped outer half-bands hold, which is correct: solid
    // blacks/whites must not sparkle).
    expect(f[4]!).toBeGreaterThan(0.08);
  });

  it('a band edge becomes a perfect checker: v=0.5 at 1-bit, dither 1 → 50/50 tile, alternating along the row', () => {
    // At v=0.5, n=2: idx = floor(0.5 + t) — white exactly when the Bayer
    // threshold ≥ 0.5, i.e. for the 8 high cells of the 16-cell tile.
    let whites = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        whites += posterboxCrush(0.5, 0.5, 0.5, x, y, 0, 1)[0];
      }
    }
    expect(whites).toBe(8);
    // and along a single row the phase alternates texel-by-texel (row 0 of
    // the matrix is 0,8,2,10 → B,W,B,W): the classic checkered band edge.
    const row = Array.from({ length: 16 }, (_, x) => posterboxCrush(0.5, 0.5, 0.5, x, 0, 0, 1)[0]);
    let transitions = 0;
    for (let x = 1; x < 16; x++) if (row[x] !== row[x - 1]) transitions++;
    expect(transitions).toBe(15);
    // while the undithered row is uniform (hard band, zero transitions).
    const hardRow = Array.from({ length: 16 }, (_, x) => posterboxCrush(0.5, 0.5, 0.5, x, 0, 0, 0)[0]);
    expect(new Set(hardRow).size).toBe(1);
  });

  it('a gradient renders as density cross-hatch: tile-mean tracks v with far more resolvable levels than the 2 hard bands', () => {
    const tileMean = (v: number, dither: number): number => {
      let sum = 0;
      for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) sum += posterboxCrush(v, v, v, x, y, 0, dither)[0];
      return sum / 16;
    };
    const vs = Array.from({ length: 33 }, (_, i) => i / 32);
    const dithered = vs.map((v) => tileMean(v, 1));
    const hard = vs.map((v) => tileMean(v, 0));
    // monotone non-decreasing density...
    for (let i = 1; i < dithered.length; i++) {
      expect(dithered[i]!).toBeGreaterThanOrEqual(dithered[i - 1]!);
    }
    // ...with many more resolvable levels than the hard 2-band staircase.
    expect(new Set(dithered.map((m) => m.toFixed(5))).size).toBeGreaterThanOrEqual(8);
    expect(new Set(hard.map((m) => m.toFixed(5))).size).toBe(2);
  });

  it('dither applies in each channel\'s OWN step size (3-3-2: B dithers where R/G hold)', () => {
    // v=0.5625 → R/G: 0.5625*8 = 4.5 (dead mid-band; |offset| ≤ 0.469 can't
    // flip it); B: 0.5625*4 = 2.25 (0.25 above the band edge at 2 → the low
    // Bayer cells flip it down). The per-channel step size is what makes the
    // asymmetric allocations dither authentically.
    const v = 0.5625;
    const rgFlips = new Set<number>();
    const bFlips = new Set<number>();
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        const [r, , b] = posterboxCrush(v, v, v, x, y, 2, 1);
        rgFlips.add(r);
        bFlips.add(b);
      }
    }
    expect(rgFlips.size).toBe(1);          // R holds its band across the tile
    expect(bFlips.size).toBeGreaterThan(1); // B checkers across the tile
  });
});

// ---------------------------------------------------------------------------
// MIX: linear dry/wet.
// ---------------------------------------------------------------------------
describe('MIX — dry/wet (5-point range proof)', () => {
  it('5-POINT RANGE PROOF: gray 0.2 at 3-3-2 sweeps linearly from source to (36,36,0)', () => {
    const mixes = [0, 0.25, 0.5, 0.75, 1];
    const outs = mixes.map((m) => posterboxPixel(0.2, 0.2, 0.2, 0, 0, 2, 0, m));
    // endpoints: dry source and the pinned crush anchor.
    expect(outs[0]).toEqual([0.2, 0.2, 0.2]);
    expect(outs[4]![0]).toBeCloseTo(1 / 7, 10);
    expect(outs[4]![2]).toBe(0);
    // linear interpolation per channel at every point...
    for (let i = 0; i < mixes.length; i++) {
      const m = mixes[i]!;
      expect(outs[i]![0]).toBeCloseTo(0.2 + (1 / 7 - 0.2) * m, 10);
      expect(outs[i]![2]).toBeCloseTo(0.2 * (1 - m), 10);
    }
    // ...producing 5 distinct outputs (strictly monotone B channel).
    for (let i = 1; i < outs.length; i++) {
      expect(outs[i]![2]).toBeLessThan(outs[i - 1]![2]);
    }
  });

  it('mix clamps outside 0..1', () => {
    expect(posterboxPixel(0.2, 0.2, 0.2, 0, 0, 2, 0, -1)).toEqual([0.2, 0.2, 0.2]);
    expect(posterboxPixel(0.2, 0.2, 0.2, 0, 0, 2, 0, 2)).toEqual(
      posterboxPixel(0.2, 0.2, 0.2, 0, 0, 2, 0, 1),
    );
  });

  it('defaults: full crush, hard bands, 3-3-2', () => {
    expect(POSTERBOX_DEFAULTS).toEqual({ depth: 2, dither: 0, mix: 1 });
  });
});
