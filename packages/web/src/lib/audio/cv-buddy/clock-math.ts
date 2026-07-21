// packages/web/src/lib/audio/cv-buddy/clock-math.ts
//
// PURE clock-pulse scheduling math for CV Buddy's hardware clock output.
//
// The clock is GENERATED (not divided from a patched input) at PPQN pulses per
// quarter note, phase-anchored to the AudioContext time origin (t=0) so
// successive scheduling ticks never drift or double-schedule a pulse: every
// pulse lands on the fixed grid k·period for integer k, and each tick asks only
// for the pulses inside its lookahead window. The owner instance places a short
// GATE (~5 ms high) on a ConstantSource at each returned edge time — a DIN-sync
// / analog-clock pulse for the ES-9's slot-8 jack.
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
 * The rising-edge times (AudioContext seconds) of every clock pulse that FALLS
 * INSIDE the half-open window [winStart, winEnd), for a clock running at `bpm`
 * / `ppqn` and shifted by `offsetMs` (± a few ms of manual latency trim).
 *
 * Pulses sit on the absolute grid k·period (k ≥ 0) shifted by offsetMs/1000, so
 * the phase is stable across successive scheduling ticks: a pulse is emitted iff
 * its actual time k·period + offset lies in the window. Returned times are
 * ascending. An invalid tempo (period = Infinity) or an empty/backwards window
 * yields [].
 */
export function pulseTimes(
  bpm: number,
  ppqn: number,
  offsetMs: number,
  winStart: number,
  winEnd: number,
): number[] {
  const period = pulsePeriodS(bpm, ppqn);
  if (!Number.isFinite(period) || period <= 0) return [];
  if (!(winEnd > winStart)) return [];
  const offsetS = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0;

  // Solve winStart ≤ k·period + offsetS < winEnd for integer k ≥ 0.
  const kMin = Math.max(0, Math.ceil((winStart - offsetS) / period));
  const kMaxExclusive = (winEnd - offsetS) / period; // strict upper bound
  const out: number[] = [];
  for (let k = kMin; k < kMaxExclusive; k++) {
    out.push(k * period + offsetS);
    if (out.length >= MAX_PULSES_PER_WINDOW) break;
  }
  return out;
}
