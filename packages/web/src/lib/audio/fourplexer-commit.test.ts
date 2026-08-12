// packages/web/src/lib/audio/fourplexer-commit.test.ts
//
// 4PLEXER's gate inputs are AUDIO-RATE PORTS, and every rising edge used to
// become a Y.Doc write.
//
// The worklet posts `{type:'sel'}` once per rising edge on `gate1..4`; the
// factory wrote each one straight into `livePatch.nodes[id].params[selN]`. The
// selector advances on a 4-cycle, so EVERY message changes the value and none
// is absorbed by the equality guard — the store-write rate is exactly the cable
// rate. A 2 kHz sine patched into a documented port produced 2000 synced param
// writes per second per output, each with a reconciler pass behind it.
//
// This file drives the REAL committer at each of those cable rates and measures
// the writes that come out. The clock and the timer are injected, so time is
// exact and the test needs no fake timers, no AudioContext and no worklet.
//
// ⚠ EVERY RATE ASSERTION IS PAIRED WITH A CONVERGENCE ASSERTION. A coalescer
// that simply dropped messages would ace every "writes/s is low" row and lose
// the user's selector position, which is worse than the storm it replaced. So
// each row also asserts the LAST value announced is the last value written.

import { describe, expect, it } from 'vitest';
import {
  createSelectorCommitter,
  fourplexerAdvanceBy,
  FOURPLEXER_COMMIT_INTERVAL_MS,
} from './fourplexer-select';

/** A deterministic clock + timer queue. `advanceTo` fires every due timer in
 *  order, exactly as setTimeout would, with no wall-clock involvement. */
function fakeScheduler() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    schedule(fn: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(h: unknown) {
      timers.delete(h as number);
    },
    /** Step time forward, running due timers as they come due. */
    advanceTo(t: number) {
      for (;;) {
        let nextId = -1;
        let nextAt = Infinity;
        for (const [id, e] of timers) {
          if (e.at <= t && e.at < nextAt) {
            nextAt = e.at;
            nextId = id;
          }
        }
        if (nextId < 0) break;
        const entry = timers.get(nextId)!;
        timers.delete(nextId);
        now = entry.at;
        entry.fn();
      }
      now = t;
    },
    pending: () => timers.size,
  };
}

interface Run {
  writes: Array<{ out: number; idx: number; at: number }>;
  posts: number;
  writeRate: number;
  postRate: number;
}

/** Drive ONE output's gate at `hz` for `seconds`, advancing the selector on
 *  every edge exactly as the worklet does, and report both rates.
 *
 *  `intervalMs: 0` reproduces the PRE-FIX module exactly — every announcement
 *  commits — and is used by the negative-control row below. */
function driveGate(hz: number, seconds: number, out = 0, intervalMs?: number): Run {
  const sched = fakeScheduler();
  const writes: Run['writes'] = [];
  const committer = createSelectorCommitter({
    now: sched.now,
    schedule: sched.schedule,
    cancel: sched.cancel,
    commit: (o, idx) => writes.push({ out: o, idx, at: sched.now() }),
    ...(intervalMs === undefined ? {} : { intervalMs }),
  });

  const periodMs = 1000 / hz;
  const edges = Math.floor(seconds * hz);
  let idx = 0;
  for (let e = 1; e <= edges; e++) {
    sched.advanceTo(e * periodMs);
    idx = fourplexerAdvanceBy(idx, 1);
    committer.post(out, idx);
  }
  // Let the trailing edge land, as it would in a live rack.
  sched.advanceTo(seconds * 1000 + FOURPLEXER_COMMIT_INTERVAL_MS * 4);
  committer.dispose();

  return {
    writes,
    posts: edges,
    writeRate: writes.length / seconds,
    postRate: edges / seconds,
  };
}

/** The index the worklet ended on, given `n` edges from 0. */
const finalIdx = (n: number) => fourplexerAdvanceBy(0, n);

const CEILING = 1000 / FOURPLEXER_COMMIT_INTERVAL_MS; // writes/s per output

describe('fourplexer: gate-advance store writes are bounded by rate, not by cable', () => {
  // The four cable rates measured on the shipping module, driven through the
  // real committer. Before this change `writeRate` equalled `postRate` in
  // every row.
  const CABLES: Array<{ label: string; hz: number }> = [
    { label: 'musical clock', hz: 8 },
    { label: 'LFO', hz: 30 },
    { label: 'AUDIO 440 Hz saw', hz: 440 },
    { label: 'AUDIO 2 kHz sine', hz: 2000 },
  ];

  it.each(CABLES)('$label ($hz Hz): consecutive writes are never closer than the window', ({ hz }) => {
    // The throttle's actual INVARIANT, asserted directly. A writes-per-second
    // ceiling would be a count, and counts land on boundary arithmetic (a 1 s
    // window legitimately holds a leading commit plus one per window, which is
    // ceiling + 1 and looks like a violation). Spacing is exact and needs no
    // fudge factor.
    const run = driveGate(hz, 1.0);
    expect(run.postRate, 'the cable really did produce that many edges (units: edges/s)')
      .toBeCloseTo(hz, 5);

    const gaps: number[] = [];
    for (let i = 1; i < run.writes.length; i++) {
      gaps.push(run.writes[i]!.at - run.writes[i - 1]!.at);
    }
    const tooClose = gaps.filter((g) => g < FOURPLEXER_COMMIT_INTERVAL_MS - 1e-9);
    expect(
      tooClose,
      `gaps between consecutive store writes below the ${FOURPLEXER_COMMIT_INTERVAL_MS} ms ` +
        `window (units: ms) for a ${hz} Hz gate`,
    ).toEqual([]);
  });

  it.each(CABLES.filter((c) => c.hz > CEILING))(
    '$label ($hz Hz) actually gets throttled — writes < edges',
    ({ hz }) => {
      // The finding itself: before this change writes/s EQUALLED the cable
      // rate, so a 2 kHz sine produced 2000 Y.Doc writes a second per output.
      //
      // This is a strict inequality rather than a reduction FACTOR on purpose.
      // The factor is a function of how far the cable sits above the ceiling —
      // ~1.4x at 30 Hz, ~95x at 2 kHz — so any single threshold would either
      // be vacuous at the top or wrong at the bottom. The spacing invariant
      // above already bounds the rate; this row exists so that bound cannot
      // pass VACUOUSLY on a run that emitted one or two writes.
      const run = driveGate(hz, 1.0);
      expect(
        run.writes.length,
        `store writes vs ${run.posts} gate edges over 1.0 s at ${hz} Hz`,
      ).toBeLessThan(run.posts);
      expect(run.writes.length, 'and it is not throttled to silence').toBeGreaterThan(1);
    },
  );

  it.each(CABLES)('$label ($hz Hz) still persists the FINAL selector position', ({ hz }) => {
    // The convergence half. A coalescer that dropped its tail would pass the
    // rate rows above and silently lose the user's selector position.
    const run = driveGate(hz, 1.0);
    const last = run.writes[run.writes.length - 1];
    expect(last, 'something was written').toBeDefined();
    expect(
      last!.idx,
      'the last value WRITTEN is the last value the worklet ANNOUNCED',
    ).toBe(finalIdx(run.posts));
  });

  // PERMANENT NEGATIVE CONTROL ON THE HARNESS, and the pre-fix measurement
  // kept as a live row rather than a claim in a commit message. A zero-length
  // window IS the old module: every announcement commits. If the harness could
  // not observe the storm, every row above would be meaningless.
  it.each(CABLES)('$label ($hz Hz): a ZERO window reproduces the storm 1:1', ({ hz }) => {
    const storm = driveGate(hz, 1.0, 0, 0);
    expect(
      storm.writes.length,
      `un-throttled store writes over 1.0 s at ${hz} Hz — one per gate edge, ` +
        `which is what shipped (units: Y.Doc writes)`,
    ).toBe(storm.posts);

    // …and the same cable through the real window is strictly fewer, so the
    // two rows cannot both be measuring the same thing.
    const throttled = driveGate(hz, 1.0);
    expect(throttled.writes.length).toBeLessThanOrEqual(storm.writes.length);
  });

  it('a musical clock is not throttled at all — every edge writes, immediately', () => {
    // PERMANENT NEGATIVE CONTROL on the throttle. Without it, an
    // implementation that simply committed once per second would pass every
    // ceiling row above. A 16th at 300 bpm is 50 ms, so ordinary sequencing
    // rates must ride the leading edge untouched.
    const run = driveGate(8, 1.0);
    expect(run.writeRate, 'an 8 Hz clock writes on every edge').toBe(8);

    // …and each write lands on the edge itself, not at the end of a window.
    const period = 1000 / 8;
    for (let i = 0; i < run.writes.length; i++) {
      expect(run.writes[i]!.at, `write ${i} lands on its own edge (units: ms)`)
        .toBeCloseTo((i + 1) * period, 6);
    }
  });

  it('the very first edge after a quiet period commits with no delay', () => {
    const sched = fakeScheduler();
    const writes: number[] = [];
    const c = createSelectorCommitter({
      now: sched.now,
      schedule: sched.schedule,
      cancel: sched.cancel,
      commit: (_o, idx) => writes.push(idx),
    });
    c.post(0, 1);
    expect(writes, 'leading edge is immediate').toEqual([1]);
    c.dispose();
  });

  it('outputs are throttled independently — one busy gate cannot starve another', () => {
    const sched = fakeScheduler();
    const writes: Array<{ out: number; idx: number }> = [];
    const c = createSelectorCommitter({
      now: sched.now,
      schedule: sched.schedule,
      cancel: sched.cancel,
      commit: (out, idx) => writes.push({ out, idx }),
    });
    // out 0 hammered; out 3 turned once. Both must be seen.
    for (let i = 0; i < 100; i++) {
      sched.advanceTo(i * 0.5);
      c.post(0, fourplexerAdvanceBy(0, i + 1));
    }
    c.post(3, 2);
    sched.advanceTo(500);
    c.dispose();
    expect(writes.some((w) => w.out === 3 && w.idx === 2), 'the quiet output got through').toBe(true);
  });

  it('flush() writes a value still inside its window (dispose must not drop the tail)', () => {
    const sched = fakeScheduler();
    const writes: number[] = [];
    const c = createSelectorCommitter({
      now: sched.now,
      schedule: sched.schedule,
      cancel: sched.cancel,
      commit: (_o, idx) => writes.push(idx),
    });
    c.post(0, 1); // leading edge, commits
    sched.advanceTo(1);
    c.post(0, 2); // inside the window, pending
    expect(writes, 'still pending, correctly').toEqual([1]);
    c.flush();
    expect(writes, 'flush lands the tail').toEqual([1, 2]);
    c.dispose();
  });

  it('leaves no timer running after dispose', () => {
    const sched = fakeScheduler();
    const c = createSelectorCommitter({
      now: sched.now,
      schedule: sched.schedule,
      cancel: sched.cancel,
      commit: () => {},
    });
    c.post(0, 1);
    sched.advanceTo(1);
    c.post(0, 2);
    expect(sched.pending(), 'a trailing timer is armed').toBeGreaterThan(0);
    c.dispose();
    expect(sched.pending(), 'and cancelled on dispose').toBe(0);
  });
});
