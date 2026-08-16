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
      'mixmstrs/returns=4',
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
