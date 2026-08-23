// packages/web/src/lib/ui/modules/spectrograph-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the SPECTROGRAPH faceplate (cut B).
//
// Two claims carry this face and both are judgements against the obvious
// reading, so both are pinned here rather than argued in a comment:
//
//   1. its screen is a BODY, not the registered PANEL the cut prescribes —
//      and the reason is that the picture is unreachable without a per-frame
//      engine read;
//   2. `view` is a NEW param that exists to PRESERVE an affordance, and it is
//      display-only — so it must be provably invisible downstream.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { spectrographDef } from '$lib/audio/modules/spectrograph';
import { curatedFace, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { declaredParamCells, momentaryParamIds } from '$lib/ui/workflow/shell-control-kind';
import { glyphBinding } from '$lib/ui/workflow/shell-glyph-live';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';

const def = spectrographDef as unknown as FaceDefLike & { type: string };

function param(id: string) {
  const p = spectrographDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`spectrograph has no param '${id}'`);
  return p;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = resolve(HERE, '../../audio/modules/spectrograph.ts');
const CARD_SRC = resolve(HERE, 'SpectrographCard.svelte');
const BODY_SRC = resolve(HERE, 'spectrograph/SpectrographOutputBody.svelte');

describe('spectrograph face — promoted, and its tile paints NO picture', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('spectrograph')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  // ⚠ THE DOUBLE FORCING OF `glyph: 'none'`, which is what makes this module
  // unlike every other face whose module emits video.
  it("declares glyph 'none', and BOTH glyph routes are genuinely unavailable", () => {
    expect(def.face?.glyph).toBe('none');

    // (a) no LIVE glyph — `glyphBinding` needs a primary AUDIO output and both
    // of this module's outputs are `mono-video`. Asserted through the real
    // resolver on a copy that DOES declare a glyph, so this is the mechanism
    // and not a restatement of the declaration.
    const withGlyph = {
      ...spectrographDef,
      face: { ...(spectrographDef.face ?? {}), glyph: 'spectrum' },
    } as unknown as Parameters<typeof glyphBinding>[0];
    expect(glyphBinding(withGlyph).kind).toBe('static');
    expect(spectrographDef.outputs.every((o) => o.type !== 'audio')).toBe(true);

    // (b) no PICTURE glyph either — `hasVideoSurface` is domain-only, and this
    // def is `audio` despite emitting video.
    expect(spectrographDef.domain).toBe('audio');
    expect(hasVideoSurface(def)).toBe(false);
    expect(laneGlyphFor(def as Parameters<typeof laneGlyphFor>[0])).toBe('none');
  });

  // …so the lane MUST carry cells, or the tile would be blank — the shape
  // `module-face-lint`'s empty-lane clause denies.
  it('the lane tile still paints, because the face ranks two real controls', () => {
    for (const tier of ['mini', 'compact', 'full'] as const) {
      expect(curatedFace(def, tier)!.controls.length, `lane tier '${tier}'`).toBeGreaterThan(0);
    }
  });

  it('owns a fullViewBody extension — after promotion it is the ONLY picture', () => {
    expect(def.face?.extension).toBe('spectrograph');
  });
});

describe('spectrograph face — the screen is a BODY, and could not be a panel', () => {
  const body = stripSourceComments(readFileSync(BODY_SRC, 'utf8'));

  it('the body reaches the picture through drawFrame — a per-frame ENGINE READ', () => {
    // This is the panel-vs-body discriminator, asserted rather than argued: a
    // panel renders from params/node.data, and no amount of either produces
    // this picture.
    expect(body).toMatch(/getVideoSource/);
    expect(body).toMatch(/drawFrame\(/);
    expect(body).toMatch(/<canvas/);
  });

  it('the body OWNS NO accumulator — the scroll buffer stays in the module', () => {
    // ⚠ The load-bearing claim. A second buffer here would advance at its own
    // rate and the two surfaces would show different moments of one signal.
    expect(body).not.toMatch(/Float32Array/);
    expect(body).not.toMatch(/writeSpectrumColumn|renderSpectrographInto/);
    // …and the module is where it really lives.
    const mod = readFileSync(MODULE_SRC, 'utf8');
    expect(mod).toMatch(/const specBuf = new Float32Array/);
  });

  it('the body mirrors NO determinism seed — the freeze is read in the MODULE', () => {
    // The opposite of dockscope, whose seed lived in its card and had to be
    // duplicated into the body or the face would have been unbaselinable.
    expect(body).not.toMatch(/__spectrographVrtFreeze/);
    const mod = readFileSync(MODULE_SRC, 'utf8');
    expect(mod).toMatch(/__spectrographVrtFreeze/);
  });

  it('carries no SCREEN switch and no watch mark — neither applies to an audio def', () => {
    expect(body).not.toMatch(/previewCollapsed/);
    expect(body).not.toMatch(/markWatched|blitOutputForPreview/);
  });
});

describe('spectrograph face — `view` PRESERVES an affordance, and is display-only', () => {
  it('ranks both params, gain first', () => {
    expect(def.face?.order).toEqual(['gain', 'view']);
    expect([...(def.face?.order ?? [])].sort())
      .toEqual(spectrographDef.params.map((p) => p.id).sort());
  });

  it('declares no pages, no paramCells and no momentary params', () => {
    expect(def.face?.pages).toBeUndefined();
    expect(dockFacePlan(def)!).toHaveLength(1);
    expect([...declaredParamCells(def).keys()]).toEqual([]);
    expect([...momentaryParamIds(def)]).toEqual([]);
  });

  it('`view` is a NAMED two-state mode, not an unlabelled enable', () => {
    const p = param('view');
    expect(p.min).toBe(0);
    expect(p.max).toBe(1);
    expect(p.curve).toBe('discrete');
    expect(p.options?.map((o) => o.label)).toEqual(['COLOR', 'B/W']);
    expect(p.options?.map((o) => o.value)).toEqual([0, 1]);
  });

  // ⚠ THE CLAIM THAT MAKES ADDING A PARAM SAFE. If `view` were observable
  // downstream, promoting card state to the contract would have changed what
  // patched consumers receive. It is not: both ports render both colormaps
  // continuously and `view` only selects which one a PREVIEW pulls.
  it('is DISPLAY-ONLY — no port targets it and both outputs render regardless', () => {
    expect(
      spectrographDef.inputs.some((i) => i.paramTarget === 'view'),
      'no CV input targets `view`, so nothing in a patch can drive it',
    ).toBe(false);
    expect(spectrographDef.outputs.map((o) => o.id).sort()).toEqual(['bw', 'color']);
    // The module renders both colormaps unconditionally — the value is read by
    // neither the factory nor the draw core, only by the two SURFACES.
    const mod = stripSourceComments(readFileSync(MODULE_SRC, 'utf8'));
    expect(mod).not.toMatch(/params\.view|\.view\b/);
  });

  it('the CARD reads the same param — the switch is named from ONE place', () => {
    // Parity: the legacy card must not keep a private copy of this state, or
    // the two surfaces would disagree about which colormap is previewed.
    const card = stripSourceComments(readFileSync(CARD_SRC, 'utf8'));
    expect(card).toMatch(/params\.view/);
    expect(card, 'the old component-state spelling is gone').not.toMatch(/\$state\(false\)/);
  });
});
