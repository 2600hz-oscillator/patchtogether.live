// packages/web/src/lib/ui/modules/moog984-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind the moog984 faceplate's four column
// readouts, plus the totality legs that keep them from taking the face down.
//
// WHAT MAKES THIS FILE NECESSARY rather than decorative: `out_j = Σ_i in_i ·
// m_ij`, so an output's gain is a JOIN over a COLUMN of the matrix. The nearest
// knob to OUT 1 is `m11` — it moves when you turn `m11`, it looks right, and it
// is invariant to `m21`/`m31`/`m41`, which are three quarters of what OUT 1
// carries. A reviewer perturbing "the obvious knob" gets a green either way, so
// the difference between this readout and a relabelled knob is not observable
// at authoring time. It is observable HERE, in both directions:
//
//   MOVES  with its own column   — the leg a `m11` readback FAILS
//   INVARIANT to its own row     — the leg a `m11` readback also fails, in the
//                                  opposite direction (it moves when it must
//                                  not)
//
// ⚠ THE SECOND LEG IS THE ONE THAT ACTUALLY DISCRIMINATES, and it is why both
// are here. A readout that simply summed all sixteen cross-points would pass
// the first leg on every column while being the same number four times over.
// Only the invariance leg can tell a COLUMN sum from a MATRIX sum.

import { describe, expect, it } from 'vitest';
import { moog984Def } from '$lib/audio/modules/moog984';
import {
  MOOG984_COLUMNS,
  MOOG984_COLUMN_READOUTS,
  moog984ColumnDb,
  moog984ColumnGain,
  moog984ColumnText,
} from './moog984-face-model';

/** A reader over an explicit patch; anything unnamed reads its DECLARED
 *  default, exactly as the live param reader does. */
function reader(patch: Readonly<Record<string, number>> = {}) {
  return (paramId: string): number | undefined => {
    if (paramId in patch) return patch[paramId];
    return moog984Def.params.find((p) => p.id === paramId)?.defaultValue;
  };
}

/** The def's own cross-point ids — DERIVED, so this test cannot drift from the
 *  roster the factory wires. */
const CROSS_IDS = moog984Def.params.map((p) => p.id);

describe('moog984 column readouts: the structure they are derived from', () => {
  it('derives one column per declared OUTPUT PORT, each holding one cross-point per INPUT PORT', () => {
    expect(MOOG984_COLUMNS.length).toBe(moog984Def.outputs.length);
    for (const col of MOOG984_COLUMNS) {
      expect(col.length).toBe(moog984Def.inputs.length);
    }
  });

  it('partitions the cross-point roster EXACTLY — every param in one column, none twice', () => {
    const flat = MOOG984_COLUMNS.flatMap((c) => [...c]);
    expect([...flat].sort()).toEqual([...CROSS_IDS].sort());
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('column j holds the cross-points whose OUTPUT index is j', () => {
    MOOG984_COLUMNS.forEach((col, k) => {
      for (const id of col) expect(id.endsWith(String(k + 1))).toBe(true);
    });
  });
});

describe('moog984 column readouts: THE NEGATIVE CONTROLS', () => {
  // OUT 1's column is m11/m21/m31/m41; its ROW-1 siblings are m12/m13/m14.
  it('MOVES with every cross-point in its own column — including the three a m11 readback is BLIND to', () => {
    const base = moog984ColumnGain(reader(), 1);
    expect(base).toBe(0);

    // Each of the four, ALONE. The last three are the discriminating ones: a
    // knob readback on m11 does not move for any of them.
    for (const id of MOOG984_COLUMNS[0]!) {
      const g = moog984ColumnGain(reader({ [id]: 0.5 }), 1);
      expect(g, `OUT 1 must move when ${id} opens (it is in OUT 1's column)`).toBeCloseTo(0.5, 12);
    }
  });

  it('is INVARIANT to its own ROW — the leg that separates a COLUMN sum from a MATRIX sum', () => {
    // Open all three of input 1's OTHER cross-points to full. OUT 1 must not
    // move: they feed OUT 2/3/4. A readback of m11 is also invariant here, but
    // a naive "sum every cross-point" readout would move to 3.0 — which is why
    // this leg, not the one above, is what proves the formula.
    const rowOnly = reader({ m12: 1, m13: 1, m14: 1 });
    expect(moog984ColumnGain(rowOnly, 1)).toBe(0);
    expect(moog984ColumnText(rowOnly, 1)).toBe('silent');

    // And they land on the buses they actually feed.
    expect(moog984ColumnGain(rowOnly, 2)).toBeCloseTo(1, 12);
    expect(moog984ColumnGain(rowOnly, 3)).toBeCloseTo(1, 12);
    expect(moog984ColumnGain(rowOnly, 4)).toBeCloseTo(1, 12);
  });

  it('the four buses are INDEPENDENT — one cross-point moves exactly one readout', () => {
    const before = [1, 2, 3, 4].map((j) => moog984ColumnText(reader(), j));
    const after = [1, 2, 3, 4].map((j) => moog984ColumnText(reader({ m32: 0.75 }), j));
    // m32 is input 3 → output 2, so ONLY bus 2 may differ.
    expect(after[1]).not.toBe(before[1]);
    expect([after[0], after[2], after[3]]).toEqual([before[0], before[2], before[3]]);
  });

  it('prints the SUMMED gain, not any one knob — four cross-points at 1.0 are +12.041 dB on one bus', () => {
    const full = reader({ m11: 1, m21: 1, m31: 1, m41: 1 });
    expect(moog984ColumnGain(full, 1)).toBeCloseTo(4, 12);
    // The number no knob can show: every dial reads 1.00, the bus reads ×4.
    expect(moog984ColumnDb(full, 1)).toBeCloseTo(12.0411998, 6);
    expect(moog984ColumnText(full, 1)).toBe('+12.0 dB');
  });

  it('unity on one bus reads 0.0 dB, and a half-open cross-point reads -6.0 dB', () => {
    expect(moog984ColumnText(reader({ m11: 1 }), 1)).toBe('0.0 dB');
    expect(moog984ColumnText(reader({ m11: 0.5 }), 1)).toBe('-6.0 dB');
  });

  it('reads `silent` at the SHIPPED DEFAULTS on all four buses — the state a fresh node spawns in', () => {
    for (const p of moog984Def.params) expect(p.defaultValue).toBe(0);
    for (let j = 1; j <= moog984Def.outputs.length; j++) {
      expect(moog984ColumnText(reader(), j)).toBe('silent');
    }
  });
});

describe('moog984 column readouts: TOTALITY (it runs on every render)', () => {
  it('a FRESH node — a reader that knows nothing — returns a string, never throws', () => {
    const blank = () => undefined;
    for (let j = 1; j <= 4; j++) {
      expect(() => moog984ColumnText(blank, j)).not.toThrow();
      expect(moog984ColumnText(blank, j)).toBe('silent');
    }
  });

  it('NaN and ±Infinity on a cross-point fall back to its DECLARED default, and never print NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = reader({ m11: bad, m21: 1 });
      expect(Number.isFinite(moog984ColumnGain(r, 1))).toBe(true);
      // m11 falls back to its default (0); m21 still contributes its 1.
      expect(moog984ColumnGain(r, 1)).toBeCloseTo(1, 12);
      expect(moog984ColumnText(r, 1)).toBe('0.0 dB');
    }
  });

  it('an OUT-OF-CONTRACT write is clamped to the declared travel, not propagated', () => {
    // The seam MIDI learn / automation / a preset load reaches, and the reason
    // `moog993RouteState` exists. Without the clamp one bad key makes all four
    // readouts nonsense.
    expect(moog984ColumnGain(reader({ m11: 9999 }), 1)).toBeCloseTo(1, 12);
    expect(moog984ColumnGain(reader({ m11: -50 }), 1)).toBe(0);
  });

  it('an index naming no bus returns 0 rather than throwing', () => {
    for (const j of [0, -1, 5, 99, Number.NaN]) {
      expect(() => moog984ColumnText(reader(), j)).not.toThrow();
      expect(moog984ColumnGain(reader(), j)).toBe(0);
    }
  });
});

describe('moog984 face: the CONSOLE GRID is declared in the shape that engages it', () => {
  it('RENDERS as one band of equal clusters — the arrangement consoleGridCols answers', async () => {
    const { consoleGridCols } = await import('$lib/ui/workflow/console-grid');
    const { dockFacePlan } = await import('$lib/ui/workflow/curated-face');
    // ⚠ READ THE PLAN, NOT THE DECLARATION. The declared `face.pages` is the
    // input; `dockFacePlan` is what ModuleShell actually lays out, and the two
    // can differ (a hero promotion can empty a band, and an unresolvable key is
    // dropped). Asserting the declaration would only prove this file agrees
    // with itself.
    const plan = dockFacePlan(moog984Def)!;
    expect(plan.length).toBe(1);
    // ⚠ FOUR BANDS IS THE TRAP: packRun packs [4,4,4,4] into two rows of eight.
    expect(consoleGridCols(plan[0]!)).toBe(moog984Def.outputs.length);
  });

  it('each cluster is one INPUT ROW in output order, so the grid matches the card and the docs', () => {
    const clusters = moog984Def.face?.pages?.[0]?.clusters ?? [];
    expect(clusters.length).toBe(moog984Def.inputs.length);
    clusters.forEach((cl, i) => {
      expect(cl.label).toBe(`in ${i + 1}`);
      expect([...cl.controls]).toEqual([1, 2, 3, 4].map((j) => `m${i + 1}${j}`));
    });
  });

  it('order is COLUMN-major while pages are ROW-major — the deliberate disagreement', () => {
    const order = moog984Def.face?.order ?? [];
    // Column-major: the first four are everything reaching OUT 1.
    expect(order.slice(0, 4)).toEqual([...MOOG984_COLUMNS[0]!]);
    // Row-major page: the first four are input 1 fanning out.
    expect((moog984Def.face?.pages?.[0]?.controls ?? []).slice(0, 4)).toEqual([
      'm11',
      'm12',
      'm13',
      'm14',
    ]);
    // Both are the SAME multiset — completeness, in the direction the lint
    // checks from the other side.
    expect([...order].sort()).toEqual([...CROSS_IDS].sort());
  });
});
