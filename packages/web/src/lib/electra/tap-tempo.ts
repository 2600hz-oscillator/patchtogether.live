// packages/web/src/lib/electra/tap-tempo.ts
//
// TAP-TEMPO — a pure ring-buffer → BPM helper.
//
// The Electra (or any pad/note source) sends a momentary press on each tap.
// The APP computes BPM from the press timestamps; the device has no sub-second
// timer, so all tap math is JS-side (mirrors timelorde.ts:transportEventsToRunState
// in being a pure, unit-testable transport helper). The computed BPM is written
// to patch.nodes[tlId].params.bpm — reusing the internal-bpm path, so NO new
// param / worklet change is needed and the value syncs to rack-mates. (This also
// satisfies the deferred TimelordeCard tap-tempo button: the same helper backs it.)
//
// Algorithm:
//   - Keep the last N (default 5) tap timestamps in a ring buffer.
//   - On each tap, if the gap since the previous tap exceeds RESET_MS (~2s),
//     treat it as the start of a NEW tap sequence (clear history).
//   - BPM = 60000 / medianInterval(ms) over the buffered taps.
//   - Clamp to [MIN_BPM, MAX_BPM] (matches TIMELORDE's 10..300).
//   - Need at least 2 taps (1 interval) to produce a BPM; before that, null.
//
// Median (not mean) so one mistimed tap doesn't drag the estimate — the
// classic robust-tap-tempo trick.

export const TAP_MIN_BPM = 10;
export const TAP_MAX_BPM = 300;
/** Gap longer than this (ms) starts a fresh tap sequence. */
export const TAP_RESET_MS = 2000;
/** How many recent taps to keep (→ up to N-1 intervals). */
export const TAP_HISTORY = 5;

/** Clamp a BPM into TIMELORDE's natural range. */
export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return TAP_MIN_BPM;
  return Math.max(TAP_MIN_BPM, Math.min(TAP_MAX_BPM, bpm));
}

/** Median of a numeric array (sorted copy; avg of middle two when even). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Pure: given an ordered list of tap timestamps (performance.now() ms) and the
 * config, compute the BPM (or null if fewer than 2 taps after applying the
 * reset-gap rule). Exposed separately so the snapshot/unit test can drive it
 * with synthetic timestamps and no clock.
 *
 * The reset rule is applied here too: only the trailing run of taps whose
 * inter-tap gaps are all ≤ resetMs counts. So `[0, 250, 500, 5000, 5250]`
 * (a 5s pause) yields BPM from just `[5000, 5250]`.
 */
export function bpmFromTaps(
  taps: readonly number[],
  opts: { resetMs?: number; minBpm?: number; maxBpm?: number } = {},
): number | null {
  const resetMs = opts.resetMs ?? TAP_RESET_MS;
  const minBpm = opts.minBpm ?? TAP_MIN_BPM;
  const maxBpm = opts.maxBpm ?? TAP_MAX_BPM;
  if (taps.length < 2) return null;

  // Walk backwards, keeping the trailing run with no gap > resetMs.
  const run: number[] = [taps[taps.length - 1]!];
  for (let i = taps.length - 2; i >= 0; i--) {
    const gap = run[run.length - 1]! - taps[i]!; // gap to the NEXT (later) tap
    if (gap > resetMs) break;
    run.push(taps[i]!);
  }
  run.reverse();
  if (run.length < 2) return null;

  const intervals: number[] = [];
  for (let i = 1; i < run.length; i++) {
    const dt = run[i]! - run[i - 1]!;
    if (dt > 0) intervals.push(dt);
  }
  if (intervals.length === 0) return null;

  const bpm = 60000 / median(intervals);
  return Math.max(minBpm, Math.min(maxBpm, bpm));
}

/**
 * Stateful tap-tempo accumulator. Construct one per TIMELORDE; call `.tap(now)`
 * on each pad press; it returns the current BPM estimate (or null when not yet
 * resolvable). Internally a fixed-size ring buffer over the last `history` taps,
 * with the reset-gap rule applied via bpmFromTaps. Pure-ish: the only side
 * effect is mutating its own buffer, and `now` is injected so tests are
 * deterministic (no real clock).
 */
export class TapTempo {
  private taps: number[] = [];
  private readonly history: number;
  private readonly resetMs: number;
  private readonly minBpm: number;
  private readonly maxBpm: number;

  constructor(opts: {
    history?: number;
    resetMs?: number;
    minBpm?: number;
    maxBpm?: number;
  } = {}) {
    this.history = Math.max(2, opts.history ?? TAP_HISTORY);
    this.resetMs = opts.resetMs ?? TAP_RESET_MS;
    this.minBpm = opts.minBpm ?? TAP_MIN_BPM;
    this.maxBpm = opts.maxBpm ?? TAP_MAX_BPM;
  }

  /** Register a tap at time `now` (ms). Returns the BPM estimate or null. */
  tap(now: number): number | null {
    const prev = this.taps[this.taps.length - 1];
    // A long gap restarts the sequence so a fresh count isn't polluted by
    // the previous song's taps still in the buffer.
    if (prev !== undefined && now - prev > this.resetMs) {
      this.taps = [];
    }
    this.taps.push(now);
    if (this.taps.length > this.history) this.taps.shift();
    return bpmFromTaps(this.taps, {
      resetMs: this.resetMs,
      minBpm: this.minBpm,
      maxBpm: this.maxBpm,
    });
  }

  /** Forget all buffered taps (e.g. on switching to external clock). */
  reset(): void {
    this.taps = [];
  }

  /** Current buffered tap count (for tests / UI "tap N more" hints). */
  get count(): number {
    return this.taps.length;
  }
}
