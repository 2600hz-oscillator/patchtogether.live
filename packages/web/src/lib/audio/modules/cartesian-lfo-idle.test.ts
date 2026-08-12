// packages/web/src/lib/audio/modules/cartesian-lfo-idle.test.ts
//
// AN IDLE CARTESIAN MUST NOT SCHEDULE AUDIOPARAM EVENTS FOR A SIGNAL NOBODY
// CAN HEAR.
//
// The embedded quadrature LFO rolls a 60 ms lookahead at LFO_DT_S (2 ms) across
// two ConstantSourceNodes — 500 `setValueAtTime` per second per output. It ran
// on every scheduler tick regardless of whether `lfo_x` / `lfo_y` were patched
// anywhere, so a cartesian dropped on the canvas and left alone scheduled ~1000
// AudioParam events a second forever, for a signal no node in the graph could
// observe. The sequencer half, meanwhile, was doing nothing at all.
//
// This test MEASURES the rate rather than asserting a shape, and it measures it
// in BOTH configurations in the same run — the unpatched rate is the finding,
// and the patched rate is the permanent negative control that stops a fix which
// simply disables the LFO from passing.
//
// ⚠ The counter is a read key on the handle (`lfoScheduledWrites`), not a spy
// on the fake AudioContext, so it counts what the MODULE believes it wrote.
// The final leg cross-checks it against the fake's recorded param events, so a
// counter that drifted from reality could not certify either number.

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
import { cartesianDef } from './cartesian';

interface SchedEvent {
  value: number;
  time: number;
}
class FakeParam {
  value = 0;
  events: SchedEvent[] = [];
  setValueAtTime(v: number, t: number) {
    this.events.push({ value: v, time: t });
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push({ value: v, time: t });
    this.value = v;
    return this;
  }
  cancelScheduledValues(fromTime: number) {
    this.events = this.events.filter((e) => e.time < fromTime);
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
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
  injected: Float32Array | null = null;
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
    const buf = this._source?.injected;
    if (buf) out.set(buf.subarray(0, out.length));
    else out.fill(0);
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
  createChannelSplitter() {
    return new FakeGain() as unknown as ChannelSplitterNode;
  }
  createChannelMerger() {
    return new FakeGain() as unknown as ChannelMergerNode;
  }
}

const NODE_ID = 'cart1';
const WINDOW_S = 1.0;

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

function seed() {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'cartesian',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as never;
}

/** Patch one of cartesian's LFO OUTPUTS into some downstream sink. */
function patchLfoOut(portId: 'lfo_x' | 'lfo_y') {
  livePatch.edges[`e_${portId}`] = {
    id: `e_${portId}`,
    source: { nodeId: NODE_ID, portId },
    target: { nodeId: 'sink', portId: 'in' },
  } as never;
}

async function build(ctx: FakeAudioContext) {
  return cartesianDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'cartesian', params: {} } as never,
  );
}

/** Writes-per-second over `WINDOW_S` of scheduler ticks. */
async function measureWriteRate(patch?: () => void): Promise<{
  rate: number;
  handle: Awaited<ReturnType<typeof build>>;
  ctx: FakeAudioContext;
}> {
  seed();
  patch?.();
  const ctx = new FakeAudioContext();
  const handle = await build(ctx);
  const before = handle.read!('lfoScheduledWrites') as number;
  for (let t = 0; t < WINDOW_S; t += 0.025) {
    ctx.currentTime = t;
    hoisted.tick!();
  }
  const after = handle.read!('lfoScheduledWrites') as number;
  return { rate: (after - before) / WINDOW_S, handle, ctx };
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('cartesian: the embedded LFO does not write when nothing listens', () => {
  it('NOTHING patched → zero LFO AudioParam writes per second', async () => {
    const { rate } = await measureWriteRate();
    expect(
      rate,
      'LFO AudioParam events per second (units: writes/s) with no cable on the module at all',
    ).toBe(0);
  });

  it('lfo_x patched → the LFO runs at its full lookahead rate', async () => {
    // PERMANENT NEGATIVE CONTROL. Without this leg, deleting the LFO outright
    // would satisfy the row above. The rate is asserted as a RANGE, not a
    // pinned count: it is a property of LFO_DT_S and the lookahead, and
    // pinning the exact number would be a hand-typed population count that
    // goes stale the moment either constant is retuned.
    const { rate } = await measureWriteRate(() => patchLfoOut('lfo_x'));
    expect(rate, 'LFO writes/s with lfo_x patched').toBeGreaterThan(100);
  });

  it('lfo_y alone is enough — the pair is scheduled together', async () => {
    const { rate } = await measureWriteRate(() => patchLfoOut('lfo_y'));
    expect(rate, 'LFO writes/s with only lfo_y patched').toBeGreaterThan(100);
  });

  it('an lfo_clock INPUT does not make an unheard LFO write', async () => {
    // The gate is deliberately output-side. A clock feeding an LFO whose
    // outputs go nowhere is still inaudible, and the module used to burn the
    // same ~1000 writes/s on it.
    const { rate } = await measureWriteRate(() => {
      livePatch.edges['e_lfoclk'] = {
        id: 'e_lfoclk',
        source: { nodeId: 'clk', portId: 'out' },
        target: { nodeId: NODE_ID, portId: 'lfo_clock' },
      } as never;
    });
    expect(rate, 'LFO writes/s with only the clock INPUT patched').toBe(0);
  });

  it('the counter agrees with the AudioParam events actually recorded', async () => {
    // Validates the instrument: `lfoScheduledWrites` is the module's own
    // bookkeeping, so cross-check it against what the fake context saw. If the
    // counter drifted from reality, both numbers above would be worthless.
    const { rate, handle, ctx } = await measureWriteRate(() => patchLfoOut('lfo_x'));
    const x = (handle.outputs.get('lfo_x')!.node as unknown as FakeConstantSource)
      .offset as unknown as FakeParam;
    const y = (handle.outputs.get('lfo_y')!.node as unknown as FakeConstantSource)
      .offset as unknown as FakeParam;
    const recorded = x.events.length + y.events.length;
    expect(recorded / WINDOW_S, 'recorded events/s matches the counter').toBe(rate);
    expect(ctx.currentTime).toBeGreaterThan(0);
  });

  it('resumes as soon as a cable lands, without emitting a stale backlog', async () => {
    seed();
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);

    // Half a second idle…
    for (let t = 0; t < 0.5; t += 0.025) {
      ctx.currentTime = t;
      hoisted.tick!();
    }
    expect(handle.read!('lfoScheduledWrites'), 'silent while unpatched').toBe(0);

    // …then a cable lands.
    patchLfoOut('lfo_x');
    ctx.currentTime = 0.5;
    hoisted.tick!();

    const wrote = handle.read!('lfoScheduledWrites') as number;
    expect(wrote, 'the very next tick starts scheduling').toBeGreaterThan(0);

    // Nothing may be scheduled in the PAST: `lfoScheduledThrough` snaps
    // forward, so the idle period must not be back-filled.
    const x = (handle.outputs.get('lfo_x')!.node as unknown as FakeConstantSource)
      .offset as unknown as FakeParam;
    const earliest = Math.min(...x.events.map((e) => e.time));
    expect(
      earliest,
      'earliest scheduled LFO sample time (units: seconds) is not before the reconnect',
    ).toBeGreaterThanOrEqual(0.5);
  });
});
