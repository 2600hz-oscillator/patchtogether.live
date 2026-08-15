// packages/web/src/lib/audio/edge-detect.property.test.ts
//
// fast-check property suite for `createEdgeCounter` (#1526) — the single seam
// for MAIN-THREAD rising-edge detection, and the one CLAUDE.md names by hand:
// "NEVER re-scan a whole AnalyserNode buffer — the 2048-sample ring (~42 ms)
// overlaps the ~25 ms scheduler tick, so a whole-buffer rescan counts the same
// edge twice (one clock pulse advances two steps)."
//
// That bug (NUMPAD+ / ATLANTIS-CATALYST) is a WINDOWING law, and a windowing
// law is exactly what an example test cannot pin: it holds or fails as a
// function of the ALIGNMENT between an arbitrary pulse train and an arbitrary
// tick schedule, and the hand-written cases only ever pin the alignments
// someone thought to type. Here it is the property:
//
//   P1 CONSERVATION — over ANY pulse train and ANY sequence of poll times,
//      the counts summed across polls equal the number of rising edges that
//      actually occurred in the covered span. Not "≤" (that would pass on a
//      counter that returns 0 forever) and not "≥" — EQUAL.
//   P2 NO PHANTOMS  — a flat stream yields exactly zero, at any tick schedule.
//   P3 RESET        — reset() makes the next poll behave like the first.
//   P4 NON-NEGATIVE — a poll never returns a negative count.
//
// THE INSTRUMENT. The subject reads `ctx.currentTime`, `ctx.sampleRate` and
// `analyser.getFloatTimeDomainData(buf)`, so the fake below must model a real
// AnalyserNode exactly: at time t the ring holds the most recent `fftSize`
// samples of the stream, i.e. `stream[n - fftSize .. n - 1]` where
// `n = floor(t * sampleRate)`, zero-padded before the stream starts. Getting
// that floor wrong would make the harness — not the code — decide the result,
// which is the "validate the instrument" failure this repo keeps hitting. The
// harness is negative-controlled against the whole-buffer rescan below.
//
// PERMANENT NEGATIVE CONTROL: `countWithWholeBufferRescan` is the DEFECT —
// the same poll loop with `start = 0`. It is required to OVER-count on the
// same generated inputs. If it ever stops over-counting, the harness has
// stopped presenting overlapping windows and P1 is passing vacuously.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createEdgeCounter } from './edge-detect';
import { GATE_HI } from './gate-trigger';
import { createRisingEdgeDetector } from './modules/transport-helpers';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 2048;

// ---------------------------------------------------------------------------
// The fake AnalyserNode + BaseAudioContext.
// ---------------------------------------------------------------------------

interface Harness {
  ctx: BaseAudioContext;
  analyser: AnalyserNode;
  /** Move the context clock to `t` seconds. */
  seek(t: number): void;
}

function makeHarness(stream: Float32Array, fftSize = FFT_SIZE): Harness {
  let now = 0;
  const ctx = {
    get currentTime() {
      return now;
    },
    sampleRate: SAMPLE_RATE,
  } as unknown as BaseAudioContext;

  const analyser = {
    fftSize,
    getFloatTimeDomainData(out: Float32Array) {
      // Exactly the Web Audio contract: the most recent `fftSize` samples
      // produced up to `currentTime`, zero-padded before the stream starts.
      const produced = Math.floor(now * SAMPLE_RATE);
      const first = produced - fftSize;
      for (let i = 0; i < fftSize; i++) {
        const idx = first + i;
        out[i] = idx >= 0 && idx < stream.length ? (stream[idx] as number) : 0;
      }
    },
  } as unknown as AnalyserNode;

  return { ctx, analyser, seek: (t) => { now = t; } };
}

/** Ground truth: rising edges in `stream[0, endSample)`, from a level that
 *  starts LOW — the same initial condition `createRisingEdgeDetector` uses. */
function trueRisingEdges(stream: Float32Array, endSample: number, threshold = GATE_HI): number {
  let last = 0;
  let n = 0;
  for (let i = 0; i < Math.min(endSample, stream.length); i++) {
    const cur = stream[i] as number;
    if (last < threshold && cur >= threshold) n++;
    last = cur;
  }
  return n;
}

/** THE DEFECT, kept alive as a control: the same poll loop that re-scans the
 *  WHOLE ring every tick instead of only the samples that arrived. This is
 *  what several modules did before edge-detect.ts existed. */
function countWithWholeBufferRescan(h: Harness, times: readonly number[]): number {
  const buf = new Float32Array(FFT_SIZE);
  const detector = createRisingEdgeDetector(GATE_HI);
  let total = 0;
  for (const t of times) {
    h.seek(t);
    h.analyser.getFloatTimeDomainData(buf);
    total += detector.scan(buf, 0, buf.length); // ← start = 0: the bug
  }
  return total;
}

/** The subject, driven through the same harness. */
function countWithEdgeCounter(h: Harness, times: readonly number[]): number {
  const counter = createEdgeCounter({ ctx: h.ctx, analyser: h.analyser });
  let total = 0;
  for (const t of times) {
    h.seek(t);
    const n = counter.poll(t);
    expect(n, `poll(${t}) returned a negative count`).toBeGreaterThanOrEqual(0);
    total += n;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/**
 * A pulse train: gate-high runs separated by gate-low runs, in SAMPLES.
 * Widths are generated independently so pulses land at arbitrary phases
 * relative to any tick grid — the alignment is the whole point.
 */
const pulseTrain = fc
  .array(
    fc.record({
      lowSamples: fc.integer({ min: 1, max: 4000 }),
      highSamples: fc.integer({ min: 1, max: 2000 }),
      level: fc.double({ min: 0.5, max: 1.5, noNaN: true, noDefaultInfinity: true }),
    }),
    { minLength: 1, maxLength: 12 },
  )
  .map((pulses) => {
    const total = pulses.reduce((s, p) => s + p.lowSamples + p.highSamples, 0);
    const stream = new Float32Array(total + FFT_SIZE);
    let i = 0;
    for (const p of pulses) {
      i += p.lowSamples; // already zero
      for (let k = 0; k < p.highSamples; k++) stream[i++] = p.level;
    }
    return stream;
  });

/**
 * Poll times. The scheduler ticks at ~25 ms; the ring holds ~42.7 ms, so a
 * tick LONGER than the ring genuinely loses samples and no counter could
 * conserve. The generator therefore stays inside the ring — that is the
 * documented operating envelope (`fftSize should comfortably exceed the tick
 * interval`), not a convenience.
 */
const MAX_TICK_S = (FFT_SIZE / SAMPLE_RATE) * 0.9; // 38.4 ms
const tickSchedule = fc
  .array(fc.double({ min: 0.001, max: MAX_TICK_S, noNaN: true, noDefaultInfinity: true }), {
    minLength: 2,
    maxLength: 60,
  })
  .map((deltas) => {
    const times: number[] = [];
    let t = 0;
    for (const d of deltas) {
      t += d;
      times.push(t);
    }
    return times;
  });

describe('createEdgeCounter properties', () => {
  it('P1: counts are CONSERVED across any pulse train and any tick schedule', () => {
    fc.assert(
      fc.property(pulseTrain, tickSchedule, (stream, times) => {
        const h = makeHarness(stream);
        const got = countWithEdgeCounter(h, times);
        const last = times[times.length - 1] as number;
        const want = trueRisingEdges(stream, Math.floor(last * SAMPLE_RATE));
        expect(
          got,
          `edge count drifted: counted ${got}, actual ${want} rising edges in ` +
            `${Math.floor(last * SAMPLE_RATE)} samples over ${times.length} polls ` +
            `(sr=${SAMPLE_RATE}, fftSize=${FFT_SIZE}). ` +
            `OVER-count = the overlap double-count bug; UNDER-count = a window gap.`,
        ).toBe(want);
      }),
      { numRuns: 400, seed: 15271 },
    );
  });

  it('P2: a flat stream produces exactly zero edges at any tick schedule', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, 0.49, 1, -1),
        tickSchedule,
        (level, times) => {
          const stream = new Float32Array(200_000).fill(level);
          const h = makeHarness(stream);
          // A stream that starts ABOVE threshold has exactly one rising edge
          // at sample 0 (the detector's initial level is 0, i.e. LOW).
          const want = level >= GATE_HI ? 1 : 0;
          expect(
            countWithEdgeCounter(h, times),
            `flat stream at level ${level} over ${times.length} polls`,
          ).toBe(want);
        },
      ),
      { numRuns: 200, seed: 15272 },
    );
  });

  it('P3: reset() re-arms — the next poll behaves like the first', () => {
    fc.assert(
      fc.property(pulseTrain, tickSchedule, (stream, times) => {
        fc.pre(times.length >= 4);
        const mid = Math.floor(times.length / 2);
        const h = makeHarness(stream);
        const counter = createEdgeCounter({ ctx: h.ctx, analyser: h.analyser });

        for (const t of times.slice(0, mid)) {
          h.seek(t);
          counter.poll(t);
        }
        // reset() re-anchors lastSampleTime to ctx.currentTime, so the poll
        // AFTER it sees only the samples since the reset instant.
        h.seek(times[mid] as number);
        counter.reset();
        let after = 0;
        for (const t of times.slice(mid + 1)) {
          h.seek(t);
          after += counter.poll(t);
        }

        const from = Math.floor((times[mid] as number) * SAMPLE_RATE);
        const to = Math.floor((times[times.length - 1] as number) * SAMPLE_RATE);
        const all = trueRisingEdges(stream, to);
        const before = trueRisingEdges(stream, from);
        // The window boundary can attribute the edge sitting exactly ON the
        // reset sample to either side, so the law is stated as the tight
        // ±1-sample bracket rather than as a single number.
        expect(
          after,
          `after reset at t=${times[mid]} counted ${after}, expected the ` +
            `${all - before} edges in samples [${from}, ${to})`,
        ).toBeGreaterThanOrEqual(all - before - 1);
        expect(after).toBeLessThanOrEqual(all - before + 1);
      }),
      { numRuns: 300, seed: 15273 },
    );
  });

  // -------------------------------------------------------------------
  // PERMANENT NEGATIVE CONTROL.
  //
  // P1 asserts equality. The failure it exists to catch is the whole-buffer
  // rescan, so the rescan must be DEMONSTRABLY caught: same harness, same
  // generated inputs, `start = 0` instead of the window. If this ever finds
  // no over-count, the harness has stopped producing overlapping ring reads
  // and P1 is no longer testing the thing it is named after.
  // -------------------------------------------------------------------
  it('CONTROL: the whole-buffer rescan OVER-counts on the same inputs (P1 can fail)', () => {
    let checked = 0;
    let overCounted = 0;
    const worst: string[] = [];

    fc.assert(
      fc.property(pulseTrain, tickSchedule, (stream, times) => {
        const truth = trueRisingEdges(
          stream,
          Math.floor((times[times.length - 1] as number) * SAMPLE_RATE),
        );
        fc.pre(truth > 0); // a stream with no edges cannot distinguish the two
        checked++;
        const buggy = countWithWholeBufferRescan(makeHarness(stream), times);
        if (buggy > truth) {
          overCounted++;
          if (worst.length < 3) {
            worst.push(`${times.length} polls: rescan counted ${buggy} of ${truth} real edges`);
          }
        }
        // The rescan can never UNDER-count — it sees a superset of the samples.
        expect(
          buggy,
          `the control under-counted (${buggy} < ${truth}); the harness is not ` +
            'presenting the ring the way a real AnalyserNode does',
        ).toBeGreaterThanOrEqual(truth);
      }),
      { numRuns: 300, seed: 15274 },
    );

    expect(checked, 'the control ran no cases with any edges at all').toBeGreaterThan(0);
    expect(
      overCounted,
      `the whole-buffer rescan produced the CORRECT count on all ${checked} ` +
        'generated cases. That is not possible if the harness presents an ' +
        'AnalyserNode ring that overlaps the tick interval — so P1 above is no ' +
        'longer able to observe the double-count bug it exists to prevent.',
    ).toBeGreaterThan(0);
    expect(worst.join('\n')).toMatch(/rescan counted/);
  });
});
