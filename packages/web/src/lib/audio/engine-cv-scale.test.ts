// packages/web/src/lib/audio/engine-cv-scale.test.ts
//
// Pin the engine.ts <-> cv-scale.ts integration: when an edge is added
// from a `cv`-typed source to a `cv`-typed target whose port declares a
// `cvScale` hint, AudioEngine.addEdge MUST interpose a scaling node
// between source and the target AudioParam. We verify by inspecting the
// connection graph the engine builds with stubbed AudioNodes.

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine } from './engine';
import type { AudioModuleDef } from './module-registry';
import { registerModule } from './module-registry';
import type { Edge, ModuleNode, ParamDef } from '$lib/graph/types';

// ---- Minimal AudioContext fake ----
//
// Only the surface AudioEngine + cv-scale touch is implemented. We
// record .connect() calls so the test can assert "WaveShaperNode was
// inserted between LFO output and AudioParam".

interface ConnRec {
  fromTag: string;
  toTag: string;
  output?: number;
  input?: number;
}

let connectionLog: ConnRec[] = [];

function tag(node: { __tag: string }): string {
  return node.__tag;
}

function makeFakeNode(t: string): {
  __tag: string;
  connect: (dest: unknown, output?: number, input?: number) => void;
  disconnect: (...args: unknown[]) => void;
} {
  const n = {
    __tag: t,
    connect(dest: unknown, output?: number, input?: number) {
      const dt = (dest as { __tag?: string }).__tag ?? 'audioparam:' + ((dest as { __paramTag?: string }).__paramTag ?? 'unknown');
      connectionLog.push({ fromTag: t, toTag: dt, output, input });
    },
    disconnect() { /* */ },
  };
  return n;
}

function makeFakeParam(paramTag: string, defaultValue = 0): {
  __paramTag: string;
  value: number;
  setValueAtTime: (v: number, _t: number) => void;
} {
  return {
    __paramTag: paramTag,
    value: defaultValue,
    setValueAtTime(v: number) { this.value = v; },
  };
}

function makeFakeAudioContext(): unknown {
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
    createAnalyser() { return { ...makeFakeNode('analyser'), fftSize: 32, smoothingTimeConstant: 0, getFloatTimeDomainData() {} }; },
    createConstantSource() { return { ...makeFakeNode('const'), offset: makeFakeParam('const.offset', 0), start() {}, stop() {} }; },
    createChannelMerger() { return makeFakeNode('merger'); },
    createChannelSplitter() { return makeFakeNode('splitter'); },
  };
}

// ---- Define a minimal test module with a cv → param input that has cvScale ----

const TEST_PARAM: ParamDef = {
  id: 'gain',
  label: 'Gain',
  defaultValue: 1.0,
  min: 0,
  max: 2,
  curve: 'linear',
};

const TEST_DEF: AudioModuleDef = {
  type: 'cvScaleTestModule',
  domain: 'audio',
  label: 'CV Scale Test Module',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [
    {
      id: 'gain',
      type: 'cv',
      paramTarget: 'gain',
      cvScale: { mode: 'linear' },
    },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [TEST_PARAM],
  async factory(_ctx, _node) {
    const node = makeFakeNode('test-target');
    const param = makeFakeParam('test.gain', 1.0);
    return {
      domain: 'audio' as const,
      inputs: new Map([
        // The destination handle declares the AudioParam — this is what
        // the engine's `if (din.param)` branch reacts to.
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

// LFO-like source module that just exposes one cv output.
const TEST_SOURCE_DEF: AudioModuleDef = {
  type: 'cvScaleTestSource',
  domain: 'audio',
  label: 'CV Scale Test Source',
  category: 'utilities',
  schemaVersion: 1,
  inputs: [],
  outputs: [{ id: 'cv_out', type: 'cv' }],
  params: [],
  async factory(_ctx, _node) {
    const out = makeFakeNode('test-lfo');
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

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registerModule(TEST_DEF);
  registerModule(TEST_SOURCE_DEF);
  registered = true;
}

describe('engine + cv-scale integration', () => {
  beforeEach(() => {
    connectionLog = [];
    ensureRegistered();
  });

  it('addEdge interposes a WaveShaperNode for cv → cvScale-annotated param', async () => {
    const ctx = makeFakeAudioContext() as unknown as AudioContext;
    const eng = new AudioEngine(ctx);

    const sourceNode: ModuleNode = {
      id: 'src',
      type: 'cvScaleTestSource',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    };
    const targetNode: ModuleNode = {
      id: 'tgt',
      type: 'cvScaleTestModule',
      domain: 'audio',
      position: { x: 100, y: 0 },
      params: {},
    };
    await eng.addNode(sourceNode);
    await eng.addNode(targetNode);

    const edge: Edge = {
      id: 'e1',
      source: { nodeId: 'src', portId: 'cv_out' },
      target: { nodeId: 'tgt', portId: 'gain' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    eng.addEdge(edge);

    // Expected connection chain:
    //   test-lfo → waveshaper       (source → scaler input)
    //   waveshaper → audioparam:test.gain  (scaler output → target param)
    //   waveshaper → analyser       (scaler output → param tap)
    const lfoToShaper = connectionLog.find(
      (c) => c.fromTag === 'test-lfo' && c.toTag === 'waveshaper',
    );
    const shaperToParam = connectionLog.find(
      (c) => c.fromTag === 'waveshaper' && c.toTag === 'audioparam:test.gain',
    );
    const shaperToAnalyser = connectionLog.find(
      (c) => c.fromTag === 'waveshaper' && c.toTag === 'analyser',
    );
    expect(
      lfoToShaper,
      `expected source→waveshaper connection; saw: ${JSON.stringify(connectionLog)}`,
    ).toBeDefined();
    expect(
      shaperToParam,
      `expected waveshaper→param connection; saw: ${JSON.stringify(connectionLog)}`,
    ).toBeDefined();
    expect(
      shaperToAnalyser,
      `expected waveshaper→analyser connection; saw: ${JSON.stringify(connectionLog)}`,
    ).toBeDefined();
    // The OLD (passthrough) behavior: source→param directly. We assert this
    // does NOT happen — that's the regression guarantee.
    const lfoToParamDirect = connectionLog.find(
      (c) => c.fromTag === 'test-lfo' && c.toTag === 'audioparam:test.gain',
    );
    expect(
      lfoToParamDirect,
      `regression: source connected DIRECTLY to param (bypassing scaler); saw: ${JSON.stringify(connectionLog)}`,
    ).toBeUndefined();
  });

  it('addEdge falls back to passthrough when cvScale is omitted', async () => {
    // Quick variant: clone the test target def but drop cvScale.
    const PASSTHROUGH_DEF: AudioModuleDef = {
      ...TEST_DEF,
      type: 'cvScalePassthroughTestModule',
      label: 'CV Scale Passthrough Test',
      inputs: [
        { id: 'gain', type: 'cv', paramTarget: 'gain' /* no cvScale */ },
      ],
    };
    registerModule(PASSTHROUGH_DEF);

    connectionLog = [];
    const ctx = makeFakeAudioContext() as unknown as AudioContext;
    const eng = new AudioEngine(ctx);

    await eng.addNode({
      id: 'src',
      type: 'cvScaleTestSource',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    });
    await eng.addNode({
      id: 'tgt',
      type: 'cvScalePassthroughTestModule',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
    });
    eng.addEdge({
      id: 'e1',
      source: { nodeId: 'src', portId: 'cv_out' },
      target: { nodeId: 'tgt', portId: 'gain' },
      sourceType: 'cv',
      targetType: 'cv',
    });
    // No WaveShaperNode should appear in any connection.
    const wsAny = connectionLog.find(
      (c) => c.fromTag === 'waveshaper' || c.toTag === 'waveshaper',
    );
    expect(wsAny).toBeUndefined();
    // The source SHOULD be connected directly to the param (legacy path).
    const direct = connectionLog.find(
      (c) => c.fromTag === 'test-lfo' && c.toTag === 'audioparam:test.gain',
    );
    expect(direct).toBeDefined();
  });
});
