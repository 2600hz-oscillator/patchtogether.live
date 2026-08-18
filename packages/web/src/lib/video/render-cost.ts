// packages/web/src/lib/video/render-cost.ts
//
// MAIN-THREAD RENDER COST — an IN-PAGE accumulator for #1811.
//
// ── why this file exists ────────────────────────────────────────────────────
// #1801 is "audio slows down when I use video controls". #1803 established the
// mechanism: the audio scheduler DISPATCHES on the main thread, so anything
// that blocks the main thread delays sequencing. `tick-latency.ts` already
// measures the CONSEQUENCE (scheduler arrival lateness, ms). What nothing
// measured was the CAUSE — how much main-thread CPU the video path spends per
// frame, and in which half of it.
//
// ── the instrument rule this file obeys ─────────────────────────────────────
// CLAUDE.md: "never sample a page-side quantity with a Playwright-side poll
// loop — move the accumulator INTO the page". This IS that accumulator. A
// caller (spec, HUD, console) reads `stats()` ONCE at the end of a window; the
// summing happens on the same thread as the work, one `performance.now()` pair
// per recorded span. There is no sampling and no round trip, so a loaded runner
// cannot starve the measurement into looking like a result.
//
// ── UNITS: MILLISECONDS of MAIN-THREAD CPU, and nothing else ────────────────
// Every field carries `Ms` or `Calls` in its name, deliberately (CLAUDE.md
// §"state the units in the assertion message"). Two things this is NOT, and
// both have burned this repo before:
//
//   * it is NOT GPU time. A WebGL call returns as soon as the command is
//     queued; what we time is the CPU cost of ISSUING it (plus whatever
//     implicit sync the driver forces, which for `drawImage(webglCanvas)` is
//     real and is exactly the cost we care about). A number here going down
//     means the MAIN THREAD got its time back — which is the whole point —
//     not that the GPU got faster.
//   * it is NOT a frame budget. Frames are the right unit for a renderer-
//     dependent WAIT (see e2e/_helpers/frames.ts); they are the WRONG unit for
//     "how long did the main thread spend", which is a wall-clock quantity
//     measured against a wall-clock scheduler cadence (25 ms).
//
// `callsPerElapsed` is deliberately absent: a rate needs a denominator the
// caller owns (frames? seconds? ticks?) and folding one in here would bake a
// unit into a number whose name could not carry it. Callers divide.
//
// PURE + framework-free: the clock is injectable, so the unit test drives a
// synthetic 200 ms span with zero wall-clock time and the recorder itself has
// no dependency on `performance`.

/** How many recent spans the exact-percentile ring keeps. Matches
 *  `tick-latency.ts`'s RING so the two instruments summarise over comparable
 *  windows — at ~60 fps this is the last ~4 s of frames, at the scheduler's
 *  25 ms cadence the last ~6.4 s of ticks. */
const RING = 256;

export interface RenderCostStats {
  /** What is being timed — carried in the stats so an assertion message can
   *  name its own subject rather than the caller re-typing it. */
  readonly label: string;
  /** Spans recorded since the last reset. CUMULATIVE, not ring-limited. */
  readonly calls: number;
  /** Sum of every recorded span, MILLISECONDS. CUMULATIVE. */
  readonly totalMs: number;
  /** Exact percentiles over the last {@link RING} spans, MILLISECONDS. */
  readonly p50Ms: number;
  readonly p99Ms: number;
  /** Worst span since the last reset, MILLISECONDS. NOT ring-limited. */
  readonly maxMs: number;
  /** How many spans the percentiles above were computed from. Reported so a
   *  reader can tell "0.0 ms because it is cheap" from "0.0 ms because it
   *  never ran" — the two are indistinguishable from a percentile alone, and
   *  that confusion is the documented failure mode this repo keeps hitting. */
  readonly samples: number;
  /** Wall-clock span from the first recorded span to the last, MILLISECONDS.
   *  0 when fewer than two spans were recorded. */
  readonly elapsedMs: number;
}

export interface RenderCostRecorder {
  /** Record one span of `durationMs` that ended at `endedAtMs`. */
  record(durationMs: number, endedAtMs: number): void;
  /** Read the accumulated stats. Allocates (it sorts the ring) — call at the
   *  END of a measurement window, never per frame. */
  stats(): RenderCostStats;
  /** Forget everything. Gives a spec a defined measurement window over a
   *  cumulative counter, and is the test seam for the negative control. */
  reset(): void;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

/**
 * Build a recorder for one named cost site.
 *
 * `label` is stored, not just documented: `stats().label` is what an assertion
 * message prints, so a failure names WHICH cost moved without the spec
 * re-typing (and mistyping) it.
 */
export function createRenderCostRecorder(label: string): RenderCostRecorder {
  const ring = new Float64Array(RING);
  let ringLen = 0;
  let ringPos = 0;
  let calls = 0;
  let totalMs = 0;
  let maxMs = 0;
  let firstAtMs = 0;
  let lastAtMs = 0;

  return {
    record(durationMs: number, endedAtMs: number): void {
      // A negative or non-finite span means the clock moved backwards or the
      // caller passed garbage; recording it would poison the percentiles with
      // a value no amount of code change can move. Drop it rather than
      // "clamp to 0", which would silently inflate `calls` with fiction.
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      calls++;
      totalMs += durationMs;
      if (durationMs > maxMs) maxMs = durationMs;
      if (calls === 1) firstAtMs = endedAtMs;
      lastAtMs = endedAtMs;
      ring[ringPos] = durationMs;
      ringPos = (ringPos + 1) % RING;
      if (ringLen < RING) ringLen++;
    },
    stats(): RenderCostStats {
      const sorted = Array.from(ring.subarray(0, ringLen)).sort((a, b) => a - b);
      return {
        label,
        calls,
        totalMs,
        p50Ms: percentile(sorted, 50),
        p99Ms: percentile(sorted, 99),
        maxMs,
        samples: ringLen,
        elapsedMs: calls > 1 ? Math.max(0, lastAtMs - firstAtMs) : 0,
      };
    },
    reset(): void {
      ring.fill(0);
      ringLen = 0;
      ringPos = 0;
      calls = 0;
      totalMs = 0;
      maxMs = 0;
      firstAtMs = 0;
      lastAtMs = 0;
    },
  };
}

/**
 * One-line summary for a log / HUD tooltip. Units are IN the string, always —
 * a bare `4.2` next to a bare `0.3` is exactly the unit confusion CLAUDE.md
 * says accounted for half the instrument bugs in this repo.
 */
export function formatRenderCost(s: RenderCostStats): string {
  if (s.calls === 0) return `${s.label} — never ran (0 calls)`;
  return (
    `${s.label} p50 ${s.p50Ms.toFixed(2)}ms p99 ${s.p99Ms.toFixed(2)}ms ` +
    `max ${s.maxMs.toFixed(2)}ms over ${s.calls} calls ` +
    `(${s.totalMs.toFixed(1)}ms total main-thread CPU in ${s.elapsedMs.toFixed(0)}ms wall)`
  );
}
