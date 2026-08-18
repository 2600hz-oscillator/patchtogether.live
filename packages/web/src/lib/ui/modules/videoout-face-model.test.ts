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
  hasVideoSurface,
  laneBodyPlan,
  laneGlyphFor,
} from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { shellExtensionIds, loadShellExtension } from '$lib/ui/workflow/shell-extensions';
import { getVideoModuleDef } from '$lib/video/module-registry';
import '$lib/video/modules';

const LANE_TIERS = ['mini', 'compact', 'full'] as const;

describe('videoOut face — the LANE PICTURE (#1785, as settled by #1845)', () => {
  it('resolves a LIVE VIDEO SURFACE, and that is what makes its lane glyph a PICTURE', () => {
    // `face.glyph: 'none'` says nothing about the picture — it is mandatory for a
    // video def (no audio port, so any other literal is a dead binding). The
    // picture arrives from the DOMAIN, through `hasVideoSurface`, and #1845 gave
    // that its own kind in the lane plan.
    expect(videoOutDef.face?.glyph).toBe('none');
    expect(hasVideoSurface(videoOutDef)).toBe(true);
    expect(laneGlyphFor(videoOutDef)).toBe('picture');
  });

  it('KEEPS its picture at EVERY lane tier', () => {
    // WARNING: THE REASON CHANGED UNDER THIS TEST, AND THE CONCLUSION GOT
    // STRONGER. It used to argue: "#1785 evicts on the PLATE branch; videoOut
    // ranks nothing, so it never reaches that branch." True when written, and now
    // obsolete: #1845 made the PICTURE OUTRANK ranked cells, so a picture face
    // keeps its glyph on BOTH branches and the cells give way instead. videoOut
    // no longer depends on being control-less for its picture, which is why the
    // margin test that used to live here is deleted rather than re-tuned.
    const glyph = laneGlyphFor(videoOutDef);
    const cells = (videoOutDef.face?.order ?? []).length;
    for (const tier of LANE_TIERS) {
      expect(laneBodyPlan(cells, glyph, tier).glyph, `${tier}: the rack tile keeps its live picture`).toBe(true);
    }
  });

  it('and keeps it even if this def GROWS CONTROLS — the property #1845 actually bought', () => {
    // The forward-looking half. Under the old rule, adding params to videoOut
    // would eventually have cost it its thumbnail; under #1845 a control-heavy
    // PICTURE face keeps the picture and sheds cells to fit. Pinned here because
    // videoOut is the face that would rely on it first.
    for (const n of [4, 12, 28]) {
      expect(laneBodyPlan(n, 'picture', 'full').glyph, `a ${n}-cell picture face keeps its picture`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the plan still EVICTS a trace, so `glyph: true` is not a constant', () => {
    // WARNING: THIS LEG MOVED, AND SAYING WHY MATTERS. It used to assert that a
    // 28-cell face LOSES its glyph — the eviction #1785 measured on backdraft,
    // which #1845 deliberately removed for pictures. Left as it was it would now
    // fail; mechanically changed to `'picture'` it would assert the OPPOSITE of
    // the shipped rule and pass forever without meaning anything.
    //
    // The property it exists to protect is still real: `laneBodyPlan` must be
    // ABLE to return `glyph: false`, or every assertion above is vacuous.
    // Eviction survives for `'trace'` — an AUDIO face's scope strip — so that is
    // where the control belongs now.
    const heavy = laneBodyPlan(28, 'trace', 'full');
    expect(heavy.layout).toBe('plate');
    expect(heavy.glyph, 'ranked cells still outrank a TRACE — the instrument can say false').toBe(false);
  });

  it('NEGATIVE CONTROL: a face that declares NO glyph gets none, at every tier', () => {
    for (const tier of LANE_TIERS) {
      expect(laneBodyPlan(0, 'none', tier).glyph).toBe(false);
    }
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
