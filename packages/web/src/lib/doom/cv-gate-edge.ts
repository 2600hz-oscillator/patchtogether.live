// packages/web/src/lib/doom/cv-gate-edge.ts
//
// Pure edge-detector with hysteresis for CV-gate → key-down/up
// translation, used by the DOOM module's setParam path. Lives in its own
// file because (a) it's pure and trivially unit-testable without dragging
// in the WASM shim and (b) the same hysteresis pattern is likely to
// appear in future "CV gate → discrete event" modules.
//
// Why hysteresis instead of a simple > 0.5 threshold?
//
// Audio-rate CV (LFO ringing around 0.5, an attenuator-decayed gate
// hovering in the dead zone, noisy ADSR releases) can chatter on a
// single-threshold detector — making DOOM see hundreds of key-down/up
// events per frame for what the user sees as "one trigger". A wider
// dead band absorbs the chatter:
//
//   rise threshold = 0.6   → cross going UP fires key-down
//   fall threshold = 0.4   → cross going DOWN fires key-up
//   between → no state change (sticky)
//
// State is a single boolean per CV channel (the current "is-pressed"
// view). The state machine is tiny but having a tested helper makes the
// integration test trivial: we just feed in a sequence of CV samples
// and assert the emitted event stream matches.

/** Current "is-pressed" view of one CV channel. */
export interface EdgeState {
  pressed: boolean;
}

export interface EdgeEvent {
  /** True = key-down, false = key-up. */
  pressed: boolean;
}

/** Defaults match the plan: rise > 0.6, fall < 0.4. Exported so tests +
 *  callers can reach the same numbers. */
export const DEFAULT_RISE = 0.6;
export const DEFAULT_FALL = 0.4;

/**
 * Update `state` with a new CV sample. If the sample crosses an active
 * threshold, return an event; otherwise return null (no state change).
 * Mutates `state` in place — caller owns one state object per CV channel.
 *
 * Pure aside from the in-place mutation; identical (sample, state)
 * inputs always produce the same output.
 */
export function detectEdge(
  state: EdgeState,
  sample: number,
  riseThreshold: number = DEFAULT_RISE,
  fallThreshold: number = DEFAULT_FALL,
): EdgeEvent | null {
  if (!state.pressed && sample > riseThreshold) {
    state.pressed = true;
    return { pressed: true };
  }
  if (state.pressed && sample < fallThreshold) {
    state.pressed = false;
    return { pressed: false };
  }
  return null;
}

/** Helper: build a fresh edge state. Equivalent to `{ pressed: false }`
 *  but documents the contract + plays nicely with `new Map(CV_GATE_PORT_IDS.map(...))`. */
export function makeEdgeState(): EdgeState {
  return { pressed: false };
}
