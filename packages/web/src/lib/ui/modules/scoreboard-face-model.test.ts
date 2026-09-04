// packages/web/src/lib/ui/modules/scoreboard-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the SCOREBOARD faceplate (#2089).
//
// This is the THINNEST face in the video fleet — one ranked control — which
// makes the interesting claims structural rather than about ranking: that its
// one control gets the right PRIMITIVE, that its two synthetic gate params get
// none, and that its renderer is deterministic BY CONSTRUCTION rather than by a
// pin (the property its VRT scenes rest on).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import { scoreboardDef, SCOREBOARD_DEFAULT_HUE } from '$lib/video/modules/scoreboard';
import { curatedFace, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { paramCellKind, declaredParamCells, momentaryParamIds } from '$lib/ui/workflow/shell-control-kind';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';

const def = scoreboardDef as unknown as FaceDefLike & { type: string };

/** The LIVE `ParamDef` — `FaceDefLike` narrows params to `FaceParamLike`, so
 *  min/max/curve are unreachable through `def.params`. (svelte-check catches
 *  this where vitest does not.) */
function param(id: string) {
  const p = scoreboardDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`scoreboard has no param '${id}'`);
  return p;
}

const MODULE_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../video/modules/scoreboard.ts',
);
const DRAW_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../video/modules/scoreboard-draw.ts',
);

describe('scoreboard face — promoted, and the tile shows the module', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('scoreboard')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' AND still has a live picture", () => {
    // A video def MUST declare 'none', which makes 'none + blank tile' and
    // 'none + live thumb' indistinguishable from the declaration — so assert
    // the seam that actually paints. On a module whose whole product is a
    // number on a screen, a blank tile is the module missing from the lane.
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def)).toBe(true);
  });

  it('owns a fullViewBody extension — the card is its only other view', () => {
    expect(def.face?.extension).toBe('scoreboard');
  });
});

describe('scoreboard face — ONE ranked control, and no page for it', () => {
  it('ranks exactly `color`', () => {
    expect(def.face?.order).toEqual(['color']);
  });

  it('every tier shows that one control — there is no ladder to measure', () => {
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      expect(curatedFace(def, tier)!.controls.map((c) => c.key), tier).toEqual(['color']);
    }
  });

  it('declares NO pages — the dock renders one unlabelled band', () => {
    // A page earns a header at >=2 controls, or at 1 that is the module's
    // identity. COLOUR is not this module's identity; the COUNTER is. So a page
    // here would buy an ~81px header to write "colour" above a colour wheel.
    expect(def.face?.pages).toBeUndefined();
    const plan = dockFacePlan(def)!;
    expect(plan).toHaveLength(1);
    expect(plan[0]!.label, 'the single band is unlabelled').toBe('');
    expect(plan[0]!.controls.map((c) => c.key)).toEqual(['color']);
  });
});

describe('scoreboard — the one control is a HUE, not a knob', () => {
  it('resolves to the hue wheel at the dock', () => {
    expect(declaredParamCells(def).get('color')).toBe('hue');
    expect(paramCellKind(param('color'), momentaryParamIds(def), 'dock', declaredParamCells(def)))
      .toBe('hue');
  });

  it('⚠ the param has the shape the wheel REQUIRES — continuous, exactly one turn', () => {
    // `module-face-lint`'s hue clause is `curve !== 'discrete' && min === 0 &&
    // max === 1`, because the wheel maps the full ring onto the declared span:
    // any other range makes one revolution write values the module never asked
    // for, and no def-reading gate could see that.
    const p = param('color');
    expect(p.curve).not.toBe('discrete');
    expect([p.min, p.max]).toEqual([0, 1]);
  });

  it('⚠ it WRAPS — which is the whole argument against a dial', () => {
    // The fact that makes a knob wrong rather than merely plain: the hue is an
    // angle, so the ends of the range are the SAME COLOUR. A linear dial puts
    // its end stops in the middle of a continuous space, and a player dragging
    // from 0.99 to 0.01 travels the long way round through every other hue.
    // Asserted against the module's own mapping (0..1 -> 0..360 degrees).
    const p = param('color');
    const deg = (v: number) => (v * 360) % 360;
    expect(deg(p.min)).toBe(deg(p.max));
    // …and the default really is the green the module is named for.
    expect(SCOREBOARD_DEFAULT_HUE).toBeCloseTo(1 / 3, 10);
    expect(deg(SCOREBOARD_DEFAULT_HUE)).toBeCloseTo(120, 6);
  });

  it('⚠ NEGATIVE CONTROL: the resolver would NOT say hue without the declaration', () => {
    // Without this, the first assertion passes on a resolver that returns 'hue'
    // for everything — and the whole point is that NOTHING in a ParamDef can
    // imply this primitive, which is why it must be declared at all.
    const undeclared = { ...def, face: { ...def.face!, paramCells: undefined } } as FaceDefLike;
    expect(paramCellKind(param('color'), momentaryParamIds(undeclared), 'dock', declaredParamCells(undeclared)))
      .toBe('knob');
  });
});

describe('scoreboard — both gate params are CV-written and get no cell', () => {
  it('declares exactly the two synthetic trigs, both cv-port', () => {
    const decl = (scoreboardDef as { noUserControl?: readonly { param: string; writer: string }[] })
      .noUserControl ?? [];
    expect(decl.map((d) => d.param).sort()).toEqual(['resetTrig', 'scoreTrig']);
    for (const d of decl) expect(d.writer, d.param).toBe('cv-port');
  });

  it('⚠ the cv-port claim is CHECKABLE — a port targets EACH of them', () => {
    const targets = (scoreboardDef.inputs ?? []).map(
      (p) => (p as { paramTarget?: string }).paramTarget,
    );
    expect(targets.sort()).toEqual(['resetTrig', 'scoreTrig']);
  });

  it('neither renders a dock cell, and `color` renders exactly one', () => {
    const keys = dockFacePlan(def)!.flatMap((b) => b.controls.map((c) => c.key));
    expect(keys).toEqual(['color']);
    expect(keys).not.toContain('scoreTrig');
    expect(keys).not.toContain('resetTrig');
  });
});

describe('scoreboard — deterministic BY CONSTRUCTION, which is what its scenes rest on', () => {
  const moduleSrc = () => readFileSync(MODULE_SRC, 'utf8');
  const drawSrc = () => readFileSync(DRAW_SRC, 'utf8');

  it('⚠ the renderer has NO time term, NO RNG, NO accumulator', () => {
    // This is the claim the FACES entry makes instead of installing a freeze:
    // the picture is a pure function of (score, hue). If any of these ever
    // appears, the scenes are no longer stable for the stated reason and the
    // roster entry's argument has to be re-made — which is exactly what this
    // leg is for.
    for (const [name, src] of [['scoreboard.ts', moduleSrc()], ['scoreboard-draw.ts', drawSrc()]] as const) {
      expect(/\bframe\.time\b/.test(src), `${name}: frame.time`).toBe(false);
      expect(/\bperformance\.now\b/.test(src), `${name}: performance.now`).toBe(false);
      expect(/\bDate\.now\b/.test(src), `${name}: Date.now`).toBe(false);
      expect(/\bMath\.random\b/.test(src), `${name}: Math.random`).toBe(false);
    }
  });

  it('⚠ NEGATIVE CONTROL: the probe reads the real files and can find things in them', () => {
    // Four absences prove nothing if the probe is reading empty strings. Pin
    // that it is reading THESE modules, by finding something only they contain.
    const m = moduleSrc();
    const d = drawSrc();
    expect(m.length, 'the probe read an empty/missing scoreboard.ts').toBeGreaterThan(2000);
    expect(d.length, 'the probe read an empty/missing scoreboard-draw.ts').toBeGreaterThan(1000);
    expect(m).toContain('__scoreboardVrtSeed');
    expect(d).toContain('SCOREBOARD_WRAP_AT');
  });

  it('the VRT seed hook is read at CONSTRUCTION — which is what makes simPin work', () => {
    // simPin installs a page global via addInitScript BEFORE goto, so it is
    // only useful to a factory that reads it while constructing. Assert the
    // read is in the factory body rather than, say, inside draw().
    const m = moduleSrc();
    expect(/factory\([\s\S]*__scoreboardVrtSeed/.test(m)).toBe(true);
    // …and that it is a no-op when unset, so production still starts at 0.
    expect(/typeof seed === 'number'/.test(m)).toBe(true);
  });

  it('⚠ and the module is MAIN-THREAD, which is why a page global reaches it', () => {
    // The inverse of acidwarp: there, `renderLocus: 'worker'` puts simPin out
    // of reach entirely because a Worker has its own global scope. scoreboard
    // declares no renderLocus AND is excluded from worker eligibility for this
    // very reason, so the seed lands.
    expect(/renderLocus/.test(moduleSrc()), 'scoreboard must stay main-thread').toBe(false);
  });
});

describe('scoreboard — the body, and the non-finding worth recording', () => {
  /**
   * ⚠ COMMENT-STRIPPED **AND WHITESPACE-COLLAPSED**, which together are the fix
   * rather than a wider regex window.
   *
   * The ordering claim below is about CODE — does the collapsed branch take the
   * watch mark before it returns — and this body carries a long explanatory
   * comment between the two. MEASURED: 901 characters separate them in the raw
   * source, and ⚠ `stripSourceComments` does NOT close that gap, because it
   * replaces comments with SPACES to preserve line/column offsets. Stripping
   * alone therefore buys nothing here, which is worth recording: the obvious
   * fix looks right and does not work.
   *
   * Collapsing runs of whitespace afterwards is what makes the window mean
   * something real — "no other STATEMENT intervenes" — instead of "the author
   * did not write much prose". With both applied the two are ~45 characters
   * apart, so the tight window below is a genuine adjacency check rather than a
   * number tuned until it passed.
   */
  const bodySrc = () =>
    stripSourceComments(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), 'scoreboard/ScoreboardScreenBody.svelte'),
        'utf8',
      ),
    ).replace(/\s+/g, ' ');

  it('⚠ the SURFACE paints no resting derived text, so the face deletes nothing', () => {
    // Unlike the other faces in this wave there was nothing to remove. Pinned
    // as a fact rather than left implicit, so a future reader does not go
    // hunting for a readout that was never there — and so that ADDING one is
    // visible here.
    //
    // ⚠ THE SUBJECT WAS THE CARD, which was the surface that would have carried
    // such a readout at the time. The body is the surface now, and the same
    // three denials are made of it: no buttons, no selects, no readout element.
    const body = bodySrc();
    expect(body.length).toBeGreaterThan(500);
    expect(/<button/.test(body), 'the body has no buttons').toBe(false);
    expect(/<select/.test(body), 'the body has no selects').toBe(false);
    expect(/class="[^"]*readout/.test(body), 'the body paints no readout element').toBe(false);
  });

  it('the collapsed branch marks the node watched BEFORE it returns', () => {
    // #1937 / #2015, and load-bearing on STATE here rather than only on the
    // picture: the counter advances on gate edges the factory detects during
    // draw, so a lapsed watch mark leaves SCORE edges uncounted and the number
    // WRONG when the screen returns — not merely stale.
    const src = bodySrc();
    expect(src).toContain('markWatched');
    expect(
      /if\s*\(previewCollapsed\)\s*\{[\s\S]{0,200}markWatched/.test(src),
      'SCREEN OFF must keep the watch mark or the counter silently stops counting',
    ).toBe(true);
  });

  it('⚠ NEGATIVE CONTROL: the ordering pattern can fail, and the window is not vacuous', () => {
    const src = bodySrc();
    expect(src).toContain('scoreboard-face-screen-toggle');

    // (a) Remove the mark from the collapsed branch and the pattern must stop
    //     matching — otherwise the leg above would pass on a body that dropped
    //     it. ⚠ Operates on the COLLAPSED string, so no newline anchors: after
    //     `.replace(/\s+/g, ' ')` there are none, and a sabotage written against
    //     the raw shape would silently replace NOTHING and "pass".
    const sabotaged = src.replace(
      /(if \(previewCollapsed\) \{ )[\s\S]{0,200}?markWatched\(nodeId\);/,
      '$1',
    );
    expect(sabotaged, 'the sabotage must actually change the source').not.toBe(src);
    expect(/if \(previewCollapsed\) \{[\s\S]{0,200}markWatched/.test(sabotaged)).toBe(false);

    // (b) The window is a genuine ADJACENCY check, not a number large enough to
    //     span anything. Measure the real distance and assert it is well inside
    //     — if a future edit puts a statement between them, this fails HERE with
    //     the distance printed, rather than the leg above passing on a body that
    //     marks the node watched several statements late.
    const i = src.indexOf('if (previewCollapsed) {');
    const j = src.indexOf('markWatched', i);
    expect(i, 'the collapsed branch is present').toBeGreaterThan(-1);
    expect(j - i, 'chars between the branch and the mark, whitespace-collapsed').toBeLessThan(120);
  });
});
