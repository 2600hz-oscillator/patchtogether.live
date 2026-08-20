// packages/web/src/lib/ui/modules/bentbox-face-model.test.ts
//
// BENTBOX — the permanent gates on the three claims this face is built from.
// Each reads the LIVE def through the SAME pure resolvers the shell renders
// from, so an assertion here cannot drift from what actually paints.
//
// ⚠ WHY A FILE AT ALL — the blind-gate question, asked before writing it.
// Revert the `curve` correction below tomorrow and ask what goes red:
// `contract-lock` DOES catch it (curve is projected, unlike `options` and
// `landmarks`), which is genuinely more coverage than most face claims get.
// But the lock records the DECLARATION, not its CONSEQUENCE — it cannot say
// whether the shell paints a toggle or a rotary, and that consequence is the
// entire reason the edit was made. So the lock and this file gate the two
// halves of one change, and neither is redundant.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bentboxDef } from '$lib/video/modules/bentbox';
import type { ParamDef } from '$lib/graph/types';
import {
  declaredParamCells,
  momentaryParamIds,
  paramCellKind,
} from '$lib/ui/workflow/shell-control-kind';
import { curatedFace } from '$lib/ui/workflow/curated-face';
import { laneGlyphFor } from '$lib/ui/workflow/module-shell-model';

function param(id: string): ParamDef {
  const p = (bentboxDef.params ?? []).find((q) => q.id === id);
  expect(p, `bentbox declares a param '${id}'`).toBeTruthy();
  return p as ParamDef;
}

/** Derived from the LIVE def rather than hand-built as empties, so declaring
 *  either field later changes what this file asserts instead of leaving it
 *  quietly stale. */
const MOMENTARY = momentaryParamIds(bentboxDef);
const AUTHORED_CELLS = declaredParamCells(bentboxDef);

describe('bentbox face — the MIRROR pair paints a SWITCH, not a rotary', () => {
  it('both mirrors are DISCRETE, which is what makes them toggles', () => {
    // The correction. `mirrorUv` hard-thresholds both (`>= 0.5`), so `linear`
    // was always a lie about a two-state value — invisible because the CARD
    // renders BUTTONS while the DEF said otherwise, the def-vs-card divergence
    // class. `looksLikeToggle` keys on exactly this shape.
    for (const id of ['mirrorX', 'mirrorY']) {
      const pd = param(id);
      expect(pd.curve, `${id} curve`).toBe('discrete');
      expect(pd.min, `${id} min`).toBe(0);
      expect(pd.max, `${id} max`).toBe(1);
      expect(paramCellKind(pd, MOMENTARY, 'dock', AUTHORED_CELLS), `${id} cell`).toBe('toggle');
    }
  });

  it('a CONTINUOUS control still resolves a KNOB (negative control)', () => {
    // Without this leg a resolver that answered 'toggle' for everything would
    // pass the assertion above. These four are the bend/timing dials.
    for (const id of ['hsync_loss', 'feedback_gain', 'wavefold', 'master_gain']) {
      expect(paramCellKind(param(id), MOMENTARY, 'dock', AUTHORED_CELLS), `${id} cell`).toBe('knob');
    }
  });
});

describe('bentbox face — the SYNTHETIC gates are not controls', () => {
  it('declares mirrorXGate / mirrorYGate as noUserControl, with a writer and a why', () => {
    const declared = (bentboxDef.noUserControl ?? []).map((n) => n.param).sort();
    expect(declared).toEqual(['mirrorXGate', 'mirrorYGate']);
    for (const entry of bentboxDef.noUserControl ?? []) {
      expect(entry.writer, `${entry.param} writer`).toBe('cv-port');
      expect((entry.why ?? '').length, `${entry.param} why`).toBeGreaterThan(40);
    }
  });

  it('the face ranks EVERY param except exactly those two — derived, not counted', () => {
    // DERIVED MEMBERSHIP in both directions: the ranked set is the declared
    // params MINUS the declared non-controls. No population count is typed, and
    // a new synthetic param that nobody classified would fail here rather than
    // silently appearing as a rotary on the faceplate.
    const declaredIds = (bentboxDef.params ?? []).map((p) => p.id);
    const notControls = new Set((bentboxDef.noUserControl ?? []).map((n) => n.param));
    const expected = declaredIds.filter((id) => !notControls.has(id)).sort();
    expect([...(bentboxDef.face?.order ?? [])].sort()).toEqual(expected);
    // ...and each synthetic gate really is absent from the face.
    for (const id of notControls) {
      expect(bentboxDef.face?.order ?? [], `${id} must not be ranked`).not.toContain(id);
    }
  });

  it('every page control is ranked, and every ranked control is on a page', () => {
    const ranked = [...(bentboxDef.face?.order ?? [])].sort();
    const paged = (bentboxDef.face?.pages ?? []).flatMap((p) => [...p.controls]).sort();
    // An unpaged control would be swept into the shell's `more` catch-all band
    // — visible, but unplaced. This makes that RED instead.
    expect(paged).toEqual(ranked);
  });
});

describe('bentbox face — the lane budget is set by the PICTURE', () => {
  it('declares glyph none, and the LANE still budgets for a picture', () => {
    // ⚠ THE TRAP #1785 NAMES. `face.glyph` is a mandatory `'none'` on a video
    // def — every other value resolves `{kind:'static'}` (no audio output for
    // the resolver to tap) and reddens the dead-glyph clause. It is tempting to
    // read the tier caps off that declaration; they come from
    // `laneGlyphFor(def)`, which answers 'picture' because `hasVideoSurface`
    // mounts a live thumbnail that SPENDS A LANE CELL.
    expect(bentboxDef.face?.glyph).toBe('none');
    expect(laneGlyphFor(bentboxDef as never)).toBe('picture');
    expect(laneGlyphFor(bentboxDef as never)).not.toBe(bentboxDef.face?.glyph);
  });

  it('the measured TIER LADDER, in the def\'s own priority order', () => {
    const keys = (tier: 'mini' | 'compact' | 'full' | 'dock') =>
      curatedFace(bentboxDef as never, tier)?.controls.map((c) => c.key) ?? [];
    // The rank follows the module's own docs — "sync tearing, hue shimmer,
    // ghosting, solarization" — so the smallest tile carries the TEAR.
    expect(keys('mini')).toEqual(['hsync_loss']);
    expect(keys('compact')).toEqual(['hsync_loss', 'feedback_gain']);
    expect(keys('full')).toEqual(['hsync_loss', 'feedback_gain', 'wavefold']);
    expect(keys('dock')).toEqual([...(bentboxDef.face?.order ?? [])]);
  });
});

describe('bentbox face — determinism, and why it needs NO freeze param', () => {
  it('declares no `freeze` param, unlike its sibling b3ntb0x', () => {
    // The face VRT scenes rely on the shader returning early with nothing
    // patched (a static vUv-only gradient). Adding a `freeze` param would be a
    // `params` edit on a def inside the WebGL attest basis — an owner-machine
    // re-attest — to buy an assertion that already holds. This pins the
    // ABSENCE so a later "make it match b3ntb0x" edit is a deliberate act.
    const ids = (bentboxDef.params ?? []).map((p) => p.id);
    expect(ids).not.toContain('freeze');
  });

  it('the unpatched branch of the shader carries NO time term', () => {
    // ⚠ THE SOURCE IS THE EVIDENCE, BECAUSE THE COMMENT ON THAT BRANCH IS
    // WRONG. It calls the idle field "a dim sweeping color bar field"; the code
    // neither sweeps nor draws bars — it is `vec4(0.04, 0.06, 0.10 + vUv.y *
    // 0.05, 1.0)`, a pure function of vUv. A later reader trusting the prose
    // would conclude this scene cannot be deterministic and "fix" it by adding
    // a `freeze` param, which costs a real-GPU re-attest. So the determinism
    // argument is gated against the CODE.
    //
    // Source-level by necessity: the shader is a template string the def does
    // not export, and GLSL never runs in this lane. The `face-readout-source`
    // and `card-range-source` gates are the precedent for reading source when
    // no runtime gate can see the thing.
    const file = fileURLToPath(new URL('../../video/modules/bentbox.ts', import.meta.url));
    const src = readFileSync(file, 'utf8');

    const start = src.indexOf('if (uHasInput < 0.5)');
    expect(start, 'the early-return guard must exist — it IS the determinism argument').toBeGreaterThan(-1);
    const end = src.indexOf('return;', start);
    expect(end, 'the guard must actually return').toBeGreaterThan(start);
    const idleBranch = src.slice(start, end);

    // The whole claim: nothing in the unpatched path can advance between frames.
    for (const token of ['uTime', 'Date.now', 'performance.now', 'Math.random', 'uPrev']) {
      expect(idleBranch, `the idle branch must not reference ${token}`).not.toContain(token);
    }

    // ⚠ NEGATIVE CONTROL, and it is the leg that makes the four above mean
    // something: the tokens ARE present in this file, just after the guard. A
    // slice that silently matched nothing — a renamed uniform, a moved guard —
    // would pass every assertion above while proving nothing at all.
    expect(src.slice(end), 'uTime must exist BELOW the guard, or this test is vacuous').toContain('uTime');
    expect(src.slice(end), 'uPrev must exist BELOW the guard, or this test is vacuous').toContain('uPrev');
  });
});
