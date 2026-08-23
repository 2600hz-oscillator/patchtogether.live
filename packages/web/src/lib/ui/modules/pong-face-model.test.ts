// packages/web/src/lib/ui/modules/pong-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the PONG faceplate.
//
// Five claims carry this face, and every one is either invisible from the
// declaration or a judgement against the obvious reading:
//
//   1. `glyph: 'none'` is mandatory AND the lane genuinely has NO picture — the
//      opposite of every video face, and an absence a reviewer should be able to
//      confirm rather than infer.
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
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';

const def = pongDef as unknown as FaceDefLike & { type: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_SRC = resolve(HERE, 'pong/PongCourtBody.svelte');
const CARD_SRC = resolve(HERE, 'PongCard.svelte');
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
const cardSrc = stripComments(readFileSync(CARD_SRC, 'utf-8'));

describe('pong face — promoted, and the lane deliberately has NO picture', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('pong')).toBe(true);
  });

  it("declares glyph:none, and has NO video surface — the ABSENCE is the claim", () => {
    // ⚠ THE INVERSE OF EVERY VIDEO FACE IN THIS DIRECTORY. There, `glyph: 'none'`
    // plus a video surface means "the picture arrives from elsewhere". Here there
    // is no surface at all: pong is domain audio and both outputs are `gate`, so
    // `primaryAudioOutPortId` is null and every glyph literal except 'none' would
    // redden the dead-glyph clause. Asserting the absence stops a future reader
    // "fixing" the glyph and stops anyone assuming the lane shows a court.
    expect(pongDef.face?.glyph, 'a gate-output def must declare glyph:none').toBe('none');
    expect(
      hasVideoSurface(def),
      'pong reports a video surface — it is an AUDIO module and the lane tile has no court; ' +
        'if this ever becomes true the face model changed and the roster entry needs re-reading',
    ).toBe(false);
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
  it('applies the DEVICE PIXEL RATIO — the card does NOT, and that is a live defect', () => {
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

  it('NEGATIVE CONTROL: the CARD still shows the unscaled shape this leg denies', () => {
    // ⚠ Proves the predicate can tell the two apart rather than matching anything
    // that mentions a canvas. If the card is ever fixed too, this leg goes red and
    // should be deleted with the defect — not weakened.
    expect(
      /setTransform\(\s*DPR|scale\(\s*DPR/.test(cardSrc),
      'PongCard now applies the DPR — the half-size defect is fixed there too, so this control ' +
        'has no subject left. Delete it along with the note in the body.',
    ).toBe(false);
  });

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
