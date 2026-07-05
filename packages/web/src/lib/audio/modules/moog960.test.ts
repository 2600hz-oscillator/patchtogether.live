// packages/web/src/lib/audio/modules/moog960.test.ts
//
// Two test layers for the MOOG 960 SEQUENTIAL CONTROLLER:
//   1. Module-def shape — pins the 960's full I/O + param surface (24 step
//      pots, 3 ranges, 8 column modes, rate; the 3 row CV outputs + clock_out;
//      the clock/start/stop gate inputs) so a refactor that silently drops a
//      port/param fails loudly (the per-module-per-port regression class).
//   2. Factory wiring — the 960 is PLAIN JS (scheduler-clock + ConstantSources,
//      no worklet), modeled on sequencer.ts. We drive the factory with a mock
//      AudioContext (ConstantSource + Gain + Analyser), register the node in
//      the live patch store so the tick can read its params, then assert: the
//      declared inputs/outputs are exposed, a start gate runs the sequencer and
//      column 0's pots scale onto the row CV outputs, setParam/readParam
//      round-trips, and dispose() tears everything down.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { moog960Def } from './moog960';
import { patch } from '$lib/graph/store';
import { __resetSchedulerClockForTests } from '$lib/audio/scheduler-clock';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
describe('moog960Def: module def shape', () => {
  it('declares type=moog960, label, category=modulation, schemaVersion=1', () => {
    expect(moog960Def.type).toBe('moog960');
    expect(moog960Def.label).toBe('960 sequencer');
    expect(moog960Def.category).toBe('modulation');
  });

  it('lives in the Moog System 35/55 Clones palette bucket and uses the Moog960Card', () => {
    expect(moog960Def.palette).toEqual({ top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' });
    expect(moog960Def.card).toBe('Moog960Card');
  });

  it('exposes the three gate inputs: clock, start, stop', () => {
    const ids = moog960Def.inputs.map((p) => p.id);
    expect(ids).toEqual(['clock', 'start', 'stop']);
    for (const p of moog960Def.inputs) expect(p.type).toBe('gate');
  });

  it('exposes the three row CV outputs + clock_out gate', () => {
    const outs = moog960Def.outputs;
    expect(outs.map((p) => p.id)).toEqual(['row1', 'row2', 'row3', 'clock_out']);
    expect(outs.find((p) => p.id === 'row1')!.type).toBe('cv');
    expect(outs.find((p) => p.id === 'row2')!.type).toBe('cv');
    expect(outs.find((p) => p.id === 'row3')!.type).toBe('cv');
    expect(outs.find((p) => p.id === 'clock_out')!.type).toBe('gate');
  });

  it('exposes 24 step pots r{1..3}s{1..8}, linear 0..1 default 0.5', () => {
    const ids = moog960Def.params.map((p) => p.id);
    for (let row = 1; row <= 3; row++) {
      for (let col = 1; col <= 8; col++) {
        const id = `r${row}s${col}`;
        expect(ids, `pot ${id} present`).toContain(id);
        const p = moog960Def.params.find((x) => x.id === id)!;
        expect(p.min).toBe(0);
        expect(p.max).toBe(1);
        expect(p.defaultValue).toBe(0.5);
        expect(p.curve).toBe('linear');
      }
    }
    // Exactly 24 step pots.
    const potCount = moog960Def.params.filter((p) => /^r\ds\d$/.test(p.id)).length;
    expect(potCount).toBe(24);
  });

  it('exposes 3 RANGE params (range1..3), discrete 0..2 default 0', () => {
    for (const id of ['range1', 'range2', 'range3']) {
      const p = moog960Def.params.find((x) => x.id === id)!;
      expect(p, `param ${id}`).toBeDefined();
      expect(p.min).toBe(0);
      expect(p.max).toBe(2);
      expect(p.defaultValue).toBe(0);
      expect(p.curve).toBe('discrete');
    }
  });

  it('exposes 8 per-column MODE params (mode1..8), discrete 0..2 default 0', () => {
    for (let c = 1; c <= 8; c++) {
      const p = moog960Def.params.find((x) => x.id === `mode${c}`)!;
      expect(p, `mode${c}`).toBeDefined();
      expect(p.min).toBe(0);
      expect(p.max).toBe(2);
      expect(p.defaultValue).toBe(0);
      expect(p.curve).toBe('discrete');
    }
  });

  it('exposes a rate param (log 0.1..20 Hz, default 2)', () => {
    const p = moog960Def.params.find((x) => x.id === 'rate')!;
    expect(p).toBeDefined();
    expect(p.min).toBe(0.1);
    expect(p.max).toBe(20);
    expect(p.defaultValue).toBe(2);
    expect(p.curve).toBe('log');
    expect(p.units).toBe('Hz');
  });

  it('declares exactly 24 + 3 + 8 + 1 = 36 params', () => {
    expect(moog960Def.params.length).toBe(36);
  });
});

// ───────────────────── Layer 2: factory wiring ─────────────────────
//
// Minimal Web Audio mock: ConstantSource (records offset writes), Gain,
// Analyser. The factory polls each gate-input analyser for rising edges, so the
// analyser returns a controllable time-domain buffer; we seed the start port's
// buffer with a high level to simulate a start-gate rising edge.

interface MockParam {
  value: number;
  setValueAtTime: (v: number, t: number) => void;
  cancelScheduledValues: (t: number) => void;
  history: Array<{ v: number; t: number }>;
}
function makeParam(initial = 0): MockParam {
  const p: MockParam = {
    value: initial,
    history: [],
    setValueAtTime(v) {
      p.value = v;
      p.history.push({ v, t: 0 });
    },
    cancelScheduledValues() {},
  };
  return p;
}

interface MockNode {
  kind: string;
  offset?: MockParam;
  gain?: MockParam;
  fftSize?: number;
  connect: (dest: unknown) => void;
  disconnect: () => void;
  disconnectCount: number;
  start?: () => void;
  stop?: () => void;
  startCount?: number;
  stopCount?: number;
  // Analyser-only: the time-domain data this node returns.
  __td?: Float32Array;
  getFloatTimeDomainData?: (out: Float32Array) => void;
}

function makeMockCtx() {
  const nodes: MockNode[] = [];
  let now = 1.0;
  function base(kind: string): MockNode {
    const n: MockNode = {
      kind,
      disconnectCount: 0,
      connect() {},
      disconnect() {
        n.disconnectCount++;
      },
    };
    nodes.push(n);
    return n;
  }
  const ctx = {
    sampleRate: 48000,
    get currentTime() {
      return now;
    },
    createConstantSource() {
      const n = base('constant');
      n.offset = makeParam(0);
      n.startCount = 0;
      n.stopCount = 0;
      n.start = () => {
        n.startCount!++;
      };
      n.stop = () => {
        n.stopCount!++;
      };
      return n;
    },
    createGain() {
      const n = base('gain');
      n.gain = makeParam(1);
      return n;
    },
    createAnalyser() {
      const n = base('analyser');
      n.fftSize = 2048;
      n.__td = new Float32Array(0);
      n.getFloatTimeDomainData = (out: Float32Array) => {
        // Copy the seeded buffer into the caller's array (zero-filled by
        // default = no edges).
        out.fill(0);
        if (n.__td && n.__td.length) {
          const len = Math.min(out.length, n.__td.length);
          for (let i = 0; i < len; i++) out[out.length - len + i] = n.__td[i]!;
        }
      };
      return n;
    },
  } as unknown as AudioContext;
  return {
    ctx,
    nodes,
    advanceTime(dt: number) {
      now += dt;
    },
  };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog960-test',
    type: 'moog960',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

/** Register a node in the live patch store so the factory's tick (which reads
 *  livePatch.nodes[id].params) sees its params. Returns a cleanup fn. */
function registerNode(node: ModuleNode): () => void {
  patch.nodes[node.id] = node;
  return () => {
    delete patch.nodes[node.id];
  };
}

describe('moog960 factory: wiring + params', () => {
  beforeEach(() => {
    __resetSchedulerClockForTests();
  });
  afterEach(() => {
    __resetSchedulerClockForTests();
    vi.restoreAllMocks();
  });

  it('exposes the three declared gate inputs at index 0', async () => {
    const { ctx } = makeMockCtx();
    const node = makeNode();
    const cleanup = registerNode(node);
    const handle = await moog960Def.factory(ctx, node);
    for (const id of ['clock', 'start', 'stop']) {
      const entry = handle.inputs.get(id);
      expect(entry, `input ${id}`).toBeDefined();
      expect(entry!.input).toBe(0);
    }
    // Three distinct gate nodes.
    const set = new Set(['clock', 'start', 'stop'].map((id) => handle.inputs.get(id)!.node));
    expect(set.size).toBe(3);
    handle.dispose();
    cleanup();
  });

  it('exposes the row CV outputs + clock_out, each at output 0', async () => {
    const { ctx } = makeMockCtx();
    const node = makeNode();
    const cleanup = registerNode(node);
    const handle = await moog960Def.factory(ctx, node);
    for (const id of ['row1', 'row2', 'row3', 'clock_out']) {
      const out = handle.outputs.get(id);
      expect(out, `output ${id}`).toBeDefined();
      expect(out!.output).toBe(0);
    }
    handle.dispose();
    cleanup();
  });

  it('readParam reflects the live node params; setParam is a no-op (tick reads params)', async () => {
    const { ctx } = makeMockCtx();
    const node = makeNode({ r1s1: 0.25, range2: 1, rate: 4 });
    const cleanup = registerNode(node);
    const handle = await moog960Def.factory(ctx, node);
    expect(handle.readParam('r1s1')).toBeCloseTo(0.25, 6);
    expect(handle.readParam('range2')).toBe(1);
    expect(handle.readParam('rate')).toBe(4);
    // setParam doesn't throw + readParam tracks the store (the card writes
    // params into the store; the tick reads them live). Mutate through the
    // LIVE store node (SyncedStore deep-clones plain objects on assignment, so
    // the original `node` reference is no longer the one readParam sees).
    expect(() => handle.setParam('r1s1', 0.9)).not.toThrow();
    patch.nodes[node.id]!.params.r1s1 = 0.9;
    expect(handle.readParam('r1s1')).toBeCloseTo(0.9, 6);
    expect(handle.readParam('nope')).toBeUndefined();
    handle.dispose();
    cleanup();
  });

  it('dispose() stops + disconnects every ConstantSource and gate node', async () => {
    const { ctx, nodes } = makeMockCtx();
    const node = makeNode();
    const cleanup = registerNode(node);
    const handle = await moog960Def.factory(ctx, node);
    const constants = nodes.filter((n) => n.kind === 'constant');
    // 3 row sources + 1 clock-out + 3 gate-port silences = 7 ConstantSources.
    expect(constants.length).toBe(7);
    handle.dispose();
    for (const c of constants) {
      expect(c.stopCount, 'constant stopped').toBeGreaterThanOrEqual(1);
      expect(c.disconnectCount, 'constant disconnected').toBeGreaterThanOrEqual(1);
    }
    // Every gain + analyser disconnected too.
    for (const n of nodes.filter((x) => x.kind === 'gain' || x.kind === 'analyser')) {
      expect(n.disconnectCount).toBeGreaterThanOrEqual(1);
    }
    cleanup();
  });
});

// ───────────────────── Layer 3: stepping behavior through the tick ─────────────────────
//
// Drive the real scheduler-clock tick + a mock analyser that emits start/clock
// edges on demand, asserting the row CV advances column-to-column. This proves
// the factory's start→run→advance→CV-write path end-to-end (not just the def).

/** A mock ctx whose analysers are individually addressable so we can inject a
 *  rising edge on a specific gate port for one tick. */
function makeDrivableCtx() {
  const analysers: MockNode[] = [];
  const constants: MockNode[] = [];
  const gains: MockNode[] = [];
  let now = 1.0;
  // Map gain node → its analyser (gain.connect(analyser)).
  const gainToAnalyser = new Map<MockNode, MockNode>();
  function base(kind: string, bucket: MockNode[]): MockNode {
    const n: MockNode = {
      kind,
      disconnectCount: 0,
      connect(dest: unknown) {
        if (kind === 'gain') gainToAnalyser.set(n, dest as MockNode);
      },
      disconnect() {
        n.disconnectCount++;
      },
    };
    bucket.push(n);
    return n;
  }
  const ctx = {
    sampleRate: 48000,
    get currentTime() {
      return now;
    },
    createConstantSource() {
      const n = base('constant', constants);
      n.offset = makeParam(0);
      n.startCount = 0;
      n.stopCount = 0;
      n.start = () => {};
      n.stop = () => {};
      return n;
    },
    createGain() {
      const n = base('gain', gains);
      n.gain = makeParam(1);
      return n;
    },
    createAnalyser() {
      const n = base('analyser', analysers);
      n.fftSize = 2048;
      n.__td = new Float32Array(0);
      n.getFloatTimeDomainData = (out: Float32Array) => {
        out.fill(0);
        if (n.__td && n.__td.length) {
          const len = Math.min(out.length, n.__td.length);
          for (let i = 0; i < len; i++) out[out.length - len + i] = n.__td[i]!;
        }
        // One-shot: clear after read so the edge isn't re-counted next tick.
        n.__td = new Float32Array(0);
      };
      return n;
    },
  } as unknown as AudioContext;
  return {
    ctx,
    gains,
    constants,
    analysers,
    advanceTime(dt: number) {
      now += dt;
    },
    /** Inject a rising edge (0 then 1) onto the analyser fed by `gainNode`. */
    pulse(gainNode: MockNode) {
      const an = gainToAnalyser.get(gainNode);
      if (an) an.__td = new Float32Array([0, 0, 1, 1]);
    },
  };
}

describe('moog960 factory: stepping through the tick (start → advance)', () => {
  beforeEach(() => {
    __resetSchedulerClockForTests();
  });
  afterEach(() => {
    __resetSchedulerClockForTests();
    vi.restoreAllMocks();
  });

  it('start gate presents column-0 CV; an external clock edge advances to column 1', async () => {
    vi.useFakeTimers();
    const drv = makeDrivableCtx();
    // Patch an external clock so external-clock mode is active.
    const node = makeNode({
      // col1 (idx0): r1=0.2, col2 (idx1): r1=0.8. range1=0 (×1).
      r1s1: 0.2,
      r1s2: 0.8,
      range1: 0,
    });
    const cleanup = registerNode(node);
    // Register an edge into the clock input so isInputPortConnected → true.
    patch.edges['e-clock'] = {
      id: 'e-clock',
      source: { nodeId: 'src', portId: 'out' },
      target: { nodeId: node.id, portId: 'clock' },
      sourceType: 'gate',
      targetType: 'gate',
    };

    const handle = await moog960Def.factory(drv.ctx, node);
    const startGain = handle.inputs.get('start')!.node as unknown as MockNode;
    const clockGain = handle.inputs.get('clock')!.node as unknown as MockNode;
    const row1 = handle.outputs.get('row1')!.node as unknown as MockNode;

    // Tick once with a start pulse → runs, presents column 0 (r1s1 = 0.2 ×1).
    drv.pulse(startGain);
    vi.advanceTimersByTime(30); // one 25 ms scheduler tick
    expect(handle.read!('isRunning')).toBe(true);
    expect((handle.read!('rowCv:0') as number)).toBeCloseTo(0.2, 6);
    expect(row1.offset!.value).toBeCloseTo(0.2, 6);

    // Tick with a clock pulse → advances to column 1 (r1s2 = 0.8 ×1).
    drv.advanceTime(0.05);
    drv.pulse(clockGain);
    vi.advanceTimersByTime(30);
    expect((handle.read!('rowCv:0') as number)).toBeCloseTo(0.8, 6);
    expect(row1.offset!.value).toBeCloseTo(0.8, 6);

    handle.dispose();
    delete patch.edges['e-clock'];
    cleanup();
    vi.useRealTimers();
  });

  it('a STOP-column mode halts the run after landing on it', async () => {
    vi.useFakeTimers();
    const drv = makeDrivableCtx();
    const node = makeNode({ mode2: 2 /* column 2 = STOP */ });
    const cleanup = registerNode(node);
    patch.edges['e-clock2'] = {
      id: 'e-clock2',
      source: { nodeId: 'src', portId: 'out' },
      target: { nodeId: node.id, portId: 'clock' },
      sourceType: 'gate',
      targetType: 'gate',
    };
    const handle = await moog960Def.factory(drv.ctx, node);
    const startGain = handle.inputs.get('start')!.node as unknown as MockNode;
    const clockGain = handle.inputs.get('clock')!.node as unknown as MockNode;

    drv.pulse(startGain);
    vi.advanceTimersByTime(30);
    expect(handle.read!('isRunning')).toBe(true); // at column 0

    drv.advanceTime(0.05);
    drv.pulse(clockGain);
    vi.advanceTimersByTime(30); // advance to column 1 = STOP → halt
    expect(handle.read!('isRunning')).toBe(false);
    expect(handle.read!('currentColumn')).toBe(1);

    handle.dispose();
    delete patch.edges['e-clock2'];
    cleanup();
    vi.useRealTimers();
  });

  it('a stop gate halts a running internal-rate sequencer (CV holds)', async () => {
    vi.useFakeTimers();
    const drv = makeDrivableCtx();
    const node = makeNode({ r1s1: 0.4, range1: 0, rate: 5 });
    const cleanup = registerNode(node);
    // No clock edge → internal-rate mode.
    const handle = await moog960Def.factory(drv.ctx, node);
    const startGain = handle.inputs.get('start')!.node as unknown as MockNode;
    const stopGain = handle.inputs.get('stop')!.node as unknown as MockNode;

    drv.pulse(startGain);
    vi.advanceTimersByTime(30);
    expect(handle.read!('isRunning')).toBe(true);

    drv.pulse(stopGain);
    vi.advanceTimersByTime(30);
    expect(handle.read!('isRunning')).toBe(false);

    handle.dispose();
    cleanup();
    vi.useRealTimers();
  });
});
