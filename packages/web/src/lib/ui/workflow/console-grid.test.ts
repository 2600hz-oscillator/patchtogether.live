// packages/web/src/lib/ui/workflow/console-grid.test.ts
//
// The pure half of the console grid, plus the clause that actually matters: the
// LIVE ROSTER membership. `consoleGridCols` changes the layout of any band it
// answers for, so "which bands does it answer for" IS the blast radius — and it
// must be read off the registry, in both directions, rather than believed.

import { describe, expect, it } from 'vitest';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import { dockFacePlan, type FaceDefLike } from './curated-face';
import {
  consoleGridCols,
  faceConsoleGridCols,
  CONSOLE_MIN_CELLS,
  CONSOLE_MIN_CLUSTERS,
  FACE_CONSOLE_MIN_BANDS,
} from './console-grid';
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

const cluster = (n: number) => ({ controls: Array.from({ length: n }, (_, i) => `c${i}`) });

describe('consoleGridCols — the pure rule', () => {
  it('N clusters of equal size ≥2 ARE a grid, and the answer is that size', () => {
    expect(consoleGridCols({ clusters: [cluster(8), cluster(8)] })).toBe(8);
    expect(consoleGridCols({ clusters: [cluster(4), cluster(4), cluster(4), cluster(4)] })).toBe(4);
    expect(consoleGridCols({ clusters: [cluster(9), cluster(9)] })).toBe(9);
  });

  it('anything else keeps the flex-wrap layout it has today (null)', () => {
    expect(consoleGridCols(null), 'no band').toBeNull();
    expect(consoleGridCols(undefined), 'no band').toBeNull();
    expect(consoleGridCols({ clusters: [] }), 'no clusters').toBeNull();
    expect(consoleGridCols({ clusters: [cluster(8)] }), 'ONE cluster is a row, not a table').toBeNull();
    expect(consoleGridCols({ clusters: [cluster(8), cluster(7)] }), 'ragged').toBeNull();
    expect(consoleGridCols({ clusters: [cluster(1), cluster(1)] }), 'two captions, not a grid').toBeNull();
  });

  it('the thresholds are the boundary, checked on BOTH sides', () => {
    const at = Array.from({ length: CONSOLE_MIN_CLUSTERS }, () => cluster(CONSOLE_MIN_CELLS));
    expect(consoleGridCols({ clusters: at }), 'exactly at both thresholds').toBe(CONSOLE_MIN_CELLS);
    expect(consoleGridCols({ clusters: at.slice(0, CONSOLE_MIN_CLUSTERS - 1) })).toBeNull();
    expect(
      consoleGridCols({ clusters: at.map(() => cluster(CONSOLE_MIN_CELLS - 1)) }),
    ).toBeNull();
  });

  it('is order-insensitive about WHICH cluster is ragged', () => {
    expect(consoleGridCols({ clusters: [cluster(3), cluster(3), cluster(2)] })).toBeNull();
    expect(consoleGridCols({ clusters: [cluster(2), cluster(3), cluster(3)] })).toBeNull();
  });
});

describe('faceConsoleGridCols — the FACE-wide ruler (#1825)', () => {
  const band = (cols: number, clusters = CONSOLE_MIN_CLUSTERS) => ({
    clusters: Array.from({ length: clusters }, () => cluster(cols)),
  });

  it('is the WIDEST console band, so a narrower band spans a PREFIX of the ruler', () => {
    expect(faceConsoleGridCols([band(8), band(9), band(4)])).toBe(9);
    expect(faceConsoleGridCols([band(4), band(4)])).toBe(4);
  });

  it('ONE console band is not a ruler — it has nothing to be aligned to', () => {
    expect(faceConsoleGridCols([band(8)])).toBeNull();
    // …and the non-console bands beside it do not make one.
    expect(faceConsoleGridCols([band(8), { clusters: [] }, { clusters: [cluster(3)] }])).toBeNull();
  });

  it('no bands / no console bands / nullish ⇒ null (the layout every face has today)', () => {
    expect(faceConsoleGridCols(null)).toBeNull();
    expect(faceConsoleGridCols(undefined)).toBeNull();
    expect(faceConsoleGridCols([])).toBeNull();
    expect(faceConsoleGridCols([{ clusters: [] }, { clusters: [] }])).toBeNull();
    expect(faceConsoleGridCols([null, undefined])).toBeNull();
  });

  it('the threshold is checked on BOTH sides', () => {
    const at = Array.from({ length: FACE_CONSOLE_MIN_BANDS }, () => band(CONSOLE_MIN_CELLS));
    expect(faceConsoleGridCols(at)).toBe(CONSOLE_MIN_CELLS);
    expect(faceConsoleGridCols(at.slice(0, FACE_CONSOLE_MIN_BANDS - 1))).toBeNull();
  });

  it('it is the SAME predicate as consoleGridCols, band by band (no second opinion)', () => {
    // A ragged band contributes nothing to the ruler AND is not a console band —
    // if those two ever disagreed, a band could span tracks it does not subgrid.
    const ragged = { clusters: [cluster(8), cluster(7)] };
    expect(consoleGridCols(ragged)).toBeNull();
    expect(faceConsoleGridCols([band(4), band(4), ragged])).toBe(4);
  });
});

// ── THE BLAST RADIUS, READ OFF THE LIVE REGISTRY ───────────────────────────
//
// ⚠ THIS IS THE CLAUSE TO READ AFTER A MERGE. Every band listed here lays out
// as a fixed-column grid instead of a wrapping flex row, which MOVES that
// module's dock VRT baseline. The list is asserted as an exact set so that a
// face gaining or losing the property is a visible, deliberate edit with a
// baseline dispatch — never a surprise in a diff gallery.
//
// ⚠ WHAT THIS CANNOT SEE: it reads `dockFacePlan`, i.e. the DOCK band plan. It
// says nothing about the lane tile (which renders a curated subset with no
// clusters at all) and nothing about pixels — only which bands changed layout
// MODE. The pixels are the VRT dispatch.
describe('console grid — which SHIPPED bands it claims (derived membership)', () => {
  function allDefs(): (FaceDefLike & { type: string })[] {
    return [
      ...(listModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
      ...(listVideoModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
      ...(listMetaModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
    ];
  }

  /** `<type>/<bandId>=<cols>` for every band the rule claims. */
  function claimed(): string[] {
    const out: string[] = [];
    for (const def of allDefs()) {
      if (!def.face) continue;
      const plan = dockFacePlan(def);
      if (!plan) continue;
      for (const band of plan) {
        const cols = consoleGridCols(band);
        if (cols != null) out.push(`${def.type}/${band.id}=${cols}`);
      }
    }
    return out.sort();
  }

  it('claims EXACTLY these bands — a new one is a baseline dispatch, not a diff to accept', () => {
    expect(claimed()).toEqual([
      'kickdrum/dynamics=3',
      'mixmstrs/channels=8',
      'mixmstrs/dynamics=8',
      'mixmstrs/returns=4',
      'mixmstrs/sends=9',
      'pentemelodica/mix=5',
      'tidyVco/envelopes=4',
    ]);
  });

  // ⚠ THE SAME CLAUSE FOR THE FACE-WIDE RULER (#1825). A face listed here has
  // its `.dock-pages` turned into a grid and EVERY console band re-parented
  // onto it as a subgrid, which moves that face's dock baseline. A face NOT
  // listed is byte-identical, which is the whole containment argument for this
  // change: only a face with TWO OR MORE console bands can have the misaligned-
  // columns defect in the first place.
  it('the FACE-wide ruler claims EXACTLY these faces — a new one is a baseline dispatch', () => {
    const out: string[] = [];
    for (const def of allDefs()) {
      if (!def.face) continue;
      const plan = dockFacePlan(def);
      if (!plan) continue;
      const cols = faceConsoleGridCols(plan);
      if (cols != null) out.push(`${def.type}=${cols}`);
    }
    expect(out.sort()).toEqual(['mixmstrs=9']);
  });

  it('NEGATIVE CONTROL: faces WITH a console band but only one keep their own ruler', () => {
    // Without this, the clause above would look identical if the face rule had
    // been broken to answer `null` for everything.
    const singles: string[] = [];
    for (const def of allDefs()) {
      if (!def.face) continue;
      const plan = dockFacePlan(def);
      if (!plan) continue;
      const consoleBands = plan.filter((b) => consoleGridCols(b) != null);
      if (consoleBands.length === 1) singles.push(def.type);
    }
    expect(singles.sort(), 'the roster must still contain single-console-band faces').toEqual([
      'kickdrum',
      'pentemelodica',
      'tidyVco',
    ]);
    for (const t of singles) {
      const def = allDefs().find((d) => d.type === t)!;
      expect(faceConsoleGridCols(dockFacePlan(def)), `${t} must keep its own ruler`).toBeNull();
    }
  });

  it('NEGATIVE CONTROL: the rule really can say no, and does for most clustered bands', () => {
    // Without this the clause above would look identical if `consoleGridCols`
    // had been broken to answer only for one module by accident.
    const clustered: string[] = [];
    for (const def of allDefs()) {
      if (!def.face) continue;
      const plan = dockFacePlan(def);
      if (!plan) continue;
      for (const band of plan) {
        if (band.clusters.length > 0) clustered.push(`${def.type}/${band.id}`);
      }
    }
    const claimedIds = new Set(claimed().map((s) => s.split('=')[0]));
    const refused = clustered.filter((b) => !claimedIds.has(b));
    expect(clustered.length, 'the roster must actually contain clustered bands').toBeGreaterThan(
      claimedIds.size,
    );
    expect(refused.length, 'and the rule must refuse some of them').toBeGreaterThan(0);
  });
});

// ── THE `[hidden]` CLAUSE — a CSS defect no other gate can see ─────────────
//
// ⚠ THIS WAS A LIVE BUG, CAUGHT BY MEASUREMENT AND NOT BY ANY GATE. A tabbed
// face hides its inactive bands with the `hidden` ATTRIBUTE (PF-16 — hidden,
// never unmounted, so `faces-parity` can still count their cells). The UA
// stylesheet implements that as `[hidden] { display: none }`, which a CLASS
// selector outranks: `.dock-page.console-band { display: grid }` silently
// un-hid every console band on a tabbed face. Measured on pentemelodica, whose
// `mix` band is a console grid and its THIRD page: it painted 240 px wide
// underneath the active `filter` tab while every other hidden band measured 0.
//
// A rail whose hide does not hide is the exact inverse of the blank-faceplate
// failure `dock-tabs-model` exists to prevent, and NOTHING in the unit lane
// could see it — the plan model is pure, and the only tabbed adopters are two
// modules whose baselines had not been recaptured yet.
//
// ⚠ WHAT THIS GATE CAN AND CANNOT SEE: it reads ModuleShell's SOURCE and
// asserts the clause exists at higher specificity than the grid rule. It cannot
// evaluate CSS, so it cannot prove the cascade resolves the way it reads — that
// is the DOM measurement above, and the dock VRT baselines after it.
describe('the console grid must not out-rank the UA `[hidden]` rule', () => {
  const MODULE_SHELL_SRC = Object.values(
    import.meta.glob('../modules/ModuleShell.svelte', { eager: true, query: '?raw', import: 'default' }),
  )[0] as string;

  it('the source really loaded', () => {
    expect(typeof MODULE_SHELL_SRC).toBe('string');
    expect(MODULE_SHELL_SRC.length).toBeGreaterThan(10_000);
  });

  it('a `[hidden]` console band is restored to display:none EXPLICITLY', () => {
    const css = MODULE_SHELL_SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(
      /\.dock-page\.console-band\[hidden\]\s*\{\s*display:\s*none;?\s*\}/.test(css),
      'a `.dock-page.console-band { display: grid }` rule outranks the UA sheet\'s ' +
        '`[hidden] { display: none }`, so an inactive TAB PANEL keeps painting. Restate the ' +
        'hide at higher specificity beside the grid rule.',
    ).toBe(true);
  });

  it('…and it is DECLARED BEFORE the grid rule it guards, so order cannot defeat it', () => {
    // Equal specificity would make source order decide. It is not equal here
    // (the attribute selector adds weight), but asserting the order too means
    // the clause survives a future edit that drops the attribute from it.
    const css = MODULE_SHELL_SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    const guard = css.indexOf('.dock-page.console-band[hidden]');
    const grid = css.indexOf('.dock-page.console-band {');
    expect(guard, 'the guard must exist').toBeGreaterThan(-1);
    expect(grid, 'the grid rule must exist').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(grid);
  });

  it('NEGATIVE CONTROL: the probe fires on the shape that shipped the bug', () => {
    const broken = '.dock-page.console-band { display: grid; }';
    expect(/\.dock-page\.console-band\[hidden\]\s*\{\s*display:\s*none;?\s*\}/.test(broken)).toBe(false);
  });
});
