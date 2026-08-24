// packages/web/src/lib/ui/modules/pong/pong-glyph-model.ts
//
// THE PONG LANE-GLYPH LAYOUT FUNCTION — the pure arithmetic behind the court
// picture the shell paints in pong's glyph slot.
//
// This is the `layoutSource` half of the #2160 widening. That PR widened
// `GlyphBinding`'s topology branch to carry a layout-source id rather than
// requiring a param literally named `algorithm`, and said in its own body that
// it "REMOVES THE REFUSAL; IT DOES NOT DRAW ANYTHING — a module still needs its
// own layout component and a `glyph` extension slot to gain a picture." This
// file plus `PongCourtGlyph.svelte` are that component for pong, and
// `pongDef.face.glyph: 'algorithm'` + `extension: 'pong'` is what resolves
// `{ kind: 'algorithm', layoutSource: 'pong', paramId: null }`.
//
// ⚠ THE SPLIT THAT MATTERS, and it is the honest boundary of what this picture
// can claim. TWO KINDS OF NUMBER live here and they have different authorities:
//
//   POSITIONS come from the module's OWN LAW and nothing else. The ball centre
//   and both paddle centres are read off a `PongState`, and the caller feeds it
//   `initPongState` — so the glyph is literally pong's REST STATE drawn, and it
//   follows the game if that law ever moves. Paddle HEIGHT is `params.paddleH`
//   as a fraction of court height, which is `drawPong`'s own rule
//   (`pong.ts:419` — `paddleH * h`), not a restatement of it.
//
//   WEIGHTS (paddle width, ball size, net dash) are GLYPH-SCALE LAYOUT
//   CONSTANTS chosen for legibility at the shell's 40 px lane glyph, and they
//   are deliberately NOT `drawPong`'s. `drawPong` documents `paddleW` and
//   `ballPx` in CSS PIXELS against a ~320 px court: 4/320 and 6/320 are 1.25%
//   and 1.9% of width, which at a 40 px-tall tile is 0.7 px of paddle and a
//   ball under a pixel — a court that renders as an empty box. dx7's glyph has
//   the same property (its `stroke-width: 0.9` is a glyph-scale choice, not a
//   number carried over from a card), so this is the established precedent
//   rather than a new liberty. A SCHEMATIC AT GLYPH SCALE IS NOT A SCALED-DOWN
//   CARD, and pretending otherwise is how you ship a blank tile.
//
// ⚠ AND THE PICTURE IS STATIC BY CONSTRUCTION, not by omission — say it here so
// nobody "fixes" it by reaching for the engine. `ShellExtensionGlyphProps` is
// `{ num, numbers?, testid? }`: there is NO `nodeId`, so a glyph component
// cannot resolve a graph node and cannot read `eng.read(node, 'snapshot')`. The
// LIVE court needs that read and therefore lives where the read is possible —
// the dock `fullViewBody` (`PongCourtBody.svelte`). What the lane gains here is
// pong's IDENTITY at a glance in a rack, which is the glyph slot's job and the
// thing a `ModuleShellPlaceholder` gave it none of.
//
// ⚠ NO SCORES. `drawPong` paints the running score in each upper quadrant; this
// glyph paints none. Two independent reasons, either sufficient: the score is
// live state this slot structurally cannot read, so any digit here would be a
// fabricated readout of a game it is not watching; and a resting derived number
// on a faceplate is refused outright (CLAUDE.md, four rulings). The court's
// GEOMETRY is the identity; the score never was.

/** The ball + paddle positions a court picture needs — the `PongState` subset
 *  this layout reads, so the model never depends on velocity or score. */
export interface PongGlyphState {
  /** Ball centre, both in [0, 1] (field units, y down). */
  ballX: number;
  ballY: number;
  /** Paddle centres in [0, 1]. */
  paddleLY: number;
  paddleRY: number;
}

/** One paddle, in viewBox units. */
export interface PongGlyphPaddle {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The resolved court picture, in viewBox units. Pure data — the component
 *  turns it into elements and owns no arithmetic of its own. */
export interface PongGlyphGeometry {
  viewBox: string;
  /** The court outline. */
  court: { x: number; y: number; w: number; h: number };
  /** The centre net, as a dashed vertical line. */
  net: { x: number; y1: number; y2: number; dashArray: string };
  /** Left then right, always both. */
  paddles: readonly [PongGlyphPaddle, PongGlyphPaddle];
  /** The ball, drawn as a square exactly as `drawPong` does. */
  ball: { x: number; y: number; size: number };
}

// ── The viewBox ──────────────────────────────────────────────────────────────
//
// 10:7, which is the DOCK COURT'S OWN ASPECT (PongCourtBody's CSS_W 320 ×
// CSS_H 224 = 1.4286; 100 × 70 = 1.4286). The lane picture and the dock picture
// are therefore the same SHAPE at two sizes, which is the whole point of an
// identity glyph — a player who expands the tile should recognise what grew.
/** Court width in viewBox units. */
export const PONG_GLYPH_VIEW_W = 100;
/** Court height in viewBox units. */
export const PONG_GLYPH_VIEW_H = 70;

// ── Glyph-scale weights (see the header's SPLIT note) ────────────────────────

/** Paddle width. `drawPong`'s 4 CSS px on a 320 px court is 1.25 units here and
 *  sub-pixel at lane scale; this is the legible weight. */
export const PONG_GLYPH_PADDLE_W = 3;
/** Inset of each paddle from its wall — `drawPong` uses 2 CSS px, and the same
 *  scaling argument applies. Kept small so the paddles read as ON the walls. */
export const PONG_GLYPH_PADDLE_INSET = 2.5;
/** Ball side. Square, like `drawPong`'s — a round ball would be a different
 *  module's picture. */
export const PONG_GLYPH_BALL = 5;
/** Centre-net dash and gap. `drawPong` alternates equal 6 px runs, so the net
 *  is a 50% duty cycle; this keeps that ratio at a density that reads at 40 px. */
export const PONG_GLYPH_NET_DASH = 3;

/**
 * Resolve the court picture for one state. PURE.
 *
 * `paddleH` is a FRACTION OF COURT HEIGHT, exactly as `pongDef` declares it and
 * exactly as `drawPong` consumes it — so a caller passes the param value
 * straight through with no conversion, and there is no second place for the
 * paddle-height law to disagree with the game.
 */
export function pongGlyphGeometry(state: PongGlyphState, paddleH: number): PongGlyphGeometry {
  const w = PONG_GLYPH_VIEW_W;
  const h = PONG_GLYPH_VIEW_H;

  // Clamp to the court so an out-of-range state can never paint outside the
  // viewBox. The game clamps its own paddles to [0,1] (`pong-state.ts`), so this
  // is a property of the PICTURE being total, not a doubted input.
  //
  // ⚠ THE `Number.isFinite` GUARD IS NOT BELT-AND-BRACES — the obvious
  // `v < 0 ? 0 : v > 1 ? 1 : v` LETS NaN THROUGH, because NaN fails both
  // comparisons and falls to the identity branch. It then reaches the DOM as
  // `x="NaN"`, an attribute the browser silently DROPS, so the mark simply does
  // not paint and the tile shows a court with no ball and no obvious defect.
  // Caught by this model's own totality leg, which is why that leg exists.
  const clamp01 = (v: number) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0.5);

  /** Keep a mark of `span` fully inside `[0, extent]`. */
  const clampSpan = (v: number, extent: number, span: number) =>
    v < 0 ? 0 : v > extent - span ? Math.max(0, extent - span) : v;

  const padH = clamp01(paddleH) * h;
  const paddleY = (centre: number) => clampSpan(clamp01(centre) * h - padH / 2, h, padH);

  return {
    viewBox: `0 0 ${w} ${h}`,
    court: { x: 0, y: 0, w, h },
    net: {
      x: w / 2,
      y1: 0,
      y2: h,
      dashArray: `${PONG_GLYPH_NET_DASH} ${PONG_GLYPH_NET_DASH}`,
    },
    paddles: [
      {
        x: PONG_GLYPH_PADDLE_INSET,
        y: paddleY(state.paddleLY),
        w: PONG_GLYPH_PADDLE_W,
        h: padH,
      },
      {
        x: w - PONG_GLYPH_PADDLE_INSET - PONG_GLYPH_PADDLE_W,
        y: paddleY(state.paddleRY),
        w: PONG_GLYPH_PADDLE_W,
        h: padH,
      },
    ],
    // ⚠ THE BALL IS CLAMPED BY ITS BOX, NOT BY ITS CENTRE. Clamping the centre
    // to [0,1] still lets HALF THE BALL hang outside the court at either wall —
    // `1.0 * w` puts the left edge at `w - size/2`. The game's own ball centre
    // never reaches a wall (it scores first), so this only ever bites on a
    // degenerate input, which is exactly the case a total picture must survive.
    ball: {
      x: clampSpan(clamp01(state.ballX) * w - PONG_GLYPH_BALL / 2, w, PONG_GLYPH_BALL),
      y: clampSpan(clamp01(state.ballY) * h - PONG_GLYPH_BALL / 2, h, PONG_GLYPH_BALL),
      size: PONG_GLYPH_BALL,
    },
  };
}
