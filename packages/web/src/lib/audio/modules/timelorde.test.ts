// packages/web/src/lib/audio/modules/timelorde.test.ts
//
// Tests for TIMELORDE's start_in / stop_in transport gates.
// Pattern follows dx7.test.ts: mock AudioContext + AudioWorkletNode so the
// factory can be driven from node without spinning up Web Audio. The
// rising-edge transport logic itself is also exposed as a pure helper
// (transportEventsToRunState) which gets a separate unit-test block.
//
// IMPORTANT: start_in / stop_in flip the `running` AudioParam, NOT
// muteOutputs. running=0 means the worklet HALTS the clock (phase
// accumulator freezes); muteOutputs=1 means the card's MUTE button
// silenced output gates but the clock keeps turning. The two are
// independent — these tests pin that separation as a regression guard.
//
// We do NOT cover the worklet's DSP-side BPM / phase / multiplier math —
// that's the ART scenario's job (art/scenarios/timelorde/).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { timelordeDef, transportEventsToRunState } from './timelorde';
import { patch as livePatch } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';

// ---------------- module-def shape ----------------

describe('timelordeDef: shape', () => {
  it('declares start_in as a gate input', () => {
    const p = timelordeDef.inputs.find((i) => i.id === 'start_in');
    expect(p).toBeDefined();
    expect(p?.type).toBe('gate');
  });

  it('declares stop_in as a gate input', () => {
    const p = timelordeDef.inputs.find((i) => i.id === 'stop_in');
    expect(p).toBeDefined();
    expect(p?.type).toBe('gate');
  });

  it('keeps the existing clock input alongside the new transport gates', () => {
    const ids = timelordeDef.inputs.map((i) => i.id);
    expect(ids).toEqual(['clock', 'start_in', 'stop_in']);
  });

  // Regression: the timelorde worklet had outputPulseEnd = new Int32Array(12)
  // which silently dropped writes at index 12 (OUT_SWING). The def must
  // declare exactly 13 outputs and swing must be the 13th so the per-port
  // sweep catches any future miscount.
  it('declares exactly 13 outputs (12 fixed divisions + swing)', () => {
    expect(timelordeDef.outputs.length).toBe(13);
  });

  it('declares swing as the last output (index 12)', () => {
    const swing = timelordeDef.outputs[12];
    expect(swing?.id).toBe('swing');
    expect(swing?.type).toBe('gate');
  });

  it('every output is declared as gate type', () => {
    for (const out of timelordeDef.outputs) {
      expect(out.type, `output ${out.id}`).toBe('gate');
    }
  });
});

// ---------------- transportEventsToRunState (pure) ----------------

describe('transportEventsToRunState', () => {
  it('start edge while stopped resumes (run=0 → 1)', () => {
    expect(transportEventsToRunState({ startEdges: 1, stopEdges: 0, prevRunning: 0 })).toBe(1);
  });

  it('stop edge while running halts (run=1 → 0)', () => {
    expect(transportEventsToRunState({ startEdges: 0, stopEdges: 1, prevRunning: 1 })).toBe(0);
  });

  it('idempotent: start while already running stays running', () => {
    expect(transportEventsToRunState({ startEdges: 1, stopEdges: 0, prevRunning: 1 })).toBe(1);
  });

  it('idempotent: stop while already stopped stays stopped', () => {
    expect(transportEventsToRunState({ startEdges: 0, stopEdges: 1, prevRunning: 0 })).toBe(0);
  });

  it('no edges: leaves prevRunning untouched (running stays running)', () => {
    expect(transportEventsToRunState({ startEdges: 0, stopEdges: 0, prevRunning: 1 })).toBe(1);
  });

  it('no edges: leaves prevRunning untouched (stopped stays stopped)', () => {
    expect(transportEventsToRunState({ startEdges: 0, stopEdges: 0, prevRunning: 0 })).toBe(0);
  });

  it('simultaneous start + stop in one poll window: stop wins', () => {
    // Conservative interpretation: if a stop happened in the same window,
    // honor it. Avoids a malformed-burst MIDI device leaving the rack
    // unexpectedly running.
    expect(transportEventsToRunState({ startEdges: 1, stopEdges: 1, prevRunning: 1 })).toBe(0);
    expect(transportEventsToRunState({ startEdges: 1, stopEdges: 1, prevRunning: 0 })).toBe(0);
  });

  it('multi-edge counts behave like single edges (rising-edge is binary)', () => {
    expect(transportEventsToRunState({ startEdges: 3, stopEdges: 0, prevRunning: 0 })).toBe(1);
    expect(transportEventsToRunState({ startEdges: 0, stopEdges: 4, prevRunning: 1 })).toBe(0);
  });
});

// ---------------- factory: gate-driven mute-state transitions ----------------
//
// We mock Web Audio (AudioContext, AudioWorkletNode, GainNode,
// AnalyserNode, ConstantSourceNode, AudioParam) just enough to drive
// timelordeDef.factory(...). The scheduler-clock is replaced with an
// in-memory subscriber list so the test can fire `tick()` synchronously
// and observe what livePatch + the muteOutputs AudioParam look like.

interface FakeParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
  cancelScheduledValues: (t: number) => void;
}
function makeParam(initial = 0): FakeParam {
  const p: FakeParam = {
    value: initial,
    setValueAtTime(v) { p.value = v; },
    cancelScheduledValues() { /* */ },
  };
  return p;
}

// Each AnalyserNode keeps an `fftSize`-sample ring buffer of the most-recent
// samples written into its connected gain. Tests use pushSamples(...) to
// stuff edges in directly. The buffer is (re)sized off `fftSize` whenever the
// factory assigns it, so this mock tracks the real widened ring (16384) the
// production factory now requests rather than a hard-coded 2048.
class FakeAnalyserNode {
  smoothingTimeConstant = 0;
  buf: Float32Array = new Float32Array(2048);
  connect = vi.fn();
  disconnect = vi.fn();
  #fftSize = 2048;
  get fftSize(): number {
    return this.#fftSize;
  }
  set fftSize(n: number) {
    this.#fftSize = n;
    this.buf = new Float32Array(n);
  }
  getFloatTimeDomainData(out: Float32Array): void {
    out.set(this.buf);
  }
  /** Append `samples` to the right edge of the ring buffer, shifting
   *  older samples out the left. Mirrors how WebAudio fills the analyser
   *  buffer between draws. */
  pushSamples(samples: number[]): void {
    const n = samples.length;
    if (n >= this.buf.length) {
      this.buf.set(samples.slice(samples.length - this.buf.length));
      return;
    }
    this.buf.copyWithin(0, n);
    for (let i = 0; i < n; i++) {
      this.buf[this.buf.length - n + i] = samples[i]!;
    }
  }
}

class FakeGainNode {
  gain = makeParam(1);
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeConstantSourceNode {
  offset = makeParam(0);
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
}

// Capture every worklet node the factory constructs so a test can reach
// its `.port.onmessage` (the path the worklet posts measuredBpm on).
const constructedWorklets: FakeAudioWorkletNode[] = [];

class FakeAudioWorkletNode {
  parameters: { get: (k: string) => FakeParam | undefined };
  port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  disconnect = vi.fn();
  _paramMap: Map<string, FakeParam>;
  constructor(_ctx: unknown, _name: string, _opts?: unknown) {
    constructedWorklets.push(this);
    this._paramMap = new Map([
      ['bpm', makeParam(120)],
      ['swingAmount', makeParam(0)],
      ['swingSource', makeParam(0)],
      ['muteOutputs', makeParam(0)],
      // running defaults to 1 (clock advances). Test reseeds via node.params
      // when an explicit value is required for a scenario.
      ['running', makeParam(1)],
      ['hasExternalClock', makeParam(0)],
    ]);
    this.parameters = { get: (k) => this._paramMap.get(k) };
  }
}

// In-memory scheduler-clock so the test can call tick() synchronously.
// We replace the scheduler-clock module with this before importing
// timelorde, then drive it ourselves.
const fakeSchedulerSubs: Array<() => void> = [];
vi.mock('$lib/audio/scheduler-clock', () => ({
  getSchedulerClock: () => ({
    subscribe(cb: () => void) {
      fakeSchedulerSubs.push(cb);
      return () => {
        const i = fakeSchedulerSubs.indexOf(cb);
        if (i >= 0) fakeSchedulerSubs.splice(i, 1);
      };
    },
  }),
  SCHEDULER_TICK_MS: 25,
}));

// Shim the worklet module-url import; the factory only awaits
// ctx.audioWorklet.addModule(url) which our fake ctx no-ops anyway.
vi.mock('@patchtogether.live/dsp/dist/timelorde.js?url', () => ({ default: 'timelorde.js' }));

interface FakeAudioCtx {
  currentTime: number;
  sampleRate: number;
  audioWorklet: { addModule: (u: string) => Promise<void> };
  createGain: () => FakeGainNode;
  createAnalyser: () => FakeAnalyserNode;
  createConstantSource: () => FakeConstantSourceNode;
}
function makeMockCtx(): FakeAudioCtx {
  const ctx: FakeAudioCtx = {
    currentTime: 0,
    sampleRate: 48000,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createGain: () => new FakeGainNode(),
    createAnalyser: () => new FakeAnalyserNode(),
    createConstantSource: () => new FakeConstantSourceNode(),
  };
  return ctx;
}

function makeNode(params?: Record<string, number>): ModuleNode {
  return {
    id: 'timelorde-test',
    type: 'timelorde',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: params ?? {},
    data: {},
  };
}

function tickAll(): void {
  for (const cb of [...fakeSchedulerSubs]) cb();
}

function rising(prevHigh: boolean): number[] {
  // 4 low + 8 high samples → a single rising edge near the buffer's end.
  // Use prevHigh to keep the detector's cross-tick state honest if we
  // chain pushes (not needed for the small-scenario tests below, but
  // documented for future expansion).
  void prevHigh;
  return [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1];
}

describe('timelordeDef.factory: start_in / stop_in transport gates', () => {
  beforeEach(() => {
    fakeSchedulerSubs.length = 0;
    // Register the test node in livePatch so the factory's
    // livePatch.nodes[nodeId].params writes have somewhere to land.
    for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
    livePatch.nodes['timelorde-test'] = {
      id: 'timelorde-test',
      type: 'timelorde',
      domain: 'audio',
      position: { x: 0, y: 0 },
      // Start STOPPED so a start_in edge can flip running 0→1 + leave
      // muteOutputs at its default (the card's MUTE button isn't relevant
      // to the transport-gate path).
      params: { running: 0, muteOutputs: 0 },
      data: {},
    } as ModuleNode;
    (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
      FakeAudioWorkletNode;
  });

  it('exposes start_in + stop_in in the handle.inputs map', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ running: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );
    expect(handle.inputs.has('start_in')).toBe(true);
    expect(handle.inputs.has('stop_in')).toBe(true);
    expect(handle.inputs.has('clock')).toBe(true);
  });

  // #229-style regression: the start_in / stop_in edge-detector analysers
  // must use a wide ring (≥16384 samples, ~341 ms @ 48 kHz) so a long
  // main-thread stall (canvas pan/drag event-storm, 80–150 ms) can't
  // overwrite a transport edge before pollTransportGates() reads it. A
  // narrow 2048-sample ring (~42 ms) drops those edges ⇒ a missed start/stop
  // under UI load. We assert the analyser fftSize the factory requested,
  // pulled off the gain → analyser wiring.
  it('widens the start_in / stop_in edge-detector ring to ≥16384 (no dropped transport edge under UI stall)', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ running: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );
    for (const port of ['start_in', 'stop_in'] as const) {
      const gain = handle.inputs.get(port)!.node as unknown as FakeGainNode;
      const ana = gain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
      expect(ana, `${port} gain connected to an analyser`).toBeDefined();
      expect(ana.fftSize).toBeGreaterThanOrEqual(16384);
      // fftSize must be a power of two for WebAudio to accept it.
      expect(Number.isInteger(Math.log2(ana.fftSize))).toBe(true);
      // The scan buffer the factory reads into must match the ring width,
      // else widening the ring buys no extra lookback.
      expect(ana.buf.length).toBe(ana.fftSize);
    }
  });

  it('rising edge on start_in while stopped sets running ← 1 (and leaves muteOutputs alone)', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ running: 0, muteOutputs: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );
    // Sanity: a subscriber was registered.
    expect(fakeSchedulerSubs.length).toBe(1);

    // First poll has elapsed=0 → no edges to scan. Advance time so the
    // next poll covers a real window.
    tickAll();
    ctx.currentTime = 0.025;

    // Pull the analyser via the gain node's .connect() argument.
    const startGain = handle.inputs.get('start_in')!.node as unknown as FakeGainNode;
    const ana = startGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    expect(ana, 'gain connected to an analyser').toBeDefined();
    ana.pushSamples(rising(false));

    tickAll();

    // The scheduler tick should have routed the rising edge through
    // transportEventsToRunState and written running ← 1 in BOTH the
    // patch store and the running AudioParam. muteOutputs MUST be
    // unchanged — start_in/stop_in are the transport, not the mute.
    expect(livePatch.nodes['timelorde-test']!.params.running).toBe(1);
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(0);
    expect(handle.read?.('running')).toBe(1);
  });

  it('rising edge on stop_in while running sets running ← 0 (and leaves muteOutputs alone)', async () => {
    const ctx = makeMockCtx();
    // Start in the running state.
    livePatch.nodes['timelorde-test']!.params.running = 1;
    livePatch.nodes['timelorde-test']!.params.muteOutputs = 0;
    const node = makeNode({ running: 1, muteOutputs: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );

    tickAll();
    ctx.currentTime = 0.025;

    const stopGain = handle.inputs.get('stop_in')!.node as unknown as FakeGainNode;
    const ana = stopGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    ana.pushSamples(rising(false));

    tickAll();

    expect(livePatch.nodes['timelorde-test']!.params.running).toBe(0);
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(0);
    expect(handle.read?.('running')).toBe(0);
  });

  it('stop_in halts even when muteOutputs is already 1 (transport stop ≠ mute)', async () => {
    // Regression pin: the card's MUTE button (muteOutputs=1) is
    // ORTHOGONAL to the external stop gate. A patched stop_in must
    // still flip running 1→0 + leave muteOutputs at 1.
    const ctx = makeMockCtx();
    livePatch.nodes['timelorde-test']!.params.running = 1;
    livePatch.nodes['timelorde-test']!.params.muteOutputs = 1;
    const node = makeNode({ running: 1, muteOutputs: 1 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );

    tickAll();
    ctx.currentTime = 0.025;

    const stopGain = handle.inputs.get('stop_in')!.node as unknown as FakeGainNode;
    const ana = stopGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    ana.pushSamples(rising(false));

    tickAll();

    expect(livePatch.nodes['timelorde-test']!.params.running).toBe(0);
    // muteOutputs UNCHANGED — the gates are independent.
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(1);
  });

  it('start_in resumes from halted, leaving muteOutputs untouched', async () => {
    // DAW-transport pattern: a stopped clock that gets a fresh start_in
    // edge resumes from its frozen position. The factory level can only
    // observe the running flag; the position-preservation guarantee is
    // a worklet-side property (the process() block early-returns when
    // running=0, so internalPhase + sampleCount do not advance — see
    // packages/dsp/src/timelorde.ts). Here we pin the factory-level
    // signal so the worklet receives running=1 on the resume edge.
    const ctx = makeMockCtx();
    livePatch.nodes['timelorde-test']!.params.running = 0;
    livePatch.nodes['timelorde-test']!.params.muteOutputs = 1;
    const node = makeNode({ running: 0, muteOutputs: 1 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );

    tickAll();
    ctx.currentTime = 0.025;

    const startGain = handle.inputs.get('start_in')!.node as unknown as FakeGainNode;
    const ana = startGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    ana.pushSamples(rising(false));

    tickAll();

    expect(livePatch.nodes['timelorde-test']!.params.running).toBe(1);
    // muteOutputs UNCHANGED — even if the rack is muted, the transport
    // can still be running underneath (LIVECODE keeps consuming ticks).
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(1);
  });

  it('idempotent: pulsing start_in while already running is a no-op', async () => {
    const ctx = makeMockCtx();
    livePatch.nodes['timelorde-test']!.params.running = 1;
    livePatch.nodes['timelorde-test']!.params.muteOutputs = 0;
    const node = makeNode({ running: 1, muteOutputs: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );

    tickAll();
    ctx.currentTime = 0.025;

    const startGain = handle.inputs.get('start_in')!.node as unknown as FakeGainNode;
    const ana = startGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    ana.pushSamples(rising(false));

    // Must not throw; final state unchanged.
    expect(() => tickAll()).not.toThrow();
    expect(livePatch.nodes['timelorde-test']!.params.running).toBe(1);
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(0);
    expect(handle.read?.('running')).toBe(1);
  });

  it('handle.dispose() unsubscribes from the scheduler clock', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ running: 0 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );
    expect(fakeSchedulerSubs.length).toBe(1);
    handle.dispose();
    expect(fakeSchedulerSubs.length).toBe(0);
  });
});

describe('timelordeDef.factory: external-clock BPM follow (measuredBpm → bpm)', () => {
  beforeEach(() => {
    fakeSchedulerSubs.length = 0;
    constructedWorklets.length = 0;
    for (const k of Object.keys(livePatch.nodes)) delete livePatch.nodes[k];
    livePatch.nodes['timelorde-test'] = {
      id: 'timelorde-test',
      type: 'timelorde',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { bpm: 120 },
      data: {},
    } as ModuleNode;
    (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
      FakeAudioWorkletNode;
  });

  function fireMeasuredBpm(bpm: number): void {
    // The factory assigns workletNode.port.onmessage; the worklet posts
    // { type: 'measuredBpm', bpm } when it locks to / drifts on an external
    // clock (bpm:0 on dropout).
    const w = constructedWorklets[constructedWorklets.length - 1];
    w?.port.onmessage?.({ data: { type: 'measuredBpm', bpm } });
  }

  it('a positive measuredBpm writes through to the bpm param AND livePatch.params.bpm', async () => {
    // THE GAP-FILL: before this, a measured external tempo was display-only
    // (read('measuredBpm')); the bpm param stayed at the internal knob, so
    // LIVECODE's clock.bpm() / clocked() kept deriving the wrong period
    // while the gate outputs followed the hardware. Now an external lock
    // propagates into bpm everywhere.
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    // The card still surfaces the measured value too.
    fireMeasuredBpm(140);
    expect(handle.read?.('measuredBpm')).toBe(140);
    // …and now the bpm param + the patch store follow it.
    expect(handle.readParam?.('bpm')).toBe(140);
    expect(livePatch.nodes['timelorde-test']!.params.bpm).toBe(140);
  });

  it('measured BPM is clamped to the param range (10..300)', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    fireMeasuredBpm(5000); // absurd glitch reading
    expect(handle.readParam?.('bpm')).toBe(300);
    fireMeasuredBpm(2); // below floor
    expect(handle.readParam?.('bpm')).toBe(10);
  });

  it('a dropout (bpm:0) does NOT clobber the bpm param — holds the last followed tempo', async () => {
    const ctx = makeMockCtx();
    const handle = await timelordeDef.factory(ctx as unknown as AudioContext, makeNode({ bpm: 120 }));
    fireMeasuredBpm(132);
    expect(handle.readParam?.('bpm')).toBe(132);
    // Clock unplugged → worklet posts bpm:0. We hold 132 (NOT reset to 120).
    fireMeasuredBpm(0);
    expect(handle.readParam?.('bpm')).toBe(132);
    expect(livePatch.nodes['timelorde-test']!.params.bpm).toBe(132);
    // measuredBpm read still reflects the dropout for the card display.
    expect(handle.read?.('measuredBpm')).toBe(0);
  });
});
