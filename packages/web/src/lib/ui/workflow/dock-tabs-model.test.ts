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
  heroRailBelowBands,
  DOCK_TAB_MIN_BANDS,
} from './dock-tabs-model';
import '$lib/audio/modules';

const band = (id: string, label = id): DockFaceBand => ({ id, label, hint: '', controls: [], clusters: [] });
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

describe('heroRailBelowBands — the tab panel follows its rail', () => {
  // ⚠ THE PIXELS ARE GATED IN A BROWSER, NOT HERE. This holds the DECISION;
  // `faces-parity`'s railed leg holds the consequence (every tab must put
  // controls ON SCREEN, and a different set per tab), because a unit test
  // cannot see a scroll box. Both directions, so a predicate stuck on one
  // answer fails.
  it('an UNTABBED face keeps the hero above the bands', () => {
    expect(heroRailBelowBands(null)).toBe(false);
    expect(heroRailBelowBands(undefined)).toBe(false);
    expect(heroRailBelowBands([])).toBe(false);
  });

  it('a TABBED face moves the hero below them', () => {
    expect(heroRailBelowBands(dockTabPlan(bands(DOCK_TAB_MIN_BANDS)))).toBe(true);
  });

  it('flips at exactly the tab threshold, off the SAME plan the rail is built from', () => {
    expect(heroRailBelowBands(dockTabPlan(bands(DOCK_TAB_MIN_BANDS - 1)))).toBe(false);
    expect(heroRailBelowBands(dockTabPlan(bands(DOCK_TAB_MIN_BANDS)))).toBe(true);
  });
});

describe('the LIVE registry — which faces are tabbed today', () => {
  // The clause that turns the threshold into a decision instead of a constant:
  // if a face crosses it, its dock BASELINE moves, and that must be a thing
  // somebody chose. cloudseed (8 bands) is the only face over the line.
  it('cloudseed + pentemelodica + wavesculpt are tabbed; every other faced module is one column', () => {
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
      //
      // ⚠ wavesculpt (face batch 3, 2026-08-10) is the THIRD, and it is the
      // one where the rail is not a choice at all but ARITHMETIC. 79 params
      // packed PERFECTLY at the 10-cell row cap is 8 rows ≈ 720 px at the 90 px
      // band pitch, into a dock content region that tops out near 550 px — so
      // the module cannot be read as one scrolling column at any window size,
      // and the packing a rail gives up costs it nothing it could have had. Its
      // 8 bands are `room`, `ensemble`, the four voices, `view`, `walls`; its
      // dock baseline is captured tabbed from the start.
    ).toEqual(['cloudseed', 'pentemelodica', 'wavesculpt']);
  });
});
