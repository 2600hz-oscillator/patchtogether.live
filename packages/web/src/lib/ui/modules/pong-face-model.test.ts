// packages/web/src/lib/ui/modules/pong-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the PONG faceplate.
//
// Five claims carry this face, and every one is either invisible from the
// declaration or a judgement against the obvious reading:
//
//   1. the lane picture is fed by a LAYOUT SOURCE, not by a param and not by a
//      video surface — `glyph: 'algorithm'` on a def with no `algorithm` param,
//      which is the one shape a reader will assume is a mistake.
//      ⚠ THIS CLAIM WAS INVERTED UNTIL 2026-08-23 and the inversion is worth
//      keeping visible: it read "`glyph: 'none'` is mandatory AND the lane
//      genuinely has NO picture — an absence a reviewer should be able to
//      confirm". That was TRUE and correctly gated, and it stopped being true
//      the moment #2160 widened the topology branch to carry a layout-source id.
//      The leg was not weakened to survive the change; its SUBJECT moved, and it
//      now pins the presence in both directions (the binding resolves to a live
//      topology kind, and it is NOT the dead `static` the old platform forced).
//   2. `freeze` renders ZERO cells — the inverted assertion that makes the
//      `noUserControl` claim falsifiable in both directions.
//   3. the body does NOT `markWatched`, deliberately, unlike every video body.
//   4. the body applies the DEVICE PIXEL RATIO — the legacy card does not, and
//      that is a live half-size defect this face must not inherit.
//   5. `speed` is rank 1 despite having been the defect this same PR fixes.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pongDef } from '$lib/audio/modules/pong';
import { curatedFace, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { glyphBinding } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';

const def = pongDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_SRC = resolve(HERE, 'pong/PongCourtBody.svelte');
/**
 * Strip comments before grepping for CODE.
 *
 * ⚠ LOAD-BEARING, AND THIS FILE PROVED IT ON ITSELF. The body EXPLAINS in a
 * comment why it does not call \`markWatched\`, and the first version of the leg
 * below grepped raw source — so the explanation read as the call and the gate
 * failed on the very file that got it right. That is the documented "the gate
 * greps source, so it cannot tell code from comment" hazard, caught here by the
 * gate rather than in review.
 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\s+\/\/.*$/, ""))
    .join("\n");
}

const bodySrc = stripComments(readFileSync(BODY_SRC, 'utf-8'));

describe('pong face — promoted, and the lane picture is LAYOUT-FED', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('pong')).toBe(true);
  });

  it("the lane glyph is fed by the EXTENSION as a layout source, with NO param and NO video surface", () => {
    // ⚠ THE ONE DECLARATION A READER WILL ASSUME IS A TYPO. 'algorithm' is the
    // TOPOLOGY/LAYOUT literal, and pong has no param called `algorithm` — the
    // binding falls to the declared extension and names it as the layout source.
    // Pinned as a triple rather than as `glyph !== 'none'`, because the two
    // fields are ONE mechanism: 'algorithm' without an extension falls back to
    // {kind:'static'} and reddens the dead-glyph clause, and an extension
    // without the literal leaves the tile blank. Either half alone is a silent
    // regression to the placeholder tile this face exists to replace.
    expect(pongDef.face?.glyph, "pong's picture is layout-fed, so the literal is 'algorithm'").toBe(
      'algorithm',
    );
    expect(pongDef.face?.extension, 'the layout source IS the extension id').toBe('pong');
    expect(
      pongDef.params?.some((p) => p.id === 'algorithm'),
      'a real `algorithm` param would make this the dx7 captioned case instead — the ' +
        'layout-source branch is only reached when no such param exists',
    ).toBe(false);

    const bound = glyphBinding(pongDef as never);
    expect(bound).toEqual({ kind: 'algorithm', layoutSource: 'pong', paramId: null });

    // ⚠ THE NEGATIVE HALF, AND IT IS THE ONE THAT CATCHES THE REGRESSION. Before
    // #2160 every glyph literal except 'none' resolved to a DEAD {kind:'static'}
    // on this def — a binding the shell paints as a live-looking readout of
    // nothing. Asserting the kind alone would still pass if the resolver started
    // returning static for a different reason, so deny it by name.
    expect(
      bound.kind,
      'the glyph resolved to the DEAD static binding — the lane would paint a fixed trace ' +
        'that looks live and shows nothing, which is exactly what the pre-#2160 platform forced',
    ).not.toBe('static');

    // STILL TRUE, AND STILL WORTH PINNING: the picture is NOT a video surface.
    // pong is domain audio, so there is no VideoTileThumb — the court arrives
    // from the extension's own layout function. This leg keeps the two routes to
    // a lane picture from being confused for one another.
    expect(
      hasVideoSurface(def),
      'pong reports a video surface — it is an AUDIO module whose lane picture comes from its ' +
        'own layout function; if this ever becomes true the face model changed',
    ).toBe(false);
  });

  it('THE TIER LADDER, derived — the court costs serveAngle at compact, and that is the #1785 trade', () => {
    // ⚠ DERIVED THROUGH `curatedFace`, NEVER READ OFF THE CAP CONSTANTS. The
    // spec's own §15.1 flags this as a MUST-VERIFY because four sibling faces
    // got it wrong that way — and the pong spec ITSELF predicted "at compact,
    // SPEED and PADDLE" while the shipped glyph-less tile actually painted all
    // three (cap = LANE_ROW_MAX_CELLS = 3). Measuring rather than reasoning is
    // what caught that, so the measurement is the permanent record.
    //
    // Declaring a glyph moves pong onto the glyph-bearing column
    // (LANE_ROW_MAX_CELLS_WITH_GLYPH = 2), so compact now trades `serveAngle`
    // for the court. That is the #1785 ruling applied — the picture IS the
    // module's identity in a rack and outranks a ranked control — and
    // `serveAngle` is the control the spec calls unreadable in a lane column
    // ("you must watch three serves to evaluate it"). It is NOT lost: plate and
    // dock still carry it, which the ladder below pins in the same breath.
    const ladder = (['mini', 'compact', 'full', 'dock'] as const).map((tier) => [
      tier,
      curatedFace(def, tier)?.controls.map((c) => c.key) ?? [],
    ]);

    expect(ladder).toEqual([
      ['mini', ['speed']],
      ['compact', ['speed', 'paddleH']],
      ['full', ['speed', 'paddleH', 'serveAngle']],
      ['dock', ['speed', 'paddleH', 'serveAngle']],
    ]);

    // The glyph is what caused the compact trade, so assert the cause and not
    // only the effect — otherwise a future change that drops a control for an
    // unrelated reason would keep this green.
    expect(laneGlyphFor(pongDef as never), 'the lane tile must actually carry a picture').toBe(
      'trace',
    );
  });

  it('SPEED is rank 1 — the module is a clock, and rank follows what it IS', () => {
    // ⚠ Pinned precisely because `speed` was INERT MID-RALLY until this PR, so the
    // tempting move was to rank it lower "because it feels dead". Ranking around a
    // defect you are fixing in the same diff bakes the defect into the UI forever.
    expect(pongDef.face?.order?.[0]).toBe('speed');
  });
});

describe('pong face — freeze is UNREACHABLE (the lushgarden defect, avoided)', () => {
  it('declares freeze noUserControl with a writer and a substantive why', () => {
    const entry = (pongDef.noUserControl ?? []).find((d) => d.param === 'freeze');
    expect(
      entry,
      'freeze is not declared noUserControl — it becomes a fourth turnable param, and the Push ' +
        'card would offer "stop the game" under an encoder. That is the defect lushgarden ' +
        'shipped with.',
    ).toBeTruthy();
    expect(entry!.writer).toBe('internal');
    expect(entry!.why.length).toBeGreaterThan(40);
  });

  it('ZERO-CELL INVERSION: freeze is ranked on NO tier', () => {
    // Asserting "the three real ones are ranked" would pass even if freeze were
    // ranked too. This asserts the absence, which is the falsifiable direction.
    for (const tier of ['mini', 'compact', 'full', 'dock'] as const) {
      const face = curatedFace(def, tier);
      expect(face, `curatedFace returned nothing for '${tier}'`).toBeTruthy();
      const ids = (face?.controls ?? []).map((c) => c.paramId);
      expect(ids, `freeze is ranked at tier '${tier}'`).not.toContain('freeze');
    }
  });

  it('POSITIVE CONTROL: the three real controls ARE ranked, so the above is not vacuous', () => {
    const dockFace = curatedFace(def, 'dock');
    const dock = (dockFace?.controls ?? []).map((c) => c.paramId);
    for (const p of ['speed', 'paddleH', 'serveAngle']) {
      expect(dock, `'${p}' is missing from the dock face`).toContain(p);
    }
    expect(dock.length).toBeGreaterThan(0);
  });
});

describe('pong body — the court, at the RIGHT SIZE, and no cargo watch mark', () => {
  it('applies the DEVICE PIXEL RATIO — the defect the legacy card shipped with', () => {
    // ⚠ THE MEASUREMENT THIS LEG EXISTS FOR. `PongDrawOpts` documents `paddleW`
    // and `ballPx` in CSS PIXELS. `PongCard.svelte` passes `canvasEl.width` /
    // `.height` — the BACKING STORE, 2x — and never scales the context, so on the
    // card the ball is 3 CSS px instead of 6, the paddles 2 instead of 4, and the
    // 14 px score font renders at 7. Every def-reading gate is blind to it.
    // The body must not inherit that.
    expect(
      /setTransform\(\s*DPR|scale\(\s*DPR/.test(bodySrc),
      'the body does not apply the device pixel ratio, so drawPong is being handed backing-store ' +
        'dimensions for a function documented in CSS pixels — the court renders at HALF size, ' +
        'which is the defect the legacy card has today',
    ).toBe(true);

    // ANCHOR: if drawPong stops being called here this gate is measuring nothing.
    expect(bodySrc, 'the body no longer draws the court').toContain('drawPong(');
  });

  // ⚠ A NEGATIVE CONTROL STOOD HERE AND ITS SUBJECT IS GONE. It read
  // `PongCard.svelte` and required the card to STILL show the unscaled shape,
  // so that the predicate above was shown to separate the two surfaces rather
  // than matching anything that mentions a canvas. Its own note said what to do
  // when the card stopped carrying the defect: "this leg goes red and should be
  // deleted with the defect — not weakened". The fleet deletion is that, in the
  // strongest form — the defective surface no longer exists to be measured.
  //
  // What the predicate can still be shown to separate is asserted inline above
  // instead: the body must MATCH the DPR shape and must still call `drawPong`,
  // so a regex that stopped matching anything fails the anchor rather than
  // reading as a clean pass.

  it('does NOT markWatched — deliberately, unlike every video body', () => {
    // ⚠ THE CARGO-CULT GUARD. Every other `fullViewBody` in the tree calls
    // `markWatched` because its picture is a video-engine surface pulled only
    // while something watches. Pong is audio: the game is stepped by the shared
    // scheduler clock regardless of what is mounted, and this body only READS a
    // snapshot. A `markWatched` here would be an incantation against a mechanism
    // that does not exist.
    expect(
      bodySrc.includes('markWatched'),
      'the pong body calls markWatched — pong is an audio module with no video surface and no ' +
        'pull set; this was copied from a video body and means nothing here',
    ).toBe(false);
  });

  it('the SCREEN state lives on node.data and writes through the mutate seam', () => {
    expect(bodySrc).toContain('previewCollapsed');
    expect(bodySrc, 'the toggle must sync and be undoable').toContain('mutateNode');
  });
});
