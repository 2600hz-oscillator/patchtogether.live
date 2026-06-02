// packages/web/src/lib/snes9x/clock-multiplier.ts
//
// PURE clock MULTIPLIER for the SNES9X module's gate3 output.
//
// Contract (per the SNES9X spec):
//   gate3 takes `clock_in` (a gate/clock) and outputs N evenly-spaced
//   pulses per input clock PERIOD, where N = (world + level) derived from
//   the SMW RAM (see smw-events.ts deriveLocation()).
//
// Behaviour, precisely:
//   * We MEASURE the input period from the interval between the two most
//     recent rising edges of clock_in (in seconds).
//   * On each NEW rising edge we know the just-elapsed period; we schedule
//     N output pulses spaced period/N apart across the NEXT period (the
//     classic "multiply by measuring the last period, replaying it
//     subdivided" approach — one period of latency, which is inherent to
//     any measure-then-multiply clock multiplier).
//   * The FIRST scheduled sub-pulse of each group is emitted exactly on the
//     incoming rising edge (so ×1 is a clean passthrough — pulse-per-input-
//     edge, in phase).
//
// EDGE CASES (documented):
//   * N <= 1  → pass the clock through ×1 (one output pulse per input edge,
//     in phase). This covers "not in a level" / world+level == 0 (idle):
//     deriveLocation returns world=level=0 so N=0 → clamped to ×1 hold.
//   * No measured period yet (first edge ever) → emit the single in-phase
//     pulse for that edge but schedule no subdivisions (we don't know the
//     period). Subsequent edges multiply normally.
//   * The multiplier N is LATCHED at each rising edge, so a mid-period
//     world change doesn't tear the current subdivision group; it takes
//     effect on the next input edge.
//
// This is a PURE time-driven state machine: you feed it (a) rising-edge
// timestamps and (b) "advance to time t" ticks, and it returns the output
// pulse timestamps. The module factory turns those into ConstantSourceNode
// gate pulses; the unit test drives it deterministically with synthetic
// timestamps.

export interface ClockMultiplierState {
  /** Timestamp (seconds) of the most recent rising edge, or -1 if none. */
  lastEdgeT: number;
  /** Measured period (seconds) between the two most recent rising edges,
   *  or 0 if not yet measured. */
  periodS: number;
  /** Pending sub-pulse output timestamps (seconds), ascending. Drained by
   *  advance(). */
  pending: number[];
  /** Multiplier latched for the currently-scheduled group (for tests/debug). */
  lastN: number;
}

export function makeClockMultiplierState(): ClockMultiplierState {
  return { lastEdgeT: -1, periodS: 0, pending: [], lastN: 1 };
}

/** Clamp the requested multiplier to a sane, documented range. N<=1 → 1
 *  (passthrough). Upper clamp keeps a pathological world+level from
 *  scheduling thousands of pulses per period. */
export const MAX_MULTIPLIER = 32;
export function sanitizeMultiplier(n: number): number {
  if (!Number.isFinite(n) || n <= 1) return 1;
  const k = Math.floor(n);
  return k > MAX_MULTIPLIER ? MAX_MULTIPLIER : k;
}

/**
 * Register a rising edge of clock_in at time `t` (seconds), with the
 * current desired multiplier `n` (= world+level). Returns the output pulse
 * timestamps this edge produces (the in-phase pulse at `t` plus any
 * subdivisions of the JUST-MEASURED period, scheduled from `t`). Mutates
 * `state`.
 *
 * The in-phase pulse at `t` is ALWAYS returned (so ×1 passes through). The
 * subdivisions (n-1 extra pulses) are spread across [t, t+period) at
 * period/n spacing, using the period measured from the previous edge —
 * the standard measure-then-multiply scheme.
 */
export function onClockEdge(
  state: ClockMultiplierState,
  t: number,
  n: number,
): number[] {
  const mult = sanitizeMultiplier(n);
  state.lastN = mult;

  // Measure the period from the previous edge.
  if (state.lastEdgeT >= 0 && t > state.lastEdgeT) {
    state.periodS = t - state.lastEdgeT;
  }
  state.lastEdgeT = t;

  const out: number[] = [t]; // in-phase pulse — always.

  if (mult > 1 && state.periodS > 0) {
    const step = state.periodS / mult;
    for (let i = 1; i < mult; i++) {
      out.push(t + i * step);
    }
  }
  // Queue the non-immediate sub-pulses for advance() to surface as time
  // passes. (The immediate one at `t` is returned directly; we still push
  // the future ones so advance() drains them.)
  for (let i = 1; i < out.length; i++) {
    state.pending.push(out[i]!);
  }
  state.pending.sort((a, b) => a - b);
  return out;
}

/**
 * Advance the multiplier to time `t` (seconds). Returns + removes all
 * pending sub-pulse timestamps that are due (<= t), ascending. The module
 * factory calls this every audio/video tick to emit scheduled
 * subdivisions between input edges. Mutates `state`.
 */
export function advance(state: ClockMultiplierState, t: number): number[] {
  if (state.pending.length === 0) return [];
  const due: number[] = [];
  let keepFrom = 0;
  for (let i = 0; i < state.pending.length; i++) {
    if (state.pending[i]! <= t) {
      due.push(state.pending[i]!);
      keepFrom = i + 1;
    } else {
      break;
    }
  }
  if (keepFrom > 0) state.pending.splice(0, keepFrom);
  return due;
}
