// packages/web/src/lib/audio/cv-buddy/clock-math.ts
//
// PURE clock-pulse scheduling math for CV Buddy's hardware clock output.
//
// The clock is GENERATED (not divided from a patched input) at PPQN pulses per
// quarter note. The owner instance places a short GATE (~5 ms high) on a
// ConstantSource at each returned edge time — a DIN-sync / analog-clock pulse
// for the ES-9's slot-8 jack.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ WHY THIS IS AN ACCUMULATOR AND NOT A GRID (owner-reported, 2026-08-07:
//   "Pam's locks to it but not flawlessly"; a Mandala MK2 downstream of Pam's
//   showed obvious missed triggers)
//
// The original design anchored every pulse to the ABSOLUTE AudioContext origin:
// pulse k landed at `k · period`, and each tick asked which k fell in its
// lookahead window. That is beautifully drift-free while the tempo never moves
// — and it TELEPORTS THE PHASE the instant the tempo moves at all, by an amount
// that grows with how long the context has been running.
//
// The arithmetic: pulse k sits at k·period, and k ≈ elapsed/period is large. A
// change of δ in the period moves that pulse by k·δ. After an hour at 120 BPM /
// 24 PPQN, k ≈ 172 800, so a period change of a few hundred nanoseconds — what
// you get from a 0.001 BPM nudge — moves the next pulse by TENS OF
// MILLISECONDS. Measured against the real `pulseTimes`, a 120.000 → 120.001 BPM
// change displaced the next pulse by 20.75 ms at 10 s of context age and
// 11.67 ms at an hour. One period at that tempo is 20.83 ms, so the jump is
// effectively UNIFORM RANDOM over a whole period: the pulse train stutters,
// skipping or doubling an edge, and everything clocked downstream stumbles.
//
// That is not a hypothetical nudge. `timelorde.ts` writes `livePatch.params.bpm`
// — the exact value `transportBpm()` reads — every time a followed external
// clock drifts by more than 0.1 BPM, and the BPM knob writes it on every frame
// of a drag.
//
// So the grid is replaced by a PHASE ACCUMULATOR: we remember when the NEXT
// pulse is due and step forward by the CURRENT period. A tempo change then
// alters the INTERVAL from the next pulse onward and never moves a pulse that
// was already due. Drift is not a concern in exchange — `next` is absolute
// AudioContext seconds advanced by exact addition, not a count of elapsed
// ticks, so there is no accumulating rounding term to drift.
//
// A second consequence, and an improvement: the accumulator anchors on the
// FIRST window after the transport starts, so the pulse train begins with play
// rather than at whatever arbitrary phase the t=0 grid happened to be in. The
// docs' claim that the clock is "phase-locked to TIMELORDE" is only true of the
// accumulator form.
//
// ⚠ WHAT THIS DOES *NOT* FIX. If the ES-9 bridge underruns, the jack's gate
// class HOLDS its last voltage (es9.ts), freezing an edge mid-pulse no matter
// how perfect the scheduling was. That is a separate, still-open mechanism with
// its own counter — the ES-9 card's `xruns` readout. `skipped` (below) exists
// so the two are TELLABLE APART from the UI instead of both presenting as
// "the clock is unstable".
//
// PURITY: only imports gate-trigger constants (themselves pure). Unit-tested
// against plain numbers (clock-math.test.ts).

import { TRIGGER_PULSE_S } from '$lib/audio/gate-trigger';

/** How long each generated clock pulse stays HIGH — 5 ms, the canonical short
 *  trigger/clock pulse width (reused from gate-trigger, within the 1–5 ms
 *  hardware band). The clock rides the unified `gate` cable. */
export const CLOCK_PULSE_HIGH_S = TRIGGER_PULSE_S;

/** Hard cap on pulses returned from a single window, so a degenerate
 *  (tiny-period / huge-window) call can't allocate unbounded work. A real
 *  lookahead window is tens of ms, so this is never hit in practice. */
const MAX_PULSES_PER_WINDOW = 512;

/**
 * Seconds between clock pulses at `bpm` and `ppqn` pulses-per-quarter-note:
 * one quarter note is 60/bpm seconds, divided into `ppqn` pulses.
 * Returns Infinity for non-finite / non-positive inputs (caller schedules
 * nothing).
 */
export function pulsePeriodS(bpm: number, ppqn: number): number {
  if (!Number.isFinite(bpm) || !Number.isFinite(ppqn) || bpm <= 0 || ppqn <= 0) {
    return Infinity;
  }
  return 60 / bpm / ppqn;
}

/**
 * The running phase of the generated clock.
 *
 * `next` is the UNSHIFTED time of the next pulse in AudioContext seconds, or
 * `null` when the clock is stopped/unstarted and should re-anchor on its next
 * window. Unshifted means the manual `clockOffsetMs` trim is applied at EMIT,
 * not baked in — so nudging the trim moves the pulses by exactly the trim
 * delta (which is the point of a latency trim) instead of dragging the phase
 * along with it.
 */
export interface ClockPhase {
  next: number | null;
}

/** A stopped clock. `advanceClock` anchors it to the first window it sees. */
export function idleClockPhase(): ClockPhase {
  return { next: null };
}

export interface ClockAdvance {
  /** Rising-edge times (AudioContext s) inside the window, ascending. */
  pulses: number[];
  /** Phase to carry into the next call. */
  phase: ClockPhase;
  /**
   * Pulses that came due BEFORE `winStart` and so could not be scheduled —
   * the tick arrived later than the lookahead could cover.
   *
   * This path was previously silent: the old code clamped the window start
   * forward and the missed pulses simply never happened, with nothing counted
   * and nothing logged. A gap in the pulse train is precisely the reported
   * symptom, so it must be COUNTABLE — otherwise a scheduling stall and a
   * bridge underrun are indistinguishable from the jack.
   */
  skipped: number;
}

/**
 * Advance the clock across the half-open window `[winStart, winEnd)`.
 *
 * Pure: takes a phase, returns the pulses in this window plus the phase to use
 * next time. Never mutates the phase passed in.
 */
export function advanceClock(
  phase: ClockPhase,
  bpm: number,
  ppqn: number,
  offsetMs: number,
  winStart: number,
  winEnd: number,
): ClockAdvance {
  const period = pulsePeriodS(bpm, ppqn);
  // A degenerate tempo schedules nothing AND holds the phase, so recovering a
  // sane tempo resumes where it left off rather than jumping.
  if (!Number.isFinite(period) || period <= 0) {
    return { pulses: [], phase: { next: phase.next }, skipped: 0 };
  }
  if (!(winEnd > winStart)) return { pulses: [], phase: { next: phase.next }, skipped: 0 };

  const offsetS = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0;

  // Unstarted → the train begins at the top of this window, so the clock
  // starts WITH the transport instead of at an arbitrary grid phase.
  let base = phase.next ?? winStart - offsetS;

  // Late tick: pulses that were due before this window cannot be placed in the
  // past. Count them and catch the phase up in one step — a loop here would be
  // unbounded work after a long stall.
  let skipped = 0;
  const firstDue = base + offsetS;
  if (firstDue < winStart) {
    skipped = Math.ceil((winStart - firstDue) / period);
    base += skipped * period;
  }

  // `base` always points at the NEXT unshifted pulse, so whether the loop ends
  // by leaving the window or by hitting the cap, the phase carried out is the
  // pulse we have not emitted yet.
  const pulses: number[] = [];
  while (base + offsetS < winEnd) {
    pulses.push(base + offsetS);
    base += period;
    if (pulses.length >= MAX_PULSES_PER_WINDOW) break;
  }

  return { pulses, phase: { next: base }, skipped };
}
