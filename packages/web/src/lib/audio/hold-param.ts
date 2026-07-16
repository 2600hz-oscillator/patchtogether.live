// packages/web/src/lib/audio/hold-param.ts
//
// CANCEL-AND-HOLD / PIN utils for the clip-automation param-jump policy (Phase 0).
//
// The automation lane schedules a ~200 ms lookahead of setValueAtTime /
// linearRampToValueAtTime events onto each mapped AudioParam. When control of a
// param changes hands — a lane stops, a clip switches away, or a hand grabs the
// knob — the queued "ghost tail" would keep driving the param for up to the whole
// lookahead window. The fix depends on WHEN the seam is:
//
//  - a NEAR-NOW seam (touch grab, immediate stop/switch, transport stop):
//    cancel-and-hold AT now — truncate the tail, pin the current value.
//  - a FUTURE seam (a quantized switch at the next loop boundary, a switch-INTO
//    anchor at a scheduled step time): NEVER cancel. Cancelling at a future time
//    retro-deletes the outgoing clip's final in-flight ramp (a ramp's event time
//    is its END time, and the last point lands exactly AT the boundary →
//    `cancelScheduledValues(boundary)` removes it → an audible jump up to 200 ms
//    EARLY), and Chromium's native `cancelAndHoldAtTime(futureT)` inserts NO hold
//    event when nothing is scheduled after it (the normal relaunch-after-stop
//    state) — a silent no-op. A future seam instead PINS an explicit value with a
//    real `setValueAtTime` event at the seam time (identical on both engines).
//
// FIREFOX GOTCHA: `AudioParam.cancelAndHoldAtTime` is NOT implemented in Firefox
// (it ships `cancelScheduledValues` only). The near-now path FEATURE-DETECTS and,
// when it's absent, REIMPLEMENTS cancel-and-hold: read the param's CURRENT
// computed value BEFORE cancelling, cancel the schedule, and re-pin that value
// with `setValueAtTime`. (`cancelScheduledValues(t)` alone would leave the param
// drifting along the last ramp before `t`.)
//
// PURE + leaf: operates on a raw AudioParam-shaped object, no engine/Yjs, so both
// paths unit-test against mock params (with and without `cancelAndHoldAtTime`).

/** The subset of AudioParam these utils touch (so a mock param satisfies it). */
export interface HoldableParam {
  /** Current computed value — used to re-pin in the Firefox fallback. */
  value: number;
  setValueAtTime(value: number, atTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
  /** Present on Chromium/WebKit; ABSENT on Firefox → triggers the fallback. */
  cancelAndHoldAtTime?(cancelTime: number): unknown;
}

/** How close (seconds) `atTime` must be to `now` to count as a NEAR-NOW seam
 *  (cancel-and-hold) rather than a FUTURE seam (pin-only, never cancel). */
export const HOLD_NOW_EPS_S = 0.005;

/**
 * NEAR-NOW: truncate `param`'s scheduled ramp tail at `atTime`, holding it at the
 * value it has there. Uses the native `cancelAndHoldAtTime` when available;
 * otherwise (Firefox) reimplements it via `cancelScheduledValues` + a
 * `setValueAtTime` of the current computed value (read BEFORE cancelling, so the
 * pinned value is the audible one, not a post-cancel artifact). Returns the value
 * it pinned (the Firefox path) or `undefined` when the native call handled it.
 *
 * Callers MUST pass a near-now `atTime` — a future time here retro-deletes
 * in-flight ramps in the fallback (see the header). Future seams go through
 * `pinParamAt` / `holdParamAtSeam` instead.
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
 * FUTURE seam: pin `toValue` at `atTime` with a REAL event — `setValueAtTime`
 * (`glideS <= 0`) or a short de-zipper `linearRampToValueAtTime` reaching it at
 * `atTime + glideS`. NEVER cancels — nothing legitimate is scheduled past a
 * boundary seam, and a future-time cancel is destructive (fallback) or a no-op
 * (native); see the header. Works identically on both engines by construction.
 */
export function pinParamAt(
  param: HoldableParam,
  atTime: number,
  toValue: number,
  glideS: number,
): void {
  if (glideS > 0) param.linearRampToValueAtTime(toValue, atTime + glideS);
  else param.setValueAtTime(toValue, atTime);
}

/**
 * The one seam entry point: dispatches on WHEN the seam is.
 *
 *  - `atTime <= now + HOLD_NOW_EPS_S` (near-now): cancel-and-hold (`holdParam`,
 *    Firefox-safe), then optionally move to `toValue` — a hard set (`glideS<=0`)
 *    or a short glide. `toValue == null` ⇒ truncate-only (the touch punch-in —
 *    live manual input is the new writer).
 *  - else (future): `pinParamAt(toValue)` with NO cancel. `toValue == null` ⇒
 *    nothing to pin ⇒ no-op (the caller resolves an explicit value — e.g. the
 *    engine's knob cache — before calling; see AudioEngine.holdParam).
 */
export function holdParamAtSeam(
  param: HoldableParam,
  now: number,
  atTime: number,
  toValue: number | null,
  glideS: number,
): void {
  if (atTime <= now + HOLD_NOW_EPS_S) {
    holdParam(param, atTime);
    if (toValue == null) return;
    if (glideS > 0) param.linearRampToValueAtTime(toValue, atTime + glideS);
    else param.setValueAtTime(toValue, atTime);
    return;
  }
  if (toValue != null) pinParamAt(param, atTime, toValue, glideS);
}
