// packages/web/src/lib/audio/modules/timelorde.test.ts
//
// Tests for TIMELORDE's start_in / stop_in transport gates.
// Pattern follows dx7.test.ts: mock AudioContext + AudioWorkletNode so the
// factory can be driven from node without spinning up Web Audio. The
// rising-edge transport logic itself is also exposed as a pure helper
// (transportEventsToMute) which gets a separate unit-test block.
//
// We do NOT cover the worklet's DSP-side BPM / phase / multiplier math —
// that's the ART scenario's job (art/scenarios/timelorde/).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { timelordeDef, transportEventsToMute } from './timelorde';
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
});

// ---------------- transportEventsToMute (pure) ----------------

describe('transportEventsToMute', () => {
  it('start edge while muted unmutes (mute=1 → 0)', () => {
    expect(transportEventsToMute({ startEdges: 1, stopEdges: 0, prevMute: 1 })).toBe(0);
  });

  it('stop edge while running mutes (mute=0 → 1)', () => {
    expect(transportEventsToMute({ startEdges: 0, stopEdges: 1, prevMute: 0 })).toBe(1);
  });

  it('idempotent: start while already running stays unmuted', () => {
    expect(transportEventsToMute({ startEdges: 1, stopEdges: 0, prevMute: 0 })).toBe(0);
  });

  it('idempotent: stop while already muted stays muted', () => {
    expect(transportEventsToMute({ startEdges: 0, stopEdges: 1, prevMute: 1 })).toBe(1);
  });

  it('no edges: leaves prevMute untouched (both 0 → 0)', () => {
    expect(transportEventsToMute({ startEdges: 0, stopEdges: 0, prevMute: 0 })).toBe(0);
  });

  it('no edges: leaves prevMute untouched (both 1 → 1)', () => {
    expect(transportEventsToMute({ startEdges: 0, stopEdges: 0, prevMute: 1 })).toBe(1);
  });

  it('simultaneous start + stop in one poll window: stop wins', () => {
    // Conservative interpretation: if a stop happened in the same window,
    // honor it. Avoids a malformed-burst MIDI device leaving the rack
    // unexpectedly running.
    expect(transportEventsToMute({ startEdges: 1, stopEdges: 1, prevMute: 0 })).toBe(1);
    expect(transportEventsToMute({ startEdges: 1, stopEdges: 1, prevMute: 1 })).toBe(1);
  });

  it('multi-edge counts behave like single edges (rising-edge is binary)', () => {
    expect(transportEventsToMute({ startEdges: 3, stopEdges: 0, prevMute: 1 })).toBe(0);
    expect(transportEventsToMute({ startEdges: 0, stopEdges: 4, prevMute: 0 })).toBe(1);
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

// Each AnalyserNode keeps a 2048-sample ring buffer of the most-recent
// samples written into its connected gain. Tests use pushSamples(...) to
// stuff edges in directly.
class FakeAnalyserNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  buf: Float32Array = new Float32Array(2048);
  connect = vi.fn();
  disconnect = vi.fn();
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

class FakeAudioWorkletNode {
  parameters: { get: (k: string) => FakeParam | undefined };
  port = { onmessage: null as unknown, postMessage: vi.fn(), close: vi.fn() };
  disconnect = vi.fn();
  _paramMap: Map<string, FakeParam>;
  constructor(_ctx: unknown, _name: string, _opts?: unknown) {
    this._paramMap = new Map([
      ['bpm', makeParam(120)],
      ['swingAmount', makeParam(0)],
      ['swingSource', makeParam(0)],
      ['muteOutputs', makeParam(0)],
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
      params: { muteOutputs: 1 }, // start MUTED so a start_in edge can flip it
      data: {},
    } as ModuleNode;
    (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
      FakeAudioWorkletNode;
  });

  it('exposes start_in + stop_in in the handle.inputs map', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ muteOutputs: 1 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );
    expect(handle.inputs.has('start_in')).toBe(true);
    expect(handle.inputs.has('stop_in')).toBe(true);
    expect(handle.inputs.has('clock')).toBe(true);
  });

  it('rising edge on start_in while stopped sets running=true (muteOutputs ← 0)', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ muteOutputs: 1 });
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

    // Inject a rising edge on the start analyser's buffer.
    const startAna = (handle.inputs.get('start_in')!.node as unknown as FakeGainNode)
      .connect.mock.calls[0]?.[0] as FakeAnalyserNode | undefined;
    // Falling back: locate the analyser via the dedicated fake-network's
    // gain → analyser edge isn't tracked by our minimal fakes. Easier:
    // grab it through the handle by re-reaching into the gain node.
    void startAna;
    // Pull the analyser via the gain node's .connect() argument.
    const startGain = handle.inputs.get('start_in')!.node as unknown as FakeGainNode;
    const ana = startGain.connect.mock.calls[0]?.[0] as FakeAnalyserNode;
    expect(ana, 'gain connected to an analyser').toBeDefined();
    ana.pushSamples(rising(false));

    tickAll();

    // The scheduler tick should have routed the rising edge through
    // transportEventsToMute and written muteOutputs ← 0 in BOTH the
    // patch store and the muteOutputs AudioParam.
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(0);
    expect(handle.read?.('running')).toBe(1);
  });

  it('rising edge on stop_in while running sets running=false (muteOutputs ← 1)', async () => {
    const ctx = makeMockCtx();
    // Start in the unmuted/running state.
    livePatch.nodes['timelorde-test']!.params.muteOutputs = 0;
    const node = makeNode({ muteOutputs: 0 });
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

    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(1);
    expect(handle.read?.('running')).toBe(0);
  });

  it('idempotent: pulsing start_in while already running is a no-op', async () => {
    const ctx = makeMockCtx();
    livePatch.nodes['timelorde-test']!.params.muteOutputs = 0;
    const node = makeNode({ muteOutputs: 0 });
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
    expect(livePatch.nodes['timelorde-test']!.params.muteOutputs).toBe(0);
    expect(handle.read?.('running')).toBe(1);
  });

  it('handle.dispose() unsubscribes from the scheduler clock', async () => {
    const ctx = makeMockCtx();
    const node = makeNode({ muteOutputs: 1 });
    const handle = await timelordeDef.factory(
      ctx as unknown as AudioContext,
      node,
    );
    expect(fakeSchedulerSubs.length).toBe(1);
    handle.dispose();
    expect(fakeSchedulerSubs.length).toBe(0);
  });
});
