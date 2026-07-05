// packages/web/src/lib/audio/engine-cv-video-bridge.test.ts
//
// Regression coverage for the cross-domain CV → video bridge dispatch in
// PatchEngine.addEdge (the path that delivers an LFO / GAMEPAD output into
// a video module's setParam). This is the layer that broke DOOM's
// movement inputs: a gamepad D-pad button emits a `gate`-typed signal, and
// the old dispatch only took the bridge branch for `cv`. A `gate` source
// fell through to single-domain audio dispatch → no bridge → DOOM never
// saw the input (silent no-op).
//
// We can't run real Web Audio or WebGL2 under vitest, so we mirror the
// recording-fake pattern in engine-video-audio-bridge.test.ts: a fake
// AudioContext + a VideoEngineStub that records addCvBridge calls. What
// this pins:
//   1. A `cv` source (LFO / gamepad stick) into a video cv input takes the
//      bridge branch + calls VideoEngine.addCvBridge.
//   2. A `gate` source (gamepad button / dpad) ALSO takes the bridge
//      branch (the regression fix) instead of dispatching to audio.
//   3. The bridge is keyed by edge id + torn down on removeEdge.

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioEngine, PatchEngine, type DomainEngine } from './engine';
import type { AudioModuleDef } from './module-registry';
import { registerModule } from './module-registry';
import type { Edge, ModuleNode } from '$lib/graph/types';

function makeFakeNode(t: string): {
  __tag: string;
  connect: (dest: unknown, output?: number, input?: number) => void;
  disconnect: (...args: unknown[]) => void;
} {
  return {
    __tag: t,
    connect() { /* */ },
    disconnect() { /* */ },
  };
}

function makeFakeAudioContext(): AudioContext {
  return {
    currentTime: 0,
    sampleRate: 48000,
    createGain() { return { ...makeFakeNode('gain'), gain: { value: 1 } }; },
    createAnalyser() {
      return {
        ...makeFakeNode('analyser'),
        fftSize: 32,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData() { /* */ },
      };
    },
    createConstantSource() {
      return {
        ...makeFakeNode('const'),
        offset: { value: 0 },
        start() { /* */ },
        stop() { /* */ },
      };
    },
  } as unknown as AudioContext;
}

// A minimal audio source def with one `cv` output and one `gate` output —
// stands in for an LFO (cv) and a GAMEPAD (gate buttons / cv sticks).
const CV_GATE_SOURCE_DEF: AudioModuleDef = {
  type: 'cvGateBridgeTestSource',
  domain: 'audio',
  label: 'CVGateSrc',
  category: 'sources',
  inputs: [],
  outputs: [
    { id: 'cvOut', type: 'cv' },
    { id: 'gateOut', type: 'gate' },
  ],
  params: [],
  async factory(_ctx, _node) {
    const cvNode = makeFakeNode('cv-src');
    const gateNode = makeFakeNode('gate-src');
    return {
      domain: 'audio' as const,
      inputs: new Map(),
      outputs: new Map([
        ['cvOut', { node: cvNode as unknown as AudioNode, output: 0 }],
        ['gateOut', { node: gateNode as unknown as AudioNode, output: 0 }],
      ]),
      setParam(_id, _v) { /* */ },
      readParam(_id) { return undefined; },
      dispose() { /* */ },
    };
  },
};

interface RecordedBridge {
  edgeId: string;
  targetNodeId: string;
  targetPortId: string;
  teardown: () => void;
}

class VideoEngineStub implements DomainEngine {
  domain = 'video' as const;
  audioCtx: AudioContext | null = null;
  bridges: RecordedBridge[] = [];
  removedBridgeIds: string[] = [];
  /** Set true if a plain (single-domain) addEdge ever reaches us — proves
   *  the cross-domain branch did NOT take the bridge path. */
  plainEdges: Edge[] = [];

  setAudioContext(ctx: AudioContext | null): void { this.audioCtx = ctx; }

  addCvBridge(
    edgeId: string,
    _analyser: AnalyserNode,
    targetNodeId: string,
    targetPortId: string,
    teardown: () => void,
  ): void {
    this.bridges.push({ edgeId, targetNodeId, targetPortId, teardown });
  }

  removeCvBridge(edgeId: string): void {
    this.removedBridgeIds.push(edgeId);
  }

  async addNode(_n: ModuleNode): Promise<void> { /* */ }
  removeNode(_id: string): void { /* */ }
  addEdge(e: Edge): void { this.plainEdges.push(e); }
  removeEdge(_id: string): void { /* */ }
  setParam(_id: string, _p: string, _v: number): void { /* */ }
  readParam(): undefined { return undefined; }
  read(): unknown { return undefined; }
  dispose(): void { /* */ }
}

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registerModule(CV_GATE_SOURCE_DEF);
  registered = true;
}

async function setup() {
  const ctx = makeFakeAudioContext();
  const ae = new AudioEngine(ctx);
  const ve = new VideoEngineStub();
  const pe = new PatchEngine();
  pe.registerDomain(ae);
  pe.registerDomain(ve);

  const srcNode: ModuleNode = {
    id: 'a-src',
    type: 'cvGateBridgeTestSource',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
  };
  await ae.addNode(srcNode);
  return { pe, ae, ve };
}

describe('PatchEngine — cv/gate → video cross-domain bridge dispatch', () => {
  beforeEach(() => {
    ensureRegistered();
  });

  it('a cv source into a video cv input takes the bridge branch', async () => {
    const { pe, ve } = await setup();
    const edge: Edge = {
      id: 'e-cv',
      source: { nodeId: 'a-src', portId: 'cvOut' },
      target: { nodeId: 'v-doom', portId: 'up' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'audio', 'video');

    expect(ve.bridges.map((b) => b.edgeId)).toContain('e-cv');
    expect(ve.plainEdges, 'cv edge must NOT fall through to single-domain dispatch').toEqual([]);
    pe.dispose();
  });

  it('REGRESSION: a gate source (gamepad button/dpad) ALSO takes the bridge branch', async () => {
    const { pe, ve } = await setup();
    const edge: Edge = {
      id: 'e-gate',
      source: { nodeId: 'a-src', portId: 'gateOut' },
      target: { nodeId: 'v-doom', portId: 'space' },
      sourceType: 'gate',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'audio', 'video');

    // Before the fix, a `gate` source dispatched to the audio domain
    // (plainEdges) and never created a video bridge → DOOM no-op.
    expect(ve.bridges.map((b) => b.edgeId), 'gate source must create a video bridge').toContain('e-gate');
    expect(ve.plainEdges, 'gate edge must NOT fall through to audio dispatch').toEqual([]);
    pe.dispose();
  });

  it('removeEdge tears the cv bridge down (symmetric on edge id)', async () => {
    const { pe, ve } = await setup();
    const edge: Edge = {
      id: 'e-cv2',
      source: { nodeId: 'a-src', portId: 'cvOut' },
      target: { nodeId: 'v-doom', portId: 'left' },
      sourceType: 'cv',
      targetType: 'cv',
    };
    pe.addEdge(edge, 'audio', 'video');
    expect(ve.bridges.map((b) => b.edgeId)).toContain('e-cv2');

    pe.removeEdge(edge, 'audio');
    expect(ve.removedBridgeIds).toContain('e-cv2');
    pe.dispose();
  });
});
