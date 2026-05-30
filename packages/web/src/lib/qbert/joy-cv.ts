// packages/web/src/lib/qbert/joy-cv.ts
//
// CV → 4-way diagonal joystick translation for the QBERT module.
//
// Q*Bert's joystick is a 4-DIRECTION DIAGONAL stick (NE/NW/SE/SW) — the
// in-game cube grid is rotated 45° so the four cardinal "directions" the
// player presses each land on one isometric face. The CV input pair on the
// module is bipolar joy_x / joy_y in [-1, +1] (the project convention; see
// .myrobots/plans/cv-range-standard.md), so we threshold each axis with a
// small dead band to derive a discrete diagonal.
//
// Threshold convention (matches the DOOM cv-gate hysteresis spirit but uses
// a single symmetric threshold, since the joystick polling rate is fast
// enough that fine-grained debouncing isn't needed — we only push DIRECTION
// when the resolved diagonal CHANGES, so transient zero-crossings near the
// dead band are absorbed at the caller):
//   |x|, |y| < thresh → NEUTRAL (no direction pressed)
//   otherwise → the sign of each axis picks the diagonal:
//     +y = down, -y = up (screen coords; matches DOOM joy convention)
//     +x = right, -x = left
//
// The thresh default is 0.3 (per the QBERT module spec — see qbert.ts).
// Lower than the DOOM 0.5 rise threshold because diagonal-only mapping means
// the user typically holds an axis near full deflection, not hovering.
//
// Pure + trivially unit-testable. Lives in its own file so the QBERT module
// factory test suite can pin the diagonal table without booting the engine.

/** The 4 diagonals Q*Bert recognises + NEUTRAL when no direction is held. */
export type QbertDiagonal = 'NE' | 'NW' | 'SE' | 'SW' | 'NEUTRAL';

/** Default dead-band threshold matching the QBERT module spec. */
export const DEFAULT_JOY_THRESH = 0.3;

/**
 * Translate a bipolar joystick CV pair into a Q*Bert diagonal.
 *
 * Inputs are clamped to [-1, +1] implicitly (out-of-range values are still
 * checked against the threshold so a wild source that overshoots ±1 still
 * resolves cleanly). Returns 'NEUTRAL' when both axes are inside the
 * dead-band — that maps to "no direction held" (no button-press on the
 * Gottlieb joystick poll port).
 */
export function joyCvToDiagonal(
  jx: number,
  jy: number,
  thresh: number = DEFAULT_JOY_THRESH,
): QbertDiagonal {
  const xActive = Math.abs(jx) >= thresh;
  const yActive = Math.abs(jy) >= thresh;
  if (!xActive && !yActive) return 'NEUTRAL';
  // Single-axis input still resolves to a diagonal — the user clearly
  // wants to move + we shouldn't drop the input. Pick the diagonal whose
  // active axis matches: e.g. jx=+0.9, jy=0 → SE (right + assumed down).
  // We bias the inactive axis toward "down" (positive y) so a pure-
  // horizontal swing gives a deterministic diagonal rather than two
  // possible outcomes. Symmetric: pure-vertical biases toward "right".
  const xSign = xActive ? Math.sign(jx) : 1;
  const ySign = yActive ? Math.sign(jy) : 1;
  // ySign +1 = down, -1 = up; xSign +1 = right, -1 = left.
  if (ySign < 0 && xSign > 0) return 'NE';
  if (ySign < 0 && xSign < 0) return 'NW';
  if (ySign > 0 && xSign > 0) return 'SE';
  return 'SW';
}
