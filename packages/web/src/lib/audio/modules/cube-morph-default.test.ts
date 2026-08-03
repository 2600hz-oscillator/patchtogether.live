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

import { describe, expect, it } from 'vitest';
import { sampleSlice, type SliceParams } from '../../../../../dsp/src/lib/cube-dsp';
import { getFactoryTable } from '$lib/audio/wavetable-factory-tables';
import { CUBE_DEFAULT_TABLES, CUBE_SLOTS, cubeDef } from './cube';

/** A def param's shipped default, BY ID — so this renders the state a fresh
 *  spawn is really in rather than a hand-typed guess at it. */
const dflt = (id: string): number => {
  const p = cubeDef.params.find((q) => q.id === id);
  expect(p, `cube must declare a "${id}" param`).toBeDefined();
  return p!.defaultValue;
};

/** The slice params a freshly spawned CUBE renders with. */
function spawnSlice(morphFC: number): Float32Array {
  const frames = (slot: 'floor' | 'wall' | 'ceiling'): Float32Array[] => {
    const t = getFactoryTable(CUBE_DEFAULT_TABLES[slot]);
    expect(t, `factory table "${CUBE_DEFAULT_TABLES[slot]}" must exist`).toBeDefined();
    return t!.frames as Float32Array[];
  };
  const p: SliceParams = {
    morphFC,
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
  };
  return sampleSlice(frames('floor'), frames('wall'), frames('ceiling'), p);
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
  it('the three default slots are not all the same table', () => {
    const ids = CUBE_SLOTS.map((s) => CUBE_DEFAULT_TABLES[s]);
    expect(
      new Set([CUBE_DEFAULT_TABLES.floor, CUBE_DEFAULT_TABLES.ceiling]).size,
      `FLOOR and CEILING both default to "${CUBE_DEFAULT_TABLES.floor}". ` +
        `MORPH cross-fades dF↔dC and both are read at the same (x,y), so ` +
        `identical tables make it algebraically inert: ` +
        `(1−m)·dF + m·dF = dF for every m. Slots: ${ids.join(' / ')}`,
    ).toBe(2);
  });

  it('sweeping MORPH 0 → 1 changes the rendered wave', () => {
    const at0 = spawnSlice(0);
    const at1 = spawnSlice(1);
    const d = deltaRms(at0, at1);
    expect(
      d,
      `MORPH 0 vs 1 differ by an RMS of ${d.toExponential(3)} on a wave whose ` +
        `own RMS is ${rms(at0).toFixed(4)}. Measured with the shipped ` +
        `floor===ceiling defaults: EXACTLY 0.000e+0 — bit-identical at every m.`,
    ).toBeGreaterThan(0.02);
  });

  it('MORPH is monotone-ish across its travel, not just different at the rails', () => {
    // A default pair that only differed at the extremes would pass the test
    // above while leaving the middle of the knob dead. Every step must move.
    const steps = [0, 0.25, 0.5, 0.75, 1].map(spawnSlice);
    const deltas = steps.slice(1).map((s, i) => deltaRms(steps[i]!, s));
    expect(
      Math.min(...deltas),
      `per-quarter-turn deltas: ${deltas.map((x) => x.toFixed(4)).join(' / ')}`,
    ).toBeGreaterThan(0.005);
  });

  // ── NEGATIVE CONTROL on the instrument ──────────────────────────────────
  // `deltaRms` must read 0 when the two slices really are the same, or the
  // assertions above would pass on a renderer that returned noise.
  it('NEGATIVE CONTROL: deltaRms is 0 for a repeated identical render', () => {
    expect(deltaRms(spawnSlice(0.3), spawnSlice(0.3))).toBe(0);
    // …and it is NOT invariant to the thing under test.
    expect(deltaRms(spawnSlice(0), spawnSlice(0.5))).toBeGreaterThan(0);
  });
});
