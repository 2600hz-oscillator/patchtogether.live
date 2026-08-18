// packages/web/src/lib/ui/workflow/dock-tabs-model.test.ts
//
// PF-16's pure half. The interesting properties are all "the two consumers
// agree": DockFullView paints the rail off `dockTabPlan` + `activeDockTab`,
// ModuleShell hides bands off `dockTabPlan` + `dockBandVisible`, and if those
// ever answered differently the faceplate would be blank or double-painted.
// Testing the model therefore tests the agreement.
//
// The live-registry clause at the bottom is the one that would actually catch
// a regression in production: it asserts, against the REAL defs, that exactly
// the faces we intend are tabbed — so lowering the threshold (or a face growing
// a ninth page) is a deliberate, visible edit rather than a surprise in a VRT
// diff.

import { describe, expect, it } from 'vitest';
import { listModuleDefs } from '$lib/audio/module-registry';
import { dockFacePlan, type DockFaceBand, type FaceDefLike } from './curated-face';
import {
  activeDockTab,
  dockBandVisible,
  dockTabPlan,
  DOCK_TAB_MIN_BANDS,
} from './dock-tabs-model';
import '$lib/audio/modules';

const band = (id: string, label = id): DockFaceBand => ({
  id,
  label,
  hint: '',
  controls: [],
  clusters: [],
  clusterFlow: 'stack',
});
const bands = (n: number): DockFaceBand[] =>
  Array.from({ length: n }, (_, i) => band(`p${i}`, `page ${i}`));

describe('dockTabPlan — the threshold', () => {
  it('a face BELOW the threshold renders as one scrolling column (null)', () => {
    for (let n = 0; n < DOCK_TAB_MIN_BANDS; n++) {
      expect(dockTabPlan(bands(n)), `${n} bands`).toBeNull();
    }
  });

  it('a face AT or ABOVE the threshold gets one tab per band, in band order', () => {
    const tabs = dockTabPlan(bands(DOCK_TAB_MIN_BANDS));
    expect(tabs?.map((t) => t.id)).toEqual(bands(DOCK_TAB_MIN_BANDS).map((b) => b.id));
    expect(dockTabPlan(bands(DOCK_TAB_MIN_BANDS + 4))).toHaveLength(DOCK_TAB_MIN_BANDS + 4);
  });

  it('an unlabeled band falls back to its id (a tab is never a blank chip)', () => {
    const plan = [...bands(DOCK_TAB_MIN_BANDS - 1), band('__unpaged', '')];
    expect(dockTabPlan(plan)?.at(-1)?.label).toBe('__unpaged');
  });

  it('no plan at all is not tabbed (an un-faced / legacy occupant)', () => {
    expect(dockTabPlan(null)).toBeNull();
    expect(dockTabPlan(undefined)).toBeNull();
  });
});

describe('activeDockTab — the stale-id fallback', () => {
  const tabs = dockTabPlan(bands(DOCK_TAB_MIN_BANDS))!;

  it('honours a requested tab that still exists', () => {
    expect(activeDockTab(tabs, 'p3')).toBe('p3');
  });

  it('falls back to the FIRST tab when nothing is requested', () => {
    expect(activeDockTab(tabs, undefined)).toBe('p0');
  });

  it('falls back when the requested id is GONE — the blank-faceplate guard', () => {
    // The requested id is UI state that outlives a face edit (a re-paged
    // module, a swapped dock occupant). Without the fallback every band hides
    // and the module reads as broken.
    expect(activeDockTab(tabs, 'a-page-that-was-renamed')).toBe('p0');
  });
});

describe('dockBandVisible — what the shell hides', () => {
  it('an UNTABBED face shows every band', () => {
    for (const b of bands(3)) expect(dockBandVisible(b.id, null, undefined)).toBe(true);
  });

  it('a TABBED face shows exactly ONE band — the active one', () => {
    const plan = bands(DOCK_TAB_MIN_BANDS);
    const tabs = dockTabPlan(plan)!;
    const shown = plan.filter((b) => dockBandVisible(b.id, tabs, 'p2'));
    expect(shown.map((b) => b.id)).toEqual(['p2']);
  });

  it('a stale active id still shows exactly one band (never zero)', () => {
    const plan = bands(DOCK_TAB_MIN_BANDS);
    const tabs = dockTabPlan(plan)!;
    const shown = plan.filter((b) => dockBandVisible(b.id, tabs, 'nope'));
    expect(shown.map((b) => b.id)).toEqual(['p0']);
  });
});

describe('the LIVE registry — which faces are tabbed today', () => {
  // The clause that turns the threshold into a decision instead of a constant:
  // if a face crosses it, its dock BASELINE moves, and that must be a thing
  // somebody chose. cloudseed (8 bands) is the only face over the line.
  it('cloudseed + pentemelodica are tabbed; every other faced module is one column', () => {
    const tabbed: string[] = [];
    const counts: string[] = [];
    for (const def of listModuleDefs() as unknown as (FaceDefLike & { type: string })[]) {
      if (!def.face) continue;
      // `dockFacePlan` is `FaceBand[] | null` — a faced def with nothing
      // rankable plans no dock at all. Resolve it ONCE and narrow, rather than
      // calling it twice and dereferencing the first result.
      const plan = dockFacePlan(def);
      if (!plan) continue;
      counts.push(`${def.type}=${plan.length}`);
      if (dockTabPlan(plan)) tabbed.push(def.type);
    }
    expect(
      tabbed.sort(),
      // ⚠ IF YOU LANDED HERE AFTER A MERGE, READ THIS FIRST. This clause is a
      // CROSS-PR TRIPWIRE, not a cloudseed assertion. Five face PRs were in
      // flight when the threshold landed and none of them knows it exists, so a
      // face that grows a 7th band — or merely FORGETS a control, since
      // `dockFacePlan` appends a `__unpaged` "more" band for anything no page
      // mentions — silently grows a tab rail and MOVES ITS DOCK BASELINE.
      // Bands today: ' + the list below. The fix is never to widen this array
      // on reflex: decide whether that face should be tabbed, regenerate its
      // baseline if so, or give the orphaned control a page if not.
      `dock bands per faced module — ${counts.sort().join(' ')} (threshold ${DOCK_TAB_MIN_BANDS})`,
      // ⚠ pentemelodica (face batch 3) is the SECOND deliberate rail, and the
      // count is FORCED rather than chosen: 40 of its 48 params are five
      // IDENTICAL strips of eight, which neither a flat `order` nor a flat
      // `pages` list can express as "this group, five times". Its dock baseline
      // is captured as a tabbed face from the start.
    ).toEqual(['cloudseed', 'pentemelodica']);
  });
});

describe('dockTabPlan — the DRAWER host paints no rail, so it is never tabbed (#1739)', () => {
  // The file header's argument, applied to a third consumer. `DockCardHost`
  // (the pinned `m`/`e` tray) has no title bar and therefore no tab rail, so a
  // tabbed answer there is a HIDE WITH NO RAIL — the blank faceplate this model
  // exists to prevent. Driven ABOVE the threshold, where the two answers
  // actually differ; below it they agree trivially and the leg would be vacuous.
  it('a drawer face is untabbed at ANY band count', () => {
    for (const n of [DOCK_TAB_MIN_BANDS, DOCK_TAB_MIN_BANDS + 1, DOCK_TAB_MIN_BANDS + 9]) {
      expect(dockTabPlan(bands(n), 'drawer'), `${n} bands, drawer`).toBeNull();
    }
  });

  it('…and every band therefore RENDERS in a drawer, which is the property that matters', () => {
    const plan = bands(DOCK_TAB_MIN_BANDS + 2);
    const tabs = dockTabPlan(plan, 'drawer');
    const hidden = plan.filter((b) => !dockBandVisible(b.id, tabs, 'p0'));
    expect(hidden.map((b) => b.id), 'a drawer must never hide a band').toEqual([]);
  });

  it('NEGATIVE CONTROL, BOTH DIRECTIONS: the same inputs DO tab on the two rail hosts', () => {
    // Without this the clause above would pass just as well if `dockTabPlan`
    // had been broken to return null for everything.
    const plan = bands(DOCK_TAB_MIN_BANDS + 2);
    for (const view of ['dock-full', 'lane'] as const) {
      expect(dockTabPlan(plan, view), `${view} must still tab`).not.toBeNull();
    }
    // …and the DEFAULT argument is the full view, so DockFullView's existing
    // call site (`dockTabPlan(allBands)`) is unchanged by the new parameter.
    expect(dockTabPlan(plan)).toEqual(dockTabPlan(plan, 'dock-full'));
    // The hide side moves with it: the same plan on a full view hides all but
    // the active band.
    const tabs = dockTabPlan(plan, 'dock-full');
    expect(plan.filter((b) => !dockBandVisible(b.id, tabs, 'p0')).map((b) => b.id)).toEqual(
      plan.slice(1).map((b) => b.id),
    );
  });
});
