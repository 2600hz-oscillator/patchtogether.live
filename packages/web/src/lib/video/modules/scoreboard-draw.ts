// packages/web/src/lib/video/modules/scoreboard-draw.ts
//
// SCOREBOARD — pure Canvas2D draw helper for the 4-digit 7-segment display.
//
// Lives in its own file because the rendering is pure (no engine / GL /
// timing state), trivially testable in jsdom, and reusable from BOTH the
// engine's GL upload path AND the card's on-card preview blit.
//
// Why a 2D draw helper and not a fragment shader?
//   - 7-segment glyphs are a discrete set of (digit, segment) rectangles
//     with rounded corners — Canvas2D's roundRect + shadowBlur gives us a
//     correct "neon-tube" glow in ~30 LOC. Re-implementing that in WebGL
//     would need a multi-pass blur, a separate glyph atlas texture, and
//     ~150 LOC of GL plumbing for the same output.
//   - The card preview wants a small 200×80 canvas; the engine wants a
//     larger 640×240 texture for the video output. ONE helper called with
//     two sizes is cheaper than maintaining a pair of pipelines.
//   - Output texels go from a 2D canvas → texImage2D in the engine, which
//     is the standard "upload static-ish content" path (mirrors how
//     ACIDWARP uploads its R8 pattern + RGB palette textures).
//
// Render contract:
//   - Background: BG_COLOR (#0a0a0a — a soft black so the unlit segments
//     stay distinguishable from a hard background).
//   - Active segments: filled+stroked in `hsl(hue°, 90%, 55%)` with an
//     RGBA shadowBlur for the neon halo.
//   - Inactive segments: same color at IDLE_ALPHA (~5%) so a 0 or "0000"
//     state still reads as a 7-segment widget (vs. blank cells).
//   - Optional scanline overlay (every other row, 20% darker) for the CRT
//     vibe. Kept LIGHT — this is a counter, not BENTBOX.
//
// All numeric layout is derived from (width, height); identical (score,
// hue, width, height) inputs produce byte-identical canvases. The wrap
// policy (counter at 10000 wraps to 0) lives in the FACTORY, not here.

/** Canonical 7-segment masks, indexed by digit 0..9.
 *  Bit layout (LSB → MSB):
 *    bit 0 = g (middle)
 *    bit 1 = f (top-left)
 *    bit 2 = e (bottom-left)
 *    bit 3 = d (bottom)
 *    bit 4 = c (bottom-right)
 *    bit 5 = b (top-right)
 *    bit 6 = a (top)
 *
 *  The spec gives the same set as canonical hex masks where bit-6 is `a`
 *  (top) and bit-0 is `g` (middle): see SCOREBOARD_DIGIT_HEX_MASKS for
 *  the spec-form representation. We use the lower bit ordering (a..g →
 *  bits 6..0) internally and expose the segment-flag helper so test
 *  oracles can assert the canonical form directly. */
export const SCOREBOARD_DIGIT_HEX_MASKS: readonly number[] = [
  0x7e, // 0 — a b c d e f
  0x30, // 1 — b c
  0x6d, // 2 — a b d e g
  0x79, // 3 — a b c d g
  0x33, // 4 — b c f g
  0x5b, // 5 — a c d f g
  0x5f, // 6 — a c d e f g
  0x70, // 7 — a b c
  0x7f, // 8 — all seven
  0x7b, // 9 — a b c d f g
] as const;

/** Which segments are lit for each digit, decoded from the hex masks. */
export const SCOREBOARD_DIGIT_SEGMENTS: readonly DigitSegments[] = SCOREBOARD_DIGIT_HEX_MASKS.map(
  (mask) => ({
    a: (mask & (1 << 6)) !== 0,
    b: (mask & (1 << 5)) !== 0,
    c: (mask & (1 << 4)) !== 0,
    d: (mask & (1 << 3)) !== 0,
    e: (mask & (1 << 2)) !== 0,
    f: (mask & (1 << 1)) !== 0,
    g: (mask & (1 << 0)) !== 0,
  }),
);

export interface DigitSegments {
  a: boolean; // top
  b: boolean; // top-right
  c: boolean; // bottom-right
  d: boolean; // bottom
  e: boolean; // bottom-left
  f: boolean; // top-left
  g: boolean; // middle
}

/** Number of digits the display renders. */
export const SCOREBOARD_DIGITS = 4;

/** Wrap modulus — counter wraps to 0 when it would exceed (10^DIGITS − 1).
 *  i.e. with 4 digits, 9999 + 1 → 0. Use this from the factory's increment
 *  path so the display never overruns its digit count. */
export const SCOREBOARD_WRAP_AT = Math.pow(10, SCOREBOARD_DIGITS);

const BG_COLOR = '#0a0a0a';
const IDLE_ALPHA = 0.05;
const SHADOW_BLUR_FACTOR = 0.08; // shadowBlur = digitHeight * factor
const SCANLINE_ALPHA = 0.18;

/** Convert hue (0..1) + saturation + lightness to an `hsl(...)` string. */
function hslString(hue01: number, sat: number, light: number, alpha = 1): string {
  // Wrap hue into [0,1) so a negative knob value or a value > 1 is still
  // a valid hue (not NaN).
  const h = ((hue01 % 1) + 1) % 1;
  const hueDeg = Math.round(h * 360);
  const s = Math.round(sat * 100);
  const l = Math.round(light * 100);
  if (alpha >= 1) return `hsl(${hueDeg}, ${s}%, ${l}%)`;
  return `hsla(${hueDeg}, ${s}%, ${l}%, ${alpha})`;
}

/** Compute per-digit layout rectangles inside `(width, height)`.
 *  Returns one `{ x, y, w, h }` per digit slot — same array length as
 *  SCOREBOARD_DIGITS. Pure: depends only on size. */
function digitRects(width: number, height: number): Array<{ x: number; y: number; w: number; h: number }> {
  // Leave 5% padding on each side, 8% top + bottom.
  const padX = width * 0.05;
  const padY = height * 0.08;
  const innerW = width - 2 * padX;
  const innerH = height - 2 * padY;
  // Each digit cell is innerW / N wide. Inside the cell, the digit itself
  // takes 80% of the width (a thin gap between digits reads as the
  // "decimal-point" channel even though we never draw a dot).
  const cellW = innerW / SCOREBOARD_DIGITS;
  const digitW = cellW * 0.78;
  const slotXOffset = (cellW - digitW) / 2;
  return Array.from({ length: SCOREBOARD_DIGITS }, (_, i) => ({
    x: padX + i * cellW + slotXOffset,
    y: padY,
    w: digitW,
    h: innerH,
  }));
}

/** Convert a non-negative integer score to its 4-digit zero-padded
 *  decimal representation as a digit-index array (most-significant first).
 *  Scores >= SCOREBOARD_WRAP_AT are taken modulo so the helper is
 *  defensive (defense-in-depth — the factory's increment path is the
 *  canonical wrap site). */
export function scoreToDigits(score: number): number[] {
  const s = Math.max(0, Math.floor(score)) % SCOREBOARD_WRAP_AT;
  const out: number[] = new Array(SCOREBOARD_DIGITS).fill(0);
  let n = s;
  for (let i = SCOREBOARD_DIGITS - 1; i >= 0; i--) {
    out[i] = n % 10;
    n = Math.floor(n / 10);
  }
  return out;
}

/**
 * Draw ONE 7-segment digit into the rect (`dx`, `dy`, `dw`, `dh`) using
 * `colorActive` for lit segments and the same color at IDLE_ALPHA for
 * unlit ones. Shadow blur (set up by the caller before this is called)
 * paints the neon halo.
 */
function drawDigit(
  ctx: CanvasRenderingContext2D,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  digit: number,
  hue01: number,
): void {
  const seg = SCOREBOARD_DIGIT_SEGMENTS[Math.max(0, Math.min(9, digit))]!;
  const colorActive = hslString(hue01, 0.95, 0.55, 1);
  const colorIdle = hslString(hue01, 0.95, 0.55, IDLE_ALPHA);

  // Segment geometry. We carve the digit cell into 3 horizontal bars
  // (top/middle/bottom) and 2 vertical bars on each side. Segment
  // thickness scales with digit width.
  const thick = Math.max(2, dw * 0.13);
  const half = thick / 2;
  // Inset segments slightly so the corners don't overlap into a fat
  // blob. tiny= the "corner notch" on either end of each segment.
  const tiny = thick * 0.4;
  // X coords for the vertical segments.
  const xLeft = dx;
  const xRight = dx + dw;
  // Y coords for the horizontal segments.
  const yTop = dy;
  const yMid = dy + dh / 2;
  const yBot = dy + dh;

  type Bar = { x: number; y: number; w: number; h: number };
  const horiz = (x: number, y: number, w: number): Bar => ({
    x: x + tiny,
    y: y - half,
    w: w - 2 * tiny,
    h: thick,
  });
  const vert = (x: number, y: number, h: number): Bar => ({
    x: x - half,
    y: y + tiny,
    w: thick,
    h: h - 2 * tiny,
  });

  // (segment, lit, rect)
  const segs: Array<{ on: boolean; rect: Bar }> = [
    { on: seg.a, rect: horiz(xLeft, yTop, dw) },
    { on: seg.b, rect: vert(xRight, yTop, dh / 2) },
    { on: seg.c, rect: vert(xRight, yMid, dh / 2) },
    { on: seg.d, rect: horiz(xLeft, yBot, dw) },
    { on: seg.e, rect: vert(xLeft, yMid, dh / 2) },
    { on: seg.f, rect: vert(xLeft, yTop, dh / 2) },
    { on: seg.g, rect: horiz(xLeft, yMid, dw) },
  ];

  for (const s of segs) {
    ctx.fillStyle = s.on ? colorActive : colorIdle;
    // Rounded corners — gives the segment the chamfered LCD/LED look.
    // roundRect is widely supported (Chrome/Safari/Firefox all ship it).
    const r = Math.min(s.rect.w, s.rect.h) / 2;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(s.rect.x, s.rect.y, s.rect.w, s.rect.h, r);
      ctx.fill();
    } else {
      // jsdom doesn't ship roundRect; fall back to a plain fillRect so
      // the deterministic-pixel test still produces stable output (the
      // pixel hash compares two SAME-environment runs, not jsdom vs
      // a real browser).
      ctx.fillRect(s.rect.x, s.rect.y, s.rect.w, s.rect.h);
    }
  }
}

/**
 * Render the 4-digit scoreboard into `ctx` at the given `(width, height)`.
 *
 * Pure: same (score, hue, width, height, ctx-initial-state) → byte-equal
 * pixel output. The caller is responsible for sizing the underlying
 * canvas to (width, height) before this is called.
 */
export function drawScoreboard(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  score: number,
  hue01: number,
): void {
  // Background.
  ctx.save();
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, width, height);

  // Set up the neon glow. shadowBlur is in CANVAS pixels; we scale it
  // with the digit height so the halo reads correctly at any size.
  const rects = digitRects(width, height);
  const digitH = rects[0]?.h ?? height;
  const glowColor = hslString(hue01, 0.95, 0.55, 1);
  ctx.shadowBlur = digitH * SHADOW_BLUR_FACTOR;
  ctx.shadowColor = glowColor;

  const digits = scoreToDigits(score);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    drawDigit(ctx, r.x, r.y, r.w, r.h, digits[i]!, hue01);
  }

  // Scanlines overlay. Keep this in the BG_COLOR so the lit segments
  // don't shift hue. Drawn last so it lies over the segments.
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = `rgba(0, 0, 0, ${SCANLINE_ALPHA})`;
  for (let y = 0; y < height; y += 2) {
    ctx.fillRect(0, y, width, 1);
  }

  ctx.restore();
}
