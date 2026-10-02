// EDGEFADER core — the pure transition law (no GL). This file pins the CPU
// mirror in edgefader-core.ts, which the GLSL in edgefader.ts ports with the
// constants interpolated from the SAME exports: the cascade (the owner's two
// sentences, checked on the band-centre law for every adjacent pair), the
// per-pixel lead ordering, the exact endpoints in both modes, the melt
// geometry (integer-hash determinism, drip reach), and the full composite on
// 160×120 synthetic A/B pairs. The design's "25 %" became 20 % — five bands —
// and the tests read the band count from EDGEFADER_BANDS, never a typed 5.
//
// What this file is structurally unable to see: the shaders compiling at all,
// the engine's uv.y orientation (rowFromTop = 1 − uv.y is the house top-left
// convention; the e2e sees it), the GPU's mip approximations of `boxMean` and
// of the coarse density (every test on those terms is a floor or an ordering,
// never a pixel equality — the core header says why), the pass plumbing
// (FBOs, uniforms, the unpatched-input texture), and SwiftShader cost.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EDGEFADER_BANDS,
  EDGEFADER_LOCAL_FRACTION,
  EDGEFADER_LEAD_EDGE,
  EDGEFADER_LEAD_COINCIDENCE,
  EDGEFADER_LEAD_SIMILARITY,
  EDGEFADER_LEAD_INSIDE,
  EDGEFADER_BLUR_MAX_PX,
  EDGEFADER_RAY_TAPS_PX,
  EDGEFADER_COARSE_PX,
  EDGEFADER_MELT_DELAY_MAX,
  EDGEFADER_DRIP_MAX_UV,
  EDGEFADER_DRIP_MIN_FRAC,
  EDGEFADER_WOBBLE_UV,
  EDGEFADER_FRONT_SOFT_UV,
  EDGEFADER_DROP_LANES,
  EDGEFADER_DROP_R_MIN,
  EDGEFADER_DROP_R_MAX,
  EDGEFADER_DROP_JITTER,
  EDGEFADER_DROP_LEN_MAX,
  EDGEFADER_DROP_STALK,
  EDGEFADER_SEEDS,
  clamp01,
  softStep,
  meltHash,
  valueNoise,
  sdSegment,
  bandStagger,
  bandWindowLength,
  bandWindow,
  bandProgress,
  cascadeProgress,
  bandOf,
  rowStart,
  rowProgress,
  similarity,
  leadFor,
  localProgress,
  blurRadiusPx,
  blendWeight,
  dilateRadius,
  insideScore,
  meltDelayNoise,
  meltColumnProgress,
  meltEase,
  meltSlide,
  meltWobble,
  dropLaneCentre,
  dropLane,
  dropDistance,
  texelAt,
  sampleGrid,
  boxMean,
  buildEdgeAtlas,
  edgeFieldAt,
  pixelLaw,
  meltLayer,
  edgefaderPixel,
  type EdgeField,
  type EdgeAtlas,
} from './edgefader-core';
import { EDGES_DEFAULTS, EDGES_MAX_THICKNESS } from './edges';

const N = EDGEFADER_BANDS;
const STAGGER = 1 / (N + 1);
const LEAD_SPAN = EDGEFADER_LEAD_EDGE + EDGEFADER_LEAD_COINCIDENCE + EDGEFADER_LEAD_SIMILARITY + EDGEFADER_LEAD_INSIDE;
/** The fader sampled every 1/120 of its travel, both ends included. */
const T_GRID: number[] = Array.from({ length: 121 }, (_, i) => i / 120);
/** Progress sampled every 1/100, both ends included. */
const P_GRID: number[] = Array.from({ length: 101 }, (_, i) => i / 100);

const field = (over: Partial<EdgeField> = {}): EdgeField => ({
  wEdge: 0, wCoinc: 0, wSim: 0, inside: 0, nearEdge: 0, ...over,
});

// ─────────────────────────── the synthetic grids ────────────────────────────
// 160×120: the default ray taps reach 22 px and the coarse cell is 32 px, so
// the grid must be a few of those across — the core header says why a 32×24
// grid cannot host the ray geometry. Sweeps probe with a stride.

const W = 160;
const H = 120;
const ASPECT = W / H;
const rowFromTopOf = (y: number): number => (y + 0.5) / H;
const x01Of = (x: number): number => (x + 0.5) / W;

function makeGrid(f: (x: number, y: number) => number): Float32Array {
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = f(x, y);
  return g;
}
const circleGrid = (cx: number, cy: number, r: number, inside = 1, outside = 0): Float32Array =>
  makeGrid((x, y) => ((x - cx) ** 2 + (y - cy) ** 2 <= r * r ? inside : outside));
const flatGrid = (v: number): Float32Array => makeGrid(() => v);
const stripesGrid = (period: number, lo: number, hi: number): Float32Array =>
  makeGrid((_x, y) => (Math.floor(y / period) % 2 === 0 ? hi : lo));
/** A 16-px checker in the top-left quadrant only (x < 80, y < 60), flat 0.5
 *  elsewhere. `shift` moves the cell boundaries, so B = A shifted half a cell
 *  carries edges in the SAME region at DIFFERENT places. */
const checkerQuadrantGrid = (shift: number): Float32Array =>
  makeGrid((x, y) => (x < W / 2 && y < H / 2
    ? (Math.floor((x + shift) / 16) + Math.floor((y + shift) / 16)) % 2
    : 0.5));

const CIRCLE = { cx: 80, cy: 60, r: 30 } as const;
const DETECT = { threshold: EDGES_DEFAULTS.threshold, thickness: EDGES_DEFAULTS.thickness } as const;
const BLUR = { ...DETECT, melt: false } as const;
const MELT = { ...DETECT, melt: true } as const;

interface Pair { a: Float32Array; b: Float32Array; atlas: EdgeAtlas }
const pairCache = new Map<string, Pair>();
/** A memoised A/B pair + its atlas (each atlas costs ~100 ms to build). */
function pair(name: string, mk: () => [Float32Array, Float32Array], opts: { hasB?: boolean } = {}): Pair {
  let p = pairCache.get(name);
  if (!p) {
    const [a, b] = mk();
    p = { a, b, atlas: buildEdgeAtlas(W, H, a, b, DETECT.threshold, DETECT.thickness, opts) };
    pairCache.set(name, p);
  }
  return p;
}
const circleFlat = (): Pair => pair('circle/flat', () => [circleGrid(CIRCLE.cx, CIRCLE.cy, CIRCLE.r), flatGrid(0.3)]);
const circleStripes = (): Pair => pair('circle/stripes', () => [circleGrid(CIRCLE.cx, CIRCLE.cy, CIRCLE.r), stripesGrid(16, 0.3, 0.7)]);
const flatFlat = (): Pair => pair('flat/flat', () => [flatGrid(0.2), flatGrid(0.7)]);
const circleCircle = (): Pair => pair('circle/circle', () => {
  const c = circleGrid(CIRCLE.cx, CIRCLE.cy, CIRCLE.r);
  return [c, c];
});
const circleShifted = (): Pair => pair('circle/shifted', () => [
  circleGrid(CIRCLE.cx, CIRCLE.cy, CIRCLE.r),
  circleGrid(CIRCLE.cx, CIRCLE.cy + 12, CIRCLE.r),
]);
const checkerChecker = (): Pair => pair('checker/checker', () => [checkerQuadrantGrid(0), checkerQuadrantGrid(8)]);
/** Mid-level grids whose global [min, max] is NOT [0, 1], for the bounds test. */
const levels = (): Pair => pair('levels', () => [circleGrid(CIRCLE.cx, CIRCLE.cy, CIRCLE.r, 0.85, 0.25), stripesGrid(16, 0.35, 0.65)]);
const circleUnpatched = (): Pair => pair('circle/unpatched', () => {
  const c = circleGrid(CIRCLE.cx, CIRCLE.cy, CIRCLE.r);
  return [c, c];
}, { hasB: false });

const px = (p: Pair, x: number, y: number, t: number, params: typeof BLUR | typeof MELT, opts = {}): number =>
  edgefaderPixel(p.atlas, p.a, p.b, x, y, t, params, opts);
/** How far an output has moved from A toward B, as a fraction (callers pick
 *  pixels where A ≠ B). */
const fractionTowardB = (out: number, a: number, b: number): number => (out - a) / (b - a);

/** The worst pixel of a whole-grid comparison against a target grid. */
function worstAgainst(p: Pair, t: number, params: typeof BLUR | typeof MELT, target: Float32Array): { max: number; x: number; y: number } {
  let max = -1;
  let wx = -1;
  let wy = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.abs(px(p, x, y, t, params) - target[y * W + x]!);
      if (d > max) { max = d; wx = x; wy = y; }
    }
  }
  return { max, x: wx, y: wy };
}

// ─────────────────────────── primitives ─────────────────────────────────────

describe('edgefader-core — GLSL-equivalent primitives', () => {
  it('clamp01 clamps', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(7)).toBe(1);
  });

  it('softStep is smoothstep, with the e0 == e1 case a HARD step (the GLSL builtin is undefined there)', () => {
    expect(softStep(0, 1, -0.5)).toBe(0);
    expect(softStep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(softStep(0, 1, 1.5)).toBe(1);
    expect(softStep(0.3, 0.3, 0.2999), 'below a degenerate edge → 0').toBe(0);
    expect(softStep(0.3, 0.3, 0.3), 'at a degenerate edge → 1').toBe(1);
  });

  it('sdSegment: zero on the segment, the endpoint distance beyond it, the point distance when degenerate', () => {
    expect(sdSegment(0.5, 0, 0, 0, 1, 0)).toBeCloseTo(0, 12);
    expect(sdSegment(0.5, 0.25, 0, 0, 1, 0)).toBeCloseTo(0.25, 12);
    expect(sdSegment(2, 0, 0, 0, 1, 0)).toBeCloseTo(1, 12);
    expect(sdSegment(3, 4, 0, 0, 0, 0), 'degenerate a == b → |p − a|').toBeCloseTo(5, 12);
  });

  it('texelAt clamps to the edge; sampleGrid is the texel at integer coordinates and bilinear between; boxMean(r=0) is the texel', () => {
    const g = new Float32Array([0, 1, 2, 3, 4, 5]); // 3×2
    expect(texelAt(3, 2, g, -4, 0)).toBe(0);
    expect(texelAt(3, 2, g, 9, 9)).toBe(5);
    expect(sampleGrid(3, 2, g, 1, 1)).toBe(4);
    expect(sampleGrid(3, 2, g, 0.5, 0)).toBeCloseTo(0.5, 12);
    expect(sampleGrid(3, 2, g, 0.5, 0.5)).toBeCloseTo(2, 12);
    expect(boxMean(3, 2, g, 2, 1, 0)).toBe(5);
    expect(boxMean(3, 2, g, 1, 0, 1), 'the clamped 3×3 box around (1,0): rows (0,1,2),(0,1,2),(3,4,5)').toBeCloseTo((0 + 1 + 2 + 0 + 1 + 2 + 3 + 4 + 5) / 9, 12);
    expect(boxMean(W, H, flatGrid(0.4), 7, 9, 24)).toBeCloseTo(0.4, 6);
  });
});

// ─────────────────────────── 1. the cascade ─────────────────────────────────

describe('edgefader-core — cascade (the owner\'s two sentences on the band-centre law)', () => {
  it('δ = 1/(N+1) and D = 2δ: N=5 → a stagger of 1/6 and a window of 1/3', () => {
    expect(N).toBe(5);
    expect(bandStagger()).toBeCloseTo(1 / 6, 12);
    expect(bandWindowLength()).toBeCloseTo(1 / 3, 12);
    expect(bandWindowLength()).toBeCloseTo(2 * bandStagger(), 12);
    expect(bandWindowLength(3)).toBeCloseTo(2 * bandStagger(3), 12);
  });

  it('bandWindow(k) is [k/(N+1), k/(N+1) + 2/(N+1)] and the last window closes at exactly 1', () => {
    for (let k = 0; k < N; k++) {
      const w = bandWindow(k);
      expect(w.start, `band ${k} start`).toBeCloseTo(k * STAGGER, 12);
      expect(w.end, `band ${k} end`).toBeCloseTo(k * STAGGER + 2 * STAGGER, 12);
    }
    expect(bandWindow(N - 1).end).toBeCloseTo(1, 12);
  });

  it('cascadeProgress(0) is all 0 and cascadeProgress(1) is all 1 (N entries, top to bottom)', () => {
    expect(cascadeProgress(0)).toEqual(new Array(N).fill(0));
    expect(cascadeProgress(1)).toEqual(new Array(N).fill(1));
    expect(cascadeProgress(-0.2)).toEqual(new Array(N).fill(0));
    expect(cascadeProgress(1.7)).toEqual(new Array(N).fill(1));
  });

  it('band k+1 leaves 0 exactly when band k hits 0.5 — every adjacent pair', () => {
    for (let k = 0; k < N - 1; k++) {
      const tStart = bandWindow(k + 1).start;
      expect(bandProgress(tStart, k), `band ${k} is half done when band ${k + 1} opens`).toBeCloseTo(0.5, 12);
      expect(bandProgress(tStart, k + 1), `band ${k + 1} is at 0 when it opens`).toBe(0);
      expect(bandProgress(tStart - 1e-6, k + 1), `band ${k + 1} is still 0 just before`).toBe(0);
      expect(bandProgress(tStart + 1e-6, k + 1), `band ${k + 1} has left 0 just after`).toBeGreaterThan(0);
    }
  });

  it('band k reaches 1 exactly when band k+1 hits 0.5 (the level band k had when k+1 started) — every adjacent pair', () => {
    for (let k = 0; k < N - 1; k++) {
      const tEnd = bandWindow(k).end;
      expect(bandProgress(tEnd, k), `band ${k} is done at its end`).toBeCloseTo(1, 12);
      expect(bandProgress(tEnd - 1e-6, k), `band ${k} is not done just before`).toBeLessThan(1);
      expect(bandProgress(tEnd, k + 1), `band ${k + 1} is half done then`).toBeCloseTo(0.5, 12);
    }
  });

  it('every band is monotone non-decreasing in t, linear inside its window', () => {
    for (let k = 0; k < N; k++) {
      for (let i = 1; i < T_GRID.length; i++) {
        expect(bandProgress(T_GRID[i]!, k), `band ${k} at t=${T_GRID[i]}`).toBeGreaterThanOrEqual(bandProgress(T_GRID[i - 1]!, k));
      }
      const w = bandWindow(k);
      const mid = (w.start + w.end) / 2;
      expect(bandProgress(mid, k), `band ${k} is half done mid-window`).toBeCloseTo(0.5, 12);
    }
  });

  it('the top band is ≥ every lower band at every t, and the bands are ordered top → bottom', () => {
    for (const t of T_GRID) {
      const prog = cascadeProgress(t);
      for (let k = 1; k < N; k++) {
        expect(prog[0]!, `top ≥ band ${k} at t=${t}`).toBeGreaterThanOrEqual(prog[k]!);
        expect(prog[k - 1]!, `band ${k - 1} ≥ band ${k} at t=${t}`).toBeGreaterThanOrEqual(prog[k]!);
      }
    }
    // Strict while both are mid-window.
    expect(bandProgress(0.25, 0)).toBeGreaterThan(bandProgress(0.25, 1));
  });

  it('bandOf: row centres map to their band, a boundary row belongs to the band BELOW it, out-of-range clamps', () => {
    for (let k = 0; k < N; k++) {
      expect(bandOf((k + 0.5) / N), `centre of band ${k}`).toBe(k);
      expect(bandOf(k / N), `the boundary at ${k}/N starts band ${k}`).toBe(k);
      if (k > 0) expect(bandOf(k / N - 1e-9), `just above the boundary is band ${k - 1}`).toBe(k - 1);
    }
    expect(bandOf(0)).toBe(0);
    expect(bandOf(1)).toBe(N - 1);
    expect(bandOf(-0.1)).toBe(0);
    expect(bandOf(1.5)).toBe(N - 1);
  });

  it('rowStart equals k/(N+1) at every band centre', () => {
    for (let k = 0; k < N; k++) {
      expect(rowStart((k + 0.5) / N), `band ${k} centre`).toBeCloseTo(bandWindow(k).start, 12);
    }
  });

  it('rowStart is monotone in the row and adjacent rows (1/120 apart) differ by less than a tenth of a stagger — no seam', () => {
    for (let y = 1; y < H; y++) {
      const d = rowStart(rowFromTopOf(y)) - rowStart(rowFromTopOf(y - 1));
      expect(d, `row ${y}: non-decreasing`).toBeGreaterThanOrEqual(0);
      expect(d, `row ${y}: far smaller than a stagger`).toBeLessThan(STAGGER / 10);
    }
  });

  it('rows above the top band\'s centre start with it and rows below the bottom band\'s centre start with it', () => {
    expect(rowStart(0)).toBe(bandWindow(0).start);
    expect(rowStart(0.5 / N - 1e-6)).toBe(bandWindow(0).start);
    expect(rowStart(1)).toBeCloseTo(bandWindow(N - 1).start, 12);
    expect(rowStart((N - 0.5) / N + 1e-6)).toBeCloseTo(bandWindow(N - 1).start, 12);
  });

  it('rowProgress(0, row) = 0 and rowProgress(1, row) = 1 for every row, and it is monotone in t', () => {
    for (let y = 0; y < H; y++) {
      const r = rowFromTopOf(y);
      expect(rowProgress(0, r), `row ${y} at t=0`).toBe(0);
      expect(rowProgress(1, r), `row ${y} at t=1`).toBe(1);
      for (let i = 1; i < T_GRID.length; i += 10) {
        expect(rowProgress(T_GRID[i]!, r)).toBeGreaterThanOrEqual(rowProgress(T_GRID[i - 1]!, r));
      }
    }
    // At a band centre the row law IS the band law.
    for (let k = 0; k < N; k++) {
      for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        expect(rowProgress(t, (k + 0.5) / N), `band ${k} centre at t=${t}`).toBeCloseTo(bandProgress(t, k), 12);
      }
    }
  });
});

// ─────────────────────────── 2. the lead law ────────────────────────────────

describe('edgefader-core — lead law (coincident > edge; similar > flat; inside-near > flat; outside-near == flat)', () => {
  const flat = leadFor(field());
  const edge = leadFor(field({ wEdge: 1 }));
  const coincident = leadFor(field({ wEdge: 1, wCoinc: 1 }));
  const similar = leadFor(field({ wSim: 1 }));
  const insideNear = leadFor(field({ inside: 1, nearEdge: 1 }));
  const outsideNear = leadFor(field({ inside: -1, nearEdge: 1 }));

  it('orders the five cases as the core header promises', () => {
    expect(coincident, 'coincident edge > plain edge').toBeGreaterThan(edge);
    expect(edge, 'plain edge > flat').toBeGreaterThan(flat);
    expect(similar, 'similar region > flat').toBeGreaterThan(flat);
    expect(insideNear, 'inside-near-edge > flat').toBeGreaterThan(flat);
    expect(outsideNear, 'outside-near-edge == flat (nothing lags the background)').toBe(flat);
    expect(flat).toBe(0);
  });

  it('is the documented weighting over the lead span', () => {
    expect(edge).toBeCloseTo(EDGEFADER_LEAD_EDGE / LEAD_SPAN, 12);
    expect(coincident).toBeCloseTo((EDGEFADER_LEAD_EDGE + EDGEFADER_LEAD_COINCIDENCE) / LEAD_SPAN, 12);
    expect(similar).toBeCloseTo(EDGEFADER_LEAD_SIMILARITY / LEAD_SPAN, 12);
    expect(insideNear).toBeCloseTo(EDGEFADER_LEAD_INSIDE / LEAD_SPAN, 12);
    // Coincidence rides on wEdge: a "coincidence" with no edge contributes nothing.
    expect(leadFor(field({ wCoinc: 1 }))).toBe(0);
    // The inside term is scaled by proximity: inside with nothing near is flat.
    expect(leadFor(field({ inside: 1, nearEdge: 0 }))).toBe(0);
  });

  it('leadN ∈ [0, 1] at both extremes of the field', () => {
    expect(leadFor(field({ wEdge: 1, wCoinc: 1, wSim: 1, inside: 1, nearEdge: 1 }))).toBe(1);
    expect(leadFor(field())).toBe(0);
    expect(leadFor(field({ wEdge: 1, wCoinc: 1, wSim: 1, inside: -1, nearEdge: 1 }))).toBeLessThanOrEqual(1);
  });

  it('localProgress(0, lead) = 0 and localProgress(1, lead) = 1 for lead ∈ {0, 0.5, 1} — the endpoints are exact for every pixel', () => {
    for (const lead of [0, 0.5, 1]) {
      expect(Math.abs(localProgress(0, lead)), `lead ${lead} at pRow 0`).toBe(0);
      expect(localProgress(1, lead), `lead ${lead} at pRow 1`).toBe(1);
    }
  });

  it('ρ: a lead-1 pixel finishes by pRow = ρ and a lead-0 pixel has not started before pRow = 1 − ρ', () => {
    const rho = EDGEFADER_LOCAL_FRACTION;
    expect(localProgress(rho, 1)).toBeCloseTo(1, 12);
    expect(localProgress(rho - 1e-6, 1)).toBeLessThan(1);
    expect(Math.abs(localProgress(1 - rho, 0))).toBe(0);
    expect(localProgress(1 - rho + 1e-6, 0)).toBeGreaterThan(0);
  });

  it('a higher lead gives a higher-or-equal pLocal at every pRow, and pLocal is monotone in pRow', () => {
    for (const pRow of P_GRID) {
      let prev = -1;
      for (const lead of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const p = localProgress(pRow, lead);
        expect(p, `pRow ${pRow} lead ${lead} ≥ the lower lead`).toBeGreaterThanOrEqual(prev);
        prev = p;
      }
    }
    for (const lead of [0, 0.5, 1]) {
      for (let i = 1; i < P_GRID.length; i++) {
        expect(localProgress(P_GRID[i]!, lead)).toBeGreaterThanOrEqual(localProgress(P_GRID[i - 1]!, lead));
      }
    }
  });

  it('blurRadiusPx is 0 at pLocal 0 and 1, peaks at 0.5 (= BLUR_MAX × wRegion) and scales with wRegion', () => {
    for (const w of [0, 0.25, 1]) {
      expect(Math.abs(blurRadiusPx(0, w)), `w=${w} at 0`).toBe(0);
      expect(Math.abs(blurRadiusPx(1, w)), `w=${w} at 1`).toBe(0);
      expect(blurRadiusPx(0.5, w), `w=${w} peak`).toBeCloseTo(EDGEFADER_BLUR_MAX_PX * w, 12);
      for (const p of P_GRID) expect(blurRadiusPx(p, w)).toBeLessThanOrEqual(EDGEFADER_BLUR_MAX_PX * w + 1e-12);
    }
    expect(blurRadiusPx(0.3, 1)).toBeGreaterThan(blurRadiusPx(0.3, 0.5));
    expect(blurRadiusPx(0.3, 0.5)).toBeGreaterThan(blurRadiusPx(0.3, 0));
    expect(blurRadiusPx(0.5, 2), 'wRegion is clamped to 1').toBe(EDGEFADER_BLUR_MAX_PX);
  });

  it('blendWeight: 0 → A, 1 → B, 0.5 → half, monotone', () => {
    expect(blendWeight(0)).toBe(0);
    expect(blendWeight(1)).toBe(1);
    expect(blendWeight(0.5)).toBeCloseTo(0.5, 12);
    for (let i = 1; i < P_GRID.length; i++) expect(blendWeight(P_GRID[i]!)).toBeGreaterThanOrEqual(blendWeight(P_GRID[i - 1]!));
  });

  it('similarity(0, x) = 0, similarity(x, x) = √x, symmetric, and both-dense beats one-dense', () => {
    for (const x of [0, 0.1, 0.5, 1]) {
      expect(similarity(0, x), `(0, ${x})`).toBe(0);
      expect(similarity(x, 0), `(${x}, 0)`).toBe(0);
      expect(similarity(x, x), `(${x}, ${x})`).toBeCloseTo(Math.sqrt(x), 12);
    }
    expect(similarity(0.2, 0.7)).toBeCloseTo(similarity(0.7, 0.2), 12);
    expect(similarity(0.7, 0.7)).toBeGreaterThan(similarity(0.2, 0.7));
  });

  it('dilateRadius is EDGES\' round(T) − 1 law (edges.ts edgesPixel), capped at EDGES_MAX_THICKNESS − 1', () => {
    expect(dilateRadius(1)).toBe(0);
    expect(dilateRadius(2)).toBe(1);
    expect(dilateRadius(3)).toBe(2);
    expect(dilateRadius(8)).toBe(7);
    expect(dilateRadius(9999)).toBe(EDGES_MAX_THICKNESS - 1);
    expect(dilateRadius(-5)).toBe(0);
    expect(EDGES_MAX_THICKNESS).toBe(8);
  });

  it('pixelLaw composes the law: band, row progress, lead, local progress, blend, blur (scaled by the blur cap)', () => {
    const f = field({ wEdge: 1, wSim: 0.4 });
    const law = pixelLaw(0.33, rowFromTopOf(40), f);
    expect(law.band).toBe(bandOf(rowFromTopOf(40)));
    expect(law.pRow).toBe(rowProgress(0.33, rowFromTopOf(40)));
    expect(law.leadN).toBe(leadFor(f));
    expect(law.pLocal).toBe(localProgress(law.pRow, law.leadN));
    expect(law.blend).toBe(blendWeight(law.pLocal));
    expect(law.blurPx).toBeCloseTo(blurRadiusPx(law.pLocal, 1), 12);
    expect(pixelLaw(0.33, rowFromTopOf(40), f, N, 0).blurPx, 'blurMaxPx 0 → no blur').toBe(0);
    expect(pixelLaw(0.33, rowFromTopOf(40), f, N, 12).blurPx).toBeCloseTo(law.blurPx / 2, 12);
  });
});

// ─────────────────────────── 3. inside / outside ────────────────────────────

describe('edgefader-core — insideScore (the ray to screen centre)', () => {
  // Pixel at (50, 60), centre at (80, 60): the ray toward the centre runs +x.
  const X = 50;
  const Y = 60;
  const CX = 80;
  const CY = 60;
  const bandAt = (x0: number, x1: number) => (pxX: number, _pxY: number): number => (pxX >= x0 && pxX <= x1 ? 1 : 0);

  it('an edge between the pixel and the centre → inside −1 (the pixel is OUTSIDE it), nearEdge 1', () => {
    // An edge at x ∈ [56, 60] is hit by the 8-px toward tap.
    expect(insideScore(bandAt(56, 60), X, Y, CX, CY)).toEqual({ inside: -1, nearEdge: 1 });
  });

  it('an edge beyond the pixel (border-ward) → inside +1 (the pixel is INSIDE it), nearEdge 1', () => {
    // An edge at x ∈ [40, 44] is hit by the 8-px away tap.
    expect(insideScore(bandAt(40, 44), X, Y, CX, CY)).toEqual({ inside: 1, nearEdge: 1 });
  });

  it('edges on both sides cancel to 0 but still read as near', () => {
    const both = (pxX: number, _pxY: number): number => (Math.abs(pxX - X) >= 7 && Math.abs(pxX - X) <= 9 ? 1 : 0);
    expect(insideScore(both, X, Y, CX, CY)).toEqual({ inside: 0, nearEdge: 1 });
  });

  it('no edge within the taps → {0, 0}; an edge past the longest tap is invisible', () => {
    expect(insideScore(() => 0, X, Y, CX, CY)).toEqual({ inside: 0, nearEdge: 0 });
    const far = Math.max(...EDGEFADER_RAY_TAPS_PX) + 2;
    expect(insideScore(bandAt(X + far, X + far + 1), X, Y, CX, CY)).toEqual({ inside: 0, nearEdge: 0 });
  });

  it('the exact-centre guard returns zeros (no direction to march)', () => {
    expect(insideScore(() => 1, CX, CY, CX, CY)).toEqual({ inside: 0, nearEdge: 0 });
  });

  it('the taps are the exported engine px (4, 8, 14, 22) and the sampler sees them in px', () => {
    expect(EDGEFADER_RAY_TAPS_PX).toEqual([4, 8, 14, 22]);
    const seen: number[] = [];
    insideScore((pxX) => { seen.push(pxX - X); return 0; }, X, Y, CX, CY);
    expect(seen.map((v) => Math.round(v * 1e6) / 1e6).sort((a, b) => a - b)).toEqual([-22, -14, -8, -4, 4, 8, 14, 22]);
  });
});

// ─────────────────────────── 4. melt ────────────────────────────────────────

describe('edgefader-core — melt geometry', () => {
  /** An INDEPENDENT uint32 emulation of meltHash in BigInt (mod 2^32 at every
   *  step). JS's imul / >>> arithmetic equals mod-2^32 arithmetic, and GLSL ES
   *  3.0 uint arithmetic is mod 2^32 by definition — so agreement here is the
   *  bit-exactness argument for the JS ↔ GLSL mirror. */
  const M32 = (1n << 32n) - 1n;
  const refHash = (i: number, seed: number): number => {
    const u32 = (x: number): bigint => BigInt(x | 0) & M32;
    let h = (u32(i) * 374761393n + u32(seed) * 668265263n) & M32;
    h = ((h ^ (h >> 13n)) * 1274126177n) & M32;
    h = (h ^ (h >> 16n)) & M32;
    return Number(h & 0xffffffn) / 16777216;
  };
  const SEEDS = Object.values(EDGEFADER_SEEDS);

  it('meltHash is deterministic, in [0, 1), and differs across seeds and indices', () => {
    expect(meltHash(7, 11)).toBe(meltHash(7, 11));
    for (let i = 0; i < 64; i++) {
      for (const s of SEEDS) {
        const h = meltHash(i, s);
        expect(h, `h(${i}, ${s}) ≥ 0`).toBeGreaterThanOrEqual(0);
        expect(h, `h(${i}, ${s}) < 1`).toBeLessThan(1);
      }
    }
    expect(meltHash(0, 11)).not.toBe(meltHash(1, 11));
    expect(meltHash(3, 11)).not.toBe(meltHash(3, 17));
    expect(meltHash(5, EDGEFADER_SEEDS.dropHas)).not.toBe(meltHash(5, EDGEFADER_SEEDS.dropHas + 1));
  });

  it('meltHash(0, 0) is 0 by hand (0·a + 0·b stays 0 through the xorshifts) — harmless: every seed starts at 11 and the band offset only adds', () => {
    expect(meltHash(0, 0)).toBe(0);
    expect(Math.min(...SEEDS)).toBe(11);
    for (let k = 0; k < N; k++) for (const s of SEEDS) expect(meltHash(0, s + k), `h(0, ${s + k})`).toBeGreaterThan(0);
  });

  it('meltHash equals the BigInt uint32 emulation for two named inputs and across the whole lane range', () => {
    expect(meltHash(7, 11)).toBe(refHash(7, 11));
    expect(meltHash(123456, 53)).toBe(refHash(123456, 53));
    expect(refHash(7, 11)).toBeCloseTo(0.35584545135498047, 15);
    expect(refHash(123456, 53)).toBeCloseTo(0.7923945784568787, 15);
    let checked = 0;
    for (let i = -5; i < 300; i++) {
      for (const s of [0, ...SEEDS, 1000]) {
        expect(meltHash(i, s), `h(${i}, ${s})`).toBe(refHash(i, s));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it('valueNoise equals meltHash at integer x and is continuous between lattice points', () => {
    for (let i = 0; i < 20; i++) expect(valueNoise(i, 11), `x=${i}`).toBe(meltHash(i, 11));
    let prev = valueNoise(0, 11);
    for (let x = 1e-3; x <= 6; x += 1e-3) {
      const v = valueNoise(x, 11);
      expect(Math.abs(v - prev), `jump at x=${x}`).toBeLessThan(2e-3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      prev = v;
    }
  });

  it('meltDelayNoise ∈ [0, 1] across the width for every band', () => {
    for (let k = 0; k < N; k++) {
      for (let i = 0; i <= 400; i++) {
        const v = meltDelayNoise(i / 400, k);
        expect(v, `k=${k} x=${i / 400}`).toBeGreaterThanOrEqual(0);
        expect(v, `k=${k} x=${i / 400}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('meltColumnProgress is 0 at pBand 0 and 1 at pBand 1 for every column (DELAY_MAX normalisation), monotone in pBand', () => {
    for (let k = 0; k < N; k++) {
      for (let i = 0; i <= 200; i++) {
        const x = i / 200;
        for (const dens of [0, 0.5, 1]) {
          expect(Math.abs(meltColumnProgress(x, k, 0, dens)), `k=${k} x=${x} dens=${dens} at pBand 0`).toBe(0);
          expect(meltColumnProgress(x, k, 1, dens), `k=${k} x=${x} dens=${dens} at pBand 1`).toBe(1);
        }
      }
    }
    for (const x of [0.013, 0.37, 0.5, 0.91]) {
      for (let i = 1; i < P_GRID.length; i++) {
        expect(meltColumnProgress(x, 0, P_GRID[i]!, 0)).toBeGreaterThanOrEqual(meltColumnProgress(x, 0, P_GRID[i - 1]!, 0));
      }
    }
    expect(EDGEFADER_MELT_DELAY_MAX).toBeLessThan(1);
  });

  it('a higher edge density pulls a column EARLIER: progress is ≥ at every pBand and > while the delay still bites', () => {
    let strict = 0;
    for (let i = 0; i <= 100; i++) {
      const x = i / 100;
      for (const pBand of P_GRID) {
        const lo = meltColumnProgress(x, 1, pBand, 0);
        const hi = meltColumnProgress(x, 1, pBand, 1);
        expect(hi, `x=${x} pBand=${pBand}`).toBeGreaterThanOrEqual(lo);
        if (hi > lo) strict++;
      }
    }
    expect(strict, 'dense columns are strictly ahead somewhere mid-window').toBeGreaterThan(0);
    expect(meltColumnProgress(0.37, 1, 0.2, 1)).toBeGreaterThan(meltColumnProgress(0.37, 1, 0.2, 0));
  });

  it('meltEase: 0 → 0, 1 → 1, monotone, zero initial slope (f(ε)/ε → 0), unit final slope', () => {
    expect(meltEase(0)).toBe(0);
    expect(meltEase(1)).toBe(1);
    for (let i = 1; i < P_GRID.length; i++) expect(meltEase(P_GRID[i]!)).toBeGreaterThanOrEqual(meltEase(P_GRID[i - 1]!));
    expect(meltEase(1e-4) / 1e-4, 'slope at 0').toBeLessThan(1e-3);
    expect((meltEase(1) - meltEase(1 - 1e-6)) / 1e-6, 'slope at 1').toBeCloseTo(1, 4);
    expect(meltEase(-1)).toBe(0);
    expect(meltEase(2)).toBe(1);
  });

  it('meltSlide ∈ [0, DRIP_MAX_UV], 0 at p = 0, monotone in p, never shorter than DRIP_MIN_FRAC of the longest at p = 1', () => {
    for (let k = 0; k < N; k++) {
      for (let i = 0; i <= 160; i++) {
        const x = i / 160;
        expect(Math.abs(meltSlide(x, k, 0)), `k=${k} x=${x} at rest`).toBe(0);
        const full = meltSlide(x, k, 1);
        expect(full, `k=${k} x=${x} full slide ≤ max`).toBeLessThanOrEqual(EDGEFADER_DRIP_MAX_UV);
        expect(full, `k=${k} x=${x} full slide ≥ min frac`).toBeGreaterThanOrEqual(EDGEFADER_DRIP_MAX_UV * EDGEFADER_DRIP_MIN_FRAC);
      }
    }
    for (let i = 1; i < P_GRID.length; i++) expect(meltSlide(0.3, 2, P_GRID[i]!)).toBeGreaterThanOrEqual(meltSlide(0.3, 2, P_GRID[i - 1]!));
  });

  it('meltWobble is 0 at p = 0 and |·| ≤ WOBBLE_UV everywhere', () => {
    for (let i = 0; i <= 100; i++) {
      const x = i / 100;
      expect(Math.abs(meltWobble(x, 0.3, 1, 0, 0.5)), `x=${x} at rest`).toBe(0);
      for (const row of [0.05, 0.33, 0.71]) {
        for (const p of [0.2, 0.6, 1]) {
          for (const pBand of [0.1, 0.5, 0.9]) {
            expect(Math.abs(meltWobble(x, row, 1, p, pBand)), `x=${x}`).toBeLessThanOrEqual(EDGEFADER_WOBBLE_UV);
          }
        }
      }
    }
  });

  it('dropLaneCentre is the centre of the pixel\'s lane', () => {
    expect(dropLaneCentre(0.5 / EDGEFADER_DROP_LANES)).toBeCloseTo(0.5 / EDGEFADER_DROP_LANES, 12);
    expect(dropLaneCentre(0.99 / EDGEFADER_DROP_LANES)).toBeCloseTo(0.5 / EDGEFADER_DROP_LANES, 12);
    expect(dropLaneCentre(1.01 / EDGEFADER_DROP_LANES)).toBeCloseTo(1.5 / EDGEFADER_DROP_LANES, 12);
  });

  it('dropLane: cx inside its lane, r within [R_MIN, R_MAX], len 0 at the window\'s ends and > 0 mid-way, and some lanes carry a drop', () => {
    let withDrop = 0;
    for (let k = 0; k < N; k++) {
      for (let lane = 0; lane < EDGEFADER_DROP_LANES; lane++) {
        const x = (lane + 0.3) / EDGEFADER_DROP_LANES;
        const d = dropLane(x, k, 0.5);
        expect(d.cx, `k=${k} lane ${lane} cx ≥ lane start`).toBeGreaterThanOrEqual(lane / EDGEFADER_DROP_LANES);
        expect(d.cx, `k=${k} lane ${lane} cx ≤ lane end`).toBeLessThanOrEqual((lane + 1) / EDGEFADER_DROP_LANES);
        expect(d.r).toBeGreaterThanOrEqual(EDGEFADER_DROP_R_MIN);
        expect(d.r).toBeLessThanOrEqual(EDGEFADER_DROP_R_MAX);
        expect(d.len, 'mid-way the tongue is out').toBeGreaterThan(0);
        expect(d.len).toBeLessThanOrEqual(EDGEFADER_DROP_LEN_MAX);
        expect(Math.abs(dropLane(x, k, 0).len), 'no tongue before the window').toBe(0);
        expect(dropLane(x, k, 1).len, 'no tongue once the window closes').toBeCloseTo(0, 12);
        // The same lane reads the same drop from anywhere inside it.
        expect(dropLane((lane + 0.9) / EDGEFADER_DROP_LANES, k, 0.5)).toEqual(d);
        if (d.has) withDrop++;
      }
    }
    expect(withDrop, 'some lanes carry a drop').toBeGreaterThan(0);
    expect(withDrop, 'not every lane does').toBeLessThan(N * EDGEFADER_DROP_LANES);
  });

  it('O(1) lane constraint: head radius + lateral jitter stays within half a lane width in aspect units (4:3), so no drop leaves its lane', () => {
    const aspect = 4 / 3;
    const halfLaneAspect = (0.5 / EDGEFADER_DROP_LANES) * aspect;
    const jitterAspect = (EDGEFADER_DROP_JITTER * 0.5 / EDGEFADER_DROP_LANES) * aspect;
    expect(EDGEFADER_DROP_R_MAX + jitterAspect).toBeLessThanOrEqual(halfLaneAspect);
  });

  it('dropDistance: negative at the head centre and on the stalk, +Infinity without a drop', () => {
    let lane: ReturnType<typeof dropLane> | undefined;
    let x = 0;
    for (let l = 0; l < EDGEFADER_DROP_LANES && !lane; l++) {
      const cand = dropLane((l + 0.5) / EDGEFADER_DROP_LANES, 0, 0.5);
      if (cand.has) { lane = cand; x = (l + 0.5) / EDGEFADER_DROP_LANES; }
    }
    expect(lane, 'band 0 has at least one lane with a drop').toBeDefined();
    const d = lane!;
    const top = 0.3;
    const yc = top + d.len - d.r;
    expect(dropDistance(d.cx, yc, ASPECT, d, top), 'head centre').toBeLessThan(0);
    expect(dropDistance(d.cx, (top - d.r + yc) / 2, ASPECT, d, top), 'a stalk point').toBeLessThan(0);
    expect(dropDistance(d.cx, (top - d.r + yc) / 2, ASPECT, d, top), 'the stalk is thinner than the head').toBeCloseTo(-EDGEFADER_DROP_STALK * d.r, 12);
    expect(dropDistance(d.cx + 0.2, yc, ASPECT, d, top), 'far to the side').toBeGreaterThan(0);
    expect(dropDistance(x, yc, ASPECT, { ...d, has: false }, top)).toBe(Infinity);
    expect(dropDistance(x, yc, ASPECT, { ...d, len: 0 }, top)).toBe(Infinity);
  });

  it('the constant invariant: DRIP_MAX_UV + DROP_LEN_MAX (+ both soft fronts) stays below one band height, so nothing reaches band k+2', () => {
    expect(EDGEFADER_DRIP_MAX_UV + EDGEFADER_DROP_LEN_MAX).toBeLessThan(1 / N);
    expect(EDGEFADER_DRIP_MAX_UV + EDGEFADER_DROP_LEN_MAX + EDGEFADER_FRONT_SOFT_UV).toBeLessThan(1 / N);
  });

  describe('meltLayer on a built atlas', () => {
    const SLIDES = [0, 0.25, 0.5, 0.75, 1];

    it('srcRowFromTop ≤ rowFromTop always (content only slides DOWN) and stays inside band k, for pixels in band k and the band below', () => {
      const { atlas } = circleFlat();
      // Every pixel (x stride 2) of band k and band k+1, five slide stages:
      // violations are counted so the sweep stays fast, the first named.
      const violations: string[] = [];
      let checked = 0;
      for (let k = 0; k < N; k++) {
        for (const pBand of SLIDES) {
          const yFrom = Math.floor((k / N) * H);
          const yTo = Math.min(H, Math.floor(((k + 2) / N) * H));
          for (let y = yFrom; y < yTo; y++) {
            for (let x = 0; x < W; x += 2) {
              const L = meltLayer(atlas, x01Of(x), rowFromTopOf(y), k, pBand, ASPECT);
              checked++;
              const where = `k=${k} pBand=${pBand} (${x},${y})`;
              if (!(L.srcRowFromTop <= rowFromTopOf(y) + 1e-12)) violations.push(`${where} reads from below itself`);
              if (!(L.srcRowFromTop >= k / N && L.srcRowFromTop <= (k + 1) / N)) violations.push(`${where} reads outside band ${k}`);
              if (!(L.cover >= 0 && L.cover <= 1)) violations.push(`${where} cover ${L.cover}`);
              if (!(L.slide >= 0 && L.slide <= EDGEFADER_DRIP_MAX_UV)) violations.push(`${where} slide ${L.slide}`);
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(50000);
      expect(violations.slice(0, 3), `${violations.length} violations`).toEqual([]);
    });

    it('cover is 0 in the vacated top of the band once slide > 0 and 1 in the content region', () => {
      const { atlas } = circleFlat();
      for (let k = 0; k < N; k++) {
        for (let x = 0; x < W; x += 2) {
          const x01 = x01Of(x);
          const probe = meltLayer(atlas, x01, (k + 0.5) / N, k, 0.6, ASPECT);
          expect(probe.slide, `k=${k} x=${x} has started by pBand 0.6`).toBeGreaterThan(0);
          const vacated = meltLayer(atlas, x01, k / N + probe.slide * 0.25, k, 0.6, ASPECT);
          expect(vacated.cover, `k=${k} x=${x} vacated top`).toBe(0);
          const soft = Math.min(EDGEFADER_FRONT_SOFT_UV, probe.slide * 0.5);
          const content = meltLayer(atlas, x01, k / N + (1 / N + probe.slide) / 2, k, 0.6, ASPECT);
          expect(content.cover, `k=${k} x=${x} content`).toBe(1);
          expect(probe.slide).toBeGreaterThan(soft);
        }
      }
    });

    it('at rest (pBand 0) every pixel of the band is covered by its own unmoved content', () => {
      const { atlas } = circleFlat();
      for (let k = 0; k < N; k++) {
        for (let y = Math.floor((k / N) * H); y < Math.floor(((k + 1) / N) * H); y += 3) {
          for (let x = 0; x < W; x += 4) {
            const L = meltLayer(atlas, x01Of(x), rowFromTopOf(y), k, 0, ASPECT);
            expect(L.cover, `k=${k} (${x},${y})`).toBe(1);
            expect(L.srcRowFromTop, `k=${k} (${x},${y})`).toBeCloseTo(rowFromTopOf(y), 12);
            expect(Math.abs(L.xShift)).toBe(0);
            expect(Math.abs(L.slide)).toBe(0);
          }
        }
      }
    });

    it('band 0 at pBand 1 drips into the top rows of band 1 (cover > 0, sourced from band 0) and never into band 2 at any pBand', () => {
      const { atlas } = circleFlat();
      let dripped = 0;
      const band1Top = Math.floor((1 / N) * H);
      for (let y = band1Top; y < band1Top + 6; y++) {
        for (let x = 0; x < W; x += 2) {
          const L = meltLayer(atlas, x01Of(x), rowFromTopOf(y), 0, 1, ASPECT);
          if (L.cover > 0) {
            dripped++;
            expect(L.srcRowFromTop, `(${x},${y}) reads band 0`).toBeLessThan(1 / N);
          }
        }
      }
      expect(dripped, 'some of band 1\'s top rows carry band 0\'s content').toBeGreaterThan(0);
      const band2Top = Math.floor((2 / N) * H);
      for (const pBand of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        for (let y = band2Top; y < band2Top + H / N; y++) {
          for (let x = 0; x < W; x += 2) {
            expect(meltLayer(atlas, x01Of(x), rowFromTopOf(y), 0, pBand, ASPECT).cover, `pBand=${pBand} (${x},${y}) in band 2`).toBe(0);
          }
        }
      }
    });
  });
});

// ─────────────────────────── 5. the mirror ──────────────────────────────────

describe('edgefader-core — edgefaderPixel on synthetic 160×120 pairs', () => {
  it('(a) endpoints: t=0 is exactly A and t=1 exactly B at EVERY pixel, blur and melt — circle/flat and circle/stripes', () => {
    for (const [name, p] of [['circle/flat', circleFlat()], ['circle/stripes', circleStripes()]] as const) {
      for (const [mode, params] of [['blur', BLUR], ['melt', MELT]] as const) {
        const w0 = worstAgainst(p, 0, params, p.a);
        expect(w0.max, `${name} ${mode} t=0 worst pixel (${w0.x},${w0.y})`).toBeLessThan(1e-9);
        const w1 = worstAgainst(p, 1, params, p.b);
        expect(w1.max, `${name} ${mode} t=1 worst pixel (${w1.x},${w1.y})`).toBeLessThan(1e-9);
        const wNeg = worstAgainst(p, -0.3, params, p.a);
        expect(wNeg.max, `${name} ${mode} t<0 is still A`).toBeLessThan(1e-9);
        const wOver = worstAgainst(p, 1.4, params, p.b);
        expect(wOver.max, `${name} ${mode} t>1 is still B`).toBeLessThan(1e-9);
      }
    }
  });

  it('(b) a pair with NO edges is a plain delayed crossfade: rows uniform, never outside [A, B], strictly between mid-way, upper rows ahead', () => {
    const p = flatFlat();
    // The grids are Float32Array: read the stored levels back rather than the
    // double literals they were built from.
    const A = p.a[0]!;
    const B = p.b[0]!;
    for (const t of [0.25, 0.5, 0.75]) {
      let prevRow = Infinity;
      for (let y = 0; y < H; y++) {
        const first = px(p, 0, y, t, BLUR);
        const expected = A + (B - A) * blendWeight(localProgress(rowProgress(t, rowFromTopOf(y)), 0));
        expect(first, `t=${t} row ${y} is the lead-0 law`).toBeCloseTo(expected, 12);
        for (let x = 1; x < W; x += 3) expect(px(p, x, y, t, BLUR), `t=${t} row ${y} is uniform`).toBe(first);
        expect(first).toBeGreaterThanOrEqual(A);
        expect(first).toBeLessThanOrEqual(B);
        expect(first, `t=${t} row ${y} is no further toward B than the row above`).toBeLessThanOrEqual(prevRow + 1e-12);
        prevRow = first;
        const melt = px(p, 7, y, t, MELT);
        expect(melt, `melt t=${t} row ${y} ≥ A`).toBeGreaterThanOrEqual(A - 1e-12);
        expect(melt, `melt t=${t} row ${y} ≤ B`).toBeLessThanOrEqual(B + 1e-12);
      }
    }
    // Mid-way: the top is B, the bottom is A and the band in between is strictly between.
    expect(px(p, 40, 0, 0.5, BLUR)).toBe(B);
    expect(px(p, 40, H - 1, 0.5, BLUR)).toBe(A);
    for (let x = 0; x < W; x += 5) {
      const v = px(p, x, 48, 0.5, BLUR);
      expect(v, `(${x},48) strictly between at t=0.5`).toBeGreaterThan(A);
      expect(v).toBeLessThan(B);
    }
    let strictlyBetweenMelt = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 4) {
      const v = px(p, x, y, 0.5, MELT);
      if (v > A + 1e-9 && v < B - 1e-9) strictlyBetweenMelt++;
    }
    expect(strictlyBetweenMelt, 'melt mode also mid-fades somewhere at t=0.5').toBeGreaterThan(0);
  });

  it('(c) cascade order at t=0.3: per-band means of the fraction toward B are non-increasing top → bottom, band 0 > 0, band N−1 == 0', () => {
    const p = circleFlat();
    const sums = new Array<number>(N).fill(0);
    const counts = new Array<number>(N).fill(0);
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 4) {
        const i = y * W + x;
        const k = bandOf(rowFromTopOf(y));
        sums[k] = sums[k]! + fractionTowardB(px(p, x, y, 0.3, BLUR), p.a[i]!, p.b[i]!);
        counts[k] = counts[k]! + 1;
      }
    }
    const means = sums.map((s, k) => s / counts[k]!);
    for (let k = 1; k < N; k++) expect(means[k]!, `band ${k} ≤ band ${k - 1}: ${means.join(', ')}`).toBeLessThanOrEqual(means[k - 1]!);
    expect(means[0]!, 'the top band has moved').toBeGreaterThan(0);
    expect(means[N - 1]!, 'the bottom band has not').toBe(0);
    expect(means[1]!, 'the second band has started (its top rows lead its centre)').toBeGreaterThan(0);
  });

  it('(d) edges lead: in band 1 at pRow ≈ 0.4 an edge pixel of the circle has moved toward B and a flat pixel in the same row has not', () => {
    const p = circleFlat();
    const y = 36; // the centre row of band 1 (rows 24..47)
    const t = rowStart(rowFromTopOf(y)) + 0.4 / ((N + 1) * 0.5);
    expect(bandOf(rowFromTopOf(y))).toBe(1);
    expect(rowProgress(t, rowFromTopOf(y))).toBeCloseTo(0.4, 12);
    const edgeX = 62; // the circle's left contour crosses row 36 at x ≈ 62
    const flatX = 10;
    const edgeField = edgeFieldAt(p.atlas, edgeX, y);
    const flatField = edgeFieldAt(p.atlas, flatX, y);
    expect(edgeField.wEdge, 'the chosen edge pixel IS on the dilated edge').toBe(1);
    expect(flatField, 'the chosen flat pixel sees nothing').toEqual(field());
    // The lead alone (blur off): the edge pixel's fraction toward B is its blend, the flat pixel's is 0.
    const edgeNoBlur = px(p, edgeX, y, t, BLUR, { blurMaxPx: 0 });
    const flatNoBlur = px(p, flatX, y, t, BLUR, { blurMaxPx: 0 });
    const edgeLaw = pixelLaw(t, rowFromTopOf(y), edgeField);
    expect(edgeLaw.blend).toBeGreaterThan(0);
    expect(fractionTowardB(edgeNoBlur, p.a[y * W + edgeX]!, p.b[y * W + edgeX]!)).toBeCloseTo(edgeLaw.blend, 12);
    expect(flatNoBlur).toBe(p.a[y * W + flatX]!);
    // The full composite: the edge pixel has left A (toward B), the flat pixel is still exactly A.
    const edgeOut = px(p, edgeX, y, t, BLUR);
    expect(fractionTowardB(edgeOut, p.a[y * W + edgeX]!, p.b[y * W + edgeX]!), 'edge pixel moved toward B').toBeGreaterThan(0);
    expect(px(p, flatX, y, t, BLUR), 'flat pixel untouched').toBe(p.a[y * W + flatX]!);
  });

  it('(e) inside leads outside: 6 px inside the circle\'s top edge vs 6 px outside it (same column) — leadN inside > outside', () => {
    const p = circleFlat();
    const topEdgeY = CIRCLE.cy - CIRCLE.r; // 30
    const inside = edgeFieldAt(p.atlas, CIRCLE.cx, topEdgeY + 6);
    const outside = edgeFieldAt(p.atlas, CIRCLE.cx, topEdgeY - 6);
    expect(inside.inside, 'the inside pixel sees the edge border-ward').toBe(1);
    expect(outside.inside, 'the outside pixel sees the edge centre-ward').toBe(-1);
    expect(inside.wEdge, 'neither pixel is itself on the dilated edge').toBe(0);
    expect(outside.wEdge).toBe(0);
    expect(leadFor(inside)).toBeGreaterThan(leadFor(outside));
    expect(leadFor(outside), 'outside-near-edge equals flat').toBe(0);
    expect(pixelLaw(0.5, rowFromTopOf(topEdgeY + 6), inside).leadN).toBeCloseTo(EDGEFADER_LEAD_INSIDE / LEAD_SPAN, 12);
  });

  it('(e) inside leads outside in the OUTPUT on a same-row pair across the left edge (only the lead differs)', () => {
    // The brief's same-column pair straddles two rows, and the row-interpolated
    // start gives the UPPER (outside) pixel the earlier window BY DESIGN — a
    // same-column output comparison would measure the row law, not the inside
    // law. So the output is compared across the LEFT contour, where both pixels
    // share a row (and so a pRow) and only their lead differs.
    const p = circleFlat();
    const y = CIRCLE.cy;
    const leftEdgeX = CIRCLE.cx - CIRCLE.r; // 50
    const insideX = leftEdgeX + 6;
    const outsideX = leftEdgeX - 6;
    const inside = edgeFieldAt(p.atlas, insideX, y);
    const outside = edgeFieldAt(p.atlas, outsideX, y);
    expect(inside.inside).toBe(1);
    expect(outside.inside).toBe(-1);
    expect(leadFor(inside)).toBeGreaterThan(leadFor(outside));
    const t = rowStart(rowFromTopOf(y)) + 0.6 / ((N + 1) * 0.5); // pRow 0.6 on this row
    const fIn = fractionTowardB(px(p, insideX, y, t, BLUR), p.a[y * W + insideX]!, p.b[y * W + insideX]!);
    const fOut = fractionTowardB(px(p, outsideX, y, t, BLUR), p.a[y * W + outsideX]!, p.b[y * W + outsideX]!);
    expect(fIn, `inside ${fIn} is further toward B than outside ${fOut}`).toBeGreaterThan(fOut);
    expect(fOut, 'the outside pixel has started too (it is not lagging the background)').toBeGreaterThan(0);
    expect(fIn).toBeLessThan(1);
  });

  it('(f) coincidence leads: on the shared edge of identical circles wCoinc is 1 and leadN beats the same pixel against a circle shifted 12 px down (wCoinc 0)', () => {
    const idPair = circleCircle();
    const shPair = circleShifted();
    const x = CIRCLE.cx;
    const y = CIRCLE.cy - CIRCLE.r; // the top contour
    const id = edgeFieldAt(idPair.atlas, x, y);
    const sh = edgeFieldAt(shPair.atlas, x, y);
    expect(id.wEdge).toBe(1);
    expect(sh.wEdge, 'A\'s edge is the same in both pairs').toBe(1);
    expect(id.wCoinc).toBe(1);
    expect(sh.wCoinc, 'B\'s contour is 12 px away — beyond the dilation').toBe(0);
    expect(leadFor(id)).toBeGreaterThan(leadFor(sh));
    // The gap is at least the whole coincidence term: wSim can only be lower
    // against the shifted B, and an outside-leaning inside term contributes 0.
    expect(leadFor(id) - leadFor(sh)).toBeGreaterThanOrEqual(EDGEFADER_LEAD_COINCIDENCE / LEAD_SPAN - 1e-12);
  });

  it('(g) similarity leads: a flat pixel inside a region where BOTH frames carry edges has wSim > 0 and a higher leadN than a flat pixel outside it', () => {
    const p = checkerChecker();
    const inside = edgeFieldAt(p.atlas, 35, 27);
    const outside = edgeFieldAt(p.atlas, 140, 100);
    expect(inside.wEdge, 'the chosen pixel is flat in both frames').toBe(0);
    expect(inside.wCoinc).toBe(0);
    expect(inside.wSim, 'both frames carry a similar amount of edge around it').toBeGreaterThan(0);
    expect(outside.wSim).toBe(0);
    expect(outside, 'the outside pixel is flat and far from everything').toEqual(field());
    expect(leadFor(inside)).toBeGreaterThan(leadFor(outside));
    expect(leadFor(inside)).toBeGreaterThanOrEqual(EDGEFADER_LEAD_SIMILARITY * inside.wSim / LEAD_SPAN - 1e-12);
    expect(EDGEFADER_COARSE_PX).toBe(32);
  });

  it('(h) melt differs from blur at mid-fade, carries band 0 into band 1 (meltLayer), and never leaves the pair\'s [min, max]', () => {
    const p = circleFlat();
    let maxDiff = 0;
    let where = '';
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 4) {
        const d = Math.abs(px(p, x, y, 0.5, MELT) - px(p, x, y, 0.5, BLUR));
        if (d > maxDiff) { maxDiff = d; where = `(${x},${y})`; }
      }
    }
    expect(maxDiff, `melt and blur differ at ${where}`).toBeGreaterThan(0.05);

    let fromAbove = 0;
    const band1Top = Math.floor((1 / N) * H);
    for (let y = band1Top; y < band1Top + 6; y++) {
      for (let x = 0; x < W; x += 2) {
        const L = meltLayer(p.atlas, x01Of(x), rowFromTopOf(y), 0, 1, ASPECT);
        if (L.cover > 0 && L.srcRowFromTop < 1 / N) fromAbove++;
      }
    }
    expect(fromAbove, 'band 1\'s top rows sample band 0\'s content').toBeGreaterThan(0);

    const lv = levels();
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < W * H; i++) {
      lo = Math.min(lo, lv.a[i]!, lv.b[i]!);
      hi = Math.max(hi, lv.a[i]!, lv.b[i]!);
    }
    expect(lo, 'float32 of 0.25').toBeCloseTo(0.25, 6);
    expect(hi, 'float32 of 0.85').toBeCloseTo(0.85, 6);
    for (const t of [0.15, 0.35, 0.5, 0.65, 0.85]) {
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          const v = px(lv, x, y, t, MELT);
          expect(v, `t=${t} (${x},${y}) ≥ min`).toBeGreaterThanOrEqual(lo - 1e-12);
          expect(v, `t=${t} (${x},${y}) ≤ max`).toBeLessThanOrEqual(hi + 1e-12);
        }
      }
    }
  });

  it('(i) an unpatched B (hasB: false) contributes no edges: edgeB all zero and wCoinc 0 everywhere', () => {
    const p = circleUnpatched();
    let sum = 0;
    for (let i = 0; i < W * H; i++) sum += p.atlas.edgeB[i]!;
    expect(sum).toBe(0);
    let edgesA = 0;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const f = edgeFieldAt(p.atlas, x, y);
        expect(f.wCoinc, `(${x},${y})`).toBe(0);
        expect(f.wSim, `(${x},${y}) no similarity without B`).toBe(0);
        edgesA += f.wEdge;
      }
    }
    expect(edgesA, 'A\'s own edges are still there').toBeGreaterThan(0);
  });
});

// ─────────────────────────── the GLSL constants guard ───────────────────────

describe('edgefader.ts — the GLSL takes its constants from the exports, never re-typed', () => {
  const src = readFileSync(fileURLToPath(new URL('./edgefader.ts', import.meta.url)), 'utf8');

  it('the band count N is interpolated from EDGEFADER_BANDS and never typed as a literal', () => {
    const decls = [...src.matchAll(/const float N\s*=\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(decls).toEqual(['${f(EDGEFADER_BANDS)}']);
    expect(src).not.toMatch(/const float N\s*=\s*\d/);
  });

  it('the only typed float literals in the shaders are the math constants TAU and PI', () => {
    const typed = [...src.matchAll(/const float (\w+)\s*=\s*[0-9]/g)].map((m) => m[1]!).sort();
    expect(typed).toEqual(['PI', 'TAU']);
    expect(src).not.toMatch(/const int \w+\s*=\s*[0-9]/);
  });
});
