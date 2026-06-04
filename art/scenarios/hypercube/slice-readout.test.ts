// art/scenarios/hypercube/slice-readout.test.ts
//
// ART scenario for HYPERCUBE — the 4D tesseract extension of CUBE. Two layers:
//
//   1. Repo-standard build-toolchain pin: the compiled hypercube worklet exists
//      + the built .sha still matches the source .ts (catches a stale dist/).
//   2. DETERMINISTIC per-config .f32 baselines: render the SURFACE-HEIGHT SCAN
//      slice waveform via the SHARED cube-dsp.sampleSlice() helper (the SAME
//      math the worklet runs) through a synthetic floor/wall/ceiling table set
//      PLUS a non-trivial HOLO table, for several ALPHA configs:
//        • alpha-zero   — ALPHA=0; MUST equal the plain 3-table CUBE render
//                         (the backwards-compat guard — proven exactly below).
//        • alpha-mid    — ALPHA=0.5 (the tesseract cross-section morphing in).
//        • alpha-max    — ALPHA=1 (fully the HOLO-blended field).
//        • alpha-rotated— ALPHA=1 with the slice rotated.
//      Each rendered waveform is pinned as a .f32 baseline + qualitative checks.
//
// These are NEW HYPERCUBE baselines under art/baselines/hypercube/ — they do NOT
// touch CUBE's 8 baselines (the SIBLING-module guarantee).
//
// On first run (or UPDATE_BASELINES=1) the .f32 baselines are written; later
// runs compare (RMS tier B). Regenerate with `npm run art:update -w art`.

import { describe, it, expect } from 'vitest';
import {
  sampleSlice,
  CUBE_SLICE_SIZE,
  WAVETABLE_FRAME_SIZE,
  type SliceParams,
} from '../../../packages/dsp/src/lib/cube-dsp';
import {
  readBaseline,
  writeBaseline,
  compareBuffers,
  builtSha,
  moduleSourceSha,
  SHOULD_UPDATE_BASELINES,
} from '../../setup/render';

const FRAMES = 64;
const COLS = WAVETABLE_FRAME_SIZE; // 256

// ── Synthetic, hand-predictable tables (deterministic across runs/machines) ──

function constTable(value: number): Float32Array[] {
  const t: Float32Array[] = [];
  for (let f = 0; f < FRAMES; f++) t.push(new Float32Array(COLS).fill(value));
  return t;
}
function rampInXTable(lo: number, hi: number): Float32Array[] {
  const t: Float32Array[] = [];
  for (let f = 0; f < FRAMES; f++) {
    const row = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) row[c] = lo + (hi - lo) * (c / (COLS - 1));
    t.push(row);
  }
  return t;
}
function sineInXTable(): Float32Array[] {
  const t: Float32Array[] = [];
  for (let f = 0; f < FRAMES; f++) {
    const row = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) row[c] = Math.sin((2 * Math.PI * c) / COLS);
    t.push(row);
  }
  return t;
}
/** A non-trivial HOLO relief that differs from floor/ceiling so ALPHA bites:
 *  a two-cycle cosine across x (frame-independent). */
function holoTable(): Float32Array[] {
  const t: Float32Array[] = [];
  for (let f = 0; f < FRAMES; f++) {
    const row = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) row[c] = Math.cos((4 * Math.PI * c) / COLS);
    t.push(row);
  }
  return t;
}

// Fixed table set used by every config so the baselines are comparable. The 3
// base tables match CUBE's ART set exactly so `alpha-zero` provably equals a
// plain CUBE render.
const FLOOR = constTable(-1.0);
const WALL = sineInXTable();
const CEIL = rampInXTable(-1, 1);
const HOLO = holoTable();

const baseSlice = (over: Partial<SliceParams> = {}): SliceParams => ({
  sliceY: 0.5,
  rx: 0,
  ry: 0,
  rz: 0,
  morphFC: 0,
  connect: 0,
  material: 'smooth',
  crush: 0,
  wrap: false,
  ...over,
});

const CONFIGS: Array<{ id: string; sp: SliceParams }> = [
  { id: 'alpha-zero',    sp: baseSlice({ alpha: 0, morphFC: 0.5 }) },
  { id: 'alpha-mid',     sp: baseSlice({ alpha: 0.5, morphFC: 0.5 }) },
  { id: 'alpha-max',     sp: baseSlice({ alpha: 1, morphFC: 0.5 }) },
  { id: 'alpha-rotated', sp: baseSlice({ alpha: 1, morphFC: 0.5, rx: 0.7, ry: 0.4, rz: 0.2 }) },
];

describe('hypercube / build-toolchain pin', () => {
  it('built artifact SHA matches the source SHA (refresh dist/ if it fails)', async () => {
    const src = await moduleSourceSha('hypercube');
    const built = await builtSha('hypercube');
    expect(built, 'forgot `node packages/dsp/scripts/build.mjs hypercube`?').toBe(src);
  });
});

describe('hypercube / tesseract slice readout — deterministic baselines', () => {
  for (const { id, sp } of CONFIGS) {
    it(`${id}: length 256, in [-1,1], matches .f32 baseline`, async () => {
      const wave = sampleSlice(FLOOR, WALL, CEIL, sp, 0, HOLO);
      expect(wave.length).toBe(CUBE_SLICE_SIZE);
      for (const v of wave) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
        expect(Number.isFinite(v)).toBe(true);
      }

      const scenarioId = `hypercube/${id}`;
      const existing = await readBaseline(scenarioId);
      if (SHOULD_UPDATE_BASELINES || !existing) {
        await writeBaseline(scenarioId, wave);
        return;
      }
      const cmp = compareBuffers(wave, existing, 'B');
      expect(cmp.pass, cmp.detail).toBe(true);
    });
  }

  it('alpha-zero EQUALS the plain 3-table CUBE render (backwards-compat guard)', () => {
    // The defining HYPERCUBE invariant: ALPHA=0 with the HOLO table present must
    // be byte-for-byte the same as the plain 3-table render. (Exact ===, not RMS
    // — far stronger than the tier-B baseline compare above.)
    const sp = baseSlice({ alpha: 0, morphFC: 0.5 });
    const threeTable = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ morphFC: 0.5 }));
    const hyperAlpha0 = sampleSlice(FLOOR, WALL, CEIL, sp, 0, HOLO);
    expect(hyperAlpha0.length).toBe(threeTable.length);
    for (let i = 0; i < threeTable.length; i++) {
      expect(hyperAlpha0[i]).toBe(threeTable[i]);
    }
  });

  it('ALPHA=1 audibly differs from ALPHA=0 (the HOLO table actually contributes)', () => {
    const alpha0 = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ alpha: 0, morphFC: 0.5 }), 0, HOLO);
    const alpha1 = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ alpha: 1, morphFC: 0.5 }), 0, HOLO);
    let s = 0;
    for (let i = 0; i < alpha0.length; i++) { const d = alpha0[i]! - alpha1[i]!; s += d * d; }
    expect(Math.sqrt(s / alpha0.length)).toBeGreaterThan(1e-3);
  });

  it('a mid ALPHA sits between ALPHA=0 and ALPHA=1 (continuous morph)', () => {
    const rms = (x: Float32Array, y: Float32Array) => {
      let s = 0; for (let i = 0; i < x.length; i++) { const d = x[i]! - y[i]!; s += d * d; }
      return Math.sqrt(s / x.length);
    };
    const a0 = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ alpha: 0, morphFC: 0.5 }), 0, HOLO);
    const aMid = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ alpha: 0.5, morphFC: 0.5 }), 0, HOLO);
    const a1 = sampleSlice(FLOOR, WALL, CEIL, baseSlice({ alpha: 1, morphFC: 0.5 }), 0, HOLO);
    expect(rms(a0, aMid)).toBeGreaterThan(0);
    expect(rms(a0, aMid)).toBeLessThan(rms(a0, a1));
  });
});
