// packages/web/src/lib/ui/modules/shapedramps-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the SHAPEDRAMPS faceplate (cut A, batch 2).
//
// Two claims are worth pinning here rather than in a comment, because both are
// judgements this face makes AGAINST the obvious reading of the module:
//
//   1. the two SHAPE params are NOT selectors, even though the module's own
//      prose names four shapes — the shader blends between them, so a roster
//      would tell the player the in-between values are unreachable;
//   2. the eight fader-drawn params get NO `paramCells`, which is the fleet
//      convention and NOT what a literal reading of the card would produce.
//
// Plus the ranking argument, which is the one thing a reviewer cannot check by
// reading the def: that the two inert-until-patched mixes are what lose the
// lane budget, and that everything ranked above them moves the picture on an
// unpatched instance.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shapedrampsDef } from '$lib/video/modules/shapedramps';
import { curatedFace, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { declaredParamCells, momentaryParamIds, paramCellKind } from '$lib/ui/workflow/shell-control-kind';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';

const def = shapedrampsDef as unknown as FaceDefLike & { type: string };

/** The LIVE `ParamDef` — `FaceDefLike` narrows params to `FaceParamLike`, so
 *  min/max/curve/options are unreachable through `def.params`. */
function param(id: string) {
  const p = shapedrampsDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`shapedramps has no param '${id}'`);
  return p;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = resolve(HERE, '../../video/modules/shapedramps.ts');
const BODY_SRC = resolve(HERE, 'shapedramps/ShapedrampsOutputBody.svelte');

describe('shapedramps face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('shapedramps')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' AND still paints a live lane picture", () => {
    // A video def MUST declare 'none' (the dead-glyph clause refuses a trace on
    // a def with no audio output), which makes "none + blank tile" and
    // "none + live thumb" indistinguishable from the declaration alone. Assert
    // the seam that actually paints.
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def)).toBe(true);
    expect(laneGlyphFor(def as Parameters<typeof laneGlyphFor>[0])).toBe('picture');
  });

  it('owns a fullViewBody extension — after promotion it is the ONLY picture', () => {
    expect(def.face?.extension).toBe('shapedramps');
  });
});

describe('shapedramps face — the ranking is by what moves the picture', () => {
  it('ranks all eight params, shapes first and mixes last', () => {
    expect(def.face?.order).toEqual([
      'h_shape', 'v_shape', 'h_freq', 'v_freq', 'h_phase', 'v_phase', 'mix1', 'mix2',
    ]);
  });

  it('COMPLETE: every declared param is ranked exactly once', () => {
    const ranked = def.face?.order ?? [];
    expect([...ranked].sort()).toEqual(shapedrampsDef.params.map((p) => p.id).sort());
    expect(new Set(ranked).size, 'no key ranked twice').toBe(ranked.length);
  });

  // ⚠ THE RANK ARGUMENT, MADE CHECKABLE. The claim on the def is that the two
  // mixes lose the lane because they are INERT ON AN UNPATCHED INSTANCE — they
  // crossfade `mix{N}_a` against `mix{N}_b`, which are patched inputs, not this
  // module's own output. That is a property of the PORTS, so it can be asserted
  // rather than argued.
  it('the two demoted controls are exactly the ones that need a patch to do anything', () => {
    const inputIds = new Set(shapedrampsDef.inputs.map((p) => p.id));
    for (const mix of ['mix1', 'mix2'] as const) {
      expect(inputIds.has(`${mix}_a`), `${mix} crossfades a patched input A`).toBe(true);
      expect(inputIds.has(`${mix}_b`), `${mix} crossfades a patched input B`).toBe(true);
    }
    // …and every control ranked ABOVE them drives the ramp shaders directly,
    // i.e. changes the picture with nothing plugged in. Their CV inputs target
    // the param of the same name, which is the seam that proves they are ramp
    // controls rather than mixer amounts.
    for (const id of ['h_shape', 'v_shape', 'h_freq', 'v_freq', 'h_phase', 'v_phase'] as const) {
      const cv = shapedrampsDef.inputs.find((p) => p.id === id);
      expect(cv?.paramTarget, `${id} has a same-named CV input targeting itself`).toBe(id);
    }
  });

  it('the lane budget takes the six ramp controls and drops both mixes', () => {
    const lane = curatedFace(def, 'full')!.controls.map((c) => c.key);
    expect(lane).not.toContain('mix1');
    expect(lane).not.toContain('mix2');
    expect(lane.length, 'the lane is full — the demotion is a real trade, not spare room')
      .toBeGreaterThan(0);
    // The DOCK still has everything: nothing is lost, only ranked.
    expect(curatedFace(def, 'dock')!.controls.map((c) => c.key).sort())
      .toEqual([...(def.face?.order ?? [])].sort());
  });

  it('two bands, mirroring the two regions the card separates', () => {
    const plan = dockFacePlan(def)!;
    expect(plan.map((b) => b.label)).toEqual(['ramps', 'mix']);
  });
});

describe('shapedramps face — the two declarations it deliberately does NOT make', () => {
  // ⚠ CLAIM 1. Every control on the legacy card was a `<NeonFader>`, so
  // "declare the primitive the card established" read literally would have put
  // `fader` on all eight. The fleet does the opposite, and
  // `shell-control-kind.ts` records why (23 faced modules rank 121 fader-drawn
  // params as knobs; converting them is an owner ruling with a measured lane
  // cost). This pins the choice so that reversing it is a deliberate edit
  // rather than a drift.
  //
  // ⚠ THE PREMISE USED TO BE RE-MEASURED OFF THE CARD SOURCE — "this card
  // really does draw every param as a fader" — and that half is now history,
  // recorded rather than asserted, because the card it read is gone. What is
  // asserted instead is the CONSEQUENCE, which is the half that can still go
  // wrong: with no declaration the dock resolves the fleet default for every
  // one of these params, and a stray `paramCells` entry would surface here as a
  // fader rather than as a silent string nobody reads.
  it('declares NO paramCells, so every control resolves the FLEET default', () => {
    const cells = declaredParamCells(def);
    expect([...cells.keys()]).toEqual([]);
    for (const p of shapedrampsDef.params) {
      expect(paramCellKind(p, new Set(), 'dock', cells), `${p.id} must not be a fader`)
        .not.toBe('fader');
    }
  });

  // ⚠ CLAIM 2. `h_shape`/`v_shape` look like 4-position selectors and are not.
  it('the SHAPE params carry no options roster — they are a continuous morph', () => {
    for (const id of ['h_shape', 'v_shape'] as const) {
      const p = param(id);
      expect(p.options, `${id} must not declare detents`).toBeUndefined();
      expect(p.curve, `${id} is continuous`).toBe('linear');
    }
    // The read site is what makes this true: the shader picks a SEGMENT and
    // then MIXES across it, so intermediate values are reachable states rather
    // than gaps between detents. Asserted against the source so that a future
    // shader rewrite to hard detents would redden this claim rather than
    // silently making the roster's absence wrong.
    const src = readFileSync(MODULE_SRC, 'utf8');
    expect(src, 'the shape shader blends between adjacent shapes').toMatch(/mix\(vLin,\s*vTri,\s*frac\)/);
    expect(src).toMatch(/mix\(vTri,\s*vFold,\s*frac\)/);
    expect(src).toMatch(/mix\(vFold,\s*vRad,\s*frac\)/);
  });

  it('declares no momentary params — nothing here is switch-shaped', () => {
    expect([...momentaryParamIds(def)]).toEqual([]);
    for (const p of shapedrampsDef.params) {
      expect(p.curve, `${p.id} is a continuous scalar`).toBe('linear');
    }
  });
});

describe('shapedramps face — the SCREEN body keeps the watch mark', () => {
  const body = readFileSync(BODY_SRC, 'utf8');

  it('marks the node watched in the COLLAPSED branch', () => {
    // The whole #1937 contract. Without this the toggle is a producer kill
    // switch wherever nothing downstream is watching.
    expect(body).toMatch(/if \(previewCollapsed\) \{[\s\S]{0,200}markWatched\(nodeId\)/);
  });

  it('runs ONE rAF loop in BOTH screen states — the toggle never restarts it', () => {
    // The spirographs shape (tear the loop down while collapsed) is what this
    // is deliberately NOT. A body that cancels its loop on collapse cannot mark
    // anything watched, which is the same defect from the other direction.
    expect(body).not.toMatch(/if \(previewCollapsed\) \{[\s\S]{0,120}cancelAnimationFrame/);
  });

  it('REMOVES the canvas rather than hiding it, and the switch survives', () => {
    expect(body).toMatch(/\{#if !previewCollapsed\}[\s\S]{0,400}<canvas/);
    // The button is OUTSIDE the conditional — otherwise SCREEN OFF would have
    // no way back on.
    const off = body.indexOf('{/if}');
    expect(body.indexOf('screen-btn'), 'the toggle is not inside the {#if}').toBeGreaterThan(off);
  });

  it('persists on the NODE, under the shared fleet key', () => {
    expect(body).toMatch(/data\?\.previewCollapsed/);
    expect(body).toMatch(/live\.data\.previewCollapsed = next/);
  });
});
