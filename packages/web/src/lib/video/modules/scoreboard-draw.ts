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
//   - Background: BG_COLOR (#0a0a0a — a soft black). Solid, no scanlines —
//     this is a digital-alarm-clock face, not a CRT.
//   - Active segments: filled hexagonal blobs in `hsl(hue°, 90%, 55%)`
//     with an RGBA shadowBlur for the neon halo. The hex shape is the
//     canonical 7-segment glyph: a long rectangle with 45° chamfered tips
//     so adjacent segments meet at a point with a small natural gap.
//   - Inactive segments: NOT DRAWN. Off segments are fully invisible
//     against the background — the alarm-clock look, not an LCD ghost.
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
const SHADOW_BLUR_FACTOR = 0.08; // shadowBlur = digitHeight * factor

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
 * Draw a horizontal chamfered hex segment at (x, y) with length `len`
 * and thickness `thick`. The shape is a 6-vertex hexagon — long bar in
 * the middle with both ends cut at 45° so they taper to a point. The
 * canonical "alarm clock" segment.
 *
 * Vertex order clockwise from top-left chamfer corner:
 *   (x + thick/2, y           )
 *   (x + len - thick/2, y           )
 *   (x + len,           y + thick/2)
 *   (x + len - thick/2, y + thick   )
 *   (x + thick/2, y + thick   )
 *   (x,                 y + thick/2)
 */
function pathHorizSegment(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  len: number,
  thick: number,
): void {
  const half = thick / 2;
  ctx.beginPath();
  ctx.moveTo(x + half, y);
  ctx.lineTo(x + len - half, y);
  ctx.lineTo(x + len, y + half);
  ctx.lineTo(x + len - half, y + thick);
  ctx.lineTo(x + half, y + thick);
  ctx.lineTo(x, y + half);
  ctx.closePath();
}

/**
 * Draw a vertical chamfered hex segment at (x, y) with length `len`
 * (vertical extent) and thickness `thick` (horizontal extent). Same hex
 * shape as the horizontal variant, rotated 90°.
 */
function pathVertSegment(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  len: number,
  thick: number,
): void {
  const half = thick / 2;
  ctx.beginPath();
  ctx.moveTo(x, y + half);
  ctx.lineTo(x + half, y);
  ctx.lineTo(x + thick, y + half);
  ctx.lineTo(x + thick, y + len - half);
  ctx.lineTo(x + half, y + len);
  ctx.lineTo(x, y + len - half);
  ctx.closePath();
}

/**
 * Draw ONE 7-segment digit into the rect (`dx`, `dy`, `dw`, `dh`).
 * Lit segments fill as chamfered hex blobs in the active color. UNLIT
 * segments draw nothing (no ghost / IDLE_ALPHA pass — that was the
 * LCD-style render; the alarm-clock look hides off segments entirely).
 * Shadow blur (set up by the caller) paints the neon halo on each lit
 * segment.
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

  // Segment geometry. The cell is dw wide × dh tall. Segment thickness
  // scales with digit width. Each hex segment's tapered tips eat `half`
  // px on each end — adjacent segments meet at a point with a small
  // natural gap, which IS the canonical alarm-clock look.
  const thick = Math.max(2, dw * 0.13);
  const half = thick / 2;
  // X coords for the vertical segments (b/c on the right, e/f on the
  // left). The vertical hex shape is `thick` wide, so the left-side
  // segment hugs x=dx and the right-side hugs x=dx+dw-thick.
  const xLeft = dx;
  const xRight = dx + dw - thick;
  // Y coords for the horizontal segments. Horizontal segs are `thick`
  // tall; a (top) hugs y=dy, d (bottom) hugs y=dy+dh-thick, g (middle)
  // is centred on dh/2.
  const yTop = dy;
  const yMid = dy + dh / 2 - half;
  const yBot = dy + dh - thick;
  // Vertical segments: top half spans y=dy+half..dy+dh/2-half;
  // bottom half spans y=dy+dh/2+half..dy+dh-half. The +half/-half on
  // each end is what makes the tips taper toward the horizontal seg
  // tip without overlapping it.
  const yTopVert = dy + half;
  const yBotVert = dy + dh / 2 + half;
  const halfH = dh / 2 - thick; // length of each vertical seg (with tip allowance)

  type Seg = { on: boolean; draw: () => void };
  const segs: Seg[] = [
    // a — top horizontal. Inset by `half` on each end so its tips reach
    // toward the b/f corners but don't quite touch them.
    { on: seg.a, draw: () => pathHorizSegment(ctx, dx + half, yTop, dw - thick, thick) },
    // b — top-right vertical.
    { on: seg.b, draw: () => pathVertSegment(ctx, xRight, yTopVert, halfH, thick) },
    // c — bottom-right vertical.
    { on: seg.c, draw: () => pathVertSegment(ctx, xRight, yBotVert, halfH, thick) },
    // d — bottom horizontal.
    { on: seg.d, draw: () => pathHorizSegment(ctx, dx + half, yBot, dw - thick, thick) },
    // e — bottom-left vertical.
    { on: seg.e, draw: () => pathVertSegment(ctx, xLeft, yBotVert, halfH, thick) },
    // f — top-left vertical.
    { on: seg.f, draw: () => pathVertSegment(ctx, xLeft, yTopVert, halfH, thick) },
    // g — middle horizontal.
    { on: seg.g, draw: () => pathHorizSegment(ctx, dx + half, yMid, dw - thick, thick) },
  ];

  ctx.fillStyle = colorActive;
  for (const s of segs) {
    if (!s.on) continue; // No ghost / off-segment pass — alarm-clock look.
    s.draw();
    ctx.fill();
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

  // No scanlines overlay — solid black background. The alarm-clock face
  // is clean; scanlines belong to the CRT module (BENTBOX), not here.
  ctx.restore();
}
