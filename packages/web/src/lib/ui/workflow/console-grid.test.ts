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
      // ⚠ THE NARROWEST CONSOLE BAND THAT CAN EXIST — two columns — and it
      // arrived with kria's face. Its `track` band holds two equal clusters,
      // LOOP (start + length) and TIME (division + direction), and column j
      // means the same thing in both: "the first of this pair, then the
      // second". Aligning them is what makes the band read as one statement
      // about how the selected track walks the grid rather than four unrelated
      // dropdowns. (MUTE sits in the same band outside either cluster, which
      // the rule ignores — it looks only at the clusters.)
      //
      // ⚠ NO EXISTING BASELINE MOVES. The usual cost of joining this list is a
      // dispatch, because the claimed band's layout changes; here the face is
      // NEW in the same PR, so its first captured baseline simply has the
      // aligned columns from the start.
      'kria/track=2',
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
      // ⚠ THE FIRST MEMBER WHOSE CLUSTERS ARE A **WRAP**, NOT A CORRESPONDENCE —
      // and it is listed with that difference stated rather than blended in,
      // because the rule's stated property is "column j means the same thing in
      // every cluster" and this is a weaker claim than moog984's.
      //
      // moog960's eight columns are one LINEAR sequence, and the two clusters
      // are its halves (cols 1-4, cols 5-8). So column j is step j in the first
      // cluster and step j+4 in the second — not the same control, the way
      // OUTPUT j genuinely is the same output in every one of moog984's input
      // rows. What makes the alignment correct anyway is musical rather than
      // structural: on a step sequencer, steps j and j+4 are the SAME POSITION
      // in each half of the run, so a column ruler stacks the two halves the
      // way a player already reads them.
      //
      // ⚠ AND THE BAND IS CLUSTERED FOR A MEASURED REASON, not for looks. These
      // are SEGMENTED cells painting three option labels each (NORM/SKIP/STOP),
      // which makes a mode cell far wider than a knob: eight in one row put the
      // dock faceplate at 1336 CSS px of content against a 1220 px capture box,
      // and `workflow-shell-faces.spec.ts` correctly refused it. Clustering into
      // halves is what makes the plate fit, and it fits WITHOUT claiming a width
      // exemption a knob grid has not earned.
      'moog960/stepmode=4',
      // ⚠ THE FIRST BAND WHOSE COLUMNS ARE NOT CHANNELS. moog984 is a 4×4
      // MATRIX: its four clusters are the four INPUT rows and column j is
      // OUTPUT j, so the property this rule tests for — "column j means the
      // same thing in every cluster" — is here the definition of the module
      // rather than a mixer convention it happens to satisfy. It arrived with
      // its face (#1942) and its baseline was dispatched with it.
      //
      // It is a ONE-console-band face, so `faceConsoleGridCols` correctly does
      // not engage (below `FACE_CONSOLE_MIN_BANDS`) and it is absent from the
      // face-wide list below — a lone console band has nothing to align to.
      'moog984/crosspoints=4',
      'pentemelodica/mix=5',
      // ⚠ THE SECOND BAND WHOSE COLUMNS ARE NOT CHANNELS, and the first that
      // arrived by REVERSING a `clusterFlow: 'row'` rather than by declaring a
      // grid. quadralogical's four clusters are the four EDGES of its joystick
      // cycle (1-2, 2-3, 3-4, 4-1) and column j is the same control on each:
      // [FX selector][AMT][PRM]. The edges are bit-identically symmetric slots
      // over the same eight effects, so "column j means the same thing in every
      // cluster" is exact here rather than approximate.
      //
      // ⚠ IT WAS AUTHORED SIDE-BY-SIDE AND CI OVERRULED IT — the mirror image
      // of the `mixmstrs/returns` note above, and worth reading against it. The
      // owner's layout note asked for the edge boxes in "a row under the
      // frame", which is `clusterFlow: 'row'`; four boxes of
      // [selector + two knob columns] measured 1260 CSS px against a 1220 px
      // pane ("40 CSS px of faceplate right of the capture box"), and
      // `workflow-shell-faces` budgets hiddenX === 0. Stacking was the fix, and
      // gaining the ruler is why it is a better outcome and not merely a
      // narrower one: on four identical strips the aligned columns are the
      // point. So `returns` left this list to sit side by side, and `edges`
      // joined it for the opposite reason.
      //
      // It is a ONE-console-band face, so `faceConsoleGridCols` correctly does
      // not engage and it is absent from the face-wide list below.
      'quadralogical/edges=3',
      'tidyVco/envelopes=4',
      // ⚠ TWO BANDS FROM ONE FACE, WHICH IS WHY WAVESCULPT ALSO REACHES THE
      // FACE-WIDE RULER BELOW — the first new face to do so since mixmstrs.
      //
      // `walls=2` — six clusters, one per face of the room, each [alpha,
      // distort]. Column j means the same thing in all six by construction: how
      // transparent this wall is, then how far it bulges. That is the property
      // this rule tests for, on the most literally symmetric band in the fleet.
      //
      // `wavetables=3` — four clusters, one per oscillator, each [preset,
      // factory table, load]. Column j is the same ACQUISITION ROUTE for every
      // voice, so the aligned columns are what let you read "all four are on
      // factory tables except GREEN" down a column instead of hunting per
      // strip. It is also the band the platform forced into existence (a family
      // key is one cell for all instances, so the strips could not live in the
      // oscillator bands), and the alignment is the compensation: they read as
      // four comparable strips rather than twelve loose pickers.
      'wavesculpt/walls=2',
      'wavesculpt/wavetables=3',
    ]);
  });

  // ⚠ THE SAME CLAUSE FOR THE FACE-WIDE RULER (#1825). A face listed here has
  // its `.dock-pages` turned into a grid and EVERY console band re-parented
  // onto it as a subgrid, which moves that face's dock baseline. A face NOT
  // listed is byte-identical, which is the whole containment argument for this
  // change: only a face with TWO OR MORE console bands can have the misaligned-
  // columns defect in the first place.
  // ⚠ THE BAND COUNT MOVED UNDER THIS AND THE RULER DID NOT, which is worth
  // recording because it is the interesting case. #1805 gave `mixmstrs/returns`
  // `clusterFlow: 'row'`, so it stopped being a console band and mixmstrs went
  // from FOUR to THREE — still ≥ `FACE_CONSOLE_MIN_BANDS`, and the width is the
  // WIDEST remaining band (`sends`, 9), which the returns band never set. So the
  // answer is unchanged at 9 for a reason, not by luck: had `sends` been the one
  // to go side-by-side, this number would have moved and the dock baseline with
  // it.
  it('the FACE-wide ruler claims EXACTLY these faces — a new one is a baseline dispatch', () => {
    const out: string[] = [];
    for (const def of allDefs()) {
      if (!def.face) continue;
      const plan = dockFacePlan(def);
      if (!plan) continue;
      const cols = faceConsoleGridCols(plan);
      if (cols != null) out.push(`${def.type}=${cols}`);
    }
    // ⚠ WAVESCULPT IS THE SECOND FACE EVER TO REACH THIS RULER, and at 3 rather
    // than mixmstrs' 9. It qualifies because it has TWO console bands (`walls`
    // and `wavetables`) — the threshold — and the width is the WIDEST of them,
    // `wavetables` at 3, not the six-cluster `walls` at 2. That is the rule
    // working as the mixmstrs note above describes it: the ruler takes the
    // widest claimed band, so the band with MORE clusters does not win, the
    // band with more COLUMNS does. The face is new in this PR, so its first
    // captured baselines carry the aligned columns from the start and no
    // existing baseline moves.
    expect(out.sort()).toEqual(['mixmstrs=9', 'wavesculpt=3']);
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
      // kria's `track` is its only console band — `transport` and `scale` carry
      // no clusters at all — so the FACE-WIDE ruler must not engage. Same
      // statement moog984 and quadralogical make below: a lone console band has
      // nothing to align to.
      'kria',
      // moog960's `stepmode` is its only console band — the three row banks
      // carry no clusters (their eight knobs are one flat row) and `clock` /
      // `ranges` carry none either. So the FACE-WIDE ruler must not engage:
      // there is nothing for a lone console band to align against, and the
      // three knob rows are deliberately NOT clustered, since a knob cell is
      // narrow enough that eight fit without help.
      'moog960',
      // moog984 is the STRONGEST member of this control: it is the only face
      // whose console band is the module's entire surface, so if the face-wide
      // ruler ever engaged below its declared minimum it would engage here
      // first and most visibly.
      'moog984',
      'pentemelodica',
      // quadralogical's `edges` band is its only console band — the other two
      // (`field`, `key`) carry no clusters at all. So the face-wide ruler must
      // NOT engage, which is the same statement `moog984` makes above and the
      // reason a face joining this list is a smaller event than one joining the
      // face-wide list: nothing is re-parented, and only that band's own
      // columns change layout mode.
      'quadralogical',
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
