// packages/web/src/lib/audio/modules/cube-dc-faults.test.ts
//
// THE STATES A REAL SPAWN REACHES. `cube-degenerate-wave.test.ts` (packages/dsp)
// pins the predicate and the two cap functions, but it renders through synthetic
// hand-written tables because it cannot import the factory data from this
// package. That leaves exactly one claim unproven over there, and it is the one
// the player experiences:
//
//    on a freshly spawned CUBE, turning CRUSH or SPACE DIFFUSE to maximum
//    must leave a SIGNAL, not a DC step.
//
// Both faults were reachable by knob AND by CV (`cvScale: {mode:'linear'}` onto
// a 0..1 AudioParam), so "nobody turns it all the way up" was never a defence.
//
// ⚠ THIS FILE READS THE DEF'S OWN DEFAULTS AND THE SHIPPED FACTORY TABLES, so
// it re-measures rather than re-typing. If someone changes a default or swaps a
// table, this re-runs against the new spawn state instead of certifying the old
// one.

import { describe, expect, it } from 'vitest';
import {
  sampleSlice,
  sliceRay,
  rayDepth,
  isDegenerateWave,
  crushLevels,
  CUBE_CRUSH_MIN_LEVELS,
  CUBE_SLICE_SIZE,
  type SliceParams,
} from '../../../../../dsp/src/lib/cube-dsp';
import { getFactoryTable } from '$lib/audio/wavetable-factory-tables';
import { CUBE_DEFAULT_TABLES, cubeDef } from './cube';

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

function spawnParams(over: Partial<SliceParams> = {}): SliceParams {
  return {
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
}

/** Slot→table id triples this file renders through.
 *
 *  ⚠ TWO OF THEM, DELIBERATELY. The tables are USER-REPLACEABLE — every slot
 *  accepts an uploaded E352 WAV — so a level floor chosen against one table set
 *  is a floor chosen against one arbitrary data set. `PREVIOUS` is the
 *  assignment cube actually shipped before the third table landed; keeping it
 *  here is what makes "4 and not 3" a measured requirement rather than a
 *  preference, because 3 holds on the current defaults and FAILS on that one. */
const SHIPPED = CUBE_DEFAULT_TABLES;
const PREVIOUS = { floor: 'basic-shapes', wall: 'harmonic-sweep', ceiling: 'harmonic-sweep' };
type Tables = { floor: string; wall: string; ceiling: string };

/** The slice a freshly spawned CUBE renders, with a subset overridden. */
function render(over: Partial<SliceParams> = {}, t: Tables = SHIPPED as Tables): Float32Array {
  return sampleSlice(framesOf(t.floor), framesOf(t.wall), framesOf(t.ceiling), spawnParams(over));
}

/**
 * The depth signal BEFORE amplitude quantization but WITH the CRUSH spatial
 * grid already applied — i.e. exactly what `crush()` sees inside `sampleSlice`.
 *
 * ⚠ THE OBVIOUS SHORTCUT IS WRONG AND IT COST A RED RUN. Recovering depth as
 * `(render(crush:1)[n] + 1) / 2` reads back an ALREADY-QUANTIZED wave, so
 * re-quantizing it to a different level count measures nothing about the real
 * law — it quantizes 4-level data and reports whatever that gives. `rayDepth`
 * is the only honest source. Negative-controlled below.
 */
function rawDepth(over: Partial<SliceParams> = {}, t: Tables = SHIPPED as Tables): number[] {
  const p = spawnParams(over);
  const [fl, wa, ce] = [framesOf(t.floor), framesOf(t.wall), framesOf(t.ceiling)];
  const out: number[] = [];
  for (let n = 0; n < CUBE_SLICE_SIZE; n++) {
    out.push(rayDepth(fl, wa, ce, sliceRay(n, p), p, null));
  }
  return out;
}
/** The wave `levels` amplitude steps would produce from a raw depth signal. */
const quantize = (depth: number[], levels: number): Float32Array =>
  Float32Array.from(depth, (d) => (Math.round(d * (levels - 1)) / (levels - 1)) * 2 - 1);

/** AC RMS — the wave minus its DC. The metric the old `isSilentWave` could not
 *  see, and the reason both faults shipped. */
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

/** The 12 canonical states the fix was chosen against. Wide enough that a fix
 *  which only works at spawn cannot pass. */
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
  ['space_crush = 1', { spaceCrush: 1 }],
  ['connect + strength', { connect: 1, connectStrength: 1 }],
  ['space_diffuse mid', { spaceDiffuse: 0.5 }],
];

describe('cube: CRUSH at maximum', () => {
  // Both table sets, because the floor has to hold for table DATA it has never
  // seen. A pass on only the current defaults would be a pass on one data set.
  for (const [label, tables] of [['shipped', SHIPPED], ['previous', PREVIOUS]] as Array<[string, Tables]>) {
    it(`leaves AC content in all 12 canonical states — ${label} tables`, () => {
      const report: string[] = [];
      for (const [name, st] of STATES) {
        const w = render({ ...st, crush: 1 }, tables);
        report.push(`${name}: acRms ${acRms(w).toFixed(6)} DC ${dc(w).toFixed(4)}`);
        expect(
          acRms(w),
          `${name} at crush=1 (${label} tables) is a DC step, not audio. ` +
            `Full sweep:\n  ${report.join('\n  ')}`,
        ).toBeGreaterThan(0.01);
        expect(isDegenerateWave(w), `${name} at crush=1 (${label})`).toBe(false);
      }
    });
  }

  it('NEGATIVE CONTROL on the depth instrument', () => {
    // `rawDepth` + `quantize` must reproduce the REAL render bit-exactly at the
    // shipped level count, or every claim below is about a different function.
    const real = render({ crush: 1 });
    const sim = quantize(rawDepth({ crush: 1 }), crushLevels(1));
    let maxDiff = 0;
    for (let i = 0; i < real.length; i++) maxDiff = Math.max(maxDiff, Math.abs(real[i]! - sim[i]!));
    expect(maxDiff, 'the simulated quantizer must BE the real one').toBe(0);
    // …and it must MOVE when the level count moves, or it is measuring nothing.
    expect(acRms(quantize(rawDepth({ crush: 1 }), 2)))
      .not.toBe(acRms(quantize(rawDepth({ crush: 1 }), 9)));
  });

  it('POSITIVE CONTROL: the shipped floor of 2 collapsed 9 of 12 on the PREVIOUS tables', () => {
    // The fault, re-measured on every run rather than trusted from a commit
    // message. Note it is measured on the PREVIOUS tables: the third table
    // incidentally rescues most of these (1 of 12 collapses on the current
    // defaults), which is worth knowing but is NOT a fix — the table set is
    // user-replaceable and the quantizer is what has to be safe.
    const collapsed = STATES.filter(
      ([, st]) => new Set(quantize(rawDepth({ ...st, crush: 1 }, PREVIOUS), 2)).size === 1,
    ).map(([n]) => n);
    expect(
      collapsed.length,
      `the shipped 2-level quantizer must still collapse most of these states, ` +
        `or the floor of ${CUBE_CRUSH_MIN_LEVELS} is no longer what keeps them ` +
        `alive. Collapsed: ${collapsed.join(', ')}`,
    ).toBeGreaterThanOrEqual(8);
  });

  it('WHY THE FLOOR IS 4 AND NOT 3: three levels breaks WRAP on a REAL table set', () => {
    // The measured trap, and the reason the obvious "floor of 2 → 3" is wrong.
    // On the PREVIOUS defaults, WRAP at k=1 is the ONE state the 2-level floor
    // got right (a hard square). A floor of 3 puts its thresholds at 0.25/0.75,
    // which bracket the whole wrapped depth range — so 3 would have traded
    // 9 fixes for 1 new break, and the fix would have looked complete.
    //
    // ⚠ On the CURRENT defaults 3 happens to be fine. That is exactly why this
    // leg pins the previous set: "it works on today's data" is not the property
    // a floor needs to have.
    const depth = rawDepth({ wrap: true, crush: 1 }, PREVIOUS);
    expect(acRms(quantize(depth, 2)), 'WRAP is the state 2 levels got RIGHT').toBeGreaterThan(0.5);
    expect(acRms(quantize(depth, 3)), 'WRAP at 3 levels collapses — do not lower the floor').toBe(0);
    expect(
      acRms(quantize(depth, CUBE_CRUSH_MIN_LEVELS)),
      `and ${CUBE_CRUSH_MIN_LEVELS} levels is what keeps it alive`,
    ).toBeGreaterThan(0.01);
    // …and 4 holds on BOTH sets, which is the actual selection criterion.
    for (const t of [SHIPPED as Tables, PREVIOUS]) {
      for (const [name, st] of STATES) {
        const q = quantize(rawDepth({ ...st, crush: 1 }, t), CUBE_CRUSH_MIN_LEVELS);
        expect(new Set(q).size, `${name} collapses at the floor`).toBeGreaterThan(1);
      }
    }
  });

  it('the cap does not disturb the rest of the knob', () => {
    // Everything below the cap must be bit-identical to the shipped law, which
    // is what keeps the ART blast radius at zero.
    for (const k of [0, 0.25, 0.5, 0.6, 0.9, 0.99]) {
      expect(crushLevels(k)).toBe(Math.max(2, Math.round(256 + (2 - 256) * k)));
    }
  });
});

describe('cube: SPACE DIFFUSE at maximum, on the shipped tables', () => {
  it('leaves AC content in 11 of the 12 — and names the 12th', () => {
    const collapsed: string[] = [];
    for (const [name, st] of STATES) {
      const w = render({ ...st, spaceDiffuse: 1 });
      if (isDegenerateWave(w)) collapsed.push(name);
      else expect(acRms(w), `${name} at space_diffuse=1`).toBeGreaterThan(0.01);
    }
    // ⚠ DENY BY DEFAULT with a NAMED exemption. `space_crush = 1` snaps the 1 %
    // residual spread the cap leaves back onto one voxel cell; surviving it
    // would need pull ≤ ~0.83, i.e. reshaping the whole law to buy the corner
    // where two destructive controls are both at maximum. Netted by the guard.
    // A NEW collapse shows up here as an unexpected name, not as silence.
    expect(collapsed).toEqual(['space_crush = 1']);
  });

  it('the one collapse that remains is caught by the guard', () => {
    const w = render({ spaceCrush: 1, spaceDiffuse: 1 });
    expect(acRms(w)).toBe(0);
    expect(isDegenerateWave(w)).toBe(true);
  });

  it('POSITIVE CONTROL: an uncapped pull collapsed ALL 12', () => {
    // Re-derived from the law rather than asserted: at pull = 1 the coordinate
    // IS the face coordinate, so every ray reads the same column by
    // construction, whatever the tables contain.
    for (const dir of [-1, 1] as const) {
      const target = dir > 0 ? 1 : 0;
      const mapped = new Set([0.05, 0.3, 0.5, 0.8, 0.95].map((c) => c + (target - c) * 1));
      expect(mapped.size, 'pull = 1 maps every coordinate onto one').toBe(1);
    }
  });
});

describe('cube: the spawn wave itself is healthy', () => {
  it('a freshly spawned CUBE is not degenerate', () => {
    const w = render();
    expect(isDegenerateWave(w)).toBe(false);
    expect(acRms(w)).toBeGreaterThan(0.05);
  });
});
