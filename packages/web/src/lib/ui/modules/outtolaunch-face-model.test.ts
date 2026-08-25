// packages/web/src/lib/ui/modules/outtolaunch-face-model.test.ts
//
// OUT TO LAUNCH's face, pinned where no pixel gate can see it — plus the
// permanent negative controls for the two claims this promotion rests on that
// are true by MECHANISM rather than by inspection.
//
// The two claims:
//
//   1. `glyph: 'none'` is FORCED, and the tile's picture arrives from a
//      different seam entirely. A declaration cannot tell you which of "no
//      glyph, blank tile" and "no glyph, live thumbnail" you have — only
//      `hasVideoSurface` can, so it is asserted rather than assumed.
//   2. This def is the ONE video module in the fleet with a texture-less
//      surface. That is what made `VideoTileThumb` paint another node's frame,
//      and it is what the guard there keys on — so if a second such module ever
//      lands, whoever adds it meets this test rather than the bug.

import { describe, expect, it } from 'vitest';
// ⚠ THE BARREL IMPORT IS LOAD-BEARING, and its absence FAILS OPEN. The video
// registry is populated by importing the barrel; without this line
// `listVideoModuleDefs()` returns an EMPTY array, and a derived sweep over an
// empty population passes every "no offenders" shape silently. `vrt-meta.test
// .ts` records the same trap — it held for a full-file run and broke under a
// `-t` filter. Here it went RED instead, only because the assertion is
// `toContain` (a membership claim) rather than a `toEqual([])`.
import '$lib/video/modules';
import { outToLaunchDef } from '$lib/video/modules/out-to-launch';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import {
  hasVideoSurface,
  laneGlyphFor,
  dockFullViewHeadPlan,
} from '$lib/ui/workflow/module-shell-model';

describe('outToLaunch face — the ladder', () => {
  it('is PROMOTED, so the dock swap and the lane swap both fire', () => {
    expect(STRICT_FACES.has('outToLaunch')).toBe(true);
    expect(migrated('outToLaunch'), 'an authored face that is not promoted is INERT').toBe(true);
  });

  it('ranks CONNECT first, then BRIGHT, then GAMMA', () => {
    // The ladder the def's comment reads back as a sentence. CONNECT outranks
    // both knobs because the module drives no hardware at all until something is
    // bound, and BRIGHT outranks GAMMA because it is the control a player
    // reaches for when the panel is physically too bright to look at.
    expect(outToLaunchDef.face?.order).toEqual(['out-to-launch-connect-{n}', 'bright', 'gamma']);
  });

  it('declares ONE family, and it is the one `face.order` ranks', () => {
    // module-face-lint requires every declared family to be ranked AND rendered
    // exactly once, so a family is a promise to rank rather than a vocabulary
    // list. Pinned here because the def comment argues from it.
    const ids = (outToLaunchDef.controlFamilies ?? []).map((f) => f.id);
    expect(ids).toEqual(['out-to-launch-connect']);
    expect(
      outToLaunchDef.face?.order?.includes(`${ids[0]}-{n}`),
      'the declared family is ranked',
    ).toBe(true);
  });

  it('declares NO pages — three cells, one idea', () => {
    expect(outToLaunchDef.face?.pages).toBeUndefined();
  });

  it('owns a fullViewBody extension, which CLAIMS the dock head from the generic glyph', () => {
    expect(outToLaunchDef.face?.extension).toBe('outToLaunch');
    const plan = dockFullViewHeadPlan({
      view: 'dock-full',
      hasGlyph: true,
      heroCell: false,
      hasExtensionBody: true,
    });
    expect(plan.extBody, 'the module surface paints at the dock').toBe(true);
    expect(plan.heroGlyph, 'and the generic thumbnail yields to it there').toBe(false);
  });
});

describe('outToLaunch face — the two mechanism claims', () => {
  it('`glyph: none` is FORCED by an empty `outputs`, and the picture comes from elsewhere', () => {
    // ⚠ THE DECLARATION CANNOT MAKE THIS LEG. `primaryAudioOutPortId` matches
    // `type === 'audio'` and this def has NO outputs at all, so every other
    // glyph literal resolves to `{kind:'static'}`, which module-face-lint
    // reddens by name. `'none' + blank tile` and `'none' + live picture` are
    // indistinguishable from the def — `hasVideoSurface` is the only thing that
    // separates them, so it is asserted.
    expect(outToLaunchDef.face?.glyph).toBe('none');
    expect(outToLaunchDef.outputs, 'the premise: there is no audio out to bind a glyph to').toEqual([]);
    expect(hasVideoSurface(outToLaunchDef as never), 'the tile surface').toBe(true);
    expect(laneGlyphFor(outToLaunchDef as never), 'a PICTURE, which outranks ranked cells').toBe('picture');
  });

  it('it is the ONLY video def whose surface has no output texture — the thumbnail guard depends on that', () => {
    // ⚠ THE REGRESSION PIN FOR A LIVE DEFECT. `VideoTileThumb` blits a node's
    // texture into the engine's SHARED drawing buffer and then snapshots that
    // buffer; on a node with no texture the blit does nothing and the snapshot
    // showed whichever node blitted last (measured: byte-identical to a
    // `videoOut` tile, mean 710.891875 / max 765, with nothing patched in).
    //
    // The guard in `VideoTileThumb.svelte` is unconditional, so a second
    // texture-less video def would be handled correctly — but it would also be
    // the second module whose lane picture is a dark well, which is a DESIGN
    // question rather than a bug. This assertion is where that conversation
    // starts.
    //
    // ⚠ DERIVED MEMBERSHIP, BOTH DIRECTIONS — not a count, and not a ceiling.
    // The set is read off the live registry and asserted exactly, so it reddens
    // if a new video SINK lands (whoever adds it has to decide what its lane
    // tile paints) AND if this module ever grows an output port (at which point
    // the thumbnail guard stops being load-bearing for it and the reasoning
    // above needs re-reading). A `toContain` would only have caught the second.
    const sinks = listVideoModuleDefs()
      .filter((d) => d.outputs.length === 0)
      .map((d) => d.type)
      .sort();
    expect(
      sinks,
      'video defs declaring NO outputs. A new one here needs its lane picture thought about: ' +
        'is it a texture-less sink like outToLaunch — whose thumbnail must paint its own dark ' +
        'well rather than the shared drawing buffer — or does it render an output texture it ' +
        'simply does not publish as a port?',
    ).toEqual(['outToLaunch']);
  });
});
