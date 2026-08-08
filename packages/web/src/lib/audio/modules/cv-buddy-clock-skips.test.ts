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
