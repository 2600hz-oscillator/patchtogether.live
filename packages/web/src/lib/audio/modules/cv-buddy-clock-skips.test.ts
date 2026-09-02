// packages/web/src/lib/audio/modules/cv-buddy-clock-skips.test.ts
//
// The LATE-TICK COUNTER as the card actually consumes it.
//
// `clock-math.test.ts` already proves `advanceClock` RETURNS the right
// `skipped` number. This file proves the number survives the trip to the card:
// it drives the REAL factory + tick loop against a fake AudioContext and reads
// `handle.read('state').skips` — the exact call CvBuddyBody polls.
//
// ⚠ WHY THIS FILE EXISTS AT ALL, i.e. what a passing clock-math suite cannot
// see. `skipped` is computed correctly and then has to be accumulated onto a
// closure variable, folded into the `read('state')` object, and picked up by a
// poll. Every one of those is a place the number can be dropped while
// clock-math stays green — and the failure mode is a readout that says a
// confident, permanent "0 skipped". That is strictly worse than no readout,
// because the whole point of the counter is to let the owner tell a
// main-thread stall from an ES-9 underrun. A gauge welded to zero doesn't
// report "healthy", it reports "healthy" indistinguishably from "broken".
//
// So the counter is negative-controlled in BOTH directions here, on every run:
//   * a healthy on-time clock must report exactly 0 (a gauge stuck ON would
//     cry wolf and make the owner chase a stall that isn't there), and
//   * a stalled tick must make it RISE (a gauge stuck OFF is the case above).
// Neither leg is meaningful without the other.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ tick: null as null | (() => void) }));
vi.mock('$lib/audio/scheduler-clock', () => ({
  SCHEDULER_TICK_MS: 25,
  getSchedulerClock: () => ({
    subscribe: (fn: () => void) => {
      hoisted.tick = fn;
      return () => {
        hoisted.tick = null;
      };
    },
    usingWorker: false,
    dispose: () => {},
  }),
}));

import { patch as livePatch } from '$lib/graph/store';
import { cvBuddyDef, type CvBuddyClockState } from './cv-buddy';

// ---------------------------------------------------------------- fake audio
class FakeParam {
  value = 0;
  events: Array<{ value: number; time: number }> = [];
  setValueAtTime(value: number, time: number) {
    this.events.push({ value, time });
    this.value = value;
    return this;
  }
  cancelScheduledValues(fromTime: number) {
    this.events = this.events.filter((e) => e.time < fromTime);
    return this;
  }
}
class FakeConstantSource {
  offset = new FakeParam();
  start() {}
  stop() {}
  connect() {}
  disconnect() {}
}
class FakeGain {
  gain = new FakeParam();
  connect() {}
  disconnect() {}
}
class FakeAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  createConstantSource() {
    return new FakeConstantSource() as unknown as ConstantSourceNode;
  }
  createGain() {
    return new FakeGain() as unknown as GainNode;
  }
}

// ---------------------------------------------------------------- the rack
const NODE_ID = 'cvb1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

/** One CV Buddy (so it owns the clock) + a TIMELORDE at `bpm`, running or not. */
function seed(opts: { bpm: number; running: boolean }) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'cvBuddy',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { ppqn: 24, clockOffsetMs: 0 },
  } as never;
  livePatch.nodes['tl1'] = {
    id: 'tl1',
    type: 'timelorde',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { bpm: opts.bpm, running: opts.running ? 1 : 0 },
  } as never;
}

async function build(ctx: FakeAudioContext) {
  return cvBuddyDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'cvBuddy', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}

/** What the card polls, nothing more. */
function cardState(handle: { read?: (k: string) => unknown }): CvBuddyClockState {
  return handle.read!('state') as CvBuddyClockState;
}

/** Run `n` ticks, advancing the clock by `stepS` of WALL time between each. */
function runTicks(ctx: FakeAudioContext, n: number, stepS: number) {
  for (let i = 0; i < n; i++) {
    hoisted.tick!();
    ctx.currentTime += stepS;
  }
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('CV Buddy — the late-tick counter reaches the card', () => {
  it('exposes skips on read("state") alongside the clock fields the card shows', async () => {
    seed({ bpm: 120, running: true });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    const st = cardState(handle);
    // The card renders all four; a missing key would render `undefined skipped`.
    expect(st).toEqual({ ownsClock: true, running: true, bpm: 120, skips: 0 });
    expect(typeof st.skips).toBe('number');
  });

  it('NEGATIVE CONTROL (stuck-ON): a healthy, on-time clock reports exactly 0', async () => {
    // 25 ms ticks against a 200 ms lookahead — every pulse is scheduled well
    // ahead of time. If this ever reports non-zero the readout is noise and the
    // owner would chase a main-thread stall that never happened.
    seed({ bpm: 120, running: true });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    runTicks(ctx, 200, 0.025); // 5 s of transport at a healthy cadence
    expect(cardState(handle).skips).toBe(0);
  });

  it('a STALLED tick raises the count, and the card sees the rise', async () => {
    seed({ bpm: 120, running: true });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    runTicks(ctx, 4, 0.025); // settle into a healthy train
    expect(cardState(handle).skips).toBe(0);

    // The main thread wedges for 5 s and only then ticks again. At 120 BPM /
    // 24 PPQN (~20.83 ms/pulse) that is ~240 pulses that could not be placed.
    // The 200 ms lookahead covers only the tail of the gap.
    ctx.currentTime += 5;
    hoisted.tick!();

    const after = cardState(handle).skips;
    expect(after).toBeGreaterThan(200);
    expect(after).toBeLessThan(300);
  });

  it('the count is CUMULATIVE — a second stall adds to the first', async () => {
    // It must not reset per tick: a blip that clears before the 1 Hz card poll
    // would be invisible exactly when someone is looking for it.
    seed({ bpm: 120, running: true });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    runTicks(ctx, 2, 0.025);
    ctx.currentTime += 2;
    hoisted.tick!();
    const first = cardState(handle).skips;
    expect(first).toBeGreaterThan(0);

    ctx.currentTime += 2;
    hoisted.tick!();
    expect(cardState(handle).skips).toBeGreaterThan(first);
  });

  it('NEGATIVE CONTROL (stuck-OFF): a STOPPED transport accrues nothing over the same gap', async () => {
    // Same 5 s gap as the stall test, but not running. The clock is not
    // scheduling, so there is nothing to miss — a count here would mean the
    // counter tracks wall-clock rather than lost pulses, and it would climb
    // forever on an idle rack.
    seed({ bpm: 120, running: false });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    runTicks(ctx, 4, 0.025);
    ctx.currentTime += 5;
    hoisted.tick!();

    const st = cardState(handle);
    expect(st.running).toBe(false);
    expect(st.skips).toBe(0);
  });

  it('a NON-OWNER instance never accrues skips (it has no clock to lose)', async () => {
    // Two CV Buddies: the id-smallest owns the clock. The other must stay at 0
    // through the same stall, or every extra CV Buddy on the rack would show a
    // phantom fault.
    seed({ bpm: 120, running: true });
    livePatch.nodes['cvb0'] = {
      id: 'cvb0',
      type: 'cvBuddy',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { ppqn: 24, clockOffsetMs: 0 },
    } as never;

    const ctx = new FakeAudioContext();
    const handle = await build(ctx); // this is 'cvb1' — NOT the id-smallest

    runTicks(ctx, 4, 0.025);
    ctx.currentTime += 5;
    hoisted.tick!();

    const st = cardState(handle);
    expect(st.ownsClock).toBe(false);
    expect(st.skips).toBe(0);
  });

  it('readParam("clockSkips") stays as a legacy alias reporting the same number', async () => {
    seed({ bpm: 120, running: true });
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    runTicks(ctx, 2, 0.025);
    ctx.currentTime += 3;
    hoisted.tick!();

    expect(handle.readParam!('clockSkips')).toBe(cardState(handle).skips);
    expect(handle.readParam!('clockSkips')).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ANTI-BURST INVARIANT — what a dropped pulse must never turn into.
//
// Provenance: a live performance (SPEEDERR-001, 2026-09-02) where the CV clock
// fed two Pamela's Workouts and a Böhm off a passive split. Analysis of the
// recording found the pulse grid locked to ±0.002 pulses (±0.3 ms) for 88 s,
// then ONE clean +1.000-pulse step at t≈90.0 s — a single LOST edge, with no
// extra edges anywhere in the take. `advanceClock` already drops-and-counts
// rather than flushing, which is why the take shows a lost edge and not a
// burst, and that is the behaviour this block welds down.
//
// Why it needs its own coverage even though `clock-math.test.ts` is green:
// clock-math proves the RETURNED array is right. It cannot see what the tick
// loop does with it. The dangerous regression is one line in `tick()` —
// widening the window backwards, dropping the `Math.max(clockThrough, now)`
// floor, or re-scheduling a window already emitted — any of which re-emits
// past-due pulses. WebAudio then clamps every past timestamp to "now" and the
// train leaves as a clump of near-simultaneous edges. Downstream that is the
// worst possible failure: an edge-COUNTING follower that internally multiplies
// (a PAM) turns one flushed pair into triple/quad fires, and every follower on
// the split takes the same hit at once.
//
// So the invariant is asymmetric on purpose, and it is stated in the direction
// hardware forgives: a clock may EMIT FEWER edges than the grid demands, never
// more, and never two closer together than one period. A follower re-locks
// from a missing pulse; it cannot un-hear a burst.
describe('CV Buddy — a missed deadline DROPS pulses, it never flushes them', () => {
  /** Rising edges actually written to the `clock` jack, in schedule order. */
  function risingEdges(handle: {
    outputs?: Map<string, { node: unknown }>;
  }): number[] {
    const node = handle.outputs!.get('clock')!.node as unknown as FakeConstantSource;
    return node.offset.events.filter((e) => e.value === 1).map((e) => e.time);
  }

  /**
   * The checker, shared by the real clock and the positive control below.
   * Returns every way a train violates the invariant, so a failure names the
   * mode rather than just "false".
   */
  function burstViolations(edges: number[], periodS: number): string[] {
    const bad: string[] = [];
    const eps = periodS * 1e-6;
    for (let i = 1; i < edges.length; i++) {
      const gap = edges[i]! - edges[i - 1]!;
      if (gap < periodS - eps) {
        bad.push(
          `edge ${i} at ${edges[i]!.toFixed(6)}s is ${(gap * 1000).toFixed(3)}ms after its ` +
            `predecessor — closer than one ${(periodS * 1000).toFixed(3)}ms period`,
        );
      }
    }
    return bad;
  }

  /** Distance from the nearest grid point, in periods. */
  function offGridBy(edges: number[], periodS: number): number {
    if (edges.length === 0) return 0;
    let worst = 0;
    for (const e of edges) {
      const n = (e - edges[0]!) / periodS;
      worst = Math.max(worst, Math.abs(n - Math.round(n)));
    }
    return worst;
  }

  // The performance's own numbers, so a regression is measured where it bit.
  const BPM = 94.08761422877872;
  const PPQN = 4;
  const PERIOD = 60 / BPM / PPQN; // ≈ 159.42 ms

  function seedPerf() {
    clearPatch();
    livePatch.nodes[NODE_ID] = {
      id: NODE_ID,
      type: 'cvBuddy',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { ppqn: PPQN, clockOffsetMs: 0 },
    } as never;
    livePatch.nodes['tl1'] = {
      id: 'tl1',
      type: 'timelorde',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { bpm: BPM, running: 1 },
    } as never;
  }

  it('a 300 ms main-thread wedge loses pulses WITHOUT bunching the survivors', async () => {
    seedPerf();
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    runTicks(ctx, 40, 0.025); // 1 s of healthy transport
    const beforeSkips = cardState(handle).skips;
    expect(beforeSkips).toBe(0);

    // The wedge. 300 ms > the 200 ms lookahead, so at 159.42 ms/pulse exactly
    // one pulse comes due with no window able to hold it — the performance's
    // failure, reproduced.
    ctx.currentTime += 0.3;
    hoisted.tick!();

    runTicks(ctx, 40, 0.025); // and the clock carries on

    expect(cardState(handle).skips).toBeGreaterThan(0);

    const edges = risingEdges(handle);
    expect(edges.length).toBeGreaterThan(5);
    expect(burstViolations(edges, PERIOD)).toEqual([]);
  });

  it('every surviving edge stays ON the original grid — the phase never teleports', async () => {
    // The other half of "dropped, not flushed": a clock that re-anchored to the
    // recovery instant would keep its RATE while silently re-phasing, so the
    // followers would land a fraction of a pulse off forever after.
    seedPerf();
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    runTicks(ctx, 20, 0.025);
    ctx.currentTime += 0.42; // a wedge that is NOT a whole number of periods
    hoisted.tick!();
    runTicks(ctx, 40, 0.025);

    const edges = risingEdges(handle);
    expect(offGridBy(edges, PERIOD)).toBeLessThan(1e-6);
  });

  it('no edge is ever scheduled into the PAST (the clamp-to-now burst source)', async () => {
    // WebAudio silently clamps a past timestamp to the current time. That clamp
    // is the mechanism that turns a backlog into a clump, so the assertion is
    // made where it is still visible: at the setValueAtTime call site.
    seedPerf();
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    const node = handle.outputs!.get('clock')!.node as unknown as FakeConstantSource;

    let seen = 0;
    const stalls = [0.025, 0.025, 0.9, 0.025, 0.3, 0.025, 2.5, 0.025];
    for (const dt of stalls) {
      hoisted.tick!();
      for (const e of node.offset.events.slice(seen)) {
        expect(e.time).toBeGreaterThanOrEqual(ctx.currentTime);
      }
      seen = node.offset.events.length;
      ctx.currentTime += dt;
    }
  });

  it('CONSERVATION: every grid point is either EMITTED or COUNTED as skipped', async () => {
    // The aggregate law behind the two checks above, and the one that makes the
    // skip counter trustworthy as a diagnostic rather than decorative: across a
    // span containing a stall, emitted edges + reported skips must account for
    // the grid EXACTLY. A duplicated pulse inflates the left side; a pulse
    // dropped without incrementing the counter deflates it. Either way the
    // owner's readout stops meaning "this many edges the gear never saw", which
    // is the only reason the number is on the card.
    seedPerf();
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    runTicks(ctx, 10, 0.025);
    ctx.currentTime += 3; // a 3 s wedge — ~19 pulses lost
    hoisted.tick!();
    runTicks(ctx, 80, 0.025);

    const edges = risingEdges(handle);
    const skips = cardState(handle).skips;
    // The grid the transport asked for, from the first edge to the last window.
    const spanned = (edges[edges.length - 1]! - edges[0]!) / PERIOD + 1;

    expect(skips).toBeGreaterThan(0);
    // ±1 for the half-open window boundary; anything larger is a real leak.
    expect(Math.abs(edges.length + skips - spanned)).toBeLessThanOrEqual(1);
  });

  it('POSITIVE CONTROL: the checker CATCHES a flushing scheduler', () => {
    // Without this the four assertions above are unfalsifiable — a checker that
    // cannot fail would pass just as happily against the enqueue-and-flush bug
    // it exists to forbid. So the naive scheduler is built here on purpose and
    // fed through the SAME `burstViolations`, which must reject it.
    const LOOKAHEAD = 0.2;
    const emitted: number[] = [];
    let next = 0;
    let now = 0;
    const naiveTick = () => {
      while (next < now + LOOKAHEAD) {
        emitted.push(Math.max(next, now)); // ← the WebAudio clamp, modelled
        next += PERIOD;
      }
    };
    for (const dt of [0.025, 0.025, 0.025, 1.0, 0.025, 0.025]) {
      naiveTick();
      now += dt;
    }

    const violations = burstViolations(emitted, PERIOD);
    expect(violations.length).toBeGreaterThan(0);
    // …and it is the clump we claim: several edges at the same clamped instant.
    expect(violations[0]).toMatch(/closer than one/);
  });
});
