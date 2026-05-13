// packages/web/src/lib/audio/engine-removeNode-leak.test.ts
//
// Regression for issue #146: chaos 24/7 (seed=7, ~5500 iters of balanced
// add/delete) accumulated stale state in the AudioEngine across the run.
// The smoking gun was an orphaned per-param-modulator AnalyserNode for
// every cv → AudioParam edge the bot ever materialized: addEdge created
// a `paramTaps` entry, removeEdge disconnected its source but left the
// entry in the Map, and removeNode never cleaned it up. Over a long run
// the AnalyserNodes outlive their source AudioWorkletNodes — async
// callbacks from those orphans were the likely source of the 2711
// ErrorEvent storm.
//
// The fix in engine.ts removeNode now sweeps paramTaps keyed by the
// removed node. This test pins the invariant: after N add/edge/remove
// cycles, `paramTaps.size` is 0 (and `nodes.size`/`nodeTypes.size` are 0).

import { describe, it, expect } from 'vitest';
import { AudioEngine } from './engine';
import type { AudioModuleDef } from './module-registry';
import { registerModule, getModuleDef } from './module-registry';
import type { Edge, ModuleNode } from '$lib/graph/types';

// ---- Minimal AudioContext + fake node helpers (mirror engine-cv-scale.test.ts) ----

function makeFakeNode(tag: string): {
  __tag: string;
  connect: (dest: unknown, output?: number, input?: number) => void;
  disconnect: (...args: unknown[]) => void;
} {
  return {
    __tag: tag,
    connect() { /* recording not needed for this leak test */ },
    disconnect() { /* */ },
  };
}

function makeFakeParam(tag: string, defaultValue = 0): {
  __paramTag: string;
  value: number;
  setValueAtTime: (v: number, _t: number) => void;
} {
  return {
    __paramTag: tag,
    value: defaultValue,
    setValueAtTime(v: number) { this.value = v; },
  };
}

function makeFakeAudioContext(): AudioContext {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createGain() { return { ...makeFakeNode('gain'), gain: makeFakeParam('gain.gain', 1) }; },
    createWaveShaper() {
      const ws = makeFakeNode('waveshaper');
      let curve: Float32Array | null = null;
      return {
        ...ws,
        get curve() { return curve; },
        set curve(c) { curve = c; },
        oversample: 'none' as const,
      };
    },
    createAnalyser() {
      return {
        ...makeFakeNode('analyser'),
        fftSize: 32,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData() { /* */ },
      };
    },
    createConstantSource() {
      return { ...makeFakeNode('const'), offset: makeFakeParam('const.offset', 0), start() {}, stop() {} };
    },
    createChannelMerger() { return makeFakeNode('merger'); },
    createChannelSplitter() { return makeFakeNode('splitter'); },
  } as unknown as AudioContext;
}

// ---- Test module defs: one CV source, one CV-modulatable target ----

const SOURCE_DEF: AudioModuleDef = {
  type: 'leakTestSource',
  domain: 'audio',
  label: 'Leak Test Source',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [],
  outputs: [{ id: 'cv_out', type: 'cv' }],
  params: [],
  async factory(_ctx, _node) {
    const out = makeFakeNode('leak-src');
    return {
      domain: 'audio' as const,
      inputs: new Map(),
      outputs: new Map([['cv_out', { node: out as unknown as AudioNode, output: 0 }]]),
      setParam(_id, _v) { /* */ },
      readParam(_id) { return undefined; },
      dispose() { /* */ },
    };
  },
};

const TARGET_DEF: AudioModuleDef = {
  type: 'leakTestTarget',
  domain: 'audio',
  label: 'Leak Test Target',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [
    { id: 'gain', type: 'cv', paramTarget: 'gain', cvScale: { mode: 'linear' } },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [{ id: 'gain', label: 'Gain', defaultValue: 1.0, min: 0, max: 2, curve: 'linear' }],
  async factory(_ctx, _node) {
    const node = makeFakeNode('leak-tgt');
    const param = makeFakeParam('leak-tgt.gain', 1.0);
    return {
      domain: 'audio' as const,
      inputs: new Map([
        ['gain', { node: node as unknown as AudioNode, input: 0, param: param as unknown as AudioParam }],
      ]),
      outputs: new Map([
        ['audio', { node: node as unknown as AudioNode, output: 0 }],
      ]),
      setParam(_id, _v) { /* */ },
      readParam(_id) { return param.value; },
      dispose() { /* */ },
    };
  },
};

function ensureRegistered(): void {
  if (!getModuleDef(SOURCE_DEF.type)) registerModule(SOURCE_DEF);
  if (!getModuleDef(TARGET_DEF.type)) registerModule(TARGET_DEF);
}

// Helper: AudioEngine exposes `nodes` and `paramTaps` as public Maps for
// this exact kind of introspection (engine-context, chaos snapshot reader).
// We use those directly instead of reaching into private fields.
function internalCounts(eng: AudioEngine): {
  nodes: number;
  edges: number;
  paramTaps: number;
} {
  return {
    nodes: eng.nodes.size,
    edges: eng.edges.size,
    paramTaps: eng.paramTaps.size,
  };
}

describe('AudioEngine removeNode — issue #146 leak regression', () => {
  it('paramTaps does not accumulate across N add/edge/delete cycles', async () => {
    ensureRegistered();
    const ctx = makeFakeAudioContext();
    const eng = new AudioEngine(ctx);

    const CYCLES = 10;
    for (let i = 0; i < CYCLES; i++) {
      const srcId = `src-${i}`;
      const tgtId = `tgt-${i}`;
      const edgeId = `edge-${i}`;
      const src: ModuleNode = {
        id: srcId, type: 'leakTestSource', domain: 'audio',
        position: { x: 0, y: 0 }, params: {},
      };
      const tgt: ModuleNode = {
        id: tgtId, type: 'leakTestTarget', domain: 'audio',
        position: { x: 100, y: 0 }, params: {},
      };
      await eng.addNode(src);
      await eng.addNode(tgt);

      const edge: Edge = {
        id: edgeId,
        source: { nodeId: srcId, portId: 'cv_out' },
        target: { nodeId: tgtId, portId: 'gain' },
        sourceType: 'cv',
        targetType: 'cv',
      };
      eng.addEdge(edge);

      // Mid-cycle expectation: exactly one tap exists (for this edge).
      expect(eng.paramTaps.size).toBe(1);

      // Mirror reconciler order: removeEdge, then removeNode for each
      // endpoint. Chaos Carl's deleteNode intent does the same.
      eng.removeEdge(edgeId);
      eng.removeNode(srcId);
      eng.removeNode(tgtId);

      // Post-cycle: everything we added must be gone, including the tap.
      const counts = internalCounts(eng);
      expect(counts.nodes, `cycle ${i}: nodes leaked`).toBe(0);
      expect(counts.edges, `cycle ${i}: edges leaked`).toBe(0);
      expect(counts.paramTaps, `cycle ${i}: paramTaps leaked`).toBe(0);
    }

    // Final invariant: cumulative state is bounded — no monotonic growth.
    expect(internalCounts(eng)).toEqual({ nodes: 0, edges: 0, paramTaps: 0 });
  });

  it('removeNode cleans up paramTaps even when the edge was already removed', async () => {
    // This is the exact sequence chaos Carl produces: deleteEdge fires first
    // (via the cascade in applyIntent's deleteNode handler that drops touching
    // edges), and removeNode arrives with the tap-Map still carrying a stale
    // entry. Pre-fix, that entry survived; post-fix removeNode sweeps it.
    ensureRegistered();
    const ctx = makeFakeAudioContext();
    const eng = new AudioEngine(ctx);

    const src: ModuleNode = {
      id: 'src', type: 'leakTestSource', domain: 'audio',
      position: { x: 0, y: 0 }, params: {},
    };
    const tgt: ModuleNode = {
      id: 'tgt', type: 'leakTestTarget', domain: 'audio',
      position: { x: 100, y: 0 }, params: {},
    };
    await eng.addNode(src);
    await eng.addNode(tgt);
    eng.addEdge({
      id: 'e',
      source: { nodeId: 'src', portId: 'cv_out' },
      target: { nodeId: 'tgt', portId: 'gain' },
      sourceType: 'cv',
      targetType: 'cv',
    });
    expect(eng.paramTaps.size).toBe(1);

    // Drop the edge first (chaos-Carl order).
    eng.removeEdge('e');
    // Tap entry persists at this point (by design — readParam still works for
    // motorized faders while the node is alive). Removing the NODE is what
    // must sweep it.
    expect(eng.paramTaps.size).toBe(1);

    eng.removeNode('tgt');
    expect(eng.paramTaps.size).toBe(0);

    eng.removeNode('src');
    expect(internalCounts(eng)).toEqual({ nodes: 0, edges: 0, paramTaps: 0 });
  });
});
