// packages/web/src/lib/ui/modules/warrensvisions-face-model.test.ts
//
// WARREN'S VISIONS — the permanent gate on the ONE thing this face exists for.
//
// The merit argument for promoting this module is not a layout: it is that the
// def declares a VOCABULARY and, until the face landed, NOTHING CONSUMED IT.
// This module is the only one in the unfaced pool declaring BOTH `options[]`
// (engineFreeze: LIVE / FREEZE, each with a `title`) AND `landmarks`
// (visionsShape: SINE / SAW / SQUARE), and `WarrensvisionsCard.svelte` read
// neither — it RE-TYPED the two freeze words as string literals in its own
// button (`{frozen ? 'FREEZE' : 'LIVE'}`, :130) and never passed the landmarks
// to its `<Knob>` at all.
//
// ⚠ WHY THIS FILE RATHER THAN AN EXISTING GATE — the blind-gates question,
// answered before writing it. Delete the `landmarks` array from the def
// tomorrow and ask what goes red:
//
//   * `contract-lock.txt` records NEITHER `options` NOR `landmarks`
//     (`serializeModuleContract` projects id/min/max/curve/defaultValue/units/
//     ports/flags), so `docs:accept` produces an EMPTY DIFF — a pool derived
//     from the lock alone is structurally blind to this whole class;
//   * `module-face-lint` checks that every param renders exactly one cell, not
//     WHICH cell or what it says;
//   * `module-docs-lint` reads the prose, not the roster;
//   * the VRT dock baseline would move by a few characters of grey text, well
//     under `DOCK_MAX_DIFF = 1500`, so it would stay GREEN AND STALE.
//
// So the answer today is "nothing", and the face would quietly degrade to the
// anonymous dials the card already shipped. Hence: read the LIVE def through
// the SAME pure resolvers the shell renders from, so the assertion cannot
// drift from what actually paints.

import { describe, expect, it } from 'vitest';
import { warrensvisionsDef } from '$lib/video/modules/warrensvisions';
import type { ParamDef } from '$lib/graph/types';
import { knobNameReadout, paintsReadout } from '$lib/ui/controls/knob-vocabulary-model';
import {
  declaredParamCells,
  momentaryParamIds,
  paramCellKind,
} from '$lib/ui/workflow/shell-control-kind';
import { curatedFace } from '$lib/ui/workflow/curated-face';
import { laneGlyphFor } from '$lib/ui/workflow/module-shell-model';

function param(id: string): ParamDef {
  const p = (warrensvisionsDef.params ?? []).find((q) => q.id === id);
  expect(p, `warrensvisions declares a param '${id}'`).toBeTruthy();
  return p as ParamDef;
}

/** The two `paramCellKind` arguments, DERIVED FROM THE LIVE DEF rather than
 *  hand-built as empties. This module declares no `face.momentary` and no
 *  `face.paramCells` today, so both resolve empty — but reading them through
 *  the same two resolvers the shell calls means declaring either one later
 *  changes what this file asserts, instead of leaving it quietly stale. */
const MOMENTARY = momentaryParamIds(warrensvisionsDef);
const AUTHORED_CELLS = declaredParamCells(warrensvisionsDef);

describe("warren's visions face — the DECLARED VOCABULARY reaches a surface", () => {
  it('FREEZE resolves a SEGMENTED cell at the dock, from its own options roster', () => {
    const pd = param('engineFreeze');
    expect(pd.options?.map((o) => o.label), 'the roster the card re-typed as literals')
      .toEqual(['LIVE', 'FREEZE']);
    // The card rendered a bespoke <button class="freeze"> and spelled the two
    // words itself. The face renders the def's roster.
    expect(paramCellKind(pd, MOMENTARY, 'dock', AUTHORED_CELLS)).toBe('segmented');
  });

  it('SHAPE paints its landmark NAME — the one text a resting faceplate may still print', () => {
    const pd = param('visionsShape');
    expect(pd.landmarks?.map((l) => l.label)).toEqual(['SINE', 'SAW', 'SQUARE']);
    expect(paintsReadout(pd), 'no `format` declared, so the NAME is paintable').toBe(true);
    // At the shipped default the dial says what it is.
    expect(knobNameReadout(pd.defaultValue, pd)).toBe('SINE');
    expect(knobNameReadout(0.5, pd)).toBe('SAW');
    expect(knobNameReadout(1, pd)).toBe('SQUARE');
  });

  it('the readout is NEAREST-MATCH, and that is platform behaviour rather than a defect', () => {
    // ⚠ RECORDED SO NOBODY READS THE LABEL AS A HARMONIC CLAIM. `SAW` prints
    // across the whole (0.25, 0.75] half of the dial, and ties resolve to the
    // EARLIER entry. The morph really is an exact ideal saw at exactly 0.5 —
    // `max |w(n, shape) - 1/n|` over n = 2..8 is 0.000000 there against
    // 0.249900 at 0.2501, measured through the module's own `wvHarmonicWeight`
    // — but the label names a REGION, not a measurement of one point.
    const pd = param('visionsShape');
    expect(knobNameReadout(0.25, pd), 'an exact tie resolves to the earlier entry').toBe('SINE');
    expect(knobNameReadout(0.2501, pd)).toBe('SAW');
    expect(knobNameReadout(0.7499, pd)).toBe('SAW');
  });

  // ── The instrument's own negative controls ────────────────────────────────
  it('a params-with-UNITS control paints NOTHING — the predicate can say no', () => {
    // Without this leg, a `knobNameReadout` that returned a truthy string for
    // everything would pass every assertion above. FLOOR declares `units: 'dB'`
    // and no vocabulary at all, so it must resolve to null at every value —
    // this is also why the face adds no fourth readout for it.
    const floor = param('visionsFloor');
    expect(floor.units).toBe('dB');
    expect(floor.landmarks, 'FLOOR declares no vocabulary').toBeUndefined();
    expect(floor.options).toBeUndefined();
    expect(knobNameReadout(floor.defaultValue, floor)).toBeNull();
    expect(knobNameReadout(-90, floor)).toBeNull();
  });

  it('a plain continuous control resolves a KNOB, not a segmented cell', () => {
    // The paramCellKind half of the same question: if that resolver returned
    // 'segmented' for everything, the FREEZE assertion would be vacuous.
    expect(paramCellKind(param('visionsCoherence'), MOMENTARY, 'dock', AUTHORED_CELLS)).toBe('knob');
    expect(paramCellKind(param('visionsShape'), MOMENTARY, 'dock', AUTHORED_CELLS)).toBe('knob');
  });

  it('TOTALITY — the readout resolver survives the values a drag can produce', () => {
    // It runs on every render, so a throw takes the faceplate down mid-drag.
    const pd = param('visionsShape');
    for (const v of [NaN, Infinity, -Infinity, -1, 2]) {
      expect(() => knobNameReadout(v, pd), `knobNameReadout(${v})`).not.toThrow();
    }
  });
});

describe("warren's visions face — order and pages disagree ON PURPOSE", () => {
  const face = warrensvisionsDef.face;

  it('ranks COHERENCE first, on the def\'s own stated priority', () => {
    // `warrensvisions.ts` says it above `params`: "COHERENCE first: it is the
    // control that changes the module's identity, and no other control on it
    // moves more." A rank that contradicted that would need an argument.
    expect(face?.order?.[0]).toBe('visionsCoherence');
    expect(face?.order?.slice(0, 3)).toEqual([
      'visionsCoherence', 'visionsComponents', 'visionsMix',
    ]);
  });

  it('puts rank 1 in the SECOND band — the disagreement, asserted rather than described', () => {
    // `order` ranks by PRIORITY (for the tiers showing a subset); `pages` groups
    // by KIND (for the tier showing everything). COHERENCE belongs WITH drift
    // and slew — how the bank behaves over time — which is not the thing it is
    // more important THAN. This assertion is what stops a later "tidy-up" from
    // silently collapsing the two into one order.
    const pages = face?.pages ?? [];
    const bandOfRank1 = pages.findIndex((p) => p.controls.includes('visionsCoherence'));
    expect(pages[bandOfRank1]?.id).toBe('motion');
    expect(bandOfRank1, 'rank 1 is deliberately NOT in the first band').toBeGreaterThan(0);
  });

  it('the LANE BUDGET is set by the PICTURE, not by the declared glyph', () => {
    // ⚠ THE CLAIM THIS FILE EXISTS TO STOP DRIFTING, and the one the spec got
    // wrong. `face.glyph` is a mandatory `'none'` on any video def — every
    // other value resolves `{kind:'static'}` (there is no audio output for the
    // resolver to tap) and reddens the dead-glyph clause. It is TEMPTING to
    // read the compact cap off that declaration, and the spec did:
    // "no glyph binds ⇒ compact cap 3 ⇒ plate and dock carry all twelve".
    //
    // Both halves are false. `laneGlyphFor` answers 'picture', because
    // `hasVideoSurface` mounts a live thumbnail of this module's own output and
    // that thumbnail SPENDS A LANE CELL — so the budget is
    // LANE_ROW_MAX_CELLS_WITH_GLYPH, and the plate is capped too. This is
    // #1785's trap ("never a hand-rolled glyph predicate") and it is why
    // `faceTierCap` takes `laneGlyphFor(def)` rather than `face.glyph`.
    expect(warrensvisionsDef.face?.glyph, 'the mandatory video declaration').toBe('none');
    expect(laneGlyphFor(warrensvisionsDef as never), 'what the LANE actually budgets for')
      .toBe('picture');
    // The two disagree, which is the whole point — assert it rather than
    // describe it, so a platform change that made them agree is visible here.
    expect(laneGlyphFor(warrensvisionsDef as never)).not.toBe(warrensvisionsDef.face?.glyph);
  });

  it('the measured TIER LADDER — the picture costs one control at every lane tier', () => {
    const keys = (tier: 'mini' | 'compact' | 'full' | 'dock') =>
      curatedFace(warrensvisionsDef as never, tier)?.controls.map((c) => c.key) ?? [];
    expect(keys('mini')).toEqual(['visionsCoherence']);
    expect(keys('compact')).toEqual(['visionsCoherence', 'visionsComponents']);
    expect(keys('full')).toEqual(['visionsCoherence', 'visionsComponents', 'visionsMix']);
    // The dock shows everything, in rank order — derived from the face, so no
    // count is typed here either.
    expect(keys('dock')).toEqual([...(warrensvisionsDef.face?.order ?? [])]);
    // MIX arrives at the PLATE rather than at compact, and that is the
    // consequence worth naming: the one control that can take this module out
    // of the shot is not on the smallest playable tile.
    expect(keys('compact')).not.toContain('visionsMix');
    expect(keys('full')).toContain('visionsMix');
  });

  it('every page control is ranked, and every ranked control is on a page', () => {
    // Derived membership in both directions — no count is typed, and an
    // unpaged control (which the shell would sweep into a `more` catch-all
    // band) is red rather than invisible.
    const ranked = [...(face?.order ?? [])].sort();
    const paged = (face?.pages ?? []).flatMap((p) => [...p.controls]).sort();
    expect(paged).toEqual(ranked);
    // ...and both cover the def's own params exactly.
    expect(ranked).toEqual([...(warrensvisionsDef.params ?? []).map((p) => p.id)].sort());
  });
});
