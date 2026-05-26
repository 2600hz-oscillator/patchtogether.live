// packages/web/src/lib/audio/modules/grids.test.ts
//
// Unit tests for GRIDS pure-pattern math (mirror of packages/dsp/src/grids.ts).
// Coverage:
//   - drum-map LUT integrity (25 nodes x 96 bytes; euclidean LUT 1024 entries)
//   - readDrumMap interpolation at known X/Y against a recomputed reference
//   - density threshold -> trigger + accent decisions
//   - euclidean step counts (pulse density matches the bitmask popcount)
//   - the host module def shape (ports, params, attribution)
//   - unitToByte CV-sum mapping

import { describe, expect, it } from 'vitest';
import {
  GRIDS_NODES,
  GRIDS_EUCLIDEAN,
  GRIDS_DRUM_MAP,
  GRIDS_STEPS_PER_PATTERN,
  GRIDS_NUM_PARTS,
  GRIDS_BIT_BD,
  GRIDS_BIT_SD,
  GRIDS_BIT_HH,
  GRIDS_BIT_BD_ACCENT,
  u8Mix,
  u8u8MulShift8,
  readDrumMap,
  euclideanBit,
  evaluateDrums,
  evaluateEuclidean,
  computePerturbation,
  makeByteRng,
} from './grids-engine';
import { gridsDef, unitToByte } from './grids';

describe('GRIDS LUT integrity', () => {
  it('has 25 drum-map nodes, each 96 bytes (3 instruments x 32 steps)', () => {
    expect(GRIDS_NODES.length).toBe(25);
    for (const node of GRIDS_NODES) {
      expect(node.length).toBe(GRIDS_NUM_PARTS * GRIDS_STEPS_PER_PATTERN);
      expect(node.length).toBe(96);
      for (const b of node) expect(b).toBeGreaterThanOrEqual(0), expect(b).toBeLessThanOrEqual(255);
    }
  });

  it('drum map is 5x5 referencing valid node indices', () => {
    expect(GRIDS_DRUM_MAP.length).toBe(5);
    for (const row of GRIDS_DRUM_MAP) {
      expect(row.length).toBe(5);
      for (const idx of row) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(25);
      }
    }
    // All 25 nodes must be referenced exactly once (it's a permutation).
    const seen = new Set(GRIDS_DRUM_MAP.flat());
    expect(seen.size).toBe(25);
  });

  it('euclidean LUT has 32 lengths x 32 densities = 1024 entries', () => {
    expect(GRIDS_EUCLIDEAN.length).toBe(1024);
  });

  it('node_0 step 0 of BD is 255 (canonical downbeat) — matches resources.cc', () => {
    // node_0 first byte = 255 (BD on the downbeat).
    expect(GRIDS_NODES[0]![0]).toBe(255);
  });
});

describe('avrlib fixed-point helpers', () => {
  it('u8u8MulShift8 = (a*b)>>8', () => {
    expect(u8u8MulShift8(255, 255)).toBe(254);
    expect(u8u8MulShift8(128, 128)).toBe(64);
    expect(u8u8MulShift8(0, 200)).toBe(0);
  });

  it('u8Mix interpolates: balance 0 -> ~a, balance 255 -> ~b', () => {
    // u8Mix(a,b,0) = (a*255)>>8 — the classic MI off-by-one at the endpoints.
    expect(u8Mix(255, 0, 0)).toBe(254);
    expect(u8Mix(0, 255, 255)).toBe(254);
    expect(u8Mix(255, 0, 255)).toBe(0);
    expect(u8Mix(0, 0, 128)).toBe(0);
    // Midpoint of two equal values is that value (minus rounding).
    expect(u8Mix(200, 200, 128)).toBe(199);
  });
});

describe('readDrumMap', () => {
  // Recompute the reference value independently from the raw node bytes so the
  // test is genuinely table-driven (not a tautology against the impl).
  function reference(step: number, instrument: number, x: number, y: number): number {
    const i = x >> 6;
    const j = y >> 6;
    const aMap = GRIDS_NODES[GRIDS_DRUM_MAP[i]![j]!]!;
    const bMap = GRIDS_NODES[GRIDS_DRUM_MAP[i + 1]![j]!]!;
    const cMap = GRIDS_NODES[GRIDS_DRUM_MAP[i]![j + 1]!]!;
    const dMap = GRIDS_NODES[GRIDS_DRUM_MAP[i + 1]![j + 1]!]!;
    const off = instrument * 32 + step;
    return u8Mix(u8Mix(aMap[off]!, bMap[off]!, x << 2), u8Mix(cMap[off]!, dMap[off]!, x << 2), y << 2);
  }

  it('matches the reference interpolation across a grid of X/Y/step/instrument', () => {
    for (const x of [0, 31, 63, 64, 127, 128, 191, 200, 255]) {
      for (const y of [0, 64, 100, 128, 192, 255]) {
        for (const inst of [0, 1, 2]) {
          for (const step of [0, 1, 7, 16, 31]) {
            expect(readDrumMap(step, inst, x, y)).toBe(reference(step, inst, x, y));
          }
        }
      }
    }
  });

  it('at X=0,Y=0 BD downbeat (step 0) interpolates from node_10 — the (0,0) drum-map cell', () => {
    // GRIDS_DRUM_MAP[0][0] = 10 → node_10 BD step 0 = 145. With both balances 0
    // the nested u8Mix yields 143 (the classic MI endpoint rounding).
    expect(GRIDS_NODES[10]![0]).toBe(145);
    expect(readDrumMap(0, 0, 0, 0)).toBe(143);
  });
});

describe('euclideanBit + evaluateEuclidean', () => {
  it('density 0 never fires, mid density fires (matches the LUT bitmask)', () => {
    // length 2 row begins at addr 32. addr 32 (density 0) = 0 → no fire;
    // addr 40 (density 8) = 1 → step 0 fires.
    expect(euclideanBit(2, 0, 0)).toBe(false);
    expect(euclideanBit(2, 8, 0)).toBe(true);
  });

  it('pulse count in a length-N pattern equals the bitmask popcount', () => {
    function popcount(v: number): number {
      let c = 0; let x = v >>> 0;
      while (x) { c += x & 1; x >>>= 1; }
      return c;
    }
    for (const length of [4, 8, 16, 32]) {
      for (const density of [0, 4, 8, 16, 31]) {
        const addr = (length - 1) * 32 + density;
        const expected = popcount(GRIDS_EUCLIDEAN[addr]! >>> 0);
        let fired = 0;
        for (let s = 0; s < length; s++) {
          if (euclideanBit(length, density, s)) fired++;
        }
        expect(fired).toBe(expected);
      }
    }
  });

  it('evaluateEuclidean reports reset on step 0 of the (>>3)+1 length', () => {
    const s = { length: [0, 0, 0] as [number, number, number], density: [255, 255, 255] as [number, number, number] };
    // length byte 0 -> (0>>3)+1 = 1 → every step is step 0 of a 1-step pattern.
    const r = evaluateEuclidean(0, s, 0);
    expect(r.reset).toBe(true);
  });
});

describe('evaluateDrums', () => {
  const noChaos: [number, number, number] = [0, 0, 0];

  it('full density (255) fires every instrument that has any level on the step', () => {
    // density 255 → threshold = ~255 & 0xff = 0 → any level>0 fires.
    const s = { x: 0, y: 0, randomness: 0, density: [255, 255, 255] as [number, number, number] };
    // BD step 0 at (0,0) has a positive level → BD fires.
    const state = evaluateDrums(0, s, noChaos);
    expect(state & GRIDS_BIT_BD).toBeTruthy();
  });

  it('zero density (0) fires nothing (threshold 255, no level exceeds it)', () => {
    const s = { x: 128, y: 128, randomness: 0, density: [0, 0, 0] as [number, number, number] };
    let any = false;
    for (let step = 0; step < 32; step++) {
      const st = evaluateDrums(step, s, noChaos);
      if (st & (GRIDS_BIT_BD | GRIDS_BIT_SD | GRIDS_BIT_HH)) any = true;
    }
    expect(any).toBe(false);
  });

  it('high level (>192) on a firing step also sets the accent bit', () => {
    // At (0,0) step 12 the BD level interpolates to 253 (> 192) → accent latches
    // when density is high enough to fire it.
    const s = { x: 0, y: 0, randomness: 0, density: [255, 255, 255] as [number, number, number] };
    expect(readDrumMap(12, 0, 0, 0)).toBeGreaterThan(192);
    const state = evaluateDrums(12, s, noChaos);
    expect(state & GRIDS_BIT_BD).toBeTruthy();
    expect(state & GRIDS_BIT_BD_ACCENT).toBeTruthy();
  });

  it('chaos perturbation only raises levels (never reduces firing vs. no chaos)', () => {
    const base = { x: 80, y: 80, randomness: 200, density: [128, 128, 128] as [number, number, number] };
    const rng = makeByteRng(12345);
    const pert = computePerturbation(base.randomness, rng);
    let firesWith = 0;
    let firesWithout = 0;
    for (let step = 0; step < 32; step++) {
      if (evaluateDrums(step, base, pert) & GRIDS_BIT_BD) firesWith++;
      if (evaluateDrums(step, base, noChaos) & GRIDS_BIT_BD) firesWithout++;
    }
    expect(firesWith).toBeGreaterThanOrEqual(firesWithout);
  });
});

describe('computePerturbation + makeByteRng', () => {
  it('is deterministic for a given seed', () => {
    const a = computePerturbation(255, makeByteRng(42));
    const b = computePerturbation(255, makeByteRng(42));
    expect(a).toEqual(b);
  });

  it('zero randomness yields zero perturbation', () => {
    expect(computePerturbation(0, makeByteRng(1))).toEqual([0, 0, 0]);
  });

  it('rng bytes are in 0..255', () => {
    const rng = makeByteRng(7);
    for (let i = 0; i < 1000; i++) {
      const b = rng();
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
  });
});

describe('unitToByte (CV-sum mapping)', () => {
  it('maps knob 0..1 → 0..255', () => {
    expect(unitToByte(0, 0)).toBe(0);
    expect(unitToByte(1, 0)).toBe(255);
    expect(unitToByte(0.5, 0)).toBe(128);
  });
  it('CV sums on top of the knob and clamps to 0..255', () => {
    expect(unitToByte(0.5, 0.5)).toBe(255);
    expect(unitToByte(0.5, -1)).toBe(0);
    expect(unitToByte(0, 2)).toBe(255);
  });
});

describe('gridsDef module shape', () => {
  it('declares clock/reset/CV inputs and BD/SD/HH/accent/clock gate outputs', () => {
    const inIds = gridsDef.inputs.map((p) => p.id);
    expect(inIds).toContain('clock');
    expect(inIds).toContain('reset');
    expect(inIds).toContain('mapX_cv');
    expect(inIds).toContain('mapY_cv');
    const outIds = gridsDef.outputs.map((p) => p.id);
    expect(outIds).toEqual(['bd', 'sd', 'hh', 'accent', 'clock']);
    for (const p of gridsDef.outputs) expect(p.type).toBe('gate');
  });

  it('carries MI attribution and exposes a Run control', () => {
    expect(gridsDef.ossAttribution?.author).toBe('Émilie Gillet');
    expect(gridsDef.type).toBe('grids');
    expect(gridsDef.exposableControls?.some((c) => c.paramId === 'isPlaying')).toBe(true);
  });

  it('every param has a finite default within [min, max]', () => {
    for (const p of gridsDef.params) {
      expect(Number.isFinite(p.defaultValue)).toBe(true);
      if (typeof p.min === 'number') expect(p.defaultValue).toBeGreaterThanOrEqual(p.min);
      if (typeof p.max === 'number') expect(p.defaultValue).toBeLessThanOrEqual(p.max);
    }
  });
});
