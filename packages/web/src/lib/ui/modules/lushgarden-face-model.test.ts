// packages/web/src/lib/ui/modules/lushgarden-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the LUSH GARDEN faceplate.
//
// Four claims carry this face, and every one of them is either invisible from
// the declaration or a judgement against the obvious reading — so each is pinned
// here rather than argued in a comment:
//
//   1. `glyph: 'none'` is MANDATORY on a video def, and `'none' + blank tile` is
//      indistinguishable from `'none' + live picture` FROM THE DECLARATION. Only
//      `hasVideoSurface` tells them apart, so it is asserted directly.
//   2. the three synthetic params are `noUserControl` — the P1 this PR fixes —
//      and the assertion is a ZERO-cell inversion: they must be ranked NOWHERE
//      and render NO interactive cell.
//   3. SCREEN OFF keeps the WATCH MARK. On this module that is a correctness
//      requirement rather than a nicety, for two independent reasons (below).
//   4. the body is 2D — an ATTEST constraint, not a style choice.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lushgardenDef } from '$lib/video/modules/lushgarden';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';

const def = lushgardenDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_SRC = resolve(HERE, 'lushgarden/LushGardenScreenBody.svelte');
const bodySrc = readFileSync(BODY_SRC, 'utf-8');

/** The synthetic params — the three this PR makes unreachable. */
const SYNTHETIC = ['cv_grow', 'cv_reset', 'freeze'] as const;

describe('lushgarden face — promoted, and its tile GAINS a picture', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('lushgarden')).toBe(true);
  });

  it('declares glyph:none AND has a video surface — the two are NOT the same claim', () => {
    // ⚠ THE POINT OF THIS ROW. A video def MUST declare `glyph: 'none'`, because
    // `primaryAudioOutPortId` finds no audio output and any other literal falls
    // through to a dead `{kind:'static'}`. But `'none'` alone would ALSO be what
    // a module with no picture declares — the declaration cannot tell you which
    // you have. `hasVideoSurface` is the thing that can.
    expect(lushgardenDef.face?.glyph, 'a video def must declare glyph:none').toBe('none');
    expect(
      hasVideoSurface(def),
      'the face declares glyph:none but has NO video surface — the tile would be a blank plate, ' +
        'which is exactly what glyph:none looks like when it is wrong',
    ).toBe(true);
    expect(
      laneGlyphFor(def),
      'the lane must resolve a PICTURE — a picture outranks ranked controls (#1785), and that is ' +
        'the whole gain of promoting this module, whose tile is a blank placeholder today',
    ).toBe('picture');
  });
});

describe('lushgarden face — the three synthetic params are UNREACHABLE (the P1)', () => {
  it('declares noUserControl for all three, each with a writer and a why', () => {
    const declared = lushgardenDef.noUserControl ?? [];
    const byParam = new Map(declared.map((d) => [d.param, d]));
    for (const p of SYNTHETIC) {
      const entry = byParam.get(p);
      expect(entry, `'${p}' is not declared noUserControl — Push 2's generic tier and the group ` +
        'bar both synthesise a knob for any param that is not excluded, and turning this one ' +
        'is not recoverable without respawning the node').toBeTruthy();
      expect(entry!.writer, `'${p}' declares no writer`).toBeTruthy();
      expect(
        entry!.why.length,
        `'${p}' must say WHAT writes it and what turning it would do, not merely that it is hidden`,
      ).toBeGreaterThan(40);
    }
  });

  it('ZERO-CELL INVERSION: none of the three is ranked, on any tier', () => {
    // The inversion matters: asserting "the four real ones are ranked" would pass
    // even if the synthetic three were ALSO ranked. This asserts the absence.
    // ⚠ EVERY tier, including the ones a reader would not think to check. The
    // FaceTier union is mini | compact | full | dock — there is no 'plate', and
    // reaching for one is the mistake four earlier faces made by reading tier
    // names off the cap constants instead of off the type.
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      const face = curatedFace(def, tier);
      expect(face, `curatedFace returned nothing for tier '${tier}'`).toBeTruthy();
      const ids = (face?.controls ?? []).map((c) => c.paramId);
      for (const p of SYNTHETIC) {
        expect(
          ids,
          `'${p}' is ranked at tier '${tier}' — a synthetic gate/determinism param has no ` +
            'business being turnable on any surface',
        ).not.toContain(p);
      }
    }
  });

  it('POSITIVE CONTROL: the four REAL controls ARE ranked, so the check above is not vacuous', () => {
    // Without this, a `curatedFace` that returned nothing would satisfy every
    // assertion in the previous row.
    const dockFace = curatedFace(def, 'dock');
    expect(dockFace, 'curatedFace returned nothing for the dock tier').toBeTruthy();
    const dock = (dockFace?.controls ?? []).map((c) => c.paramId);
    for (const p of ['rate', 'view', 'horizon', 'fov']) {
      expect(dock, `'${p}' is missing from the dock face`).toContain(p);
    }
    expect(dock.length, 'the dock face is empty — the zero-cell check above proves nothing')
      .toBeGreaterThan(0);
  });

  it('RATE is rank 1 — the only control over the GENERATOR', () => {
    // Pinned because it is the rank most likely to be "tidied" toward a camera
    // control by someone reading the face as a viewport.
    expect(lushgardenDef.face?.order?.[0], 'rate must lead: every other param is a camera over a ' +
      'scene that already exists, and this module\'s output ACCUMULATES').toBe('rate');
  });
});

describe('lushgarden body — SCREEN OFF must not stop the garden growing', () => {
  it('the collapsed branch still marks the node watched', () => {
    // ⚠ TWO INDEPENDENT REASONS, and neither is the generic "the preview would
    // stall" — which is why this is a permanent leg rather than a shared comment.
    //
    //   1. PURE SOURCE. No input requirement, so a lapsed mark mutes the ORIGIN
    //      of the chain, not a preview.
    //   2. ACCUMULATION. The picture is a running integration over the node's
    //      lifetime. If collapsing stopped surface.draw, re-opening SCREEN would
    //      show a garden YOUNGER THAN THE RACK.
    const collapsed = bodySrc.slice(bodySrc.indexOf('if (previewCollapsed)'));
    const branch = collapsed.slice(0, collapsed.indexOf('}'));
    expect(
      branch,
      'the SCREEN-OFF branch does not call markWatched — the node drops out of the pull set, the ' +
        'garden STOPS ACCUMULATING, and re-opening SCREEN shows a garden younger than the rack',
    ).toContain('markWatched');
  });

  it('the body is 2D ONLY — an ATTEST constraint, not a style choice', () => {
    // `lushgarden.ts` and `lushgarden-scene.ts` are both in the WebGL attest
    // basis; the CARD is correctly outside it because it uses a 2D context. A GL
    // context here would pull this file in through the whole-directory sweep and
    // make every future edit cost a real GPU re-attest.
    expect(
      /getContext\(\s*['"]webgl/i.test(bodySrc),
      'the body creates a WebGL context — it would enter the WebGL attest basis and every future ' +
        'edit to it would cost a GPU re-attest. Blit the engine canvas through a 2D context.',
    ).toBe(false);
    expect(bodySrc, 'the body should blit the engine surface, not render its own')
      .toContain('blitOutputForPreview');
  });

  it('the SCREEN state lives on node.data, never in component state', () => {
    // The component unmounts on dock collapse / LRU eviction (#1531 / #1574 /
    // #1583), so component `$state` would lose the toggle on every collapse.
    expect(bodySrc, 'previewCollapsed must be read from the node').toContain('previewCollapsed');
    expect(bodySrc, 'the toggle must write through the graph mutate seam so it syncs and undoes')
      .toContain('mutateNode');
  });
});
