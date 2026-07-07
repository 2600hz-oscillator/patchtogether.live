// packages/web/src/lib/audio/modules/moog903a.test.ts
//
// Two test layers for the MOOG 903A RANDOM SIGNAL GENERATOR (moogafakkin System 55/35
// clone):
//   1. Module-def shape — pins the 903A's I/O surface (NO inputs, the two
//      independent white/pink audio outputs, the single literal `level` param)
//      so a refactor that silently drops a port / param fails loudly (the
//      per-module-per-port regression-net class of bug).
//   2. Factory wiring — the 903A is PASSIVE (pure Web Audio: two looping
//      AudioBufferSourceNodes → one GainNode each), so there's no worklet to
//      instantiate. We drive the factory with a mock AudioContext whose nodes
//      record their connections / gain.value / start+stop+disconnect counts,
//      then assert: no inputs, both declared outputs point at the right gain
//      node, LEVEL seeds both gains, the sources are started, setParam('level')
//      drives BOTH gains, setParam→readParam round-trips, and dispose() stops +
//      disconnects everything the factory made.

import { describe, it, expect } from 'vitest';
import { moog903aDef } from './moog903a';
import type { ModuleNode } from '$lib/graph/types';

// ───────────────────── Layer 1: module-def shape ─────────────────────
// ───────────────────── Layer 2: factory wiring ─────────────────────
//
// Minimal Web Audio mock. GainNodes track gain.value + connect/disconnect;
// BufferSourceNodes track buffer/loop + start/stop/disconnect counts. The mock
// AudioContext also stubs createBuffer (returns an object with getChannelData
// → a Float32Array of the requested length).
interface MockGainNode {
  __kind: 'gain';
  gain: { value: number; setValueAtTime: (v: number, t: number) => void };
  connectedTo: unknown[];
  connect: (dest: unknown) => void;
  disconnect: () => void;
  disconnectCount: number;
}
interface MockBufferSource {
  __kind: 'source';
  buffer: unknown;
  loop: boolean;
  startCount: number;
  stopCount: number;
  disconnectCount: number;
  connectedTo: unknown[];
  connect: (dest: unknown) => void;
  start: () => void;
  stop: () => void;
  disconnect: () => void;
}

function makeMockCtx(): {
  ctx: AudioContext;
  gains: MockGainNode[];
  sources: MockBufferSource[];
} {
  const gains: MockGainNode[] = [];
  const sources: MockBufferSource[] = [];

  function createGain(): MockGainNode {
    const g: MockGainNode = {
      __kind: 'gain',
      gain: {
        value: 1,
        setValueAtTime(v: number) {
          this.value = v;
        },
      },
      connectedTo: [],
      disconnectCount: 0,
      connect(dest: unknown) {
        this.connectedTo.push(dest);
      },
      disconnect() {
        this.disconnectCount++;
      },
    };
    gains.push(g);
    return g;
  }

  function createBufferSource(): MockBufferSource {
    const s: MockBufferSource = {
      __kind: 'source',
      buffer: null,
      loop: false,
      startCount: 0,
      stopCount: 0,
      disconnectCount: 0,
      connectedTo: [],
      connect(dest: unknown) {
        this.connectedTo.push(dest);
      },
      start() {
        this.startCount++;
      },
      stop() {
        this.stopCount++;
      },
      disconnect() {
        this.disconnectCount++;
      },
    };
    sources.push(s);
    return s;
  }

  function createBuffer(_channels: number, length: number, _sampleRate: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }

  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createGain,
    createBufferSource,
    createBuffer,
  } as unknown as AudioContext;
  return { ctx, gains, sources };
}

function makeNode(params: Record<string, number> = {}): ModuleNode {
  return {
    id: 'moog903a-test',
    type: 'moog903a',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params,
    data: {},
  };
}

describe('moog903a factory: wiring + params', () => {
  it('exposes no inputs', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog903aDef.factory(ctx, makeNode());
    expect(handle.inputs.size).toBe(0);
  });

  it('exposes white + pink at output index 0 of two DISTINCT gain nodes', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog903aDef.factory(ctx, makeNode());
    const white = handle.outputs.get('white');
    const pink = handle.outputs.get('pink');
    expect(white).toBeDefined();
    expect(pink).toBeDefined();
    expect(white!.output).toBe(0);
    expect(pink!.output).toBe(0);
    expect(white!.node).not.toBe(pink!.node);
  });

  it('seeds both output gains from the default LEVEL (0.8)', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog903aDef.factory(ctx, makeNode());
    const white = handle.outputs.get('white')!.node as unknown as MockGainNode;
    const pink = handle.outputs.get('pink')!.node as unknown as MockGainNode;
    expect(white.gain.value).toBeCloseTo(0.8, 6);
    expect(pink.gain.value).toBeCloseTo(0.8, 6);
  });

  it('honors initial node.params.level at mount on both gains', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog903aDef.factory(ctx, makeNode({ level: 0.3 }));
    const white = handle.outputs.get('white')!.node as unknown as MockGainNode;
    const pink = handle.outputs.get('pink')!.node as unknown as MockGainNode;
    expect(white.gain.value).toBeCloseTo(0.3, 6);
    expect(pink.gain.value).toBeCloseTo(0.3, 6);
  });

  it('creates two looping buffer sources, each connected to its own gain and started', async () => {
    const { ctx, sources, gains } = makeMockCtx();
    const handle = await moog903aDef.factory(ctx, makeNode());
    expect(sources.length).toBe(2);
    expect(gains.length).toBe(2);
    const whiteGain = handle.outputs.get('white')!.node;
    const pinkGain = handle.outputs.get('pink')!.node;
    for (const s of sources) {
      expect(s.loop).toBe(true);
      expect(s.buffer).not.toBeNull();
      expect(s.startCount).toBe(1);
      expect(s.connectedTo.length).toBe(1);
    }
    // The two sources fan out to the two distinct output gains.
    const connectedGains = sources.map((s) => s.connectedTo[0]);
    expect(connectedGains).toContain(whiteGain);
    expect(connectedGains).toContain(pinkGain);
  });

  it('setParam(level) drives BOTH output gains; readParam round-trips', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog903aDef.factory(ctx, makeNode());
    expect(handle.readParam('level')).toBeCloseTo(0.8, 6);
    handle.setParam('level', 0.42);
    const white = handle.outputs.get('white')!.node as unknown as MockGainNode;
    const pink = handle.outputs.get('pink')!.node as unknown as MockGainNode;
    expect(white.gain.value).toBeCloseTo(0.42, 6);
    expect(pink.gain.value).toBeCloseTo(0.42, 6);
    expect(handle.readParam('level')).toBeCloseTo(0.42, 6);
  });

  it('setParam / readParam ignore unknown param ids without throwing', async () => {
    const { ctx } = makeMockCtx();
    const handle = await moog903aDef.factory(ctx, makeNode());
    expect(() => handle.setParam('nope', 0.5)).not.toThrow();
    expect(handle.readParam('nope')).toBeUndefined();
  });

  it('dispose() stops both sources and disconnects every node the factory created', async () => {
    const { ctx, gains, sources } = makeMockCtx();
    const handle = await moog903aDef.factory(ctx, makeNode());
    handle.dispose();
    for (const s of sources) {
      expect(s.stopCount).toBe(1);
      expect(s.disconnectCount).toBeGreaterThanOrEqual(1);
    }
    for (const g of gains) {
      expect(g.disconnectCount).toBeGreaterThanOrEqual(1);
    }
  });
});
