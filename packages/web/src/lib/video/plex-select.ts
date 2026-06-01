// packages/web/src/lib/video/plex-select.ts
//
// Pure selector-advance + gate-edge logic for the 4PlexVid router (the
// video sibling of the audio 4Plexer). Lives in its own file because the
// logic is pure + trivially unit-testable without dragging in WebGL, and
// the "gate rising-edge → advance discrete index" pattern is reused once
// per router output (and is a candidate for any future N-way routing
// module in either domain).
//
// Two pieces:
//   1. `advanceSelector` — the wrap-around rotate: index → (index+1) % N.
//      Identical semantics to the audio 4Plexer's per-output rotate.
//   2. `gateEdge` — a hysteresis rising-edge detector. A gate is a CV
//      signal; we only advance on the LOW→HIGH transition (so a held-high
//      gate advances exactly once, not every frame the CV bridge samples
//      it). Hysteresis (rise > 0.6, fall < 0.4) absorbs LFO/ADSR chatter
//      in the dead band — same rationale as the DOOM CV-gate detector
//      (see packages/web/src/lib/doom/cv-gate-edge.ts).

/** Number of inputs a 4PlexVid output can select between. */
export const PLEX_INPUTS = 4;

/**
 * Rotate a selector index to the next input, wrapping at `count`.
 * `0 → 1 → 2 → 3 → 0` for the default count of 4.
 *
 * Tolerates out-of-range / non-integer inputs (clamps + floors) so a
 * persisted param value that drifted can never produce an invalid index.
 */
export function advanceSelector(index: number, count: number = PLEX_INPUTS): number {
  const n = Math.max(1, Math.floor(count));
  const cur = ((Math.floor(index) % n) + n) % n; // normalize into [0, n)
  return (cur + 1) % n;
}

/** Mutable per-gate hysteresis state. One object per router output. */
export interface GateState {
  high: boolean;
}

/** Fresh gate state (not yet triggered). */
export function makeGateState(): GateState {
  return { high: false };
}

/** Defaults match the DOOM CV-gate detector: rise > 0.6, fall < 0.4. */
export const GATE_RISE = 0.6;
export const GATE_FALL = 0.4;

/**
 * Feed one CV sample into a gate state. Returns `true` exactly on the
 * rising edge (the LOW→HIGH crossing); `false` otherwise. Mutates `state`
 * in place — the caller owns one state per gate channel.
 *
 * Pure aside from the in-place mutation: identical (sample, state) inputs
 * always produce the same result.
 */
export function gateEdge(
  state: GateState,
  sample: number,
  rise: number = GATE_RISE,
  fall: number = GATE_FALL,
): boolean {
  if (!state.high && sample > rise) {
    state.high = true;
    return true; // rising edge — advance
  }
  if (state.high && sample < fall) {
    state.high = false;
  }
  return false;
}
