// packages/web/src/lib/audio/dx7-eg-curve.ts
//
// THE OPERATOR ENVELOPE, AS A DRAWABLE CURVE. One function feeds the 20x12
// thumbnails on the operator map, the ghosted comparison curves and the big
// draggable editor, so all three draw the same envelope the engine plays.
//
// ==========================================================================
// THE MODEL — the CORRECTED one. Three facts here were wrong in the first
// draft of this program and are easy to reintroduce; each is load-bearing.
// ==========================================================================
//
// 1. **The envelope IDLES AT L4.** L4 is both where it starts and where the
//    release lands, so the curve opens at L4 and closes at L4. It does not
//    start at zero. (hexter: `op->eg.value = INT_TO_FP(op->eg.level[3])`.)
//
// 2. **The hold is a FROZEN SEGMENT 3, not a fourth segment.** After R3 has
//    carried the level to L3 the envelope parks there — Dexed's `getsample()`
//    runs only `if (ix_ < 3 || ((ix_ < 4) && !down_))`, so reaching index 3
//    with the key still down FREEZES it. Note-off UNFREEZES the same segment
//    rather than changing the index. So the editor draws the hold as **the L3
//    PLATEAU PRECEDING THE RELEASE**, not as a distinct segment with its own
//    rate. There are four rates and four levels, and the plateau has neither.
//
// 3. **RATE 0 IS 317.487 s, NOT 90 s.** The 90 was Dexed's internal envelope
//    span, which is ~90 **dB** — a units confusion. The real number is
//    hexter's measured `dx7_voice_eg_rate_decay_duration[0]`, and it is
//    already pinned in dx7-syx.ts as `DX7_EG_RATE0_FULL_SCALE_S`. This file
//    derives every duration from `dx7RateToDbPerSec`, never from its own
//    constant, so the two cannot drift.
//
// ==========================================================================
// THE AXES — and why X is NOT seconds.
// ==========================================================================
//
//   Y = LEVEL, the raw 0..99 byte. Linear in LEVEL, not in dB and not in
//       amplitude, because LEVEL is what the drag writes back.
//
//   X = the RATE of the segment ARRIVING at that point, as a WIDTH:
//       `width = (99 - rate) / 99`, so a slow segment is wide and rate 99 is a
//       hairline. Point n sits at the cumulative sum of the widths before it.
//       **RAW RATE, NEVER SECONDS.** Rate 99 is milliseconds while rate 0 is
//       five minutes, so a linear-seconds axis is unusable and a log-seconds
//       axis makes the drag -> stored round trip lossy. A 1:1 mapping is also
//       what a VRT baseline and a drag probe need to stay deterministic.
//
// `segmentTimes` carries the REAL seconds for every segment, for the hover
// readout and for tests — the honest number lives beside the drawing number
// rather than replacing it.

import {
  DX7_DB_PER_OCTAVE,
  DX7_EG_ATTACK_CEIL_DB,
  DX7_EG_ATTACK_JUMP_DB,
  dx7LevelToDb,
  dx7RateToDbPerSec,
} from './dx7-syx';

/**
 * Horizontal width of the sustain plateau, in the same RATE-WIDTH units as the
 * segments. A DRAWING constant with no counterpart in the patch: how long a
 * note is held is the player's business, not the voice's, so the plateau has
 * no rate and no stored length. Half a full-width segment reads as a hold
 * without dominating a curve whose four segments can total 4.0.
 */
export const DX7_EG_HOLD_WIDTH = 0.5;

/** Rate byte -> the segment's horizontal WIDTH on the editor's X axis. */
export function dx7RateToWidth(rate: number): number {
  const r = Math.max(0, Math.min(99, Math.round(rate)));
  return (99 - r) / 99;
}

/** Inverse of `dx7RateToWidth` — a drag on the X axis back to a rate byte. */
export function dx7WidthToRate(width: number): number {
  const w = Math.max(0, Math.min(1, width));
  return Math.max(0, Math.min(99, Math.round(99 - w * 99)));
}

export type Dx7EgPointKind = 'start' | 'point' | 'hold' | 'release';

export interface Dx7EgPoint {
  /**
   * Index of the DRAGGABLE handle this point is: 0..3 for the R1/L1 .. R4/L4
   * pairs. `-1` for the two undraggable points (the L4 start and the end of
   * the sustain plateau), which have no rate/level pair of their own.
   */
  index: number;
  /** Raw DX7 LEVEL byte 0..99 — the value a vertical drag writes back. */
  level: number;
  /** X in RATE-WIDTH units (cumulative sum of `(99 - rate) / 99`). NOT seconds. */
  x: number;
  /**
   * Y in 0..1, ready to plot: `level / 99`, scaled by `outputLevel / 99`.
   * The output-level scaling is what makes the map's thumbnails comparable —
   * a quiet operator draws a short curve — so a caller wanting the unscaled
   * shape passes `outputLevel = 99`.
   */
  y: number;
  kind: Dx7EgPointKind;
}

export interface Dx7EgCurve {
  /**
   * Six points in draw order: L4 start, L1, L2, L3, the end of the L3 hold
   * plateau, then L4 again at the end of the release. Feed straight to an SVG
   * `polyline`; the four with `index >= 0` are the draggable handles.
   */
  points: Dx7EgPoint[];
  /** Per-segment horizontal width for R1..R4, `(99 - rate) / 99`. */
  segmentWidths: [number, number, number, number];
  /**
   * Per-segment REAL duration in seconds, from the authentic rate law — a
   * rising segment uses Dexed's asymptotic log-domain attack (after the
   * level-31 jump) and a falling segment is linear in dB, exactly as
   * `dx7EgTick` integrates them. A segment already at its target is 0 s.
   */
  segmentTimes: [number, number, number, number];
  /** Total X extent including the hold plateau — the natural viewBox width. */
  width: number;
  /** X extent of the L3 sustain plateau (`DX7_EG_HOLD_WIDTH`). */
  holdWidth: number;
  /** Y of the curve's highest point, 0..1 — for scaling a thumbnail's box. */
  peakY: number;
}

function clampByte(v: number): number {
  const i = Math.round(Number.isFinite(v) ? v : 0);
  return i < 0 ? 0 : i > 99 ? 99 : i;
}

/**
 * SECONDS for one envelope segment: travel from level `fromLevel` to
 * `toLevel` at rate byte `rate`.
 *
 * Falling is linear in dB — `t = ΔdB / (dB per second)` — which is why rate 0
 * over the full 74.25 dB scale is 317.487 s. Rising follows Dexed's
 * `level_ += ((CEIL - level_) / …) * inc_`, whose closed form is
 * `t = (DB_PER_OCTAVE / rate) · ln((CEIL - from) / (CEIL - to))` after the
 * start is snapped up to the level-31 attack jump. That makes a full-scale
 * attack 8.01x faster than a full-scale decay at the same rate byte, which is
 * hexter's measured `decay_duration[r] / rise_duration[r]` — the constant this
 * whole calibration hangs on. (The test negative-controls exactly that ratio.)
 */
export function dx7EgSegmentSeconds(fromLevel: number, toLevel: number, rate: number): number {
  const fromDb = dx7LevelToDb(clampByte(fromLevel));
  const toDb = dx7LevelToDb(clampByte(toLevel));
  if (fromDb === toDb) return 0;
  const dbPerSec = dx7RateToDbPerSec(rate);
  if (!(dbPerSec > 0)) return Number.POSITIVE_INFINITY;
  if (fromDb > toDb) return (fromDb - toDb) / dbPerSec; // FALLING — linear in dB
  // RISING — asymptotic in the log domain, from the attack-jump floor.
  const start = Math.max(fromDb, DX7_EG_ATTACK_JUMP_DB);
  if (start >= toDb) return 0;
  const k = dbPerSec / DX7_DB_PER_OCTAVE;
  return Math.log((DX7_EG_ATTACK_CEIL_DB - start) / (DX7_EG_ATTACK_CEIL_DB - toDb)) / k;
}

/**
 * Build the drawable curve for one operator envelope.
 *
 * @param r  the four RATE bytes R1..R4 (0..99; 99 is FASTEST).
 * @param l  the four LEVEL bytes L1..L4 (0..99).
 * @param outputLevel the operator's OUTPUT LEVEL 0..99, which scales `y` so a
 *        quiet operator draws a short curve. Pass 99 for the unscaled shape.
 *
 * Tolerant of short/garbage arrays (a legacy or half-written voice out of the
 * Y.Doc): missing entries read as 0, and every byte is clamped to 0..99.
 */
export function dx7EgCurve(
  r: readonly number[],
  l: readonly number[],
  outputLevel = 99,
): Dx7EgCurve {
  const rate = [0, 1, 2, 3].map((i) => clampByte(r[i] ?? 0)) as [number, number, number, number];
  const lvl = [0, 1, 2, 3].map((i) => clampByte(l[i] ?? 0)) as [number, number, number, number];
  const outScale = clampByte(outputLevel) / 99;

  const segmentWidths = rate.map(dx7RateToWidth) as [number, number, number, number];

  // The envelope idles at L4, so segment 1 starts there and the release ends
  // there. Segment n travels from the previous level to l[n].
  const from: [number, number, number, number] = [lvl[3], lvl[0], lvl[1], lvl[2]];
  const segmentTimes = [0, 1, 2, 3].map((i) =>
    dx7EgSegmentSeconds(from[i]!, lvl[i]!, rate[i]!),
  ) as [number, number, number, number];

  const y = (level: number) => (level / 99) * outScale;

  const x1 = segmentWidths[0];
  const x2 = x1 + segmentWidths[1];
  const x3 = x2 + segmentWidths[2];
  const xHold = x3 + DX7_EG_HOLD_WIDTH;
  const x4 = xHold + segmentWidths[3];

  const points: Dx7EgPoint[] = [
    { index: -1, level: lvl[3], x: 0, y: y(lvl[3]), kind: 'start' },
    { index: 0, level: lvl[0], x: x1, y: y(lvl[0]), kind: 'point' },
    { index: 1, level: lvl[1], x: x2, y: y(lvl[1]), kind: 'point' },
    { index: 2, level: lvl[2], x: x3, y: y(lvl[2]), kind: 'point' },
    // The sustain: the L3 plateau PRECEDING the release. Same level as the
    // point before it — a horizontal run, not a new segment.
    { index: -1, level: lvl[2], x: xHold, y: y(lvl[2]), kind: 'hold' },
    { index: 3, level: lvl[3], x: x4, y: y(lvl[3]), kind: 'release' },
  ];

  let peakY = 0;
  for (const p of points) peakY = Math.max(peakY, p.y);

  return {
    points,
    segmentWidths,
    segmentTimes,
    width: x4,
    holdWidth: DX7_EG_HOLD_WIDTH,
    peakY,
  };
}
