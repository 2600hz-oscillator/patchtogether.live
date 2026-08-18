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
import { consoleGridCols, CONSOLE_MIN_CELLS, CONSOLE_MIN_CLUSTERS } from './console-grid';
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
      // ⚠ `mixmstrs/returns` IS DELIBERATELY ABSENT and used to be here. It
      // still has two equal-sized clusters, so the SHAPE rule would claim it —
      // it is refused by the first clause of `consoleGridCols`, because the
      // band now declares `clusterFlow: 'row'` (owner, 2026-08-17: *"return 1
      // and return 2 can sit next to each other"*). A console grid aligns
      // column j ACROSS clusters stacked one above the other; side by side
      // there is nothing to align, and handing ModuleShell a column ruler for a
      // flex row is two layout systems disagreeing about one element.
      'mixmstrs/sends=9',
      'pentemelodica/mix=5',
      'tidyVco/envelopes=4',
    ]);
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
