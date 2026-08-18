// packages/web/src/lib/ui/modules/videoout-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the videoOut face (#1821).
//
// ⚠ THIS FILE EXISTS BECAUSE EVERY GENERIC GATE PASSES VACUOUSLY OVER THIS FACE.
// `videoOutDef` declares `params: []`, so `module-face-lint`'s completeness, the
// dock render-plan parity check and `faces-parity` all enumerate an EMPTY set —
// their green runs would look exactly the same if this face were completely
// broken. That is the `blind-gates.md` question ("would its green run look any
// different if the answer were 'everything'?") answered in the affirmative, so
// the real coverage has to be written here.
//
// What it pins, and why each is unreachable from the declaration:
//
//   1. THE LANE TILE STILL SHOWS A PICTURE. `glyph: 'none'` is mandatory for a
//      video def, and `'none' + blank tile` is indistinguishable from
//      `'none' + live thumb` from the declaration alone — the picture arrives
//      through `hasVideoSurface`. This is also the #1785 leg: a promoted video
//      module LOSES its rack thumbnail when ranked cells push the face onto the
//      PLATE branch, and the reason videoOut does not is that it ranks nothing.
//      Asserted in BOTH directions, so it cannot pass by being blind.
//   2. THE EXTENSION RESOLVES. A `face.extension` naming a directory that does
//      not exist degrades to the generic shell at RENDER time (never throws), so
//      only a test can tell "the bespoke surface mounted" from "it silently did
//      not". For this module that is the whole faceplate.
//   3. THE DEF STILL HAS NOTHING TO RANK. The empty `order` is only correct
//      while `params` is empty; the day a param is added, an empty order is a
//      completeness failure AND walks the tile toward the plate branch.

import { describe, expect, it } from 'vitest';

import { videoOutDef } from '$lib/video/modules/video-out';
import {
  LANE_ROW_MAX_CELLS,
  LANE_ROW_MAX_CELLS_WITH_GLYPH,
  hasVideoSurface,
  laneBodyPlan,
} from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { shellExtensionIds, loadShellExtension } from '$lib/ui/workflow/shell-extensions';
import { getVideoModuleDef } from '$lib/video/module-registry';
import '$lib/video/modules';

const LANE_TIERS = ['mini', 'compact', 'full'] as const;

describe('videoOut face — the LANE PICTURE (#1785)', () => {
  it('resolves a LIVE VIDEO SURFACE, which is the only reason its tile paints anything', () => {
    // `glyph: 'none'` says nothing about the picture. `hasVideoSurface` is what
    // mounts VideoTileThumb, and it is a property of the DOMAIN, not the face.
    expect(videoOutDef.face?.glyph).toBe('none');
    expect(hasVideoSurface(videoOutDef)).toBe(true);
  });

  it('KEEPS the glyph strip at EVERY lane tier — it never reaches the plate branch', () => {
    // #1785: "ranked cells outrank the glyph" is a property of `laneBodyPlan`'s
    // PLATE branch, which is reached only when a face has more controls than a
    // row can hold. With zero controls this face takes the ROW branch at every
    // tier, where the glyph is unconditional.
    const cells = (videoOutDef.face?.order ?? []).length;
    for (const tier of LANE_TIERS) {
      const plan = laneBodyPlan(cells, /* hasGlyph */ true, tier);
      expect(plan.layout, `${tier}: a zero-control face must not take the plate branch`).toBe('row');
      expect(plan.glyph, `${tier}: the rack tile keeps its live picture`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the SAME predicate DOES evict the picture for a control-heavy face', () => {
    // ⚠ Without this leg, the assertion above would pass on an instrument that
    // simply always returns `glyph: true` — the passing-negative-control trap.
    // A face with more cells than a plate row can hold loses it, which is
    // exactly what #1785 measured on backdraft's 28 lane-eligible controls.
    const heavy = laneBodyPlan(28, true, 'full');
    expect(heavy.layout).toBe('plate');
    expect(heavy.glyph, 'the eviction this face avoids is REAL and still fires').toBe(false);
  });

  it('NEGATIVE CONTROL: the picture is a function of hasGlyph, not a constant', () => {
    // The other direction: the plan must be able to say "no glyph" for a face
    // that declares none, or the leg above proves nothing about this one.
    for (const tier of LANE_TIERS) {
      expect(laneBodyPlan(0, false, tier).glyph).toBe(false);
    }
  });

  it('the margin to the plate branch is stated, so a future param is a RED test and not a surprise', () => {
    // Not a population count — a PROPERTY of the current declaration measured
    // against the platform's own row cap. It says: this face has room for this
    // many ranked controls before the tile starts losing its picture.
    const cells = (videoOutDef.face?.order ?? []).length;
    const cap = Math.max(LANE_ROW_MAX_CELLS, LANE_ROW_MAX_CELLS_WITH_GLYPH);
    expect(
      cells,
      `videoOut ranks ${cells} control(s); above ${cap} the 'full' lane tier takes the PLATE branch `
        + 'and #1785 evicts the live thumbnail. Adding a param to this def means deciding what the '
        + 'rack tile shows.',
    ).toBeLessThanOrEqual(cap);
  });
});

describe('videoOut face — the BESPOKE SURFACE', () => {
  it('declares the extension, and the extension actually resolves a fullViewBody', async () => {
    // An id the glob did not discover resolves `null` and the render degrades
    // SILENTLY to the generic shell — which, for a face with no bands, is an
    // empty faceplate. Only a test separates "mounted" from "silently absent".
    const id = videoOutDef.face?.extension;
    expect(id).toBe('videoOut');
    expect(shellExtensionIds()).toContain('videoOut');
    const ext = await loadShellExtension(id!);
    expect(ext, 'the declared extension id must resolve to a discovered module').not.toBeNull();
    expect(typeof ext?.fullViewBody, 'the fullViewBody slot must be filled').toBe('function');
  });

  it('is PROMOTED — an authored face outside STRICT_FACES ships as a no-op', () => {
    expect(STRICT_FACES.has('videoOut')).toBe(true);
  });
});

describe('videoOut face — the EMPTY RANKING is a claim about the def', () => {
  it('the def genuinely has nothing to rank', () => {
    // The empty `order` is only correct while this holds. `module-face-lint`
    // would catch an unranked param, but it would catch it as a completeness
    // failure with no hint that the LANE PICTURE is the real casualty — this
    // states the connection where an author will read it.
    expect(videoOutDef.params ?? []).toEqual([]);
    expect(videoOutDef.face?.order ?? []).toEqual([]);
    expect(videoOutDef.face?.pages, 'no controls ⇒ no pages to name').toBeUndefined();
    expect(videoOutDef.face?.hero, 'no controls ⇒ nothing to promote into a hero').toBeUndefined();
  });

  it('the def in the LIVE REGISTRY is the one this file asserts about', () => {
    // Anchored: a rename would otherwise leave every leg above testing a def
    // nothing renders.
    expect(getVideoModuleDef('videoOut')).toBe(videoOutDef);
  });
});
