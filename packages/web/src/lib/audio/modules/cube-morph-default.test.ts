// packages/web/src/lib/audio/modules/cube-morph-default.test.ts
//
// CUBE's headline knob must DO something on a freshly spawned module.
//
// THE BUG THIS PINS. `CUBE_DEFAULT_TABLES` set BOTH `floor` and `ceiling` to
// `basic-shapes`. The field is
//
//     dF = occ(z, floorH, wallH)     dC = occ(z, ceilH, wallH)
//     f3 = (1 − m)·dF + m·dC                      (cube-dsp.ts)
//
// and `columnHeights` reads floor and ceiling at the SAME (x, y). Identical
// tables therefore give `floorH ≡ ceilH`, so `dF ≡ dC` and
// `f3 = (1−m)·dF + m·dF = dF` for EVERY m. MORPH — the module's identity
// control, with its own CV jack and its own docs sentence ("MORPH connects the
// wall to the floor or the ceiling") — was a BIT-EXACT no-op at spawn.
//
// WHY NOTHING CAUGHT IT. Every gate reads the CONTRACT: contract-lock pins the
// param, module-docs-lint checks it is documented, the per-port sweep proves
// the CV jack materialises an edge. None of them renders the module and asks
// whether the knob changes the output — and the default tables are DATA, not
// contract. A slice render is the only instrument that can see this.
//
// The assertion is deliberately about DEFAULTS, not about the DSP: swap any
// two distinct tables in and the maths was always right.
//
// ── AND THE SEQUEL, WHICH IS WHY THIS FILE NOW CHECKS THREE PAIRS ──────────
// Fixing floor≡ceiling did not fix the CLASS, it MOVED the collision. Every
// slot pair kills a different control, because `columnHeights` reads all three
// at the same (x, y):
//
//   floor ≡ ceiling → MORPH inert          (the bug above)
//   floor ≡ wall    → CONNECT + CNCT STR bit-exactly dead at morph = 0
//   ceiling ≡ wall  → CONNECT + CNCT STR bit-exactly dead at morph = 1
//
// THREE slots and only TWO factory tables is a pigeonhole: some pair must
// collide, so SOME control was always dead. All six two-table assignments were
// measured and every one has exactly one dead control — the shipped
// BASIC/HARM/HARM included, at `maxAbsDiff` EXACTLY 0.000e+0 for CONNECT and
// CONNECT STRENGTH at morph = 1. The fix is `pwm-sweep`, a third table.
//
// So a test that only watched floor≠ceiling would have gone green on a module
// with two dead knobs. It now watches all three pairs AND renders each one.

import { describe, expect, it } from 'vitest';
import { sampleSlice, type SliceParams } from '../../../../../dsp/src/lib/cube-dsp';
import { getFactoryTable, getFactoryTables } from '$lib/audio/wavetable-factory-tables';
import { CUBE_DEFAULT_TABLES, CUBE_SLOTS, cubeDef } from './cube';

/** A def param's shipped default, BY ID — so this renders the state a fresh
 *  spawn is really in rather than a hand-typed guess at it. */
const dflt = (id: string): number => {
  const p = cubeDef.params.find((q) => q.id === id);
  expect(p, `cube must declare a "${id}" param`).toBeDefined();
  return p!.defaultValue;
};

const framesOf = (id: string): Float32Array[] => {
  const t = getFactoryTable(id);
  expect(t, `factory table "${id}" must exist`).toBeDefined();
  return t!.frames as Float32Array[];
};

/** The slice params a freshly spawned CUBE renders with, with any subset
 *  overridden. Every value that is not overridden comes from the DEF's shipped
 *  `defaultValue`, so this renders the state a real spawn is in. */
function spawnSlice(over: Partial<SliceParams> = {}, tables = CUBE_DEFAULT_TABLES): Float32Array {
  const p: SliceParams = {
    morphFC: dflt('morph_fc'),
    connect: dflt('connect'),
    connectStrength: dflt('connect_strength'),
    material: 'smooth',
    crush: dflt('crush'),
    spaceCrush: dflt('space_crush'),
    spaceDiffuse: dflt('space_diffuse'),
    wrap: false,
    sliceY: dflt('slice_y'),
    rx: dflt('slice_rx'),
    ry: dflt('slice_ry'),
    rz: dflt('slice_rz'),
    ...over,
  };
  return sampleSlice(
    framesOf(tables.floor!), framesOf(tables.wall!), framesOf(tables.ceiling!), p,
  );
}
/** Largest single-sample difference — 0.000e+0 means BIT-identical, which is
 *  the signature a dead control leaves (an attenuated one still moves). */
function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

function rms(b: Float32Array): number {
  let x = 0;
  for (const v of b) x += v * v;
  return Math.sqrt(x / b.length);
}
/** RMS of the DIFFERENCE between two slices — 0 means bit-identical waves. */
function deltaRms(a: Float32Array, b: Float32Array): number {
  let x = 0;
  for (let i = 0; i < a.length; i++) x += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(x / a.length);
}

describe('cube: MORPH is alive on a freshly spawned module', () => {
  it('ALL THREE default slots are distinct tables', () => {
    const ids = CUBE_SLOTS.map((s) => CUBE_DEFAULT_TABLES[s]);
    // Deny by default: state each pair, so a failure names the control that
    // died rather than printing a bare set size.
    expect(
      CUBE_DEFAULT_TABLES.ceiling,
      `FLOOR ≡ CEILING ("${CUBE_DEFAULT_TABLES.floor}") makes MORPH inert: ` +
        `it cross-fades dF↔dC and both are read at the same (x,y), so ` +
        `(1−m)·dF + m·dF = dF for every m. Slots: ${ids.join(' / ')}`,
    ).not.toBe(CUBE_DEFAULT_TABLES.floor);
    expect(
      CUBE_DEFAULT_TABLES.wall,
      `FLOOR ≡ WALL ("${CUBE_DEFAULT_TABLES.floor}") makes CONNECT and CONNECT ` +
        `STRENGTH dead at morph = 0 — occ() hits its degenerate span ≤ 1e-9 ` +
        `branch and returns a hard step. Slots: ${ids.join(' / ')}`,
    ).not.toBe(CUBE_DEFAULT_TABLES.floor);
    expect(
      CUBE_DEFAULT_TABLES.wall,
      `CEILING ≡ WALL ("${CUBE_DEFAULT_TABLES.ceiling}") makes CONNECT and ` +
        `CONNECT STRENGTH dead at morph = 1 — the same degenerate branch. ` +
        `This is what the shipped defaults did. Slots: ${ids.join(' / ')}`,
    ).not.toBe(CUBE_DEFAULT_TABLES.ceiling);
    expect(new Set(ids).size, `slots: ${ids.join(' / ')}`).toBe(3);
  });

  it('sweeping MORPH 0 → 1 changes the rendered wave', () => {
    const at0 = spawnSlice({ morphFC: 0 });
    const at1 = spawnSlice({ morphFC: 1 });
    const d = deltaRms(at0, at1);
    expect(
      d,
      `MORPH 0 vs 1 differ by an RMS of ${d.toExponential(3)} on a wave whose ` +
        `own RMS is ${rms(at0).toFixed(4)}. Measured with the old ` +
        `floor===ceiling defaults: EXACTLY 0.000e+0 — bit-identical at every m.`,
    ).toBeGreaterThan(0.02);
  });

  it('MORPH is monotone-ish across its travel, not just different at the rails', () => {
    // A default pair that only differed at the extremes would pass the test
    // above while leaving the middle of the knob dead. Every step must move.
    const steps = [0, 0.25, 0.5, 0.75, 1].map((m) => spawnSlice({ morphFC: m }));
    const deltas = steps.slice(1).map((s, i) => deltaRms(steps[i]!, s));
    expect(
      Math.min(...deltas),
      `per-quarter-turn deltas: ${deltas.map((x) => x.toFixed(4)).join(' / ')}`,
    ).toBeGreaterThan(0.005);
  });

  // ── THE PIGEONHOLE — the two controls the floor≡ceiling fix silently killed ──
  // These render the module. A declaration test ("the ids differ") is not a
  // substitute: `occ`'s degenerate branch is what actually kills the knob, and
  // only a render can see it.
  for (const morph of [0, 1]) {
    it(`CONNECT moves the wave at morph = ${morph}`, () => {
      const off = spawnSlice({ morphFC: morph, connect: 0 });
      const on = spawnSlice({ morphFC: morph, connect: 1 });
      const d = maxAbsDiff(off, on);
      expect(
        d,
        `CONNECT 0 vs 1 at morph=${morph} differ by maxAbsDiff ` +
          `${d.toExponential(3)}. EXACTLY 0.000e+0 means the connector hit ` +
          `occ()'s span ≤ 1e-9 branch because two slots share a table — ` +
          `slots: ${CUBE_SLOTS.map((s) => CUBE_DEFAULT_TABLES[s]).join(' / ')}`,
      ).toBeGreaterThan(0.01);
    });

    it(`CONNECT STRENGTH moves the wave at morph = ${morph}`, () => {
      const off = spawnSlice({ morphFC: morph, connectStrength: 0 });
      const on = spawnSlice({ morphFC: morph, connectStrength: 1 });
      const d = maxAbsDiff(off, on);
      expect(
        d,
        `CNCT STR 0 vs 1 at morph=${morph} differ by maxAbsDiff ` +
          `${d.toExponential(3)}; EXACTLY 0.000e+0 = the same degenerate branch.`,
      ).toBeGreaterThan(0.01);
    });
  }

  // ── AND THE COUNTING ARGUMENT ITSELF ────────────────────────────────────
  // The reason the defaults can satisfy all three pairs at once is that there
  // are now ≥ 3 factory tables. If someone deletes one, this fails HERE with
  // the reason, instead of failing as a mystery dead knob later.
  it('the factory offers at least as many tables as CUBE has slots', () => {
    const n = getFactoryTables().length;
    expect(
      n,
      `${CUBE_SLOTS.length} slots need ${CUBE_SLOTS.length} distinct tables — ` +
        `each coinciding pair kills a different control (MORPH, or CONNECT at ` +
        `one end of MORPH). With only ${n} tables SOME pair must collide by ` +
        `pigeonhole. Tables: ${getFactoryTables().map((t) => t.id).join(', ')}`,
    ).toBeGreaterThanOrEqual(CUBE_SLOTS.length);
  });

  // ── POSITIVE CONTROL: the collisions this file exists to forbid really do
  // kill those controls. Without this, every assertion above could be passing
  // for a reason unrelated to the table assignment.
  it('POSITIVE CONTROL: a colliding assignment DOES kill the named control', () => {
    const B = 'basic-shapes', H = 'harmonic-sweep';
    // floor ≡ ceiling → MORPH inert.
    expect(
      deltaRms(
        spawnSlice({ morphFC: 0 }, { floor: B, wall: H, ceiling: B }),
        spawnSlice({ morphFC: 1 }, { floor: B, wall: H, ceiling: B }),
      ),
      'floor ≡ ceiling must make MORPH bit-exactly inert',
    ).toBe(0);
    // ceiling ≡ wall → CONNECT dead at morph = 1 (the SHIPPED defect).
    expect(
      maxAbsDiff(
        spawnSlice({ morphFC: 1, connect: 0 }, { floor: B, wall: H, ceiling: H }),
        spawnSlice({ morphFC: 1, connect: 1 }, { floor: B, wall: H, ceiling: H }),
      ),
      'ceiling ≡ wall must make CONNECT bit-exactly dead at morph = 1',
    ).toBe(0);
    // floor ≡ wall → CONNECT dead at morph = 0.
    expect(
      maxAbsDiff(
        spawnSlice({ morphFC: 0, connect: 0 }, { floor: B, wall: B, ceiling: H }),
        spawnSlice({ morphFC: 0, connect: 1 }, { floor: B, wall: B, ceiling: H }),
      ),
      'floor ≡ wall must make CONNECT bit-exactly dead at morph = 0',
    ).toBe(0);
  });

  // ── NEGATIVE CONTROL on the instrument ──────────────────────────────────
  // `deltaRms` must read 0 when the two slices really are the same, or the
  // assertions above would pass on a renderer that returned noise.
  it('NEGATIVE CONTROL: deltaRms is 0 for a repeated identical render', () => {
    expect(deltaRms(spawnSlice({ morphFC: 0.3 }), spawnSlice({ morphFC: 0.3 }))).toBe(0);
    // …and it is NOT invariant to the thing under test.
    expect(deltaRms(spawnSlice({ morphFC: 0 }), spawnSlice({ morphFC: 0.5 }))).toBeGreaterThan(0);
    // …and neither is maxAbsDiff, the instrument the CONNECT legs read.
    expect(maxAbsDiff(spawnSlice({ connect: 0.3 }), spawnSlice({ connect: 0.3 }))).toBe(0);
    expect(maxAbsDiff(spawnSlice({ connect: 0 }), spawnSlice({ connect: 1 }))).toBeGreaterThan(0);
  });
});
