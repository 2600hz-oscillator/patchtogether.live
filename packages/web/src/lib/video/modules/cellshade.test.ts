// packages/web/src/lib/video/modules/cellshade.test.ts
//
// CELLSHADE rebuild — module-def shape + the pure 4-pass cel pipeline (no GL):
//   - BANDS knob (legacy `bits` id) snaps to the 5 band counts {2,3,4,6,8};
//   - P3 soft luminance quantization: hard-degenerate anchor (softness 0 ==
//     floor(Y·n)/(n−1) exactly), near-continuous at softness 1, monotone,
//     CHROMA-PRESERVING (the exhaustive 15°-hue sweep F-CS1 shipped without);
//   - P1/P2 separable bilateral: true bypass at smooth 0 (by BRANCH — §12 R4),
//     identity on constants, edge-preserving, texture-flattening;
//   - P4 ink: EDGES Sobel semantics + the INK strength composite;
//   - 5-POINT FULL-RANGE DYNAMISM PROOFS for every control (threshold /
//     thickness / bands / softness / smooth / ink) — each knob provably
//     changes the output monotonically across its whole range (the mapper.ts
//     behavioural-mirror pattern; no string-containment).
//
// The pure functions are the EXACT CPU mirror of the GLSL passes — the same
// source-of-truth pattern EDGES / FREEZEFRAME / MAPPER use.

import { describe, it, expect } from 'vitest';
import {
  cellshadeDef,
  cellshadeBandsIndex,
  cellshadeBandCount,
  cellshadeLuma,
  cellshadeMix,
  cellshadeSmoothstep,
  cellshadeSigmaR,
  cellshadeSoftWidth,
  cellshadeBilateralWeight,
  cellshadeSmoothGrid,
  cellshadeQuantizeLuma,
  cellshadeQuantizeY,
  cellshadeInkComposite,
  cellshadePixel,
  CELLSHADE_BAND_STEPS,
  CELLSHADE_DEFAULTS,
  CELLSHADE_DEFAULT_BANDS_INDEX,
  CELLSHADE_SIGMA_D,
  CELLSHADE_SMOOTH_RADIUS,
} from './cellshade';
import { EDGES_MAX_THICKNESS, EDGES_LUMA_WEIGHTS } from './edges';

// ---------------------------------------------------------------------------
// Test-local HSV helpers (for building hue-sweep fixtures + measuring hue —
// the MODULE no longer ships HSV code; the engine never leaves RGB/Y space).
// ---------------------------------------------------------------------------

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

function rgbHueDeg(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d <= 1e-9) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function hueErrDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

// ---------------------------------------------------------------------------
// Def shape
// ---------------------------------------------------------------------------
describe('cellshadeDef shape', () => {
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

  it('bands keeps the LEGACY `bits` id + DISCRETE 0..4 step index (zero-migration)', () => {
    const b = cellshadeDef.params.find((p) => p.id === 'bits');
    expect(b?.curve).toBe('discrete');
    expect(b?.label).toBe('Bands');
    expect(b?.min).toBe(0);
    expect(b?.max).toBe(CELLSHADE_BAND_STEPS.length - 1);
    expect(b?.max).toBe(4);
    expect(b?.defaultValue).toBe(CELLSHADE_DEFAULT_BANDS_INDEX);
    expect(cellshadeBandCount(b!.defaultValue)).toBe(4);
  });

  it('softness / smooth / ink span 0..1 linear (defaults 0.25 / 0.35 / 1)', () => {
    const soft = cellshadeDef.params.find((p) => p.id === 'softness');
    const smo = cellshadeDef.params.find((p) => p.id === 'smooth');
    const ink = cellshadeDef.params.find((p) => p.id === 'ink');
    for (const p of [soft, smo, ink]) {
      expect([p?.min, p?.max, p?.curve]).toEqual([0, 1, 'linear']);
    }
    expect(soft?.defaultValue).toBe(0.25);
    expect(smo?.defaultValue).toBe(0.35);
    expect(ink?.defaultValue).toBe(1);
  });

  it('every param has a matching CV input (port id == param id); bits is discrete', () => {
    for (const p of cellshadeDef.params) {
      const port = cellshadeDef.inputs.find((i) => i.id === p.id);
      expect(port?.type, `${p.id} CV port`).toBe('cv');
      expect(port?.paramTarget).toBe(p.id);
      expect(port?.cvScale?.mode).toBe(p.id === 'bits' ? 'discrete' : 'linear');
    }
  });
});

// ---------------------------------------------------------------------------
// BANDS knob: snaps to the 5 luminance band counts.
// ---------------------------------------------------------------------------
describe('BANDS knob snaps to the 5 band-count steps', () => {
  it('the 5 steps are exactly {2, 3, 4, 6, 8} luminance bands', () => {
    expect([...CELLSHADE_BAND_STEPS]).toEqual([2, 3, 4, 6, 8]);
    expect(CELLSHADE_BAND_STEPS.map((_, i) => cellshadeBandCount(i)))
      .toEqual([2, 3, 4, 6, 8]);
  });

  it('a FRACTIONAL bits value (e.g. from a CV write) snaps to the nearest step', () => {
    expect(cellshadeBandsIndex(1.4)).toBe(1);
    expect(cellshadeBandsIndex(1.6)).toBe(2);
    expect(cellshadeBandsIndex(2.5)).toBe(3);
    // and out-of-range clamps to the valid 0..4 step index.
    expect(cellshadeBandsIndex(-3)).toBe(0);
    expect(cellshadeBandsIndex(99)).toBe(4);
    // non-finite falls back to the default index.
    expect(cellshadeBandsIndex(NaN)).toBe(CELLSHADE_DEFAULT_BANDS_INDEX);
  });
});

// ---------------------------------------------------------------------------
// Scalar helpers — GLSL-mirror exactness.
// ---------------------------------------------------------------------------
describe('scalar mirrors (mix / smoothstep / sigmaR / softWidth / luma)', () => {
  it('cellshadeLuma matches the EDGES Rec.601 weights', () => {
    expect(cellshadeLuma(1, 1, 1)).toBeCloseTo(1, 6);
    expect(cellshadeLuma(0, 0, 0)).toBe(0);
    expect(cellshadeLuma(1, 0, 0)).toBeCloseTo(EDGES_LUMA_WEIGHTS[0], 6);
    expect(cellshadeLuma(0, 1, 0)).toBeCloseTo(EDGES_LUMA_WEIGHTS[1], 6);
    expect(cellshadeLuma(0, 0, 1)).toBeCloseTo(EDGES_LUMA_WEIGHTS[2], 6);
  });

  it('mix + smoothstep behave like GLSL', () => {
    expect(cellshadeMix(2, 10, 0.5)).toBe(6);
    expect(cellshadeSmoothstep(-1, 1, -2)).toBe(0);
    expect(cellshadeSmoothstep(-1, 1, 2)).toBe(1);
    expect(cellshadeSmoothstep(-1, 1, 0)).toBeCloseTo(0.5, 9);
  });

  it('σ_r sweeps 0.03 → 0.4 with SMOOTH (clamped)', () => {
    expect(cellshadeSigmaR(0)).toBeCloseTo(0.03, 9);
    expect(cellshadeSigmaR(1)).toBeCloseTo(0.4, 9);
    expect(cellshadeSigmaR(0.5)).toBeCloseTo(0.215, 9);
    expect(cellshadeSigmaR(-5)).toBeCloseTo(0.03, 9);
    expect(cellshadeSigmaR(99)).toBeCloseTo(0.4, 9);
  });

  it('soft half-width sweeps 1e-3 → 0.5 with SOFTNESS (capped at 0.5)', () => {
    expect(cellshadeSoftWidth(0)).toBeCloseTo(1e-3, 12);
    expect(cellshadeSoftWidth(1)).toBeCloseTo(0.5, 12);
    expect(cellshadeSoftWidth(99)).toBeCloseTo(0.5, 12); // capped — w > 0.5
    // would break the round()-tie continuity proof (§12 R3).
  });
});

// ---------------------------------------------------------------------------
// P3 — soft luminance quantization.
// ---------------------------------------------------------------------------
describe('cellshadeQuantizeLuma — soft luminance banding', () => {
  it('HARD-DEGENERATE ANCHOR: softness 0 reproduces floor(Y·n)/(n−1) exactly, every step', () => {
    for (const n of CELLSHADE_BAND_STEPS) {
      for (let k = 0; k < 512; k++) {
        const y = k / 511;
        const expected = Math.min(n - 1, Math.floor(y * n)) / (n - 1);
        expect(cellshadeQuantizeLuma(y, n, 0)).toBeCloseTo(expected, 10);
      }
    }
  });

  it('band VALUES at softness 0 are the exact levels i/(n−1) (n=4 → 0/85/170/255)', () => {
    const seen = new Set<number>();
    for (let k = 0; k < 512; k++) seen.add(cellshadeQuantizeLuma(k / 511, 4, 0));
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1 / 3, 2 / 3, 1]);
    // In 8-bit terms: 0 / 85 / 170 / 255 — the e2e regression anchor.
    expect([...seen].map((v) => Math.round(v * 255)).sort((a, b) => a - b))
      .toEqual([0, 85, 170, 255]);
  });

  it('softness 1 is NEAR-CONTINUOUS: no hard step anywhere on the ramp', () => {
    for (const n of CELLSHADE_BAND_STEPS) {
      let maxJump = 0;
      let prev = cellshadeQuantizeLuma(0, n, 1);
      for (let k = 1; k < 2048; k++) {
        const cur = cellshadeQuantizeLuma(k / 2047, n, 1);
        maxJump = Math.max(maxJump, cur - prev);
        prev = cur;
      }
      // A hard band step would be 1/(n−1) ≥ 0.143; the soft transfer's max
      // slope is 1.5·n/(n−1) → adjacent-sample jumps stay ~3/2048.
      expect(maxJump, `n=${n} max adjacent jump`).toBeLessThan(0.01);
    }
  });

  it('monotone non-decreasing in Y for every band step × softness', () => {
    for (const n of CELLSHADE_BAND_STEPS) {
      for (const s of [0, 0.25, 0.5, 0.75, 1]) {
        let prev = -1;
        for (let k = 0; k < 512; k++) {
          const cur = cellshadeQuantizeLuma(k / 511, n, s);
          expect(cur, `n=${n} s=${s} k=${k}`).toBeGreaterThanOrEqual(prev - 1e-12);
          prev = cur;
        }
      }
    }
  });

  it('5-POINT SOFTNESS DYNAMISM: the 0.48/0.52 boundary jump strictly shrinks across the range', () => {
    // n=4 puts a band threshold exactly at Y=0.5 (the F-CS4 probe pair).
    const jumps = [0, 0.25, 0.5, 0.75, 1].map(
      (s) => cellshadeQuantizeLuma(0.52, 4, s) - cellshadeQuantizeLuma(0.48, 4, s),
    );
    expect(jumps[0]).toBeCloseTo(1 / 3, 9); // hard: the full band step
    for (let i = 1; i < jumps.length; i++) {
      expect(jumps[i]!, `softness step ${i}`).toBeLessThan(jumps[i - 1]! - 1e-6);
    }
    expect(jumps[4]!).toBeLessThan(0.12); // near-continuous end
  });

  it('5-POINT BANDS DYNAMISM: each step yields exactly its distinct band count on a ramp (softness 0)', () => {
    // 512-point ramp: no k/511 lands within the 1e-3 soft window of an i/n
    // threshold for any step (511 = 7·73 is coprime to every n here), so the
    // hard quantizer emits ONLY the n levels.
    const counts = CELLSHADE_BAND_STEPS.map((_, idx) => {
      const seen = new Set<number>();
      for (let k = 0; k < 512; k++) {
        seen.add(cellshadeQuantizeLuma(k / 511, cellshadeBandCount(idx), 0));
      }
      return seen.size;
    });
    expect(counts).toEqual([2, 3, 4, 6, 8]);
  });
});

describe('cellshadeQuantizeY — chroma-preserving reconstruction (additive luma shift)', () => {
  it('a NEUTRAL input stays exactly neutral at every step', () => {
    for (let idx = 0; idx < CELLSHADE_BAND_STEPS.length; idx++) {
      for (const y of [0.1, 0.35, 0.6, 0.9]) {
        const [r, g, b] = cellshadeQuantizeY(y, y, y, idx, 0);
        expect(r).toBeCloseTo(g, 12);
        expect(g).toBeCloseTo(b, 12);
      }
    }
  });

  it('[F-CS2 fix] the skin tone lands at ≈(209,158,132) at the default (bands 4, softness 0.25)', () => {
    const [r, g, b] = cellshadeQuantizeY(0.8, 0.6, 0.5, 2, 0.25);
    expect(Math.round(r * 255)).toBe(209);
    expect(Math.round(g * 255)).toBe(158);
    expect(Math.round(b * 255)).toBe(132);
    // warm cast retained: R clearly above B.
    expect(r - b).toBeGreaterThan(0.2);
  });

  it('[F-CS1 fix] magenta stays magenta: (235,0,235) at the default', () => {
    const [r, g, b] = cellshadeQuantizeY(1, 0, 1, 2, 0.25);
    expect(Math.round(r * 255)).toBe(235);
    expect(g).toBe(0);
    expect(Math.round(b * 255)).toBe(235);
  });

  it('[F-CS1 fix] yellow stays yellow: (255,255,29) at the default', () => {
    const [r, g, b] = cellshadeQuantizeY(1, 1, 0, 2, 0.25);
    expect(r).toBe(1);
    expect(g).toBe(1);
    expect(Math.round(b * 255)).toBe(29);
  });

  it('[F-CS3 fix] saturated blue lands in the DARK band in LUMA terms: (0,0,226), out-luma ≈ 26/255', () => {
    // 2 bands, hard: blue's Rec.601 luma 0.114 < 0.5 → band 0 → Δ = −0.114.
    // The gamut clamp eats the rest (−0.886 is unrealizable) — §12 R1: the
    // correct assertion is on the OUTPUT LUMA, not per-channel darkness.
    const [r, g, b] = cellshadeQuantizeY(0, 0, 1, 0, 0);
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(Math.round(b * 255)).toBe(226);
    expect(cellshadeLuma(r, g, b) * 255).toBeLessThan(38);
    // hue retained: B ≫ R, G.
    expect(b).toBeGreaterThan(0.8);
  });

  it('EXHAUSTIVE HUE SWEEP (the F-CS1 blind spot): every 15° hue survives every band step', () => {
    // Under the additive shift, channel DIFFERENCES are preserved exactly
    // until the gamut clamp kicks in → hue is EXACT for unclamped texels.
    // The clamp is per-channel monotone, so even clamped texels can never
    // INVERT the channel ordering (a hue flip like F-CS1's yellow→red).
    let unclamped = 0;
    let total = 0;
    for (let hDeg = 0; hDeg < 360; hDeg += 15) {
      const [r, g, b] = hsvToRgb(hDeg / 360, 0.5, 0.6);
      const hueIn = rgbHueDeg(r, g, b);
      for (let idx = 0; idx < CELLSHADE_BAND_STEPS.length; idx++) {
        for (const s of [0, 0.25]) {
          total++;
          const y = cellshadeLuma(r, g, b);
          const d = cellshadeQuantizeLuma(y, cellshadeBandCount(idx), s) - y;
          const [or, og, ob] = cellshadeQuantizeY(r, g, b, idx, s);
          const clamps =
            Math.min(r, g, b) + d < 0 || Math.max(r, g, b) + d > 1;
          if (!clamps) {
            unclamped++;
            expect(
              hueErrDeg(rgbHueDeg(or, og, ob), hueIn),
              `hue ${hDeg}° idx ${idx} softness ${s}`,
            ).toBeLessThan(2);
          }
          // Weak channel-ordering preservation — ALWAYS, clamped or not.
          const pairs: Array<[number, number, number, number]> = [
            [r, g, or, og], [g, b, og, ob], [r, b, or, ob],
          ];
          for (const [i1, i2, o1, o2] of pairs) {
            if (i1 > i2 + 1e-9) expect(o1).toBeGreaterThanOrEqual(o2 - 1e-9);
            else if (i2 > i1 + 1e-9) expect(o2).toBeGreaterThanOrEqual(o1 - 1e-9);
            else expect(Math.abs(o1 - o2)).toBeLessThan(1e-9);
          }
        }
      }
    }
    // the strict hue check must not be vacuous: most cases stay in gamut.
    expect(unclamped / total).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// P1/P2 — separable bilateral.
// ---------------------------------------------------------------------------
describe('cellshadeSmoothGrid — separable bilateral abstraction', () => {
  const W = 24, H = 8;

  function grid(fill: (x: number, y: number) => [number, number, number]): Float32Array {
    const g = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, gg, b] = fill(x, y);
        const i = (y * W + x) * 3;
        g[i] = r; g[i + 1] = gg; g[i + 2] = b;
      }
    }
    return g;
  }

  function rowVariance(g: ArrayLike<number>, y: number): number {
    let sum = 0, sumSq = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const v = cellshadeLuma(g[i]!, g[i + 1]!, g[i + 2]!);
      sum += v; sumSq += v * v;
    }
    const mean = sum / W;
    return sumSq / W - mean * mean;
  }

  it('kernel shape: σ_d = 2, radius 3 (7 taps); weight peaks at the centre and decays', () => {
    expect(CELLSHADE_SIGMA_D).toBe(2.0);
    expect(CELLSHADE_SMOOTH_RADIUS).toBe(3);
    expect(cellshadeBilateralWeight(0, 0, 0.2)).toBeCloseTo(1, 9);
    expect(cellshadeBilateralWeight(1, 0, 0.2)).toBeLessThan(1);
    expect(cellshadeBilateralWeight(3, 0, 0.2)).toBeLessThan(cellshadeBilateralWeight(1, 0, 0.2));
    // range term: a big luma difference kills the tap.
    expect(cellshadeBilateralWeight(1, 0.9, 0.03)).toBeLessThan(1e-9);
  });

  it('TRUE BYPASS at smooth 0: the input grid is returned BY REFERENCE (§12 R4 — identity by branch)', () => {
    const g = grid((x) => [x / W, x / W, x / W]);
    expect(cellshadeSmoothGrid(W, H, g, 0)).toBe(g);
  });

  it('identity on a CONSTANT frame at any smooth (solid fixtures are bilateral-invariant)', () => {
    const g = grid(() => [0.3, 0.55, 0.7]);
    const out = cellshadeSmoothGrid(W, H, g, 1);
    for (let i = 0; i < g.length; i++) {
      expect(out[i]!).toBeCloseTo(g[i]!, 6);
    }
  });

  it('EDGE-PRESERVING: a high-contrast step survives heavy smoothing', () => {
    const g = grid((x) => (x < W / 2 ? [0.05, 0.05, 0.05] : [0.95, 0.95, 0.95]));
    const out = cellshadeSmoothGrid(W, H, g, 1);
    const iL = (4 * W + (W / 2 - 1)) * 3;
    const iR = (4 * W + W / 2) * 3;
    const step = out[iR]! - out[iL]!;
    // the raw step is 0.9; the bilateral must keep the contour crisp.
    expect(step).toBeGreaterThan(0.7);
  });

  it('flattens LOW-CONTRAST texture (the abstraction Winnemöller step 1 provides)', () => {
    const g = grid((x) => {
      const v = 0.5 + (x % 2 === 0 ? 0.1 : -0.1);
      return [v, v, v];
    });
    const out = cellshadeSmoothGrid(W, H, g, 1);
    expect(rowVariance(out, 4)).toBeLessThan(rowVariance(g, 4) * 0.2);
  });

  it('5-POINT SMOOTH DYNAMISM: texture variance strictly decreases across the range', () => {
    const g = grid((x) => {
      const v = 0.5 + (x % 2 === 0 ? 0.1 : -0.1);
      return [v, v, v];
    });
    const variances = [0, 0.25, 0.5, 0.75, 1].map((s) =>
      rowVariance(cellshadeSmoothGrid(W, H, g, s), 4),
    );
    // smooth 0 is the bypass — variance is the raw texture's, exactly.
    expect(variances[0]).toBeCloseTo(rowVariance(g, 4), 12);
    for (let i = 1; i < variances.length; i++) {
      expect(variances[i]!, `smooth step ${i}`).toBeLessThan(variances[i - 1]! * 0.999);
    }
  });
});

// ---------------------------------------------------------------------------
// P4 — ink strength composite.
// ---------------------------------------------------------------------------
describe('cellshadeInkComposite — outline darkness', () => {
  it('5-POINT INK DYNAMISM: an edge texel interpolates linearly quantized → black', () => {
    const q: [number, number, number] = [0.8, 0.5, 0.3];
    const inks = [0, 0.25, 0.5, 0.75, 1];
    const outs = inks.map((k) => cellshadeInkComposite(q, 1, k));
    for (let i = 0; i < inks.length; i++) {
      // exact linear scaling: out = q·(1 − ink).
      expect(outs[i]![0]).toBeCloseTo(q[0] * (1 - inks[i]!), 9);
      expect(outs[i]![1]).toBeCloseTo(q[1] * (1 - inks[i]!), 9);
      if (i > 0) expect(outs[i]![0]).toBeLessThan(outs[i - 1]![0]);
    }
    expect(outs[0]).toEqual(q);           // ink 0 → no lines at all
    expect(outs[4]).toEqual([0, 0, 0]);   // ink 1 → solid black
  });

  it('a NON-edge texel is untouched at every ink strength', () => {
    const q: [number, number, number] = [0.8, 0.5, 0.3];
    for (const k of [0, 0.5, 1]) {
      expect(cellshadeInkComposite(q, 0, k)).toEqual(q);
    }
  });
});

// ---------------------------------------------------------------------------
// Full pipeline — cellshadePixel over synthetic grids.
// ---------------------------------------------------------------------------
describe('cellshadePixel — the full 4-pass mirror', () => {
  // Left half mid-grey, right half white → one high-contrast vertical edge.
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
  const base = { threshold: 0.2, thickness: 2, bits: 2, softness: 0, smooth: 0, ink: 1 };

  it('a pixel ON the high-contrast boundary is inked BLACK at ink 1', () => {
    const onEdge = cellshadePixel(W, H, grid, W / 2 - 1, H / 2, base);
    expect(onEdge).toEqual([0, 0, 0]);
  });

  it('a FLAT-interior pixel is NOT inked and equals the pure quantization', () => {
    const flat = cellshadePixel(W, H, grid, 1, H / 2, base);
    const quant = cellshadeQuantizeY(0.3, 0.3, 0.3, base.bits, base.softness);
    expect(flat[0]).toBeCloseTo(quant[0], 6);
    expect(flat[1]).toBeCloseTo(quant[1], 6);
    expect(flat[2]).toBeCloseTo(quant[2], 6);
    expect(flat[0] + flat[1] + flat[2]).toBeGreaterThan(0);
  });

  function inkedCount(threshold: number, thickness: number): number {
    let n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = cellshadePixel(W, H, grid, x, y, { ...base, threshold, thickness });
        if (r === 0 && g === 0 && b === 0) n++;
      }
    }
    return n;
  }

  it('5-POINT THRESHOLD DYNAMISM: raising the gate never inks more; the range ends differ', () => {
    const gates = [0.05, 0.25, 0.5, 0.75, 0.95];
    const counts = gates.map((t) => inkedCount(t, 2));
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!, `gate ${gates[i]}`).toBeLessThanOrEqual(counts[i - 1]!);
    }
    expect(counts[0]!).toBeGreaterThan(0);
    expect(counts[4]!).toBeLessThan(counts[0]!);
  });

  it('5-POINT THICKNESS DYNAMISM: wider strokes never ink fewer; the range ends differ', () => {
    const widths = [1, 2, 4, 6, 8];
    const counts = widths.map((w) => inkedCount(0.2, w));
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!, `thickness ${widths[i]}`).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
    expect(counts[0]!).toBeGreaterThan(0);
    expect(counts[4]!).toBeGreaterThan(counts[0]!);
  });

  it('a FLAT (no-contrast) grid inks NOTHING at any threshold', () => {
    const flatGrid = new Float32Array(W * H * 3).fill(0.5);
    let inked = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = cellshadePixel(W, H, flatGrid, x, y, { ...base, threshold: 0.05, thickness: 4 });
        if (r === 0 && g === 0 && b === 0) inked++;
      }
    }
    expect(inked).toBe(0);
  });

  it('SMOOTHING KILLS NOISE-INK (F-CS6): speckle that inks raw stops inking under smooth', () => {
    // Low-contrast fine texture: vertical stripes, period 4, amplitude ±0.02
    // (a period-2 checker is Sobel-null by symmetry). The stripe boundaries'
    // Sobel magnitude is 4·0.04/4 = 0.04 — just over a 0.03 gate on the raw
    // input; the bilateral flattens the texture far below it.
    const g = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = 0.5 + (x % 4 < 2 ? 0.02 : -0.02);
        const i = (y * W + x) * 3;
        g[i] = v; g[i + 1] = v; g[i + 2] = v;
      }
    }
    const countAt = (smooth: number): number => {
      let n = 0;
      for (let y = 2; y < H - 2; y++) {
        for (let x = 2; x < W - 2; x++) {
          const [r, gg, b] = cellshadePixel(W, H, g, x, y, { ...base, threshold: 0.03, thickness: 1, smooth });
          if (r === 0 && gg === 0 && b === 0) n++;
        }
      }
      return n;
    };
    const rawInked = countAt(0);
    const smoothedInked = countAt(0.8);
    expect(rawInked).toBeGreaterThan(0);          // noise inks on the raw input
    expect(smoothedInked).toBe(0);                // …and not once smoothed
  });

  it('bands sweep through the pixel path matches the quantizer (neutral ramp, softness 0)', () => {
    // texel-centre ramp v = (x+0.5)/W — (2x+1)/32 never lands ON an i/n
    // threshold for n ∈ {2,3,4,6,8} (odd numerator), so the hard quantizer
    // emits clean levels at every step.
    const ramp = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = (x + 0.5) / W;
        const i = (y * W + x) * 3;
        ramp[i] = v; ramp[i + 1] = v; ramp[i + 2] = v;
      }
    }
    const distinctAt = (bitsIdx: number): number => {
      const seen = new Set<string>();
      for (let x = 2; x < W - 2; x++) {
        const [r, g, b] = cellshadePixel(W, H, ramp, x, H / 2, {
          ...base, threshold: 0.95, thickness: 1, bits: bitsIdx,
        });
        seen.add(`${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)}`);
      }
      return seen.size;
    };
    // interior sample only (2..W−2 ≈ Y 0.13..0.87) — the count grows with
    // the step, and lower BANDS always yields fewer distinct tones.
    let prev = 0;
    for (let idx = 0; idx < CELLSHADE_BAND_STEPS.length; idx++) {
      const d = distinctAt(idx);
      expect(d, `idx ${idx}`).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    expect(distinctAt(0)).toBeLessThan(distinctAt(4));
  });
});
