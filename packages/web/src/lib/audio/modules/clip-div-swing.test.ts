// packages/web/src/lib/audio/modules/clip-div-swing.test.ts
//
// ENGINE behavior for the single-pad Launchpad rework's two new per-clip/-lane
// timing knobs, driven through the REAL clipplayer factory + tick loop against a
// fake (advanceable) AudioContext — the same harness style as clipplayer.test.ts
// (which the clip-clock model comment points at for scheduling behavior):
//
//   • PER-CLIP DIV — a clip's `div` OVERRIDES the per-lane rate[] for its step
//     duration, LATCHED at the loop boundary so a mid-loop Clip-Div edit only
//     takes effect at the NEXT clip start; no `div` falls back to the lane rate.
//   • PER-LANE SWING — odd steps push late by swing*laneDur; swing 0 emits the
//     byte-identical un-swung even grid.
//
// Gate-high event TIMES on a lane's mono gate mark each step's emit time, so we
// read them straight off the fake param and assert the step spacing.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the scheduler-clock tick so we can drive it manually (same shape as
// clipplayer.test.ts / the other clip specs).
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
import { clipplayerDef } from './clipplayer';
import { clipIndex, type NoteClipRecord } from './clip-types';

// ---- Minimal fake AudioContext (advanceable currentTime; records param events) ----
interface SchedEvent {
  value: number;
  time: number;
}
class FakeParam {
  value = 0;
  events: SchedEvent[] = [];
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
  connect(target?: unknown, _output?: number, input?: number) {
    const t = target as { _inputs?: Record<number, FakeConstantSource> } | undefined;
    if (t && t._inputs && typeof input === 'number') t._inputs[input] = this;
  }
  disconnect() {}
}
class FakeGain {
  gain = new FakeParam();
  _inputs: Record<number, FakeConstantSource> = {};
  connect(node: unknown) {
    if (node instanceof FakeAnalyser) node._source = this;
  }
  disconnect() {}
}
class FakeAnalyser {
  fftSize = 2048;
  _source: FakeGain | null = null;
  connect() {}
  disconnect() {}
  getFloatTimeDomainData(out: Float32Array) {
    out.fill(0);
  }
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
  createAnalyser() {
    return new FakeAnalyser() as unknown as AnalyserNode;
  }
  createChannelMerger() {
    return new FakeGain() as unknown as ChannelMergerNode;
  }
}

const NODE_ID = 'cp-divswing';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}
/** A note-on EVERY step so each step's gate-high event marks its emit time. */
function allStepsClip(lengthSteps: number, extra: Partial<NoteClipRecord> = {}): NoteClipRecord {
  return {
    kind: 'note',
    steps: Array.from({ length: lengthSteps }, (_, i) => ({
      step: i,
      midi: 60,
      velocity: 127,
      lengthSteps: 1,
    })),
    lengthSteps,
    root: 48,
    loop: true,
    ...extra,
  };
}
/** Per-lane state array of length 8 with `val` at `lane`. */
function lane8<T>(lane: number, val: T, fill: T): T[] {
  const a = new Array<T>(8).fill(fill);
  a[lane] = val;
  return a;
}
function seed(params: Record<string, number>, data: Record<string, unknown>) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID, type: 'clipplayer', domain: 'audio',
    position: { x: 0, y: 0 }, params, data,
  } as never;
  livePatch.nodes['tl'] = {
    id: 'tl', type: 'timelorde', domain: 'audio',
    position: { x: 0, y: 0 }, params: { running: 1, bpm: 120 }, data: {},
  } as never;
}
async function build(ctx: FakeAudioContext) {
  return clipplayerDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'clipplayer', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}
function run(ctx: FakeAudioContext, fromS: number, toS: number, tickMs = 0.025) {
  for (let t = fromS; t < toS; t += tickMs) {
    ctx.currentTime = t;
    hoisted.tick!();
  }
}
/** Ascending times of the note-on (gate → high) edges on a lane's mono gate. */
function gateHighTimes(handle: { outputs: Map<string, { node: unknown }> }, lane: number): number[] {
  const p = (handle.outputs.get(`gate${lane + 1}`)!.node as unknown as FakeConstantSource)
    .offset as unknown as FakeParam;
  return p.events.filter((e) => e.value >= 0.5).map((e) => e.time).sort((a, b) => a - b);
}
/** Consecutive gaps between gate-high times = the per-step durations. */
function deltas(times: number[]): number[] {
  const d: number[] = [];
  for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
  return d;
}

// base step grid: stepDiv 2 @120bpm → 60/120/4 = 0.125 s/step.
const BASE = 0.125;

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('clipplayer per-clip DIV (engine)', () => {
  it("a clip's div OVERRIDES the per-lane rate for step duration", async () => {
    // lane rate = 0 (1/8 → 1.0 s/step if it were used); clip.div = 4 (2x →
    // 0.0625 s/step). The clip's div must win.
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 },
      {
        clips: { [clipIndex(0, 0)]: allStepsClip(4, { div: 4 }) },
        queued: lane8(0, 0, null),
        rate: lane8(0, 0, 3),
      },
    );
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.5);
    for (const d of deltas(gateHighTimes(handle, 0))) expect(d).toBeCloseTo(BASE / 2, 6); // 2x
  });

  it('no div ⇒ falls back to the per-lane rate (unchanged behavior)', async () => {
    // rate = 2 (1/2 → 0.25 s/step); clip has NO div.
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 },
      {
        clips: { [clipIndex(0, 0)]: allStepsClip(4) },
        queued: lane8(0, 0, null),
        rate: lane8(0, 2, 3),
      },
    );
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 1.2);
    const d = deltas(gateHighTimes(handle, 0));
    expect(d.length).toBeGreaterThan(2);
    for (const x of d) expect(x).toBeCloseTo(BASE * 2, 6); // 1/2 → 2× the base step
  });

  it('a mid-loop div edit LATCHES at the boundary (current loop unchanged, next loop adopts it)', async () => {
    // Start at div 3 ('1' → 0.125 s/step; loop = 4*0.125 = 0.5 s). Mid-loop 1,
    // switch to div 4 (2x → 0.0625). Loop 1 must stay 0.125; loop 2 adopts 0.0625.
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 },
      {
        clips: { [clipIndex(0, 0)]: allStepsClip(4, { div: 3 }) },
        queued: lane8(0, 0, null),
      },
    );
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    // Loop 1 starts + latches div=3 at step 0 (currentTime ~0).
    run(ctx, 0, 0.1);
    // Mid-loop edit (well before loop 2's step 0 schedules at ~0.31).
    const clip = (livePatch.nodes[NODE_ID]!.data as { clips: Record<string, NoteClipRecord> })
      .clips[String(clipIndex(0, 0))];
    clip.div = 4;
    run(ctx, 0.1, 1.5);

    const d = deltas(gateHighTimes(handle, 0));
    // Loop 1 = steps 0-3 (+ its last step's own duration) all at the latched
    // 0.125 — the mid-loop edit did NOT shorten the current loop.
    expect(d[0]).toBeCloseTo(BASE, 6);
    expect(d[1]).toBeCloseTo(BASE, 6);
    expect(d[2]).toBeCloseTo(BASE, 6);
    expect(d[3]).toBeCloseTo(BASE, 6); // loop1 → loop2 boundary uses loop1's div
    // Loop 2 onward re-latched to 0.0625 (2x).
    expect(d[4]).toBeCloseTo(BASE / 2, 6);
    expect(d[5]).toBeCloseTo(BASE / 2, 6);
    expect(d[6]).toBeCloseTo(BASE / 2, 6);
  });
});

describe('clipplayer per-lane SWING (engine)', () => {
  it('swing 0 is byte-identical to no swing at all (the un-swung even grid)', async () => {
    const PARAMS = { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 };

    // (a) No swing field at all (legacy path).
    seed(PARAMS, { clips: { [clipIndex(0, 0)]: allStepsClip(4) }, queued: lane8(0, 0, null) });
    const ctxA = new FakeAudioContext();
    const hA = await build(ctxA);
    run(ctxA, 0, 0.9);
    const legacy = gateHighTimes(hA, 0);

    // (b) Explicit swing 0 (the new code path, offset must be 0).
    seed(PARAMS, {
      clips: { [clipIndex(0, 0)]: allStepsClip(4) },
      queued: lane8(0, 0, null),
      swing: lane8(0, 0, 0),
    });
    const ctxB = new FakeAudioContext();
    const hB = await build(ctxB);
    run(ctxB, 0, 0.9);
    const zeroSwing = gateHighTimes(hB, 0);

    expect(zeroSwing).toEqual(legacy); // identical emit times
    expect(legacy.length).toBeGreaterThan(2);
    for (const x of deltas(legacy)) expect(x).toBeCloseTo(BASE, 6); // even grid
  });

  it('swing > 0 pushes ODD steps late while EVEN steps stay on the grid', async () => {
    // swing 0.5 @ base 0.125 → odd steps late by 0.0625. Gaps alternate
    // 0.1875 (even→odd) / 0.0625 (odd→even); even steps stay on the 0.25 grid.
    seed(
      { stepDiv: 2, quantize: 0, octave: 0, gateLength: 0.9, snh: 1 },
      {
        clips: { [clipIndex(0, 0)]: allStepsClip(4) },
        queued: lane8(0, 0, null),
        swing: lane8(0, 0.5, 0),
      },
    );
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    run(ctx, 0, 0.9);
    const t = gateHighTimes(handle, 0);
    const d = deltas(t);
    expect(d[0]).toBeCloseTo(BASE * 1.5, 6); // step0(even)→step1(odd): late
    expect(d[1]).toBeCloseTo(BASE * 0.5, 6); // step1(odd)→step2(even): early back
    expect(d[2]).toBeCloseTo(BASE * 1.5, 6);
    // even steps land exactly on the base pair-grid (2*base apart).
    expect(t[2] - t[0]).toBeCloseTo(BASE * 2, 6);
  });
});
