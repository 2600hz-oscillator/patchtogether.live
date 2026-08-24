// packages/web/src/lib/ui/modules/pong/pong-glyph-model.test.ts
//
// The pure-layout half of pong's lane glyph. `PongCourtGlyph.svelte` is a thin
// renderer with no arithmetic of its own, so every way the court picture can be
// WRONG is reachable from here — the same split `dx7-glyph-model` and
// `Dx7AlgorithmGlyph` use.
//
// What these legs are actually protecting, since "a rect is at an x" is not
// self-evidently worth a test:
//
//   1. the picture is TOTAL — no state, however out of range, paints outside the
//      viewBox, because a glyph that overflows its plate corrupts the tile
//      layout rather than merely looking wrong;
//   2. the paddle-height LAW is `drawPong`'s (a fraction of court height), not a
//      second copy of it that can drift from the game;
//   3. the picture MOVES with the state it is given — the negative control that
//      stops a future "simplification" to a hardcoded court from passing.

import { describe, expect, it } from 'vitest';
import { initPongState } from '$lib/audio/modules/pong-state';
import {
  PONG_GLYPH_BALL,
  PONG_GLYPH_VIEW_H,
  PONG_GLYPH_VIEW_W,
  pongGlyphGeometry,
  type PongGlyphState,
} from './pong-glyph-model';

const REST: PongGlyphState = { ballX: 0.5, ballY: 0.5, paddleLY: 0.5, paddleRY: 0.5 };

describe('pong glyph model — the court, as pure layout', () => {
  it('draws the module\'s OWN rest frame, not numbers typed in here', () => {
    // ⚠ THE PROVENANCE LEG. The component feeds this model `initPongState`, so
    // the glyph is pong's real rest state rather than a court someone drew from
    // memory. If the game's opening frame ever changes, the picture follows —
    // and if someone replaces the call with literals, this leg is what notices.
    const rest = initPongState(
      { speed: 1, paddleH: 0.2, serveAngle: 0.3 },
      { rng: () => 0.5 },
    );
    expect(
      { ballX: rest.ballX, ballY: rest.ballY, paddleLY: rest.paddleLY, paddleRY: rest.paddleRY },
      'pong\'s rest frame is centre-ball, centre-paddles — the glyph inherits it',
    ).toEqual(REST);

    const geom = pongGlyphGeometry(rest, 0.2);
    // Centred ball: its top-left is half a ball short of the centre.
    expect(geom.ball.x).toBeCloseTo(PONG_GLYPH_VIEW_W / 2 - PONG_GLYPH_BALL / 2, 10);
    expect(geom.ball.y).toBeCloseTo(PONG_GLYPH_VIEW_H / 2 - PONG_GLYPH_BALL / 2, 10);
    // Both paddles centred ⇒ identical y, and the pair is symmetric about the net.
    const [left, right] = geom.paddles;
    expect(left.y).toBeCloseTo(right.y, 10);
    expect(left.x + left.w / 2).toBeCloseTo(
      PONG_GLYPH_VIEW_W - (right.x + right.w / 2),
      10,
    );
  });

  it('paddle height is drawPong\'s law — a FRACTION OF COURT HEIGHT, and it tracks', () => {
    // The one number this model shares with the running game. Pinned as a ratio
    // across the param's real range (0.05..0.5) rather than at one value, so a
    // stray `+ constant` or a clamp creeping in is visible.
    for (const paddleH of [0.05, 0.2, 0.5]) {
      const geom = pongGlyphGeometry(REST, paddleH);
      for (const p of geom.paddles) {
        expect(p.h, `paddleH=${paddleH} must be that fraction of ${PONG_GLYPH_VIEW_H}`).toBeCloseTo(
          paddleH * PONG_GLYPH_VIEW_H,
          10,
        );
        // Centred paddle: equal margin above and below.
        expect(p.y + p.h / 2).toBeCloseTo(PONG_GLYPH_VIEW_H / 2, 10);
      }
    }
  });

  it('THE PICTURE MOVES — a different state is a different court', () => {
    // ⚠ THE NEGATIVE CONTROL, and it is the leg that stops this whole model from
    // being quietly replaced by a constant. Every other assertion here would
    // still pass against a hardcoded centred court.
    const moved = pongGlyphGeometry(
      { ballX: 0.2, ballY: 0.8, paddleLY: 0.1, paddleRY: 0.9 },
      0.2,
    );
    const rest = pongGlyphGeometry(REST, 0.2);
    expect(moved.ball.x).not.toBeCloseTo(rest.ball.x, 5);
    expect(moved.ball.y).not.toBeCloseTo(rest.ball.y, 5);
    expect(moved.paddles[0].y).toBeLessThan(rest.paddles[0].y);
    expect(moved.paddles[1].y).toBeGreaterThan(rest.paddles[1].y);
  });

  it('is TOTAL — no state paints outside the viewBox', () => {
    // A glyph that overflows its plate does not merely look wrong: the shell
    // gives `.topo-diagram` an explicit height precisely because an unbounded
    // SVG grows the plate and swallows the faceplate (the comment at
    // ModuleShell's topology branch). So refuse the input, not the symptom.
    const wild: PongGlyphState[] = [
      { ballX: -5, ballY: -5, paddleLY: -1, paddleRY: -1 },
      { ballX: 9, ballY: 9, paddleLY: 2, paddleRY: 2 },
      { ballX: Number.NaN, ballY: Number.NaN, paddleLY: Number.NaN, paddleRY: Number.NaN },
    ];
    for (const state of wild) {
      for (const paddleH of [-1, 0.2, 4]) {
        const geom = pongGlyphGeometry(state, paddleH);
        const marks = [
          { x: geom.ball.x, y: geom.ball.y, w: geom.ball.size, h: geom.ball.size },
          ...geom.paddles,
        ];
        for (const m of marks) {
          // NaN fails every comparison, so these bounds also assert finiteness —
          // which is what a NaN state would otherwise smuggle into the DOM as
          // `x="NaN"` (an attribute the browser drops, painting nothing).
          expect(Number.isFinite(m.x) && Number.isFinite(m.y), `non-finite mark ${JSON.stringify(m)}`).toBe(true);
          expect(m.x, `mark left of the court: ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(0);
          expect(m.y, `mark above the court: ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(0);
          expect(m.x + m.w, `mark right of the court: ${JSON.stringify(m)}`).toBeLessThanOrEqual(
            PONG_GLYPH_VIEW_W,
          );
          expect(m.y + m.h, `mark below the court: ${JSON.stringify(m)}`).toBeLessThanOrEqual(
            PONG_GLYPH_VIEW_H,
          );
        }
      }
    }
  });

  it('the viewBox is the DOCK COURT\'S aspect — one shape at two sizes', () => {
    // The lane glyph and the dock court are the same picture; a player who
    // expands the tile should recognise what grew. PongCourtBody's court is
    // 320x224 CSS px.
    expect(PONG_GLYPH_VIEW_W / PONG_GLYPH_VIEW_H).toBeCloseTo(320 / 224, 6);
    expect(pongGlyphGeometry(REST, 0.2).viewBox).toBe(
      `0 0 ${PONG_GLYPH_VIEW_W} ${PONG_GLYPH_VIEW_H}`,
    );
  });
});
