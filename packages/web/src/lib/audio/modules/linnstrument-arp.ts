// LINNSTRUMENT ARP ADAPTER — a caller-owned TRANSPORT over the pure
// `arp-engine` (createArpState / arpSetHeld / arpAdvance), one instance per
// musical region (keys, pad). NOT the Launchpad's singleton: that engine is
// bound to `launchpad-control`'s KEYS view and its `pushAudition` seam, and
// this module must never reach into it (design.md D16, implementation-plan WP5).
//
// What the pure engine deliberately does NOT carry, and this adapter adds:
//
//   TOUCH PROVENANCE + DUPLICATE-PITCH REFCOUNT. `expandPool` dedupes by
//   PITCH (arp-engine.ts `expandPool` builds a Set of MIDI numbers), so two
//   touches of the same pitch — two voices on the bus (D13) — are ONE arp
//   note. The refcount lives OUTSIDE the engine: a pitch stays in the held set
//   while ANY touch holds it, so releasing one of two same-pitch fingers keeps
//   the note (V13's refcount half), and the physical set handed to
//   `arpSetHeld` is the set of pitches with a non-zero count.
//
//   EXPRESSION OWNER PER GENERATED NOTE. Every note the arp plays names the
//   ONE source touch whose expression it carries (V12: "one source touch owns
//   expression per generated note"): the oldest live touch holding the source
//   pitch, where the source pitch of an octave-expanded note is the held pitch
//   it was copied from. A LATCH SNAPSHOT keeps the owner's last expression
//   after the finger has gone, so a latched note does not lose its pressure
//   and timbre the instant the touch ends.
//
//   A REAL GATE-LOW INTERVAL. Every step is written through the PolySender
//   shape `scheduleStep(at, lanes, gateOffSec)` with `gateOffSec > 0` (poly.ts
//   161-166 schedules the gate-down event), so a one-note arp produces
//   audible attacks with genuine gate-low samples between them (V13). The
//   pure engine's noteOff is therefore implied by the previous step's
//   scheduled gate-down and is NOT written as a second edge.
//
//   CANCELLATION. `cancel()` silences the sink now, drops the running note and
//   the step clock, so stop / latch-off end both the active note and every
//   future one — the latched set and the touches SURVIVE, which is what an
//   arp-off + arp-on round trip wants. `reset()` is the stronger one: it also
//   forgets every touch and the engine's frozen (latched) set, so PANIC and
//   an unplug leave NOTHING for the next tick to resurrect (2026-09-15 review
//   F01: `cancel` alone kept a released, latched pool and the next service
//   re-anchored the clock and played it again).
//
//   TICKING. `service({ nowMs, audioTime, bpm })` is called from the module's
//   scheduler-clock subscription (~25 ms, tick-granular exactly like the
//   Launchpad's `serviceArp`) at the TIMELORDE bpm the caller reads; the step
//   period comes from `arpStepPeriod` so the division table is the engine's.
//
//   THE LATE-STEP POLICY. A service call plays AT MOST ONE step. When a stalled
//   tick (a busy main thread, a backgrounded tab, a division that just got
//   much shorter) finds more than one step due, the backlog is NOT replayed:
//   the next note in sequence plays once at `audioTime + lookahead` and the
//   step clock re-anchors to now. Replaying the backlog at one instant stacks
//   every attack on the same audio time — a gate written 1, 0, 1 at one
//   timestamp is not an edge at all (review F07: a 400 ms stall at a 125 ms
//   division scheduled three steps on one timestamp); replaying it at
//   distinct future instants plays a burst nobody asked for. Skipping
//   nothing and shifting the grid keeps every note of the pattern and the
//   real gate-low interval between attacks.
//
// PURE + engine-free: the sink is an interface, so the adapter is unit-tested
// with a recording fake and the module wires a real `createPolySender`.

import {
  arpAdvance,
  arpSetHeld,
  arpSetParams,
  arpStepPeriod,
  createArpState,
  type ArpParams,
  type ArpState,
} from '$lib/audio/arp-engine';
import { midiToVOct } from '$lib/audio/note-entry';
import { POLY_CHANNEL_PAIRS } from '$lib/audio/poly';

/** The touch identity the module hands us — the same generation id that keys
 *  the voice allocator, so provenance and voice identity agree by construction. */
export type ArpTouchId = number;

export interface ArpExpression {
  velocity: number;
  pressure: number;
  timbre: number;
  /** Signed semitones — the generated note's pitch CV includes it. */
  bend: number;
}

/** The sink one arp instance writes — `PolySender`'s scheduling half. */
export interface ArpSink {
  scheduleStep(
    at: number,
    lanes: ReadonlyArray<{ pitch: number; gate: 0 | 1 }>,
    gateOffSec: number,
  ): void;
  silence(now: number): void;
}

export interface ArpServiceInput {
  /** Monotonic wall clock, ms (performance.now()). */
  nowMs: number;
  /** AudioContext.currentTime, seconds — steps are scheduled `lookaheadS` past it. */
  audioTime: number;
  /** TIMELORDE bpm the caller read. */
  bpm: number;
}

/** One generated step, returned so the module can align card-api expression
 *  lanes with what the bus is playing. */
export interface ArpPlayed {
  at: number;
  note: number;
  /** The touch whose expression this note carries, or null when the held set
   *  came from a snapshot whose owner is no longer known. */
  owner: ArpTouchId | null;
  expression: ArpExpression;
  gateOffSec: number;
}

export interface LinnArpSnapshot {
  enabled: boolean;
  running: boolean;
  params: ArpParams;
  /** Pitches with a non-zero refcount. */
  held: number[];
  /** The engine's effective (post-latch) held set. */
  effective: number[];
  playing: number | null;
  owner: ArpTouchId | null;
}

export interface LinnArp {
  setParams(partial: Partial<ArpParams>): void;
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  touchStart(touch: ArpTouchId, note: number, expression?: Partial<ArpExpression>): void;
  touchExpression(touch: ArpTouchId, expression: Partial<ArpExpression>): void;
  touchEnd(touch: ArpTouchId): void;
  /** Drive the transport: schedules AT MOST ONE step per call (header: THE
   *  LATE-STEP POLICY). Returns the steps it played. */
  service(input: ArpServiceInput): ArpPlayed[];
  /** Stop now: silence the sink, drop the running note and the step clock.
   *  The touches and a latched set survive (arp off → on resumes them). */
  cancel(audioTime: number): void;
  /** PANIC / unplug / session end: forget every touch AND the engine's
   *  frozen (latched) set, then cancel — nothing is left for the next tick. */
  reset(audioTime: number): void;
  snapshot(): LinnArpSnapshot;
}

export interface LinnArpOptions {
  params?: Partial<ArpParams>;
  /** Seconds a scheduled step is placed ahead of `audioTime` (the shared
   *  MIDI lookahead by default). */
  lookaheadS?: number;
  /** Which poly lane the generated note occupies. Lane 0 is "the root note by
   *  convention" (poly.ts) and what a mono `pitch` sink pulls. */
  lane?: number;
  /** Fraction of the step period the gate stays HIGH (0 < ratio < 1). */
  gateRatio?: number;
}

const DEFAULT_LOOKAHEAD_S = 0.025;
const DEFAULT_GATE_RATIO = 0.5;
/** The shortest gate-low interval a step may schedule, seconds — one render
 *  quantum at 48 kHz, so `gateOffSec` can never collapse the low interval to
 *  zero even at the 8× division of a fast tempo. */
const MIN_GATE_LOW_S = 128 / 48000;

const DEFAULT_EXPRESSION: ArpExpression = { velocity: 0.8, pressure: 0, timbre: 0.5, bend: 0 };

interface HeldTouch {
  touch: ArpTouchId;
  note: number;
  /** Arrival order, for "the OLDEST live touch owns the note". */
  seq: number;
  expression: ArpExpression;
  live: boolean;
}

export function createLinnArp(opts: LinnArpOptions = {}): LinnArpWithSink {
  const lookaheadS = opts.lookaheadS ?? DEFAULT_LOOKAHEAD_S;
  const lane = Math.max(0, Math.min(POLY_CHANNEL_PAIRS - 1, opts.lane ?? 0));
  const gateRatio = Math.min(0.95, Math.max(0.05, opts.gateRatio ?? DEFAULT_GATE_RATIO));

  let state: ArpState = createArpState(opts.params);
  let enabled = false;
  let sink: ArpSink | null = null;
  let seq = 0;
  /** Every touch we know about — live ones count toward the held set; ended
   *  ones survive only while their pitch is in the engine's latched set (the
   *  latch SNAPSHOT), so a generated note keeps an expression owner. */
  const touches = new Map<ArpTouchId, HeldTouch>();
  let nextStepMs = 0;
  let lastOwner: ArpTouchId | null = null;

  const api: LinnArp = {
    setParams(partial) {
      state = arpSetParams(state, partial);
      pruneSnapshot();
    },
    setEnabled(on) {
      if (enabled === on) return;
      enabled = on;
      if (!on) stopNow();
    },
    get enabled() {
      return enabled;
    },
    touchStart(touch, note, expression) {
      if (!Number.isFinite(note)) return;
      const m = Math.round(note);
      touches.set(touch, {
        touch,
        note: m,
        seq: ++seq,
        expression: { ...DEFAULT_EXPRESSION, ...expression },
        live: true,
      });
      rebuildHeld();
    },
    touchExpression(touch, expression) {
      const t = touches.get(touch);
      if (!t) return;
      t.expression = { ...t.expression, ...expression };
    },
    touchEnd(touch) {
      const t = touches.get(touch);
      if (!t) return;
      t.live = false;
      rebuildHeld();
    },
    service(input) {
      const played: ArpPlayed[] = [];
      if (!enabled || !sink) return played;
      if (state.pool.length === 0) {
        // Nothing to play: flush the engine's pending note-off so `playing`
        // clears; the gate already closed on its own scheduled gate-down.
        if (state.playing !== null) state = arpAdvance(state).state;
        nextStepMs = 0;
        lastOwner = null;
        return played;
      }
      const bpm = Number.isFinite(input.bpm) && input.bpm > 0 ? input.bpm : 120;
      const beatMs = (60 / bpm) * 1000;
      const stepMs = arpStepPeriod(beatMs, state.params.divisionIndex);
      const now = input.nowMs;
      if (nextStepMs === 0) nextStepMs = now;
      if (now < nextStepMs) return played;
      // THE LATE-STEP POLICY (header): more than one step due means a stalled
      // tick — re-anchor the grid to now and play the next note ONCE. The
      // in-time case (exactly one step due) keeps its grid.
      if (now - nextStepMs >= stepMs) nextStepMs = now;
      const step = arpAdvance(state);
      state = step.state;
      if (step.noteOn !== undefined) {
        const owner = ownerOf(step.noteOn);
        const expr = owner ? owner.expression : DEFAULT_EXPRESSION;
        const at = input.audioTime + lookaheadS;
        const stepS = stepMs / 1000;
        // A REAL gate-low interval: high for `gateRatio` of the step, and
        // never so long that the low part vanishes.
        const gateOffSec = Math.max(MIN_GATE_LOW_S, Math.min(stepS - MIN_GATE_LOW_S, stepS * gateRatio));
        const lanes: { pitch: number; gate: 0 | 1 }[] = [];
        for (let i = 0; i < POLY_CHANNEL_PAIRS; i++) lanes.push({ pitch: 0, gate: 0 });
        lanes[lane] = { pitch: midiToVOct(step.noteOn + expr.bend), gate: 1 };
        sink.scheduleStep(at, lanes, gateOffSec);
        lastOwner = owner ? owner.touch : null;
        played.push({ at, note: step.noteOn, owner: lastOwner, expression: { ...expr }, gateOffSec });
      }
      nextStepMs += stepMs;
      return played;
    },
    cancel(audioTime) {
      stopNow(audioTime);
    },
    reset(audioTime) {
      touches.clear();
      state = arpSetHeld({ ...state, physical: [], held: [] }, []);
      state = { ...state, pool: [], cursor: 0, playing: null };
      stopNow(audioTime);
    },
    snapshot() {
      return {
        enabled,
        running: enabled && state.pool.length > 0,
        params: { ...state.params },
        held: heldPitches(),
        effective: [...state.held],
        playing: state.playing,
        owner: lastOwner,
      };
    },
  };

  /** Pitches with a non-zero LIVE refcount, sorted. */
  function heldPitches(): number[] {
    const out = new Set<number>();
    for (const t of touches.values()) if (t.live) out.add(t.note);
    return [...out].sort((a, b) => a - b);
  }

  function rebuildHeld(): void {
    state = arpSetHeld(state, heldPitches());
    pruneSnapshot();
  }

  /** Drop ended touches whose pitch the engine no longer holds — the latch
   *  snapshot keeps an owner exactly as long as the note it owns. */
  function pruneSnapshot(): void {
    const kept = new Set(state.held);
    for (const [id, t] of touches) {
      if (!t.live && !kept.has(t.note)) touches.delete(id);
    }
  }

  /** The owner of a generated note: the oldest touch (live first) holding the
   *  source pitch the note was octave-copied from. */
  function ownerOf(note: number): HeldTouch | null {
    let best: HeldTouch | null = null;
    let bestDist = Infinity;
    for (const t of touches.values()) {
      const d = note - t.note;
      if (d % 12 !== 0) continue;
      const dist = Math.abs(d);
      const better =
        best === null
        || dist < bestDist
        || (dist === bestDist && ((t.live && !best.live) || (t.live === best.live && t.seq < best.seq)));
      if (better) {
        best = t;
        bestDist = dist;
      }
    }
    return best;
  }

  function stopNow(audioTime = 0): void {
    if (sink) sink.silence(audioTime);
    if (state.playing !== null) state = { ...state, playing: null };
    nextStepMs = 0;
    lastOwner = null;
  }

  return Object.assign(api, {
    /** Attach the sink. Separate from construction so a module can build its
     *  arps before its senders and tests can swap a recorder in. */
    attach(next: ArpSink | null): void {
      sink = next;
    },
  });
}

/** The attach half of `createLinnArp`'s return, typed for callers that need it. */
export type LinnArpWithSink = LinnArp & { attach(next: ArpSink | null): void };

/** Read `keys_arp_dir`-style param values into the engine's vocabulary. */
export const ARP_DIRECTIONS = ['up', 'down', 'updown'] as const satisfies readonly ArpParams['direction'][];

export function arpDirectionFromIndex(v: unknown): ArpParams['direction'] {
  const i = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return ARP_DIRECTIONS[Math.max(0, Math.min(ARP_DIRECTIONS.length - 1, i))]!;
}
