// packages/web/src/lib/ui/modules/dockscope-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the DOCKSCOPE faceplate (cut A, batch 2).
//
// ⚠ THE CENTRAL CLAIM OF THIS FACE IS A REFUSAL, and it is the one thing here
// that MUST be a test rather than a comment. The migration inventory prescribes
// `glyph: 'scope'` for this module — "the trace IS the scope glyph" — and that
// is wrong in a way no existing gate can see: `glyph: 'scope'` COMPILES, passes
// `VALID_GLYPHS`, and paints the STATIC placeholder waveform, because
// `glyphBinding` reaches a live tap only through a primary AUDIO output and
// dockscope declares `outputs: []`. A green gate certifying a dead picture.
//
// So the first describe below asserts the mechanism directly: the binding this
// module WOULD get is `static`, which is why the face declares `glyph: 'none'`
// and routes its trace through a `fullViewBody` instead. If a later change gave
// dockscope an audio output, this test goes red and the glyph decision gets
// re-made deliberately rather than left stale.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { dockscopeDef } from '$lib/audio/modules/dockscope';
import { curatedFace, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { declaredParamCells, momentaryParamIds } from '$lib/ui/workflow/shell-control-kind';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { laneGlyphFor, hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';

const def = dockscopeDef as unknown as FaceDefLike & { type: string };

function param(id: string) {
  const p = dockscopeDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`dockscope has no param '${id}'`);
  return p;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_SRC = resolve(HERE, 'dockscope/DockscopeOutputBody.svelte');
const DRAW_SRC = resolve(HERE, '../../audio/modules/dockscope-draw.ts');

describe('dockscope face — the glyph REFUSAL, asserted at the mechanism', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('dockscope')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it('has NO primary audio output — the premise of the refusal', () => {
    // A terminal visualiser: it observes and never passes through. This is the
    // fact everything below depends on, so it is asserted first and on its own.
    expect(dockscopeDef.outputs).toEqual([]);
    expect(primaryAudioOutPortId(dockscopeDef as Parameters<typeof primaryAudioOutPortId>[0]))
      .toBeNull();
  });

  it("a declared 'scope' glyph WOULD resolve to a dead STATIC binding", () => {
    // ⚠ THE NEGATIVE CONTROL THAT MAKES THE REFUSAL CHECKABLE. Take the real
    // def, give it the glyph the inventory recommends, and ask the real
    // resolver what it produces. `static` is the deterministic placeholder — a
    // picture that is not this module's signal.
    const withScopeGlyph = {
      ...dockscopeDef,
      face: { ...(dockscopeDef.face ?? {}), glyph: 'scope' },
    } as unknown as Parameters<typeof glyphBinding>[0];
    expect(glyphBinding(withScopeGlyph).kind).toBe('static');
  });

  it("so it declares glyph 'none', and paints no lane glyph at all", () => {
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def), 'an audio def gets no video thumb either').toBe(false);
    expect(laneGlyphFor(def as Parameters<typeof laneGlyphFor>[0])).toBe('none');
  });

  it('routes the trace through a fullViewBody instead — the only seam that reaches it', () => {
    expect(def.face?.extension).toBe('dockscope');
    // The body must actually call the engine read key. A body that mounted a
    // canvas and never read `snapshot` would look identical from the outside
    // and paint nothing.
    const body = readFileSync(BODY_SRC, 'utf8');
    expect(body).toMatch(/read\(n, 'snapshot'\)/);
    expect(body).toMatch(/<canvas/);
  });

  it('the body draws through the CARD\'s own pure draw function, not a second plot', () => {
    // Two surfaces re-implementing one trace is how they drift. `drawDockscope`
    // is pure, so both can share it.
    const body = readFileSync(BODY_SRC, 'utf8');
    expect(body).toMatch(/import \{ drawDockscope \}/);
    expect(body).toMatch(/drawDockscope\(/);
  });

  it('the body honours the SAME VRT seed the card does — else the face is unbaselinable', () => {
    // A live analyser window is different pixels every run. Reading a different
    // global here would leave this surface un-pinnable while the card stayed
    // pinned, which is the quiet way a face loses its baseline.
    const body = readFileSync(BODY_SRC, 'utf8');
    expect(body).toMatch(/__dockscopeVrtSeed/);
  });
});

describe('dockscope face — three controls, one band, no invented width', () => {
  it('ranks all three params', () => {
    expect(def.face?.order).toEqual(['timeMs', 'scale', 'range']);
    expect([...(def.face?.order ?? [])].sort()).toEqual(dockscopeDef.params.map((p) => p.id).sort());
  });

  it('the DOCK shows all three, and each lane tier is a PREFIX of the ranking', () => {
    // The lane tiers cap (mini takes one), so the interesting property is not
    // "all three everywhere" but that the ladder never re-orders or skips: what
    // a smaller tile shows is the top of the same list.
    const ranked = ['timeMs', 'scale', 'range'];
    expect(curatedFace(def, 'dock')!.controls.map((c) => c.key)).toEqual(ranked);
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const shown = curatedFace(def, tier)!.controls.map((c) => c.key);
      expect(shown, `lane tier '${tier}' is a prefix of the ranking`)
        .toEqual(ranked.slice(0, shown.length));
      expect(shown.length, `lane tier '${tier}' shows at least the top control`).toBeGreaterThan(0);
    }
  });

  it('declares NO pages — three controls under one display is one band', () => {
    expect(def.face?.pages).toBeUndefined();
    expect(dockFacePlan(def)!).toHaveLength(1);
  });

  it('declares NO paramCells and NO momentary params', () => {
    expect([...declaredParamCells(def).keys()]).toEqual([]);
    expect([...momentaryParamIds(def)]).toEqual([]);
  });

  // ⚠ THE LANE IS NOT EMPTY, which is what separates this face from the
  // joystick refusal in the same batch. dockscope has no glyph, so if it also
  // ranked nothing the lane tile would be blank — the shape `module-face-lint`
  // now denies. It ranks three ordinary scalars, so the lane paints.
  it('the lane tile paints cells even though the module has no glyph', () => {
    for (const tier of ['mini', 'compact', 'full'] as const) {
      expect(curatedFace(def, tier)!.controls.length, `lane tier '${tier}'`).toBeGreaterThan(0);
    }
  });
});

describe('dockscope face — `range` is a NAMED MODE, and it LATCHES', () => {
  it('carries an AUDIO/CV roster rather than reading as pressed/unpressed', () => {
    const p = param('range');
    expect(p.options?.map((o) => o.label)).toEqual(['AUDIO', 'CV']);
    expect(p.options?.map((o) => o.value)).toEqual([0, 1]);
  });

  it('keeps the two-state shape the toggle primitive resolves from', () => {
    const p = param('range');
    expect(p.min).toBe(0);
    expect(p.max).toBe(1);
    expect(p.curve).toBe('discrete');
  });

  // ⚠ THE CLASSIFICATION, ANCHORED TO ITS READ SITE. `module-face-lint` records
  // `dockscope:range` as ACKNOWLEDGED_LATCHING; the justification is that the
  // consumer compares it as a LEVEL every redraw and nothing edge-detects it.
  // Asserted against the source so that adding an edge detector later reddens
  // the classification instead of silently invalidating it.
  it('the READ SITE compares it as a level, with no edge detection anywhere', () => {
    const draw = readFileSync(DRAW_SRC, 'utf8');
    expect(draw, 'the consumer reads `range` as a level each redraw')
      .toMatch(/params\.range\s*>=\s*0\.5/);
    expect(draw, 'no rising-edge machinery in the trace path').not.toMatch(/lastTrig|edgeCount|createEdgeCounter/);
  });

  it('the module declares no gate input that could make it momentary', () => {
    expect(dockscopeDef.inputs.every((p) => p.type !== 'gate')).toBe(true);
  });
});

describe('dockscope face — the SCREEN switch is ABSENT, by derivation', () => {
  // ⚠ COMMENTS STRIPPED FIRST, and the reason is this file's own prose: the
  // body's header EXPLAINS at length why it has no SCREEN switch and no watch
  // mark, so a raw grep for those words matches the explanation and reports the
  // opposite of the truth. The gate greps CODE; it cannot tell code from a
  // comment unless the comments are removed. (The same trap
  // `card-range-source.test.ts` documents from the other direction, where a
  // comment merely spelling a literal out was a real violation.)
  const body = stripSourceComments(readFileSync(BODY_SRC, 'utf8'));

  it('has no SCREEN toggle and no previewCollapsed state', () => {
    // ⚠ NOT AN OVERSIGHT. The fleet standard puts a SCREEN switch on every
    // VIDEO card; this is an audio def, so `video-face-screen-source.test.ts`
    // does not reach it and no exemption entry is owed. The substantive reason
    // is `videoOut`'s, the one module that gate DOES exempt: when the picture
    // IS the module, a switch that collapses it deletes the product instead of
    // reclaiming space beside it. dockscope has no outputs at all.
    expect(body).not.toMatch(/previewCollapsed/);
    expect(body).not.toMatch(/SCREEN/);
  });

  it('and carries no watch mark, because there is no pull set to fall out of', () => {
    // `markWatched` is a VideoEngine concept. This module's AnalyserNode is fed
    // by the Web Audio graph, which runs whether or not anyone is looking.
    // Asserted so that a future copy-paste from a video body does not add a
    // call that would silently do nothing.
    expect(body).not.toMatch(/markWatched/);
    expect(body).not.toMatch(/blitOutputForPreview/);
  });
});
