// packages/web/src/lib/audio/tick-latency.ts
//
// SCHEDULER TICK-LATENCY HISTOGRAM — is the MAIN THREAD starved, or the AUDIO
// THREAD? Those are different diseases with different fixes, and today they
// produce the same user report ("it bogs down").
//
// ── The correction this instrument is built on ──────────────────────────────
// The scheduler's tick SOURCE is a Web Worker (`scheduler-clock.ts` — an inline
// Blob worker running `setInterval`), chosen precisely so the cadence survives
// main-thread jank. The tick therefore CANNOT be lost, which is why the
// 2026-07-29 bog-down diagnosis measured 0 missed scheduler ticks over 7 minutes
// while the owner was still reporting dropouts. Do not go looking for missed
// ticks again — there are none, by construction.
//
// What CAN be arbitrarily delayed is the tick's WORK: the subscriber callbacks
// run on the MAIN thread. The worker keeps posting during a 200 ms block, the
// messages queue, and they drain in a burst when the main thread frees up. That
// is the quantity this file measures.
//
// ── What the instrument actually measures, and why not "postedAt" ───────────
// The obvious design stamps `performance.now()` in the worker and subtracts on
// arrival. IT IS A CROSS-ORIGIN CLOCK COMPARISON: a dedicated worker has its
// OWN `performance.timeOrigin` (set when the worker was created), so the
// difference is an arbitrary constant plus the latency, and the constant is
// unobservable from either side. It would produce a confident, stable, WRONG
// number — exactly the instrument-error class in `blind-gates.md` §2.
//
// So we measure ARRIVAL CADENCE on one clock, the main thread's:
//
//     lateness = (arrival - previousArrival) - tickMs
//
// A 200 ms main-thread block shows up as ONE arrival with lateness ≈ +175 ms
// followed by a burst of queued arrivals with lateness ≈ -25 ms. Both halves
// are recorded, and the burst half is what distinguishes the two diagnoses:
//
//   - late arrivals WITH a following drain burst → the MAIN THREAD was blocked
//     (the worker kept posting; we just couldn't run).
//   - late arrivals WITHOUT a drain burst        → the TICK SOURCE itself
//     slowed (background-tab throttling, or the setTimeout fallback path).
//
// A bare "p99 lateness" number cannot tell those apart, which is why `drained`
// is a first-class field and not an implementation detail.
//
// ── UNITS: MILLISECONDS, deliberately ───────────────────────────────────────
// The repo standard "never express a renderer-dependent wait in milliseconds —
// count frames" applies to RENDERER-dependent budgets (WebGL/video e2e, where
// wall-clock silently becomes a different frame count per machine). This is a
// MAIN-THREAD SCHEDULING quantity against a fixed 25 ms wall-clock cadence;
// frames are not its unit and converting to frames would BE the instrument
// error. Every field name and every assertion message carries `Ms`.
//
// PURE + framework-free: no timers, no globals, no `performance` dependency.
// The caller passes the timestamps in, so `tick-latency.test.ts` can drive a
// synthetic 200 ms stall deterministically with zero wall-clock time.

/**
 * Lateness bucket LOWER edges, in MILLISECONDS. Bucket `i` counts samples with
 * `EDGES[i] <= latenessMs < EDGES[i+1]`; the final bucket is unbounded above.
 *
 * Negative lateness (an arrival EARLIER than the cadence — a queue drain) is
 * NOT bucketed here; it is counted separately as `drained`, because folding it
 * into bucket 0 would erase the one signal that separates "main thread blocked"
 * from "tick source slowed".
 */
export const TICK_LATENESS_EDGES_MS = [0, 5, 10, 25, 50, 100, 250] as const;

/** How many recent lateness samples the exact-percentile ring keeps. */
const RING = 256;

export interface TickLatencyStats {
  /** Tick arrivals recorded (the FIRST arrival is excluded — no predecessor). */
  readonly samples: number;
  /**
   * Arrivals that came in EARLIER than half the tick period — the queue
   * draining after a main-thread block. Non-zero here alongside high lateness
   * means the main thread was blocked, not that the tick source slowed.
   */
  readonly drained: number;
  /** Arrivals later than a WHOLE extra tick period (lateness >= tickMs). */
  readonly overBudget: number;
  /** Per-bucket counts, aligned to `TICK_LATENESS_EDGES_MS`. Cumulative. */
  readonly buckets: readonly number[];
  /** Exact percentiles over the last `RING` samples, MILLISECONDS. */
  readonly p50Ms: number;
  readonly p99Ms: number;
  /** Worst lateness ever seen this session, MILLISECONDS. Not ring-limited. */
  readonly maxMs: number;
  /**
   * How long the subscriber callbacks themselves took, MILLISECONDS. Separates
   * "the main thread was busy with someone else's work" from "OUR tick work is
   * the expensive thing" — two conclusions a lateness number alone conflates.
   */
  readonly dispatchP99Ms: number;
  readonly dispatchMaxMs: number;
  /** Wall-clock span from first to last arrival, MILLISECONDS. */
  readonly elapsedMs: number;
  /** The cadence being measured against, MILLISECONDS. Stated, not assumed. */
  readonly tickMs: number;
}

export interface TickLatencyRecorder {
  /** Record a tick ARRIVAL at `nowMs` (main-thread clock). */
  arrive(nowMs: number): void;
  /** Record that the dispatch that began at the last `arrive` took `ms`. */
  dispatched(durationMs: number): void;
  /** Read the accumulated stats. Allocates; call at ~1 Hz, not per tick. */
  stats(): TickLatencyStats;
  /** Forget everything. Test seam + "reset counters" affordance. */
  reset(): void;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Build a recorder for a `tickMs` cadence.
 *
 * Allocation-free in the hot path: the percentile rings are preallocated and
 * written modulo their length, and `arrive`/`dispatched` do a handful of
 * arithmetic ops each. `stats()` is the only allocating call.
 */
export function createTickLatencyRecorder(tickMs: number): TickLatencyRecorder {
  const buckets = new Array<number>(TICK_LATENESS_EDGES_MS.length).fill(0);
  const lateRing = new Float64Array(RING);
  const dispRing = new Float64Array(RING);
  let lateCount = 0;
  let dispCount = 0;
  let samples = 0;
  let drained = 0;
  let overBudget = 0;
  let maxMs = 0;
  let dispatchMaxMs = 0;
  let prevArrival: number | null = null;
  let firstArrival: number | null = null;
  let lastArrival = 0;

  function bucketFor(latenessMs: number): number {
    // Linear scan over 7 edges: cheaper than a branchy binary search and the
    // array is a compile-time constant.
    let i = 0;
    for (let k = 0; k < TICK_LATENESS_EDGES_MS.length; k++) {
      if (latenessMs >= TICK_LATENESS_EDGES_MS[k]!) i = k;
      else break;
    }
    return i;
  }

  return {
    arrive(nowMs: number) {
      if (firstArrival === null) firstArrival = nowMs;
      lastArrival = nowMs;
      if (prevArrival === null) {
        prevArrival = nowMs;
        return; // no predecessor → no cadence to compare against
      }
      const lateness = nowMs - prevArrival - tickMs;
      prevArrival = nowMs;
      samples++;
      if (lateness < -tickMs / 2) {
        // Arrived far earlier than the cadence: a queued tick draining.
        drained++;
        return;
      }
      const late = lateness > 0 ? lateness : 0;
      if (late > maxMs) maxMs = late;
      if (lateness >= tickMs) overBudget++;
      buckets[bucketFor(late)]!++;
      lateRing[lateCount % RING] = late;
      lateCount++;
    },
    dispatched(durationMs: number) {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      if (durationMs > dispatchMaxMs) dispatchMaxMs = durationMs;
      dispRing[dispCount % RING] = durationMs;
      dispCount++;
    },
    stats(): TickLatencyStats {
      const lateSorted = Array.from(lateRing.slice(0, Math.min(lateCount, RING))).sort(
        (a, b) => a - b,
      );
      const dispSorted = Array.from(dispRing.slice(0, Math.min(dispCount, RING))).sort(
        (a, b) => a - b,
      );
      return {
        samples,
        drained,
        overBudget,
        buckets: buckets.slice(),
        p50Ms: percentile(lateSorted, 50),
        p99Ms: percentile(lateSorted, 99),
        maxMs,
        dispatchP99Ms: percentile(dispSorted, 99),
        dispatchMaxMs,
        elapsedMs: firstArrival === null ? 0 : lastArrival - firstArrival,
        tickMs,
      };
    },
    reset() {
      buckets.fill(0);
      lateRing.fill(0);
      dispRing.fill(0);
      lateCount = 0;
      dispCount = 0;
      samples = 0;
      drained = 0;
      overBudget = 0;
      maxMs = 0;
      dispatchMaxMs = 0;
      prevArrival = null;
      firstArrival = null;
      lastArrival = 0;
    },
  };
}

/**
 * One-line summary for the footer / a bug report. Units are IN the string on
 * purpose — a bare "p99 143" is the kind of number that gets misread as frames.
 */
export function formatTickLatency(s: TickLatencyStats): string {
  if (s.samples === 0) return '—';
  return `p50 ${s.p50Ms.toFixed(1)}ms · p99 ${s.p99Ms.toFixed(1)}ms · max ${s.maxMs.toFixed(
    0,
  )}ms · over ${s.overBudget}/${s.samples}`;
}
