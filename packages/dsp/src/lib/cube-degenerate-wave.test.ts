// packages/dsp/src/lib/cube-degenerate-wave.test.ts
//
// CUBE's two DC FAULTS, and the guard that was structurally blind to both.
//
// THE BUG. `crush ≥ 0.999` and `space_diffuse = 1.0` each drove the oscillator
// to `acRms` EXACTLY 0.000000 with a full-scale DC offset (−1.0000 and −0.2125
// respectively) — reachable by knob AND by CV, since both are plain linear
// `cvScale` params on a 0..1 AudioParam. A wavetable is replayed by a phase
// accumulator, so a buffer pinned at a constant is not a quiet sound, it is NO
// sound plus a DC step into both output channels.
//
// WHY NOTHING CAUGHT IT, WHICH IS THE ACTUAL BUG. The module HAS a no-dropout
// guard, `isSilentWave`, and it ran on every adopt. It tested `all |v| ≤ eps`.
// A constant −1 has |v| = 1 at every sample, so it passed the test with room to
// spare and the guard adopted every DC fault the module produced. The guard was
// not broken — it was measuring the wrong quantity, which reads exactly like a
// clean bill of health. This file therefore pins BOTH the controls and the
// predicate, because fixing only the controls would leave the blind guard in
// place for the next one.
//
// The ART scenario had already noticed the symptom and worked around it: two
// baselines (`crushed`, `space-diffuse-max`) were DELETED as "byte-identical
// duplicates" of each other with a note that both extremes collapsing "may be
// worth a DSP review". They were duplicates because they were both the constant
// −1. This is that review; the baselines come back in the same commit.
//
// ⚠ SCOPE OF THIS FILE, STATED SO A GREEN RUN CANNOT BE MISREAD. Everything
// here is table-INDEPENDENT: the predicate, the two cap functions, and the
// proof that the guard nets what the caps provably cannot. The claim that a
// FRESHLY SPAWNED cube stays a signal at either maximum depends on the factory
// table DATA, which lives in another package — that sweep is
// `cube-dc-faults.test.ts` in packages/web, and this file cannot see it.

import { describe, expect, it } from 'vitest';
import {
  sampleSlice,
  isDegenerateWave,
  crushLevels,
  diffusePull,
  CUBE_CRUSH_MIN_LEVELS,
  CUBE_DIFFUSE_MAX_PULL,
  WAVETABLE_FRAME_SIZE,
  type SliceParams,
} from './cube-dsp';

// ── Tables. Synthetic + hand-predictable, like the ART scenario's, so this
// file does not depend on the factory-table data (which lives in another
// package and changes for its own reasons).
const FRAMES = 64;
const COLS = WAVETABLE_FRAME_SIZE;
function constTable(value: number): Float32Array[] {
  return Array.from({ length: FRAMES }, () => new Float32Array(COLS).fill(value));
}
function rampInXTable(lo: number, hi: number): Float32Array[] {
  return Array.from({ length: FRAMES }, () => {
    const row = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) row[c] = lo + (hi - lo) * (c / (COLS - 1));
    return row;
  });
}
function sineInXTable(): Float32Array[] {
  return Array.from({ length: FRAMES }, () => {
    const row = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) row[c] = Math.sin((2 * Math.PI * c) / COLS);
    return row;
  });
}
const FLOOR = constTable(-1.0);
const WALL = sineInXTable();
const CEIL = rampInXTable(-1, 1);

const slice = (over: Partial<SliceParams> = {}): SliceParams => ({
  sliceY: 0.5, rx: 0, ry: 0, rz: 0, morphFC: 0, connect: 0,
  material: 'smooth', crush: 0, wrap: false, ...over,
});
const render = (over: Partial<SliceParams> = {}) => sampleSlice(FLOOR, WALL, CEIL, slice(over));

/** AC RMS — the wave with its DC component removed. THE metric: it is what the
 *  phase accumulator actually turns into sound, and it is the one an all-zero
 *  test cannot see. */
function acRms(w: Float32Array): number {
  let sum = 0;
  for (const v of w) sum += v;
  const mean = sum / w.length;
  let ac = 0;
  for (const v of w) ac += (v - mean) ** 2;
  return Math.sqrt(ac / w.length);
}
function dc(w: Float32Array): number {
  let s = 0;
  for (const v of w) s += v;
  return s / w.length;
}

// ── The states a player can actually get to. Not an exhaustive sweep — a set
// wide enough that a fix which only works at spawn cannot pass.
const STATES: Array<[string, Partial<SliceParams>]> = [
  ['spawn', {}],
  ['rotated ry', { ry: 1.2 }],
  ['rotated ry+rz', { ry: 0.5, rz: 0.9 }],
  ['rotated rx+ry', { rx: 0.8, ry: 0.5 }],
  ['sliceY high', { sliceY: 0.9 }],
  ['sliceY low', { sliceY: 0.1 }],
  ['morph = 1', { morphFC: 1 }],
  ['HARD material', { material: 'hard' }],
  ['WRAP on', { wrap: true }],
  ['connect + strength', { connect: 1, connectStrength: 1 }],
];

describe('cube: the AC-content guard (isDegenerateWave)', () => {
  // ── NEGATIVE CONTROL IN BOTH DIRECTIONS, AS A PERMANENT LEG ──────────────
  // Run on every CI run, not once at authoring time. The predicate must trip
  // on BOTH degenerate shapes and must NOT trip on a real wave — a guard that
  // only ever returned `true` would "fix" the DC fault by muting the module,
  // and a guard that only ever returned `false` is the bug we started with.
  it('trips on TRUE SILENCE (the case the old predicate was written for)', () => {
    expect(isDegenerateWave(new Float32Array(256))).toBe(true);
  });

  it('trips on a DC-PINNED buffer — the case the old predicate could not see', () => {
    for (const level of [-1, -0.2125, 0, 0.5, 1]) {
      const w = new Float32Array(256).fill(level);
      expect(
        isDegenerateWave(w),
        `a buffer pinned at ${level} carries no AC and is inaudible; the old ` +
          `all-|v|≤eps test returned ${level === 0} for it`,
      ).toBe(true);
    }
  });

  it('does NOT trip on a real rendered wave (or the guard would mute the module)', () => {
    for (const [name, st] of STATES) {
      expect(isDegenerateWave(render(st)), `${name} is a real wave`).toBe(false);
    }
  });

  it('does NOT trip on a DC buffer carrying one sample of real signal', () => {
    // The boundary: a wave that is *nearly* constant is still a wave. This is
    // what stops the fix from over-reaching into "quiet = silent".
    const w = new Float32Array(256).fill(-1);
    w[7] = -1 + 1e-3;
    expect(isDegenerateWave(w)).toBe(false);
  });

  it('is a strict generalisation: everything the OLD predicate caught, it catches', () => {
    // The old test was `all |v| ≤ eps`. Any buffer satisfying that has zero
    // mean and zero deviation, so the new one must agree on all of them.
    const oldWouldTrip = (w: Float32Array, eps = 1e-6) =>
      Array.from(w).every((v) => Math.abs(v) <= eps);
    for (const fill of [0, 1e-9, -1e-9, 5e-7]) {
      const w = new Float32Array(64).fill(fill);
      expect(oldWouldTrip(w)).toBe(true);
      expect(isDegenerateWave(w), `old predicate tripped at fill=${fill}; new must too`).toBe(true);
    }
  });

  it('an empty buffer is degenerate (no samples = no audio)', () => {
    expect(isDegenerateWave(new Float32Array(0))).toBe(true);
  });
});

describe('cube: CRUSH at its maximum is still a signal', () => {
  it('crushLevels never returns fewer than CUBE_CRUSH_MIN_LEVELS', () => {
    for (let k = 0; k <= 1.0001; k += 0.001) {
      expect(crushLevels(k)).toBeGreaterThanOrEqual(CUBE_CRUSH_MIN_LEVELS);
    }
    expect(crushLevels(1)).toBe(CUBE_CRUSH_MIN_LEVELS);
    // …and out-of-range input still clamps rather than exploding.
    expect(crushLevels(5)).toBe(CUBE_CRUSH_MIN_LEVELS);
    expect(crushLevels(-5)).toBe(256);
  });

  it('THE CAP IS AN ENDPOINT CAP, NOT A RESHAPE — the law below it is untouched', () => {
    // This is the property that keeps the ART blast radius at zero: every k
    // whose shipped level count was already ≥ the floor must be BIT-identical.
    for (const k of [0, 0.1, 0.25, 0.5, 0.6, 0.75, 0.9, 0.95, 0.98, 0.99]) {
      const shipped = Math.max(2, Math.round(256 + (2 - 256) * k));
      expect(crushLevels(k), `k=${k} must not move; it was already ≥ the floor`).toBe(shipped);
    }
    // …and it DOES bite where the shipped law went below the floor.
    expect(Math.max(2, Math.round(256 + (2 - 256) * 1))).toBe(2); // the old value
    expect(crushLevels(1)).toBe(4); // the capped one
  });

  it('crush = 1 leaves AC content on the states these tables CAN speak for', () => {
    // ⚠ `morphFC ≳ 0.5` is deliberately absent — see the "no cap can cover it"
    // block below, which asserts it collapses and that the guard catches it.
    // Naming the exclusion here so this list cannot quietly shrink to the easy
    // cases and still read as coverage.
    for (const [name, st] of STATES) {
      if (st.morphFC) continue;
      const w = render({ ...st, crush: 1 });
      expect(
        acRms(w),
        `${name} at crush=1: acRms ${acRms(w).toFixed(6)}, DC ${dc(w).toFixed(4)}. ` +
          `0.000000 means the quantizer collapsed every sample onto one level ` +
          `and the module is emitting a DC step, not audio.`,
      ).toBeGreaterThan(0.01);
      expect(isDegenerateWave(w), `${name} at crush=1 must not be degenerate`).toBe(false);
    }
  });

  it('POSITIVE CONTROL: 2 levels — the shipped floor — really does collapse it', () => {
    // Without this the test above could be passing because the states are easy,
    // not because the floor of 4 is doing anything. Reproduce the old fault by
    // quantizing the same depth signal to 2 levels by hand.
    const clean = render();
    const twoLevel = Float32Array.from(clean, (v) => {
      const depth = (v + 1) / 2;
      return Math.round(depth * (2 - 1)) / (2 - 1) * 2 - 1;
    });
    expect(acRms(twoLevel), 'the 2-level quantizer must produce the DC fault').toBe(0);
    expect(isDegenerateWave(twoLevel)).toBe(true);
    expect(dc(twoLevel)).toBe(-1);
  });
});

describe('cube: SPACE DIFFUSE at its maximum is still a signal', () => {
  it('diffusePull never reaches the face exactly', () => {
    // pull = 1 returns `target` verbatim for every sample of every ray, so all
    // 256 rays read one column of the heightfield and the wave is a constant.
    for (const dir of [-1, 1] as const) {
      const target = dir > 0 ? 1 : 0;
      expect(diffusePull(0.3, 1, dir)).not.toBe(target);
      expect(diffusePull(0.7, 1, dir)).not.toBe(target);
    }
    // k = 0 is still an EXACT identity (no arithmetic) — the transparent case.
    expect(diffusePull(0.3, 0, 1)).toBe(0.3);
  });

  it('THE CAP IS AN ENDPOINT CAP — the kk² law below it is untouched', () => {
    for (const k of [0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
      const shipped = 0.3 + (1 - 0.3) * (k * k);
      expect(diffusePull(0.3, k, 1), `k=${k} must not move`).toBeCloseTo(shipped, 12);
    }
    expect(Math.min(1 * 1, CUBE_DIFFUSE_MAX_PULL)).toBe(CUBE_DIFFUSE_MAX_PULL);
  });

  it('space_diffuse = 1 leaves AC content in every canonical state', () => {
    for (const [name, st] of STATES) {
      if (st.morphFC) continue; // same exclusion, same reason
      const w = render({ ...st, spaceDiffuse: 1 });
      expect(
        acRms(w),
        `${name} at space_diffuse=1: acRms ${acRms(w).toFixed(6)}, DC ${dc(w).toFixed(4)}. ` +
          `0.000000 means every marched sample collapsed onto one face coordinate.`,
      ).toBeGreaterThan(0.005);
      expect(isDegenerateWave(w), `${name} at diffuse=1 must not be degenerate`).toBe(false);
    }
  });

  it('POSITIVE CONTROL: an UNCAPPED pull really does collapse it', () => {
    // Prove the cap is what is doing the work. `diffusePull` at pull=1 is
    // exactly `target`, so a wave built from it has zero spread by
    // construction — which is the collapse, stated as arithmetic.
    for (const dir of [-1, 1] as const) {
      const target = dir > 0 ? 1 : 0;
      const uncapped = (c: number) => c + (target - c) * 1;
      const spread = new Set([0.1, 0.4, 0.6, 0.9].map(uncapped));
      expect(spread.size, 'an uncapped pull maps every coordinate onto one').toBe(1);
      // …and the capped one preserves the ordering that carries the signal.
      const capped = [0.1, 0.4, 0.6, 0.9].map((c) => diffusePull(c, 1, dir));
      expect(new Set(capped).size).toBe(4);
    }
  });
});

describe('cube: the residual corner is NETTED, since no cap can cover it', () => {
  // ── THE HONESTY LEGS. Capping the controls is necessary and NOT sufficient,
  // and pretending otherwise is how the first blind guard got written. These
  // assert the exact cases the caps provably cannot reach, so that the guard's
  // load-bearing role is a tested claim rather than a comment.

  it('CRUSH at max can still collapse — the SPATIAL grid, not the quantizer', () => {
    // The mechanism, and the reason `CUBE_CRUSH_MIN_LEVELS` cannot be raised to
    // fix it: with these tables at morph = 1 the depth signal is ALREADY a
    // single value BEFORE any amplitude quantization, because `crushCoord`
    // snaps the lookup coords onto a 4-step grid and the field is uniform
    // across it. Raising the level floor to 16 changes nothing — measured.
    const depth = Array.from(render({ morphFC: 1, crush: 1 }), (v) => (v + 1) / 2);
    expect(
      new Set(depth).size,
      'the pre-quantization depth is constant, so this is a spatial collapse',
    ).toBe(1);
    for (const levels of [CUBE_CRUSH_MIN_LEVELS, 8, 16, 64]) {
      const q = Float32Array.from(depth, (d) =>
        Math.round(d * (levels - 1)) / (levels - 1) * 2 - 1);
      expect(acRms(q), `no amplitude floor can fix a spatial collapse (tried ${levels})`).toBe(0);
    }
    // …and the guard is what stands between that and a DC step on the output.
    expect(isDegenerateWave(render({ morphFC: 1, crush: 1 }))).toBe(true);
  });

  // SPACE CRUSH at 1 snaps the 1 % residual spread the diffuse cap leaves back
  // onto a single voxel cell. Surviving it would need pull ≤ ~0.83 — reshaping
  // the whole law to buy the corner where two destructive controls are both at
  // maximum.
  it('space_crush = 1 + space_diffuse = 1 is still degenerate — and the guard sees it', () => {
    const w = render({ spaceCrush: 1, spaceDiffuse: 1 });
    expect(acRms(w)).toBe(0);
    expect(
      isDegenerateWave(w),
      'the guard is the only thing standing between this corner and a DC step ' +
        'on the output — if this ever returns false the module can emit DC again',
    ).toBe(true);
  });

  it('crush = 1 + space_diffuse = 1 is likewise netted by the guard', () => {
    const w = render({ crush: 1, spaceDiffuse: 1 });
    expect(isDegenerateWave(w)).toBe(true);
  });
});
