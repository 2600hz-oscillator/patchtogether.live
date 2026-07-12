// packages/web/src/lib/audio/modules/clip-clock.ts
//
// PURE per-lane clock RATE (mult/div) helpers for the `clipplayer` module.
// Kept out of clipplayer.ts so the rate table + coercion math are unit-testable
// with no engine, and out of clip-types.ts so the clip data model doesn't grow
// scheduler knowledge. (This file exports no `*Def`, so the audio module glob
// ignores it.)
//
// MODEL — why this is TIME-SCALING, not edge-counting or interval inference:
// clipplayer consumes NO external clock edges. It is LOCKED TO TIMELORDE and
// computes each lane's absolute step time from TIMELORDE.bpm (see clipplayer.ts
// tick()). A lane's rate therefore simply scales its step DURATION:
//
//   laneStepDur = baseStepDur / rateMult
//
// - DIVISION (1/8, 1/4, 1/2): the lane advances every 8th/4th/2nd base step —
//   equivalent to counting every Nth edge of the base step grid, but exact by
//   construction (no counter to drift).
// - MULTIPLICATION (2x, 4x): the lane advances 2×/4× per base step. Because the
//   bpm is KNOWN (not inferred from incoming edges), multiplication is exact
//   from the very first step — the usual "a multiplier can't tick before two
//   edges have been seen" caveat does not apply here.
//
// PHASE RULE: all lanes re-anchor to a COMMON origin instant on transport start
// and on RESET (clipplayer resetActiveLanes). From that origin a 1/2 lane's
// advances land on EVEN base steps (0, 2, 4, …) and a 2x lane lands on the base
// grid every second advance. An unquantized (NOW) launch re-anchors just that
// lane to its launch instant (pre-existing behavior, unchanged); a quantized
// launch applies on the lane's own loop boundary, preserving the lane's phase.

/** The card dropdown's rate choices, in display order (index = stored value). */
export const RATE_LABELS = ['1/8', '1/4', '1/2', '1', '2x', '4x'] as const;

/** Step-rate multiplier for each RATE_LABELS index. <1 divides (slower), >1
 *  multiplies (faster). laneStepDur = baseStepDur / mult. */
export const RATE_MULTS = [0.125, 0.25, 0.5, 1, 2, 4] as const;

/** Default rate index — '1' (the lane runs at the global STEP grid). */
export const RATE_DEFAULT_INDEX = 3;

/** Clamp/round an arbitrary persisted value to a valid RATE index. Anything
 *  non-numeric (missing lane, corrupt sync payload) falls back to '1'. */
export function coerceRateIndex(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return RATE_DEFAULT_INDEX;
  return Math.max(0, Math.min(RATE_MULTS.length - 1, Math.round(v)));
}

/** Read lane L's rate index from a clipplayer node's data (`data.rate` — a
 *  plain per-lane number array, same shape discipline as `mono`/`playing`). */
export function laneRateIndex(data: { rate?: unknown } | undefined, lane: number): number {
  const arr = data?.rate;
  if (!Array.isArray(arr)) return RATE_DEFAULT_INDEX;
  return coerceRateIndex(arr[lane]);
}

/** A lane's step duration (s) at a rate index, from the base (global STEP grid)
 *  step duration. 1/2 → 2× the base duration; 2x → half the base duration. */
export function laneStepDur(baseStepDur: number, rateIndex: number): number {
  return baseStepDur / RATE_MULTS[coerceRateIndex(rateIndex)];
}
