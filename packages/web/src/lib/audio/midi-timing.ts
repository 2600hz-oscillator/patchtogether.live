// Shared MIDI → audio-clock timing helpers.
//
// WHY THIS FILE EXISTS (root-cause of a real bug): three modules ingest
// Web-MIDI on the main thread and schedule AudioParam changes on the audio
// clock — MIDICLOCK (clock pulses), MIDI-CV-BUDDY (live keyboard), and
// MIDI LANE (note/CC lanes). The correct way to schedule is to PROJECT the
// event's own `event.timeStamp` (a `performance.now()`-relative
// DOMHighResTimestamp captured by the MIDI subsystem) onto
// `AudioContext.currentTime`, so two events keep their real inter-event
// spacing no matter how late their handlers actually run.
//
// MIDICLOCK was rewritten to do this (`eventTimeStampToAudioTime`), but the
// fix never reached its two siblings: MIDI-CV-BUDDY and MIDI LANE still used a
// `Math.max(now + L, now + delta + L)` floor that — because a Web-MIDI handler
// always runs AFTER the event arrived (`perfNow >= eventTimeStamp` ⇒
// `delta <= 0`) — collapses every note to `currentTime + L`. Inter-note
// spacing then equals main-thread event-loop dispatch jitter. Under heavy
// main-thread load (e.g. a patch rendering several videos through the engine
// rAF) that jitter is the steady state, audible as note "swing"/flam even
// when locked to an external MIDI clock.
//
// Hoisting the projection into ONE place means all three bridges share the
// proven math and it can't silently drift into "fixed in 1 of 3" again.

/** MIDI Beat Clock resolution: 24 pulses per quarter note. */
export const MIDI_PPQN = 24;

/** One Web Audio render quantum in seconds at 48 kHz (128 frames = 2.67 ms).
 *  Any schedule floor must be ≥ this so a clamped event still lands at the
 *  START of a future block, not mid-block (a mid-block AudioParam step is an
 *  audible discontinuity). */
export const RENDER_QUANTUM_S = 128 / 48000;

/** Lookahead budget added when projecting `event.timeStamp` onto the audio
 *  clock. It must exceed the worst-case main-thread handler-dispatch lag,
 *  otherwise late events get clamped to the floor and re-introduce
 *  currentTime-spacing (== event-loop jitter == the bug). 25 ms covers a
 *  stalled event loop for the duration of one MIDI tick at 120 BPM — a
 *  worst-realistic case under heavy main-thread (e.g. video) load.
 *
 *  The user perceives this as a CONSTANT ~25 ms latency on scheduled events
 *  (inaudible — any MIDI host already runs 5–15 ms of buffer); what they do
 *  NOT perceive is jitter, because the same budget is added to every event so
 *  relative spacing is preserved to float precision. */
export const TIMESTAMP_LOOKAHEAD_S = 0.025;

/** Maximum lag we'll honor from `event.timeStamp` before treating it as bogus
 *  and re-anchoring at "now + lookahead". A real Web-MIDI event lags its
 *  handler by a few ms at most; >100 ms means either the tab was backgrounded
 *  (a burst arrived at once on resume) or the timestamp is from a different
 *  clock domain (some platforms have shipped MIDI timestamps with the wrong
 *  origin). Honoring such a stale timestamp would project far into the past;
 *  Web Audio coerces that to currentTime but ALSO loses the burst's relative
 *  spacing. Re-anchoring at the floor is the lesser audible evil. */
export const MAX_TIMESTAMP_LAG_MS = 100;

/**
 * Calibrated offset between `AudioContext.currentTime` (s) and
 * `performance.now()` (ms). Both tick at real-time, so this is constant up to
 * a small per-platform drift (~ppm). Re-measure every few seconds to absorb
 * drift — far cheaper than re-reading both clocks per MIDI message.
 */
export function measureCtxOffset(currentTimeS: number, performanceNowMs: number): number {
  return currentTimeS - performanceNowMs / 1000;
}

/**
 * Project a Web-MIDI `event.timeStamp` (ms, `performance.now()`-relative) onto
 * the AudioContext's `currentTime` clock (s), with a fixed lookahead budget.
 *
 *   eventTimeStampMs — `event.timeStamp` from the MIDIMessageEvent.
 *   currentTimeS     — `audioContext.currentTime` at handler-dispatch.
 *   performanceNowMs — `performance.now()` at handler-dispatch.
 *   ctxOffsetS       — calibrated `currentTimeS - performanceNowMs/1000`,
 *                      measured at init + refreshed every few seconds.
 *   lookaheadS       — lookahead budget (defaults to TIMESTAMP_LOOKAHEAD_S).
 *
 * Properties:
 *   1. Two messages whose `timeStamp`s differ by `Δms` are scheduled
 *      `Δms / 1000` s apart on the audio clock — independent of when their
 *      handlers actually ran. (THIS is what the old `Math.max(now + L, …)`
 *      floor broke: it clamped every event to "now + L", erasing spacing.)
 *   2. Every schedule is at least one render quantum in the future, so Web
 *      Audio never coerces it into the past (mid-block discontinuity).
 *   3. A timestamp lag outside [0, MAX_TIMESTAMP_LAG_MS] re-anchors at
 *      "now + lookahead" (stale burst / bogus clock domain).
 *
 * Pure — tests pin the math directly.
 */
export function eventTimeStampToAudioTime(
  eventTimeStampMs: number,
  currentTimeS: number,
  performanceNowMs: number,
  ctxOffsetS: number,
  lookaheadS: number = TIMESTAMP_LOOKAHEAD_S,
): number {
  const lagMs = performanceNowMs - eventTimeStampMs;
  // Defense in depth: stale or future-skewed timestamps re-anchor at the
  // floor so a misbehaving driver can't push the schedule arbitrarily.
  if (lagMs < 0 || lagMs > MAX_TIMESTAMP_LAG_MS) {
    return currentTimeS + lookaheadS;
  }
  const target = eventTimeStampMs / 1000 + ctxOffsetS + lookaheadS;
  // Floor: an event whose lag exceeds the lookahead would project into the
  // past on the audio clock. Clamp to one audio block ahead — Web Audio
  // honors the schedule, but the affected event loses its projected spacing.
  // Kept INTENTIONALLY tiny (one quantum, not lookahead/2) so the clamp only
  // catches genuine outliers; normal-lag events pass through the projection
  // and keep their inter-event spacing.
  const floor = currentTimeS + RENDER_QUANTUM_S;
  return target > floor ? target : floor;
}

/** How often to re-measure the ctx↔perf offset (ms). */
const CTX_OFFSET_REFRESH_MS = 2000;

/** A minimal view of the bits of AudioContext the scheduler needs. */
export interface MidiSchedulerCtx {
  readonly currentTime: number;
}

export interface MidiScheduler {
  /**
   * Project a MIDI `event.timeStamp` (ms) to the audio time (s) at which its
   * AudioParam change should land — preserving inter-event spacing under
   * handler-dispatch jitter. Refreshes the ctx↔perf offset lazily.
   */
  schedAt(eventTimeStampMs: number): number;
  /**
   * Schedule time for an event NOT driven by a MIDI timestamp (panic /
   * all-notes-off / mode change): just `currentTime + extraLookahead`. Spacing
   * is irrelevant for these, so a small lookahead keeps them snappy.
   */
  soon(extraLookaheadS?: number): number;
}

/**
 * Create a stateful per-node MIDI→audio scheduler. Encapsulates the ctx↔perf
 * offset measurement + periodic refresh and exposes `schedAt`/`soon`, so each
 * MIDI bridge gets the proven projection with one line instead of re-deriving
 * (and re-breaking) the math.
 *
 * `nowMs` is injectable for tests; in production it defaults to
 * `performance.now()` (falling back to the event timestamp under SSR/no-perf).
 */
export function createMidiScheduler(
  ctx: MidiSchedulerCtx,
  opts: { lookaheadS?: number; soonLookaheadS?: number; nowMs?: () => number } = {},
): MidiScheduler {
  const lookaheadS = opts.lookaheadS ?? TIMESTAMP_LOOKAHEAD_S;
  const soonLookaheadS = opts.soonLookaheadS ?? RENDER_QUANTUM_S * 3; // ~8 ms
  const nowMs =
    opts.nowMs ?? (() => (typeof performance !== 'undefined' ? performance.now() : 0));

  let ctxOffsetS = measureCtxOffset(ctx.currentTime, nowMs());
  let lastRefreshMs = nowMs();

  return {
    schedAt(eventTimeStampMs: number): number {
      const perfNow = nowMs();
      const now = ctx.currentTime;
      if (perfNow - lastRefreshMs > CTX_OFFSET_REFRESH_MS) {
        ctxOffsetS = measureCtxOffset(now, perfNow);
        lastRefreshMs = perfNow;
      }
      return eventTimeStampToAudioTime(eventTimeStampMs, now, perfNow, ctxOffsetS, lookaheadS);
    },
    soon(extraLookaheadS: number = soonLookaheadS): number {
      return ctx.currentTime + extraLookaheadS;
    },
  };
}
