// packages/web/src/lib/audio/hold-param.ts
//
// CANCEL-AND-HOLD util for the clip-automation param-jump policy (Phase 0).
//
// The automation lane schedules a ~200 ms lookahead of setValueAtTime /
// linearRampToValueAtTime events onto each mapped AudioParam. When control of a
// param changes hands — a lane stops, a clip switches away, or a hand grabs the
// knob — that queued "ghost tail" keeps driving the param for up to the whole
// lookahead window, so the param ignores the new owner for ~200 ms then freezes
// wherever the tail ended. The fix at every seam is a `cancelAndHoldAtTime`:
// truncate the schedule AT `atTime`, pinning the param at the value it would
// have there, so nothing fights the new owner.
//
// FIREFOX GOTCHA: `AudioParam.cancelAndHoldAtTime` is NOT implemented in Firefox
// (it ships `cancelScheduledValues` only). So we FEATURE-DETECT and, when it's
// absent, REIMPLEMENT cancel-and-hold: read the param's CURRENT computed value,
// cancel the schedule from `atTime`, and pin that value with `setValueAtTime`.
// (`cancelScheduledValues(t)` alone would leave the param drifting along the last
// ramp BEFORE `t`; we must actively re-pin the held value.)
//
// PURE + leaf: operates on a raw AudioParam-shaped object, no engine/Yjs, so the
// fallback path unit-tests against a mock param with no `cancelAndHoldAtTime`.

/** The subset of AudioParam this util touches (so a mock param satisfies it). */
export interface HoldableParam {
  /** Current computed value — used to re-pin in the Firefox fallback. */
  value: number;
  setValueAtTime(value: number, atTime: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
  /** Present on Chromium/WebKit; ABSENT on Firefox → triggers the fallback. */
  cancelAndHoldAtTime?(cancelTime: number): unknown;
}

/**
 * Truncate `param`'s scheduled ramp tail at `atTime`, holding it at the value it
 * has there. Uses the native `cancelAndHoldAtTime` when available; otherwise
 * (Firefox) reimplements it via `cancelScheduledValues` + a `setValueAtTime` of
 * the current computed value. Returns the value it pinned (the Firefox path) or
 * `undefined` when the native call handled it (the native path holds the
 * projected value, which we do not read back).
 *
 * NOTE the fallback reads `param.value`, which is the value at the audio clock's
 * CURRENT time; callers pass `atTime = ctx.currentTime` (a stop/touch is "now"),
 * so the pinned value is correct. A future `atTime` with the fallback would pin
 * the current value, not the projected one — acceptable for a near-now seam.
 */
export function holdParam(param: HoldableParam, atTime: number): number | undefined {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(atTime);
    return undefined;
  }
  // Firefox fallback: read the current value FIRST (before cancelling), then
  // cancel the future schedule and actively re-pin so the param doesn't keep
  // drifting along whatever ramp was already in flight.
  const current = param.value;
  param.cancelScheduledValues(atTime);
  param.setValueAtTime(current, atTime);
  return current;
}

/**
 * `holdParam` + optionally move to a NEW value: after truncating the tail, either
 * hard-set `toValue` at `atTime` (`glideS <= 0`) or de-zipper to it with a short
 * `linearRampToValueAtTime` over `glideS` (the hold-last-value + clip-switch
 * seam glides). Pass `toValue = null` to only truncate (the touch punch-in — the
 * new owner is live manual input, which writes the value itself).
 */
export function holdAndGlideParam(
  param: HoldableParam & { linearRampToValueAtTime(value: number, endTime: number): unknown },
  atTime: number,
  toValue: number | null,
  glideS: number,
): void {
  holdParam(param, atTime);
  if (toValue == null) return;
  if (glideS > 0) param.linearRampToValueAtTime(toValue, atTime + glideS);
  else param.setValueAtTime(toValue, atTime);
}
