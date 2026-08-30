// packages/web/src/lib/audio/playback-stats.ts
//
// THE UNDERRUN COUNTER — device-layer dropouts, named and counted.
//
// ── Why this file exists ────────────────────────────────────────────────────
// Until this PR the app had NO audio-health instrumentation of any kind.
// Verified by `git grep` over `packages/web/src` + `packages/dsp/src`:
// `renderCapacity`, `playoutStats`, `processorerror`, `PerformanceObserver` —
// ZERO hits, all four. So "it bogs down and then stops" was indistinguishable
// from a thermally-throttled laptop, a dead worklet, or a backgrounded tab, and
// every dropout investigation had to argue from inference.
//
// ── ⚠ THE NAMING CORRECTION (read this before "fixing" the feature probe) ────
// Our own planning docs (`FABLE_PERF_PLAN` P1-2, and the 2026-07-29 bog-down
// diagnosis) tell implementers to feature-detect `renderCapacity` /
// `playoutStats` / `onprocessorerror`. TWO OF THOSE THREE NAMES DO NOT EXIST ON
// `AudioContext`:
//
//   - `AudioContext.playbackStats` → `AudioPlaybackStats` is the shipped API,
//     and it is the one this file reads.
//   - `playoutStats` is a DIFFERENT API on a DIFFERENT interface
//     (`HTMLMediaElement`-adjacent video playout quality), not on AudioContext.
//   - `renderCapacity` is not listed among `AudioContext`'s instance properties.
//
// Anyone implementing the plan as written would have probed the wrong property,
// got `undefined`, and concluded "no browser support". It IS supported — the
// owner ran the probe on real Chrome on 2026-08-08 and got live data:
//
//     underrunDuration 0 · underrunEvents 0 · totalDuration 18.056818
//     averageLatency 0.036588 · minimumLatency 0 · maximumLatency 0.041291
//
// That is the healthy baseline this readout is pinned against.
//
// ── ⚠ `minimumLatency` IS DELIBERATELY NOT SURFACED ─────────────────────────
// `minimumLatency: 0` next to a 36.6 ms average and a 41.3 ms maximum is not
// physically plausible — a real output pipeline cannot momentarily have zero
// latency. Treat it as uninitialised / a sentinel. It is NOT read here, NOT
// exposed on the snapshot, and NO logic is built on it. `snapshotFromStats` is
// asserted INVARIANT to it in playback-stats.test.ts, so a future "let's also
// show min" edit fails the gate rather than shipping a fake number.
//
// ── ⚠ THE STRUCTURALLY-BLIND ALTERNATIVE — DO NOT REINVENT IT ───────────────
// The obvious no-API detector is to compare `ctx.currentTime` against
// `performance.now()` and call the drift "underrun". IT IS INVARIANT TO THE
// THING IT CLAIMS TO MEASURE. The device clock keeps consuming samples at the
// sample rate whether the buffer was filled with real audio or with silence, so
// `currentTime` advances at wall-clock rate straight THROUGH a dropout. It
// returns a clean, confident, always-zero number. Same failure shape as the
// Pearson-correlation blind gate covered by AGENTS.md's instrument rule.
//
// PURE + framework-free on purpose: every function here is unit-testable with a
// plain object, no browser and no AudioContext. The reactive 1 Hz poller lives
// in `audio-health.svelte.ts`; the numbers live here.

/**
 * The shape of `AudioContext.playbackStats` (`AudioPlaybackStats`).
 *
 * Declared locally because the API is still marked experimental and our
 * TypeScript DOM lib does not carry it. All durations are SECONDS and all
 * counters are CUMULATIVE SINCE CONTEXT CREATION — see `AudioHealthSnapshot`.
 *
 * `minimumLatency` is present in the real object and is deliberately absent
 * here: see the header. Not declaring it is the cheapest way to make reading it
 * a type error.
 */
export interface AudioPlaybackStatsLike {
  /** Total time, in seconds, the output was starved (silence/repeat played). */
  readonly underrunDuration: number;
  /** Number of DISTINCT starvation events since the context was created. */
  readonly underrunEvents: number;
  /** Total time, in seconds, the context has been producing output. */
  readonly totalDuration: number;
  /** Mean output-pipeline latency, in seconds. */
  readonly averageLatency: number;
  /** Worst observed output-pipeline latency, in seconds. */
  readonly maximumLatency: number;
}

/**
 * What the UI reads. Milliseconds where a human reads it, seconds where the
 * platform gave us seconds — and the field names say which, because half the
 * instrument bugs this repo has hit were unit confusions (blind-gates §2).
 *
 * ⚠ SEMANTICS: `underrunEvents` / `underrunSec` / `totalSec` are CUMULATIVE
 * SINCE THE AUDIOCONTEXT WAS CREATED, never a rate and never a window. A rising
 * number means "this many dropouts have EVER happened in this session", so a
 * count of 12 after four hours is a very different report from 12 in a minute.
 * The footer tooltip says so; do not silently redefine it to a rate.
 */
export interface AudioHealthSnapshot {
  /** False when the browser has no `playbackStats` (Firefox / Safari today). */
  readonly supported: boolean;
  /** Cumulative count of starvation events since context creation. */
  readonly underrunEvents: number;
  /** Cumulative starved time, SECONDS, since context creation. */
  readonly underrunSec: number;
  /** Cumulative output time, SECONDS, since context creation. */
  readonly totalSec: number;
  /** `underrunSec / totalSec`, 0 when `totalSec` is 0. Unitless fraction. */
  readonly underrunRatio: number;
  /** Mean output latency in MILLISECONDS (the platform reports seconds). */
  readonly avgLatencyMs: number;
  /** Worst output latency in MILLISECONDS (the platform reports seconds). */
  readonly maxLatencyMs: number;
}

/** The snapshot a browser without `playbackStats` gets. Renders as "—". */
export const UNSUPPORTED_AUDIO_HEALTH: AudioHealthSnapshot = Object.freeze({
  supported: false,
  underrunEvents: 0,
  underrunSec: 0,
  totalSec: 0,
  underrunRatio: 0,
  avgLatencyMs: 0,
  maxLatencyMs: 0,
});

/** A finite number, or `fallback`. Guards against a partial/NaN stats object. */
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * FEATURE DETECTION. Returns the live stats object, or null when the browser
 * does not implement it.
 *
 * Deliberately strict: the property must exist AND the object must actually
 * carry a numeric `underrunEvents`. A property that exists but answers
 * `undefined` is the exact shape that would let a dead readout look healthy.
 *
 * NEVER throws and NEVER warns — a Firefox/Safari user must not be nagged about
 * a Chromium-only counter. Silent degradation is the contract.
 */
export function readPlaybackStats(ctx: unknown): AudioPlaybackStatsLike | null {
  if (!ctx || typeof ctx !== 'object') return null;
  if (!('playbackStats' in ctx)) return null;
  let stats: unknown;
  try {
    stats = (ctx as { playbackStats?: unknown }).playbackStats;
  } catch {
    // A getter that throws (a closed context on some builds) is "unsupported".
    return null;
  }
  if (!stats || typeof stats !== 'object') return null;
  if (typeof (stats as { underrunEvents?: unknown }).underrunEvents !== 'number') return null;
  return stats as AudioPlaybackStatsLike;
}

/** True iff this context can report underruns at all. */
export function playbackStatsSupported(ctx: unknown): boolean {
  return readPlaybackStats(ctx) !== null;
}

/**
 * Project the platform stats onto the UI snapshot. PURE.
 *
 * Note what is NOT here: `minimumLatency`. See the header — and see
 * playback-stats.test.ts, which perturbs `minimumLatency` and asserts the
 * snapshot is byte-identical, so the omission is a gate rather than a habit.
 */
export function snapshotFromStats(stats: AudioPlaybackStatsLike): AudioHealthSnapshot {
  const underrunSec = num(stats.underrunDuration);
  const totalSec = num(stats.totalDuration);
  return {
    supported: true,
    underrunEvents: num(stats.underrunEvents),
    underrunSec,
    totalSec,
    underrunRatio: totalSec > 0 ? underrunSec / totalSec : 0,
    avgLatencyMs: num(stats.averageLatency) * 1000,
    maxLatencyMs: num(stats.maximumLatency) * 1000,
  };
}

/** Read a context straight through to a snapshot. Unsupported → the frozen "—". */
export function snapshotAudioHealth(ctx: unknown): AudioHealthSnapshot {
  const stats = readPlaybackStats(ctx);
  return stats ? snapshotFromStats(stats) : UNSUPPORTED_AUDIO_HEALTH;
}

/**
 * The footer strings. Kept next to the numbers so the UI cannot invent its own
 * rounding, and so the "—" path is testable without mounting a component.
 *
 * `dropout` is total STARVED TIME, printed in ms below a second and in seconds
 * above it — a 4-hour session that dropped 1.8 s should not read "1800.0ms".
 */
export function formatAudioHealth(s: AudioHealthSnapshot): {
  underruns: string;
  dropout: string;
  avgLatency: string;
} {
  if (!s.supported) return { underruns: '—', dropout: '—', avgLatency: '—' };
  const sec = s.underrunSec;
  return {
    underruns: String(s.underrunEvents),
    dropout: sec >= 1 ? `${sec.toFixed(2)}s` : `${(sec * 1000).toFixed(1)}ms`,
    avgLatency: `${s.avgLatencyMs.toFixed(1)}ms`,
  };
}
