// packages/web/src/lib/ui/modules/quadralogical-face-model.ts
//
// The PURE half of the QUADRALOGICAL faceplate — the geometry and the accessible
// name of the joystick field, extracted from `QuadralogicalScreenBody.svelte` so
// they can be asserted without a browser.
//
// ⚠ WHY THESE FOUR AND NOT THE WHOLE COMPONENT. Each one is a claim that can be
// WRONG IN A WAY NO PIXEL GATE WOULD NAME:
//
//   * the frame's two widths encode "the toggle re-aspects on the WIDTH and the
//     height never moves", which is what stops the EDGE band below the screen
//     jumping under the player's cursor on every toggle. A regression here is a
//     moved baseline with no explanation attached;
//   * the diamond is the module's own weight model DRAWN, and the legacy card's
//     rotate(45deg) square is correct ONLY at 1:1 — at the SCREEN-ON aspect it
//     is wrong by 4/3 on one axis. That is a silent maths error: the outline
//     still looks like a diamond;
//   * the DOMINANT input is the one fact the card carried as a COLOUR and
//     nothing else, and a colour is not speakable or assertable;
//   * the accessible name is where the deleted `x: 0.00  y: 0.00` row went, so
//     it is the only remaining observable of the pad's position.

/**
 * The joystick field's HEIGHT, in CSS px — a CONSTANT across both screen
 * states, and that is the design rather than a coincidence. The four EDGE boxes
 * sit in the band directly below this frame; a toggle that changed the height
 * would move them under the pointer mid-performance.
 */
export const QUAD_FIELD_H = 360;

/** SCREEN OFF: the legacy card's SQUARE pad (1:1) — the joystick with no video. */
export const QUAD_FIELD_W_OFF = 360;

/**
 * SCREEN ON: 4:3, because a quadrant is one input at `VIDEO_RES` (1024×768 =
 * 4:3) and a 2×2 grid of 4:3 tiles is 8:6 = 4:3 overall. Exactly
 * `QUAD_FIELD_H * 4 / 3`, asserted rather than typed independently.
 */
export const QUAD_FIELD_W_ON = (QUAD_FIELD_H * 4) / 3;

/** The frame's width for a screen state. `true` = collapsed = SCREEN OFF. */
export function quadFieldWidth(previewCollapsed: boolean): number {
  return previewCollapsed ? QUAD_FIELD_W_OFF : QUAD_FIELD_W_ON;
}

/**
 * The all-four-composite zone as a CSS `clip-path` polygon, in PERCENTAGES of
 * the frame.
 *
 * ⚠ IT IS A RHOMBUS AND IT CANNOT BE A ROTATED SQUARE. The boundary is
 * `|x| + |y| = margin` in NORMALISED joystick coordinates, whose horizontal
 * semi-axis is `margin·W/2` and vertical semi-axis `margin·H/2`. A CSS square
 * rotated 45° has EQUAL semi-axes, so it is correct at 1:1 and only at 1:1 —
 * which is why the legacy card's version (`diamondSide = margin·PAD/√2` +
 * `rotate(45deg)`) is right where it lives, on a square pad, and would be wrong
 * by 4/3 on one axis here with SCREEN ON.
 *
 * Percentages are aspect-free, so ONE expression is correct in both states.
 * `margin` is clamped to the param's own 0..1 range.
 */
export function quadDiamondClipPath(margin: number): string {
  const h = Math.max(0, Math.min(1, Number.isFinite(margin) ? margin : 0)) * 50;
  return `polygon(50% ${50 - h}%, ${50 + h}% 50%, 50% ${50 + h}%, ${50 - h}% 50%)`;
}

/** The four inputs, in the `quadWeights` corner order (in1 TL … in4 BR). */
export const QUAD_INPUT_NAMES = ['IN1', 'IN2', 'IN3', 'IN4'] as const;

/**
 * Which input the composite currently favours, as an index into
 * `QUAD_INPUT_NAMES` / the card's `INPUT_COLORS`.
 *
 * ⚠ TIES RESOLVE TO THE LOWEST INDEX, and that is the SHIPPED behaviour being
 * preserved rather than a choice made here: `Array.indexOf(Math.max(...))` is
 * what `QuadralogicalCard.svelte` has always done, and at the spawn position
 * (0, 0) all four weights are exactly 0.25 — so the resting puck is IN1's red.
 * That is the "red puck" the design brief describes, and a tie-break that
 * picked differently would change the module's resting appearance.
 */
export function quadDominantInput(weights: readonly number[]): number {
  if (!weights.length) return 0;
  let best = 0;
  for (let i = 1; i < weights.length; i++) {
    if ((weights[i] ?? -Infinity) > (weights[best] ?? -Infinity)) best = i;
  }
  return best;
}

/** Format one axis for the accessible name — `XyPad`'s own ladder (2 dp under
 *  10), so the two pads speak their positions the same way. */
export function quadFmtAxis(v: number): string {
  if (!Number.isFinite(v)) return '0.00';
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/**
 * The joystick field's ACCESSIBLE NAME — where the legacy card's
 * `x: 0.00  y: 0.00` row went when the resting-text ruling deleted it.
 *
 * ⚠ `aria-label`, NOT `aria-valuetext`. The field is `role="application"` — the
 * correct role for a 2-D manipulation surface that owns its own handling — and
 * `aria-valuetext` is only meaningful on a RANGE role. `XyPad.svelte` records
 * the identical conclusion where #2038 deleted the generic pad's readout row.
 *
 * The trailing name is the DOMINANT input, which the card carried only as the
 * puck's colour. A colour is neither speakable nor assertable, so promoting it
 * into the accessible name is the one thing this rendering adds rather than
 * relocates.
 */
export function quadPadAriaLabel(x: number, y: number, dominantIdx: number): string {
  const name = QUAD_INPUT_NAMES[dominantIdx] ?? QUAD_INPUT_NAMES[0];
  return `joystick: X ${quadFmtAxis(x)}, Y ${quadFmtAxis(y)} — ${name}`;
}
