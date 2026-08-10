// packages/web/src/lib/audio/modules/timelorde-transport-state.ts
//
// TIMELORDE's TRANSPORT STATE — the one place the rack's clock says which of
// its four states it is in, and the answer to "why is my whole rack stopped".
//
// ── THE MEASUREMENT THIS EXISTS FOR ──────────────────────────────────────
//
// `running = 0` (transport STOP) and `muteOutputs = 1` (the card's MUTE) are
// OBSERVATIONALLY IDENTICAL AT EVERY JACK. Measured on the real clock core,
// 4 s at 120 bpm, all 13 gate outputs: STOPPED, MUTED and STOPPED + MUTED are
// byte-identical — zero rising edges, zero peak, zero DC — while a running
// clock differs from all three. (Pinned in packages/dsp/src/lib/
// timelorde-clock-core.test.ts, "STOP and MUTE are indistinguishable AT THE
// JACKS".)
//
// They are not the same thing. STOP halts the phase accumulator: the sample
// counter, the pending pulses and the musical position all freeze, and nothing
// downstream advances. MUTE only zeroes the gate WRITES — the clock keeps
// turning underneath so LIVECODE's clocked() subscribers and every other tick
// consumer stay alive. A rack that is silent because of one is debugged
// completely differently from a rack that is silent because of the other, and
// TIMELORDE is a singleton every patch depends on.
//
// ── WHY A READOUT AND NOT A JACK ─────────────────────────────────────────
//
// Keeping one output alive under MUTE (a run indicator on 1x, say) would make
// the states separable with a patch cable — and would CHANGE WHAT A JACK
// EMITS. Every existing patch that relies on MUTE silencing everything would
// start receiving pulses it never used to get, on the rack's clock, which is
// the single worst place in the graph to change emission semantics. Adding new
// output ports would avoid that, but it takes TWO of them to separate four
// states (one bit each), permanently widens the singleton's contract, and
// gives nothing at all to a rack that is already wired.
//
// So the distinction is published where the player is already looking: a named
// state on the card, and the same string off the engine handle
// (`read('transportState')`) so tests and tooling read exactly what the card
// renders rather than re-deriving it.

/** The four states TIMELORDE's two transport params can be in. */
export type TimelordeTransportStateId = 'running' | 'stopped' | 'muted' | 'stopped-muted';

export interface TimelordeTransportState {
  /** Machine-readable id — the value published on `data-transport-state` and
   *  by the engine handle's `read('transportState')`. */
  id: TimelordeTransportStateId;
  /** The word the card prints. */
  label: string;
  /** The label plus the shortest true statement about the PHASE — the half a
   *  jack cannot report. Sized to fit one line of the 300 px card so the strip
   *  never changes height between states (a readout that reflows is a readout
   *  that moves every VRT baseline underneath it). */
  short: string;
  /** The full line, for the tooltip and the docs — what is actually true of the
   *  clock, because "no pulses" is the only thing the jacks can say and it is
   *  not enough. */
  detail: string;
}

/** Every state, in the order a UI would list them. Exported so a test can
 *  enumerate the real set rather than re-typing it (a hand-copied list is how
 *  a collapsed pair goes unnoticed). */
export const TIMELORDE_TRANSPORT_STATES: readonly TimelordeTransportState[] = [
  {
    id: 'running',
    label: 'RUNNING',
    short: 'RUNNING · gates live',
    detail: 'Clock advancing and gates live.',
  },
  {
    id: 'stopped',
    label: 'STOPPED',
    short: 'STOPPED · phase frozen',
    detail:
      'Transport HALTED: the phase accumulator is frozen, so nothing downstream advances. ' +
      'Un-muting will not help — this is a STOP, not a mute.',
  },
  {
    id: 'muted',
    label: 'MUTED',
    short: 'MUTED · clock turning',
    detail:
      'Gates MUTED but the clock is still turning underneath, so LIVECODE ticks and other ' +
      'tick subscribers are still firing. The jacks are silent; the transport is not stopped.',
  },
  {
    id: 'stopped-muted',
    label: 'STOPPED + MUTED',
    short: 'STOPPED + MUTED · frozen',
    detail:
      'BOTH: the transport is halted AND the gates are muted. Un-muting alone will not ' +
      'restart the rack — start the transport as well.',
  },
] as const;

/** The subset of a TIMELORDE node's params this derivation reads. Deliberately
 *  typed as the whole loose param bag: the function must be able to be handed
 *  `node.params` verbatim, so the "bpm does not move it" control is a real test
 *  of the derivation rather than a test of the caller's destructuring. */
export type TimelordeParamBag = Readonly<Record<string, number | undefined>>;

/** Interpret a discrete 0/1 param the way the worklet does (>= 0.5), falling
 *  back to `fallback` when the patch has never written it. */
function flag(v: number | undefined, fallback: 0 | 1): boolean {
  return (typeof v === 'number' ? v : fallback) >= 0.5;
}

/**
 * Derive TIMELORDE's transport state from its params.
 *
 * Reads EXACTLY `running` (default 1) and `muteOutputs` (default 0) and nothing
 * else — in particular not `bpm`, which is the spec's named negative control:
 * a clock at 300 bpm and a clock at 10 bpm are in the same transport state, and
 * a readout that moved with tempo would be reporting the wrong thing.
 *
 * All four combinations map to DISTINCT states. Collapsing STOPPED and MUTED
 * into one word would reproduce the exact ambiguity this exists to remove —
 * and it would pass any test written against the outputs, because the outputs
 * genuinely cannot tell them apart.
 */
export function timelordeTransportState(params: TimelordeParamBag): TimelordeTransportState {
  const running = flag(params['running'], 1);
  const muted = flag(params['muteOutputs'], 0);
  const id: TimelordeTransportStateId = running
    ? (muted ? 'muted' : 'running')
    : (muted ? 'stopped-muted' : 'stopped');
  // Non-null: the table above covers all four ids exhaustively, and
  // timelorde-transport-state.test.ts asserts that (a lookup miss would be a
  // silent undefined at render time otherwise).
  return TIMELORDE_TRANSPORT_STATES.find((s) => s.id === id)!;
}

/** True when the clock's phase is advancing — i.e. anything downstream that
 *  rides the tick bus (LIVECODE `clocked()`) is still being called, whether or
 *  not the gates are audible. This is the half of the state that a jack cannot
 *  report at all. */
export function timelordeClockIsTurning(params: TimelordeParamBag): boolean {
  return flag(params['running'], 1);
}
