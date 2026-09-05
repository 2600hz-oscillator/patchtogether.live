// packages/web/src/lib/ui/modules/thin-utility-faces-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind the THIN AUDIO TAIL faceplates —
// utilities whose entire control surface is ONE knob or NOTHING at all.
//
// WHY ONE FILE FOR SEVERAL FACES. These faces are the same shape, and the two
// CV twins (polarizer / depolarizer) are literally the same control surface
// with inverse transfer functions. Reviewing them side by side is the point:
// the failure mode for a face this thin is not a wrong ranking (there is
// nothing to rank) but a control or a picture that quietly appears out of
// nowhere, and that is easiest to see when the four are read together.
//
// WHAT MAKES THIS FILE NECESSARY — three things no other gate sees:
//
//   1. `pages` IN THE VRT ROSTER IS AN UNGATED HAND COPY. `_shell-faces.ts`
//      declares how many section bands each dock scene must render, and
//      `shell-faces-roster.test.ts` only cross-checks `tabbedOptIn` — nothing
//      checks `pages` against the live face. A wrong number there fails as a
//      Playwright timeout on a capture job, which is the slowest possible place
//      to learn it. The band counts are asserted here, in the unit lane,
//      against the same planner the shell renders from.
//   2. A ZERO-CONTROL FACE MUST STAY FACED. `dockFacePlan` returns `null` for
//      an UN-faced def, and `ModuleShell` renders NO section bands at all for
//      a null plan, so the empty plan for these two modules has to be `[]` —
//      truthy, faced, no bands. `[]` and `null` are one keystroke apart and
//      only one of them is a visible regression (an empty faceplate).
//   3. THE GLYPH CHOICE WAS FORCED FOR THREE OF THEM AND A JUDGEMENT FOR ONE,
//      and that distinction is invisible in the declaration itself — every one
//      of them just reads `glyph: 'none'`.
//
// ⚠ THESE ARE MODEL ASSERTIONS, NOT PIXEL ONES. What renders is proven by the
// VRT scenes; what this file proves is that the declarations the renderer reads
// still say what these faces were built on.

import { describe, expect, it } from 'vitest';

import { depolarizerDef } from '$lib/audio/modules/depolarizer';
import { flipperDef } from '$lib/audio/modules/flipper';
import { moog994Def } from '$lib/audio/modules/moog994';
import { polarizerDef } from '$lib/audio/modules/polarizer';
import { dockFacePlan } from '$lib/ui/workflow/curated-face';
import { paramCellKind } from '$lib/ui/workflow/shell-control-kind';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import type { ParamDef } from '$lib/graph/types';

const NO_MOMENTARY: ReadonlySet<string> = new Set();

/** The batch, ANCHORED TO THE ARTIFACT: each entry carries the def itself, so
 *  a renamed or deleted module is a compile error rather than a silently
 *  skipped row. `bands` is the number of dock section bands the face plans —
 *  the number `_shell-faces.ts` copies as `pages`. */
const TAIL = [
  { type: 'flipper', def: flipperDef, bands: 0 },
  { type: 'moog994', def: moog994Def, bands: 0 },
  { type: 'depolarizer', def: depolarizerDef, bands: 1 },
  { type: 'polarizer', def: polarizerDef, bands: 1 },
] as const;

function param(def: { params: readonly ParamDef[] }, id: string): ParamDef {
  const p = def.params.find((q) => q.id === id);
  if (!p) throw new Error(`no param '${id}'`);
  return p;
}

describe('thin audio tail — the DEFAULTS and DECLARATIONS these faces were built on', () => {
  it('every module in the batch is PROMOTED, and its face ranks exactly what it declares', () => {
    const problems: string[] = [];
    for (const { type, def, bands } of TAIL) {
      if (!STRICT_FACES.has(type)) problems.push(`${type}: not in STRICT_FACES`);
      const order = def.face?.order ?? [];
      const paramIds = def.params.map((p) => p.id);
      // COMPLETENESS, both directions: every param ranked, nothing ranked that
      // is not a param. module-face-lint asserts this fleet-wide; stating it
      // here keeps the batch's own claim readable next to its band count.
      const unranked = paramIds.filter((id) => !order.includes(id));
      const unbacked = order.filter((k) => !paramIds.includes(k));
      if (unranked.length) problems.push(`${type}: params not ranked: ${unranked.join(',')}`);
      if (unbacked.length) problems.push(`${type}: ranked keys with no param: ${unbacked.join(',')}`);
      // The honest-band claim: a face with N controls gets N's worth of bands,
      // never a band invented to make the plate look furnished.
      if (order.length === 0 && bands !== 0) problems.push(`${type}: ranks nothing but claims ${bands} band(s)`);
    }
    expect(problems).toEqual([]);
  });

  it('NO face in this batch declares paramCells, momentary, pages, a hero or a title', () => {
    // The thin-face discipline, asserted rather than trusted. Every one of
    // these fields is a REASON TO BE WIDER or a reason to paint more text, and
    // none of these modules has earned one. A future edit that adds a hero to a
    // one-knob utility should have to delete a line here and say why.
    const problems: string[] = [];
    for (const { type, def } of TAIL) {
      const f = def.face as Record<string, unknown> | undefined;
      for (const field of ['paramCells', 'momentary', 'pages', 'hero', 'title', 'hint', 'xyPads', 'bareCells', 'extension', 'tabbed']) {
        if (f && f[field] !== undefined) problems.push(`${type}: declares face.${field}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the CV twins are declared IDENTICALLY apart from their module identity', () => {
    // polarizer and depolarizer are inverse transfer functions on the same
    // one-knob surface. Divergence between them is drift, not curation.
    expect(polarizerDef.face?.order).toEqual(depolarizerDef.face?.order);
    expect(polarizerDef.face?.glyph).toEqual(depolarizerDef.face?.glyph);
    for (const def of [polarizerDef, depolarizerDef]) {
      const depth = param(def, 'depth');
      expect(depth.defaultValue).toBe(1);
      expect(depth.min).toBe(0);
      expect(depth.max).toBe(1);
      expect(depth.curve).toBe('linear');
    }
  });

  it('DEPTH renders as the shell default KNOB — the card draws a Knob and the face adds nothing', () => {
    // The `noise` class in reverse. `paramCells: {depth:'fader'}` would be a
    // one-line change that no runtime gate reads back, and both defs' own docs
    // used to call DEPTH a "fader" — so this pins the agreement that the cards
    // draw <Knob> and the faces declare no override.
    for (const def of [polarizerDef, depolarizerDef]) {
      expect(paramCellKind(param(def, 'depth'), NO_MOMENTARY, 'dock')).toBe('knob');
    }
  });
});

describe('thin audio tail — the GLYPH decision, run through the real resolver', () => {
  it('every face in the batch resolves to NO glyph binding', () => {
    for (const { type, def } of TAIL) {
      expect(glyphBinding(def as never).kind, `${type} glyph binding`).toBe('none');
    }
  });

  it('FORCED vs CHOSEN: three of these could not have a live glyph, and moog994 could', () => {
    // The distinction the declaration itself cannot carry, and the reason the
    // `none` on moog994 needs a comment where the others do not.
    //
    // FORCED — no `audio` output at all, so any glyph would resolve to the DEAD
    // `static` binding that shipped on marbles through three passes.
    for (const def of [flipperDef, polarizerDef, depolarizerDef]) {
      expect(primaryAudioOutPortId(def as never)).toBeNull();
      const withMeter = { ...def, face: { ...(def.face ?? { order: [] }), glyph: 'meter' } };
      expect(glyphBinding(withMeter as never).kind).toBe('static');
    }

    // CHOSEN — moog994 HAS a primary audio out, so a meter would bind LIVE.
    // It is refused because the module is two INDEPENDENT groups and the glyph
    // binds one port: a rack patched through group B only would show a flat
    // meter over a module that is passing signal.
    expect(primaryAudioOutPortId(moog994Def as never)).toBe('a1');
    const moogWithMeter = { ...moog994Def, face: { ...(moog994Def.face ?? { order: [] }), glyph: 'meter' } };
    expect(glyphBinding(moogWithMeter as never).kind).toBe('live-audio');
  });
});

describe('thin audio tail — a face that ranks NOTHING still renders as a FACE', () => {
  it('planning a zero-control face yields NO bands — and an empty plan, never a null one', () => {
    for (const { type, def, bands } of TAIL) {
      const plan = dockFacePlan(def as never);
      // `null` means UN-FACED, and the shell then renders no bands at all.
      // That is the regression this clause exists to catch, and it is
      // invisible in a band count alone — `plan?.length ?? 0` reads 0 for both.
      expect(plan, `${type}: planned as UN-FACED — the faceplate would come up empty`).not.toBeNull();
      expect(plan!.length, `${type}: dock band count (the roster's \`pages\`)`).toBe(bands);
    }
  });

  it('no band in the batch is EMPTY — the bare-divider defect cannot come back', () => {
    // `.dock-page` is `border-top: 1px solid` + `padding-top: 6px`, so a band
    // with nothing in it paints a rule over blank space. On a face with an
    // extension body that reads as a divider; on these modules it would BE the
    // faceplate.
    const empties: string[] = [];
    for (const { type, def } of TAIL) {
      for (const b of dockFacePlan(def as never) ?? []) {
        if (b.controls.length === 0 && b.clusters.length === 0) empties.push(`${type}/${b.id}`);
      }
    }
    expect(empties).toEqual([]);
  });

  it('NEGATIVE CONTROL: the planner still emits a band for a face that DOES rank something', () => {
    // Both directions against the real planner, so the two clauses above cannot
    // be vacuously green — a `dockFacePlan` that had started returning `[]`
    // unconditionally would satisfy them and delete every faceplate in the app.
    const oneControl = {
      type: 'synthetic',
      params: [{ id: 'depth', label: 'DEPTH', defaultValue: 1, min: 0, max: 1, curve: 'linear' }],
      face: { order: ['depth'], glyph: 'none' },
    };
    const plan = dockFacePlan(oneControl as never);
    expect(plan).not.toBeNull();
    expect(plan!.length).toBe(1);
    expect(plan![0]!.controls.map((c) => c.key)).toEqual(['depth']);

    // …and the same def with its ranking removed collapses to no bands, which
    // is the exact edit that distinguishes the two outcomes.
    const ranksNothing = { ...oneControl, params: [], face: { order: [], glyph: 'none' } };
    expect(dockFacePlan(ranksNothing as never)).toEqual([]);

    // An UN-faced def is still `null` — the third outcome, and the one that
    // must not be confused with the second.
    const unfaced = { type: 'synthetic', params: [] };
    expect(dockFacePlan(unfaced as never)).toBeNull();
  });
});
