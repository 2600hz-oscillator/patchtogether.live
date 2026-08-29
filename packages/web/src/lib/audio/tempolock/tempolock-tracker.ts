// packages/web/src/lib/audio/tempolock/tempolock-tracker.ts
//
// PURE tempo-tracking math for TEMPOLOCK — gate onsets in, a steady tracked
// quarter-note clock out. The cv-buddy `clock-math.ts` shape: no AudioContext,
// no timers, no Math.random / Date.now — every quantity arrives as an argument
// and every decision is unit-testable against plain numbers
// (tempolock-tracker.test.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ WHY THIS IS NOT A LAST-INTERVAL FOLLOWER (the owner's report, 2026-08-29)
//
// The rack's existing clock consumers — TIMELORDE's CLOCK IN and backdraft's
// delay_clock — lock to the gap between the LAST TWO rising edges. That is
// correct for a clock cable (a pulse train that IS the tempo) and wrong for a
// beat cable (a pulse train that IMPLIES the tempo): SYNESTHESIA's per-band
// onset trigger fires on every kick, and real kick patterns are not
// four-on-the-floor. The owner's concrete case: 108 BPM, kicks on steps
// 1,5,7,9,13,15 of a 16-step bar → inter-onset gaps of 555.6 / 277.8 / 277.8 /
// 555.6 / 277.8 / 277.8 ms → a last-interval follower flaps between 216 and
// 108 BPM forever (pinned as this module's negative control in the test).
//
// The tracker instead treats inter-onset intervals as INTEGER MULTIPLES of an
// unknown base pulse, recovers that pulse with a tolerance-window
// greatest-common-pulse fit, folds it into a preferred BPM band by octave, and
// then runs a phase accumulator that EMITS ITS OWN steady quarter-note clock —
// never a passthrough of input edges — with gentle PLL-style phase correction
// from onsets that land near predicted beats or half-beats. The eighth-note
// kicks in the owner's pattern are ON the half-beat grid: they are evidence,
// not noise. Onsets far off-grid are ignored.
//
// ── THE STATE MACHINE ──────────────────────────────────────────────────────
//
//   cold    no lock has ever been declared. NO CLOCK — the module is silent
//           until it has evidence (see the fixture-7 argument in the test:
//           a free-running default tempo would inject a wrong clock into a
//           rack the moment the module spawns, before any input arrived).
//   locked  confident lock: the clock runs and `locked` is high.
//   coast   the input went silent (or stopped making sense) AFTER a lock:
//           the clock FREE-RUNS at the last locked tempo — the whole rack may
//           be synced to this output, so the clock never stops — while
//           `locked` drops after MISSED_BEATS_UNLOCK expected beats. Fresh
//           on-grid onsets (2 in a row) relock without touching the phase; a
//           fresh consistent interval run at a NEW tempo re-locks through the
//           ordinary estimator with a re-anchor.
//
// PURITY: imports nothing. All constants live here so the module def, the
// status body and the tests read one copy.

/** A preferred tempo band for the octave fold, half-open: [min, max). */
export interface TempolockBand {
  readonly min: number;
  readonly max: number;
}

/** The selectable fold bands (the `range` param indexes this list). The
 *  default 90–180 covers the owner's 108 case and most dance-floor tempi;
 *  60–120 halves everything for downtempo/half-time reads of the same
 *  pattern; 120–240 doubles for footwork/DnB reads. */
export const TEMPOLOCK_BANDS: readonly TempolockBand[] = [
  { min: 60, max: 120 },
  { min: 90, max: 180 },
  { min: 120, max: 240 },
];
export const TEMPOLOCK_DEFAULT_BAND_INDEX = 1;

/** Onsets closer together than this are duplicates/flams of one strike
 *  (spectral-flux detectors double-fire on soft attacks); they are ignored
 *  outright. 70 ms sits below the fastest musical base pulse the fold bands
 *  can reach (a sixteenth at 240 BPM = 62.5 ms is folded UP from its
 *  multiples, never observed directly as consecutive onsets by design —
 *  and a real pattern that dense reads as its eighth grid anyway). */
export const TEMPOLOCK_MIN_IOI_S = 0.07;

/** An inter-onset gap longer than this is a DROPOUT, not an interval: it is
 *  not pushed into the interval history (a 2-bar rest is not evidence of a
 *  tempo), and the history restarts on the far side of it. */
export const TEMPOLOCK_MAX_IOI_S = 3.0;

/** How many recent accepted intervals the estimator looks at. */
export const TEMPOLOCK_IOI_HISTORY = 32;

/** The shorter window the LOCKED-mode tempo follow consults when the tempo
 *  is MOVING (see the call site): long enough to span one full cycle of the
 *  owner's 3-1-2-2 pattern, short enough to trail a ramp by only a couple of
 *  intervals. */
export const TEMPOLOCK_FOLLOW_WINDOW = 8;

/** Steady-vs-agile divergence (|log2 ratio|) beyond which the follow deems
 *  the tempo to be moving and switches to the agile window. ~1.4% — above
 *  the agile fit's own noise on a real groove (±1.1% measured), far below a
 *  ramp's steady-vs-agile split (~5% on the 108→120 fixture). */
export const TEMPOLOCK_TREND_LOG2 = 0.02;

/** Interval-consistency tolerance: an interval matches m × base when it is
 *  within max(REL × m × base, ABS) of it. The relative half is the musical
 *  tolerance (~±5%); the absolute floor absorbs scheduler-tick quantisation —
 *  onset timestamps arrive at the ~25 ms tick, so a single interval can be
 *  off by up to ~±25 ms even when the player is perfect. */
export const TEMPOLOCK_TOL_REL = 0.05;
export const TEMPOLOCK_TOL_ABS_S = 0.032;

/** How many consistent intervals are required before a lock is declared. */
export const TEMPOLOCK_MIN_LOCK_INTERVALS = 4;
/** ...and what fraction of the recent history must be consistent. */
export const TEMPOLOCK_MIN_LOCK_SCORE = 0.8;

/** PLL phase-correction gain: the fraction of an on-grid onset's phase error
 *  applied to the next pulse. Small enough that tick-quantisation noise
 *  (±12.5 ms per onset) moves the clock by a few ms at most; large enough
 *  that a constant phase offset dies within a few beats. */
export const TEMPOLOCK_PLL_GAIN = 0.25;

/** Second-order PLL term: the fraction of an on-grid phase error ALSO folded
 *  into the period. Without it the tracker is a first-order loop whose only
 *  frequency input is the interval estimator — which averages the last
 *  TEMPOLOCK_IOI_HISTORY intervals and therefore TRAILS a moving tempo by
 *  half its window. Measured on the 108→120 ramp fixture: the trailing
 *  target left ~5% of steady phase drift per beat, the on-grid window (6%)
 *  starved, and the tracker degenerated into re-anchor hopping — pulse
 *  intervals down to 0.75 beat. The frequency term closes that loop the way
 *  every hardware PLL does; its per-onset effect is bounded below the slew
 *  cap so noise cannot whip the period. */
export const TEMPOLOCK_PLL_FREQ_GAIN = 0.04;

/** An onset counts as ON-GRID evidence when it lands within
 *  max(6% of a beat, 30 ms) of a predicted beat or half-beat. */
export function tempolockOnGridWindowS(quarterS: number): number {
  return Math.max(0.06 * quarterS, 0.03);
}

/** Consecutive expected beats with no on-grid onset before `locked` drops
 *  (the clock itself keeps free-running — coast, not stop). */
export const TEMPOLOCK_MISSED_BEATS_UNLOCK = 4;

/** On-grid onsets in a row that relock a coasting tracker whose tempo still
 *  fits the incoming train. */
export const TEMPOLOCK_COAST_RELOCK_ONSETS = 2;

/** Consecutive OFF-grid onsets (while the interval history still fits one
 *  base pulse) that force a phase RE-ANCHOR onto the incoming train.
 *
 *  ⚠ WHY THIS EXISTS — the quarter-beat trap, measured on the owner's real
 *  recording. Intervals alone cannot say which onset is a beat, so the first
 *  lock anchors on whatever onset completed the estimate. When that onset
 *  sits on an ODD sixteenth of the true grid, every predicted beat and
 *  half-beat lands a quarter-beat off — the exact midpoint between grid
 *  points — so the PLL never sees a correctable error and the lock starves
 *  into coast while the tempo is RIGHT. Three consecutive off-grid onsets
 *  against a still-consistent history is that signature (the owner pattern's
 *  longest legitimate off-grid run under a quarter-shifted anchor is 3), and
 *  the repair is to snap the phase to the train rather than wait out a
 *  ~half-beat of tempo-error drift. */
export const TEMPOLOCK_REANCHOR_OFFGRID_ONSETS = 3;

/** Maximum relative tempo change applied per accepted onset. At the owner's
 *  onset densities (~1.5 onsets per beat) this follows a 108→120 ramp in
 *  well under two bars while bounding the output jitter a noisy interval can
 *  cause to ±1.5% of a beat. */
export const TEMPOLOCK_TEMPO_SLEW = 0.008;

/** Octave-fold hysteresis: while locked, a re-estimated tempo may stay in the
 *  octave nearest the CURRENT lock as long as it sits within the band
 *  stretched by this factor on both edges. A borderline pattern (say 176 BPM
 *  drifting to 184 against a 90–180 band) therefore does NOT flip down an
 *  octave mid-performance; only an unlocked (cold) fold is strict. */
export const TEMPOLOCK_OCTAVE_HYST = 1.12;

/** Hard cap on pulses returned from one window (degenerate-input guard —
 *  the cv-buddy clock-math precedent). */
const MAX_PULSES_PER_WINDOW = 64;

/** Base-pulse candidates are only considered in this window (seconds).
 *  0.05 s = a sixteenth at 300 BPM; 1.5 s = a quarter at 40 BPM. */
const BASE_MIN_S = 0.05;
const BASE_MAX_S = 1.5;
/** Integer multiples considered when deriving candidates from one interval. */
const MAX_CANDIDATE_DIV = 4;
/** Largest multiple an interval may be of the base pulse and still count. */
const MAX_MULTIPLE = 8;

/** Strictly fold a raw pulse-level tempo into [band.min, band.max) by
 *  octaves. Exported for the octave-choice fixtures. */
export function tempolockFoldStrict(rawBpm: number, band: TempolockBand): number {
  if (!Number.isFinite(rawBpm) || rawBpm <= 0) return band.min;
  let bpm = rawBpm;
  for (let i = 0; i < 12 && bpm >= band.max; i++) bpm /= 2;
  for (let i = 0; i < 12 && bpm < band.min; i++) bpm *= 2;
  return bpm;
}

/**
 * Fold WITH hysteresis toward an existing lock: among the raw tempo's octave
 * family, prefer the member closest (in log space) to `currentBpm`, accepting
 * it as long as it sits inside the band stretched by TEMPOLOCK_OCTAVE_HYST.
 * With no current lock this is the strict fold. Exported for fixture 6.
 */
export function tempolockFoldWithHysteresis(
  rawBpm: number,
  currentBpm: number | null,
  band: TempolockBand,
): number {
  if (currentBpm === null) return tempolockFoldStrict(rawBpm, band);
  const lo = band.min / TEMPOLOCK_OCTAVE_HYST;
  const hi = band.max * TEMPOLOCK_OCTAVE_HYST;
  let best: number | null = null;
  let bestDist = Infinity;
  for (let k = -6; k <= 6; k++) {
    const c = rawBpm * Math.pow(2, k);
    if (c < lo || c >= hi) continue;
    const dist = Math.abs(Math.log2(c / currentBpm));
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best ?? tempolockFoldStrict(rawBpm, band);
}

/**
 * Greatest-common-pulse fit over recent inter-onset intervals.
 *
 * Real patterns place onsets on a metric grid, so their intervals are integer
 * multiples of one base pulse. Candidates are every interval divided by
 * 1..MAX_CANDIDATE_DIV; scanning candidates LARGEST-FIRST returns the
 * greatest pulse that explains the history (so a pure quarter train reads as
 * quarters, not as its own half). A candidate must explain at least
 * TEMPOLOCK_MIN_LOCK_SCORE of the history with at least
 * TEMPOLOCK_MIN_LOCK_INTERVALS members; the winner is refined by the
 * least-squares estimate Σinterval / Σmultiple over its consistent members.
 *
 * Returns the refined base pulse in seconds, or null when the history is too
 * short or too inconsistent — which is exactly the "do not lock yet" signal.
 * Exported for the fixture tests.
 */
export function tempolockEstimateBasePulse(
  iois: readonly number[],
  window: number = TEMPOLOCK_IOI_HISTORY,
): number | null {
  if (iois.length < TEMPOLOCK_MIN_LOCK_INTERVALS) return null;
  const recent = iois.slice(-window);

  // Candidate base pulses, deduped within 4%, largest first.
  const candidates: number[] = [];
  for (const v of recent) {
    for (let k = 1; k <= MAX_CANDIDATE_DIV; k++) {
      const c = v / k;
      if (c >= BASE_MIN_S && c <= BASE_MAX_S) candidates.push(c);
    }
  }
  candidates.sort((a, b) => b - a);
  const deduped: number[] = [];
  for (const c of candidates) {
    if (deduped.length === 0 || deduped[deduped.length - 1]! / c > 1.04) deduped.push(c);
  }

  for (const c of deduped) {
    const members: Array<{ v: number; m: number }> = [];
    for (const v of recent) {
      const m = Math.round(v / c);
      if (m < 1 || m > MAX_MULTIPLE) continue;
      const tol = Math.max(TEMPOLOCK_TOL_REL * m * c, TEMPOLOCK_TOL_ABS_S);
      if (Math.abs(v - m * c) > tol) continue;
      members.push({ v, m });
    }
    if (
      members.length >= TEMPOLOCK_MIN_LOCK_INTERVALS &&
      members.length / recent.length >= TEMPOLOCK_MIN_LOCK_SCORE
    ) {
      let sumIoi = 0;
      let sumM = 0;
      for (const { v, m } of members) {
        sumIoi += v;
        sumM += m;
      }
      return sumIoi / sumM;
    }
  }
  return null;
}

export type TempolockMode = 'cold' | 'locked' | 'coast';

/** What one tick advances to. `pulses` are absolute rising-edge times inside
 *  the caller's half-open window, ascending — the caller schedules a short
 *  gate at each. */
export interface TempolockTickResult {
  pulses: number[];
  /** Tracked quarter-note tempo; null before the first lock ever. */
  bpm: number | null;
  /** High while the tracker is confidently locked. */
  locked: boolean;
  mode: TempolockMode;
  /** Pulses that came due before the window could place them (late tick) —
   *  counted, never silently dropped (the cv-buddy `skipped` discipline). */
  skipped: number;
}

export interface TempolockTickArgs {
  /** Current time, seconds (the scheduler tick's `ctx.currentTime`). */
  nowS: number;
  /** Rising edges detected since the previous tick. Multiple edges within one
   *  ~25 ms tick are one onset (they sit inside the flam-blanking window by
   *  construction). */
  onsets: number;
  /** End of the scheduling look-ahead window. Every pulse due in
   *  [nowS, winEnd) that has not been emitted yet is returned; the phase
   *  cursor (`nextPulseAt`) advancing through emission is what deduplicates
   *  overlapping windows across ticks — the cursor never re-enters emitted
   *  territory, so no clockThrough bookkeeping is needed on the caller. */
  winEnd: number;
}

export interface TempolockTracker {
  tick(args: TempolockTickArgs): TempolockTickResult;
  /** Switch the fold band (the `range` param). While locked the CURRENT tempo
   *  is strictly re-folded into the new band immediately — that is the
   *  control's whole point — and the phase is left alone. */
  setBand(band: TempolockBand): void;
  readonly mode: TempolockMode;
  readonly bpm: number | null;
}

/**
 * Create a tracker. All state lives in the closure; nothing global, nothing
 * time-sourced — `nowS` is the only clock it ever sees.
 */
export function createTempolockTracker(
  opts: { band?: TempolockBand } = {},
): TempolockTracker {
  let band: TempolockBand = opts.band ?? TEMPOLOCK_BANDS[TEMPOLOCK_DEFAULT_BAND_INDEX]!;

  let mode: TempolockMode = 'cold';
  /** Quarter-note period, seconds. Set at first lock, then slewed. */
  let quarterS: number | null = null;
  /** Absolute time of the next unemitted pulse. */
  let nextPulseAt: number | null = null;
  let lastPulseAt: number | null = null;

  let lastOnsetAt: number | null = null;
  /** Last onset that landed ON the predicted beat/half-beat grid. */
  let lastGoodOnsetAt: number | null = null;
  let coastOnGrid = 0;
  /** Consecutive off-grid onsets since the last on-grid one. */
  let offGridRun = 0;
  const iois: number[] = [];

  function pushIoi(dt: number): void {
    iois.push(dt);
    if (iois.length > TEMPOLOCK_IOI_HISTORY) iois.shift();
  }

  function currentBpm(): number | null {
    return quarterS === null ? null : 60 / quarterS;
  }

  /** Apply a fresh base-pulse estimate: fold, then slew the running tempo
   *  toward it (or adopt it outright at [re]lock time). */
  function applyTempo(baseS: number, hard: boolean): void {
    const rawBpm = 60 / baseS;
    const folded = tempolockFoldWithHysteresis(rawBpm, hard ? null : currentBpm(), band);
    const targetQ = 60 / folded;
    if (hard || quarterS === null) {
      quarterS = targetQ;
      return;
    }
    const maxStep = TEMPOLOCK_TEMPO_SLEW * quarterS;
    const delta = Math.max(-maxStep, Math.min(maxStep, targetQ - quarterS));
    quarterS += delta;
  }

  function handleOnset(nowS: number): void {
    if (lastOnsetAt !== null) {
      const dt = nowS - lastOnsetAt;
      if (dt < TEMPOLOCK_MIN_IOI_S) return; // flam/double-fire: not an onset.
      if (dt <= TEMPOLOCK_MAX_IOI_S) pushIoi(dt);
      else iois.length = 0; // dropout gap: the far side starts a fresh run.
    }
    lastOnsetAt = nowS;

    // Phase evidence against the running clock (locked OR coasting): an onset
    // near a predicted beat or HALF-beat corrects the phase; the owner's
    // eighth-note kicks are half-beat evidence, not noise. Off-grid onsets are
    // ignored here (they still entered the interval history above, so a
    // genuine tempo change is still heard by the estimator).
    if (mode !== 'cold' && quarterS !== null && nextPulseAt !== null) {
      const halfQ = quarterS / 2;
      const k = Math.round((nowS - nextPulseAt) / halfQ);
      const err = nowS - (nextPulseAt + k * halfQ);
      if (Math.abs(err) <= tempolockOnGridWindowS(quarterS)) {
        lastGoodOnsetAt = nowS;
        offGridRun = 0;
        nextPulseAt += TEMPOLOCK_PLL_GAIN * err;
        // Second-order term: a persistent early/late bias means the PERIOD is
        // off, not just the phase (see TEMPOLOCK_PLL_FREQ_GAIN).
        const dq = TEMPOLOCK_PLL_FREQ_GAIN * err;
        const dqCap = 0.004 * quarterS;
        quarterS += Math.max(-dqCap, Math.min(dqCap, dq));
        if (mode === 'coast') {
          coastOnGrid++;
          if (coastOnGrid >= TEMPOLOCK_COAST_RELOCK_ONSETS) {
            mode = 'locked';
            coastOnGrid = 0;
          }
        }
      } else {
        offGridRun++;
        coastOnGrid = 0;
      }
    }

    // TWO estimates, one decision. The full-history fit is the steadiest
    // answer a STATIC tempo can get (measured on the owner recording: the
    // 32-interval fit wanders ±0.5%, the 8-interval one ±1.1%) — but it
    // trails a MOVING tempo by half its window, and the consistency score
    // cannot flag a ramp at quarter-note scale (the ±32 ms tick-noise floor
    // spans an 11% tempo spread on a 0.5 s interval, so the whole ramp reads
    // as one consistent candidate; measured on the 108→120 fixture). So the
    // follow compares the steady fit against the agile recent-window fit:
    // when they agree the tempo is static and the steady fit's low noise
    // wins; when they diverge past ~1.4% the tempo is genuinely moving and
    // the agile fit's low lag wins. Cold locks always use the full window —
    // half a window of evidence can follow a tempo, not declare one.
    let base = tempolockEstimateBasePulse(iois, TEMPOLOCK_IOI_HISTORY);
    if (mode !== 'cold') {
      const agile = tempolockEstimateBasePulse(iois, TEMPOLOCK_FOLLOW_WINDOW);
      if (base === null) base = agile;
      else if (agile !== null && Math.abs(Math.log2(agile / base)) > TEMPOLOCK_TREND_LOG2) {
        base = agile;
      }
    }
    if (base === null) return;

    if (mode === 'cold') {
      // FIRST LOCK. The anchor beat is this onset: the first clock fires WITH
      // it (phase ambiguity between beat and half-beat is unavoidable from
      // intervals alone, and half-beat anchoring is a half-beat phase offset
      // on a correct tempo — the PLL then rides whichever grid the input
      // actually plays; a QUARTER-beat anchor is the pathological case and is
      // repaired by the off-grid re-anchor below).
      applyTempo(base, true);
      mode = 'locked';
      lastGoodOnsetAt = nowS;
      nextPulseAt = nowS;
      return;
    }

    if (mode === 'coast') {
      // Keep FOLLOWING tempo while coasting: the estimator still sees the
      // incoming train, and a coasting clock frozen a fraction of a percent
      // off the returning train would slip its grid past the on-grid window
      // for tens of seconds before the relock path could fire (measured on
      // the owner recording: a 0.4% frozen error coasted for 25 s). If the
      // fold lands a real distance away the tempo CHANGED during the dropout
      // — adopt it and re-anchor the phase to the incoming train, clamped so
      // the clock never double-fires against a pulse it already emitted.
      const folded = tempolockFoldWithHysteresis(60 / base, currentBpm(), band);
      const changed =
        quarterS === null || Math.abs(Math.log2(60 / folded / quarterS)) > 0.06;
      if (changed) {
        applyTempo(base, true);
        mode = 'locked';
        coastOnGrid = 0;
        offGridRun = 0;
        lastGoodOnsetAt = nowS;
        reanchorPhase(nowS);
      } else {
        applyTempo(base, false);
      }
      return;
    }

    // Locked: smooth tempo follow (median-ish via the least-squares refit
    // over the rolling history, slew-limited per onset).
    applyTempo(base, false);

    // The QUARTER-BEAT-ANCHOR repair (see TEMPOLOCK_REANCHOR_OFFGRID_ONSETS):
    // a run of off-grid onsets from a train the estimator still finds
    // CONSISTENT means the phase is wrong, not the input — snap the grid onto
    // the train instead of starving into coast at a correct tempo.
    if (offGridRun >= TEMPOLOCK_REANCHOR_OFFGRID_ONSETS) {
      offGridRun = 0;
      lastGoodOnsetAt = nowS;
      reanchorPhase(nowS);
    }
  }

  /** Re-align the half-beat grid onto an anchor onset with the MINIMAL phase
   *  shift — the full residual against the nearest half-beat point, which is
   *  at most a quarter of a beat. A raw snap-to-the-onset was tried first and
   *  measured worse: clamped against the last emitted pulse it manufactures
   *  half-length clock intervals on every repair, which is exactly the
   *  unsteadiness this module exists to remove. The minimal shift keeps every
   *  emitted interval within [0.75, 1.25] beats through a repair. */
  function reanchorPhase(nowS: number): void {
    const q = quarterS!;
    if (nextPulseAt === null) {
      nextPulseAt = nowS;
      return;
    }
    const halfQ = q / 2;
    const k = Math.round((nowS - nextPulseAt) / halfQ);
    nextPulseAt += nowS - (nextPulseAt + k * halfQ);
  }

  return {
    get mode() {
      return mode;
    },
    get bpm() {
      return currentBpm();
    },

    setBand(next: TempolockBand): void {
      band = next;
      if (quarterS !== null) {
        const refolded = tempolockFoldStrict(currentBpm()!, band);
        quarterS = 60 / refolded;
      }
    },

    tick({ nowS, onsets, winEnd }: TempolockTickArgs): TempolockTickResult {
      if (onsets > 0) handleOnset(nowS);

      // Confidence decay: expected beats with no on-grid onset.
      if (
        mode === 'locked' &&
        quarterS !== null &&
        lastGoodOnsetAt !== null &&
        nowS - lastGoodOnsetAt > TEMPOLOCK_MISSED_BEATS_UNLOCK * quarterS
      ) {
        mode = 'coast';
        coastOnGrid = 0;
      }

      // Emit: the phase accumulator, never a passthrough of input edges.
      // A pulse more than SCHED_EPS in the past cannot be placed — the tick
      // arrived later than the look-ahead could cover; count it and catch the
      // cursor up in ONE step (an unbounded loop after a long stall is the
      // cv-buddy clock-math hazard). A pulse a hair behind `nowS` (a PLL
      // nudge landing mid-tick) still schedules — setValueAtTime clamps.
      const SCHED_EPS = 0.005;
      const pulses: number[] = [];
      let skipped = 0;
      if (mode !== 'cold' && quarterS !== null && nextPulseAt !== null && winEnd > nowS) {
        if (nextPulseAt < nowS - SCHED_EPS) {
          skipped = Math.ceil((nowS - SCHED_EPS - nextPulseAt) / quarterS);
          nextPulseAt += skipped * quarterS;
        }
        while (nextPulseAt < winEnd && pulses.length < MAX_PULSES_PER_WINDOW) {
          pulses.push(nextPulseAt);
          lastPulseAt = nextPulseAt;
          nextPulseAt += quarterS;
        }
      }

      return {
        pulses,
        bpm: currentBpm(),
        locked: mode === 'locked',
        mode,
        skipped,
      };
    },
  };
}
