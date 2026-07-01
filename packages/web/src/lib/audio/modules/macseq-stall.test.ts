// packages/web/src/lib/audio/modules/macseq-stall.test.ts
//
// Two audio-thread correctness fixes on MACSEQ, driven against a fake
// AudioContext + the injectable scheduler tick (same harness style as
// sequencer-snh.test.ts):
//
//   C1 (#229 drop guard) — after a main-thread stall LONGER than the 200 ms
//       lookahead, the INTERNAL-clock loop must DROP the past-due backlog
//       (count it in `lateStepsDropped`) instead of emitting a burst of steps
//       at past timestamps that Web Audio collapses onto "now" (a rushed
//       double-hit). Mirrors the existing drumseqz guard.
//
//   C2 (shared edge counter) — the EXTERNAL-clock path now advances one step
//       per rising edge via the shared, windowed `createEdgeCounter`
//       ($lib/audio/edge-detect), so a single clock pulse advances exactly one
//       step (no 2048-sample-ring double-count) and the per-module scan can't
//       drift from the canonical one.

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
import { macseqDef } from './macseq';

// ---- fake Web Audio (advanceable currentTime; injectable analyser data) ----
class FakeParam {
  value = 0;
  setValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
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
  /** Test hook: the time-domain samples this gain feeds into a connected
   *  AnalyserNode (the external clock-in signal). */
  injected: Float32Array | null = null;
  connect(node: unknown) {
    if (node instanceof FakeAnalyser) node._source = this;
  }
  disconnect() {}
}
class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0;
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
  analysers: FakeAnalyser[] = [];
  createConstantSource() {
    return new FakeConstantSource() as unknown as ConstantSourceNode;
  }
  createGain() {
    return new FakeGain() as unknown as GainNode;
  }
  createAnalyser() {
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return a as unknown as AnalyserNode;
  }
  createChannelSplitter() {
    return new FakeGain() as unknown as ChannelSplitterNode;
  }
  createChannelMerger() {
    return new FakeGain() as unknown as ChannelMergerNode;
  }
  /** The clock-in AnalyserNode is the FIRST analyser the factory creates
   *  (before the transport-CV analysers). Feed its source gain a time-domain
   *  buffer to simulate an external clock signal on the `clock` input. */
  injectClock(buf: Float32Array | null) {
    const a = this.analysers[0];
    if (a?._source) a._source.injected = buf;
  }
}

const NODE_ID = 'macseqstall1';

type Step = { on: boolean; midi: number | null; model: number | null };
const STEP = (midi = 60): Step => ({ on: true, midi, model: null });

function clearPatch() {
  for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
  for (const k of Object.keys(livePatch.edges)) delete livePatch.edges[k];
}

function seed(opts: { externalClock: boolean; steps?: Step[]; length?: number }) {
  clearPatch();
  const steps = opts.steps ?? [STEP(60), STEP(62), STEP(64), STEP(65)];
  livePatch.nodes[NODE_ID] = {
    id: NODE_ID,
    type: 'macseq',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: { bpm: 120, length: opts.length ?? steps.length, isPlaying: 1, octave: 0, gateLength: 0.5 },
    data: { steps },
  } as never;
  if (opts.externalClock) {
    livePatch.edges['e_clock'] = {
      id: 'e_clock',
      source: { nodeId: 'srcclk', portId: 'clock' },
      target: { nodeId: NODE_ID, portId: 'clock' },
    } as never;
  }
}

async function build(ctx: FakeAudioContext) {
  return macseqDef.factory(
    ctx as unknown as AudioContext,
    { id: NODE_ID, type: 'macseq', params: livePatch.nodes[NODE_ID]!.params } as never,
  );
}

/** A 2048-sample buffer that rises through the threshold exactly once. */
function risingEdgeBuffer(): Float32Array {
  const b = new Float32Array(2048);
  for (let i = 1024; i < 2048; i++) b[i] = 1;
  return b;
}

beforeEach(() => {
  hoisted.tick = null;
  clearPatch();
});

describe('macseq C1: internal-clock past-due drop guard (#229)', () => {
  it('no stall → nothing is dropped', async () => {
    seed({ externalClock: false });
    const ctx = new FakeAudioContext();
    const h = await build(ctx);
    // Run ~0.5 s of ticks at the normal 25 ms cadence — the lookahead stays
    // ahead of currentTime the whole time, so no step is ever past-due.
    for (let t = 0; t < 0.5; t += 0.025) {
      ctx.currentTime = t;
      hoisted.tick!();
    }
    expect(h.read!('lateStepsDropped')).toBe(0);
    expect((h.read!('totalAdvances') as number)).toBeGreaterThan(0);
  });

  it('a >200 ms main-thread stall DROPS the past-due backlog (no burst emit)', async () => {
    seed({ externalClock: false });
    const ctx = new FakeAudioContext();
    const h = await build(ctx);
    // Normal playback for ~0.5 s...
    for (let t = 0; t < 0.5; t += 0.025) {
      ctx.currentTime = t;
      hoisted.tick!();
    }
    expect(h.read!('lateStepsDropped')).toBe(0);
    const advancesBefore = h.read!('totalAdvances') as number;
    // ...then the main thread blocks for 500 ms (currentTime jumps far past
    // nextStepTime) and finally ticks once. The while-loop backlog is now all
    // past-due; the guard must drop it instead of emitting a burst onto "now".
    ctx.currentTime = 1.0;
    hoisted.tick!();
    const dropped = h.read!('lateStepsDropped') as number;
    expect(dropped).toBeGreaterThan(0);
    // Sanity: the step counter still walked forward to re-lock (advances keep
    // counting), but the DROP is what suppresses the audible double-hit.
    expect((h.read!('totalAdvances') as number)).toBeGreaterThan(advancesBefore);
  });
});

describe('macseq C2: external-clock advances one step per rising edge', () => {
  it('a single rising edge advances exactly one step (shared edge counter)', async () => {
    seed({ externalClock: true });
    const ctx = new FakeAudioContext();
    const h = await build(ctx);

    // Play-start tick with a flat (silent) clock line: establishes running +
    // resets the edge counter, no edges yet.
    ctx.currentTime = 0.03;
    ctx.injectClock(new Float32Array(2048));
    hoisted.tick!();
    expect(h.read!('totalAdvances')).toBe(0);

    // One rising edge arrives on the clock input → exactly one advance.
    ctx.currentTime = 0.06;
    ctx.injectClock(risingEdgeBuffer());
    hoisted.tick!();
    expect(h.read!('totalAdvances')).toBe(1);

    // The clock line is now HELD high (the rising edge has scrolled out of the
    // ring; the ring is full of high samples) — no NEW rising edge, so no
    // phantom second advance.
    const held = new Float32Array(2048);
    held.fill(1);
    ctx.currentTime = 0.09;
    ctx.injectClock(held);
    hoisted.tick!();
    expect(h.read!('totalAdvances')).toBe(1);
  });
});
