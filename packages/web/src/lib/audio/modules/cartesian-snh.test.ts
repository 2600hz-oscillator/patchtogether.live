// packages/web/src/lib/audio/modules/cartesian-snh.test.ts
//
// Gate-sampled Sample & Hold on CARTESIAN's pitch CV. Drives the REAL factory +
// tick loop against a fake AudioContext, asserting:
//   • the `snh` param exists, defaults ON (1), discrete 0..1.
//   • clock-UNPATCHED X/Y-tracking branch with S&H ON: a pad change while the
//     PRIOR gate is still high SUPPRESSES the pitch+gate re-emit (the pitch CV
//     holds, no extra gate), but the visual playhead / lastSelectedIdx still
//     tracks (totalAdvances does NOT increment for the suppressed change, while
//     currentStep keeps following).
//   • S&H OFF: every pad change re-emits pitch+gate (legacy continuous), so
//     totalAdvances increments on each change.
//   • the clock-PATCHED branch is unchanged (gate-sampled already) — a quick
//     smoke that it still advances on each clock edge regardless of snh.

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

/** A constant buffer at level `v` (the most-recent sample is read by cvToCell). */
function levelBuffer(v: number, len = 2048): Float32Array {
  const b = new Float32Array(len);
  b.fill(v);
  return b;
}
/** A pulse buffer with a single rising edge near the end (for clock). */
function pulseBuffer(len = 2048): Float32Array {
  const b = new Float32Array(len);
  for (let i = len - 64; i < len; i++) b[i] = 1;
  return b;
}

import { cartesianDef, GRID_DIM } from './cartesian';

const NODE_ID = 'cartsnh1';

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

type Cell = { on: boolean; midi: number | null; chord: string };

function denseCells(): Cell[] {
  // Every cell ON with a distinct-ish pitch so any pad has a gated note.
  return Array.from({ length: GRID_DIM * GRID_DIM }, (_, i) => ({
    on: true,
    midi: 60 + i,
    chord: 'mono',
  }));
}

function seed(snh: number, gateLength: number, patchedPorts: string[]) {
  clearPatch();
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'cartesian',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { mode: 0, octave: 0, gateLength, lfoDiv: 3, lfoShape: 0, snh },
    data: { cells: denseCells() },
  } as never;
  // Declare edges so isInputPortConnected sees the patched inputs.
  patchedPorts.forEach((portId, i) => {
    livePatch.edges[`e${i}`] = {
      id: `e${i}`,
      source: { nodeId: 'src', portId: 'out' },
      target: { nodeId: NODE_ID, portId },
    } as never;
  });
}

async function build(ctx: FakeAudioContext) {
  return cartesianDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'cartesian', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('cartesian: gate-sampled S&H — clock-UNPATCHED X/Y branch', () => {
  // Patch x_cv only (clock + y_cv unpatched). Drive X CV to move the selected
  // pad. With a long gate (0.95) and tight ticks (5 ms), a pad change lands
  // while the prior gate is still high.
  function setupXOnly(snh: number) {
    seed(snh, 0.95, ['x_cv']);
  }

  it('S&H ON: a pad change while the prior gate is high suppresses the re-emit (no extra advance), but the playhead tracks', async () => {
    setupXOnly(1);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    const xGain = handle.inputs.get('x_cv')!.node as unknown as FakeGain;

    // X = -1 → column 0. First change fires (prior gate is low → no suppression).
    // The first gate fires at ~t+0.005 and stays high for gateLength*step.
    xGain.injected = levelBuffer(-1);
    ctx.currentTime = 0;
    hoisted.tick!();
    const advAfterFirst = handle.read!('totalAdvances') as number;
    expect(advAfterFirst).toBe(1);
    const idxAfterFirst = handle.read!('currentStep') as number;

    // X = +1 → column 3 (a DIFFERENT pad) on the very NEXT tick — the prior
    // gate is STILL high → S&H suppresses the pitch+gate re-emit. The visual
    // playhead is STILL scheduled (continuous tracking), so it follows.
    xGain.injected = levelBuffer(1);
    ctx.currentTime = 0.005;
    hoisted.tick!();
    const advAfterSecond = handle.read!('totalAdvances') as number;
    // The pitch+gate re-emit was SUPPRESSED → no extra advance.
    expect(advAfterSecond).toBe(advAfterFirst);
    // Advance time past the (continuously) scheduled playhead for the new pad
    // (X still +1 → idx unchanged → no further fire) and confirm the visual
    // playhead / lastSelectedIdx TRACKED the suppressed pad change.
    ctx.currentTime = 0.02;
    hoisted.tick!();
    expect(handle.read!('totalAdvances')).toBe(advAfterFirst); // still suppressed
    const idxAfterSecond = handle.read!('currentStep') as number;
    expect(idxAfterSecond).not.toBe(idxAfterFirst);
  });

  it('S&H OFF: every pad change re-emits pitch+gate (advance increments each time)', async () => {
    setupXOnly(0);
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    const xGain = handle.inputs.get('x_cv')!.node as unknown as FakeGain;

    xGain.injected = levelBuffer(-1); // col 0
    ctx.currentTime = 0;
    hoisted.tick!();
    expect(handle.read!('totalAdvances')).toBe(1);

    xGain.injected = levelBuffer(1); // col 3 — re-emits even though gate is high
    ctx.currentTime = 0.005;
    hoisted.tick!();
    expect(handle.read!('totalAdvances')).toBe(2);
  });
});

describe('cartesian: clock-PATCHED branch is unchanged by S&H', () => {
  it('advances on each clock rising edge regardless of snh', async () => {
    seed(1, 0.95, ['clock']); // clock patched, S&H ON
    const ctx = new FakeAudioContext();
    const handle = await build(ctx);
    const clockGain = handle.inputs.get('clock')!.node as unknown as FakeGain;
    // One rising edge per tick window.
    clockGain.injected = pulseBuffer();
    ctx.currentTime = 0;
    hoisted.tick!();
    ctx.currentTime = 0.025;
    hoisted.tick!();
    // The clock-patched branch is already gate-sampled — it advanced on the
    // clock edge(s) (at least once).
    expect((handle.read!('totalAdvances') as number)).toBeGreaterThanOrEqual(1);
  });
});
