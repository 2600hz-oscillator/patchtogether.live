// packages/web/src/lib/ui/workflow/dock-row-plan.test.ts
//
// PF-21 — the gate for the DOCK ROW PLAN (which section bands share a row).
//
// Pure unit, zero flake. Three things it has to hold, and one it has to prove
// about ITSELF:
//
//  1. TOTALITY — the rows carry exactly the bands that went in, in order. A
//     regrouping bug looks like a faceplate that quietly lost a section, which
//     is `dockFacePlan`'s control-loss class one level up.
//  2. THE CEILING — no row exceeds DOCK_ROW_MAX_CONTROLS unless it is a single
//     over-sized band (a section is atomic and is never split).
//  3. THE OWNER'S EXAMPLE — sixstrum's real band shape packs to the layout the
//     owner asked for by NAME, from the live registry, not from a fixture.
//
//  4. ⚠ THE INSTRUMENT IS NEGATIVE-CONTROLLED, IN BOTH DIRECTIONS, ON EVERY
//     RUN. `cellWidthClass` is the whole safety argument for packing — it is
//     what keeps a 560 px panel out of a shared row — and a classifier that
//     answered 'column' for everything would produce a green, plausible, wrong
//     plan for every face. So the fixtures below PERTURB the declaration each
//     way (give a param an `options` roster → its band must STOP packing;
//     take it away → it must START) and assert the plan MOVES. A classifier
//     blind to the dimension under test cannot pass both legs.

import { describe, it, expect } from 'vitest';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { ParamDef } from '$lib/graph/types';
import { dockFacePlan, type DockFaceBand, type FaceControl, type FaceDefLike } from './curated-face';
import { heroFacePlan, type FaceplateDefLike } from './dock-faceplate-model';
import { STRICT_FACES } from './strict-faces';
import {
  DOCK_ROW_MAX_CONTROLS,
  bandControlCount,
  bandIsPackable,
  cellWidthClass,
  dockRowPlan,
  dockRowPlanIsTotal,
  packRun,
  PARAM_CELL_WIDTH_CLASS,
  type RowPlanDefLike,
} from './dock-row-plan';
import type { ParamCellKind } from './shell-control-kind';

// ── fixtures ────────────────────────────────────────────────────────────────

const knobParam = (id: string): ParamDef => ({
  id,
  label: id,
  min: 0,
  max: 1,
  curve: 'linear',
  defaultValue: 0.5,
});

/** A band of `n` plain knob params named `<prefix>1..n`. */
function knobBand(id: string, n: number, prefix = id): { band: DockFaceBand; params: ParamDef[] } {
  const params = Array.from({ length: n }, (_, i) => knobParam(`${prefix}${i + 1}`));
  const controls: FaceControl[] = params.map((p) => ({
    key: p.id,
    kind: 'param' as const,
    paramId: p.id,
    label: p.label!,
  }));
  return { band: { id, label: id, hint: '', controls, clusters: [], clusterFlow: 'stack' }, params };
}

/** A def + bands from a list of `[bandId, controlCount]` pairs. */
function fixture(spec: readonly (readonly [string, number])[]): {
  bands: DockFaceBand[];
  def: RowPlanDefLike;
} {
  const bands: DockFaceBand[] = [];
  const params: ParamDef[] = [];
  for (const [id, n] of spec) {
    const made = knobBand(id, n);
    bands.push(made.band);
    params.push(...made.params);
  }
  return { bands, def: { type: 'fixture', params } };
}

// ── 1. TOTALITY + the ceiling ───────────────────────────────────────────────

describe('dockRowPlan — totality and the ceiling', () => {
  it('carries exactly the bands it was given, in order', () => {
    const { bands, def } = fixture([
      ['a', 3],
      ['b', 3],
      ['c', 3],
      ['d', 6],
    ]);
    const rows = dockRowPlan(bands, def);
    expect(dockRowPlanIsTotal(bands, rows)).toBe(true);
    expect(rows.flatMap((r) => r.bands.map((b) => b.id))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never exceeds the ceiling except for a single over-sized band', () => {
    const { bands, def } = fixture([
      ['big', 14],
      ['a', 4],
      ['b', 4],
      ['c', 4],
    ]);
    const rows = dockRowPlan(bands, def);
    for (const row of rows) {
      if (row.bands.length === 1) continue;
      expect(row.controls, `row ${row.id} is over the ceiling`).toBeLessThanOrEqual(
        DOCK_ROW_MAX_CONTROLS,
      );
    }
    // …and the over-sized band is alone rather than split.
    expect(rows[0].bands.map((b) => b.id)).toEqual(['big']);
    expect(rows[0].controls).toBe(14);
  });

  it('an empty / absent plan is an empty row list (never a row of nothing)', () => {
    expect(dockRowPlan(null, undefined)).toEqual([]);
    expect(dockRowPlan([], undefined)).toEqual([]);
  });

  it('a TABBED face never packs — one band per row', () => {
    // 8 one-knob bands: without the rail they would all fit on one row.
    const { bands, def } = fixture(
      Array.from({ length: 8 }, (_, i) => [`p${i}`, 1] as const),
    );
    expect(dockRowPlan(bands, def, { tabbed: false })).toHaveLength(1);
    const railed = dockRowPlan(bands, def, { tabbed: true });
    expect(railed).toHaveLength(8);
    expect(railed.every((r) => r.bands.length === 1)).toBe(true);
    // …and the default reads dockTabPlan itself, so the two consumers agree:
    // 8 bands trips DOCK_TAB_MIN_BANDS.
    expect(dockRowPlan(bands, def)).toHaveLength(8);
  });
});

// ── 2. THE PACKER's objective ───────────────────────────────────────────────

describe('packRun — minimum rows, then evenness, then heaviest row last', () => {
  it('minimises the row count', () => {
    expect(packRun([3, 2, 2, 2], 10)).toEqual([[0, 1, 2, 3]]);
    expect(packRun([7, 2, 5, 8, 3], 10)).toHaveLength(4);
  });

  it("breaks a fewest-rows tie toward the EVENEST split", () => {
    // [3,3,6] fits in 2 rows as (3|3,6)=(3,9) or (3,3|6)=(6,6). Both are two
    // rows; the second is evener, so it wins on max before lexicography ever
    // gets a say.
    expect(packRun([3, 3, 6], 10)).toEqual([
      [0, 1],
      [2],
    ]);
  });

  it('breaks an EVENNESS tie by putting the heaviest row LAST (no runt final row)', () => {
    // THE OWNER'S CASE. [3,3,3,6] packs in two rows as (6,9) or (9,6) — same
    // count, same max — and the owner asked for "2 and 3 on the same row, and
    // probably 4 and 5 as well", i.e. (6,9).
    expect(packRun([3, 3, 3, 6], 10)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('gives an over-sized band its own row and keeps going', () => {
    expect(packRun([12, 3, 3], 10)).toEqual([[0], [1, 2]]);
  });

  it('is total: every index appears exactly once, in order', () => {
    const counts = [4, 1, 9, 2, 3, 11, 2, 2];
    const flat = packRun(counts, 10).flat();
    expect(flat).toEqual(counts.map((_, i) => i));
  });
});

// ── 3. THE WIDTH CLASSIFIER — negative-controlled BOTH ways, every run ──────

describe('cellWidthClass — the instrument, perturbed in both directions', () => {
  const ctl = (id: string): FaceControl => ({ key: id, kind: 'param', paramId: id, label: id });

  it('a plain knob is a COLUMN; giving it an options roster makes it WIDE', () => {
    const plain: RowPlanDefLike = { type: 'x', params: [knobParam('mode')] };
    expect(cellWidthClass(ctl('mode'), plain)).toBe('column');

    // ONE declaration changes — the param grows named states — and the class
    // must move. `paramCellKind` renders those as an inline <Segmented> row
    // (measured 94.3–430.9 px against a 40–68.8 px knob column).
    const roster: RowPlanDefLike = {
      type: 'x',
      params: [{ ...knobParam('mode'), options: [{ value: 0, label: 'lp' }, { value: 1, label: 'hp' }] }],
    };
    expect(cellWidthClass(ctl('mode'), roster)).toBe('wide');
  });

  it('a declared GRID cell is WIDE; dropping the declaration makes it a column', () => {
    const p = knobParam('algorithm');
    expect(cellWidthClass(ctl('algorithm'), { type: 'x', params: [p] })).toBe('column');
    expect(
      cellWidthClass(ctl('algorithm'), {
        type: 'x',
        params: [p],
        face: { paramCells: { algorithm: 'grid' } },
      }),
    ).toBe('wide');
  });

  it('a declared FADER is a COLUMN — the shell renders it inside `.kcol`', () => {
    // ⚠ THIS WAS A LATENT DEFECT UNTIL marbles (2026-08-11), and the shape of
    // it is the file header's own deny-by-default arm doing exactly what it
    // should to a kind nobody had taught it. `fader` (#1464) fell through to
    // `wide`, which is the SAFE direction but the wrong answer: `ModuleShell`'s
    // fader branch is `<div class="kcol ms-cell-fader">` and `Fader.svelte` is
    // 22 px wide — narrower than the 40–68.8 px knob columns this class exists
    // to identify. noise, the kind's first consumer, could not surface it: one
    // param, promoted to the hero, zero bands, so no fader ever reached a band.
    //
    // Both directions, so the clause cannot go vacuous: the DECLARATION is what
    // moves the class, and dropping it leaves a plain knob column.
    const p = knobParam('level');
    expect(cellWidthClass(ctl('level'), { type: 'x', params: [p] })).toBe('column');
    expect(
      cellWidthClass(ctl('level'), {
        type: 'x',
        params: [p],
        face: { paramCells: { level: 'fader' } },
      }),
    ).toBe('column');
    // …and it is still distinguishable from the WIDE declared cell beside it,
    // so "everything is a column" would not pass either.
    expect(
      cellWidthClass(ctl('level'), {
        type: 'x',
        params: [{ ...p, curve: 'discrete', min: 0, max: 5 }],
        face: { paramCells: { level: 'grid' } },
      }),
    ).toBe('wide');
  });

  it('a declared MOMENTARY pad stays a column (it is a Button in a knob column)', () => {
    // A press-param SHAPE: 0..1 discrete resting at 0 (looksLikeSwitch). Only
    // the DECLARATION tells it apart from a latching switch — which is the
    // point: both stay knob columns, and the momentary path must not be
    // mis-sized as a roster.
    const p: ParamDef = { ...knobParam('strike'), curve: 'discrete', defaultValue: 0 };
    expect(cellWidthClass(ctl('strike'), { type: 'x', params: [p], face: { momentary: ['strike'] } })).toBe(
      'column',
    );
  });

  it('DENIES BY DEFAULT — an unresolvable cell is WIDE, never packed', () => {
    // A param the def does not declare (an orphaned face key — module-face-lint
    // fails it loudly; the layout must stay conservative meanwhile).
    expect(cellWidthClass(ctl('ghost'), { type: 'x', params: [] })).toBe('wide');
    // A family key with no registered shell cell (renders as the INERT cell).
    expect(
      cellWidthClass({ key: 'nope-{n}', kind: 'family', familyId: 'nope', label: 'nope' }, { type: 'x' }),
    ).toBe('wide');
  });

  it('reads the REAL registry: a panel is wide, a selector is wide, an action is a column', () => {
    // dx7's operator map declares minWidth 280; its preset roster is a
    // Selector; karplus's pluck is an action <Button>.
    expect(
      cellWidthClass(
        { key: 'dx7-operator-map-{n}', kind: 'family', familyId: 'dx7-operator-map', label: '' },
        { type: 'dx7' },
      ),
    ).toBe('wide');
    expect(
      cellWidthClass(
        { key: 'dx7-preset-select-{n}', kind: 'family', familyId: 'dx7-preset-select', label: '' },
        { type: 'dx7' },
      ),
    ).toBe('wide');
    expect(
      cellWidthClass(
        { key: 'karplus-strike-{n}', kind: 'family', familyId: 'karplus-strike', label: '' },
        { type: 'karplus' },
      ),
    ).toBe('column');
  });

  it('a WIDE cell makes its whole band solo — and the plan MOVES when it does', () => {
    const { bands, def } = fixture([
      ['a', 3],
      ['b', 3],
    ]);
    expect(dockRowPlan(bands, def)).toHaveLength(1);

    // Same two bands; ONE of a's params grows a roster. `a` must stop sharing.
    const wideDef: RowPlanDefLike = {
      ...def,
      params: def.params!.map((p) =>
        p.id === 'a1' ? { ...p, options: [{ value: 0, label: 'x' }, { value: 1, label: 'y' }] } : p,
      ),
    };
    expect(bandIsPackable(bands[0], wideDef)).toBe(false);
    expect(bandIsPackable(bands[1], wideDef)).toBe(true);
    const rows = dockRowPlan(bands, wideDef);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  // ── EXHAUSTIVE OVER THE KIND UNION, NOT OVER THE KINDS SOMEONE REMEMBERED ──
  //
  // Every test above names a kind. That is why `fader` could ship: the file
  // tested the kinds it knew about, and the one it did not know about took the
  // deny-by-default arm silently. A per-kind test cannot prevent the next
  // instance of that — only a sweep over the union can, and only if the union
  // is READ rather than re-typed here.
  //
  // `PARAM_CELL_WIDTH_CLASS` is a `Record<ParamCellKind, …>`, so TS already
  // refuses a table missing a kind (TS2741). These two legs close the other
  // half: that the table is the ONLY thing deciding, and that it has not
  // collapsed to one answer.
  it('classifies EVERY ParamCellKind explicitly — no kind reaches a default', () => {
    const kinds = Object.keys(PARAM_CELL_WIDTH_CLASS) as ParamCellKind[];
    expect(kinds.length, 'the kind table is not empty').toBeGreaterThan(0);
    for (const k of kinds) {
      expect(
        PARAM_CELL_WIDTH_CLASS[k],
        `${k}: every kind must be classified 'column' or 'wide' by NAME`,
      ).toMatch(/^(column|wide)$/);
    }
    // Both answers are actually used. A table that said 'column' for
    // everything would satisfy the loop above and destroy the packing rule —
    // this is the same "would a green run look different if the answer were
    // 'everything'?" check the repo applies to its other classifiers.
    const classes = new Set(kinds.map((k) => PARAM_CELL_WIDTH_CLASS[k]));
    expect([...classes].sort(), 'the classifier must still discriminate').toEqual(['column', 'wide']);
  });

  it('the live resolver AGREES with the table for every kind — no second opinion', () => {
    // `cellWidthClass` must be a lookup, not a re-derivation. Drive a real
    // ParamDef into each kind through the SAME resolver the shell uses and
    // require the answer to equal the table's. A divergence here is the
    // planner/renderer split that caused both this bug and the marbles one.
    const cases: { kind: ParamCellKind; def: RowPlanDefLike }[] = [
      { kind: 'knob', def: { type: 'x', params: [knobParam('p')] } },
      {
        kind: 'segmented',
        def: {
          type: 'x',
          params: [{ ...knobParam('p'), options: [{ value: 0, label: 'a' }, { value: 1, label: 'b' }] }],
        },
      },
      {
        kind: 'selector',
        def: {
          type: 'x',
          params: [
            {
              ...knobParam('p'),
              options: Array.from({ length: 9 }, (_, i) => ({ value: i, label: `o${i}` })),
            },
          ],
        },
      },
      { kind: 'grid', def: { type: 'x', params: [knobParam('p')], face: { paramCells: { p: 'grid' } } } },
      { kind: 'color', def: { type: 'x', params: [knobParam('p')], face: { paramCells: { p: 'color' } } } },
      { kind: 'fader', def: { type: 'x', params: [knobParam('p')], face: { paramCells: { p: 'fader' } } } },
      // The SAME throw in the conic knob's language — declared the same way,
      // so the resolver must reach the same width class through the same field.
      {
        kind: 'neon-fader',
        def: { type: 'x', params: [knobParam('p')], face: { paramCells: { p: 'neon-fader' } } },
      },
      // The pad is declared through `face.xyPads`, NOT `face.paramCells` — it
      // binds a PAIR and that map is keyed by one id. Driving the real resolver
      // through the real declaration field is the point of this sweep: an `xy`
      // that only resolved from a hand-written `paramCells` entry would pass a
      // fixture written the other way and fail on every real face.
      {
        kind: 'xy',
        def: {
          type: 'x',
          params: [knobParam('p'), knobParam('q')],
          face: { xyPads: [{ x: 'p', y: 'q' }] },
        },
      },
      { kind: 'momentary', def: { type: 'x', params: [knobParam('p')], face: { momentary: ['p'] } } },
      {
        kind: 'toggle',
        def: { type: 'x', params: [{ ...knobParam('p'), min: 0, max: 1, curve: 'discrete' }] },
      },
    ];
    // The sweep must cover the union — if a kind is added and no case is
    // written for it, this fails rather than quietly testing seven of eight.
    expect(
      cases.map((c) => c.kind).sort(),
      'every ParamCellKind needs a live fixture here',
    ).toEqual((Object.keys(PARAM_CELL_WIDTH_CLASS) as ParamCellKind[]).sort());

    for (const { kind, def } of cases) {
      expect(
        cellWidthClass(ctl('p'), def),
        `${kind}: the resolver disagrees with PARAM_CELL_WIDTH_CLASS`,
      ).toBe(PARAM_CELL_WIDTH_CLASS[kind]);
    }
  });
});

// ── 4. THE OWNER'S EXAMPLE, off the LIVE registry ───────────────────────────

/** The dock bands a live def actually renders (post hero-split). */
function liveBands(type: string): { bands: DockFaceBand[]; def: RowPlanDefLike } {
  const def = listModuleDefs().find((d) => d.type === type) as unknown as FaceDefLike & { type: string };
  expect(def, `${type} is registered`).toBeTruthy();
  const all = dockFacePlan(def);
  const split = heroFacePlan(def as FaceplateDefLike, all);
  return { bands: split.bands, def: def as RowPlanDefLike };
}

describe('the live faces', () => {
  it('sixstrum packs to exactly the layout the owner asked for', () => {
    const { bands, def } = liveBands('sixstrum');
    expect(bands.map((b) => b.id)).toEqual(['instrument', 'string', 'strum', 'pick', 'output']);
    const rows = dockRowPlan(bands, def);
    expect(rows.map((r) => r.bands.map((b) => b.id))).toEqual([
      // band 1 carries the 14-entry PRESET selector → solo.
      ['instrument'],
      // "here 2 and 3 can be on the same row…"
      ['string', 'strum'],
      // "…and probably 4 and 5 as well."
      ['pick', 'output'],
    ]);
    expect(rows.map((r) => r.controls)).toEqual([4, 6, 9]);
  });

  it('pentemelodica is UNTOUCHED — it is a tab rail, and a rail cannot pack', () => {
    const { bands, def } = liveBands('pentemelodica');
    const rows = dockRowPlan(bands, def);
    expect(rows).toHaveLength(bands.length);
    expect(rows.every((r) => r.bands.length === 1)).toBe(true);
  });

  it('clap and drummergirl collapse to ONE row each', () => {
    for (const type of ['clap', 'drummergirl']) {
      const { bands, def } = liveBands(type);
      const rows = dockRowPlan(bands, def);
      expect(rows, `${type}`).toHaveLength(1);
      expect(rows[0].controls, `${type}`).toBeLessThanOrEqual(DOCK_ROW_MAX_CONTROLS);
    }
  });

  it("dx7's panel bands stay solo — a 560px operator detail never shares a row", () => {
    const { bands, def } = liveBands('dx7');
    const rows = dockRowPlan(bands, def);
    const opRow = rows.find((r) => r.bands.some((b) => b.id === 'operators'));
    expect(opRow!.bands).toHaveLength(1);
  });

  it('EVERY faced module: the row plan is TOTAL and honours the ceiling', () => {
    const shapes: string[] = [];
    // ⚠ ALL THREE REGISTRIES. Stating the scope inside the gate, because an
    // unstated scope reads as full coverage: the faces live in audio today, but
    // a video/meta module growing one must enrol here automatically.
    const every = [
      ...(listModuleDefs() as unknown as object[]),
      ...(listVideoModuleDefs() as unknown as object[]),
      ...(listMetaModuleDefs() as unknown as object[]),
    ];
    for (const raw of every) {
      const def = raw as unknown as FaceDefLike & { type: string };
      if (!def.face) continue;
      const all = dockFacePlan(def);
      const split = heroFacePlan(def as FaceplateDefLike, all);
      const rows = dockRowPlan(split.bands, def as RowPlanDefLike);
      expect(dockRowPlanIsTotal(split.bands, rows), `${def.type}: rows lost or reordered a band`).toBe(
        true,
      );
      for (const row of rows) {
        if (row.bands.length === 1) continue;
        expect(row.controls, `${def.type} row ${row.id}`).toBeLessThanOrEqual(DOCK_ROW_MAX_CONTROLS);
      }
      shapes.push(`${def.type}: ${split.bands.length} bands → ${rows.length} rows`);
    }
    // A face roster this sweep can see at all (it would print an empty list if
    // the registry import ever stopped resolving — the "green because it looked
    // at nothing" failure).
    //
    // ⚠ `>= 20` STOOD HERE (removed 2026-08-12, the no-ratchets sweep). It had
    // real slack — 32 faced defs against a floor of 20 — so it was not yet
    // biting, but it was a hand-typed integer over the SAME growing population
    // that `module-face-lint`'s set identity now governs, i.e. the next one to
    // go stale. Replaced with the derived form: the sweep must see exactly the
    // promoted set, which cannot drift because both sides are read off the
    // registry, and a name makes a fail-open registry import impossible to miss.
    expect(shapes.length, 'the faced-def sweep looked at nothing').toBe(STRICT_FACES.size);
    expect(
      shapes.map((s) => s.split(':')[0]),
      'the registry resolved but not the canonical faced module',
    ).toContain('ringback');
  });

  it('bandControlCount counts CLUSTERED cells too — a cluster is not a section', () => {
    const band: DockFaceBand = {
      id: 'x',
      label: 'x',
      hint: '',
      controls: [{ key: 'a', kind: 'param', paramId: 'a', label: 'a' }],
      clusters: [
        {
          label: 'c',
          controls: [
            { key: 'b', kind: 'param', paramId: 'b', label: 'b' },
            { key: 'c', kind: 'param', paramId: 'c', label: 'c' },
          ],
        },
      ],
      clusterFlow: 'stack',
    };
    expect(bandControlCount(band)).toBe(3);
  });
});

// ── 5. THE TIE-BREAK QUANTITY ───────────────────────────────────────────────
//
// ⚠ THIS SECTION EXISTS BECAUSE THE TEST I SET OUT TO WRITE CANNOT EXIST, and
// that is the finding.
//
// The packer's third tie-break compares each row's CONTROL WEIGHT. Reviewing
// it, the field being compared was the row's BAND COUNT — a different quantity
// from the one the rule documents — which looked like exactly the class of
// defect this repo keeps finding (a metric that is not the thing under test).
// Attempting to construct a face shape where the two disagree proved they
// cannot: rows are PREFIXES of the band list, so a longer first row has both
// more sections AND more weight whenever every band holds at least one cell —
// and `heroFacePlan` already drops any band a hero promotion emptied. The two
// lexicographic orders are identical over the whole reachable input space.
//
// So the code now compares the quantity the rule names (weight), the
// equivalence is recorded at the field, and the tests below pin the OBSERVABLE
// behaviour plus the ≥1-cell precondition the equivalence rests on.
describe('the tie-break quantity', () => {
  it('splits a run of equal bands evenly (the degenerate case)', () => {
    expect(packRun([5, 5, 5, 5], 10)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('the chosen partition has the lexicographically smallest WEIGHT sequence', () => {
    // Enumerate every legal partition and confirm the packer picked the
    // optimum under the DOCUMENTED objective — rather than re-asserting the
    // implementation's own answer back at itself.
    const counts = [3, 3, 3, 6];
    const cap = 10;
    const all: number[][][] = [];
    const walk = (at: number, acc: number[][]) => {
      if (at === counts.length) { all.push(acc.map((g) => [...g])); return; }
      for (let j = at; j < counts.length; j++) {
        const group = counts.slice(at, j + 1);
        const w = group.reduce((a, b) => a + b, 0);
        if (j > at && w > cap) break;
        walk(j + 1, [...acc, Array.from({ length: j - at + 1 }, (_, k) => at + k)]);
      }
    };
    walk(0, []);
    const weigh = (p: number[][]) => p.map((g) => g.reduce((n, i) => n + counts[i], 0));
    const legal = all.filter((p) => p.every((g, i) => p.length === 1 || g.length === 1 || weigh(p)[i] <= cap));
    const rank = (p: number[][]) => {
      const w = weigh(p);
      return [p.length, Math.max(...w), ...w];
    };
    const best = legal.reduce((a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
        const x = ra[i] ?? -1, y = rb[i] ?? -1;
        if (x !== y) return x < y ? a : b;
      }
      return a;
    });
    expect(weigh(best)).toEqual([6, 9]);
    expect(packRun(counts, cap)).toEqual(best);
  });

  it('EVERY band that reaches the packer holds at least one cell — the precondition', () => {
    // The band-count/weight equivalence recorded on `PackCandidate.weights`
    // holds only while this is true, and `heroFacePlan` is what makes it true
    // (it drops a band a hero promotion emptied). Asserted over the live
    // registry so a future face cannot quietly invalidate the reasoning.
    for (const raw of listModuleDefs()) {
      const def = raw as unknown as FaceDefLike & { type: string };
      if (!def.face) continue;
      const split = heroFacePlan(def as FaceplateDefLike, dockFacePlan(def));
      for (const b of split.bands) {
        expect(bandControlCount(b), `${def.type} band '${b.id}' reaches the packer empty`).toBeGreaterThan(0);
      }
    }
  });
});
