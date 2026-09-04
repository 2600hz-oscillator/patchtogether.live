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
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { dockFacePlan, type DockFaceBand, type FaceDefLike } from './curated-face';
import {
  activeDockTab,
  dockBandVisible,
  dockTabPlan,
  faceForcesTabs,
  DOCK_TAB_MIN_BANDS,
} from './dock-tabs-model';
import '$lib/audio/modules';
import '$lib/video/modules';

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
  it('backdraft + cloudseed + pentemelodica + spirographs are tabbed; every other faced module is one column', () => {
    const tabbed: string[] = [];
    const counts: string[] = [];
    // ⚠ VIDEO DEFS ARE IN THE SWEEP NOW, and they had to be: `face.tabbed`'s
    // FIRST adopter is a VIDEO module (spirographs), so an audio-only sweep
    // would have been structurally blind to the very mechanism this file
    // gained. The second (clipplayer) is audio, so the sweep now needs both
    // registries for the opt-in alone.
    const allDefs = [
      ...(listModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
      ...(listVideoModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
    ];
    for (const def of allDefs) {
      if (!def.face) continue;
      // `dockFacePlan` is `FaceBand[] | null` — a faced def with nothing
      // rankable plans no dock at all. Resolve it ONCE and narrow, rather than
      // calling it twice and dereferencing the first result.
      const plan = dockFacePlan(def);
      if (!plan) continue;
      counts.push(`${def.type}=${plan.length}`);
      // ⚠ THE DEF GOES IN. Passing only the bands asks the THRESHOLD question,
      // which stopped being the whole question when `face.tabbed` landed — a
      // def-less call here would report spirographs as untabbed while the app
      // rails it, i.e. the tripwire would be measuring something the user never
      // sees.
      if (dockTabPlan(plan, 'dock-full', def)) tabbed.push(def.type);
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
      // ⚠ backdraft (7 bands) WAS ALREADY RAILED AND THIS TRIPWIRE COULD NOT
      // SEE IT. The sweep read `listModuleDefs()` only — audio — so every VIDEO
      // face was outside its subject, and backdraft has been over the threshold
      // since it was authored. Adding video defs here (needed anyway, because
      // the tab opt-in's only adopter is a video module) surfaced it. Nothing
      // about backdraft changed; what changed is that the gate now looks.
      // ⚠ foxy (queue Q49, 2026-08-20) is the FOURTH rail and the first to
      // arrive by the THRESHOLD route since the opt-in existed — which is the
      // distinction this array is here to keep visible. It declares NO
      // `face.tabbed`: 33 params fall into seven honest groups (five WAVECEL
      // surface params · three separate sources whose defaults differ musically
      // · the XYZ combination · the two generator modes · the four freezes) and
      // seven IS the threshold. Nothing was padded to reach it and nothing was
      // crammed to avoid it, per the 2026-08-18 ruling. Its dock baseline is
      // captured as a tabbed face from the start, so no existing baseline moves.
      // ⚠ AND `foxy=7` IS ITSELF A COMPLETENESS PROOF worth reading off the
      // message above: `dockFacePlan` appends a `__unpaged` band for any ranked
      // control no page mentions, so a forgotten param would report 8 here, not
      // 7. The count matching the page count is what says all 33 are paged.
      // ⚠ videocube (2026-08-23) is the FIFTH rail, the SECOND to arrive by the
      // THRESHOLD route, and the first the 2026-08-18 CONTROL-HEAVY ruling was
      // written for by name. It declares NO `face.tabbed`: THIRTY params across
      // six different KINDS of control — three 2-D pads, five named rosters,
      // three switches, sixteen dials — plus SIX ingest cells, falling into
      // seven honest stages of one pipeline (what goes in · how the solid is
      // built · where it is cut · how it is read in time · where the camera is ·
      // how it is drawn · what it sounds like). Seven IS the threshold; nothing
      // was padded to reach it and nothing crammed to avoid it. It is a NEW
      // face, so it is captured as a tabbed face from the start and no existing
      // baseline moves.
      // ⚠ AND `videocube=7` IS THE SAME COMPLETENESS PROOF foxy's entry
      // describes, on a wider surface: 30 params + 6 families = 36 ranked
      // controls, and a single one left off a page would report 8 here.
      // ⚠ wavesculpt (2026-08-24) is the SEVENTH rail — it and `twotracks`
      // landed the same day, and twotracks reached main first — and it is the
      // widest face in the fleet: TEN bands off 79 params + 12 control families. It declares no
      // `face.tabbed` either — the count gets there on its own, and the thing
      // that gets it there is the FOUR OSCILLATOR BANDS. That split is argued on
      // arithmetic rather than taste: four voices are "the same idea four
      // times", which normally reads as CLUSTER, but each carries twelve params
      // plus a colour cell, and four of those in one band is a wall of knobs
      // with four sub-headers on a dock that folds at 720p. The clusters then do
      // their proper job INSIDE each band (SHAPE / ENV / FX are three different
      // ideas about ONE voice). Nothing was padded to reach ten.
      // ⚠ ITS BAND 2 IS A PLATFORM-FORCED SHAPE, not a design choice, and the
      // count reflects that: the build spec put each oscillator's wavetable
      // strip inside that oscillator's band, which cannot exist because a
      // family key is ONE cell for ALL instances. The twelve family cells share
      // a WAVETABLES band instead, which is the band that takes this face from
      // nine to ten.
      // ⚠ twotracks (2026-08-24) is the SIXTH rail and the THIRD by the
      // THRESHOLD route. It declares NO `face.tabbed`. Its seven are the
      // machine's own shape rather than a chosen number: a tape deck's
      // TRANSPORT, its TAPE MOTION and its TONE section are three different
      // things, there are TWO DECKS, and the mix that blends them is a seventh
      // that belongs to neither. Nothing was padded to reach seven and nothing
      // crammed to avoid it.
      // ⚠ AND THE HONEST COUNTER-READING IS RECORDED RATHER THAN HIDDEN: a
      // reviewer could reasonably fold TAPE and TONE together per reel, which
      // gives THREE bands and turns the rail off. If that is the ruling, the
      // face ships untabbed (ruttetra's precedent) — it does NOT get re-split
      // to win the rail back, which is the padding the 2026-08-18 ruling
      // forbids.
      // ⚠ `twotracks=7` is the same completeness proof again — every ranked
      // param and family is claimed by a page, and a single one left off would
      // report 8 here rather than 7. (Deliberately not restating HOW MANY there
      // are: a count in a comment is the construct CLAUDE.md bans, because a
      // sibling PR adding a param auto-merges cleanly and leaves it wrong. The
      // assertion message above prints the live number.)
      // ⚠ clipplayer (2026-09-04) is the NINTH rail and the SECOND by the
      // OPT-IN route — the first AUDIO opt-in, and the first rail taken for a
      // reason that is not density at all. It has FOUR bands, three under the
      // threshold, and it is railed because the owner reported the untabbed
      // face as a P0 defect: the launch grid and the piano roll are two VIEWS
      // of one instrument (the legacy card's `cardView`), and only band hiding
      // can make double-clicking a pad REPLACE the grid with the editor. Its
      // `face.hero` was removed in the same change, because a hero paints above
      // every tab panel and therefore cannot be hidden. Both dock baselines
      // move with it, deliberately. See FACE_TAB_OPT_IN below for the verbatim
      // instruction.
    ).toEqual([
      'backdraft', 'clipplayer', 'cloudseed', 'foxy', 'pentemelodica', 'spirographs',
      'twotracks', 'videocube', 'wavesculpt',
    ]);
  });

  it('every tabbed face is EITHER over the threshold OR a named opt-in — never neither', () => {
    // The two routes to a rail, joined. A face that is tabbed for no reason
    // either route explains is the case this clause exists to make impossible.
    const allDefs = [
      ...(listModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
      ...(listVideoModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
    ];
    const unexplained: string[] = [];
    for (const def of allDefs) {
      if (!def.face) continue;
      const plan = dockFacePlan(def);
      if (!plan || !dockTabPlan(plan, 'dock-full', def)) continue;
      const overThreshold = plan.length >= DOCK_TAB_MIN_BANDS;
      const optedIn = faceForcesTabs(def);
      if (!overThreshold && !optedIn) unexplained.push(`${def.type} (${plan.length} bands)`);
    }
    expect(unexplained, 'a face is railed with neither route explaining it').toEqual([]);
  });
});

// ── THE PER-FACE OPT-IN — NAMED, WITH PROVENANCE ────────────────────────────
//
// `face.tabbed` forces the rail on below the band threshold. The fence (see the
// header of dock-tabs-model.ts) is that it is declared ONLY on explicit owner
// instruction, PER MODULE — it is not a layout preference and it does NOT
// reopen "should this face be tabbed?" for anything else. The owner separately
// ruled `ruttetra` ships UNTABBED, and the default is unchanged: honest pages,
// rail at `DOCK_TAB_MIN_BANDS`.
//
// ⚠ THE PROVENANCE FIELD IS THE POINT, NOT BOOKKEEPING. The risk here is not a
// typo — it is an agent adding `tabbed: true` because a face "reads better as
// tabs" and writing a plausible sentence about what the owner wanted. Requiring
// the instruction VERBATIM, per module, makes the licence checkable against
// something that was actually said.

interface TabOptIn {
  /** The module type that declares `face.tabbed`. */
  type: string;
  /** The owner's instruction, VERBATIM. Not a paraphrase. */
  instruction: string;
  /** Why the rail is this module's own STRUCTURE rather than a density fix. */
  why: string;
}

const FACE_TAB_OPT_IN: readonly TabOptIn[] = [
  {
    type: 'spirographs',
    instruction: '"this should just be 3 tabs, one per spiro"',
    why:
      "The three spiros are INDEPENDENT FIGURES, not three sections of one idea: each has its own complete ten-param bank and its own centre drifting across the frame. The module's own legacy card already shipped a role=\"tablist\" with a 1/2/3 selector and edited one spiro at a time, so the rail restores a structure the module had rather than compressing a column that was merely tall.",
  },
  {
    type: 'clipplayer',
    instruction:
      '"this still sucks, by the way. we do NOT want the clip viewer always visible. we want to ' +
      'see it when we double click on a grid cell, at which point, we do not see the grid. this ' +
      'needs to work exactly the way the legacy card did, fixing this is a p0"',
    why:
      'The launcher and the piano roll are MUTUALLY EXCLUSIVE VIEWS of one instrument, not two ' +
      'sections of one page: ClipplayerCard.svelte holds a `cardView` rune, paints a ' +
      'GRID / CLIP / ARR / CTRL strip, and renders the grid and the editor as the two branches of ' +
      'one if/else — so the rail restores a structure the module has always had rather than ' +
      'compressing a column. It is also the only mechanism that CAN deliver the instruction: band ' +
      'hiding is what makes the grid disappear, and it is why this face now carries no ' +
      '`face.hero` (a hero is promoted out of its band and painted above every tab panel, so a ' +
      'hero grid cannot be hidden). Not a density fix — the four pages are unpadded and the face ' +
      'sits three bands UNDER the threshold.',
  },
];

describe('face.tabbed — the opt-in is NAMED, and cannot be taken quietly', () => {
  const declaring = (): string[] => {
    const all = [
      ...(listModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
      ...(listVideoModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
    ];
    return all.filter((d) => faceForcesTabs(d)).map((d) => d.type).sort();
  };

  it('no def declares face.tabbed without a NAMED entry', () => {
    const named = new Set(FACE_TAB_OPT_IN.map((e) => e.type));
    const rogue = declaring().filter((t) => !named.has(t));
    expect(
      rogue,
      'a face forces the tab rail on with no FACE_TAB_OPT_IN entry. This is an OWNER-INSTRUCTION-ONLY ' +
        'declaration: author honest pages and let the rail engage at DOCK_TAB_MIN_BANDS instead. If the ' +
        'owner really did ask for tabs on this module, add an entry quoting the instruction VERBATIM.',
    ).toEqual([]);
  });

  it('ANCHOR: every entry names a def that still declares it — a dead licence is RED', () => {
    const live = new Set(declaring());
    const dead = FACE_TAB_OPT_IN.map((e) => e.type).filter((t) => !live.has(t));
    expect(
      dead,
      'an opt-in entry names a module that no longer forces tabs. Delete it — a stale licence ' +
        'silently pre-approves whatever takes its name next.',
    ).toEqual([]);
  });

  it('every entry quotes an instruction and states why the rail is structural', () => {
    for (const e of FACE_TAB_OPT_IN) {
      expect(e.instruction.trim().length, `${e.type}: instruction must be quoted verbatim`).toBeGreaterThan(10);
      expect(e.instruction, `${e.type}: the instruction must be a QUOTE`).toMatch(/["“”]/);
      expect(e.why.trim().length, `${e.type}: why must be a real argument`).toBeGreaterThan(80);
    }
  });

  it('THE FENCE: the opt-in does not leak — every OTHER face still answers to the threshold', () => {
    // ⚠ THE CLAUSE THAT KEEPS THIS FROM BECOMING "tabs on request". Named
    // explicitly because the owner ruled it for a specific module and ruled
    // ruttetra the other way in the same breath.
    const named = new Set(FACE_TAB_OPT_IN.map((e) => e.type));
    expect([...named].sort(), 'the opt-in roster is exactly its owner-instructed members').toEqual([
      'clipplayer',
      'spirographs',
    ]);
    const all = [
      ...(listModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
      ...(listVideoModuleDefs() as unknown as (FaceDefLike & { type: string })[]),
    ];
    const ruttetra = all.find((d) => d.type === 'ruttetra');
    if (ruttetra) {
      expect(faceForcesTabs(ruttetra), 'ruttetra ships UNTABBED by owner ruling ("2 - a")').toBe(false);
    }
  });

  it('NEGATIVE CONTROL: the opt-in genuinely forces a rail the threshold refuses', () => {
    // Both directions on the SAME band count, so neither leg can pass vacuously.
    const few = bands(3);
    expect(dockTabPlan(few, 'dock-full', undefined), '3 bands, no opt-in').toBeNull();
    expect(
      dockTabPlan(few, 'dock-full', { face: { tabbed: true } }),
      '3 bands, opted in',
    ).toHaveLength(3);
    // …and it does NOT override the host: a drawer still paints no rail, so a
    // forced-tabs face there would be a hide with no rail.
    expect(
      dockTabPlan(few, 'drawer', { face: { tabbed: true } }),
      'the drawer host refuses the rail even when forced',
    ).toBeNull();
    // …and the hide side moves with it, which is the property that matters.
    const tabs = dockTabPlan(few, 'dock-full', { face: { tabbed: true } });
    expect(few.filter((b) => !dockBandVisible(b.id, tabs, 'p0')).map((b) => b.id)).toEqual([
      'p1',
      'p2',
    ]);
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
