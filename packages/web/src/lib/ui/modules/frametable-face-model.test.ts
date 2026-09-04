// packages/web/src/lib/ui/modules/frametable-face-model.test.ts
//
// FRAMETABLE — the permanent gates on the claims this face is built from.
//
// ⚠ FIVE OF THE SIX BLOCKS BELOW GUARD A REPAIR, not a preference, and each one
// covers a defect that was INVISIBLE to every gate in the tree before this face
// existed. That is the shape worth noting: promoting a module is what made these
// findable, because `migrated(type)` deletes the card that was quietly carrying
// each one.
//
//   1. FOUR SWITCHES declared `curve: 'linear'` while being read as `>= 0.5`
//      two-state levels. Nothing could see it: the card drew them as buttons
//      from its own markup and never consulted `curve`, so the wrong
//      declaration had no consequence until a faceplate resolved a primitive
//      from it.
//   2. `mode` HAD NO `options` ROSTER. SMOOTH / MORPH / CHAOS lived only in the
//      card's `MODES` array.
//   3. THE `.frametable.png` FILE WORKFLOW was card-only.
//   4. THE RE-HYDRATE was attached to a VIEW rather than to the node.
//   5. THE PREVIEW was card-only, so promotion would have deleted the picture.
//
// The sixth block is the ordinary one: the tier ladder and the band structure.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frametableDef } from '$lib/video/modules/frametable';
import {
  FRAMETABLE_MODE_SMOOTH,
  FRAMETABLE_MODE_MORPH,
  FRAMETABLE_MODE_CHAOS,
} from '$lib/video/frametable-core';
import type { ParamDef } from '$lib/graph/types';
import {
  SEGMENTED_MAX_OPTIONS,
  declaredParamCells,
  foldedParamIds,
  momentaryParamIds,
  paramCellKind,
} from '$lib/ui/workflow/shell-control-kind';
import { curatedFace, dockFacePlan, laneOrder } from '$lib/ui/workflow/curated-face';
import { DOCK_TAB_MIN_BANDS, dockTabPlan } from '$lib/ui/workflow/dock-tabs-model';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEF_SRC = resolve(HERE, '../../video/modules/frametable.ts');
const ACTIONS_SRC = resolve(HERE, './frametable-file-actions.ts');
const BODY_SRC = resolve(HERE, './frametable/FrametableOutputBody.svelte');
const CELLS_SRC = resolve(HERE, '../workflow/shell-cells.ts');
const read = (p: string): string => readFileSync(p, 'utf8');

function param(id: string): ParamDef {
  const p = (frametableDef.params ?? []).find((q) => q.id === id);
  expect(p, `frametable declares a param '${id}'`).toBeTruthy();
  return p as ParamDef;
}

const MOMENTARY = momentaryParamIds(frametableDef);
const AUTHORED_CELLS = declaredParamCells(frametableDef);
const ALL_PARAMS = (frametableDef.params ?? []).map((p) => p.id);
/** The params a player can actually operate — DERIVED, never listed. */
const NO_CONTROL = (frametableDef.noUserControl ?? []).map((e) => e.param);
const PLAYABLE = ALL_PARAMS.filter((id) => !NO_CONTROL.includes(id));
const ORDER = frametableDef.face?.order ?? [];

// ───────────────────────────────────────────────────────────────────────────
describe('frametable face — the gate params a player CANNOT operate', () => {
  it('every noUserControl entry names a live param and a REAL writing port', () => {
    // ⚠ ANCHORED TO THE DEF'S OWN PORTS. `writer: 'cv-port'` is a CLAIM that
    // something on the patch surface targets the param; if a port stops doing
    // so, the entry has quietly become a lie about why the control is missing.
    for (const e of frametableDef.noUserControl ?? []) {
      expect(ALL_PARAMS, `${e.param} is a live param`).toContain(e.param);
      expect(e.writer, `${e.param} is written from the patch surface`).toBe('cv-port');
      const port = (frametableDef.inputs ?? []).find((p) => p.paramTarget === e.param);
      expect(port, `a port targets ${e.param}`).toBeTruthy();
      expect(port?.type, `${e.param} is written by a GATE jack`).toBe('gate');
      expect(e.why.trim().length, `${e.param} carries an argument`).toBeGreaterThan(40);
    }
  });

  it('⚠ saveTrig is NOT among them — it has a cv-port AND a user control', () => {
    // THE DISCRIMINATION THIS BLOCK EXISTS FOR. All four of `liveGate`,
    // `chaosGate`, `freezeGate` and `saveTrig` are targeted by a gate port, so
    // "has a cv-port" cannot be the test for whether a player operates it. The
    // first three have NO control anywhere; `saveTrig` is the SAVE pad's own
    // param, and sweeping it into noUserControl on the port evidence alone
    // would delete a shipped control while every gate stayed green.
    const savePort = (frametableDef.inputs ?? []).find((p) => p.paramTarget === 'saveTrig');
    expect(savePort, 'saveTrig IS targeted by a port, like the three gates').toBeTruthy();
    expect(NO_CONTROL, 'yet it is not declared uncontrollable').not.toContain('saveTrig');
    expect(ORDER, 'because it is ranked as a real control').toContain('saveTrig');
    expect(MOMENTARY.has('saveTrig'), 'specifically as a press-pad').toBe(true);
  });

  it('the gate params are ABSENT from the face and every playable one is PRESENT', () => {
    for (const id of NO_CONTROL) {
      expect(ORDER, `${id} must not be ranked`).not.toContain(id);
    }
    for (const id of PLAYABLE) {
      expect(ORDER, `${id} is a real control and must be ranked`).toContain(id);
    }
    // NON-VACUITY, both ways: this proves nothing if either set is empty.
    expect(NO_CONTROL.length, 'some params are gate-only').toBeGreaterThan(0);
    expect(PLAYABLE.length, 'and some are playable').toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('frametable face — the FOUR switches that said `linear` (the repair)', () => {
  /** Which primitive each switch must resolve to, and why it is not the other. */
  const SWITCHES: readonly { id: string; kind: 'toggle' | 'momentary' }[] = [
    { id: 'live', kind: 'toggle' },
    { id: 'freeze', kind: 'toggle' },
    { id: 'chaos', kind: 'momentary' },
    { id: 'saveTrig', kind: 'momentary' },
  ];

  it('all four carry the 0..1 DISCRETE press-pad shape', () => {
    for (const { id } of SWITCHES) {
      const p = param(id);
      expect(p.min, `${id} min`).toBe(0);
      expect(p.max, `${id} max`).toBe(1);
      expect(p.defaultValue, `${id} rests at 0`).toBe(0);
      // ⚠ THE LEG THAT WOULD HAVE FAILED BEFORE THIS FACE. `looksLikeToggle`
      // is `curve === 'discrete' && min === 0 && max === 1`, so `linear` here
      // makes every one of these a rotary over a continuum — and puts
      // `chaos`/`saveTrig` beyond `face.momentary` entirely, since
      // module-face-lint refuses a press-pad that is not 0..1 discrete at 0.
      expect(p.curve, `${id} must be discrete, not linear`).toBe('discrete');
    }
  });

  it('each resolves to the primitive its READ SITE requires', () => {
    for (const { id, kind } of SWITCHES) {
      expect(paramCellKind(param(id), MOMENTARY, 'dock', AUTHORED_CELLS), `${id} @dock`).toBe(kind);
    }
  });

  it('⚠ POSITIVE CONTROL: reverting `curve` to linear MOVES the answer to knob', () => {
    // The instrument's own check, in the direction that matters. Without this
    // the block above would pass on a resolver that returned 'toggle' for
    // everything, and it would not notice the exact regression it guards.
    for (const { id } of SWITCHES.filter((s) => s.kind === 'toggle')) {
      const asShipped = param(id);
      const reverted: ParamDef = { ...asShipped, curve: 'linear' };
      expect(paramCellKind(reverted, MOMENTARY, 'dock', AUTHORED_CELLS), `${id} reverted`).toBe('knob');
    }
    // And for the two press-pads the declaration outranks the shape, so the
    // control has to come from the OTHER side: drop them from face.momentary.
    const noneMomentary = new Set<string>();
    expect(paramCellKind(param('chaos'), noneMomentary, 'dock', AUTHORED_CELLS)).toBe('toggle');
    expect(paramCellKind(param('saveTrig'), noneMomentary, 'dock', AUTHORED_CELLS)).toBe('toggle');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('frametable face — the MODE roster is a PROMOTION, not an invention', () => {
  const modeOptions = () => param('mode').options ?? [];

  it('names exactly the three modes, and they are the SHADER\'s three', () => {
    // ⚠ THIS WAS ANCHORED TO THE CARD SOURCE, and that anchor is worth naming
    // because it is what is lost. The rule for a roster is "promote names that
    // exist in code, never invent them", and a test that re-typed the three
    // strings would assert the invention against itself — so the leg read the
    // labels out of `FrametableCard.svelte`'s own `MODES` array and compared
    // the def to THEM. The card was the second source; with it gone the def is
    // the only home, and no cross-check can separate a promoted name from an
    // invented one. NAMED COVERAGE LOSS.
    //
    // What survives is the half that was never circular, asserted in the leg
    // below: the option VALUES are the shader's own mode constants, so a
    // fourth invented mode has no constant to point at.
    expect(modeOptions().map((o) => o.label)).toEqual(['SMOOTH', 'MORPH', 'CHAOS']);
    expect(modeOptions().length, 'three modes, no more').toBe(3);
  });

  it('every option value is a real, reachable integer step, and the constants agree', () => {
    const p = param('mode');
    const values = modeOptions().map((o) => o.value);
    expect(values, 'the roster values are the shader mode constants').toEqual([
      FRAMETABLE_MODE_SMOOTH, FRAMETABLE_MODE_MORPH, FRAMETABLE_MODE_CHAOS,
    ]);
    for (const v of values) {
      expect(Number.isInteger(v), `${v} is an integer step`).toBe(true);
      expect(v, `${v} >= min`).toBeGreaterThanOrEqual(p.min);
      expect(v, `${v} <= max`).toBeLessThanOrEqual(p.max);
    }
    // ⚠ THE ROSTER MUST NAME EVERY REACHABLE STATE. `param-vocabulary`'s rule:
    // a roster that skips one leaves a state the dial can reach and the picker
    // cannot name. Derived from the range, so widening `max` reddens this.
    expect(values.length, 'one name per integer step in [min,max]').toBe(p.max - p.min + 1);
  });

  it('renders as a SEGMENTED row at the dock and a NAMED knob in the lane', () => {
    expect(modeOptions().length, 'few enough for an inline button row')
      .toBeLessThanOrEqual(SEGMENTED_MAX_OPTIONS);
    expect(paramCellKind(param('mode'), MOMENTARY, 'dock', AUTHORED_CELLS)).toBe('segmented');
    // A lane column cannot hold a roster; the dial keeps the space and earns a
    // readout naming the current state. That readout is the ONLY thing carrying
    // the mode name at the tier where MODE ranks first, which is why the roster
    // is load-bearing at the lane and not just at the dock.
    expect(paramCellKind(param('mode'), MOMENTARY, 'lane', AUTHORED_CELLS)).toBe('knob');
  });

  it('⚠ POSITIVE CONTROL: without the roster the dock cell is a bare KNOB', () => {
    // The moog962 trap, made falsifiable: a discrete 0..2 param with no names
    // is a dial whose three states are indistinguishable.
    const noRoster: ParamDef = { ...param('mode'), options: undefined };
    expect(paramCellKind(noRoster, MOMENTARY, 'dock', AUTHORED_CELLS)).toBe('knob');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('frametable face — the FILE workflow survives promotion', () => {
  it('both card affordances are declared families, ranked, and resolve to cells', () => {
    // STOP 2, as an assertion. `migrated(type)` stops both surfaces rendering
    // FrametableCard.svelte, so a family that is declared but unranked — or
    // ranked but unregistered — is an affordance that silently disappeared.
    const families = (frametableDef.controlFamilies ?? []).map((f) => f.id);
    expect(families).toContain('frametable-file-input');
    expect(families).toContain('frametable-save-file');
    for (const id of families) {
      expect(ORDER, `${id} is ranked`).toContain(`${id}-{n}`);
    }
    expect(shellCellFor('frametable', { kind: 'family', key: 'frametable-file-input-{n}' } as never)?.kind)
      .toBe('file');
    expect(shellCellFor('frametable', { kind: 'family', key: 'frametable-save-file-{n}' } as never)?.kind)
      .toBe('action');
  });

  it('every declared family resolves to a live shell cell', () => {
    // ⚠ THIS ASKED WHETHER THE CARD EMITTED EACH `testidPrefix`, mirroring
    // `module-docs-lint`'s card-drift leg so a rename broke at the module
    // rather than in a shared sweep. The shell stamps `shell-cell-<familyId>`
    // from an interpolation, so no surviving surface carries a per-family
    // literal to grep; that gate resolves each family to a live cell instead,
    // and so does this one, at the module.
    for (const f of frametableDef.controlFamilies ?? []) {
      expect(
        shellCellFor('frametable', { kind: 'family', key: `${f.id}-{n}` } as never),
        `${f.id} has no shell cell`,
      ).toBeTruthy();
    }
  });

  it('⚠ the SAVE cell probes an OUTCOME record, because a file write leaves nothing else', () => {
    const cell = shellCellFor('frametable', { kind: 'family', key: 'frametable-save-file-{n}' } as never);
    expect(cell?.kind).toBe('action');
    const probe = (cell as { probe?: { effect?: { kind?: string; key?: string } } }).probe;
    // An `audition` probe would be a lie: this action touches no seam, no
    // engine-handle callable and no ConstantSource.
    expect(probe?.effect?.kind, 'a data probe, not an audition').toBe('data');
    // ⚠ THE OUTCOME, NOT THE DESCRIPTOR. `frametableFile` is the stronger,
    // success-only claim and it is UNREACHABLE in the parity scene: measured on
    // this branch, `spawnPatch` never reconciles the engine, so the video engine
    // holds zero nodes even with the dock open and there is no ring to read.
    expect(probe?.effect?.key, 'the record every press writes').toBe('frametableSave');
  });

  it('⚠ EVERY exit of the save records an outcome — `ok: false` is kept, not dropped', () => {
    // The audition ledger's principle, transposed to a disk write: an outcome
    // recorded only on the happy path cannot tell a DEAD button from a FAILING
    // one, which is the exact vacuity the ledger exists to prevent.
    const actions = read(ACTIONS_SRC);
    const body = actions.slice(actions.indexOf('export async function saveFrametableFile'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    // ⚠ SLICED FROM `try {`, so the `done` HELPER'S OWN `return { status, error }`
    // is excluded. The first draft of this test did not, matched that line, and
    // reported a violation that did not exist — an instrument bug that reads
    // exactly like the defect it hunts.
    const exits = fn.slice(fn.indexOf('try {'));
    const returns = [...exits.matchAll(/return\s+([a-zA-Z{]\w*)/g)].map((m) => m[1]);
    expect(returns.length, 'the function has several exits').toBeGreaterThan(3);
    for (const r of returns) {
      expect(r, 'every exit funnels through the outcome-recording `done`').toBe('done');
    }
    // …and the descriptor is still success-only, written AFTER the disk write,
    // so the weaker probe above did not weaken the stronger claim.
    const stampAt = actions.indexOf('writeFileMeta(nodeId, {');
    const diskAt = actions.indexOf('await saveBlobToDisk(');
    expect(diskAt, 'the disk write exists').toBeGreaterThan(-1);
    expect(stampAt, 'and the descriptor stamp comes AFTER it').toBeGreaterThan(diskAt);
  });

  it('⚠ the RE-HYDRATE lives on the FACTORY, not on a view (#1531)', () => {
    // THE PARITY REPAIR, in both directions. Restoring a saved table into the
    // GPU ring after a reload used to be a `$effect` on the card; promotion
    // stops the card rendering, so a view-lifetime hydrate would simply have
    // stopped happening and the table would be silently gone.
    // ⚠ THE DENY HALF READ THE CARD (no `getFrametableBlob`, no `hydratedId`),
    // because the hazard was a view-lifetime hydrate SURVIVING alongside the
    // factory one. The view that held it is gone; what has to stay true is that
    // the FACTORY owns the restore, which is the half asserted here.
    const def = read(DEF_SRC);
    expect(def, 'the factory reads the persisted blob').toContain('getFrametableBlob');
    expect(def, 'and it is keyed off the node descriptor').toContain('frametableFile');
    expect(read(BODY_SRC), 'no surface may hydrate on view lifetime')
      .not.toContain('getFrametableBlob');
  });

  it('⚠ the shell cells call ONE implementation, so a second copy cannot appear', () => {
    // ⚠ THIS READ THE CARD, because the card and the shell cells were the two
    // callers and "they cannot drift" needed both. The registry is the caller
    // now, and it is the one that must delegate rather than re-derive.
    const cells = read(CELLS_SRC);
    expect(cells, 'the cells delegate the load').toContain('loadFrametableFile');
    expect(cells, 'and the save').toContain('saveFrametableFile');
    // …and no surface owns a second copy of the atlas encoder.
    expect(read(BODY_SRC), 'no surface tiles its own atlas').not.toContain('flipRowsY');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('frametable face — the picture, the pads and the band structure', () => {
  it('the picture arrives from the VIDEO seam, never from the glyph literal', () => {
    // ⚠ ASSERT `hasVideoSurface`, NEVER `glyph: 'none'`. A video def MUST
    // declare 'none' (no audio output ⇒ any other literal resolves to a dead
    // static glyph), so `'none' + blank tile` and `'none' + live thumb` are
    // indistinguishable from the declaration alone.
    expect(frametableDef.face?.glyph, 'the mandatory literal').toBe('none');
    expect(hasVideoSurface(frametableDef), 'the lane tile paints a live thumb').toBe(true);
    expect(frametableDef.face?.extension, 'and the dock paints the module body').toBe('frametable');
  });

  it('both XY pads bind CONTINUOUS pairs, rank both axes, and fold the y', () => {
    const pads = frametableDef.face?.xyPads ?? [];
    expect(pads.length, 'two pads, matching the card').toBe(2);
    const folded = foldedParamIds(frametableDef);
    for (const pad of pads) {
      for (const axis of [pad.x, pad.y]) {
        const p = param(axis);
        expect(p.curve, `${axis} is continuous — a pad over a discrete param is a stepper`)
          .not.toBe('discrete');
        expect(ORDER, `${axis} is ranked (completeness proves nothing was dropped)`).toContain(axis);
      }
      expect(folded.has(pad.y), `${pad.y} folds into the pad rather than painting twice`).toBe(true);
      expect(folded.has(pad.x), `${pad.x} anchors the pad`).toBe(false);
    }
  });

  it('a pad costs NO lane rank — and it takes TWO composed exclusions to get there', () => {
    // ⚠ MEASURED, because the obvious single-function assertion is WRONG and
    // passed for the wrong reason on the first draft of this test. `laneOrder`
    // alone drops only the pad's ANCHOR — it returns `…waveAmtX, waveShapeX,
    // waveAmtY…`, partners included — and it is `foldedOrder` (composed on top
    // of it inside `curatedFace`) that removes the partners. Asserting either
    // half in isolation would certify a face whose other half regressed.
    const laneOnly = laneOrder(frametableDef.face!);
    const folded = foldedParamIds(frametableDef);
    for (const pad of frametableDef.face?.xyPads ?? []) {
      expect(laneOnly, `${pad.x}: the ANCHOR is what laneOrder drops`).not.toContain(pad.x);
      expect(folded.has(pad.y), `${pad.y}: the PARTNER is what folding drops`).toBe(true);
    }
    // THE COMPOSED OBSERVABLE — the only one a player can see. Checked at the
    // WIDEST lane tier, so it is not passing merely because the video cap is 2.
    const wide = curatedFace(frametableDef, 'full')?.controls.map((c) => c.key) ?? [];
    for (const pad of frametableDef.face?.xyPads ?? []) {
      expect(wide, `${pad.x} never reaches a lane cell`).not.toContain(pad.x);
      expect(wide, `${pad.y} never reaches a lane cell`).not.toContain(pad.y);
    }
    // …and the DOCK is where the pad does render: the anchor paints one cell
    // for the pair, and the partner paints none.
    const dock = curatedFace(frametableDef, 'dock')?.controls.map((c) => c.key) ?? [];
    for (const pad of frametableDef.face?.xyPads ?? []) {
      expect(dock, `${pad.x} anchors the dock pad cell`).toContain(pad.x);
      expect(dock, `${pad.y} is inside it, not beside it`).not.toContain(pad.y);
    }
  });

  it('the TIER LADDER reads back as the comment claims: mini MODE, compact MODE+MORPH', () => {
    const mini = curatedFace(frametableDef, 'mini');
    const compact = curatedFace(frametableDef, 'compact');
    expect(mini?.controls.map((c) => c.key), 'mini: which instrument you are holding').toEqual(['mode']);
    expect(compact?.controls.map((c) => c.key), 'compact: which engine, and where it points')
      .toEqual(['mode', 'morph']);
  });

  it('FOUR honest bands, and the tab rail stays OFF', () => {
    const bands = dockFacePlan(frametableDef) ?? [];
    expect(bands.map((b) => b.id)).toEqual(['engine', 'scan', 'field', 'ring']);
    expect(bands.length, 'below the rail threshold').toBeLessThan(DOCK_TAB_MIN_BANDS);
    // ⚠ `dockTabPlan` TAKES BANDS AND RETURNS `DockTab[] | null`, and the first
    // draft of this line passed the DEF and read a `.tabbed` field that does not
    // exist — `undefined ?? false` is `false`, so it asserted `false === false`
    // and would have stayed green if this face had grown a rail. vitest accepted
    // it; svelte-check is what refused it, which is the whole reason `typecheck`
    // is a separate gate from `test`.
    expect(dockTabPlan(bands), 'so the dock renders a COLUMN, not a rail').toBeNull();
    // POSITIVE CONTROL: the same call DOES return a rail once the band count
    // crosses the threshold, so the null above is a property of this face
    // rather than of the arguments.
    const padded = [...bands, ...bands, ...bands].slice(0, DOCK_TAB_MIN_BANDS);
    expect(padded.length).toBe(DOCK_TAB_MIN_BANDS);
    expect(dockTabPlan(padded), 'the predicate can say YES').not.toBeNull();
    // ⚠ NON-VACUITY: this must be a real margin, not a coincidence at the
    // boundary. Padding to seven to earn a rail is what the owner ruling
    // forbids, so the gap is the thing being asserted.
    expect(DOCK_TAB_MIN_BANDS - bands.length, 'and not by one band').toBeGreaterThanOrEqual(2);
  });
});
